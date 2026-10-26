import {mountAnnotation} from './annotation.js';
import {mountQualityReview} from './quality-review.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STATES={needs_input:'等待用户补充',ready:'信息已保存，可继续求解',solving:'正在求解',verified:'几何检查已通过',stale:'输入已改变，需要复查',failed:'求解失败，请查看日志'};
const OPTIONS={yes:'是',no:'不是',unknown:'不知道',near_door:'近处的门',beyond_door:'门外的门',inside:'室内侧',outside:'门外侧',doorway:'门口连接',ghosting:'墙面重影',proportions:'房间比例',other:'其他'};
const EDITABLE=['answers','regionLabels','objects','landmarks','dimensions','coverage','onlyExistingPhotos','localRepair'];
const draftOf=record=>Object.fromEntries(EDITABLE.map(k=>[k,structuredClone(record?.[k]??(k==='onlyExistingPhotos'?false:k==='localRepair'?null:[]))]));

/** The server owns readiness and verification. This view owns only an unsaved draft. */
export function mountAssistance(root,{api,onProjectChange=()=>{},onSceneChange=()=>{}}){
 let project=null,record=null,draft=null,dirty=false,busy=false,message='',conflict=false,selected=[],destroyed=false,annotation=null;
 let reusePreview=null,reuseSource='';
 let lastSummary={};const qualityRoot=document.createElement('div');
 const qualityView=mountQualityReview(qualityRoot,{api,onSceneChange,onReview:async result=>{record=result.record;if(!dirty)draft=draftOf(record);lastSummary={...lastSummary,assistance:record,quality:result.quality};render();await onProjectChange();}});
 const abort=new AbortController();
 const url=suffix=>`/api/projects/${project.id}/assistance${suffix??''}`;
 const photoUrl=photo=>`/api/projects/${project.id}/image?photoId=${encodeURIComponent(photo.photoId)}`;
 const photos=()=>record?.photos??[];
 const mark=()=>{dirty=true;message='尚未保存';root.querySelector('[data-save-state]').textContent=message;root.querySelector('[data-action="run"]').disabled=true;for(const button of root.querySelectorAll('[data-action="reuse"],[data-action="import-photos"]'))button.disabled=true;};
 function render(){
  annotation?.destroy();annotation=null;
  root.classList.remove('hidden');
  if(!record){root.innerHTML='<h3>位置和连接检查</h3><p>照片准备完成后，可以检查模型位置。</p><button data-action="check">检查位置</button><p data-save-state role="status"></p>';root.prepend(qualityRoot);qualityView.update(project,{...lastSummary,assistance:record});return;}
  const byPhoto=new Map(photos().map(p=>[p.photoId,p]));
  const image=id=>{const p=byPhoto.get(id);return p?`<figure><img loading="lazy" src="${photoUrl(p)}" alt="${esc(p.name)}"><figcaption>${esc(p.name)}</figcaption></figure>`:'';};
  const role=id=>draft.localRepair?.photoIds.includes(id)?'repair':draft.localRepair?.referencePhotoIds.includes(id)?'reference':draft.localRepair?.contextPhotoIds?.includes(id)?'context':'none';
  const roleSelect=id=>`<label>照片用途 <select data-repair-role="${esc(id)}">${[['none','仅用于标记'],['repair','加入修正范围'],['reference','作为固定参照'],['context','作为重建背景']].map(([value,label])=>`<option value="${value}" ${role(id)===value?'selected':''}>${label}</option>`).join('')}</select></label>`;
  const option=(q,value)=>{const val=typeof value==='string'?value:value.value,label=typeof value==='string'?(OPTIONS[val]??val):value.label;return `<button data-question="${esc(q.id)}" data-value="${esc(val)}" aria-pressed="${draft.answers.some(a=>a.questionId===q.id&&a.value===val)}">${esc(label)}</button>`;};
  const questions=(record.questions??[]).map(q=>`<section class="assist-question"><h4>${esc(q.text)}</h4><p class="muted">${esc(q.reason)}</p><div class="assist-photos">${(q.photoIds??[]).map(image).join('')}</div>${q.type==='coverage'?coverage(q.photoIds[0]):`<div class="row">${(q.options??[]).map(v=>option(q,v)).join('')}</div>`}${q.warning?`<p class="muted">${esc(q.warning)}</p>`:''}</section>`).join('');
  root.innerHTML=`<div class="row"><h3>辅助重建</h3><span class="badge">${esc(STATES[record.state]??record.state)}</span><button data-action="check">检查位置</button></div>
   <p>请选择门框、墙角或固定家具。避开相似地砖、镜中物体和移动物品。回答“是”后，仍需检查真实共同点。</p>
   ${(record.state==='verified'?[]:record.reasons??[]).map(r=>`<p class="assist-reason">${esc(r.message)}</p>`).join('')}
   ${record.state==='verified'?`<details data-assistance-history><summary>已保存的辅助资料</summary>${questions}</details>`:questions}
   <details><summary>区域名称</summary>${(record.regions??[]).map(r=>`<label>${esc(r.id)} <input data-region="${esc(r.id)}" maxlength="120" placeholder="例如：走廊" value="${esc(draft.regionLabels.find(l=>l.regionId===r.id)?.label??'')}"></label>`).join('')}</details>
   <div class="row"><label>手动选择照片 <select data-photo-picker>${photos().map(p=>`<option value="${esc(p.photoId)}">${esc(p.name)}</option>`).join('')}</select></label><button data-action="add-photo">加入标记照片</button></div>
   <p class="muted">可选择全部工作照片，不限于自动候选。图片坐标以工作照片为准。</p>
   <section data-local-scope><h4>局部位置修正</h4><p>把同一区域的全部照片加入修正范围。固定参照应位于位置可靠的区域。两侧仍需提供真实共同点。</p>
   <p>修正照片：${draft.localRepair?.photoIds.length??0} 张；固定参照：${draft.localRepair?.referencePhotoIds.length??0} 张</p>
   <p class="muted">标记照片只控制下方显示。移除标记照片不会移除修正范围。位置检查通过后，仍须检查渲染画面。</p>
   ${draft.localRepair?`<details><summary>查看全部范围</summary>${['photoIds','referencePhotoIds','contextPhotoIds'].flatMap(key=>draft.localRepair[key]??[]).map(id=>`<p>${esc(byPhoto.get(id)?.name??id)} <button data-remove-scope="${esc(id)}">从范围移除</button></p>`).join('')}</details><button data-action="clear-local-repair">取消局部修正</button>`:''}</section>
   ${draft.localRepair?`<details data-local-advanced><summary>高级几何选项</summary><p>角点细化会在原始标记附近查找真实图片角点。最大移动为 15 像素。求解记录会区分人工标记与检测结果，原始标记保持不变。</p>
   ${draft.landmarks.map((p,i)=>`<label><input type="checkbox" data-refine-corner="${esc(p.id)}" ${draft.localRepair.refineCornerIds?.includes(p.id)?'checked':''}>细化角点 ${i+1}（${esc(p.id)}）</label>`).join('')}
   <p>可用四个已标记边框角点排除镜面内部的自动特征。按边框顺序选择四角。计算出的区域仅用于排除特征。</p>
   <div class="row">${[1,2,3,4].map(n=>`<label>边框第 ${n} 角 <select data-exclusion-corner="${n}"><option value="">请选择</option>${draft.landmarks.map((p,i)=>`<option value="${esc(p.id)}">${i+1}（${esc(p.id)}）</option>`).join('')}</select></label>`).join('')}<button data-action="add-exclusion">添加排除区域</button></div>
   ${(draft.localRepair.excludedPlanarInteriors??[]).map((q,i)=>`<p>排除区域 ${i+1}：${q.map(esc).join(' / ')} <button data-remove-exclusion="${i}">移除排除区域</button></p>`).join('')}</details>`:''}
   <div class="assist-photos">${selected.map(id=>`<div data-selected-photo="${esc(id)}">${image(id)}${roleSelect(id)}<button data-remove-photo="${esc(id)}">移除照片</button></div>`).join('')}</div>
   <div data-annotation></div>
   <label><input type="checkbox" data-existing ${draft.onlyExistingPhotos?'checked':''}>只有现有照片</label>
   <details data-import-details><summary>增加照片或复用资料</summary><p>复用只复制你选中的事实和有效标记。新模型仍须重新检查。</p>
    <label>来源项目 ID <input data-reuse-source value="${esc(reuseSource)}" list="reuse-projects-${project.id}"></label><datalist id="reuse-projects-${project.id}" data-reuse-projects></datalist><button data-action="preview-reuse">预览可复用资料</button>
    <div data-reuse-preview>${reusePreview?`<p>相同内容的照片 ${reusePreview.photos.length} 张。</p>${reusePreview.conflicts.map(c=>`<p>${esc(c.message)}</p>`).join('')}${reusePreview.answers.map(a=>`<label><input type="checkbox" data-reuse-fact="${esc(a.id)}">${esc(a.description)}</label>`).join('')}<button data-action="reuse" ${dirty?'disabled':''}>复用所选资料</button>`:''}</div>
    <p>只有选择新照片目录后，工作台才复制照片。原图保持只读。</p><button data-action="import-photos" ${dirty?'disabled':''}>选择并导入照片</button></details>
   <ul>${(record.missing??[]).map(m=>`<li>${esc(m.message)}</li>`).join('')}</ul>
   <div class="row"><button data-action="save" class="primary" ${busy?'disabled':''}>保存回答</button><button data-action="run" ${busy||dirty||record.state!=='ready'?'disabled':''}>继续求解</button><button data-action="reload">读取服务器版本</button></div>
   <p data-save-state role="status">${esc(message||(dirty?'尚未保存':`已读取版本 ${record.revision}`))}</p>`;
  const annotationPhotos=photos().filter(p=>selected.includes(p.photoId)).map(p=>({...p,src:photoUrl(p),regionIds:record.regions.filter(r=>r.photoIds?.includes(p.photoId)).map(r=>r.id)}));
  if(annotationPhotos.length)annotation=mountAnnotation(root.querySelector('[data-annotation]'),{photos:annotationPhotos,objects:draft.objects,landmarks:draft.landmarks,dimensions:draft.dimensions,onChange:patch=>{Object.assign(draft,patch);mark();}});
  root.prepend(qualityRoot);qualityView.update(project,{...lastSummary,assistance:record});
  function coverage(photoId){const value=draft.coverage.find(c=>c.photoId===photoId);return `<label>照片区域 <select data-coverage="${esc(photoId)}"><option value="unknown">不知道</option><option value="new" ${value?.decision==='new'?'selected':''}>新区域</option>${record.regions.map(r=>`<option value="existing:${esc(r.id)}" ${value?.decision==='existing'&&value.regionId===r.id?'selected':''}>已有区域：${esc(draft.regionLabels.find(l=>l.regionId===r.id)?.label??r.id)}</option>`).join('')}</select></label>`;}
 }
 async function reload(){
  const id=project.id,data=await api(url());if(destroyed||project.id!==id)return;
  record=data.record;draft=draftOf(record);dirty=false;conflict=false;message='已读取服务器版本';render();
 }
 async function click(event){
  const button=event.target.closest('button');if(!button||!root.contains(button))return;
  if(button.dataset.question){draft.answers=draft.answers.filter(a=>a.questionId!==button.dataset.question);draft.answers.push({questionId:button.dataset.question,value:button.dataset.value});mark();render();return;}
  if(button.dataset.removePhoto){selected=selected.filter(id=>id!==button.dataset.removePhoto);render();return;}
  if(button.dataset.removeScope){for(const key of ['photoIds','referencePhotoIds','contextPhotoIds'])draft.localRepair[key]=draft.localRepair[key].filter(id=>id!==button.dataset.removeScope);mark();render();return;}
  if(button.dataset.removeExclusion!==undefined){draft.localRepair.excludedPlanarInteriors.splice(Number(button.dataset.removeExclusion),1);mark();render();root.querySelector('[data-local-advanced]').open=true;return;}
  const action=button.dataset.action;
  if(action==='add-exclusion'){
   const corners=[...root.querySelectorAll('[data-exclusion-corner]')].map(el=>el.value);
   if(corners.some(id=>!id)||new Set(corners).size!==4){message='请选择四个不同的边框角点。';root.querySelector('[data-save-state]').textContent=message;return;}
   draft.localRepair.excludedPlanarInteriors??=[];draft.localRepair.excludedPlanarInteriors.push(corners);mark();render();root.querySelector('[data-local-advanced]').open=true;return;
  }
  if(action==='clear-local-repair'){draft.localRepair=null;mark();render();return;}
  if(action==='add-photo'){const id=root.querySelector('[data-photo-picker]').value;if(!selected.includes(id))selected.push(id);render();return;}
  if(busy)return;
  const actionProject=project.id;
  const scopedApi=async(...args)=>{const value=await api(...args);if(destroyed||project.id!==actionProject)throw Object.assign(new Error('项目已切换'),{staleView:true});return value;};
  try{
   busy=true;
   if(action==='reload')await reload();
   if(action==='save'){
    const id=project.id,result=await scopedApi(url(),{method:'PUT',body:JSON.stringify({expectedRevision:record.revision,patch:draft})});
    if(destroyed||project.id!==id)return;record=result.record;if(result.quality)lastSummary.quality=result.quality;draft=draftOf(record);dirty=false;conflict=false;message=`已保存。版本 ${record.revision}`;render();
   }
   if(action==='run'){
    if(dirty||record.state!=='ready'||conflict)return;
    await scopedApi(url('/run'),{method:'POST',body:JSON.stringify({expectedRevision:record.revision})});message='已启动求解。请查看步骤和日志。';await onProjectChange();
   }
   if(action==='check'){
    const result=await scopedApi(url('/check'),{method:'POST',body:JSON.stringify({expectedRevision:record?.revision??0})});record=result.record;draft=draftOf(record);dirty=false;message='请选择要复查的位置。';render();await onProjectChange();
   }
   if(action==='preview-reuse'){
    reuseSource=root.querySelector('[data-reuse-source]').value.trim();if(!reuseSource)throw new Error('请选择来源项目。');
    reusePreview=await scopedApi(url(`/reuse?sourceProjectId=${encodeURIComponent(reuseSource)}`));render();root.querySelector('[data-import-details]').open=true;
   }
   if(action==='reuse'){
    if(dirty)throw new Error('请先保存当前回答。');
    const answerIds=[...root.querySelectorAll('[data-reuse-fact]:checked')].map(el=>el.dataset.reuseFact);
    if(!answerIds.length)throw new Error('请选择要复用的资料。');
    const result=await scopedApi(url('/reuse'),{method:'POST',body:JSON.stringify({expectedRevision:record.revision,sourceProjectId:reuseSource,answerIds})});record=result.record;draft=draftOf(record);dirty=false;reusePreview=null;message='已复用所选资料。请复查，再继续求解。';render();
   }
   if(action==='import-photos'){
    if(dirty)throw new Error('请先保存当前回答。');
    const chosen=await scopedApi('/api/dialog/folder',{method:'POST',body:JSON.stringify({title:'选择要添加的照片目录'})});
    if(!chosen){message='已取消选择。项目未改变。';return;}
    const result=await scopedApi(url('/photos'),{method:'POST',body:JSON.stringify({expectedRevision:record.revision,sourceDir:chosen.path})});record=result.record;draft=draftOf(record);message=`已添加 ${result.added} 张照片；忽略 ${result.duplicates} 张重复照片。请从照片预处理重跑。`;render();await onProjectChange();
   }
  }catch(error){if(error.staleView)return;conflict=error.status===409;message=conflict?`${error.message} 草稿已保留。点击“读取服务器版本”后重新编辑。`:error.message;}
  finally{if(!destroyed&&project.id===actionProject){busy=false;const status=root.querySelector('[data-save-state]');if(status)status.textContent=message;const save=root.querySelector('[data-action="save"]');if(save)save.disabled=false;const run=root.querySelector('[data-action="run"]');if(run)run.disabled=dirty||conflict||record?.state!=='ready'||['running','aborting'].includes(project?.state);}}
 }
 root.addEventListener('click',click,{signal:abort.signal});
 root.addEventListener('change',event=>{
  const el=event.target;
  if(el.matches('[data-existing]'))draft.onlyExistingPhotos=el.checked;
  else if(el.dataset.refineCorner){draft.localRepair.refineCornerIds=(draft.localRepair.refineCornerIds??[]).filter(id=>id!==el.dataset.refineCorner);if(el.checked)draft.localRepair.refineCornerIds.push(el.dataset.refineCorner);}
  else if(el.dataset.repairRole){
   draft.localRepair??={photoIds:[],referencePhotoIds:[],contextPhotoIds:[],refineCornerIds:[],excludedPlanarInteriors:[]};
   for(const key of ['photoIds','referencePhotoIds','contextPhotoIds'])draft.localRepair[key]=(draft.localRepair[key]??[]).filter(id=>id!==el.dataset.repairRole);
   const key={repair:'photoIds',reference:'referencePhotoIds',context:'contextPhotoIds'}[el.value];if(key)draft.localRepair[key].push(el.dataset.repairRole);
   mark();render();return;
  }
  else if(el.dataset.coverage){const [decision,...region]=el.value.split(':');draft.coverage=draft.coverage.filter(c=>c.photoId!==el.dataset.coverage);draft.coverage.push({photoId:el.dataset.coverage,decision,regionId:decision==='existing'?region.join(':'):null});}
  else if(el.dataset.region){draft.regionLabels=draft.regionLabels.filter(l=>l.regionId!==el.dataset.region);if(el.value.trim())draft.regionLabels.push({regionId:el.dataset.region,label:el.value.trim()});}
  else return;mark();
 },{signal:abort.signal});
 root.addEventListener('toggle',async event=>{
  if(!event.target.matches('[data-import-details]')||!event.target.open)return;
  try{const id=project.id,items=await api('/api/projects');if(id!==project.id||destroyed)return;const list=root.querySelector('[data-reuse-projects]');if(list)list.innerHTML=items.filter(p=>p.id!==id).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');}catch{}
 },{signal:abort.signal,capture:true});
 return {update(next,summary={}){
   if(destroyed)return;const changed=project?.id!==next.id;project=next;
   if(changed){busy=false;dirty=false;conflict=false;selected=[];message='';record=null;reusePreview=null;reuseSource='';lastSummary={};}
   lastSummary={...lastSummary,...summary};
   const incoming=summary.assistance;
   if(incoming!==undefined&&(!dirty||changed)){record=incoming;draft=draftOf(record);selected=selected.filter(id=>record?.photos?.some(p=>p.photoId===id));if(!selected.length)selected=[...new Set([...(record?.landmarks??[]).flatMap(p=>p.observations.map(o=>o.photoId)),...(record?.objects??[]).flatMap(o=>[...(o.rois??[]),...(o.corners??[])].map(r=>r.photoId))])];render();}
   else if(changed){render();reload().catch(error=>{message=error.message;const s=root.querySelector('[data-save-state]');if(s)s.textContent=message;});}
  },destroy(){destroyed=true;abort.abort();annotation?.destroy();qualityView.destroy();root.replaceChildren();}};
}
