import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileGateway } from './lib/mobile.mjs';

test('gateway starts disabled, pairs and revokes a device', async () => {
 const root=mkdtempSync(join(tmpdir(),'mobile-test-'));
 const gateway=createMobileGateway({stateRoot:root});
 try {
  assert.equal(gateway.status().enabled,false);
  const info=await gateway.enable({port:0,host:'127.0.0.1'});
  const base=`http://127.0.0.1:${info.port}/api/mobile/v1`;
  let response=await fetch(`${base}/uploads`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,401);
  response=await fetch(`${base}/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'test'})});
  const device=await response.json(); assert.equal(response.status,200); assert.ok(device.token);
  gateway.revoke(device.deviceId);
  response=await fetch(`${base}/uploads/anything`,{headers:{authorization:`Bearer ${device.token}`}});
  assert.equal(response.status,401);
 } finally { await gateway.disable(); rmSync(root,{recursive:true,force:true}); }
});

test('startup reads existing photo grants without rewriting unchanged device state',async t=>{
 const {mkdirSync,writeFileSync}=await import('node:fs');const {randomUUID}=await import('node:crypto');
 const root=mkdtempSync(join(tmpdir(),'mobile-grant-read-')),deviceId=randomUUID(),sessionId=randomUUID(),projectId=`mobile-${randomUUID()}`;
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'state.json'),JSON.stringify({devices:{[deviceId]:{deviceName:'existing',tokenHash:'a'.repeat(64),projects:[projectId]}},scans:{}}));
 const folder=join(root,'photos',sessionId);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'session.json'),JSON.stringify({id:sessionId,deviceId,projectId,status:'committed',files:[]}));
 mkdirSync(join(root,'state.json.tmp')); // Any unnecessary persist would fail.
 const gateway=createMobileGateway({stateRoot:root});assert.equal(gateway.status().devices.length,1);await gateway.disable();
});

test('pairing restores removed gateway directories and both upload entry points remain usable', async t => {
 const {renameSync,readFileSync}=await import('node:fs');const {resolve,sep}=await import('node:path');const {randomUUID}=await import('node:crypto');
 const root=mkdtempSync(join(tmpdir(),'mobile-missing-state-')),stateRoot=join(root,'state'),backup=join(root,'saved-state');
 const gateway=createMobileGateway({stateRoot,photoCapabilities:async()=>({photoFormats:['.jpg','.jpeg','.png']})});
 t.after(async()=>{await gateway.disable();rmSync(root,{recursive:true,force:true});});
 const info=await gateway.enable({port:0,host:'127.0.0.1'}),base=`http://127.0.0.1:${info.port}/api/mobile/v1`;
 assert.ok(resolve(stateRoot).startsWith(resolve(root)+sep));assert.ok(resolve(backup).startsWith(resolve(root)+sep));renameSync(stateRoot,backup);
 let r=await fetch(base+'/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'手机'})});
 assert.equal(r.status,200);const device=await r.json(),headers={authorization:`Bearer ${device.token}`,'content-type':'application/json'};
 assert.equal(JSON.parse(readFileSync(join(stateRoot,'state.json'),'utf8')).devices[device.deviceId].deviceName,'手机');
 r=await fetch(base+'/photo-sessions',{method:'POST',headers,body:JSON.stringify({name:'restored'})});assert.equal(r.status,200);assert.equal((await r.json()).status,'open');
 r=await fetch(base+'/uploads',{method:'POST',headers,body:JSON.stringify({scanId:randomUUID(),sha256:'a'.repeat(64),bytes:123})});assert.equal(r.status,200);assert.equal((await r.json()).offset,0);
});

test('failed pairing persistence keeps the code retryable and leaves no unsaved authorized device',async t=>{
 const {mkdirSync,rmdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'mobile-write-failure-')),blocked=join(root,'state.json.tmp');
 const gateway=createMobileGateway({stateRoot:root});t.after(async()=>{await gateway.disable();rmSync(root,{recursive:true,force:true});});
 const info=await gateway.enable({port:0,host:'127.0.0.1'}),url=`http://127.0.0.1:${info.port}/api/mobile/v1/pair`,body=JSON.stringify({code:info.code,deviceName:'retry'});
 mkdirSync(blocked);let r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(r.status,503);const error=await r.json();assert.match(error.error,/保存/);assert.equal(error.error.includes(root),false);
 assert.deepEqual(gateway.status().devices,[]);assert.equal(gateway.status().code,info.code);
 rmdirSync(blocked);r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(r.status,200);assert.ok((await r.json()).token);assert.equal(gateway.status().devices.length,1);
});

test('upload persists its offset, enforces ownership and commits once', async () => {
 const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs'); const {createHash,randomUUID}=await import('node:crypto');
 const root=mkdtempSync(join(tmpdir(),'mobile-test-')),projectRoot=join(root,'projects');mkdirSync(projectRoot);
 const records=new Map();let imports=0;
 const store={projectPath:id=>join(projectRoot,id,'project.json'),create:({name,sourceDir},{id})=>{mkdirSync(join(projectRoot,id));const p={id,name,sourceDir};records.set(id,p);return p;},write:p=>records.set(p.id,p),read:id=>records.get(id),remove:id=>records.delete(id),summarise:p=>({...p,steps:[],scene:null}),latestExport:()=>null};
 const scanId=randomUUID(),content=Buffer.from('test archive'),sha256=createHash('sha256').update(content).digest('hex');
 const importer=async (archive,output)=>{imports++;if(readFileSync(archive).toString()!=='test archive')throw Object.assign(new Error('bad archive'),{code:400});mkdirSync(join(output,'images'),{recursive:true});writeFileSync(join(output,'images','a.jpg'),'a');return {scanId,manifestSha256:'a'.repeat(64)};};
 let gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store,importer});let base,token,upload;
 const request=async(path,options={})=>fetch(base+path,{...options,headers:{...(token?{authorization:`Bearer ${token}`} :{}),...options.headers}});
 try {
  let info=await gateway.enable({port:0,host:'127.0.0.1'});base=`http://127.0.0.1:${info.port}/api/mobile/v1`;
  let r=await request('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'A'})});token=(await r.json()).token;
  r=await request('/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scanId,sha256,bytes:content.length})});upload=await r.json();
  const {request:httpRequest}=await import('node:http');
  await new Promise(resolve=>{const req=httpRequest(`${base}/uploads/${upload.id}`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-range':`bytes 0-3/${content.length}`,'content-length':'4'}});req.on('error',()=>resolve());req.write(content.subarray(0,2));setTimeout(()=>req.destroy(),20);});
  r=await request(`/uploads/${upload.id}`);assert.equal((await r.json()).offset,0);
  r=await request(`/uploads/${upload.id}`,{method:'PUT',headers:{'content-range':`bytes 0-3/${content.length}`},body:content.subarray(0,4)});{const result=await r.json();assert.equal(result.offset,4,JSON.stringify(result));}
  await gateway.disable();gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store,importer});info=await gateway.enable({port:0,host:'127.0.0.1'});base=`http://127.0.0.1:${info.port}/api/mobile/v1`;
  r=await request(`/uploads/${upload.id}`);{const result=await r.json();assert.equal(result.offset,4,JSON.stringify(result));}
  const firstToken=token;token=null;r=await request('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'B'})});token=(await r.json()).token;r=await request(`/uploads/${upload.id}`);assert.equal(r.status,404);token=firstToken;
  r=await request(`/uploads/${upload.id}`,{method:'PUT',headers:{'content-range':`bytes 0-3/${content.length}`},body:content.subarray(0,4)});assert.equal(r.status,409);
  r=await request(`/uploads/${upload.id}`,{method:'PUT',headers:{'content-range':`bytes 4-${content.length-1}/${content.length}`},body:content.subarray(4)});assert.equal((await r.json()).offset,content.length);
  r=await request(`/uploads/${upload.id}/commit`,{method:'POST'});const committed=await r.json();assert.equal(r.status,200);assert.equal(imports,1);assert.match(store.read(committed.projectId).sourceDir,/capture[\\/]images$/);
  r=await request(`/uploads/${upload.id}/commit`,{method:'POST'});assert.deepEqual(await r.json(),committed);assert.equal(imports,1);
  r=await request('/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scanId,sha256:'b'.repeat(64),bytes:content.length})});assert.equal(r.status,409);
  r=await request('/session',{method:'POST'});const cookie=r.headers.get('set-cookie').split(';')[0];token=null;r=await fetch(`http://127.0.0.1:${info.port}/viewer.html`,{headers:{cookie}});assert.equal(r.status,200);r=await fetch(`http://127.0.0.1:${info.port}/app.js`,{headers:{cookie}});assert.equal(r.status,404);r=await request(`/projects/${committed.projectId}/run`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"trainingPreset":"standard"}'});assert.equal(r.status,401);
 } finally {await gateway.disable();rmSync(root,{recursive:true,force:true});}
});


test('offline import uses the real Python validator and rejects corrupt packages', async () => {
 const {mkdirSync,writeFileSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');const {TOOLS}=await import('./lib/paths.mjs');
 const root=mkdtempSync(join(tmpdir(),'mobile-real-')),projectRoot=join(root,'projects');mkdirSync(projectRoot);const records=new Map();
 const store={projectPath:id=>join(projectRoot,id,'project.json'),create:({name,sourceDir},{id})=>{mkdirSync(join(projectRoot,id));const p={id,name,sourceDir};records.set(id,p);return p;},write:p=>records.set(p.id,p),read:id=>records.get(id),remove:id=>records.delete(id)};
 const fixture=spawnSync(TOOLS.python,['-c',`import sys,json,hashlib,copy,io
from PIL import Image
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from test_scan_arkit import ScanTests
def add_frame(m,files,frame):
 f=copy.deepcopy(frame);f['id']='f2';f['timestamp']=2.0
 for kind in ('image','depth','confidence'):
  old=f[kind]['path']; new=old.replace('/a.', '/b.'); files[new]=files[old];f[kind]['path']=new
 image=io.BytesIO(); Image.new('RGB',(4,3),(255,0,0)).save(image,format='JPEG'); files[f['image']['path']]=image.getvalue()
 files['frames.json']=json.dumps({'frames':[frame,f]}).encode()
 m['files']=[{'path':k,'bytes':len(v),'sha256':hashlib.sha256(v).hexdigest()} for k,v in files.items()]
ScanTests().make_archive(Path(sys.argv[2]),add_frame)`,join(process.cwd(),'tools/workbench/py'),root],{encoding:'utf8'});
 assert.equal(fixture.status,0,fixture.stderr);
 const gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store});
 try {const imported=await gateway.offlineImport(join(root,'scan.zip'));assert.equal(records.size,1);const p=records.get(imported.projectId);assert.equal(p.inputKind,'arkit_scan');assert.match(p.sourceDir,/capture[\\/]images$/);assert.deepEqual(await gateway.offlineImport(join(root,'scan.zip')),imported);writeFileSync(join(root,'bad.zip'),'broken');await assert.rejects(gateway.offlineImport(join(root,'bad.zip')),/扫描包校验失败/);assert.equal(records.size,1);}finally{await gateway.disable();rmSync(root,{recursive:true,force:true});}
});

test('pair attempts are limited and import recovery keeps a completed capture', async () => {
 const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const {randomUUID}=await import('node:crypto');
 const root=mkdtempSync(join(tmpdir(),'mobile-recover-')),capture=join(root,'p','capture'),scanId=randomUUID();mkdirSync(capture,{recursive:true});
 const project={id:'p',capture:{scanId,root:capture}},store={read:()=>project,remove:()=>assert.fail('completed project must not be deleted')};
 const saved={devices:{},scans:{},pending:{projectId:'p',scanId,sha256:'a'.repeat(64)}};writeFileSync(join(root,'state.json'),JSON.stringify(saved));
 const gateway=createMobileGateway({stateRoot:root,projectStore:store});
 try{const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));assert.equal(state.scans[scanId].projectId,'p');assert.equal(state.pending,undefined);
 const info=await gateway.enable({port:0,host:'127.0.0.1'}),base=`http://127.0.0.1:${info.port}/api/mobile/v1`;for(let i=0;i<8;i++){const r=await fetch(base+'/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'wrong',deviceName:'x'})});assert.equal(r.status,403);}const r=await fetch(base+'/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'x'})});assert.equal(r.status,429);
 }finally{await gateway.disable();rmSync(root,{recursive:true,force:true});}
});

