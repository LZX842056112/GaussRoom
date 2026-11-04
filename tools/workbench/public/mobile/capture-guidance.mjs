import {DirectionGuide,DIRECTION_TARGETS,projectDirection,containedVideoRect} from './direction-guide.mjs';

export class OrientationInput {
 constructor({host,isActive,onSample,onChange,onReset}){Object.assign(this,{host,isActive,onSample,onChange,onReset});this.generation=0;this.status='off';this.detail='';this.handler=null;this.timer=null;}
 get enabled(){return ['permission','waiting','active'].includes(this.status);}
 async enable(){
  this.stop();const generation=this.generation,host=this.host;
  if(!this.isActive())return;
  if(!host.isSecureContext||!host.DeviceOrientationEvent){this.status='unavailable';this.detail='此浏览器没有可用的方向传感器。请按文字提示继续拍摄。';this.onChange();return;}
  this.status='permission';this.detail='正在请求方向权限…';this.onChange();
  try{
   // This call must happen before the first await, inside the user's click.
   const permission=typeof host.DeviceOrientationEvent.requestPermission==='function'?await host.DeviceOrientationEvent.requestPermission():'granted';
   if(generation!==this.generation)return;
   if(!this.isActive()){this.stop();return;}
   if(permission!=='granted')throw new Error('permission denied');
   this.status='waiting';this.detail='保持手机对准墙面，等待方向数据。';
   this.handler=event=>{
    if(generation!==this.generation||!this.isActive())return;
    const angle=host.screen?.orientation?.angle??host.orientation??0;
    this.onSample({alpha:event.alpha,beta:event.beta,gamma:event.gamma,screenAngle:Number.isFinite(angle)?angle:0});
    this.status='active';
   };
   host.addEventListener('deviceorientation',this.handler);
   this.timer=host.setInterval(()=>{if(!this.isActive())this.stop();else this.onChange();},200);this.onChange();
  }catch{
   if(generation!==this.generation)return;
   this.status='unavailable';this.detail='方向权限未开启。照片仍可正常拍摄，请按文字提示补拍。';this.onChange();
  }
 }
 stop(){
  this.generation++;if(this.handler)this.host.removeEventListener('deviceorientation',this.handler);this.handler=null;
  if(this.timer!==null)this.host.clearInterval(this.timer);this.timer=null;this.status='off';this.detail='';this.onReset();this.onChange();
 }
}

const rowNames=['墙面环视','上方／天花边缘','下方／家具下沿'];
const manualHints={auto:'沿墙面慢慢环视，再抬高、压低镜头补拍。每次移动保留足够重叠。',wall:'沿墙面缓慢转动，补拍墙角、家具边缘及被遮挡处。',upper:'向上抬镜头，补拍天花边缘、门框上沿和高处。',lower:'向下压镜头，补拍墙脚、地面与家具下沿。',doorway:'走到门口后点“新站位”，分别朝两个房间拍摄，保留共同的门框与地面。'};
const qualityHints={blur:'画面模糊，请停稳后补拍。',dark:'画面过暗，请增加照明后补拍。',bright:'画面过亮，请避开强光后补拍。',repeat:'这个画面已近似拍过。请移动或转向；需要时使用手动补拍。',uncertain:'纹理不足。请把墙角、门框或家具一同拍入。',resolution:'分辨率不足，请改用系统相机。'};
const angleDelta=(a,b)=>((a-b+180)%360+360)%360-180;

