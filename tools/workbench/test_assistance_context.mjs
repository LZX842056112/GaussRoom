import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getContext, prepareAutomaticAttempt, prepareAssistedAttempt } from './lib/assistance-service.mjs';
import { dirs } from './lib/pipeline.mjs';
import { TOOLS,PY_DIR } from './lib/paths.mjs';
import { sameInputs,writeAttempt } from './lib/attempts.mjs';

function fixture(t){
 const root=mkdtempSync(resolve(tmpdir(),'real-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const script="import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from test_assistance_solver import fixture; r,m=fixture(Path(sys.argv[2])); Path(sys.argv[2],'request.json').write_text(json.dumps(r),encoding='utf8')";
 execFileSync(TOOLS.python,['-c',script,PY_DIR,root],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
 const request=JSON.parse(readFileSync(resolve(root,'request.json'),'utf8'));
 const source=resolve(root,'source');cpSync(resolve(source,'sparse'),resolve(source,'sfm/sparse'),{recursive:true});
 cpSync(resolve(source,'database.db'),resolve(source,'sfm/database.db'));
 return {p:{id:'context-fixture',root:source,mapper:'global',useGpu:true,trainingPreset:'full',cameraModel:'SIMPLE_RADIAL',featurePreset:'standard'},request};
}
test('real context snapshots remain stable when only SQLite counters change',async t=>{
 const {p}=fixture(t),first=await getContext(p,{fresh:true}),db=resolve(dirs(p).sfm,'database.db');
 const bytes=readFileSync(db);const counter=bytes.readUInt32BE(24)+1;bytes.writeUInt32BE(counter,24);bytes.writeUInt32BE(counter,92);writeFileSync(db,bytes);
 const second=await getContext(p,{fresh:true});assert.ok(sameInputs(first.inputs,second.inputs));assert.equal(first.matchingSnapshot,second.matchingSnapshot);assert.equal(second.catalog.length,6);
});
test('automatic retry and assisted requests copy actual photos, models and matching data',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});const sourceBytes=readFileSync(context.database);
 const retry=await prepareAutomaticAttempt(p,'gate');assert.notEqual(dirs(retry.project).images,dirs(p).images);
 assert.deepEqual(readFileSync(context.database),sourceBytes);
 const record={revision:1,inputs:context.inputs,sourceAttemptId:null,regions:request.regions,...request.constraints};
 const prepared=await prepareAssistedAttempt(p,record);
 const frozen=JSON.parse(readFileSync(prepared.requestPath,'utf8'));
 assert.ok(sameInputs(prepared.context.inputs,context.inputs));assert.equal(frozen.inputRevision,1);assert.equal(frozen.models.length,1);assert.equal(frozen.catalog.length,6);
 const verify="import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from assistance_inputs import fingerprint_inputs; r=json.loads(Path(sys.argv[2]).read_text(encoding='utf8')); assert fingerprint_inputs(r['catalog'],Path(r['database']),[Path(m['path']) for m in r['models']],r['config'])==r['inputFingerprint']";
 execFileSync(TOOLS.python,['-c',verify,PY_DIR,prepared.requestPath],{windowsHide:true});
});

