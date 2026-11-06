// 看门狗：进程「还在、但不干活」时，光等 exit 是等不到的。
// 背景：2026-11-01 凌晨 23:27 之后心跳、日志、定时器一起停，机器二十分钟后才睡眠，
// 计划任务显示「正在运行」，实际什么都没做——这种一具尸体，只能从外面的心跳文件看出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatStale, backoffMs, parseBeat } from '../scripts/runner-guard.mjs';

const now = Date.parse('2026-11-01T00:00:00.000Z');

test('心跳文件读不到算不动', () => {
  assert.equal(beatStale(null, now), true);
});

test('刚跳过的心跳不算卡住', () => {
  assert.equal(beatStale({ ts: new Date(now - 30_000).toISOString() }, now), false);
  assert.equal(beatStale({ ts: new Date(now - 4 * 60_000).toISOString() }, now), false);
});

test('超过 5 分钟没跳就算卡住', () => {
  assert.equal(beatStale({ ts: new Date(now - 5 * 60_000 - 1).toISOString() }, now), true);
  assert.equal(beatStale({ ts: new Date(now - 40 * 60_000).toISOString() }, now), true);
});

test('时间戳坏了也按卡住处理，不猜', () => {
  assert.equal(beatStale({ ts: '不是时间' }, now), true);
  assert.equal(beatStale({}, now), true);
});

test('阈值可以调，便于测试和临时放宽', () => {
  assert.equal(beatStale({ ts: new Date(now - 90_000).toISOString() }, now, 60_000), true);
  assert.equal(beatStale({ ts: new Date(now - 90_000).toISOString() }, now, 120_000), false);
});

test('连续快速退出时间隔递增，且有上限', () => {
  assert.equal(backoffMs(0), 5_000);
  assert.equal(backoffMs(1), 10_000);
  assert.equal(backoffMs(2), 20_000);
  assert.equal(backoffMs(3), 40_000);
  assert.equal(backoffMs(4), 60_000);
  assert.equal(backoffMs(9), 60_000);
});

test('心跳文件带 BOM 也读得出来，别把「能读」误报成「从没写过」', () => {
  const json = '{"ts":"2026-10-31T16:46:58.426Z","pid":33432}';
  assert.deepEqual(parseBeat('\uFEFF' + json), { ts: '2026-10-31T16:46:58.426Z', pid: 33432 });
  assert.deepEqual(parseBeat(json), { ts: '2026-10-31T16:46:58.426Z', pid: 33432 });
});

test('空文件或坏 JSON 返回 null，由 beatStale 判成卡住', () => {
  assert.equal(parseBeat(''), null);
  assert.equal(parseBeat('不是 json'), null);
  assert.equal(parseBeat(null), null);
});
