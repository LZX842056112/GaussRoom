// Step definitions, command construction, progress parsing and gate thresholds.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PY_DIR, PROJECTS_DIR, TOOLS } from "./paths.mjs";

export const STEP_ORDER = [
  { id: "prepare", name: "照片预处理" },
  { id: "features", name: "特征提取" },
  { id: "match", name: "特征匹配" },
  { id: "sparse", name: "稀疏重建" },
  { id: "gate", name: "几何门禁" },
  { id: "undistort", name: "去畸变" },
  { id: "train", name: "Brush 训练" },
];

export const STEP_WEIGHTS = {
  prepare: 0.05, features: 0.10, match: 0.20, sparse: 0.25,
  gate: 0.0, undistort: 0.05, train: 0.35,
};

// Hard ceilings so a hung child cannot hold the single job slot forever.
// Roughly 2-3x the observed runtime for the largest dataset tested here.
export const STEP_TIMEOUT_MS = {
  prepare: 15 * 60_000,
  features: 30 * 60_000,
  match: 120 * 60_000,
  sparse: 60 * 60_000,
  gate: 2 * 60_000,
  undistort: 30 * 60_000,
  train: 180 * 60_000,
};

export const GATE = {
  minRatio: 0.80,
  maxError: 2.0,
  minPoints: 5000,
  fragmentShare: 0.05,
};

export const CAMERA_MODELS = ["SIMPLE_RADIAL", "OPENCV", "RADIAL", "PINHOLE"];

export const TRAINING_PRESETS = {
  fast: { label: "快速预览", totalSteps: 10000, maxSplats: 500000, shDegree: 1, exportEvery: 2000, eta: "约 20 分钟", ply: "约 50 MB" },
  standard: { label: "标准", totalSteps: 20000, maxSplats: 800000, shDegree: 2, exportEvery: 5000, eta: "约 40 分钟", ply: "约 100 MB" },
  full: { label: "完整", totalSteps: 30000, maxSplats: 1000000, shDegree: 2, exportEvery: 5000, eta: "约 60 分钟", ply: "约 150 MB" },
};

export function dirs(project) {
  const root = resolve(PROJECTS_DIR, project.id);
  return {
    root,
    images: resolve(root, "images"),
    sfm: resolve(root, "sfm"),
    sparse: resolve(root, "sfm", "sparse"),
    summary: resolve(root, "summary"),
    undistorted: resolve(root, "undistorted"),
    train: resolve(root, "train"),
    logs: resolve(root, "logs"),
  };
}

export function manifestSummary(project) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(dirs(project).root, "manifest.json"), "utf8"));
    return { retained: manifest.retained_count, groups: manifest.camera_groups };
  } catch {
    return { retained: 0, groups: {} };
  }
}