test('local repair freezes the persisted scope and server-owned prior bridge evidence',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const prior=await prepareAssistedAttempt(p,{revision:1,inputs:context.inputs,regions:request.regions,...request.constraints});
 const bridge={accepted:true,regions:request.regions,retainedLandmarks:request.constraints.landmarks};
 writeAttempt(p,{...prior.attempt,status:'verified',result:{bridges:bridge}});
 const localRepair={photoIds:context.catalog.slice(3).map(p=>p.photoId),referencePhotoIds:context.catalog.slice(0,3).map(p=>p.photoId),contextPhotoIds:[],refineCornerIds:[],excludedPlanarInteriors:[]};
 // The source attempt supplies the evidence; no client path can select it.
 cpSync(dirs(p).sparse,dirs(prior.project).sparse,{recursive:true});
 const record={revision:2,inputs:context.inputs,sourceAttemptId:prior.attempt.id,regions:[{id:'whole',model:'0',component:0,photoIds:context.catalog.map(p=>p.photoId)}],...request.constraints,localRepair};
 const next=await prepareAssistedAttempt(p,record);
 assert.deepEqual(next.request.constraints.localRepair,localRepair);
 assert.equal(next.attempt.localRepairRequired,true);
 assert.equal(next.request.priorBridgeChecks.length,1);
 assert.deepEqual(next.request.priorBridgeChecks[0].constraints.landmarks,bridge.retainedLandmarks);
 assert.equal(next.request.priorBridgeChecks[0].sourceAttemptId,prior.attempt.id);
 assert.ok(!JSON.stringify(next.request.priorBridgeChecks).includes('outputPath'));
 writeAttempt(p,{...next.attempt,status:'verified',result:{bridges:{accepted:true,regions:record.regions,retainedLandmarks:[]},localRepair:{accepted:true,priorBridgeChecks:next.request.priorBridgeChecks.map(c=>({...c,accepted:true,retainedLandmarks:c.constraints.landmarks}))}}});
 cpSync(dirs(p).sparse,dirs(next.project).sparse,{recursive:true});
 const again=await prepareAssistedAttempt(p,{...record,revision:3,sourceAttemptId:next.attempt.id});
 assert.equal(again.request.priorBridgeChecks.length,1,'a later repair must retain original multi-region evidence');
});

test('later repair preserves effective source pixels only for unchanged user points',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const raw=structuredClone(request.constraints.landmarks);
 raw[0].observations[0].xy[0]+=.5;
 const prior=await prepareAssistedAttempt(p,{revision:1,inputs:context.inputs,regions:request.regions,...request.constraints,landmarks:raw});
 const detected={...structuredClone(request.constraints.landmarks[3]),id:'detected-source-feature'};
 for(const obs of detected.observations)obs.origin='detected';
 const effective=[...structuredClone(request.constraints.landmarks),detected];
 writeAttempt(p,{...prior.attempt,status:'verified',result:{bridges:{accepted:true,regions:request.regions,retainedLandmarks:effective}}});
 cpSync(dirs(p).sparse,dirs(prior.project).sparse,{recursive:true});
 const localRepair={photoIds:context.catalog.slice(4).map(p=>p.photoId),referencePhotoIds:context.catalog.slice(2,4).map(p=>p.photoId),contextPhotoIds:context.catalog.slice(0,2).map(p=>p.photoId),refineCornerIds:[],excludedPlanarInteriors:[]};
 const changed=structuredClone(raw);changed[1].observations[0].xy[0]+=3;changed.splice(2,1);
 const before=structuredClone(changed);
 const next=await prepareAssistedAttempt(p,{revision:2,inputs:context.inputs,sourceAttemptId:prior.attempt.id,regions:[{id:'whole',model:'0',photoIds:context.catalog.map(p=>p.photoId)}],...request.constraints,landmarks:changed,localRepair});
 const preserved=next.request.preservedLandmarks;
 assert.ok(Array.isArray(preserved),'server-owned effective observations must be frozen');
 assert.deepEqual(preserved.find(p=>p.id===raw[0].id),request.constraints.landmarks[0]);
 assert.ok(!preserved.some(p=>p.id===raw[1].id),'a user edit must not be overwritten with source pixels');
 assert.ok(!preserved.some(p=>p.id===raw[2].id),'a removed user point must not be restored');
 assert.ok(preserved.some(p=>p.id.startsWith('preserved-')&&p.observations.every(o=>o.origin==='detected')),'prior automatic point IDs must not collide with fresh detector numbering');
 assert.deepEqual(next.request.constraints.landmarks,before,'raw user clicks remain separate from effective source observations');
 assert.deepEqual(JSON.parse(readFileSync(next.requestPath,'utf8')).preservedLandmarks,preserved);
});

