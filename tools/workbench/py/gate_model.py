"""Geometry gate for the reconstruction workbench.

Reads the COLMAP sparse models plus the feature database and decides whether the
reconstruction is a single connected model of the whole scene.  The verdict is
data, not an error: this script exits 0 whenever the analysis ran, and writes the
decision to <out>/gate.json.  Exit 1 only if the analysis itself could not run.
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "scripts"))

from check_model import images, points  # noqa: E402 - needs the path tweak above


def strong_components(database_path):
    """Connected components of the strong (>=30 inlier) match graph."""
    with sqlite3.connect(f"file:{database_path.as_posix()}?mode=ro", uri=True) as database:
        info = {
            "image_count": database.execute("select count(*) from images").fetchone()[0],
            "camera_count": database.execute("select count(*) from cameras").fetchone()[0],
            "verified_pairs": database.execute(
                "select count(*) from two_view_geometries where rows > 0").fetchone()[0],
        }
        names = dict(database.execute("select image_id, name from images"))
        neighbours = {image_id: set() for image_id in names}
        for pair_id, inliers in database.execute(
                "select pair_id, rows from two_view_geometries where rows >= 30"):
            second = pair_id % 2147483647
            first = (pair_id - second) // 2147483647
            if first not in neighbours or second not in neighbours:
                continue
            neighbours[first].add(second)
            neighbours[second].add(first)

    components, unseen = [], set(names)
    while unseen:
        stack, found = [next(iter(unseen))], set()
        while stack:
            image_id = stack.pop()
            if image_id in found:
                continue
            found.add(image_id)
            stack.extend(neighbours[image_id] - found)
        unseen -= found
        components.append(sorted(names[i] for i in found))
    components.sort(key=len, reverse=True)
    info["strong_pair_components"] = components
    return info


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--min-ratio", type=float, default=0.80)
    parser.add_argument("--max-error", type=float, default=2.0)
    parser.add_argument("--min-points", type=int, default=5000)
    parser.add_argument("--fragment-share", type=float, default=0.05)
    args = parser.parse_args()

    if not args.model_root.is_dir():
        print(f"稀疏模型目录不存在：{args.model_root}", file=sys.stderr)
        return 1

    expected = set()
    if args.manifest.exists():
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        expected = {r["work_image"] for r in manifest["records"]
                    if not r["excluded"] and r.get("work_image")}
    expected_count = len(expected)

    models = []
    for folder in sorted(args.model_root.iterdir()):
        if not (folder / "images.bin").exists():
            continue
        views = images(folder / "images.bin")
        # COLMAP stores names relative to --image_path (the images dir), while the
        # manifest stores them relative to the project root. Normalise before
        # comparing, otherwise every image looks unregistered.
        registered = {
            view["name"][len("images/"):] if view["name"].startswith("images/") else view["name"]
            for view in views
        }
        stats = points(folder / "points3D.bin")
        models.append({
            "name": folder.name,
            "registered": len(views),
            "registration_ratio": len(views) / max(expected_count, 1),
            "mean_reprojection_error": stats["mean_reprojection_error"],
            "mean_track_length": stats["mean_track_length"],
            "points": stats["count"],
            "unregistered": sorted(
                name[len("images/"):] if name.startswith("images/") else name
                for name in expected
                if (name[len("images/"):] if name.startswith("images/") else name) not in registered
            ),
        })
    models.sort(key=lambda model: model["registered"], reverse=True)

    database_info = {"image_count": 0, "camera_count": 0, "verified_pairs": 0,
                     "strong_pair_components": []}
    if args.database.exists():
        try:
            database_info = strong_components(args.database)
        except sqlite3.Error as error:
            print(f"读取特征数据库失败：{error}", file=sys.stderr)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "model-summary.json").write_text(json.dumps({
        "expected_images": expected_count,
        "database": {k: v for k, v in database_info.items() if k != "strong_pair_components"},
        "strong_component_sizes": [len(c) for c in database_info["strong_pair_components"]],
        "models": [{k: v for k, v in m.items() if k != "unregistered"} for m in models],
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    if not models:
        verdict = "none"
        message = "稀疏重建没有产出任何模型，无法进入训练。请检查照片是否有足够重叠。"
        selected = None
    else:
        largest = models[0]
        threshold = args.fragment_share * max(expected_count, 1)
        fragments = [m for m in models[1:] if m["registered"] < threshold]
        splits = [m for m in models[1:] if m["registered"] >= threshold]
        selected = largest["name"]
        if splits:
            verdict = "split"
            sizes = "、".join(f"模型 {m['name']} 注册 {m['registered']} 张" for m in [largest] + splits)
            message = (
                f"稀疏重建分裂为 {1 + len(splits)} 个互不连通的模型（{sizes}），已中止训练。"
                "这些模型之间缺少重叠视角：请在断开处补拍连续、重叠约 70%–80% 的照片后重跑。"
            )
        elif largest["registration_ratio"] < args.min_ratio:
            verdict = "weak"
            message = (
                f"只有 {largest['registered']}/{expected_count} 张照片成功定位"
                f"（{largest['registration_ratio']:.0%}，低于 {args.min_ratio:.0%}），已中止训练。"
                "通常意味着照片重叠不足或存在大量模糊/重复纹理，建议提高重叠度后重拍。"
            )
        elif (largest["mean_reprojection_error"] or 0) > args.max_error:
            verdict = "weak"
            message = (
                f"重投影误差 {largest['mean_reprojection_error']:.2f} px 高于阈值 {args.max_error:.2f} px，"
                "重建几何不可靠，已中止训练。"
            )
        elif largest["points"] < args.min_points:
            verdict = "weak"
            message = (
                f"稀疏点仅 {largest['points']} 个，低于阈值 {args.min_points}，场景过于稀疏，已中止训练。"
            )
        else:
            verdict = "pass"
            message = (
                f"单一连通模型，注册 {largest['registered']}/{expected_count} 张"
                f"（{largest['registration_ratio']:.0%}），重投影误差 "
                f"{largest['mean_reprojection_error']:.3f} px，稀疏点 {largest['points']} 个。"
            )
            if fragments:
                message += f" 另有 {len(fragments)} 个碎片模型已丢弃。"

    gate = {
        "verdict": verdict,
        "message": message,
        "selectedModel": selected,
        "expectedImages": expected_count,
        "thresholds": {"minRatio": args.min_ratio, "maxError": args.max_error,
                       "minPoints": args.min_points, "fragmentShare": args.fragment_share},
        "models": models,
        "discardedFragments": [m["name"] for m in models[1:]] if verdict == "pass" else [],
        "strongComponentSizes": [len(c) for c in database_info["strong_pair_components"]],
        "database": {k: v for k, v in database_info.items() if k != "strong_pair_components"},
    }
    (args.out / "gate.json").write_text(json.dumps(gate, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps({"verdict": verdict, "selectedModel": selected,
                      "models": [{k: v for k, v in m.items() if k != "unregistered"} for m in models],
                      "strongComponentSizes": gate["strongComponentSizes"]},
                     indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
