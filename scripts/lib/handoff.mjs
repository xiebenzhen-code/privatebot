// 035.3：部署之后「换执行器」这一步，交给一个脱离父进程的助手去做。
//
// 旧做法是：旧执行器**还活着**的时候点一下计划任务，然后自己退出。这里有三个坑：
//   1. 计划任务配的是 `-MultipleInstances IgnoreNew`，启动脚本里还有一道「已经有人在跑就跳过」的守卫。
//      旧进程没退出之前点它，等于什么都没发生——而 `Start-ScheduledTask` 照样返回 0。
//   2. 于是旧的走了、新的没来，机器上可能一个执行器都不剩，页面只看到「执行器掉线」。
//   3. 那条命令到底成没成，没有任何人验证过。
//
// 现在：旧执行器只负责把这个文件当脚本 detached 地拉起来，然后自己退出。助手在旧进程之外，
// 先等旧 pid 消失、锁放开，再启动新实例，最后确认锁里的 pid 真的换成了新进程，
// 全程写进 `runner-autostart.log`。工作台那边靠心跳里的 pid / code_hash 判断「接班到了没有」。
//
// 用法（由 runner 自己调，不用人手敲）：
//   node scripts/lib/handoff.mjs --pid 42556 [--lock <path>] [--log <path>] [--task "AI Workbench Runner"]
// 测试用 `--start-cmd "node fake-new.mjs"` 换掉「启动新实例」那一步；`--wait-exit` / `--wait-start` 调超时。
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_NAME = 'AI Workbench Runner';
/** 等旧进程退出：60 秒。一个正常的 runner 收到 exit 之后立刻就没了。 */
export const WAIT_EXIT_MS = 60_000;
/** 等新实例出现：90 秒。要留出计划任务调度 + 容器里那次健康检查的余量。 */
export const WAIT_START_MS = 90_000;
const POLL_MS = 1_000;
/** 根目录：和 runner.mjs / runner-guard.mjs 用的是同一套（后者自己算了一遍，路径必须一致）。 */
export function stateDir(env = process.env) {
  return env.WB_RUNNER_STATE || join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ai-workbench');
}
export const lockPath = (env = process.env) => join(stateDir(env), 'runner.lock');
export const autostartLogPath = (env = process.env) => join(stateDir(env), 'runner-autostart.log');

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 锁文件是执行器自己写的 JSON。Windows 上别的工具常带 BOM，直接 parse 会失败，先剥掉。 */
export function parseLock(text) {
  if (!text) return null;
  try {
    const o = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * 进程还活着吗。EPERM 表示进程在、只是没权限问，也算活着——
 * 把「问不动」当成「已经退出」会让助手提前启动新实例，两个执行器抢同一份额度。
 */
export function pidAlive(pid, selfPid = 0) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === selfPid) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 可以启动新实例了吗：旧的那一个已经不在，而且没有别人占着锁。
 *
 * 关于「计划任务不再处于运行中」：任务跑的就是守卫 + 执行器，执行器活着就一定在锁里
 * （除非执行器是手动起的，那种情况根本没有计划任务）。而计划任务的状态文本是随系统语言变的
 * （Running / 正在运行），拿它做判断比锁文件更容易误判，所以这里只认锁和 pid。
 */
export function canStart({ pid, lockText, isAlive = pidAlive }) {
  if (isAlive(pid)) return false;
  const lock = parseLock(lockText);
  const n = Number(lock?.pid);
  if (!Number.isInteger(n) || n <= 0) return true;
  if (n === Number(pid)) return true; // 锁还指着那个已经不在的 pid，等价于没锁
  return !isAlive(n); // 别人还占着，再起一个就是两个执行器
}

/** 新实例到位：锁里有一个活着的 pid，而且不是旧的那个。 */
export function successorPid({ lockText, fromPid, isAlive = pidAlive }) {
  const lock = parseLock(lockText);
  const n = Number(lock?.pid);
  if (!Number.isInteger(n) || n <= 0) return 0;
  if (n === Number(fromPid)) return 0;
  return isAlive(n) ? n : 0;
}

/** 轮询到条件成立或超时。`now` / `sleep` 可注入，纯逻辑才测得动。 */
export async function waitUntil(check, { timeoutMs, everyMs = POLL_MS, sleep = defaultSleep, now = Date.now } = {}) {
  const started = now();
  for (;;) {
    if (await check()) return { ok: true, waitedMs: now() - started };
    const left = timeoutMs - (now() - started);
    if (left <= 0) return { ok: false, waitedMs: now() - started };
    await sleep(Math.min(everyMs, left));
  }
}

/**
 * 启动新实例：有计划任务就点它，没有就直接跑启动脚本。
 *
 * 不用 `schtasks /Query` 先问「任务在不在」：多一次进程，而且有的机器把 schtasks 挡在黑名单里，
 * 会让「任务明明在」也走成启动脚本，起一个没有守卫的执行器。直接点，点不动再看有没有脚本。
 */
export function startRunner({
  platform = process.platform,
  taskName = TASK_NAME,
  autostart = '',
  run = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts }),
  launch,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') return { ok: false, why: '不是 Windows，没有计划任务可点，请手动重启执行器' };
  const s = run('powershell', ['-NoProfile', '-Command', `Start-ScheduledTask -TaskName "${taskName}"`], { timeout: 60_000 });
  if (s && !s.error && s.status === 0) return { ok: true, how: '计划任务' };
  const tail = String(s?.stderr || s?.stdout || s?.error?.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 160);
  if (autostart && exists(autostart)) {
    try {
      if (launch) launch(autostart);
      else spawn('cmd.exe', ['/c', autostart], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, how: '启动脚本' };
    } catch (err) {
      return { ok: false, why: `点计划任务没成功（${tail || '没有输出'}），跑启动脚本也失败：${err.message}` };
    }
  }
  return { ok: false, why: `既没能点起计划任务「${taskName}」${tail ? `（${tail}）` : ''}，也没有启动脚本，请手动启动一次` };
}

