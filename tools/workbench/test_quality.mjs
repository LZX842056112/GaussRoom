import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSteps, geometrySignature, readGate } from './lib/pipeline.mjs';
import { TOOLS } from './lib/paths.mjs';
import * as projects from './lib/projects.mjs';
import * as jobs from './lib/jobs.mjs';
import * as pipeline from './lib/pipeline.mjs';
import { resolve } from 'node:path';

const project = { id: 'quality-unit-test', mapper: 'global', useGpu: true, cameraModel: 'SIMPLE_RADIAL' };

test('orphan cleanup recognizes only the recorded workbench Python script', () => {
  assert.equal(typeof jobs.isOwnedProcess, 'function');
  const script = resolve('tools/workbench/py/sparse_reconstruct.py');
  assert.ok(jobs.isOwnedProcess({ childScript: script }, { name: 'python.exe', commandLine: `python.exe "${script}" --mapper global` }));
  assert.ok(!jobs.isOwnedProcess({ childScript: script }, { name: 'python.exe', commandLine: 'python.exe other.py' }));
  assert.ok(!jobs.isOwnedProcess({ childScript: resolve('other.py') }, { name: 'python.exe', commandLine: `python.exe "${resolve('other.py')}"` }));
});

test('training rejects an undistorted dataset from an older approved geometry', async () => {
  assert.equal(typeof pipeline.requireTrainingDataset, 'function');
  const fs = await import('node:fs');
  const id = 'quality-provenance-test';
  const p = { ...project, id, selectedModel: '0' };
  const d = pipeline.dirs(p);
  fs.mkdirSync(resolve(d.sparse, '0'), { recursive: true });
  fs.mkdirSync(resolve(d.undistorted, 'sparse'), { recursive: true });
  fs.mkdirSync(d.summary, { recursive: true });
  try {
    for (const name of ['cameras.bin', 'images.bin', 'points3D.bin']) {
      fs.writeFileSync(resolve(d.sparse, '0', name), name);
      fs.writeFileSync(resolve(d.undistorted, 'sparse', name), name);
    }
    const approve = () => fs.writeFileSync(resolve(d.summary, 'gate.json'), JSON.stringify({
      geometryValidationVersion: 1, geometryConnected: true, verdict: 'pass', selectedModel: '0',
      models: [{ name: '0', geometryComponentSizes: [3], geometrySignature: geometrySignature(resolve(d.sparse, '0')) }],
    }));
    approve();
    assert.throws(() => pipeline.requireTrainingDataset(p), /去畸变/);
    buildSteps().find(step => step.id === 'undistort').verify(p);
    assert.doesNotThrow(() => pipeline.requireTrainingDataset(p));
    fs.appendFileSync(resolve(d.sparse, '0/images.bin'), 'new geometry');
    approve();
    assert.throws(() => pipeline.requireTrainingDataset(p), /去畸变/);
  } finally { fs.rmSync(d.root, { recursive: true, force: true }); }
});

test('stop-before-start requests never launch training', async () => {
  const fs = await import('node:fs');
  const id = 'quality-range-test';
  const dir = resolve('projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolve(dir, 'project.json'), JSON.stringify({ ...project, id, state: 'partial',
    steps: buildSteps().map((step, index) => ({ id: step.id, status: index <= 4 ? 'success' : 'pending' })) }));
  try {
    assert.throws(() => jobs.start(id, { untilStep: 'gate' }), /结束步骤/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkpoint resume preserves exports and verifies checkpoint identity before training', async () => {
  const fs = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const p = { ...project, id: 'quality-resume-test', selectedModel: '0', trainingPreset: 'full' };
  const d = pipeline.dirs(p);
  fs.mkdirSync(resolve(d.sparse, '0'), { recursive: true });
  fs.mkdirSync(resolve(d.undistorted, 'sparse'), { recursive: true });
  fs.mkdirSync(d.summary, { recursive: true });
  try {
    for (const name of ['cameras.bin', 'images.bin', 'points3D.bin']) {
      fs.writeFileSync(resolve(d.sparse, '0', name), name);
      fs.writeFileSync(resolve(d.undistorted, 'sparse', name), name);
    }
    const signature = geometrySignature(resolve(d.sparse, '0'));
    fs.writeFileSync(resolve(d.summary, 'gate.json'), JSON.stringify({ geometryValidationVersion: 1,
      geometryConnected: true, verdict: 'pass', selectedModel: '0', models: [
        { name: '0', geometryComponentSizes: [3], geometrySignature: signature }] }));
    buildSteps().find(step => step.id === 'undistort').verify(p);
    const checkpoint = resolve(d.undistorted, 'init.ply');
    fs.writeFileSync(checkpoint, 'checkpoint');
    p.trainingResume = { step: 5000, preset: 'full', geometrySignature: signature,
      datasetSignature: JSON.parse(fs.readFileSync(resolve(d.undistorted, 'geometry-source.json'), 'utf8')).datasetSignature,
      sha256: createHash('sha256').update('checkpoint').digest('hex') };
    const train = buildSteps().find(step => step.id === 'train');
    const command = train.command(p);
    assert.equal(command.args[command.args.indexOf('--start-iter') + 1], '5000');
    assert.deepEqual(train.clean(d, p), []);
    assert.doesNotThrow(() => pipeline.requireTrainingDataset(p));
    fs.mkdirSync(d.train, { recursive: true });
    fs.writeFileSync(resolve(d.train, 'export_05000.ply'), 'retained');
    assert.equal(jobs.trainCleanWarning(p, { fromStep: 'train' }), null);
    assert.equal(jobs.trainCleanWarning(p, { fromStep: 'gate', untilStep: 'gate' }), null);
    assert.equal(jobs.trainCleanWarning(p, { fromStep: 'undistort' }).code, 'train_clean_confirmation_required');
    assert.equal(train.verify(p).ok, false, '保留的旧导出不能证明训练完成');
    fs.writeFileSync(resolve(d.train, 'export_10000.ply'), 'newer checkpoint');
    assert.throws(() => pipeline.requireTrainingDataset(p), /更新的训练结果/);
    fs.rmSync(resolve(d.train, 'export_10000.ply'));
    fs.mkdirSync(resolve(d.train, 'eval_6000'));
    assert.throws(() => pipeline.requireTrainingDataset(p), /更新的训练结果/);
    fs.rmdirSync(resolve(d.train, 'eval_6000'));
    fs.writeFileSync(checkpoint, 'wrong checkpoint');
    assert.throws(() => pipeline.requireTrainingDataset(p), /恢复检查点/);
    fs.writeFileSync(checkpoint, 'checkpoint');
    p.trainingResume.step = 30000;
    assert.throws(() => pipeline.requireTrainingDataset(p), /恢复检查点/);
    p.trainingResume.step = 5000;
    p.trainingResume.preset = 'fast';
    assert.throws(() => pipeline.requireTrainingDataset(p), /恢复检查点/);
    p.trainingResume.preset = 'full';
    p.trainingResume.geometrySignature = 'old model';
    assert.throws(() => pipeline.requireTrainingDataset(p), /恢复检查点/);
    fs.rmSync(checkpoint);
    delete p.trainingResume;
    assert.deepEqual(train.clean(d, p), [d.train]);
  } finally { fs.rmSync(d.root, { recursive: true, force: true }); }
});

