import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createPhotoSessions } from './lib/photo-sessions.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t, extra={}) {
 const root=mkdtempSync(join(tmpdir(),'photo-sessions-')), projects=join(root,'projects'), state=join(root,'state'); mkdirSync(projects);
 const store={projectPath:id=>join(projects,id,'project.json'), read(id){return JSON.parse(readFileSync(this.projectPath(id)));}, write(p){writeFileSync(this.projectPath(p.id),JSON.stringify(p)); return p;}, remove(id){const path=dirname(this.projectPath(id));assert.equal(dirname(path),projects);rmSync(path,{recursive:true,force:true});},create(data,{id}) {const d=dirname(this.projectPath(id)); if(existsSync(d)) throw Object.assign(new Error('exists'),{code:409}); mkdirSync(d); return this.write({id,...data});}};
 let active=true; const grants=[];
 const opts={root:state,projectStore:store,getCapabilities:async()=>({photoFormats:['.jpg','.jpeg','.png']}),validatePhoto:async p=>{const b=readFileSync(p);return {extension:'.jpg',format:'JPEG',width:1200,height:800,bytes:b.length,sha256:hash(b)};},grantProject:(d,p)=>grants.push([d,p]),isDeviceActive:()=>active,limits:{maxFileBytes:10,maxBatchBytes:25,maxFiles:4},...extra};
 let service=createPhotoSessions(opts);
 const server=createServer(async(req,res)=>{try {await service.handle(req,res,new URL(req.url,'http://localhost').pathname,req.headers.device||'a',()=>{if(!active)throw Object.assign(new Error('revoked'),{code:401});});}catch(e){if(!res.destroyed){res.writeHead(Number.isInteger(e.code)?e.code:500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}}});
 t.after(()=>{server.close();rmSync(root,{recursive:true,force:true});});
 return {root,state,store,grants,opts,server,restart(){service=createPhotoSessions(opts);},revoke(){active=false;},service:()=>service};
}
async function start(f) {await new Promise(ok=>f.server.listen(0,'127.0.0.1',ok)); return `http://127.0.0.1:${f.server.address().port}/api/mobile/v1/photo-sessions`;}
async function call(url,method='GET',body,device='a') {const binary=Buffer.isBuffer(body); const r=await fetch(url,{method,headers:{device,...(body!==undefined&&!binary?{'content-type':'application/json'}:{})},body:body===undefined?undefined:binary?body:JSON.stringify(body)});return [r.status,await r.json()];}
async function add(url,name,bytes) {const [,b]=await call(url+'/files','POST',{name,bytes}); return b.fileId;}

test('client capture IDs survive lost registration replies without reserving another file',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'camera'}))[1],url=base+'/'+s.id;
 const clientCaptureId='22ee18c0-e8cd-45c2-876d-c8f891824b35',body={name:'camera.jpg',bytes:3,clientCaptureId};
 const first=await call(url+'/files','POST',body);assert.equal(first[0],200);
 const again=await call(url+'/files','POST',body);assert.equal(again[0],200);assert.equal(again[1].fileId,first[1].fileId);assert.equal(again[1].session.files.length,1);
 assert.equal(again[1].session.files[0].clientCaptureId,clientCaptureId);
 assert.equal((await call(url+'/files','POST',{...body,bytes:4}))[0],409);
 assert.equal((await call(url+'/files','POST',{...body,clientCaptureId:'../bad'}))[0],400);
 await call(url+'/files/'+first[1].fileId,'PUT',Buffer.from('abc'));f.restart();
 const restored=await call(url+'/files','POST',body);assert.equal(restored[1].fileId,first[1].fileId);assert.equal(restored[1].session.files[0].status,'ready');
});

