import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAssistance, saveAssistance, validatePatch } from './lib/assistance.mjs';

const photos = [1,2,3,4].map(n=>({photoId:String(n).repeat(64),name:`group/photo-${n}.jpg`,width:1000,height:800,regionId:n<3?'r1':'r2'}));
const catalog = {photos,regions:[{id:'r1'},{id:'r2'}],questions:[{id:'same',type:'same_object',options:['yes','no','unknown']}]};
const inputs = {photosSha256:'photos',matchingContentSha256:'matches',matchingSnapshotSha256:'snapshot',geometrySha256:'geometry',configSha256:'config'};
const valid = ()=>({answers:[{questionId:'same',value:'yes'}],regionLabels:[],objects:[],landmarks:[],dimensions:[],coverage:[],onlyExistingPhotos:true});
function fixture(t){ const root=mkdtempSync(join(tmpdir(),'gauss-assist-')); t.after(()=>rmSync(root,{recursive:true,force:true}));return {id:'fixture',root}; }

test('revision conflict keeps the latest answer byte for byte',t=>{
  const p=fixture(t);
  const saved=saveAssistance(p,{expectedRevision:0,patch:valid(),catalog,inputs});
  assert.equal(saved.revision,1);
  const bytes=readFileSync(join(p.root,'assistance.json'),'utf8');
  assert.throws(()=>saveAssistance(p,{expectedRevision:0,patch:valid(),catalog,inputs}),{code:409});
  assert.equal(readFileSync(join(p.root,'assistance.json'),'utf8'),bytes);
  assert.deepEqual(readAssistance(p),saved);
  assert.equal(saved.state,'needs_input','confirming the same door is not a geometric observation');
});
test('invalid observations never change the saved record',t=>{
  const p=fixture(t);saveAssistance(p,{expectedRevision:0,patch:valid(),catalog,inputs});
  const before=readFileSync(join(p.root,'assistance.json'),'utf8');
  for(const xy of [[NaN,10],[Infinity,10],[-1,0],[1000,0],[10,800]]){
    const patch=valid();patch.landmarks=[{id:'p1',objectId:null,observations:[{photoId:photos[0].photoId,xy,origin:'manual'}]}];
    assert.throws(()=>saveAssistance(p,{expectedRevision:1,patch,catalog,inputs}),{code:400});
  }
  assert.equal(readFileSync(join(p.root,'assistance.json'),'utf8'),before);
});
test('unknown references, duplicate observations and client result fields are rejected',()=>{
  let patch=valid();patch.landmarks=[{id:'p',observations:[{photoId:'missing',xy:[1,2],origin:'manual'}]}];
  assert.throws(()=>validatePatch(patch,catalog),{code:400});
  const obs={photoId:photos[0].photoId,xy:[10,20],origin:'manual'};
  patch={...valid(),landmarks:[{id:'p1',objectId:null,observations:[obs]},{id:'p2',objectId:null,observations:[obs]}]};
  assert.throws(()=>validatePatch(patch,catalog),{code:400});
  for(const extra of [{state:'verified'},{outputPath:'C:/outside'},{unknown:true}]) assert.throws(()=>validatePatch({...valid(),...extra},catalog),{code:400});
});
test('dimension sources, endpoints, limits and planar corners are checked',()=>{
  assert.throws(()=>validatePatch({...valid(),dimensions:[{id:'d',value:-1,unit:'cm',source:'measured',endpoints:null}]},catalog),{code:400});
  assert.throws(()=>validatePatch({...valid(),dimensions:[{id:'d',value:90,unit:'inch',source:'measured',endpoints:null}]},catalog),{code:400});
  assert.doesNotThrow(()=>validatePatch({...valid(),dimensions:[{id:'d',value:null,unit:'cm',source:'unknown',endpoints:null}]},catalog));
  assert.throws(()=>validatePatch({...valid(),regionLabels:Array(101).fill({regionId:'r1',label:'room'})},catalog),{code:400});
  assert.throws(()=>validatePatch({...valid(),objects:[{id:'o',kind:'planar',regions:['r1'],rois:[],corners:[{photoId:photos[0].photoId,xy:[[1,1],[2,2],[3,3]]}]}]},catalog),{code:400});
});
test('legacy projects have no assistance record',t=>assert.equal(readAssistance(fixture(t)),null));

