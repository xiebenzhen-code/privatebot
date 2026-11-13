// 054：执行器掉线之后的看护，以及「停止任务后 node 游离」的两块地基。
//
// 现场（2026-11-06）：工作台重建前后，执行器的 guard 和 runner 一起消失，
// `runner-autostart.log` 里没有「runner 退出」也没有「收到 SIGINT」——JS 层根本没执行。
// `Stop-ScheduledTask` 只 TerminateProcess 了最外层 powershell，node 这一层成了孤儿：
// 任务显示 Ready，进程还在后台跑，下一次 Start 被锁挡住，看起来重启过了其实什么都没换。
//
// 这里只测纯逻辑（不拉真进程）；「外层被杀 → 守卫带整棵树收工」在 guard0355.test.ts 里用真进程验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { killTree, parentVanished } from '../scripts/runner-guard.mjs';
import { beatAge, check, STALE_MS, QUIET_MS } from '../scripts/watch-runner.mjs';

const sec = (n: number) => n * 1000;

test('054 看护：心跳新鲜就不动手', () => {
  const now = Date.now();
  const v = check({ beat: { ts: new Date(now - sec(20)).toISOString() }, lock: { pid: 10 } }, { now, isAlive: () => true });
  assert.equal(v.ok, true);
  assert.equal(v.restart, false);
  assert.equal(v.age, sec(20));
});

test('054 看护：心跳停了、进程也没了 → 拉起来', () => {
  const now = Date.now();
  const v = check({ beat: { ts: new Date(now - sec(200)).toISOString() }, lock: { pid: 10 } }, { now, isAlive: () => false });
  assert.equal(v.ok, false);
  assert.equal(v.restart, true);
  assert.equal(v.runnerAlive, false);
  assert.match(v.reason, /心跳停在 200 秒前/);
});

test('054 看护：没有心跳文件也算「该拉」', () => {
  const now = Date.now();
  const v = check({ beat: null, lock: null }, { now, isAlive: () => false });
  assert.equal(v.restart, true);
  assert.equal(v.age, null);
  assert.match(v.reason, /没有心跳/);
});

test('054 看护：刚拉过一次就先等，别一分钟连拉三次', () => {
  const now = Date.now();
  const v = check(
    { beat: { ts: new Date(now - sec(120)).toISOString() }, lock: null, lastRestartAt: now - sec(30) },
    { now, isAlive: () => false },
  );
  assert.equal(v.restart, false);
  assert.match(v.reason, /30 秒前刚拉过一次/);

  // 过了静默期就该再拉一次
  const later = check(
    { beat: { ts: new Date(now - sec(120)).toISOString() }, lock: null, lastRestartAt: now - sec(600) },
    { now, isAlive: () => false },
  );
  assert.equal(later.restart, true);
});

test('054 看护：90 秒 / 5 分钟是默认线', () => {
  assert.equal(STALE_MS, 90_000);
  assert.equal(QUIET_MS, 300_000);
  const now = Date.now();
  // 正好压在线上：90 秒整还算活着，多 1 毫秒才算死
  assert.equal(beatAge({ ts: new Date(now - STALE_MS).toISOString() }, now), STALE_MS);
  assert.equal(check({ beat: { ts: new Date(now - STALE_MS).toISOString() } }, { now }).ok, true);
  assert.equal(check({ beat: { ts: new Date(now - STALE_MS - 1).toISOString() } }, { now }).ok, false);
});

test('054 看护：心跳时间戳坏了、BOM、空文件都不当成活着', () => {
  const now = Date.now();
  assert.equal(beatAge(null, now), null);
  assert.equal(beatAge({ ts: 'not-a-date' }, now), null);
  assert.equal(beatAge({}, now), null);
  assert.equal(check({ beat: {} }, { now }).restart, true);
});

test('054 killTree：Windows 走 taskkill /T /F，整棵带走', () => {
  const calls: unknown[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { status: 0 };
  };
  assert.equal(killTree(4321, { platform: 'win32', run }), true);
  assert.deepEqual(calls, [['taskkill', '/PID', '4321', '/T', '/F']]);

  // 非法 pid 不该去调外部命令
  const again: unknown[][] = [];
  const run2 = (cmd: string, args: string[]) => {
    again.push([cmd, ...args]);
    return { status: 0 };
  };
  for (const bad of [0, -1, 1.5, Number.NaN, 'abc']) {
    assert.equal(killTree(bad, { platform: 'win32', run: run2 }), false, `pid=${String(bad)}`);
  }
  assert.equal(again.length, 0);
});

test('054 parentVanished：父进程不在才算，自己 / 0 / 非法值都不算', async () => {
  assert.equal(parentVanished(process.ppid), false, '父进程在');
  assert.equal(parentVanished(0), false);
  assert.equal(parentVanished(-3), false);
  assert.equal(parentVanished(process.pid), false, '自己不算');

  const dead = await deadPid();
  assert.equal(parentVanished(dead), true, '早就退出的 pid 算不在');
});

/** 拿一个确定已经退出的 pid。 */
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = p.pid as number;
  await new Promise<void>((r) => p.once('exit', () => r()));
  return pid;
}

test('054 看护：自己的有效忙声明不记事故、不重启', () => {
  const now = Date.now();
  const base = { beat: { ts: new Date(now - sec(200)).toISOString() }, lock: { pid: 10 } };
  const valid = { pid: 10, until: new Date(now + sec(300)).toISOString() };
  assert.equal(check({ ...base, busy: valid }, { now, isAlive: () => true }).ok, true);
  assert.equal(check({ ...base, busy: valid }, { now, isAlive: () => true }).restart, false);
  for (const busy of [{ ...valid, pid: 11 }, { ...valid, until: new Date(now - 1).toISOString() }]) {
    assert.equal(check({ ...base, busy }, { now, isAlive: () => true }).restart, true);
  }
  assert.equal(check({ ...base, busy: valid }, { now, isAlive: () => false }).restart, true);
});
