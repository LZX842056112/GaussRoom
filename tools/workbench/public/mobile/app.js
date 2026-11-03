import {canCommit, needsReselect, unfinished, formatBytes, timingLabel, uploadLabel, shouldPoll, photoView} from './state.mjs';
const $ = id => document.getElementById(id), base='/api/mobile/v1';
let token=localStorage.getItem('gr.mobile.token')||'', batch=null, project=null, capabilities=null, busy=false, queue=[], local=new Map(), thumbs=new Map(), thumbQueue=[], thumbnailing=false, pollTimer=null, pollAbort=null, pollGeneration=0, uploadProgress=null, thumbGeneration=0;
let photoFilter='all',photosExpanded=false,photoPage=0;
const labels={open:'待上传',committing:'正在创建',committed:'已创建',pending:'待处理',uploading:'上传中',ready:'已上传',duplicate:'重复照片',failed:'失败',idle:'待开始',running:'重建中',aborting:'正在停止',completed:'已完成',done:'已完成',needs_input:'待补充',passed:'通过',pass:'通过',unmeasured:'未实测',unknown:'待检查',not_run:'待检查',unverified:'待验证',verified:'已验证',unreviewed:'待检查',reviewed:'已检查',missing:'有缺失',needs_improvement:'待改进',calibrated:'已标定',skipped:'已跳过',cancelled:'已停止',canceled:'已停止'};
labels.deleting='删除未完成';
const statusLabel=value=>labels[value]||value||'待检查';
function resetPhotoView(){photoFilter='all';photosExpanded=false;photoPage=0;}
const say = text => $('message').textContent=text;
const saveQueue = () => { if(batch) localStorage.setItem(`gr.mobile.queue.${batch.id}`,JSON.stringify(queue.map(f=>({name:f.name,size:f.size})))); };
function clearAuthorization(){token='';localStorage.removeItem('gr.mobile.token');localStorage.removeItem('gr.mobile.batch');stopPoll();resetPhotoView();batch=null;project=null;capabilities=null;queue=[];local.clear();thumbs.clear();thumbQueue=[];thumbGeneration++;uploadProgress=null;$('camera').value='';$('gallery').value='';$('sessions').replaceChildren(new Option('选择批次',''));for(const id of ['batchInfo','projectInfo','progress','timing','quality','formatNote'])$(id).textContent='';$('steps').replaceChildren();$('viewer').removeAttribute('href');render();say('授权已失效，请重新配对。');}
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
async function action(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){say(e.message);}finally{busy=false;render();}}
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
 for(const el of document.querySelectorAll('button, input, select')) el.disabled=busy;
 $('cancelDelete').disabled=false;$('confirmDelete').disabled=false;
 $('batchActions').hidden=!batch;const deletingRunning=['running','aborting'].includes(project?.state);
 $('deleteBatch').disabled=busy||deletingRunning;$('deleteBatch').textContent=batch?.status==='deleting'?'重试删除':batch?.projectId?'删除项目':'删除批次';
 $('batchActions').querySelector('span').textContent=deletingRunning?'重建进行中，暂不可删除':busy?'正在处理，暂不可删除':'管理当前照片与重建结果';
 $('commit').disabled=busy||!canCommit(batch,queue.length);$('commit').textContent=batch?.status==='committing'?'重试创建项目':'提交照片并创建项目';$('sessions').disabled=busy||queue.length>0;$('createForm').querySelector('button').disabled=busy||queue.length>0;$('retryQueue').hidden=!queue.length;$('retryQueue').disabled=busy||batch?.status!=='open';$('run').disabled=busy||!project||['running','aborting'].includes(project.state);
 $('camera').disabled=$('gallery').disabled=busy||batch?.status!=='open';
 for(const id of ['camera','gallery'])$(id).closest('label').classList.toggle('is-disabled',$(id).disabled);
 updateUploadProgress();
 $('batchInfo').textContent=batch?batch.name:'';$('batchState').textContent=statusLabel(batch?.status);
 $('photoCount').textContent=(batch?.files.length||0)+queue.length;$('validCount').textContent=batch?.uniqueCount||0;
 $('attentionCount').textContent=(batch?.files.filter(unfinished).length||0)+queue.length;$('photoSize').textContent=formatBytes(batch?.totalBytes||0);
 const view=photoView(batch?.files||[],{filter:photoFilter,expanded:photosExpanded,page:photoPage,activeId:uploadProgress?.id});photoPage=view.page;
 $('togglePhotos').hidden=view.count<=6&&!photosExpanded;$('togglePhotos').disabled=false;$('togglePhotos').textContent=photosExpanded?'收起照片':`查看全部 ${view.count} 张`;$('togglePhotos').setAttribute('aria-expanded',String(photosExpanded));
 $('photoFilters').hidden=!batch?.files.length;for(const button of $('photoFilters').querySelectorAll('button')){button.disabled=false;button.setAttribute('aria-pressed',String(button.dataset.filter===photoFilter));}
 $('photoPager').hidden=!photosExpanded||view.pages<=1;$('photoPage').textContent=`${view.page+1} / ${view.pages}`;$('prevPhotos').disabled=view.page===0;$('nextPhotos').disabled=view.page>=view.pages-1;
 $('emptyPhotos').hidden=!!view.count;$('emptyPhotos').querySelector('p').textContent=batch?.files.length?'暂无此类照片':'还没有照片';
 $('emptyPhotos').querySelector('small').textContent=batch?.files.length?'可以切换筛选，查看其他照片。':'从相册添加，或拍下第一个视角。';
 $('queuedDetails').hidden=!queue.length;$('queueSummary').textContent=`待上传队列 · ${queue.length} 张`;
 const missing=batch?needsReselect(batch.files,local).length:0;
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
   if(unfinished(f)){const label=element('label','选择原照片并重试');label.className='button';const input=document.createElement('input');input.type='file';input.accept=capabilities?.photoFormats.join(',')||'.jpg,.jpeg,.png';input.disabled=busy;input.setAttribute('aria-label',`为 ${f.name} 选择原照片并重试`);input.onchange=()=>{const file=input.files[0];if(!file)return;if(file.size!==f.bytes){say('所选文件大小与原记录不同。请选择原照片，或移除该记录后重新上传。');return;}local.set(f.id,file);makeThumb(f.id,file);action(()=>upload(f.id,file));};label.append(input);actions.append(label);
    if(local.has(f.id)){const retry=element('button','重试');retry.className='retry-button';retry.disabled=busy;retry.setAttribute('aria-label',`重试 ${f.name}`);retry.onclick=()=>action(()=>upload(f.id,local.get(f.id)));actions.append(retry);}}
   const remove=element('button','移除');remove.disabled=busy;remove.setAttribute('aria-label',`移除 ${f.name}`);remove.onclick=()=>action(async()=>{batch=await api(`/photo-sessions/${batch.id}/files/${f.id}`,{method:'DELETE'});local.delete(f.id);thumbs.delete(f.id);say('照片已移除。');});actions.append(remove);info.append(actions);}
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
 try{await api(`/photo-sessions/${encodeURIComponent(target.id)}`,{method:'DELETE'});}
 catch(e){if(e.status!==404){if(batch?.id===target.id){try{await refreshBatch();}catch{}if(batch?.status==='deleting'){stopPoll();project=null;render();}}throw e;}}
 stopPoll();if(batch?.id!==target.id)return;
 localStorage.removeItem(`gr.mobile.queue.${target.id}`);localStorage.removeItem('gr.mobile.batch');
 batch=null;project=null;queue=[];local.clear();thumbs.clear();thumbQueue=[];thumbGeneration++;uploadProgress=null;resetPhotoView();
 $('camera').value='';$('gallery').value='';$('projectSetup').open=true;$('sessions').replaceChildren(new Option('选择批次',''));render();say('项目与上传批次已删除。');
 try{await getSessions();}catch(e){if(e.status===401)throw e;say('已删除。列表暂时无法刷新，请刷新页面。');}
}
async function getSessions(){const sessions=await api('/photo-sessions');const select=$('sessions');select.replaceChildren(new Option('选择批次',''));for(const s of sessions)select.add(new Option(`${s.name} · ${statusLabel(s.status)}`,s.id));if(batch)select.value=batch.id;}
async function loadBatch(id){stopPoll();batch=await api(`/photo-sessions/${encodeURIComponent(id)}`);localStorage.setItem('gr.mobile.batch',id);local.clear();thumbs.clear();queue=restoreQueue(id);resetPhotoView();$('projectSetup').open=false;$('queuedDetails').open=queue.some(f=>f.needsFile);$('sessions').value=id;project=null;if(batch.projectId)await loadProject();render();}
async function loadProject(){
 const projectId=batch?.projectId, generation=pollGeneration;if(!projectId)return;
 clearTimeout(pollTimer);pollTimer=null;const controller=new AbortController();pollAbort=controller;let retry=false,stopped=false;
 try{const result=await api(`/projects/${encodeURIComponent(projectId)}`,{signal:controller.signal});if(generation!==pollGeneration||batch?.projectId!==projectId)return;project=result;render();}
 catch(e){if(e.name==='AbortError'||generation!==pollGeneration){stopped=true;return;}stopped=e.status===401||e.status===404;retry=!stopped;say(e.message);}
 finally{if(pollAbort===controller)pollAbort=null;if(!stopped&&generation===pollGeneration&&batch?.projectId===projectId&&(retry||shouldPoll(project,generation,pollGeneration)))pollTimer=setTimeout(loadProject,2000);}
}
async function init(){if(!token){render();return;}await api('/session',{method:'POST'});capabilities=await api('/capabilities');$('camera').accept=['image/jpeg','image/png',...capabilities.photoFormats].join(',');$('gallery').accept=capabilities.photoFormats.join(',');$('formatNote').textContent=capabilities.photoFormats.some(x=>/heic|heif/i.test(x))?'如果无法选择 HEIC，请在手机中先转为 JPEG 或 PNG。':'此工作台不支持 HEIC/HEIF。请先在手机中转为 JPEG 或 PNG。';for(const option of $('preset').options)option.disabled=!capabilities.trainingPresets.includes(option.value);$('limits').textContent=`支持：${capabilities.photoFormats.join('、')}；单张不超过 ${formatBytes(capabilities.limits.maxFileBytes)}，最多 ${capabilities.limits.maxFiles} 张；照片长边至少 ${capabilities.limits.minLongEdge} 像素。`;await getSessions();const id=localStorage.getItem('gr.mobile.batch');if(id)try{await loadBatch(id);}catch(e){if(e.status!==404)throw e;localStorage.removeItem('gr.mobile.batch');}render();}
$('pairForm').onsubmit=e=>{e.preventDefault();action(async()=>{const result=await api('/pair',{method:'POST',json:{code:$('code').value,deviceName:$('device').value}});token=result.token;localStorage.setItem('gr.mobile.token',token);localStorage.removeItem('gr.mobile.batch');batch=null;project=null;await init();say('配对成功。');});};
$('createForm').onsubmit=e=>{e.preventDefault();action(async()=>{batch=await api('/photo-sessions',{method:'POST',json:{name:$('name').value,trainingPreset:$('preset').value}});localStorage.setItem('gr.mobile.batch',batch.id);project=null;queue=[];local.clear();thumbs.clear();resetPhotoView();$('projectSetup').open=false;await getSessions();say('批次已创建。');});};
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
$('commit').onclick=()=>action(async()=>{let result;try{result=await api(`/photo-sessions/${batch.id}/commit`,{method:'POST'});}catch(e){try{await refreshBatch();}catch{}throw e;}batch=await api(`/photo-sessions/${batch.id}`);if(!batch.projectId)batch.projectId=result.projectId;await loadProject();say('项目已创建。请确认后开始重建。');});
$('run').onclick=()=>action(async()=>{try{await api(`/projects/${project.id}/run`,{method:'POST',json:{trainingPreset:batch.trainingPreset}});say('已开始重建。');}catch(e){if(e.status===409)say('工作台正忙或当前项目不能启动。请稍后再试。');else throw e;}await loadProject();});
window.addEventListener('pagehide',stopPoll);window.addEventListener('pageshow',event=>{if(event.persisted&&token&&batch?.projectId)loadProject();});action(init);