export function readGate(project) {
  try {
    return JSON.parse(readFileSync(resolve(dirs(project).summary, "gate.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Sub-directories of sfm/sparse that actually contain a binary COLMAP model. */
export function sparseModels(project) {
  const folder = dirs(project).sparse;
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(folder, entry.name, "images.bin")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Build the ordered step list.  Every step exposes `command(project)` so later
 * steps can depend on artefacts produced by earlier ones (the gate selects which
 * sparse model the undistorter consumes).
 */
export function buildSteps() {
  return [
    {
      id: "prepare",
      name: "照片预处理",
      clean: (d) => [d.images, resolve(d.root, "contact-sheets"), resolve(d.root, "manifest.json")],
      command: (project) => ({
        cmd: TOOLS.python,
        args: [
          resolve(PY_DIR, "prepare_project.py"),
          "--source", project.sourceDir,
          "--project", dirs(project).root,
          "--long-edge", "2048",
          "--min-long-edge", "1000",
          "--ffmpeg", TOOLS.ffmpeg,
        ],
      }),
      verify: (project) => {
        const summary = manifestSummary(project);
        return summary.retained >= 2
          ? { ok: true }
          : { ok: false, message: `预处理后可用图像仅 ${summary.retained} 张` };
      },
    },
    {
      id: "features",
      name: "特征提取",
      clean: (d) => [resolve(d.sfm, "database.db")],
      ensure: (d) => [d.sfm],
      command: (project) => ({
        cmd: project.useGpu ? TOOLS.colmapGpu : TOOLS.colmapCpu,
        args: [
          "feature_extractor",
          "--database_path", resolve(dirs(project).sfm, "database.db"),
          "--image_path", dirs(project).images,
          "--ImageReader.camera_model", project.cameraModel,
          "--ImageReader.single_camera_per_folder", "1",
          "--FeatureExtraction.use_gpu", project.useGpu ? "1" : "0",
          "--FeatureExtraction.gpu_index", "0",
          "--FeatureExtraction.num_threads", "12",
          "--log_path", dirs(project).sfm,
          "--log_color", "0",
        ],
      }),
      progress: (line) => {
        const found = /Processing file \[(\d+)\/(\d+)\]/.exec(line);
        return found ? Number(found[1]) / Number(found[2]) : null;
      },
      verify: (project) => {
        const database = resolve(dirs(project).sfm, "database.db");
        return existsSync(database) && readFileSync(database).length > 0
          ? { ok: true }
          : { ok: false, message: "特征数据库未生成" };
      },
    },
    {
      id: "match",
      name: "特征匹配",
      command: (project) => ({
        cmd: project.useGpu ? TOOLS.colmapGpu : TOOLS.colmapCpu,
        args: [
          "exhaustive_matcher",
          "--database_path", resolve(dirs(project).sfm, "database.db"),
          "--FeatureMatching.use_gpu", project.useGpu ? "1" : "0",
          "--FeatureMatching.num_threads", "12",
          "--log_path", dirs(project).sfm,
          "--log_color", "0",
        ],
      }),
      progress: (line) => {
        const found = /Matching block \[(\d+)\/(\d+), (\d+)\/(\d+)\]/.exec(line);
        if (!found) return null;
        const [row, rows, col, cols] = found.slice(1).map(Number);
        return ((row - 1) * cols + col) / (rows * cols);
      },
    },
    {
      id: "sparse",
      name: "稀疏重建",
      clean: (d) => [d.sparse],
      ensure: (d) => [d.sparse],
      // Two reconstruction strategies:
      //   incremental (default) — COLMAP's `mapper`, grows one model at a time and
      //     can split the scene into disconnected models when the view graph is weak.
      //   global — `global_mapper` (global SfM: rotation averaging + global
      //     positioning). It solves all cameras jointly, so a connected view graph
      //     yields a single model instead of a split.
      command: (project) => {
        const global = project.mapper === "global";
        return {
          cmd: project.useGpu ? TOOLS.colmapGpu : TOOLS.colmapCpu,
          args: global
            ? [
              "global_mapper",
              "--database_path", resolve(dirs(project).sfm, "database.db"),
              "--image_path", dirs(project).images,
              "--output_path", dirs(project).sparse,
              "--GlobalMapper.num_threads", "12",
              "--log_path", dirs(project).sfm,
              "--log_color", "0",
            ]
            : [
              "mapper",
              "--database_path", resolve(dirs(project).sfm, "database.db"),
              "--image_path", dirs(project).images,
              "--output_path", dirs(project).sparse,
              "--Mapper.num_threads", "12",
              "--log_path", dirs(project).sfm,
              "--log_color", "0",
            ],
        };
      },
      progress: (line) => {
        // global_mapper does not log per-image registration; leave it indeterminate.
        const found = /Registering image #(\d+)/.exec(line);
        return found ? Number(found[1]) : null;
      },
      progressTotal: (project) => manifestSummary(project).retained,
      progressIsCount: true,
      verify: (project) => {
        const models = sparseModels(project);
        return models.length
          ? { ok: true, note: `生成 ${models.length} 个模型：${models.join(", ")}` }
          : { ok: false, message: "稀疏重建未产出任何模型" };
      },
    },
    {
      id: "gate",
      name: "几何门禁",
      command: (project) => ({
        cmd: TOOLS.python,
        args: [
          resolve(PY_DIR, "gate_model.py"),
          "--model-root", dirs(project).sparse,
          "--database", resolve(dirs(project).sfm, "database.db"),
          "--manifest", resolve(dirs(project).root, "manifest.json"),
          "--out", dirs(project).summary,
          "--min-ratio", String(GATE.minRatio),
          "--max-error", String(GATE.maxError),
          "--min-points", String(GATE.minPoints),
          "--fragment-share", String(GATE.fragmentShare),
        ],
      }),
      gate: true,
    },
    {
      id: "undistort",
      name: "去畸变",
      clean: (d) => [d.undistorted],
      ensure: (d) => [d.undistorted],
      command: (project) => ({
        cmd: project.useGpu ? TOOLS.colmapGpu : TOOLS.colmapCpu,
        args: [
          "image_undistorter",
          "--image_path", dirs(project).images,
          "--input_path", resolve(dirs(project).sparse, project.selectedModel ?? "0"),
          "--output_path", dirs(project).undistorted,
          "--output_type", "COLMAP",
          "--max_image_size", "2048",
          "--log_path", dirs(project).sfm,
          "--log_color", "0",
        ],
      }),
      verify: (project) => {
        const folder = resolve(dirs(project).undistorted, "sparse");
        return existsSync(resolve(folder, "images.bin"))
          ? { ok: true }
          : { ok: false, message: "去畸变未产出 COLMAP 数据集" };
      },
    },
    {
      id: "train",
      name: "Brush 训练",
      clean: (d) => [d.train],
      ensure: (d) => [d.train],
      // Brush uses env_logger: without RUST_LOG it prints nothing at all.
      // This filter keeps the iteration/PSNR lines and drops the huge dataset dumps.
      env: { RUST_LOG: "warn,brush_cli=info,brush_process=info" },
      command: (project) => {
        const preset = TRAINING_PRESETS[project.trainingPreset] ?? TRAINING_PRESETS.standard;
        return {
          cmd: TOOLS.brush,
          args: [
            dirs(project).undistorted,
            "--total-steps", String(preset.totalSteps),
            "--max-splats", String(preset.maxSplats),
            "--sh-degree", String(preset.shDegree),
            "--max-resolution", "2048",
            "--export-every", String(preset.exportEvery),
            "--export-path", dirs(project).train,
            "--eval-split-every", "10",
          ],
        };
      },
      progress: (line, project) => {
        // Brush logs "Refine iter 201, 15656 splats." every --refine-every steps
        // and "Eval iter 300: PSNR ..." every --eval-every steps. Both are real
        // signals; the caller only ever increases the recorded value.
        const found = /(?:Refine|Eval) iter\s+(\d+)/.exec(line);
        if (!found) return null;
        const preset = TRAINING_PRESETS[project.trainingPreset] ?? TRAINING_PRESETS.standard;
        return Number(found[1]) / preset.totalSteps;
      },
      // Fallback signal: exported checkpoints on disk, in case stdout format differs.
      progressTotal: (project) => (TRAINING_PRESETS[project.trainingPreset] ?? TRAINING_PRESETS.standard).totalSteps,
      verify: (project) => {
        const step = latestExportStep(project);
        return step
          ? { ok: true, note: `已导出 export_${step}.ply` }
          : { ok: false, message: "训练结束但磁盘上没有 export_*.ply" };
      },
    },
  ];
}

/** Highest export step number present on disk, or null. */
export function latestExportStep(project) {
  const folder = dirs(project).train;
  if (!existsSync(folder)) return null;
  const steps = readdirSync(folder)
    .map((file) => /^export_(\d+)\.ply$/.exec(file))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return steps.length ? Math.max(...steps) : null;
}

/** Global progress across all steps, weighted by STEP_WEIGHTS. */
export function globalProgress(project) {
  let total = 0;
  for (const step of project.steps) {
    const weight = STEP_WEIGHTS[step.id] ?? 0;
    if (step.status === "success") total += weight;
    else if (step.status === "running") total += weight * (step.progress ?? 0);
  }
  return Math.min(total, 1);
}
