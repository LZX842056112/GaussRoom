import test from 'node:test';
import assert from 'node:assert/strict';
let guide={};
try{guide=await import('./public/mobile/direction-guide.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} differs from ${b}`);
const portrait=(alpha=0,beta=90)=>({alpha,beta,gamma:0,screenAngle:0});

test('rear-camera orientation uses gravity and keeps screen axes correct in both landscape rotations',()=>{
 assert.equal(typeof guide.orientationPose,'function');
 const upright=guide.orientationPose(portrait());close(upright.yaw,0);close(upright.pitch,0);
 close(guide.orientationPose(portrait(0,125)).pitch,35);close(guide.orientationPose(portrait(0,55)).pitch,-35);
 for(const pose of [guide.orientationPose({alpha:90,beta:0,gamma:-90,screenAngle:90}),guide.orientationPose({alpha:270,beta:0,gamma:90,screenAngle:270})]){
  for(const key of ['right','up','forward'])pose[key].forEach((value,i)=>close(value,upright[key][i]));
 }
 for(const input of [{alpha:null,beta:90,gamma:0},{alpha:0,beta:NaN,gamma:0},{alpha:0,beta:90,gamma:Infinity}])assert.equal(guide.orientationPose(input),null);
});

test('direction projection clips points behind the camera and honors the actual contained video rectangle',()=>{
 const pose=guide.orientationPose(portrait());
 const center=guide.projectDirection(0,0,pose,1920,1080);close(center.x,.5);close(center.y,.5);
 assert.ok(guide.projectDirection(15,0,pose,1920,1080).x>.5);
 assert.ok(guide.projectDirection(0,15,pose,1920,1080).y<.5);
 assert.equal(guide.projectDirection(180,0,pose,1920,1080),null);
 assert.deepEqual(guide.containedVideoRect(600,380,1080,1920),{left:193.125,top:0,width:213.75,height:380});
});

test('only confirmed saved photos count, wrapped headings stay in one cell, and stations invalidate old snapshots',()=>{
 let now=1000;const model=new guide.DirectionGuide({clock:()=>now});model.newStation();model.update(portrait(359));
 const first=model.snapshot();assert.ok(first);assert.equal(model.view().recorded,0);assert.equal(model.saved(first,'first'),true);assert.equal(model.view().recorded,1);
 now+=1000;model.update(portrait(1));model.saved(model.snapshot(),'second');assert.equal(model.view().recorded,1);
 model.reconcile(new Set(['second']));assert.equal(model.view().recorded,1);model.reconcile(new Set());assert.equal(model.view().recorded,0);
 const old=model.snapshot();model.newStation();assert.equal(model.saved(old,'late'),false);assert.equal(model.view().recorded,0);
});

test('unknown, stale, too fast, and off-target orientation never awards a direction',()=>{
 let now=1000;const model=new guide.DirectionGuide({clock:()=>now});model.newStation();assert.equal(model.snapshot(),null);
 model.update(portrait());now+=801;assert.equal(model.snapshot(),null);
 model.update(portrait());now+=100;model.update(portrait(30));assert.equal(model.snapshot(),null);assert.equal(model.view().reason,'fast');
 now+=1000;model.update(portrait(30,110));assert.equal(model.snapshot(),null);
 model.suspend();assert.equal(model.snapshot(),null);assert.equal(model.view().ready,false);
});
test('slow sensor delivery still detects a fast turn and equal-time motion cannot earn a direction',()=>{
 let now=1000;const model=new guide.DirectionGuide({clock:()=>now});model.update(portrait());now+=600;model.update(portrait(60));
 assert.equal(model.view().reason,'fast');assert.equal(model.snapshot(),null);
 model.newStation();model.update(portrait());model.update(portrait(30));assert.equal(model.snapshot(),null);
 now+=100;model.update(portrait(30));assert.ok(model.snapshot());
});

test('suggestions choose unrecorded directions, distinguish height rings, and never declare surface coverage',()=>{
 let now=1000;const model=new guide.DirectionGuide({clock:()=>now});model.newStation();model.update(portrait());model.saved(model.snapshot(),'f');
 assert.notEqual(model.view('wall').target.id,model.snapshot().cell);
 assert.equal(model.view('upper').target.pitch,35);assert.equal(model.view('lower').target.pitch,-35);
 assert.equal(model.view().total,72);assert.equal(model.view().coverage,undefined);
});

let ui={};try{ui=await import('./public/mobile/capture-guidance.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
function sensorHost(permission){
 const listeners=new Map(),timers=new Set();
 class DeviceOrientationEvent{static requestPermission(){assert.equal(this,DeviceOrientationEvent);return permission();}}
 const host={isSecureContext:true,DeviceOrientationEvent,screen:{orientation:{angle:90}},addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:(name,handler)=>{if(listeners.get(name)===handler)listeners.delete(name);},setInterval:fn=>{timers.add(fn);return fn;},clearInterval:id=>timers.delete(id)};
 return {host,listeners,timers};
}
test('motion permission starts in the click call and a late grant cannot restart stopped guidance',async()=>{
 let resolve,requested=false;const f=sensorHost(()=>{requested=true;return new Promise(r=>resolve=r);});
 const input=new ui.OrientationInput({host:f.host,isActive:()=>true,onSample:()=>{},onChange:()=>{},onReset:()=>{}});
 const promise=input.enable();assert.equal(requested,true);input.stop();resolve('granted');await promise;
 assert.equal(input.enabled,false);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});
test('denied or unavailable direction sensors leave capture free and active subscriptions stop cleanly',async()=>{
 const denied=sensorHost(async()=>'denied');let active=true;
 const rejected=new ui.OrientationInput({host:denied.host,isActive:()=>active,onSample:()=>assert.fail('no sensor data'),onChange:()=>{},onReset:()=>{}});await rejected.enable();assert.equal(rejected.status,'unavailable');assert.equal(active,true);
 const accepted=sensorHost(async()=>'granted'),samples=[];
 const input=new ui.OrientationInput({host:accepted.host,isActive:()=>active,onSample:sample=>samples.push(sample),onChange:()=>{},onReset:()=>{}});await input.enable();
 accepted.listeners.get('deviceorientation')(portrait());assert.equal(samples[0].screenAngle,90);const old=accepted.listeners.get('deviceorientation');input.stop();old(portrait());assert.equal(samples.length,1);assert.equal(accepted.timers.size,0);
 const unavailable=new ui.OrientationInput({host:{isSecureContext:true},isActive:()=>true,onSample:()=>{},onChange:()=>{},onReset:()=>{}});await unavailable.enable();assert.equal(unavailable.status,'unavailable');
});
test('camera overlay lights saved directions, reconciles duplicates, and clears its reference on interruption',async()=>{
 const f=sensorHost(async()=>'granted');f.host.screen.orientation.angle=0;
 const controls=new Map();function element(){return {style:{},attributes:{},children:[],value:'auto',hidden:false,clientWidth:600,clientHeight:380,videoWidth:1080,videoHeight:1920,setAttribute(name,value){this.attributes[name]=value;},toggleAttribute(name,force){if(force)this.attributes[name]='';else delete this.attributes[name];},append(child){this.children.push(child);},addEventListener(){}};}
 const $=id=>{if(!controls.has(id))controls.set(id,element());return controls.get(id);};
 const context={active:true,hidden:false,opening:false,inFlight:false,files:[],pending:[]};
 $('directionOverlay').setAttribute('hidden','');
 const controller=ui.createCaptureGuidance({host:f.host,document:{createElementNS:element},$,getContext:()=>context});
 $('directionEnable').onclick();await Promise.resolve();await Promise.resolve();f.listeners.get('deviceorientation')(portrait());controller.render();
 assert.equal('hidden' in $('directionOverlay').attributes,false);assert.equal($('directionOverlay').style.left,'193.125px');
 const before=controller.snapshot();assert.ok(before);context.pending=[{id:'frame'}];controller.saved(before,'frame');controller.render();assert.match($('directionSummary').textContent,/1 \/ 72/);
 assert.ok($('directionOverlay').children.some(dot=>dot.attributes.class?.includes('is-recorded')));
 $('directionMode').value='doorway';controller.render();assert.match($('directionCue').textContent,/两个房间/);assert.match($('directionCue').textContent,/共同/);assert.equal($('directionBadge').textContent,'门口连接');
 context.files=[{clientCaptureId:'frame',status:'duplicate'}];controller.render();assert.match($('directionSummary').textContent,/0 \/ 72/);
 $('directionNewStation').onclick();assert.equal(controller.saved(before,'late'),false);
 context.hidden=true;for(const tick of [...f.timers])tick();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);assert.equal(controller.snapshot(),null);
 assert.equal('hidden' in $('directionOverlay').attributes,true);
});
test('saved-frame integration awards directions only after durable success and keeps overlays out of JPEG pixels',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm'),source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function captureFrame('),source.indexOf('\nfunction stopCaptureUploads()'));
 for(const mode of ['success','rejected','write-failed']){
  const model=new guide.DirectionGuide({clock:()=>1000});model.update(portrait());const snapshot=model.snapshot();
  const events=[],video={videoWidth:1200,videoHeight:1000},controls=new Map();const get=id=>id==='captureVideo'?video:(controls.has(id)?controls.get(id):controls.set(id,{}).get(id));
  const context=vm.createContext({Blob,crypto:{randomUUID:()=> 'capture-id'},Date,document:{hidden:false,createElement:()=>({getContext:()=>({drawImage:source=>assert.equal(source,video),getImageData:()=>({data:[]})}),toBlob:callback=>callback(new Blob(['jpeg']))})},$:get,
   frameMetrics:()=>({}),captureDecision:()=>({accept:mode!=='rejected',reason:mode==='rejected'?'blur':'accepted'}),
   directionGuidance:{feedback(){},snapshot:()=>{events.push('snapshot');return snapshot;},saved:(shot,id)=>{assert.ok(events.includes('stored'));model.saved(shot,id);events.push('marked');}},
   captureStore:{put:async()=>{if(mode==='write-failed')throw Error('quota');events.push('stored');}},refreshPending:async()=>{await Promise.resolve();model.reconcile(new Set());events.push('refreshed');},canStoreCapture:()=>true,pauseCapture(){},pumpCaptures(){},render(){}});
  vm.runInContext(`let stream={},token='t',batch={id:'b',status:'open'},deviceId='d',captureHistory=[],acceptedCaptures=0,skippedCaptures=0,pendingCaptures=[],capabilities=null;${fn}`,context);
  const pending=vm.runInContext('captureFrame(false,()=>true)',context);if(mode==='write-failed')await assert.rejects(pending,/quota/);else await pending;
  assert.equal(events.includes('marked'),mode==='success');if(mode==='rejected')assert.equal(events.length,0);
  if(mode==='success'){assert.equal(model.view().recorded,1,'an old-queue render during refresh must not discard the just-saved direction');assert.ok(events.indexOf('marked')>events.indexOf('refreshed'));}
 }
});
test('the public mobile gateway serves both guidance modules',async t=>{
 const {createMobileGateway}=await import('./lib/mobile.mjs'),{mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'guide-assets-')),gateway=createMobileGateway({stateRoot:root});t.after(async()=>{await gateway.disable();rmSync(root,{recursive:true,force:true});});
 const info=await gateway.enable({port:0,host:'127.0.0.1'});for(const module of ['direction-guide.mjs','capture-guidance.mjs']){
  const response=await fetch(`http://127.0.0.1:${info.port}/mobile/${module}`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);
 }
});
