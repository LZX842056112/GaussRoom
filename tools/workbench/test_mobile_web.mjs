import test from 'node:test';
import assert from 'node:assert/strict';
import * as state from './public/mobile/state.mjs';
test('commit requires two ready photos and no unfinished files', () => {
  assert.equal(state.canCommit?.({status:'open',uniqueCount:2,files:[{status:'ready'},{status:'duplicate'}]}, 0), true);
  assert.equal(state.canCommit?.({status:'open',uniqueCount:2,files:[{status:'failed'}]}, 0), false);
  assert.equal(state.canCommit?.({status:'open',uniqueCount:2,files:[]}, 1), false);
});
test('reload needs reselection for unfinished files only', () => {
  assert.deepEqual(state.needsReselect?.([{id:'a',status:'ready'},{id:'b',status:'failed'},{id:'c',status:'pending'}], new Map()), ['b','c']);
});
test('timing distinguishes missing and incomplete data', () => {
  assert.equal(state.timingLabel?.(null, 1000), '暂无记录');
  assert.match(state.timingLabel?.({elapsedMs:2000,complete:false},1000), /不完整/);
});
test('upload progress shows transferred bytes and all completed photos', () => {
  assert.equal(state.uploadLabel?.({loaded:1024,total:2048},[{status:'ready'},{status:'duplicate'},{status:'failed'}]), '上传中：1.0 KiB / 2.0 KiB · 已完成 2 / 3 张');
});
test('poll retry stays active only for running jobs and current generation', () => {
  assert.equal(state.shouldPoll?.({state:'running'}, 4, 4), true);
  assert.equal(state.shouldPoll?.({state:'aborting'}, 4, 5), false);
  assert.equal(state.shouldPoll?.({state:'success'}, 4, 4), false);
});
test('committing batch can retry creation only when all photos are ready', () => {
  const batch={status:'committing',uniqueCount:2,files:[{status:'ready'},{status:'ready'}]};
  assert.equal(state.canCommit(batch,0),true);
  assert.equal(state.canCommit({...batch,files:[...batch.files,{status:'failed'}]},0),false);
  assert.equal(state.canCommit(batch,1),false);
  assert.equal(state.canCommit({...batch,uniqueCount:1},0),false);
});

test('large photo batches have a bounded preview and twelve-item pages without losing files',()=>{
  const files=Array.from({length:500},(_,i)=>({id:String(i),status:'ready'}));
  const preview=state.photoView(files,{});assert.equal(preview.items.length,6);assert.equal(preview.count,500);
  const first=state.photoView(files,{expanded:true,page:0}),last=state.photoView(files,{expanded:true,page:99});
  assert.equal(first.items.length,12);assert.equal(last.page,41);assert.equal(last.items.length,8);
  assert.equal(files.length,500);
});
test('photo preview surfaces active and failed uploads, filters remain complete, and paging clamps after removal',()=>{
  const files=Array.from({length:30},(_,i)=>({id:String(i),status:i===28?'failed':i===29?'pending':'ready'}));
  const preview=state.photoView(files,{activeId:'29'});assert.equal(preview.items[0].id,'29');assert.ok(preview.items.some(f=>f.id==='28'));
  assert.deepEqual(state.photoView(files,{filter:'issues'}).items.map(f=>f.id),['28','29']);
  assert.equal(state.photoView(files,{filter:'complete'}).count,28);
  assert.equal(state.photoView(files.slice(0,12),{expanded:true,page:2}).page,0);
  assert.equal(state.photoView([],{expanded:true,page:3}).page,0);
  assert.equal(state.canCommit({status:'open',uniqueCount:28,files}),false);
});

