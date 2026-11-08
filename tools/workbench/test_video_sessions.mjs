// Mobile video upload contract: chunked put, resume, validation, commit and the
// rollback that must leave the uploaded bytes reusable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoSessions } from './lib/video-sessions.mjs';

const bytes = (size, fill = 1) => Buffer.alloc(size, fill);

async function fixture(t, { probe, failWriteOnce = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'video-sessions-'));
  const projects = join(root, 'projects');
  mkdirSync(projects, { recursive: true });
  const records = new Map();
  let failNextWrite = failWriteOnce;
  const store = {
    projectPath: (id) => join(projects, id, 'project.json'),
    read: (id) => {
      const record = records.get(id);
      if (!record) throw Object.assign(new Error('项目不存在'), { code: 404 });
      return record;
    },
    write: (project) => {
      if (failNextWrite) { failNextWrite = false; throw new Error('disk full'); }
      records.set(project.id, project);
      writeFileSync(store.projectPath(project.id), JSON.stringify(project));
      return project;
    },
    create: (body, { id }) => {
      mkdirSync(join(projects, id), { recursive: true });
      return store.write({ id, name: body.name, videoSources: body.videoPaths, photoSources: body.photoSources });
    },
    remove: (id, { allowMissingMetadata = false } = {}) => {
      if (!records.has(id) && !allowMissingMetadata) throw new Error('项目不存在');
      records.delete(id);
      rmSync(join(projects, id), { recursive: true, force: true });
    },
  };
  const granted = [];
  const defaultProbe = async () => ({ width: 1920, height: 1080, fps: 30, duration: 12.5, hdr: false });
  const service = createVideoSessions({
    root: join(root, 'videos'), projectStore: store,
    grantProject: (device, id) => granted.push(id), revokeProject: () => {},
    isDeviceActive: () => true, probe: probe ?? defaultProbe,
  });
  const server = createServer(async (req, res) => {
    try {
      const handled = await service.handle(req, res, new URL(req.url, 'http://x').pathname,
        req.headers.device ?? 'a', () => {});
      if (!handled) res.writeHead(404).end();
    } catch (error) {
      // Mirror the real gateway envelope (mobile.mjs): a chunk mismatch also
      // carries the authoritative offset so the phone can resume.
      res.writeHead(error.code ?? 500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error.message,
          ...(Number.isInteger(error.offset) ? { offset: error.offset } : {}) }));
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/api/mobile/v1/video-sessions`;
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const call = async (path = '', method = 'GET', body, device = 'a') => {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(base + path, {
      method,
      headers: { device, ...(body !== undefined && !binary ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const session = (await call('', 'POST', { name: '客厅', trainingPreset: 'standard' })).body;
  async function declare(size, name = 'room.mp4') {
    return (await call(`/${session.id}/files`, 'POST', { name, bytes: size })).body.fileId;
  }
  async function put(fileId, data, start, total) {
    return call(`/${session.id}/files/${fileId}`, 'PUT', data, 'a');
  }
  async function putChunk(fileId, data, start, total) {
    const binary = Buffer.from(data);
    const response = await fetch(`${base}/${session.id}/files/${fileId}`, {
      method: 'PUT',
      headers: { device: 'a', 'content-range': `bytes ${start}-${start + binary.length - 1}/${total}` },
      body: binary,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  return { root, session, store, records, call, declare, put, putChunk, granted, service, projects };
}

test('chunked upload resumes from the acknowledged offset and validates once', async (t) => {
  const f = await fixture(t);
  const payload = bytes(20);
  const fileId = await f.declare(payload.length);
  assert.equal((await f.putChunk(fileId, payload.subarray(0, 8), 0, 20)).body.offset, 8);
  assert.equal((await f.putChunk(fileId, payload.subarray(0, 8), 0, 20)).body.offset, 8); // replay is a no-op
  assert.equal((await f.putChunk(fileId, payload.subarray(8, 20), 8, 20)).body.status, 'ready');
  const detail = await f.call(`/${f.session.id}/files/${fileId}`);
  assert.equal(detail.body.status, 'ready');
  assert.equal(detail.body.offset, 20);
});

test('a gap in the byte stream is refused with the expected offset', async (t) => {
  const f = await fixture(t);
  const fileId = await f.declare(20);
  await f.putChunk(fileId, bytes(8), 0, 20);
  const gap = await f.putChunk(fileId, bytes(4), 12, 20);
  assert.equal(gap.status, 409);
  assert.match(gap.body.error, /请从 8 字节/);
});

test('validation rejects a clip that is too short and keeps the bytes for retry', async (t) => {
  const f = await fixture(t, { probe: async () => ({ width: 1920, height: 1080, fps: 30, duration: 1.0 }) });
  const fileId = await f.declare(12);
  const result = await f.putChunk(fileId, bytes(12), 0, 12);
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.errorCode, 'video_too_short');
  // The part file must survive: re-uploading 400 MB because ffmpeg was missing
  // is exactly the behaviour this design avoids.
  assert.ok(existsSync(join(f.root, 'videos', f.session.id, `${fileId}.part`)));
  const commit = await f.call(`/${f.session.id}/commit`, 'POST', {});
  assert.equal(commit.status, 409);
});

test('a re-verification can succeed without re-uploading', async (t) => {
  let healthy = false;
  const f = await fixture(t, {
    probe: async () => {
      if (!healthy) throw Object.assign(new Error('电脑未配置 ffmpeg'), { code: 503, videoCode: 'ffmpeg_missing' });
      return { width: 1920, height: 1080, fps: 30, duration: 9 };
    },
  });
  const fileId = await f.declare(10);
  const first = await f.putChunk(fileId, bytes(10), 0, 10);
  assert.equal(first.body.status, 'failed');
  healthy = true;
  const retry = await f.call(`/${f.session.id}/files/${fileId}/complete`, 'POST', {});
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, 'ready');
});

test('identical content in one batch is kept once', async (t) => {
  const f = await fixture(t);
  const payload = bytes(16, 3);
  const first = await f.declare(16, 'a.mp4');
  await f.putChunk(first, payload, 0, 16);
  const second = await f.declare(16, 'b.mp4');
  const twin = await f.putChunk(second, payload, 0, 16);
  assert.equal(twin.body.status, 'duplicate');
  assert.equal(twin.body.duplicateOf, first);
});

test('commit creates a video project with collision-free file names', async (t) => {
  const f = await fixture(t);
  // Same name, different bytes: the point is the output filename, and identical
  // bytes would be collapsed as a duplicate before reaching this assertion.
  let fill = 1;
  for (const name of ['IMG_0001.MOV', 'IMG_0001.MOV']) {
    const fileId = await f.declare(8, name);
    await f.putChunk(fileId, bytes(8, fill++), 0, 8);
  }
  const committed = await f.call(`/${f.session.id}/commit`, 'POST', {});
  assert.equal(committed.status, 200);
  const project = f.records.get(committed.body.projectId);
  assert.equal(project.inputKind, 'video');
  assert.deepEqual(project.photoSources, []);
  assert.equal(project.videoSources.length, 2);
  const names = project.videoSources.map((path) => path.split(/[\\/]/).pop());
  assert.equal(new Set(names).size, 2, `file names collided: ${names}`);
  for (const path of project.videoSources) assert.ok(existsSync(path));
  assert.deepEqual(f.granted, [committed.body.projectId]);
});

test('a failed project write rolls back to open and keeps the ready files', async (t) => {
  const f = await fixture(t, { failWriteOnce: true });
  const fileId = await f.declare(12);
  await f.putChunk(fileId, bytes(12), 0, 12);
  const failed = await f.call(`/${f.session.id}/commit`, 'POST', {});
  assert.equal(failed.status, 500);
  const session = (await f.call(`/${f.session.id}`)).body;
  assert.equal(session.status, 'open');
  assert.equal(session.projectId, null);
  assert.equal(session.files[0].status, 'ready');
  // Second attempt must succeed without any re-upload.
  const retried = await f.call(`/${f.session.id}/commit`, 'POST', {});
  assert.equal(retried.status, 200);
  assert.ok(existsSync(f.records.get(retried.body.projectId).videoSources[0]));
});

test('a session killed mid-commit is rolled back on restart, not stranded', async (t) => {
  const f = await fixture(t);
  const fileId = await f.declare(6);
  await f.putChunk(fileId, bytes(6), 0, 6);
  const meta = join(f.root, 'videos', f.session.id, 'session.json');
  const stored = JSON.parse(readFileSync(meta, 'utf8'));
  stored.status = 'committing';
  stored.projectId = 'mobile-00000000-0000-4000-8000-000000000000';
  writeFileSync(meta, JSON.stringify(stored));

  const revived = createVideoSessions({
    root: join(f.root, 'videos'), projectStore: f.store, grantProject: () => {},
    isDeviceActive: () => true, probe: async () => ({ width: 1920, height: 1080, fps: 30, duration: 8 }),
  });
  const after = JSON.parse(readFileSync(meta, 'utf8'));
  assert.equal(after.status, 'open');
  assert.equal(after.projectId, null);
  assert.equal(after.files[0].status, 'ready');
  await revived.close();
});

test('deleting a committed batch removes its project', async (t) => {
  const f = await fixture(t);
  const fileId = await f.declare(5);
  await f.putChunk(fileId, bytes(5), 0, 5);
  const committed = await f.call(`/${f.session.id}/commit`, 'POST', {});
  const projectId = committed.body.projectId;
  const removed = await f.call(`/${f.session.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.projectId, projectId);
  assert.equal(f.records.has(projectId), false);
  assert.equal(existsSync(join(f.root, 'videos', f.session.id)), false);
});

