import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync,utimesSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import * as quality from './lib/quality.mjs';
import * as projects from './lib/projects.mjs';
import {dirs,geometrySignature,buildSteps} from './lib/pipeline.mjs';
import {atomicJson,newRecord,updateAssistance,readAssistance} from './lib/assistance.mjs';
import * as assistance from './lib/assistance.mjs';
function fixture(t){
 const p={id:`test-assist-quality-${randomBytes(4).toString('hex')}`,name:'fixture',state:'done',selectedModel:'0',trainingPreset:'full',steps:buildSteps().map(s=>({...s,status:'success'}))},d=dirs(p);
 for(const folder of [d.summary,d.train,d.images,resolve(d.sparse,'0')])mkdirSync(folder,{recursive:true});
 for(const name of ['images.bin','cameras.bin','points3D.bin'])writeFileSync(resolve(d.sparse,'0',name),'fixture');
 const photos=[{photoId:'a',name:'a.jpg',width:100,height:80},{photoId:'b',name:'b.jpg',width:100,height:80}];
 const gate={verdict:'pass',geometryValidationVersion:1,geometryConnected:true,selectedModel:'0',models:[{name:'0',geometrySignature:geometrySignature(resolve(d.sparse,'0')),geometryComponentSizes:[2],geometryComponents:[{index:0,registered:2,images:['a.jpg','b.jpg']}],unregistered:[]}]};
 atomicJson(resolve(d.summary,'gate.json'),gate);atomicJson(d.manifest,{records:photos.map(p=>({sha256:p.photoId,work_image:`images/${p.name}`}))});
 writeFileSync(resolve(d.train,'export_30000.ply'),'fixture-ply');projects.write(p);
 updateAssistance(p,()=>({...newRecord({catalog:photos,regions:[{id:'0:0',photoIds:['a','b']}]}),state:'verified',sourceAttemptId:null}));
 t.after(()=>rmSync(d.root,{recursive:true,force:true}));return {p,d,photos,gate,signature:gate.models[0].geometrySignature};
}
const review=appearance=>({appearance,requestPositionCheck:false,items:['doorway','ghosting','proportions','coverage'].map(code=>({code,status:appearance,photoIds:['a'],regionIds:['0:0'],note:appearance==='passed'?'已检查':'仍有重影'}))});
test('full training alone never approves geometry, coverage and appearance',t=>{
 const {p}=fixture(t);const q=quality.qualityFor(p);assert.equal(q.trainingComplete,true);assert.equal(q.complete,false);assert.equal(q.appearance,'unreviewed');
});
test('review is bound to geometry; a failed bathroom review remains incomplete',t=>{
 const {p,d,signature}=fixture(t);
 let q=quality.saveReview(p,{expectedRevision:0,attemptId:null,geometrySignature:signature,review:review('needs_improvement')});assert.equal(q.appearance,'needs_improvement');assert.equal(q.complete,false);
 q=quality.saveReview(p,{expectedRevision:1,attemptId:null,geometrySignature:signature,review:review('passed')});assert.equal(q.complete,true);
 writeFileSync(resolve(d.sparse,'0/images.bin'),'changed geometry');assert.equal(quality.qualityFor(p).appearance,'unreviewed');assert.notEqual(quality.qualityFor(p).geometry,'verified');
});

