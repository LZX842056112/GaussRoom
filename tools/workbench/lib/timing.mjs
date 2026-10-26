// Only executed stage time counts. Gaps between runs and user input are excluded.
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const validMs = value => Number.isFinite(value) && value >= 0;

export function stepTiming(step, now = Date.now()) {
  const saved = step.timing;
  if (saved && (validMs(saved.elapsedMs) || saved.elapsedMs === null)) {
    const since = timestamp(saved.runningSince);
    const running = step.status === 'running' && Number.isFinite(since);
    return {elapsedMs:running ? (saved.elapsedMs ?? 0) + Math.max(0, now - since) : saved.elapsedMs,
      complete:saved.complete === true, running, asOf:now};
  }
  const start = timestamp(step.startedAt), end = timestamp(step.endedAt);
  const running = step.status === 'running' && Number.isFinite(start);
  const elapsedMs = Number.isFinite(start) && (running || Number.isFinite(end))
    ? Math.max(0, (running ? now : end) - start) : null;
  const untouched = ['pending','blocked'].includes(step.status) && !step.startedAt && !step.endedAt;
  // Old timestamps describe only the last execution; earlier retries may be lost.
  return {elapsedMs, complete:untouched, running, asOf:now};
}

export function projectTiming(project, now = Date.now()) {
  const stages = (project.steps ?? []).map(step => stepTiming(step, now));
  const known = stages.filter(stage => stage.elapsedMs !== null);
  return {elapsedMs:known.length ? known.reduce((sum, stage) => sum + stage.elapsedMs, 0) : null,
    complete:stages.every(stage => stage.complete), running:stages.some(stage => stage.running), asOf:now};
}

/** Snapshot legacy timestamps before a retry or settings change clears them. */
export function preserveStepTiming(step, now = Date.now()) {
  const previous = stepTiming(step, now);
  if (previous.elapsedMs === null && previous.complete) return;
  step.timing = {elapsedMs:previous.elapsedMs, runningSince:null, complete:previous.complete};
}

export function beginStepTiming(step, now = Date.now()) {
  const previous = stepTiming(step, now);
  const since = new Date(now).toISOString();
  step.timing = {elapsedMs:previous.elapsedMs ?? 0, runningSince:since, complete:previous.complete};
  step.startedAt = since;
  delete step.endedAt;
}

/** Safe to call again after success, failure or cancellation has already closed it. */
export function endStepTiming(step, now = Date.now()) {
  const running = step.status === 'running' || step.timing?.runningSince;
  preserveStepTiming(step, now);
  if (running) step.endedAt = new Date(now).toISOString();
}
