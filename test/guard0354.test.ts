// 035.4：守卫的两处回归——「合法长操作被当卡死」和「重启之后停止信号打空」。
//
// 两条都不是读代码看出来的假设，是独立审查用真子进程复现的。这里照同样的路子钉住，
// 全部走真 guard + 真子进程，只是把巡检节奏和重启间隔调小（真机仍是 30 秒 / 5 秒）：
//   1. 合法长命令（主线程被 spawnSync 钉住）长过心跳阈值：不杀，而且能跑完；
//   2. 真卡死（心跳停了、也没有忙声明）：照杀照重启；
//   3. 自动重启之后收到 SIGTERM：停的是**现在活着的那个**，不是第一个死进程；
//   4. 重启间隙里收到 SIGTERM：直接收工，不许过一会儿又冒出一个新子进程。
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCreationTime } from '../scripts/runner-guard.mjs';

const GUARD = fileURLToPath(new URL('../scripts/runner-guard.mjs', import.meta.url));

/**
 * 2026-11-11：守卫起一次，要先**同步**查三次进程创建时间（`powershell -Command Get-CimInstance
 * Win32_Process`）：自己、父进程、刚 spawn 的那个；判锁时再查两次。这台机器（Win11 26200，
 * 2026-11 累积安全更新之后）单次 2.3–2.5 秒，而且第二次起常返回空、触发重试，于是「起一次守卫」
 * 从几十毫秒变成 5–12 秒。原来按「毫秒级」写的 8/10 秒预算，会把「还在查创建时间」误判成
 * 「守卫不干活」——测试红了，守卫本身没问题。
 *
 * 这里在进程里量一次真实代价，把「等守卫起来」的预算按它算出来：机器快，预算自然就小。
 */
function startupBudget(): number {
  const t0 = Date.now();
  try { processCreationTime(process.pid); } catch { /* 查不到也量得出耗时 */ }
  // 单次超过 5 秒就按 5 秒算：WMI 真坏掉时不要把等待放大成几分钟的空等。
  const one = Math.min(5_000, Math.max(200, Date.now() - t0));
  // 一次启动 3 次查询 + 判锁 2 次，按每次都可能重试一轮算，另外留 8 秒给真正的逻辑。
  // 本机单次 2.4 秒 → 32 秒；WMI 秒回的机器 → 10 秒，和原来的量级一致。
  return 10 * one + 8_000;
}
const STARTUP_MS = startupBudget();
/**
 * Windows 上 `child.kill('SIGTERM')` 直接 TerminateProcess，进程里的处理器根本收不到
 * （本机实测：handler 没跑，exit 报 SIGTERM）。所以「停止信号」这两条只能在 Linux 上用真信号验；
 * Windows 上退化成 stopPlan 的单元用例——判定逻辑一样，只是平台不给真信号。
 */
const STOP_SKIP = process.platform === 'win32'
  ? 'Windows 的 kill() 是 TerminateProcess，收不到 SIGTERM；这条在 Linux 上跑'
  : false;
const TMP: string[] = [];
const live: ChildProcess[] = [];

after(() => {
  for (const c of live) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows 锁文件 */ } }
});

const FAKE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const STATE = process.env.WB_RUNNER_STATE;
const MODE = process.env.FAKE_MODE ?? 'stay';
const beat = () => writeFileSync(join(STATE, 'runner.beat'), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }), 'utf8');
const mark = (name) => writeFileSync(join(STATE, name), String(process.pid), 'utf8');

