"""Overview of the ARKit capture: contact sheets plus a top-down trajectory."""
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "data" / "arkit" / "images"
XMP = Path(r"C:\Users\lzx84\Desktop\images\room\Room - 97 images.zip")
SHEETS = ROOT / "runs" / "arkit" / "sheets"

POSITION = re.compile(r"<xcr:Position>([^<]+)</xcr:Position>")
TIMESTAMP = re.compile(r"_(\d+)\.xmp$")

files = sorted(IMAGES.glob("*.jpg"), key=lambda p: int(p.stem.split("_")[-1]))
SHEETS.mkdir(parents=True, exist_ok=True)

for start in range(0, len(files), 24):
    canvas = Image.new("RGB", (1440, 1680), "white")
    draw = ImageDraw.Draw(canvas)
    for index, path in enumerate(files[start:start + 24]):
        with Image.open(path) as source:
            thumb = source.copy()
        thumb.thumbnail((342, 242))
        col, row = index % 4, index // 4
        x, y = col * 360, row * 280
        canvas.paste(thumb, (x + (360 - thumb.width) // 2, y + 4))
        draw.text((x + 10, y + 250), path.stem, fill="black")
    canvas.save(SHEETS / f"arkit-sheet-{start // 24 + 1:02d}.jpg", quality=92)
print(f"sheets={len(list(SHEETS.glob('*.jpg')))} images={len(files)}")

poses = []
for path in sorted(XMP.glob("*.xmp"), key=lambda p: int(TIMESTAMP.search(p.name).group(1))):
    text = path.read_text(encoding="utf-8", errors="replace")
    position = [float(v) for v in POSITION.search(text).group(1).split()]
    poses.append((int(TIMESTAMP.search(path.name).group(1)), position))

width, height = 1000, 800
canvas = Image.new("RGB", (width, height), "white")
draw = ImageDraw.Draw(canvas)
xs = [p[1][0] for p in poses]
ys = [p[1][1] for p in poses]
low_x, high_x, low_y, high_y = min(xs), max(xs), min(ys), max(ys)
scale = min((width - 140) / max(high_x - low_x, 1e-6), (height - 140) / max(high_y - low_y, 1e-6))


def project(position):
    return (70 + (position[0] - low_x) * scale, height - 70 - (position[1] - low_y) * scale)


for i in range(1, len(poses)):
    draw.line([project(poses[i - 1][1]), project(poses[i][1])], fill="#9fb3cc", width=2)
for index, (timestamp, position) in enumerate(poses):
    x, y = project(position)
    ratio = index / max(len(poses) - 1, 1)
    color = (int(30 + 200 * ratio), int(90 - 60 * ratio), int(190 - 150 * ratio))
    draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color)
    if index % 10 == 0:
        draw.text((x + 8, y - 6), f"{index + 1}", fill="#33465e")
draw.text((20, 20), f"ARKit camera path (top view, metres)  X:{low_x:.1f}..{high_x:.1f}  Y:{low_y:.1f}..{high_y:.1f}", fill="black")
draw.text((20, 40), "colour: blue = capture start, red = capture end; numbers = frame order", fill="#46546b")
canvas.save(ROOT / "runs" / "arkit" / "trajectory.png")
print("trajectory ->", ROOT / "runs" / "arkit" / "trajectory.png")
