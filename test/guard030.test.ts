// 030：执行器自启的单实例守卫。
// 起因：计划任务和手动启动撞在一起时靠「命令行里有没有 runner.mjs」判断，--check 会被误伤；
// 而且两个 runner 同时在线会各领一个任务并行跑，同一份额度花两遍。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { alive, decide } from '../scripts/runner-guard.mjs';

describe('030 单实例守卫', () => {
  test('没有锁就接管', () => {
    assert.equal(decide(null), 'take');
    assert.equal(decide(undefined), 'take');
    assert.equal(decide('not-an-object'), 'take');
  });

  test('锁里的进程还活着就跳过', () => {
    assert.equal(decide({ pid: 4242, startedAt: '2026-10-31T00:00:00Z' }, () => true), 'skip');
  });

  test('锁里的进程已经不在就接管', () => {
    assert.equal(decide({ pid: 4242 }, () => false), 'take');
  });

  test('pid 不是正整数一律当作没有锁', () => {
    // 这里用默认的 alive 判断，验证非法 pid 进不了“有人在跑”那一支。
    for (const pid of ['abc', '', null, undefined, -1, 0, 1.5]) {
      assert.equal(decide({ pid }), 'take', `pid=${String(pid)} 不该被当成占位者`);
    }
  });

  test('alive：非法 pid、自己、明显不存在的 pid', () => {
    assert.equal(alive(0), false);
    assert.equal(alive(-5), false);
    assert.equal(alive(Number.NaN), false);
    assert.equal(alive('abc'), false);
    assert.equal(alive(process.pid), false, '自己不算占位者');
    assert.equal(alive(999_999), false);
  });

  test('alive：父进程在就是活着（EPERM 也算）', () => {
    if (!process.ppid) return;
    assert.equal(alive(process.ppid), true);
  });
});
