// Project store: one directory per project under <repo>/projects.
import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PROJECTS_DIR, WORKBENCH } from "./paths.mjs";
import {
  CAMERA_MODELS, STEP_ORDER, TRAINING_PRESETS, dirs, globalProgress, readGate, sparseModels,
} from "./pipeline.mjs";
import { scenePose } from "./pose.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"]);

export function ensureStore() {
  mkdirSync(PROJECTS_DIR, { recursive: true });
}

export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function slugify(name) {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "proj";
}

export function projectPath(id) {
  if (!isValidId(id)) throw Object.assign(new Error("项目 id 非法"), { code: 400 });
  return resolve(PROJECTS_DIR, id, "project.json");
}

export function read(id) {
  const path = projectPath(id);
  if (!existsSync(path)) throw Object.assign(new Error("项目不存在"), { code: 404 });
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Object.assign(new Error(`项目文件损坏，无法解析：${path}`), { code: 500 });
  }
}

/** Atomic write: a crash mid-write must never leave a half-written project.json. */
export function write(project) {
  project.updatedAt = new Date().toISOString();
  const folder = resolve(PROJECTS_DIR, project.id);
  mkdirSync(folder, { recursive: true });
  const target = projectPath(project.id);
  const temporary = `${target}.tmp`;
  const payload = JSON.stringify(project, null, 2);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(temporary, payload, "utf8");
      renameSync(temporary, target);
      return project;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * A server restart leaves projects stuck in `running` with no live job, which
 * used to lock the UI (continue disabled, abort returning 409). Reconcile them
 * on boot so the user can resume.
 */
export function reconcile() {
  ensureStore();
  const reconciled = [];
  for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    let project;
    try {
      project = read(entry.name);
    } catch {
      continue;
    }
    const stuckSteps = (project.steps ?? []).filter((step) => step.status === "running");
    const stuck = ["running", "aborting"].includes(project.state) || stuckSteps.length > 0;
    if (!stuck) continue;
    for (const step of stuckSteps) {
      step.status = "aborted";
      step.endedAt = step.endedAt ?? new Date().toISOString();
    }
    project.state = "aborted";
    project.currentStep = null;
    project.lastError = "工作台服务曾中断，该作业已停止；可点「继续重建」从中断处恢复。";
    try {
      write(project);
      reconciled.push(project.id);
    } catch {
      // A project we cannot rewrite must not stop the boot sequence.
    }
  }
  return reconciled;
}

function markPendingFrom(project, stepId) {
  const from = STEP_ORDER.findIndex((step) => step.id === stepId);
  if (from < 0) return;
  for (let i = from; i < project.steps.length; i += 1) {
    const step = project.steps[i];
    if (step.status === "success") step.status = "pending";
    step.progress = 0;
    step.error = null;
    delete step.endedAt;
    delete step.startedAt;
    delete step.note;
  }
}

const PATCHABLE = ["useGpu", "cameraModel", "trainingPreset", "selectedModel", "mapper"];

export function update(id, patch) {
  const project = read(id);
  const running = ["running", "aborting"].includes(project.state);
  const applied = [];
  const blocked = [];

  if (typeof patch.name === "string") {
    const label = patch.name.trim();
    if (!label) throw Object.assign(new Error("项目名称不能为空"), { code: 400 });
    project.name = label;
    applied.push("name");
  }

  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    if (running) {
      blocked.push(key);
      continue;
    }
    if (key === "trainingPreset") {
      if (!TRAINING_PRESETS[patch.trainingPreset]) {
        throw Object.assign(new Error(`未知训练档位：${patch.trainingPreset}`), { code: 400 });
      }
      project.trainingPreset = patch.trainingPreset;
    } else if (key === "useGpu") {
      project.useGpu = Boolean(patch.useGpu);
    } else if (key === "cameraModel") {
      if (!CAMERA_MODELS.includes(patch.cameraModel)) {
        throw Object.assign(new Error(`未知相机模型：${patch.cameraModel}`), { code: 400 });
      }
      if (patch.cameraModel !== project.cameraModel) {
        project.cameraModel = patch.cameraModel;
        // Intrinsics changed: every step that consumed them must run again.
        markPendingFrom(project, "features");
      }
    } else if (key === "selectedModel") {
      // Lets the user pick which sparse model to undistort and train when the
      // reconstruction split (see the gate's "split" verdict).
      const available = sparseModels(project);
      if (!available.includes(patch.selectedModel)) {
        throw Object.assign(
          new Error(`找不到稀疏模型：${patch.selectedModel}（现有：${available.join("、") || "无"}）`),
          { code: 400 },
        );
      }
      project.selectedModel = patch.selectedModel;
    } else if (key === "mapper") {
      if (!["incremental", "global"].includes(patch.mapper)) {
        throw Object.assign(new Error(`未知重建方式：${patch.mapper}`), { code: 400 });
      }
      if (patch.mapper !== project.mapper) {
        project.mapper = patch.mapper;
        // The sparse model is rebuilt, so everything downstream is stale.
        markPendingFrom(project, "sparse");
        project.selectedModel = null;
      }
    }
    applied.push(key);
  }

  if (blocked.length) {
    throw Object.assign(
      new Error(`作业运行中，暂不能修改：${blocked.join("、")}。请先中止或等待完成。`),
      { code: 409 },
    );
  }
  return write(project);
}

