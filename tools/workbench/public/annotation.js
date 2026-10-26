import {viewToImage,imageToView} from './annotation-coordinates.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=prefix=>`${prefix}-${crypto.randomUUID().slice(0,12)}`;
export function mountAnnotation(root,{photos=[],objects=[],landmarks=[],dimensions=[],onChange=()=>{}}){
 root.classList.add('annotation-editor');
 let data=structuredClone({photos,objects,landmarks,dimensions}),photoId=photos[0]?.photoId,objectId=objects[0]?.id??'',pointId=landmarks[0]?.id??'',mode='point',zoom=1,pan={x:0,y:0},roi=[],corners=[],drag=null,ready=false,dead=false;
 const abort=new AbortController();let resizeObserver;
 const photo=()=>data.photos.find(p=>p.photoId===photoId),object=()=>data.objects.find(o=>o.id===objectId);
 const emit=()=>onChange(structuredClone({objects:data.objects,landmarks:data.landmarks,dimensions:data.dimensions}));
 const message=text=>{root.querySelector('[data-annotation-message]').textContent=text;};
 function controls(){
  root.innerHTML=`<h4>共同内容标记</h4><p class="muted">同一编号必须指向同一物理位置。每侧至少选两张有视角变化的照片。门的内外两面不能混用。</p>
   <div class="row"><label>标记照片 <select data-edit-photo>${data.photos.map(p=>`<option value="${esc(p.photoId)}" ${p.photoId===photoId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>
   <label>共同物体 <select data-object><option value="">未指定</option>${data.objects.map(o=>`<option value="${esc(o.id)}" ${o.id===objectId?'selected':''}>${esc(o.id)}</option>`).join('')}</select></label><button data-edit-action="object">新建共同物体</button>
   <label>物体模式 <select data-kind><option value="points" ${object()?.kind!=='planar'?'selected':''}>非平面或普通对应点</option><option value="planar" ${object()?.kind==='planar'?'selected':''}>同一平面</option></select></label></div>
   <div class="row"><label>编辑模式 <select data-mode><option value="point">对应点</option><option value="roi">圈选共同区域</option><option value="corners">平面四角</option><option value="move">移动标记</option><option value="pan">平移图片</option></select></label>
   <label>对应点编号 <select data-point><option value="">请选择或新建</option>${data.landmarks.map(p=>`<option value="${esc(p.id)}" ${p.id===pointId?'selected':''}>${esc(p.id)}（${p.observations.length} 张）</option>`).join('')}</select></label><button data-edit-action="point">新建对应点</button>
   <button data-edit-action="finish-roi">完成圈选</button><button data-edit-action="undo">撤销当前顶点</button><button data-edit-action="delete-observation">删除本图观察</button><button data-edit-action="delete-point">删除对应点</button><button data-edit-action="clear-object">清除本图物体标记</button></div>
   <div class="row"><label>缩放 <input data-zoom type="number" min="0.25" max="8" step="0.25" value="${zoom}" style="width:80px"></label><button data-edit-action="pan">平移图片</button><button data-edit-action="reset-view">复位视图</button></div>
   <p class="muted">移动标记模式：拖动空白处移动图片，拖动圆点修改标记。其他模式可按住鼠标中键拖动图片。</p>
   <div class="annotation-stage"><img data-work-photo alt="工作照片"><svg data-annotation-surface role="img" aria-label="工作照片标记画布"></svg></div>
   <p data-annotation-message role="status"></p><p data-point-count class="muted"></p>
   <details><summary>可选尺寸</summary><p>不知道尺寸时可留空。实测或估计尺寸须选择两个不同的对应点。</p>
    <div class="row"><label>尺寸来源 <select data-dim-source><option value="unknown">不知道</option><option value="measured">实测</option><option value="estimated">估计</option></select></label><label>尺寸值 <input data-dim-value type="number" min="0" step="any" style="width:100px"></label><label>单位 <select data-dim-unit><option>cm</option><option>m</option><option>mm</option></select></label>
    ${['start','end'].map((key,i)=>`<label>端点 ${i+1} <select data-dim-${key}><option value="">未指定</option>${data.landmarks.map(p=>`<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('')}</select></label>`).join('')}<button data-edit-action="dimension">添加尺寸</button></div>
    <ul>${data.dimensions.map(d=>`<li>${esc(d.source)}：${d.value??'未知'} ${esc(d.unit)} <button data-delete-dimension="${esc(d.id)}">删除尺寸</button></li>`).join('')}</ul></details>`;
  root.querySelector('[data-mode]').value=mode;
  const image=root.querySelector('[data-work-photo]');ready=false;
  image.onload=()=>{if(dead)return;const p=photo();ready=image.naturalWidth===p?.width&&image.naturalHeight===p?.height;message(ready?'请在图片内容中标记。放大后可点击“平移图片”查看边缘。':'工作图片尺寸已改变，请重新读取项目。');draw();};
  if(photo())image.src=photo().src;else message('请先加入标记照片。');
  resizeObserver?.disconnect();resizeObserver=new ResizeObserver(draw);resizeObserver.observe(root.querySelector('.annotation-stage'));
  draw();
 }
 function transform(){
  const p=photo(),stage=root.querySelector('.annotation-stage'),b=stage?{width:stage.clientWidth,height:stage.clientHeight}:null;
  if(!p||!b||!b.width||!b.height)return null;
  const ratio=Math.min(b.width/p.width,b.height/p.height),width=p.width*ratio,height=p.height*ratio;
  return {rect:{x:(b.width-width)/2,y:(b.height-height)/2,width,height},workWidth:p.width,workHeight:p.height,zoom,pan};
 }
 function draw(){
  if(dead)return;const t=transform(),svg=root.querySelector('svg'),image=root.querySelector('[data-work-photo]');if(!t||!svg)return;
  const stage=root.querySelector('.annotation-stage'),b={width:stage.clientWidth,height:stage.clientHeight};svg.setAttribute('viewBox',`0 0 ${b.width} ${b.height}`);
  const origin=imageToView([0,0],t);Object.assign(image.style,{left:`${origin.x}px`,top:`${origin.y}px`,width:`${t.rect.width*zoom}px`,height:`${t.rect.height*zoom}px`});
  svg.dataset.ready=String(ready);
  svg.dataset.interaction=drag?.type==='pan'?'panning':mode;
  const coords=points=>points.map(xy=>{const p=imageToView(xy,t);return `${p.x},${p.y}`;}).join(' ');
  const circle=(xy,attrs,label='')=>{const p=imageToView(xy,t);return `<circle cx="${p.x}" cy="${p.y}" r="6" ${attrs}/>${label?`<text x="${p.x+9}" y="${p.y-7}">${esc(label)}</text>`:''}`;};
  const o=object(),savedRoi=o?.rois?.find(r=>r.photoId===photoId)?.polygon??[],savedCorners=o?.corners?.find(r=>r.photoId===photoId)?.xy??[];
  svg.innerHTML=`${savedRoi.length?`<polygon points="${coords(savedRoi)}" class="roi-shape"/>`:''}${roi.length?`<polyline points="${coords(roi)}" class="roi-shape"/>`:''}
   ${savedRoi.map((xy,i)=>circle(xy,`data-vertex="roi:${i}"`,String(i+1))).join('')}
   ${[...savedCorners,...corners].map((xy,i)=>circle(xy,`data-vertex="corners:${i}"`,String(i+1))).join('')}
   ${data.landmarks.flatMap(p=>p.observations.filter(o=>o.photoId===photoId).map(o=>circle(o.xy,`data-marker="${esc(p.id)}" class="${p.id===pointId?'selected':''}"`,p.id))).join('')}`;
  root.querySelector('[data-point-count]').textContent=`对应点 ${data.landmarks.length} 个；至少四张照片观察到的点 ${data.landmarks.filter(p=>p.observations.length>=4).length} 个。几何有效性由求解器检查。`;
  for(const option of root.querySelectorAll('[data-point] option')){const p=data.landmarks.find(p=>p.id===option.value);if(p)option.textContent=`${p.id}（${p.observations.length} 张）`;}
 }
 function ensureObject(){if(!object()){const o={id:uid('object'),kind:root.querySelector('[data-kind]').value,regions:[...new Set(data.photos.flatMap(p=>p.regionIds??[]))],rois:[],corners:[]};data.objects.push(o);objectId=o.id;}return object();}
 function pointer(event){
  const svg=root.querySelector('svg'),b=svg.getBoundingClientRect(),stage=root.querySelector('.annotation-stage');return {x:(event.clientX-b.x)*stage.clientWidth/b.width,y:(event.clientY-b.y)*stage.clientHeight/b.height};
 }
 root.addEventListener('pointerdown',event=>{
  const svg=event.target.closest('[data-annotation-surface]');if(!svg||!ready||drag||![0,1].includes(event.button))return;
  const at=pointer(event),xy=viewToImage(at,transform());
  const marker=event.target.closest('[data-marker]'),vertex=event.target.closest('[data-vertex]');
  if(mode==='pan'||event.button===1||(mode==='move'&&!marker&&!vertex)){
   event.preventDefault();drag={type:'pan',start:at,pan:{...pan},pointerId:event.pointerId};svg.setPointerCapture(event.pointerId);draw();return;
  }
  if(mode==='move'){
   if(marker){pointId=marker.dataset.marker;drag={type:'point',id:pointId};}
   else if(vertex){const [kind,index]=vertex.dataset.vertex.split(':');drag={type:kind,index:Number(index)};}
   if(drag){drag.pointerId=event.pointerId;svg.setPointerCapture(event.pointerId);}return;
  }
  if(!xy)return;
  if(mode==='point'){
   const point=data.landmarks.find(p=>p.id===pointId);if(!point){message('请先新建或选择对应点编号。');return;}
   const obs={photoId,xy,origin:'manual'};point.observations=point.observations.filter(o=>o.photoId!==photoId);point.observations.push(obs);emit();draw();
  }else if(mode==='roi'){ensureObject();roi.push(xy);draw();message('依次点击共同区域边界，再点击“完成圈选”。');}
  else if(mode==='corners'){
   const o=ensureObject();if(o.kind!=='planar'){message('四角只用于同一平面。普通物体请使用对应点或圈选。');return;}
   corners.push(xy);if(corners.length===4){o.corners=o.corners.filter(c=>c.photoId!==photoId);o.corners.push({photoId,xy:corners});corners=[];emit();}draw();message('四角顺序：沿同一物理平面依次标记。其他照片使用相同顺序。');
  }
 },{signal:abort.signal});
 root.addEventListener('pointermove',event=>{
  if(!drag||drag.pointerId!==event.pointerId)return;const at=pointer(event);
  if(drag.type==='pan'){pan={x:drag.pan.x+at.x-drag.start.x,y:drag.pan.y+at.y-drag.start.y};draw();return;}
  const xy=viewToImage(at,transform());if(!xy)return;
  if(drag.type==='point')data.landmarks.find(p=>p.id===drag.id).observations.find(o=>o.photoId===photoId).xy=xy;
  else{const entry=(drag.type==='roi'?object()?.rois:object()?.corners)?.find(o=>o.photoId===photoId);const points=drag.type==='roi'?entry?.polygon:entry?.xy;if(points?.[drag.index])points[drag.index]=xy;}
  draw();
 },{signal:abort.signal});
 const finishDrag=event=>{
  if(!drag||drag.pointerId!==event.pointerId)return;const finished=drag;drag=null;
  const svg=root.querySelector('[data-annotation-surface]');if(svg?.hasPointerCapture(finished.pointerId))svg.releasePointerCapture(finished.pointerId);
  if(finished.type!=='pan')emit();draw();
 };
 root.addEventListener('pointerup',finishDrag,{signal:abort.signal});root.addEventListener('pointercancel',finishDrag,{signal:abort.signal});root.addEventListener('lostpointercapture',finishDrag,{signal:abort.signal});
 root.addEventListener('input',event=>{if(event.target.matches('[data-zoom]')){const z=Number(event.target.value);if(z>=.25&&z<=8){zoom=z;draw();}}},{signal:abort.signal});
 root.addEventListener('change',event=>{
  const el=event.target;
  if(el.matches('[data-edit-photo]')){photoId=el.value;roi=[];corners=[];pan={x:0,y:0};controls();}
  else if(el.matches('[data-mode]')){mode=el.value;roi=[];corners=[];draw();}
  else if(el.matches('[data-object]')){objectId=el.value;controls();}
  else if(el.matches('[data-point]')){pointId=el.value;draw();}
  else if(el.matches('[data-kind]')){const o=ensureObject();o.kind=el.value;if(o.kind!=='planar')o.corners=[];emit();draw();}
 },{signal:abort.signal});
 root.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  const action=button.dataset.editAction;
  if(action==='point'){pointId=uid('point');data.landmarks.push({id:pointId,objectId:objectId||null,observations:[]});mode='point';emit();controls();}
  if(action==='object'){objectId='';ensureObject();emit();controls();}
  if(action==='finish-roi'){if(roi.length<3){message('圈选至少需要三个顶点。');return;}const o=ensureObject();o.rois=o.rois.filter(r=>r.photoId!==photoId);o.rois.push({photoId,polygon:roi});roi=[];emit();controls();}
  if(action==='undo'){if(mode==='roi')roi.pop();if(mode==='corners')corners.pop();draw();}
  if(action==='pan'){mode='pan';root.querySelector('[data-mode]').value=mode;draw();}
  if(action==='reset-view'){zoom=1;pan={x:0,y:0};root.querySelector('[data-zoom]').value=zoom;draw();}
  if(action==='delete-observation'){const p=data.landmarks.find(p=>p.id===pointId);if(p){p.observations=p.observations.filter(o=>o.photoId!==photoId);emit();draw();}}
  if(action==='delete-point'){data.landmarks=data.landmarks.filter(p=>p.id!==pointId);data.dimensions=data.dimensions.filter(d=>!d.endpoints?.some(e=>e.landmarkId===pointId));pointId='';emit();controls();}
  if(action==='clear-object'){const o=object();if(o){o.rois=o.rois.filter(r=>r.photoId!==photoId);o.corners=o.corners.filter(r=>r.photoId!==photoId);roi=[];corners=[];emit();draw();}}
  if(action==='dimension'){
   const source=root.querySelector('[data-dim-source]').value,value=source==='unknown'?null:Number(root.querySelector('[data-dim-value]').value),a=root.querySelector('[data-dim-start]').value,b=root.querySelector('[data-dim-end]').value;
   if(source!=='unknown'&&(!(value>0)||!a||!b||a===b)){message('请输入正数，并选择两个不同的对应点作为尺寸端点。');return;}
   data.dimensions.push({id:uid('dimension'),source,value,unit:root.querySelector('[data-dim-unit]').value,endpoints:a&&b&&a!==b?[{landmarkId:a},{landmarkId:b}]:null});emit();controls();
  }
  if(button.dataset.deleteDimension){data.dimensions=data.dimensions.filter(d=>d.id!==button.dataset.deleteDimension);emit();controls();}
 },{signal:abort.signal});
 controls();
 return {update(next){data=structuredClone({...data,...next});if(!data.photos.some(p=>p.photoId===photoId))photoId=data.photos[0]?.photoId;controls();},destroy(){dead=true;abort.abort();resizeObserver?.disconnect();root.replaceChildren();}};
}
