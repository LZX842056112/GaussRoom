// Mobile video upload: a separate resource from photo batches, so the photo
// state machine (and every test that covers it) stays untouched.
//
// Uploads are chunked on purpose: a phone-recorded 4K clip is hundreds of MB
// over Wi-Fi, and a single PUT that dies at 90% would have to start over. Each
// chunk is written at an explicit offset and fsynced before the offset is
// persisted, so `offset` is a real resume point and a replayed chunk is a no-op.
// Two timeout invariants hold this design together. Both are cross-module and
// enforced by nothing but these comments:
//   1. An outer timeout must be *significantly* longer than the inner one - not
//      merely longer. The outer kill is a SIGKILL: if the two are within a
//      second or two, the inner process can die while writing its
//      `video-error-code:` line and truncate the marker. The code then degrades
//      to the generic message and the user is told to re-encode a file that is
//      fine. The margin is what keeps the error channel usable.
//      current: probeVideo 45s > _ffprobe 30s; prepare step 2700s > _decode_ffmpeg 600s.
//   2. An abstaining layer must time out *faster* than the deciding layer, or the
//      abstention is handed to a layer that cannot answer either.
//      current: filterSupport 5s (abstain) < _zscale_available 20s (decide).
// Update these numbers in the same commit as any timeout change.
import { randomUUID, createHash } from 'node:crypto';
import {
  createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, rmdirSync, statSync, statfsSync, openSync, closeSync, fsyncSync, writeSync, ftruncateSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, sendJson } from './http.mjs';
import { PY_DIR, TOOLS } from './paths.mjs';
import { videoCapabilities } from './video-tools.mjs';

const base = '/api/mobile/v1/video-sessions';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, code = 400) => Object.assign(new Error(message), { code });
const CHUNK = 8 * 1024 * 1024;
const LIMITS = {
  maxFileBytes: 1024 * 1024 * 1024, maxFiles: 6, maxBatchBytes: 2 * 1024 * 1024 * 1024,
  minDurationSec: 3, maxDurationSec: 600, minLongEdge: 1280,
};
// H.264-in-MP4 is what every phone and every ffmpeg build can decode; MOV is
// the iPhone container and carries the same codecs.
const FORMATS = ['.mp4', '.mov', '.m4v'];
// Codes that mean "the computer cannot decode video at all". They must never be
// answered with "convert your file and try again" - the user's file is fine.
// Adding a code in Python therefore requires adding it here in the same commit;
// the two lists are the seam where a deployment problem used to masquerade as a
// user problem.
const DEPLOYMENT_CODES = new Set([
  'ffmpeg_missing', 'ffprobe_missing', 'ffmpeg_probe_failed', 'hdr_requires_ffmpeg',
  'probe_timeout', 'decode_timeout', 'internal_error',
]);

const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

async function probeVideo(path, { run = promisify(execFile), ffmpeg = TOOLS.ffmpeg, python = TOOLS.python } = {}) {
  if (!ffmpeg) {
    throw Object.assign(bad('电脑未配置 ffmpeg，暂时不能接收视频', 503), { videoCode: 'ffmpeg_missing' });
  }
  try {
    const { stdout } = await run(python, ['-X', 'utf8', '-B', join(PY_DIR, 'video_frames.py'),
      '--probe', path, '--ffmpeg', ffmpeg],
    { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout);
    // Refuse HDR at upload time only when the build provably cannot tone-map it.
    // `unknown` (filter probe timed out) passes through: Python re-checks during
    // extraction and fails with a precise code if the capability is真 missing.
    const tonemap = videoCapabilities().tonemap;
    if (info.hdr && tonemap.unknown !== true && !tonemap.ok) {
      throw Object.assign(bad('视频是 HDR，但电脑的 ffmpeg 缺少 zscale/tonemap；请换用完整版 ffmpeg，或先转成 SDR', 503),
        { videoCode: 'hdr_requires_ffmpeg' });
    }
    return info;
  } catch (error) {
    if (error.videoCode) throw error;      // already classified above
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      // Node also sets `killed` when it aborts a child for exceeding maxBuffer;
      // that is an environment problem, not a hung decoder.
      throw Object.assign(bad('读取视频信息失败（输出异常），请重试', 503), { videoCode: 'ffmpeg_probe_failed' });
    }
    if (error.killed) {
      // A timeout here is a slow disk or a hung decoder, not a broken container;
      // answering 400 would send the user off to convert a perfectly good file.
      throw Object.assign(bad('读取视频信息超时，请重试', 503), { videoCode: 'probe_timeout' });
    }
    // Prefer the marker line; old Python builds only print prose, so the
    // includes() fallbacks stay as a compatibility path.
    const stderr = String(error.stderr ?? '');
    const marked = /video-error-code:\s*([a-z0-9_]+)/.exec(stderr)?.[1] ?? '';
    const guessed = ['ffmpeg_missing', 'ffprobe_missing', 'ffmpeg_probe_failed', 'hdr_requires_ffmpeg',
      'hdr_unverified', 'video_too_short', 'source_long_edge_below_1000', 'unsupported_container']
      .find((code) => stderr.includes(code)) ?? '';
    const code = marked || guessed;
    const message = /视频处理失败：(.*)/.exec(stderr)?.[1]?.trim()
      ?? '无法读取视频信息，请转成 H.264 MP4 后重试';
    const failure = bad(message, DEPLOYMENT_CODES.has(code) ? 503 : 400);
    failure.videoCode = code || 'decode_failed';
    throw failure;
  }
}

