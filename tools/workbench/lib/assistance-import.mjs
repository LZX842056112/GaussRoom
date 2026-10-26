// Explicit fact reuse copies observations, never cameras, poses or verification.
import {existsSync,readFileSync,readdirSync,mkdirSync,copyFileSync,statSync} from 'node:fs';
import {resolve,extname,basename,sep} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import * as projects from './projects.mjs';
import {dirs} from './pipeline.mjs';
import {readAssistance,newRecord,updateAssistance,validatePatch,missingInput,inputError,emptyPatch} from './assistance.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const PHOTO=/\.(jpe?g|png|webp|heic|heif|tiff?|bmp)$/i;
function targetPhotos(project,catalog){
 if(catalog)return Array.isArray(catalog)?catalog:catalog.photos;
 const record=readAssistance(project);if(record)return record.photos;
 const d=dirs(project),path=resolve(d.summary,'assistance-context.json');
 if(existsSync(path))return JSON.parse(readFileSync(path,'utf8')).catalog;
 if(!existsSync(d.manifest))throw inputError('请先准备工作照片，再选择复用资料。',409);
 return JSON.parse(readFileSync(d.manifest,'utf8')).records.filter(r=>!r.excluded&&r.work_image).map(r=>({photoId:r.sha256,sourceSha256:r.sha256,workSha256:r.work_sha256,
  name:r.work_image.replace(/^(?:inputs\/)?images\//,''),width:r.work_size?.[0],height:r.work_size?.[1]}));
}
export function previewFactReuse(project,sourceProjectId,{catalog}={}){
 if(sourceProjectId===project.id)throw inputError('请选择其他项目');
 const source=readAssistance(projects.read(sourceProjectId)),photos=targetPhotos(project,catalog),bySha=new Map(photos.map(p=>[p.sourceSha256??p.photoId,p])),mapping=new Map(),conflicts=[];
 for(const p of source?.photos??[]){const target=bySha.get(p.sourceSha256??p.photoId);if(target)mapping.set(p.photoId,{source:p,target,coordinates:p.width===target.width&&p.height===target.height&&!!p.workSha256&&p.workSha256===target.workSha256});}
 for(const {source,target,coordinates} of mapping.values())if(!coordinates)conflicts.push({photoId:target.photoId,message:'工作图片的方向、尺寸或内容不同，不复用标记坐标。',sourceName:source.name});
 const remap=id=>mapping.get(id)?.target.photoId,canCoordinate=id=>mapping.get(id)?.coordinates;
 const answers=[];
 for(const answer of source?.answers??[]){
  const q=source.questions.find(q=>q.id===answer.questionId);
  if(!q||answer.value==='unknown'||!q.photoIds?.length||q.photoIds.some(id=>!mapping.has(id))||['coverage','position_review'].includes(q.type))continue;
  answers.push({id:`answer:${q.id}`,kind:'answer',description:`${q.text??q.type}：${answer.value}`,value:answer,question:{...q,photoIds:q.photoIds.map(remap)}});
 }
 const objectIds=new Map((source?.objects??[]).map(o=>[o.id,`reuse-${hash(sourceProjectId+':object:'+o.id).slice(0,20)}`]));
 const pointIds=new Map((source?.landmarks??[]).map(p=>[p.id,`reuse-${hash(sourceProjectId+':point:'+p.id).slice(0,20)}`]));
 for(const o of source?.objects??[]){
  const rois=(o.rois??[]).filter(r=>canCoordinate(r.photoId)).map(r=>({...r,photoId:remap(r.photoId)}));
  const corners=(o.corners??[]).filter(r=>canCoordinate(r.photoId)).map(r=>({...r,photoId:remap(r.photoId)}));
  if(rois.length||corners.length)answers.push({id:`object:${o.id}`,kind:'object',description:`共同物体 ${o.id}`,value:{...o,id:objectIds.get(o.id),regions:[],rois,corners}});
 }
 for(const p of source?.landmarks??[]){
  const observations=p.observations.filter(o=>o.origin==='manual'&&canCoordinate(o.photoId)).map(o=>({...o,photoId:remap(o.photoId)}));
  if(observations.length)answers.push({id:`landmark:${p.id}`,kind:'landmark',description:`对应点 ${p.id}（${observations.length} 张照片）`,value:{...p,id:pointIds.get(p.id),objectId:objectIds.get(p.objectId)??null,observations}});
 }
 const usablePoints=new Set(answers.filter(a=>a.kind==='landmark').map(a=>a.value.id));
 for(const d of source?.dimensions??[]){
  if(d.source==='unknown'||!d.endpoints?.every(e=>usablePoints.has(pointIds.get(e.landmarkId))))continue;
  answers.push({id:`dimension:${d.id}`,kind:'dimension',description:`尺寸 ${d.value} ${d.unit}（须同时选择两端对应点）`,value:{...d,id:`reuse-${hash(sourceProjectId+':dimension:'+d.id).slice(0,20)}`,endpoints:d.endpoints.map(e=>({landmarkId:pointIds.get(e.landmarkId)}))}});
 }
 return {photos:[...mapping.values()].map(({source,target,coordinates})=>({photoId:target.photoId,sourceName:source.name,targetName:target.name,coordinates})),answers,conflicts};
}
export function reuseFacts(project,{expectedRevision,sourceProjectId,answerIds,catalog,inputs}){
 if(['running','aborting'].includes(projects.read(project.id).state))throw inputError('项目正在运行，请先等待或中止。',409);
 const preview=previewFactReuse(project,sourceProjectId,{catalog});
 if(!Array.isArray(answerIds)||!answerIds.length||new Set(answerIds).size!==answerIds.length||answerIds.some(id=>!preview.answers.some(a=>a.id===id)))throw inputError('请选择预览中的资料');
 const photos=targetPhotos(project,catalog);
 return updateAssistance(project,current=>{
  const previous=current??newRecord({catalog:photos,inputs});
  if(previous.revision!==expectedRevision)throw inputError('辅助回答版本已改变',409,{revision:previous.revision});
  const draft=Object.fromEntries(Object.entries(emptyPatch()).map(([k,value])=>[k,structuredClone(previous[k]??value)])),questions=structuredClone(previous.questions);
  const chosen=preview.answers.filter(a=>answerIds.includes(a.id));
  for(const a of chosen){
   if(a.kind==='answer'){
    const existing=questions.find(q=>q.type===a.question.type&&JSON.stringify(q.photoIds)===JSON.stringify(a.question.photoIds));
    if(!existing)questions.push(a.question);
    const questionId=existing?.id??a.question.id;draft.answers=draft.answers.filter(v=>v.questionId!==questionId);draft.answers.push({...a.value,questionId});
   }else{const key={object:'objects',landmark:'landmarks',dimension:'dimensions'}[a.kind];draft[key]=draft[key].filter(v=>v.id!==a.value.id);draft[key].push(structuredClone(a.value));}
  }
  const objectIds=new Set(draft.objects.map(o=>o.id));for(const p of draft.landmarks)if(!objectIds.has(p.objectId))p.objectId=null;
  const validation={photos,questions,regions:previous.regions,reasons:previous.reasons};
  const value=validatePatch(draft,validation),missing=missingInput(value,validation);
  return {...previous,...value,photos,questions,inputs:inputs??previous.inputs,revision:previous.revision+1,state:missing.length?'needs_input':'ready',missing,verifiedAgainst:null};
 });
}
export function importPhotos(project,{expectedRevision,sourceDir}){
 project=projects.read(project.id);
 if(['running','aborting'].includes(project.state))throw inputError('项目正在运行，请先等待或中止。',409);
 if(typeof sourceDir!=='string'||!sourceDir.trim()||!existsSync(sourceDir)||!statSync(sourceDir).isDirectory())throw inputError('请选择有效的照片目录');
 return (()=>{let result;
  updateAssistance(project,current=>{
   const previous=current??newRecord();if(previous.revision!==expectedRevision)throw inputError('辅助回答版本已改变',409,{revision:previous.revision});
   const known=new Set([...(previous.photos??[]).map(p=>p.sourceSha256??p.photoId),...(project.importedPhotos??[]).map(p=>p.sha256)]);
   const manifest=dirs(project).manifest;if(existsSync(manifest))for(const r of JSON.parse(readFileSync(manifest,'utf8')).records)known.add(r.sha256);
   const pending=[];let duplicates=0;
   for(const file of readdirSync(sourceDir,{withFileTypes:true}).filter(e=>e.isFile()&&PHOTO.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=resolve(sourceDir,file.name),digest=hash(readFileSync(path));if(known.has(digest)){duplicates++;continue;}known.add(digest);pending.push({path,name:file.name,sha256:digest});
   }
   if(!pending.length){result={added:0,duplicates,record:previous};return previous;}
   const root=dirs(project).root,destination=resolve(root,'imports',`i-${randomBytes(12).toString('hex')}`);
   if(!destination.startsWith(resolve(root)+sep))throw inputError('导入目录越界');mkdirSync(destination,{recursive:true});
   const imported=pending.map(p=>{const name=`${basename(p.name,extname(p.name)).slice(0,60)}-${p.sha256.slice(0,16)}${extname(p.name).toLowerCase()}`,target=resolve(destination,name);copyFileSync(p.path,target,1);
    if(hash(readFileSync(p.path))!==p.sha256||hash(readFileSync(target))!==p.sha256)throw inputError('照片在复制时发生变化，请重新导入。',409);return {sha256:p.sha256,path:target,name:p.name};});
   const record={...previous,revision:previous.revision+1,state:'stale',verifiedAgainst:null,missing:[{code:'photos_changed',message:'已添加照片。请从照片预处理重跑，再复查原有回答和标记。'}]};
   project.photoSources=[...(project.photoSources??[project.sourceDir]),destination];project.importedPhotos=[...(project.importedPhotos??[]),...imported];project.sourceImageCount=(project.sourceImageCount??previous.photos.length)+imported.length;
   project.state='partial';project.pendingAttemptId=null;project.lastError=null;delete project.trainingResume;
   project.steps=project.steps.map(s=>({id:s.id,name:s.name,status:'pending',progress:0}));projects.write(project);
   result={added:pending.length,duplicates,record};return record;
  });return result;
 })();
}
