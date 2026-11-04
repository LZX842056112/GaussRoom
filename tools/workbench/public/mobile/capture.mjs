// The checks are conservative. A flat wall cannot prove blur or a repeated view.
export function captureDecision(frame, history=[], manual=false) {
 if(frame.longEdge<1000)return {accept:false,reason:'resolution'};
 if(frame.mean<12||frame.dark>.94)return {accept:false,reason:'dark'};
 if(frame.mean>245||frame.bright>.94)return {accept:false,reason:'bright'};
 const textured=frame.variance>=100;
 if(textured&&frame.sharpness<22)return {accept:false,reason:'blur'};
 if(!manual&&textured&&history.some(old=>old.variance>=100&&old.hash.length===frame.hash.length&&old.hash.reduce((n,v,i)=>n+(v!==frame.hash[i]),0)<=2&&old.gray.reduce((n,v,i)=>n+Math.abs(v-frame.gray[i]),0)/frame.gray.length<3.5))return {accept:false,reason:'repeat'};
 return {accept:true,reason:textured?'accepted':'uncertain'};
}

export function frameMetrics(data,width,height,longEdge) {
 const values=new Float32Array(width*height);let sum=0,squares=0,dark=0,bright=0;
 for(let i=0;i<values.length;i++){const v=.299*data[i*4]+.587*data[i*4+1]+.114*data[i*4+2];values[i]=v;sum+=v;squares+=v*v;dark+=v<8;bright+=v>250;}
 const mean=sum/values.length;let lapSum=0,lapSquares=0,count=0;
 for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x,v=values[i-1]+values[i+1]+values[i-width]+values[i+width]-4*values[i];lapSum+=v;lapSquares+=v*v;count++;}
 const gray=[];for(let y=0;y<8;y++)for(let x=0;x<9;x++)gray.push(values[Math.min(height-1,Math.floor((y+.5)*height/8))*width+Math.min(width-1,Math.floor((x+.5)*width/9))]);
 const hash=[];for(let y=0;y<8;y++)for(let x=0;x<8;x++)hash.push(gray[y*9+x]>gray[y*9+x+1]?1:0);
 return {longEdge,mean,variance:squares/values.length-mean*mean,dark:dark/values.length,bright:bright/values.length,sharpness:lapSquares/count-(lapSum/count)**2,gray,hash};
}

export class CaptureLoop {
 constructor(take,{setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),onError=()=>{},onSettled=()=>{}}={}){this.capture=take;this.setTimer=setTimer;this.clearTimer=clearTimer;this.onError=onError;this.onSettled=onSettled;this.interval=1500;this.state='stopped';this.generation=0;this.inFlight=false;this.timer=null;}
 start(){if(this.state==='running')return;this.state='running';this.generation++;this.schedule();}
 schedule(){if(this.state!=='running'||this.timer!==null||this.inFlight)return;this.timer=this.setTimer(async()=>{this.timer=null;await this.take(false);},this.interval);}
 async take(manual=false){if(this.inFlight||(!manual&&this.state!=='running'))return false;const generation=this.generation;this.inFlight=true;try{this.current=Promise.resolve(this.capture(manual,()=>generation===this.generation));await this.current;}catch(e){this.pause();this.onError(e);}finally{this.current=null;this.inFlight=false;this.schedule();this.onSettled();}return true;}
 pause(){this.state='paused';this.generation++;this.clearTimer(this.timer);this.timer=null;}
 stop(){this.pause();this.state='stopped';}
}

export function canStoreCapture(rows,bytes){return rows.length<20&&Number.isSafeInteger(bytes)&&bytes>0&&rows.reduce((n,r)=>n+r.bytes,0)+bytes<=128*1024*1024;}

export class CaptureStore {
 async open(){if(this.db)return this.db;this.db=await new Promise((resolve,reject)=>{const request=indexedDB.open('gaussroom-captures',1);request.onupgradeneeded=()=>request.result.createObjectStore('captures',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('本地存储被其他页面占用。请关闭其他采集页。'));});return this.db;}
 async list(){const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction('captures').objectStore('captures').getAll();request.onsuccess=()=>resolve(request.result.sort((a,b)=>a.createdAt-b.createdAt));request.onerror=()=>reject(request.error);});}
 async put(row){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('captures','readwrite'),store=tx.objectStore('captures');let failure;const all=store.getAll();all.onsuccess=()=>{if(!canStoreCapture(all.result.filter(r=>r.id!==row.id),row.bytes)){failure=new Error('本地队列已满。请等待上传，再点继续采集。');tx.abort();return;}store.put(row);};tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(failure||tx.error||new Error('本地照片保存失败。'));});}
 async remove(id){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('captures','readwrite');tx.objectStore('captures').delete(id);tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本地记录更新失败。'));});}
 async reassign(ids,batchId,owner){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('captures','readwrite'),store=tx.objectStore('captures');for(const id of ids){const get=store.get(id);get.onsuccess=()=>{if(get.result)store.put({...get.result,batchId,owner});};}tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本地照片转移失败。'));});}
}

// The caller serializes this pump with system-camera and gallery uploads.
export async function uploadPending({store,api,batchId,owner,active=()=>true,onSession=()=>{},onPending=()=>{}}) {
 for(const row of await store.list()){
  if(!active())return;if(row.batchId!==batchId||row.owner!==owner)continue;
  let session=await api(`/photo-sessions/${encodeURIComponent(batchId)}`);if(!active())return;onSession(session);
  let file=session.files.find(f=>f.clientCaptureId===row.id);
  if(file&&['ready','duplicate'].includes(file.status)){await store.remove(row.id);await onPending();continue;}
  if(session.status!=='open')throw new Error('批次已关闭。本地照片仍保留，请将其转移到新批次。');
  if(!file){const result=await api(`/photo-sessions/${encodeURIComponent(batchId)}/files`,{method:'POST',json:{name:row.name,bytes:row.bytes,clientCaptureId:row.id}});session=result.session;file=session.files.find(f=>f.id===result.fileId);onSession(session);}
  if(!active())return;
  if(!file)throw new Error('服务器没有返回照片记录。请重试。');
  if(!['ready','duplicate'].includes(file.status)){session=await api(`/photo-sessions/${encodeURIComponent(batchId)}/files/${encodeURIComponent(file.id)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:row.blob});onSession(session);file=session.files.find(f=>f.id===file.id);}
  if(!active())return;
  if(!file||!['ready','duplicate'].includes(file.status))throw new Error('服务器尚未确认照片。本地照片仍保留。');
  await store.remove(row.id);await onPending();
 }
}
