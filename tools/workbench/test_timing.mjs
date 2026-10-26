import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as projects from './lib/projects.mjs';
import * as timers from './lib/timing.mjs';
import * as jobs from './lib/jobs.mjs';
import { buildSteps, dirs } from './lib/pipeline.mjs';
import { createAttempt } from './lib/attempts.mjs';
const { summarise } = projects;

const at = seconds => new Date(Date.UTC(2026, 9, 26) + seconds * 1000).toISOString();
const project = steps => ({id:'test-timing-summary',name:'Timing',state:'partial',trainingPreset:'full',steps});

test('project API includes recorded stage time and a total without counting the gap between stages', () => {
  const result = summarise(project([
    {id:'prepare',name:'照片预处理',status:'success',startedAt:at(0),endedAt:at(10)},
    {id:'features',name:'特征提取',status:'success',startedAt:at(100),endedAt:at(125)},
    {id:'match',name:'特征匹配',status:'pending'},
  ]), Date.parse(at(1000)));
  assert.equal(result.steps[0].timing?.elapsedMs, 10_000);
  assert.equal(result.steps[1].timing?.elapsedMs, 25_000);
  assert.equal(result.timing?.elapsedMs, 35_000);
  assert.equal(result.timing.complete, false, 'old timestamps cannot prove historical retry duration');
});

test('project API samples the active stage at the same instant as total timing', () => {
  const result = summarise({...project([
    {id:'prepare',status:'success',timing:{elapsedMs:10_000,runningSince:null,complete:true}},
    {id:'features',status:'running',timing:{elapsedMs:5_000,runningSince:at(100),complete:true}},
  ]),state:'running'}, Date.parse(at(120)));
  assert.equal(result.steps[1].timing?.elapsedMs, 25_000);
  assert.equal(result.timing?.elapsedMs, 35_000);
  assert.equal(result.timing.running, true);
  assert.equal(result.timing.complete, true);
  assert.equal(result.timing.asOf, Date.parse(at(120)));
});

test('missing historical timestamps remain unknown instead of showing a zero second rebuild', () => {
  const result = summarise(project([{id:'prepare',status:'success'},{id:'features',status:'pending'}]));
  assert.equal(result.steps[0].timing?.elapsedMs, null);
  assert.equal(result.timing?.elapsedMs, null);
  assert.equal(result.timing.complete, false);
});

test('retry accumulates executed time and leaves time waiting for input out of the total', () => {
  assert.equal(typeof timers.beginStepTiming, 'function');
  const step = {id:'sparse',status:'pending'};
  timers.beginStepTiming(step, Date.parse(at(0)));step.status='running';
  timers.endStepTiming(step, Date.parse(at(10)));step.status='needs_input';
  assert.equal(timers.stepTiming(step, Date.parse(at(1000))).elapsedMs, 10_000);
  timers.beginStepTiming(step, Date.parse(at(1000)));step.status='running';
  assert.equal(timers.stepTiming(step, Date.parse(at(1005))).elapsedMs, 15_000);
  timers.endStepTiming(step, Date.parse(at(1020)));step.status='success';
  timers.endStepTiming(step, Date.parse(at(2000)));
  assert.equal(timers.stepTiming(step, Date.parse(at(3000))).elapsedMs, 30_000);
  assert.equal(timers.stepTiming(step).complete, true);
});

test('retry preserves available legacy timing without claiming lost history is known', () => {
  assert.equal(typeof timers.beginStepTiming, 'function');
  const step = {id:'match',status:'failed',startedAt:at(0),endedAt:at(12)};
  timers.beginStepTiming(step, Date.parse(at(100)));step.status='running';
  timers.endStepTiming(step, Date.parse(at(108)));step.status='success';
  assert.equal(timers.stepTiming(step).elapsedMs, 20_000);
  assert.equal(timers.stepTiming(step).complete, false);
});

function fixture(t, stepOverrides = {}) {
  const id = `test-timing-${randomBytes(5).toString('hex')}`;
  const p = {...project(buildSteps().map((s,i) => ({id:s.id,name:s.name,status:i<2?'success':'pending',
    ...(stepOverrides[s.id]??{})}))),id,mapper:'global',featurePreset:'standard',cameraModel:'SIMPLE_RADIAL'};
  const d = dirs(p);mkdirSync(d.root,{recursive:true});projects.write(p);
  t.after(async () => {
    const job = jobs.current(id);
    if(job){await jobs.abort(id);await job.done;}
    assert.ok(d.root.startsWith(resolve('projects') + '\\'));
    rmSync(d.root,{recursive:true,force:true});
  });
  const runtime = {
    prepareAutomaticAttempt:async (p,from,{onAttempt}) => {
      const attempt=createAttempt(p,{kind:'automatic',inputRevision:null,inputFingerprint:null});
      onAttempt(attempt);return {attempt,project:{...p,activeAttemptId:attempt.id}};
    },
    commandForStep:() => ({cmd:process.execPath,args:['-e','setTimeout(()=>{},50)']}),
  };
  return {p,runtime};
}

