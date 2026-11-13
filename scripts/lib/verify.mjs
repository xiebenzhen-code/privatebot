// 066 · 自己跑一遍测试：执行者说「测试通过」，执行器不采信，自己跑一遍来对照。
//
// 跑的是普通命令（npm test 之类），不经过任何模型、不花额度。结果是程序的退出码和输出，执行者改不了。
// 这里只管三件事：这个项目的测试命令是什么、能不能放心跑、跑出来是什么。对照「它怎么说的」在工作台那边做。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 命令里每一段只许这些字符——配置是你自己写的，但 Windows 上要过一层 shell，不让任何一段带出别的命令。 */
const TOKEN = /^[\w@.\/:=+-]{1,120}$/;
export const VERIFY_TAIL = 1500;
export const VERIFY_DEFAULT_MINUTES = 10;

/** 把配置里的一行命令拆成参数。不合规返回 null。 */
export function parseCommand(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 12 || parts.some((p) => !TOKEN.test(p))) return null;
  return parts;
}

function scriptsOf(text) {
  try { const j = JSON.parse(text); return j && typeof j === 'object' && j.scripts && typeof j.scripts === 'object' ? j.scripts : {}; } catch { return null; }
}

/**
 * 这个项目的测试命令。
 *   cfg.verify === false           → 整个功能关掉
 *   cfg.tests[项目名] = "npm test"  → 用你写的
 *   cfg.tests[项目名] = "" / false  → 这个项目不核对
 *   没写                           → 有 package.json 而且里面有真的 test 脚本，就用 npm test；否则没有可核对的
 * @returns {{cmd: string[]|null, label: string, why: string}}
 */
export function testCommandFor(cfg, projectName, dir, read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)) {
  if (cfg?.verify === false) return { cmd: null, label: '', why: 'off' };
  const tests = cfg?.tests && typeof cfg.tests === 'object' ? cfg.tests : {};
  if (Object.hasOwn(tests, projectName)) {
    const v = tests[projectName];
    if (v === false || v === '' || v == null) return { cmd: null, label: '', why: 'off' };
    const cmd = parseCommand(v);
    return cmd ? { cmd, label: cmd.join(' '), why: '' } : { cmd: null, label: '', why: 'bad-command' };
  }
  const pkg = read(join(dir, 'package.json'));
  const scripts = pkg == null ? null : scriptsOf(pkg);
  const t = String(scripts?.test ?? '').trim();
  if (!t || /no test specified/i.test(t)) return { cmd: null, label: '', why: 'none' };
  return { cmd: ['npm', 'test'], label: 'npm test', why: '' };
}

/**
 * 这次任务有没有动「测试命令本身」（package.json 的 scripts）。
 * 动了就不在宿主上跑：执行者自己跑命令要过审批规则，我们替它跑一条它刚改写的命令，等于帮它绕过去。
 * 沙箱里不用管这个——容器本身就是隔离。拿不准（读不出来）算动了。
 */
export function scriptsChanged(dir, gitRun, read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)) {
  let before = null;
  try { before = String(gitRun(dir, 'show', 'main:package.json')); } catch { before = null; }
  const after = read(join(dir, 'package.json'));
  if (before == null && after == null) return false;
  if (before == null || after == null) return true;
  const a = scriptsOf(before), b = scriptsOf(after);
  if (a == null || b == null) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** 输出只留尾巴，去掉控制字符。打码由调用方做（执行器有自己的 redact）。 */
export function tailOf(text, max = VERIFY_TAIL) {
  const s = String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return s.length > max ? s.slice(-max) : s;
}

/**
 * 超时要把整棵进程树收掉：npm test 自己只是个壳，真正跑测试的是它起的子进程，只杀壳会留下一个一直在跑的测试。
 * Windows 用 taskkill /T；别处杀整个进程组（起的时候 detached，自己是组长）。
 */
export function killTree(child, { platform = process.platform, run = spawnSync } = {}) {
  const pid = child?.pid;
  if (!pid) return;
  if (platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已经没了 */ } }
}

/**
 * 在一个目录里把测试跑一遍。不阻塞（执行器还要按时打心跳）。
 * @returns {Promise<{status:'pass'|'fail'|'timeout'|'error', code:number, tail:string, ms:number}>}
 */
export function runVerify({ dir, cmd, timeoutMs, env = process.env, spawnFn = spawn, kill }) {
  const started = Date.now();
  return new Promise((done) => {
    let out = ''; let settled = false; let child; let timer = null;
    const finish = (status, code) => { if (settled) return; settled = true; clearTimeout(timer); done({ status, code, tail: tailOf(out), ms: Date.now() - started }); };
    const keep = (chunk) => { out += String(chunk); if (out.length > 200_000) out = out.slice(-100_000); };
    try {
      // Windows 上 npm 是 npm.cmd，新版 Node 不让不过 shell 直接起 .cmd；参数已经逐段校验过。
      // 别处：自己一个进程组（detached），超时能连 npm 起的子进程一起收掉。
      const win = process.platform === 'win32';
      child = spawnFn(cmd[0], cmd.slice(1), { cwd: dir, env, windowsHide: true, shell: win, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { out = String(err?.message ?? err); return finish('error', -1); }
    timer = setTimeout(() => {
      try { (kill ?? killTree)(child); } catch { /* 进程已经没了 */ }
      finish('timeout', -1);
    }, timeoutMs);
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    child.on('error', (err) => { keep(`\n${err?.message ?? err}`); finish('error', -1); });
    child.on('close', (code) => finish(code === 0 ? 'pass' : 'fail', typeof code === 'number' ? code : -1));
  });
}
