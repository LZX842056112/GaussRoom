import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { artifactDirs } from './artifact-paths.mjs';
import { atomicJson, inputError } from './assistance.mjs';
import { geometrySignature } from './pipeline.mjs';

export function sameInputs(a,b) {
  return !!a&&!!b&&['photosSha256','matchingContentSha256','geometrySha256','configSha256'].every(k=>typeof a[k]==='string'&&a[k]===b[k]);
}
export function readAttempt(project,id) {
  const path=resolve(artifactDirs(project,{attemptId:id}).workspace,'attempt.json');
  if(!existsSync(path))throw inputError('重建尝试不存在',404);
  const attempt=JSON.parse(readFileSync(path,'utf8'));
  if(attempt.id!==id)throw inputError('重建尝试清单不一致',409);
  return attempt;
}
export function writeAttempt(project,attempt) {
  const path=resolve(artifactDirs(project,{attemptId:attempt.id}).workspace,'attempt.json');
  return atomicJson(path,attempt);
}
export function createAttempt(project,{kind,inputRevision,inputFingerprint}) {
  if(!['automatic','assisted'].includes(kind))throw inputError('重建尝试类型无效');
  if(kind==='assisted'&&(!Number.isInteger(inputRevision)||!inputFingerprint))throw inputError('辅助求解缺少输入版本',409);
  const attempt={id:`a-${randomBytes(12).toString('hex')}`,kind,inputRevision,inputFingerprint,status:'created',createdAt:new Date().toISOString(),result:null,failure:null};
  const d=artifactDirs(project,{attemptId:attempt.id}),source=artifactDirs(project);
  for(const name of ['sfm','summary','logs','train','undistorted'])mkdirSync(d[name],{recursive:true});
  mkdirSync(resolve(d.workspace,'inputs'),{recursive:true});
  atomicJson(resolve(d.workspace,'inputs/source-project.json'),project);
  if(existsSync(source.images))cpSync(source.images,d.images,{recursive:true,errorOnExist:true,force:false});
  if(existsSync(source.manifest))cpSync(source.manifest,d.manifest,{errorOnExist:true,force:false});
  if(existsSync(source.sparse))cpSync(source.sparse,resolve(d.workspace,'inputs/models'),{recursive:true,errorOnExist:true,force:false});
  return writeAttempt(project,attempt);
}
export function listAttempts(project) {
  const folder=resolve(artifactDirs(project,{attemptId:null}).root,'attempts');
  if(!existsSync(folder))return [];
  return readdirSync(folder,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^a-[a-f0-9]{24}$/.test(e.name)).flatMap(e=>{
    try{return [readAttempt(project,e.name)];}catch{return [];}
  }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export function adoptAttempt(project,attempt,{currentRevision,currentFingerprint}) {
  attempt=readAttempt(project,attempt.id);
  if(attempt.status!=='verified'||!attempt.result||!sameInputs(attempt.inputFingerprint,currentFingerprint)
      || (attempt.kind==='assisted'&&attempt.inputRevision!==currentRevision))throw inputError('新结果未验证，或回答和输入已改变。旧模型已保留。',409);
  const {gate,selectedModel}=attempt.result;
  if(attempt.localRepairRequired&&attempt.result.localRepair?.accepted!==true)throw inputError('完整局部修正尚未通过检查。旧模型已保留。',409);
  const model=gate?.models?.find(m=>m.name===selectedModel);
  if(gate?.verdict!=='pass'||gate.geometryValidationVersion!==1||!gate.geometryConnected||gate.selectedModel!==selectedModel
      ||model?.geometryComponentSizes?.length!==1||!/^[a-zA-Z0-9_-]+$/.test(selectedModel)
      || (attempt.kind==='assisted'&&attempt.result.bridges?.accepted!==true))throw inputError('新模型几何连接未通过检查',409);
  const folder=resolve(artifactDirs(project,{attemptId:attempt.id}).sparse,selectedModel);
  if(!existsSync(folder)||geometrySignature(folder)!==model.geometrySignature)throw inputError('新模型已改变，请重新检查',409);
  const adopted={...project,activeAttemptId:attempt.id,pendingAttemptId:null,selectedModel,mapper:attempt.kind==='assisted'?'global':project.mapper};
  delete adopted.trainingResume;
  atomicJson(resolve(artifactDirs(project).root,'project.json'),adopted);
  return adopted;
}
