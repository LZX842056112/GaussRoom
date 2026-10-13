"""Create diagnostic orthographic views of an existing sparse model."""
import json
import math
import struct
from pathlib import Path
from PIL import Image, ImageDraw

from check_model import images, unpack

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "runs" / "sfm-001"
summary = json.loads((RUN / "model-summary.json").read_text(encoding="utf-8"))
review = json.loads((ROOT / "data" / "space-review.json").read_text(encoding="utf-8"))
colors = {"bedroom": "#4168b5", "bathroom": "#308e7a", "corridor": "#ba802d", "open_kitchen": "#9259a0"}
for model in summary["models"]:
    folder = Path(model["path"])
    views = images(folder / "images.bin")
    points = []
    with (folder / "points3D.bin").open("rb") as handle:
        count, = unpack(handle, "Q")
        for _ in range(count):
            data = unpack(handle, "QdddBBBd")
            length, = unpack(handle, "Q")
            handle.seek(length * 8, 1)
            if all(math.isfinite(v) for v in data[1:4]):
                points.append((data[1:4], data[4:7]))
    canvas = Image.new("RGB", (1800, 740), "white")
    draw = ImageDraw.Draw(canvas)
    for panel, (a,b,label) in enumerate(((0,1,"XY"),(0,2,"XZ"),(1,2,"YZ"))):
        values = [p[0] for p in points] + [v["center"] for v in views]
        if not values:
            continue
        bounds = []
        for axis in (a,b):
            vals = sorted(v[axis] for v in values)
            low, high = vals[int(len(vals)*.01)], vals[min(len(vals)-1,int(len(vals)*.99))]
            cameras = [v["center"][axis] for v in views if math.isfinite(v["center"][axis])]
            if cameras:
                low, high = min(low, min(cameras)), max(high, max(cameras))
            padding = max((high - low) * .03, .01)
            bounds.append((low - padding, high + padding))
        scale = min(540/max(bounds[0][1]-bounds[0][0],1e-6), 570/max(bounds[1][1]-bounds[1][0],1e-6))
        def project(v):
            return (int(panel*600+30+(v[a]-bounds[0][0])*scale), int(650-(v[b]-bounds[1][0])*scale))
        draw.text((panel*600+30,20), f"Model {folder.name} | {label} | {len(views)} cameras", fill="black")
        draw.rectangle((panel*600+20,50,panel*600+580,670), outline="#d0d8e4")
        for xyz,rgb in points[::max(1,len(points)//25000)]:
            x,y = project(xyz)
            if panel*600+21 <= x < panel*600+580 and 51 <= y < 670:
                draw.point((x,y),fill=rgb)
        for view in views:
            x,y = project(view["center"])
            if not (panel*600+21 <= x < panel*600+580 and 51 <= y < 670):
                continue
            stem = Path(view["name"]).stem
            key = next((k for k,stems in review["spaces"].items() if stem in stems),None)
            color = colors.get(key,"#111111")
            draw.ellipse((x-3,y-3,x+3,y+3),fill=color)
            if key:
                draw.text((x+4,y-8),stem.replace("IMG_",""),fill=color)
    draw.text((25,695),"Camera labels: blue bedroom | teal bathroom | ochre corridor | purple kitchen. Uncalibrated scale; all finite cameras retained, point tails clipped.",fill="#46546b")
    canvas.save(RUN / f"geometry-{folder.name}.png")
    print(RUN / f"geometry-{folder.name}.png")