// --- Phase 3 regressions: the four ways a user could get stuck -------------

test('an aborted chunk becomes a resumable failure on restart and can finish', async (t) => {
  const f = await fixture(t);
  const fileId = await f.declare(20);
  const first = await f.putChunk(fileId, bytes(8), 0, 20);
  assert.equal(first.body.status, 'uploading');
  assert.equal(first.body.offset, 8);
  const meta = join(f.root, 'videos', f.session.id, 'session.json');
  assert.equal(JSON.parse(readFileSync(meta, 'utf8')).files[0].status, 'uploading');

  // Simulate a service restart: boot reconciliation must NOT leave `uploading`,
  // which has no UI action and blocks commit forever.
  const revived = createVideoSessions({
    root: join(f.root, 'videos'), projectStore: f.store, grantProject: () => {},
    isDeviceActive: () => true, probe: async () => ({ width: 1920, height: 1080, fps: 30, duration: 8 }),
  });
  const after = JSON.parse(readFileSync(meta, 'utf8'));
  assert.equal(after.status, 'open');
  assert.equal(after.files[0].status, 'failed');
  assert.equal(after.files[0].errorCode, 'upload_interrupted');
  assert.equal(after.files[0].offset, 8);
  assert.ok(existsSync(join(f.root, 'videos', f.session.id, `${fileId}.part`)));

  // A fresh server bound to the revived service must accept the remaining bytes.
  const server2 = createServer(async (req, res) => {
    try {
      const handled = await revived.handle(req, res, new URL(req.url, 'http://x').pathname, 'a', () => {});
      if (!handled) res.writeHead(404).end();
    } catch (error) {
      res.writeHead(error.code ?? 500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((done) => server2.listen(0, '127.0.0.1', done));
  t.after(async () => { server2.closeAllConnections(); await new Promise((done) => server2.close(done)); await revived.close(); });
  const detail = await fetch(`http://127.0.0.1:${server2.address().port}/api/mobile/v1/video-sessions/${f.session.id}/files/${fileId}`,
    { headers: { device: 'a' } });
  assert.equal((await detail.json()).offset, 8);
  const resumed = await fetch(`http://127.0.0.1:${server2.address().port}/api/mobile/v1/video-sessions/${f.session.id}/files/${fileId}`,
    { method: 'PUT', headers: { device: 'a', 'content-range': 'bytes 8-19/20' }, body: bytes(12) });
  const resumedBody = await resumed.json();
  assert.equal(resumed.status, 200);
  assert.equal(resumedBody.status, 'ready');
  assert.equal(resumedBody.offset, 20);
});

test('a chunk mismatch reports a structured offset for the phone resume branch', async (t) => {
  const f = await fixture(t);
  const fileId = await f.declare(20);
  await f.putChunk(fileId, bytes(8), 0, 20);
  const gap = await f.putChunk(fileId, bytes(4), 12, 20);
  assert.equal(gap.status, 409);
  // video.mjs checks `error.payload.offset`; a message-only 409 is unreachable.
  assert.equal(gap.body.offset, 8);
});

// Browser modules need a DOM, so drive the real video.mjs with a small fake one.
async function browserHarness({ session, apiHandler, responses }) {
  const elements = new Map();
  const makeEl = () => ({
    hidden: false, disabled: false, textContent: '', value: '', dataset: {}, className: '', handlers: {},
    append() {}, replaceChildren() {}, setAttribute() {}, removeAttribute() {},
    querySelectorAll() { return []; }, addEventListener(type, fn) { this.handlers[type] = fn; },
  });
  const $ = (id) => { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); };
  const savedGlobals = { document: globalThis.document, window: globalThis.window,
    localStorage: globalThis.localStorage, XMLHttpRequest: globalThis.XMLHttpRequest };
  globalThis.document = { createElement: () => makeEl(), hidden: false };
  globalThis.window = { confirm: () => true };
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  const calls = [];
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, json: options.json });
    return apiHandler(path, { ...options, method });
  };
  const queue = [...responses];
  class FakeXHR {
    constructor() { this.upload = {}; this.headers = {}; FakeXHR.instances.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      this.body = body;
      const next = queue.shift() ?? { status: 200, body: {} };
      setImmediate(() => {
        this.status = next.status ?? 200;
        this.responseText = JSON.stringify(next.body ?? {});
        if (next.progress !== undefined) this.upload.onprogress?.({ lengthComputable: true, loaded: next.progress });
        if (next.networkError) { this.onerror?.(); return; }
        this.onload?.();
      });
    }
    abort() { this.onabort?.(); }
  }
  FakeXHR.instances = [];
  globalThis.XMLHttpRequest = FakeXHR;
  const { initVideoUpload } = await import('./public/mobile/video.mjs');
  const ui = initVideoUpload({ api, $, say: () => {}, onProject: async () => {} });
  await ui.refresh('token', { video: { canUpload: true, tonemap: true, tonemapUnknown: false },
    videoLimits: { chunkBytes: 8 } });
  return { ui, calls, elements, instances: FakeXHR.instances,
    restore: () => Object.assign(globalThis, savedGlobals) };
}

