import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const imports=await import('./lib/assistance-import.mjs').catch(()=>({}));
import * as projects from './lib/projects.mjs';
import {dirs,buildSteps} from './lib/pipeline.mjs';
import {atomicJson,newRecord,readAssistance,updateAssistance} from './lib/assistance.mjs';
import {createAttempt} from './lib/attempts.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,{record=true,name='old.png',bytes='original photo'}={}){
 const p={id:`test-assist-import-${randomBytes(4).toString('hex')}`,name:'Import fixture',sourceDir:'initial readonly source',state:'needs_input',steps:buildSteps().map(s=>({...s,status:'success'}))},d=dirs(p);
 mkdirSync(d.images,{recursive:true});mkdirSync(d.summary,{recursive:true});const photo={photoId:sha(bytes),sourceSha256:sha(bytes),workSha256:sha('work'),name,width:100,height:80};writeFileSync(resolve(d.images,name),'work');
 atomicJson(d.manifest,{records:[{sha256:photo.photoId,work_image:`images/${name}`,work_size:[100,80],work_sha256:photo.workSha256}],retained_count:1});projects.write(p);
 if(record)updateAssistance(p,()=>({...newRecord({catalog:[photo],regions:[{id:'0:0',photoIds:[photo.photoId]}]}),questions:[{id:'q',type:'same_object',photoIds:[photo.photoId],options:['yes','no','unknown']}],answers:[{questionId:'q',value:'yes'}],landmarks:[{id:'p',objectId:null,observations:[{photoId:photo.photoId,xy:[25,30],origin:'manual'}]}]}));
 t.after(()=>rmSync(d.root,{recursive:true,force:true}));return {p,d,photo};
}
test('renamed photos offer explicit facts; new projects never inherit automatically',t=>{
 const source=fixture(t),target=fixture(t,{record:false,name:'renamed.png'});
 assert.equal(typeof imports.previewFactReuse,'function');
 assert.equal(readAssistance(target.p),null);
 const preview=imports.previewFactReuse(target.p,source.p.id);assert.equal(preview.photos.length,1);assert.ok(preview.answers.length>=2);
 const record=imports.reuseFacts(target.p,{expectedRevision:0,sourceProjectId:source.p.id,answerIds:preview.answers.map(a=>a.id)});
 assert.notEqual(record.state,'verified');assert.equal(record.landmarks.length,1);assert.equal(record.answers[0].value,'yes');
 assert.equal(readAssistance(source.p).revision,0);
});
test('same names with different source bytes cannot reuse any fact',t=>{
 const source=fixture(t),target=fixture(t,{record:false,bytes:'different photo'});
 const preview=imports.previewFactReuse(target.p,source.p.id);assert.equal(preview.photos.length,0);assert.equal(preview.answers.length,0);
 assert.throws(()=>imports.reuseFacts(target.p,{expectedRevision:0,sourceProjectId:source.p.id,answerIds:['unknown']}),{code:400});
});
test('coordinate reuse refuses changed work-image direction or size',t=>{
 const source=fixture(t),target=fixture(t);const r=readAssistance(target.p);r.photos[0].width=80;r.photos[0].height=100;updateAssistance(target.p,()=>r);
 const preview=imports.previewFactReuse(target.p,source.p.id);assert.ok(preview.conflicts.length);assert.equal(preview.answers.filter(a=>a.kind==='landmark').length,0);
});
test('explicit measured dimensions keep linked points but never inherit scale verification',t=>{
 const source=fixture(t),target=fixture(t,{record:false});
 updateAssistance(source.p,current=>({...current,landmarks:[...current.landmarks,{id:'p2',objectId:null,observations:[{photoId:source.photo.photoId,xy:[75,30],origin:'manual'}]}],dimensions:[{id:'width',value:90,unit:'cm',source:'measured',endpoints:[{landmarkId:'p'},{landmarkId:'p2'}]}],verifiedAgainst:{scale:'calibrated'}}));
 const preview=imports.previewFactReuse(target.p,source.p.id);assert.ok(preview.answers.some(a=>a.kind==='dimension'));
 const result=imports.reuseFacts(target.p,{expectedRevision:0,sourceProjectId:source.p.id,answerIds:preview.answers.map(a=>a.id)});assert.equal(result.dimensions[0].value,90);assert.equal(result.verifiedAgainst,null);
});
test('photo import preserves originals, old attempts and existing answers',t=>{
 const f=fixture(t),folder=resolve(f.d.root,'external-test-source');mkdirSync(folder);writeFileSync(resolve(folder,'old.png'),'new photo');writeFileSync(resolve(folder,'same.png'),'original photo');
 const attempt=createAttempt(f.p,{kind:'automatic',inputRevision:null,inputFingerprint:null});const before=readFileSync(resolve(dirs(f.p,{attemptId:attempt.id}).images,'old.png'));
 const result=imports.importPhotos(f.p,{expectedRevision:0,sourceDir:folder});assert.equal(result.added,1);assert.equal(result.duplicates,1);assert.equal(result.record.state,'stale');
 assert.equal(result.record.answers[0].value,'yes');assert.deepEqual(readFileSync(resolve(folder,'old.png')),Buffer.from('new photo'));
 assert.deepEqual(readFileSync(resolve(dirs(f.p,{attemptId:attempt.id}).images,'old.png')),before);assert.equal(readFileSync(resolve(f.d.images,'old.png'),'utf8'),'work');
 assert.ok(projects.read(f.p.id).photoSources.length===2);assert.ok(projects.read(f.p.id).steps.every(s=>s.status==='pending'));
 assert.throws(()=>imports.importPhotos(f.p,{expectedRevision:0,sourceDir:folder}),{code:409});
 const again=imports.importPhotos(projects.read(f.p.id),{expectedRevision:1,sourceDir:folder});assert.equal(again.added,0);assert.equal(again.record.revision,1);
});

test('adding photos preserves both accumulated and legacy stage time when resetting steps',t=>{
 const f=fixture(t),folder=resolve(f.d.root,'external-timing-source');mkdirSync(folder);writeFileSync(resolve(folder,'added.png'),'additional fixture photo');
 f.p.steps[0].timing={elapsedMs:4500,runningSince:null,complete:true};
 Object.assign(f.p.steps[1],{startedAt:'2026-10-26T00:00:00.000Z',endedAt:'2026-10-26T00:01:15.000Z'});projects.write(f.p);
 imports.importPhotos(f.p,{expectedRevision:0,sourceDir:folder});
 const result=projects.summarise(projects.read(f.p.id));
 assert.equal(result.steps[0].status,'pending');
 assert.equal(result.steps[0].timing.elapsedMs,4500);
 assert.equal(result.steps[1].timing.elapsedMs,75000);
 assert.equal(result.timing.elapsedMs,79500);
 assert.equal(result.timing.complete,false);
});
