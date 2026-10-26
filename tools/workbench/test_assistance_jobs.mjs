import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as jobs from './lib/jobs.mjs';
import * as projects from './lib/projects.mjs';
import { dirs, buildSteps } from './lib/pipeline.mjs';
import { atomicJson, newRecord, updateAssistance, readAssistance } from './lib/assistance.mjs';
import { createAttempt } from './lib/attempts.mjs';

// Tiny binary camera graph, read by the real Python gate; no COLMAP/GPU needed.
function binaryGraph(folder){
 mkdirSync(folder,{recursive:true});let chunks=[];
 const number=(kind,v)=>{const b=Buffer.alloc(kind==='i'?4:8);if(kind==='i')b.writeInt32LE(v);else if(kind==='d')b.writeDoubleLE(v);else b.writeBigUInt64LE(BigInt(v));chunks.push(b);};
 number('q',4);
 for(let i=1;i<=4;i++){number('i',i);for(const v of [1,0,0,0,0,0,0])number('d',v);number('i',1);chunks.push(Buffer.from(`p${i}.png\0`));number('q',0);}
 writeFileSync(resolve(folder,'images.bin'),Buffer.concat(chunks));chunks=[];number('q',2);
 for(const [id,ids] of [[1,[1,2]],[2,[3,4]]]){number('q',id);for(const v of [0,0,4])number('d',v);chunks.push(Buffer.from([100,100,100]));number('d',0.1);number('q',2);for(const imageId of ids){number('i',imageId);number('i',0);}}
 writeFileSync(resolve(folder,'points3D.bin'),Buffer.concat(chunks));
}
function fixture(t){
 const id=`test-assist-job-${randomBytes(4).toString('hex')}`;
 const p={id,name:'fixture',sourceDir:'test-only',mapper:'global',useGpu:true,cameraModel:'SIMPLE_RADIAL',trainingPreset:'full',state:'partial',selectedModel:'0',steps:buildSteps().map((s,i)=>({id:s.id,name:s.name,status:i<4?'success':'pending'}))};
 const d=dirs(p);mkdirSync(d.images,{recursive:true});mkdirSync(d.summary,{recursive:true});mkdirSync(d.train,{recursive:true});binaryGraph(resolve(d.sparse,'0'));
 const photos=Array.from({length:4},(_,i)=>({photoId:`photo${i+1}`,name:`p${i+1}.png`,width:1000,height:800}));
 for(const photo of photos)writeFileSync(resolve(d.images,photo.name),'fixture-image-not-decoded-by-gate');
 atomicJson(d.manifest,{records:photos.map(p=>({work_image:`images/${p.name}`,sha256:p.photoId,excluded:null}))});
 writeFileSync(resolve(d.train,'export_30000.ply'),'retained old scene');projects.write(p);
 const inputs={photosSha256:'photos',matchingContentSha256:'matches',matchingSnapshotSha256:'snapshot',geometrySha256:'geometry',configSha256:'config'};
 t.after(async()=>{if(jobs.current(id)){await jobs.abort(id);for(let i=0;jobs.current(id)&&i<300;i++)await delay(10);}rmSync(d.root,{recursive:true,force:true});});
 return {p,d,photos,inputs,runtime:{getContext:async()=>({catalog:photos,inputs,models:[{name:'0',path:resolve(d.sparse,'0')}],gate:null}),
   prepareAutomaticAttempt:async(project,from,{onAttempt})=>{const attempt=createAttempt(project,{kind:'automatic',inputRevision:null,inputFingerprint:null});onAttempt(attempt);cpSync(d.sparse,dirs(project,{attemptId:attempt.id}).sparse,{recursive:true});return {attempt,project:{...project,activeAttemptId:attempt.id}};}}};
}
async function finished(job){if(job.done)return job.done;for(let i=0;jobs.current(job.projectId)&&i<500;i++)await delay(10);assert.equal(jobs.current(job.projectId),null);}