test('changing feature settings retains timing when downstream timestamps are cleared', t => {
  const {p} = fixture(t,{features:{status:'success',startedAt:at(0),endedAt:at(12)}});
  projects.update(p.id,{featurePreset:'enhanced'});
  const updated = projects.read(p.id);
  assert.equal(updated.steps[1].status,'pending');
  assert.equal(summarise(updated).steps[1].timing.elapsedMs,12_000);
});

test('restart freezes an interrupted timer at the last saved activity instead of counting downtime', t => {
  const {p} = fixture(t,{match:{status:'running',startedAt:at(0),timing:{elapsedMs:5_000,runningSince:at(0),complete:true}}});
  writeFileSync(projects.projectPath(p.id),JSON.stringify({...p,state:'running',updatedAt:at(30)}));
  projects.reconcileProject(p.id);
  const result = summarise(projects.read(p.id));
  assert.equal(result.state,'aborted');
  assert.equal(result.steps[2].timing.elapsedMs,35_000);
  assert.equal(result.steps[2].timing.running,false);
  assert.equal(result.steps[2].timing.complete,false);
});

test('the job runner adds retry time to the persisted accumulator and closes it on completion', async t => {
  const {p,runtime} = fixture(t,{match:{status:'failed',timing:{elapsedMs:12_000,runningSince:null,complete:true}}});
  await jobs.start(p.id,{fromStep:'match',untilStep:'match'},runtime).done;
  const saved = projects.read(p.id),timing = summarise(saved).steps[2].timing;
  assert.equal(saved.steps[2].status,'success');
  assert.ok(timing.elapsedMs >= 12_050);
  assert.equal(saved.steps[2].timing.runningSince,null);
  assert.equal(timing.running,false);
});

test('an exception after stage start freezes the failed timer', async t => {
  const {p,runtime} = fixture(t);
  runtime.commandForStep=()=>{throw new Error('timing-command-fixture');};
  await jobs.start(p.id,{fromStep:'match',untilStep:'match'},runtime).done;
  const saved = projects.read(p.id);
  assert.equal(saved.steps[2].status,'failed');
  assert.equal(saved.steps[2].timing?.runningSince,null);
  assert.equal(summarise(saved).steps[2].timing.running,false);
});

test('timing starts while the job prepares its isolated inputs', async t => {
  const {p,runtime} = fixture(t);
  let entered, release;
  const ready=new Promise(resolve=>entered=resolve), hold=new Promise(resolve=>release=resolve);
  const prepare=runtime.prepareAutomaticAttempt;
  runtime.prepareAutomaticAttempt=async (...args)=>{entered();await hold;return prepare(...args);};
  const job=jobs.start(p.id,{fromStep:'match',untilStep:'match'},runtime);
  await ready;
  try {
    const result=summarise(jobs.liveProject(p.id));
    assert.equal(result.steps[2].timing.running,true);
    assert.equal(result.timing.running,true);
    assert.equal(result.currentStep,'match');
  } finally {release();await job.done;}
});

test('a failure while preparing inputs closes the already started timer', async t => {
  const {p,runtime}=fixture(t);
  runtime.prepareAutomaticAttempt=async()=>{throw new Error('timing-preparation-fixture');};
  await jobs.start(p.id,{fromStep:'match',untilStep:'match'},runtime).done;
  const result=summarise(projects.read(p.id));
  assert.equal(result.steps[2].status,'failed');
  assert.ok(result.steps[2].timing.elapsedMs>=0);
  assert.equal(result.steps[2].timing.running,false);
});

test('a nonzero child exit closes the failed stage without advancing pending stages', async t => {
  const {p,runtime}=fixture(t);
  runtime.commandForStep=()=>({cmd:process.execPath,args:['-e','process.exit(2)']});
  await jobs.start(p.id,{fromStep:'match',untilStep:'match'},runtime).done;
  const saved=projects.read(p.id),result=summarise(saved,Date.now()+86_400_000);
  assert.equal(saved.state,'failed');
  assert.equal(result.steps[2].timing.running,false);
  assert.ok(result.steps[2].timing.elapsedMs>=0);
  assert.equal(result.steps[3].timing.elapsedMs,null);
});
