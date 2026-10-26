import { createHash } from 'node:crypto';

export const workName=name=>String(name).replaceAll('\\','/').replace(/^(?:inputs\/)?images\//,'');
const questionId=(type,ids)=>`${type}-${createHash('sha256').update(ids.join('|')).digest('hex').slice(0,20)}`;
export function classifyToolFailure(_error) { return 'failed'; }

/** Local, deterministic questions. A match count ranks pictures, never proves a link. */
export function diagnoseAssistance({gate,catalog=[],record=null,manualRequest=false}) {
  const photos=Array.isArray(catalog)?catalog:catalog.photos??[];
  const byName=new Map(photos.map(p=>[workName(p.name),p]));
  const regions=[],reasons=[],questions=[],missing=[];
  for(const model of gate?.models??[]){
    for(const component of model.geometryComponents??[]){
      regions.push({id:`${model.name}:${component.index}`,model:model.name,component:component.index,
        registered:component.registered,photoIds:component.images.map(name=>byName.get(workName(name))?.photoId).filter(Boolean),
        imageNames:component.images,geometrySignature:model.geometrySignature});
    }
  }
  const registered=new Set(regions.flatMap(r=>r.photoIds));
  const unregistered=photos.filter(p=>!registered.has(p.photoId));
  const split=regions.length>1 || (gate?.models??[]).some(m=>m.geometryComponentSizes?.length>1);
  if(split)reasons.push({code:'disconnected_regions',message:`检测到 ${regions.length} 个独立区域。分量之间没有经过验证的共同三维点。`});
  if(gate&&gate.verdict!=='pass'&&!split)reasons.push({code:'weak_geometry',message:gate.message??'当前几何未通过检查。'});
  if(manualRequest)reasons.push({code:'position_review',message:'你要求复查模型位置。请选择需要检查的照片和共同内容。'});
  for(const photo of unregistered){
    const answer=record?.coverage?.find(c=>c.photoId===photo.photoId);
    if(!answer||answer.decision!=='existing'){
      reasons.push({code:'coverage_unknown',photoId:photo.photoId,message:'存在未定位照片，目标区域覆盖尚未确认。'});
      missing.push({code:answer?.decision==='new'?'new_region_unregistered':'coverage_unknown',photoId:photo.photoId,message:answer?.decision==='new'?'新区域尚未定位，请选择共同可见的照片。':'请确认未定位照片属于哪个区域。'});
    }
    questions.push({id:questionId('coverage',[photo.photoId]),type:'coverage',reason:'定位率不能排除遗漏了一个房间。',text:'这张未定位照片属于已有区域、新区域，还是不知道？',photoIds:[photo.photoId],options:['existing','new','unknown']});
  }
  const pairs=(gate?.bridgeCandidates??[]).map(c=>({...c,a:byName.get(workName(c.first)),b:byName.get(workName(c.second))})).filter(c=>c.a&&c.b);
  if(split&&!pairs.length&&regions.length>1){
    for(let i=1;i<regions.length;i++){
      const a=photos.find(p=>regions[0].photoIds.includes(p.photoId));
      const b=photos.find(p=>regions[i].photoIds.includes(p.photoId));
      if(a&&b)pairs.push({a,b,inliers:0,configuration:'未确认'});
    }
  }
  if(split||manualRequest){
    for(const pair of pairs.slice(0,24)){
      const ids=[pair.a.photoId,pair.b.photoId];
      questions.push({id:questionId('same',ids),type:'same_object',reason:'需要确认跨区域共同内容，再搜索真实对应点。',text:'这两张照片是否拍到同一扇门、墙角或固定物体？',photoIds:ids,options:['yes','no','unknown'],allowManualSelection:true,inliers:pair.inliers,configuration:pair.configuration,warning:'请避开相似地砖、镜中物体和移动物品。匹配数量不能证明位置正确。'});
      questions.push({id:questionId('door',ids),type:'door_relation',reason:'门的内外两面和门外另一扇门不能混用。不是门时可选“不知道”。',text:'你要标记照片中的哪部分？',photoIds:ids,options:['near_door','beyond_door','inside','outside','unknown'],allowManualSelection:true});
    }
    questions.push({id:questionId('observations',regions.map(r=>r.id)),type:'observations',reason:'物体名称和门位关系不能确定距离与比例。',text:'请选择共同区域，或在多张照片中标记同一物理位置。',photoIds:[],options:[],allowManualSelection:true});
    missing.push({code:'reliable_observations_needed',message:'需要真实共享点。可选择其他照片，不限于自动候选。'});
  }
  if(manualRequest)questions.push({id:'position-review',type:'position_review',reason:'连通模型仍可能有局部位置错误或重影。',text:'请选择位置不符的照片或图像区域。',photoIds:[],options:['doorway','ghosting','proportions','other'],allowManualSelection:true});
  return {required:reasons.length>0,reasons,questions,missing,regions,unregistered:unregistered.map(p=>p.photoId)};
}