export function createVideoSessions({
  root, projectStore, jobStore = {}, grantProject, revokeProject = () => {},
  isDeviceActive, probe = probeVideo, limits = {}, now = Date.now,
}) {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const lim = { ...LIMITS, ...limits };
  const sessions = new Map();
  const locks = new Set();
  const dir = (id) => join(root, id);
  const meta = (id) => join(dir(id), 'session.json');
  const part = (s, f) => join(dir(s.id), f.id + '.part');
  const ready = (s, f) => join(dir(s.id), 'ready', f.id + f.extension);
  const projectFolder = (s) => dirname(projectStore.projectPath(s.projectId));
  const sourceVideos = (s) => join(projectFolder(s), 'source-videos');

  // Durability matters here: a crash between "offset stored" and "bytes on
  // disk" would make the resume point lie. fsync before rename, like photo
  // sessions do.
  const save = (s) => {
    const target = meta(s.id);
    const temporary = `${target}.tmp`;
    const fd = openSync(temporary, 'w');
    try {
      writeFileSync(fd, JSON.stringify(s));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, target);
  };
  const dto = (s) => ({
    id: s.id, name: s.name, trainingPreset: s.trainingPreset, status: s.status,
    projectId: s.projectId, totalBytes: s.files.reduce((n, f) => n + f.bytes, 0),
    readyCount: s.files.filter((f) => f.status === 'ready').length,
    files: s.files.map(({ id, name, bytes, status, offset, error, errorCode, durationSec, width, height, duplicateOf }) => ({
      id, name, bytes, status, offset, error, errorCode, durationSec, width, height, duplicateOf,
    })),
  });
  const own = (id, device) => {
    const session = uuid.test(id) && sessions.get(id);
    if (!session || session.deviceId !== device) throw bad('批次不存在', 404);
    return session;
  };
  const open = (s) => { if (s.status !== 'open') throw bad('批次已提交或正在提交', 409); };
  const find = (s, id) => {
    const found = s.files.find((item) => item.id === id);
    if (!found) throw bad('文件不存在', 404);
    return found;
  };
  const exclusive = async (key, fn) => {
    if (locks.has(key)) throw bad('该操作正在进行', 409);
    locks.add(key);
    try { return await fn(); } finally { locks.delete(key); }
  };
  const ensureSpace = (bytes) => {
    try {
      const stats = statfsSync(root);
      if (Number(stats.bavail) * Number(stats.bsize) < bytes + 512 * 1024 * 1024) {
        throw bad('电脑磁盘空间不足', 413);
      }
    } catch (error) {
      if (error.code === 413) throw error;
    }
  };

  /**
   * Resolve a session that died inside `committing`.
   *
   * Two crash windows exist: before project.json is written, and after it is
   * written but before our marker lands in it. Both used to strand the batch on
   * 409 forever, so anything that is not provably "ours" is rolled back to
   * `open` with the partially copied videos removed.
   */
  const recover = (s) => {
    if (s.status !== 'committing' || !s.projectId) return s.status === 'committed';
    let project = null;
    try { project = projectStore.read(s.projectId); } catch { project = null; }
    if (project?.videoSessionId === s.id) {
      s.status = 'committed';
      save(s);
      for (const f of s.files) rmSync(ready(s, f), { force: true });
      return true;
    }
    try { projectStore.remove(s.projectId, { allowMissingMetadata: true }); }
    catch {
      // A corrupt project.json makes remove() throw before it deletes anything,
      // which would leave a folder no listing can show. Delete it directly.
      try { rmSync(dirname(projectStore.projectPath(s.projectId)), { recursive: true, force: true }); }
      catch { /* last resort: nothing else to try */ }
    }
    try { rmSync(sourceVideos(s), { recursive: true, force: true }); } catch { /* ignore */ }
    s.status = 'open';
    s.projectId = null;
    save(s);
    return false;
  };

  for (const id of existsSync(root) ? readdirSync(root) : []) {
    if (!uuid.test(id)) continue;
    rmSync(join(dir(id), 'session.json.tmp'), { force: true });
    if (!existsSync(meta(id))) continue;
    let session;
    try { session = JSON.parse(readFileSync(meta(id), 'utf8')); } catch { continue; }
    if (session.id !== id) continue;
    if (session.status === 'deleting') {
      // An interrupted delete is retried at boot; if the files are locked it
      // stays visible so the user can press delete again.
      try {
        const folder = resolve(dir(session.id));
        if (!uuid.test(session.id) || dirname(folder) !== root) continue;
        for (const name of readdirSync(folder)) {
          if (name === 'session.json' || name === 'session.json.tmp') continue;
          rmSync(join(folder, name), { recursive: true, force: true });
        }
        rmSync(meta(session.id), { force: true });
        rmdirSync(folder);
        continue;
      } catch { /* fall through and keep it */ }
    }
    let changed = false;
    for (const f of session.files) {
      // Never delete bytes on restart: a 400 MB clip is not worth saving the
      // 3 seconds it takes to re-verify. Both states keep their data and land in
      // `failed`, which the client can retry through POST .../complete.
      if (f.status === 'probing' || (f.status === 'uploading' && f.offset === f.bytes)) {
        f.status = 'failed';
        f.offset = f.bytes;
        f.error = '电脑服务曾中断，请点“重新校验”';
        f.errorCode = 'verification_interrupted';
        changed = true;
      } else if (f.status === 'uploading') {
        // An aborted chunk leaves `uploading` with a durable offset. Keeping that
        // state would block commit forever: the UI has no action for it and a
        // re-selected file would declare a second record. Convert it to `failed`
        // (bytes and offset intact) so the client can resume or remove it.
        f.offset = Number(f.offset) || 0;
        f.status = 'failed';
        f.error = '上传中断，请重新选择同一文件继续';
        f.errorCode = 'upload_interrupted';
        changed = true;
      }
    }
    try {
      if (recover(session)) changed = true;
      if (changed) save(session);
    } catch { continue; }
    sessions.set(id, session);
  }

  async function verify(session, record, check = () => {}) {
    const source = part(session, record);
    record.status = 'probing';
    record.error = null;
    record.errorCode = null;
    save(session);
    try {
      const info = await probe(source);
      // A probe can take 45 s; a device revoked during that window must not get
      // its file promoted to `ready`. This mirrors photo-sessions' check after
      // validatePhoto().
      check();
      const longEdge = Math.max(info.width, info.height);
      if (!Number.isFinite(info.duration) || info.duration < lim.minDurationSec) {
        throw Object.assign(bad(`视频太短（${Math.round(info.duration ?? 0)} 秒），至少 ${lim.minDurationSec} 秒`, 400),
          { videoCode: 'video_too_short' });
      }
      if (info.duration > lim.maxDurationSec) {
        throw Object.assign(bad(`视频超过 ${Math.round(lim.maxDurationSec / 60)} 分钟，请分段拍摄`, 400),
          { videoCode: 'video_too_long' });
      }
      if (longEdge < lim.minLongEdge) {
        throw Object.assign(bad(`视频长边仅 ${longEdge} 像素，至少要 ${lim.minLongEdge}`, 400),
          { videoCode: 'source_long_edge_below_1000' });
      }
      const sha256 = await digest(source);
      const twin = session.files.find((item) => item.id !== record.id && item.status === 'ready' && item.sha256 === sha256);
      if (twin) {
        rmSync(source, { force: true });
        Object.assign(record, {
          status: 'duplicate', duplicateOf: twin.id, sha256,
          durationSec: Math.round(info.duration * 10) / 10,
        });
        save(session);
        return;
      }
      mkdirSync(join(dir(session.id), 'ready'), { recursive: true });
      renameSync(source, ready(session, record));
      Object.assign(record, {
        status: 'ready', sha256, durationSec: Math.round(info.duration * 10) / 10,
        width: info.width, height: info.height, offset: record.bytes,
      });
      save(session);
    } catch (error) {
      // Keep the bytes: an ffmpeg fix or a transient timeout must not force a
      // 400 MB re-upload. Only an explicit DELETE discards them.
      record.status = 'failed';
      record.error = error.message ?? '视频校验失败';
      record.errorCode = error.videoCode ?? 'decode_failed';
      save(session);
      throw error;
    }
  }

  async function commit(session, deviceId, check) {
    if (session.status === 'committed') { grantProject(deviceId, session.projectId); return session.projectId; }
    if (session.status === 'committing' && recover(session)) {
      grantProject(deviceId, session.projectId);
      return session.projectId;
    }
    open(session);
    const usable = session.files.filter((f) => f.status === 'ready');
    if (!usable.length) throw bad('还没有可用的视频', 409);
    if (session.files.some((f) => ['pending', 'uploading', 'probing', 'failed'].includes(f.status))) {
      throw bad('还有视频没有处理完成', 409);
    }
    const total = usable.reduce((n, f) => n + f.bytes, 0);
    // Copy (not rename) keeps `ready/` intact for rollback, which costs 2x peak
    // disk; the check below accounts for that instead of the 1x it used to do.
    ensureSpace(total * 2);
    session.status = 'committing';
    session.projectId = `mobile-${randomUUID()}`;
    save(session);
    const projectId = session.projectId;
    try {
      const folder = sourceVideos(session);
      mkdirSync(folder, { recursive: true });
      const paths = [];
      for (const f of usable) {
        // Content-addressed by file id: two clips named IMG_0001.MOV must not
        // overwrite each other, and reserved names like CON.mp4 never appear.
        const target = join(folder, f.id + f.extension);
        copyFileSync(ready(session, f), target);
        if (statSync(target).size !== f.bytes) throw bad('视频复制不完整，请重试', 503);
        paths.push(target);
      }
      check();
      const project = projectStore.create({
        name: session.name, videoPaths: paths, photoSources: [],
        trainingPreset: session.trainingPreset,
      }, { id: projectId });
      check();
      projectStore.write({ ...project, inputKind: 'video', videoSessionId: session.id });
      session.status = 'committed';
      save(session);
      for (const f of usable) rmSync(ready(session, f), { force: true });
      grantProject(deviceId, projectId);
      return projectId;
    } catch (error) {
      // Same shape as recover(): a corrupt project.json must not strand an
      // unreachable project folder behind a rolled-back batch.
      try { projectStore.remove(projectId, { allowMissingMetadata: true }); }
      catch {
        try { rmSync(dirname(projectStore.projectPath(projectId)), { recursive: true, force: true }); }
        catch { /* ignore */ }
      }
      try { rmSync(sourceVideos(session), { recursive: true, force: true }); } catch { /* ignore */ }
      session.status = 'open';
      session.projectId = null;
      try { save(session); } catch { /* the original error matters more */ }
      throw error;
    }
  }

  async function handle(req, res, pathname, deviceId, checkAuthorization) {
    if (pathname !== base && !pathname.startsWith(base + '/')) return false;
    const method = req.method;
    const suffix = pathname.slice(base.length);
    const match = /^\/([^/]+)(?:\/(commit|files)(?:\/([^/]+)(?:\/(complete))?)?)?$/.exec(suffix);
    const check = () => {
      checkAuthorization();
      if (!isDeviceActive(deviceId)) throw bad('设备未授权', 401);
    };

    if (!suffix && method === 'GET') {
      check();
      sendJson(res, 200, [...sessions.values()].filter((s) => s.deviceId === deviceId).map(dto));
      return true;
    }
    if (!suffix && method === 'POST') {
      check();
      const body = await readJson(req);
      if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200
          || Object.keys(body).some((key) => !['name', 'trainingPreset'].includes(key))
          || !['fast', 'standard', 'full'].includes(body.trainingPreset ?? 'standard')) {
        throw bad('批次参数无效');
      }
      const id = randomUUID();
      const session = {
        id, deviceId, name: body.name.trim(), trainingPreset: body.trainingPreset ?? 'standard',
        status: 'open', projectId: null, createdAt: new Date(now()).toISOString(), files: [],
      };
      mkdirSync(join(dir(id), 'ready'), { recursive: true });
      save(session);
      sessions.set(id, session);
      sendJson(res, 200, dto(session));
      return true;
    }
    if (!match) throw bad('接口不存在', 404);
    const [, id, action, fileId, complete] = match;

    if (!action && method === 'GET') { check(); sendJson(res, 200, dto(own(id, deviceId))); return true; }

    if (!action && method === 'DELETE') {
      // Serialised with commit/chunk writes: deleting mid-copy would leave a
      // half-written project nobody can reach from the phone.
      await exclusive(`session:${id}`, async () => {
        const session = own(id, deviceId);
        check();
        if (session.projectId && (jobStore.current?.(session.projectId) || jobStore.liveProject?.(session.projectId))) {
          throw bad('项目正在重建，请先在电脑停止任务', 409);
        }
        // `deleting` is written before anything is removed: it is the only proof
        // that a half-deleted folder belongs to an interrupted delete rather than
        // to an unknown session. session.json stays until the very end for the
        // same reason - it is the authoritative record.
        session.status = 'deleting';
        save(session);
        if (session.projectId) {
          try {
            const project = projectStore.read(session.projectId);
            if (project.videoSessionId === session.id) projectStore.remove(session.projectId);
          } catch { /* already gone */ }
          revokeProject(deviceId, session.projectId);
        }
        const folder = resolve(dir(session.id));
        if (!uuid.test(session.id) || dirname(folder) !== root) throw bad('批次路径无效', 409);
        try {
          for (const name of readdirSync(folder)) {
            if (name === 'session.json' || name === 'session.json.tmp') continue;
            rmSync(join(folder, name), { recursive: true, force: true });
          }
          rmSync(meta(session.id) + '.tmp', { force: true });
          rmSync(meta(session.id), { force: true });
          rmdirSync(folder);
        } catch {
          // Windows keeps the handle when a video is still open (antivirus, a
          // preview window). Report it as retryable instead of a bare 500.
          throw bad('删除未完成，请检查电脑文件占用和写入权限后重试。', 503);
        }
        sessions.delete(session.id);
        sendJson(res, 200, { removed: session.id, projectId: session.projectId });
      });
      return true;
    }

    if (action === 'commit' && method === 'POST') {
      await exclusive(`session:${id}`, async () => {
        const session = own(id, deviceId);
        const projectId = await commit(session, deviceId, () => { check(); own(id, deviceId); });
        sendJson(res, 200, { projectId });
      });
      return true;
    }

    if (action === 'files' && !fileId && method === 'POST') {
      await exclusive(`session:${id}`, async () => {
        const session = own(id, deviceId);
        const body = await readJson(req);
        check(); open(session);
        if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255
            || !Number.isSafeInteger(body.bytes) || body.bytes < 1
            || Object.keys(body).some((key) => !['name', 'bytes'].includes(key))) throw bad('文件参数无效');
        const extension = extname(body.name).toLowerCase();
        if (!FORMATS.includes(extension)) throw bad(`不支持的视频格式，请使用 ${FORMATS.join(' / ')}`);
        if (body.bytes > lim.maxFileBytes) {
          throw bad(`单个视频不能超过 ${Math.round(lim.maxFileBytes / 1024 / 1024)} MB`, 413);
        }
        if (session.files.length >= lim.maxFiles) throw bad(`一批最多 ${lim.maxFiles} 段视频`, 413);
        if (session.files.reduce((n, f) => n + f.bytes, 0) + body.bytes > lim.maxBatchBytes) {
          throw bad('本批视频总大小超过限制', 413);
        }
        ensureSpace(body.bytes);
        const record = {
          id: randomUUID(), name: body.name.trim(), bytes: body.bytes, extension,
          status: 'pending', offset: 0, error: null, errorCode: null,
          durationSec: null, width: null, height: null, duplicateOf: null, sha256: null,
        };
        session.files.push(record);
        save(session);
        sendJson(res, 200, { fileId: record.id, offset: 0, session: dto(session) });
      });
      return true;
    }

    if (action === 'files' && fileId && (method === 'GET' || method === 'HEAD')) {
      check();
      const record = find(own(id, deviceId), fileId);
      sendJson(res, 200, { fileId: record.id, offset: record.offset, status: record.status, bytes: record.bytes });
      return true;
    }

    if (action === 'files' && fileId && method === 'DELETE') {
      await exclusive(`session:${id}`, async () => {
        const session = own(id, deviceId);
        check(); open(session);
        const record = find(session, fileId);
        session.files = session.files.filter((item) => item !== record);
        rmSync(part(session, record), { force: true });
        rmSync(ready(session, record), { force: true });
        for (const other of session.files) {
          if (other.duplicateOf === record.id) {
            other.status = 'failed'; other.duplicateOf = null; other.error = '原视频已移除，请重试';
          }
        }
        save(session);
        sendJson(res, 200, dto(session));
      });
      return true;
    }

    // Retry validation without re-uploading: the bytes are already on disk and
    // the previous failure may have been an ffmpeg config or a probe timeout.
    if (action === 'files' && fileId && complete && method === 'POST') {
      await exclusive(`session:${id}`, async () => {
        const session = own(id, deviceId);
        check(); open(session);
        const record = find(session, fileId);
        if (record.status === 'ready') { sendJson(res, 200, { status: 'ready', session: dto(session) }); return; }
        if (record.offset !== record.bytes || !existsSync(part(session, record))) {
          throw bad('文件尚未上传完整，请重新上传', 409);
        }
        try { await verify(session, record, check); } catch { /* stored on the record */ }
        sendJson(res, 200, { status: record.status, error: record.error, errorCode: record.errorCode,
          session: dto(session) });
      });
      return true;
    }

    if (action === 'files' && fileId && method === 'PUT') {
      // Session-wide lock, not per file: DELETE and commit both take
      // `session:<id>`, and a chunk write must not be able to run underneath
      // them. Phones upload one file at a time, so this costs no parallelism.
      await exclusive(`session:${id}`, async () => {
        const session = own(id, deviceId);
        check(); open(session);
        const record = find(session, fileId);
        if (record.status === 'ready') {
          for await (const chunk of req) { /* drain */ }
          sendJson(res, 200, { offset: record.bytes, status: 'ready' });
          return;
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] ?? '');
        if (!range) throw bad('Content-Range 无效');
        const [start, end, total] = range.slice(1).map(Number);
        const length = end - start + 1;
        if (!Number.isSafeInteger(length) || length < 1 || length > CHUNK || total !== record.bytes || end >= total) {
          throw bad('上传偏移或长度无效', 400);
        }
        const chunks = [];
        let received = 0;
        for await (const chunk of req) {
          received += chunk.length;
          if (received > length) throw bad('数据长度超出声明范围', 413);
          chunks.push(chunk);
        }
        if (received !== length) throw bad('数据不完整，请重试该分片', 400);
        if (end < record.offset) {
          // Chunk already stored (client retried after a lost response).
          sendJson(res, 200, { offset: record.offset, status: record.status });
          return;
        }
        if (start !== record.offset) {
          // The client needs the authoritative offset in the response body, not
          // just in the human-readable message (the gateway error envelope is
          // otherwise `{error}` only).
          throw Object.assign(bad(`请从 ${record.offset} 字节继续上传`, 409), { offset: record.offset });
        }
        check();
        const source = part(session, record);
        const fd = openSync(source, existsSync(source) ? 'r+' : 'w+');
        try {
          ftruncateSync(fd, start);
          const buffer = Buffer.concat(chunks);
          let written = 0;
          while (written < buffer.length) {
            const count = writeSync(fd, buffer, written, buffer.length - written, start + written);
            if (count <= 0) throw bad('写入失败，请重试', 503);
            written += count;
          }
          fsyncSync(fd);
        } finally { closeSync(fd); }
        record.offset = end + 1;
        record.status = 'uploading';
        save(session);
        if (record.offset === record.bytes) {
          // Validation happens inline on the last chunk: one round-trip instead
          // of a separate "start verifying" call the client could forget.
          try { await verify(session, record, check); } catch { /* stored on the record */ }
        }
        sendJson(res, 200, {
          offset: record.offset, status: record.status, error: record.error ?? null,
          errorCode: record.errorCode ?? null, durationSec: record.durationSec,
          duplicateOf: record.duplicateOf, session: dto(session),
        });
      });
      return true;
    }

    throw bad('接口不存在', 404);
  }

  return {
    handle,
    // Only a committed session owns a project; during `committing` the project
    // may not exist yet, and mobile.mjs would answer 404 instead of "creating".
    ownsProject: (id) => [...sessions.values()].some((s) => s.status === 'committed' && s.projectId === id),
    ownsSession: (id, device) => { own(id, device); return true; },
    capabilities: () => ({ videoFormats: FORMATS, videoLimits: { ...lim, chunkBytes: CHUNK } }),
    close: async () => {},
  };
}