test('recovery removes only an unfinished import with its journaled source', async () => {
 const {mkdirSync,writeFileSync,existsSync,readFileSync}=await import('node:fs');const {randomUUID}=await import('node:crypto');
 const root=mkdtempSync(join(tmpdir(),'mobile-kill-')),scanId=randomUUID(),stage=`extract-${randomUUID()}`,id=`mobile-${randomUUID()}`;mkdirSync(join(root,stage,'images'),{recursive:true});
 let project={id,sourceDir:join(root,stage,'images')},removed=0;const store={read:()=>project,remove:()=>{removed++;project=null;}};
 writeFileSync(join(root,'state.json'),JSON.stringify({devices:{},scans:{},pending:{projectId:id,scanId,sha256:'a'.repeat(64),stage}}));
 try {const gateway=createMobileGateway({stateRoot:root,projectStore:store});assert.equal(removed,1);assert.equal(existsSync(join(root,stage)),false);assert.equal(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).pending,undefined);await gateway.disable();
  const unrelated={id,sourceDir:join(root,'other')};project=unrelated;writeFileSync(join(root,'state.json'),JSON.stringify({devices:{},scans:{},pending:{projectId:id,scanId,sha256:'a'.repeat(64),stage}}));createMobileGateway({stateRoot:root,projectStore:store});assert.equal(removed,1);assert.equal(project,unrelated);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('forced process termination during project creation recovers without an orphan', async () => {
 const {writeFileSync,readFileSync,existsSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');const {pathToFileURL}=await import('node:url');
 const root=mkdtempSync(join(tmpdir(),'mobile-killed-')),archive=join(root,'archive.zip');writeFileSync(archive,'archive');
 const script=`import {createMobileGateway} from process.argv[2];
 import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
 const root=process.argv[1];const importer=async (a,out)=>{mkdirSync(join(out,'images'),{recursive:true});return {scanId:'b13fe83a-a22f-48b9-bc99-c01bd133c941',manifestSha256:'a'.repeat(64)}};
 const store={create:(body,{id})=>{writeFileSync(join(root,'project.json'),JSON.stringify({id,sourceDir:body.sourceDir}));process.kill(process.pid,'SIGKILL');}};
 await createMobileGateway({stateRoot:join(root,'state'),projectStore:store,importer}).offlineImport(join(root,'archive.zip'));`;
 // Dynamic import is used so the module path remains an argument, not source text.
 const childScript=script.replace("import {createMobileGateway} from process.argv[2];", "const {createMobileGateway}=await import(process.argv[2]);");
 try {const child=spawnSync(process.execPath,['--input-type=module','-e',childScript,root,pathToFileURL(join(process.cwd(),'tools/workbench/lib/mobile.mjs')).href],{encoding:'utf8'});assert.notEqual(child.status,0);assert.ok(existsSync(join(root,'project.json')),child.stderr);
  const store={read:()=>JSON.parse(readFileSync(join(root,'project.json'),'utf8')),remove:()=>rmSync(join(root,'project.json'))};createMobileGateway({stateRoot:join(root,'state'),projectStore:store});assert.equal(existsSync(join(root,'project.json')),false);assert.equal(JSON.parse(readFileSync(join(root,'state','state.json'),'utf8')).pending,undefined);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('paired cookie can load every local viewer module', async () => {
 const root=mkdtempSync(join(tmpdir(),'mobile-viewer-')),gateway=createMobileGateway({stateRoot:root});
 try {const info=await gateway.enable({port:0,host:'127.0.0.1'}),origin=`http://127.0.0.1:${info.port}`,base=origin+'/api/mobile/v1';
  let r=await fetch(origin+'/touch-controls.mjs');assert.equal(r.status,401);
  r=await fetch(base+'/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'viewer'})});const {token}=await r.json();
  r=await fetch(base+'/session',{method:'POST',headers:{authorization:`Bearer ${token}`}});const cookie=r.headers.get('set-cookie').split(';')[0];
  for(const path of ['/viewer.html','/touch-controls.mjs','/render-limits.mjs','/vendor/three/build/three.module.js','/vendor/three/build/three.core.js','/vendor/three/examples/jsm/postprocessing/Pass.js','/vendor/spark.module.js']) {r=await fetch(origin+path,{headers:{cookie}});await r.arrayBuffer();assert.equal(r.status,200,path);}
 } finally {await gateway.disable();rmSync(root,{recursive:true,force:true});}
});

test('pair code must still be valid when the request body finishes', async () => {
 const {request}=await import('node:http');const root=mkdtempSync(join(tmpdir(),'mobile-expiry-')),gateway=createMobileGateway({stateRoot:root}),realNow=Date.now;
 try {const info=await gateway.enable({port:0,host:'127.0.0.1'});let now=realNow(),signal;const started=new Promise(resolve=>signal=resolve);Date.now=()=>{if(new Error().stack.includes('lib/mobile.mjs'))signal();return now;};
  const response=new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${info.port}/api/mobile/v1/pair`,{method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.flushHeaders();started.then(()=>{now+=301000;req.end(JSON.stringify({code:info.code,deviceName:'late'}));});});
  assert.equal(await response,403);assert.equal(gateway.status().devices.length,0);
 } finally {Date.now=realNow;await gateway.disable();rmSync(root,{recursive:true,force:true});}
});

test('revocation during delayed requests prevents mutations', async () => {
 const {mkdirSync,readFileSync,existsSync}=await import('node:fs');
 const {createHash,randomUUID}=await import('node:crypto'); const {request}=await import('node:http');
 const root=mkdtempSync(join(tmpdir(),'mobile-revoke-')),records=new Map();let starts=0,release,entered;
 const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r),scanId=randomUUID(),content=Buffer.from('archive'),sha256=createHash('sha256').update(content).digest('hex');
 const store={projectPath:id=>join(root,id,'project.json'),create:({name,sourceDir},{id})=>{mkdirSync(join(root,id));const p={id,name,sourceDir};records.set(id,p);return p;},write:p=>records.set(p.id,p),read:id=>records.get(id),remove:id=>records.delete(id)};
 const importer=async (archive,out)=>{mkdirSync(join(out,'images'),{recursive:true});entered();await gate;return {scanId,manifestSha256:'a'.repeat(64)};};
 const jobs={anyRunning:()=>false,trainCleanWarning:()=>null,start:()=>{starts++;return {id:'job'};}};
 const gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store,jobStore:jobs,importer});
 const info=await gateway.enable({port:0,host:'127.0.0.1'}),base=`http://127.0.0.1:${info.port}/api/mobile/v1`;
 const pair=async()=>{await gateway.disable();const i=await gateway.enable({port:info.port,host:'127.0.0.1'});const r=await fetch(base+'/pair',{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({code:i.code,deviceName:'test'})});return r.json();};
 const call=(device,path,options={})=>fetch(base+path,{...options,headers:{authorization:`Bearer ${device.token}`,connection:'close',...options.headers}});
 const delayed=(device,path,method,headers,body)=>new Promise((resolve,reject)=>{const req=request(base+path,{method,headers:{authorization:`Bearer ${device.token}`,...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.flushHeaders();setTimeout(()=>{gateway.revoke(device.deviceId);req.end(body);},80);});
 try {
  let device=await pair();let r=await call(device,'/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scanId,sha256,bytes:content.length})});let upload=await r.json();
  assert.equal(await delayed(device,`/uploads/${upload.id}`,'PUT',{'content-range':`bytes 0-${content.length-1}/${content.length}`,'content-length':String(content.length)},content),401);
  assert.equal(JSON.parse(readFileSync(join(root,'state','uploads',upload.id+'.json'))).offset,0);assert.equal(existsSync(join(root,'state','uploads',upload.id+'.part')),false);
  device=await pair();r=await call(device,'/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scanId,sha256,bytes:content.length})});upload=await r.json();
  await call(device,`/uploads/${upload.id}`,{method:'PUT',headers:{'content-range':`bytes 0-${content.length-1}/${content.length}`},body:content});
  const pending=call(device,`/uploads/${upload.id}/commit`,{method:'POST'});await waiting;gateway.revoke(device.deviceId);release();r=await pending;assert.equal(r.status,401);assert.equal(records.size,0);
  device=await pair();const imported=await gateway.offlineImport(join(root,'state','uploads',upload.id+'.part'));
  r=await call(device,'/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scanId,sha256,bytes:content.length})});upload=await r.json();
  await call(device,`/uploads/${upload.id}`,{method:'PUT',headers:{'content-range':`bytes 0-${content.length-1}/${content.length}`},body:content});
  r=await call(device,`/uploads/${upload.id}/commit`,{method:'POST'});assert.equal(r.status,200);
  assert.equal(await delayed(device,`/projects/${imported.projectId}/run`,'POST',{'content-type':'application/json'},'{"trainingPreset":"standard"}'),401);assert.equal(starts,0);
 } finally {release();await gateway.disable();rmSync(root,{recursive:true,force:true});}
});
