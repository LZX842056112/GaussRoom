"""Merge the two COLMAP models into one, using the XMP positions as common frame.

Each model is aligned to the XMP track by a similarity transform recovered from
its registered ARKit frames (rms ~2 cm), then both are written into a single
COLMAP text model with renumbered ids.
"""
import json
import math
import sqlite3
import struct
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_model import images, unpack  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SPARSE = ROOT / "runs" / "merged" / "sparse"
OUTPUT = ROOT / "data" / "merged" / "sparse"

PARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}
NAMES = {0: "SIMPLE_PINHOLE", 1: "PINHOLE", 2: "SIMPLE_RADIAL", 3: "RADIAL",
         4: "OPENCV", 5: "OPENCV_FISHEYE", 6: "FULL_OPENCV", 7: "FOV",
         8: "SIMPLE_RADIAL_FISHEYE", 9: "RADIAL_FISHEYE", 10: "THIN_PRISM_FISHEYE"}


def cameras(path):
    out = {}
    with path.open("rb") as handle:
        count, = unpack(handle, "Q")
        for _ in range(count):
            camera_id, model_id = unpack(handle, "ii")
            width, height = unpack(handle, "QQ")
            params = unpack(handle, "d" * PARAMS[model_id])
            out[camera_id] = (model_id, width, height, params)
    return out