/**
 * 交接本体。
 * 返回 `{ ok, why?, newPid? }`——`ok:false` 时 `why` 是写给人看的一句话，
 * 它会进日志，也会由工作台在 5 分钟没等到接班时变成橙色提示。
 */
export async function handoff({
  pid,
  lockFile,
  start,
  log = () => {},
  isAlive = pidAlive,
  readText = (f) => {
    try { return readFileSync(f, 'utf8'); } catch { return ''; }
  },
  sleep = defaultSleep,
  now = Date.now,
  waitExitMs = WAIT_EXIT_MS,
  waitStartMs = WAIT_START_MS,
  everyMs = POLL_MS,
} = {}) {
  const from = Number(pid) || 0;
  if (!from) return { ok: false, why: '不知道旧执行器的 pid，没法确认它真的退出了' };
  if (typeof start !== 'function') return { ok: false, why: '没有给出启动新实例的办法' };

  const lockText = () => readText(lockFile);
  log(`接手：等旧执行器 ${from} 退出（最多 ${Math.round(waitExitMs / 1000)} 秒）`);

  // 先等旧的那个让开。中途要是有别人已经把新实例接上了（守卫先动的手），就到此为止——
  // 再点一次计划任务或者再跑一次启动脚本，只会多出一个执行器抢同一份额度。
  const deadline = now() + waitExitMs;
  for (;;) {
    const text = lockText();
    const ready = successorPid({ lockText: text, fromPid: from, isAlive });
    if (ready) {
      log(`旧执行器 ${from} 已经不在，而且新实例 ${ready} 已经被守卫接上了，不用再起`);
      return { ok: true, newPid: ready, already: true };
    }
    if (canStart({ pid: from, lockText: text, isAlive })) break;
    const left = deadline - now();
    if (left <= 0) {
      // 旧进程不肯走就别硬启动：两个执行器同时在线，同一份额度会花两遍。
      return {
        ok: false,
        why: `旧执行器 ${from} 在 ${Math.round(waitExitMs / 1000)} 秒内没有退出，没有启动新实例；需要手动重启一次`,
      };
    }
    await sleep(Math.min(everyMs, left));
  }
  log(`旧执行器 ${from} 已经退出，锁也放开了；启动新实例`);

  let started;
  try {
    started = await start();
  } catch (err) {
    return { ok: false, why: `启动新实例时出错：${err.message}` };
  }
  if (started && started.ok === false) return { ok: false, why: started.why || '启动新实例失败' };
  log(`已经点了启动（${started?.how ?? '未知方式'}），等新实例出现`);

  const came = await waitUntil(
    () => Boolean(successorPid({ lockText: lockText(), fromPid: from, isAlive })),
    { timeoutMs: waitStartMs, everyMs, sleep, now },
  );
  if (!came.ok) {
    return { ok: false, why: `新实例 ${Math.round(waitStartMs / 1000)} 秒内没有出现（锁里没换成新的 pid），执行器现在是停着的，请手动启动一次` };
  }
  const newPid = successorPid({ lockText: lockText(), fromPid: from, isAlive });
  log(`接班成功：新实例 pid ${newPid}`);
  return { ok: true, newPid };
}

