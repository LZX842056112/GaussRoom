"""Convert ARKit/RealityCapture XMP poses into a COLMAP text model.

The XMP rotation may be camera-to-world or world-to-camera; which one is
correct is decided by triangulation reprojection error, not assumed.
"""
import argparse
import math
import re
import sys
from pathlib import Path

XMP_DIR = Path(r"C:\Users\lzx84\Desktop\images\room\Room - 97 images.zip")
JPEG_DIR = Path(__file__).resolve().parents[1] / "data" / "arkit" / "images"
FULL_FRAME_DIAGONAL = math.hypot(36.0, 24.0)
ROTATION = re.compile(r"<xcr:Rotation>([^<]+)</xcr:Rotation>")
POSITION = re.compile(r"<xcr:Position>([^<]+)</xcr:Position>")
FOCAL = re.compile(r'FocalLength35mm="([^"]+)"')
PRINCIPAL = re.compile(r'PrincipalPointU="([^"]+)"\s+xcr:PrincipalPointV="([^"]+)"')
TIMESTAMP = re.compile(r"_(\d+)\.xmp$")


def parse(xmp_path):
    text = xmp_path.read_text(encoding="utf-8", errors="replace")
    return {
        "rotation": [float(v) for v in ROTATION.search(text).group(1).split()],
        "position": [float(v) for v in POSITION.search(text).group(1).split()],
        "focal35": float(FOCAL.search(text).group(1)),
        "principal": [float(v) for v in PRINCIPAL.search(text).groups()],
        "timestamp": int(TIMESTAMP.search(xmp_path.name).group(1)),
    }


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--convention", choices=["c2w", "w2c"], default="c2w")
    parser.add_argument("--focal-scale", type=float, default=1.0)
    args = parser.parse_args()

    from PIL import Image
    records = sorted((parse(p) for p in XMP_DIR.glob("*.xmp")), key=lambda r: r["timestamp"])
    width, height = Image.open(JPEG_DIR / f"IMG_ARKit_{records[0]['timestamp']}.jpg").size
    diagonal = math.hypot(width, height)

    args.output.mkdir(parents=True, exist_ok=True)
    # One camera for the whole capture: every frame shares the same optics, so
    # average the per-frame values instead of emitting a camera line per image.
    focal = (sum(r["focal35"] for r in records) / len(records)) * diagonal / FULL_FRAME_DIAGONAL * args.focal_scale
    cx = width * (0.5 + sum(r["principal"][0] for r in records) / len(records))
    cy = height * (0.5 + sum(r["principal"][1] for r in records) / len(records))
    camera_lines = [f"1 PINHOLE {width} {height} {focal:.6f} {focal:.6f} {cx:.6f} {cy:.6f}"]
    image_lines, frame_lines = [], []
    for index, record in enumerate(records, start=1):
        name = f"IMG_ARKit_{record['timestamp']}.jpg"
        assert (JPEG_DIR / name).exists(), f"missing converted image: {name}"

        m, center = record["rotation"], record["position"]
        if args.convention == "c2w":
            # m maps camera axes to world; COLMAP stores world-to-camera.
            rotation = [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]]
            translation = [-sum(rotation[i][j] * center[j] for j in range(3)) for i in range(3)]
        else:
            rotation = [m[0:3], m[3:6], m[6:9]]
            translation = center
        qw, qx, qy, qz = matrix_to_quaternion(rotation)
        image_lines.append(
            f"{index} {qw:.9f} {qx:.9f} {qy:.9f} {qz:.9f} "
            f"{translation[0]:.9f} {translation[1]:.9f} {translation[2]:.9f} 1 {name}")
        image_lines.append("")
        # COLMAP 4.2 stores the pose on the frame; single-camera rig => identical to the image pose.
        frame_lines.append(
            f"{index} 1 {qw:.9f} {qx:.9f} {qy:.9f} {qz:.9f} "
            f"{translation[0]:.9f} {translation[1]:.9f} {translation[2]:.9f} 1 CAMERA 1 {index}")

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

    (args.output / "cameras.txt").write_text(
        "# Camera list\n# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n" + "\n".join(camera_lines) + "\n",
        encoding="utf-8")
    (args.output / "images.txt").write_text(
        "# Image list\n# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n# POINTS2D[]\n"
        + "\n".join(image_lines) + "\n", encoding="utf-8")
    (args.output / "points3D.txt").write_text("# 3D point list\n", encoding="utf-8")
    print(f"convention={args.convention} focal_scale={args.focal_scale} images={len(records)} "
          f"size={width}x{height} focal_px={focal:.2f} -> {args.output}")


if __name__ == "__main__":
    sys.exit(main())
