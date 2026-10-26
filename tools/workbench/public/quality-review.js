const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LABELS={geometry:'几何连接',coverage:'区域覆盖',appearance:'画面质量',scale:'实际尺度'};
const VALUES={verified:'已验证',failed:'未通过',unverified:'未验证',reviewed:'已检查',missing:'存在遗漏或未知',unreviewed:'未检查',passed:'已通过',needs_improvement:'需要改进',unmeasured:'未验证',calibrated:'已按实测校准'};
const ITEMS={doorway:'门口连接',ghosting:'墙面重影',proportions:'房间比例',coverage:'区域覆盖'};
export function mountQualityReview(root,{api,onReview=()=>{},onSceneChange=()=>{}}){
 let project,summary={},identity='',edited=false,revision=0,busy=false,message='',evaluation=null,comparison=null,history='_current_',dead=false;
 const abort=new AbortController();
 const endpoint=suffix=>`/api/projects/${project.id}${suffix}`;
 const scopedApi=async(id,...args)=>{const requestedIdentity=identity;const result=await api(...args);if(dead||project?.id!==id||identity!==requestedIdentity)throw Object.assign(new Error('项目或模型已切换'),{staleView:true});return result;};
 function render(){
  const q=summary.quality??{},record=summary.assistance;
  root.innerHTML=`<h3>质量状态</h3><div class="quality-states">${Object.entries(LABELS).map(([key,label])=>`<span>${label}：<strong>${esc(VALUES[q[key]]??'未验证')}</strong></span>`).join('')}<span>训练目标：${q.trainingComplete?'已达到':'未达到'}</span><strong>${q.complete?'完整检查已通过':'完整检查尚未通过'}</strong></div>
   <p class="muted">照片未记录的表面不能通过增加训练步数恢复。未实测尺寸时，不显示确定的米或厘米数。</p>
   <label>查看历史模型 <select data-history><option value="_current_">当前采用的模型</option><option value="legacy">原有结果</option>${(summary.attempts??[]).filter(a=>a.id!==project.activeAttemptId).map(a=>`<option value="${esc(a.id)}">${esc(a.createdAt)} · ${esc(a.status)} · ${esc(a.id)}</option>`).join('')}</select></label>
   <details data-review-details><summary>画面检查</summary><p>查看当前模型后，逐项检查。历史模型只供查看。</p>
    <div class="row">${Object.entries(ITEMS).map(([code,label])=>`<label>${label} <select data-review-item="${code}"><option value="unreviewed">未检查</option><option value="passed">通过</option><option value="needs_improvement">需要改进</option></select></label>`).join('')}</div>
    <label>检查照片 <select data-review-photos multiple size="4">${(record?.photos??[]).map(p=>`<option value="${esc(p.photoId)}">${esc(p.name)}</option>`).join('')}</select></label>
    <label>检查区域 <select data-review-regions multiple size="3">${(record?.regions??[]).map(r=>`<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('')}</select></label>
    <label>检查说明 <textarea data-review-note rows="3" maxlength="2000" placeholder="记录位置不符、重影或比例问题"></textarea></label>
    <label><input type="checkbox" data-position-recheck>需要重新检查位置</label><button data-quality-action="review">保存画面检查</button><button data-quality-action="reset-review">重新读取检查版本</button></details>
   <p data-review-message role="status">${esc(message)}</p>
   <button data-quality-action="evaluation">载入固定评估对比</button><div data-evaluation></div>`;
  root.querySelector('[data-history]').value=history;
  root.querySelector('[data-quality-action="review"]').disabled=history!=='_current_'||busy;
  renderEvaluation();
 }
 const imageUrl=(attempt,step,name)=>endpoint(`/evaluation/image?${new URLSearchParams({...(attempt?{attemptId:attempt}:{}),step,name})}`);
 function renderEvaluation(){
  const node=root.querySelector('[data-evaluation]');if(!node||!evaluation)return;
  const right=comparison??evaluation;
  const common=evaluation.photos.filter(p=>right===evaluation||p.photoId&&right.photos.some(r=>r.photoId===p.photoId));
  node.innerHTML=`<p>两侧使用同一评估照片。不同模型只比较内容指纹相同的照片。</p>
   <div class="row"><label>对比尝试 <select data-eval-attempt><option value="">同一模型</option><option value="legacy">原有结果</option>${(summary.attempts??[]).map(a=>`<option value="${esc(a.id)}">${esc(a.id)}</option>`).join('')}</select></label>
   <label>评估照片 <select data-eval-photo>${common.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</select></label>
   <label>左侧步数 <select data-eval-left>${evaluation.steps.map(step=>`<option>${step}</option>`).join('')}</select></label>
   <label>右侧步数 <select data-eval-right>${right.steps.map(step=>`<option ${step===right.steps.at(-1)?'selected':''}>${step}</option>`).join('')}</select></label></div><div class="eval-pair" data-eval-pair></div>`;
  node.querySelector('[data-eval-attempt]').value=comparison?comparison.requestedAttempt:'';drawComparison();
 }
 function drawComparison(){
  const name=root.querySelector('[data-eval-photo]')?.value,pair=root.querySelector('[data-eval-pair]'),left=Number(root.querySelector('[data-eval-left]')?.value),rightStep=Number(root.querySelector('[data-eval-right]')?.value),right=comparison??evaluation;
  if(!pair)return;const photo=evaluation.photos.find(p=>p.name===name),other=comparison?right.photos.find(p=>p.photoId&&p.photoId===photo?.photoId):photo;
  if(!photo||!other){pair.textContent='没有可确认的共同评估照片。';return;}
  pair.innerHTML=[{data:evaluation,step:left,name:photo.name,attempt:null},{data:right,step:rightStep,name:other.name,attempt:comparison?.requestedAttempt}].map(side=>side.data.available.some(s=>s.step===side.step&&s.names.includes(side.name))?`<figure><figcaption>${side.step} 步 · ${esc(side.name)}</figcaption><img data-eval-image src="${imageUrl(side.attempt,side.step,side.name)}" alt="${esc(side.name)} ${side.step} 步"></figure>`:'<p>该步数没有此评估照片。</p>').join('');
 }
 root.addEventListener('change',async event=>{
  const el=event.target;
  const sourceProject=project.id;
  if(el.matches('[data-history]')){
   history=el.value;try{if(history==='_current_')await onSceneChange(null);else{const scene=await scopedApi(sourceProject,endpoint(`/attempts/${history}/scene`));if(!scene)throw new Error('该次尝试尚无场景导出。');await onSceneChange(scene);}}
   catch(error){if(error.staleView)return;message=error.message;history='_current_';el.value=history;await onSceneChange(null);}
   root.querySelector('[data-quality-action="review"]').disabled=history!=='_current_';root.querySelector('[data-review-message]').textContent=message||(history==='_current_'?'当前模型可检查。':'正在查看历史模型。请返回当前模型后保存检查。');
  }else if(el.matches('[data-eval-attempt]')){
   try{comparison=el.value?{...await scopedApi(sourceProject,endpoint(`/evaluation?attemptId=${encodeURIComponent(el.value)}`)),requestedAttempt:el.value}:null;renderEvaluation();}catch(error){if(!error.staleView)root.querySelector('[data-review-message]').textContent=error.message;}
  }else if(el.matches('[data-eval-photo],[data-eval-left],[data-eval-right]'))drawComparison();
  else if(el.closest('[data-review-details]'))edited=true;
 },{signal:abort.signal});
 root.addEventListener('click',async event=>{
  const action=event.target.closest('[data-quality-action]')?.dataset.qualityAction;if(!action||busy)return;
  const sourceProject=project.id;
  try{
   busy=true;
   if(action==='reset-review'){edited=false;revision=summary.assistance?.revision??0;message='已读取当前检查版本。';render();}
   if(action==='evaluation'){evaluation=await scopedApi(sourceProject,endpoint('/evaluation'));comparison=null;renderEvaluation();}
   if(action==='review'){
    if(history!=='_current_')throw new Error('请返回当前模型后保存检查。');
    const photoIds=[...root.querySelector('[data-review-photos]').selectedOptions].map(o=>o.value),regionIds=[...root.querySelector('[data-review-regions]').selectedOptions].map(o=>o.value),note=root.querySelector('[data-review-note]').value;
    const items=[...root.querySelectorAll('[data-review-item]')].filter(el=>el.value!=='unreviewed').map(el=>({code:el.dataset.reviewItem,status:el.value,photoIds,regionIds,note}));
    if(!items.length)throw new Error('请至少检查一项。');
    const requestPositionCheck=root.querySelector('[data-position-recheck]').checked,appearance=items.length===4&&items.every(i=>i.status==='passed')&&!requestPositionCheck?'passed':'needs_improvement';
    const gate=summary.gate,model=gate?.models?.find(m=>m.name===(project.selectedModel??gate.selectedModel));
    const result=await scopedApi(sourceProject,endpoint('/assistance/review'),{method:'POST',body:JSON.stringify({expectedRevision:revision,attemptId:project.activeAttemptId??null,geometrySignature:model?.geometrySignature,review:{appearance,items,requestPositionCheck}})});
    edited=false;message='画面检查已保存。'+(appearance==='needs_improvement'?'仍需改进。':'');await onReview(result);
   }
  }catch(error){if(error.staleView)return;message=error.status===409?`${error.message} 请重新读取检查版本。`:error.message;}
  finally{if(!dead&&project.id===sourceProject){busy=false;const node=root.querySelector('[data-review-message]');if(node)node.textContent=message;const save=root.querySelector('[data-quality-action="review"]');if(save)save.disabled=history!=='_current_';}}
 },{signal:abort.signal});
 return {update(next,data){const nextIdentity=`${next.id}|${next.activeAttemptId??''}|${data.gate?.models?.map(m=>m.geometrySignature).join('|')}`;project=next;summary=data;
  if(nextIdentity!==identity){const hadHistory=history!=='_current_';identity=nextIdentity;busy=false;edited=false;history='_current_';evaluation=null;comparison=null;message='';if(hadHistory)onSceneChange(null);}
  if(!edited){revision=data.assistance?.revision??0;render();}
 },destroy(){dead=true;abort.abort();root.replaceChildren();}};
}
