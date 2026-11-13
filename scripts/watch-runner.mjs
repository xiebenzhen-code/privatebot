// 执行器看护：每分钟新起一次，看执行器还在不在动，不在动就拉起来，并把现场记进日志。
//
// 为什么不是常驻看守：常驻的自己也会被同一种方式带走。2026-11-06 那一晚，guard 和 runner
// 一起消失，`runner-autostart.log` 里连「runner 退出」都没留下——JS 层根本没机会执行。
// 计划任务每次新起一个进程，被带走也只丢这一次；下一次触发照常来。
//
// 判断只看一个文件：`runner.beat`。runner 每 30 秒写一次时间戳，超过 90 秒没动就是「不动了」。
// 不看计划任务状态——`Running` 只代表外层 powershell 在等，`Ready` 也不代表执行器没了
// （2026-11-06 现场：任务显示 Ready，guard 和 runner 都还在跑）。这两个数经常和事实相反。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockProcessAlive, busyValid } from './runner-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.WB_RUNNER_STATE ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ai-workbench');
const BEAT = join(STATE_DIR, 'runner.beat');
const LOCK = join(STATE_DIR, 'runner.lock');
const LOG = join(STATE_DIR, 'watch.log');
const MARK = join(STATE_DIR, 'watch.state');
const TASK = process.env.WB_RUNNER_TASK ?? 'AI Workbench Runner';

