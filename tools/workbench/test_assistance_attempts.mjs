import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createAttempt, readAttempt, adoptAttempt, listAttempts, writeAttempt } from './lib/attempts.mjs';
import { atomicJson } from './lib/assistance.mjs';
import { existsSync, cpSync, unlinkSync } from 'node:fs';
import { dirs, geometrySignature } from './lib/pipeline.mjs';
import * as projects from './lib/projects.mjs';

const inputs={photosSha256:'photos',matchingContentSha256:'matches',matchingSnapshotSha256:'snapshot',geometrySha256:'geometry',configSha256:'config'};
function fixture(t){const root=mkdtempSync(resolve(tmpdir(),'attempt-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const p={id:'fixture',root,mapper:'global',selectedModel:'0',steps:[]};atomicJson(resolve(root,'project.json'),p);return p;}
function verified(p,attempt){const d=dirs(p,{attemptId:attempt.id}),model=resolve(d.sparse,'0');mkdirSync(model,{recursive:true});for(const f of ['cameras.bin','images.bin','points3D.bin'])writeFileSync(resolve(model,f),f);const signature=geometrySignature(model);const gate={verdict:'pass',geometryValidationVersion:1,geometryConnected:true,selectedModel:'0',models:[{name:'0',geometrySignature:signature,geometryComponentSizes:[4]}]};atomicJson(resolve(d.summary,'gate.json'),gate);attempt.status='verified';attempt.result={selectedModel:'0',geometrySignature:signature,gate,bridges:{accepted:true}};writeAttempt(p,attempt);return attempt;}

test('failed or stale attempt preserves the old active scene',t=>{
 const p=fixture(t);mkdirSync(dirs(p).train,{recursive:true});writeFileSync(resolve(dirs(p).train,'export_30000.ply'),'old model');
 const a=createAttempt(p,{kind:'assisted',inputRevision:2,inputFingerprint:inputs});
 assert.throws(()=>adoptAttempt(p,a,{currentRevision:2,currentFingerprint:inputs}),{code:409});
 verified(p,a);
 assert.throws(()=>adoptAttempt(p,a,{currentRevision:3,currentFingerprint:inputs}),{code:409});
 assert.equal(JSON.parse(readFileSync(resolve(p.root,'project.json'),'utf8')).activeAttemptId,undefined);
 assert.equal(projects.latestExport(p).name,'export_30000.ply');
 assert.throws(()=>adoptAttempt(p,a,{currentRevision:2,currentFingerprint:{...inputs,matchingContentSha256:'changed'}}),{code:409});
});
test('old PLY is not an export of a new verified geometry',t=>{
 const p=fixture(t);mkdirSync(dirs(p).train,{recursive:true});writeFileSync(resolve(dirs(p).train,'export_30000.ply'),'old model');
 const a=verified(p,createAttempt(p,{kind:'assisted',inputRevision:2,inputFingerprint:inputs}));
 p.trainingResume={step:5000,geometrySignature:'old-geometry'};
 const adopted=adoptAttempt(p,a,{currentRevision:2,currentFingerprint:inputs});
 assert.equal(adopted.activeAttemptId,a.id);assert.equal(projects.latestExport(adopted),null);
 assert.equal(adopted.trainingResume,undefined,'new geometry cannot inherit an old checkpoint');
 assert.equal(readAttempt(p,a.id).status,'verified');assert.equal(listAttempts(p).length,1);
 assert.equal(readFileSync(resolve(p.root,'train/export_30000.ply'),'utf8'),'old model');
});
test('legacy paths still resolve and attempt paths cannot escape',t=>{
 const p=fixture(t);assert.equal(dirs(p).train,resolve(p.root,'train'));
 const a=createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null});
 assert.equal(dirs(p,{attemptId:a.id}).root,p.root);
 assert.equal(dirs(p,{attemptId:a.id}).images,resolve(p.root,'attempts',a.id,'inputs/images'));
 assert.throws(()=>readAttempt(p,'../../outside'),{code:400});
 assert.throws(()=>dirs(p,{attemptId:'../../outside'}),{code:400});
});

test('a junction in a new attempt ancestor is rejected before any external write',t=>{
 const p=fixture(t),outside=mkdtempSync(resolve(tmpdir(),'outside-attempt-'));
 t.after(()=>rmSync(outside,{recursive:true,force:true}));
 writeFileSync(resolve(outside,'sentinel.txt'),'keep');
 symlinkSync(outside,resolve(p.root,'attempts'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null}),/越界/);
 assert.deepEqual(readdirSync(outside),['sentinel.txt'],'must reject before mkdir, source snapshot or photo copying');
});
test('adoption checks the actual final geometry signature again',t=>{
 const p=fixture(t),a=verified(p,createAttempt(p,{kind:'assisted',inputRevision:2,inputFingerprint:inputs}));
 writeFileSync(resolve(dirs(p,{attemptId:a.id}).sparse,'0/images.bin'),'changed');
 assert.throws(()=>adoptAttempt(p,a,{currentRevision:2,currentFingerprint:inputs}),{code:409});
});

