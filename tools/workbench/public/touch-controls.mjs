/** Camera deltas from stable pointer identities. A count change starts a new gesture. */
export function touchDelta(before, after) {
  const empty = {orbit:[0,0], pan:[0,0], zoom:1};
  if (before.size !== after.size || after.size < 1 || after.size > 2
      || [...after.keys()].some(id => !before.has(id))) return empty;
  const ids = [...after.keys()];
  const old = ids.map(id => before.get(id)), next = ids.map(id => after.get(id));
  if (![...old,...next].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return empty;
  if (ids.length === 1) return {...empty, orbit:[next[0].x-old[0].x,next[0].y-old[0].y]};
  const previousDistance = Math.hypot(old[1].x-old[0].x,old[1].y-old[0].y);
  const distance = Math.hypot(next[1].x-next[0].x,next[1].y-next[0].y);
  if (previousDistance < 1 || distance < 1) return empty;
  return {orbit:[0,0],pan:[(next[0].x+next[1].x-old[0].x-old[1].x)/2,
    (next[0].y+next[1].y-old[0].y-old[1].y)/2],zoom:previousDistance/distance};
}

export function installTouchGestures(canvas, {orbit,pan,zoom}) {
  const points = new Map();
  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    event.preventDefault();points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!points.has(event.pointerId)) return;
    event.preventDefault();const before = new Map(points);
    points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const delta = touchDelta(before,points);
    orbit(...delta.orbit);pan(...delta.pan);zoom(delta.zoom);
  });
  const end = event => points.delete(event.pointerId);
  for (const type of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(type,end);
}
