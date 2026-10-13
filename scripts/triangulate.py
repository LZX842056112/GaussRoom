"""Triangulate the ARKit captures with their known poses.

Serves two purposes: it verifies the XMP poses against the SIFT matches
(reprojection error), and it produces the sparse point cloud Brush needs.
COLMAP's own point_triangulator exits abnormally in this environment.
"""
import argparse
import json
import math
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from arkit_to_colmap import (JPEG_DIR, XMP_DIR, FULL_FRAME_DIAGONAL,  # noqa: E402
                             matrix_to_quaternion, parse)

ROOT = Path(__file__).resolve().parents[1]
PAIR_STRIDE = 2147483647


def load_poses(convention, focal_scale=1.0):
    from PIL import Image
    records = sorted((parse(p) for p in XMP_DIR.glob("*.xmp")), key=lambda r: r["timestamp"])
    width, height = Image.open(JPEG_DIR / f"IMG_ARKit_{records[0]['timestamp']}.jpg").size
    focal = (sum(r["focal35"] for r in records) / len(records)) * math.hypot(width, height) \
        / FULL_FRAME_DIAGONAL * focal_scale
    cx = width * (0.5 + sum(r["principal"][0] for r in records) / len(records))
    cy = height * (0.5 + sum(r["principal"][1] for r in records) / len(records))
    k = np.array([[focal, 0, cx], [0, focal, cy], [0, 0, 1]], dtype=np.float64)

    # ARKit camera axes look down -Z, COLMAP expects +Z, so the camera frame
    # needs the Y/Z flip whenever the XMP rotation is camera-to-world.
    axis_flip = np.diag([1.0, -1.0, -1.0])
    poses, names = {}, {}
    for index, record in enumerate(records, start=1):
        name = f"IMG_ARKit_{record['timestamp']}.jpg"
        m, center = record["rotation"], record["position"]
        if convention.startswith("c2w"):
            rotation = np.array([[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]])
            if convention == "c2w-flip":
                rotation = axis_flip @ rotation
            translation = -rotation @ np.array(center)
        else:
            rotation = np.array([m[0:3], m[3:6], m[6:9]])
            if convention == "w2c-flip":
                rotation = axis_flip @ rotation
            translation = np.array(center)
        poses[index] = (rotation, translation)
        names[index] = name
    return poses, names, k, width, height, focal


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, item):
        self.parent.setdefault(item, item)
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def read_database(path, min_inliers):
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    keypoints = {}
    for image_id, rows, cols, blob in connection.execute(
            "select image_id, rows, cols, data from keypoints"):
        # COLMAP stores x, y plus optional scale/orientation; only xy is needed.
        keypoints[image_id] = np.frombuffer(blob, dtype=np.float32).reshape(rows, cols)[:, :2]

    verified = {pair_id: rows for pair_id, rows in connection.execute(
        "select pair_id, rows from two_view_geometries where rows >= ?", (min_inliers,))}
    matches = {}
    for pair_id, rows, cols, blob in connection.execute(
            "select pair_id, rows, cols, data from matches"):
        if pair_id in verified:
            matches[pair_id] = np.frombuffer(blob, dtype=np.uint32).reshape(rows, cols)
    connection.close()
    return keypoints, matches, verified


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--database", type=Path, default=ROOT / "runs" / "arkit" / "database.db")
    parser.add_argument("--convention", choices=["c2w", "c2w-flip", "w2c", "w2c-flip"], default="c2w-flip")
    parser.add_argument("--focal-scale", type=float, default=1.0)
    parser.add_argument("--min-inliers", type=int, default=30)
    parser.add_argument("--max-error", type=float, default=2.0)
    parser.add_argument("--min-angle", type=float, default=1.5)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    poses, names, k, width, height, focal = load_poses(args.convention, args.focal_scale)
    keypoints, matches, verified = read_database(args.database, args.min_inliers)
    print(f"poses={len(poses)} verified_pairs={len(verified)} usable_pairs={len(matches)}", flush=True)

    projections, centers = {}, {}
    for image_id, (rotation, translation) in poses.items():
        projections[image_id] = k @ np.hstack([rotation, translation.reshape(3, 1)])
        centers[image_id] = -rotation.T @ translation

    def triangulate(observation_list):
        """DLT over the given observations, returning xyz plus max reprojection error."""
        rows = np.empty((len(observation_list) * 2, 4))
        for position, (image_id, key_index) in enumerate(observation_list):
            x, y = keypoints[image_id][key_index]
            projection = projections[image_id]
            rows[2 * position] = x * projection[2] - projection[0]
            rows[2 * position + 1] = y * projection[2] - projection[1]
        _, _, vh = np.linalg.svd(rows)
        homogeneous = vh[-1]
        if abs(homogeneous[3]) < 1e-9:
            return None, None
        xyz = homogeneous[:3] / homogeneous[3]
        worst = 0.0
        for image_id, key_index in observation_list:
            projection = projections[image_id]
            projected = projection @ np.append(xyz, 1.0)
            if projected[2] <= 1e-9:
                return None, None
            worst = max(worst, float(np.linalg.norm(projected[:2] / projected[2]
                                                   - keypoints[image_id][key_index])))
        return xyz, worst

    def opening_angle(xyz, observation_list):
        rays = []
        for image_id, _ in observation_list[:6]:
            ray = xyz - centers[image_id]
            norm = np.linalg.norm(ray)
            if norm > 1e-9:
                rays.append(ray / norm)
        if len(rays) < 2:
            return 0.0
        return max(math.degrees(math.acos(float(np.clip(rays[i] @ rays[j], -1, 1))))
                   for i in range(len(rays)) for j in range(i + 1, len(rays)))

    # Phase 1: per-pair triangulation. Removing gross outliers before merging stops
    # union-find from chaining unrelated observations into one track.
    union = UnionFind()
    kept_pairs = 0
    for pair_id, table in matches.items():
        first, second = pair_id // PAIR_STRIDE, pair_id % PAIR_STRIDE
        if first not in poses or second not in poses:
            continue
        a, b = keypoints[first][table[:, 0]], keypoints[second][table[:, 1]]
        pa, pb = projections[first], projections[second]
        rows = np.empty((len(table), 4, 4))
        rows[:, 0] = a[:, 0:1] * pa[2] - pa[0]
        rows[:, 1] = a[:, 1:2] * pa[2] - pa[1]
        rows[:, 2] = b[:, 0:1] * pb[2] - pb[0]
        rows[:, 3] = b[:, 1:2] * pb[2] - pb[1]
        _, _, vh = np.linalg.svd(rows)
        homogeneous = vh[:, -1]
        valid = np.abs(homogeneous[:, 3]) > 1e-9
        xyz = np.zeros((len(table), 3))
        xyz[valid] = homogeneous[valid, :3] / homogeneous[valid, 3:4]

        error = np.zeros(len(table))
        for projection, observed in ((pa, a), (pb, b)):
            camera = (projection @ np.hstack([xyz, np.ones((len(xyz), 1))]).T).T
            ahead = camera[:, 2] > 1e-9
            projected = np.full((len(xyz), 2), np.inf)
            projected[ahead] = camera[ahead, :2] / camera[ahead, 2:3]
            error = np.maximum(error, np.where(ahead, np.linalg.norm(projected - observed, axis=1), np.inf))
        ray_a = xyz - centers[first]
        ray_b = xyz - centers[second]
        ray_a /= np.linalg.norm(ray_a, axis=1, keepdims=True) + 1e-12
        ray_b /= np.linalg.norm(ray_b, axis=1, keepdims=True) + 1e-12
        angle = np.degrees(np.arccos(np.clip(np.einsum("ij,ij->i", ray_a, ray_b), -1, 1)))

        keep = valid & (error < args.max_error) & (angle > args.min_angle)
        for key_a, key_b in table[keep]:
            union.union((first, int(key_a)), (second, int(key_b)))
        kept_pairs += int(keep.sum())
    print(f"pair_observations_kept={kept_pairs}", flush=True)

    tracks = defaultdict(list)
    for observation in union.parent:
        tracks[union.find(observation)].append(observation)
    print(f"tracks={len(tracks)}", flush=True)

    # Phase 2: refine each track with all of its observations.
    points, errors, angles = [], [], []
    for items in tracks.values():
        if len(items) < 2 or len({image for image, _ in items}) < 2:
            continue
        xyz, worst = triangulate(sorted(items))
        if xyz is None or worst > args.max_error:
            continue
        angle = opening_angle(xyz, sorted(items))
        if angle < args.min_angle:
            continue
        points.append((xyz, items, worst))
        errors.append(worst)
        angles.append(angle)

    print(f"triangulated_points={len(points)}", flush=True)

    # Colour each point from the first observing image.
    from PIL import Image
    image_pixels = {}
    for image_id in {item[0] for p in points for item in p[1]}:
        with Image.open(JPEG_DIR / names[image_id]) as handle:
            image_pixels[image_id] = np.asarray(handle.convert("RGB"))

    args.output.mkdir(parents=True, exist_ok=True)
    lines3d, per_image = [], defaultdict(list)
    for index, (xyz, items, worst) in enumerate(points, start=1):
        image_id, key_index = items[0]
        pixels = image_pixels[image_id]
        x, y = keypoints[image_id][key_index]
        colour = pixels[int(np.clip(round(y), 0, height - 1)), int(np.clip(round(x), 0, width - 1))]
        track = " ".join(f"{img} {int(kp)}" for img, kp in items)
        lines3d.append(f"{index} {xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f} "
                       f"{colour[0]} {colour[1]} {colour[2]} {worst:.6f} {track}")
        for img, kp in items:
            per_image[img].append((kp, index))

    camera_line = f"1 PINHOLE {width} {height} {focal:.6f} {focal:.6f} {k[0,2]:.6f} {k[1,2]:.6f}"
    (args.output / "cameras.txt").write_text(
        "# Camera list\n# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n" + camera_line + "\n", encoding="utf-8")

    image_lines, frame_lines = [], []
    for image_id in sorted(poses):
        rotation, translation = poses[image_id]
        qw, qx, qy, qz = matrix_to_quaternion(rotation.tolist())
        pose = (f"{qw:.9f} {qx:.9f} {qy:.9f} {qz:.9f} "
                f"{translation[0]:.9f} {translation[1]:.9f} {translation[2]:.9f}")
        image_lines.append(f"{image_id} {pose} 1 {names[image_id]}")
        entries = per_image.get(image_id, [])
        image_lines.append(" ".join(f"{keypoints[image_id][kp][0]:.4f} {keypoints[image_id][kp][1]:.4f} {pid}"
                                    for kp, pid in sorted(entries)))
        frame_lines.append(f"{image_id} 1 {pose} 1 CAMERA 1 {image_id}")
    (args.output / "images.txt").write_text(
        "# Image list\n# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n# POINTS2D[]\n"
        + "\n".join(image_lines) + "\n", encoding="utf-8")
    (args.output / "points3D.txt").write_text("# 3D point list\n" + "\n".join(lines3d) + "\n", encoding="utf-8")
    (args.output / "rigs.txt").write_text(
        "# Rig calib list with one line of data per calib:\n"
        "#   RIG_ID, NUM_SENSORS, REF_SENSOR_TYPE, REF_SENSOR_ID, SENSORS[] as "
        "(SENSOR_TYPE, SENSOR_ID, HAS_POSE, [QW, QX, QY, QZ, TX, TY, TZ])\n"
        "# Number of rigs: 1\n1 1 CAMERA 1\n", encoding="utf-8")
    (args.output / "frames.txt").write_text(
        "# Frame list with one line of data per frame:\n"
        "#   FRAME_ID, RIG_ID, RIG_FROM_WORLD[QW, QX, QY, QZ, TX, TY, TZ], NUM_DATA_IDS, "
        "DATA_IDS[] as (SENSOR_TYPE, SENSOR_ID, DATA_ID)\n"
        f"# Number of frames: {len(frame_lines)}\n" + "\n".join(frame_lines) + "\n", encoding="utf-8")

    report = {
        "convention": args.convention,
        "focal_scale": args.focal_scale,
        "focal_px": round(focal, 3),
        "image_size": [width, height],
        "verified_pairs": len(verified),
        "usable_pairs": len(matches),
        "tracks": len(tracks),
        "points": len(points),
        "observations": sum(len(p[1]) for p in points),
        "mean_reprojection_error_px": round(float(np.mean(errors)), 4) if errors else None,
        "median_reprojection_error_px": round(float(np.median(errors)), 4) if errors else None,
        "p90_reprojection_error_px": round(float(np.percentile(errors, 90)), 4) if errors else None,
        "median_triangulation_angle_deg": round(float(np.median(angles)), 3) if angles else None,
        "images_with_points": len(per_image),
    }
    print(json.dumps(report, indent=2))
    if args.report:
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