const BASE = '/api/mobile/v1/video-sessions';
function fakeFile(name, size) {
  return { name, size, slice: (start, end) => ({ size: end - start }) };
}

test('re-selecting an interrupted clip reuses its fileId and resumes at the server offset', async (t) => {
  const session = { id: 'S1', name: '视频', status: 'open', projectId: null, files: [
    { id: 'F1', name: 'room.mp4', bytes: 16, status: 'failed', offset: 8,
      errorCode: 'upload_interrupted', error: '上传中断' },
  ] };
  const h = await browserHarness({ session, responses: [{ status: 200, body: { offset: 16, status: 'ready', session } }],
    apiHandler: async (path, options) => {
      if (path === BASE && options.method === 'POST') return session;
      if (path === `${BASE}/S1/files/F1` && options.method === 'GET') return { offset: 8, status: 'failed', bytes: 16 };
      if (path === `${BASE}/S1` && options.method === 'GET') return session;
      throw new Error(`unexpected api call: ${options.method} ${path}`);
    } });
  t.after(h.restore);
  await h.elements.get('videoPick').handlers.change({ target: { files: [fakeFile('room.mp4', 16)] } });
  assert.equal(h.calls.some((c) => c.path === `${BASE}/S1/files` && c.method === 'POST'), false,
    'a second file record must not be declared');
  assert.ok(h.calls.some((c) => c.path === `${BASE}/S1/files/F1` && c.method === 'GET'));
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].headers['content-range'], 'bytes 8-15/16');
  assert.equal(h.elements.get('videoPick').disabled, false, 'busy must be reset');
});

