"""Decode the ARKit HEIC captures to JPEG work copies (long edge <= 2048).

ffmpeg pipes a full-resolution JPEG per capture; Pillow does the scaling so the
aspect ratio is preserved exactly. HEIC tile-grid streams cannot take -vf.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

FFMPEG = Path(r"C:\Users\lzx84\AppData\Local\Microsoft\WinGet\Packages"
              r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
              r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.EXE")
SOURCE = Path(r"C:\Users\lzx84\Desktop\images\room\Room - 97 images.zip")
DEST = Path(__file__).resolve().parents[1] / "data" / "arkit" / "images"


def already_scaled(target):
    """True when the file was produced by this script (aspect preserved)."""
    if not target.exists():
        return False
    try:
        with Image.open(target) as existing:
            return max(existing.size) == 2048 and existing.width != existing.height
    except Exception:
        return False


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    sources = sorted(SOURCE.glob("*.heic"))
    assert sources, "no HEIC found"
    failures, sizes, skipped = [], set(), 0
    for index, source in enumerate(sources, start=1):
        target = DEST / (source.stem + ".jpg")
        if already_scaled(target):
            skipped += 1
            continue
        command = [
            str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-frames:v", "1",
            "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "-",
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            failures.append((source.name, "ffmpeg timeout"))
            continue
        if result.returncode != 0 or not result.stdout:
            failures.append((source.name, result.stderr.decode(errors="replace")[:200]))
            continue
        import io
        with Image.open(io.BytesIO(result.stdout)) as image:
            image = image.convert("RGB")
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            sizes.add(image.size)
            image.save(target, "JPEG", quality=94)
        if index % 10 == 0:
            print(f"  {index}/{len(sources)}", flush=True)
    print(f"total={len(list(DEST.glob('*.jpg')))}/{len(sources)} skipped={skipped} "
          f"failures={len(failures)} new_sizes={sorted(sizes)}", flush=True)
    for name, error in failures[:5]:
        print(f"  FAIL {name}: {error}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
