"""Decide the XMP pose convention by testing the epipolar constraint.

For each verified image pair the relative pose follows from the candidate
convention; matches that satisfy the epipolar geometry under a wrong
convention are rare, so the fraction of satisfied matches is decisive.
"""
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from triangulate import PAIR_STRIDE, load_poses, read_database  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "runs" / "arkit" / "database.db"


def sampson(matches, first, second, k):
    x1 = np.hstack([matches[:, 0:1], matches[:, 1:2], np.ones((len(matches), 1))])
    x2 = np.hstack([matches[:, 2:3], matches[:, 3:4], np.ones((len(matches), 1))])
    k_inv = np.linalg.inv(k)
    rays1 = (k_inv @ x1.T).T[:, :3]
    rays2 = (k_inv @ x2.T).T[:, :3]
    # Essential matrix from the relative pose: E = [t]x R
    relative_rotation = second[0] @ first[0].T
    relative_translation = second[1] - relative_rotation @ first[1]
    skew = np.array([[0, -relative_translation[2], relative_translation[1]],
                     [relative_translation[2], 0, -relative_translation[0]],
                     [-relative_translation[1], relative_translation[0], 0]])
    essential = skew @ relative_rotation
    numerator = np.einsum("ij,jk,ik->i", rays2, essential, rays1) ** 2
    ex = (essential @ rays1.T).T
    etx = (essential.T @ rays2.T).T
    denominator = ex[:, 0] ** 2 + ex[:, 1] ** 2 + etx[:, 0] ** 2 + etx[:, 1] ** 2
    return np.sqrt(numerator / np.maximum(denominator, 1e-12))


def main():
    keypoints, matches, verified = read_database(DATABASE, 30)
    # read_database returns xy-only keypoints; reload the full match coordinates
    connection = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
    raw = {}
    for pair_id, rows, cols, blob in connection.execute(
            "select pair_id, rows, cols, data from matches"):
        if pair_id in verified:
            raw[pair_id] = np.frombuffer(blob, dtype=np.uint32).reshape(rows, cols)
    connection.close()

    results = {}
    for convention in ("c2w", "w2c"):
        poses, names, k, width, height, focal = load_poses(convention)
        errors = []
        for pair_id, table in raw.items():
            first, second = pair_id // PAIR_STRIDE, pair_id % PAIR_STRIDE
            if first not in poses or second not in poses:
                continue
            a = np.hstack([keypoints[first][table[:, 0]], keypoints[second][table[:, 1]]])
            errors.append(sampson(a, poses[first], poses[second], k))
        merged = np.concatenate(errors) if errors else np.array([np.inf])
        results[convention] = {
            "matches": int(merged.size),
            "median_sampson_px": round(float(np.median(merged)), 4),
            "fraction_below_1px": round(float(np.mean(merged < 1.0)), 4),
            "fraction_below_2px": round(float(np.mean(merged < 2.0)), 4),
        }
    print(json.dumps(results, indent=2))
    (ROOT / "runs" / "arkit" / "convention-test.json").write_text(
        json.dumps(results, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