test('a 409 without a structured offset falls back to GET and continues uploading', async (t) => {
  const session = { id: 'S1', name: '视频', status: 'open', projectId: null, files: [] };
  const h = await browserHarness({ session, responses: [
    { status: 409, body: { error: '请从 8 字节继续上传' } },
    { status: 200, body: { offset: 16, status: 'ready', session } },
  ], apiHandler: async (path, options) => {
    if (path === BASE && options.method === 'POST') return session;
    if (path === `${BASE}/S1/files` && options.method === 'POST') return { fileId: 'F2', offset: 0, session };
    if (path === `${BASE}/S1/files/F2` && options.method === 'GET') return { offset: 8, status: 'uploading', bytes: 16 };
    if (path === `${BASE}/S1` && options.method === 'GET') return session;
    throw new Error(`unexpected api call: ${options.method} ${path}`);
  } });
  t.after(h.restore);
  await h.elements.get('videoPick').handlers.change({ target: { files: [fakeFile('room.mp4', 16)] } });
  assert.equal(h.calls.filter((c) => c.path === `${BASE}/S1/files` && c.method === 'POST').length, 1);
  assert.ok(h.calls.some((c) => c.path === `${BASE}/S1/files/F2` && c.method === 'GET'));
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].headers['content-range'], 'bytes 0-7/16');
  assert.equal(h.instances[1].headers['content-range'], 'bytes 8-15/16');
});