export function createCaptureGuidance({host=window,document,$,getContext}){
 const model=new DirectionGuide(),video=$('captureVideo'),svg=$('directionOverlay');let station=0,notice=null;
 const dots=new Map();
 for(const target of DIRECTION_TARGETS){
  const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('r','11');dot.setAttribute('class','direction-dot');svg.append(dot);dots.set(target.id,dot);
 }
 const input=new OrientationInput({host,isActive:()=>{const context=getContext();return context.active&&!context.hidden;},onSample:sample=>model.update(sample),onChange:render,onReset:()=>model.suspend()});
 function render(){
  const context=getContext(),active=context.active&&!context.hidden;
  const duplicateIds=new Set((context.files??[]).filter(f=>f.status==='duplicate').map(f=>f.clientCaptureId));
  const ids=new Set([...(context.files??[]).filter(f=>f.status==='ready').map(f=>f.clientCaptureId),...(context.pending??[]).filter(f=>!duplicateIds.has(f.id)).map(f=>f.id)]);
  model.reconcile(ids);
  const view=model.view($('directionMode').value),visible=active&&input.enabled&&view.ready;
  $('cameraViewport').hidden=!context.active;
  $('directionEnable').disabled=!active||context.opening||context.frontCamera;
  $('directionEnable').textContent=input.enabled?'关闭方向引导':'启用方向引导';
  $('directionEnable').setAttribute('aria-pressed',String(input.enabled));
  $('directionNewStation').disabled=!active||!input.enabled||context.inFlight;
  $('directionMode').disabled=!active;
  $('directionSummary').textContent=`当前站位${station?` ${station}`:''}：已记录 ${view.recorded} / ${view.total} 个方向点。方向记录不代表墙面覆盖率。`;
  let status=context.frontCamera?'当前为前置相机。请使用后置相机；文字提示仍可查看。':!active?'打开相机后，可启用方向引导。':input.status==='off'?'启用方向权限后显示待拍方向点。文字提示始终可用。':input.detail;
  if(input.enabled&&input.status!=='permission')status=view.ready?'空心点：待拍方向；绿色点：已有保存照片。换位置后请点“新站位”。':({waiting:'尚无可用方向。请稳住手机对准墙面；也可按文字提示拍摄。',stale:'方向暂未刷新。请轻微转动手机，照片仍可正常拍摄。',fast:'转动过快。请放慢并稳住手机，再对准方向点。',vertical:'镜头过于接近竖直方向。请先对准墙面，再缓慢抬高或压低。'}[view.reason]);
  $('directionStatus').textContent=status;
  let cue=manualHints[$('directionMode').value]??manualHints.auto,arrow='◎';
  if(visible){
   if(view.target){
    const yaw=angleDelta(view.target.yaw+view.origin,view.pose.yaw),pitch=view.target.pitch-view.pose.pitch;
    if(Math.abs(pitch)>10){arrow=pitch>0?'↑':'↓';cue=pitch>0?'向上抬镜头，补拍上方方向点。':'向下压镜头，补拍下方方向点。';}
    else if(Math.abs(yaw)>6){arrow=yaw>0?'→':'←';cue=`缓慢向${yaw>0?'右':'左'}转动，对准空心点。`;}
    else cue='方向已对准。请稳住手机，保存一张清晰照片。';
   }else cue=$('directionMode').value==='auto'?'本站位方向点已记录。请换站位检查门口与遮挡处。':'本层方向点已记录。请选择其他拍摄部位，或换一个站位。';
  }else if(view.reason==='fast'&&input.enabled){arrow='!';cue='转动过快，请先停稳。';}
  if(notice&&Date.now()<notice.until){arrow='!';cue=notice.text;}
  if($('directionMode').value==='doorway')cue=`门口：分别面向两个房间，保留共同门框。${cue}`;
  $('directionArrow').textContent=arrow;$('directionCue').textContent=cue;
  $('directionHud').hidden=!context.active;
  $('directionBadge').textContent=$('directionMode').value==='doorway'?'门口连接':visible?(view.target?rowNames[view.target.row]:'请检查其他站位'):'拍摄提示';
  svg.toggleAttribute('hidden',!visible);
  if(visible){
   const rect=containedVideoRect(video.clientWidth,video.clientHeight,video.videoWidth,video.videoHeight);
   Object.assign(svg.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  }
  for(const target of DIRECTION_TARGETS){
   const dot=dots.get(target.id),point=visible?projectDirection(view.origin+target.yaw,target.pitch,view.pose,video.videoWidth,video.videoHeight):null;
   dot.style.display=point?'':'none';if(!point)continue;
   dot.setAttribute('cx',String(point.x*1000));dot.setAttribute('cy',String(point.y*1000));dot.setAttribute('class',`direction-dot${view.done.has(target.id)?' is-recorded':''}${view.target?.id===target.id?' is-next':''}`);
  }
 }
 $('directionEnable').onclick=()=>{if(input.enabled)input.stop();else{station++;notice=null;void input.enable();}};
 $('directionNewStation').onclick=()=>{if(getContext().inFlight)return;model.newStation();station++;notice=null;render();};
 $('directionMode').onchange=render;
 const resize=typeof host.ResizeObserver==='function'?new host.ResizeObserver(render):null;resize?.observe(video);
 video.addEventListener('resize',render);
 return {
  render,
  snapshot:()=>input.enabled?model.snapshot():null,
  saved:(snapshot,id)=>model.saved(snapshot,id),
  feedback:reason=>{notice=qualityHints[reason]?{text:qualityHints[reason],until:Date.now()+2500}:null;},
  stop:()=>{input.stop();notice=null;},
 };
}
