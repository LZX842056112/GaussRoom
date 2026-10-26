import test from 'node:test';
import assert from 'node:assert/strict';
import { screenRadiusLimit } from './public/render-limits.mjs';

test('walking inside the scene retains a viewport sized Gaussian footprint',()=>{
  const limit=screenRadiusLimit({width:800,height:600,pixelRatio:1,sceneRadius:5,cameraDistance:4});
  assert.ok(limit>=1000,'A nearby surface must retain support across the viewport diagonal');
});

test('high density displays retain physical pixel coverage',()=>{
  assert.ok(screenRadiusLimit({width:800,height:600,pixelRatio:2,sceneRadius:5,cameraDistance:0})>=2000);
});

test('a distant overview retains the small footprint used to limit floating streaks',()=>{
  assert.ok(screenRadiusLimit({width:800,height:600,pixelRatio:1,sceneRadius:5,cameraDistance:15})<=32);
});

test('limits depend on camera position relative to scene scale',()=>{
  const view={width:800,height:600,pixelRatio:1};
  assert.equal(screenRadiusLimit({...view,sceneRadius:1,cameraDistance:1.8}),
    screenRadiusLimit({...view,sceneRadius:1000,cameraDistance:1800}));
  assert.ok(screenRadiusLimit({...view,sceneRadius:5,cameraDistance:0})>
    screenRadiusLimit({...view,sceneRadius:5,cameraDistance:9}));
});

test('the transition from walking to overview is continuous and nonincreasing',()=>{
  const view={width:800,height:600,pixelRatio:1,sceneRadius:5};
  const values=[0,5,6,7,8,9,10,11,12,15].map(cameraDistance=>screenRadiusLimit({...view,cameraDistance}));
  assert.ok(values.every((value,index)=>index===0||value<=values[index-1]));
  assert.ok(Math.abs(screenRadiusLimit({...view,cameraDistance:6-.0001})-
    screenRadiusLimit({...view,cameraDistance:6+.0001}))<.001);
});

test('missing scene scale uses a finite conservative walking limit',()=>{
  const limit=screenRadiusLimit({width:320,height:320,pixelRatio:1,sceneRadius:NaN,cameraDistance:NaN});
  assert.ok(Number.isFinite(limit)&&limit>=452);
});
