// Video as a project input: record shape, prepare command wiring, and the
// manifest → verify() path that carries a content failure to the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as projects from './lib/projects.mjs';
import { buildSteps, dirs, frameCacheDir, photoSources, videoSources } from './lib/pipeline.mjs';
import { TOOLS } from './lib/paths.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'video-project-'));
  const video = join(root, 'room.mp4');
  // Content does not matter here: creation validates path, suffix and size only.
  writeFileSync(video, Buffer.alloc(4096, 7));
  // One id per test. A fixed id makes create() throw 409 whenever an earlier
  // interrupted run (or a concurrent test file) left that directory behind,
  // which shows up as a spurious failure in a full-suite run.
  const id = `test-video-${randomBytes(3).toString('hex')}`;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => { try { projects.remove(id); } catch { /* already gone */ } });
  return { root, video, id };
}

test('a video-only project records its source and needs no image folder', (t) => {
  const { video, id } = fixture(t);
  const project = projects.create({
    name: '视频项目', videoPaths: [video], videoFrameTarget: 60, trainingPreset: 'standard',
  }, { id });
  assert.equal(project.inputKind, 'video');
  assert.equal(project.sourceDir, '');
  assert.deepEqual(project.photoSources, []);
  assert.equal(project.videoSources.length, 1);
  assert.equal(project.videoSources[0].name, 'room.mp4');
  assert.equal(project.videoFrameTarget, 60);

  const summary = projects.summarise(project);
  assert.equal(summary.videoCount, 1);
  assert.equal(summary.videoFrameTarget, 60);
  assert.deepEqual(summary.videos.map((item) => item.name), ['room.mp4']);
});

test('video inputs are validated: extension, existence and duplicates', (t) => {
  const { root, video } = fixture(t);
  const text = join(root, 'notes.txt');
  writeFileSync(text, 'x');
  assert.throws(() => projects.create({ name: 'x', videoPaths: [text], trainingPreset: 'standard' }),
    /不支持的视频格式/);
  assert.throws(() => projects.create({ name: 'x', videoPaths: [join(root, 'missing.mp4')], trainingPreset: 'standard' }),
    /视频文件不存在/);
  assert.throws(() => projects.create({ name: 'x', videoPaths: [], trainingPreset: 'standard' }),
    /至少一个视频文件|图片文件夹/);
  // The same path twice is one input, not two.
  const project = projects.create({ name: 'dup', videoPaths: [video, video], trainingPreset: 'standard' });
  assert.equal(project.videoSources.length, 1);
  projects.remove(project.id);
});

test('prepare receives the videos, the cache and no empty --source', (t) => {
  const { video, id } = fixture(t);
  const project = projects.create({
    name: '视频项目 2', videoPaths: [video], videoFrameTarget: 0, trainingPreset: 'standard',
  }, { id });
  const prepare = buildSteps()[0];
  const { cmd, args } = prepare.command(project);
  assert.equal(cmd, TOOLS.python);
  assert.equal(args.filter((value) => value === '--video').length, 1);
  assert.equal(args[args.indexOf('--video') + 1], video);
  // An empty --source would make prepare exit 3 for a perfectly good project.
  assert.equal(args.includes('--source'), false);
  assert.equal(args[args.indexOf('--frame-cache') + 1], frameCacheDir(project));
  assert.equal(args[args.indexOf('--images-relative') + 1], 'images');
  // The frame cache must live outside any attempt workspace, or re-running
  // prepare deletes the decoded frames it was supposed to reuse.
  const attempt = dirs({ ...project, activeAttemptId: 'a-0123456789abcdef01234567' }).workspace;
  const cache = frameCacheDir(project);
  assert.equal(cache.startsWith(attempt + '\\') || cache.startsWith(attempt + '/'), false);
  assert.deepEqual(photoSources(project), []);
  assert.deepEqual(videoSources(project), [video]);
});

test('a manifest error becomes a verify failure with its code, not an exit code', (t) => {
  const { video, id } = fixture(t);
  const project = projects.create({
    name: '视频项目 3', videoPaths: [video], trainingPreset: 'standard',
  }, { id });
  const prepare = buildSteps()[0];
  const manifest = dirs(project).manifest;
  mkdirSync(resolve(manifest, '..'), { recursive: true });
  writeFileSync(manifest, JSON.stringify({
    retained_count: 0, camera_groups: {}, videos: [{ name: 'room.mp4', error: '解码失败', errorCode: 'decode_failed' }],
    error: { code: 'decode_failed', message: '视频处理失败：room.mp4（解码失败）' },
  }));
  const check = prepare.verify(project);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'decode_failed');
  assert.match(check.message, /room\.mp4/);

  // Without the error field, the count alone still fails the step.
  writeFileSync(manifest, JSON.stringify({ retained_count: 1, camera_groups: {}, videos: [] }));
  const count = prepare.verify(project);
  assert.equal(count.ok, false);
  assert.match(count.message, /1 张/);
  assert.equal(readFileSync(manifest, 'utf8').length > 0, true);
});
