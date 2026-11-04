// Photo-session analysis has its own immutable inputs and never creates a project.
import {spawn} from 'node:child_process';
import {copyFile,readFile} from 'node:fs/promises';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {TOOLS,PY_DIR} from './paths.mjs';
import {acquireCompute,computeOwner} from './compute-slot.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=()=>Object.assign(new Error('批次无效'),{code:400});
function atomic(path,value){const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(value));renameSync(tmp,path);}
function killTree(child){return new Promise(done=>{
  if(!child.pid||child.exitCode!==null){done();return;}
  if(process.platform==='win32'){
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('error',()=>{child.kill('SIGKILL');done();});killer.once('close',done);
  }else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}done();}
});}
async function execute({requestPath,outputPath,signal}){
  await new Promise((done,reject)=>{
    const child=spawn(TOOLS.python,['-X','utf8','-B',join(PY_DIR,'capture_analysis.py'),'--request',requestPath,'--output',outputPath,'--parent-pid',String(process.pid)],{windowsHide:true,detached:process.platform!=='win32',stdio:'ignore'});
    let stopping=Promise.resolve();
    const abort=()=>{stopping=killTree(child);};signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    child.once('error',reject);
    child.once('close',async code=>{signal.removeEventListener('abort',abort);await stopping;if(code===0&&!signal.aborted)done();else reject(new Error('analysis process stopped'));});
  });
  return JSON.parse(await readFile(outputPath,'utf8'));
}

