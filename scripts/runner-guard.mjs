// 执行器的单实例守卫：登录自启和手动启动撞在一起时，只让一个 runner 活着。
//
// 为什么需要它：两个 runner 同时在线不会重复领同一个任务（claimTask 用
// `WHERE status='queued'` 原子抢），但会各自领走不同任务并行跑，等于同一份额度
// 花两遍；而且两个进程同时动同一个 worktree 容易互相踩。
//
// 判断「有人在跑」靠锁文件里的 pid + 进程存活，不靠命令行字符串匹配：
// 命令行匹配会把 `runner.mjs --check`（自检）和编辑器里开着的文件误当成实例。
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.WB_RUNNER_REPO ?? resolve(HERE, '..');
const STATE_DIR = process.env.WB_RUNNER_STATE ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ai-workbench');
export const LOCK = join(STATE_DIR, 'runner.lock');
const LOG = join(STATE_DIR, 'runner-autostart.log');
// runner 每 30 秒往这里写一次时间戳。路径必须和 scripts/runner.mjs 里的 BEAT_FILE 一致。
const BEAT = join(STATE_DIR, 'runner.beat');
/** runner 承认「我在跑长命令，先别杀」时写的声明。路径要和 runner.mjs 的 BUSY_FILE 一致。 */
const BUSY = join(STATE_DIR, 'runner.busy');
/** 心跳超过这么久没动就认为「进程还在、但已经不干活了」。10 次心跳的余量。 */
const STALE_MS = Number(process.env.WB_BEAT_STALE_MS ?? 300_000);
/**
 * 035.4：忙声明最长只能顶这么久。docker 构建允许 10 分钟，留一点余量；
 * 超过这个数的声明一律不认——“忙”不能变成“永远不用杀”。
 */
const BUSY_MAX_MS = 15 * 60_000;
// 巡检节奏与重启间隔只在测试里调小（真机保持 30 秒 / 5 秒），否则跑一次边界用例要等半分钟。
const DOG_MS = Number(process.env.WB_DOG_MS ?? 30_000);
const BACKOFF_BASE_MS = Number(process.env.WB_BACKOFF_MS ?? 5_000);

/**
 * 035.4：这份忙声明还算不算数。
 *
 * 只看两件事：写声明的就是这个子进程，而且截止时间还没到、也没离谱地远。
 * 过期、别人的、时间戳坏掉的，都当没有——宁可重启一次，也不要放过真卡死的进程。
 */
export function busyValid(busy, pid, now = Date.now()) {
  if (!busy || typeof busy !== 'object') return false;
  if (Number(busy.pid) !== Number(pid)) return false;
  const until = Date.parse(busy.until);
  if (!Number.isFinite(until) || until <= now) return false;
  return until - now <= BUSY_MAX_MS + 60_000;
}

/**
 * 从 `runner.beat` 判断 runner 还动不动。
 * 读不到、时间戳坏了、或者太久没更新，都算「不动」——这时候进程可能还活着，但已经是一具尸体：
 * 2026-11-01 凌晨就是这样，心跳、日志、定时器全停了二十分钟，而进程当时还在进程表里。
 */
export function beatStale(beat, now = Date.now(), limit = STALE_MS) {
  if (!beat || typeof beat !== 'object' || !beat.ts) return true;
  const t = Date.parse(beat.ts);
  if (!Number.isFinite(t)) return true;
  return now - t > limit;
}

/**
 * 进程还活着吗。EPERM 表示进程在、只是没权限问，也算活着。
 * 自己不算——守卫可能是被 runner 拉起来的，别把自己当成占位者。
 */