// ---------- 旧进程这一侧：把它 detached 地拉起来 ----------

/**
 * runner 调这个：起一个脱离父进程的助手，然后自己安心退出。
 * `stdio:'ignore'` + `detached` + `unref` 三件套是必须的——否则父进程一退，
 * 助手跟着一起被收掉，交接就变成了「谁也没接班」。
 */
export function spawnHandoff({
  pid = process.pid,
  taskName = TASK_NAME,
  lockFile = lockPath(),
  logFile = autostartLogPath(),
  cwd = process.cwd(),
  script = fileURLToPath(new URL('./handoff.mjs', import.meta.url)),
} = {}) {
  try {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', script, '--pid', String(pid), '--lock', lockFile, '--log', logFile, '--task', taskName],
      { cwd, detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, why: `起接班助手失败：${err.message}` };
  }
}

// ---------- CLI ----------

export function parseArgs(argv = []) {
  const out = { pid: 0, lock: '', log: '', task: TASK_NAME, startCmd: '', waitExit: WAIT_EXIT_MS, waitStart: WAIT_START_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--pid') out.pid = Number(next()) || 0;
    else if (a === '--lock') out.lock = next();
    else if (a === '--log') out.log = next();
    else if (a === '--task') out.task = next() || TASK_NAME;
    else if (a === '--start-cmd') out.startCmd = next();
    else if (a === '--wait-exit') out.waitExit = Number(next()) || WAIT_EXIT_MS;
    else if (a === '--wait-start') out.waitStart = Number(next()) || WAIT_START_MS;
  }
  return out;
}

async function main(argv) {
  const a = parseArgs(argv);
  const logFile = a.log || autostartLogPath();
  const log = (text) => {
    const line = `[${new Date().toISOString()}] 接班助手：${text}\n`;
    try { appendFileSync(logFile, line, 'utf8'); } catch { /* 写不进去也要继续交接 */ }
    if (process.env.WB_RUNNER_VERBOSE) process.stdout.write(line);
  };
  if (!a.pid) {
    log('没有给出 --pid，什么也没做');
    return 2;
  }
  const start = a.startCmd
    ? () => {
      try {
        spawn(a.startCmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, cwd: process.cwd() }).unref();
        return { ok: true, how: '指定的启动命令' };
      } catch (err) {
        return { ok: false, why: `跑启动命令失败：${err.message}` };
      }
    }
    : () => startRunner({ taskName: a.task, autostart: join(stateDir(), 'runner-autostart.cmd') });

  const r = await handoff({
    pid: a.pid, lockFile: a.lock || lockPath(), start, log,
    waitExitMs: a.waitExit, waitStartMs: a.waitStart,
  });
  if (!r.ok) log(`失败：${r.why}`);
  return r.ok ? 0 : 1;
}

// 被测试 import 时不要真的去交接。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    // 助手崩了也必须留一行，否则工作台只会看到「没人接班」而不知道是谁没接。
    try {
      appendFileSync(autostartLogPath(), `[${new Date().toISOString()}] 接班助手崩了：${err?.message ?? err}\n`, 'utf8');
    } catch { /* nothing left to do */ }
    process.exit(1);
  });
}
