// Single-job step machine: spawns one child at a time, streams real logs over SSE.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import * as pipeline from "./pipeline.mjs";
import * as projects from "./projects.mjs";

const active = new Map();
const channels = new Map();
const LOG_TAIL_BYTES = 262144;
const HEARTBEAT_MS = 30000;

function channel(projectId) {
  if (!channels.has(projectId)) {
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    channels.set(projectId, bus);
  }
  return channels.get(projectId);
}

/** Human-readable duration: sub-minute timeouts must not read "超过 0 分钟". */
function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
}

/** A failed status write must never take the job (or the process) down. */
function persist(project) {
  try {
    return projects.write(project);
  } catch (error) {
    console.error(`[workbench] 写入项目状态失败（${project.id}）：${error.message}`);
    return project;
  }
}

export function current(projectId) {
  return active.get(projectId) ?? null;
}

export function busyId() {
  return active.size ? [...active.keys()][0] : null;
}

export function anyRunning() {
  return active.size > 0;
}

/**
 * Live in-memory project for an active job. Step progress is only kept in memory
 * (persisting it on every refine iteration would hammer the disk), so readers must
 * overlay this onto the on-disk project.json.
 */
export function liveProject(projectId) {
  return active.get(projectId)?.project ?? null;
}

export function liveProjects() {
  const map = new Map();
  for (const [projectId, job] of active) map.set(projectId, job.project);
  return map;
}

function emitState(projectId, project) {
  channel(projectId).emit("state", projects.summarise(project));
}

function setProgress(job, project, step, value) {
  const record = project.steps.find((entry) => entry.id === step.id);
  if (!record || value <= (record.progress ?? 0)) return;
  record.progress = value;
  channel(job.projectId).emit("progress", {
    step: step.id,
    value,
    global: pipeline.globalProgress(project),
  });
}

function pushLog(job, stepId, text, logPath) {
  try {
    appendFileSync(logPath, text, "utf8");
  } catch {
    // Logging must never take the job down.
  }
  job.logTail.push(text);
  job.logTailSize = (job.logTailSize ?? 0) + Buffer.byteLength(text);
  while (job.logTailSize > LOG_TAIL_BYTES && job.logTail.length > 1) {
    job.logTailSize -= Buffer.byteLength(job.logTail.shift());
  }
  channel(job.projectId).emit("log", { step: stepId, text });
}

function applyProgress(job, step, project, text) {
  if (!step.progress) return;
  for (const line of text.split(/\r?\n/)) {
    const value = step.progress(line, project);
    if (value == null) continue;
    const normalised = step.progressIsCount
      ? Math.min(value / Math.max(step.progressTotal?.(project) ?? 1, 1), 1)
      : Math.min(Math.max(value, 0), 1);
    setProgress(job, project, step, normalised);
  }
}

function spawnStep(job, step, project, cmd, args, logPath) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: pipeline.dirs(project).root,
      windowsHide: true,
      env: { ...process.env, ...(step.env ?? {}) },
      detached: process.platform !== "win32",
    });
    job.child = child;
    // Recorded so a later boot can reap the tree if this process is hard-killed.
    project.childPid = child.pid;
    persist(project);

    const timeoutMs = pipeline.STEP_TIMEOUT_MS[step.id] ?? 60 * 60_000;
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      pushLog(job, step.id,
        `\n[workbench] 该步骤已超过 ${formatDuration(timeoutMs)}，判定为挂起，正在终止进程树。\n`,
        logPath);
      await killTree(child.pid);
    }, timeoutMs);

    const forward = (chunk) => {
      const text = chunk.toString("utf8");
      pushLog(job, step.id, text, logPath);
      applyProgress(job, step, project, text);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => {
      clearTimeout(timer);
      pushLog(job, step.id, `\n[workbench] 无法启动进程：${error.message}\n`, logPath);
      job.child = null;
      delete project.childPid;
      persist(project);
      done({ code: -1, signal: null, timedOut: false, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      job.child = null;
      delete project.childPid;
      persist(project);
      done({ code, signal, timedOut });
    });
  });
}

/** PIDs of every live step child, so a shutdown can take the whole tree with it. */
export function activeChildPids() {
  const pids = [];
  for (const job of active.values()) {
    if (job.child?.pid) pids.push(job.child.pid);
  }
  return pids;
}