test('sparse reconstruction invokes safe calibration wrapper', () => {
  const command = buildSteps().find(s => s.id === 'sparse').command(project);
  assert.equal(command.cmd, TOOLS.python);
  assert.ok(command.args.some(arg => arg.endsWith('sparse_reconstruct.py')));
  assert.equal(command.args[command.args.indexOf('--mapper') + 1], 'global');
});

test('enhanced features and guided matching are configurable', () => {
  const steps = buildSteps();
  const features = steps.find(s => s.id === 'features').command({ ...project, featurePreset: 'enhanced' });
  assert.equal(features.args[features.args.indexOf('--SiftExtraction.max_num_features') + 1], '16384');
  const match = steps.find(s => s.id === 'match').command({ ...project, featurePreset: 'enhanced' });
  assert.equal(match.args[match.args.indexOf('--FeatureMatching.guided_matching') + 1], '1');
});

test('reports without geometry validation cannot claim pass', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve('projects', project.id, 'summary');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify({ verdict: 'pass', models: [] }));
    assert.equal(readGate(project).verdict, 'unverified');
  } finally {
    fs.rmSync(path.resolve('projects', project.id), { recursive: true, force: true });
  }
});

test('manual downstream retries cannot bypass geometry validation', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve('projects', 'quality-retry-test');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...project, id: 'quality-retry-test',
      steps: buildSteps().map(s => ({ id: s.id, status: 'success' })), state: 'partial' }));
    let rejected = false;
    try { jobs.start('quality-retry-test', { fromStep: 'undistort' }); }
    catch (error) { rejected = /几何/.test(error.message); }
    if (jobs.current('quality-retry-test')) {
      await jobs.abort('quality-retry-test');
      while (jobs.current('quality-retry-test')) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(rejected, '未校验的模型不应启动去畸变或训练');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('independent component selection snapshots geometry and photos; stale reports are rejected', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const id = 'quality-component-test';
  const dir = path.resolve('projects', id);
  const modelDir = path.join(dir, 'sfm', 'sparse', '0');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'summary'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'images', 'camera-01'), { recursive: true });
  let created;
  try {
    fs.writeFileSync(path.join(modelDir, 'images.bin'), 'test image bytes');
    fs.writeFileSync(path.join(modelDir, 'points3D.bin'), 'test point bytes');
    const names = ['a.jpg', 'b.jpg', 'c.jpg'].map(name => `camera-01/${name}`);
    for (const name of names) fs.writeFileSync(path.join(dir, 'images', name), 'source photo');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ records: names.map(name => ({
      work_image: `images/${name}`, excluded: null, camera_group: 'camera-01' })) }));
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...project, id, name: 'quality-component',
      steps: [], state: 'partial', trainingPreset: 'full' }));
    fs.writeFileSync(path.join(dir, 'summary', 'gate.json'), JSON.stringify({ geometryValidationVersion: 1,
      verdict: 'split', models: [{ name: '0', geometrySignature: geometrySignature(modelDir),
        geometryComponents: [{ index: 0, registered: 3, imageIds: [1,2,3], images: names }] }] }));
    created = projects.createComponent(id, { model: '0', component: 0 });
    assert.notEqual(created.id, id);
    assert.equal(created.sourceImageCount, 3);
    assert.equal(created.componentSource.layoutVerified, false);
    assert.ok(fs.existsSync(path.resolve('projects', created.id, 'sfm/component-source/images.bin')));
    assert.equal(fs.readFileSync(path.join(dir, 'images', names[0]), 'utf8'), 'source photo');
    assert.equal(created.steps[3].status, 'pending');
    fs.appendFileSync(path.join(modelDir, 'points3D.bin'), 'changed');
    assert.throws(() => projects.createComponent(id, { model: '0', component: 0 }), /过期/);
  } finally {
    if (created) fs.rmSync(path.resolve('projects', created.id), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