/** 心跳超过这么久没动就算「执行器不动了」。3 拍心跳，够容忍一次慢 GC、一次卡住的文件写。 */
export const STALE_MS = Number(process.env.WB_WATCH_STALE_MS ?? 90_000);
/** 拉起来之后先等这么久再允许下一次拉，避免配置错时每分钟刷一次计划任务。 */
export const QUIET_MS = Number(process.env.WB_WATCH_QUIET_MS ?? 5 * 60_000);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 心跳是多少秒之前的；读不到 / 时间戳坏了返回 null（当作从没跳过）。 */
export function beatAge(beat, now = Date.now()) {
  const t = Date.parse(beat?.ts ?? '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}

/**
 * 该不该拉起来。
 *
 * 三种结果：
 *   ok             心跳新鲜，什么都不用做；
 *   restart:true   心跳停了 / 从来没有，该拉；
 *   restart:false  心跳停了但刚刚才拉过一次，等下一轮（拉起来要十几秒才写出心跳，
 *                  这一分钟必然还是停的，不等就会连着拉三次）。
 */
export function check(facts = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? STALE_MS;
  const quietMs = opts.quietMs ?? QUIET_MS;
  const age = beatAge(facts.beat, now);
  const runnerAlive = !!(facts.lock && (opts.isAlive ? opts.isAlive(facts.lock.pid, -1) : lockProcessAlive(facts.lock.pid, facts.lock.creationTime)));

  if (age !== null && age <= staleMs) {
    return { ok: true, restart: false, age, runnerAlive, reason: `心跳正常（${Math.round(age / 1000)} 秒前）` };
  }

  if (runnerAlive && busyValid(facts.busy, facts.lock.pid, now)) {
    return { ok: true, restart: false, age, runnerAlive, reason: '执行器在跑有效的长命令' };
  }

  const why = age === null ? '没有心跳（从没跳过或文件被清掉）' : `心跳停在 ${Math.round(age / 1000)} 秒前`;
  const state = runnerAlive ? '进程还在，多半是卡住了' : '进程也不在了';
  const last = Number(facts.lastRestartAt) || 0;
  const waited = last ? now - last : Infinity;
  if (waited < quietMs) {
    return {
      ok: false, restart: false, age, runnerAlive,
      reason: `${why}，${state}；${Math.round(waited / 1000)} 秒前刚拉过一次，等下一轮`,
    };
  }
  return { ok: false, restart: true, age, runnerAlive, reason: `${why}，${state}` };
}

function stamp() {
  return new Date().toISOString();
}

function logBlock(lines) {
  try {
    appendFileSync(LOG, lines.map((l) => `[${stamp()}] ${l}\n`).join(''), 'utf8');
  } catch {
    /* 日志写不进去不该拦住拉起 */
  }
}

/** 跑一段 PowerShell，取文本输出。超时就返回空串——看护卡在取证上比不取证更糟。 */
function ps(script, timeout = 15_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout,
  });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

/** 当前所有和 runner 有关的进程（pid、父进程、启动时间、命令行前 110 字）。 */
export function processSnapshot() {
  if (process.platform !== 'win32') return '(非 Windows，跳过进程快照)';
  // 排掉看护自己（它命令行里也有 watch-runner.mjs，混进来会让人以为那是执行器）。
  return ps(`
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'runner' -and $_.CommandLine -notmatch 'watch-runner' })
if ($p.Count -eq 0) { '（没有任何 runner / powershell 进程）' } else {
  $p | ForEach-Object {
    $c = ($_.CommandLine -replace '\\s+', ' ')
    if ($c.Length -gt 110) { $c = $c.Substring(0, 110) }
    '{0} ppid={1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToString('HH:mm:ss'), $c
  }
}`);
}

/** 最近十分钟的系统事件。掉线往往伴随电源 / 会话 / 崩溃事件。 */
export function eventSnapshot() {
  if (process.platform !== 'win32') return '(非 Windows，跳过事件快照)';
  return ps(`
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue |
  Select-Object -First 8 |
  ForEach-Object { '{0} id={1} {2}' -f $_.TimeCreated.ToString('HH:mm:ss'), $_.Id, $_.ProviderName }`);
}

function readState() {
  const s = readJson(MARK);
  return { lastRestartAt: Number(s?.lastRestartAt) || 0 };
}

function startTask() {
  if (process.platform !== 'win32') return '(非 Windows，没有计划任务可拉)';
  return ps(`try { Start-ScheduledTask -TaskName '${TASK}'; '已请求启动 ' + '${TASK}' } catch { '启动失败：' + $_.Exception.Message }`);
}

/** 拉起来之后最多等这么久看心跳有没有续上。 */
async function waitBeat(ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const age = beatAge(readJson(BEAT));
    if (age !== null && age <= STALE_MS) return age;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const beat = readJson(BEAT);
  const lock = readJson(LOCK);
  const state = readState();
  const verdict = check({ beat, lock, busy: readJson(join(STATE_DIR, 'runner.busy')), lastRestartAt: state.lastRestartAt });

  if (verdict.ok) return 0; // 一切正常就不写字，日志只留事故

  const head = `看护：${verdict.reason}`;
  if (!verdict.restart) {
    logBlock([head, '这一轮不动手。']);
    return 0;
  }

  const lines = [
    head,
    `计划任务：${process.platform === 'win32' ? ps(`(Get-ScheduledTask -TaskName '${TASK}').State`) || '(读不到)' : '(非 Windows)'}`,
    `心跳：${beat?.ts ?? '(没有文件)'}`,
    `锁：${lock ? `pid=${lock.pid} guard=${lock.guard ?? '-'} ${lock.startedAt ?? ''}` : '(没有锁)'}`,
    '进程快照：',
    ...processSnapshot().split('\n').map((l) => `  ${l}`),
    '最近十分钟系统事件：',
    ...eventSnapshot().split('\n').map((l) => `  ${l}`),
  ];
  logBlock(lines);

  writeFileSync(MARK, JSON.stringify({ lastRestartAt: Date.now() }), 'utf8');
  const out = startTask();
  logBlock([`拉起：${out || '(没有输出)'}`]);

  const age = await waitBeat();
  logBlock([
    age === null
      ? '拉起之后 20 秒内没有新心跳——下一轮会再来看，并把新的现场记下来。'
      : `已恢复，心跳 ${Math.round(age / 1000)} 秒前。`,
  ]);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = await main();
  if (typeof code === 'number' && code !== 0) process.exit(code);
}