export function alive(pid, selfPid = process.pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === selfPid) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function processCreationTime(pid, run = spawnSync) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const options = { encoding: 'utf8', windowsHide: true, timeout: 15000 };
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = process.platform === 'win32'
      ? run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "ProcessId = ${n}" | ForEach-Object { $_.CreationDate.ToUniversalTime().Ticks }`], options)
      : run('ps', ['-p', String(n), '-o', 'lstart='], { ...options, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const stamp = result.stdout?.trim();
    if (!result.error && result.status === 0 && stamp) return stamp;
    if (!alive(n, -1)) return null;
  }
  throw new Error(`无法核实进程 ${n} 的创建时间`, { cause: result.error });
}

export function lockProcessAlive(pid, creationTime) {
  if (!alive(pid, -1)) return false;
  // 升级前的锁，以及暂时查不到创建时间时写出的锁，仍用 PID 判活。
  if (creationTime == null || creationTime === '') return true;
  return typeof creationTime === 'string' && processCreationTime(pid) === creationTime;
}

/**
 * 2026-11-06：结束**整棵**进程树，不是只结束顶上那个。
 *
 * Windows 上 `child.kill()` 只是 TerminateProcess 一个进程，runner 往下还挂着
 * claude / bash / git，它们会留下来继续占着 worktree（下次开跑就撞锁）。
 * `taskkill /T` 按父子关系一次带走；`/F` 是因为这些进程没有窗口、不受 Ctrl+C。
 * POSIX 上 runner 是 detached 的（自己的进程组），杀 `-pid` 就是整组。
 */
export function killTree(pid, { sig = 'SIGKILL', run = spawnSync, platform = process.platform } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (platform === 'win32') {
    const r = run('taskkill', ['/PID', String(n), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return (r?.status ?? 1) === 0;
  }
  try {
    process.kill(-n, sig);
    return true;
  } catch {
    /* 不是进程组长，退回单杀 */
  }
  try {
    process.kill(n, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * 2026-11-06：父进程是不是已经没了。
 *
 * 现场：`Stop-ScheduledTask` 只 TerminateProcess 了最外层那个 powershell，
 * guard 和 runner 却都还活着——计划任务显示 Ready，执行器在后台继续跑，
 * 下一次 Start 被 IgnoreNew 或锁挡住，看起来「重启了」其实什么都没换。
 * 守卫自己盯着父进程：父进程没了就是没人要我们了，带着整棵树收工。
 */
export function parentVanished(ppid, isAlive = alive, selfPid = process.pid) {
  const n = Number(ppid);
  if (!Number.isInteger(n) || n <= 0 || n === selfPid) return false;
  return !isAlive(n, selfPid);
}

/**
 * 035.4：收到停止信号时该对谁下手。
 *
 * 这一条原来藏在 startOnce 的闭包里：每次重启都新挂一组监听器、各自捕获自己的 child，
 * 但「已经停过」的标记是共用的。第一个子进程死后旧监听器还在，它先把 stopping 置真、
 * 再去 kill 那个已经死掉的 pid；新监听器看到 stopping 就直接返回——活着的 runner 因此停不掉。
 *
 * 现在单独拎出来：只认「当前」那个子进程；当前没有（重启间隙）、或者已经死了，就直接收工。
 */
export function stopPlan(current, isAlive = alive) {
  if (current && isAlive(current.pid)) return { kill: Number(current.pid), exit: false };
  return { kill: 0, exit: true };
}

/**
 * runner 不在就正常启动；旧守卫的父进程已退出，则先结束旧进程树再启动。
 * 其余活着的 runner 接手监护，老锁没有 guardParent 时保留接手行为。
 */
export function decide(lock, isAlive = null) {
  if (!lock || typeof lock !== 'object') return 'take';
  if (!(isAlive ? isAlive(lock.pid) : lockProcessAlive(lock.pid, lock.creationTime))) return 'take';
  if (isAlive ? parentVanished(lock.guardParent, isAlive) : parentGone(lock)) return 'take';
  const guardAlive = isAlive ? isAlive(lock.guard) : lockProcessAlive(lock.guard, lock.guardCreationTime);
  return guardAlive ? 'skip' : 'adopt';
}

function parentGone(lock) {
  return !!lock.guardParent && !lockProcessAlive(lock.guardParent, lock.guardParentCreationTime);
}

function log(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    appendFileSync(LOG, line, 'utf8');
  } catch {
    /* 日志写不进去不该拦住 runner */
  }
}

function creationTimeOrEmpty(pid) {
  try {
    return processCreationTime(pid) ?? '';
  } catch (err) {
    log(`${err.message}，暂按 PID 记录。`);
    return '';
  }
}

// null 表示这轮查不到。只可等待，不可据此结束进程或启动第二份。
function probeLockedProcess(pid, creationTime) {
  try {
    return lockProcessAlive(pid, creationTime);
  } catch (err) {
    log(`${err.message}，本轮保留原进程。`);
    return null;
  }
}

function readLock() {
  try {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return null;
    const pid = Number(lock.starting ? lock.guard : lock.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? lock : null;
  } catch {
    return null;
  }
}

function openExclusive(path) {
  try {
    return openSync(path, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

const LOCK_STALE_MS = 120_000;

function removeExpired(path) {
  try {
    if (Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return false;
    unlinkSync(path);
    log(`清理过期锁文件：${path}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') log(`暂时无法清理锁文件 ${path}：${err.code ?? err.message}`);
    return err.code === 'ENOENT';
  }
}

