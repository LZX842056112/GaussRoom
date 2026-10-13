"""Test whether the XMP positions can place both COLMAP models in one frame.

The XMP rotations proved unusable, but the position track looked physically
sane. If the ARKit frames registered in each model agree with those positions,
a similarity transform recovered from them can bring both models together.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_model import images  # noqa: E402
from arkit_to_colmap import XMP_DIR, POSITION, TIMESTAMP, parse  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SPARSE = ROOT / "runs" / "merged" / "sparse"


def umeyama(source, target):
    """Least-squares similarity transform mapping source onto target."""
    source_mean, target_mean = source.mean(0), target.mean(0)
    source_centered, target_centered = source - source_mean, target - target_mean
    covariance = target_centered.T @ source_centered / len(source)
    u, singular, vt = np.linalg.svd(covariance)
    sign = np.ones(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[-1] = -1
    rotation = u @ np.diag(sign) @ vt
    variance = (source_centered ** 2).sum() / len(source)
    scale = (singular * sign).sum() / variance
    translation = target_mean - scale * rotation @ source_mean
    return scale, rotation, translation


def apply_transform(points, scale, rotation, translation):
    return (scale * (rotation @ points.T)).T + translation


def main():
    priors = {}
    for path in XMP_DIR.glob("*.xmp"):
        timestamp = int(TIMESTAMP.search(path.name).group(1))
        text = path.read_text(encoding="utf-8", errors="replace")
        priors[f"IMG_ARKit_{timestamp}.jpg"] = np.array(
            [float(v) for v in POSITION.search(text).group(1).split()])

    report = {}
    for folder in sorted(SPARSE.iterdir()):
        if not (folder / "images.bin").exists():
            continue
        views = images(folder / "images.bin")
        names, centers = [], []
        for view in views:
            key = Path(view["name"]).name
            if key in priors:
                names.append(key)
                centers.append(view["center"])
        if len(names) < 3:
            report[folder.name] = {"arkit_registered": len(names), "status": "too few"}
            continue
        source = np.array(centers)
        target = np.array([priors[n] for n in names])
        scale, rotation, translation = umeyama(source, target)
        residual = np.linalg.norm(apply_transform(source, scale, rotation, translation) - target, axis=1)
        report[folder.name] = {
            "registered_total": len(views),
            "arkit_registered": len(names),
            "scale": round(float(scale), 4),
            "rms_residual_m": round(float(np.sqrt((residual ** 2).mean())), 4),
            "median_residual_m": round(float(np.median(residual)), 4),
            "max_residual_m": round(float(residual.max()), 4),
            "span_m": [round(float(v), 3) for v in (target.max(0) - target.min(0))],
        }
        np.save(ROOT / "runs" / "merged" / f"transform-{folder.name}.npy",
                np.vstack([np.hstack([scale * rotation, translation.reshape(3, 1)]), [0, 0, 0, 1]]))

    print(json.dumps(report, indent=2))
    (ROOT / "runs" / "merged" / "prior-alignment.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
