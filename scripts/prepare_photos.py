"""Create audited, oriented reconstruction copies; never write to the source."""
import hashlib
import json
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"C:\Users\lzx84\Desktop\images\room")
DEST = ROOT / "data" / "images"
SHEETS = ROOT / "data" / "contact-sheets"
assert SOURCE.resolve() not in DEST.resolve().parents
DEST.mkdir(parents=True, exist_ok=True)
SHEETS.mkdir(parents=True, exist_ok=True)
records, seen, groups, thumbs = [], {}, {}, []

for path in sorted(SOURCE.iterdir(), key=lambda p: p.name.lower()):
    if not path.is_file() or path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".heic"}:
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    item = {"source": str(path), "name": path.name, "bytes": path.stat().st_size,
            "sha256": digest, "excluded": None, "work_image": None}
    with Image.open(path) as raw:
        raw.load()
        exif = raw.getexif()
        lens = exif.get_ifd(34665) if 34665 in exif else {}
        info = {"make": str(exif.get(271, "")), "model": str(exif.get(272, "")),
                "orientation": int(exif.get(274, 1)), "datetime": str(lens.get(36867, exif.get(306, ""))),
                "lens_model": str(lens.get(42036, "")), "focal_mm": str(lens.get(37386, "")),
                "focal_35mm": str(lens.get(41989, ""))}
        item.update({"original_size": list(raw.size), "exif": info})
        image = ImageOps.exif_transpose(raw).convert("RGB")
        item["oriented_size"] = list(image.size)
        if max(image.size) < 1000:
            item["excluded"] = "low_resolution_below_1000_long_edge"
        elif digest in seen:
            item["excluded"] = "exact_duplicate_of_" + seen[digest]
        seen.setdefault(digest, path.name)
        image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
        item["work_size"] = list(image.size)
        if not item["excluded"]:
            key = (info["make"], info["model"], info["lens_model"], info["focal_mm"],
                   info["focal_35mm"], *item["original_size"], *image.size)
            # Images without lens evidence are not forced to share intrinsics.
            if not info["lens_model"] or not info["focal_mm"]:
                key += (path.name,)
            group = groups.setdefault(key, f"camera-{len(groups) + 1:02d}")
            folder = DEST / group
            folder.mkdir(exist_ok=True)
            out = folder / (path.stem + ".jpg")
            assert not out.exists(), f"Refusing to overwrite: {out}"
            # Retain device and focal evidence, not location or obsolete orientation/dimensions.
            out_exif = Image.Exif()
            for tag in (271, 272, 306):
                if tag in exif:
                    out_exif[tag] = exif[tag]
            useful = {tag: lens[tag] for tag in (36867, 37386, 41989, 42036) if tag in lens}
            useful.update({40962: image.width, 40963: image.height})
            out_exif[34665] = useful
            out_exif[274] = 1
            image.save(out, "JPEG", quality=94, exif=out_exif)
            item["work_image"] = out.relative_to(DEST).as_posix()
            item["camera_group"] = group
            with Image.open(out) as check:
                assert check.size == image.size and check.getexif().get(274, 1) == 1
        preview = image.copy()
        preview.thumbnail((342, 242))
        thumbs.append((preview, path.name, item["excluded"]))
    records.append(item)

for start in range(0, len(thumbs), 24):
    canvas = Image.new("RGB", (1440, 1680), "white")
    draw = ImageDraw.Draw(canvas)
    for index, (thumb, name, excluded) in enumerate(thumbs[start:start + 24]):
        col, row = index % 4, index // 4
        x, y = col * 360, row * 280
        canvas.paste(thumb, (x + (360 - thumb.width) // 2, y + 4))
        draw.text((x + 12, y + 249), name + (" [excluded]" if excluded else ""), fill="black")
    canvas.save(SHEETS / f"sheet-{start // 24 + 1:02d}.jpg", quality=92)

unchanged = all(hashlib.sha256(Path(r["source"]).read_bytes()).hexdigest() == r["sha256"] for r in records)
assert unchanged, "Source hash changed"
summary = {"source_count": len(records), "retained_count": sum(not r["excluded"] for r in records),
           "excluded": [{"name": r["name"], "reason": r["excluded"]} for r in records if r["excluded"]],
           "camera_groups": dict(Counter(r.get("camera_group") for r in records if not r["excluded"])),
           "sources_unchanged": unchanged, "records": records}
(ROOT / "data" / "manifest.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({k: v for k, v in summary.items() if k != "records"}, ensure_ascii=True, indent=2))