def matrix_to_quaternion(r):
    trace = r[0][0] + r[1][1] + r[2][2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        return 0.25 * s, (r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s
    if r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        s = math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2
        return (r[2][1] - r[1][2]) / s, 0.25 * s, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s
    if r[1][1] > r[2][2]:
        s = math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2
        return (r[0][2] - r[2][0]) / s, (r[0][1] + r[1][0]) / s, 0.25 * s, (r[1][2] + r[2][1]) / s
    s = math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2
    return (r[1][0] - r[0][1]) / s, (r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, 0.25 * s


def read_points(path):
    out = []
    with path.open("rb") as handle:
        count, = unpack(handle, "Q")
        for _ in range(count):
            values = unpack(handle, "QdddBBBd")
            length, = unpack(handle, "Q")
            track = [unpack(handle, "ii") for _ in range(length)]
            out.append((values[1:4], values[4:7], values[7], track))
    return out


def load_keypoints(database):
    """Keypoint xy per image name, so points2D lines match the tracks."""
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    names = dict(connection.execute("select image_id, name from images"))
    keypoints = {}
    for image_id, rows, cols, blob in connection.execute(
            "select image_id, rows, cols, data from keypoints"):
        keypoints[names[image_id]] = np.frombuffer(blob, dtype=np.float32).reshape(rows, cols)[:, :2]
    connection.close()
    return keypoints


def main():
    keypoints = load_keypoints(ROOT / "runs" / "merged" / "database.db")
    camera_lines, image_meta, frame_lines = [], [], []
    camera_offset = image_offset = point_offset = 0
    observations = defaultdict(list)
    point_records = []
    stats = []

    for folder in sorted(SPARSE.iterdir()):
        if not (folder / "images.bin").exists():
            continue
        transform = np.load(ROOT / "runs" / "merged" / f"transform-{folder.name}.npy")
        scale_rotation, translation = transform[:3, :3], transform[:3, 3]
        rotation_only = scale_rotation / np.cbrt(np.linalg.det(scale_rotation))

        model_cameras = cameras(folder / "cameras.bin")
        views = images(folder / "images.bin")
        points = read_points(folder / "points3D.bin")

        camera_id_map = {}
        for camera_id, (model_id, width, height, params) in sorted(model_cameras.items()):
            camera_offset += 1
            camera_id_map[camera_id] = camera_offset
            camera_lines.append(f"{camera_offset} {NAMES[model_id]} {width} {height} "
                                + " ".join(f"{p:.9f}" for p in params))

        image_id_map, image_names = {}, {}
        for view in sorted(views, key=lambda v: v["id"]):
            image_offset += 1
            image_id_map[view["id"]] = image_offset
            image_names[image_offset] = view["name"]
            w, x, y, z = view["qvec"]
            rotation_matrix = np.array([
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
            new_rotation = rotation_matrix @ rotation_only.T
            center = scale_rotation @ np.array(view["center"]) + translation
            new_translation = -new_rotation @ center
            qw, qx, qy, qz = matrix_to_quaternion(new_rotation.tolist())
            pose = (f"{qw:.9f} {qx:.9f} {qy:.9f} {qz:.9f} "
                    f"{new_translation[0]:.9f} {new_translation[1]:.9f} {new_translation[2]:.9f}")
            image_meta.append((image_offset, pose, camera_id_map[view["camera_id"]], view["name"]))
            frame_lines.append(f"{image_offset} {camera_id_map[view['camera_id']]} {pose} 1 "
                               f"CAMERA {camera_id_map[view['camera_id']]} {image_offset}")

        for xyz, rgb, error, track in points:
            entries = [(image_id_map[i], k) for i, k in track if i in image_id_map]
            if not entries:
                continue
            point_offset += 1
            new_xyz = scale_rotation @ np.array(xyz) + translation
            point_records.append((point_offset, new_xyz, rgb, error, entries))
            for image_id, key_index in entries:
                observations[image_id].append((key_index, point_offset))
        stats.append({"model": folder.name, "images": len(views), "points": len(points)})

    index_in_image = {}
    image_lines = []
    for image_id, pose, camera_id, name in image_meta:
        entries = sorted(observations.get(image_id, []))
        index_in_image[image_id] = {key_index: position for position, (key_index, _) in enumerate(entries)}
        image_lines.append(f"{image_id} {pose} {camera_id} {name}")
        pixels = keypoints.get(name)
        parts = []
        for position, (key_index, point_id) in enumerate(entries):
            if pixels is None or key_index >= len(pixels):
                continue
            x, y = pixels[key_index]
            parts.append(f"{x:.4f} {y:.4f} {point_id}")
        image_lines.append(" ".join(parts))

    point_lines = []
    for point_id, xyz, rgb, error, entries in point_records:
        track = " ".join(f"{image_id} {index_in_image[image_id][key_index]}"
                         for image_id, key_index in entries
                         if key_index in index_in_image.get(image_id, {}))
        if not track:
            continue
        point_lines.append(f"{point_id} {xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f} "
                           f"{rgb[0]} {rgb[1]} {rgb[2]} {error:.6f} {track}")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "cameras.txt").write_text(
        "# Camera list\n# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n" + "\n".join(camera_lines) + "\n",
        encoding="utf-8")
    (OUTPUT / "images.txt").write_text(
        "# Image list\n# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n# POINTS2D[]\n"
        + "\n".join(image_lines) + "\n", encoding="utf-8")
    (OUTPUT / "points3D.txt").write_text("# 3D point list\n" + "\n".join(point_lines) + "\n", encoding="utf-8")
    (OUTPUT / "rigs.txt").write_text(
        "# Rig calib list with one line of data per calib:\n"
        "#   RIG_ID, NUM_SENSORS, REF_SENSOR_TYPE, REF_SENSOR_ID, SENSORS[] as "
        "(SENSOR_TYPE, SENSOR_ID, HAS_POSE, [QW, QX, QY, QZ, TX, TY, TZ])\n"
        f"# Number of rigs: {camera_offset}\n"
        + "\n".join(f"{camera_id} 1 CAMERA {camera_id}" for camera_id in range(1, camera_offset + 1))
        + "\n", encoding="utf-8")
    (OUTPUT / "frames.txt").write_text(
        "# Frame list with one line of data per frame:\n"
        "#   FRAME_ID, RIG_ID, RIG_FROM_WORLD[QW, QX, QY, QZ, TX, TY, TZ], NUM_DATA_IDS, "
        "DATA_IDS[] as (SENSOR_TYPE, SENSOR_ID, DATA_ID)\n"
        f"# Number of frames: {len(frame_lines)}\n" + "\n".join(frame_lines) + "\n", encoding="utf-8")

    summary = {"merged_images": image_offset, "merged_points": len(point_lines),
               "merged_cameras": camera_offset, "per_model": stats}
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
