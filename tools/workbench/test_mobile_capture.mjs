import test from 'node:test';
import assert from 'node:assert/strict';
let capture={};
try { capture=await import('./public/mobile/capture.mjs'); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; }

test('quality policy rejects severe exposure and blur, but preserves uncertain low texture and new directions',()=>{
 assert.equal(typeof capture.captureDecision,'function');
 const frame={longEdge:1920,mean:110,dark:0,bright:0,variance:500,sharpness:200,hash:Array(64).fill(1),gray:Array(72).fill(100)};
 assert.equal(capture.captureDecision({...frame,longEdge:999},[]).reason,'resolution');
 assert.equal(capture.captureDecision({...frame,mean:5},[]).reason,'dark');
 assert.equal(capture.captureDecision({...frame,bright:.97},[]).reason,'bright');
 assert.equal(capture.captureDecision({...frame,sharpness:3},[]).reason,'blur');
 assert.equal(capture.captureDecision(frame,[frame]).reason,'repeat');
 assert.equal(capture.captureDecision(frame,[frame],true).accept,true);
 assert.equal(capture.captureDecision({...frame,gray:Array(72).fill(120)},[frame]).accept,true);
 assert.equal(capture.captureDecision({...frame,hash:Array(64).fill(0)},[frame]).accept,true);
 assert.equal(capture.captureDecision({...frame,variance:8,sharpness:1},[frame]).accept,true);
});