test('changing only a COLMAP frame or rig invalidates cached geometry and appearance',t=>{
 for(const name of ['frames.bin','rigs.bin'])for(const change of ['content','remove','add']){
  const {p,d,gate}=fixture(t),folder=resolve(d.sparse,'0');if(change!=='add')writeFileSync(resolve(folder,name),'original pose');
  gate.models[0].geometrySignature=geometrySignature(folder);atomicJson(resolve(d.summary,'gate.json'),gate);
  const q=quality.saveReview(p,{expectedRevision:0,attemptId:null,geometrySignature:gate.models[0].geometrySignature,review:review('passed')});
  assert.equal(q.complete,true);
  if(change==='remove')unlinkSync(resolve(folder,name));else writeFileSync(resolve(folder,name),'changed pose');
  assert.equal(quality.qualityFor(p).geometry,'unverified',`${name} changes the actual camera pose`);
  assert.equal(quality.qualityFor(p).appearance,'unreviewed');
 }
});
test('input changes and a requested position check invalidate completion',t=>{
 const {p,signature}=fixture(t);updateAssistance(p,r=>({...r,state:'stale'}));assert.notEqual(quality.qualityFor(p).geometry,'verified');
 updateAssistance(p,r=>({...r,state:'verified'}));const r=review('needs_improvement');r.requestPositionCheck=true;
 quality.saveReview(p,{expectedRevision:0,attemptId:null,geometrySignature:signature,review:r});
 assert.equal(readAssistance(p).state,'needs_input');assert.ok(readAssistance(p).questions.some(q=>q.type==='position_review'));assert.equal(projects.read(p.id).state,'needs_input');
});
test('a complete appearance review checks all required items',t=>{
 const {p,signature}=fixture(t);
 assert.throws(()=>quality.saveReview(p,{expectedRevision:0,attemptId:null,geometrySignature:signature,review:{appearance:'passed',items:[],requestPositionCheck:false}}),{code:400});
});
test('evaluation comparisons freeze the same photographs across checkpoints',t=>{
 const {p,d}=fixture(t);
 for(const step of [1000,30000]){mkdirSync(resolve(d.train,`eval_${step}`));for(const name of ['a.png','b.png',...(step===30000?['other.png']:[])])writeFileSync(resolve(d.train,`eval_${step}`,name),'render');}
 assert.equal(typeof quality.evaluationFor,'function');const result=quality.evaluationFor(p);
 assert.deepEqual(result.photos.map(p=>p.name),['a.png','b.png']);assert.deepEqual(result.steps,[1000,30000]);
 writeFileSync(resolve(d.train,'eval_1000/later.png'),'later render');assert.deepEqual(quality.evaluationFor(p).photos.map(p=>p.name),['a.png','b.png']);
});
test('new geometry rebinds region references and preserves old labels for inspection',()=>{
 assert.equal(typeof assistance.rebaseRecordGeometry,'function');
 const record={regions:[{id:'0:0',photoIds:['a']},{id:'0:1',photoIds:['b']}],regionLabels:[{regionId:'0:1',label:'卧室'}],objects:[{id:'o',regions:['0:1']}],coverage:[{photoId:'c',decision:'existing',regionId:'0:1'}],answers:[],questions:[]};
 const result=assistance.rebaseRecordGeometry(record,{regions:[{id:'0:0',photoIds:['a','b']}],questions:[],unregistered:['c']},[{photoId:'a'},{photoId:'b'},{photoId:'c'}]);
 assert.equal(result.coverage[0].regionId,'0:0');assert.deepEqual(result.objects[0].regions,['0:0']);assert.deepEqual(result.regionLabels,[]);assert.equal(result.previousLabels[0].label,'卧室');
});
test('an explicit recheck can refresh cached validation after identical files are rewritten',t=>{
 const {p,d}=fixture(t);assert.equal(quality.qualityFor(p).geometry,'verified');
 const path=resolve(d.sparse,'0/images.bin');writeFileSync(path,'fixture');utimesSync(path,new Date(),new Date(Date.now()+5000));assert.equal(quality.qualityFor(p).geometry,'unverified');
 assert.equal(quality.qualityFor(p,{fresh:true}).geometry,'verified');
});
test('a fully automatic connected project can save its first appearance review',t=>{
 const {p,d,signature,photos}=fixture(t);unlinkSync(resolve(d.root,'assistance.json'));
 const q=quality.saveReview(p,{expectedRevision:0,attemptId:null,geometrySignature:signature,review:review('passed'),catalog:photos});
 assert.equal(q.complete,true);assert.equal(readAssistance(p).revision,1);assert.equal(readAssistance(p).state,'verified');
});
