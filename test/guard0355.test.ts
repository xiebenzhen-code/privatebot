// 035.5：守卫被强杀以后，接班的那一个必须把看门狗接过去。
//
// 真实事故形状：Stop-ScheduledTask 只带走了守卫，detached 的 runner 还活着，锁里写的 guard 已经死了。
// 下一个守卫读到「runner 活着」就 skip → 留下一个活着但没人看的执行器，卡死了也不会有人重开。
// 这组用真进程验三件事：接班者会 adopt、adopt 期间不会双开、旧 runner 卡死后会被杀掉重开。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/runner-guard.mjs', import.meta.url));
const TMP: string[] = [];
const live: ChildProcess[] = [];

after(() => {
  for (const c of live) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows 锁 */ } }
});

/** 假 runner：'hang' 跳 FAKE_BEATS 下就冻住（活着但卡死）；'stay' 一直跳。 */
const FAKE = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const STATE = process.env.WB_RUNNER_STATE;
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

async function waitFor(what: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// decide() 的三态：没有锁 / runner 不在 → take；runner 与守卫都在 → skip；runner 在、守卫不在 → adopt。
test('decide 分得清「有人看」和「没人看」', async () => {
  const { decide } = await import('../scripts/runner-guard.mjs');
  const only = (...pids: number[]) => (pid: number) => pids.includes(Number(pid));
  assert.equal(decide(null), 'take');
  assert.equal(decide({ pid: 10, guard: 20 }, only(20)), 'take', 'runner 不在就正常起');
  assert.equal(decide({ pid: 10, guard: 20 }, only(10, 20)), 'skip', '两个都在：重复启动，退出');
  assert.equal(decide({ pid: 10, guard: 20 }, only(10)), 'adopt', 'runner 在、守卫不在：接手');
  assert.equal(decide({ pid: 10 }, only(10)), 'adopt', '老锁里没有 guard 字段，也算没人看');
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
    assert.ok(await waitFor(() => Number(readLockRaw(state)?.pid) !== runnerPid), '应该起一个新的');
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
  assert.ok(await waitFor(() => Number(readLockRaw(state)?.pid) !== Number(orphan.pid), 15_000), '卡住的旧 runner 应该被换掉');
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
      writeFileSync(join(state, 'runner.lock'), JSON.stringify({ pid, guard: await deadProcessPid() }));
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
