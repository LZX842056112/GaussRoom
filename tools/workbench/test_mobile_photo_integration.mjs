import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createMobileGateway} from './lib/mobile.mjs';
import * as projects from './lib/projects.mjs';
import {TOOLS,PROJECTS_DIR} from './lib/paths.mjs';
import {buildSteps} from './lib/pipeline.mjs';

test('public phone page pairs and imports real photos into the existing ordinary-photo pipeline',async t=>{
 const root=mkdtempSync(join(tmpdir(),'photo-gateway-')),created=[];let starts=0;
 execFileSync(TOOLS.python,['-X','utf8','-B','-c','from PIL import Image; from pathlib import Path; import sys; p=Path(sys.argv[1]); Image.new("RGB",(1200,1000),"red").save(p/"a.jpg"); Image.new("RGB",(1000,1200),"green").save(p/"b.png")',root]);
 const store={...projects,create:(data,options)=>{const p=projects.create(data,options);created.push(p.id);return p;}};
 const jobs={anyRunning:()=>false,liveProject:()=>null,trainCleanWarning:()=>null,start:(id,options)=>{starts++;assert.equal(projects.read(id).inputKind,'photos');assert.equal(options.trainingPreset,'standard');return{id:'fixture-job'};}};
 let gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store,jobStore:jobs});
 t.after(async()=>{await gateway.disable();for(const id of created){assert.match(id,/^mobile-[a-f0-9-]+$/);rmSync(dirname(projects.projectPath(id)),{recursive:true,force:true});}rmSync(root,{recursive:true,force:true});});
 let info=await gateway.enable({port:0,host:'127.0.0.1'}),origin=`http://127.0.0.1:${info.port}`,base=origin+'/api/mobile/v1',token='';
 const request=(path,method='GET',json)=>fetch(base+path,{method,headers:{...(token?{authorization:`Bearer ${token}`} :{}),...(json!==undefined?{'content-type':'application/json'}:{})},...(json!==undefined?{body:JSON.stringify(json)}:{})});
 for(const path of ['/mobile/','/mobile/app.js','/mobile/style.css','/mobile/state.mjs']){const r=await fetch(origin+path);assert.equal(r.status,200,path);assert.ok((await r.text()).length>50);}
 assert.equal((await fetch(origin+'/mobile/../../.env')).status,401);
 assert.equal((await request('/capabilities')).status,401);
 let r=await request('/pair','POST',{code:info.code,deviceName:'browser-fixture'});assert.equal(r.status,200);token=(await r.json()).token;
 r=await request('/capabilities');assert.equal(r.status,200);const caps=await r.json();assert.ok(caps.photoFormats.includes('.jpg'));assert.deepEqual(caps.limits,{maxFileBytes:67108864,maxFiles:500,maxBatchBytes:4294967296,minLongEdge:1000});assert.equal(JSON.stringify(caps).includes(PROJECTS_DIR),false);
 r=await request('/photo-sessions','POST',{name:'Phone photos',trainingPreset:'standard'});assert.equal(r.status,200);let session=await r.json();
 for(const [file,label] of [['a.jpg','../same.jpg'],['b.png','same.png'],['a.jpg','duplicate.jpg']]){
  const bytes=readFileSync(join(root,file));r=await request(`/photo-sessions/${session.id}/files`,'POST',{name:label,bytes:bytes.length});assert.equal(r.status,200);const declared=await r.json();
  r=await fetch(`${base}/photo-sessions/${session.id}/files/${declared.fileId}`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:bytes});assert.equal(r.status,200);session=await r.json();
 }
 assert.equal(session.uniqueCount,2);assert.equal(session.files.filter(f=>f.status==='duplicate').length,1);
 r=await request(`/photo-sessions/${session.id}/files`,'POST',{name:'not-uploaded.jpg',bytes:123});const pending=await r.json();
 assert.equal((await request(`/photo-sessions/${session.id}/commit`,'POST')).status,409);
 assert.equal((await request(`/photo-sessions/${session.id}/files/${pending.fileId}`,'DELETE')).status,200);
 r=await request(`/photo-sessions/${session.id}/commit`,'POST');assert.equal(r.status,200);const committed=await r.json();
 assert.deepEqual(await (await request(`/photo-sessions/${session.id}/commit`,'POST')).json(),committed);assert.equal(created.length,1);
 const p=projects.read(committed.projectId);assert.equal(p.inputKind,'photos');assert.equal(p.cameraModel,'SIMPLE_RADIAL');assert.equal(p.capture,undefined);assert.equal(p.trainingPreset,'standard');
 assert.equal(p.sourceDir,resolve(PROJECTS_DIR,p.id,'source-images'));assert.equal(readdirSync(p.sourceDir).length,2);assert.equal(existsSync(join(p.sourceDir,'same.jpg')),false);
 const steps=buildSteps();assert.equal(steps.find(s=>s.id==='features').command(p).args[0],'feature_extractor');assert.match(steps.find(s=>s.id==='sparse').command(p).args[0],/sparse_reconstruct\.py$/);
 r=await request(`/projects/${p.id}`);assert.equal(r.status,200);const summary=await r.json();assert.equal(summary.quality.scale,'unmeasured');assert.equal(JSON.stringify(summary).includes(p.sourceDir),false);
 assert.equal((await request(`/projects/${p.id}/run`,'POST',{trainingPreset:'standard'})).status,202);assert.equal(starts,1);
 r=await request('/session','POST');const cookie=r.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(`${base}/projects/${p.id}`,{headers:{cookie}})).status,200);
 assert.equal((await fetch(`${base}/photo-sessions`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"name":"csrf"}'})).status,401);
 // A fresh service restores the committed batch and only its original device's grant.
 const firstToken=token;await gateway.disable();gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store,jobStore:jobs});
 info=await gateway.enable({port:0,host:'127.0.0.1'});origin=`http://127.0.0.1:${info.port}`;base=origin+'/api/mobile/v1';
 assert.equal((await request(`/projects/${p.id}`)).status,200);
 assert.deepEqual(await (await request(`/photo-sessions/${session.id}/commit`,'POST')).json(),committed);assert.equal(created.length,1);
 r=await request('/pair','POST',{code:info.code,deviceName:'other-device'});token=(await r.json()).token;
 assert.deepEqual(await (await request('/photo-sessions')).json(),[]);
 assert.equal((await request(`/photo-sessions/${session.id}`)).status,404);
 assert.equal((await request(`/projects/${p.id}`)).status,404);
 assert.equal((await request(`/projects/${p.id}/run`,'POST',{trainingPreset:'standard'})).status,404);assert.equal(starts,1);
 token=firstToken;assert.equal((await request(`/projects/${p.id}`)).status,200);
 assert.equal((await fetch(`${base}/photo-sessions/${session.id}`,{method:'DELETE',headers:{cookie}})).status,401);
 const remove=store.remove;let failRemoval=true;store.remove=(id,options)=>{if(failRemoval){failRemoval=false;rmSync(projects.projectPath(id));throw Error('simulated locked output');}return remove(id,options);};
 assert.equal((await request(`/photo-sessions/${session.id}`,'DELETE')).status,503);assert.equal(existsSync(p.sourceDir),true);
 await gateway.disable();gateway=createMobileGateway({stateRoot:join(root,'state'),projectStore:store,jobStore:jobs});info=await gateway.enable({port:0,host:'127.0.0.1'});origin=`http://127.0.0.1:${info.port}`;base=origin+'/api/mobile/v1';
 assert.equal((await request(`/photo-sessions/${session.id}`,'DELETE')).status,200);
 assert.equal(existsSync(dirname(projects.projectPath(p.id))),false);
 assert.equal((await request(`/projects/${p.id}`)).status,404);assert.deepEqual(await (await request('/photo-sessions')).json(),[]);
 const saved=JSON.parse(readFileSync(join(root,'state','state.json'),'utf8'));assert.equal(Object.values(saved.devices).some(d=>d.projects.includes(p.id)),false);
});

