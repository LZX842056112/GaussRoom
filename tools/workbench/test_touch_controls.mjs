import test from 'node:test';
import assert from 'node:assert/strict';
import {touchDelta} from './public/touch-controls.mjs';
const fingers=(...points)=>new Map(points.map(([id,x,y])=>[id,{x,y}]));
test('single touch rotates and a two finger pan does not rotate',()=>{
 assert.deepEqual(touchDelta(fingers([1,10,20]),fingers([1,30,15])),{orbit:[20,-5],pan:[0,0],zoom:1});
 assert.deepEqual(touchDelta(fingers([1,0,0],[2,10,0]),fingers([1,4,6],[2,14,6])),{orbit:[0,0],pan:[4,6],zoom:1});
});
test('pinch distance changes zoom with a stable midpoint',()=>{
 assert.deepEqual(touchDelta(fingers([1,0,0],[2,10,0]),fingers([1,-5,0],[2,15,0])),{orbit:[0,0],pan:[0,0],zoom:0.5});
});
test('adding or removing a finger resets gesture deltas without a camera jump',()=>{
 const zero={orbit:[0,0],pan:[0,0],zoom:1};
 assert.deepEqual(touchDelta(fingers([1,10,20]),fingers([1,10,20],[2,200,300])),zero);
 assert.deepEqual(touchDelta(fingers([1,10,20],[2,200,300]),fingers([1,12,20])),zero);
 assert.deepEqual(touchDelta(fingers([1,0,0]),fingers([2,100,300])),zero);
 assert.deepEqual(touchDelta(fingers([1,0,0],[2,0,0]),fingers([1,0,0],[2,1,0])),zero);
});