export async function killAll() {
  await Promise.all(activeChildPids().map((pid) => killTree(pid)));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function imageName(pid) {
  return new Promise((done) => {
    const child = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => done(""));
    child.on("close", () => done((/^"([^"]+)"/.exec(out.trim())?.[1] ?? "").toLowerCase()));
  });
}

const OUR_TOOLS = new Set(["colmap.exe", "brush_app.exe"]);

/**
 * A hard kill (task manager, process tree teardown) skips the signal handler and
 * leaves COLMAP/Brush running. On boot, kill any child we recorded but no longer
 * own — guarded by the image name so a recycled PID can never hit an unrelated
 * process.
 */
export async function cleanupOrphans() {
  const cleaned = [];
  for (const item of projects.list()) {
    let project;
    try {
      project = projects.read(item.id);
    } catch {
      continue;
    }
    const pid = project.childPid;
    if (!pid) continue;
    if (isAlive(pid) && OUR_TOOLS.has(await imageName(pid))) {
      await killTree(pid);
      cleaned.push({ id: project.id, pid });
    }
    delete project.childPid;
    persist(project);
  }
  return cleaned;
}

export function killTree(pid) {
  return new Promise((done) => {
    if (!pid) return done();
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      killer.on("close", () => done());
      killer.on("error", () => done());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    done();
  });
}

function markDownstream(project, index, status) {
  for (let i = index + 1; i < project.steps.length; i += 1) {
    if (project.steps[i].status === "pending") project.steps[i].status = status;
  }
}

function halt(job, project, index, message) {
  const record = project.steps[index];
  record.status = "failed";
  record.endedAt = new Date().toISOString();
  record.error = message;
  markDownstream(project, index, "blocked");
  project.state = "failed";
  project.lastError = message;
  project.currentStep = null;
  persist(project);
  emitState(job.projectId, project);
}

function settle(job, project) {
  const allDone = project.steps.every((step) => step.status === "success");
  const scene = projects.latestExport(project);
  if (allDone && scene) {
    project.state = "done";
    project.lastError = null;
  } else if (allDone) {
    project.state = "failed";
    project.lastError = "全部步骤已完成，但磁盘上找不到 export_*.ply";
  } else {
    project.state = "partial";
  }
  project.currentStep = null;
  persist(project);
  emitState(job.projectId, project);
}

async function run(job, project, options) {
  const steps = pipeline.buildSteps();
  const d = pipeline.dirs(project);
  mkdirSync(d.logs, { recursive: true });

  let startIndex;
  if (options.fromStep) {
    startIndex = steps.findIndex((step) => step.id === options.fromStep);
    if (startIndex < 0) throw Object.assign(new Error(`未知步骤：${options.fromStep}`), { code: 400 });
  } else {
    startIndex = project.steps.findIndex((step) => step.status !== "success");
  }
  if (startIndex < 0) {
    settle(job, project);
    return;
  }

  for (let i = startIndex; i < project.steps.length; i += 1) {
    Object.assign(project.steps[i], { status: "pending", progress: 0, error: null });
    delete project.steps[i].endedAt;
  }
  project.state = "running";
  project.lastError = null;
  project.currentStep = null;
  persist(project);
  emitState(job.projectId, project);

  const poller = setInterval(() => {
    const index = project.steps.findIndex((step) => step.status === "running");
    if (index < 0) return;
    const step = steps[index];
    if (step.id !== "train") return;
    const latest = pipeline.latestExportStep(project);
    if (!latest) return;
    const preset = pipeline.TRAINING_PRESETS[project.trainingPreset] ?? pipeline.TRAINING_PRESETS.standard;
    setProgress(job, project, step, Math.min(latest / preset.totalSteps, 1));
  }, 10000);

  // A real, workbench-authored heartbeat. It is explicitly prefixed so it can
  // never be mistaken for output from the child process.
  const heartbeat = setInterval(() => {
    const index = project.steps.findIndex((step) => step.status === "running");
    if (index < 0) return;
    const step = steps[index];
    const record = project.steps[index];
    const started = record.startedAt ? new Date(record.startedAt).getTime() : Date.now();
    const elapsed = formatDuration(Math.max(1000, Date.now() - started));
    const scene = projects.latestExport(project);
    const detail = step.id === "train" && scene
      ? `；最近导出 ${scene.name}（${(scene.size / 1024 / 1024).toFixed(1)} MB）`
      : "";
    pushLog(job, step.id,
      `[workbench] 「${step.name}」已运行约 ${elapsed}${detail}\n`,
      resolve(d.logs, `${step.id}.log`));
  }, HEARTBEAT_MS);

  try {
    for (let i = startIndex; i < project.steps.length; i += 1) {
      if (job.aborted) break;
      const step = steps[i];
      const record = project.steps[i];

      if (step.clean) {
        for (const target of step.clean(d)) {
          try {
            rmSync(target, { recursive: true, force: true });
          } catch (error) {
            halt(job, project, i, `清理「${step.name}」的旧产物失败：${target}（${error.message}）`);
            return;
          }
        }
      }
      // COLMAP refuses to write into a missing output directory, so recreate it here.
      if (step.ensure) {
        for (const target of step.ensure(d)) {
          try {
            mkdirSync(target, { recursive: true });
          } catch (error) {
            halt(job, project, i, `无法创建输出目录：${target}（${error.message}）`);
            return;
          }
        }
      }

      Object.assign(record, { status: "running", progress: 0, startedAt: new Date().toISOString() });
      delete record.endedAt;
      project.currentStep = step.id;
      persist(project);
      emitState(job.projectId, project);

      const logPath = resolve(d.logs, `${step.id}.log`);
      writeFileSync(logPath, "", "utf8");
      job.logTail = [];
      job.logTailSize = 0;

      const { cmd, args } = step.command(project);
      pushLog(job, step.id, `$ ${cmd} ${args.join(" ")}\n`, logPath);

      const result = await spawnStep(job, step, project, cmd, args, logPath);

      if (job.aborted) {
        record.status = "aborted";
        record.endedAt = new Date().toISOString();
        markDownstream(project, i, "blocked");
        project.state = "aborted";
        project.currentStep = null;
        project.lastError = `已在「${step.name}」中止；该步骤及其下游需要重新运行`;
        persist(project);
        emitState(job.projectId, project);
        return;
      }

      if (result.timedOut) {
        halt(job, project, i,
          `「${step.name}」超过 ${formatDuration(pipeline.STEP_TIMEOUT_MS[step.id] ?? 0)}未结束，已判定为挂起并终止。`);
        return;
      }

      if (result.spawnError) {
        halt(job, project, i, `「${step.name}」无法启动进程：${result.spawnError}（请检查工具路径是否存在）`);
        return;
      }

      if (result.code !== 0) {
        halt(job, project, i, `「${step.name}」退出码 ${result.code}${result.signal ? `（信号 ${result.signal}）` : ""}`);
        return;
      }

      if (step.gate) {
        const gate = pipeline.readGate(project);
        if (!gate) {
          halt(job, project, i, "几何门禁未产出 gate.json");
          return;
        }
        project.selectedModel = gate.selectedModel ?? null;
        persist(project);
        if (gate.verdict !== "pass") {
          halt(job, project, i, gate.message ?? `几何门禁未通过（${gate.verdict}）`);
          return;
        }
      }

      if (step.verify) {
        const check = step.verify(project);
        if (!check.ok) {
          halt(job, project, i, `「${step.name}」校验失败：${check.message}`);
          return;
        }
        if (check.note) record.note = check.note;
      }

      Object.assign(record, { status: "success", progress: 1, exitCode: 0, endedAt: new Date().toISOString() });
      persist(project);
      emitState(job.projectId, project);
    }
    settle(job, project);
  } finally {
    clearInterval(poller);
    clearInterval(heartbeat);
  }
}

export function start(projectId, options = {}) {
  if (active.size) {
    throw Object.assign(new Error("已有作业在运行，请先等待完成或中止"), { code: 409 });
  }
  const project = projects.read(projectId);
  if (options.trainingPreset && pipeline.TRAINING_PRESETS[options.trainingPreset]) {
    project.trainingPreset = options.trainingPreset;
    persist(project);
  }
  const job = {
    id: `${projectId}-${Date.now()}`,
    projectId,
    project,
    child: null,
    aborted: false,
    logTail: [],
    logTailSize: 0,
  };
  active.set(projectId, job);
  run(job, project, options)
    .catch((error) => {
      // This handler must never throw: a secondary failure here would surface as
      // an unhandled rejection and take the whole server down.
      try {
        const latest = projects.read(projectId);
        latest.state = "failed";
        latest.lastError = error.message;
        latest.currentStep = null;
        persist(latest);
        emitState(projectId, latest);
      } catch (secondary) {
        console.error(`[workbench] 标记作业失败时出错（${projectId}）：${secondary.message}`);
      }
    })
    .finally(() => active.delete(projectId));
  return job;
}

/**
 * Rerunning the train step wipes its directory first, which used to silently
 * delete an already exported scene. Callers must pass allowTrainClean to proceed.
 *
 * Two ways to reach train: resuming a run whose next step is train, or an explicit
 * `fromStep` at or before train (the "retry this step" button).
 */
export function trainCleanWarning(project, options = {}) {
  const order = pipeline.buildSteps().map((step) => step.id);
  const trainIndex = order.indexOf("train");
  let startIndex;
  if (options.fromStep) {
    startIndex = order.indexOf(options.fromStep);
    if (startIndex < 0) return null;
  } else {
    startIndex = project.steps.findIndex((step) => step.status !== "success");
    if (startIndex < 0) return null;
  }
  if (startIndex > trainIndex) return null;

  const exports = projects.trainExports(project);
  if (!exports.length) return null;
  return {
    code: "train_clean_confirmation_required",
    message: `重新训练会先清空项目的 train/ 目录，删除以下 ${exports.length} 个已导出的场景文件。`,
    files: exports.map((item) => ({ name: item.name, step: item.step, size: item.size })),
  };
}

export async function abort(projectId) {
  const job = active.get(projectId);
  if (!job) throw Object.assign(new Error("该项目没有正在运行的作业"), { code: 409 });
  job.aborted = true;
  const project = projects.read(projectId);
  project.state = "aborting";
  projects.write(project);
  emitState(projectId, project);

  const pid = job.child?.pid;
  await killTree(pid);
  // Safety net: COLMAP/Brush can take a moment to release the tree.
  setTimeout(() => {
    if (job.child?.pid) killTree(job.child.pid);
  }, 5000);
}

const RAN_STATUSES = new Set(["success", "failed", "aborted", "running"]);

/** Last step that actually executed — `blocked` steps have no log file. */
function lastActiveStepId(project) {
  const touched = [...project.steps].reverse().find((step) => RAN_STATUSES.has(step.status));
  return touched?.id ?? project.steps[0].id;
}

function readTail(path, maxBytes = LOG_TAIL_BYTES) {
  // Read only the tail: a long training log can reach hundreds of megabytes and
  // must never be loaded whole into memory.
  let handle;
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const length = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    handle = openSync(path, "r");
    readSync(handle, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle); } catch { /* already closed */ }
    }
  }
}