test('waiting releases the slot and blocks downstream steps instead of failing',async t=>{
 const {p,runtime}=fixture(t);const job=jobs.start(p.id,{fromStep:'gate',untilStep:'gate'},runtime);await finished(job);
 const after=projects.read(p.id);assert.equal(after.state,'needs_input');assert.equal(jobs.busyId(),null);
 assert.equal(after.steps.find(s=>s.id==='gate').status,'needs_input');
 assert.ok(after.steps.filter(s=>['undistort','train'].includes(s.id)).every(s=>s.status==='blocked'));
 assert.equal(readAssistance(after).state,'needs_input');assert.ok(readAssistance(after).questions.length>0);
 assert.equal(projects.latestExport(after).name,'export_30000.ply');
 assert.equal(jobs.activeChildPids().length,0);
 const originalNow=Date.now;try{Date.now=()=>originalNow()+3*60*60*1000;assert.equal(projects.read(p.id).state,'needs_input');}finally{Date.now=originalNow;}
 const other=fixture(t);await finished(jobs.start(other.p.id,{fromStep:'gate',untilStep:'gate'},other.runtime));
 assert.equal(projects.read(other.p.id).state,'needs_input');
});
test('a stale assistance revision is rejected before any job starts',t=>{
 const {p,photos,inputs}=fixture(t);updateAssistance(p,()=>({...newRecord({catalog:photos,inputs}),revision:2,state:'ready'}));
 assert.equal(typeof jobs.startAssistance,'function');
 assert.throws(()=>jobs.startAssistance(p.id,{expectedRevision:1}),{code:409});assert.equal(jobs.busyId(),null);
});
test('rechecking imported photos preserves explicitly answered questions',async t=>{
 const f=fixture(t);updateAssistance(f.p,()=>({...newRecord({catalog:f.photos,inputs:f.inputs}),state:'stale',questions:[{id:'user-confirmed',type:'same_object',photoIds:[f.photos[0].photoId,f.photos[2].photoId],options:['yes','no','unknown']}],answers:[{questionId:'user-confirmed',value:'yes'}]}));
 await finished(jobs.start(f.p.id,{fromStep:'gate',untilStep:'gate'},f.runtime));
 const current=readAssistance(f.p);assert.equal(current.answers[0].value,'yes');assert.ok(current.questions.some(q=>q.id==='user-confirmed'));
});
test('waiting survives restart and direct training retries cannot bypass it',t=>{
 const {p,photos,inputs}=fixture(t);p.state='needs_input';p.steps[4].status='needs_input';projects.write(p);
 const marked=[{id:'point',objectId:null,observations:[{photoId:photos[0].photoId,xy:[20,30],origin:'manual'}]}];
 updateAssistance(p,()=>({...newRecord({catalog:photos,inputs}),landmarks:marked}));
 projects.reconcileProject(p.id);assert.equal(projects.read(p.id).state,'needs_input');assert.deepEqual(readAssistance(p).landmarks,marked);
 assert.throws(()=>jobs.start(p.id,{fromStep:'train'}),{code:409});
});
test('owned script checks include new solver but exclude unrelated Python',()=>{
 const script=resolve('tools/workbench/py/assisted_reconstruct.py');
 assert.equal(jobs.isOwnedProcess({childScript:script},{name:'python.exe',commandLine:`python.exe "${script}" --request project-input.json`}),true);
 assert.equal(jobs.isOwnedProcess({childScript:script},{name:'python.exe',commandLine:'python.exe unrelated.py'}),false);
});

