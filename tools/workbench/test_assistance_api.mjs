import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import * as serverModule from './server.mjs';
import * as projects from './lib/projects.mjs';
import {dirs,buildSteps,geometrySignature} from './lib/pipeline.mjs';
import {atomicJson,newRecord,updateAssistance,readAssistance} from './lib/assistance.mjs';
import {createAttempt} from './lib/attempts.mjs';

async function fixture(t,{contextError=null}={}){
 assert.equal(typeof serverModule.createWorkbenchServer,'function','server must support isolated random-port tests');
 const id=`test-assist-api-${randomBytes(5).toString('hex')}`;
 const p={id,name:'API fixture',state:'needs_input',selectedModel:'0',trainingPreset:'full',steps:buildSteps().map(s=>({...s,status:'pending'}))};
 const d=dirs(p);mkdirSync(d.images,{recursive:true});mkdirSync(d.summary,{recursive:true});mkdirSync(resolve(d.sparse,'0'),{recursive:true});
 for(const name of ['images.bin','cameras.bin','points3D.bin'])writeFileSync(resolve(d.sparse,'0',name),'fixture');
 const photos=[{photoId:'p1',name:'one.png',width:100,height:80},{photoId:'p2',name:'two.png',width:100,height:80}];
 atomicJson(d.manifest,{records:[],retained_count:2});projects.write(p);
 const inputs={photosSha256:'photos',matchingContentSha256:'matches',geometrySha256:'geometry',configSha256:'config'};
 const signature=geometrySignature(resolve(d.sparse,'0'));
 const gate={verdict:'pass',geometryValidationVersion:1,geometryConnected:true,selectedModel:'0',models:[{name:'0',geometrySignature:signature,geometryComponentSizes:[2],geometryComponents:[{index:0,registered:2,images:['one.png','two.png']}],unregistered:[]}]};
 atomicJson(resolve(d.summary,'gate.json'),gate);
 updateAssistance(p,()=>({...newRecord({catalog:photos,inputs,regions:[{id:'0:0',photoIds:['p1','p2']}]}),sourceAttemptId:null}));
 let hashes=0;
 const server=serverModule.createWorkbenchServer({getContext:async(_p,{fresh=false}={})=>{if(fresh){hashes++;if(contextError)throw contextError;}return {catalog:photos,inputs,gate,sourceAttemptId:null};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/projects/${id}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(d.root,{recursive:true,force:true});});
 const call=(path='',body,method='GET')=>fetch(base+path,{method,signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
 return {p,d,photos,signature,call,hashes:()=>hashes};
}
test('PUT validates the revision, client paths and photo coordinates',async t=>{
 const {call}=await fixture(t);
 assert.equal((await call('/assistance',{expectedRevision:0,patch:{onlyExistingPhotos:true}},'PUT')).status,200);
 assert.equal((await call('/assistance',{expectedRevision:0,patch:{}},'PUT')).status,409);
 for(const patch of [{outputRoot:'elsewhere'},{landmarks:[{id:'x',objectId:null,observations:[{photoId:'unknown',xy:[1,2],origin:'manual'}]}]},{landmarks:[{id:'x',objectId:null,observations:[{photoId:'p1',xy:[101,2],origin:'manual'}]}]},{dimensions:[{id:'d',source:'measured',unit:'cm',value:-2,endpoints:null}]}]){
  assert.equal((await call('/assistance',{expectedRevision:1,patch},'PUT')).status,400);
 }
 assert.equal((await call('/assistance',{expectedRevision:1,patch:{},database:'outside'},'PUT')).status,400);
});
test('concurrent PUT accepts one save and preserves its answers',async t=>{
 const {p,call}=await fixture(t);
 const results=await Promise.all([true,false].map(value=>call('/assistance',{expectedRevision:0,patch:{onlyExistingPhotos:value}},'PUT')));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(readAssistance(p).revision,1);
});
test('summary keeps legacy fields; polling does not rehash input files',async t=>{
 const {call,hashes}=await fixture(t);
 const summary=await (await call('/summary')).json();
 assert.ok(['gate','modelSummary','manifest','assistance','quality','attempts'].every(k=>k in summary));
 const assistance=await(await call('/assistance')).json();assert.ok(assistance.catalog.length===2&&assistance.record.revision===0);
 await call('/summary');await call('/assistance');assert.equal(hashes(),0);
});
test('malformed and oversized requests fail without stopping the server',async t=>{
 const {call}=await fixture(t);
 assert.equal((await call('/assistance','{','PUT')).status,400);
 assert.equal((await call('/assistance',JSON.stringify({data:'a'.repeat(1024*1024)}),'PUT')).status,413);
 assert.equal((await call('/summary')).status,200);
});

test('tool failures return HTTP errors and leave the workbench available',async t=>{
 for(const code of [1,'ENOENT',-1,700,200,409]){
  const {call}=await fixture(t,{contextError:Object.assign(new Error('geometry tool failed'),{code})});
  const response=await call('/assistance/review',{},'POST');
  assert.equal(response.status,code===409?409:500);
  assert.equal((await response.json()).error,'geometry tool failed');
  assert.equal((await call('/summary')).status,200);
 }
});
test('old review cannot approve another attempt or changed geometry',async t=>{
 const {call,signature}=await fixture(t);
 const review={appearance:'passed',items:['doorway','ghosting','proportions','coverage'].map(code=>({code,status:'passed',photoIds:['p1'],regionIds:['0:0'],note:'checked'})),requestPositionCheck:false};
 for(const identity of [{attemptId:'a-'+'1'.repeat(24),geometrySignature:signature},{attemptId:null,geometrySignature:'changed'}]){
  assert.equal((await call('/assistance/review',{expectedRevision:0,...identity,review},'POST')).status,409);
 }
 assert.equal((await call('/assistance/review',{expectedRevision:0,attemptId:null,geometrySignature:signature,review},'POST')).status,200);
});
test('history is project scoped and direct downstream retries remain blocked',async t=>{
 const {p,call}=await fixture(t);const a=createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null});
 assert.equal((await call(`/attempts/${a.id}/scene`)).status,200);
 assert.equal((await call(`/attempts/a-${'0'.repeat(24)}/scene`)).status,404);
 assert.equal((await call('/attempts/%2e%2e%5coutside/scene.ply')).status,400);
 for(const fromStep of ['undistort','train'])assert.equal((await call('/run',{fromStep},'POST')).status,409);
 assert.equal((await call('/run',{fromStep:'train',runtime:{},outputRoot:'x'},'POST')).status,400);
 assert.equal((await call('/assistance/run',{expectedRevision:99},'POST')).status,409);
});
test('connected models can explicitly request a position check',async t=>{
 const {call,p}=await fixture(t);
 const result=await call('/assistance/check',{expectedRevision:0},'POST');assert.equal(result.status,200);
 const {record}=await result.json();assert.equal(record.state,'needs_input');assert.ok(record.questions.some(q=>q.type==='position_review'));
 assert.equal(projects.read(p.id).state,'needs_input');
 assert.equal((await call('/assistance/check',{expectedRevision:0},'POST')).status,409);
});
test('explicit photo import rejects stale revisions, unknown fields and a running project',async t=>{
 const {call,p,d}=await fixture(t),folder=resolve(d.root,'photo-source');mkdirSync(folder);writeFileSync(resolve(folder,'new.png'),'new-readonly-photo');
 assert.equal((await call('/assistance/photos',{expectedRevision:99,sourceDir:folder},'POST')).status,409);
 assert.equal((await call('/assistance/photos',{expectedRevision:0,sourceDir:folder,outputRoot:'x'},'POST')).status,400);
 projects.write({...p,state:'running'});assert.equal((await call('/assistance/photos',{expectedRevision:0,sourceDir:folder},'POST')).status,409);projects.write(p);
 const result=await call('/assistance/photos',{expectedRevision:0,sourceDir:folder},'POST');assert.equal(result.status,200);assert.equal((await result.json()).added,1);
});
test('evaluation images are resolved only from the fixed server manifest',async t=>{
 const {call,d}=await fixture(t);mkdirSync(resolve(d.train,'eval_1000'),{recursive:true});writeFileSync(resolve(d.train,'eval_1000/one.png'),'render');
 const result=await call('/evaluation');assert.equal(result.status,200);assert.equal((await result.json()).photos[0].name,'one.png');
 assert.equal((await call('/evaluation/image?step=1000&name=one.png')).status,200);
 assert.equal((await call('/evaluation/image?step=1000&name=..%2Foutside.png')).status,400);
 assert.equal((await call(`/evaluation?attemptId=a-${'a'.repeat(24)}`)).status,404);
});
test('accepted assisted runs return their server-created attempt identity',async t=>{
 const {p,call}=await fixture(t),jobs=await import('./lib/jobs.mjs');projects.write({...p,steps:p.steps.map((s,i)=>({...s,status:i<3?'success':'pending'}))});
 updateAssistance(p,r=>({...r,state:'ready'}));
 const response=await call('/assistance/run',{expectedRevision:0,untilStep:'gate'},'POST');assert.equal(response.status,202);const result=await response.json();
 const job=jobs.current(p.id);if(job)await job.done;
 assert.match(result.attemptId??'',/^a-[a-f0-9]{24}$/);assert.equal(projects.read(p.id).activeAttemptId??null,null);
});
test('history exports reject a nested directory junction outside their attempt',async t=>{
 const f=await fixture(t),other=await fixture(t),attempt=createAttempt(f.p,{kind:'automatic',inputRevision:null,inputFingerprint:null});
 mkdirSync(other.d.train,{recursive:true});writeFileSync(resolve(other.d.train,'export_30000.ply'),'different project');
 const folder=dirs(f.p,{attemptId:attempt.id}).train;rmSync(folder,{recursive:true});symlinkSync(other.d.train,folder,process.platform==='win32'?'junction':'dir');
 t.after(()=>rmSync(folder,{recursive:true,force:true}));
 assert.equal((await f.call(`/attempts/${attempt.id}/scene.ply`)).status,400);
});
test('a legacy connected gate with unknown coverage cannot bypass assistance through downstream run',async t=>{
 const {p,d,call}=await fixture(t),jobs=await import('./lib/jobs.mjs');unlinkSync(resolve(d.root,'assistance.json'));
 const gate=JSON.parse(readFileSync(resolve(d.summary,'gate.json'),'utf8'));gate.models[0].unregistered=['unseen-room.png'];atomicJson(resolve(d.summary,'gate.json'),gate);
 projects.write({...p,state:'partial',steps:p.steps.map((s,i)=>({...s,status:i<5?'success':'pending'}))});
 const response=await call('/run',{fromStep:'undistort'},'POST');const job=jobs.current(p.id);if(job)await job.done;assert.equal(response.status,409);
});
test('summary shows a pending geometry failure without changing the active model report',async t=>{
 const {p,d,call}=await fixture(t),attempt=createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null});
 const gate=JSON.parse(readFileSync(resolve(d.summary,'gate.json'),'utf8'));atomicJson(resolve(dirs(p,{attemptId:attempt.id}).summary,'gate.json'),{...gate,verdict:'split',geometryConnected:false});projects.write({...p,pendingAttemptId:attempt.id});
 const summary=await(await call('/summary')).json();assert.equal(summary.gate.verdict,'pass');assert.equal(summary.pendingGate?.verdict,'split');
});
