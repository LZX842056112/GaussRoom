// Step definitions, command construction, progress parsing and gate thresholds.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
export const FEATURE_PRESETS = ["standard", "enhanced"];

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
    const gate = JSON.parse(readFileSync(resolve(dirs(project).summary, "gate.json"), "utf8"));
    if (gate.geometryValidationVersion !== 1) {
      return { ...gate, previousVerdict: gate.verdict, verdict: "unverified", geometryConnected: false,
        message: "几何连接未验证。请重新运行几何检查，再决定是否训练。" };
    }
    return gate;
  } catch {
    return null;
  }
}

export function matchingDatabase(project) {
  const calibrated = resolve(dirs(project).sfm, "database-global.db");
  return project.mapper === "global" && existsSync(calibrated)
    ? calibrated : resolve(dirs(project).sfm, "database.db");
}

export function geometrySignature(folder) {
  const hash = createHash("sha256");
  for (const name of ["cameras.bin", "images.bin", "points3D.bin"]) {
    if (name === "cameras.bin" && !existsSync(resolve(folder, name))) continue;
    hash.update(readFileSync(resolve(folder, name)));
  }
  return hash.digest("hex");
}

export function requireValidatedModel(project) {
  const gate = readGate(project);
  const model = gate?.models?.find(entry => entry.name === project.selectedModel);
  if (gate?.verdict !== "pass" || !gate.geometryConnected || gate.selectedModel !== project.selectedModel || !model?.geometrySignature
      || model.geometryComponentSizes?.length !== 1
      || geometrySignature(resolve(dirs(project).sparse, model.name)) !== model.geometrySignature) {
    throw Object.assign(new Error("几何连接未通过当前模型的检查。请先运行几何检查，或新建独立区域项目。"), { code: 409 });
  }
}

function datasetSignature(folder) {
  const hash = createHash("sha256");
  for (const name of ["cameras.bin", "images.bin", "points3D.bin"]) hash.update(readFileSync(resolve(folder, name)));
  return hash.digest("hex");
}

function recordDatasetProvenance(project) {
  requireValidatedModel(project);
  const d = dirs(project);
  const origin = { model: project.selectedModel,
    geometrySignature: geometrySignature(resolve(d.sparse, project.selectedModel)),
    datasetSignature: datasetSignature(resolve(d.undistorted, "sparse")) };
  writeFileSync(resolve(d.undistorted, "geometry-source.json"), JSON.stringify(origin));
}

export function requireTrainingDataset(project, { preparingResume = false } = {}) {
  requireValidatedModel(project);
  const d = dirs(project);
  let origin;
  try {
    origin = JSON.parse(readFileSync(resolve(d.undistorted, "geometry-source.json"), "utf8"));
    if (origin.model !== project.selectedModel
        || origin.geometrySignature !== geometrySignature(resolve(d.sparse, project.selectedModel))
        || origin.datasetSignature !== datasetSignature(resolve(d.undistorted, "sparse"))) throw new Error("stale");
  } catch {
    throw Object.assign(new Error("去畸变数据缺失或与当前模型不一致。请从去畸变步骤重跑，已有训练输出已保留。"), { code: 409 });
  }
  const resume = project.trainingResume;
  const initial = resolve(d.undistorted, "init.ply");
  if (resume || existsSync(initial)) {
    const preset = TRAINING_PRESETS[project.trainingPreset];
    if (!resume || !Number.isInteger(resume.step) || resume.step <= 0 || resume.step >= (preset?.totalSteps ?? 0)
        || resume.preset !== project.trainingPreset || resume.geometrySignature !== origin.geometrySignature
        || resume.datasetSignature !== origin.datasetSignature || !existsSync(initial)
        || createHash("sha256").update(readFileSync(initial)).digest("hex") !== resume.sha256) {
      throw Object.assign(new Error("恢复检查点缺失或与当前模型、去畸变数据或训练档位不一致，已有输出已保留。"), { code: 409 });
    }
    const newerEval = existsSync(d.train) && readdirSync(d.train).some(name => {
      const match = /^eval_(\d+)$/.exec(name);
      return match && Number(match[1]) > resume.step;
    });
    if (!preparingResume && ((latestExportStep(project) ?? 0) > resume.step || newerEval)) {
      throw Object.assign(new Error("已有更新的训练结果。请先保存这些结果，并从最新完整检查点准备恢复。"), { code: 409 });
    }
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
          "--SiftExtraction.max_num_features", project.featurePreset === "enhanced" ? "16384" : "8192",
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
          "--FeatureMatching.guided_matching", project.featurePreset === "enhanced" ? "1" : "0",
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
      // Calibration is a substage: both strategies still use the same seven steps.
      command: (project) => {
        if (project.componentSource) return {
          cmd: TOOLS.python,
          args: [resolve(PY_DIR, "extract_component.py"),
            "--colmap", project.useGpu ? TOOLS.colmapGpu : TOOLS.colmapCpu,
            "--source", resolve(dirs(project).sfm, "component-source"),
            "--selection", resolve(dirs(project).sfm, "component-selection.json"),
            "--output", resolve(dirs(project).sparse, "0")],
        };
        return {
          cmd: TOOLS.python,
          args: [resolve(PY_DIR, "sparse_reconstruct.py"),
            "--colmap", project.useGpu ? TOOLS.colmapGpu : TOOLS.colmapCpu,
            "--database", resolve(dirs(project).sfm, "database.db"),
            "--image-path", dirs(project).images,
            "--output-path", dirs(project).sparse,
            "--mapper", project.mapper ?? "incremental"],
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
          "--database", matchingDatabase(project),
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
        if (!["cameras.bin", "images.bin", "points3D.bin"].every(name => existsSync(resolve(folder, name)))) {
          return { ok: false, message: "去畸变未产出完整 COLMAP 数据集" };
        }
        recordDatasetProvenance(project);
        delete project.trainingResume;
        return { ok: true };
      },
    },
    {
      id: "train",
      name: "Brush 训练",
      clean: (d, project) => project?.trainingResume ? [] : [d.train],
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
            "--seed", "42",
            "--eval-save-to-disk",
            ...(project.trainingResume ? ["--start-iter", String(project.trainingResume.step)] : []),
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
        const expected = (TRAINING_PRESETS[project.trainingPreset] ?? TRAINING_PRESETS.standard).totalSteps;
        return step === expected
          ? { ok: true, note: `已导出 export_${step}.ply` }
          : { ok: false, message: `训练结束但没有完成 ${expected} 步导出，最近导出为 ${step ?? 0} 步` };
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