test('capture loop waits after each completed frame, never overlaps, and pause prevents catch-up and automatic restart',async()=>{
 assert.equal(typeof capture.CaptureLoop,'function');
 let release,shots=0;const timers=new Map();let next=0;
 const loop=new capture.CaptureLoop(async()=>{shots++;await new Promise(r=>{release=r;});},{setTimer:(fn,ms)=>{assert.equal(ms,1500);timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
 loop.start();assert.equal(timers.size,1);const fire=timers.values().next().value;timers.clear();const running=fire();
 await Promise.resolve();assert.equal(shots,1);assert.equal(timers.size,0);
 assert.equal(await loop.take(true),false);loop.pause();release();await running;assert.equal(timers.size,0);
 loop.start();assert.equal(timers.size,1);loop.stop();assert.equal(timers.size,0);assert.equal(loop.state,'stopped');
});

test('pending backpressure is bounded by both record count and Blob bytes',()=>{
 assert.equal(typeof capture.canStoreCapture,'function');
 assert.equal(capture.canStoreCapture(Array.from({length:20},()=>({bytes:1})),1),false);
 assert.equal(capture.canStoreCapture([{bytes:128*1024*1024-3}],4),false);
 assert.equal(capture.canStoreCapture([{bytes:128*1024*1024-3}],3),true);
});

test('serial durable upload reconciles ACK loss without uploading ready bytes again',async()=>{
 assert.equal(typeof capture.uploadPending,'function');
 let files=[],puts=0,posts=0;const rows=[{id:'stable',batchId:'b',owner:'o',name:'frame.jpg',bytes:4,blob:new Blob(['jpeg'])}];
 const store={list:async()=>rows.slice(),remove:async id=>{rows.splice(rows.findIndex(r=>r.id===id),1);}};
 const api=async(path,opts)=>{
  if(opts?.method==='POST'){posts++;assert.equal(opts.json.clientCaptureId,'stable');return {fileId:'f',session:{id:'b',files:files.length?files:[{id:'f',clientCaptureId:'stable',status:'pending'}]}};}
  if(opts?.method==='PUT'){puts++;files=[{id:'f',clientCaptureId:'stable',status:'ready'}];throw new Error('ACK lost');}
  return {id:'b',status:'open',files};
 };
 await assert.rejects(capture.uploadPending({store,api,batchId:'b',owner:'o'}),/ACK lost/);
 assert.equal(rows.length,1);await capture.uploadPending({store,api,batchId:'b',owner:'o'});
 assert.equal(rows.length,0);assert.equal(puts,1);assert.equal(posts,1);
});

test('revoked upload stops immediately and keeps pending Blobs for explicit recovery',async()=>{
 assert.equal(typeof capture.uploadPending,'function');
 const row={id:'keep',batchId:'old',owner:'old-owner',bytes:4,blob:new Blob(['jpeg'])};let calls=0;
 const store={list:async()=>[row],remove:async()=>assert.fail('must keep Blob')};
 await capture.uploadPending({store,api:async()=>{calls++;},batchId:'new',owner:'new-owner'});assert.equal(calls,0);
 await assert.rejects(capture.uploadPending({store,api:async()=>{throw Object.assign(new Error('revoked'),{status:401});},batchId:'old',owner:'old-owner'}),/revoked/);
 assert.equal(row.blob.size,4);
});

test('capture map keeps real camera directions and bounds sparse points without inventing unlocalized positions',async()=>{
 let maps={};try{maps=await import('./public/mobile/capture-map.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof maps.mapSnapshot,'function');
 const snapshot=maps.mapSnapshot({revision:2,cameras:[{fileId:'f',cameraToWorld:[1,0,0,0,0,1,0,0,0,0,1,0,2,3,4,1],intrinsics:[100,100,50,50],width:100,height:100}],points:Array.from({length:10050},()=>({position:[1,2,3],color:[255,0,0]})),unlocalized:['missing']});
 assert.equal(snapshot.cameras.length,1);assert.deepEqual(snapshot.cameras[0].origin,[2,3,4]);assert.deepEqual(snapshot.cameras[0].corners[0],[1.5,3.5,3]);assert.equal(snapshot.points.length,10000);assert.deepEqual(snapshot.unlocalized,['missing']);
});

test('camera markers allow a twenty pixel touch target and reject empty space',async()=>{
 const maps=await import('./public/mobile/capture-map.mjs'),THREE=await import('./public/vendor/three/build/three.module.js');
 const camera=new THREE.PerspectiveCamera(50,1,.01,100);camera.position.set(0,0,5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
 const cameras=[{fileId:'middle',origin:[0,0,0]},{fileId:'behind',origin:[0,0,8]}];
 assert.equal(maps.cameraMarkerAt(cameras,camera,{x:.08,y:.02},{width:400,height:400}),'middle');
 assert.equal(maps.cameraMarkerAt(cameras,camera,{x:.4,y:.4},{width:400,height:400}),null);
});

test('pausing while camera permission is pending invalidates the opening request',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');
 const source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
 const pause=source.slice(source.indexOf('function pauseCapture('),source.indexOf('\nasync function startCapture()'));
 const controls=new Map();let stopped=0;
 const context=vm.createContext({$:id=>{if(!controls.has(id))controls.set(id,{});return controls.get(id);},render(){},releaseWakeLock(){},directionGuidance:{stop(){stopped++;}}});
 vm.runInContext(`let cameraGeneration=4,openingCamera=true,stream=null;const captureLoop={pause(){},stop(){}};${pause}`,context);
 vm.runInContext('pauseCapture()',context);
 assert.equal(vm.runInContext('openingCamera',context),false);assert.equal(vm.runInContext('cameraGeneration',context),5);
 assert.equal(stopped,1);
});

test('batch transition waits for capture storage and cancels analysis only after checking local Blobs',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');
 const source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
 const prepare=source.slice(source.indexOf('async function prepareBatchChange(){'),source.indexOf('\nfunction stopAnalysisPolling()'));
 for(const pending of [true,false]){
  const events=[];let release;const current=new Promise(resolve=>{release=resolve;});
  const context=vm.createContext({stopCapture(){events.push('stop');},render(){},refreshPending:async()=>events.push('read'),stopCaptureUploads(){events.push('upload-stop');},cancelCaptureAnalysis:async()=>events.push('cancel'),captureLoop:{current},pendingCaptures:pending?[{blob:new Blob(['jpeg'])}]:[],queue:[]});
  vm.runInContext(prepare,context);const promise=vm.runInContext('prepareBatchChange()',context);assert.deepEqual(events,['stop']);release();
  if(pending){await assert.rejects(promise,/本地仍有/);assert.deepEqual(events,['stop','read']);}else{await promise;assert.deepEqual(events,['stop','read','upload-stop','cancel']);}
 }
});

test('browser timers retain their Window receiver rather than using CaptureLoop as this',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');
 const source=await readFile(new URL('./public/mobile/capture.mjs',import.meta.url),'utf8');
 const loop=source.slice(source.indexOf('export class CaptureLoop'),source.indexOf('\nexport function canStoreCapture')).replace('export class','class');
 const context=vm.createContext({setTimeout(){assert.notEqual(this?.constructor?.name,'CaptureLoop','Window timer called with CaptureLoop receiver');return 1;},clearTimeout(){assert.notEqual(this?.constructor?.name,'CaptureLoop');}});
 vm.runInContext(`${loop};const instance=new CaptureLoop(async()=>{});instance.start();instance.stop();`,context);
});

test('capture completion re-enables manual controls only after the in-flight frame settles',async()=>{
 let observed;const loop=new capture.CaptureLoop(async()=>{}, {onSettled:()=>{observed=loop.inFlight;}});
 await loop.take(true);assert.equal(observed,false);
});

test('analysis follows completed uploads after capture pauses and removes an invalidated map',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');
 const source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
 const poll=source.slice(source.indexOf('async function pollCaptureAnalysis('),source.indexOf('\nasync function replaceCaptureMap('));
 let starts=0,resets=0;const control={};
 const context=vm.createContext({encodeURIComponent,$:()=>control,api:async(path,options)=>{if(options?.method==='POST'){starts++;return {};}return {status:'waiting',lastMapRevision:0,processedCount:0,requestedCount:20};},resetCaptureMap(){resets++;},setTimeout(){return 1;}});
 vm.runInContext(`let batch={id:'b',status:'open'},token='t',analysisGeneration=2,analysisWanted=true,mapRevision=3,analysisTimer=null;const captureLoop={state:'paused'};${poll}`,context);
 await vm.runInContext('pollCaptureAnalysis(2)',context);assert.equal(starts,1);assert.equal(resets,1);
});
