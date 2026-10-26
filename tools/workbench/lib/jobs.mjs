// Single-job step machine: spawns one child at a time, streams real logs over SSE.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { PY_DIR, TOOLS } from "./paths.mjs";
import * as pipeline from "./pipeline.mjs";
import * as projects from "./projects.mjs";
import { atomicJson, newRecord, readAssistance, updateAssistance, inputError, preserveQuestions, rebaseRecordGeometry } from './assistance.mjs';
import { diagnoseAssistance } from './assistance-diagnosis.mjs';
import { readAttempt, writeAttempt, adoptAttempt, sameInputs } from './attempts.mjs';
import { getContext, prepareAutomaticAttempt, prepareAssistedAttempt, assistanceSource } from './assistance-service.mjs';
import {qualityFor,deriveQuality} from './quality.mjs';

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
    const value = step.progress(line, job.scopeProject??project);
    if (value == null) continue;
    const normalised = step.progressIsCount
      ? Math.min(value / Math.max(step.progressTotal?.(job.scopeProject??project) ?? 1, 1), 1)
      : Math.min(Math.max(value, 0), 1);
    setProgress(job, project, step, normalised);
  }
}

function spawnStep(job, step, project, cmd, args, logPath) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: pipeline.dirs(project).root,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(step.env ?? {}) },
      detached: process.platform !== "win32",
    });
    job.child = child;
    // Recorded so a later boot can reap the tree if this process is hard-killed.
    project.childPid = child.pid;
    if (cmd === TOOLS.python) project.childScript = args[0];
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
      delete project.childScript;
      persist(project);
      done({ code: -1, signal: null, timedOut: false, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      job.child = null;
      delete project.childPid;
      delete project.childScript;
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

function processInfo(pid) {
  return new Promise((done) => {
    if (!Number.isInteger(pid) || pid <= 0) return done(null);
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress`], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => done(null));
    child.on("close", () => {
      try {
        const info = JSON.parse(out.trim());
        done({ name: info.Name?.toLowerCase(), commandLine: info.CommandLine ?? "" });
      } catch { done(null); }
    });
  });
}

const OUR_TOOLS = new Set(["colmap.exe", "brush_app.exe"]);
const OWNED_SCRIPTS = new Set(["sparse_reconstruct.py", "extract_component.py", "prepare_project.py", "gate_model.py", "assistance_inputs.py", "assisted_reconstruct.py"]
  .map(name => resolve(PY_DIR, name).toLowerCase()));

export function isOwnedProcess(project, info) {
  if (!info) return false;
  if (OUR_TOOLS.has(info.name)) return true;
  const expected = project.childScript?.replaceAll("/", "\\").toLowerCase();
  if (!/^python(?:\d+(?:\.\d+)?)?\.exe$/.test(info.name ?? "") || !OWNED_SCRIPTS.has(expected)) return false;
  const tokens = info.commandLine.match(/"[^"]*"|\S+/g) ?? [];
  return tokens[1]?.replace(/^"|"$/g, "").replaceAll("/", "\\").toLowerCase() === expected;
}

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
    if (isAlive(pid) && isOwnedProcess(project, await processInfo(pid))) {
      await killTree(pid);
      cleaned.push({ id: project.id, pid });
    }
    delete project.childPid;
    delete project.childScript;
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
  if(job.attemptId){
    const attempt=readAttempt(project,job.attemptId);attempt.status='failed';attempt.failure={message};writeAttempt(project,attempt);
  }
  if(job.assistanceRecord)updateAssistance(project,current=>({...current,state:current.revision===job.assistanceRecord.revision?'failed':current.state}));
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

function pauseForInput(job,project,index,missing) {
  const record=project.steps[index];record.status='needs_input';record.endedAt=new Date().toISOString();record.error=null;
  record.note=missing.map(m=>m.message).filter(Boolean).join(' ');
  for(let i=index+1;i<project.steps.length;i++)project.steps[i].status='blocked';
  project.state='needs_input';project.currentStep=record.id;project.lastError=null;
  persist(project);emitState(project.id,project);
}
async function checkAssistance(job,project,index,gate,execute) {
  const context=await (job.runtime.getContext??getContext)(job.scopeProject,{fresh:true,execute});
  const previous=readAssistance(project);
  const diagnosis=diagnoseAssistance({gate,catalog:context.catalog,record:previous,
    manualRequest:previous?.state!=='verified'&&previous?.reasons?.some(r=>r.code==='position_review')});
  if(!diagnosis.required)return {context,diagnosis};
  const photos=context.catalog.map(p=>({...p,unregistered:diagnosis.unregistered.includes(p.photoId),regionIds:diagnosis.regions.filter(r=>r.photoIds.includes(p.photoId)).map(r=>r.id)}));
  updateAssistance(project,current=>({...current??newRecord({catalog:photos,inputs:context.inputs}),state:'needs_input',
    inputs:context.inputs,photos,regions:diagnosis.regions,questions:preserveQuestions(current,diagnosis.questions,photos),reasons:diagnosis.reasons,missing:diagnosis.missing,
    sourceAttemptId:job.attemptId??project.activeAttemptId??null,verifiedAgainst:null}));
  if(job.attemptId){const attempt=readAttempt(project,job.attemptId);attempt.status='needs_input';attempt.result={gate};writeAttempt(project,attempt);}
  pauseForInput(job,project,index,diagnosis.missing);
  return null;
}

async function run(job, project, options) {
  const steps = pipeline.buildSteps();

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

  const onAttempt=attempt=>{job.attemptId=attempt.id;project.pendingAttemptId=attempt.id;persist(project);};
  const execute=async(cmd,args)=>{
    const folder=pipeline.dirs(project,{attemptId:job.attemptId??project.activeAttemptId??null}).logs;
    mkdirSync(folder,{recursive:true});const log=resolve(folder,'sparse.log');
    const result=await spawnStep(job,{id:'sparse',name:'输入验证'},project,cmd,args,log);
    if(job.aborted)throw inputError('作业已取消',409);
    if(result.code!==0||result.spawnError)throw inputError('输入快照或指纹检查失败。请查看稀疏重建日志。',500);
  };
  if(job.assistanceRecord){
    job.prepared=await (job.runtime.prepareAssistedAttempt??prepareAssistedAttempt)(project,job.assistanceRecord,{execute,onAttempt});
    if(!sameInputs(job.prepared.context.inputs,job.assistanceRecord.inputs))throw Object.assign(inputError('辅助输入已改变。请重新检查回答和标记。',409),{staleAssistance:true});
    updateAssistance(project,current=>{
      if(current.revision!==job.assistanceRecord.revision)throw Object.assign(inputError('准备求解期间回答已更新，请使用新版本继续。',409),{staleAssistance:true});
      return {...current,state:'solving',lastAttemptId:job.attemptId};
    });
    job.scopeProject=job.prepared.project;
  }else if(!(steps[startIndex].id==='train'&&project.trainingResume)){
    const prepared=await (job.runtime.prepareAutomaticAttempt??prepareAutomaticAttempt)(project,steps[startIndex].id,{execute,onAttempt});
    job.scopeProject=prepared.project;
    if(prepared.attempt.status==='verified'){
      Object.assign(project,adoptAttempt(project,prepared.attempt,{currentRevision:readAssistance(project)?.revision??0,currentFingerprint:prepared.attempt.inputFingerprint}));
      delete project.trainingResume;
      job.scopeProject={...project};
    }
  }else job.scopeProject={...project};
  if(job.aborted)throw inputError('作业已取消',409);
  const d=pipeline.dirs(job.scopeProject);
  mkdirSync(d.logs,{recursive:true});

  const poller = setInterval(() => {
    const index = project.steps.findIndex((step) => step.status === "running");
    if (index < 0) return;
    const step = steps[index];
    if (step.id !== "train") return;
    const latest = pipeline.latestExportStep(job.scopeProject);
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
    const scene = projects.latestExport(job.scopeProject);
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
      if (step.id === "train") {
        try { pipeline.requireTrainingDataset(job.scopeProject); }
        catch (error) { halt(job, project, i, error.message); return; }
      }

      if (step.clean) {
        for (const target of step.clean(d, job.scopeProject)) {
          try {
            const absolute=resolve(target),workspace=resolve(d.workspace);
            if(absolute===workspace||!absolute.startsWith(workspace+sep))throw inputError('清理目标越过当前尝试目录',409);
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
      delete record.note;
      delete record.endedAt;
      project.currentStep = step.id;
      persist(project);
      emitState(job.projectId, project);

      const logPath = resolve(d.logs, `${step.id}.log`);
      if (step.id === "train" && project.trainingResume) {
        appendFileSync(logPath, `\n[workbench] 从 ${project.trainingResume.step} 步检查点恢复；保留已有导出，优化器重新初始化。\n`, "utf8");
      } else writeFileSync(logPath, "", "utf8");
      job.logTail = [];
      job.logTailSize = 0;

      const { cmd, args } = job.prepared&&step.id==='sparse'
        ? (job.runtime.assistanceCommand?.(job.prepared)??{cmd:TOOLS.python,args:[resolve(PY_DIR,'assisted_reconstruct.py'),'--request',job.prepared.requestPath,'--result',job.prepared.resultPath]})
        : (job.runtime.commandForStep?.(step.id,job.scopeProject)??step.command(job.scopeProject));
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

      if(job.prepared&&step.id==='sparse'&&existsSync(job.prepared.resultPath)){
        const solved=JSON.parse(readFileSync(job.prepared.resultPath,'utf8'));job.assistanceResult=solved;
        if(solved.outcome==='verified'&&readAssistance(project).revision!==job.assistanceRecord.revision){
          const attempt=readAttempt(project,job.attemptId);attempt.status='stale';attempt.result=solved;writeAttempt(project,attempt);
          pauseForInput(job,project,i,[{code:'stale_result',message:'求解期间回答已更新。旧模型已保留，请使用最新信息继续。'}]);return;
        }
        if(solved.outcome==='needs_input'){
          updateAssistance(project,current=>({...current,state:current.revision===job.assistanceRecord.revision?'needs_input':current.state,missing:solved.missing,lastAttemptId:job.attemptId}));
          const attempt=readAttempt(project,job.attemptId);attempt.status='needs_input';attempt.result=solved;writeAttempt(project,attempt);
          pauseForInput(job,project,i,solved.missing);return;
        }
        if(solved.outcome==='failed'){
          halt(job,project,i,solved.error?.message??'辅助求解工具失败。请查看日志。');return;
        }
      }
      if (result.code !== 0) {
        halt(job, project, i, `「${step.name}」退出码 ${result.code}${result.signal ? `（信号 ${result.signal}）` : ""}`);
        return;
      }

      if (step.gate) {
        const gate = pipeline.readGate(job.scopeProject);
        if (!gate) {
          halt(job, project, i, "几何门禁未产出 gate.json");
          return;
        }
        job.scopeProject.selectedModel=gate.selectedModel??null;
        let context;
        if(job.assistanceRecord){
          const current=readAssistance(project);
          const sourceContext=await (job.runtime.getContext??getContext)(assistanceSource(project,job.assistanceRecord),{fresh:true,execute});
          if(current.revision!==job.assistanceRecord.revision||!sameInputs(sourceContext.inputs,job.assistanceRecord.inputs)){
            pauseForInput(job,project,i,[{code:'stale_result',message:'求解期间回答或照片已更新。旧模型已保留，请使用最新信息继续。'}]);return;
          }
          context=await (job.runtime.getContext??getContext)(job.scopeProject,{fresh:true,execute});
          if(gate.verdict!=='pass'||!job.assistanceResult?.bridges?.accepted){pauseForInput(job,project,i,[{message:gate.message??'最终共享点未通过验证。'}]);return;}
          // Re-read after all asynchronous hashes, before adopting any result.
          if(readAssistance(project).revision!==job.assistanceRecord.revision){pauseForInput(job,project,i,[{message:'回答已更新，请按新版本继续。'}]);return;}
          const latest=readAssistance(project),diagnosis=diagnoseAssistance({gate,catalog:context.catalog,record:latest,manualRequest:false});
          if(diagnosis.required){
            updateAssistance(project,current=>({...current,...rebaseRecordGeometry(current,diagnosis,context.catalog),state:'needs_input',inputs:context.inputs,
              reasons:diagnosis.reasons,missing:diagnosis.missing,sourceAttemptId:job.attemptId,verifiedAgainst:null}));
            const pending=readAttempt(project,job.attemptId);pending.status='needs_input';pending.result={...job.assistanceResult,gate};writeAttempt(project,pending);
            pauseForInput(job,project,i,diagnosis.missing);return;
          }
        }else{
          const checked=await checkAssistance(job,project,i,gate,execute);if(!checked)return;context=checked.context;
          if(job.runtime.coverageRecord&&(readAssistance(project).revision!==job.runtime.coverageRecord.revision||!sameInputs(context.inputs,job.runtime.coverageRecord.inputs))){
            pauseForInput(job,project,i,[{message:'覆盖检查的回答或输入已改变，请重新确认。'}]);return;
          }
        }
        const attempt=readAttempt(project,job.attemptId);
        if(!job.assistanceRecord)attempt.inputFingerprint=context.inputs;
        const inherited=attempt.result?.geometrySignature===gate.models.find(m=>m.name===gate.selectedModel)?.geometrySignature?attempt.result:null;
        attempt.status='verified';attempt.result={selectedModel:gate.selectedModel,gate,geometrySignature:gate.models.find(m=>m.name===gate.selectedModel)?.geometrySignature,
          bridges:job.assistanceResult?.bridges??inherited?.bridges??null,scale:job.assistanceResult?.scale??inherited?.scale??null,localRepair:job.assistanceResult?.localRepair??inherited?.localRepair??null};writeAttempt(project,attempt);
        Object.assign(project,adoptAttempt(project,attempt,{currentRevision:readAssistance(project)?.revision??0,currentFingerprint:job.assistanceRecord?job.prepared.attempt.inputFingerprint:context.inputs}));
        delete project.trainingResume;
        job.scopeProject={...project};
        record.note=gate.message;
        const outputDiagnosis=diagnoseAssistance({gate,catalog:context.catalog,record:readAssistance(project)});
        if(readAssistance(project))updateAssistance(project,current=>({...current,...rebaseRecordGeometry(current,outputDiagnosis,context.catalog),state:'verified',inputs:context.inputs,sourceAttemptId:attempt.id,
          verifiedAgainst:{attemptId:attempt.id,geometrySignature:attempt.result.geometrySignature,sourceInputs:attempt.inputFingerprint,scale:job.assistanceResult?.scale?.scale??'unmeasured'},reasons:[],missing:[]}));
        qualityFor(project,{fresh:true});
      }

      if (step.verify) {
        const check = step.verify(job.scopeProject);
        if (!check.ok) {
          halt(job, project, i, `「${step.name}」校验失败：${check.message}`);
          return;
        }
        if (check.note) record.note = check.note;
      }

      Object.assign(record, { status: "success", progress: 1, exitCode: 0, endedAt: new Date().toISOString() });
      persist(project);
      emitState(job.projectId, project);
      if (options.untilStep === step.id) break;
    }
    settle(job, project);
  } finally {
    clearInterval(poller);
    clearInterval(heartbeat);
    if(job.aborted&&job.assistanceRecord)updateAssistance(project,current=>({...current,state:current.revision===job.assistanceRecord.revision?'ready':current.state}));
    if(job.aborted&&job.attemptId){const attempt=readAttempt(project,job.attemptId);attempt.status='aborted';writeAttempt(project,attempt);}
  }
}

export function start(projectId, options = {}, runtime = {}) {
  if (active.size) {
    throw Object.assign(new Error("已有作业在运行，请先等待完成或中止"), { code: 409 });
  }
  const project = projects.read(projectId);
  const order = pipeline.STEP_ORDER.map(step => step.id);
  if (options.untilStep && !order.includes(options.untilStep)) throw Object.assign(new Error("未知结束步骤"), { code: 400 });
  const startIndex = options.fromStep ? order.indexOf(options.fromStep)
    : project.steps.findIndex(step => step.status !== "success");
  if (options.untilStep && order.indexOf(options.untilStep) < startIndex) {
    throw Object.assign(new Error("结束步骤早于开始步骤，请选择有效运行范围"), { code: 400 });
  }
  if (options.fromStep && startIndex < 0) throw Object.assign(new Error("未知步骤"), { code: 400 });
  const assistance=readAssistance(project);
  if(startIndex>=order.indexOf('undistort')&&assistance&&assistance.state!=='verified')throw inputError('辅助信息尚未验证。请先在辅助重建中继续。',409);
  if (project.componentSource && startIndex >= 0 && startIndex < order.indexOf("sparse")) {
    throw Object.assign(new Error("独立区域项目复用已定位的数据。请从稀疏重建或几何检查继续。"), { code: 409 });
  }
  if (startIndex >= order.indexOf("undistort")) {
    pipeline.requireValidatedModel(project);
    if(deriveQuality(project,{gate:pipeline.readGate(project),record:assistance}).coverage!=='reviewed')throw inputError('目标区域覆盖尚未确认。请先重试几何检查，确认未定位照片所属区域。',409);
  }
  if (startIndex === order.indexOf("train")) pipeline.requireTrainingDataset(project);
  if (options.trainingPreset && pipeline.TRAINING_PRESETS[options.trainingPreset]) {
    project.trainingPreset = options.trainingPreset;
    persist(project);
  }
  const job = {
    id: `${projectId}-${Date.now()}`,
    projectId,
    project,
    runtime,
    assistanceRecord:runtime.assistanceRecord??null,
    child: null,
    aborted: false,
    logTail: [],
    logTailSize: 0,
  };
  active.set(projectId, job);
  job.done=run(job, project, options)
    .catch((error) => {
      // This handler must never throw: a secondary failure here would surface as
      // an unhandled rejection and take the whole server down.
      try {
        const latest = projects.read(projectId);
        const stale=error.staleAssistance===true;
        latest.state = job.aborted ? 'aborted' : stale?'needs_input':"failed";
        latest.lastError = stale?null:error.message;
        latest.currentStep = stale?'sparse':null;
        if(stale){const i=latest.steps.findIndex(s=>s.id==='sparse');latest.steps[i].status='needs_input';latest.steps[i].note=error.message;for(let j=i+1;j<latest.steps.length;j++)latest.steps[j].status='blocked';}
        if(job.attemptId){const attempt=readAttempt(latest,job.attemptId);attempt.status=job.aborted?'aborted':stale?'stale':'failed';attempt.failure={message:error.message};writeAttempt(latest,attempt);}
        if(job.assistanceRecord)updateAssistance(latest,current=>({...current,state:current.revision===job.assistanceRecord.revision?(job.aborted?'ready':stale?'stale':'failed'):current.state}));
        persist(latest);
        emitState(projectId, latest);
      } catch (secondary) {
        console.error(`[workbench] 标记作业失败时出错（${projectId}）：${secondary.message}`);
      }
    })
    .finally(() => active.delete(projectId));
  return job;
}

export function startAssistance(projectId,{expectedRevision,untilStep}={},runtime={}) {
  const project=projects.read(projectId),record=readAssistance(project);
  if(!record||record.revision!==expectedRevision)throw inputError('辅助回答版本已改变。请读取新版本。',409,{revision:record?.revision??0});
  if(record.state!=='ready')throw inputError('辅助信息尚不足以启动求解。请查看缺少信息。',409,{missing:record.missing});
  if(project.steps.slice(0,3).some(step=>step.status!=='success'))throw inputError('照片、特征或匹配需要重跑。请先完成这些步骤，再使用辅助信息继续。',409);
  if(record.reasons?.length&&record.reasons.every(r=>r.code==='coverage_unknown'))return start(projectId,{fromStep:'gate',...(untilStep?{untilStep}:{})},{...runtime,coverageRecord:structuredClone(record)});
  return start(projectId,{fromStep:'sparse',...(untilStep?{untilStep}:{})},{...runtime,assistanceRecord:structuredClone(record)});
}

/** Retained API: fresh runs use new attempts; checkpoint resume stays validated. */
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
  if (options.untilStep && order.indexOf(options.untilStep) < trainIndex) return null;
  if (startIndex === trainIndex && project.trainingResume) {
    pipeline.requireTrainingDataset({ ...project, trainingPreset: options.trainingPreset ?? project.trainingPreset });
    return null;
  }

  return null;
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
  const path = resolve(pipeline.dirs(project,{attemptId:project.pendingAttemptId??project.activeAttemptId??null}).logs, `${id}.log`);
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
