import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, openSync, closeSync, fsyncSync, readSync, writeSync, copyFileSync, statfsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { readJson, sendJson } from './http.mjs';

const base = '/api/mobile/v1/photo-sessions';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, code = 400) => Object.assign(new Error(message), { code });
const defaults = { maxFileBytes: 67108864, maxFiles: 500, maxBatchBytes: 4294967296, minLongEdge: 1000 };
const digest = async path => { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); };
const digestSync = path => { const h=createHash('sha256'), fd=openSync(path,'r'), b=Buffer.alloc(65536); try { let n; while((n=readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n)); } finally { closeSync(fd); } return h.digest('hex'); };

export function createPhotoSessions({ root, projectStore, validatePhoto, getCapabilities, grantProject, isDeviceActive, limits = {} }) {
  root = resolve(root); mkdirSync(root, { recursive: true });
  const lim = { ...defaults, ...limits }, locks = new Set(), sessions = new Map();
  const dir = id => join(root, id), meta = id => join(dir(id), 'session.json');
  const ready = (s, f) => join(dir(s.id), 'ready', f.id + f.extension);
  const removePart = (s, f) => { if (uuid.test(f.id)) rmSync(join(dir(s.id),f.id+'.part'),{force:true}); };
  const save = s => { const p = meta(s.id), tmp = p + '.tmp'; const fd = openSync(tmp, 'w'); try { writeFileSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, p); };
  const dto = s => ({ id:s.id, name:s.name, trainingPreset:s.trainingPreset, status:s.status, projectId:s.projectId, files:s.files.map(({id,name,bytes,status,error,sha256,width,height,duplicateOf}) => ({id,name,bytes,status,error,sha256,width,height,duplicateOf})), uniqueCount:s.files.filter(f => f.status === 'ready').length, totalBytes:s.files.reduce((n,f) => n + f.bytes, 0) });
  const own = (id, device) => { const s = uuid.test(id) && sessions.get(id); if (!s || s.deviceId !== device) throw bad('批次不存在',404); return s; };
  const cleanupReady = s => { try { rmSync(join(dir(s.id),'ready'),{recursive:true,force:true}); } catch {} };
  const file = (s,id) => { const f = s.files.find(x => x.id === id); if (!f) throw bad('文件不存在',404); return f; };
  const space = n => { const d = statfsSync(root); if (d.bavail * d.bsize < n) throw bad('磁盘空间不足',413); };
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
  async function handle(req,res,pathname,deviceId,checkAuthorization) {
    if (pathname !== base && !pathname.startsWith(base + '/')) return false;
    const method=req.method, suffix=pathname.slice(base.length), m=/^\/([^/]+)(?:\/(commit|files)(?:\/([^/]+))?)?$/.exec(suffix);
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
      if (action==='files' && !fid && method==='POST') {
        const b=await readJson(req); check(); checkOpen(s);
        if (!b || typeof b.name!=='string' || !b.name.trim() || b.name.length>255 || !Number.isSafeInteger(b.bytes) || b.bytes<1 || Object.keys(b).some(k=>!['name','bytes'].includes(k))) throw bad('文件参数无效');
        const cap=await getCapabilities(); check(); const ext=extname(b.name).toLowerCase();
        if (!cap.photoFormats.includes(ext)) throw bad('不支持的图片格式');
        if (b.bytes>lim.maxFileBytes || s.files.length>=lim.maxFiles || dto(s).totalBytes+b.bytes>lim.maxBatchBytes) throw bad('超过上传限制',413);
        space(b.bytes); const f={id:randomUUID(),name:b.name,bytes:b.bytes,status:'pending',error:null,sha256:null,width:null,height:null,duplicateOf:null,extension:ext}; s.files.push(f); save(s); sendJson(res,200,{fileId:f.id,session:dto(s)}); return;
      }
      if (action==='files' && fid && method==='DELETE') { check(); checkOpen(s); const f=file(s,fid); removePart(s,f); s.files=s.files.filter(x=>x!==f); if(f.status==='ready') { rmSync(ready(s,f),{force:true}); for(const d of s.files.filter(x=>x.duplicateOf===f.id)) { d.status='failed'; d.error='原文件已移除，请重试'; d.duplicateOf=null; } } save(s); sendJson(res,200,dto(s)); return; }
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
        check(); if(s.status==='committing') { recover(s); check(); } if(s.status==='committed') { grantProject(deviceId,s.projectId); sendJson(res,200,{projectId:s.projectId}); return; } checkOpen(s);
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
  return {handle,capabilities:async()=>{const cap=await getCapabilities(); return {...cap,limits:{...defaults},trainingPresets:['fast','standard','full']};},ownsProject:id=>[...sessions.values()].some(s=>s.status==='committed' && s.projectId===id)};
}
