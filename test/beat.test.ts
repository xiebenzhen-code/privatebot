// 心跳失败要不要记日志。背景：2026-10-31 一天撞到两次「心跳停了两三个小时、日志一个字都没有」，
// 只能靠库里 last_seen 停住才发现。这里钉住节流规则，既别一次不记，也别每 30 秒刷一行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldLogBeat } from '../scripts/runner.mjs';

test('第一次失败一定记', () => {
  assert.equal(shouldLogBeat(1), true);
});

test('紧接着的失败不记，免得每 30 秒刷一行', () => {
  for (const n of [2, 3, 5, 19]) assert.equal(shouldLogBeat(n), false, `${n} 不该记`);
});

test('每 20 次记一条（约 10 分钟一条）', () => {
  for (const n of [20, 40, 60, 120]) assert.equal(shouldLogBeat(n), true, `${n} 应该记`);
});

test('20 的整数倍前后不会连带刷屏', () => {
  assert.equal(shouldLogBeat(21), false);
  assert.equal(shouldLogBeat(39), false);
  assert.equal(shouldLogBeat(41), false);
});

test('0 次不算失败', () => {
  assert.equal(shouldLogBeat(0), false);
});