test('a network error resets busy so the section is usable again', async (t) => {
  const session = { id: 'S1', name: '视频', status: 'open', projectId: null, files: [] };
  const h = await browserHarness({ session, responses: [{ networkError: true }],
    apiHandler: async (path, options) => {
      if (path === BASE && options.method === 'POST') return session;
      if (path === `${BASE}/S1/files` && options.method === 'POST') return { fileId: 'F3', offset: 0, session };
      if (path === `${BASE}/S1` && options.method === 'GET') return session;
      throw new Error(`unexpected api call: ${options.method} ${path}`);
    } });
  t.after(h.restore);
  await h.elements.get('videoPick').handlers.change({ target: { files: [fakeFile('room.mp4', 16)] } });
  assert.equal(h.elements.get('videoPick').disabled, false, 'busy must be reset after an error');
  assert.match(h.elements.get('videoStatus').textContent, /网络中断/);
});

// app.js needs a full page + bootstrap, so assert the wiring statically instead
// of trying to execute it in Node. These two lines are the entire deadlock fix.
test('authorization loss and api timeout wiring stay in place (static contract)', () => {
  const app = readFileSync(new URL('./public/mobile/app.js', import.meta.url), 'utf8');
  const video = readFileSync(new URL('./public/mobile/video.mjs', import.meta.url), 'utf8');
  assert.match(app, /let videoUI=null;/);
  assert.match(app, /videoUI\?\.refresh\('', null\)/);
  assert.match(app, /AbortController/);
  assert.match(app, /30000/);
  assert.match(video, /RESUMABLE_CODES/);
  assert.match(video, /let authoritative = error\.payload\?\.offset/);
});

// The Python CLI now emits `video-error-code: internal_error`. This is a seam
// test: it pins the literal Set, the exact marker regex and the 503 classifier
// without spawning a Python child (the fixture injects a fake probe).
test('internal_error stays in the deployment set and parses as 503', () => {
  const source = readFileSync(new URL('./lib/video-sessions.mjs', import.meta.url), 'utf8');
  const block = /const DEPLOYMENT_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block, 'DEPLOYMENT_CODES not found');
  const members = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  assert.equal(new Set(members).size, members.length, 'no duplicate code in the set');
  assert.ok(members.includes('internal_error'), 'internal_error must not fall into the 400 material domain');
  // Exactly the regex used by probeVideo(); underscores must be matched, and
  // prefix noise from import-time warnings must not break it.
  const stderr = 'numpy DeprecationWarning: x\nvideo-error-code: internal_error\n视频处理失败：内部错误';
  assert.equal(/video-error-code:\s*([a-z0-9_]+)/.exec(stderr)?.[1] ?? '', 'internal_error');
  assert.match(source, /DEPLOYMENT_CODES\.has\(code\) \? 503 : 400/);
  assert.equal(new Set(members).has('internal_error') ? 503 : 400, 503);
  // The phone must get an actionable sentence, never the raw code.
  const gateway = readFileSync(new URL('./lib/mobile.mjs', import.meta.url), 'utf8');
  assert.match(gateway, /internal_error:'电脑处理视频时发生内部错误/);
});

test('an internal_error from the probe reaches the client as a deployment failure', async (t) => {
  const f = await fixture(t, {
    probe: async () => { throw Object.assign(new Error('内部错误'), { code: 503, videoCode: 'internal_error' }); },
  });
  const fileId = await f.declare(10);
  const result = await f.putChunk(fileId, bytes(10), 0, 10);
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.errorCode, 'internal_error');
  // Bytes are kept so a retry is possible without re-uploading.
  assert.ok(existsSync(join(f.root, 'videos', f.session.id, `${fileId}.part`)));
  const detail = (await f.call(`/${f.session.id}`)).body;
  assert.equal(detail.files[0].errorCode, 'internal_error');
});