test('only an active owner can delete an open batch and its uploaded files',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'delete batch'}))[1],url=base+'/'+s.id;
 const id=await add(url,'a.jpg',3);await call(url+'/files/'+id,'PUT',Buffer.from('abc'));
 assert.equal((await call(url,'DELETE',undefined,'b'))[0],404);assert.equal(existsSync(join(f.state,s.id,'ready',id+'.jpg')),true);
 assert.equal((await call(url,'DELETE'))[0],200);assert.equal(existsSync(join(f.state,s.id)),false);assert.deepEqual((await call(base))[1],[]);f.restart();assert.equal((await call(url))[0],404);
 const denied=(await call(base,'POST',{name:'revoked'}))[1];f.revoke();assert.equal((await call(base+'/'+denied.id,'DELETE'))[0],401);assert.equal(existsSync(join(f.state,denied.id)),true);
});

test('project deletion rejects active work, preserves other projects and completes after a restart retry',async t=>{
 let running=true;const revoked=[];const f=fixture(t,{jobStore:{current:()=>running?{}:null},revokeProject:(device,id)=>revoked.push([device,id])}),base=await start(f),s=(await call(base,'POST',{name:'delete project'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3);await call(url+'/files/'+a,'PUT',Buffer.from('abc'));await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const p=(await call(url+'/commit','POST'))[1].projectId;const unrelated=join(f.root,'projects','unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'keep'),'keep');
 assert.equal((await call(url,'DELETE'))[0],409);assert.equal(existsSync(f.store.projectPath(p)),true);running=false;
 const remove=f.store.remove;f.store.remove=()=>{throw new Error('locked private path '+f.root);};const failed=await call(url,'DELETE');assert.equal(failed[0],503);assert.equal(JSON.stringify(failed[1]).includes(f.root),false);assert.equal((await call(url))[1].status,'deleting');
 const grants=f.grants.length;f.restart();assert.equal(f.grants.length,grants);f.store.remove=remove;
 assert.equal((await call(url,'DELETE'))[0],200);assert.equal(existsSync(f.store.projectPath(p)),false);assert.equal(existsSync(join(f.state,s.id)),false);assert.deepEqual(revoked,[['a',p]]);assert.equal(readFileSync(join(unrelated,'keep'),'utf8'),'keep');
});

test('batch deletion refuses an unrelated project association',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'protected'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3);await call(url+'/files/'+a,'PUT',Buffer.from('abc'));await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const p=f.store.read((await call(url+'/commit','POST'))[1].projectId);f.store.write({...p,photoSessionId:'other-session',sourceDir:join(f.root,'elsewhere')});
 assert.equal((await call(url,'DELETE'))[0],409);assert.equal(existsSync(f.store.projectPath(p.id)),true);assert.equal((await call(url))[1].status,'committed');
});

test('retrying deletion removes project output even after project metadata was removed',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'partial delete'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3);await call(url+'/files/'+a,'PUT',Buffer.from('abc'));await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const p=(await call(url+'/commit','POST'))[1].projectId,folder=dirname(f.store.projectPath(p));writeFileSync(join(folder,'output.ply'),'remaining');
 const remove=f.store.remove;let calls=0;f.store.remove=function(id,options){calls++;if(calls===1){rmSync(this.projectPath(id));throw Error('locked output');}return remove.call(this,id,options);};
 assert.equal((await call(url,'DELETE'))[0],503);f.restart();assert.equal((await call(url,'DELETE'))[0],200);assert.equal(calls,2);assert.equal(existsSync(folder),false);
});

test('ownership, limits, duplicate content, restart and idempotent commit',async t=>{
 const f=fixture(t), base=await start(f); let [status,s]=await call(base,'POST',{name:'batch'}); assert.equal(status,200); const url=base+'/'+s.id;
 assert.equal((await call(url,'GET',undefined,'b'))[0],404);
 assert.equal((await call(url+'/files','POST',{name:'x.jpg',bytes:11}))[0],413);
 const a=await add(url,'same.jpg',3), b=await add(url,'same.jpg',3), c=await add(url,'other.jpg',3);
 assert.equal((await call(url+'/files/'+a,'PUT',Buffer.from('abc')))[1].files[0].status,'ready');
 assert.equal((await call(url+'/files/'+b,'PUT',Buffer.from('abc')))[1].files[1].duplicateOf,a);
 assert.equal((await call(url+'/commit','POST'))[0],409);
 await call(url+'/files/'+c,'PUT',Buffer.from('xyz')); f.restart();
 assert.equal((await call(url))[1].uniqueCount,2);
 const [code,result]=await call(url+'/commit','POST'); assert.equal(code,200); assert.deepEqual((await call(url+'/commit','POST'))[1],result);
 assert.equal(f.store.read(result.projectId).inputKind,'photos'); assert.equal(f.service().ownsProject(result.projectId),true);
});

