// Mobile video upload. Kept out of app.js on purpose: the photo flow there is
// dense and battle-tested, and this feature must not perturb it.
//
// A 4K phone clip is hundreds of MB, so the file is sent in chunks with
// XMLHttpRequest (fetch cannot report upload progress). The server stores each
// chunk at an explicit offset, which makes a retry after a dropped connection
// resume rather than restart.
const BASE = '/api/mobile/v1/video-sessions';
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const STORE_KEY = 'gr.mobile.videoSession';

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const LABELS = {
  pending: '待上传', uploading: '上传中', probing: '校验中',
  ready: '就绪', failed: '失败', duplicate: '重复', deleting: '删除未完成',
};
// Only these failures still have usable bytes on the computer. A content
// rejection (too short / undecodable) must start a fresh record instead.
const RESUMABLE_CODES = new Set(['upload_interrupted', 'verification_interrupted']);
const resumable = (file) => file.status === 'uploading' ||
  (file.status === 'failed' && RESUMABLE_CODES.has(file.errorCode));

export function initVideoUpload({ api, $, say, onProject }) {
  let token = '';
  let caps = { canUpload: false, chunkBytes: DEFAULT_CHUNK };
  let session = null;
  let busy = false;
  let message = '';
  let restored = false;

  const chunkSize = () => Math.min(DEFAULT_CHUNK, Number(caps?.chunkBytes) || DEFAULT_CHUNK);

  function setMessage(text, tone = '') {
    message = text;
    const node = $('videoStatus');
    if (node) { node.textContent = text; node.dataset.tone = tone; }
  }

  function remember(id) {
    try { id ? localStorage.setItem(STORE_KEY, id) : localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
  }

  function render() {
    const section = $('videoSection');
    if (!section) return;
    section.hidden = !token;
    if ($('videoTitle')) $('videoTitle').textContent = session ? `视频重建 · ${session.name}` : '视频重建';

    const committed = session?.status === 'committed';
    const pick = $('videoPick');
    // The input itself has no visible text; the label lives in the markup. Only
    // the enabled state changes here, plus a chip in the hint line.
    if (pick) pick.disabled = busy || !caps.canUpload || committed;
    if ($('videoHint')) {
      // Three states, not two: "unknown" must not be shown as "missing", or a
      // phone that could upload HDR is told to re-encode for no reason.
      const tonemapNote = caps.tonemapUnknown
        ? ' 电脑正在确认 HDR 转换能力；若上传后提示缺少滤镜，请更新 ffmpeg。'
        : (caps.tonemap === false ? ' 电脑的 ffmpeg 缺少色调映射，HDR 视频会被拒绝，请先转成 SDR。' : '');
      $('videoHint').textContent = caps.canUpload
        ? `支持 MP4 / MOV，单段不超过 ${formatSize(1024 * 1024 * 1024)}，建议 10 秒到 8 分钟、1080p 以上。iPhone 若提示无法解码，请在 设置 → 相机 → 格式 选择“兼容性最佳”后重录。${tonemapNote}`
        : (caps.message || '电脑端未配置 ffmpeg，暂时不能上传视频。');
    }
    if ($('videoClear')) $('videoClear').hidden = !session || busy;
    // Without this, making a second video project means deleting the first, and
    // deleting a project also drops its frame cache - the same clip is then
    // decoded all over again for no visible reason.
    if ($('videoNew')) $('videoNew').hidden = !committed || busy;

    const list = $('videoList');
    if (!list) return;
    list.replaceChildren();
    for (const file of session?.files ?? []) {
      const row = document.createElement('li');
      row.className = `video-row ${file.status}`;

      const name = document.createElement('span');
      name.className = 'video-name';
      name.textContent = file.name;

      const detail = document.createElement('span');
      detail.className = 'video-detail';
      const parts = [formatSize(file.bytes)];
      if (file.durationSec) parts.push(`${file.durationSec} 秒`);
      if (file.status === 'uploading' || file.status === 'pending') {
        parts.push(`${Math.round((file.offset / file.bytes) * 100)}%`);
      }
      if (file.status === 'failed' && file.error) parts.push(file.error);
      if (file.status === 'duplicate') parts.push('与另一段重复，已忽略');
      detail.textContent = parts.join(' · ');

      const state = document.createElement('span');
      state.className = 'video-state';
      state.textContent = LABELS[file.status] ?? file.status;

      const actions = document.createElement('span');
      actions.className = 'video-actions';
      if (!busy && !committed && (file.status === 'failed' || file.status === 'uploading')) {
        // Bytes are still on disk after a failed validation or an aborted chunk,
        // so the user can retry without re-sending 400 MB. `uploading` is
        // included because a watchdog abort leaves that state on the server;
        // `!busy` keeps the buttons hidden while a chunk is actually in flight.
        if (file.offset === file.bytes) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'text-button';
          retry.textContent = '重新校验';
          retry.onclick = () => revalidate(file.id);
          actions.append(retry);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-button';
        remove.textContent = '移除';
        remove.onclick = () => removeFile(file.id);
        actions.append(remove);
      }
      if (!busy && !committed && file.status === 'ready') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-button';
        remove.textContent = '移除';
        remove.onclick = () => removeFile(file.id);
        actions.append(remove);
      }

      row.append(name, detail, state, actions);
      list.append(row);
    }

    const commit = $('videoCommit');
    if (commit) {
      const ready = (session?.files ?? []).filter((file) => file.status === 'ready').length;
      const blocked = (session?.files ?? []).some((file) => ['failed', 'uploading', 'probing', 'pending'].includes(file.status));
      commit.hidden = !ready || busy || session?.status !== 'open';
      // Say why instead of silently disabling: a failed file is the usual cause.
      commit.textContent = blocked
        ? `还有视频未完成，先处理失败项`
        : `提交 ${ready} 段视频并创建项目`;
      commit.disabled = blocked;
    }
  }

  async function refreshSession() {
    if (!session?.id) return;
    try {
      session = await api(`${BASE}/${session.id}`);
      if (session.status === 'committed') remember(session.id);
    } catch (error) {
      if (error.status === 404) { session = null; remember(null); }
    }
    render();
  }

  async function ensureSession() {
    if (session && session.status === 'open') return session;
    const stamp = new Date();
    const name = `视频 ${stamp.getMonth() + 1}月${stamp.getDate()}日 ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
    session = await api(BASE, { method: 'POST', json: { name, trainingPreset: 'standard' } });
    remember(session.id);
    return session;
  }

  function putChunk(url, blob, start, total, onProgress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', url);
      request.setRequestHeader('authorization', `Bearer ${token}`);
      request.setRequestHeader('content-type', 'application/octet-stream');
      request.setRequestHeader('content-range', `bytes ${start}-${start + blob.size - 1}/${total}`);
      // A Wi-Fi connection that goes half-dead fires neither onload nor onerror.
      // Without this watchdog the promise never settles, `busy` stays true and
      // every control in the section (including "remove") is disabled until the
      // page is reloaded. The offset is persisted server-side, so aborting and
      // retrying the same chunk is safe.
      let lastTick = Date.now();
      const stall = setInterval(() => {
        if (Date.now() - lastTick < 30000) return;
        clearInterval(stall);
        request.abort();
        reject(Object.assign(new Error('上传停顿超过 30 秒，已中止；请重试'), { status: 0, payload: {} }));
      }, 5000);
      request.upload.onprogress = (event) => {
        lastTick = Date.now();
        if (event.lengthComputable) onProgress(event.loaded);
      };
      request.onerror = () => { clearInterval(stall); reject(new Error('网络中断，请重试')); };
      request.onabort = () => clearInterval(stall);
      request.onload = () => {
        clearInterval(stall);
        let payload = {};
        try { payload = JSON.parse(request.responseText || '{}'); } catch { /* ignore */ }
        if (request.status === 200) resolve(payload);
        else reject(Object.assign(new Error(payload.error || `上传失败（${request.status}）`),
          { status: request.status, payload }));
      };
      request.send(blob);
    });
  }

  async function uploadFile(file, onProgress) {
    // Re-selecting the same clip after an interrupted upload must resume the
    // existing record. Declaring a new one would leave the old `uploading`
    // record blocking commit forever and re-send every byte.
    const prior = (session?.files ?? []).find((item) =>
      item.name === file.name && item.bytes === file.size && resumable(item));
    let fileId, offset;
    if (prior) {
      fileId = prior.id;
      let detail = null;
      try { detail = await api(`${BASE}/${session.id}/files/${fileId}`); } catch { /* fall back to the session view */ }
      offset = Number.isFinite(detail?.offset) ? detail.offset : (Number(prior.offset) || 0);
      if (offset >= file.size) {
        // All bytes arrived earlier; only validation was interrupted.
        const result = await api(`${BASE}/${session.id}/files/${fileId}/complete`, { method: 'POST', json: {} });
        if (result.status === 'failed') throw Object.assign(new Error(result.error || '视频校验失败'),
          { errorCode: result.errorCode });
        if (result.session) session = result.session;
        return result;
      }
    } else {
      const created = await api(`${BASE}/${session.id}/files`, {
        method: 'POST', json: { name: file.name, bytes: file.size },
      });
      session = created.session;
      fileId = created.fileId;
      offset = created.offset ?? 0;
    }
    let last = null;
    while (offset < file.size) {
      const end = Math.min(offset + chunkSize(), file.size);
      try {
        last = await putChunk(`${BASE}/${session.id}/files/${fileId}`, file.slice(offset, end),
          offset, file.size, (loaded) => onProgress(offset + loaded));
      } catch (error) {
        // 409 means the server's offset wins. Newer gateways include the
        // structured offset in the error body; otherwise fetch the
        // authoritative value from the file endpoint before giving up.
        if (error.status === 409) {
          let authoritative = error.payload?.offset;
          if (!Number.isFinite(authoritative)) {
            try {
              const detail = await api(`${BASE}/${session.id}/files/${fileId}`);
              authoritative = detail?.offset;
            } catch { /* handled below */ }
          }
          if (Number.isFinite(authoritative)) { offset = authoritative; continue; }
        }
        throw error;
      }
      offset = last.offset ?? end;
      onProgress(offset);
      if (last.session) session = last.session;
      render();
    }
    if (last?.status === 'failed') throw Object.assign(new Error(last.error || '视频校验失败'),
      { errorCode: last.errorCode });
    return last;
  }

  async function handleFiles(files) {
    if (!files?.length) return;
    if (!caps.canUpload) { setMessage(caps.message || '电脑端未配置 ffmpeg，暂时不能上传视频。', 'warn'); return; }
    busy = true; render();
    try {
      await ensureSession();
      for (const file of files) {
        setMessage(`上传 ${file.name}（${formatSize(file.size)}）…`);
        render();
        try {
          const result = await uploadFile(file, (loaded) => {
            setMessage(`上传 ${file.name}：${Math.round((loaded / file.size) * 100)}%`);
          });
          if (result?.duplicateOf) setMessage(`${file.name} 与另一段视频内容相同，已忽略。`, 'warn');
          else setMessage(`${file.name} 已就绪。`);
        } catch (error) {
          setMessage(`${file.name}：${error.message}`, 'warn');
        }
        await refreshSession();
      }
      const failed = (session?.files ?? []).filter((file) => file.status === 'failed').length;
      say(failed
        ? `有 ${failed} 段视频未能通过校验，请按提示重新校验或移除后再提交。`
        : '视频已上传，可以提交后开始重建。');
    } catch (error) {
      setMessage(error.message, 'warn');
    } finally {
      busy = false;
      const pick = $('videoPick');
      if (pick) pick.value = '';
      render();
    }
  }

  async function revalidate(fileId) {
    if (!session || busy) return;
    busy = true; render();
    try {
      const result = await api(`${BASE}/${session.id}/files/${fileId}/complete`, { method: 'POST', json: {} });
      setMessage(result.status === 'ready' ? '重新校验通过。' : (result.error || '仍然无法校验这段视频。'),
        result.status === 'ready' ? '' : 'warn');
    } catch (error) {
      setMessage(error.message, 'warn');
    } finally {
      busy = false;
      await refreshSession();
    }
  }

  async function removeFile(fileId) {
    if (!session || busy) return;
    busy = true; render();
    try {
      session = await api(`${BASE}/${session.id}/files/${fileId}`, { method: 'DELETE' });
      setMessage('已移除这段视频。');
    } catch (error) {
      setMessage(error.message, 'warn');
      // A 503 from Windows file locking leaves the server in `deleting`; refresh
      // so the UI shows the real state instead of a stale `open`/`committed`.
      try { await refreshSession(); } catch { /* keep the original message */ }
    } finally {
      busy = false;
      render();
    }
  }

  async function commit() {
    if (!session || busy) return;
    busy = true; render();
    try {
      setMessage('正在创建项目…');
      const result = await api(`${BASE}/${session.id}/commit`, { method: 'POST', json: {} });
      session.status = 'committed';
      session.projectId = result.projectId;
      remember(session.id);
      setMessage('项目已创建，回到下方「重建与漫游」查看进度。');
      render();
      await onProject(result.projectId);
    } catch (error) {
      setMessage(error.message, 'warn');
    } finally {
      busy = false;
      render();
    }
  }

  async function clear() {
    if (!session) return;
    if (!window.confirm('删除这个视频批次？已上传的视频、由它创建的项目以及抽帧缓存都会删除；下次同一段视频需要重新抽帧。')) return;
    busy = true; render();
    try {
      await api(`${BASE}/${session.id}`, { method: 'DELETE' });
      session = null;
      remember(null);
      setMessage('批次已删除。');
    } catch (error) {
      setMessage(error.message, 'warn');
    } finally {
      busy = false;
      render();
    }
  }

  const pick = $('videoPick');
  if (pick) pick.addEventListener('change', (event) => handleFiles(event.target.files));
  if ($('videoCommit')) $('videoCommit').addEventListener('click', commit);
  if ($('videoClear')) $('videoClear').addEventListener('click', clear);
  if ($('videoNew')) $('videoNew').addEventListener('click', () => {
    // The committed session stays on the computer as a small record; simply stop
    // pointing at it and the next upload opens a fresh one.
    session = null;
    remember(null);
    setMessage('');
    render();
  });

  return {
    async refresh(newToken, capabilities) {
      const nextToken = newToken ?? '';
      caps = {
        canUpload: Boolean(capabilities?.video?.canUpload),
        chunkBytes: Number(capabilities?.videoLimits?.chunkBytes) || DEFAULT_CHUNK,
        tonemap: capabilities?.video?.tonemap,
        tonemapUnknown: capabilities?.video?.tonemapUnknown === true,
        message: capabilities?.video?.message ?? '',
      };
      if (!nextToken) {
        // Authorization is gone: drop the pointer so a re-paired device does not
        // try to resume a batch that belongs to the previous token.
        if (token) { session = null; remember(null); }
        token = '';
        restored = false;
        render();
        return;
      }
      token = nextToken;
      if (!restored) {
        restored = true;
        // A reload mid-upload must not orphan the batch: the .part files are on
        // the computer, and without this the user has no way to reach them.
        let id = null;
        try { id = localStorage.getItem(STORE_KEY); } catch { /* private mode */ }
        if (id && !session) {
          try { session = await api(`${BASE}/${id}`); } catch { remember(null); }
        }
      }
      render();
    },
  };
}