test('newer effective observations win over older accepted proof',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const localRepair={photoIds:context.catalog.slice(4).map(p=>p.photoId),referencePhotoIds:context.catalog.slice(2,4).map(p=>p.photoId),contextPhotoIds:context.catalog.slice(0,2).map(p=>p.photoId),refineCornerIds:[],excludedPlanarInteriors:[]};
 const record={revision:1,inputs:context.inputs,regions:request.regions,...request.constraints,localRepair};
 const first=await prepareAssistedAttempt(p,record);
 cpSync(dirs(p).sparse,dirs(first.project).sparse,{recursive:true});
 const older=structuredClone(request.constraints.landmarks);
 writeAttempt(p,{...first.attempt,status:'verified',result:{bridges:{accepted:true,regions:request.regions,retainedLandmarks:older}}});
 const second=await prepareAssistedAttempt(p,{...record,revision:2,sourceAttemptId:first.attempt.id});
 cpSync(dirs(first.project).sparse,dirs(second.project).sparse,{recursive:true});
 const newer=structuredClone(older);newer[0].observations[0].xy[0]+=.25;
 for(const proof of ['global','local boundary'])await t.test(proof,async()=>{
  const result=proof==='global'?{bridges:{accepted:true,regions:request.regions,retainedLandmarks:newer}}:{
   bridges:{accepted:true,regions:request.regions,retainedLandmarks:newer.slice(1)},
   localRepair:{accepted:true,boundary:{accepted:true,regions:request.regions,retainedLandmarks:newer},
    priorBridgeChecks:[{accepted:true,regions:request.regions,retainedLandmarks:older}]}
  };
  writeAttempt(p,{...second.attempt,status:'verified',result});
  const next=await prepareAssistedAttempt(p,{...record,revision:3,sourceAttemptId:second.attempt.id});
  assert.equal(next.request.priorBridgeChecks.length,proof==='global'?2:3);
  assert.deepEqual(next.request.preservedLandmarks.find(point=>point.id===newer[0].id),newer[0],
   'older source-chain proof cannot overwrite a newer verified pixel');
  assert.deepEqual(next.request.constraints.landmarks,request.constraints.landmarks);
 });
});

test('deleted refined manual points cannot return under automatic point IDs',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const localRepair={photoIds:context.catalog.slice(4).map(p=>p.photoId),referencePhotoIds:context.catalog.slice(2,4).map(p=>p.photoId),contextPhotoIds:context.catalog.slice(0,2).map(p=>p.photoId),refineCornerIds:[],excludedPlanarInteriors:[]};
 const record={revision:1,inputs:context.inputs,regions:request.regions,...request.constraints,localRepair};
 const first=await prepareAssistedAttempt(p,record);
 cpSync(dirs(p).sparse,dirs(first.project).sparse,{recursive:true});
 const effective=structuredClone(request.constraints.landmarks);
 for(const observation of effective[0].observations)observation.origin='detected';
 writeAttempt(p,{...first.attempt,status:'verified',result:{bridges:{accepted:true,regions:request.regions,retainedLandmarks:effective}}});
 const remaining=structuredClone(request.constraints.landmarks.slice(1));
 const second=await prepareAssistedAttempt(p,{...record,revision:2,sourceAttemptId:first.attempt.id,landmarks:remaining});
 cpSync(dirs(first.project).sparse,dirs(second.project).sparse,{recursive:true});
 writeAttempt(p,{...second.attempt,status:'verified',result:{bridges:{accepted:true,regions:request.regions,retainedLandmarks:effective.slice(1)}}});
 const next=await prepareAssistedAttempt(p,{...record,revision:3,sourceAttemptId:second.attempt.id,landmarks:remaining});
 assert.equal(next.request.priorBridgeChecks.length,2);
 assert.ok(next.request.preservedLandmarks.every(point=>remaining.some(raw=>raw.id===point.id)),
  'a deleted user point stays deleted even when its refined pixels had detected origin');
 assert.deepEqual(next.request.constraints.landmarks,remaining);
});