test('failed upload can be retried and tampering prevents commit',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3), b=await add(url,'b.jpg',3);
 assert.equal((await call(url+'/files/'+a,'PUT',Buffer.from('a')))[0],400);
 assert.equal((await call(url))[1].files[0].status,'failed');
 await call(url+'/files/'+a,'PUT',Buffer.from('abc')); await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 writeFileSync(join(f.state,s.id,'ready',a+'.jpg'),'bad'); assert.equal((await call(url+'/commit','POST'))[0],409);
});

test('revocation during validation prevents publication',async t=>{
 let resume,entered; const waiting=new Promise(ok=>entered=ok), gate=new Promise(ok=>resume=ok);
 const f=fixture(t,{validatePhoto:async p=>{entered();await gate; const b=readFileSync(p);return {extension:'.jpg',width:1200,height:800,bytes:b.length,sha256:hash(b)};}}),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3), pending=call(url+'/files/'+a,'PUT',Buffer.from('abc')); await waiting; f.revoke(); resume(); assert.equal((await pending)[0],401); assert.equal(f.grants.length,0);
});

test('interrupted uploading state is retryable after restart',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id,id=await add(url,'a.jpg',3);
 const path=join(f.state,s.id,'session.json'), part=join(f.state,s.id,id+'.part'), data=JSON.parse(readFileSync(path)); data.files[0].status='uploading'; writeFileSync(path,JSON.stringify(data)); writeFileSync(part,'ab'); f.restart();
 assert.equal((await call(url))[1].files[0].status,'failed'); assert.equal(existsSync(part),false); assert.equal((await call(url+'/files/'+id,'PUT',Buffer.from('abc')))[1].files[0].status,'ready');
});

test('deleting a file removes only its remaining partial upload',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id,id=await add(url,'a.jpg',3),other=await add(url,'b.jpg',3);
 const part=join(f.state,s.id,id+'.part'),keep=join(f.state,s.id,other+'.part'); writeFileSync(part,'ab'); writeFileSync(keep,'other');
 assert.equal((await call(url+'/files/'+id,'DELETE'))[0],200); assert.equal(existsSync(part),false); assert.equal(readFileSync(keep,'utf8'),'other');
});

test('recovers journal after project creation and does not grant a revoked device',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3); await call(url+'/files/'+a,'PUT',Buffer.from('abc'));await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const original=f.store.write; let fail=true; f.store.write=function(p){if(p.photoSessionId && fail){fail=false;throw new Error('simulated crash');}return original.call(this,p);};
 assert.equal((await call(url+'/commit','POST'))[0],500); f.revoke(); f.restart();
 const recovered=(await call(url))[1]; assert.equal(recovered.status,'committed'); assert.equal(f.store.read(recovered.projectId).photoSessionId,s.id); assert.equal(f.grants.length,0);
});

test('batch byte and file count reservations include duplicate files',async t=>{
 const f=fixture(t,{limits:{maxFileBytes:10,maxBatchBytes:6,maxFiles:2}}),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 await add(url,'a.jpg',3); await add(url,'b.jpg',3); assert.equal((await call(url+'/files','POST',{name:'c.jpg',bytes:1}))[0],413);
 const other=(await call(base,'POST',{name:'other'}))[1], u=base+'/'+other.id; await add(u,'a.jpg',4); assert.equal((await call(u+'/files','POST',{name:'b.jpg',bytes:3}))[0],413);
});

