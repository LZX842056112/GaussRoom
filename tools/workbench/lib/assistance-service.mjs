// Local orchestration boundary. HTTP clients never supply these filesystem paths.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, cpSync,readdirSync,realpathSync } from 'node:fs';
import { resolve,sep } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { PY_DIR, TOOLS } from './paths.mjs';
import { dirs, sparseModels, readGate, geometrySignature } from './pipeline.mjs';
import { ASSISTANCE_CONFIG, atomicJson, inputError } from './assistance.mjs';
import { createAttempt, writeAttempt,readAttempt } from './attempts.mjs';

const exec=promisify(execFile);
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const scope=(project,attemptId)=>({...project,activeAttemptId:attemptId??null});
function candidateSignature(folder){
  const hash=createHash('sha256');
  for(const name of ['cameras.bin','frames.bin','images.bin','points3D.bin','rigs.bin'])if(existsSync(resolve(folder,name)))hash.update(name).update('\0').update(readFileSync(resolve(folder,name)));
  return hash.digest('hex');
}
function priorConnectionChecks(project,attemptId){
  const checks=[],seen=new Set(),proofs=new Set();
  const add=(proof,id)=>{
    const marks=proof?.retainedLandmarks??proof?.constraints?.landmarks;
    if(!proof?.accepted||proof.regions?.length<2||!marks?.length)return;
    const value={regions:proof.regions,constraints:{landmarks:marks}},key=createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if(!proofs.has(key)){proofs.add(key);checks.push({sourceAttemptId:proof.sourceAttemptId??id,...value});}
  };
  for(let id=attemptId;id;){
    if(seen.has(id))throw inputError('重建来源链重复。请重新检查模型连接。',409);
    seen.add(id);const previous=readAttempt(project,id);
    if(previous.status==='verified'){
      add(previous.result?.bridges,id);
      if(previous.result?.localRepair?.accepted){
        add(previous.result.localRepair.boundary,id);
        for(const proof of previous.result.localRepair.priorBridgeChecks??[])add(proof,id);
      }
    }
    const path=resolve(dirs(project,{attemptId:id}).workspace,'inputs/source-project.json');
    id=existsSync(path)?readJson(path).activeAttemptId??null:null;
  }
  return checks;
}
function preservedSourceLandmarks(project,attemptId,landmarks,checks){
  if(!checks.length)return [];
  let submitted=null;const seen=new Set(),manualIds=new Set();
  for(let id=attemptId;id;){
    if(seen.has(id))throw inputError('重建来源链重复。请重新检查模型连接。',409);
    seen.add(id);const previous=readAttempt(project,id),workspace=dirs(project,{attemptId:id}).workspace;
    const input=resolve(workspace,'inputs/assisted-request.json');
    if(previous.status==='verified'&&existsSync(input)){
      const sourceMarks=readJson(input).constraints?.landmarks;
      if(sourceMarks){
        submitted??=sourceMarks;
        for(const point of sourceMarks)manualIds.add(point.id);
      }
    }
    const source=resolve(workspace,'inputs/source-project.json');
    id=existsSync(source)?readJson(source).activeAttemptId??null:null;
  }
  // Old projects without raw source clicks cannot safely supply pixel aliases.
  if(!submitted)return [];
  const raw=new Map(submitted.map(p=>[p.id,p])),current=new Map(landmarks.map(p=>[p.id,p])),effective=new Map();
  for(const check of checks)for(const point of check.constraints.landmarks){
    const original=raw.get(point.id);
    if(original){
      if(JSON.stringify(current.get(point.id))!==JSON.stringify(original))continue;
    }else if(manualIds.has(point.id)||!point.observations.length||!point.observations.every(o=>o.origin==='detected'))continue;
    const kept=structuredClone(point);
    // Fresh detector IDs depend on feature enumeration; keep source IDs apart.
    if(!original)kept.id=`preserved-${createHash('sha256').update(JSON.stringify(point)).digest('hex').slice(0,24)}`;
    const old=effective.get(kept.id);
    if(old){
      // Checks arrive newest first; older proof can only fill absent photos.
      const rows=new Map(old.observations.map(o=>[o.photoId,o]));
      for(const row of kept.observations)if(!rows.has(row.photoId))rows.set(row.photoId,row);
      effective.set(kept.id,{...kept,...old,observations:[...rows.values()]});
    }else effective.set(kept.id,kept);
  }
  return [...effective.values()];
}
export function assistanceSource(project,record=null) {
  const id=record&&Object.hasOwn(record,'sourceAttemptId')?record.sourceAttemptId:(project.pendingAttemptId??project.activeAttemptId??null);
  return scope(project,id);
}
async function inputRequest(folder,request,execute) {
  mkdirSync(folder,{recursive:true});
  const token=randomBytes(8).toString('hex'),path=resolve(folder,`input-${token}.json`),result=resolve(folder,`input-${token}-result.json`);
  atomicJson(path,request);
  const args=[resolve(PY_DIR,'assistance_inputs.py'),'--request',path,'--result',result];
  if(execute)await execute(TOOLS.python,args);
  else await exec(TOOLS.python,args,{windowsHide:true,timeout:120000,maxBuffer:1024*1024,env:{...process.env,PYTHONUTF8:'1'}});
  return readJson(result);
}
export async function getContext(project,{fresh=false,execute}={}) {
  const d=dirs(project),cachePath=resolve(d.summary,'assistance-context.json');
  const cached=existsSync(cachePath)?readJson(cachePath):null;
  if(cached&&!fresh)return {...cached,gate:readGate(project)};
  const frozen=resolve(d.workspace,'inputs/matching.db');
  const candidate=existsSync(frozen)?frozen:resolve(d.sfm,'database.db');
  const database=existsSync(candidate)?candidate:null;
  if((!database&&!project.componentSource)||!existsSync(d.manifest))throw inputError('照片清单或源匹配数据库缺失。请重试前置步骤。',409);
  const models=sparseModels(project).map(name=>({name,path:resolve(d.sparse,name)}));
  const request={manifest:d.manifest,images:d.images,database,models:models.map(m=>m.path),config:ASSISTANCE_CONFIG};
  let snapshot=database?(cached?.matchingSnapshot??null):null;
  if(database&&(!snapshot||!existsSync(snapshot))){
    snapshot=resolve(d.workspace,'inputs',`matches-${randomBytes(8).toString('hex')}.db`);
    request.snapshot=snapshot;
  }
  let result=await inputRequest(d.summary,request,execute);
  if(database&&cached&&!request.snapshot&&cached.inputs.matchingContentSha256!==result.inputs.matchingContentSha256){
    snapshot=resolve(d.workspace,'inputs',`matches-${randomBytes(8).toString('hex')}.db`);
    result=await inputRequest(d.summary,{...request,snapshot},execute);
  }else if(database&&cached&&!request.snapshot){result.inputs.matchingSnapshotSha256=cached.inputs.matchingSnapshotSha256;}
  const value={...result,models,database,matchingSnapshot:snapshot,matchingAvailable:!!database,sourceAttemptId:project.activeAttemptId??null};
  atomicJson(cachePath,value);
  return {...value,gate:readGate(project)};
}
export async function prepareAutomaticAttempt(project,fromStep,{execute,onAttempt}={}) {
  const source=assistanceSource(project),sd=dirs(source);
  const attempt=createAttempt(source,{kind:'automatic',inputRevision:null,inputFingerprint:null});
  onAttempt?.(attempt);
  const target=scope(project,attempt.id),d=dirs(target);
  if(['gate','undistort','train'].includes(fromStep)&&existsSync(sd.sparse))cpSync(sd.sparse,d.sparse,{recursive:true});
  if(['match','sparse','gate','undistort','train'].includes(fromStep)&&!project.componentSource){
    const frozen=resolve(sd.workspace,'inputs/matching.db'),geometric=resolve(sd.sfm,'database.db');
    const database=(['match','sparse'].includes(fromStep)||!existsSync(geometric))&&existsSync(frozen)?frozen:geometric;
    if(!existsSync(database))throw inputError('源匹配数据库不存在，请先提取特征和匹配。',409);
    await inputRequest(d.summary,{manifest:d.manifest,images:d.images,database,snapshot:resolve(d.sfm,'database.db'),models:[],config:ASSISTANCE_CONFIG},execute);
    if(existsSync(frozen))await inputRequest(d.summary,{manifest:d.manifest,images:d.images,database:frozen,snapshot:resolve(d.workspace,'inputs/matching.db'),models:[],config:ASSISTANCE_CONFIG},execute);
  }
  if(project.componentSource){
    for(const name of ['component-source','component-selection.json'])if(existsSync(resolve(sd.sfm,name)))cpSync(resolve(sd.sfm,name),resolve(d.sfm,name),{recursive:true});
  }
  if(['gate','undistort','train'].includes(fromStep)&&source.activeAttemptId){
    const previous=readAttempt(project,source.activeAttemptId),selected=project.selectedModel??previous.result?.selectedModel;
    if(previous.status==='verified'&&selected&&sparseModels(target).includes(selected)){
      const signature=geometrySignature(resolve(d.sparse,selected));
      if(signature===previous.result?.geometrySignature){
        attempt.result={geometrySignature:signature,bridges:previous.result.bridges??null,localRepair:previous.result.localRepair??null,scale:previous.result.scale??null};
        attempt.localRepairRequired=previous.localRepairRequired??false;
      }
    }
  }
  if(['undistort','train'].includes(fromStep)){
    const gate=readGate(source);
    if(gate?.verdict!=='pass')throw inputError('当前模型尚未验证，不能继续训练。',409);
    atomicJson(resolve(d.summary,'gate.json'),gate);
    attempt.inputFingerprint=(await getContext(target,{fresh:true,execute})).inputs;
    attempt.status='verified';attempt.result={...attempt.result,selectedModel:project.selectedModel,geometrySignature:geometrySignature(resolve(d.sparse,project.selectedModel)),gate,bridges:attempt.result?.bridges??null};
    if(fromStep==='train'&&existsSync(sd.undistorted)){
      cpSync(sd.undistorted,d.undistorted,{recursive:true});
      const origin=resolve(d.undistorted,'geometry-source.json');
      if(existsSync(origin))atomicJson(origin,{...readJson(origin),attemptId:attempt.id});
    }
  }
  writeAttempt(project,attempt);
  return {attempt,project:target};
}
export async function prepareAssistedAttempt(project,record,{execute,onAttempt}={}) {
  const source=assistanceSource(project,record);
  const attempt=createAttempt(source,{kind:'assisted',inputRevision:record.revision,inputFingerprint:record.inputs});
  onAttempt?.(attempt);
  const context=await getContext(source,{fresh:true,execute});
  if(!context.matchingAvailable)throw inputError('辅助全局求解需要源匹配数据库。该独立区域只有导出的几何数据。',409);
  const target=scope(project,attempt.id),d=dirs(target);
  const models=context.models.map(m=>({name:m.name,path:resolve(d.workspace,'inputs/models',m.name)}));
  const frozen=await inputRequest(d.summary,{manifest:d.manifest,images:d.images,database:context.matchingSnapshot,
    snapshot:resolve(d.workspace,'inputs/matching.db'),models:models.map(m=>m.path),config:ASSISTANCE_CONFIG},execute);
  attempt.inputFingerprint=frozen.inputs;attempt.localRepairRequired=record.localRepair!=null;writeAttempt(project,attempt);
  const regionalCandidates=[],candidateHashes=new Set();
  for(const previousId of new Set([record.sourceAttemptId,record.lastAttemptId].filter(Boolean))){
    const previous=readAttempt(project,previousId),pd=dirs(project,{attemptId:previous.id});
    const sameDerivedInputs=['photosSha256','matchingContentSha256','configSha256'].every(k=>typeof previous.inputFingerprint?.[k]==='string'&&previous.inputFingerprint[k]===context.inputs[k]);
    const folders=['regional-candidates/sparse','inputs/regional-candidates','sfm/local-native/sparse'].map(name=>resolve(pd.workspace,name)).filter(existsSync);
    if(previous.kind==='assisted'&&['needs_input','failed','aborted','verified'].includes(previous.status)&&sameDerivedInputs){
      const base=realpathSync(pd.workspace);
      for(const folder of folders)for(const entry of readdirSync(folder,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d+$/.test(e.name))){
        const input=resolve(folder,entry.name);if(!realpathSync(input).startsWith(base+sep))throw inputError('区域候选路径越界');
        const signature=candidateSignature(input);if(candidateHashes.has(signature))continue;candidateHashes.add(signature);
        const target=resolve(d.workspace,'inputs/regional-candidates',String(regionalCandidates.length));cpSync(input,target,{recursive:true,errorOnExist:true,force:false});
        regionalCandidates.push({name:`incremental-${regionalCandidates.length}`,path:target,modelSignature:candidateSignature(target),sourceAttemptId:previous.id});
      }
    }
  }
  const priorBridgeChecks=record.localRepair&&source.activeAttemptId?priorConnectionChecks(project,source.activeAttemptId):[];
  const preservedLandmarks=record.localRepair&&source.activeAttemptId?preservedSourceLandmarks(project,source.activeAttemptId,record.landmarks,priorBridgeChecks):[];
  const request={version:1,inputRevision:record.revision,inputFingerprint:frozen.inputs,catalog:frozen.catalog,regions:record.regions,models,
    database:resolve(d.workspace,'inputs/matching.db'),images:d.images,manifest:d.manifest,config:ASSISTANCE_CONFIG,
    constraints:{answers:record.answers,objects:record.objects,landmarks:record.landmarks,dimensions:record.dimensions,questions:record.questions,coverage:record.coverage??[],localRepair:record.localRepair??null},
    priorBridgeChecks,preservedLandmarks,
    regionalCandidates,
    colmap:project.useGpu?TOOLS.colmapGpu:TOOLS.colmapCpu,outputRoot:d.workspace};
  const requestPath=resolve(d.workspace,'inputs/assisted-request.json'),resultPath=resolve(d.summary,'assistance-result.json');
  atomicJson(requestPath,request);
  return {attempt,project:target,request,requestPath,resultPath,context};
}
