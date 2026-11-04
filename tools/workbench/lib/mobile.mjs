import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { isIP } from 'node:net';
import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { createReadStream, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, writeSync, ftruncateSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { PROJECTS_DIR, PUBLIC_DIR, PY_DIR, TOOLS } from './paths.mjs';
import { readJson, sendJson, streamFile } from './http.mjs';
import * as defaultProjects from './projects.mjs';
import * as defaultJobs from './jobs.mjs';
import {createPhotoSessions} from './photo-sessions.mjs';
import {validatePhotoFile,getPhotoFormats} from './photo-validator.mjs';
import {ensureMobileCertificates,needsCertificateRenewal} from './mobile-tls.mjs';

const base='/api/mobile/v1', maxChunk=8*1024*1024, maxArchive=20*1024*1024*1024;
const bad=(message,code=400)=>Object.assign(new Error(message),{code});
const hash=(value)=>createHash('sha256').update(value).digest('hex');
const digestFile=async path=>{const h=createHash('sha256'); for await(const chunk of createReadStream(path))h.update(chunk); return h.digest('hex');};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedAssets=new Set(['/viewer.html','/touch-controls.mjs','/render-limits.mjs','/vendor/three/build/three.module.js','/vendor/three/build/three.core.js','/vendor/three/examples/jsm/postprocessing/Pass.js','/vendor/spark.module.js']);
const publicMobileAssets=new Map([['/mobile/','mobile/index.html'],['/mobile/app.js','mobile/app.js'],['/mobile/style.css','mobile/style.css'],['/mobile/state.mjs','mobile/state.mjs'],['/mobile/capture.mjs','mobile/capture.mjs'],['/mobile/capture-map.mjs','mobile/capture-map.mjs']]);
function privateAddress(address='') { const a=address.replace(/^::ffff:/,''); return a==='::1'||a==='127.0.0.1'||/^10\./.test(a)||/^192\.168\./.test(a)||/^172\.(1[6-9]|2\d|3[01])\./.test(a)||/^169\.254\./.test(a)||/^fe80:/i.test(a)||/^f[cd][0-9a-f]{2}:/i.test(a); }
async function validateArchive(archive,output) {
 return await new Promise((ok,fail)=>{let stdout='',stderr='';const child=spawn(TOOLS.python,[resolve(PY_DIR,'scan_archive.py'),'--archive',archive,'--output',output],{windowsHide:true});child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',fail);child.on('close',code=>{if(code!==0)return fail(bad('扫描包校验失败',400));try{ok(JSON.parse(stdout));}catch{fail(bad('校验器输出无效',500));}});});
}
export function createMobileGateway({stateRoot=resolve(PROJECTS_DIR,'.mobile'), projectStore=defaultProjects, jobStore=defaultJobs, importer=validateArchive, jobRuntime={},photoValidator=validatePhotoFile,photoCapabilities=getPhotoFormats,certificateProvider=ensureMobileCertificates,clock=Date.now,analysisRun}={}) {
 mkdirSync(stateRoot,{recursive:true}); const uploads=join(stateRoot,'uploads'); mkdirSync(uploads,{recursive:true});
 const statePath=join(stateRoot,'state.json');
 let state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{devices:{},scans:{}}; state.devices??={};state.scans??={};
 const save=(path,value)=>{try{mkdirSync(dirname(path),{recursive:true});const tmp=path+'.tmp';const fd=openSync(tmp,'w');try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);}catch(error){console.error('[mobile] 保存状态失败：',error.code??error.name);throw bad('无法保存手机连接状态。请检查电脑磁盘空间和写入权限，然后重试。',503);}};
 const persist=()=>save(statePath,state);
 if(state.pending){const pending=state.pending;try{const p=projectStore.read(pending.projectId);if(p.capture?.scanId===pending.scanId&&existsSync(p.capture.root)){state.scans[pending.scanId]={sha256:pending.sha256,projectId:pending.projectId};}else if(p.sourceDir===resolve(stateRoot, pending.stage, 'images')){projectStore.remove(pending.projectId);}}catch{}if(/^extract-[0-9a-f-]+$/.test(pending.stage??''))rmSync(resolve(stateRoot,pending.stage),{recursive:true,force:true});delete state.pending;persist();}
 let server=null,httpsServer=null,certificate=null,httpsError=null,httpsStarting=null,certificateTimer=null,httpStarting=null,lifecycle=0,code=null,expires=0;const handoffs=new Map(),attempts=new Map(),locks=new Set();
 const metadata=id=>join(uploads,`${id}.json`),data=id=>join(uploads,`${id}.part`);
 const readUpload=id=>{if(!uuid.test(id)||!existsSync(metadata(id)))throw bad('上传不存在',404);return JSON.parse(readFileSync(metadata(id),'utf8'));};
 const owned=(id,device)=>{const u=readUpload(id);if(u.deviceId!==device)throw bad('上传不存在',404);return u;};
 const addresses=()=>[...new Set(Object.values(networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal&&privateAddress(x.address)).map(x=>x.address))].sort();
 const publicCertificate=()=>certificate?{fingerprint:certificate.fingerprint,expiresAt:certificate.expiresAt,certUrl:'/mobile/ca.cer',profileUrl:'/mobile/ios.mobileconfig'}:null;
 const connection=()=>({httpsEnabled:!!httpsServer,httpsPort:httpsServer?.address()?.port??null,certificate:publicCertificate()});
 const status=()=>({enabled:!!server,port:server?.address()?.port??null,addresses:server||httpsServer?addresses():[],code:server&&clock()<expires?code:null,expiresAt:server&&clock()<expires?new Date(expires).toISOString():null,devices:Object.entries(state.devices).map(([deviceId,d])=>({deviceId,deviceName:d.deviceName})),...connection(),httpsError});
 const revoke=deviceId=>{delete state.devices[deviceId];persist();return photos.cancelDevice(deviceId);};
 async function exclusive(key,fn){if(locks.has(key))throw bad('操作正在进行',409);locks.add(key);try{return await fn();}finally{locks.delete(key);}}
 async function importArchive(archive,expectedId,archiveHash,checkAuthorization=()=>{}) {
  return exclusive('import',async()=>{
   const stage=join(stateRoot,`extract-${randomUUID()}`); let project;
   try {const result=await importer(archive,stage); if(!uuid.test(result.scanId)||!/^([a-f0-9]{64})$/.test(result.manifestSha256))throw bad('扫描包校验结果无效');
    if(expectedId&&result.scanId.toLowerCase()!==expectedId.toLowerCase())throw bad('扫描 ID 不匹配',409);
    checkAuthorization();
    const scanId=result.scanId.toLowerCase(), prior=state.scans[scanId];
    if(prior){if(prior.sha256!==archiveHash)throw bad('扫描 ID 已用于不同内容',409);return prior.projectId;}
    const imageDir=resolve(stage,'images');
    const projectId=`mobile-${randomUUID()}`;
    state.pending={projectId,scanId,sha256:archiveHash,stage:stage.slice(stateRoot.length+1)};persist();
    project=projectStore.create({name:`iPhone ${scanId.slice(0,8)}`,sourceDir:imageDir,trainingPreset:'standard',cameraModel:'PINHOLE'},{id:projectId});
    const capture=resolve(dirname(projectStore.projectPath(project.id)),'capture'); renameSync(stage,capture);
    projectStore.write({...project,inputKind:'arkit_scan',capture:{format:'gaussroom_scan_v1',scanId,root:capture,manifestSha256:result.manifestSha256},sourceDir:resolve(capture,'images')});
    state.scans[scanId]={sha256:archiveHash,projectId:project.id};delete state.pending;persist();return project.id;
   }catch(error){if(project){try{projectStore.remove(project.id);}catch{}for(const [key,value] of Object.entries(state.scans)){if(value.projectId===project.id)delete state.scans[key];}}delete state.pending;persist();throw error;}finally{rmSync(stage,{recursive:true,force:true});}
  });
 }
 async function offlineImport(path){if(typeof path!=='string'||!statSync(path).isFile())throw bad('扫描包路径无效');const copy=join(stateRoot,`offline-${randomUUID()}.zip`);try{copyFileSync(resolve(path),copy);return {projectId:await importArchive(copy,null,await digestFile(copy))};}finally{rmSync(copy,{force:true});}}
 const authorize=(req,allowCookie)=>{let token=/^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization??'')?.[1];if(!token&&allowCookie)token=/(?:^|;\s*)gr_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie??'')?.[1];if(!token)throw bad('需要配对',401);const digest=hash(token);const entry=Object.entries(state.devices).find(([,d])=>d.tokenHash===digest);if(!entry)throw bad('设备未授权',401);return entry[0];};
 const visibleProject=(id,device)=>{const entry=Object.values(state.scans).find(x=>x.projectId===id);if((!entry&&!photos.ownsProject(id))||!state.devices[device]?.projects?.includes(id))throw bad('项目不存在',404);return projectStore.read(id);};
 const grant=(device,id)=>{const d=state.devices[device];d.projects??=[];if(d.projects.includes(id))return;d.projects.push(id);persist();};
 const revokeProject=(device,id)=>{const d=state.devices[device];if(!d)return;d.projects=(d.projects??[]).filter(p=>p!==id);persist();};
 const photos=createPhotoSessions({root:join(stateRoot,'photos'),projectStore,jobStore,validatePhoto:photoValidator,getCapabilities:photoCapabilities,grantProject:grant,revokeProject,isDeviceActive:id=>!!state.devices[id],analysisRun});
 async function handle(req,res){try{
  if(!privateAddress(req.socket.remoteAddress))throw bad('仅允许私有网络',403);
  const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method,epoch=lifecycle;
  const checkConnection=()=>{if(epoch!==lifecycle||(!server&&!httpsServer))throw bad('手机连接已关闭',401);};
  if((method==='GET'||method==='HEAD')&&path==='/mobile'){res.writeHead(308,{Location:'/mobile/'});res.end();return;}
  if((method==='GET'||method==='HEAD')&&publicMobileAssets.has(path)){streamFile(res,resolve(PUBLIC_DIR,publicMobileAssets.get(path)),{head:method==='HEAD'});return;}
  if((method==='GET'||method==='HEAD')&&path==='/mobile/connection.json'){sendJson(res,200,connection());return;}
  if((method==='GET'||method==='HEAD')&&['/mobile/ca.cer','/mobile/ios.mobileconfig'].includes(path)){
    if(!certificate)throw bad('请先在电脑启用 HTTPS',404);const profile=path.endsWith('.mobileconfig'),bytes=profile?certificate.profile:certificate.caDer;
    res.writeHead(200,{'Content-Type':profile?'application/x-apple-aspen-config':'application/pkix-cert','Content-Length':bytes.length,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="${profile?'GaussRoom.mobileconfig':'GaussRoom-Root-CA.cer'}"`});res.end(method==='HEAD'?undefined:bytes);return;
  }
  if(path===base+'/https-handoff/redeem'&&method==='POST'){
    if(!req.socket.encrypted)throw bad('请使用 HTTPS 接收身份',403);
    const b=await readJson(req);checkConnection();if(!b||typeof b.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.ticket)||Object.keys(b).some(k=>k!=='ticket'))throw bad('交接码无效',403);
    const key=hash(b.ticket),entry=handoffs.get(key);handoffs.delete(key);if(!entry||clock()>=entry.expires)throw bad('交接码无效或已过期',403);
    if(!state.devices[entry.deviceId]||state.devices[entry.deviceId].tokenHash!==hash(entry.token))throw bad('设备未授权',401);
    if(entry.batchId)photos.ownsSession(entry.batchId,entry.deviceId);sendJson(res,200,{token:entry.token,deviceId:entry.deviceId,...(entry.batchId?{batchId:entry.batchId}:{})});return;
  }
  if(path===base+'/pair'&&method==='POST') {const ip=req.socket.remoteAddress,now=Date.now(),history=(attempts.get(ip)??[]).filter(t=>now-t<60000);if(history.length>=8)throw bad('配对次数过多',429);history.push(now);attempts.set(ip,history);const body=await readJson(req);if(!code||Date.now()>=expires||body.code!==code||typeof body.deviceName!=='string'||!body.deviceName.trim()||body.deviceName.length>100)throw bad('配对码无效或已过期',403);const token=randomBytes(32).toString('base64url'),deviceId=randomUUID();state.devices[deviceId]={deviceName:body.deviceName.trim(),tokenHash:hash(token),projects:[]};try{persist();}catch(error){delete state.devices[deviceId];throw error;}code=null;sendJson(res,200,{token,deviceId});return;}
  const readOnly=method==='GET'||method==='HEAD',device=authorize(req,readOnly);
  const reauthorize=()=>{checkConnection();if(authorize(req,readOnly)!==device)throw bad('设备未授权',401);};
  if(path===base+'/https-handoff'&&method==='POST'){
    const b=await readJson(req);reauthorize();if(!httpsServer||!certificate)throw bad('请先在电脑启用 HTTPS',409);
    if(!b||Object.keys(b).some(k=>k!=='batchId')||(b.batchId!==undefined&&(typeof b.batchId!=='string'||!uuid.test(b.batchId))))throw bad('交接参数无效');if(b.batchId)photos.ownsSession(b.batchId,device);
    let host;try{const target=new URL('http://'+req.headers.host);host=target.hostname;if(target.username||target.password||target.pathname!=='/'||(host!=='localhost'&&(isIP(host)!==4||!privateAddress(host))))throw Error();}catch{throw bad('请使用电脑局域网 IP 地址',400);}
    if(host!=='localhost'&&!certificate.addresses.includes(host))throw bad('电脑 IP 已变化。请在电脑重新启用 HTTPS',409);
    for(const [key,value]of handoffs)if(value.expires<=clock()||value.deviceId===device)handoffs.delete(key);
    const ticket=randomBytes(32).toString('base64url');handoffs.set(hash(ticket),{deviceId:device,token:/^Bearer (.+)$/.exec(req.headers.authorization)[1],batchId:b.batchId,expires:clock()+60000});
    sendJson(res,200,{url:`https://${host}:${httpsServer.address().port}/mobile/#handoff=${ticket}`,expiresIn:60});return;
  }
  if(readOnly&&path===base+'/capabilities'){const cap=await photos.capabilities();reauthorize();sendJson(res,200,{...cap,deviceId:device});return;}
  if(await photos.handle(req,res,path,device,reauthorize))return;
  if(path===base+'/session'&&method==='POST'){const token=/^Bearer (.+)$/.exec(req.headers.authorization)[1];res.setHeader('Set-Cookie',`gr_session=${token}; HttpOnly; SameSite=Strict; Path=/${req.socket.encrypted?'; Secure':''}`);sendJson(res,200,{ok:true});return;}
  if(readOnly&&allowedAssets.has(path)){streamFile(res,resolve(PUBLIC_DIR,'.'+path),{head:method==='HEAD'});return;}
  if(path===base+'/uploads'&&method==='POST'){const b=await readJson(req);if(!uuid.test(b.scanId)||!/^[a-f0-9]{64}$/.test(b.sha256)||!Number.isSafeInteger(b.bytes)||b.bytes<1||b.bytes>maxArchive)throw bad('上传参数无效');reauthorize();const scan=state.scans[b.scanId.toLowerCase()];if(scan&&scan.sha256!==b.sha256)throw bad('扫描 ID 已用于不同内容',409);const id=randomUUID(),u={id,deviceId:device,scanId:b.scanId.toLowerCase(),sha256:b.sha256,bytes:b.bytes,offset:0,...(scan&&state.devices[device]?.projects?.includes(scan.projectId)?{projectId:scan.projectId}:{})};save(metadata(id),u);sendJson(res,200,{id,offset:0,bytes:u.bytes,...(u.projectId?{projectId:u.projectId}:{})});return;}
  const match=path.match(/^\/api\/mobile\/v1\/uploads\/([^/]+)(\/commit)?$/);if(match){const id=match[1];if(method==='GET'&&!match[2]){const u=owned(id,device);sendJson(res,200,{id,offset:u.offset,bytes:u.bytes,...(u.projectId?{projectId:u.projectId}:{})});return;}
   if(method==='PUT'&&!match[2]){await exclusive(id,async()=>{const u=owned(id,device),r=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range']??'');if(!r)throw bad('Content-Range 无效');const [start,end,total]=r.slice(1).map(Number),length=end-start+1;if(!Number.isSafeInteger(length)||start!==u.offset||total!==u.bytes||length<1||length>maxChunk||end>=total)throw bad('上传偏移或长度无效',409);let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>length)throw bad('数据过长',413);chunks.push(chunk);}if(size!==length)throw bad('数据不完整');reauthorize();owned(id,device);const fd=openSync(data(id),existsSync(data(id))?'r+':'w+');try{ftruncateSync(fd,u.offset);const buffer=Buffer.concat(chunks);let written=0;while(written<length){const n=writeSync(fd,buffer,written,length-written,u.offset+written);if(n<=0)throw new Error('short write');written+=n;}fsyncSync(fd);}finally{closeSync(fd);}u.offset+=length;save(metadata(id),u);sendJson(res,200,{offset:u.offset});});return;}
   if(method==='POST'&&match[2]){await exclusive(id,async()=>{const u=owned(id,device);if(u.projectId){sendJson(res,200,{projectId:u.projectId});return;}if(u.offset!==u.bytes)throw bad('上传尚未完成',409);if(await digestFile(data(id))!==u.sha256)throw bad('扫描包哈希不匹配');const check=()=>{reauthorize();owned(id,device);};check();u.projectId=await importArchive(data(id),u.scanId,u.sha256,check);check();grant(device,u.projectId);save(metadata(id),u);sendJson(res,200,{projectId:u.projectId});});return;}}
  const p=path.match(/^\/api\/mobile\/v1\/projects\/([^/]+)(?:\/(run|scene\.ply))?$/);if(p){const project=visibleProject(p[1],device);if(readOnly&&p[2]==='scene.ply'){const scene=projectStore.latestExport(project);if(!scene)throw bad('场景不存在',404);streamFile(res,scene.path,{head:method==='HEAD'});return;}
   if(method==='POST'&&p[2]==='run'){const b=await readJson(req);if(!['fast','standard','full'].includes(b.trainingPreset)||Object.keys(b).some(k=>k!=='trainingPreset'))throw bad('训练档位无效');reauthorize();visibleProject(p[1],device);if(jobStore.anyRunning())throw bad('已有作业运行',409);const warning=jobStore.trainCleanWarning(project,b);if(warning)throw bad(warning.message,409);const job=jobStore.start(project.id,b,jobRuntime);sendJson(res,202,{jobId:job.id});return;}
   if(readOnly&&!p[2]){const s=projectStore.summarise(jobStore.liveProject(project.id)??project),out={};for(const k of ['id','name','state','progress','timing','quality'])out[k]=s[k];out.steps=(s.steps??[]).map(({id,name,status,progress,startedAt,endedAt,timing})=>({id,name,status,progress,startedAt,endedAt,timing}));out.lastError=s.lastError?'作业失败。请在工作台查看详情。':null;out.scene=null;if(s.scene){const pose=s.scene.home,params=new URLSearchParams({scene:`${base}/projects/${project.id}/scene.ply`});if(pose){params.set('home',[...pose.position,pose.yaw,pose.pitch].map(x=>x.toFixed(4)).join(','));if(pose.basis)params.set('basis',pose.basis.flat().map(x=>x.toFixed(5)).join(','));if(Number.isFinite(pose.extent)&&pose.extent>0)params.set('radius',pose.extent.toFixed(4));}out.scene={viewerUrl:`/viewer.html?${params}`};}sendJson(res,200,out);return;}}
  throw bad('接口不存在',404);
 }catch(e){if(!res.headersSent)sendJson(res,Number.isInteger(e.code)?e.code:500,{error:Number.isInteger(e.code)?e.message:'网关内部错误'});else res.destroy();}}
 async function enable({port=8124,host='0.0.0.0'}={}){if(server)return status();if(httpStarting)return httpStarting;const epoch=lifecycle;
  httpStarting=(async()=>{const candidate=createServer(handle);await new Promise((ok,fail)=>{candidate.once('error',fail);candidate.listen(port,host,ok);});if(epoch!==lifecycle){await new Promise(ok=>candidate.close(ok));throw bad('手机连接已关闭',409);}server=candidate;code=String(randomInt(100000,1000000));expires=clock()+5*60*1000;return status();})();try{return await httpStarting;}finally{httpStarting=null;}
 }
 async function enableHttps({port=8125,host='0.0.0.0'}={}){
  if(httpsStarting)return httpsStarting;const epoch=lifecycle;
  httpsStarting=(async()=>{try{if(!server)await enable();const next=await certificateProvider({root:join(stateRoot,'certificates'),addresses:addresses(),now:clock()});if(epoch!==lifecycle)throw bad('手机连接已关闭',409);
    if(httpsServer){httpsServer.setSecureContext({pfx:next.pfx,passphrase:next.passphrase});}else{const candidate=createSecureServer({pfx:next.pfx,passphrase:next.passphrase,minVersion:'TLSv1.2'},handle);await new Promise((ok,fail)=>{candidate.once('error',fail);candidate.listen(port,host,ok);});if(epoch!==lifecycle){candidate.closeAllConnections();await new Promise(ok=>candidate.close(ok));throw bad('手机连接已关闭',409);}httpsServer=candidate;}
    certificate=next;httpsError=null;
    if(!certificateTimer){certificateTimer=setInterval(()=>{if(httpsServer&&needsCertificateRenewal(certificate,{addresses:addresses(),now:clock()}))void enableHttps().catch(()=>{});},60000);certificateTimer.unref();}return status();
   }catch(e){httpsError=Number.isInteger(e.code)?e.message:'无法启用 HTTPS。请检查端口、电脑时间和证书目录权限。';throw bad(httpsError,Number.isInteger(e.code)?e.code:503);}})();try{return await httpsStarting;}finally{httpsStarting=null;}
 }
 async function disable(){lifecycle++;clearInterval(certificateTimer);certificateTimer=null;code=null;expires=0;handoffs.clear();const old=[server,httpsServer].filter(Boolean);server=null;httpsServer=null;
  const closing=old.map(s=>{s.closeAllConnections();return new Promise(ok=>s.close(ok));});await Promise.allSettled([httpStarting,httpsStarting].filter(Boolean));await photos.close();await Promise.all(closing);
 }
 return {enable,enableHttps,disable,status,revoke,offlineImport};
}
