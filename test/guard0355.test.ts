import { processCreationTime } from '../scripts/runner-guard.mjs';
// 035.5：守卫被强杀以后，接班的那一个必须把看门狗接过去。
//
// 真实事故形状：Stop-ScheduledTask 只带走了守卫，detached 的 runner 还活着，锁里写的 guard 已经死了。
// 下一个守卫读到「runner 活着」就 skip → 留下一个活着但没人看的执行器，卡死了也不会有人重开。
// 这组用真进程验三件事：接班者会 adopt、adopt 期间不会双开、旧 runner 卡死后会被杀掉重开。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/runner-guard.mjs', import.meta.url));
const TMP: string[] = [];
const live: ChildProcess[] = [];

after(() => {
  for (const c of live) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of TMP) {
    try {
      for (const pid of readFileSync(join(d, 'state', 'starts'), 'utf8').trim().split(String.fromCharCode(10)).map(Number)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 测试 runner 已退出 */ }
      }
    } catch { /* 没有启动过 runner */ }
  }
  for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows 锁 */ } }
});

/** 假 runner：'hang' 跳 FAKE_BEATS 下就冻住（活着但卡死）；'stay' 一直跳。 */
const FAKE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const STATE = process.env.WB_RUNNER_STATE;
try {
  for (const pid of readFileSync(join(STATE, 'starts'), 'utf8').trim().split(String.fromCharCode(10)).map(Number)) {
    try { process.kill(pid, 0); appendFileSync(join(STATE, 'overlap'), String(pid)); } catch {}
  }
} catch {}
appendFileSync(join(STATE, 'starts'), String(process.pid) + String.fromCharCode(10));
const beat = () => writeFileSync(join(STATE, 'runner.beat'), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }), 'utf8');
beat();
if ((process.env.FAKE_MODE ?? 'hang') === 'stay') {
  setInterval(beat, 100);
} else {
  // 043：默认只跳 1 下就冻住；要留出观察窗口时把 FAKE_BEATS 调大。
  let n = 0;
  const beats = Number(process.env.FAKE_BEATS ?? '1');
  const t = setInterval(() => {
    if (++n >= beats) { clearInterval(t); return; }
    beat();
  }, 100);
  setInterval(() => {}, 1000);
}
`;

function stage(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'wb-guard-0355-'));
  TMP.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(repo, 'scripts', 'runner.mjs'), FAKE, 'utf8');
  const start = (extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [GUARD], {
      env: {
        ...process.env, WB_RUNNER_REPO: repo, WB_RUNNER_STATE: state, FAKE_MODE: mode,
        // 巡检和心跳阈值调到毫秒级，不然一条用例要等半分钟
        WB_DOG_MS: '150', WB_BEAT_STALE_MS: '600', WB_BACKOFF_MS: '100',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.push(child);
    return child;
  };
  return { state, repo, start };
}

const readLockRaw = (state: string) => {
  try { return JSON.parse(readFileSync(join(state, 'runner.lock'), 'utf8')); } catch { return null; }
};
const logText = (state: string) => {
  try { return readFileSync(join(state, 'runner-autostart.log'), 'utf8'); } catch { return ''; }
};
const isAlive = (pid: number) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * 2026-11-11：守卫起一次要同步查三次进程创建时间（自己/父进程/runner），判锁时再查两次。
 * 这台机器单次 2.3–2.5 秒、还常返回空再重试，一次启动 5–12 秒——原来 10 秒的默认等待
 * 会把「还在查」判成「B 不退出」。这里量一次真实代价，把预算按它算出来。
 */
function startupBudget(): number {
  const t0 = Date.now();
  try { processCreationTime(process.pid); } catch { /* 查不到也量得出耗时 */ }
  // 单次超过 5 秒就按 5 秒算：WMI 真坏掉时不要把等待放大成几分钟的空等。
  const one = Math.min(5_000, Math.max(200, Date.now() - t0));
  return 10 * one + 8_000;
}
const STARTUP_MS = startupBudget();

async function waitFor(what: () => boolean, ms = STARTUP_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// decide() 的两态（2026-11-06 收窄）：没有锁 / runner 不在 → take；runner 还活着 → adopt。
// 原来「runner 和守卫都在」是 skip，事故证明那一支只会让孤儿进程没人接。
test('decide 只分「有人跑」和「没人跑」', async () => {
  const { decide } = await import('../scripts/runner-guard.mjs');
  const only = (...pids: number[]) => (pid: number) => pids.includes(Number(pid));
  assert.equal(decide(null), 'take');
  assert.equal(decide({ pid: 10, guard: 20 }, only(20)), 'take', 'runner 不在就正常起');
  assert.equal(decide({ pid: 10, guard: 20 }, only(10, 20)), 'skip', '两个都在：保留现有监护');
  assert.equal(decide({ pid: 10, guard: 20 }, only(10)), 'adopt', 'runner 在、守卫不在：接手');
  assert.equal(decide({ pid: 10 }, only(10)), 'adopt', '老锁里没有 guard 字段，也算没人看');
  assert.equal(decide({ pid: 10, guard: 20, guardParent: 30 }, only(10, 20)), 'take', '父进程已退出就换新 runner');
  assert.equal(decide({ pid: 10, guard: 20, guardParent: 30 }, only(10, 20, 30)), 'skip', '父进程还在时保留现有监护');
});

test('守卫被杀：Windows 上 runner 跟着走（043 不再 detached），接班者不会双开', async () => {
  const { state, start } = stage('hang');
  // 先让 A 别因为心跳冻住去杀 runner —— 这条只关心「守卫死的那一刻 runner 在不在」。
  const guardA = start({ WB_BEAT_STALE_MS: '60000' });
  assert.ok(await waitFor(() => readLockRaw(state)?.pid), '第一个守卫应该起了一个 runner');
  const first = readLockRaw(state);
  const runnerPid = Number(first.pid);
  assert.equal(Number(first.guard), guardA.pid, '锁里记着自己的 pid');

  guardA.kill('SIGKILL');
  assert.ok(await waitFor(() => !isAlive(guardA.pid), 4000), '守卫确实死了');

  if (process.platform === 'win32') {
    // 043 B：runner 挂在守卫的控制台上，守卫被 TerminateProcess 带走时 runner 一起没。
    // 于是「活着但没人看」的孤儿在 Windows 上不会出现——这是换来的好处，不能当没发生。
    assert.ok(await waitFor(() => !isAlive(runnerPid), 8000), 'Windows 上 runner 应该跟着守卫一起没');
    const guardB = start();
    assert.ok(await waitFor(() => /锁里的 pid \d+ 已经不在，接管/.test(logText(state))), '接班者要说明自己接管');
    assert.ok(await waitFor(() => Number(readLockRaw(state)?.pid) > 0 && Number(readLockRaw(state)?.pid) !== runnerPid), '应该起一个新的');
    const second = readLockRaw(state);
    assert.equal(isAlive(Number(second.pid)), true, '新的那个在跑');
    assert.equal(Number(second.guard), guardB.pid, '锁里的守卫是自己');
  } else {
    // POSIX 上 runner 是自己的进程组，守卫死了它还活着——必须接手，不能双开。
    assert.equal(isAlive(runnerPid), true, 'detached 的 runner 还活着（这正是问题现场）');
    const guardB = start();
    assert.ok(await waitFor(() => /接手监护/.test(logText(state))), '接班者要说明自己在接手');
    assert.ok(await waitFor(() => Number(readLockRaw(state)?.guard) === guardB.pid), '锁里的守卫要改成自己');
    assert.equal(Number(readLockRaw(state)?.pid), runnerPid, '接手时不能换 runner（那就是双开）');
  }
});

test('老锁指向没人看的 runner：接手监护，卡死后换掉而不是双开', async () => {
  const { state, repo, start } = stage('hang');
  // 造一个「上一个守卫留下的」runner：心跳跳 2.5 秒后冻住；锁里写的守卫已经死了。
  // 这样不依赖 043 的 detached 与否，任何平台都能把 adopt 这条分支真正走一遍。
  const deadPid = await deadProcessPid();
  const orphan = spawn(process.execPath, [join(repo, 'scripts', 'runner.mjs')], {
    env: { ...process.env, WB_RUNNER_STATE: state, FAKE_MODE: 'hang', FAKE_BEATS: '25' },
    stdio: 'ignore', detached: true,
  });
  live.push(orphan);
  assert.ok(await waitFor(() => {
    try { return readFileSync(join(state, 'runner.beat'), 'utf8').includes(String(orphan.pid)); } catch { return false; }
  }), '假 runner 要先跳一下心跳');
  writeFileSync(join(state, 'runner.lock'),
    JSON.stringify({ pid: orphan.pid, startedAt: new Date().toISOString(), guard: deadPid }), 'utf8');

  const guardB = start();
  assert.ok(await waitFor(() => /接手监护/.test(logText(state))), '接班者要说明自己在接手');
  assert.ok(await waitFor(() => Number(readLockRaw(state)?.guard) === guardB.pid), '锁里的守卫要改成自己');
  assert.equal(Number(readLockRaw(state)?.pid), Number(orphan.pid), '接手时不能换 runner（那就是双开）');

  // 心跳冻住以后：杀掉旧的、等它真没了再起新的。
  assert.ok(await waitFor(() => Number(readLockRaw(state)?.pid) > 0 && Number(readLockRaw(state)?.pid) !== Number(orphan.pid), STARTUP_MS), '卡住的旧 runner 应该被换掉');
  const second = readLockRaw(state);
  assert.equal(isAlive(Number(orphan.pid)), false, '旧的那个要先死');
  assert.equal(isAlive(Number(second.pid)), true, '新的那个在跑');
  assert.match(logText(state), /心跳停住|自己退了/, '日志里要留下原因');
});

/** 拿一个确定已经退出的 pid，当「死掉的守卫」。 */
async function deadProcessPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = p.pid as number;
  await new Promise<void>((r) => p.once('exit', () => r()));
  return pid;
}

test('054 重复启动：父进程仍活着时保留旧守卫和 runner', async () => {
  const { state, start } = stage('stay');
  const guardA = start({ WB_DOG_MS: '60000' });
  assert.ok(await waitFor(() => readLockRaw(state)?.pid, STARTUP_MS));
  const before = readLockRaw(state);
  const guardB = start({ WB_DOG_MS: '60000' });
  assert.ok(await waitFor(() => !isAlive(guardB.pid!), STARTUP_MS), 'B 应退出');
  assert.equal(isAlive(guardA.pid!), true);
  assert.equal(isAlive(before.pid), true);
  assert.deepEqual(readLockRaw(state), before);
});

// 054：计划任务「停止」的真实现场——外层 powershell 被 TerminateProcess，node 这一层收不到任何信号，
// 于是任务回到 Ready、guard 和 runner 都还在后台跑（2026-11-06 那一晚，日志一行都没留）。
// 守卫现在自己盯父进程：父进程没了就带着整棵树收工，不留孤儿。
//
// 这里用 WB_PARENT_PID 指定一个已经退出的 pid 来验这条逻辑，而不是真去杀一层父进程：
// 在测试环境里杀掉外层会连整棵树一起带走（同一台机器实测），那样连分支都跑不到，
// 测出来的是「进程怎么死的」，不是「守卫有没有看着父进程」。
test('054 父进程没了：守卫带着 runner 整棵树收工，不留孤儿', async () => {
  const { state, start } = stage('stay');
  const deadParent = await deadProcessPid();
  start({
    WB_PARENT_PID: String(deadParent),
    // 父进程检查调到毫秒级，不然一条用例要等 5 秒宽限
    WB_PARENT_MS: '150',
    WB_PARENT_GRACE_MS: '100',
    WB_DOG_MS: '60000',
  });

  assert.ok(await waitFor(() => readLockRaw(state)?.pid, STARTUP_MS), '守卫应该起了一个 runner');
  const first = readLockRaw(state);
  const runnerPid = Number(first.pid);
  const guardPid = Number(first.guard);
  assert.equal(isAlive(runnerPid), true, 'runner 在跑');

  assert.ok(await waitFor(() => !isAlive(runnerPid), STARTUP_MS), 'runner 要跟着走，不能留下孤儿');
  assert.ok(await waitFor(() => !isAlive(guardPid), STARTUP_MS), '守卫自己也要退出');
  assert.match(logText(state), /父进程.*已经不在/, '日志要说明为什么收工');
  assert.match(logText(state), /整棵进程树/, '日志要说明带走的是整棵树');
  assert.doesNotMatch(logText(state), /重开/, '停止期间不能重开');
});



for (const alreadyGone of [false, true]) {
  test(alreadyGone ? '035.6 停止时被接手的 runner 已退出，也清锁退出' : '035.6 停止时等被接手的 runner 真正退出，再清锁退出',
    { skip: process.platform === 'win32' ? 'Windows 的 TerminateProcess 不投递 SIGTERM' : false }, async () => {
      const { state, repo, start } = stage('stay');
      const orphan = spawn(process.execPath, [join(repo, 'scripts', 'runner.mjs')], {
        env: { ...process.env, WB_RUNNER_STATE: state, FAKE_MODE: 'stay' },
        stdio: 'ignore',
      });
      live.push(orphan);
      const pid = orphan.pid!;
      writeFileSync(join(state, 'runner.lock'), JSON.stringify({ pid, creationTime: processCreationTime(pid), guard: await deadProcessPid() }));
      const guard = start({ WB_DOG_MS: '60000' });
      assert.ok(await waitFor(() => readLockRaw(state)?.guard === guard.pid), '守卫要先接手');
      if (alreadyGone) {
        orphan.kill('SIGTERM');
        assert.ok(await waitFor(() => !isAlive(pid)), '先让 runner 退出');
      }
      guard.kill('SIGTERM');
      assert.ok(await waitFor(() => !isAlive(pid), 3000), 'runner 应退出');
      assert.ok(await waitFor(() => guard.exitCode !== null, 3000), '守卫应退出');
      assert.equal(guard.exitCode, 0);
      assert.equal(readLockRaw(state), null, '停止后应清掉自己的锁');
      assert.doesNotMatch(logText(state), /启动 runner|重开/, '停止期间不能重启');
    });
}
for (const delay of [0, 400, 1200]) {
  test(`054 Stop 后 ${delay}ms Start：旧父进程已死就换掉旧 runner`, async () => {
    const { state, repo, start } = stage('stay');
    const wrapper = `const {spawn}=require('node:child_process');
      spawn(process.execPath,[process.env.TEST_GUARD],{env:process.env,stdio:'ignore',detached:true}).unref();
      setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ['-e', wrapper], {
      env: { ...process.env, TEST_GUARD: GUARD, WB_RUNNER_REPO: repo, WB_RUNNER_STATE: state,
        FAKE_MODE: 'stay', WB_PARENT_MS: '2000', WB_PARENT_GRACE_MS: '5000', WB_DOG_MS: '60000' },
      stdio: 'ignore', windowsHide: true,
    });
    live.push(parent);
    assert.ok(await waitFor(() => readLockRaw(state)?.guard), 'A 先启动');
    const guardA = { pid: Number(readLockRaw(state).guard) };
    live.push({ kill: (sig: NodeJS.Signals) => { try { process.kill(guardA.pid, sig); } catch {} } } as ChildProcess);
    const old = Number(readLockRaw(state).pid);
    const guardParent = readLockRaw(state).guardParent;
    parent.kill('SIGKILL');
    assert.ok(await waitFor(() => !isAlive(parent.pid!)), '真实父进程已退出');
    await new Promise((r) => setTimeout(r, delay));
    const guardB = start({ WB_DOG_MS: '60000' });
    assert.ok(await waitFor(() => {
      const lock = readLockRaw(state);
      return lock?.guard === guardB.pid && Number(lock.pid) !== old && isAlive(Number(lock.pid));
    }, STARTUP_MS), 'B 应启动新的 runner');
    assert.equal(guardParent, parent.pid, '锁里记录 A 监护的父进程');
    assert.equal(isAlive(old), false, '旧 runner 必须先退出');
    assert.equal(isAlive(guardA.pid!), false, '旧守卫应退出');
    const lock = readLockRaw(state);
    assert.ok(await waitFor(() => {
      try { return readFileSync(join(state, 'starts'), 'utf8').split(String.fromCharCode(10)).includes(String(lock.pid)); } catch { return false; }
    }), '新的 runner 已经实际启动');
    const runners = readFileSync(join(state, 'starts'), 'utf8').trim().split(String.fromCharCode(10)).map(Number).filter(isAlive);
    assert.deepEqual(runners, [Number(lock.pid)], '所有实际启动过的 runner 中只能剩一个');
    assert.equal(existsSync(join(state, 'overlap')), false, '启动过程中也不能重叠');
  });
}

