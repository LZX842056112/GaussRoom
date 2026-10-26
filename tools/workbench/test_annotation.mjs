import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('./public/annotation-coordinates.mjs').catch(()=>({}));
test('work pixels round trip through letterbox, pan, zoom and resize',()=>{
 assert.equal(typeof mod.viewToImage,'function');assert.equal(typeof mod.imageToView,'function');
 for(const [width,height,zoom,pan] of [[800,600,1,{x:0,y:0}],[320,600,2,{x:30,y:-70}],[1200,300,.5,{x:-20,y:55}],[320,500,1.5,{x:15,y:30}]]){
  const rect={x:15,y:20,width,height},t={rect,workWidth:1000,workHeight:800,zoom,pan};
  const xy=mod.viewToImage(mod.imageToView([153,287],t),t);
  assert.ok(Math.abs(xy[0]-153)<1e-6&&Math.abs(xy[1]-287)<1e-6);
 }
 const t={rect:{x:100,y:0,width:300,height:400},workWidth:600,workHeight:800,zoom:1,pan:{x:0,y:0}};
 assert.equal(mod.viewToImage({x:20,y:50},t),null);
 assert.equal(mod.viewToImage({x:400,y:400},t),null);
});
