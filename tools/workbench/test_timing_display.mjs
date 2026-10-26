import assert from 'node:assert/strict';
import test from 'node:test';
import * as display from './public/timing.mjs';

test('duration display supports seconds, minutes and runs longer than a day', () => {
  assert.equal(typeof display.formatDuration,'function');
  for(const [ms,want] of [[0,'0 秒'],[850,'不足 1 秒'],[61_000,'1 分 1 秒'],
    [3_661_000,'1 小时 1 分 1 秒'],[90_000_000,'25 小时 0 分 0 秒'],[null,'—'],[NaN,'—']]){
    assert.equal(display.formatDuration(ms),want);
  }
});

test('only a running server sample advances on a display tick', () => {
  assert.equal(typeof display.elapsedTiming,'function');
  const sample={elapsedMs:12_000,asOf:100_000,running:true,complete:true};
  assert.equal(display.elapsedTiming(sample,105_000),17_000);
  assert.equal(display.elapsedTiming({...sample,running:false},105_000),12_000);
  assert.equal(display.elapsedTiming(sample,95_000),12_000);
  assert.equal(display.elapsedTiming({elapsedMs:null},105_000),null);
});

test('missing timing is distinct from an unstarted stage and incomplete records are identified', () => {
  assert.equal(typeof display.timingLabel,'function');
  assert.equal(display.timingLabel({elapsedMs:null,complete:true,running:false}),'未开始');
  assert.equal(display.timingLabel({elapsedMs:null,complete:false,running:false}),'暂无记录');
  assert.equal(display.timingLabel({elapsedMs:75_000,complete:false,running:false}),'已记录 1 分 15 秒');
  assert.equal(display.timingLabel({elapsedMs:75_000,complete:true,running:false}),'1 分 15 秒');
});
