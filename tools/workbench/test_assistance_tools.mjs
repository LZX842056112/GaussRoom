import test from 'node:test';
import assert from 'node:assert/strict';
import * as paths from './lib/paths.mjs';
test('missing geometry dependencies name the module and repair command',()=>{
 assert.equal(typeof paths.dependencyStatus,'function');
 const result=paths.dependencyStatus({force:true,probe:()=>JSON.stringify({pycolmap:{ok:false,error:'No module named pycolmap'},opencv:{ok:true,version:'5.0.0'}})});
 assert.equal(result.pycolmap.ok,false);assert.match(result.pycolmap.message,/pycolmap/);assert.match(result.pycolmap.repair,/uv sync/);
 assert.equal(result.opencv.ok,true);
});
test('a broken Python executable does not report installed dependencies',()=>{
 assert.equal(typeof paths.dependencyStatus,'function');
 const result=paths.dependencyStatus({force:true,probe:()=>{throw Error('spawn failed');}});
 assert.equal(result.pycolmap.ok,false);assert.equal(result.opencv.ok,false);
 assert.match(result.pycolmap.message,/spawn failed/);
});
