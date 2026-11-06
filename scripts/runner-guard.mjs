// 执行器的单实例守卫：登录自启和手动启动撞在一起时，只让一个 runner 活着。
//
// 为什么需要它：两个 runner 同时在线不会重复领同一个任务（claimTask 用
// `WHERE status='queued'` 原子抢），但会各自领走不同任务并行跑，等于同一份额度
// 花两遍；而且两个进程同时动同一个 worktree 容易互相踩。
//
// 判断「有人在跑」靠锁文件里的 pid + 进程存活，不靠命令行字符串匹配：
// 命令行匹配会把 `runner.mjs --check`（自检）和编辑器里开着的文件误当成实例。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * 锁说「还有人在跑」该怎么办（035.5）。
 *
 * 三种，不能只分两种：
 *   take  —— 没有锁 / runner 已经不在：正常起一个；
 *   skip  —— runner 活着，**看守它的那个守卫也活着**：这一次重复启动了，退出；
 *   adopt —— runner 活着，但守卫已经不在了（被强杀、计划任务 Stop 只带走了守卫）：
 *            不能当没事发生——那是「活着但没人看」的执行器，卡死了也没人重开。
 *            也不能再起一个——那就两个 runner 抢同一份额度。正确做法是自己接手当看守。
 */
export function decide(lock, isAlive = alive) {
  if (!lock || typeof lock !== 'object') return 'take';
  if (!isAlive(lock.pid)) return 'take';
  return isAlive(lock.guard) ? 'skip' : 'adopt';
}

function log(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    appendFileSync(LOG, line, 'utf8');
  } catch {
    /* 日志写不进去不该拦住 runner */
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK, 'utf8'));
  } catch {
    return null;
  }
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
  if (verdict === 'skip') {
    log(`另一个 runner 还活着（pid ${prev.pid}，${prev.startedAt ?? '未知时间'}启动），而且有守卫（pid ${prev.guard}）在看着，这次跳过。`);
    return 0;
  }
  if (prev && verdict === 'take') log(`锁里的 pid ${prev.pid} 已经不在，接管。`);

  const entry = join(REPO, 'scripts', 'runner.mjs');
  if (!existsSync(entry)) {
    log(`找不到 ${entry}，退出。`);
    return 1;
  }

  let stopping = false;
  // 035.4：这两个是「当前」而不是「这一次」——停止信号和重启定时器都只该有一份。
  let current = null;
  let restartTimer = null;

  /**
   * 035.4：停止信号只注册一次，指向**当前活着的**子进程。
   * 原来每次 startOnce 都挂一组、各自捕获自己的 child，但 stopping 是共用的：
   * 第一次的子进程死后旧监听器还在，收到 SIGTERM 时它先 kill 那个已经死掉的 pid，
   * 接着把 stopping 置真，新监听器一看就直接返回——活着的那个 runner 因此永远不会被停。
   */
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const plan = stopPlan(current);
    log(`收到 ${sig}，结束 runner（pid ${plan.kill || '无'}）。`);
    if (plan.exit) process.exit(0); // 重启间隙里收到停止：没有子进程可等，直接收工
    current.kill(sig);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => stop(sig));

  /**
   * 起一次 runner，并盯着它。原来跑起来后只等 exit——进程要是「还在、但不干活了」，
   * 这里永远等不到，计划任务看着也是「正在运行」，实际上什么都没做。现在用心跳文件兜这个洞。
   */
  const startOnce = (fastExits) => {
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

    writeFileSync(LOCK, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), guard: process.pid }), 'utf8');

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

    current = child;

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
      if (cur && Number(cur.pid) === child.pid) {
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
   * 035.5：接管一个「还在跑、但没人看」的 runner。
   *
   * 不 spawn 第二个（会双开、双份额度），也不放着不管（卡死了没人重开）。
   * 这里只做两件事：把锁的 guard 改成自己，然后用心跳文件盯着那个 pid——
   * 它自己退了就重开；它卡住了就杀掉、等它真的消失再重开（保证任何时刻只有一个）。
   */
  const adoptExisting = (lock) => {
    const pid = Number(lock.pid);
    log(`runner（pid ${pid}）还活着，但看守它的守卫（${lock.guard ?? '没有记录'}）已经不在了——接手监护，不再起第二个。`);
    writeFileSync(LOCK, JSON.stringify({ ...lock, pid, guard: process.pid, adoptedAt: new Date().toISOString() }), 'utf8');
    current = { pid, kill: (sig) => { try { process.kill(pid, sig); } catch { /* 已经没了 */ } } };
    let restarting = false;
    const reap = () => {
      const gone = setInterval(() => {
        if (alive(pid)) return;
        clearInterval(gone);
        clearInterval(dog);
        current = null;
        if (stopping) return;
        log(`接手的 runner（pid ${pid}）已经退出，重开。`);
        startOnce(0);
      }, 100);
    };
    const dog = setInterval(() => {
      if (stopping || restarting) return;
      if (!alive(pid)) {
        restarting = true;
        log(`接手的 runner（pid ${pid}）自己退了，重开。`);
        clearInterval(dog);
        current = null;
        startOnce(0);
        return;
      }
      const b = readBeat();
      if (!beatStale(b)) return;
      if (busyValid(readBusy(), pid)) return;
      restarting = true;
      log(`接手的 runner ${pid} 心跳停住（最后一下 ${b?.ts ?? '从没写过'}），杀掉重开。`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
      clearInterval(dog);
      reap();
    }, DOG_MS);
    return null;
  };

  if (verdict === 'adopt') return adoptExisting(prev);
  startOnce(0);
  return null; // 交给子进程的 exit 事件收尾
}

// 被测试 import 时不要真的去启动 runner。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = main();
  if (code !== null) process.exit(code);
}
