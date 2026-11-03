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
