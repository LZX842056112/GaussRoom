// Reconstruction workbench: local-only HTTP service for the browser UI.
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from 'node:url';
import { PUBLIC_DIR, PROJECTS_DIR, REPO, TOOLS, toolStatus, dependencyStatus } from "./lib/paths.mjs";
import { createRouter, readJson, sendJson, sendText, serveStatic, streamFile } from "./lib/http.mjs";
import * as projects from "./lib/projects.mjs";
import * as jobs from "./lib/jobs.mjs";
import { FEATURE_PRESETS, GATE, TRAINING_PRESETS, dirs, readGate } from "./lib/pipeline.mjs";
import { readAssistance, saveAssistance, inputError, updateAssistance, newRecord, preserveQuestions } from './lib/assistance.mjs';
import { diagnoseAssistance } from './lib/assistance-diagnosis.mjs';
import { getContext as defaultGetContext, assistanceSource } from './lib/assistance-service.mjs';
import { listAttempts, readAttempt } from './lib/attempts.mjs';
import { qualityFor, saveReview, evaluationFor } from './lib/quality.mjs';
import {previewFactReuse,reuseFacts,importPhotos} from './lib/assistance-import.mjs';

export function createWorkbenchServer({getContext=defaultGetContext,jobRuntime={}}={}) {
const router = createRouter();
const fail = (response, error) => sendJson(response, Number.isInteger(error.code)&&error.code>=400&&error.code<=599?error.code:500, {
  error: error.message,
  ...(error.details ? { details: error.details } : {}),
});

function diskFreeBytes() {
  try {
    const stats = statfsSync(REPO);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

router.get("/api/health", (request, response) => {
  sendJson(response, 200, {
    ok: true,
    tools: toolStatus(),
    dependencyDetails: dependencyStatus(),
    paths: { repo: REPO, projects: PROJECTS_DIR, tools: TOOLS },
    diskFreeBytes: diskFreeBytes(),
    busyProject: jobs.busyId(),
  });
});

router.get("/api/presets", (request, response) => {
  sendJson(response, 200, { trainingPresets: TRAINING_PRESETS, featurePresets: FEATURE_PRESETS, gate: GATE });
});

/** Step progress lives in memory while a job runs; overlay it on the on-disk record. */
function summarise(id) {
  return projects.summarise(jobs.liveProject(id) ?? projects.read(id));
}

router.get("/api/projects", (request, response) => {
  const live = jobs.liveProjects();
  sendJson(response, 200, projects.list().map((item) => (
    live.has(item.id) ? projects.summarise(live.get(item.id)) : item
  )));
});

router.post("/api/projects", async (request, response) => {
  const body = await readJson(request);
  try {
    sendJson(response, 201, projects.summarise(projects.create(body)));
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id", (request, response, { id }) => {
  try {
    sendJson(response, 200, summarise(id));
  } catch (error) {
    fail(response, error);
  }
});

router.patch("/api/projects/:id", async (request, response, { id }) => {
  try {
    const body = await readJson(request);
    sendJson(response, 200, projects.summarise(projects.update(id, body)));
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/projects/:id/components", async (request, response, { id }) => {
  try {
    const body = await readJson(request);
    if (jobs.anyRunning()) throw Object.assign(new Error("已有作业在运行，请等待完成后选择独立区域"), { code: 409 });
    const project = projects.createComponent(id, body);
    jobs.start(project.id, { fromStep: "sparse", untilStep: "gate" });
    sendJson(response, 201, summarise(project.id));
  } catch (error) {
    fail(response, error);
  }
});

router.delete("/api/projects/:id", (request, response, { id }) => {
  try {
    if (jobs.current(id)) throw Object.assign(new Error("项目正在运行，请先中止"), { code: 409 });
    projects.remove(id);
    sendJson(response, 200, { removed: id });
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/dialog/folder", async (request, response) => {
  const body = await readJson(request);
  try {
    const chosen = await projects.pickFolder(body.title || "选择图片文件夹");
    if (!chosen) {
      response.writeHead(204).end();
      return;
    }
    sendJson(response, 200, { path: chosen, imageCount: projects.countImages(chosen) });
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/projects/:id/run", async (request, response, { id }) => {
  const body = await readJson(request);
  try {
    fields(body,['fromStep','untilStep','trainingPreset','allowTrainClean','resumeCheckpoint']);
    // Rerunning train wipes its directory; make that an explicit decision.
    if (!body.allowTrainClean) {
      const warning = jobs.trainCleanWarning(projects.read(id), body);
      if (warning) throw Object.assign(new Error(warning.message), { code: 409, details: warning });
    }
    const job = jobs.start(id, body,jobRuntime);
    sendJson(response, 202, { jobId: job.id });
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/projects/:id/abort", async (request, response, { id }) => {
  try {
    await jobs.abort(id);
    sendJson(response, 202, { aborted: true });
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/events", (request, response, { id }) => jobs.attachEvents(id, request, response));

router.get("/api/projects/:id/log", (request, response, { id }, query) => {
  try {
    const raw = Number(query.get("tail") ?? 65536);
    const tail = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), 1024), 4 * 1024 * 1024)
      : 65536;
    const { text } = jobs.readStepLog(id, query.get("step") ?? undefined, tail);
    sendText(response, 200, text);
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/summary", (request, response, { id }) => {
  try {
    const project = projects.read(id);
    const folder = dirs(project).summary;
    const readOrNull = (name) => {
      const path = resolve(folder, name);
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    };
    sendJson(response, 200, {
      gate: readGate(project),
      pendingGate:project.pendingAttemptId?readGate(project,{attemptId:project.pendingAttemptId}):null,
      modelSummary: readOrNull("model-summary.json"),
      manifest: (() => {
        const path = dirs(project).manifest;
        if (!existsSync(path)) return null;
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        const { records, ...rest } = manifest;
        return rest;
      })(),
      assistance:readAssistance(project),quality:qualityFor(project),attempts:listAttempts(project),
    });
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/scene", (request, response, { id }) => {
  try {
    const project = projects.read(id);
    const scene = projects.latestExport(project);
    sendJson(response, 200, scene ? { ...scene, url: `/api/projects/${id}/scene.ply` } : null);
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/image", (request, response, { id }, query) => {
  try {
    const project=projects.read(id),record=readAssistance(project),photoId=query.get('photoId');
    const photo=photoId?record?.photos?.find(p=>p.photoId===photoId):null;
    if(photoId&&!photo)throw inputError('照片不存在或已改变',404);
    const requestedAttempt=query.get('attemptId');
    if(requestedAttempt&&requestedAttempt!=='legacy')readAttempt(project,requestedAttempt);
    const imageProject=requestedAttempt?{...project,activeAttemptId:requestedAttempt==='legacy'?null:requestedAttempt}:photoId?assistanceSource(project,record):project;
    const root = realpathSync(dirs(imageProject).images);
    const target = realpathSync(resolve(root, photo?.name??query.get("name")??''));
    if (!target.startsWith(root + sep) || !/\.(jpe?g|png|webp)$/i.test(target)) {
      throw Object.assign(new Error("照片路径无效"), { code: 400 });
    }
    streamFile(response, target, { head: request.method === "HEAD" });
  } catch (error) {
    fail(response, error);
  }
});

function sceneFile(request, response, { id }, query) {
  try {
    const project = projects.read(id);
    const scene = projects.latestExport(project);
    if (!scene) throw Object.assign(new Error("尚未导出任何场景"), { code: 404 });
    streamFile(response, scene.path, {
      head: request.method === "HEAD",
      download: query?.get("download") === "1",
    });
  } catch (error) {
    fail(response, error);
  }
}

router.get("/api/projects/:id/scene.ply", sceneFile);

function fields(body,allowed){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))throw inputError('请求包含不允许的字段');
}
router.get('/api/projects/:id/assistance',async(request,response,{id})=>{
  const project=projects.read(id),record=readAssistance(project);
  let catalog=record?.photos??[];
  try{catalog=(await getContext(assistanceSource(project,record))).catalog;}catch(error){if(!catalog.length&&error.code!==409)throw error;}
  sendJson(response,200,{record,quality:qualityFor(project),catalog,attempts:listAttempts(project)});
});
router.put('/api/projects/:id/assistance',async(request,response,{id})=>{
  const body=await readJson(request);fields(body,['expectedRevision','patch']);
  const project=projects.read(id),previous=readAssistance(project);
  const context=await getContext(assistanceSource(project,previous),{fresh:true});
  const catalog={photos:context.catalog.map(p=>({...p,unregistered:previous?.photos?.find(old=>old.photoId===p.photoId)?.unregistered??false})),regions:previous?.regions??[],questions:previous?.questions??[],reasons:previous?.reasons??[]};
  const record=saveAssistance(project,{...body,catalog,inputs:context.inputs});
  sendJson(response,200,{record,quality:qualityFor(project)});
});
router.post('/api/projects/:id/assistance/check',async(request,response,{id})=>{
  const body=await readJson(request);fields(body,['expectedRevision']);
  if(jobs.anyRunning())throw inputError('已有作业正在运行，请先等待或中止。',409);
  const project=projects.read(id),previous=readAssistance(project),context=await getContext(project,{fresh:true});
  const diagnosis=diagnoseAssistance({gate:context.gate,catalog:context.catalog,record:previous,manualRequest:true});
  const record=updateAssistance(project,current=>{
    if((current?.revision??0)!==body.expectedRevision)throw inputError('辅助回答版本已改变',409,{revision:current?.revision??0});
    return {...(current??newRecord()),revision:(current?.revision??0)+1,state:'needs_input',inputs:context.inputs,sourceAttemptId:project.activeAttemptId??null,
      photos:context.catalog.map(p=>({...p,unregistered:diagnosis.unregistered.includes(p.photoId)})),regions:diagnosis.regions,questions:preserveQuestions(current,diagnosis.questions,context.catalog),reasons:diagnosis.reasons,missing:diagnosis.missing,verifiedAgainst:null};
  });
  project.state='needs_input';projects.write(project);
  sendJson(response,200,{record,quality:qualityFor(project)});
});
router.post('/api/projects/:id/assistance/run',async(request,response,{id})=>{
  const body=await readJson(request);fields(body,['expectedRevision','untilStep']);
  if(body.untilStep&&!['gate','train'].includes(body.untilStep))throw inputError('辅助求解只支持停在几何检查或训练完成。');
  const job=jobs.startAssistance(id,body,jobRuntime);
  // Job creation is synchronous; its new attempt is assigned during preparation.
  sendJson(response,202,{project:projects.summarise(job.project),attemptId:job.attemptId??null,jobId:job.id});
});
router.post('/api/projects/:id/assistance/review',async(request,response,{id})=>{
  const body=await readJson(request);fields(body,['expectedRevision','attemptId','geometrySignature','review']);
  const project=projects.read(id),context=await getContext(project,{fresh:true});
  const quality=saveReview(project,{...body,catalog:context.catalog,inputs:context.inputs});
  sendJson(response,200,{record:readAssistance(project),quality});
});
router.get('/api/projects/:id/assistance/reuse',async(request,response,{id},query)=>{
 const project=projects.read(id),record=readAssistance(project),context=await getContext(assistanceSource(project,record),{fresh:true});
 sendJson(response,200,previewFactReuse(project,query.get('sourceProjectId'),{catalog:context.catalog}));
});
router.post('/api/projects/:id/assistance/reuse',async(request,response,{id})=>{
 const body=await readJson(request);fields(body,['expectedRevision','sourceProjectId','answerIds']);
 if(jobs.anyRunning())throw inputError('已有作业正在运行，请先等待或中止。',409);
 const project=projects.read(id),context=await getContext(assistanceSource(project,readAssistance(project)),{fresh:true});
 const record=reuseFacts(project,{...body,catalog:context.catalog,inputs:context.inputs});sendJson(response,200,{record,quality:qualityFor(project)});
});
router.post('/api/projects/:id/assistance/photos',async(request,response,{id})=>{
 const body=await readJson(request);fields(body,['expectedRevision','sourceDir']);
 if(jobs.anyRunning())throw inputError('已有作业正在运行，请先等待或中止。',409);
 const project=projects.read(id),result=importPhotos(project,body);sendJson(response,200,{...result,project:projects.summarise(projects.read(id)),quality:qualityFor(projects.read(id))});
});
for(const suffix of ['scene','scene.ply'])router.get(`/api/projects/:id/attempts/:attemptId/${suffix}`,(request,response,{id,attemptId},query)=>{
  const project=projects.read(id);if(attemptId!=='legacy')readAttempt(project,attemptId);
  const scoped={...project,activeAttemptId:attemptId==='legacy'?null:attemptId},scene=projects.latestExport(scoped);
  if(suffix==='scene'){sendJson(response,200,scene?{...scene,url:`/api/projects/${id}/attempts/${attemptId}/scene.ply`}:null);return;}
  if(!scene)throw inputError('尚未导出任何场景',404);
  streamFile(response,scene.path,{head:request.method==='HEAD',download:query.get('download')==='1'});
});
function evaluationProject(id,query){
 const project=projects.read(id),attemptId=query.get('attemptId');if(!attemptId)return project;
 if(attemptId!=='legacy')readAttempt(project,attemptId);
 return {...project,selectedModel:null,activeAttemptId:attemptId==='legacy'?null:attemptId};
}
router.get('/api/projects/:id/evaluation',(request,response,{id},query)=>sendJson(response,200,evaluationFor(evaluationProject(id,query))));
router.get('/api/projects/:id/evaluation/image',(request,response,{id},query)=>{
 const project=evaluationProject(id,query),evaluation=evaluationFor(project),step=Number(query.get('step')),name=query.get('name');
 if(!Number.isInteger(step)||!evaluation.available.some(s=>s.step===step&&s.names.includes(name)))throw inputError('评估照片或步数不在检查清单内');
 const root=realpathSync(dirs(project).workspace),target=realpathSync(resolve(dirs(project).train,`eval_${step}`,name));
 if(!target.startsWith(root+sep))throw inputError('评估图片路径越界');streamFile(response,target,{head:request.method==='HEAD'});
});

const server = createServer(async (request, response) => {
  // Every request path is wrapped: a malformed URI used to throw out of the
  // async handler and take the whole process down with an unhandled rejection.
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const method = request.method === "HEAD" ? "GET" : request.method;
    const hit = router.match(method, url.pathname);
    if (hit) {
      await hit.handler(request, response, hit.params, url.searchParams);
      return;
    }
    serveStatic(request, response, url.pathname, PUBLIC_DIR);
  } catch (error) {
    if (!response.headersSent) fail(response, error);
    else response.destroy();
  }
});
return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
const server=createWorkbenchServer();

process.on("unhandledRejection", (reason) => {
  console.error("[workbench] 未处理的 Promise 拒绝：", reason?.message ?? reason);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[workbench] 收到 ${signal}，正在终止子进程…`);
  try {
    await jobs.killAll();
  } catch (error) {
    console.error(`[workbench] 终止子进程失败：${error.message}`);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { shutdown(signal); });
}

const orphans = await jobs.cleanupOrphans();
if (orphans.length) {
  console.log(`[workbench] 已清理 ${orphans.length} 个遗留子进程：${orphans.map((o) => `${o.id}#${o.pid}`).join("、")}`);
}
const reconciled = projects.reconcile();
if (reconciled.length) {
  console.log(`[workbench] 已对账 ${reconciled.length} 个被中断的项目：${reconciled.join("、")}`);
}

let port = Number(process.env.PORT ?? process.argv[2] ?? 8123);
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    port += 1;
    server.listen(port, "127.0.0.1");
    return;
  }
  throw error;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`workbench: http://127.0.0.1:${port}/`);
  console.log(`projects : ${PROJECTS_DIR}`);
});
}
