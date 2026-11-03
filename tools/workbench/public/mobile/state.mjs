export const unfinished = file => ['pending','uploading','failed'].includes(file.status);
export const needsReselect = (files, local) => files.filter(f => unfinished(f) && !local.has(f.id)).map(f => f.id);
export const canCommit = (batch, queued = 0) => ['open','committing'].includes(batch?.status) && batch.uniqueCount >= 2 && !queued && !batch.files.some(unfinished);
export function formatBytes(n) { return Number.isFinite(n) ? (n < 1048576 ? `${(n/1024).toFixed(1)} KiB` : `${(n/1048576).toFixed(1)} MiB`) : '未知'; }
export function timingLabel(timing, now = Date.now()) {
 if (!Number.isFinite(timing?.elapsedMs) || timing.elapsedMs < 0) return timing?.complete ? '未开始' : '暂无记录';
 const seconds = Math.floor((timing.elapsedMs + (timing.running && Number.isFinite(timing.asOf) ? Math.max(0, now-timing.asOf) : 0))/1000);
 return `${timing.complete === false ? '记录不完整，已记录 ' : ''}${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
}
export const uploadLabel = (progress, files, queued = 0) => `上传中：${formatBytes(progress.loaded)} / ${formatBytes(progress.total)} · 已完成 ${files.filter(f=>['ready','duplicate'].includes(f.status)).length} / ${files.length + queued} 张`;
export const shouldPoll = (project, generation, currentGeneration) => generation === currentGeneration && ['running','aborting'].includes(project?.state);

export function photoView(files,{filter='all',expanded=false,page=0,activeId=null}={}) {
 const selected=files.filter(f=>filter==='issues'?unfinished(f):filter==='complete'?['ready','duplicate'].includes(f.status):true);
 const count=selected.length,pages=Math.max(1,Math.ceil(count/12));
 const current=expanded?Math.min(Math.max(0,Number.isInteger(page)?page:0),pages-1):0;
 const ordered=expanded?selected:[...selected.filter(f=>f.id===activeId),...selected.filter(f=>f.id!==activeId&&unfinished(f)),...selected.filter(f=>f.id!==activeId&&!unfinished(f))];
 return {items:ordered.slice(expanded?current*12:0,expanded?(current+1)*12:6),count,pages,page:current};
}