export function createCaptureAnalysis({root,busy=()=>false,run=execute,clock=Date.now}){
  root=resolve(root);mkdirSync(root,{recursive:true});
  const entries=new Map();let timer=null;
  function folder(id){if(!uuid.test(id))throw bad();const batch=resolve(root,id);if(dirname(batch)!==root)throw bad();
    // Refuse junctions and symlinks before any recursive removal or write.
    for(const path of [batch,join(batch,'analysis')])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw bad();
    if(existsSync(batch)&&dirname(realpathSync(batch))!==realpathSync(root))throw bad();
    return join(batch,'analysis');}
  function get(id){const dir=folder(id);if(entries.has(id))return entries.get(id);
    const initial={status:'idle',revision:0,lastMapRevision:0,processedCount:0,requestedCount:0,updatedAt:clock(),error:null,processedFileIds:[],lastStart:null};let saved;
    try{saved=JSON.parse(readFileSync(join(dir,'status.json'),'utf8'));}catch{}
    if(!existsSync(dirname(dir)))throw Object.assign(new Error('批次不存在'),{code:404});
    const e={id,dir,state:{...initial,...saved},pending:null,job:null,generation:0,cancelling:false};entries.set(id,e);
    if(['running','waiting'].includes(e.state.status)){e.state.status='failed';e.state.error='位置分析已中断，请重试。';save(e);}
    return e;}
  function save(e){folder(e.id);if(!existsSync(dirname(e.dir)))return;mkdirSync(e.dir,{recursive:true});e.state.updatedAt=clock();atomic(join(e.dir,'status.json'),e.state);}
  function dto(e){return Object.fromEntries(['status','revision','lastMapRevision','processedCount','requestedCount','updatedAt','error'].map(key=>[key,e.state[key]]));}
  function selected(files){const ids=new Set(),hashes=new Set();return files.filter(f=>{
    if(!uuid.test(f.id)||typeof f.path!=='string'||!/^[0-9a-f]{64}$/i.test(f.sha256??'')||!Number.isFinite(f.width)||f.width<=0||!Number.isFinite(f.height)||f.height<=0||!['.jpg','.jpeg','.png','.heic','.heif'].includes(extname(f.path).toLowerCase())||ids.has(f.id)||hashes.has(f.sha256))return false;
    ids.add(f.id);hashes.add(f.sha256);return true;}).map(f=>({...f}));}
  function eligible(e){const p=e.pending;if(!p)return false;const done=new Set(e.state.processedFileIds),count=p.files.filter(f=>!done.has(f.id)).length;
    return done.size===0?p.files.length>=20:count>0&&(p.force||count>=12);}
  function poll(){if(!timer){timer=setInterval(pump,200);timer.unref();}}
  function pump(){
    for(const e of entries.values()){
      if(e.cancelling||e.job||!eligible(e))continue;
      if((e.state.lastStart!==null&&clock()-e.state.lastStart<15000)||busy()||computeOwner()){if(e.state.status!=='waiting'){e.state.status='waiting';try{save(e);}catch{e.state.status='failed';e.pending=null;e.state.error='无法保存位置分析状态。';}}continue;}
      const release=acquireCompute({kind:'capture_analysis',id:e.id});if(!release)continue;
      const p=e.pending;e.pending=null;
      const controller=new AbortController(),generation=e.generation;
      const job={controller,done:null,timedOut:false};e.job=job;e.state.status='running';e.state.lastStart=clock();e.state.error=null;
      try{save(e);}catch{e.job=null;release();e.state.status='failed';e.state.error='无法保存位置分析状态。';continue;}
      const timeout=setTimeout(()=>{job.timedOut=true;controller.abort();},120000);timeout.unref();
      job.done=(async()=>{
        const check=()=>{if(controller.signal.aborted||generation!==e.generation)throw new Error('cancelled');p.check();folder(e.id);};
        try{
          check();const inputs=join(e.dir,'inputs');mkdirSync(inputs,{recursive:true});
          const files=[];
          for(const f of p.files){
            check();const source=realpathSync(f.path),batch=realpathSync(dirname(e.dir));if(!source.startsWith(batch+sep)||source.startsWith(realpathSync(e.dir)+sep))throw bad();
            const name=f.id+extname(f.path).toLowerCase(),destination=join(inputs,name);
            if(!existsSync(destination)){await copyFile(source,destination);check();}
            const bytes=await readFile(destination);check();if(createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw new Error('input changed');
            files.push({...f,name,path:destination});
          }
          const request={files,workDir:join(e.dir,'work'),colmap:existsSync(TOOLS.colmapGpu)?TOOLS.colmapGpu:TOOLS.colmapCpu,gpu:existsSync(TOOLS.colmapGpu)?1:0,ffmpeg:TOOLS.ffmpeg||null};
          check();const requestPath=join(e.dir,'request.json'),outputPath=join(e.dir,'result.json');atomic(requestPath,request);
          const raw=await run({requestPath,outputPath,request,signal:controller.signal});check();
          const result=cleanMap(raw,files,p.revision,clock());check();atomic(join(e.dir,'map.json'),result);
          e.state.status='ready';e.state.lastMapRevision=p.revision;e.state.processedFileIds=files.map(f=>f.id);e.state.processedCount=files.length;e.state.error=null;
        }catch{const cancelled=generation!==e.generation||(controller.signal.aborted&&!job.timedOut);e.state.status=cancelled?'cancelled':'failed';e.state.error=cancelled?null:job.timedOut?'位置分析超时（120 秒），请稍后重试。':'位置分析失败，请重试。';}
        finally{clearTimeout(timeout);e.job=null;release();try{save(e);if(eligible(e)&&!e.cancelling){e.state.status='waiting';save(e);}}catch{e.state.status='failed';e.pending=null;}pump();}
      })();
      // One process owns the global compute slot. Other batches stay queued.
      break;
    }
  }
  function request({id,deviceId,files,check,force=false}){if(typeof check!=='function'||!Array.isArray(files))throw bad();check();const e=get(id);if(e.cancelling)throw Object.assign(new Error('位置分析正在停止'),{code:409});const picked=selected(files);
    e.state.revision++;e.state.requestedCount=picked.length;e.pending={deviceId,files:picked,check,force:!!force,revision:e.state.revision};
    if(eligible(e)&&!e.job)e.state.status='waiting';save(e);poll();pump();return dto(e);}
  function status(id){return dto(get(id));}
  function map(id){const e=get(id);try{return JSON.parse(readFileSync(join(e.dir,'map.json'),'utf8'));}catch{return null;}}
  async function cancel(id,{invalidate=false}={}){const e=get(id);if(e.cancelling){await e.cancelled;return dto(e);}e.cancelling=true;e.generation++;e.pending=null;e.job?.controller.abort();
    e.cancelled=(async()=>{await e.job?.done;
    e.state.status='cancelled';e.state.error=null;
    if(invalidate){const dir=folder(id);e.state.processedFileIds=[];e.state.processedCount=0;e.state.lastMapRevision=0;e.state.lastStart=null;e.state.updatedAt=clock();rmSync(dir,{recursive:true,force:true});}
    else save(e);
    return dto(e);})();try{return await e.cancelled;}finally{e.cancelling=false;}}
  async function close(){if(timer){clearInterval(timer);timer=null;}await Promise.all([...entries.keys()].map(id=>cancel(id)));}
  function forget(id){const e=entries.get(id);if(e?.job)throw Object.assign(new Error('位置分析尚未退出'),{code:409});entries.delete(id);}
  return {request,status,map,cancel,close,forget};
}

function cleanMap(raw,files,revision,updatedAt){
  const ids=new Set(files.map(f=>f.id)),numeric=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(Number.isFinite);
  if(!raw||!Array.isArray(raw.cameras)||!Array.isArray(raw.points))throw new Error('invalid analysis output');
  const cameras=raw.cameras.filter(c=>ids.has(c.fileId)&&numeric(c.cameraToWorld,16)&&numeric(c.intrinsics,4)&&Number.isFinite(c.width)&&c.width>0&&Number.isFinite(c.height)&&c.height>0).map(c=>({fileId:c.fileId,cameraToWorld:c.cameraToWorld,intrinsics:c.intrinsics,width:c.width,height:c.height}));
  const localized=new Set(cameras.map(c=>c.fileId));
  return {revision,updatedAt,scale:'unmeasured',coordinateSystem:{up:'y',cameraForward:'-z',matrixOrder:'column-major',units:'arbitrary'},cameras,
    points:raw.points.filter(p=>numeric(p.position,3)&&numeric(p.color,3)).slice(0,10000).map(p=>({position:p.position,color:p.color})),
    unlocalized:files.filter(f=>!localized.has(f.id)).map(f=>f.id),processedFileIds:files.map(f=>f.id),
    suspectedDuplicates:(raw.suspectedDuplicates??[]).filter(d=>ids.has(d.fileId)&&ids.has(d.similarTo)).map(d=>({fileId:d.fileId,similarTo:d.similarTo}))};
}
