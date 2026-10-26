// User input revisions are separate from job progress. All mutations use one
// synchronous lock so an older browser or child result cannot overwrite answers.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECTS_DIR, WORKBENCH } from './paths.mjs';

export const ASSISTANCE_CONFIG = JSON.parse(readFileSync(resolve(WORKBENCH,'assistance-config.json'),'utf8'));
const EDITABLE = ['answers','regionLabels','objects','landmarks','dimensions','coverage','onlyExistingPhotos','localRepair'];
export const emptyPatch = ()=>({answers:[],regionLabels:[],objects:[],landmarks:[],dimensions:[],coverage:[],onlyExistingPhotos:false,localRepair:null});
export const inputError = (message,code=400,details)=>Object.assign(new Error(message),{code,...(details?{details}:{})});
export function assistancePath(project) { return resolve(project.root??resolve(PROJECTS_DIR,project.id),'assistance.json'); }
export function atomicJson(path,value) {
  mkdirSync(dirname(path),{recursive:true});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary,JSON.stringify(value,null,2),'utf8');renameSync(temporary,path); }
  finally { if(existsSync(temporary)) unlinkSync(temporary); }
  return value;
}
export function readAssistance(project) {
  const path=assistancePath(project);
  if(!existsSync(path)) return null;
  try {
    const record=JSON.parse(readFileSync(path,'utf8'));
    if(record.version!==1 || !Number.isInteger(record.revision)) throw new Error('version');
    return {...record,localRepair:record.localRepair??null};
  } catch { throw inputError('辅助记录损坏或格式不受支持。已有模型已保留。',500); }
}
function withLock(project,action) {
  const path=`${assistancePath(project)}.lock`;
  mkdirSync(dirname(path),{recursive:true});
  if(existsSync(path)) {
    let owner;
    try { owner=Number(readFileSync(path,'utf8'));process.kill(owner,0); }
    catch(error) { if(error.code==='ESRCH' || !Number.isInteger(owner) || owner<=0) unlinkSync(path); }
  }
  let fd;
  try { fd=openSync(path,'wx'); }
  catch(error) { if(error.code==='EEXIST') throw inputError('辅助记录正在保存。请重试。',409); throw error; }
  try { writeFileSync(fd,String(process.pid));return action(); }
  finally { closeSync(fd);unlinkSync(path); }
}
export function newRecord({catalog={},inputs=null,reasons=[],questions=[],regions=[]}={}) {
  return {version:1,revision:0,state:'needs_input',reasons,inputs,photos:Array.isArray(catalog)?catalog:(catalog.photos??[]),regions,questions,missing:[],...emptyPatch(),attempts:[],verifiedAgainst:null};
}
export function updateAssistance(project,update) {
  return withLock(project,()=>atomicJson(assistancePath(project),update(readAssistance(project))));
}
export function preserveQuestions(previous,questions,photos){
  const ids=new Set(questions.map(q=>q.id)),known=new Set(photos.map(p=>p.photoId)),answered=new Set(previous?.answers?.map(a=>a.questionId));
  return [...questions,...(previous?.questions??[]).filter(q=>answered.has(q.id)&&!ids.has(q.id)&&(q.photoIds??[]).every(id=>known.has(id)))];
}
export function rebaseRecordGeometry(record,diagnosis,catalog){
  const regions=diagnosis.regions,known=new Set(catalog.map(p=>p.photoId)),map=new Map();
  for(const old of record.regions??[]){
    const contained=regions.filter(r=>old.photoIds?.length&&old.photoIds.every(id=>r.photoIds.includes(id)));
    if(contained.length===1)map.set(old.id,contained[0].id);
  }
  const keptLabels=[],previousLabels=[...(record.previousLabels??[])];
  for(const label of record.regionLabels??[]){
    const old=record.regions.find(r=>r.id===label.regionId),next=regions.find(r=>r.id===map.get(label.regionId));
    if(old&&next&&old.photoIds.length===next.photoIds.length)keptLabels.push({...label,regionId:next.id});else previousLabels.push(label);
  }
  return {photos:catalog.map(p=>({...p,unregistered:diagnosis.unregistered.includes(p.photoId)})),regions,questions:preserveQuestions(record,diagnosis.questions,catalog),
    localRepair:record.localRepair&&['photoIds','referencePhotoIds','contextPhotoIds'].every(k=>(record.localRepair[k]??[]).every(id=>known.has(id)))?record.localRepair:null,
    regionLabels:keptLabels,previousLabels,objects:(record.objects??[]).map(o=>({...o,regions:[...new Set((o.regions??[]).map(id=>map.get(id)).filter(Boolean))]})),
    coverage:(record.coverage??[]).filter(c=>known.has(c.photoId)).map(c=>c.decision==='existing'?(map.has(c.regionId)?{...c,regionId:map.get(c.regionId)}:{...c,decision:'unknown',regionId:null}):c)};
}
const check = (condition,message)=>{if(!condition) throw inputError(message);};
const plain = value=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype;
function keys(value,allowed,label) { check(plain(value),`${label}格式无效`);check(Object.keys(value).every(k=>allowed.includes(k)),`${label}包含不允许的字段`); }
function items(value,max,label) { check(Array.isArray(value)&&value.length<=max,`${label}数量超出上限或格式无效`);return value; }
function text(value,label) {check(typeof value==='string'&&value.length>0&&value.length<=ASSISTANCE_CONFIG.maxLabelLength,`${label}无效`);return value;}
function uniqueIds(values,label){const ids=new Set();for(const value of values){text(value.id,label);check(!ids.has(value.id),`${label}重复`);ids.add(value.id);}return ids;}

