import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createCaptureAnalysis} from './lib/capture-analysis.mjs';
import {acquireCompute,computeOwner} from './lib/compute-slot.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(10);}assert.fail('analysis did not settle');}
function fixture(t,run){const root=mkdtempSync(join(tmpdir(),'capture-analysis-')),id=randomUUID();mkdirSync(join(root,id,'ready'),{recursive:true});let now=1700000000000;let blocked=false;
 const manager=createCaptureAnalysis({root,run,clock:()=>now,busy:()=>blocked});t.after(async()=>{await manager.close();rmSync(root,{recursive:true,force:true});});
 const files=[];function append(n){for(let i=0;i<n;i++){const id=randomUUID();const data=Buffer.from(String(files.length));const entry={id,path:join(root,fixtureId,'ready',id+'.jpg'),sha256:createHash('sha256').update(data).digest('hex'),width:1600,height:1200};writeFileSync(entry.path,data);files.push(entry);}return files.slice();}const fixtureId=id;
 return {root,id,manager,files,append,request:(force=false)=>manager.request({id,deviceId:'device',files:files.slice(),check:()=>{},force}),tick:()=>now+=15000,block:v=>blocked=v};}
const mapFor=request=>({cameras:[],points:[],unlocalized:request.files.map(f=>f.id),processedFileIds:request.files.map(f=>f.id),suspectedDuplicates:[]});

test('starts at 20 unique images, preserves private snapshots, and publishes no paths',async t=>{let snapshot;const f=fixture(t,async({request})=>{snapshot=request;return mapFor(request);});f.append(19);assert.equal(f.request().status,'idle');f.append(1);f.request();await until(()=>f.manager.status(f.id).status==='ready');assert.equal(f.manager.status(f.id).processedCount,20);assert.notEqual(snapshot.files[0].path,f.files[0].path);assert.equal(readFileSync(snapshot.files[0].path,'utf8'),'0');assert.equal(JSON.stringify(f.manager.map(f.id)).includes(f.root),false);assert.equal(JSON.stringify(f.manager.status(f.id)).includes(f.root),false);});

test('coalesces appends, requires 12 new images and 15 seconds, force only bypasses image threshold',async t=>{const runs=[];const f=fixture(t,async({request})=>{runs.push(request.files.length);return mapFor(request);});f.append(20);f.request();await until(()=>f.manager.status(f.id).status==='ready');f.append(11);f.tick();assert.equal(f.request().status,'ready');f.append(1);f.request();await until(()=>runs.length===2&&f.manager.status(f.id).status==='ready');f.append(1);assert.equal(f.request(true).status,'waiting');await sleep(40);assert.deepEqual(runs,[20,32]);f.append(2);f.request(true);f.tick();await until(()=>runs.length===3&&f.manager.status(f.id).status==='ready');assert.deepEqual(runs,[20,32,35]);});

test('waits for reconstruction compute slot and injected busy guard',async t=>{const f=fixture(t,async({request})=>mapFor(request));f.append(20);const release=acquireCompute({kind:'reconstruction',id:'test-training'});assert.ok(release);f.request();assert.equal(f.manager.status(f.id).status,'waiting');await sleep(40);assert.equal(f.manager.status(f.id).processedCount,0);f.block(true);release();await sleep(300);assert.equal(f.manager.status(f.id).processedCount,0);f.block(false);await until(()=>f.manager.status(f.id).status==='ready');});

test('cancel waits for child completion, rejects stale publication, and invalidation clears only analysis',async t=>{let finish;let started=false;const f=fixture(t,async({request,signal})=>{started=true;await new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>setTimeout(resolve,30),{once:true});});return mapFor(request);});f.append(20);f.request();await until(()=>started);let cancelled=false;const pending=f.manager.cancel(f.id,{invalidate:true}).then(()=>cancelled=true);assert.equal(cancelled,false);await pending;assert.equal(f.manager.map(f.id),null);assert.equal(existsSync(join(f.root,f.id,'analysis')),false);assert.equal(existsSync(f.files[0].path),true);assert.equal(f.manager.status(f.id).status,'cancelled');finish();});

test('authorization change rejects publication and sanitizes child errors',async t=>{let valid=true,finish;const f=fixture(t,async({request})=>{await new Promise(r=>finish=r);return mapFor(request);});f.append(20);f.manager.request({id:f.id,deviceId:'d',files:f.files,check:()=>{if(!valid)throw new Error('secret '+f.root);}});await until(()=>finish);valid=false;finish();await until(()=>['failed','cancelled'].includes(f.manager.status(f.id).status));assert.equal(f.manager.map(f.id),null);assert.equal(JSON.stringify(f.manager.status(f.id)).includes(f.root),false);});

test('restart marks interrupted task failed and keeps last successful map',async t=>{const f=fixture(t,async({request})=>mapFor(request));f.append(20);f.request();await until(()=>f.manager.status(f.id).status==='ready');await f.manager.close();const statePath=join(f.root,f.id,'analysis','status.json'),state=JSON.parse(readFileSync(statePath));state.status='running';writeFileSync(statePath,JSON.stringify(state));const second=createCaptureAnalysis({root:f.root});t.after(()=>second.close());assert.equal(second.status(f.id).status,'failed');assert.equal(second.map(f.id).processedFileIds.length,20);assert.throws(()=>second.status('../escape'));});

test('close does not recreate a deleted batch and manager remains usable after close',async t=>{const f=fixture(t,async({request})=>mapFor(request));f.append(20);f.request();await until(()=>f.manager.status(f.id).status==='ready');await f.manager.close();f.append(12);f.tick();f.request();await until(()=>f.manager.status(f.id).processedCount===32);await f.manager.cancel(f.id);rmSync(join(f.root,f.id),{recursive:true,force:true});await f.manager.close();assert.equal(existsSync(join(f.root,f.id)),false);});

test('cancelling prevents requests from starting another child during deletion',async t=>{let started=false;const f=fixture(t,async({request,signal})=>{started=true;await new Promise(r=>signal.addEventListener('abort',()=>setTimeout(r,30),{once:true}));return mapFor(request);});f.append(20);f.request();await until(()=>started);const cancelled=f.manager.cancel(f.id,{invalidate:true});assert.throws(()=>f.request(),{code:409});await cancelled;assert.equal(f.manager.map(f.id),null);});

test('timeout reports its reason and retains the preceding valid map',async t=>{
 let calls=0,started=false;const f=fixture(t,async({request,signal})=>{if(++calls>1){started=true;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}return mapFor(request);});
 f.append(20);f.request();await until(()=>f.manager.status(f.id).status==='ready');const previous=f.manager.map(f.id);f.append(12);f.tick();
 t.mock.timers.enable({apis:['setTimeout']});f.request();const deadline=Date.now()+3000;
 while(!started){assert.ok(Date.now()<deadline,'second child did not start');await new Promise(setImmediate);}
 t.mock.timers.tick(120000);t.mock.timers.reset();await until(()=>['cancelled','failed'].includes(f.manager.status(f.id).status));
 assert.equal(f.manager.status(f.id).status,'failed');assert.match(f.manager.status(f.id).error,/超时/);assert.deepEqual(f.manager.map(f.id),previous);assert.equal(computeOwner(),null);
});