test('whole-project deletion requires confirmation and clears saved UI state only after success',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
 const remove=source.slice(source.indexOf('async function deleteBatch(){'),source.indexOf('\nasync function getSessions()'));
 for(const mode of ['cancel','success','busy','retry']){
  let requests=0;const removed=[],controls=new Map();const context=vm.createContext({encodeURIComponent,Option:function(){},window:{confirm:()=>assert.fail('must use page confirmation')},confirmDeletion:async target=>{assert.equal(target.name,'Test');return mode!=='cancel';},localStorage:{removeItem:key=>removed.push(key)},$:id=>{if(!controls.has(id))controls.set(id,{value:'old',open:false,replaceChildren(){}});return controls.get(id);},render(){},say(){},stopPoll(){},resetPhotoView(){},getSessions:async()=>{},refreshBatch:async()=>{if(mode==='retry')vm.runInContext("batch.status='deleting'",context);},api:async(path,options)=>{requests++;assert.equal(path,'/photo-sessions/b');assert.equal(options.method,'DELETE');if(['busy','retry'].includes(mode))throw Object.assign(new Error(mode),{status:mode==='busy'?409:503});}});
  vm.runInContext(`let batch={id:'b',name:'Test',projectId:'p'},project={id:'p'},queue=[1],local=new Map([['x',1]]),thumbs=new Map(),thumbQueue=[],thumbGeneration=0,uploadProgress=null;${remove}`,context);
  if(['busy','retry'].includes(mode))await assert.rejects(vm.runInContext('deleteBatch()',context));else await vm.runInContext('deleteBatch()',context);
  assert.equal(requests,mode==='cancel'?0:1);
  assert.equal(vm.runInContext('batch===null',context),mode==='success');
  assert.equal(vm.runInContext('project===null',context),['success','retry'].includes(mode));
  if(mode==='success'){assert.deepEqual(removed,['gr.mobile.queue.b','gr.mobile.batch']);assert.equal(vm.runInContext('queue.length+local.size',context),0);}else assert.equal(removed.length,0);
 }
});

test('failed first project GET retries for both idle and missing prior state without another run', async () => {
  const {readFile} = await import('node:fs/promises');
  const vm = await import('node:vm');
  const source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
  const load=source.slice(source.indexOf('async function loadProject(){'),source.indexOf('\nasync function init()'));
  const run=source.match(/\$\('run'\)\.onclick=(.*);\r?\nwindow\.addEventListener/)[1];
  for(const initial of [null,{id:'p',state:'idle'}]){
    let gets=0,posts=0;const timers=[];const button={};
    const context=vm.createContext({AbortController,encodeURIComponent,shouldPoll:state.shouldPoll,clearTimeout(){},setTimeout(fn,ms){assert.equal(ms,2000);timers.push(fn);return 1;},
      api:async(path,opts)=>{if(opts?.method==='POST'){posts++;return {};}gets++;if(gets===1)throw new Error('offline');return {id:'p',state:'running'};},
      render(){},say(){},action:fn=>fn(),$:()=>button});
    vm.runInContext(`let batch={projectId:'p',trainingPreset:'standard'}, project=${JSON.stringify(initial)},pollGeneration=0,pollTimer=null,pollAbort=null;${load}\n$('run').onclick=${run};`,context);
    if(initial)await button.onclick();else await vm.runInContext('loadProject()',context);
    assert.equal(timers.length,1,`retry missing after GET failure with ${initial?'idle':'no prior state'}`);
    await timers.shift()();
    assert.equal(vm.runInContext('project.state',context),'running');
    assert.equal(posts,initial?1:0);
    assert.equal(gets,2);
  }
});

test('project polling stops on 401, 404, abort, stale batch, and successful terminal state', async () => {
  const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
  const source=await readFile(new URL('./public/mobile/app.js',import.meta.url),'utf8');
  const load=source.slice(source.indexOf('async function loadProject(){'),source.indexOf('\nasync function init()'));
  for(const kind of ['401','404','abort','stale','terminal']){
    const timers=[];let context;
    context=vm.createContext({AbortController,encodeURIComponent,shouldPoll:state.shouldPoll,clearTimeout(){},setTimeout(fn){timers.push(fn);},render(){},say(){},api:async()=>{
      if(kind==='terminal')return {state:'success'};
      if(kind==='stale'){vm.runInContext('pollGeneration++',context);throw new Error('offline');}
      const e=new Error(kind);if(kind==='abort')e.name='AbortError';else e.status=Number(kind);throw e;
    }});
    vm.runInContext(`let batch={projectId:'p'},project={state:'running'},pollGeneration=0,pollTimer=null,pollAbort=null;${load}`,context);
    await vm.runInContext('loadProject()',context);
    assert.equal(timers.length,0,kind);
  }
});
