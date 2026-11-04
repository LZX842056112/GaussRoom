import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createPhotoSessions} from './lib/photo-sessions.mjs';
import {TOOLS} from './lib/paths.mjs';

async function fixture(t,extra={}){
 const root=mkdtempSync(join(tmpdir(),'photo-analysis-api-')),state=join(root,'photos'),projects=join(root,'projects');mkdirSync(projects);
 const records=new Map(),store={projectPath:id=>join(projects,id,'project.json'),read:id=>records.get(id),write:p=>{records.set(p.id,p);writeFileSync(store.projectPath(p.id),JSON.stringify(p));return p;},create:(data,{id})=>{mkdirSync(join(projects,id));return store.write({id,...data});},remove:id=>{records.delete(id);rmSync(join(projects,id),{recursive:true,force:true});}};
 let active=true;const service=createPhotoSessions({root:state,projectStore:store,grantProject:()=>{},isDeviceActive:()=>active,getCapabilities:async()=>({photoFormats:['.jpg']}),validatePhoto:async path=>{const bytes=readFileSync(path);return {width:1200,height:1000,extension:'.jpg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};},analysisRun:async({request})=>({cameras:[],points:[]}),...extra});
 const server=createServer(async(req,res)=>{try{const handled=await service.handle(req,res,new URL(req.url,'http://localhost').pathname,req.headers.device??'a',()=>{if(!active)throw Object.assign(new Error('revoked'),{code:401});});if(!handled)res.writeHead(404).end();}catch(e){res.writeHead(e.code??500,{'content-type':'application/json'}).end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/mobile/v1/photo-sessions`;
 t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});});
 const call=async(path='',method='GET',body,device='a')=>{const binary=Buffer.isBuffer(body);const r=await fetch(base+path,{method,headers:{device,...(body!==undefined&&!binary?{'content-type':'application/json'}:{})},body:body===undefined?undefined:binary?body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const s=(await call('','POST',{name:'capture'})).body;
 async function append(count){for(let i=0;i<count;i++){const bytes=Buffer.from('view-'+i),d=(await call(`/${s.id}/files`,'POST',{name:`${i}.jpg`,bytes:bytes.length})).body;assert.equal((await call(`/${s.id}/files/${d.fileId}`,'PUT',bytes)).status,200);}}
 return {root,state,s,store,service,call,append,base,revoke:async()=>{active=false;await service.cancelDevice('a');}};
}
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('analysis did not settle');}

test('analysis publishes authorized subsets and file removal invalidates all old positions',async t=>{
 let finish;const f=await fixture(t,{analysisRun:async()=>{await new Promise(r=>finish=r);return {cameras:[],points:[]};}});await f.append(20);
 const path=`/${f.s.id}`;assert.equal((await f.call(path+'/capture-analysis','POST',{action:'start'})).status,202);await until(()=>finish);
 assert.equal((await f.call(path+'/capture-map','GET',undefined,'b')).status,404);
 const extra=(await f.call(path+'/files','POST',{name:'new.jpg',bytes:3})).body;await f.call(path+'/files/'+extra.fileId,'PUT',Buffer.from('new'));
 finish();await until(async()=> (await f.call(path+'/capture-analysis')).body.status==='ready');
 const map=await f.call(path+'/capture-map');assert.equal(map.status,200);assert.equal(map.body.processedFileIds.length,20);assert.equal(JSON.stringify(map.body).includes(f.root),false);
 const file=(await f.call(path)).body.files[0];assert.equal((await f.call(path+'/files/'+file.id,'DELETE')).status,200);assert.equal((await f.call(path+'/capture-map')).status,404);
});

test('commit and revocation wait for analysis exit and prevent stale publication',async t=>{
 let entered=false;const f=await fixture(t,{analysisRun:async({signal})=>{entered=true;await new Promise(r=>signal.addEventListener('abort',()=>setTimeout(r,40),{once:true}));return {cameras:[],points:[]};}});await f.append(20);const path=`/${f.s.id}`;
 await f.call(path+'/capture-analysis','POST',{action:'start'});await until(()=>entered);
 const committed=await f.call(path+'/commit','POST');assert.equal(committed.status,200);assert.equal(f.store.read(committed.body.projectId).inputKind,'photos');assert.equal((await f.call(path+'/capture-map')).status,404);
 assert.equal((await f.call(path+'/capture-analysis','POST',{action:'cancel'})).status,200);
 assert.equal((await f.call(path+'/capture-analysis','POST',{action:'start'})).status,409);
 const g=await fixture(t,{analysisRun:async({signal})=>{entered=true;await new Promise(r=>signal.addEventListener('abort',()=>setTimeout(r,40),{once:true}));return {cameras:[],points:[]};}});entered=false;await g.append(20);await g.call(`/${g.s.id}/capture-analysis`,'POST',{action:'start'});await until(()=>entered);await g.revoke();assert.equal((await g.call(`/${g.s.id}/capture-map`)).status,401);assert.equal(existsSync(join(g.state,g.s.id,'analysis','map.json')),false);
});

test('thumbnail is a bounded JPEG and delayed authorization is checked before publication',async t=>{
 const f=await fixture(t);execFileSync(TOOLS.python,['-B','-c','from PIL import Image; import sys; Image.new("RGB",(1200,1000),"red").save(sys.argv[1])',join(f.root,'image.jpg')]);
 const bytes=readFileSync(join(f.root,'image.jpg')),path=`/${f.s.id}`,file=(await f.call(path+'/files','POST',{name:'a.jpg',bytes:bytes.length})).body.fileId;await f.call(path+'/files/'+file,'PUT',bytes);
 const url=f.base+path+'/files/'+file+'/thumbnail';const r=await fetch(url,{headers:{device:'a'}});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/jpeg/);assert.ok((await r.arrayBuffer()).byteLength<bytes.length);
 assert.equal((await fetch(url,{headers:{device:'b'}})).status,404);await f.revoke();assert.equal((await fetch(url,{headers:{device:'a'}})).status,401);
});
