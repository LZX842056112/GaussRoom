export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms > 0 && ms < 1000) return '不足 1 秒';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds} 秒`;
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`;
}

export function elapsedTiming(timing, now = Date.now()) {
  if (!Number.isFinite(timing?.elapsedMs) || timing.elapsedMs < 0) return null;
  return timing.elapsedMs + (timing.running && Number.isFinite(timing.asOf) ? Math.max(0, now - timing.asOf) : 0);
}

export function timingLabel(timing, now = Date.now()) {
  const elapsed = elapsedTiming(timing, now);
  if (elapsed === null) return timing?.complete ? '未开始' : '暂无记录';
  return `${timing.complete === false ? '已记录 ' : ''}${formatDuration(elapsed)}`;
}
