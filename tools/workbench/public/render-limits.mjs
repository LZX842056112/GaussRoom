// A fixed small pixel footprint shrinks valid surfaces as the camera approaches.
// Keep screen sized support while walking; retain the old limit for overviews.
export function screenRadiusLimit({width,height,pixelRatio=1,sceneRadius,cameraDistance}) {
  const positive=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;
  const walking=Math.max(512,Math.hypot(positive(width,1),positive(height,1))*positive(pixelRatio,1));
  const radius=positive(sceneRadius,4);
  const distance=Number.isFinite(cameraDistance)?Math.max(0,cameraDistance):0;
  const t=Math.max(0,Math.min(1,(distance/radius-1.2)/1.2));
  const blend=t*t*(3-2*t);
  return walking+(32-walking)*blend;
}
