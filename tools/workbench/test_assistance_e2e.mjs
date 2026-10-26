import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,rmSync,cpSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkbenchServer} from './server.mjs';
import {graph} from './test-fixtures/assistance-native.mjs';
import * as projects from './lib/projects.mjs';
import * as jobs from './lib/jobs.mjs';
import {dirs,readGate,buildSteps} from './lib/pipeline.mjs';
import {atomicJson,readAssistance} from './lib/assistance.mjs';
import {createAttempt,listAttempts} from './lib/attempts.mjs';
import {assistanceSource} from './lib/assistance-service.mjs';

test('HTTP assistance resumes after restart, trains one component, and retains old models on failure',async t=>{
 const id=`test-assist-e2e-${randomBytes(4).toString('hex')}`,p={id,name:'Lifecycle fixture',state:'partial',sourceDir:'fixture-readonly',mapper:'global',useGpu:true,selectedModel:'0',trainingPreset:'full',steps:buildSteps().map((s,i)=>({...s,status:i<4?'success':'pending'}))},d=dirs(p);
 mkdirSync(d.images,{recursive:true});mkdirSync(d.train,{recursive:true});graph(resolve(d.sparse,'0'),false);graph(resolve(d.root,'fixture-connected'),true);graph(resolve(d.root,'fixture-loss'),true,'p5.png');
 const catalog=Array.from({length:5},(_,i)=>({photoId:`sha-${i+1}`,sourceSha256:`sha-${i+1}`,name:`p${i+1}.png`,width:1000,height:800}));
 for(const photo of catalog)writeFileSync(resolve(d.images,photo.name),'readonly fixture photo');
 atomicJson(d.manifest,{retained_count:5,records:catalog.map(p=>({sha256:p.photoId,work_image:`images/${p.name}`,excluded:null}))});writeFileSync(resolve(d.train,'export_30000.ply'),'old retained PLY');projects.write(p);
 const inputs={photosSha256:'fixture-photos',matchingContentSha256:'fixture-matches',geometrySha256:'fixture-geometry',configSha256:'fixture-config'},worker=resolve('tools/workbench/test-fixtures/assistance-native.mjs');let fail=false,coverageLoss=false;
 const context=async project=>({catalog,inputs,gate:readGate(project)});
 const runtime={getContext:context,
  prepareAutomaticAttempt:async(project,from,{onAttempt})=>{const attempt=createAttempt(project,{kind:'automatic',inputRevision:null,inputFingerprint:null});onAttempt(attempt);cpSync(d.sparse,dirs(project,{attemptId:attempt.id}).sparse,{recursive:true});return {attempt,project:{...project,activeAttemptId:attempt.id}};},
  prepareAssistedAttempt:async(project,record,{onAttempt})=>{const attempt=createAttempt(assistanceSource(project,record),{kind:'assisted',inputRevision:record.revision,inputFingerprint:inputs});onAttempt(attempt);return {attempt,project:{...project,activeAttemptId:attempt.id},context:{inputs},resultPath:resolve(dirs(project,{attemptId:attempt.id}).summary,'assistance-result.json')};},
  assistanceCommand:prepared=>({cmd:process.execPath,args:[worker,'solve',resolve(d.root,coverageLoss?'fixture-loss':'fixture-connected'),dirs(prepared.project).workspace,prepared.resultPath,...(fail?['fail']:[])]}),
  commandForStep:(step,project)=>step==='undistort'?{cmd:process.execPath,args:[worker,'undistort',resolve(dirs(project).sparse,'0'),dirs(project).images,dirs(project).undistorted]}:step==='train'?{cmd:process.execPath,args:[worker,'train',dirs(project).train]}:null};
 let server,base;
 const open=async()=>{server=createWorkbenchServer({getContext:context,jobRuntime:runtime});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}/api/projects/${id}`;};
 const call=(path='',body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const wait=async()=>{const job=jobs.current(id);if(job)await job.done;};
 t.after(async()=>{await wait();if(server?.listening)await new Promise(r=>server.close(r));rmSync(d.root,{recursive:true,force:true});});
 await open();assert.equal((await call('/run',{fromStep:'gate',untilStep:'gate'})).status,202);await wait();
 assert.equal(projects.read(id).state,'needs_input');assert.deepEqual(readGate({...p,activeAttemptId:projects.read(id).pendingAttemptId}).models[0].geometryComponentSizes,[2,2]);assert.equal(projects.latestExport(projects.read(id)).name,'export_30000.ply');
 const initial=await(await call('/assistance')).json();const landmarks=Array.from({length:8},(_,i)=>({id:`point-${i}`,objectId:null,observations:catalog.slice(0,4).map(photo=>({photoId:photo.photoId,xy:[200+i*50,200+(i%2)*100],origin:'manual'}))}));
 const coverage=[{photoId:catalog[4].photoId,decision:'existing',regionId:'0:0'}];
 const saved=await fetch(base+'/assistance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:initial.record.revision,patch:{landmarks,coverage,onlyExistingPhotos:true}})});assert.equal(saved.status,200);assert.equal((await saved.json()).record.state,'ready');
 await new Promise(r=>server.close(r));await open();assert.equal((await(await call('/assistance')).json()).record.landmarks.length,8);
 const accepted=await call('/assistance/run',{expectedRevision:1});assert.equal(accepted.status,202);const {attemptId}=await accepted.json();assert.ok(attemptId);
 assert.equal((await call('/assistance/run',{expectedRevision:1})).status,409);
 for(let i=0;readAssistance(p).state!=='solving'&&i<50;i++)await delay(10);assert.equal(readAssistance(p).state,'solving');
 await wait();let after=projects.read(id);assert.equal(after.state,'done',after.lastError);assert.equal(after.activeAttemptId,attemptId);assert.equal(readAssistance(p).state,'verified');
 assert.deepEqual(readAssistance(p).reasons,[],'resolved split reasons must not remain current after verified adoption');
 assert.ok(!after.steps.find(s=>s.id==='gate').note?.includes('需要真实共享点'),'successful gate must replace its old waiting note');
 assert.deepEqual(readGate(after).models[0].geometryComponentSizes,[4]);assert.ok(after.steps.filter(s=>['undistort','train'].includes(s.id)).every(s=>s.status==='success'));
 const summary=await(await call('/summary')).json();assert.equal(summary.quality.trainingComplete,true);assert.equal(summary.quality.complete,false);assert.equal(listAttempts(after).length,2);
 assert.equal(readFileSync(resolve(d.train,'export_30000.ply'),'utf8'),'old retained PLY');
 // A connected repair that loses a previously registered target must stop before training.
 let latest=readAssistance(p);await call('/assistance/check',{expectedRevision:latest.revision});latest=readAssistance(p);
 const lossSave=await fetch(base+'/assistance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:latest.revision,patch:{landmarks,coverage,onlyExistingPhotos:true}})});assert.equal(lossSave.status,200);latest=(await lossSave.json()).record;
 coverageLoss=true;assert.equal((await call('/assistance/run',{expectedRevision:latest.revision})).status,202);await wait();after=projects.read(id);
 assert.equal(after.state,'needs_input','newly unknown coverage must stop an assisted pipeline');assert.equal(after.activeAttemptId,attemptId);assert.equal(after.steps.find(s=>s.id==='undistort').status,'blocked');coverageLoss=false;
 // Failed repair produces a new attempt and leaves the adopted scene intact.
 const before=projects.latestExport(after).path;let record=readAssistance(p);await call('/assistance/check',{expectedRevision:record.revision});record=readAssistance(p);
 const retry=await fetch(base+'/assistance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:record.revision,patch:{landmarks,coverage,onlyExistingPhotos:true}})});assert.equal(retry.status,200);record=(await retry.json()).record;
 fail=true;assert.equal((await call('/assistance/run',{expectedRevision:record.revision})).status,202);await wait();after=projects.read(id);
 assert.equal(after.state,'failed');assert.equal(after.activeAttemptId,attemptId);assert.equal(projects.latestExport(after).path,before);assert.equal(readAssistance(p).state,'failed');
});
