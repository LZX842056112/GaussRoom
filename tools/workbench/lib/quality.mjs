/** Geometry, coverage, appearance and measured scale are independent claims. */
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,basename,extname} from 'node:path';
import {dirs,readGate,geometrySignature as signatureOf,TRAINING_PRESETS} from './pipeline.mjs';
import {readAssistance,updateAssistance,inputError,atomicJson,newRecord,rebaseRecordGeometry} from './assistance.mjs';
import {diagnoseAssistance} from './assistance-diagnosis.mjs';

const reviewPath=project=>resolve(dirs(project).summary,'appearance-review.json');
const geometryCache=new Map();
function geometryCurrent(project,model,fresh=false){
 if(!model||!/^[a-zA-Z0-9_-]+$/.test(model.name))return false;
 const folder=resolve(dirs(project).sparse,model.name);
 let stats;try{stats=['cameras.bin','images.bin','points3D.bin','frames.bin','rigs.bin'].map(name=>{if(['frames.bin','rigs.bin'].includes(name)&&!existsSync(resolve(folder,name)))return null;const s=statSync(resolve(folder,name));return [s.size,s.mtimeMs,s.ctimeMs];});}catch{return false;}
 const key=folder+'|'+model.geometrySignature,cached=geometryCache.get(key),fingerprint=JSON.stringify(stats);
 if(cached&&!fresh)return cached.stats===fingerprint&&cached.matches;
 const matches=signatureOf(folder)===model.geometrySignature;geometryCache.set(key,{stats:fingerprint,matches});return matches;
}
export function qualityFor(project,{fresh=false}={}){
 let review=null;try{review=JSON.parse(readFileSync(reviewPath(project),'utf8'));}catch{}
 const d=dirs(project),exports=existsSync(d.train)?readdirSync(d.train).map(name=>/^export_(\d+)\.ply$/.exec(name)).filter(Boolean).map(m=>Number(m[1])):[];
 let gate=readGate(project);const model=gate?.models?.find(m=>m.name===(project.selectedModel??gate.selectedModel));
 if(gate?.geometryValidationVersion===1&&!geometryCurrent(project,model,fresh)){gate={...gate,geometryValidationVersion:0,geometryConnected:false};review=null;}
 return deriveQuality(project,{gate,record:readAssistance(project),review,
  training:{step:Math.max(0,...exports),totalSteps:TRAINING_PRESETS[project.trainingPreset]?.totalSteps,attemptId:project.activeAttemptId??null}});
}
export function saveReview(project,{expectedRevision,attemptId,geometrySignature,review,catalog,inputs}){
 const gate=readGate(project),model=gate?.models?.find(m=>m.name===(project.selectedModel??gate.selectedModel));
 if((attemptId??null)!==(project.activeAttemptId??null)||!model||model.geometrySignature!==geometrySignature
   ||signatureOf(resolve(dirs(project).sparse,model.name))!==geometrySignature)throw inputError('模型已改变。请重新打开当前模型后检查。',409);
 const existing=readAssistance(project),initialDiagnosis=!existing?diagnoseAssistance({gate,catalog:catalog??[]}):null;
 const record=existing??{...newRecord({catalog:catalog??[],inputs,regions:initialDiagnosis.regions,questions:initialDiagnosis.questions,reasons:initialDiagnosis.reasons}),state:initialDiagnosis.required?'needs_input':'verified',sourceAttemptId:project.activeAttemptId??null,missing:initialDiagnosis.missing};
 if(record.revision!==expectedRevision)throw inputError('辅助回答版本已改变。请读取新版本。',409,{revision:record.revision});
 const photos=new Set((catalog??record.photos??[]).map(p=>p.photoId)),regions=new Set(record.regions.map(r=>r.id));
 if(!review||Object.keys(review).some(k=>!['appearance','items','requestPositionCheck'].includes(k))||!['passed','needs_improvement'].includes(review.appearance)||typeof review.requestPositionCheck!=='boolean'||!Array.isArray(review.items)||review.items.length>100)throw inputError('画面检查格式无效');
 for(const item of review.items){
  if(!item||Object.keys(item).some(k=>!['code','photoIds','regionIds','note','status'].includes(k))||!['doorway','ghosting','proportions','coverage','other'].includes(item.code)
    ||!['passed','needs_improvement'].includes(item.status)||typeof item.note!=='string'||item.note.length>2000||!Array.isArray(item.photoIds)||!Array.isArray(item.regionIds)
    ||item.photoIds.some(id=>!photos.has(id))||item.regionIds.some(id=>!regions.has(id)))throw inputError('画面检查包含未知照片、区域或无效内容');
 }
 if(review.appearance==='passed'&&review.items.some(i=>i.status==='needs_improvement'))throw inputError('存在未解决的画面问题，不能标记通过');
 if(review.appearance==='passed'&&(['doorway','ghosting','proportions','coverage'].some(code=>!review.items.some(i=>i.code===code&&i.status==='passed'))||review.requestPositionCheck))throw inputError('请检查门口连接、重影、比例和覆盖。需要复查时不能标记通过。');
 if(review.requestPositionCheck&&['running','aborting'].includes(project.state))throw inputError('项目正在运行，请先等待或中止。',409);
 // Revision check and the review write share the assistance lock.
 updateAssistance(project,current=>{
  current??=record;
  if(current.revision!==expectedRevision)throw inputError('辅助回答版本已改变',409,{revision:current.revision});
  atomicJson(reviewPath(project),{...review,attemptId:attemptId??null,geometrySignature,createdAt:new Date().toISOString()});
  if(review.requestPositionCheck){
   const photos=catalog??current.photos,diagnosis=diagnoseAssistance({gate,catalog:photos,record:current,manualRequest:true});
   atomicJson(resolve(dirs(project).root,'project.json'),{...project,state:'needs_input'});
   return {...current,...rebaseRecordGeometry(current,diagnosis,photos),inputs:inputs??current.inputs,revision:current.revision+1,state:'needs_input',sourceAttemptId:project.activeAttemptId??null,reasons:diagnosis.reasons,missing:diagnosis.missing,verifiedAgainst:null};
  }
  return {...current,revision:current.revision+1};
 });
 return qualityFor(project,{fresh:true});
}
export function deriveQuality(project,{gate=null,record=null,review=null,training=null}={}) {
  const model=gate?.models?.find(m=>m.name===(project.selectedModel??gate.selectedModel));
  const validated=gate?.geometryValidationVersion===1;
  const geometry=!validated?'unverified':gate.verdict==='pass'&&gate.geometryConnected&&model?.geometryComponentSizes?.length===1?record&&record.state!=='verified'?'unverified':'verified':'failed';
  const unregistered=model?.unregistered??[];
  const scope=record?.coverage??[];
  const photos=record?.photos??[];
  const excluded=unregistered.filter(name=>{
    const photo=photos.find(p=>p.name===name);
    return !scope.some(c=>c.photoId===photo?.photoId&&c.decision==='existing');
  });
  const coverage=!gate?'unreviewed':excluded.length?'missing':'reviewed';
  const currentAttempt=project.activeAttemptId??null;
  const sameReview=review&&(review.attemptId??null)===currentAttempt&&review.geometrySignature===model?.geometrySignature;
  const appearance=sameReview&&['passed','needs_improvement'].includes(review.appearance)?review.appearance:'unreviewed';
  const scale=record?.verifiedAgainst?.geometrySignature&&record.verifiedAgainst.geometrySignature===model?.geometrySignature&&record.verifiedAgainst.scale==='calibrated'?'calibrated':'unmeasured';
  const trainingComplete=!!training&&(training.attemptId??null)===currentAttempt&&Number.isFinite(training.totalSteps)&&training.totalSteps>0&&training.step>=training.totalSteps;
  return {geometry,coverage,appearance,scale,trainingComplete,
    complete:geometry==='verified'&&coverage==='reviewed'&&appearance==='passed'&&trainingComplete};
}

