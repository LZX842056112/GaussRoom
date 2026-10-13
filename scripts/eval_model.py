"""Report triangulation quality for a single COLMAP model directory."""
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_model import images, points, unpack  # noqa: E402


def main():
    model = Path(sys.argv[1])
    views = images(model / "images.bin")
    stats = points(model / "points3D.bin")

    errors, lengths = [], []
    with (model / "points3D.bin").open("rb") as handle:
        count, = unpack(handle, "Q")
        for _ in range(count):
            values = unpack(handle, "QdddBBBd")
            length, = unpack(handle, "Q")
            handle.seek(length * 8, 1)
            if math.isfinite(values[-1]):
                errors.append(values[-1])
                lengths.append(length)

    centers = [v["center"] for v in views]
    spans = {}
    for axis, name in enumerate("XYZ"):
        values = [c[axis] for c in centers]
        spans[name] = round(max(values) - min(values), 3)

    summary = {
        "model": str(model),
        "images": len(views),
        "points": stats["count"],
        "mean_reprojection_error_px": round(stats["mean_reprojection_error"], 4) if errors else None,
        "median_reprojection_error_px": round(statistics.median(errors), 4) if errors else None,
        "p90_reprojection_error_px": round(sorted(errors)[int(len(errors) * 0.9)], 4) if errors else None,
        "mean_track_length": round(stats["mean_track_length"], 3) if lengths else None,
        "camera_position_spans_m": spans,
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