export function readStepLog(projectId, stepId, tailBytes = 65536) {
  const project = projects.read(projectId);
  const id = stepId ?? lastActiveStepId(project);
  const path = resolve(pipeline.dirs(project).logs, `${id}.log`);
  if (!existsSync(path)) throw Object.assign(new Error("该步骤还没有日志"), { code: 404 });
  return { step: id, text: readTail(path, tailBytes) };
}

export function attachEvents(projectId, request, response) {
  let project;
  try {
    project = liveProject(projectId) ?? projects.read(projectId);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("项目不存在");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Snapshot first so a reconnect never lands on an empty state.
  send("state", projects.summarise(project));
  const job = active.get(projectId);
  const replayStep = job?.currentStep ?? lastActiveStepId(project);
  const replay = job ? job.logTail.join("") : readTail(resolve(pipeline.dirs(project).logs, `${replayStep}.log`));
  if (replay) send("log", { step: replayStep, text: replay, replay: true });

  const bus = channel(projectId);
  const onState = (payload) => send("state", payload);
  const onLog = (payload) => send("log", payload);
  const onProgress = (payload) => send("progress", payload);
  bus.on("state", onState);
  bus.on("log", onLog);
  bus.on("progress", onProgress);

  const heartbeat = setInterval(() => response.write(": ping\n\n"), 15000);
  request.on("close", () => {
    clearInterval(heartbeat);
    bus.off("state", onState);
    bus.off("log", onLog);
    bus.off("progress", onProgress);
  });
}