/** Explicit comparison request freezes the first evaluation photo set. */
export function evaluationFor(project){
 const d=dirs(project),gate=readGate(project),geometrySignature=gate?.models?.find(m=>m.name===(project.selectedModel??gate.selectedModel))?.geometrySignature??null;
 const steps=existsSync(d.train)?readdirSync(d.train,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^eval_\d+$/.test(e.name)).map(e=>Number(e.name.slice(5))).sort((a,b)=>a-b):[];
 const manifestPath=resolve(d.summary,'evaluation-photos.json');let manifest=null;
 try{manifest=JSON.parse(readFileSync(manifestPath,'utf8'));}catch{}
 if(!manifest||manifest.geometrySignature!==geometrySignature){
  const records=existsSync(d.manifest)?JSON.parse(readFileSync(d.manifest,'utf8')).records.filter(r=>!r.excluded&&r.work_image):[];
  const first=steps[0],files=first===undefined?[]:readdirSync(resolve(d.train,`eval_${first}`)).filter(name=>/\.(png|jpe?g)$/i.test(name)).sort();
  const photos=files.map(name=>{const stem=basename(name,extname(name)),matches=records.filter(r=>basename(r.work_image,extname(r.work_image))===stem);return {name,photoId:matches.length===1?matches[0].sha256:null,workName:matches.length===1?matches[0].work_image.replace(/^(?:inputs\/)?images\//,''):null};});
  manifest={version:1,attemptId:project.activeAttemptId??null,geometrySignature,photos};if(photos.length)atomicJson(manifestPath,manifest);
 }
 return {...manifest,steps,available:steps.map(step=>({step,names:manifest.photos.filter(p=>existsSync(resolve(d.train,`eval_${step}`,p.name))).map(p=>p.name)}))};
}