function assistedRuntime(f){
 let signal;const commandReady=new Promise(resolve=>signal=resolve);
 return {commandReady,...f.runtime,
   prepareAssistedAttempt:async(project,record,{onAttempt})=>{
     const attempt=createAttempt(project,{kind:'assisted',inputRevision:record.revision,inputFingerprint:f.inputs});onAttempt(attempt);
     cpSync(f.d.sparse,dirs(project,{attemptId:attempt.id}).sparse,{recursive:true});
     const d=dirs(project,{attemptId:attempt.id});
     return {attempt,project:{...project,activeAttemptId:attempt.id},context:{inputs:f.inputs},
       requestPath:resolve(d.workspace,'inputs/request.json'),resultPath:resolve(d.summary,'assistance-result.json')};
   },
   assistanceCommand:prepared=>{
     signal();
     const result={outcome:'verified',inputRevision:prepared.attempt.inputRevision,bridges:{accepted:true}};
     return {cmd:process.execPath,args:['-e',`setTimeout(()=>require('fs').writeFileSync(process.argv[1],process.argv[2]),350)`,prepared.resultPath,JSON.stringify(result)]};
   }
 };
}
test('a late solve cannot overwrite an answer edited during the run',async t=>{
 const f=fixture(t),runtime=assistedRuntime(f);
 updateAssistance(f.p,()=>({...newRecord({catalog:f.photos,inputs:f.inputs}),revision:1,state:'ready',sourceAttemptId:null}));
 const job=jobs.startAssistance(f.p.id,{expectedRevision:1,untilStep:'gate'},runtime);
 await runtime.commandReady;
 updateAssistance(f.p,current=>({...current,revision:2,state:'ready',onlyExistingPhotos:true}));
 await finished(job);
 assert.equal(readAssistance(f.p).revision,2);assert.equal(readAssistance(f.p).onlyExistingPhotos,true);
 assert.equal(projects.read(f.p.id).state,'needs_input');assert.equal(projects.read(f.p.id).activeAttemptId,undefined);
});
test('cancel preserves observations and leaves a recoverable assistance state',async t=>{
 const f=fixture(t),runtime=assistedRuntime(f);
 const marks=[{id:'retained',observations:[{photoId:f.photos[0].photoId,xy:[50,60],origin:'manual'}]}];
 updateAssistance(f.p,()=>({...newRecord({catalog:f.photos,inputs:f.inputs}),revision:1,state:'ready',sourceAttemptId:null,landmarks:marks}));
 const job=jobs.startAssistance(f.p.id,{expectedRevision:1},runtime);await runtime.commandReady;await jobs.abort(f.p.id);await finished(job);
 assert.equal(projects.read(f.p.id).state,'aborted');assert.deepEqual(readAssistance(f.p).landmarks,marks);
 assert.notEqual(readAssistance(f.p).state,'solving');assert.equal(jobs.busyId(),null);
});
test('restart changes an interrupted solving state without losing answers',t=>{
 const f=fixture(t);f.p.state='running';f.p.steps[3].status='running';projects.write(f.p);
 updateAssistance(f.p,()=>({...newRecord({catalog:f.photos,inputs:f.inputs}),revision:1,state:'solving',onlyExistingPhotos:true}));
 projects.reconcileProject(f.p.id);assert.equal(projects.read(f.p.id).state,'aborted');
 assert.equal(readAssistance(f.p).state,'ready');assert.equal(readAssistance(f.p).onlyExistingPhotos,true);
});
test('reconciling one interrupted project does not change another running project',t=>{
 const first=fixture(t),second=fixture(t);projects.write({...first.p,state:'running'});projects.write({...second.p,state:'running'});
 assert.equal(typeof projects.reconcileProject,'function');projects.reconcileProject(first.p.id);
 assert.equal(projects.read(first.p.id).state,'aborted');assert.equal(projects.read(second.p.id).state,'running');
});
test('changing reconstruction settings invalidates verification but retains answers',t=>{
 const f=fixture(t);
 for(const patch of [{featurePreset:'enhanced'},{cameraModel:'OPENCV'},{mapper:'incremental'}]){
   updateAssistance(f.p,()=>({...newRecord({catalog:f.photos,inputs:f.inputs}),revision:1,state:'verified',onlyExistingPhotos:true}));
   projects.update(f.p.id,patch);
   assert.equal(readAssistance(f.p).state,'stale');assert.equal(readAssistance(f.p).onlyExistingPhotos,true);
 }
});
test('answer changes during input preparation pause safely and duplicate starts are rejected',async t=>{
 const f=fixture(t),runtime=assistedRuntime(f);let signal;
 const prepared=new Promise(resolve=>signal=resolve),base=runtime.prepareAssistedAttempt;
 runtime.prepareAssistedAttempt=async(...args)=>{const value=await base(...args);signal();await delay(200);return value;};
 updateAssistance(f.p,()=>({...newRecord({catalog:f.photos,inputs:f.inputs}),revision:1,state:'ready',sourceAttemptId:null}));
 const job=jobs.startAssistance(f.p.id,{expectedRevision:1},runtime);await prepared;
 assert.throws(()=>jobs.startAssistance(f.p.id,{expectedRevision:1},runtime),{code:409});
 updateAssistance(f.p,current=>({...current,revision:2,state:'ready'}));await finished(job);
 assert.equal(projects.read(f.p.id).state,'needs_input');assert.equal(readAssistance(f.p).revision,2);
 assert.equal(jobs.busyId(),null);
});
