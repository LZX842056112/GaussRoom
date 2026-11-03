import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {buildSteps,dirs,matchingDatabase} from './lib/pipeline.mjs';
import * as projects from './lib/projects.mjs';
import {importPhotos} from './lib/assistance-import.mjs';
import {createAttempt} from './lib/attempts.mjs';
import {isOwnedProcess,startAssistance,busyId} from './lib/jobs.mjs';
import {PY_DIR,PROJECTS_DIR} from './lib/paths.mjs';

function fixture(t){
 const root=mkdtempSync(resolve(tmpdir(),'mobile-pipeline-')),capture=resolve(root,'capture');
 mkdirSync(capture);writeFileSync(resolve(capture,'manifest.json'),'{}');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 return {id:'mobile-fixture',root,name:'scan',sourceDir:resolve(capture,'images'),inputKind:'arkit_scan',
  capture:{format:'gaussroom_scan_v1',scanId:randomUUID(),root:capture,manifestSha256:createHash('sha256').update('{}').digest('hex')},
  trainingPreset:'standard',cameraModel:'PINHOLE',useGpu:false,mapper:'incremental',steps:buildSteps().map(s=>({id:s.id,status:'pending'}))};
}

test('mobile capture uses calibrated features and fixed-pose sparse commands in the same seven stages',t=>{
 const p=fixture(t),steps=buildSteps(),features=steps.find(s=>s.id==='features').command(p),sparse=steps.find(s=>s.id==='sparse').command(p);
 assert.deepEqual(steps.map(s=>s.id),['prepare','features','match','sparse','gate','undistort','train']);
 assert.equal(features.args[0],resolve(PY_DIR,'arkit_reconstruct.py'));
 assert.equal(features.args[1],'features');assert.equal(features.args[features.args.indexOf('--scan')+1],p.capture.root);
 assert.equal(sparse.args[1],'sparse');assert.equal(sparse.args[sparse.args.indexOf('--manifest')+1],dirs(p).manifest);
 assert.equal(steps.find(s=>s.id==='gate').command(p).args.includes('--min-points'),true);
 assert.equal(steps.find(s=>s.id==='features').command({...p,inputKind:'photos'}).args[0],'feature_extractor');
});

test('a changed or foreign capture is rejected before calibrated commands can run',t=>{
 const p=fixture(t),features=buildSteps().find(s=>s.id==='features');
 writeFileSync(resolve(p.capture.root,'manifest.json'),'changed');
 assert.throws(()=>features.command(p),{code:409});
 assert.throws(()=>features.command({...p,capture:{...p.capture,root:resolve(p.root,'..')}}),{code:409});
});

test('attempt scope retains immutable capture while work image paths change',t=>{
 const p=fixture(t),attempt=createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null});
 const scoped={...p,activeAttemptId:attempt.id},args=buildSteps().find(s=>s.id==='sparse').command(scoped).args;
 assert.equal(args[args.indexOf('--scan')+1],p.capture.root);
 assert.equal(args[args.indexOf('--images')+1],resolve(p.root,'attempts',attempt.id,'inputs/images'));
 const saved=JSON.parse(readFileSync(resolve(p.root,'attempts',attempt.id,'inputs/source-project.json'),'utf8'));
 assert.equal(saved.capture.manifestSha256,p.capture.manifestSha256);
});

test('mobile summaries expose source kind and sensor scale without private capture paths',t=>{
 const p=fixture(t),summary=projects.summarise(p);
 assert.equal(summary.inputKind,'arkit_scan');assert.equal(summary.capture.scanId,p.capture.scanId);
 assert.equal(summary.capture.root,undefined);assert.equal(summary.quality.scale,'unmeasured');
 assert.equal(summary.scaleSource,'lidar');
 assert.equal(projects.summarise({...p,inputKind:undefined,capture:undefined}).inputKind,'photos');
});

test('phone calibration is immutable and extra uncalibrated photos cannot enter a phone scan',t=>{
 const p=fixture(t),id=`mobile-calibration-${randomUUID().slice(0,8)}`,diskRoot=resolve(PROJECTS_DIR,id);
 projects.write({...p,id});t.after(()=>rmSync(diskRoot,{recursive:true,force:true}));
 assert.throws(()=>projects.update(id,{cameraModel:'OPENCV'}),{code:409});
 assert.throws(()=>projects.update(id,{mapper:'global'}),{code:409});
 assert.throws(()=>importPhotos({id},{expectedRevision:0,sourceDir:p.root}),{code:409});
 assert.equal(projects.read(id).cameraModel,'PINHOLE');
});

test('mobile matching never selects a stale global database and its subprocess is owned',t=>{
 const p=fixture(t);mkdirSync(dirs(p).sfm,{recursive:true});writeFileSync(resolve(dirs(p).sfm,'database-global.db'),'stale');
 assert.equal(matchingDatabase({...p,mapper:'global'}),resolve(dirs(p).sfm,'database.db'));
 const script=resolve(PY_DIR,'arkit_reconstruct.py');
 assert.equal(isOwnedProcess({childScript:script},{name:'python.exe',commandLine:`python.exe "${script}" sparse`}),true);
});

test('only the internal create option can allocate an import ID and it cannot overwrite a project',t=>{
 const root=mkdtempSync(resolve(tmpdir(),'mobile-create-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(resolve(root,'one.jpg'),'one');writeFileSync(resolve(root,'two.jpg'),'two');
 const id=`mobile-internal-${randomUUID().slice(0,8)}`,data={name:'allocation',sourceDir:root,trainingPreset:'standard',id:'client-injected'};
 const p=projects.create(data,{id});t.after(()=>rmSync(resolve(PROJECTS_DIR,id),{recursive:true,force:true}));
 assert.equal(p.id,id);assert.throws(()=>projects.create(data,{id}),{code:409});
 const normal=projects.create(data);t.after(()=>rmSync(resolve(PROJECTS_DIR,normal.id),{recursive:true,force:true}));
 assert.notEqual(normal.id,'client-injected');assert.equal(normal.inputKind,'photos');
 assert.throws(()=>projects.create(data,{id:'../escape'}),{code:400});
});

test('manual assisted solving cannot replace fixed mobile poses with an unconstrained mapper',async t=>{
 const p=fixture(t),id=`mobile-assisted-${randomUUID().slice(0,8)}`;
 p.id=id;p.steps.forEach((s,i)=>{if(i<3)s.status='success';});projects.write(p);
 t.after(()=>rmSync(resolve(PROJECTS_DIR,id),{recursive:true,force:true}));
 writeFileSync(resolve(p.root,'assistance.json'),JSON.stringify({version:1,revision:1,state:'ready',reasons:[{code:'geometry_split'}]}));
 let job;
 try {
  assert.throws(()=>{job=startAssistance(id,{expectedRevision:1},{prepareAssistedAttempt:async()=>{throw new Error('must not reach unconstrained solver');}});},
   error=>error.code===409&&error.message.includes('补扫'));
  assert.equal(busyId(),null);
 } finally {if(job)await job.done;}
});
