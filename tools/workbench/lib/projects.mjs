// Project store: one directory per project under <repo>/projects.
import { spawn } from "node:child_process";
import {
  cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,realpathSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve,sep } from "node:path";
import { PROJECTS_DIR, WORKBENCH } from "./paths.mjs";
import {
  CAMERA_MODELS, FEATURE_PRESETS, STEP_ORDER, TRAINING_PRESETS, dirs, geometrySignature, globalProgress, readGate, sparseModels,
} from "./pipeline.mjs";
import { scenePose } from "./pose.mjs";
import { readAssistance, updateAssistance } from './assistance.mjs';
import {qualityFor} from './quality.mjs';
import { endStepTiming, preserveStepTiming, projectTiming, stepTiming } from './timing.mjs';

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
    if(reconcileProject(entry.name))reconciled.push(entry.name);
  }
  return reconciled;
}
export function reconcileProject(id){
  let project;try{project=read(id);}catch{return false;}
  const stuckSteps=(project.steps??[]).filter(step=>step.status==='running');
  if(!['running','aborting'].includes(project.state)&&!stuckSteps.length)return false;
  for(const step of stuckSteps){
    const start=Date.parse(step.timing?.runningSince??step.startedAt),saved=Date.parse(project.updatedAt);
    const cutoff=Math.min(Date.now(),Math.max(Number.isFinite(start)?start:0,Number.isFinite(saved)?saved:Number.isFinite(start)?start:Date.now()));
    endStepTiming(step,cutoff);
    step.timing.complete=false; // The last unsaved interval cannot be recovered.
    step.status='aborted';
  }
  project.state='aborted';project.currentStep=null;
  project.lastError='工作台服务曾中断，该作业已停止；可点「继续重建」从中断处恢复。';
  try{
    write(project);
    if(readAssistance(project)?.state==='solving')updateAssistance(project,current=>({...current,state:'ready',recoveryNote:'服务曾中断。回答已保存；继续前将重新检查输入。'}));
    return true;
  }catch{return false;}
}

function markPendingFrom(project, stepId) {
  const from = STEP_ORDER.findIndex((step) => step.id === stepId);
  if (from < 0) return;
  for (let i = from; i < project.steps.length; i += 1) {
    const step = project.steps[i];
    preserveStepTiming(step);
    if (step.status === "success") step.status = "pending";
    step.progress = 0;
    step.error = null;
    delete step.endedAt;
    delete step.startedAt;
    delete step.note;
  }
}

const PATCHABLE = ["useGpu", "cameraModel", "featurePreset", "trainingPreset", "selectedModel", "mapper"];

