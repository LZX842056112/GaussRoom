// Derive a sensible default viewer pose from the reconstruction itself.
//
// The COLMAP world frame is arbitrary (defined by the first registered image), so
// a hardcoded camera pose is meaningless across projects. Instead we stand at the
// centroid of the recorded camera path and look down the direction the path runs.
//
// Note: the mean of the camera viewing directions is NOT usable here — in a
// corridor the photographer shoots both ways, so the two clusters cancel out
// (measured resultant length ~0.34). The trajectory's principal axis is the
// robust signal instead.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { dirs, sparseModels } from "./pipeline.mjs";

const cache = new Map();

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * The cameras' own "up" in world coordinates. A camera's local -Y is its up, so
 * world up = R^T·(0,-1,0) = -(second row of R). COLMAP anchors the world frame on
 * the first image using the computer-vision convention (+Y is image-down), so this
 * frequently comes out as -Y — i.e. the scene is upside down for a Y-up viewer.
 *
 * @returns {{up: number[], resultant: number}|null}
 */
function impliedUp(centers, rotations) {
  if (!rotations.length) return null;
  const sum = [0, 0, 0];
  for (const rotation of rotations) {
    for (let axis = 0; axis < 3; axis += 1) sum[axis] -= rotation[1][axis];
  }
  const resultant = Math.hypot(sum[0], sum[1], sum[2]) / rotations.length;
  return { up: normalize(sum), resultant };
}

/**
 * Orthonormal basis (rows e_x, e_y, e_z) that re-expresses reconstruction
 * coordinates in an upright, Y-up frame: `v_upright = (v·e_x, v·e_y, v·e_z)`.
 */
function uprightBasis(up) {
  const reference = Math.abs(up[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const e_x = normalize(cross(up, reference));
  const e_z = cross(e_x, up);
  return [e_x, up, e_z];
}

function readCameraCenters(path) {
  const buffer = readFileSync(path);
  let offset = 0;
  const count = Number(buffer.readBigUInt64LE(offset));
  offset += 8;
  const centers = [];
  const rotations = [];
  for (let index = 0; index < count; index += 1) {
    // COLMAP images.bin record: image_id(i32) qvec(4×f64) tvec(3×f64) camera_id(i32)
    offset += 4;
    const q = [0, 1, 2, 3].map((i) => buffer.readDoubleLE(offset + i * 8));
    offset += 32;
    const translation = [0, 1, 2].map((i) => buffer.readDoubleLE(offset + i * 8));
    offset += 24;
    offset += 4;
    while (buffer[offset] !== 0) offset += 1;
    offset += 1;
    const points2d = Number(buffer.readBigUInt64LE(offset));
    offset += 8 + points2d * 24;

    const [w, x, y, z] = q;
    const rotation = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    centers.push([0, 1, 2].map((i) => -rotation.reduce((sum, row, j) => sum + row[i] * translation[j], 0)));
    rotations.push(rotation);
  }
  return { centers, rotations };
}

/**
 * @returns {{position: number[], yaw: number, pitch: number, basis: number[][],
 *            cameras: number, elongation: number, up: number[],
 *            upResultant: number}|null}
 */
export function scenePose(project) {
  const models = sparseModels(project);
  const selected = project.selectedModel && models.includes(project.selectedModel)
    ? project.selectedModel
    : models[0];
  if (!selected) return null;

  const imagesPath = resolve(dirs(project).sparse, selected, "images.bin");
  if (!existsSync(imagesPath)) return null;

  const stamp = `${imagesPath}:${statSync(imagesPath).mtimeMs}`;
  const cached = cache.get(project.id);
  if (cached && cached.stamp === stamp) return cached.pose;

  let pose = null;
  try {
    const { centers, rotations } = readCameraCenters(imagesPath);
    if (centers.length >= 3) {
      const frame = impliedUp(centers, rotations);
      // Only trust the correction when the cameras agree on where "up" is.
      const basis = frame && frame.resultant > 0.5 ? uprightBasis(frame.up) : null;
      const toUpright = basis
        ? (v) => [dot(v, basis[0]), dot(v, basis[1]), dot(v, basis[2])]
        : (v) => v;

      const upright = centers.map(toUpright);
      const position = [0, 1, 2].map((axis) =>
        upright.reduce((sum, c) => sum + c[axis], 0) / upright.length);

      // 相机轨迹的尺度：从质心到最远相机的距离。观众能走到哪里，场景就有多大，
      // 用它定查看器的缩放上限。不用高斯点的包围盒——3DGS 常有远处的漂浮点，
      // 本项目实测包围球半径 64，而房间本体只有 8 左右，用包围盒会把上限撑到 192。
      const extent = Math.max(...upright.map((center) =>
        Math.hypot(center[0] - position[0], center[1] - position[1], center[2] - position[2])));

      // Principal axis of the horizontal camera path (2x2 eigenvector).
      const xs = upright.map((c) => c[0] - position[0]);
      const zs = upright.map((c) => c[2] - position[2]);
      const sxx = xs.reduce((sum, v) => sum + v * v, 0) / upright.length;
      const szz = zs.reduce((sum, v) => sum + v * v, 0) / upright.length;
      const sxz = xs.reduce((sum, v, i) => sum + v * zs[i], 0) / upright.length;
      const trace = sxx + szz;
      const det = sxx * szz - sxz * sxz;
      const eigenvalue = trace / 2 + Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
      let axis = [eigenvalue - szz, sxz];
      const length = Math.hypot(axis[0], axis[1]) || 1;
      axis = [axis[0] / length, axis[1] / length];

      // Face the longer remaining stretch of the path, so the opening shot looks
      // down the space rather than into a nearby wall.
      let ahead = 0;
      let behind = 0;
      for (const center of upright) {
        const along = (center[0] - position[0]) * axis[0] + (center[2] - position[2]) * axis[1];
        if (along > 0) ahead = Math.max(ahead, along);
        else behind = Math.max(behind, -along);
      }
      const sign = ahead >= behind ? 1 : -1;
      const direction = [axis[0] * sign, axis[1] * sign];

      // Three.js looks along local -Z; yaw is such that R_y(yaw)·(0,0,-1) = direction.
      const yaw = Math.atan2(-direction[0], -direction[1]);
      pose = {
        position,
        yaw,
        pitch: 0,
        basis,
        extent,
        cameras: centers.length,
        elongation: Math.max(sxx, szz) / Math.max(1e-6, Math.min(sxx, szz)),
        up: frame ? frame.up : null,
        upResultant: frame ? frame.resultant : 0,
      };
    }
  } catch (error) {
    console.error(`[workbench] 计算默认机位失败（${project.id}）：${error.message}`);
    pose = null;
  }

  cache.set(project.id, { stamp, pose });
  return pose;
}
