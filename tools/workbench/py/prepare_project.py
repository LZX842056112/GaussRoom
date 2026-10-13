"""Create audited, oriented reconstruction copies inside a workbench project.

The source folder is only ever read.  Everything this script writes lives under
--project.  Exit codes: 0 ok, 2 target already exists without --force, 3 no
usable images, 4 a source file changed while we were working, 1 other error.
"""
import argparse
import hashlib
import io
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"}
HEIC_SUFFIXES = {".heic", ".heif"}


EMPTY_TAGS = {"make": "", "model": "", "orientation": 1, "datetime": "",
              "lens_model": "", "focal_mm": "", "focal_35mm": "", "exif_available": False}


def read_oriented(path, ffmpeg):
    """Return {image, out_exif, tags, original_size} for one source file."""
    if path.suffix.lower() in HEIC_SUFFIXES:
        if not ffmpeg:
            raise RuntimeError("HEIC 需要 ffmpeg，但未提供 --ffmpeg")
        # HEIC is a HEVC tile-grid stream: a -vf filter graph conflicts with the
        # internal one, so decode full resolution to a pipe and scale with Pillow.
        process = subprocess.run(
            [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
             "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "-"],
            capture_output=True, timeout=300)
        if process.returncode != 0 or not process.stdout:
            raise RuntimeError("ffmpeg 解码失败：" + process.stderr.decode(errors="replace")[:200])
        with Image.open(io.BytesIO(process.stdout)) as raw:
            raw.load()
            image = raw.convert("RGB")
        return {"image": image, "out_exif": Image.Exif(), "tags": dict(EMPTY_TAGS),
                "original_size": image.size, "useful": {}}

    with Image.open(path) as raw:
        raw.load()
        exif = raw.getexif()
        lens = exif.get_ifd(34665) if 34665 in exif else {}
        tags = {"make": str(exif.get(271, "")), "model": str(exif.get(272, "")),
                "orientation": int(exif.get(274, 1)),
                "datetime": str(lens.get(36867, exif.get(306, ""))),
                "lens_model": str(lens.get(42036, "")), "focal_mm": str(lens.get(37386, "")),
                "focal_35mm": str(lens.get(41989, "")), "exif_available": True}
        original_size = raw.size
        image = ImageOps.exif_transpose(raw).convert("RGB")

    # Retain device and focal evidence, not location or obsolete orientation/dimensions.
    out_exif = Image.Exif()
    for tag in (271, 272, 306):
        if tag in exif:
            out_exif[tag] = exif[tag]
    useful = {tag: lens[tag] for tag in (36867, 37386, 41989, 42036) if tag in lens}
    return {"image": image, "out_exif": out_exif, "tags": tags,
            "original_size": original_size, "useful": useful}


def group_key(tags, original_size, work_size):
    """Same physical camera + lens + zoom share intrinsics.

    When lens evidence is missing we fall back to make/model plus pixel
    dimensions instead of splitting every file into its own camera, which would
    leave single-image cameras with unconstrained intrinsics.
    """
    has_lens = bool(tags["lens_model"]) and bool(tags["focal_mm"])
    if has_lens:
        return (tags["make"], tags["model"], tags["lens_model"], tags["focal_mm"],
                tags["focal_35mm"], *original_size, *work_size), "lens_exif"
    return (tags["make"], tags["model"], *original_size, *work_size), "make_model_dims"


def contact_sheets(thumbs, folder):
    for start in range(0, len(thumbs), 24):
        canvas = Image.new("RGB", (1440, 1680), "white")
        draw = ImageDraw.Draw(canvas)
        for index, (thumb, name, excluded) in enumerate(thumbs[start:start + 24]):
            col, row = index % 4, index // 4
            x, y = col * 360, row * 280
            canvas.paste(thumb, (x + (360 - thumb.width) // 2, y + 4))
            draw.text((x + 12, y + 249), name + (" [excluded]" if excluded else ""), fill="black")
        canvas.save(folder / f"sheet-{start // 24 + 1:02d}.jpg", quality=92)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--long-edge", type=int, default=2048)
    parser.add_argument("--min-long-edge", type=int, default=1000)
    parser.add_argument("--quality", type=int, default=94)
    parser.add_argument("--ffmpeg", type=Path, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    source = args.source.resolve()
    if not source.is_dir():
        print(f"源目录不存在：{source}", file=sys.stderr)
        return 3

    images_dir = args.project / "images"
    sheets_dir = args.project / "contact-sheets"
    manifest_path = args.project / "manifest.json"
    if images_dir.exists() and any(images_dir.iterdir()) and not args.force:
        print(f"项目已包含图像，未指定 --force：{images_dir}", file=sys.stderr)
        return 2
    for target in (images_dir, sheets_dir):
        if target.exists():
            for child in sorted(target.rglob("*"), reverse=True):
                child.unlink() if child.is_file() else child.rmdir()
        target.mkdir(parents=True, exist_ok=True)
    if manifest_path.exists():
        manifest_path.unlink()

    files = sorted((p for p in source.iterdir()
                    if p.is_file() and p.suffix.lower() in SUFFIXES),
                   key=lambda p: p.name.lower())
    if not files:
        print(f"源目录内没有可用图片：{source}", file=sys.stderr)
        return 3

    records, seen, groups, thumbs = [], {}, {}, []
    for index, path in enumerate(files, start=1):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        item = {"source": str(path), "name": path.name, "bytes": path.stat().st_size,
                "sha256": digest, "excluded": None, "work_image": None}
        try:
            loaded = read_oriented(path, args.ffmpeg)
        except Exception as error:                       # noqa: BLE001 - report and continue
            item["excluded"] = f"decode_failed: {error}"
            records.append(item)
            print(f"  [{index}/{len(files)}] 解码失败 {path.name}: {error}", file=sys.stderr)
            continue

        image = loaded["image"]
        out_exif = loaded["out_exif"]
        tags = loaded["tags"]
        original_size = loaded["original_size"]

        item["exif"] = tags
        item["original_size"] = list(original_size)
        item["oriented_size"] = list(image.size)
        if max(image.size) < args.min_long_edge:
            item["excluded"] = f"low_resolution_below_{args.min_long_edge}_long_edge"
        elif digest in seen:
            item["excluded"] = "exact_duplicate_of_" + seen[digest]
        seen.setdefault(digest, path.name)

        image.thumbnail((args.long_edge, args.long_edge), Image.Resampling.LANCZOS)
        item["work_size"] = list(image.size)

        if not item["excluded"]:
            key, basis = group_key(tags, original_size, image.size)
            group = groups.setdefault(key, {"name": f"camera-{len(groups) + 1:02d}", "basis": basis})
            folder = images_dir / group["name"]
            folder.mkdir(exist_ok=True)
            out = folder / (path.stem + ".jpg")
            if out.exists():
                item["excluded"] = "duplicate_output_name"
            else:
                out_exif[34665] = dict(loaded["useful"])
                out_exif[34665].update({40962: image.width, 40963: image.height})
                out_exif[274] = 1
                image.save(out, "JPEG", quality=args.quality, exif=out_exif)
                item["work_image"] = out.relative_to(args.project).as_posix()
                item["camera_group"] = group["name"]
                item["grouping_basis"] = basis
                with Image.open(out) as check:
                    if check.size != image.size or check.getexif().get(274, 1) != 1:
                        raise RuntimeError(f"写入校验失败：{out}")

        preview = image.copy()
        preview.thumbnail((342, 242))
        thumbs.append((preview, path.name, item["excluded"]))
        records.append(item)
        if index % 25 == 0 or index == len(files):
            print(f"  [{index}/{len(files)}]", file=sys.stderr, flush=True)

    contact_sheets(thumbs, sheets_dir)

    changed = [r["name"] for r in records
               if hashlib.sha256(Path(r["source"]).read_bytes()).hexdigest() != r["sha256"]]
    summary = {"source_dir": str(source),
               "source_count": len(records),
               "retained_count": sum(not r["excluded"] for r in records),
               "excluded": [{"name": r["name"], "reason": r["excluded"]}
                            for r in records if r["excluded"]],
               "camera_groups": dict(Counter(r["camera_group"] for r in records
                                             if r.get("camera_group"))),
               "grouping": {g["name"]: g["basis"] for g in groups.values()},
               "sources_unchanged": not changed,
               "changed_sources": changed,
               "records": records}
    manifest_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    if changed:
        print(f"源文件在处理期间发生变化：{changed[:5]}", file=sys.stderr)
        return 4
    if summary["retained_count"] < 2:
        print(f"可用图像不足（{summary['retained_count']} 张）", file=sys.stderr)
        return 3

    print(json.dumps({k: v for k, v in summary.items() if k != "records"},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