test('revocation while photo declarations await input or capabilities prevents new records',async t=>{
 const {request}=await import('node:http');const root=mkdtempSync(join(tmpdir(),'photo-delayed-'));
 let resume,entered;const waiting=new Promise(ok=>entered=ok),gate=new Promise(ok=>resume=ok);
 const gateway=createMobileGateway({stateRoot:root,photoCapabilities:async()=>{entered();await gate;return{photoFormats:['.jpg','.jpeg','.png']};}});
 t.after(async()=>{await gateway.disable();rmSync(root,{recursive:true,force:true});});
 let info=await gateway.enable({port:0,host:'127.0.0.1'}),base=`http://127.0.0.1:${info.port}/api/mobile/v1`;
 const pair=async()=>await (await fetch(base+'/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:info.code,deviceName:'delayed'})})).json();
 let device=await pair();
 const delayed=new Promise((resolve,reject)=>{const req=request(base+'/photo-sessions',{method:'POST',headers:{authorization:`Bearer ${device.token}`,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{"name":');setTimeout(()=>{gateway.revoke(device.deviceId);req.end('"revoked"}');},60);});
 assert.equal(await delayed,401);assert.deepEqual(readdirSync(join(root,'photos')),[]);
 await gateway.disable();info=await gateway.enable({port:0,host:'127.0.0.1'});base=`http://127.0.0.1:${info.port}/api/mobile/v1`;device=await pair();
 const headers={authorization:`Bearer ${device.token}`,'content-type':'application/json'};
 let r=await fetch(base+'/photo-sessions',{method:'POST',headers,body:'{"name":"kept"}'});const session=await r.json();
 const pending=fetch(`${base}/photo-sessions/${session.id}/files`,{method:'POST',headers,body:'{"name":"late.jpg","bytes":123}'});
 await waiting;gateway.revoke(device.deviceId);resume();assert.equal((await pending).status,401);
 assert.deepEqual(JSON.parse(readFileSync(join(root,'photos',session.id,'session.json'),'utf8')).files,[]);
 assert.deepEqual(readdirSync(join(root,'photos',session.id,'ready')),[]);
});