test('local repair adoption requires the complete local proof',t=>{
 const p=fixture(t),a=verified(p,createAttempt(p,{kind:'assisted',inputRevision:2,inputFingerprint:inputs}));
 a.localRepairRequired=true;writeAttempt(p,a);
 assert.throws(()=>adoptAttempt(p,a,{currentRevision:2,currentFingerprint:inputs}),{code:409});
 a.result.localRepair={accepted:false};writeAttempt(p,a);
 assert.throws(()=>adoptAttempt(p,a,{currentRevision:2,currentFingerprint:inputs}),{code:409});
 a.result.localRepair={accepted:true};writeAttempt(p,a);
 assert.equal(adoptAttempt(p,a,{currentRevision:2,currentFingerprint:inputs}).activeAttemptId,a.id);
});
test('component selection can use a pending attempt without inheriting its pointer',t=>{
 const id='test-component-pending',p={id,name:'pending',mapper:'global',state:'needs_input',trainingPreset:'full',steps:[]};
 const base=dirs(p);mkdirSync(resolve(base.sparse,'0'),{recursive:true});mkdirSync(base.images,{recursive:true});
 for(const name of ['images.bin','points3D.bin'])writeFileSync(resolve(base.sparse,'0',name),name);
 const names=['a.jpg','b.jpg','c.jpg'];for(const name of names)writeFileSync(resolve(base.images,name),'photo');
 atomicJson(base.manifest,{records:names.map(name=>({work_image:`images/${name}`,camera_group:'group',excluded:null,sha256:name}))});
 const attempt=createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null}),d=dirs(p,{attemptId:attempt.id});
 cpSync(base.sparse,d.sparse,{recursive:true});
 atomicJson(d.manifest,{records:names.map(name=>({work_image:`inputs/images/${name}`,camera_group:'group',excluded:null,sha256:name}))});
 unlinkSync(base.manifest);
 atomicJson(resolve(d.summary,'gate.json'),{geometryValidationVersion:1,verdict:'split',models:[{name:'0',geometrySignature:geometrySignature(resolve(d.sparse,'0')),geometryComponents:[{index:0,registered:3,imageIds:[1,2,3],images:names}]}]});
 p.pendingAttemptId=attempt.id;projects.write(p);let child;
 t.after(()=>{if(child)rmSync(dirs(child).root,{recursive:true,force:true});rmSync(base.root,{recursive:true,force:true});});
 child=projects.createComponent(id,{model:'0',component:0});
 assert.equal(child.activeAttemptId,undefined);assert.equal(child.pendingAttemptId,undefined);
 assert.equal(child.sourceImageCount,3);assert.ok(existsSync(resolve(dirs(child).sfm,'component-source/images.bin')));
 const manifest=JSON.parse(readFileSync(dirs(child).manifest,'utf8'));
 assert.ok(manifest.records.every(r=>r.work_image.startsWith('images/')));
});