test('downstream automatic retries retain prior connection proof for later local repair',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const prior=await prepareAssistedAttempt(p,{revision:1,inputs:context.inputs,regions:request.regions,...request.constraints});
 cpSync(dirs(p).sparse,dirs(prior.project).sparse,{recursive:true});
 const signature=await import('./lib/pipeline.mjs').then(m=>m.geometrySignature(resolve(dirs(prior.project).sparse,'0')));
 const gate={verdict:'pass',geometryValidationVersion:1,geometryConnected:true,selectedModel:'0',models:[{name:'0',geometrySignature:signature,geometryComponentSizes:[6]}]};
 writeFileSync(resolve(dirs(prior.project).summary,'gate.json'),JSON.stringify(gate));
 const bridge={accepted:true,regions:request.regions,retainedLandmarks:request.constraints.landmarks};
 writeAttempt(p,{...prior.attempt,status:'verified',result:{selectedModel:'0',gate,geometrySignature:signature,bridges:bridge,localRepair:null}});
 const retry=await prepareAutomaticAttempt({...prior.project,selectedModel:'0'},'undistort');
 assert.equal(retry.attempt.result.bridges?.accepted,true);
 const localRepair={photoIds:context.catalog.slice(3).map(p=>p.photoId),referencePhotoIds:context.catalog.slice(0,3).map(p=>p.photoId),contextPhotoIds:[],refineCornerIds:[],excludedPlanarInteriors:[]};
 const next=await prepareAssistedAttempt(p,{revision:2,inputs:context.inputs,sourceAttemptId:retry.attempt.id,regions:[{id:'whole',model:'0',photoIds:context.catalog.map(p=>p.photoId)}],...request.constraints,localRepair});
 assert.equal(next.request.priorBridgeChecks.length,1);
 assert.deepEqual(next.request.priorBridgeChecks[0].constraints.landmarks,bridge.retainedLandmarks);
 assert.deepEqual(next.request.preservedLandmarks,bridge.retainedLandmarks,'effective source observations survive an automatic retry without an assisted input file');
 // Old automatic attempts already on disk did not retain this field.
 writeAttempt(p,{...retry.attempt,result:{...retry.attempt.result,bridges:null,localRepair:null}});
 const legacy=await prepareAssistedAttempt(p,{revision:3,inputs:context.inputs,sourceAttemptId:retry.attempt.id,regions:[{id:'whole',model:'0',photoIds:context.catalog.map(p=>p.photoId)}],...request.constraints,localRepair});
 assert.equal(legacy.request.priorBridgeChecks.length,1,'recover historical proof through the server-owned source chain');
});
test('an explicit component can use geometry alone; unified reconstruction still requires matches',async t=>{
 const {p}=fixture(t);unlinkSync(resolve(dirs(p).sfm,'database.db'));
 await assert.rejects(getContext(p,{fresh:true}),/匹配数据库/);
 const context=await getContext({...p,componentSource:{projectId:'parent',model:'0',index:0}},{fresh:true});
 assert.equal(context.matchingAvailable,false);assert.equal(context.inputs.matchingContentSha256,'unavailable');assert.equal(context.catalog.length,6);
});
test('coverage-only retries retain full matching inputs as well as the geometric database',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const record={revision:1,inputs:context.inputs,sourceAttemptId:null,regions:request.regions,...request.constraints};
 const assisted=await prepareAssistedAttempt(p,record),ad=dirs(assisted.project);
 cpSync(dirs(p).sparse,ad.sparse,{recursive:true});cpSync(context.database,resolve(ad.sfm,'database.db'));
 execFileSync(TOOLS.python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('delete from descriptors'); c.commit(); c.close()",resolve(ad.sfm,'database.db')],{windowsHide:true});
 const sourceContext=await getContext(assisted.project,{fresh:true}),retry=await prepareAutomaticAttempt(assisted.project,'gate'),next=await getContext(retry.project,{fresh:true});
 assert.ok(sameInputs(sourceContext.inputs,next.inputs),'rechecking coverage must not switch from full features to the compact geometric DB');
});

test('a failed assisted attempt can restart sparse reconstruction from its frozen full matches',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const record={revision:1,inputs:context.inputs,sourceAttemptId:null,regions:request.regions,...request.constraints};
 const assisted=await prepareAssistedAttempt(p,record);
 const retry=await prepareAutomaticAttempt({...assisted.project,pendingAttemptId:assisted.attempt.id},'sparse');
 const next=await getContext(retry.project,{fresh:true});
 assert.equal(next.inputs.matchingContentSha256,context.inputs.matchingContentSha256);
});

