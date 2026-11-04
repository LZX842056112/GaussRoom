import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireCompute,computeOwner} from './lib/compute-slot.mjs';

test('capture analysis and reconstruction share one releasable compute slot',()=>{
 const release=acquireCompute({kind:'capture_analysis',id:'batch'});
 try {assert.equal(typeof release,'function');assert.deepEqual(computeOwner(),{kind:'capture_analysis',id:'batch'});assert.equal(acquireCompute({kind:'reconstruction',id:'project'}),null);}
 finally {release();}
 const next=acquireCompute({kind:'reconstruction',id:'project'});
 release();assert.equal(computeOwner().id,'project');next();assert.equal(computeOwner(),null);
});

test('callers cannot mutate the identity that owns the compute slot',()=>{
 const owner={kind:'reconstruction',id:'project'},release=acquireCompute(owner);
 try {owner.id='other';assert.equal(computeOwner().id,'project');assert.throws(()=>{computeOwner().id='other';},TypeError);}
 finally{release();}
});