export function list() {
  ensureStore();
  const projects = [];
  for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    try {
      projects.push(summarise(read(entry.name)));
    } catch {
      // A half-written project should not break the listing.
    }
  }
  // Tolerate a missing createdAt so one odd project cannot break the whole list.
  return projects.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export function summarise(project) {
  return {
    id: project.id,
    name: project.name,
    state: project.state,
    sourceDir: project.sourceDir,
    sourceImageCount: project.sourceImageCount,
    trainingPreset: project.trainingPreset,
    useGpu: project.useGpu,
    cameraModel: project.cameraModel,
    selectedModel: project.selectedModel ?? null,
    mapper: project.mapper ?? "incremental",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentStep: project.currentStep ?? null,
    progress: globalProgress(project),
    steps: project.steps.map(({ id, name, status, progress: value, error, note }) => ({
      id, name, status, progress: value ?? 0, error: error ?? null, note: note ?? null,
    })),
    gate: readGate(project),
    lastError: project.lastError ?? null,
    scene: withHome(project),
  };
}

/** Attach the reconstruction-derived default viewer pose to the exported scene. */
function withHome(project) {
  const scene = latestExport(project);
  if (!scene) return null;
  try {
    return { ...scene, home: scenePose(project) };
  } catch {
    return { ...scene, home: null };
  }
}

export function countImages(folder) {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && IMAGE_SUFFIXES.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()))
      .length;
  } catch {
    return 0;
  }
}

export function create({ name, sourceDir, trainingPreset, useGpu = true, cameraModel = "SIMPLE_RADIAL" }) {
  ensureStore();
  const label = String(name ?? "").trim();
  if (!label) throw Object.assign(new Error("请填写项目名称"), { code: 400 });
  const source = String(sourceDir ?? "").trim();
  if (!source) throw Object.assign(new Error("请选择或填写图片文件夹路径"), { code: 400 });
  const resolved = resolve(source);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw Object.assign(new Error(`图片文件夹不存在：${resolved}`), { code: 400 });
  }
  const found = countImages(resolved);
  if (found < 2) {
    throw Object.assign(new Error(`该文件夹内只有 ${found} 张可用图片，至少需要 2 张`), { code: 400 });
  }
  if (!TRAINING_PRESETS[trainingPreset]) {
    throw Object.assign(new Error("请选择训练档位"), { code: 400 });
  }

  const id = `${slugify(label)}-${randomBytes(3).toString("hex")}`;
  const now = new Date().toISOString();
  const project = {
    id,
    name: label,
    sourceDir: resolved,
    sourceImageCount: found,
    createdAt: now,
    updatedAt: now,
    state: "idle",
    trainingPreset,
    useGpu: Boolean(useGpu),
    cameraModel,
    selectedModel: null,
    mapper: "incremental",
    forcePrepare: false,
    steps: STEP_ORDER.map(({ id: stepId, name: stepName }) => ({ id: stepId, name: stepName, status: "pending", progress: 0 })),
    lastError: null,
  };
  mkdirSync(resolve(PROJECTS_DIR, id), { recursive: true });
  return write(project);
}

export function remove(id) {
  const project = read(id);
  const folder = resolve(PROJECTS_DIR, project.id);
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    // e.g. a file is still open, or a permissions problem.
    throw Object.assign(
      new Error(`删除项目目录失败：${folder}\n${error.message}`),
      { code: 500 },
    );
  }
}

/** Every exported checkpoint on disk, newest first. */
export function trainExports(project) {
  const folder = dirs(project).train;
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .map((file) => /^export_(\d+)\.ply$/.exec(file))
    .filter(Boolean)
    .map((match) => {
      const path = resolve(folder, match[0]);
      return { step: Number(match[1]), name: match[0], path, size: statSync(path).size };
    })
    .sort((a, b) => b.step - a.step);
}

export function latestExport(project) {
  return trainExports(project)[0] ?? null;
}

export function pickFolder(title = "选择图片文件夹") {
  return new Promise((done, fail) => {
    const script = resolve(WORKBENCH, "scripts", "folder-dialog.ps1");
    const child = spawn("powershell", [
      "-Sta", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Title", title,
    ], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", fail);
    child.on("close", (code) => {
      const chosen = out.trim();
      if (chosen) return done(chosen);
      if (code === 0) return done(null);          // user cancelled
      fail(new Error(err.trim() || `文件夹对话框退出码 ${code}`));
    });
  });
}
