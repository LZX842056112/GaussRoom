// Isolated frontend fixture. Open the printed URLs with the approved browser tool.
// This process never reads workbench projects and never opens a physical camera.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function startCaptureFixture(){
 let batch={id:'b',name:'隔离采集测试',status:'open',uniqueCount:0,totalBytes:0,files:[]},uploads='fail',revoked=false;
 const root=resolve(import.meta.dirname,'public');
 const json=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
 const fixtureScript=`<script>
 localStorage.setItem('gr.mobile.token','fixture-token');localStorage.setItem('gr.mobile.device','device');localStorage.setItem('gr.mobile.batch','b');
 navigator.mediaDevices.getUserMedia=async function(constraints){
   const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d');
   for(let y=0;y<1080;y+=40)for(let x=0;x<1920;x+=40){ctx.fillStyle=(x/40+y/40)%2?'#7483be':'#c1b275';ctx.fillRect(x,y,40,40);}
   const timer=setInterval(()=>{ctx.fillStyle='#6487b3';ctx.fillRect(850,450,200,100);ctx.fillStyle='#b48c69';ctx.fillRect(850+Math.floor(Date.now()/100)%150,450,20,100);},100);
   const stream=canvas.captureStream(10);stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
 };
 </script>`;
 const server=createServer(async(request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname;
  if(path==='/fixture-control'){
   if(request.method==='POST'){let text='';for await(const chunk of request)text+=chunk;const input=JSON.parse(text);if(input.uploads)uploads=input.uploads;if(input.revoked!==undefined)revoked=input.revoked;return json(response,{uploads,revoked});}
   response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(`<h1>隔离前端测试控制</h1><p>所有数据均为内存测试数据。相机使用测试画布。</p><button onclick="update({uploads:'ready'})">允许上传</button><button onclick="update({uploads:'fail'})">模拟断网</button><button onclick="update({revoked:true})">撤销测试授权</button><button onclick="update({revoked:false})">恢复测试授权</button><pre id="status"></pre><p><a href="/mobile/">手机页面</a> · <a href="/capture-store-check.html">IndexedDB 检查</a></p><script>async function update(value){document.querySelector('#status').textContent=JSON.stringify(await(await fetch('/fixture-control',{method:'POST',body:JSON.stringify(value)})).json())}</script>`);return;
  }
  if(path==='/capture-store-check.html'){
   response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(`<h1>原生 IndexedDB 检查</h1><button id="run">运行存储检查</button><pre id="results">尚未运行</pre><script type="module">
   import {CaptureStore} from '/mobile/capture.mjs';
   document.querySelector('#run').onclick=async()=>{
    const result=document.querySelector('#results');result.textContent='运行中';const passed=[];const check=(value,message)=>{if(!value)throw new Error(message);passed.push(message);};
    try{
     const store=new CaptureStore(),before=await store.list(),prefix='store-check-'+crypto.randomUUID();
     const row={id:prefix,bytes:4,blob:new Blob(['jpeg'],{type:'image/jpeg'}),batchId:'isolated',owner:'fixture',name:'check.jpg',createdAt:Date.now()};await store.put(row);
     const reloaded=new CaptureStore(),saved=(await reloaded.list()).find(r=>r.id===prefix);check(saved&&await saved.blob.text()==='jpeg','PASS Blob survives a new store instance');
     await reloaded.reassign([prefix],'new-batch','new-device');const moved=(await reloaded.list()).find(r=>r.id===prefix);check(moved.batchId==='new-batch'&&moved.owner==='new-device'&&await moved.blob.text()==='jpeg','PASS explicit recovery preserves Blob');
     let quota=false;try{await store.put({...row,id:prefix+'-big',bytes:128*1024*1024+1});}catch{quota=true;}check(quota,'PASS byte backpressure rejects excess storage');
     await store.remove(prefix);check(!(await store.list()).some(r=>r.id===prefix),'PASS acknowledged record can be removed');
     check((await store.list()).length===before.length,'PASS existing capture records preserved');result.textContent=passed.join('\\n');
    }catch(e){result.textContent=passed.join('\\n')+'\\nFAIL '+e.message;}
   };
   </script>`);return;
  }
  if(path.startsWith('/api/mobile/v1')){
   let raw='';for await(const chunk of request)raw+=chunk;const route=path.slice('/api/mobile/v1'.length);
   if(revoked)return json(response,{error:'测试授权已撤销'},401);
   if(route==='/pair'){revoked=false;return json(response,{token:'fixture-new-token',deviceId:'new-device'});}
   if(route==='/session')return json(response,{});
   if(route==='/capabilities')return json(response,{deviceId:'device',photoFormats:['.jpg','.jpeg','.png'],trainingPresets:['standard'],limits:{maxFileBytes:20*1024*1024,maxFiles:500,minLongEdge:1000}});
   if(route==='/photo-sessions'&&request.method==='POST'){batch={id:'b',name:'新恢复测试批次',status:'open',uniqueCount:0,totalBytes:0,files:[]};return json(response,batch);}
   if(route==='/photo-sessions')return json(response,[batch]);
   if(route==='/photo-sessions/b')return json(response,batch);
   if(route==='/photo-sessions/b/capture-analysis')return json(response,{status:'waiting',revision:0,lastMapRevision:0,processedCount:0,requestedCount:batch.files.length});
   if(route==='/photo-sessions/b/files'&&request.method==='POST'){
    const input=JSON.parse(raw),prior=batch.files.find(f=>f.clientCaptureId===input.clientCaptureId),file=prior||{id:'f'+batch.files.length,name:input.name,bytes:input.bytes,clientCaptureId:input.clientCaptureId,status:'pending'};if(!prior)batch.files.push(file);return json(response,{fileId:file.id,session:batch});
   }
   if(route.startsWith('/photo-sessions/b/files/')&&request.method==='PUT'){
    if(uploads==='fail')return json(response,{error:'模拟断网'},503);
    const file=batch.files.find(f=>f.id===route.split('/').at(-1));file.status='ready';batch.uniqueCount=batch.files.filter(f=>f.status==='ready').length;batch.totalBytes+=file.bytes;return json(response,batch);
   }
   return json(response,{error:route},404);
  }
  if(path==='/mobile/connection.json')return json(response,{httpsEnabled:false,httpsPort:8125,certificate:null});
  try{const relative=path==='/mobile/'?'mobile/index.html':path.slice(1),file=resolve(root,relative);if(!file.startsWith(root+sep))throw new Error('outside fixture');let contents=await readFile(file);if(relative==='mobile/index.html')contents=contents.toString().replace('<script type="module"',fixtureScript+'<script type="module"');const type={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream';response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});response.end(contents);}catch{response.writeHead(404);response.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:'http://127.0.0.1:'+server.address().port};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const fixture=await startCaptureFixture();console.log('Fixture only: '+fixture.url+'/fixture-control');}
