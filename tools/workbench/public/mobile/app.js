import {canCommit, needsReselect, unfinished, formatBytes, timingLabel, uploadLabel, shouldPoll, photoView} from './state.mjs';
import {captureDecision,frameMetrics,CaptureLoop,CaptureStore,uploadPending,canStoreCapture} from './capture.mjs';
import {createCaptureGuidance} from './capture-guidance.mjs';
const $ = id => document.getElementById(id), base='/api/mobile/v1';
const handoffParams=new URLSearchParams(location.hash.slice(1)),handoffTicket=handoffParams.get('handoff');
if(handoffParams.has('handoff'))history.replaceState(null,'',location.pathname+location.search);
let token=localStorage.getItem('gr.mobile.token')||'', batch=null, project=null, capabilities=null, busy=false, queue=[], local=new Map(), thumbs=new Map(), thumbQueue=[], thumbnailing=false, pollTimer=null, pollAbort=null, pollGeneration=0, uploadProgress=null, thumbGeneration=0;
let photoFilter='all',photosExpanded=false,photoPage=0;
const captureStore=new CaptureStore();
let deviceId=localStorage.getItem('gr.mobile.device')||'',pendingCaptures=[],storageReady=false,stream=null,openingCamera=false,cameraGeneration=0,wakeLock=null,captureHistory=[],acceptedCaptures=0,skippedCaptures=0,captureUploading=false,captureUploadTimer=null,captureUploadAbort=null,captureUploadGeneration=0;
let analysisTimer=null,analysisGeneration=0,analysisWanted=false,mapPanel=null,mapRevision=null,mapThumbUrl=null,mapThumbGeneration=0,connection=null;
let recoveryTargetId=localStorage.getItem('gr.mobile.recoveryTarget')||'';
const captureLoop=new CaptureLoop(captureFrame,{onError:e=>{pauseCapture(e.message);},onSettled:()=>render()});
const directionGuidance=createCaptureGuidance({host:window,document,$,getContext:()=>({active:!!stream,hidden:document.hidden,opening:openingCamera,inFlight:captureLoop.inFlight,frontCamera:stream?.getVideoTracks()[0]?.getSettings?.().facingMode==='user',files:batch?.files??[],pending:currentPending()})});
const labels={open:'待上传',committing:'正在创建',committed:'已创建',pending:'待处理',uploading:'上传中',ready:'已上传',duplicate:'重复照片',failed:'失败',idle:'待开始',running:'重建中',aborting:'正在停止',completed:'已完成',done:'已完成',needs_input:'待补充',passed:'通过',pass:'通过',unmeasured:'未实测',unknown:'待检查',not_run:'待检查',unverified:'待验证',verified:'已验证',unreviewed:'待检查',reviewed:'已检查',missing:'有缺失',needs_improvement:'待改进',calibrated:'已标定',skipped:'已跳过',cancelled:'已停止',canceled:'已停止'};
labels.deleting='删除未完成';
const statusLabel=value=>labels[value]||value||'待检查';
function resetPhotoView(){photoFilter='all';photosExpanded=false;photoPage=0;}
const say = text => $('message').textContent=text;
const saveQueue = () => { if(batch) localStorage.setItem(`gr.mobile.queue.${batch.id}`,JSON.stringify(queue.map(f=>({name:f.name,size:f.size})))); };
function clearAuthorization(){stopCapture('授权已失效。相机已停止。本地待上传照片仍保留。');stopCaptureUploads();stopAnalysisPolling();resetCaptureMap();token='';deviceId='';localStorage.removeItem('gr.mobile.token');localStorage.removeItem('gr.mobile.device');localStorage.removeItem('gr.mobile.batch');stopPoll();resetPhotoView();batch=null;project=null;capabilities=null;queue=[];local.clear();thumbs.clear();thumbQueue=[];thumbGeneration++;uploadProgress=null;$('camera').value='';$('gallery').value='';$('sessions').replaceChildren(new Option('选择批次',''));for(const id of ['batchInfo','projectInfo','progress','timing','quality','formatNote'])$(id).textContent='';$('steps').replaceChildren();$('viewer').removeAttribute('href');render();say('授权已失效，请重新配对。本地待上传照片仍保留。');}
function restoreQueue(id){try{const entries=JSON.parse(localStorage.getItem(`gr.mobile.queue.${id}`)||'[]');return Array.isArray(entries)?entries.filter(x=>typeof x.name==='string'&&Number.isSafeInteger(x.size)&&x.size>0).map(x=>({...x,needsFile:true})):[];}catch{return [];}}
async function api(path, options={}) {
 const headers=new Headers(options.headers||{}); if(token) headers.set('Authorization',`Bearer ${token}`);
 if(options.json!==undefined){headers.set('Content-Type','application/json');options.body=JSON.stringify(options.json);delete options.json;}
 const response=await fetch(base+path,{...options,headers,credentials:'same-origin'});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){if(response.status===401){clearAuthorization();} const e=new Error(response.status===401?'授权已失效，请重新配对。':data.error||`请求失败 (${response.status})`);e.status=response.status;throw e;}
 return data;
}
function stopPoll(){pollGeneration++;clearTimeout(pollTimer);pollTimer=null;pollAbort?.abort();pollAbort=null;}
async function action(fn){if(busy||captureUploading)return;busy=true;render();try{await fn();}catch(e){say(e.message);}finally{busy=false;render();pumpCaptures();}}
function element(tag,text){const el=document.createElement(tag);el.textContent=text;return el;}
function updateUploadProgress(){
 const active=uploadProgress&&batch;$('transferStatus').hidden=!active;
 $('uploadProgress').textContent=active?uploadLabel(uploadProgress,batch.files,queue.length):'';
 $('uploadMeter').value=active&&uploadProgress.total>0?Math.min(1,uploadProgress.loaded/uploadProgress.total):0;
}
function render(){
 $('pairSection').hidden=!!token;$('createSection').hidden=!token;$('batchSection').hidden=!batch;$('projectSection').hidden=!project;
 $('connectionState').textContent=token?'已配对':'未连接';$('connectionState').classList.toggle('is-connected',!!token);
 const step=project?2:token?1:0;['connectStep','photosStep','rebuildStep'].forEach((id,i)=>{$(id).classList.toggle('is-active',i===step);$(id).classList.toggle('is-done',i<step);if(i===step)$(id).setAttribute('aria-current','step');else $(id).removeAttribute('aria-current');});
 $('setupSummary').textContent=batch?.name||'新建或选择照片项目';
 for(const el of document.querySelectorAll('button, input, select')) el.disabled=busy||captureUploading;
 $('cancelDelete').disabled=false;$('confirmDelete').disabled=false;
 $('batchActions').hidden=!batch;const deletingRunning=['running','aborting'].includes(project?.state);
 $('deleteBatch').disabled=busy||deletingRunning;$('deleteBatch').textContent=batch?.status==='deleting'?'重试删除':batch?.projectId?'删除项目':'删除批次';
 $('batchActions').querySelector('span').textContent=deletingRunning?'重建进行中，暂不可删除':busy?'正在处理，暂不可删除':'管理当前照片与重建结果';
 $('commit').disabled=busy||!canCommit(batch,queue.length);$('commit').textContent=batch?.status==='committing'?'重试创建项目':'提交照片并创建项目';$('sessions').disabled=busy||queue.length>0;$('createForm').querySelector('button').disabled=busy||queue.length>0;$('retryQueue').hidden=!queue.length;$('retryQueue').disabled=busy||batch?.status!=='open';$('run').disabled=busy||!project||['running','aborting'].includes(project.state);
 $('camera').disabled=$('gallery').disabled=busy||batch?.status!=='open';
 for(const id of ['camera','gallery'])$(id).closest('label').classList.toggle('is-disabled',$(id).disabled);
 renderCapture();
 updateUploadProgress();
 $('batchInfo').textContent=batch?batch.name:'';$('batchState').textContent=statusLabel(batch?.status);
 const unregisteredCaptures=currentPending().filter(row=>!batch?.files.some(f=>f.clientCaptureId===row.id)).length;
 $('photoCount').textContent=(batch?.files.length||0)+queue.length+unregisteredCaptures;$('validCount').textContent=batch?.uniqueCount||0;
 $('attentionCount').textContent=(batch?.files.filter(unfinished).length||0)+queue.length+unregisteredCaptures;$('photoSize').textContent=formatBytes(batch?.totalBytes||0);
 const view=photoView(batch?.files||[],{filter:photoFilter,expanded:photosExpanded,page:photoPage,activeId:uploadProgress?.id});photoPage=view.page;
 $('togglePhotos').hidden=view.count<=6&&!photosExpanded;$('togglePhotos').disabled=false;$('togglePhotos').textContent=photosExpanded?'收起照片':`查看全部 ${view.count} 张`;$('togglePhotos').setAttribute('aria-expanded',String(photosExpanded));
 $('photoFilters').hidden=!batch?.files.length;for(const button of $('photoFilters').querySelectorAll('button')){button.disabled=false;button.setAttribute('aria-pressed',String(button.dataset.filter===photoFilter));}
 $('photoPager').hidden=!photosExpanded||view.pages<=1;$('photoPage').textContent=`${view.page+1} / ${view.pages}`;$('prevPhotos').disabled=view.page===0;$('nextPhotos').disabled=view.page>=view.pages-1;
 $('emptyPhotos').hidden=!!view.count;$('emptyPhotos').querySelector('p').textContent=batch?.files.length?'暂无此类照片':'还没有照片';
 $('emptyPhotos').querySelector('small').textContent=batch?.files.length?'可以切换筛选，查看其他照片。':'从相册添加，或拍下第一个视角。';
 $('queuedDetails').hidden=!queue.length;$('queueSummary').textContent=`待上传队列 · ${queue.length} 张`;
 const durableIds=new Set(currentPending().map(row=>row.id));
 const missing=batch?needsReselect(batch.files.filter(f=>!durableIds.has(f.clientCaptureId)),local).length:0;
 $('reselect').textContent=missing?`有 ${missing} 张照片需要重新选择或移除。请在对应照片下选择原文件并重试。`:queue.length?`待上传 ${queue.length} 张照片。`:'';
 const queued=$('queued');queued.replaceChildren();queue.forEach((file,index)=>{const li=element('li',`${file.name} · ${file.needsFile?'请重新选择原照片':'待上传'} `);if(file.needsFile){const label=element('label','选择原照片');label.className='button';const input=document.createElement('input');input.type='file';input.accept=capabilities?.photoFormats.join(',')||'.jpg,.jpeg,.png';input.disabled=busy;input.setAttribute('aria-label',`为 ${file.name} 选择原照片`);input.onchange=()=>{const selected=input.files[0];if(!selected)return;if(selected.size!==file.size){say('所选文件大小与原记录不同。请选择原照片，或移除该记录。');return;}queue[index]=selected;saveQueue();render();};label.append(input);li.append(label);}const remove=element('button','移除');remove.disabled=busy;remove.onclick=()=>{queue.splice(index,1);saveQueue();render();};li.append(remove);queued.append(li);});
 const list=$('files');list.replaceChildren();
 if(batch) for(const f of view.items){
  const li=element('li',''), row=element('div','');row.className='file';li.dataset.fileId=f.id;li.classList.toggle('needs-attention',unfinished(f));
  const preview=element('div','');preview.className='photo-preview';
  if(thumbs.has(f.id)){const img=document.createElement('img');img.alt='';img.src=thumbs.get(f.id);preview.append(img);}else{const type=element('span',f.name.split('.').pop().slice(0,5).toUpperCase());type.className='file-type';preview.append(type);}
  const badge=element('span',statusLabel(uploadProgress?.id===f.id?'uploading':f.status));badge.className='file-state';preview.append(badge);row.append(preview);
  const info=element('div','');info.className='file-info';const name=element('strong',f.name),size=element('p',formatBytes(f.bytes));name.className='file-name';name.title=f.name;size.className='file-size';info.append(name,size);
  if(f.error){const error=element('p',f.error);error.className='file-error';info.append(error);}
  if(batch.status==='open') {const actions=element('div','');actions.className='file-actions';
   if(unfinished(f)&&durableIds.has(f.clientCaptureId))actions.append(element('small','本地照片已保留，将自动重试。'));
   if(unfinished(f)&&!durableIds.has(f.clientCaptureId)){const label=element('label','选择原照片并重试');label.className='button';const input=document.createElement('input');input.type='file';input.accept=capabilities?.photoFormats.join(',')||'.jpg,.jpeg,.png';input.disabled=busy;input.setAttribute('aria-label',`为 ${f.name} 选择原照片并重试`);input.onchange=()=>{const file=input.files[0];if(!file)return;if(file.size!==f.bytes){say('所选文件大小与原记录不同。请选择原照片，或移除该记录后重新上传。');return;}local.set(f.id,file);makeThumb(f.id,file);action(()=>upload(f.id,file));};label.append(input);actions.append(label);
    if(local.has(f.id)){const retry=element('button','重试');retry.className='retry-button';retry.disabled=busy;retry.setAttribute('aria-label',`重试 ${f.name}`);retry.onclick=()=>action(()=>upload(f.id,local.get(f.id)));actions.append(retry);}}
   const remove=element('button','移除');remove.disabled=busy||captureUploading||durableIds.has(f.clientCaptureId);remove.setAttribute('aria-label',`移除 ${f.name}`);remove.onclick=()=>action(async()=>{batch=await api(`/photo-sessions/${batch.id}/files/${f.id}`,{method:'DELETE'});local.delete(f.id);thumbs.delete(f.id);resetCaptureMap();startAnalysisPolling();say('照片已移除。');});actions.append(remove);info.append(actions);}
  row.append(info);li.append(row);list.append(li);
 }
 if(project){
  $('projectInfo').textContent=`${project.name} · ${statusLabel(project.state)}`;$('projectMeter').value=Math.max(0,Math.min(1,project.progress||0));
  $('progress').textContent=`进度 ${Math.round((project.progress||0)*100)}%`;$('timing').textContent=`累计 ${timingLabel(project.timing)}`;
  const q=project.quality;$('quality').textContent=project.lastError||(q?`质量：${q.complete?'完整检查已通过':'待完成检查'} · 几何${statusLabel(q.geometry)} · 覆盖${statusLabel(q.coverage)} · 外观${statusLabel(q.appearance)} · 尺度${statusLabel(q.scale)} · 训练目标${q.trainingComplete?'已达到':'未达到'}`:'质量：暂无记录');
  $('steps').replaceChildren(...(project.steps||[]).map(s=>{const li=element('li','');li.dataset.status=s.status;li.append(element('strong',`${s.name} · ${statusLabel(s.status)}`),element('small',`${Math.round((s.progress||0)*100)}% · ${timingLabel(s.timing)}`));return li;}));
  const a=$('viewer');a.hidden=true;if(project.scene?.viewerUrl){try{const u=new URL(project.scene.viewerUrl,location.origin);if(u.origin===location.origin){a.href=u.href;a.hidden=false;}}catch{}}
 }
}
async function makeThumb(id,file){thumbQueue.push([id,file]);if(thumbnailing)return;thumbnailing=true;while(thumbQueue.length){const [key,source]=thumbQueue.shift();const generation=thumbGeneration;const url=URL.createObjectURL(source);try{const img=new Image();img.src=url;await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;});const scale=Math.min(1,160/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);if(generation===thumbGeneration){thumbs.set(key,canvas.toDataURL('image/jpeg',.65));render();}}catch{}finally{URL.revokeObjectURL(url);}}thumbnailing=false;}
async function refreshBatch(){if(!batch)return;batch=await api(`/photo-sessions/${batch.id}`);render();}
async function upload(id,file){
 const batchId=batch.id;uploadProgress={id,loaded:0,total:file.size};render();
 try{const result=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('PUT',`${base}/photo-sessions/${encodeURIComponent(batchId)}/files/${encodeURIComponent(id)}`);xhr.setRequestHeader('Authorization',`Bearer ${token}`);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.upload.onprogress=e=>{if(uploadProgress?.id===id){uploadProgress.loaded=e.loaded;uploadProgress.total=e.lengthComputable?e.total:file.size;updateUploadProgress();}};xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(data);else{if(xhr.status===401)clearAuthorization();const error=new Error(xhr.status===401?'授权已失效，请重新配对。':data.error||`请求失败 (${xhr.status})`);error.status=xhr.status;reject(error);}};xhr.onerror=()=>reject(new Error('网络连接中断，请重试。'));xhr.onabort=()=>reject(new Error('上传已中断，请重试。'));xhr.send(file);});if(batch?.id===batchId){batch=result;local.delete(id);say('照片上传完成。');}}
 catch(e){if(batch?.id===batchId)try{await refreshBatch();}catch{}throw e;}
 finally{uploadProgress=null;render();}
}
async function processQueue(){while(queue.length){const file=queue[0];if(file.needsFile){say('请先重新选择待上传的原照片，或移除该记录。');return;}let created;try{created=await api(`/photo-sessions/${batch.id}/files`,{method:'POST',json:{name:file.name,bytes:file.size}});}catch(e){say(e.status===401?e.message:`${file.name}：${e.message}。待上传照片仍在本页，请重试。`);return;}batch=created.session;queue.shift();saveQueue();local.set(created.fileId,file);makeThumb(created.fileId,file);render();try{await upload(created.fileId,file);}catch(e){say(e.status===401?e.message:`${file.name}：${e.message}。请重试或移除。`);return;}}}
async function confirmDeletion(target){
 const dialog=$('deleteDialog');$('deleteTitle').textContent=target.projectId?'删除这个项目？':'删除这个批次？';$('deleteName').textContent=target.name;dialog.returnValue='';
 const result=new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='delete'),{once:true}));dialog.showModal();return result;
}
async function deleteBatch(){
 const target=batch;if(!target)return;
 if(!await confirmDeletion(target))return;
 await prepareBatchChange();
 try{await api(`/photo-sessions/${encodeURIComponent(target.id)}`,{method:'DELETE'});}
 catch(e){if(e.status!==404){if(batch?.id===target.id){try{await refreshBatch();}catch{}if(batch?.status==='deleting'){stopPoll();project=null;render();}}throw e;}}
 stopPoll();if(batch?.id!==target.id)return;
 localStorage.removeItem(`gr.mobile.queue.${target.id}`);localStorage.removeItem('gr.mobile.batch');
 batch=null;project=null;queue=[];local.clear();thumbs.clear();thumbQueue=[];thumbGeneration++;uploadProgress=null;resetPhotoView();
 $('camera').value='';$('gallery').value='';$('projectSetup').open=true;$('sessions').replaceChildren(new Option('选择批次',''));render();say('项目与上传批次已删除。');
 try{await getSessions();}catch(e){if(e.status===401)throw e;say('已删除。列表暂时无法刷新，请刷新页面。');}
}
async function getSessions(){const sessions=await api('/photo-sessions');const select=$('sessions');select.replaceChildren(new Option('选择批次',''));for(const s of sessions)select.add(new Option(`${s.name} · ${statusLabel(s.status)}`,s.id));if(batch)select.value=batch.id;}
async function loadBatch(id){if(batch&&batch.id!==id)await prepareBatchChange();stopCapture();stopAnalysisPolling();resetCaptureMap();stopPoll();batch=await api(`/photo-sessions/${encodeURIComponent(id)}`);localStorage.setItem('gr.mobile.batch',id);local.clear();thumbs.clear();queue=restoreQueue(id);resetPhotoView();$('projectSetup').open=false;$('queuedDetails').open=queue.some(f=>f.needsFile);$('sessions').value=id;project=null;if(batch.projectId)await loadProject();startAnalysisPolling();render();}
function currentPending(){return pendingCaptures.filter(row=>row.batchId===batch?.id&&row.owner===deviceId);}
function renderCapture(){
 const running=captureLoop.state==='running',cameraOpen=!!stream,blocked=busy||captureUploading;
 const pending=currentPending(),foreign=pendingCaptures.filter(row=>row.batchId!==batch?.id||row.owner!==deviceId);
 $('captureRecovery').hidden=!foreign.length;
 $('recoveryInfo').textContent=`本机保留 ${foreign.length} 张其他批次或旧授权的照片，共 ${formatBytes(foreign.reduce((n,r)=>n+r.bytes,0))}。请创建新批次，再转移照片。`;
 $('recoverCaptures').disabled=blocked||!token||batch?.status!=='open'||recoveryTargetId!==`${deviceId}:${batch?.id}`||!foreign.length||cameraOpen;
 $('captureState').textContent=openingCamera?'正在打开':running?'采集中':captureLoop.state==='paused'?'已暂停':'未启动';
 $('captureStart').textContent=captureLoop.state==='paused'?'继续采集':'启动自动采集';
 $('captureStart').disabled=busy||openingCamera||running||!token||batch?.status!=='open'||!storageReady||!isSecureContext||!navigator.mediaDevices?.getUserMedia||!canStoreCapture(pendingCaptures,1);
 $('capturePause').disabled=!running&&!openingCamera;
 $('captureStop').disabled=!cameraOpen&&!openingCamera;
 $('captureManual').disabled=!cameraOpen||openingCamera||captureLoop.inFlight||!token||batch?.status!=='open'||document.hidden||!storageReady||!canStoreCapture(pendingCaptures,1);
 $('captureInterval').disabled=openingCamera||running;
 $('captureCounts').textContent=`本次已保存 ${acceptedCaptures} 张 · 已跳过 ${skippedCaptures} 次 · 本地待上传 ${pending.length} 张 / ${formatBytes(pending.reduce((n,r)=>n+r.bytes,0))} · 服务器有效 ${batch?.uniqueCount||0} 张`;
 $('retryCaptures').hidden=!pending.length;$('retryCaptures').disabled=blocked||!token;
 if(cameraOpen||openingCamera||captureUploading){$('camera').disabled=$('gallery').disabled=true;for(const id of ['camera','gallery'])$(id).closest('label').classList.add('is-disabled');}
 $('sessions').disabled=blocked||queue.length>0||pendingCaptures.length>0||cameraOpen||openingCamera;
 $('createForm').querySelector('button').disabled=blocked||queue.length>0||cameraOpen||openingCamera;
 $('deleteBatch').disabled=blocked||pendingCaptures.length>0||cameraOpen||openingCamera||['running','aborting'].includes(project?.state);
 $('commit').disabled=blocked||pendingCaptures.length>0||cameraOpen||openingCamera||!canCommit(batch,queue.length);
 $('analyzeCapture').disabled=blocked||!batch||batch.status!=='open';$('cancelAnalysis').disabled=!batch||!token;
 $('fitCaptureMap').disabled=!mapPanel;
 $('secureSection').hidden=isSecureContext;
 $('secureHandoff').disabled=blocked||!token||!connection?.httpsEnabled||pendingCaptures.length>0||queue.length>0;
 directionGuidance.render();
}
async function refreshPending(){pendingCaptures=await captureStore.list();storageReady=true;render();}
async function releaseWakeLock(){const lock=wakeLock;wakeLock=null;try{await lock?.release();}catch{}}
async function requestWakeLock(){if(!navigator.wakeLock||document.hidden)return;try{const lock=await navigator.wakeLock.request('screen');if(captureLoop.state==='running'&&!document.hidden)wakeLock=lock;else await lock.release();}catch{/* Optional: capture remains usable without a screen lock. */}}
function pauseCapture(reason='已暂停。点“继续采集”后恢复。'){if(openingCamera)stopCapture(reason);captureLoop.pause();releaseWakeLock();$('captureReason').textContent=reason;render();}
function stopCapture(reason='相机已停止。'){
 cameraGeneration++;openingCamera=false;captureLoop.stop();const old=stream;stream=null;if(old)for(const track of old.getTracks())track.stop();$('captureVideo').srcObject=null;$('captureVideo').hidden=true;releaseWakeLock();$('captureReason').textContent=reason;
 directionGuidance.stop();
}
async function startCapture(){
 if(openingCamera||captureLoop.state==='running'||!token||batch?.status!=='open')return;
 if(!isSecureContext||!navigator.mediaDevices?.getUserMedia){$('captureReason').textContent='浏览器不能打开网页相机。请安装并信任 HTTPS 证书，或使用系统相机。';return;}
 if(document.hidden){pauseCapture('页面处于后台。请回到前台，再点“继续采集”。');return;}
 const generation=++cameraGeneration,targetBatch=batch.id;openingCamera=true;render();
 try{
  await refreshPending();if(!canStoreCapture(pendingCaptures,1))throw new Error('本地队列已满。请先上传照片。');
  if(!stream){
   const opened=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
   if(generation!==cameraGeneration||document.hidden||batch?.id!==targetBatch||!token){opened.getTracks().forEach(t=>t.stop());return;}
   stream=opened;const video=$('captureVideo');video.srcObject=stream;video.hidden=false;
   for(const track of stream.getVideoTracks())track.addEventListener('ended',()=>{if(stream===opened){stopCapture();pauseCapture('相机已断开。请点“继续采集”重新打开。');}});
   await video.play();
  }
  if(generation!==cameraGeneration||document.hidden||batch?.id!==targetBatch)return;
  const video=$('captureVideo'),width=video.videoWidth,height=video.videoHeight;
  $('captureResolution').textContent=`实际视频帧：${width} × ${height} 像素。保存完整画面。`;
  if(Math.max(width,height)<1000)throw new Error('实际相机分辨率不足。照片长边必须至少为 1000 像素。请使用系统相机。');
  captureLoop.interval=Number($('captureInterval').value)||1500;captureLoop.start();requestWakeLock();analysisWanted=true;startAnalysisPolling();$('captureReason').textContent='正在采集。请缓慢移动，并保留相邻照片的重叠区域。';
 }catch(e){stopCapture();pauseCapture(['NotAllowedError','SecurityError'].includes(e.name)?'相机权限未开启，或 HTTPS 证书未受信任。请检查浏览器权限。也可以使用系统相机。':e.message);}
 finally{if(generation===cameraGeneration)openingCamera=false;render();}
}
async function captureFrame(manual,stillCurrent){
 if(!stream||document.hidden||!token||batch?.status!=='open')return;
 const target=batch.id,owner=deviceId,video=$('captureVideo'),width=video.videoWidth,height=video.videoHeight;
 if(!width||!height)return;
 const sample=document.createElement('canvas');sample.width=160;sample.height=Math.max(32,Math.round(160*height/width));
 // A portrait sensor may be tall; keep the analysis buffer bounded too.
 if(sample.height>160){sample.height=160;sample.width=Math.max(32,Math.round(160*width/height));}
 const context=sample.getContext('2d',{willReadFrequently:true});context.drawImage(video,0,0,sample.width,sample.height);
 const metrics=frameMetrics(context.getImageData(0,0,sample.width,sample.height).data,sample.width,sample.height,Math.max(width,height));
 const decision=captureDecision(metrics,captureHistory,manual);
 directionGuidance.feedback(decision.reason);
 const reasons={resolution:'已跳过：分辨率不足。',dark:'已跳过：画面过暗。请增加照明。',bright:'已跳过：画面过亮。请避开强光。',blur:'已跳过：画面模糊。请减慢移动速度。',repeat:'已跳过：画面与最近照片近乎相同。请移动或改变朝向。',uncertain:'已保存。画面纹理不足，不能可靠判断重复。',accepted:manual?'手动补拍已保存。':'照片已保存。'};
 if(!decision.accept){skippedCaptures++;$('captureReason').textContent=reasons[decision.reason];if(decision.reason==='resolution')pauseCapture(reasons.resolution);render();return;}
 const directionShot=directionGuidance.snapshot();
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(video,0,0,width,height);
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('照片编码失败。请重试。')),'image/jpeg',.94));
 if(!stillCurrent()||document.hidden||batch?.id!==target||deviceId!==owner||!token)return;
 if(blob.size>(capabilities?.limits.maxFileBytes||Infinity))throw new Error('此视频帧超过单张照片大小上限。请使用系统相机。');
 const id=crypto.randomUUID(),createdAt=Date.now();
 await captureStore.put({id,batchId:target,owner,name:`capture-${createdAt}-${id.slice(0,8)}.jpg`,bytes:blob.size,blob,createdAt,width,height});
 captureHistory.push(metrics);if(captureHistory.length>16)captureHistory.shift();acceptedCaptures++;$('captureReason').textContent=reasons[decision.reason];
 await refreshPending();directionGuidance.saved(directionShot,id);if(!canStoreCapture(pendingCaptures,1))pauseCapture('本地队列已满。照片已保存。请等待上传，再点“继续采集”。');
 pumpCaptures();render();
}
function stopCaptureUploads(){captureUploadGeneration++;clearTimeout(captureUploadTimer);captureUploadTimer=null;captureUploadAbort?.abort();captureUploadAbort=null;}
async function pumpCaptures(){
 if(captureUploading||busy||!storageReady||!token||!deviceId||!batch||!currentPending().length)return;
 clearTimeout(captureUploadTimer);captureUploadTimer=null;const target=batch.id,owner=deviceId,generation=captureUploadGeneration,controller=new AbortController();captureUploadAbort=controller;captureUploading=true;render();
 const active=()=>generation===captureUploadGeneration&&!!token&&deviceId===owner&&batch?.id===target;
 let failed=false;
 try{await uploadPending({store:captureStore,batchId:target,owner,active,api:(path,options={})=>api(path,{...options,signal:controller.signal}),onSession:session=>{if(active()){batch=session;render();}},onPending:refreshPending});}
 catch(e){failed=true;if(e.name!=='AbortError'&&e.status!==401){$('captureReason').textContent=`上传暂未完成：${e.message} 本地照片仍保留。`;say('本地照片仍保留。网络恢复后会重试。');}}
 finally{if(captureUploadAbort===controller)captureUploadAbort=null;captureUploading=false;try{await refreshPending();}catch(e){storageReady=false;pauseCapture(`本地存储读取失败：${e.message}`);}render();if(active()&&currentPending().length)captureUploadTimer=setTimeout(pumpCaptures,failed?4000:100);}
}
async function prepareBatchChange(){
 stopCapture();render();await captureLoop.current?.catch(()=>{});await refreshPending();
 if(pendingCaptures.length)throw new Error('本地仍有待上传照片。请先完成上传，或创建新批次并明确转移照片。');
 if(queue.length)throw new Error('仍有待上传文件。请先完成上传或移除队列记录。');
 stopCaptureUploads();await cancelCaptureAnalysis();
}
function stopAnalysisPolling(){analysisGeneration++;analysisWanted=false;clearTimeout(analysisTimer);analysisTimer=null;}
function resetCaptureMap(){mapRevision=null;mapPanel?.clear();mapThumbGeneration++;if(mapThumbUrl)URL.revokeObjectURL(mapThumbUrl);mapThumbUrl=null;$('mapThumbnail').hidden=true;$('mapThumbnail').removeAttribute('src');$('mapSelection').textContent='';$('captureMapCounts').textContent='';$('unlocalizedPhotos').replaceChildren();$('suspectedDuplicates').replaceChildren();}
async function cancelCaptureAnalysis(){
 const target=batch?.id;stopAnalysisPolling();if(!target||!token)return;
 const status=await api(`/photo-sessions/${encodeURIComponent(target)}/capture-analysis`,{method:'POST',json:{action:'cancel'}});
 if(batch?.id===target)$('analysisStatus').textContent=`分析已停止。已处理 ${status.processedCount||0} 张。`;
}
function startAnalysisPolling(){clearTimeout(analysisTimer);const generation=++analysisGeneration;if(!batch||!token)return;analysisTimer=setTimeout(()=>pollCaptureAnalysis(generation),1000);}
async function pollCaptureAnalysis(generation){
 const target=batch?.id;if(!target||!token||generation!==analysisGeneration)return;
 try{
  if(analysisWanted&&batch.status==='open')await api(`/photo-sessions/${encodeURIComponent(target)}/capture-analysis`,{method:'POST',json:{action:'start'}});
  const status=await api(`/photo-sessions/${encodeURIComponent(target)}/capture-analysis`);
  if(generation!==analysisGeneration||batch?.id!==target)return;
  const text={idle:'待分析',waiting:'等待更多照片或分析资源',running:'电脑正在估计相机位置',ready:'位置估计已更新',failed:'位置估计失败',cancelled:'分析已停止'};
  $('analysisStatus').textContent=`${text[status.status]||status.status} · 已处理 ${status.processedCount||0} / ${status.requestedCount||0} 张${status.error?` · ${status.error}`:''}`;
  if(!status.lastMapRevision&&mapRevision!==null)resetCaptureMap();
  if(status.lastMapRevision&&status.lastMapRevision!==mapRevision){const data=await api(`/photo-sessions/${encodeURIComponent(target)}/capture-map`);if(generation===analysisGeneration&&batch?.id===target)await replaceCaptureMap(data,generation);}
 }catch(e){if(e.status===401||generation!==analysisGeneration)return;$('analysisStatus').textContent=`分析暂不可用：${e.message}。照片上传仍可继续。`;}
 finally{if(token&&batch?.id===target&&generation===analysisGeneration)analysisTimer=setTimeout(()=>pollCaptureAnalysis(generation),4000);}
}
async function replaceCaptureMap(data,generation){
 if(!mapPanel){const module=await import('./capture-map.mjs');if(generation!==analysisGeneration)return;mapPanel=module.createCaptureMap($('captureMap'),selectMapCamera);}
 if(generation!==analysisGeneration)return;
 mapPanel.replace(data);mapRevision=data.revision;
 const name=id=>batch?.files.find(f=>f.id===id)?.name||id;
 const updatedAt=new Date(data.updatedAt),updated=Number.isFinite(updatedAt.getTime())?updatedAt.toLocaleString():'暂无记录';
 $('captureMapCounts').textContent=`已定位 ${data.cameras?.length||0} 张 · 未定位 ${data.unlocalized?.length||0} 张 · 稀疏点 ${Math.min(10000,data.points?.length||0)} 个 · 尺度未实测 · 更新于 ${updated}。位置估计会延迟更新。`;
 $('unlocalizedPhotos').replaceChildren(...(data.unlocalized||[]).map(id=>element('li',name(id))));
 $('suspectedDuplicates').replaceChildren(...(data.suspectedDuplicates||[]).map(item=>element('li',`${name(item.fileId)} → ${name(item.similarTo)}`)));
 render();
}
async function selectMapCamera(id){
 const target=batch?.id,generation=++mapThumbGeneration;if(!target||!token)return;
 if(mapThumbUrl)URL.revokeObjectURL(mapThumbUrl);mapThumbUrl=null;$('mapThumbnail').hidden=true;$('mapThumbnail').removeAttribute('src');$('mapSelection').textContent='正在读取缩略图…';
 try{
  const response=await fetch(`${base}/photo-sessions/${encodeURIComponent(target)}/files/${encodeURIComponent(id)}/thumbnail`,{headers:{Authorization:`Bearer ${token}`},credentials:'same-origin'});
  if(response.status===401){clearAuthorization();return;}if(!response.ok)throw new Error('缩略图暂不可用');
  const length=Number(response.headers.get('Content-Length'));if(length>512*1024)throw new Error('缩略图超过大小上限');
  const blob=await response.blob();if(blob.size>512*1024)throw new Error('缩略图超过大小上限');
  if(generation!==mapThumbGeneration||batch?.id!==target||!token)return;
  mapThumbUrl=URL.createObjectURL(blob);$('mapThumbnail').src=mapThumbUrl;$('mapThumbnail').hidden=false;$('mapSelection').textContent=batch.files.find(f=>f.id===id)?.name||id;
 }catch(e){if(generation===mapThumbGeneration)$('mapSelection').textContent=e.message;}
}
async function loadConnection(){
 try{const response=await fetch('/mobile/connection.json',{cache:'no-store'});if(!response.ok)throw new Error('连接信息暂不可用');connection=await response.json();
  $('secureStatus').textContent=connection.httpsEnabled?`HTTPS 已启用。证书指纹：${connection.certificate?.fingerprint||'暂无'}；有效期至 ${connection.certificate?.expiresAt||'暂无'}。`:'请在电脑工作台启用 HTTPS。';
  $('certificateLinks').replaceChildren();for(const [key,label] of [['profileUrl','iPhone 描述文件'],['certUrl','Android CA 证书']]){const path=connection.certificate?.[key];if(path){const url=new URL(path,location.origin);if(url.origin===location.origin){const link=element('a',label);link.href=url.href;$('certificateLinks').append(link);}}}
 }catch(e){$('secureStatus').textContent=e.message;}render();
}
async function loadProject(){
 const projectId=batch?.projectId, generation=pollGeneration;if(!projectId)return;
 clearTimeout(pollTimer);pollTimer=null;const controller=new AbortController();pollAbort=controller;let retry=false,stopped=false;
 try{const result=await api(`/projects/${encodeURIComponent(projectId)}`,{signal:controller.signal});if(generation!==pollGeneration||batch?.projectId!==projectId)return;project=result;render();}
 catch(e){if(e.name==='AbortError'||generation!==pollGeneration){stopped=true;return;}stopped=e.status===401||e.status===404;retry=!stopped;say(e.message);}
 finally{if(pollAbort===controller)pollAbort=null;if(!stopped&&generation===pollGeneration&&batch?.projectId===projectId&&(retry||shouldPoll(project,generation,pollGeneration)))pollTimer=setTimeout(loadProject,2000);}
}
async function init(){if(!token){render();return;}await api('/session',{method:'POST'});capabilities=await api('/capabilities');if(capabilities.deviceId){deviceId=capabilities.deviceId;localStorage.setItem('gr.mobile.device',deviceId);}$('camera').accept=['image/jpeg','image/png',...capabilities.photoFormats].join(',');$('gallery').accept=capabilities.photoFormats.join(',');$('formatNote').textContent=capabilities.photoFormats.some(x=>/heic|heif/i.test(x))?'如果无法选择 HEIC，请在手机中先转为 JPEG 或 PNG。':'此工作台不支持 HEIC/HEIF。请先在手机中转为 JPEG 或 PNG。';for(const option of $('preset').options)option.disabled=!capabilities.trainingPresets.includes(option.value);$('limits').textContent=`支持：${capabilities.photoFormats.join('、')}；单张不超过 ${formatBytes(capabilities.limits.maxFileBytes)}，最多 ${capabilities.limits.maxFiles} 张；照片长边至少 ${capabilities.limits.minLongEdge} 像素。`;await getSessions();const id=localStorage.getItem('gr.mobile.batch');if(id)try{await loadBatch(id);}catch(e){if(e.status!==404)throw e;localStorage.removeItem('gr.mobile.batch');}render();}
$('pairForm').onsubmit=e=>{e.preventDefault();action(async()=>{const result=await api('/pair',{method:'POST',json:{code:$('code').value,deviceName:$('device').value}});token=result.token;deviceId=result.deviceId||'';localStorage.setItem('gr.mobile.token',token);localStorage.setItem('gr.mobile.device',deviceId);localStorage.removeItem('gr.mobile.batch');batch=null;project=null;await init();say('配对成功。');});};
$('createForm').onsubmit=e=>{e.preventDefault();action(async()=>{stopCapture();await captureLoop.current?.catch(()=>{});stopCaptureUploads();await cancelCaptureAnalysis();resetCaptureMap();batch=await api('/photo-sessions',{method:'POST',json:{name:$('name').value,trainingPreset:$('preset').value}});localStorage.setItem('gr.mobile.batch',batch.id);recoveryTargetId=`${deviceId}:${batch.id}`;localStorage.setItem('gr.mobile.recoveryTarget',recoveryTargetId);project=null;queue=[];local.clear();thumbs.clear();captureHistory=[];acceptedCaptures=skippedCaptures=0;resetPhotoView();$('projectSetup').open=false;startAnalysisPolling();await getSessions();say('批次已创建。');});};
$('sessions').onchange=e=>{if(e.target.value)action(()=>loadBatch(e.target.value));};
for(const id of ['camera','gallery'])$(id).onchange=e=>{const files=Array.from(e.target.files);e.target.value='';queue.push(...files);saveQueue();action(processQueue);};
$('retryQueue').onclick=()=>action(processQueue);
$('deleteBatch').onclick=()=>action(deleteBatch);
$('cancelDelete').onclick=()=>$('deleteDialog').close('cancel');
$('confirmDelete').onclick=()=>$('deleteDialog').close('delete');
$('togglePhotos').onclick=()=>{photosExpanded=!photosExpanded;photoPage=0;render();};
$('prevPhotos').onclick=()=>{photoPage--;render();$('files').scrollTop=0;};
$('nextPhotos').onclick=()=>{photoPage++;render();$('files').scrollTop=0;};
for(const button of $('photoFilters').querySelectorAll('button'))button.onclick=()=>{photoFilter=button.dataset.filter;photoPage=0;render();$('files').scrollTop=0;};
$('captureStart').onclick=()=>startCapture();
$('capturePause').onclick=()=>pauseCapture();
$('captureStop').onclick=()=>{stopCapture();render();};
$('captureManual').onclick=()=>captureLoop.take(true).then(render);
$('retryCaptures').onclick=()=>pumpCaptures();
$('recoverCaptures').onclick=()=>action(async()=>{if(!batch||batch.status!=='open'||recoveryTargetId!==`${deviceId}:${batch.id}`)throw new Error('请先创建新批次。');stopCapture();await captureLoop.current?.catch(()=>{});const target=batch.id,owner=deviceId;await refreshPending();const rows=pendingCaptures.filter(row=>row.batchId!==target||row.owner!==owner);await captureStore.reassign(rows.map(row=>row.id),target,owner);await refreshPending();say(`已将 ${rows.length} 张本地照片转移到当前批次。即将上传。`);});
$('analyzeCapture').onclick=async()=>{if(!batch||!token)return;try{await api(`/photo-sessions/${encodeURIComponent(batch.id)}/capture-analysis`,{method:'POST',json:{action:'start',force:true}});startAnalysisPolling();}catch(e){$('analysisStatus').textContent=e.message;}};
$('cancelAnalysis').onclick=()=>cancelCaptureAnalysis().catch(e=>{$('analysisStatus').textContent=e.message;});
$('fitCaptureMap').onclick=()=>mapPanel?.fit();
$('captureMapPanel').ontoggle=()=>{if($('captureMapPanel').open)mapPanel?.fit();};
$('refreshSecure').onclick=()=>loadConnection();
$('secureHandoff').onclick=()=>action(async()=>{await prepareBatchChange();const result=await api('/https-handoff',{method:'POST',json:batch?{batchId:batch.id}:{}});const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!==location.hostname||Number(url.port||443)!==connection?.httpsPort||!url.hash.startsWith('#handoff='))throw new Error('HTTPS 跳转地址无效。请在电脑工作台检查连接。');location.assign(url.href);});
$('commit').onclick=()=>action(async()=>{await prepareBatchChange();let result;try{result=await api(`/photo-sessions/${batch.id}/commit`,{method:'POST'});}catch(e){try{await refreshBatch();}catch{}throw e;}batch=await api(`/photo-sessions/${batch.id}`);if(!batch.projectId)batch.projectId=result.projectId;await loadProject();say('项目已创建。请确认后开始重建。');});
$('run').onclick=()=>action(async()=>{try{await api(`/projects/${project.id}/run`,{method:'POST',json:{trainingPreset:batch.trainingPreset}});say('已开始重建。');}catch(e){if(e.status===409)say('工作台正忙或当前项目不能启动。请稍后再试。');else throw e;}await loadProject();});
window.addEventListener('pagehide',()=>{stopPoll();stopCapture('页面已离开。请手动重新启动相机。');stopCaptureUploads();stopAnalysisPolling();});
window.addEventListener('pageshow',event=>{if(event.persisted&&token){if(batch?.projectId)loadProject();startAnalysisPolling();pumpCaptures();render();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){directionGuidance.stop();if(stream||openingCamera)pauseCapture('页面进入后台，已暂停。回到前台后，请点“继续采集”。');releaseWakeLock();}else{render();pumpCaptures();}});
window.addEventListener('online',()=>{loadConnection();pumpCaptures();});
async function bootstrap(){
 try{await refreshPending();}catch(e){storageReady=false;$('captureReason').textContent=`本地存储不可用：${e.message}。请使用系统相机或相册。`;}
 if(handoffTicket){
  try{if(location.protocol!=='https:')throw new Error('请通过 HTTPS 打开一次性连接。');const response=await fetch(base+'/https-handoff/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:handoffTicket}),credentials:'same-origin'}),result=await response.json();if(!response.ok)throw new Error(result.error||'一次性连接已过期。请返回 HTTP 页面重新跳转。');token=result.token;deviceId=result.deviceId;localStorage.setItem('gr.mobile.token',token);localStorage.setItem('gr.mobile.device',deviceId);if(result.batchId)localStorage.setItem('gr.mobile.batch',result.batchId);else localStorage.removeItem('gr.mobile.batch');}
  catch(e){say(e.message);await loadConnection();render();return;}
 }
 await loadConnection();await action(init);
}
bootstrap();
