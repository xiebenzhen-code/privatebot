import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as guard from '../scripts/runner-guard.mjs';

test('054：锁里的 PID 被复用时不能接手或终止新进程', () => {
  const creation = guard.processCreationTime(process.pid);
  assert.ok(creation);
  assert.equal(guard.lockProcessAlive(process.pid, creation), true);
  assert.equal(guard.lockProcessAlive(process.pid, '旧进程的创建时间'), false);
  assert.equal(guard.decide({ pid: process.pid, creationTime: '旧进程的创建时间' }), 'take');
});

test('054 升级：旧格式锁仍按 PID 区分存活和已退出', () => {
  assert.equal(guard.decide({ pid: process.pid, guard: 99999999 }), 'adopt');
  assert.equal(guard.decide({ pid: 99999999, guard: 99999999 }), 'take');
});

test('054 创建时间查询：单次超时 15 秒，失败后重试两次', () => {
  let calls = 0;
  const run = (_command, _args, options) => {
    assert.equal(options.timeout, 15000);
    calls++;
    return calls < 3 ? { error: new Error('timeout') } : { status: 0, stdout: 'creation-stamp\n' };
  };
  assert.equal(guard.processCreationTime(process.pid, run), 'creation-stamp');
  assert.equal(calls, 3);
});
