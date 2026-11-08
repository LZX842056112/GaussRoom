"""Create audited, oriented reconstruction copies inside a workbench project.

The source folder is only ever read.  Everything this script writes lives under
--project, except the reusable frame cache (--frame-cache), which also stays
inside the project directory but outside any single attempt.  Exit codes: 0 ok,
2 target already exists without --force, 3 no usable images, 4 a source file
changed while we were working, 1 other error.  An unexpected internal failure
also returns 0 after writing an `internal_error` manifest, so jobs reaches
verify() instead of halting on a bare exit code (1 only when --project is
unknown and no manifest can be written).
"""
import argparse
import hashlib
import io
import json
import shutil
import subprocess
import sys
import traceback
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

import video_frames

SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"}
HEIC_SUFFIXES = {".heic", ".heif"}


EMPTY_TAGS = {"make": "", "model": "", "orientation": 1, "datetime": "",
              "lens_model": "", "focal_mm": "", "focal_35mm": "", "exif_available": False}


def sha256_file(path):
    """Chunked digest: frames are ~600 KB each and a clip yields hundreds."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


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


def _relative_to(path, root):
    """Project-relative posix path, or None when the file lives outside the project."""
    if not path:
        return None
    try:
        return Path(path).resolve().relative_to(root).as_posix()
    except ValueError:
        return None


def _video_summary(video_entries, report_root):
    """One flat record per video input: enough for the UI, no per-frame dump."""
    summary = []
    for entry in video_entries:
        if entry.get("error"):
            stats = (entry.get("report") or {}).get("stats") or {}
            summary.append({"name": entry["name"], "path": entry["path"], "error": entry["error"],
                            "errorCode": entry.get("errorCode", "decode_failed"),
                            # Present when the failure was "no usable frames": the
                            # UI can then name the gate instead of repeating prose.
                            **({"rejected": stats["rejected_by_reason"],
                                "reasonSummary": stats.get("reason_summary")}
                               if stats.get("rejected_by_reason") else {})})
            continue
        report = entry["report"]
        video, policy, stats = report["video"], report["policy"], report["stats"]
        summary.append({
            "name": entry["name"], "path": entry["path"],
            "durationSec": video["duration_s"], "width": video["src_w"], "height": video["src_h"],
            "fps": video["fps"], "targetFrames": policy["target_frames"], "kept": stats["n_kept"],
            "intervalSec": policy["delta_cand_s"], "cached": entry.get("cached", False),
            "hdr": video.get("hdr", False), "toneMapped": video.get("tone_mapped", False),
            "decoder": video.get("decoder"), "policyVersion": policy.get("policy_version"),
            "policyHash": policy.get("policy_hash"),
            "reportPath": _relative_to(entry.get("report_path"), report_root),
            "modeFlags": report.get("mode_flags", []), "warnings": report.get("warnings", []),
            "rejected": stats["rejected_by_reason"],
        })
    return summary


def _write_manifest(path, summary):
    path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")


def _fail_manifest(manifest_path, sources, videos, code, message):
    """Record an input problem the same way a decode failure is recorded.

    These are asset problems (a source folder or video disappeared), not shooting
    problems, so they must reach the UI as a code it can word differently from
    "shots too blurry, please retake".
    """
    _write_manifest(manifest_path, {
        "source_dir": str(sources[0]) if sources else "",
        "source_dirs": [str(path) for path in sources],
        "video_sources": [str(path) for path in videos],
        "videos": [], "source_count": 0, "video_frames": 0, "retained_count": 0,
        "excluded": [], "camera_groups": {}, "grouping": {},
        "sources_unchanged": True, "changed_sources": [], "records": [],
        "error": {"code": code, "message": message},
    })
    print(message, file=sys.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, action='append', default=[])
    parser.add_argument("--video", type=Path, action='append', default=[],
                        help="视频文件；抽出的帧与照片一起进入同一次预处理")
    parser.add_argument("--frame-cache", type=Path, default=None,
                        help="抽帧缓存目录；不传则放在项目的 video-frames 下")
    parser.add_argument("--target-frames", type=int, default=0,
                        help="每段视频的目标保留帧数；0 表示按时长自动决定")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--project-root", type=Path, default=None,
                        help="项目根目录；尝试工作区在其下时用于生成相对的 reportPath")
    parser.add_argument("--images-relative", default="images")
    parser.add_argument("--long-edge", type=int, default=2048)
    parser.add_argument("--min-long-edge", type=int, default=1000)
    parser.add_argument("--quality", type=int, default=94)
    parser.add_argument("--ffmpeg", type=Path, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    # Everything below works in absolute paths: --project may be relative, and
    # work_image is computed by stripping the project root from an absolute path.
    project_root = args.project.resolve()
    # The cache lives at the project root, the workspace may be an attempt
    # subdirectory; reportPath must be relative to the former to stay stable.
    report_root = (args.project_root or args.project).resolve()
    manifest_path = project_root / "manifest.json"

    sources = [path.resolve() for path in args.source]
    videos = [path.resolve() for path in args.video]
    if not sources and not videos:
        _fail_manifest(manifest_path, sources, videos, "no_input", "至少需要一个图片目录或视频文件")
        return 0
    for folder in sources:
        if not folder.is_dir():
            _fail_manifest(manifest_path, sources, videos, "source_missing", f"源目录不存在：{folder}")
            return 0
    for path in videos:
        if not path.is_file():
            _fail_manifest(manifest_path, sources, videos, "source_missing", f"视频文件不存在：{path}")
            return 0

    images_dir = (project_root / args.images_relative).resolve()
    if not images_dir.is_relative_to(project_root):
        raise ValueError('工作照片目录必须在项目内')
    sheets_dir = project_root / "contact-sheets"
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

    ffmpeg = str(args.ffmpeg) if args.ffmpeg else None
    entries = []
    for folder in sources:
        for path in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
            if path.is_file() and path.suffix.lower() in SUFFIXES:
                entries.append({"path": path, "name": path.name, "kind": "photo", "video": None})
    video_entries = []
    if videos:
        cache_root = args.frame_cache or (project_root / "video-frames")
        video_entries = video_frames.materialise(
            [str(path) for path in videos], cache_root, ffmpeg=ffmpeg, target=args.target_frames,
            min_long_edge=args.min_long_edge,
            log=lambda message: print(message, file=sys.stderr, flush=True))
        for number, entry in enumerate(video_entries, start=1):
            if entry.get("error") or not entry.get("dir"):
                continue
            # Names must stay unique across videos and stable across reruns, so
            # they carry a short content hash instead of the video's position.
            prefix = f"v{entry['report']['video']['sha256'][:8]}-"
            rows = {f"frame-{row['i']:05d}.jpg": row for row in entry["report"]["frames"]}
            for frame in sorted(Path(entry["dir"]).glob("*.jpg")):
                meta = rows.get(frame.name, {})
                entries.append({"path": frame, "name": prefix + frame.name, "kind": "video_frame",
                                "video": {"index": number, "name": entry["name"], "path": entry["path"],
                                          "timeSec": meta.get("t")}})

    video_summary = _video_summary(video_entries, report_root)
    if not entries:
        # The manifest is written even when nothing usable was produced: jobs
        # treats a non-zero exit as a crash and never reaches prepare's verify(),
        # so the actionable message has to travel through the manifest.
        broken = [v for v in video_summary if v.get("error")]
        message = "视频处理失败：" + "；".join(f"{v['name']}（{v['error']}）" for v in broken) \
            if broken else "没有找到可用的图片或视频"
        _write_manifest(manifest_path, {
            "source_dir": str(sources[0]) if sources else "",
            "source_dirs": [str(path) for path in sources],
            "video_sources": [str(path) for path in videos],
            "videos": video_summary, "source_count": 0, "video_frames": 0,
            "retained_count": 0, "excluded": [], "camera_groups": {}, "grouping": {},
            "sources_unchanged": True, "changed_sources": [], "records": [],
            "error": {"code": broken[0].get("errorCode", "decode_failed") if broken else "no_usable_media",
                      "message": message},
        })
        print(message, file=sys.stderr)
        return 0

    records, seen, groups, thumbs = [], {}, {}, []
    for index, entry in enumerate(entries, start=1):
        path = entry["path"]
        digest = sha256_file(path)
        item = {"source": str(path), "name": entry["name"], "bytes": path.stat().st_size,
                "sha256": digest, "excluded": None, "work_image": None, "kind": entry["kind"]}
        if entry["video"]:
            item["video"] = entry["video"]
        try:
            loaded = read_oriented(path, args.ffmpeg)
        except Exception as error:                       # noqa: BLE001 - report and continue
            item["excluded"] = f"decode_failed: {error}"
            records.append(item)
            print(f"  [{index}/{len(entries)}] 解码失败 {path.name}: {error}", file=sys.stderr)
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
        seen.setdefault(digest, entry["name"])

        image.thumbnail((args.long_edge, args.long_edge), Image.Resampling.LANCZOS)
        item["work_size"] = list(image.size)

        if not item["excluded"]:
            key, basis = group_key(tags, original_size, image.size)
            group = groups.setdefault(key, {"name": f"camera-{len(groups) + 1:02d}", "basis": basis})
            folder = images_dir / group["name"]
            folder.mkdir(exist_ok=True)
            out = folder / (Path(entry["name"]).stem + ".jpg")
            if out.exists():
                out = folder / (Path(entry["name"]).stem + '-' + digest[:16] + '.jpg')
            if not out.exists():
                if entry["kind"] == "video_frame" and image.size == tuple(original_size):
                    # Extracted frames already sit at the working resolution;
                    # copying avoids a second JPEG generation loss.
                    shutil.copyfile(path, out)
                else:
                    out_exif[34665] = dict(loaded["useful"])
                    out_exif[34665].update({40962: image.width, 40963: image.height})
                    out_exif[274] = 1
                    image.save(out, "JPEG", quality=args.quality, exif=out_exif)
                item["work_image"] = out.relative_to(project_root).as_posix()
                item["work_sha256"] = sha256_file(out)
                item["camera_group"] = group["name"]
                item["grouping_basis"] = basis
                with Image.open(out) as check:
                    if check.size != image.size or check.getexif().get(274, 1) != 1:
                        raise RuntimeError(f"写入校验失败：{out}")

        preview = image.copy()
        preview.thumbnail((342, 242))
        thumbs.append((preview, entry["name"], item["excluded"]))
        records.append(item)
        if index % 25 == 0 or index == len(entries):
            print(f"  [{index}/{len(entries)}]", file=sys.stderr, flush=True)

    contact_sheets(thumbs, sheets_dir)

    # Frames live in the cache, not in the source folder: only real photos are
    # re-hashed here. Video files are covered by the content hash in the cache path.
    changed = [r["name"] for r in records if r["kind"] == "photo"
               if sha256_file(r["source"]) != r["sha256"]]
    video_summary = _video_summary(video_entries, report_root)
    retained = sum(not r["excluded"] for r in records)
    # Content failures are reported inside the manifest rather than through the
    # exit code: jobs treats a non-zero exit as a crash and never reaches the
    # step's verify(), which is where the actionable message is produced.
    failure = None
    # Deliberately asymmetric between one video and one photo:
    #   * per item - one unusable clip is fatal (a clip is a room or a whole
    #     trajectory; silently dropping it produces a "successful" run that is
    #     missing an area), while one unusable photo is just excluded (1 of 300
    #     is noise).
    #   * aggregate - too little usable material is fatal for both (see the
    #     `retained < 2` branch below, which is a hard COLMAP/Brush precondition).
    # Do not "unify" these two paths in either direction: making videos
    # non-fatal hides a missing room, and making photos fatal wastes a 45-minute
    # run over one bad frame.
    broken = [v for v in video_summary if v.get("error")]
    if broken:
        failure = {"code": broken[0].get("errorCode", "decode_failed"),
                   "message": "视频处理失败：" + "；".join(f"{v['name']}（{v['error']}）" for v in broken)}
    elif retained < 2:
        failure = {"code": "insufficient_media",
                   "message": f"可用图像仅 {retained} 张，至少需要 2 张"
                              + (f"（共排除 {len(records) - retained} 项）" if records else "")}
    summary = {"source_dir": str(sources[0]) if sources else "",
               "source_dirs": [str(path) for path in sources],
               "video_sources": [str(path) for path in videos],
               "videos": video_summary,
               "source_count": len(records),
               "video_frames": sum(1 for r in records if r["kind"] == "video_frame"),
               "retained_count": retained,
               "excluded": [{"name": r["name"], "reason": r["excluded"]}
                            for r in records if r["excluded"]],
               "camera_groups": dict(Counter(r["camera_group"] for r in records
                                             if r.get("camera_group"))),
               "grouping": {g["name"]: g["basis"] for g in groups.values()},
               "sources_unchanged": not changed,
               "changed_sources": changed,
               "records": records}
    if failure:
        summary["error"] = failure
    _write_manifest(manifest_path, summary)

    if changed:
        print(f"源文件在处理期间发生变化：{changed[:5]}", file=sys.stderr)
        return 4
    if failure:
        print(failure["message"], file=sys.stderr)
        return 0

    print(json.dumps({k: v for k, v in summary.items() if k != "records"},
                     ensure_ascii=False, indent=2))
    return 0


def _argv_values(argv, name):
    """Best-effort, non-throwing read of a repeatable --name option.

    main() owns argparse and its parsed args are unreachable once it raises, so
    the top-level boundary recovers the paths it needs without invoking argparse
    a second time (which could itself fail on malformed arguments).
    """
    prefix = "--" + name + "="
    values = []
    for index, token in enumerate(argv):
        if token.startswith(prefix):
            values.append(token[len(prefix):])
        elif token == "--" + name and index + 1 < len(argv):
            values.append(argv[index + 1])
    return values


def _internal_error_manifest(argv):
    """Write the deployment-side failure record. Returns False if impossible."""
    projects = _argv_values(argv, "project")
    if not projects:
        return False
    try:
        manifest_path = Path(projects[0]).resolve() / "manifest.json"
        sources = [Path(value) for value in _argv_values(argv, "source")]
        videos = [Path(value) for value in _argv_values(argv, "video")]
        _fail_manifest(manifest_path, sources, videos, "internal_error",
                       "预处理发生内部错误，请检查运行环境后重试")
    except Exception:                              # noqa: BLE001 - last-resort boundary
        return False
    return True


if __name__ == "__main__":
    try:
        code = main()
    except Exception:                              # noqa: BLE001 - CLI boundary
        # Full detail for operators, but never in the user-facing message.
        traceback.print_exc()
        # jobs halts on a non-zero exit before verify() runs; keeping the
        # "write manifest + return 0" contract preserves the actionable code.
        if not _internal_error_manifest(sys.argv[1:]):
            sys.exit(1)
        sys.exit(0)
    sys.exit(code)
