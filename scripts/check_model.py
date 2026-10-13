"""Read COLMAP model statistics without extra dependencies."""
import json
import math
import sqlite3
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "runs" / "sfm-001"


def unpack(handle, fmt):
    return struct.unpack("<" + fmt, handle.read(struct.calcsize("<" + fmt)))


def images(path):
    entries = []
    with path.open("rb") as handle:
        count, = unpack(handle, "Q")
        for _ in range(count):
            values = unpack(handle, "idddddddi")
            name = bytearray()
            while (char := handle.read(1)) != b"\0":
                if not char:
                    raise ValueError("Truncated COLMAP image name")
                name.extend(char)
            num_points, = unpack(handle, "Q")
            handle.seek(num_points * 24, 1)
            w, x, y, z = values[1:5]
            tx, ty, tz = values[5:8]
            rotation = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]
            translation = [tx, ty, tz]
            center = [-sum(rotation[j][i] * translation[j] for j in range(3)) for i in range(3)]
            entries.append({"id": values[0], "name": name.decode("utf-8"),
                            "camera_id": values[8], "qvec": [w,x,y,z], "tvec": translation,
                            "center": center, "points2d": num_points})
    return entries


def points(path):
    errors, tracks = [], []
    with path.open("rb") as handle:
        count, = unpack(handle, "Q")
        for _ in range(count):
            values = unpack(handle, "QdddBBBd")
            length, = unpack(handle, "Q")
            handle.seek(length * 8, 1)
            errors.append(values[-1])
            tracks.append(length)
    return {"count": count, "mean_reprojection_error": sum(errors)/count if count else None,
            "mean_track_length": sum(tracks)/count if count else None}


if __name__ == "__main__":
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
    expected = {r["work_image"] for r in manifest["records"] if not r["excluded"]}
    models = []
    model_root = Path(sys.argv[1]) if len(sys.argv) > 1 else (RUN / "sparse-complete" if (RUN / "sparse-complete").exists() else RUN / "sparse")
    database_path = Path(sys.argv[2]) if len(sys.argv) > 2 else RUN / "database.db"
    for folder in sorted(model_root.iterdir()):
        if not (folder / "images.bin").exists():
            continue
        views = images(folder / "images.bin")
        names = {v["name"] for v in views}
        models.append({"path": str(folder), "registered": len(views),
                       "registration_ratio": len(views)/max(1,len(expected)),
                       "unregistered": sorted(expected - names), "images": views,
                       "points": points(folder / "points3D.bin")})
    models.sort(key=lambda m: m["registered"], reverse=True)
    with sqlite3.connect(f"file:{database_path.as_posix()}?mode=ro", uri=True) as database:
        info = {"image_count": database.execute("select count(*) from images").fetchone()[0],
                "camera_count": database.execute("select count(*) from cameras").fetchone()[0],
                "verified_pairs": database.execute("select count(*) from two_view_geometries where rows > 0").fetchone()[0]}
        names = dict(database.execute("select image_id, name from images"))
        neighbors = {i: set() for i in names}
        strong_pairs = []
        for pair_id, inliers, config in database.execute("select pair_id, rows, config from two_view_geometries where rows >= 30"):
            b = pair_id % 2147483647
            a = (pair_id - b) // 2147483647
            if a not in neighbors or b not in neighbors:
                continue
            neighbors[a].add(b)
            neighbors[b].add(a)
            strong_pairs.append({"a": names[a], "b": names[b], "inliers": inliers, "config": config})
        components, unseen = [], set(names)
        while unseen:
            todo, found = [next(iter(unseen))], set()
            while todo:
                image_id = todo.pop()
                if image_id in found:
                    continue
                found.add(image_id)
                todo.extend(neighbors[image_id] - found)
            unseen -= found
            components.append(sorted(names[i] for i in found))
        info["strong_pair_components"] = sorted(components, key=len, reverse=True)
    summary = {"database": info, "models": models, "strong_pairs": strong_pairs,
               "requires_manual_space_review": True, "geometry_gate_passed": False}
    (RUN / "model-summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"database": {k:v for k,v in info.items() if k != "strong_pair_components"},
                      "strong_component_sizes": [len(c) for c in info['strong_pair_components']],
                      "models": [{k:v for k,v in m.items() if k not in {'images', 'unregistered'}} for m in models]}, indent=2))
