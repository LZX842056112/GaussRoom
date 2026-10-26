import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseAssistance, classifyToolFailure } from './lib/assistance-diagnosis.mjs';
import { deriveQuality } from './lib/quality.mjs';
const photos=Array.from({length:297},(_,i)=>({photoId:`hash-${i}`,name:`group/${i}.jpg`,width:1000,height:800}));
function fixtureGate(sizes){let offset=0;return {verdict:sizes.length===1?'pass':'split',geometryValidationVersion:1,geometryConnected:sizes.length===1,selectedModel:'0',models:[{name:'0',geometrySignature:'g',geometryComponentSizes:sizes,geometryComponents:sizes.map((count,index)=>({index,registered:count,images:photos.slice(offset,(offset+=count)).map(p=>p.name)})),unregistered:photos.slice(offset).map(p=>p.name)}],bridgeCandidates:[]};}
const diagnose=gate=>diagnoseAssistance({gate,catalog:photos,record:null,manualRequest:false});
test('split requires assistance even at full registration',()=>{
 for(const sizes of [[150,147],[149,146],[100,100,97],[296,1]]){
   const d=diagnose(fixtureGate(sizes));assert.equal(d.required,true);assert.equal(d.regions.length,sizes.length);assert.ok(d.questions.length>0);
 }
 assert.equal(diagnose(fixtureGate([297])).required,false);
});
test('unregistered photos cannot be hidden by 80 percent registration',()=>{
 const d=diagnose(fixtureGate([290]));assert.equal(d.required,true);
 assert.equal(d.questions.filter(q=>q.type==='coverage').length,7);
 for(const decision of ['new','unknown']){
  const record={coverage:[{photoId:photos[290].photoId,decision,regionId:null}]};
  assert.equal(diagnoseAssistance({gate:fixtureGate([290]),catalog:photos,record}).required,true);
 }
});
test('one connected component permits manual position review',()=>{
 const d=diagnoseAssistance({gate:fixtureGate([297]),catalog:photos,manualRequest:true});
 assert.equal(d.required,true);assert.ok(d.questions.some(q=>q.type==='position_review'));
});
test('candidate order never proves geometry and suspicious configurations stay visible',()=>{
 const gate=fixtureGate([150,147]);gate.bridgeCandidates=[{first:photos[0].name,second:photos[200].name,inliers:5000,configuration:'平面或纯旋转'}];
 const d=diagnose(gate);assert.equal(d.required,true);assert.ok(d.questions.some(q=>q.type==='same_object'&&q.warning));
 assert.deepEqual(d.questions.find(q=>q.type==='same_object').options,['yes','no','unknown']);
 assert.ok(d.questions.find(q=>q.type==='same_object').allowManualSelection);
 assert.ok(d.questions.some(q=>q.type==='door_relation'&&q.options.includes('unknown')));
});
test('tool errors are failures and training completion is not quality approval',()=>{
 for(const error of ['calibration failed','disk full','missing executable','database malformed'])assert.equal(classifyToolFailure(error),'failed');
 const q=deriveQuality({selectedModel:'0',activeAttemptId:null},{gate:fixtureGate([297]),record:null,review:null,training:{step:30000,totalSteps:30000,attemptId:null}});
 assert.equal(q.geometry,'verified');assert.equal(q.appearance,'unreviewed');assert.equal(q.scale,'unmeasured');assert.equal(q.complete,false);
 assert.equal(deriveQuality({}, {gate:{verdict:'pass'},training:null}).geometry,'unverified');
});