test('054 父进程消失后 1 秒内 runner 退出', async () => {
  const { state, start } = stage('stay');
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  live.push(parent);
  start({ WB_PARENT_PID: String(parent.pid), WB_PARENT_MS: '50', WB_PARENT_GRACE_MS: '0', WB_DOG_MS: '60000' });
  assert.ok(await waitFor(() => readLockRaw(state)?.pid), 'runner 启动');
  const runner = Number(readLockRaw(state).pid);
  parent.kill('SIGKILL');
  assert.ok(await waitFor(() => !isAlive(parent.pid!)));
  assert.ok(await waitFor(() => !isAlive(runner), 1000), '不能等五秒兜底才退出');
});

test('054 并发启动：两个守卫只能启动一个 runner', async () => {
  const { state, start } = stage('stay');
  const a = start({ WB_DOG_MS: '60000' });
  const b = start({ WB_DOG_MS: '60000' });
  assert.ok(await waitFor(() => readLockRaw(state)?.pid, STARTUP_MS));
  // 2026-11-11：原来只睡 3.5 秒就数「启动 runner」有几行。可输的那个守卫要先查三次创建时间
  // 再判锁（本机 5–12 秒），3.5 秒时它可能还没走到决策点——数出来当然是 1 行，等于没测。
  // 先等「两个里只有一个还活着」，等真的分出胜负，再确认只有一行启动。
  assert.ok(
    await waitFor(() => [a, b].filter((c) => c.exitCode !== null || c.signalCode !== null).length === 1, STARTUP_MS),
    '两个守卫应该只留一个，另一个退出',
  );
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 留出「输的那个也去起 runner」的余量
  assert.equal((logText(state).match(/启动 runner（/g) ?? []).length, 1);
  assert.equal([a, b].filter((c) => c.exitCode === null && c.signalCode === null).length, 1, '只该活下来一个');
});

for (const file of ['runner.lock', 'runner.lock.reclaim']) {
  for (const stale of [false, true]) {
    test(`054 ${file}：${stale ? '过期残留可恢复' : '新文件保守退出'}`, async () => {
      const { state, start } = stage('stay');
      const lockPath = join(state, 'runner.lock');
      writeFileSync(lockPath, file === 'runner.lock' ? '' : JSON.stringify({ pid: 99999999 }));
      if (file !== 'runner.lock') writeFileSync(join(state, file), '');
      if (stale) {
        const old = new Date(Date.now() - 180000);
        utimesSync(join(state, file), old, old);
      }
      const child = start({ WB_DOG_MS: '60000' });
      if (stale) {
        assert.ok(await waitFor(() => readLockRaw(state)?.pid > 0 && readLockRaw(state)?.guard === child.pid, STARTUP_MS));
        assert.match(logText(state), /清理过期/);
      } else {
        assert.ok(await waitFor(() => child.exitCode !== null, STARTUP_MS));
        assert.equal(existsSync(join(state, 'starts')), false);
        assert.equal(existsSync(join(state, file)), true);
      }
    });
  }
}