test('rematching an assisted model uses retained descriptors instead of the compact geometric database',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const record={revision:1,inputs:context.inputs,sourceAttemptId:null,regions:request.regions,...request.constraints};
 const assisted=await prepareAssistedAttempt(p,record),ad=dirs(assisted.project);
 cpSync(context.database,resolve(ad.sfm,'database.db'));
 execFileSync(TOOLS.python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('delete from descriptors'); c.commit(); c.close()",resolve(ad.sfm,'database.db')],{windowsHide:true});
 const retry=await prepareAutomaticAttempt({...assisted.project,pendingAttemptId:assisted.attempt.id},'match');
 const check="import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from assistance_inputs import matching_content_signature; assert matching_content_signature(Path(sys.argv[2]))==sys.argv[3]";
 execFileSync(TOOLS.python,['-c',check,PY_DIR,resolve(dirs(retry.project).sfm,'database.db'),context.inputs.matchingContentSha256],{windowsHide:true});
});
test('retries reuse only same-input native regional candidates, never their validation status',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});const record={revision:1,inputs:context.inputs,sourceAttemptId:null,regions:request.regions,...request.constraints};
 const previous=await prepareAssistedAttempt(p,record),folder=resolve(dirs(previous.project).workspace,'regional-candidates/sparse/0');mkdirSync(folder,{recursive:true});cpSync(resolve(dirs(p).sparse,'0'),folder,{recursive:true});
 writeAttempt(p,{...previous.attempt,status:'needs_input'});
 const next=await prepareAssistedAttempt(p,{...record,revision:2,lastAttemptId:previous.attempt.id});
 assert.equal(next.request.regionalCandidates?.length??0,1);assert.ok(next.request.regionalCandidates[0].modelSignature);assert.notEqual(next.attempt.status,'verified');
 writeAttempt(p,{...next.attempt,status:'needs_input'});
 const third=await prepareAssistedAttempt(p,{...record,revision:3,lastAttemptId:next.attempt.id});
 assert.equal(third.request.regionalCandidates?.length??0,1,'a candidate must survive repeated retries, not just the first reuse');
 assert.equal(third.request.regionalCandidates[0].modelSignature,next.request.regionalCandidates[0].modelSignature);
 assert.notEqual(third.attempt.status,'verified');
 writeAttempt(p,{...previous.attempt,status:'needs_input',inputFingerprint:{...previous.attempt.inputFingerprint,photosSha256:'other-photos'}});
 const unrelated=await prepareAssistedAttempt(p,{...record,lastAttemptId:previous.attempt.id});assert.equal(unrelated.request.regionalCandidates?.length??0,0);
});

test('local retries freeze a same-input native seed from the verified source after a failed attempt',async t=>{
 const {p,request}=fixture(t),context=await getContext(p,{fresh:true});
 const record={revision:1,inputs:context.inputs,sourceAttemptId:null,regions:request.regions,...request.constraints};
 const prior=await prepareAssistedAttempt(p,record),pd=dirs(prior.project);
 cpSync(dirs(p).sparse,pd.sparse,{recursive:true});
 const native=resolve(pd.sfm,'local-native/sparse/0');mkdirSync(native,{recursive:true});cpSync(resolve(dirs(p).sparse,'0'),native,{recursive:true});
 writeAttempt(p,{...prior.attempt,status:'verified',result:{bridges:{accepted:true,regions:request.regions,retainedLandmarks:request.constraints.landmarks}}});
 const failed=await prepareAssistedAttempt(p,{...record,revision:2,sourceAttemptId:prior.attempt.id});writeAttempt(p,{...failed.attempt,status:'needs_input'});
 const next=await prepareAssistedAttempt(p,{...record,revision:3,sourceAttemptId:prior.attempt.id,lastAttemptId:failed.attempt.id});
 assert.ok(next.request.regionalCandidates.some(c=>c.sourceAttemptId===prior.attempt.id));
 const frozen=next.request.regionalCandidates.find(c=>c.sourceAttemptId===prior.attempt.id);
 assert.notEqual(frozen.path,native);assert.ok(frozen.modelSignature);assert.notEqual(next.attempt.status,'verified');
});