/** Validate work-image coordinates and references before changing any file. */
export function validatePatch(patch,catalog) {
  keys(patch,EDITABLE,'回答');
  const c=ASSISTANCE_CONFIG, data={...emptyPatch(),...structuredClone(patch)};
  const photos=Array.isArray(catalog)?catalog:catalog.photos??[];
  const byPhoto=new Map(photos.map(p=>[p.photoId,p]));
  const regionIds=new Set((catalog.regions??[]).map(r=>r.id));
  const questionMap=new Map((catalog.questions??[]).map(q=>[q.id,q]));
  const photo = id=>{check(byPhoto.has(id),'照片不存在或已改变');return byPhoto.get(id);};
  const region = id=>check(regionIds.has(id),'区域不存在或已改变');
  const xy = (id,point)=>{const p=photo(id);check(Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)&&point[0]>=0&&point[1]>=0&&point[0]<p.width&&point[1]<p.height,'标记坐标必须位于工作图片内');};
  items(data.answers,c.maxAnswers,'回答');items(data.regionLabels,c.maxObjects,'区域标签');items(data.objects,c.maxObjects,'共同物体');items(data.landmarks,c.maxLandmarks,'对应点');items(data.dimensions,c.maxDimensions,'尺寸');items(data.coverage,photos.length,'覆盖检查');
  check(typeof data.onlyExistingPhotos==='boolean','现有照片选项无效');
  const answerIds=new Set();
  for(const answer of data.answers){
    keys(answer,['questionId','value'],'问题回答');check(!answerIds.has(answer.questionId),'问题回答重复');answerIds.add(answer.questionId);
    const q=questionMap.get(answer.questionId);check(q,'问题不存在或已改变');
    check((q.options??['yes','no','unknown']).some(o=>(typeof o==='string'?o:o.value)===answer.value),'回答选项无效');
  }
  for(const label of data.regionLabels){keys(label,['regionId','label'],'区域标签');region(label.regionId);text(label.label,'区域标签');}
  const objects=uniqueIds(data.objects,'物体编号'), landmarks=uniqueIds(data.landmarks,'对应点编号');uniqueIds(data.dimensions,'尺寸编号');
  for(const object of data.objects){
    keys(object,['id','kind','regions','rois','corners'],'共同物体');check(['planar','points'].includes(object.kind),'物体模式无效');
    for(const id of items(object.regions??[],regionIds.size,'物体区域')) region(id);
    for(const roi of items(object.rois??[],c.maxObservationsPerPoint,'圈选')){keys(roi,['photoId','polygon'],'圈选');photo(roi.photoId);check(items(roi.polygon,c.maxPolygonVertices,'圈选顶点').length>=3,'圈选至少需要三个顶点');for(const point of roi.polygon) xy(roi.photoId,point);}
    const seen=new Set();
    for(const corners of items(object.corners??[],c.maxObservationsPerPoint,'平面角点')){keys(corners,['photoId','xy'],'平面角点');check(object.kind==='planar'&&corners.xy?.length===4,'平面需要按相同顺序标记四角');check(!seen.has(corners.photoId),'平面照片重复');seen.add(corners.photoId);for(const point of corners.xy)xy(corners.photoId,point);}
  }
  const used=new Set();
  for(const point of data.landmarks){
    keys(point,['id','objectId','observations'],'对应点');check(point.objectId==null||objects.has(point.objectId),'对应点引用未知物体');
    const seen=new Set();
    for(const obs of items(point.observations,c.maxObservationsPerPoint,'点观察')){
      keys(obs,['photoId','xy','origin'],'点观察');check(obs.origin==='manual','客户端只能提交手工标记的观察');xy(obs.photoId,obs.xy);
      check(!seen.has(obs.photoId),'一个对应点在同一照片中只能出现一次');seen.add(obs.photoId);
      const key=`${obs.photoId}:${obs.xy[0].toFixed(3)},${obs.xy[1].toFixed(3)}`;check(!used.has(key),'同一个观察不能属于多个对应点');used.add(key);
    }
  }
  if(data.localRepair!==null){
    const s=data.localRepair;keys(s,['photoIds','referencePhotoIds','contextPhotoIds','refineCornerIds','excludedPlanarInteriors'],'局部修正范围');
    const assigned=new Set();
    for(const key of ['photoIds','referencePhotoIds','contextPhotoIds']){
      s[key]??=[];
      for(const id of items(s[key],photos.length,'修正照片')){photo(id);check(!assigned.has(id),'修正照片、固定参照和背景照片不能重复或重叠');assigned.add(id);}
    }
    s.refineCornerIds??=[];s.excludedPlanarInteriors??=[];
    const corners=new Set();
    for(const id of items(s.refineCornerIds,c.maxLandmarks,'角点细化')){check(landmarks.has(id)&&!corners.has(id),'角点细化含未知或重复对应点');corners.add(id);}
    for(const q of items(s.excludedPlanarInteriors,c.maxObjects,'排除区域')){
      check(Array.isArray(q)&&q.length===4&&new Set(q).size===4&&q.every(id=>landmarks.has(id)),'排除区域需要四个不同的已标记角点');
    }
  }
  for(const d of data.dimensions){
    keys(d,['id','value','unit','source','endpoints'],'尺寸');check(['mm','cm','m'].includes(d.unit)&&['measured','estimated','unknown'].includes(d.source),'尺寸单位或来源无效');
    check(d.source==='unknown'?d.value===null:Number.isFinite(d.value)&&d.value>0,'尺寸必须为正数；未知尺寸使用空值');
    if(d.endpoints!==null){check(Array.isArray(d.endpoints)&&d.endpoints.length===2,'尺寸需要两个端点');for(const e of d.endpoints){keys(e,['landmarkId'],'尺寸端点');check(landmarks.has(e.landmarkId),'尺寸端点不存在');}check(d.endpoints[0].landmarkId!==d.endpoints[1].landmarkId,'尺寸端点不能相同');}
  }
  const coverageSeen=new Set();
  for(const entry of data.coverage){keys(entry,['photoId','decision','regionId'],'照片覆盖');photo(entry.photoId);check(!coverageSeen.has(entry.photoId),'照片覆盖回答重复');coverageSeen.add(entry.photoId);check(['existing','new','unknown'].includes(entry.decision),'照片覆盖选项无效');if(entry.decision==='existing')region(entry.regionId);else check(entry.regionId==null,'未确认区域不能指定已有区域');}
  return data;
}
export function missingInput(patch,catalog) {
  const missing=[],photos=Array.isArray(catalog)?catalog:catalog.photos??[];
  const byPhoto=new Map(photos.map(p=>[p.photoId,p]));
  if(patch.localRepair){
    const s=patch.localRepair,targets=new Set(s.photoIds),refs=new Set(s.referencePhotoIds);
    const shared=patch.landmarks.filter(p=>p.observations.filter(o=>targets.has(o.photoId)).length>=ASSISTANCE_CONFIG.minViewsPerSide&&p.observations.filter(o=>refs.has(o.photoId)).length>=ASSISTANCE_CONFIG.minViewsPerSide);
    const sharedRoi=patch.objects.some(o=>{
      const ids=new Set([...(o.rois??[]),...(o.corners??[])].map(r=>r.photoId));
      return [...ids].filter(id=>targets.has(id)).length>=ASSISTANCE_CONFIG.minViewsPerSide&&[...ids].filter(id=>refs.has(id)).length>=ASSISTANCE_CONFIG.minViewsPerSide;
    });
    if(targets.size<ASSISTANCE_CONFIG.minViewsPerSide||refs.size<ASSISTANCE_CONFIG.minViewsPerSide||(shared.length<ASSISTANCE_CONFIG.minSharedPoints&&!sharedRoi))missing.push({code:'local_scope_support_needed',message:'请选择完整的修正范围和至少两张固定参照。在两侧各两张照片中圈选同一固定内容，或标记至少 8 个共同点。自动匹配后仍须通过几何检查。'});
  }
  const enoughPoints=patch.landmarks.filter(p=>p.observations.length>=4).length>=ASSISTANCE_CONFIG.minSharedPoints;
  const guidedObject=patch.objects.some(o=>new Set([...(o.rois??[]),...(o.corners??[])].map(r=>r.photoId)).size>=2);
  const coverageOnly=catalog.reasons?.length&&catalog.reasons.every(r=>r.code==='coverage_unknown');
  if(!coverageOnly&&!enoughPoints&&!guidedObject)missing.push({code:'observations_needed',message:'请选择共同物体区域，或标记至少 8 个对应点。每点需要两侧各两张照片。'});
  for(const p of photos.filter(p=>p.unregistered)){
    const scope=patch.coverage.find(c=>c.photoId===p.photoId);
    if(!scope||scope.decision==='unknown') missing.push({code:'coverage_unknown',photoId:p.photoId,message:'请确认这张未定位照片属于已有区域还是新区域。'});
    if(scope?.decision==='new') missing.push({code:'new_region_unregistered',photoId:p.photoId,message:'该新区域尚未定位。请选择与已定位区域共同可见的照片。'});
  }
  return missing;
}
export function saveAssistance(project,{expectedRevision,patch,catalog,inputs}) {
  return withLock(project,()=>{
    const previous=readAssistance(project)??newRecord({catalog,inputs,regions:catalog.regions??[],questions:catalog.questions??[]});
    if(!Number.isInteger(expectedRevision)||expectedRevision!==previous.revision)throw inputError('回答已在另一页面更新。请读取新版本后再保存。',409,{revision:previous.revision});
    const editable=validatePatch(patch,catalog),missing=missingInput(editable,catalog);
    const record={...previous,...editable,revision:previous.revision+1,inputs,photos:Array.isArray(catalog)?catalog:catalog.photos,regions:catalog.regions??previous.regions,questions:catalog.questions??previous.questions,missing,state:missing.length?'needs_input':'ready',verifiedAgainst:null,updatedAt:new Date().toISOString()};
    return atomicJson(assistancePath(project),record);
  });
}