test('local repair scope persists independently of annotation selection and old records default to null',t=>{
  const p=fixture(t),patch=valid();
  assert.equal(validatePatch(patch,catalog).localRepair,null);
  patch.localRepair={photoIds:photos.slice(2).map(p=>p.photoId),referencePhotoIds:photos.slice(0,2).map(p=>p.photoId)};
  const saved=saveAssistance(p,{expectedRevision:0,patch,catalog,inputs});
  assert.deepEqual(readAssistance(p).localRepair,saved.localRepair);
  assert.equal(saved.state,'needs_input','scope selection supplies no measured geometry');
  const bytes=readFileSync(join(p.root,'assistance.json'),'utf8');
  assert.throws(()=>saveAssistance(p,{expectedRevision:0,patch,catalog,inputs}),{code:409});
  assert.equal(readFileSync(join(p.root,'assistance.json'),'utf8'),bytes);
});

test('local repair rejects unknown IDs, overlap, duplicates and client geometry',()=>{
  const scope={photoIds:photos.slice(2).map(p=>p.photoId),referencePhotoIds:photos.slice(0,2).map(p=>p.photoId)};
  for(const extra of [{photoIds:['missing']},{referencePhotoIds:[photos[2].photoId]},{photoIds:[photos[2].photoId,photos[2].photoId]},{outputPath:'C:/outside'},{refineCornerIds:['unknown']},{excludedPlanarInteriors:[['a','b','c','d']]}]){
    assert.throws(()=>validatePatch({...valid(),localRepair:{...scope,...extra}},catalog),{code:400});
  }
});
test('answers and pixel observations survive a reload; edits clear verified state',t=>{
  const p=fixture(t),patch=valid();patch.landmarks=Array.from({length:8},(_,n)=>({id:`p${n}`,objectId:null,observations:photos.map(photo=>({photoId:photo.photoId,xy:[100+n*60,100+n*20],origin:'manual'}))}));
  const saved=saveAssistance(p,{expectedRevision:0,patch,catalog,inputs});
  assert.equal(saved.state,'ready');
  assert.deepEqual(readAssistance(p).landmarks,patch.landmarks);
  const updated=saveAssistance(p,{expectedRevision:1,patch:valid(),catalog,inputs});
  assert.equal(updated.revision,2);assert.equal(updated.state,'needs_input');assert.equal(updated.verifiedAgainst,null);
});
test('coverage-only questions do not force unnecessary point marking',t=>{
  const p=fixture(t),scope={...catalog,reasons:[{code:'coverage_unknown'}],photos:photos.map((p,i)=>({...p,unregistered:i===3}))};
  const patch=valid();patch.answers=[];patch.coverage=[{photoId:photos[3].photoId,decision:'existing',regionId:'r2'}];
  assert.equal(saveAssistance(p,{expectedRevision:0,patch,catalog:scope,inputs}).state,'ready');
  patch.coverage[0]={photoId:photos[3].photoId,decision:'new',regionId:null};
  assert.equal(saveAssistance(p,{expectedRevision:1,patch,catalog:scope,inputs}).state,'needs_input');
});

const localRoi=(id,selected)=>({id,kind:'points',regions:[],rois:selected.map(p=>({photoId:p.photoId,polygon:[[100,100],[800,100],[800,600],[100,600]]})),corners:[]});
const localScope=()=>({photoIds:photos.slice(2).map(p=>p.photoId),referencePhotoIds:photos.slice(0,2).map(p=>p.photoId)});

test('local repair can prepare real ROI matching without client detected points',t=>{
  const p=fixture(t),patch={...valid(),localRepair:localScope(),objects:[localRoi('shared-fixed-region',photos)]};
  const saved=saveAssistance(p,{expectedRevision:0,patch,catalog,inputs});
  assert.equal(saved.state,'ready','ready starts matching; it does not verify geometry');
  assert.equal(saved.verifiedAgainst,null);
  assert.deepEqual(saved.landmarks,[]);
  assert.deepEqual(saved.objects,patch.objects);
});

test('separate objects on either side are not a shared local ROI',t=>{
  const p=fixture(t),patch={...valid(),localRepair:localScope(),objects:[localRoi('first-only',photos.slice(0,2)),localRoi('second-only',photos.slice(2))]};
  const saved=saveAssistance(p,{expectedRevision:0,patch,catalog,inputs});
  assert.equal(saved.state,'needs_input');
  assert(saved.missing.some(m=>m.code==='local_scope_support_needed'));
});

test('a local ROI needs two photos on each side before matching',t=>{
  const p=fixture(t),patch={...valid(),localRepair:localScope(),objects:[localRoi('one-reference',[photos[0],...photos.slice(2)])]};
  assert.equal(saveAssistance(p,{expectedRevision:0,patch,catalog,inputs}).state,'needs_input');
});

test('automatic observation origins remain server owned',()=>{
  const patch={...valid(),landmarks:[{id:'untrusted-detection',objectId:null,observations:[{photoId:photos[0].photoId,xy:[120,150],origin:'detected'}]}]};
  assert.throws(()=>validatePatch(patch,catalog),{code:400});
});