test('journal written before project creation is retryable after restart',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3); await call(url+'/files/'+a,'PUT',Buffer.from('abc')); await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const create=f.store.create; f.store.create=()=>{throw new Error('simulated crash');}; assert.equal((await call(url+'/commit','POST'))[0],500); f.store.create=create; f.restart();
 assert.equal((await call(url))[1].status,'open'); assert.equal((await call(url+'/commit','POST'))[0],200);
});

test('commit retries in the same process after project creation and metadata failures',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3); await call(url+'/files/'+a,'PUT',Buffer.from('abc')); await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const create=f.store.create; f.store.create=()=>{throw new Error('create failure');}; assert.equal((await call(url+'/commit','POST'))[0],500); f.store.create=create;
 const write=f.store.write; let failure=true; f.store.write=function(p){if(p.photoSessionId&&failure){failure=false;throw new Error('write failure');} return write.call(this,p);};
 assert.equal((await call(url+'/commit','POST'))[0],500); const [status,result]=await call(url+'/commit','POST'); assert.equal(status,200); assert.equal(f.store.read(result.projectId).photoSessionId,s.id);
 assert.equal(existsSync(join(f.state,s.id,'ready',a+'.jpg')),false);
});

test('real TCP interruption marks file failed and allows a whole-file retry',async t=>{
 const { request }=await import('node:http'); const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id,id=await add(url,'a.jpg',6);
 await new Promise(resolve=>{const req=request(url+'/files/'+id,{method:'PUT',headers:{device:'a','content-length':'6'}},()=>{}); req.on('error',()=>resolve()); req.on('socket',()=>{req.write('abc');setTimeout(()=>req.destroy(),30);});});
 let state; for(let i=0;i<30;i++){state=(await call(url))[1].files[0].status; if(state==='failed')break; await new Promise(r=>setTimeout(r,10));} assert.equal(state,'failed');
 const [code,result]=await call(url+'/files/'+id,'PUT',Buffer.from('abcdef')); assert.equal(code,200); assert.equal(result.files[0].sha256,hash(Buffer.from('abcdef')));
});

test('revoked validation leaves file failed without publishing bytes',async t=>{
 let resume,entered; const waiting=new Promise(ok=>entered=ok), gate=new Promise(ok=>resume=ok);
 const f=fixture(t,{validatePhoto:async p=>{entered();await gate; const b=readFileSync(p);return {extension:'.jpg',width:1200,height:800,bytes:b.length,sha256:hash(b)};}}),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const id=await add(url,'a.jpg',3), pending=call(url+'/files/'+id,'PUT',Buffer.from('abc')); await waiting; f.revoke(); resume(); assert.equal((await pending)[0],401);
 assert.equal((await call(url))[1].files[0].status,'failed'); assert.equal(existsSync(join(f.state,s.id,'ready',id+'.jpg')),false);
});

test('copy failure remains retryable without touching unrelated projects',async t=>{
 const f=fixture(t),base=await start(f),s=(await call(base,'POST',{name:'batch'}))[1],url=base+'/'+s.id;
 const a=await add(url,'a.jpg',3),b=await add(url,'b.jpg',3); await call(url+'/files/'+a,'PUT',Buffer.from('abc')); await call(url+'/files/'+b,'PUT',Buffer.from('xyz'));
 const sentinel=join(f.root,'projects','unrelated'); mkdirSync(sentinel); writeFileSync(join(sentinel,'keep'),'unchanged');
 const create=f.store.create; let obstacle; f.store.create=function(data,options){const p=create.call(this,data,options); obstacle=join(dirname(this.projectPath(p.id)),'source-images',a+'.jpg'); mkdirSync(obstacle,{recursive:true}); return p;};
 const other=(await call(base,'POST',{name:'other batch'}))[1];
 assert.equal((await call(url+'/commit','POST'))[0],500); f.restart();
 assert.equal((await call(base+'/'+other.id))[1].name,'other batch'); assert.equal((await call(url))[1].status,'committing');
 assert.equal((await call(url+'/commit','POST'))[0],500); rmSync(obstacle,{recursive:true});
 assert.equal((await call(url+'/commit','POST'))[0],200); assert.equal(readFileSync(join(sentinel,'keep'),'utf8'),'unchanged');
});