export function update(id, patch) {
  const project = read(id);
  const geometrySettings=JSON.stringify([project.cameraModel,project.featurePreset??'standard',project.mapper??'incremental',project.selectedModel??null]);
  const running = ["running", "aborting"].includes(project.state);
  const applied = [];
  const blocked = [];
  if (project.componentSource && ["cameraModel", "featurePreset", "mapper"].some(key => key in patch)) {
    throw Object.assign(new Error("独立区域项目使用已验证的相机和几何参数，不能修改重建参数。"), { code: 409 });
  }
  if ("cameraModel" in patch && !CAMERA_MODELS.includes(patch.cameraModel)) {
    throw Object.assign(new Error("未知相机模型"), { code: 400 });
  }

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
    } else if (key === "featurePreset") {
      if (!FEATURE_PRESETS.includes(patch.featurePreset)) throw Object.assign(new Error("未知特征档位"), { code: 400 });
      if (patch.featurePreset !== (project.featurePreset ?? "standard")) {
        project.featurePreset = patch.featurePreset;
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
  const saved=write(project);
  if(geometrySettings!==JSON.stringify([project.cameraModel,project.featurePreset??'standard',project.mapper??'incremental',project.selectedModel??null])&&readAssistance(project)){
    updateAssistance(project,current=>({...current,state:'stale',verifiedAgainst:null,
      missing:[{code:'reconstruction_settings_changed',message:'重建设置已改变。请先重跑相应前置步骤，再复查已保存的回答和标记。'}]}));
  }
  return saved;
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

export function summarise(project, now = Date.now()) {
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
    activeAttemptId:project.activeAttemptId??null,pendingAttemptId:project.pendingAttemptId??null,
    quality:qualityFor(project),
    mapper: project.mapper ?? "incremental",
    featurePreset: project.featurePreset ?? "standard",
    componentSource: project.componentSource ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentStep: project.currentStep ?? null,
    progress: globalProgress(project),
    timing: projectTiming(project, now),
    steps: project.steps.map((step) => ({
      id:step.id, name:step.name, status:step.status, progress:step.progress ?? 0,
      error:step.error ?? null, note:step.note ?? null,
      startedAt:step.startedAt ?? null, endedAt:step.endedAt ?? null, timing:stepTiming(step, now),
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

export function create({ name, sourceDir, trainingPreset, useGpu = true, cameraModel = "SIMPLE_RADIAL", mapper = "incremental", featurePreset = "standard" }) {
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
  if (!["incremental", "global"].includes(mapper)) {
    throw Object.assign(new Error(`未知重建方式：${mapper}`), { code: 400 });
  }
  if (!CAMERA_MODELS.includes(cameraModel)) throw Object.assign(new Error("未知相机模型"), { code: 400 });
  if (!FEATURE_PRESETS.includes(featurePreset)) throw Object.assign(new Error("未知特征档位"), { code: 400 });

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
    mapper,
    featurePreset,
    forcePrepare: false,
    steps: STEP_ORDER.map(({ id: stepId, name: stepName }) => ({ id: stepId, name: stepName, status: "pending", progress: 0 })),
    lastError: null,
  };
  mkdirSync(resolve(PROJECTS_DIR, id), { recursive: true });
  return write(project);
}

/** Snapshot an inspected component into a new project; the source stays intact. */
export function createComponent(id, { model: modelName, component: componentIndex }) {
  const stored=read(id);
  const source={...stored,activeAttemptId:stored.pendingAttemptId??stored.activeAttemptId??null};
  if (["running", "aborting"].includes(source.state)) throw Object.assign(new Error("源项目正在运行"), { code: 409 });
  const gate = readGate(source);
  if (gate?.geometryValidationVersion !== 1 || gate.verdict === "unverified") {
    throw Object.assign(new Error("几何连接未验证，请先运行几何检查"), { code: 409 });
  }
  if (!sparseModels(source).includes(modelName) || !Number.isInteger(componentIndex)) {
    throw Object.assign(new Error("独立区域选择无效"), { code: 400 });
  }
  const model = gate.models.find(entry => entry.name === modelName);
  const component = model?.geometryComponents?.find(entry => entry.index === componentIndex);
  if (!component || component.registered < 3) throw Object.assign(new Error("该区域至少需要三张已定位照片"), { code: 400 });
  const input = resolve(dirs(source).sparse, modelName);
  if (geometrySignature(input) !== model.geometrySignature) {
    throw Object.assign(new Error("几何报告已过期，请重新运行几何检查"), { code: 409 });
  }
  const manifest = JSON.parse(readFileSync(dirs(source).manifest, "utf8"));
  const names = new Set(component.images);
  const workName=name=>name?.replace(/^(?:inputs\/)?images\//,'');
  const records = manifest.records.filter(record => !record.excluded && names.has(workName(record.work_image)))
    .map(record=>({...record,work_image:`images/${workName(record.work_image)}`}));
  if (records.length !== names.size) throw Object.assign(new Error("照片清单与几何分量不一致"), { code: 409 });
  const newId = `${slugify(source.name).slice(0, 25)}-region-${componentIndex + 1}-${randomBytes(3).toString("hex")}`;
  const project = structuredClone(source);
  project.id = newId;
  project.name = `${source.name} · 模型 ${modelName} · 区域 ${componentIndex + 1}`;
  project.createdAt = new Date().toISOString();
  project.state = "partial";
  project.currentStep = null;
  project.lastError = null;
  project.selectedModel = null;
  project.sourceImageCount = records.length;
  project.componentSource = { projectId: id, model: modelName, index: componentIndex, images: component.images,
    layoutVerified: false };
  delete project.activeAttemptId;
  delete project.pendingAttemptId;
  delete project.trainingResume;
  delete project.root;
  delete project.childPid;
  const d = dirs(project);
  mkdirSync(d.root);
  try {
    mkdirSync(d.sfm, { recursive: true });
    cpSync(input, resolve(d.sfm, "component-source"), { recursive: true });
    writeFileSync(resolve(d.sfm, "component-selection.json"), JSON.stringify(component));
    for (const record of records) {
      const name = record.work_image.replace(/^images\//, "");
      // Names come from COLMAP, but must still stay inside both image directories.
      if (name.includes("\\") || name.split("/").some(part => part === ".." || part === "" || part.includes(":"))) {
        throw Object.assign(new Error("照片路径无效"), { code: 400 });
      }
      const target = resolve(d.images, name);
      mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(resolve(dirs(source).images, name), target);
    }
    const groups = {};
    for (const record of records) groups[record.camera_group] = (groups[record.camera_group] ?? 0) + 1;
    writeFileSync(resolve(d.root, "manifest.json"), JSON.stringify({ ...manifest, source_count: records.length,
      retained_count: records.length, excluded: [], camera_groups: groups, records }, null, 2));
    project.steps = STEP_ORDER.map((step, index) => ({ ...step, status: index < 3 ? "success" : "pending",
      progress: index < 3 ? 1 : 0, error: null, ...(index < 3 ? { note: "复用已定位的独立区域数据" } : {}) }));
    return write(project);
  } catch (error) {
    rmSync(d.root, { recursive: true, force: true });
    throw error;
  }
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
  const d=dirs(project),folder = d.train;
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .map((file) => /^export_(\d+)\.ply$/.exec(file))
    .filter(Boolean)
    .map((match) => {
      const path = resolve(folder, match[0]);
      if(!realpathSync(path).startsWith(realpathSync(d.workspace)+sep))throw Object.assign(new Error('场景文件路径越界'),{code:400});
      return { step: Number(match[1]), name: match[0], path, size: statSync(path).size,
        attemptId: project.activeAttemptId??null };
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