if (MODE === 'long-busy') {
  // 2026-11-11：守卫 spawn 完 runner 才去查创建时间、才挂上巡检定时器（本机 2–7 秒）。
  // 原来这里不等就钉主线程，2.6 秒的忙窗整段落在守卫的盲窗里，断言「先不杀」永远看不到——
  // 测的其实是「守卫起得多快」。现在先写心跳和忙声明，等锁里出现自己（= 守卫已经进入巡检），
  // 再把主线程真钉住 2.6 秒，让「忙」和「巡检」确实撞上。
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const owned = () => {
    try { return JSON.parse(readFileSync(join(STATE, 'runner.lock'), 'utf8')).pid === process.pid; } catch { return false; }
  };
  beat();
  for (let i = 0; i < 1200 && !owned(); i++) sleep(50); // 最多等 60 秒；最坏情况（3 次查询 × 3 次重试）约 22 秒
  beat();
  writeFileSync(join(STATE, 'runner.busy'), JSON.stringify({
    pid: process.pid, until: new Date(Date.now() + 60000).toISOString(), why: '测试用的长命令',
  }), 'utf8');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 2600)']);
  beat();
  mark('finished.mark');
  process.exit(0);
} else if (MODE === 'hang') {
  // 只写一次心跳，之后就装死——这才是「进程还在、但不干活」
  beat();
  setInterval(() => {}, 1000);
} else if (MODE === 'restart-then-stay') {
  if (!existsSync(join(STATE, 'restarted.mark'))) { mark('restarted.mark'); process.exit(1); }
  beat();
  setInterval(beat, 100);
} else if (MODE === 'exit-fast') {
  mark('first.mark');
  process.exit(0);
} else {
  beat();
  setInterval(beat, 100);
}
`;

/** 搭一个隔离的仓库 + 状态目录，返回可以起 guard 的材料。 */
function stage(mode: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-guard-0354-'));
  TMP.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(repo, 'scripts', 'runner.mjs'), FAKE, 'utf8');
  const log: string[] = [];
  const child = spawn(process.execPath, [GUARD], {
    env: { ...process.env, WB_RUNNER_REPO: repo, WB_RUNNER_STATE: state, FAKE_MODE: mode, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.push(child);
  child.stdout?.on('data', (d) => log.push(d.toString()));
  child.stderr?.on('data', (d) => log.push(d.toString()));
  return { repo, state, child, text: () => log.join(''), lock: () => readLock(state) };
}

function readLock(state: string): number {
  try { return Number(JSON.parse(readFileSync(join(state, 'runner.lock'), 'utf8')).pid) || 0; } catch { return 0; }
}

const text_ = (state: string) => {
  try { return readFileSync(join(state, 'runner-autostart.log'), 'utf8'); } catch { return ''; }
};

const isAlive = (pid: number) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(what: () => boolean, ms = STARTUP_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function stop(child: ChildProcess, ms = 5000): Promise<boolean> {
  try { child.kill('SIGTERM'); } catch { return true; }
  return waitFor(() => child.exitCode !== null || child.signalCode !== null, ms);
}

describe('035.4 忙声明本身：有界才算数', () => {
  test('只认「同一个 pid + 没到期 + 没离谱地远」', async () => {
    const { busyValid } = await import('../scripts/runner-guard.mjs');
    const now = Date.parse('2026-11-01T10:00:00Z');
    const at = (sec: number, pid = 42) => ({ pid, until: new Date(now + sec * 1000).toISOString() });
    assert.equal(busyValid(at(300), 42, now), true);
    assert.equal(busyValid(at(-1), 42, now), false, '过期了就不算');
    assert.equal(busyValid(at(300, 7), 42, now), false, '别人的声明不算');
    assert.equal(busyValid({ pid: 42, until: 'not-a-date' }, 42, now), false);
    assert.equal(busyValid(at(3600), 42, now), false, '超过 15 分钟的上限，不认——忙不能变成永远不杀');
    assert.equal(busyValid(null, 42, now), false);
  });
});

describe('035.4-1 合法长命令：心跳停住也不杀', () => {
  test('主线程被钉住 2.6 秒（阈值 0.4 秒）仍然跑完，日志写明「先不杀」', async () => {
    const s = stage('long-busy', { WB_BEAT_STALE_MS: '400', WB_DOG_MS: '800', WB_BACKOFF_MS: '8000' });
    const done = await waitFor(() => existsSync(join(s.state, 'finished.mark')), STARTUP_MS);
    const log = text_(s.state);
    assert.equal(done, true, `长命令没跑完，日志：\n${log}`);
    assert.match(log, /先不杀/, '守卫应该认出这是忙，不是死');
    assert.equal(/杀掉重开/.test(log), false, '合法的活不许被砍');
    await stop(s.child);
  });

  test('真卡死（没声明）照杀照重启', async () => {
    const s = stage('hang', { WB_BEAT_STALE_MS: '300', WB_DOG_MS: '800', WB_BACKOFF_MS: '300' });
    // 先等守卫把锁发出来——那表示三次同步查询已经做完、巡检定时器挂上了。
    // 从这一刻起算「多久该杀掉」，而不是从 spawn 算，否则等的是守卫起得多快。
    assert.ok(await waitFor(() => s.lock() > 0, STARTUP_MS), `守卫应该先接管，日志：\n${text_(s.state)}`);
    const firstPid = s.lock();
    const killed = await waitFor(() => /杀掉重开/.test(text_(s.state)), STARTUP_MS);
    const log = text_(s.state) + `\n[debug] guard=${s.child.exitCode}/${s.child.signalCode} files=${existsSync(s.state) ? (readdirSync(s.state).join(',')) : '?'}`;
    assert.equal(killed, true, `真卡死必须被杀，日志：\n${log}`);
    // 认「换了个新的 pid」而不是「锁里有个 pid」——旧锁要等 exit 才清，光看有没有值会当场为真。
    // 一次读出来再比：读两次的话，两次之间撞上 unlink 会返回 0，反而误判成「换了新的」。
    const restarted = await waitFor(() => { const p = s.lock(); return p > 0 && p !== firstPid; }, STARTUP_MS);
    assert.equal(restarted, true, `杀掉之后应该重启了一个新的，日志：\n${text_(s.state)}`);
    await stop(s.child);
  });
});

describe('035.4-2 停止信号：打的是现在活着的那个', () => {
  test('stopPlan：认「当前」那个，不认闭包里那个已经死掉的', async () => {
    const { stopPlan } = await import('../scripts/runner-guard.mjs');
    // 回归现场：第一个子进程（111）已经死了，第二个（222）活着。旧代码的监听器还攥着 111。
    assert.deepEqual(stopPlan({ pid: 222 }, () => true), { kill: 222, exit: false });
    assert.deepEqual(stopPlan({ pid: 111 }, () => false), { kill: 0, exit: true }, '当前那个也死了，就别再 kill 一个空 pid');
    assert.deepEqual(stopPlan(null, () => true), { kill: 0, exit: true }, '重启间隙：没有子进程，直接收工');
  });

  test('重启过一次之后 SIGTERM：新子进程真的停掉，不留孤儿', { skip: STOP_SKIP }, async () => {
    const s = stage('restart-then-stay', { WB_BEAT_STALE_MS: '5000', WB_DOG_MS: '1000', WB_BACKOFF_MS: '500' });
    const second = await waitFor(() => s.lock() > 0 && /启动 runner/.test(text_(s.state)) && (text_(s.state).match(/启动 runner/g) ?? []).length >= 2, 9000);
    assert.equal(second, true, `没等到第二次启动，日志：\n${text_(s.state)}`);
    const pid = s.lock();
    assert.ok(isAlive(pid), '第二个子进程应该是活着的');
    const exited = await stop(s.child);
    assert.equal(exited, true, '守卫收到 SIGTERM 应该退出');
    const gone = await waitFor(() => !isAlive(pid), 4000);
    assert.equal(gone, true, `守卫自己退了，但活着的 runner（pid ${pid}）还在——这就是这次要修的那个洞`);
    assert.match(text_(s.state), new RegExp(`结束 runner(?: 整棵进程树)?（pid ${pid}）`), '日志要指向真正被停的那个 pid');
  });

  test('重启间隙里 SIGTERM：直接收工，不许过一会儿又冒出来', { skip: STOP_SKIP }, async () => {
    const s = stage('exit-fast', { WB_BEAT_STALE_MS: '5000', WB_DOG_MS: '1000', WB_BACKOFF_MS: '900' });
    const gap = await waitFor(() => /秒后重开/.test(text_(s.state)), 8000);
    assert.equal(gap, true, `没进到重启间隙，日志：\n${text_(s.state)}`);
    const exited = await stop(s.child, 3000);
    assert.equal(exited, true, '间隙里收到停止也要结束，不能等重启定时器');
    await new Promise((r) => setTimeout(r, 1600)); // 等过原本该重启的时刻
    const starts = (text_(s.state).match(/启动 runner/g) ?? []).length;
    assert.equal(starts, 1, `停止之后不许再启动，实际启动 ${starts} 次`);
    assert.equal(s.lock(), 0, '锁应该已经被清掉');
  });
});