function reserveLock(owner) {
  let fd = openExclusive(LOCK);
  if (fd === null) {
    // Serialize stale-file deletion. The winner still needs wx after unlink:
    // a fresh contender may have created the lock in that gap.
    const reclaim = LOCK + '.reclaim';
    let gate = openExclusive(reclaim);
    if (gate === null && removeExpired(reclaim)) gate = openExclusive(reclaim);
    if (gate === null) return false;
    try {
      const prev = readLock();
      if (prev && (lockProcessAlive(prev.pid, prev.creationTime) ||
          lockProcessAlive(prev.guard, prev.guardCreationTime))) return false;
      // An empty or unreadable lock can be a reservation still being written.
      if (!prev && !removeExpired(LOCK)) return false;
      if (prev) {
        try { unlinkSync(LOCK); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      fd = openExclusive(LOCK);
    } finally {
      closeSync(gate);
      try { unlinkSync(reclaim); } catch (err) {
        if (err.code !== 'ENOENT') log(`暂时无法清理锁闸门：${err.code ?? err.message}`);
      }
    }
    if (fd === null) return false;
  }
  try {
    writeFileSync(fd, JSON.stringify({ ...owner, starting: true }), 'utf8');
  } finally {
    closeSync(fd);
  }
  return true;
}

function publishLock(lock) {
  const tmp = LOCK + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(lock), 'utf8');
  renameSync(tmp, LOCK);
}

/**
 * 读心跳文件的内容。Windows 上别的工具写文件常带 BOM，直接 JSON.parse 会失败；
 * 失败就被当成「从没写过」，日志里会写成一句让人误解的话，所以这里先剥 BOM。
 */
export function parseBeat(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readBusy() {
  try {
    return JSON.parse(readFileSync(BUSY, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readBeat() {
  try {
    return parseBeat(readFileSync(BEAT, 'utf8'));
  } catch {
    return null;
  }
}

/** 连续快速退出几次后就把重启间隔拉开，别让「配置错、一启动就退」变成每 5 秒刷一条日志。 */
export function backoffMs(fastExits, base = BACKOFF_BASE_MS) {
  if (fastExits <= 0) return base;
  return Math.min(base * 12, base * 2 ** Math.min(fastExits, 4));
}

function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const prev = readLock();
  const verdict = decide(prev);
  if (prev && verdict === 'take' && !lockProcessAlive(prev.pid, prev.creationTime)) log(`锁里的 pid ${prev.pid} 已经不在，接管。`);

  const entry = join(REPO, 'scripts', 'runner.mjs');
  if (!existsSync(entry)) {
    log(`找不到 ${entry}，退出。`);
    return 1;
  }

  let stopping = false;
  // 035.4：这两个是「当前」而不是「这一次」——停止信号和重启定时器都只该有一份。
  let current = null;
  let restartTimer = null;
  let stopAdopted = null;
  let parentTimer = null;

  /**
   * 035.4：停止信号只注册一次，指向**当前活着的**子进程。
   * 原来每次 startOnce 都挂一组、各自捕获自己的 child，但 stopping 是共用的：
   * 第一次的子进程死后旧监听器还在，收到 SIGTERM 时它先 kill 那个已经死掉的 pid，
   * 接着把 stopping 置真，新监听器一看就直接返回——活着的那个 runner 因此永远不会被停。
   *
   * 2026-11-06：停止要带走**整棵树**。只终止 runner 本体，它下面的 claude / bash / git
   * 会继续占着 worktree，下次开跑撞锁——用户看到的「node 进程游离」就是这个。
   */
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (parentTimer) {
      clearInterval(parentTimer);
      parentTimer = null;
    }
    const plan = stopPlan(current, pid => current?.exitCode == null && current?.signalCode == null && alive(pid));
    log(`收到 ${sig}，结束 runner 整棵进程树（pid ${plan.kill || '无'}）。`);
    const signal = /^SIG[A-Z0-9]+$/.test(sig) ? sig : 'SIGTERM';
    if (stopAdopted) return stopAdopted(signal, plan.exit);
    if (plan.exit) process.exit(0); // 重启间隙里收到停止：没有子进程可等，直接收工
    // Windows 上没有优雅退出可言（TerminateProcess 本来就不投递信号），直接整棵带走；
    // POSIX 上先给进程组 SIGTERM 让它自己收尾，5 秒还没走再 SIGKILL。
    if (process.platform === 'win32') killTree(plan.kill);
    else {
      try {
        current.kill(signal);
      } catch {
        /* 已经没了 */
      }
      killTree(plan.kill, { sig: signal });
      setTimeout(() => { if (current?.pid === plan.kill && probeLockedProcess(plan.kill, current.creationTime) === true) killTree(plan.kill); }, 5000).unref?.();
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => stop(sig));

  /**
   * 2026-11-06：父进程（计划任务的隐藏 powershell）没了就说明任务被停止了，
   * 但 TerminateProcess 只带走了外层，node 这一层会变成孤儿继续跑。
   * 等信号是等不到的——只能自己看。刚起来的几秒不判，躲开启动瞬态。
   */
  const PARENT_MS = Number(process.env.WB_PARENT_MS ?? 2_000);
  const PARENT_GRACE = Number(process.env.WB_PARENT_GRACE_MS ?? 5_000);
  // WB_PARENT_PID 只给测试用：这台机器的测试环境里杀掉外层会连整棵树一起带走，
  // 真等「父进程消失」这一支根本跑不到，只能指定一个已经死掉的 pid 来验逻辑。
  const parentPid = Number(process.env.WB_PARENT_PID ?? process.ppid);
  const guardCreationTime = creationTimeOrEmpty(process.pid);
  const guardParentCreationTime = creationTimeOrEmpty(parentPid);
  if (PARENT_MS > 0 && parentPid > 0) {
    const bornAt = Date.now();
    parentTimer = setInterval(() => {
      if (stopping) return;
      if (Date.now() - bornAt < PARENT_GRACE) return;
      if (!parentVanished(parentPid)) return;
      log(`父进程（pid ${parentPid}，计划任务的 powershell）已经不在——任务已被停止，带着整棵树收工。`);
      stop('父进程退出');
    }, PARENT_MS);
    parentTimer.unref?.();
  }

  /**
   * 起一次 runner，并盯着它。原来跑起来后只等 exit——进程要是「还在、但不干活了」，
   * 这里永远等不到，计划任务看着也是「正在运行」，实际上什么都没做。现在用心跳文件兜这个洞。
   */
  const startOnce = (fastExits) => {
    const owner = { guard: process.pid, guardCreationTime, guardParent: parentPid, guardParentCreationTime };
    if (!reserveLock(owner)) {
      log('已有守卫持锁，跳过本次启动。');
      return;
    }
    const startedAt = Date.now();
    log(`启动 runner（${process.execPath}），仓库 ${REPO}`);
    // stdin 用 ignore：计划任务里没有可用的控制台输入，runner 也不读它。
    // detached（2026-11-02）：守卫和 runner 原来共享一个控制台，控制台一关/一次 Ctrl+C
    // 整棵树就一起走，计划任务的 LastTaskResult 落成 3221225786（0xC000013A），
    // 日志里连一行「runner 退出」都留不下。detached 让子进程自己去开进程组、
    // 不挂在父进程的控制台上：关终端不再带走它，杀掉仍然走 child.kill('SIGKILL')。
    // 043 B：Windows 上**不** detached、**不** windowsHide。这两样都会让 runner 没有控制台，
    // 它往下起的 Claude Code → bash → git 每一层都会新开一个可见黑框（用户 2026-11-03 报的「黑框乱跳」）。
    // 现在 runner 挂在守卫的控制台上；守卫由计划任务以隐藏窗口启动（INSTALL-WINDOWS），这个控制台本身看不见，
    // 下面整棵树都共用它，一个窗口都不弹。4cb491c 要防的「关终端带走执行器」：隐藏控制台没有人能关。
    // 其他系统没有这个问题，保持原来的 detached（自己的进程组，不随终端走）。
    const win = process.platform === 'win32';
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: !win,
      detached: !win,
    });

    let creationTime;
    try {
      creationTime = creationTimeOrEmpty(child.pid);
      publishLock({ ...owner, pid: child.pid, creationTime, startedAt: new Date().toISOString() });
    } catch (err) {
      child.kill();
      throw err;
    }

    const relay = (chunk) => {
      const text = chunk.toString();
      try {
        appendFileSync(LOG, text, 'utf8');
      } catch {
        /* 同上 */
      }
      process.stdout.write(text);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    current = Object.assign(child, { creationTime });

    let busyLogged = false;
    const dog = setInterval(() => {
      // 已经在退出流程里的就别再补一刀，交给 exit 事件。
      if (!alive(child.pid)) return;
      const b = readBeat();
      if (!beatStale(b)) {
        busyLogged = false;
        return;
      }
      // 035.4：心跳停了，但它在跑一条承认过的长命令（docker 构建、clone、push）。
      // 这种时候主线程被 spawnSync 钉住，心跳本来就写不出来——杀掉等于把合法的活砍了。
      const busy = readBusy();
      if (busyValid(busy, child.pid)) {
        if (!busyLogged) {
          log(`runner ${child.pid} 心跳停住，但它在跑长命令（${busy.why ?? '没写原因'}），先不杀。`);
          busyLogged = true;
        }
        return;
      }
      log(
        `runner ${child.pid} 心跳停住（最后一下 ${b?.ts ?? '从没写过'}），超过 ${Math.round(STALE_MS / 60000)} 分钟没动静，杀掉重开。`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    }, DOG_MS);

    child.on('exit', (code, signal) => {
      clearInterval(dog);
      if (current === child) current = null;
      log(`runner 退出：code=${code} signal=${signal ?? '-'}`);
      // 只清自己那把锁，别把别人刚写的删掉。
      const cur = readLock();
      if (cur && Number(cur.pid) === child.pid && Number(cur.guard) === process.pid) {
        try {
          unlinkSync(LOCK);
        } catch {
          /* 已经没了 */
        }
      }
      if (stopping) {
        process.exit(code ?? 0);
        return;
      }
      const next = Date.now() - startedAt < 60_000 ? fastExits + 1 : 0;
      const wait = backoffMs(next);
      log(`${Math.round(wait / 1000)} 秒后重开（连续快速退出 ${next} 次）。`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startOnce(next);
      }, wait);
    });
  };

  /**
   * 035.5：接管一个还在跑的 runner。
   *
   * 不 spawn 第二个（会双开、双份额度），也不放着不管（卡死了没人重开）。
   * 这里只做两件事：把锁的 guard 改成自己，然后用心跳文件盯着那个 pid——
   * 它自己退了就重开；它卡住了就杀掉、等它真的消失再重开（保证任何时刻只有一个）。
   *
   * 只有旧守卫不在才接手，避免破坏还在用的控制台和输出管道。
   */
  const adoptExisting = (lock) => {
    const pid = Number(lock.pid);
    const runnerAlive = () => probeLockedProcess(pid, lock.creationTime);
    // 判断和接手之间有一个空档：旧守卫正是在这两步中间死的（杀守卫会带走 runner 的控制台和管道）。
    // 已经没了就别摆出「正在监护」的样子等下一轮巡检，直接开一个新的。
    const live = runnerAlive();
    if (live === null) return null;
    if (!live) {
      log(`准备接手的 runner（pid ${pid}）已经不在了，直接起新的。`);
      return startOnce(0);
    }
    if (probeLockedProcess(lock.guard, lock.guardCreationTime) !== false) return null;
    if (!lock.creationTime) lock = { ...lock, creationTime: creationTimeOrEmpty(pid) };
    log(`runner（pid ${pid}）还活着，接手监护，不再起第二个。`);
    publishLock({ ...lock, pid, guard: process.pid, guardCreationTime, guardParent: parentPid, guardParentCreationTime, adoptedAt: new Date().toISOString() });
    current = { pid, creationTime: lock.creationTime, kill: (sig) => { try { process.kill(pid, sig); } catch { /* 已经没了 */ } } };
    let reapTimer = null;
    const finishAdopted = () => {
      clearInterval(reapTimer);
      clearInterval(dog);
      stopAdopted = null;
      current = null;
      const cur = readLock();
      if (Number(cur?.pid) === pid && Number(cur?.guard) === process.pid) {
        try { unlinkSync(LOCK); } catch { /* 已经没了 */ }
      }
      if (stopping) {
        process.exit(0);
      }
      log('接手的 runner（pid ' + pid + '）已经退出，重开。');
      startOnce(0);
    };
    const reap = () => {
      clearInterval(dog);
      if (runnerAlive() === false) return finishAdopted();
      reapTimer ??= setInterval(() => {
        if (runnerAlive() === false) finishAdopted();
      }, 100);
    };
    stopAdopted = (sig, alreadyGone) => {
      if (!alreadyGone && runnerAlive() === true) {
        killTree(pid, { sig });
        setTimeout(() => { if (runnerAlive() === true) killTree(pid); }, 5000).unref?.();
      }
      reap();
    };
    const dog = setInterval(() => {
      const live = runnerAlive();
      if (live === null) return;
      if (!live) return finishAdopted();
      const b = readBeat();
      if (!beatStale(b)) return;
      if (busyValid(readBusy(), pid)) return;
      log(`接手的 runner ${pid} 心跳停住（最后一下 ${b?.ts ?? '从没写过'}），杀掉重开。`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
      reap();
    }, DOG_MS);
    return null;
  };

  // 外层计划任务已停止时，旧 runner 必须退出后才能启动新的一份。
  const retireStopped = (lock) => {
    const pid = Number(lock.pid);
    const runnerAlive = () => probeLockedProcess(pid, lock.creationTime);
    const oldGuard = Number(lock.guard);
    const oldGuardAlive = () => probeLockedProcess(oldGuard, lock.guardCreationTime);
    log(`旧守卫的父进程 ${lock.guardParent} 已退出，结束旧守卫和 runner ${pid}，再启动新的。`);
    if (oldGuard !== process.pid && oldGuardAlive() === true) {
      try { process.kill(oldGuard, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM'); } catch { /* 下面等待它退出 */ }
    }
    let runnerStopRequested = false;
    const warnAt = Date.now() + 5000;
    let warned = false;
    const wait = () => {
      if (stopping) return;
      const runner = runnerAlive();
      const guard = oldGuardAlive();
      if (runner === true && !runnerStopRequested) runnerStopRequested = killTree(pid);
      if (runner === false && guard === true) {
        try { process.kill(oldGuard, 'SIGKILL'); } catch { /* 已退出 */ }
      }
      if (runner !== false || guard !== false) {
        if (!warned && Date.now() >= warnAt) {
          warned = true;
          log(`旧 runner ${pid} 或守卫 ${oldGuard} 仍未退出，继续等待，暂不启动新 runner。`);
        }
        restartTimer = setTimeout(wait, 50);
        return;
      }
      restartTimer = null;
      startOnce(0);
    };
    wait();
    return null;
  };

  if (prev && verdict === 'take' && (lockProcessAlive(prev.pid, prev.creationTime) || (parentGone(prev) && lockProcessAlive(prev.guard, prev.guardCreationTime)))) return retireStopped(prev);
  if (verdict === 'skip') return 0;
  if (verdict === 'adopt') return adoptExisting(prev);
  startOnce(0);
  return null; // 交给子进程的 exit 事件收尾
}

// 被测试 import 时不要真的去启动 runner。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const code = main();
    if (code !== null) process.exit(code);
  } catch (err) {
    log(`本次守卫启动未完成：${err.message}`);
    process.exitCode = 1;
  }
}
