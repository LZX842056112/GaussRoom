import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, existsSync, openSync, closeSync, fsyncSync, readSync, writeSync, copyFileSync, statfsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, sendJson, streamFile } from './http.mjs';
import { createCaptureAnalysis } from './capture-analysis.mjs';
import { PY_DIR, TOOLS } from './paths.mjs';

const base = '/api/mobile/v1/photo-sessions';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, code = 400) => Object.assign(new Error(message), { code });
const defaults = { maxFileBytes: 67108864, maxFiles: 500, maxBatchBytes: 4294967296, minLongEdge: 1000 };
const digest = async path => { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); };
const digestSync = path => { const h=createHash('sha256'), fd=openSync(path,'r'), b=Buffer.alloc(65536); try { let n; while((n=readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n)); } finally { closeSync(fd); } return h.digest('hex'); };

async function makeThumbnail(source,target){
  await promisify(execFile)(TOOLS.python,['-X','utf8','-B',join(PY_DIR,'capture_analysis.py'),'--thumbnail',source,'--output',target,...(TOOLS.ffmpeg?['--ffmpeg',TOOLS.ffmpeg]:[])],{windowsHide:true,timeout:30000,maxBuffer:65536});
}

export function createPhotoSessions({ root, projectStore, jobStore = {}, validatePhoto, getCapabilities, grantProject, revokeProject = ()=>{}, isDeviceActive, limits = {}, analysisRun, thumbnailer=makeThumbnail }) {
  root = resolve(root); mkdirSync(root, { recursive: true });
  const lim = { ...defaults, ...limits }, locks = new Set(), sessions = new Map();
  const analysis=createCaptureAnalysis({root,busy:()=>jobStore.anyRunning?.()??false,...(analysisRun?{run:analysisRun}:{})}),thumbnailJobs=new Map();
  const dir = id => join(root, id), meta = id => join(dir(id), 'session.json');
  const ready = (s, f) => join(dir(s.id), 'ready', f.id + f.extension);
  const removePart = (s, f) => { if (uuid.test(f.id)) rmSync(join(dir(s.id),f.id+'.part'),{force:true}); };
  const save = s => { const p = meta(s.id), tmp = p + '.tmp'; const fd = openSync(tmp, 'w'); try { writeFileSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, p); };
  const dto = s => ({ id:s.id, name:s.name, trainingPreset:s.trainingPreset, status:s.status, projectId:s.projectId, files:s.files.map(({id,name,bytes,status,error,sha256,width,height,duplicateOf,clientCaptureId}) => ({id,name,bytes,status,error,sha256,width,height,duplicateOf,...(clientCaptureId?{clientCaptureId}:{})})), uniqueCount:s.files.filter(f => f.status === 'ready').length, totalBytes:s.files.reduce((n,f) => n + f.bytes, 0) });
  const own = (id, device) => { const s = uuid.test(id) && sessions.get(id); if (!s || s.deviceId !== device) throw bad('批次不存在',404); return s; };
  const cleanupReady = s => { try { rmSync(join(dir(s.id),'ready'),{recursive:true,force:true}); } catch {} };
  const file = (s,id) => { const f = s.files.find(x => x.id === id); if (!f) throw bad('文件不存在',404); return f; };
  const space = n => { mkdirSync(root,{recursive:true}); const d = statfsSync(root); if (d.bavail * d.bsize < n) throw bad('磁盘空间不足',413); };
  const recover = s => {
    if (s.status !== 'committing') return;
    let p; try { p = projectStore.read(s.projectId); } catch { s.status = 'open'; s.projectId = null; save(s); return; }
    const source = resolve(dir(s.id), 'ready'), target = resolve(dirname(projectStore.projectPath(s.projectId)), 'source-images');
    if (resolve(p.sourceDir) !== source && !(resolve(p.sourceDir) === target && p.photoSessionId === s.id)) return;
    const files=s.files.filter(x => x.status === 'ready');
    try { if(files.some(f=>digestSync(ready(s,f))!==f.sha256)) return; } catch { return; }
    mkdirSync(target, { recursive:true });
    for (const f of files) copyFileSync(ready(s,f),join(target,f.id+f.extension));
    projectStore.write({ ...p, inputKind:'photos', sourceDir:target, photoSessionId:s.id });
    s.status = 'committed'; save(s);
    cleanupReady(s);
  };
  for (const id of readdirSync(root)) {
    if (!uuid.test(id) || !existsSync(meta(id))) continue;
    const s = JSON.parse(readFileSync(meta(id),'utf8')); if (s.id !== id) continue;
    sessions.set(id,s); let changed = false;
    for (const f of s.files) {
      if (f.status === 'uploading' || f.status === 'failed') { try { removePart(s,f); } catch {} }
      if (f.status === 'uploading') { f.status='failed'; f.error='上传中断，请重试'; changed=true; }
    }
    if (changed) save(s);
    const pendingId=s.projectId;
    try { recover(s); } catch { s.status='committing'; s.projectId=pendingId; }
    if (s.status === 'committed') { cleanupReady(s); if (isDeviceActive(s.deviceId)) grantProject(s.deviceId,s.projectId); }
  }
  const exclusive = async (id, fn) => { if (locks.has(id)) throw bad('批次正在处理',409); locks.add(id); try { return await fn(); } finally { locks.delete(id); } };
  const checkOpen = s => { if (s.status !== 'open') throw bad('批次已提交或正在提交',409); };
  async function cancelAnalysis(s,invalidate=false){s.captureGeneration=(s.captureGeneration??0)+1;save(s);await analysis.cancel(s.id,{invalidate});}
  async function handleCapture(req,res,suffix,deviceId,checkAuthorization){
    const m=/^\/([^/]+)\/(capture-analysis|capture-map|files\/([^/]+)\/thumbnail)$/.exec(suffix);if(!m)return false;
    const [,id,action,fid]=m,s=own(id,deviceId),check=()=>{checkAuthorization();own(id,deviceId);if(!isDeviceActive(deviceId))throw bad('设备未授权',401);};check();
    if(action==='capture-analysis'){
      if(req.method==='GET'||req.method==='HEAD'){sendJson(res,200,analysis.status(id));return true;}
      if(req.method!=='POST')throw bad('接口不存在',404);
      await exclusive(id,async()=>{const b=await readJson(req);check();
        if(!b||!['start','cancel'].includes(b.action)||Object.keys(b).some(k=>!['action','force'].includes(k))||(b.force!==undefined&&typeof b.force!=='boolean'))throw bad('分析参数无效');
        if(b.action==='cancel'){await cancelAnalysis(s);check();sendJson(res,200,analysis.status(id));return;}
        checkOpen(s);
        const generation=s.captureGeneration??0,files=s.files.filter(f=>f.status==='ready').map(f=>({id:f.id,path:ready(s,f),sha256:f.sha256,width:f.width,height:f.height}));
        const status=analysis.request({id,deviceId,files,force:b.force,check:()=>{check();checkOpen(s);if((s.captureGeneration??0)!==generation)throw bad('分析输入已变更',409);}});
        sendJson(res,202,status);
      });return true;
    }
    if(req.method!=='GET'&&req.method!=='HEAD')throw bad('接口不存在',404);
    if(action==='capture-map'){const map=analysis.map(id);check();if(!map)throw bad('暂无位置图',404);sendJson(res,200,map);return true;}
    const f=file(s,fid);if(f.status!=='ready')throw bad('照片尚未上传',404);
    let source=ready(s,f);
    if(s.status==='committed'){
      const p=projectStore.read(s.projectId),folder=join(dirname(projectStore.projectPath(s.projectId)),'source-images');
      if(!p||p.photoSessionId!==s.id||resolve(p.sourceDir)!==resolve(folder))throw bad('项目关联无效',409);source=join(folder,f.id+f.extension);
    }else checkOpen(s);
    const generation=s.captureGeneration??0,sha=f.sha256,folder=join(dir(id),'thumbnails'),target=join(folder,f.id+'.jpg');
    if(!existsSync(target)){
      let task=thumbnailJobs.get(target);if(!task){mkdirSync(folder,{recursive:true});const tmp=target+'.tmp-'+randomUUID()+'.jpg';
        task=(async()=>{try{await thumbnailer(source,tmp);check();if((s.captureGeneration??0)!==generation||!s.files.some(x=>x.id===fid&&x.status==='ready'&&x.sha256===sha))throw bad('照片已变更',409);renameSync(tmp,target);}catch(e){if(Number.isInteger(e.code))throw e;throw bad('缩略图生成失败',503);}finally{rmSync(tmp,{force:true});thumbnailJobs.delete(target);}})();thumbnailJobs.set(target,task);
      }await task;
    }
    check();if((s.captureGeneration??0)!==generation)throw bad('照片已变更',409);streamFile(res,target,{head:req.method==='HEAD'});return true;
  }
  async function handle(req,res,pathname,deviceId,checkAuthorization) {
    if (pathname !== base && !pathname.startsWith(base + '/')) return false;
    const method=req.method, suffix=pathname.slice(base.length), m=/^\/([^/]+)(?:\/(commit|files)(?:\/([^/]+))?)?$/.exec(suffix);
    if(await handleCapture(req,res,suffix,deviceId,checkAuthorization))return true;
    if (!suffix && method === 'GET') { sendJson(res,200,[...sessions.values()].filter(s=>s.deviceId===deviceId).map(dto)); return true; }
    if (!suffix && method === 'POST') {
      const b=await readJson(req); checkAuthorization();
      if (!b || typeof b.name !== 'string' || !b.name.trim() || b.name.length>200 || Object.keys(b).some(k=>!['name','trainingPreset'].includes(k)) || !['fast','standard','full'].includes(b.trainingPreset ?? 'standard')) throw bad('批次参数无效');
      space(1); const id=randomUUID(), s={id,deviceId,name:b.name.trim(),trainingPreset:b.trainingPreset??'standard',status:'open',projectId:null,files:[]}; mkdirSync(join(dir(id),'ready'),{recursive:true}); save(s); sessions.set(id,s); sendJson(res,200,dto(s)); return true;
    }
    if (!m) throw bad('接口不存在',404);
    const [,id,action,fid]=m; own(id,deviceId);
    if (!action && method==='GET') { sendJson(res,200,dto(own(id,deviceId))); return true; }
    await exclusive(id,async()=>{
      const s=own(id,deviceId), check=()=>{checkAuthorization(); own(id,deviceId);};
      if (!action && method==='DELETE') {
        check();const folder=resolve(dir(s.id));if(!uuid.test(s.id)||dirname(folder)!==root)throw bad('批次路径无效',409);
        let project=null,projectFolder=null;const retryDeletion=s.status==='deleting';
        if(s.projectId){
          if(!s.projectId.startsWith('mobile-')||!uuid.test(s.projectId.slice(7)))throw bad('项目关联无效',409);
          projectFolder=dirname(projectStore.projectPath(s.projectId));
          if(jobStore.current?.(s.projectId)||jobStore.liveProject?.(s.projectId))throw bad('项目正在重建，请等待完成或先在电脑停止任务。',409);
          try{project=projectStore.read(s.projectId);}catch{if(existsSync(projectStore.projectPath(s.projectId))||(!retryDeletion&&existsSync(projectFolder)))throw bad('无法读取项目，请在电脑工作台检查。',409);}
          if(project){
            const belongs=project.photoSessionId===s.id||resolve(project.sourceDir??'')===resolve(folder,'ready');
            if(project.id!==s.projectId||!belongs||project.inputKind==='arkit_scan'||project.capture)throw bad('项目不属于当前批次',409);
            if(['running','aborting'].includes(project.state))throw bad('项目正在重建，请等待完成或先在电脑停止任务。',409);
          }
        }
        await cancelAnalysis(s,true);check();s.status='deleting';save(s);check();
        try{
          if(project||(retryDeletion&&projectFolder&&existsSync(projectFolder)))projectStore.remove(s.projectId,{allowMissingMetadata:retryDeletion});
          if(s.projectId)revokeProject(deviceId,s.projectId);
          // Keep the deletion record until uploaded data has been removed.
          for(const name of readdirSync(folder))if(!['session.json','session.json.tmp'].includes(name))rmSync(join(folder,name),{recursive:true,force:true});
          rmSync(meta(s.id)+'.tmp',{force:true});rmSync(meta(s.id),{force:true});rmdirSync(folder);
        }catch{throw bad('删除未完成，请检查电脑文件占用和写入权限后重试。',503);}
        sessions.delete(s.id);analysis.forget(s.id);sendJson(res,200,{removed:s.id,projectId:s.projectId});return;
      }
      if (action==='files' && !fid && method==='POST') {
        const b=await readJson(req); check(); checkOpen(s);
        if (!b || typeof b.name!=='string' || !b.name.trim() || b.name.length>255 || !Number.isSafeInteger(b.bytes) || b.bytes<1 || Object.keys(b).some(k=>!['name','bytes','clientCaptureId'].includes(k)) || (b.clientCaptureId!==undefined && (typeof b.clientCaptureId!=='string'||!uuid.test(b.clientCaptureId)))) throw bad('文件参数无效');
        if(b.clientCaptureId){const prior=s.files.find(f=>f.clientCaptureId===b.clientCaptureId);if(prior){if(prior.name!==b.name||prior.bytes!==b.bytes)throw bad('采集编号已用于其他照片',409);sendJson(res,200,{fileId:prior.id,session:dto(s)});return;}}
        const cap=await getCapabilities(); check(); const ext=extname(b.name).toLowerCase();
        if (!cap.photoFormats.includes(ext)) throw bad('不支持的图片格式');
        if (b.bytes>lim.maxFileBytes || s.files.length>=lim.maxFiles || dto(s).totalBytes+b.bytes>lim.maxBatchBytes) throw bad('超过上传限制',413);
        space(b.bytes); const f={id:randomUUID(),name:b.name,bytes:b.bytes,status:'pending',error:null,sha256:null,width:null,height:null,duplicateOf:null,extension:ext,...(b.clientCaptureId?{clientCaptureId:b.clientCaptureId}:{})}; s.files.push(f); save(s); sendJson(res,200,{fileId:f.id,session:dto(s)}); return;
      }
      if (action==='files' && fid && method==='DELETE') { check(); checkOpen(s); const f=file(s,fid);await cancelAnalysis(s,true);check();removePart(s,f);rmSync(join(dir(id),'thumbnails',f.id+'.jpg'),{force:true});s.files=s.files.filter(x=>x!==f); if(f.status==='ready') { rmSync(ready(s,f),{force:true}); for(const d of s.files.filter(x=>x.duplicateOf===f.id)) { d.status='failed'; d.error='原文件已移除，请重试'; d.duplicateOf=null; } } save(s); sendJson(res,200,dto(s)); return; }
      if (action==='files' && fid && method==='PUT') {
        check(); checkOpen(s); const f=file(s,fid); if (!['pending','failed'].includes(f.status)) throw bad('文件状态冲突',409);
        const part=join(dir(id),f.id+'.part'); f.status='uploading'; f.error=null; save(s); let fd;
        try {
          space(f.bytes); fd=openSync(part,'w'); let n=0; const h=createHash('sha256');
          for await (const chunk of req) { check(); n+=chunk.length; if(n>f.bytes || n>lim.maxFileBytes) throw bad('文件过大',413); h.update(chunk); let pos=0; while(pos<chunk.length) pos+=writeSync(fd,chunk,pos,chunk.length-pos); }
          fsyncSync(fd); closeSync(fd); fd=undefined; check(); if(n!==f.bytes) throw bad('文件不完整');
          const sha=h.digest('hex'), info=await validatePhoto(part,f.extension); check();
          if (!info || !Number.isFinite(info.width) || !Number.isFinite(info.height) || Math.max(info.width,info.height)<lim.minLongEdge || !['.jpg','.png','.heic','.heif'].includes(info.extension) || info.sha256!==sha || info.bytes!==n) throw bad('图片校验失败');
          const dupe=s.files.find(x=>x.status==='ready' && x.sha256===sha); f.sha256=sha; f.width=info.width; f.height=info.height; f.extension=info.extension;
          if (dupe) { f.status='duplicate'; f.duplicateOf=dupe.id; rmSync(part,{force:true}); } else { renameSync(part,ready(s,f)); f.status='ready'; }
          save(s); sendJson(res,200,dto(s));
        } catch(e) { if(fd!==undefined) closeSync(fd); rmSync(part,{force:true}); f.status='failed'; f.error=e.code===401?'设备未授权':(e.message||'上传失败'); save(s); throw e; }
        return;
      }
      if (action==='commit' && !fid && method==='POST') {
        check();await cancelAnalysis(s);check();if(s.status==='committing') { recover(s); check(); } if(s.status==='committed') { grantProject(deviceId,s.projectId); sendJson(res,200,{projectId:s.projectId}); return; } checkOpen(s);
        const files=s.files.filter(f=>f.status==='ready'); if(files.length<2 || s.files.some(f=>['pending','uploading','failed'].includes(f.status))) throw bad('照片尚未准备完成',409);
        for(const f of files) { const h=await digest(ready(s,f)); check(); if(h!==f.sha256) throw bad('照片文件已损坏',409); }
        space(files.reduce((n,f)=>n+f.bytes,0)); check(); s.status='committing'; s.projectId=`mobile-${randomUUID()}`; save(s);
        check(); const p=projectStore.create({name:s.name,sourceDir:join(dir(s.id),'ready'),trainingPreset:s.trainingPreset},{id:s.projectId});
        check(); const target=join(dirname(projectStore.projectPath(p.id)),'source-images'); mkdirSync(target,{recursive:true}); for(const f of files) copyFileSync(ready(s,f),join(target,f.id+f.extension));
        check(); projectStore.write({...p,inputKind:'photos',sourceDir:target,photoSessionId:s.id}); s.status='committed'; save(s); cleanupReady(s); check(); grantProject(deviceId,s.projectId); sendJson(res,200,{projectId:s.projectId}); return;
      }
      throw bad('接口不存在',404);
    }); return true;
  }
  return {handle,capabilities:async()=>{const cap=await getCapabilities(); return {...cap,limits:{...lim},trainingPresets:['fast','standard','full']};},ownsProject:id=>[...sessions.values()].some(s=>s.status==='committed' && s.projectId===id),
    ownsSession:(id,device)=>{own(id,device);return true;},
    cancelDevice:async device=>{await Promise.all([...sessions.values()].filter(s=>s.deviceId===device).map(s=>cancelAnalysis(s,true)));},
    close:async()=>{await analysis.close();await Promise.allSettled([...thumbnailJobs.values()]);}};
}
