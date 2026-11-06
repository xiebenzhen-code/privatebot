#!/usr/bin/env node
// 008 executor: claims a task, works in an isolated git worktree, reports progress, finishes into
// a merge approval. Zero dependencies.
//
//   node scripts/runner.mjs            run the loop until Ctrl+C
//   node scripts/runner.mjs --once     claim and run at most one task
//
// Config: ~/.ai-workbench-runner.json (never committed)
//   { "workbench": "http://localhost:3200",
//     "projects": { "ai-workbench": "C:/Users/you/ai-workbench" },
//     "worktreeRoot": "C:/Users/you/wb-worktrees",
//     "executors": { "zcode": { "tool": "claude", "model": "glm-4.6", "env": { "...": "..." } } } }
// The ZAI key lives only in this process's environment (or the config file, which is git-ignored).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { parseSuggestions } from './lib/notes-core.mjs';
import { dirname, join, resolve, basename } from 'node:path';
import { addRemote, cloneProject, createProject } from './lib/projects.mjs';
import { deployDirs, needsDeploy, runDeploy, shouldDeploy } from './lib/deploy.mjs';
import { githubRelayRound } from './lib/github-relay.mjs';
import { getProvider } from './lib/sandbox/provider.mjs';
import { parseAsk, resumeArgs, resumeData, resumeLost, resumeMessage } from './lib/ask.mjs';
import { anySandbox, applySandboxPatch, flagLine, runInSandbox, sandboxModeFor, sandboxPlan } from './lib/sandbox/run.mjs';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const CONFIG_FILE = join(HOME, '.ai-workbench-runner.json');
const WB_FILE = join(HOME, '.ai-workbench.json');
const LOG_DIR = join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'ai-workbench');
const HEARTBEAT_MS = 30_000;
// 每跳一次就写一回，给 guard 看「进程还动不动」。路径必须和 scripts/runner-guard.mjs 里的 BEAT 一致。
const BEAT_FILE = join(LOG_DIR, 'runner.beat');
/**
 * 035.4：长同步命令（git fetch/push、克隆）会把主线程钉住，心跳定时器跟着停。
 * 只靠「把阈值调大」是骗自己：真卡死也不杀了。这里给守卫一份**有界**的忙声明——
 * 声明期间不杀，声明过期照杀，而且最长只认 15 分钟。路径要和 runner-guard.mjs 的 BUSY 一致。
 */
const BUSY_FILE = join(LOG_DIR, 'runner.busy');

// ---------- 043 A：同时跑多个任务 ----------
//
// 以前主循环是 `await runTask(...)`：跑完一个才领下一个，执行者设置里的「同时跑几个」只是摆设。
// 现在每个任务各自异步跑。只有「编码」这一段占名额；改完在等你批合并 / 推送的任务不占——
// 它们只是在轮询审批，不花模型额度，不能因为你没空批就把后面的活全堵住。
//
// 本机的 Git 调用同步串行。跨审批等待用不可变快照协调推送与其它任务的合并。
export const inFlight = new Map(); // task id → 'coding' | 'waiting'
let draining = false;
let deployTail = Promise.resolve();
let claiming = false;

export function maxParallel(cfg) {
  const n = Math.round(Number(cfg?.maxParallel ?? 3));
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 3;
}

export const codingCount = () => [...inFlight.values()].filter((p) => p === 'coding').length;

/** 还能不能再领一个：在排空（准备重启）时一个都不领。 */
export function canClaim(cfg) {
  return !draining && codingCount() < maxParallel(cfg);
}

/**
 * 构建前停止领取并等编码结束。审批中的任务可以继续等待；交接前另查它们是否已结束。
 */
export async function drainOthers(selfId, { wait = sleep, say = log, notify = async () => {}, now = Date.now, remindMs = 30 * 60_000 } = {}) {
  draining = true;
  let since = now();
  const others = () => [...inFlight].filter(([id, phase]) => id !== selfId && phase === 'coding').map(([id]) => id);
  while (claiming || others().length) {
    if (others().length && now() - since >= remindMs) {
      const text = `还有 ${others().length} 个任务在跑（${others().map((id) => `T-${id}`).join('、')}），执行器重启要等它们做完`;
      say(text);
      await notify(text);
      since = now();
    }
    await wait(5_000);
  }
}

export function endDrain() { draining = false; }

/** 测试用：把排空状态恢复成初始。 */
export function resetParallelState() {
  inFlight.clear();
  endDrain();
}
const BUSY_MAX_MS = 15 * 60_000;

export function writeBusy(ms, why, now = Date.now()) {
  const until = new Date(now + Math.min(ms, BUSY_MAX_MS)).toISOString();
  try {
    writeFileSync(BUSY_FILE, JSON.stringify({ pid: process.pid, until, why }), 'utf8');
  } catch {
    /* 写不进去也不能拦着正事 */
  }
}

export function clearBusy() {
  try {
    unlinkSync(BUSY_FILE);
  } catch {
    /* 已经没了 */
  }
}

/** 包住一条可能跑很久的同步命令：跑前声明，跑完（成功失败都）撤销。 */
export function withBusy(ms, why, fn) {
  writeBusy(ms, why);
  try {
    return fn();
  } finally {
    clearBusy();
  }
}
const PROGRESS_MS = 15_000;
const RULES_FILE = new URL('./runner-rules.md', import.meta.url);
// 035.3：这个执行器自己所在的仓库。部署审批只对它弹——别的项目改了 src/ 跟工作台容器没关系。
const SELF_REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 心跳连续失败到第几次才值得写一行日志：第一次必写，之后每 20 次（30 秒一次 ≈ 10 分钟）写一条。
 * 抽查一条死链时，中间那几十行除了把日志撑大没别的用；但一次都不写，就等于把这个部件做成黑盒。
 */
export function shouldLogBeat(failCount) {
  if (!(failCount > 0)) return false;
  return failCount === 1 || failCount % 20 === 0;
}

function log(line) {
  const stamp = new Date().toISOString();
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = stamp.slice(0, 10);
    appendFileSync(join(LOG_DIR, `runner-${day}.log`), `${stamp} ${line}\n`);
  } catch { /* logging must never break the run */ }
  if (process.env.WB_RUNNER_VERBOSE) console.log(line);
}

// ---------- pure helpers (tested) ----------

// ---------- 028.1: 代码指纹 ----------
// 执行器启动时把 runner.mjs 读进内存，之后磁盘上怎么改都影响不到这个进程。
// 记下启动时的指纹，每次心跳重算一次：不一致就说明「在跑旧代码」，让页面提醒重启。

/** 参与指纹的文件：入口脚本 + scripts/lib 下的所有 .mjs。 */
function codeFiles() {
  const out = [new URL('./runner.mjs', import.meta.url)];
  try {
    const lib = new URL('./lib/', import.meta.url);
    for (const name of readdirSync(lib)) if (name.endsWith('.mjs')) out.push(new URL(name, lib));
  } catch { /* 没有 lib 目录也不算错 */ }
  return out.sort((a, b) => (a.href < b.href ? -1 : 1));
}

export function codeFingerprint(files = codeFiles()) {
  const h = createHash('sha256');
  for (const f of files) {
    try {
      h.update(readFileSync(f));
    } catch {
      h.update('missing');
    }
  }
  return h.digest('hex');
}

/** 013.5: whatever ends up on a task page is scrubbed first — errors carry headers and paths. */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(bearer)\s+([^\s,;"']{6,})/gi, '$1 ***')
    .replace(/(authorization|token|key|secret|password)(["']?\s*[:=]\s*["']?|\s+)([^\s,;"'}]{6,})/gi, (_m, p1, p2) => `${p1}${p2}***`)
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
    // 025.1：本机路径里的 Windows 用户名不进任务页（028.2 的同一条规则，这里留一份，
    // 因为执行器是独立脚本，不 import 服务端的 .ts）。
    .replace(
      /\b([A-Za-z]:[\\/]users[\\/])(?!~)([^\r\n\\/]*?)(?=[\\/]|[,;:"'()\[\]<>。，；：）】]|\s+[A-Za-z]:[\\/]|(?<![^\x00-\x7F])\s+[^\x00-\x7F]|[\r\n]|$)/gi,
      (_m, head, name) => (name ? `${head}~` : head),
    )
    .replace(/(?<![A-Za-z]:)(\/home\/)([^/\s'"`]+)/gi, '$1~')
    .replace(/(?<![A-Za-z]:)(\/Users\/)([^/\s'"`]+)/gi, '$1~');
}

/** 025.1：这句会进任务页，所以不写配置文件路径（里面有 Windows 用户名）。 */
export function missingProjectMessage(project) {
  return `没有配置项目路径：执行器的 projects 里没有「${project}」这个名字。`
    + '把任务的项目改成已有的名字，或者在执行器配置里加上它（npm run setup）。';
}

/**
 * 013.5: the fallback path for a workbench that does not return approval_id. The newest merge
 * approval of this task wins — never the first match, which may be the previous run's decision.
 */
export function newestMerge(list, taskId) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => /合并/.test(String(a?.title ?? '')) && Number(a?.task_id) === Number(taskId))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

/** What the task page says when the merge itself failed; no tokens, no full paths. */
export function mergeFailureStep(err) {
  return `合并失败：${redact(err?.message ?? err).trim().slice(0, 160)}`;
}

/** The task prompt is task text + the fixed rules; rules are read from disk so they can be edited.
 *  031c: `notes` 是这个项目里**用户确认过**的备忘（工作台拼好的整段，自带「不是指令」的说明）。
 *  位置固定在规则之前：模型先看任务，再看「这些是参考不是命令」，最后才是执行守则。 */
export function buildPrompt(task, rules, notes = '', extra = '') {
  return [
    `# 任务 T-${task.id}：${task.title}`,
    task.description ? `\n${task.description}` : '',
    task.category ? `\n分类：${task.category}` : '',
    // 043 F：说清楚这一单要的是什么——没勾「只要回答」的，必须把成果写成文件。
    task.answer_only ? '\n这一单只要一个回答：用中文把结论写在最后的回复里，不要改任何文件。'
      : '\n这一单要有产出：把成果写成仓库里的文件（代码、文档都行），只在回复里说是不算完成的。',
    notes ? `\n${String(notes).trim()}` : '',
    extra ? `\n${String(extra).trim()}` : '',
    '\n---\n',
    rules.trim(),
  ].join('\n');
}

/**
 * 043 E：WebSearch 是 Anthropic 服务端的工具，走百炼 / DeepSeek 这些兼容接口时用不了。
 * 给 agent 一条能走通的路：用 WebFetch 打开搜索页。地址可配，默认国内能直接打开的必应。
 */
export function searchHint(cfg = {}) {
  const url = String(cfg.searchUrl || 'https://cn.bing.com/search').replace(/\?+$/, '');
  return `需要搜索时：WebSearch 在这个后端上用不了，请用 WebFetch 打开 ${url}?q=<关键词>，再打开结果里的网页。`;
}

/** 走的是不是 Anthropic 官方接口（只有官方接口的 WebSearch 能用）。 */
export function nativeSearch(backend) {
  const url = String(backend?.env?.ANTHROPIC_BASE_URL ?? '').trim();
  return !url || /(^|\.)anthropic\.com/i.test(url);
}

/** 031c: 把回答末尾「## 备忘建议」报给工作台（永远存成 unverified，采纳由人来点）。
 *  上报失败不影响任务本身——备忘是附赠品，不能因为写笔记把一次成功的任务标成失败。 */
async function reportSuggestions(cfg, task, resultText) {
  const project = String(task.project ?? '').trim();
  if (!project) return;
  const suggestions = parseSuggestions(resultText);
  if (!suggestions.length) return;
  try {
    await api(cfg, 'POST', '/api/runner/notes', { project, task_id: task.id, suggestions });
    log(`T-${task.id} 建议记住 ${suggestions.length} 条（等人采纳）`);
  } catch (err) {
    log(`T-${task.id} 上报备忘建议失败：${err.message}`);
  }
}

/** 031c: 开工前取这个项目里确认过的笔记。取不到就当没有——不阻断任务。 */
async function fetchNotes(cfg, task) {
  const project = String(task.project ?? '').trim();
  if (!project) return '';
  try {
    const q = new URLSearchParams({ project, title: task.title ?? '', description: task.description ?? '' });
    const r = await api(cfg, 'GET', `/api/runner/notes?${q.toString()}`);
    return String(r?.block ?? '');
  } catch (err) {
    log(`T-${task.id} 取项目备忘失败：${err.message}`);
    return '';
  }
}

/** --output-format stream-json emits one JSON object per line; only assistant/result matter. */
export function parseStreamLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  const usage = msg.usage ?? msg.message?.usage;
  const inputTokens = usage ? Math.max(0, Number(usage.input_tokens ?? 0)) : 0;
  const outputTokens = usage ? Math.max(0, Number(usage.output_tokens ?? 0)) : 0;
  // 017: input and output are priced differently, and a direct backend has to be billed from
  // what the runner saw — keep the split instead of only the sum.
  const counts = { tokens: inputTokens + outputTokens, inputTokens, outputTokens };
  if (msg.type === 'assistant') {
    const blocks = msg.message?.content ?? [];
    const said = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
    return { kind: 'step', step: said.slice(0, 120), ...counts };
  }
  if (msg.type === 'result') {
    // 028: `result` is the model's final answer — the deliverable for a read-only task. Keep the
    // whole thing (the workbench truncates at 8000); `summary` stays the short one for approvals.
    // 043 F：被拒掉的工具。无头模式下没人能点确认，拒了 agent 也照样退出码 0——要靠这个认出假完成。
    const denials = (Array.isArray(msg.permission_denials) ? msg.permission_denials : [])
      .map((d) => String(d?.tool_name ?? '').trim()).filter(Boolean);
    // 055.2：会话号，提问之后用 `claude -p --resume <会话号>` 接着干。
    return { kind: 'result', summary: String(msg.result ?? '').slice(0, 4000), text: String(msg.result ?? ''), failed: msg.is_error === true, denials, sessionId: String(msg.session_id ?? ''), ...counts };
  }
  if (msg.type === 'system' && msg.subtype === 'init') return { kind: 'init', model: msg.model ?? '', sessionId: String(msg.session_id ?? ''), ...counts };
  return { kind: 'other', ...counts };
}

export function branchOf(taskId) {
  return `wb/T-${taskId}`;
}

// ---------- 036: DeepSeek Harness（dsh）----------

/** 无头 + 机器可读事件。任务说明一律走 stdin，不占命令行参数。 */
export const DSH_ARGS = ['--profile', 'headless', '--json'];

/**
 * 036 B.2/C.3：dsh 默认把会话日志上报到官方收集端（mode 默认 FEEDBACK_ONLY，地址
 * https://dsh-otel-collector.deepseeksvc.com/v1/logs）。只有 FEEDBACK_ONLY / DISABLED 两个合法值，
 * 写别的（比如 off）会在启动时被配置校验拒掉，实测报 expected "FEEDBACK_ONLY" | "DISABLED"。
 *
 * 权限固定 read-only：执行中的审批接不上（见 036 的调研），dsh 的沙箱在 read-only 下是
 * fail-closed——写文件返回 [sandbox: file access denied under read-only mode]，升级到
 * workspace-write 要审批而 headless 没有审批通道，所以写任务在这里直接做不了，不会悄悄写进去。
 */
export const DSH_ENV = {
  DSH_TELEMETRY_MODE: 'DISABLED',
  DSH_PERMISSION_MODE: 'read-only',
};

/**
 * dsh `--json` 的一行事件 → 执行器内部的消息形状（和 parseStreamLine 对齐）。
 * 事件类型（0.2.1-rc.5 实测）：session / status / thinking / text / tool_call / tool_result / final。
 * 不认识的行返回 null，不让任务失败。
 */
export function parseDshLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  const usage = msg.usage;
  const inputTokens = usage ? Math.max(0, Number(usage.inputTokens ?? 0)) : 0;
  const outputTokens = usage ? Math.max(0, Number(usage.outputTokens ?? 0)) : 0;
  const counts = { tokens: inputTokens + outputTokens, inputTokens, outputTokens };
  if (msg.type === 'status') return usage ? { kind: 'other', ...counts } : null;
  if (msg.type === 'session') return { kind: 'init', model: '', ...counts };
  if (msg.type === 'thinking') return { kind: 'step', step: String(msg.text ?? '').slice(0, 120), ...counts };
  if (msg.type === 'tool_call') return { kind: 'step', step: `工具 ${String(msg.tool ?? '')}`.slice(0, 120), ...counts };
  if (msg.type === 'tool_result') {
    const failed = msg.status && msg.status !== 'completed';
    return failed ? { kind: 'step', step: String(msg.result ?? '').slice(0, 120), ...counts } : null;
  }
  if (msg.type === 'text') return { kind: 'step', step: String(msg.text ?? '').slice(0, 120), ...counts };
  if (msg.type === 'final') {
    const answer = String(msg.text ?? '');
    return { kind: 'result', summary: answer.slice(0, 4000), text: answer, failed: false, ...counts };
  }
  return { kind: 'other', ...counts };
}

/** 036 A.3：alpha 版本随时变，不能静悄悄跟着升级。锁了就必须一致。 */
export function dshVersionProblem(actual, required) {
  const want = String(required ?? '').trim();
  if (!want) return '';
  if (!actual) return '找不到 dsh，装好再跑 dsh 任务';
  if (String(actual).trim() !== want) {
    return `dsh 版本不对（配置锁的是 ${want}，这台机器是 ${actual}）：先用只读任务试一次，确认没问题再把 dshVersion 改成 ${actual}`;
  }
  return '';
}

/** 跑一次 `dsh --version`，拿不到就返回空串。doctor 和领任务时都用它。 */
export function dshVersion(cfg = {}, path) {
  const exe = path ?? which('dsh');
  if (!exe) return '';
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: process.platform === 'win32' });
    const m = String(r.stdout ?? '').trim().match(/\d+\.\d+\.\d+[\w.\-]*/);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

// ---------- 037: WorkBuddy 的 codebuddy ----------

/**
 * 无头 + 机器可读事件。提示词不走命令行参数：Windows 下参数要过 cmd.exe 一遍，带换行、引号
 * 或 %PATH% 的任务说明会被截断甚至展开；改走 stdin 的 stream-json（一条 user 消息，JSON 编码），
 * 内容和 shell 再没有交集。实测 codebuddy 2.179.1：`-p` 后面不给提示词、只塞纯文本 stdin
 * 时它一个字都不输出就退出 0——所以这里必须显式带上 --input-format。
 */
export const CODEBUDDY_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];

/**
 * 只读档：不给 -y，并且把能写盘、能执行命令的工具直接禁掉。不给 -y 时 codebuddy 自己也会挡住
 * 需要授权的操作，但模型会白试几轮；禁掉更干脆，也不会在 worktree 里留下半截改动。
 */
export const CODEBUDDY_READONLY_ARGS = ['--disallowedTools', 'Bash,Write,Edit,MultiEdit,NotebookEdit'];

export const CODEBUDDY_ENV = {
  // 纯 -p 单发模式跑不了后台任务（官方 headless 文档自己写了会报错），关掉免得模型拿到一个用不了的工具。
  CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
  // 2026-11-01 实测：从 WorkBuddy 那个宿主里起的进程会带着 SERVER__PORT（桌面端 daemon 的端口），
  // codebuddy 一读就去 listen 同一个端口，直接 `EADDRINUSE ... 127.0.0.1:65255` 起不来。
  // 空串实测等于「不指定」，它会自己分配端口。置空而不是删掉：childEnv 是白名单复制，
  // 这里显式给空值，才能保证不管父进程带什么都不会漏进来。
  SERVER__PORT: '',
};

/** 一条 user 消息，就是 --input-format stream-json 认的形状。 */
export function codebuddyPrompt(text) {
  const content = [{ type: 'text', text: String(text ?? '') }];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/**
 * write=false 是默认档：只读。写任务要同时满足「钩子写得进去」和「配置里 codebuddyWrite 显式开了」
 * ——真机批过一次人工审批再开，不默认放开。
 */
export function codebuddyArgs({ model = '', write = false } = {}) {
  const args = [...CODEBUDDY_ARGS];
  if (model) args.push('--model', String(model));
  if (write) args.push('-y');
  else args.push(...CODEBUDDY_READONLY_ARGS);
  return args;
}

/** 版本号只认第一个 x.y.z；拿不到返回空串。 */
export function codebuddyVersion(exe) {
  if (!exe) return '';
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: process.platform === 'win32' });
    const m = String(r.stdout ?? '').trim().match(/\d+\.\d+\.\d+/);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

/**
 * 登录状态的判据只有它自己吐出来的话。codebuddy 没登录时**退出码是 0**，回答里带一句
 * 「Authentication required. Please use /login command」，usage 全是 0（实测 2.179.1）。
 * 所以「退出码为 0」在这条工具上不能当成跑通了。
 */
export function loginState(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 'unknown';
  if (/Authentication required|Please use \/login|not logged in|请先登录|未登录/i.test(s)) return 'logged-out';
  // 2026-11-01 踩到的：起了但没起来（端口被占、模块缺失、配置拉不到）时它吐的是报错栈，
  // 既不含「没登录」也不含任何回答。原来的写法只要「说了点什么」就当 'ok'，等于把崩溃读成已登录。
  if (/EADDRINUSE|listen E[A-Z]+|Cannot find module|ERR_MODULE_NOT_FOUND|TypeError:|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket disconnected/i.test(s)) return 'unknown';
  return 'ok';
}

export function loginProblem(state, tool = 'codebuddy') {
  if (state === 'logged-out') return `${tool} 没登录：先在终端跑一次 ${tool}，进去用 /login 登录（执行器不保存账号密码，只沿用本机已登录的状态）`;
  if (state === 'unknown') return `${tool} 一个字都没回：先手动跑一次 \`${tool} -p hi\`，看是网络、代理还是启动就挂了`;
  return '';
}

/** 登录探测要花一次极小的请求，30 分钟内不重复问。 */
let loginCache = { exe: '', at: 0, state: '' };
const LOGIN_TTL_MS = 30 * 60_000;

export function codebuddyLoginState(exe, { now = Date.now(), run } = {}) {
  if (loginCache.exe === exe && now - loginCache.at < LOGIN_TTL_MS) return loginCache.state;
  const doRun = run ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
  let stdout = '';
  let stderr = '';
  try {
    // --port 0 是保险：万一 SERVER__PORT 还是漏进来了，也别去抢桌面端那个端口。
    const r = doRun(exe, ['-p', 'ok', '--output-format', 'json', '--max-turns', '1', '--port', '0'], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: childEnv(process.env, { ...CODEBUDDY_ENV, WB_SOURCE: 'runner' }),
    });
    stdout = String(r?.stdout ?? '');
    stderr = String(r?.stderr ?? '');
  } catch {
    stdout = '';
    stderr = '';
  }
  // 有回答就只看回答：stderr 里常有 `fetch config failed TypeError ...` 这种无害告警
  // （代理开关下必现），混在一起会把好结果读成「崩了」。没回答才拿报错去判。
  const state = loginState(stdout.trim() ? stdout : stderr);
  loginCache = { exe, at: now, state };
  return state;
}

/**
 * 037 C/4：审批门写在 worktree 里的 .codebuddy/settings.local.json（本地作用域，优先级最高）。
 * 不用 CODEBUDDY_CONFIG_DIR 隔离——登录状态就存在那下面，隔离了等于每次都要重新登录；
 * 也不动 ~/.codebuddy/settings.json——那是用户自己日常在用的，执行器不该改。
 */
export function writeCodebuddyGate(dir, { hookPath = HOOK_SCRIPT, gitRun = git } = {}) {
  const settingsDir = join(dir, '.codebuddy');
  const file = join(settingsDir, 'settings.local.json');
  const mine = join(settingsDir, '.wb-gate');
  if (existsSync(file) && !existsSync(mine)) {
    return { ok: false, file, why: '仓库自带 .codebuddy/settings.local.json，执行器保证不了自己的门禁生效' };
  }
  const abs = hookPath instanceof URL ? fileURLToPath(hookPath) : String(hookPath);
  if (!existsSync(abs)) return { ok: false, file, why: `钩子脚本不存在：${abs}` };
  // codebuddy 在 Windows 上固定用 Git Bash 跑钩子，路径给正斜杠最稳。
  const command = `node "${abs.replace(/\\/g, '/')}"`;
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 1800 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
      Stop: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
    },
  };
  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2));
    writeFileSync(mine, new Date().toISOString());
    // 文件不进版本库：不然「只读任务」也会被自己写的门禁配置弄成有改动。
    excludeFromGit(dir, '.codebuddy/');
    return { ok: true, file, why: '' };
  } catch (err) {
    return { ok: false, file, why: `门禁配置写入失败：${err.message}` };
  }
}

/** 往仓库的 info/exclude 里加一条本地忽略（不动 .gitignore，不算改动）。 */
export function excludeFromGit(dir, pattern, gitRun = git) {
  const common = gitRun(dir, 'rev-parse', '--git-common-dir');
  const file = resolve(dir, common, 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some((line) => line.trim() === pattern)) return file;
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return file;
}

/** 037：一次跑的 token 记到哪个账号。codebuddy 花的是本机 WorkBuddy 账号，没配就记「WorkBuddy」。 */
export function usageAccountOf(backend = {}) {
  if (backend.account) return String(backend.account);
  return backend.tool === 'codebuddy' ? 'WorkBuddy' : '';
}

/** 这个执行者是不是用 codebuddy 跑；不是就返回空 problem，谁都不用管。 */
export function codebuddyGate(spec = {}, { probe, find = which } = {}) {
  const backends = backendsFor(spec);
  if (!backends.some((b) => b.tool === 'codebuddy')) return { problem: '', exe: '', version: '', state: '' };
  const configured = String(spec?.codebuddyPath ?? '').trim();
  const exe = configured || find('codebuddy');
  if (!exe) {
    return {
      problem: '找不到 codebuddy：先 `npm i -g @tencent-ai/codebuddy-code`（要 ≥ 2.179），或在执行者配置里写 codebuddyPath',
      exe: '', version: '', state: '',
    };
  }
  if (configured && !existsSync(configured)) {
    return { problem: `codebuddyPath 指的文件不存在：${configured}`, exe: '', version: '', state: '' };
  }
  const version = codebuddyVersion(exe);
  const state = (probe ?? codebuddyLoginState)(exe);
  return { problem: loginProblem(state), exe, version, state };
}

/**
 * 031a: 分支不能到期就删——未合并的分支可能是 agent 已经干完、用户还没收的成果。
 * 这里只做「看一眼」：把仓库里的 wb/T-* 分支和 worktree 列出来，删不删由工作台决定
 * （它知道哪些任务还在跑，也知道用户点过哪个删除）。真正动 git 的是 applyCleanup。
 */
export function taskIdOfBranch(branch) {
  const m = /^wb\/T-(\d+)(?:-\d+)?$/.exec(branch);
  return m ? Number(m[1]) : null;
}

/** 解析 `git worktree list --porcelain`：每块以 worktree <path> 开头，可能带 branch 或 detached。 */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { dir: line.slice('worktree '.length).trim(), branch: '', detached: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    if (line.trim() === 'detached') cur.detached = true;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 扫一遍：哪些分支已经合并、哪些领先 main 几个提交、哪些还挂着 worktree、worktree 里有没有没提交的改动。
 * worktreeRoot 之外的目录不算（那是用户自己开的，不能碰）。
 *
 * 031a.1：读不出来 ≠ 没有。
 * - 没有 main（仓库默认分支叫 master、main 被改名/删掉、main 还没有提交）→ 整个项目跳过，
 *   `skipped` 写一句人话。绝不能当成「所有分支都没合并、都没提交」继续往下算——那会把
 *   有成果的分支删掉。
 * - 某条分支的 `rev-list` 失败 → `ahead: null`（未知），服务端遇到未知只上报、不删。
 */
export function scanBranches(project, worktreeRoot, run = git) {
  // 先确认 main 在，不然下面每条命令都会失败，而失败会被当成「没有」。
  try {
    run(project, 'rev-parse', '--verify', 'refs/heads/main');
  } catch {
    return { branches: [], worktrees: [], skipped: '这个仓库没有 main 分支，这次不清理' };
  }

  const rootNorm = String(worktreeRoot).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const worktrees = [];
  try {
    for (const w of parseWorktrees(run(project, 'worktree', 'list', '--porcelain'))) {
      const dirNorm = String(w.dir).replace(/\\/g, '/').toLowerCase();
      if (!dirNorm.startsWith(`${rootNorm}/`)) continue;
      let dirty = false;
      try { dirty = Boolean(run(w.dir, 'status', '--porcelain')); } catch { dirty = true; } // 读不出来就当有改动，宁可不删
      worktrees.push({ dir: w.dir, branch: w.branch, dirty });
    }
  } catch { /* 不是 git 仓库就算了 */ }

  const merged = new Set();
  try {
    for (const b of run(project, 'branch', '--merged', 'main', '--format=%(refname:short)').split('\n')) {
      const name = b.replace(/^[*+]\s+/, '').trim();
      if (name) merged.add(name);
    }
  } catch {
    // 读不出哪些已合并，就不能判断谁安全——这个项目整个跳过。
    return { branches: [], worktrees, skipped: '读不出哪些分支已经合并进 main，这次不清理' };
  }

  const branches = [];
  let refs = '';
  try {
    refs = run(project, 'for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/heads/wb/T-*');
  } catch { refs = ''; }
  for (const line of refs.split('\n')) {
    const [branch, tip, date] = line.split('\t');
    if (!branch) continue;
    let ahead = null;
    try {
      const n = Number(run(project, 'rev-list', '--count', `main..${branch}`));
      ahead = Number.isFinite(n) ? n : null; // 解析不出来也是「未知」，不是 0
    } catch { ahead = null; }
    const wt = worktrees.find((w) => w.branch === branch) || null;
    branches.push({
      branch, tip: tip || '', ahead, merged: merged.has(branch),
      lastCommitAt: date || null,
      worktree: wt ? { dir: wt.dir, dirty: wt.dirty } : null,
    });
  }
  return { branches, worktrees, skipped: null };
}

/** 按工作台给的计划动 git：先拆 worktree（否则被占用的分支删不掉），再删分支。 */
export function applyCleanup(project, plan, run = git) {
  const cleaned = [];
  const failed = [];
  for (const dir of plan?.deleteWorktrees ?? []) {
    try { run(project, 'worktree', 'remove', '--force', dir); } catch (err) {
      if (existsSync(dir)) failed.push({ branch: `worktree:${dir.split(/[\\/]/).pop()}`, reason: redact(err.message).slice(0, 120) });
    }
  }
  for (const b of plan?.deleteBranches ?? []) {
    if (!b.tip) {
      // 没有当时看到的提交号就没法核对，宁可不删。
      failed.push({ branch: b.branch, reason: '没拿到扫描时的提交号，没有删' });
      continue;
    }
    try {
      // 031a.1：带旧值删。扫描到删除之间如果有新提交，update-ref 会直接失败——那正是要的结果。
      run(project, 'update-ref', '-d', `refs/heads/${b.branch}`, b.tip);
      cleaned.push(b.branch);
    } catch (err) {
      failed.push({ branch: b.branch, reason: redact(err.message).slice(0, 120) });
    }
  }
  return { cleaned, failed };
}

/**
 * Why the run stopped goes first: `step` keeps only the first ~200 characters, and a 4000-character
 * model summary would push «被总开关暂停» out of sight — the task would read as a plain failure.
 */
export function finishSummary(why, summary) {
  return [why, summary].filter(Boolean).join('\n\n').slice(0, 4000);
}

// ---------- workbench client ----------

function config() {
  if (!existsSync(CONFIG_FILE)) throw new Error(`缺少执行器配置：${CONFIG_FILE}`);
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  if (!cfg.workbench) throw new Error('配置里缺 workbench 地址');
  let token = cfg.token ?? '';
  if (!token && existsSync(WB_FILE)) {
    try { token = JSON.parse(readFileSync(WB_FILE, 'utf8')).token ?? ''; } catch { /* ignore */ }
  }
  if (!token) throw new Error('缺少工作台令牌：填配置里的 token，或 ~/.ai-workbench.json');
  return { ...cfg, token, workbench: String(cfg.workbench).replace(/\/+$/, '') };
}

async function api(cfg, method, path, body) {
  const res = await fetch(`${cfg.workbench}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- 042: 调度大脑 ----------
//
// 大脑跑在这里，不跑在工作台：模型密钥在这台机器上（执行器配置里各后端的 env），工作台一个字节都看不到。
// 分工：工作台给材料（已经脱敏、已经筛过合格名单的提示词），这边只负责问一次、把 JSON 原样送回去；
// 收不收由工作台再校验一遍——执行器说「派给谁」不算数，规则说才算。

/**
 * 用哪条模型。默认「代金券那条」：执行器配置里 model 以 bl- 开头、带着地址和令牌的那个后端（017 的百炼）。
 * 想换成别的（这会花真钱）就在配置里加一段，不动代码：
 *   "brain": { "baseUrl": "https://...", "token": "...", "model": "..." }
 */
export function brainTarget(cfg = {}) {
  const explicit = cfg.brain ?? {};
  const shape = (baseUrl, token, model, from) => ({
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    token: String(token),
    model: String(model),
    from,
  });
  if (explicit.baseUrl && explicit.model && explicit.token) {
    return shape(explicit.baseUrl, explicit.token, explicit.model, 'brain');
  }
  const all = [];
  for (const [name, spec] of Object.entries(cfg.executors ?? {})) {
    for (const b of backendsFor(spec, name)) {
      const env = b.env ?? {};
      const url = env.ANTHROPIC_BASE_URL ?? '';
      const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '';
      const model = b.model || env.ANTHROPIC_MODEL || '';
      if (url && token && model) all.push(shape(url, token, model, `${name}/${b.name}`));
    }
  }
  return all.find((t) => t.model.startsWith('bl-')) ?? all[0] ?? null;
}

/**
 * 只回 JSON。模型很爱加解释、加 ```，所以从第一个 `{` 起往后找配对的 `}`——不用正则糊，也不 eval。
 * 拿不到干净的 JSON 就返回 ok:false，让调用方按「这次没成」处理，而不是猜。
 */
export function parseBrainReply(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return { ok: false, why: '回话里没有 JSON' };
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { ok: false, why: 'JSON 没写完' };
  let v;
  try { v = JSON.parse(s.slice(start, end + 1)); } catch (err) { return { ok: false, why: `JSON 解析不了：${err.message}` }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, why: '不是一个 JSON 对象' };
  const executor = String(v.executor ?? '').trim();
  if (!executor) return { ok: false, why: '回话里没有 executor' };
  return {
    ok: true,
    value: {
      executor,
      difficulty: Math.min(5, Math.max(1, Math.round(Number(v.difficulty) || 3))),
      read_only: v.read_only === true || v.read_only === 'true',
      reason: String(v.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    },
  };
}

/** 调一次模型（Anthropic 兼容的 /v1/messages，和 017 的后端同一个地址）。超时就当没成。 */
export async function callBrain(target, messages, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const url = `${String(target.baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${target.token}`,
        'x-api-key': target.token,
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: 400,
        system: messages.system,
        messages: [{ role: 'user', content: messages.user }],
      }),
      signal: ctl.signal,
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`模型 ${res.status}：${redact(raw).slice(0, 160)}`);
    let data = {};
    try { data = JSON.parse(raw); } catch { /* 不是 JSON 就是没成 */ }
    const text = (data.content ?? []).filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
    const usage = data.usage ?? {};
    return {
      text,
      model: String(data.model ?? target.model),
      in_tokens: Math.max(0, Number(usage.input_tokens ?? 0)),
      out_tokens: Math.max(0, Number(usage.output_tokens ?? 0)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一轮派单：问工作台要「要我拿主意的任务」，逐个问模型，再把答案送回去。
 * 任何一步不成都要回话（`failed:true`），不然任务会卡在「收件 · 待分派」没人解释。
 * 返回这轮处理了几个，调用方据此决定还睡不睡。
 */
export async function routeRound(cfg, io = {}) {
  const ask = io.api ?? api;
  const view = await ask(cfg, 'GET', '/api/route/pending');
  if (!view || !view.enabled) return 0;
  for (const note of view.notes ?? []) log(note);
  const items = Array.isArray(view.items) ? view.items : [];
  if (!items.length) return 0;

  const target = io.target ?? brainTarget(cfg);
  let toldNoModel = false;
  for (const item of items) {
    const fail = (why) => ask(cfg, 'POST', `/api/tasks/${item.id}/route`, { failed: true, why: String(why).slice(0, 160) })
      .catch((err) => log(`T-${item.id} 上报失败原因也失败了：${err.message}`));
    if (!target) {
      // 没有模型时，这一轮拿到的每个任务都要回话：只回第一个，剩下的只能等 10 分钟超时兜底。
      if (!toldNoModel) {
        log('没有可用的模型：配置里既没有 brain，也没有一个带地址和令牌的后端');
        toldNoModel = true;
      }
      await fail('执行器没有可用的模型密钥');
      continue;
    }
    let out;
    try {
      out = await (io.call ?? callBrain)(target, item.messages, io);
    } catch (err) {
      log(`T-${item.id} 问模型没成：${err.message}`);
      await fail(`模型没回话：${err.message}`);
      continue;
    }
    // 042.3：模型已经答话就意味着费用已经发生——不管这段回答能不能用，先把用量记下来。
    // source_key 固定成 `brain:T-<id>`：同一单重试也不会记第二笔（usage 表是 INSERT OR IGNORE）。
    // 没有 usage 的超时/连接失败不在这里补，不能凭空造 token。
    if (out && (out.in_tokens || out.out_tokens)) {
      await ask(cfg, 'POST', '/api/usage', {
        records: [{
          source_key: `brain:T-${item.id}`,
          ts: new Date().toISOString(),
          executor: 'me',
          account: '调度大脑',
          model: `brain:${out.model ?? target.model}`,
          project: '调度大脑',
          input_tokens: out.in_tokens ?? 0,
          output_tokens: out.out_tokens ?? 0,
        }],
      }).catch((err) => log(`上报调度用量失败：${err.message}`));
    }
    const parsed = parseBrainReply(out.text);
    if (!parsed.ok) {
      log(`T-${item.id} 模型的回话不能用（${parsed.why}）`);
      await fail(`模型的回话不能用：${parsed.why}`);
      continue;
    }
    try {
      await ask(cfg, 'POST', `/api/tasks/${item.id}/route`, {
        ...parsed.value, tokens: (out.in_tokens ?? 0) + (out.out_tokens ?? 0), model: out.model,
      });
      log(`T-${item.id} 大脑派给 ${parsed.value.executor}（难度 ${parsed.value.difficulty}/5）：${parsed.value.reason}`);
    } catch (err) {
      // 400 = 工作台不认这个结果，而且已经按规则派好了；再报一次「失败」只会自相矛盾。
      log(`T-${item.id} 派单没通过：${err.message}`);
      continue;
    }
  }
  return items.length;
}

// ---------- git ----------
function git(cwd, ...args) {
  // 043 B：执行器没有自己的控制台时，每个不带 windowsHide 的子进程都会弹一个黑框。
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || '').slice(0, 200)}`);
  return (r.stdout || '').trim();
}

/**
 * 013.5: a branch from an earlier run stays until someone decides, so `worktree add -b wb/T-7` would fail.
 * Each run gets its own branch; the first one keeps the plain name.
 */
export function nextBranch(projectPath, taskId, run = git) {
  const base = branchOf(taskId);
  let names = [];
  try {
    names = run(projectPath, 'branch', '--list', `${base}*`)
      .split('\n').map((s) => s.replace(/^[*+]\s+/, '').trim()).filter(Boolean);
  } catch { names = []; }
  if (!names.includes(base)) return base;
  for (let n = 2; n < 100; n++) if (!names.includes(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`T-${taskId} 的分支名用完了（wb/T-${taskId} 到 -99），先清理旧分支`);
}

/**
 * 043 B：开分支之前先把主仓库的 main 和 origin 对齐。
 * 对不上（两边各有提交）就不开工——返回 block，调用方报失败并写清原因；
 * 拉不到网络只 warn，照旧在本地开工。
 */
export function makeWorktree(projectPath, root, taskId, run = git) {
  const dir = join(root, `T-${taskId}`);
  mkdirSync(root, { recursive: true });
  if (existsSync(dir)) {
    // Resuming a leftover worktree: it is already on the branch this run should use.
    let branch = branchOf(taskId);
    try { branch = run(dir, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch { /* keep the default */ }
    return { dir, branch, block: '', warn: '' };
  }
  const sync = syncMain(projectPath, run);
  if (sync.block) return { dir: '', branch: '', block: sync.block, warn: '' };
  const branch = nextBranch(projectPath, taskId, run);
  run(projectPath, 'worktree', 'add', '-b', branch, dir, 'main');
  return { dir, branch, block: '', warn: sync.warn };
}

/**
 * 028: 「这次跑完什么都没改」——分支相对 main 没有提交，worktree 里也没有未提交的改动。
 * 只读任务（读一遍 README 说说它干什么）就是这样：它的成果是模型的回答，不是 diff。
 * 这种任务不该逼用户批一次「合并分支到 main」。
 */
export function nothingChanged(dir, branch, run = git) {
  try {
    const ahead = Number(run(dir, 'rev-list', '--count', `main..${branch}`)) || 0;
    const dirty = run(dir, 'status', '--porcelain');
    return ahead === 0 && !String(dirty).trim();
  } catch { return false; } // 拿不准就当有改动：宁可多批一次合并，也不要丢掉改动
}

/**
 * 039：这个任务改了哪些文件（相对仓库根）。合并审批要不要自动通过，全看这份清单——
 * git 报错、找不到基准，一律返回空数组，服务端按「有代码改动」处理，绝不误放行。
 */
export function taskFiles(dir, run = git) {
  try {
    const base = String(run(dir, 'merge-base', 'main', 'HEAD')).trim();
    if (!base) return [];
    // 039.1：一定带上 --no-renames。开着重命名检测时，`git mv src/x.ts docs/x.ts` 只报目标路径，
    // 清单看着「全是文档」，实际删掉的是代码——那就等于把代码删除自动放行了。
    // 关掉它，一次移动就是「源删除 + 目标新增」，两条路径都在清单里，src 那端会把审批退回人工。
    return String(run(dir, 'diff', '--no-renames', '--name-only', `${base}...HEAD`))
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

export function removeWorktree(projectPath, dir, { keepBranch = true } = {}) {
  try { git(projectPath, 'worktree', 'remove', '--force', dir); } catch (err) { log(`清理 worktree 失败：${err.message}`); }
  if (!keepBranch) {
    try { git(projectPath, 'branch', '-D', branchOf(dir.split(/[\\/]/).pop().replace('T-', ''))); } catch { /* keep it */ }
  }
}

// ---------- tool ----------

/** 043 B：Windows 上编码工具继承执行器的（隐藏）控制台，而不是各开各的。见 runTool 里的说明。 */
export const INHERIT_CONSOLE = process.platform === 'win32';

/** Only these reach the coding tool; the workbench token must never be visible to an agent. */
export function childEnv(base, extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT'];
  const out = {};
  for (const k of keep) if (base[k] !== undefined) out[k] = base[k];
  return { ...out, ...extra };
}

/**
 * Runs the coding tool. The prompt goes in over stdin: on Windows the arguments are joined by
 * cmd.exe, so a prompt holding & | " %VAR% would be executed, and a newline would cut it short.
 */
export function runTool({ tool, args, cwd, env, prompt, stdinText, onLine, timeoutMs, onSpawn, parse = parseStreamLine }) {
  return new Promise((resolveRun) => {
    const quote = (a) => (process.platform === 'win32' && /\s/.test(a) ? `"${a}"` : a);
    // 043 B：编码工具**不能**带 windowsHide。在 Windows 上它等于 CREATE_NO_WINDOW——子进程没有控制台，
    // 它再起的 bash、git、node（Claude Code 自己起的，我们管不到）每一个都会新开一个可见的黑框。
    // 不带它，子进程就挂在执行器的控制台上；执行器的控制台由守卫给的、本身是隐藏的，于是一个窗口都不弹。
    // 只有 git 这类「叶子」进程才带 windowsHide（它们不再往下起控制台程序）。
    const child = spawn(tool, args.map(quote), { cwd, env, shell: process.platform === 'win32', windowsHide: INHERIT_CONSOLE ? false : true });
    if (onSpawn) { try { onSpawn(child); } catch { /* the caller only wants a handle */ } }
    let buffer = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    const feed = (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parse(line);
        if (parsed) onLine(parsed);
        else if (line.trim()) onLine({ kind: 'raw', step: line.trim().slice(0, 120), tokens: 0 });
      }
    };
    child.stdout.on('data', (d) => feed(String(d)));
    child.stderr.on('data', (d) => feed(String(d)));
    child.on('error', (err) => { clearTimeout(timer); resolveRun({ code: -1, error: err.message, killed }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const parsed = parse(buffer);
        if (parsed) onLine(parsed);
      }
      resolveRun({ code, killed });
    });

    // claude reads the prompt from stdin when -p has no argument. codebuddy wants a JSON
    // "user message" line there (037), so the caller hands over the already-encoded text.
    child.stdin.on('error', () => { /* the tool may not read stdin; that is fine */ });
    child.stdin.end(stdinText ?? prompt, 'utf8');
  });
}

// ---------- hook config (item 2 of 008.1) ----------

const HOOK_SCRIPT = new URL('./claude-hook.mjs', import.meta.url);

// ---------- 045：账号槽 ----------

/** 槽目录的根。每个槽是它下面的一个子目录，由用户自己登录一次；执行器只读这个路径，不碰里面的凭据。 */
export function slotsRoot(cfg) {
  return resolve(cfg.slotsRoot ?? join(HOME, '.workbench-slots'));
}

/**
 * 这个后端用不用「登录」。带了 API key / 网关地址的（DeepSeek、百炼）花的是 key，不是账号——
 * 给它换 CLAUDE_CONFIG_DIR 不会换账号，只会白白丢掉钩子，所以槽只给走登录的后端用。
 * codebuddy 一律走自己的登录；dsh 认的是 DEEPSEEK_API_KEY，从来不用槽（045 核对）。
 */
export function usesLogin(backend = {}) {
  if (backend.tool === 'dsh') return false;
  if (backend.tool === 'codebuddy') return true;
  const env = backend.env ?? {};
  return !['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].some((k) => String(env[k] ?? '').trim());
}

export function harnessOf(backend = {}) {
  return backend.tool === 'codebuddy' ? 'codebuddy' : backend.tool === 'dsh' ? 'dsh' : 'claude-code';
}

/**
 * 从工作台领到的槽里取第一个（工作台已经排好序）。名字和目录名再校验一遍：
 * 目录名只许 [a-z0-9-]，拼出来的路径必须还在 slotsRoot 下——工作台被人改了也越不了界。
 */
export function chooseSlot(task, cfg) {
  const list = Array.isArray(task?.slots) ? task.slots : [];
  for (const s of list) {
    const name = String(s?.name ?? '');
    const dirName = String(s?.slot_dir ?? '');
    if (!/^[a-z0-9_-]{1,40}$/i.test(name) || !/^[a-z0-9-]{1,32}$/.test(dirName)) continue;
    const root = slotsRoot(cfg);
    const dir = resolve(root, dirName);
    if (dirname(dir) !== root) continue;
    return { name, dir };
  }
  return null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** 某个时区里的墙上时间 → UTC 毫秒。不认识的时区返回 NaN（宁可不知道，不猜）。 */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asIf = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return guess - (asIf - guess);
  } catch {
    return NaN;
  }
}

/**
 * 045：认「到账号上限」。Claude Code 见过两种：
 *   You've hit your session limit · resets 3pm (Asia/Hong_Kong)
 *   You've hit your weekly limit · resets Nov 7, 3pm (Asia/Hong_Kong)
 * 认出「到上限」但时间读不懂 → resetAt 为 null，由工作台按「1 小时后再试」处理。
 * 根本不像到上限 → 返回 null，按普通失败走。
 */
export function parseLimit(text, now = Date.now()) {
  const s = String(text ?? '');
  const hit = s.match(/you(?:'|’)?ve hit your\s+(session|weekly|usage|5-hour|five-hour)?\s*limit/i)
    ?? s.match(/(?:usage|session|weekly)\s+limit\s+(?:reached|exceeded)/i);
  if (!hit) return null;
  const word = (hit[1] ?? hit[0]).toLowerCase();
  const kind = /week/.test(word) ? 'weekly' : /session|5-hour|five/.test(word) ? 'session' : 'other';
  const raw = s.slice(Math.max(0, hit.index - 20), hit.index + 160).replace(/\s+/g, ' ').trim();
  const m = s.slice(hit.index).match(/resets\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC)\))?/i);
  if (!m) return { kind, resetAt: null, raw };
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const ap = (m[5] ?? '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  if (!ap && !m[4]) return { kind, resetAt: null, raw }; // 只有一个光秃秃的数字，不知道是几点
  if (hour > 23 || minute > 59) return { kind, resetAt: null, raw };
  const tz = m[6] === 'UTC' ? 'UTC' : m[6] ?? '';
  const today = new Date(now);
  let ms;
  if (m[1]) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) return { kind, resetAt: null, raw };
    const day = Number(m[2]);
    ms = zonedToUtc(today.getUTCFullYear(), mo, day, hour, minute, tz);
    if (ms < now - 24 * 3600e3) ms = zonedToUtc(today.getUTCFullYear() + 1, mo, day, hour, minute, tz); // 跨年
  } else {
    // 只有钟点：先按「那个时区的今天」算，过了就是明天。
    let y = today.getUTCFullYear(), mo = today.getUTCMonth(), d = today.getUTCDate();
    if (tz) {
      try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
          .formatToParts(today).map((x) => [x.type, x.value]));
        y = +p.year; mo = +p.month - 1; d = +p.day;
      } catch { return { kind, resetAt: null, raw }; }
    } else { y = today.getFullYear(); mo = today.getMonth(); d = today.getDate(); }
    ms = zonedToUtc(y, mo, d, hour, minute, tz);
    if (ms <= now) ms = zonedToUtc(y, mo, d + 1, hour, minute, tz);
  }
  if (!Number.isFinite(ms) || ms <= now) return { kind, resetAt: null, raw };
  return { kind, resetAt: new Date(ms).toISOString(), raw };
}

/** The executor's own CLAUDE_CONFIG_DIR; the user's ~/.claude is never touched. */
export function claudeConfigDir(cfg) {
  return resolve(cfg.claudeConfigDir ?? join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'ai-workbench', 'claude-runner'));
}

/**
 * Write a settings.json holding the approval hooks (plus any other hooks already there — never any other setting),
 * with an absolute path to claude-hook.mjs.
 * Returns the directory. Throws when it cannot be written — a runner without the gate must not run.
 */
export function ensureHookConfig(cfg, dir = claudeConfigDir(cfg)) {
  mkdirSync(dir, { recursive: true });
  const hookPath = process.platform === 'win32' ? HOOK_SCRIPT.pathname.slice(1) : HOOK_SCRIPT.pathname;
  const command = `node "${hookPath.replace(/\\/g, '/')}"`;
  const settings = {
    hooks: {
      // 043 E：所有工具都过钩子。以前只管 Bash/Edit/Write/MultiEdit，WebFetch 等落回 Claude Code
      // 自己的权限判断——无头模式没人能点确认，于是一律被拒，执行器就「不能联网」。
      // 现在放不放行统一由工作台的审批规则决定：没命中规则就放行，命中就等你批。
      PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 1800 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
      Stop: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
    },
  };
  const file = join(dir, 'settings.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const hooks = { ...previous.hooks };
  for (const [event, required] of Object.entries(settings.hooks)) {
    const extras = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((entry) => ({
        ...entry,
        hooks: (Array.isArray(entry.hooks) ? entry.hooks : [])
          .filter((hook) => hook.command !== command),
      }))
      .filter((entry) => entry.hooks.length);
    hooks[event] = [...required, ...extras];
  }
  // 只留钩子，别的设置一律不留：settings.json 里的 `disableAllHooks`、`permissions`（比如 defaultMode: bypassPermissions）
  // 都能让审批门形同虚设。别人的钩子（技能自带的）可以并存——它们说「放行」也盖不过审批钩子的「拦下」。
  writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return { dir, file };
}

/** Before claiming anything: the gate must exist and point at a file that is really there. */
export function selfCheck(cfg) {
  try {
    const { file } = ensureHookConfig(cfg);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    const hook = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    const path = (hook.match(/"([^"]+)"/) ?? [])[1];
    if (!path || !existsSync(path)) return { ok: false, reason: `hook 脚本不存在：${path || '(空)'}` };
    return { ok: true, dir: claudeConfigDir(cfg), file };
  } catch (err) {
    return { ok: false, reason: `hook 配置写入失败：${err.message}` };
  }
}

/** A repo that ships its own settings could relax the gate; without a supported flag we refuse. */
export function worktreeSettings(dir) {
  return ['.claude/settings.json', '.claude/settings.local.json']
    .map((p) => join(dir, p))
    .filter((p) => existsSync(p));
}

// ---------- one task ----------

/**
 * 036 A.3：这个执行者要是用 dsh，版本就得和配置里锁的一致；没锁（dshVersion 缺）也允许，
 * 但 doctor 会提醒。返回 { problem, version, exe }，problem 为空表示能跑。
 *
 * 036.1（审查建议修）：没锁 dshVersion 时，**第一次**真跑起来看到的版本记在状态目录里，
 * 之后变了就拒绝领任务——需求单要的是版本锁，不能只靠 doctor 里一句提醒。dsh 是 alpha，
 * 升级会破坏事件解析，静悄悄跟着升上去等于把解析弄坏还不吭声。
 */
export function dshVersionFile() {
  return join(LOG_DIR, 'dsh-versions.json');
}

export function readDshVersions(file = dshVersionFile()) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** 记下/核对「这个执行者第一次跑起来是什么版本」。写不进去不挡着跑（下次还会再试）。 */
export function rememberDshVersion(name, version, { file = dshVersionFile(), load = readDshVersions, save } = {}) {
  const key = String(name || 'dsh');
  const mem = load(file);
  const prev = String(mem?.[key] ?? '');
  if (!version) return { problem: '', prev, first: false };
  if (!prev) {
    try {
      const write = save ?? ((f, o) => {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify(o, null, 2), 'utf8');
      });
      write(file, { ...mem, [key]: version });
    } catch { /* 记不下来不挡着跑：下一次还是「第一次」 */ }
    return { problem: '', prev: '', first: true };
  }
  if (prev !== version) {
    return {
      problem: `dsh 版本变了（第一次跑是 ${prev}，现在是 ${version}，没锁 dshVersion）：先用只读任务试一次，确认没问题再把 dshVersion 改成 ${version}`,
      prev,
      first: false,
    };
  }
  return { problem: '', prev, first: false };
}

/**
 * @param {object} spec 执行者配置
 * @param {{ name?: string, remember?: boolean, versionFile?: string }} opts
 *   `remember: true` 只在真的要跑任务时用（会落盘）；doctor 只看不写。
 */
export function dshGate(spec, { name = '', remember = false, versionFile } = {}) {
  const isDsh = String(spec?.tool ?? '') === 'dsh';
  if (!isDsh) return { problem: '', version: '', exe: '' };
  const exe = String(spec?.dshPath ?? '').trim() || which('dsh') || '';
  if (!exe) return { problem: '找不到 dsh：先 `npm i -g @deepseek-ai/dsh`，或在执行者配置里写 dshPath', version: '', exe: '' };
  const version = dshVersion({}, exe);
  const locked = dshVersionProblem(version, spec?.dshVersion);
  if (locked) return { problem: locked, version, exe };
  // 锁了 dshVersion 就已经有版本锁了，不需要再记第一次。
  if (String(spec?.dshVersion ?? '').trim()) return { problem: '', version, exe };
  const mem = remember
    ? rememberDshVersion(name, version, { file: versionFile ?? dshVersionFile() })
    : { problem: '', prev: String(readDshVersions(versionFile ?? dshVersionFile())[String(name || 'dsh')] ?? ''), first: false };
  return { problem: mem.problem, version, exe, memorized: mem.prev };
}

/**
 * 017: an executor may hold several backends in order — bailian first, deepseek as the fallback.
 * A plain single-tool spec (013 style) is the one-backend case and keeps working unchanged.
 */
export function backendsFor(spec, executor = '') {
  const base = Array.isArray(spec) ? {} : (spec ?? {});
  const list = Array.isArray(spec) ? spec : Array.isArray(base.backends) ? base.backends : [];
  const shared = { tool: base.tool ?? 'claude', args: base.args ?? ['-p', '--output-format', 'stream-json', '--verbose'] };
  if (!list.length) {
    return [{ ...shared, name: String(base.backend ?? executor ?? 'default'), model: base.model ?? '', env: base.env ?? {}, account: String(base.account ?? '') }];
  }
  return list
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({ ...shared, name: String(b.name ?? 'default'), model: b.model ?? '', env: b.env ?? {}, account: String(b.account ?? '') }));
}

/** 017: voucher work goes to bailian, everything else to deepseek; an unknown name keeps the order. */
export function pickBackend(backends, hint) {
  const list = Array.isArray(backends) ? backends : [];
  if (!list.length) return null;
  const wanted = String(hint ?? '').trim().startsWith('bl-') ? 'bailian' : 'deepseek';
  return list.find((b) => b.name === wanted) ?? list[0];
}

/**
 * 017: only an answer about credit or permission justifies a second backend. A failing test, a
 * syntax error or a stopped run must NOT be replayed on another model — that hides real bugs.
 */
export function backendSignal(text) {
  const s = String(text ?? '');
  const m = s.match(/\b(401|403|429)\b/)
    ?? s.match(/AccessDenied|Unpurchased|insufficient[ _-]?quota|quota exceeded|rate[ _-]limit|too many requests|invalid[ _-]?api[ _-]?key/i)
    ?? s.match(/(额度|余额)(不足|用完|超限)/);
  return m ? m[0] : '';
}

/** Convenience for callers that only care whether this run should be retried elsewhere. */
export function backendUnavailable(text) {
  return backendSignal(text) !== '';
}

/**
 * 043.5：一次运行算不算完成，只有这一个判定口。
 * 编码工具在 result 事件里写了 `is_error: true` 时，退出码往往还是 0；什么都没说、
 * 没有最终结果时也一样。以前只看退出码，任务和运行都记成 done，错误文本被当成成果交付。
 *
 * 顺序有讲究：
 *   - `stopped`（预算闸 / 总开关）是人的决定，原因最先；
 *   - 已经认出的「到额度上限」走 limited，不能退回普通失败——有没有真实槽由工作台判定；
 *   - 登录、超时、工具报错、退出码、缺少最终结果，都算失败。错误文本只进 result_text 和原因，
 *     不会被当成「只要一个回答」的成果。
 */
export function judgeRun({ code = 0, killed = false, stopped = '', authProblem = '', maxMinutes = 45, resultSeen = false, resultFailed = false, resultText = '', limit = null } = {}) {
  if (stopped) return { failed: true, limited: false, reason: stopped };
  if (limit) return { failed: false, limited: true, reason: '' };
  if (authProblem) return { failed: true, limited: false, reason: authProblem };
  if (killed) return { failed: true, limited: false, reason: `超过单任务时间上限（${maxMinutes} 分钟）` };
  if (resultFailed) {
    const said = redact(String(resultText ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '').slice(0, 160);
    return { failed: true, limited: false, reason: `编码工具报告失败${said ? `：${said}` : '，但没有说明原因'}` };
  }
  if (code !== 0) return { failed: true, limited: false, reason: `编码工具退出码 ${code ?? '未知'}` };
  if (!resultSeen) return { failed: true, limited: false, reason: '编码工具没有给出最终结果（退出码 0）' };
  if (!String(resultText ?? '').trim()) return { failed: true, limited: false, reason: '编码工具给出的最终结果为空' };
  return { failed: false, limited: false, reason: '' };
}

export async function runTask(cfg, task) {
  const project = cfg.projects?.[task.project];
  if (!project) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
      result: 'failed', summary: missingProjectMessage(task.project),
    });
    log(`T-${task.id} 跳过：没有配置项目路径 ${task.project}`);
    return;
  }
  // 013.6: 重试合并 / 重试推送 replay one step. The coding work is already done and its branch
  // is still in the repo, so re-running the model would be money and time for nothing.
  if (task.retry === 'merge' || task.retry === 'push') {
    log(`T-${task.id} 重试：${task.retry === 'merge' ? '合并' : '推送'}`);
    if (task.retry === 'push') {
      await clearRetry(cfg, task.id);
      await waitForPush(cfg, task, resolve(project), { branch: task.branch ?? '', commit: task.merged_commit ?? '' });
    } else {
      await retryMerge(cfg, task, resolve(project));
    }
    return;
  }

  const spec = cfg.executors?.[task.executor];
  const backends = spec ? backendsFor(spec, task.executor) : [];
  if (!backends.length) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, { result: 'failed', summary: `没有配置执行者 ${task.executor} 的编码工具` });
    return;
  }
  // 036 A.3：锁了 dshVersion 的执行者，机器上的 dsh 版本不一致就不领这个任务；
  // 没锁的，第一次跑把版本记下来，之后变了就拒绝（remember 只在这里为真）。
  const dsh = dshGate(spec, { name: task.executor, remember: true });
  if (dsh.problem) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, { result: 'failed', summary: dsh.problem });
    log(`T-${task.id} 拒绝：${dsh.problem}`);
    return;
  }
  // 037：codebuddy 没装 / 没登录，同样在领任务之前就挡住。没登录时它退出码是 0，
  // 真跑起来只会白烧一个 worktree，再回一句「Authentication required」。
  // 045：用槽的话登录在槽目录里，默认目录登没登录不相关——不用默认目录去探，跑完再认「没登录」。
  const slot = chooseSlot(task, cfg);
  const cb = codebuddyGate(spec, slot ? { probe: () => 'ok' } : {});
  if (cb.problem) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, { result: 'failed', summary: cb.problem });
    log(`T-${task.id} 拒绝：${cb.problem}`);
    return;
  }
  // 017: the dispatch suggestion already knows whether this task should spend the voucher. Ask
  // it about this task's own executor — the overall "cheapest executor" answer is usually zcode,
  // which carries no model hint and would silently send every run to the paid balance.
  let hint = '';
  try {
    const s = await api(cfg, 'GET', `/api/dispatch/suggest?category=${encodeURIComponent(task.category ?? '')}&executor=${encodeURIComponent(task.executor)}`);
    hint = String(s?.model_hint ?? '');
  } catch (err) {
    // No suggestion is not a reason to stop: the first configured backend is the default.
    log(`T-${task.id} 取派单建议失败，用第一个后端：${err.message}`);
  }
  let backend = pickBackend(backends, hint);
  log(`T-${task.id} 后端 ${backend.name}${hint ? `（派单建议 ${hint}）` : '（没有派单建议，用第一个）'}`);

  // 043 B：开工前先把主仓库的 main 和 origin 对齐（只快进）。对不上就不开工，
  // 否则改完照样卡在合并那一步，白烧一遍模型。
  const wt = makeWorktree(resolve(project), resolve(cfg.worktreeRoot ?? join(HOME, 'wb-worktrees')), task.id);
  if (wt.block) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
      result: 'failed', summary: `没有开工：${wt.block}`,
    });
    log(`T-${task.id} 没有开工：${wt.block}`);
    return;
  }
  if (wt.warn) log(`T-${task.id} ${wt.warn}`);
  const { dir, branch } = wt;

  // A repo that ships .claude/settings*.json could loosen the gate; there is no supported
  // "ignore project settings" flag, so the task is refused instead of run unguarded.
  const projectSettings = worktreeSettings(dir);
  if (projectSettings.length && !cfg.allowProjectSettings) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
      result: 'failed',
      summary: `仓库自带 ${projectSettings.map((p) => p.replace(dir, '.')).join('、')}，执行器无法保证门禁生效，已拒绝执行`,
    });
    removeWorktree(resolve(project), dir);
    log(`T-${task.id} 拒绝：worktree 里有项目级 .claude 配置`);
    return;
  }

  // 046.3：配了 sandbox: docker，这次就在一次性容器里跑。进不去就**失败并说清楚**，不退回宿主上跑。
  // 执行者自己写了 sandbox 就听它的（比如全局开沙箱、WorkBuddy 写 "none" 照旧跑）。
  const sandboxMode = sandboxModeFor(cfg, task.executor);
  let sandbox = null;
  let sandboxOut = null;
  if (sandboxMode === 'docker') {
    const plan = sandboxPlan(backend, cfg, task.id);
    let problem = plan.ok ? '' : plan.why;
    let provider = null;
    if (!problem) {
      try {
        provider = getProvider('docker', { image: cfg.sandboxImage || 'wb-sandbox:latest', limits: cfg.sandboxLimits ?? {} });
        const av = await provider.available();
        if (!av.ok) problem = av.why;
      } catch (err) { problem = err.message; }
    }
    if (problem) {
      await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, { result: 'failed', sandbox: 'docker', summary: `沙箱：${problem}（执行器配了 sandbox: docker，不会退回宿主上跑）` });
      removeWorktree(resolve(project), dir);
      log(`T-${task.id} 沙箱进不去：${problem}`);
      return;
    }
    sandbox = { provider, plan };
    log(`T-${task.id} 在沙箱里跑（${cfg.sandboxImage || 'wb-sandbox:latest'}，出网白名单 ${plan.egress.allow.length} 项）`);
  }

  // 037：审批门钉进这个 worktree。装不上不拒绝任务——降级成只读，任务还能干活，
  // 只是碰不了文件；页面上的步骤会说清楚。
  const usesCodebuddy = backends.some((b) => b.tool === 'codebuddy');
  let cbWrite = false;
  if (usesCodebuddy) {
    const gate = writeCodebuddyGate(dir);
    if (!gate.ok) log(`T-${task.id} 审批门没装上（${gate.why}），这次只跑只读`);
    cbWrite = gate.ok && cfg.codebuddyWrite === true;
    log(`T-${task.id} codebuddy ${codebuddyVersion(cb.exe) || '?'}（${cb.state}）· ${cbWrite ? '可写：-y + 钩子审批' : '只读：没给 -y，禁了 Bash/Write/Edit'}`);
  }

  // 045：只有走登录的后端才用槽。槽目录不存在 = 还没登录，不开跑、说清楚去哪登录。
  // Claude Code 的审批钩子写在 CLAUDE_CONFIG_DIR 的 settings.json 里，换了目录就要在新目录里再写一份，
  // 写不进去宁可不跑——没有门禁的执行器不能跑（008.1）。
  const slotFor = (b) => (slot && usesLogin(b) ? slot : null);
  if (slotFor(backend)) {
    if (!existsSync(slot.dir)) {
      await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
        result: 'failed',
        summary: `账号槽 ${slot.name} 的目录还没建：先在这台电脑上按使用手册「添加账号槽」登录一次（目录 ${basename(slot.dir)}）`,
      });
      removeWorktree(resolve(project), dir);
      log(`T-${task.id} 拒绝：账号槽目录不存在 ${slot.dir}`);
      return;
    }
    if (harnessOf(backend) === 'claude-code') {
      try { ensureHookConfig(cfg, slot.dir); } catch (err) {
        await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, { result: 'failed', summary: `账号槽 ${slot.name} 里写不进审批钩子：${err.message}` });
        removeWorktree(resolve(project), dir);
        return;
      }
    }
    log(`T-${task.id} 用账号槽 ${slot.name}`);
  }

  const rules = readFileSync(RULES_FILE, 'utf8');
  // 031c: 只有用户确认过的笔记会进来；工作台那边已经限到 5 条 / 1200 字。
  const notes = await fetchNotes(cfg, task);
  if (notes) log(`T-${task.id} 带上 ${notes.split('\n').filter((l) => l.startsWith('- ')).length} 条确认过的项目笔记`);
  // 055.2：你回答过提问、这次是接着干？回答由工作台只给一次（取走就空了）。取不到就别硬跑——
  // 没有你的回答就重跑，等于把你答过的问题白问一遍；回答还在工作台里，点「重新开始」会再取。
  let resume = null;
  if (task.resume) {
    try {
      resume = (await api(cfg, 'POST', `/api/runner/tasks/${task.id}/resume`, {}))?.resume ?? null;
    } catch (err) {
      await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
        result: 'failed', summary: `取你的回答失败：${err.message}。回答还在工作台里，点「重新开始」会再试一次`,
      }).catch(() => {});
      log(`T-${task.id} 取回答失败：${err.message}`);
      return;
    }
    if (!resume) log(`T-${task.id} 标了接着干，但工作台里没有可取的回答，按新任务跑`);
  }
  // 新会话用的提示词：原任务 + 上一轮的资料（有的话）。沙箱任务、原会话接不上时都走它。
  const prompt = buildPrompt(task, rules, notes, [nativeSearch(backend) ? '' : searchHint(cfg), resume ? resumeData(resume) : ''].filter(Boolean).join('\n\n'));
  // 原会话接着干：只有宿主上的 Claude Code、有会话号才行。沙箱里的会话文件随容器销毁，不带出来（规格 055.2）。
  let resumeSid = resume && resume.session_id && !sandbox && resume.sandbox !== 'docker' && backend.tool === 'claude' ? resume.session_id : '';
  let curPrompt = resumeSid ? resumeMessage(resume) : prompt;
  if (resume) log(`T-${task.id} 接着干：${resumeSid ? '用原会话' : '开新会话，带上上一轮的资料'}`);

  let tokens = 0;
  let inTokens = 0;
  let outTokens = 0;
  let summary = '';
  // 028: 模型的最终回答（原样，工作台负责打码和截断）。
  let resultText = '';
  // 043 F：这次运行里被拒掉的工具，跟着 finish 报给工作台，由工作台判定是不是假完成。
  const denials = new Set();
  // 043.5：最终结果本身也要说话——收到过 result 事件没有、它是不是报错、文本是什么。
  // 退出码 0 只能说明进程正常退出，不能说明模型交出了成果。
  let resultSeen = false;
  let resultFailed = false;
  // 055.2：这次运行用的会话号（最后一次说了算）。提问时报给工作台，接着干要用它。
  let sessionId = '';
  let step = '启动';
  const maxMinutes = Number(cfg.maxMinutes ?? 45);
  await api(cfg, 'POST', `/api/runner/tasks/${task.id}/progress`, { step, progress: 5, branch });
  if (usesCodebuddy && !cbWrite) {
    step = '只读模式：codebuddy 没给 -y，Bash/Write/Edit 已禁；要写文件先把审批门验收过、配置里开 codebuddyWrite';
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/progress`, { step }).catch(() => {});
  }

  // Why we stopped the run ourselves. Empty while it is going normally.
  let stopped = '';
  let killChild = null;
  const stop = (reason) => {
    if (stopped) return; // first reason wins
    stopped = reason;
    try { killChild?.('SIGKILL'); } catch { /* already gone */ }
  };

  const ticker = setInterval(() => {
    if (stopped) return; // one stop, one approval — no repeated budget calls while it winds down
    void api(cfg, 'POST', `/api/runner/tasks/${task.id}/progress`, { step, tokens_used: tokens }).catch(() => {});
    // 007 budget gate: the workbench knows the per-executor caps, we only know the running totals.
    // It answers { gated } and, when over, parks an approval for 继续 / 终止.
    void api(cfg, 'POST', `/api/runner/tasks/${task.id}/budget`, { tokens }).then((r) => {
      if (r?.gated) stop('触发预算闸（单任务超时或超用量），已停下等审批');
    }).catch(() => {});
  }, PROGRESS_MS);

  const pauseWatch = setInterval(() => {
    void api(cfg, 'GET', '/api/dispatch/state').then((s) => { if (s?.auto_paused) stop('被总开关暂停，当前这一步结束后停止'); }).catch(() => {});
  }, 10_000);

  // 017: one attempt per backend. The first is chosen from the dispatch hint; a second is only
  // spent when the first answers "no credit / no permission" — never on an ordinary failure.
  let tail = '';
  const onMsg = (msg) => {
    if (msg.tokens) tokens += msg.tokens;
    if (msg.inputTokens) inTokens += msg.inputTokens;
    if (msg.outputTokens) outTokens += msg.outputTokens;
    if (msg.kind === 'step' && msg.step) step = msg.step;
    if (msg.sessionId) sessionId = msg.sessionId;
    if (msg.kind === 'result') {
      resultSeen = true;
      resultFailed = msg.failed === true;
      summary = msg.summary || summary;
      if (msg.text) resultText = msg.text;
      for (const d of msg.denials ?? []) denials.add(d);
    }
    const said = msg.step || msg.summary || '';
    if (said) tail = `${tail} ${said}`.slice(-4000);
  };
  const attempt = (b) => {
    tail = '';
    // 043.5：换后端重跑时，上一次的失败结果不能带到这一次来判定。
    summary = '';
    resultText = '';
    resultSeen = false;
    resultFailed = false;
    // 036：dsh 的参数、事件格式和环境都是自己的，不能沿用 Claude Code 那套。
    // 046.3：沙箱里跑。事件格式和宿主上的 Claude Code 一样，按行解析后走同一个 onMsg。
    if (sandbox) {
      return runInSandbox({
        provider: sandbox.provider, task, project: resolve(project), branch, plan: sandbox.plan, prompt,
        timeoutMs: maxMinutes * 60_000, gitRun: git,
        onBox: (box) => { killChild = () => { void box.destroy(); }; },
        onLine: (line) => {
          const parsed = parseStreamLine(line);
          if (parsed) onMsg(parsed);
          else if (line.trim()) onMsg({ kind: 'raw', step: line.trim().slice(0, 120), tokens: 0 });
        },
      }).then((r) => { sandboxOut = r; return { code: r.code, killed: r.killed }; });
    }
    const isDsh = b.tool === 'dsh';
    // 037：codebuddy 的事件形状和 Claude Code 一样（init / assistant / result），提示词的传法不同。
    const isCb = b.tool === 'codebuddy';
    const tool = isDsh ? (dsh.exe || 'dsh') : isCb ? (cb.exe || 'codebuddy') : b.tool;
    const args = isDsh ? DSH_ARGS : isCb ? codebuddyArgs({ model: b.model, write: cbWrite }) : resumeSid ? resumeArgs(b.args, resumeSid) : b.args;
    return runTool({
      tool,
      args,
      parse: isDsh ? parseDshLine : parseStreamLine,
      cwd: dir,
      // Whitelisted environment only: whatever the runner process happens to hold stays hidden.
      env: {
        ...childEnv(process.env, {
          WB_SOURCE: 'runner',
          WB_EXECUTOR: task.executor,
          CLAUDE_CONFIG_DIR: !isDsh && !isCb && slotFor(b) ? slotFor(b).dir : claudeConfigDir(cfg),
          ...(b.env ?? {}),
        }),
        // 045：codebuddy 的登录目录（核对过：CODEBUDDY_CONFIG_DIR，空目录会要求重新登录）。
        ...(isCb && slotFor(b) ? { CODEBUDDY_CONFIG_DIR: slotFor(b).dir } : {}),
        // WB_TASK_ID tells the hook which task this session belongs to; without it the workbench
        // would invent a second task for the same run and hang the approvals off that one.
        WB_TASK_ID: String(task.id),
        // 036：DSH_* 放在 b.env 之后，用户配置改不了这两项——日志不上传、只读，是执行器的底线。
        ...(isDsh ? DSH_ENV : {}),
        // 037：codebuddy 的钩子要按「退出码 2 才算拦下」说话，见 claude-hook.mjs 里的 decide()。
        ...(isCb ? { ...CODEBUDDY_ENV, WB_HOOK_VARIANT: 'codebuddy' } : {}),
        ANTHROPIC_MODEL: isDsh || isCb ? '' : (b.model || b.env?.ANTHROPIC_MODEL || ''),
      },
      prompt: curPrompt,
      stdinText: isCb ? codebuddyPrompt(curPrompt) : undefined,
      timeoutMs: maxMinutes * 60_000,
      onSpawn: (child) => { killChild = (sig) => child.kill(sig); },
      onLine: onMsg,
    });
  };

  let run = await attempt(backend);
  let backendUsed = backend;
  // 055.2：用 --resume 起的那次，原会话找不到（会话文件被清了、换了账号槽）：开新会话，带上上一轮的资料。
  if (resumeSid && !stopped && resumeLost(`${tail} ${summary} ${resultText}`, tokens)) {
    const why = '原会话接不上，改开新会话（带上上一轮的资料）';
    log(`T-${task.id} ${why}`);
    step = why;
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/progress`, { step: why }).catch(() => {});
    resumeSid = '';
    curPrompt = prompt;
    run = await attempt(backend);
  }
  // 045：账号到上限不是「后端坏了」：不换后端重跑，交给工作台换下一个槽。
  if (!sandbox && run.code !== 0 && !stopped && !(slotFor(backend) && parseLimit(`${tail} ${summary}`))) {
    const signal = backendSignal(`${tail} ${summary}`);
    const next = backends.find((b) => b.name !== backend.name);
    if (signal && next) {
      const why = `后端 ${backend.name} 不可用（${signal}），改用 ${next.name} 重跑`;
      log(`T-${task.id} ${why}`);
      // The failed attempt's last line is an auth error; without this the task page keeps showing
      // it while the fallback run is going well.
      step = why;
      summary = '';
      await api(cfg, 'POST', '/api/events', { kind: 'runner.backend_fallback', task_id: task.id, text: `T-${task.id}：${backendUsed.name} 失败（${why}），已换到 ${next.name}`.slice(0, 300) })
        .catch((err) => log(`记后端切换失败：${err.message}`));
      await api(cfg, 'POST', `/api/runner/tasks/${task.id}/progress`, { step: why }).catch(() => {});
      backendUsed = next;
      resumeSid = ''; // 055.2：会话属于原来那个后端，换后端就开新会话
      curPrompt = prompt;
      run = await attempt(next);
    }
  }

  clearInterval(ticker);
  clearInterval(pauseWatch);

  // 046.3：沙箱里出来的补丁，过 patch-guard 才套到宿主 worktree；之后的合并 / 推送审批原样不动。
  let sandboxProblem = '';
  let sandboxFlags = [];
  if (sandbox) {
    if (sandboxOut?.problem) sandboxProblem = sandboxOut.problem;
    else if (sandboxOut && !stopped) {
      try {
        const ap = applySandboxPatch({ dir, patch: sandboxOut.patch, taskId: task.id, gitRun: git, rejectsDir: join(LOG_DIR, 'sandbox-rejects') });
        if (!ap.ok) sandboxProblem = `补丁没过检查，没有套用：${ap.reasons.join('；')}${ap.saved ? `（原文存在 ${ap.saved}）` : ''}`;
        else sandboxFlags = ap.flags;
      } catch (err) { sandboxProblem = `套用沙箱补丁失败：${redact(err.message)}`; }
    }
  }

  // 017: a direct backend never goes through the proxy queue, so its tokens are reported from
  // here. Without this the voucher account would keep showing its full face value.
  // 037：codebuddy 用的是本机 WorkBuddy 账号，没配 account 时按 010 里已有的「WorkBuddy」记，
  // 不然这部分用量就落在账外——预算页看着是 0，实际一直在花。
  const usedSlot = slotFor(backendUsed);
  const usageAccount = usedSlot ? usedSlot.name : usageAccountOf(backendUsed);
  if (usageAccount && inTokens + outTokens > 0) {
    await api(cfg, 'POST', '/api/usage', {
      records: [{
        source_key: `runner:T-${task.id}:${Date.now()}`,
        ts: new Date().toISOString(),
        executor: task.executor,
        account: usageAccount,
        model: backendUsed.model || '',
        project: task.project ?? '',
        input_tokens: inTokens,
        output_tokens: outTokens,
      }],
    }).catch((err) => log(`上报用量失败：${err.message}`));
  }

  let diffStat = '';
  try { diffStat = git(dir, 'diff', '--stat', `main...${branch}`); } catch { diffStat = ''; }
  // 037：codebuddy 没登录也是退出码 0，回答里一句「Authentication required」。不认这一条，
  // 任务会被标成「已完成」、结果是一句让用户去 /login 的话——那是最坏的一种假成功。
  // 这句话出现在 assistant 的正文里（当成 step 收进 tail），result 里可能一个字都没有，
  // 所以要把这一轮看过的东西合起来判断。
  const authFailed = usesCodebuddy && loginState(`${resultText} ${summary} ${tail}`) === 'logged-out';
  if (authFailed) loginCache = { exe: cb.exe, at: 0, state: 'logged-out' };
  const authProblem = authFailed
    ? (usedSlot ? `账号槽 ${usedSlot.name} 没登录：按使用手册「添加账号槽」，用 CODEBUDDY_CONFIG_DIR 指到这个目录登录一次` : loginProblem('logged-out'))
    : '';
  // 045：用了槽、又认出「到上限」→ 报 limited，工作台记下重置时间、任务回排队换槽。
  // 043.5：限额要在统一判定之前算出来——已经认出的限额不能因为 is_error / 退出码退化成普通失败。
  const limit = usedSlot && !stopped ? parseLimit(`${resultText} ${summary} ${tail}`) : null;
  const verdict = judgeRun({
    code: run.code, killed: run.killed, stopped, authProblem, maxMinutes,
    resultSeen, resultFailed, resultText, limit,
  });
  const failed = verdict.failed || Boolean(sandboxProblem);
  const why = sandboxProblem || verdict.reason;
  // 013.5: the approval is for this tree. Record the commit now; the branch may move afterwards.
  let commit = '';
  if (!failed) { try { commit = git(dir, 'rev-parse', 'HEAD'); } catch { commit = ''; } }
  // 028: 只读任务（「读一遍 README 说说它干什么」）不会产生提交，worktree 也不该有未提交改动。
  // 这种任务的成功就是「回答」，以前却要用户批一次「合并分支到 main」——分支和 main 一模一样。
  const noChanges = !failed && nothingChanged(dir, branch);
  // 031c: 先把建议报上去（unverified），再报完成——页面打开时「它建议记住 N 条」就已经在。
  if (resultText) await reportSuggestions(cfg, task, resultText);
  if (limit) {
    await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
      result: 'limited', slot: usedSlot.name, harness: harnessOf(backendUsed), model: backendUsed.model || '',
      backend: backendUsed.name, limit, summary: limit.raw,
      // 045.1：这一次运行最终的累计 token（本次从 0 数起）。短任务等不到下一次进度上报就结束了。
      tokens_used: tokens,
    }).catch((err) => log(`回报到上限失败：${err.message}`));
    removeWorktree(resolve(project), dir);
    log(`T-${task.id} 账号槽 ${usedSlot.name} 到上限${limit.resetAt ? `，${limit.resetAt} 重置` : '（重置时间没认出来）'}`);
    return;
  }
  // 055.2：回答末尾带 wb-ask、而且这次没失败 → 不是完成，是在等你选：把卡片报上去，任务停在「等你选」。
  // worktree 留着（原会话要在同一个目录里接着干；工作台整理分支时不会碰等你选的任务）。
  // 报不上去（工作台说卡片不合格、网络断了）就当普通回答收尾，不能让任务卡死。
  if (!failed && !stopped) {
    const asked = parseAsk(resultText);
    if (asked.why) log(`T-${task.id} 回答末尾的 wb-ask 不合格，当普通回答收尾：${asked.why}`);
    if (asked.cards) {
      const reg = await api(cfg, 'POST', `/api/runner/tasks/${task.id}/ask`, {
        ask: asked.cards, session_id: sandbox ? '' : sessionId, sandbox: sandboxMode, result_text: asked.rest,
        slot: usedSlot?.name ?? '', harness: harnessOf(backendUsed), model: backendUsed.model || '', backend: backendUsed.name,
        tokens_used: tokens,
      }).catch((err) => { log(`T-${task.id} 报提问失败，当普通回答收尾：${err.message}`); return null; });
      if (reg?.ok) {
        if (sandbox) {
          // 接着干会开新容器、从 main 重新开始：这一轮在容器里写下的文件不带过去。宿主 worktree 退回 main，
          // 免得下一轮的补丁和它打架。
          try { git(dir, 'reset', '--hard', 'main'); } catch (err) { log(`T-${task.id} 沙箱提问后退回 main 失败：${err.message}`); }
        }
        log(`T-${task.id} 提了 ${asked.cards.length} 个问题，等你选（${sandbox ? '沙箱：接着干会开新容器' : sessionId ? `原会话 ${sessionId.slice(0, 8)}` : '没拿到会话号，接着干会开新会话'}）`);
        return;
      }
    }
  }
  const closed = await api(cfg, 'POST', `/api/runner/tasks/${task.id}/finish`, {
    result: failed ? 'failed' : 'done',
    slot: usedSlot?.name ?? '',
    harness: harnessOf(backendUsed),
    model: backendUsed.model || '',
    summary: finishSummary(why, [summary, flagLine(sandboxFlags)].filter(Boolean).join(' ')),
    sandbox: sandboxMode,
    branch: noChanges ? '' : branch,
    commit,
    diff_stat: diffStat,
    tests: run.tests ?? '',
    backend: backendUsed.name,
    result_text: resultText,
    no_changes: noChanges,
    // 039：只改了 docs/ 的任务，合并审批由工作台自动通过（推送和部署照旧要人点）。
    changed_files: noChanges ? [] : taskFiles(dir, git),
    denials: [...denials],
    tokens_used: tokens, // 045.1：同上
  }).catch((err) => { log(`回报 finish 失败：${err.message}`); return null; });

  if (failed) {
    removeWorktree(resolve(project), dir); // 031a: branch stays (never auto-deleted), worktree goes
    log(`T-${task.id} 失败：${why || '未知原因'}`);
    return;
  }
  if (noChanges) {
    // 没有改动就没有可合并的东西：清掉 worktree 和这个空分支，任务到此为止。
    removeWorktree(resolve(project), dir);
    try { git(resolve(project), 'branch', '-D', branch); } catch { /* 分支可能已经被上一个清理删掉 */ }
    // 043 F：工作台可能判成「没干活」——日志跟着工作台说，不自己宣布完成。
    const judged = closed?.task?.status === 'failed' ? `没算完成：${closed.task.fail_reason ?? ''}` : `完成：没有改动，不需要合并（结果 ${resultText.length} 字）`;
    log(`T-${task.id} ${judged}`);
    return;
  }
  // Success: wait for the merge approval, then merge locally and clean up.
  // 043 A：编码这段结束了，名额让出来；等审批不占名额。
  if (inFlight.has(task.id)) inFlight.set(task.id, 'waiting');
  await waitForMerge(cfg, task, project, dir, branch, { commit, approvalId: closed?.approval_id ?? null });
}

async function waitForMerge(cfg, task, project, dir, branch, { commit = '', approvalId = null } = {}) {
  const deadline = Date.now() + Number(cfg.mergeWaitMinutes ?? 120) * 60_000;
  // 013.5: finish returns the id. Polling that one row is the only way to be sure a second run
  // is not reading the previous run's merge approval — a title search happily skips the new one.
  let id = approvalId ? Number(approvalId) : 0;
  while (Date.now() < deadline) {
    await sleep(15_000);
    let merge = null;
    if (id) {
      try { merge = await api(cfg, 'GET', `/api/approvals/${id}`); } catch { merge = null; }
      if (merge && Number(merge.task_id) !== Number(task.id)) merge = null;
    } else {
      // An older workbench does not return approval_id; take the newest merge approval of this
      // task and ignore the older ones entirely, even when they are already decided.
      let approvals;
      try { approvals = await api(cfg, 'GET', `/api/approvals?task=${task.id}`); } catch { continue; }
      merge = newestMerge(Array.isArray(approvals) ? approvals : approvals?.items ?? [], task.id);
      if (merge) id = Number(merge.id);
    }
    if (!merge || merge.status === 'pending') continue;
    if (merge.status === 'approved') {
      // Merge the commit the approval was about, not wherever the branch points now.
      let approved = commit;
      if (!approved && merge.tool_input) {
        try {
          const input = typeof merge.tool_input === 'string' ? JSON.parse(merge.tool_input) : merge.tool_input;
          approved = String(input?.commit ?? '');
        } catch { approved = ''; }
      }
      const what = approved || branch;
      // 013.6: the merge target is the repo the user works in every day. Look before touching it.
      const pre = preMergeProblem(project);
      if (pre.block) {
        // 028: 025 只在 step 里说原因，红框却写着「没有记录原因」。人话要写进 fail_reason。
        const reason = `${mergeBlockedStep(pre.block)}（主仓库 ${basename(project)}）`;
        await api(cfg, 'PATCH', `/api/tasks/${task.id}`, {
          status: 'failed', retry: 'merge', step: mergeBlockedStep(pre.block), fail_reason: reason.slice(0, 300),
        }).catch((e) => log(`记合并受阻时出错：${e.message}`));
        log(`T-${task.id} 没有合并：${pre.block}`);
        return; // worktree stays, branch stays — 重试合并 only repeats this step
      }
      try {
        git(project, 'merge', '--no-ff', what, '-m', `合并 ${branch}（T-${task.id}）`);
        log(`T-${task.id} 已合并到本地 main：${String(what).slice(0, 7)}`);
        if (pre.warn) {
          // 028.1: 合并照做，但要让用户在任务页看到「刚才没连上远端」。
          log(`T-${task.id} ${pre.warn}`);
          await api(cfg, 'PATCH', `/api/tasks/${task.id}`, { step: pre.warn.slice(0, 300) }).catch(() => {});
          await api(cfg, 'POST', '/api/events', { kind: 'runner.merge_offline', text: `T-${task.id} ${pre.warn}`.slice(0, 300) })
            .catch(() => {});
        }
      } catch (err) {
        // 013.5: a merge that failed is a failed task, not a finished one. Keep the worktree.
        await api(cfg, 'PATCH', `/api/tasks/${task.id}`, {
          status: 'failed', step: mergeFailureStep(err), fail_reason: mergeFailureStep(err).slice(0, 300),
        }).catch((e) => log(`标记合并失败时出错：${e.message}`));
        log(`T-${task.id} 合并失败，worktree 保留：${err.message}`);
        return;
      }
      removeWorktree(project, dir);
      // 012.2: merging only touches the local main. Pushing is the user's second button.
      await waitForPush(cfg, task, project, { branch, commit: what });
      return;
    }
    if (merge.status === 'rejected' || merge.status === 'changes') {
      removeWorktree(project, dir);
      // 031a: 旧文案承诺了一个到期天数，但全仓库从来没有清理代码——那是假承诺。分支确实一直留着，
      // 由扫描列进「待处理」，让人决定留还是删。
      const why3 = merge.status === 'rejected' ? '合并被驳回' : '合并被要求先改';
      await api(cfg, 'PATCH', `/api/tasks/${task.id}`, {
        status: 'failed', step: '合并被驳回，分支已保留（不会自动删除）',
        fail_reason: `${why3}：${merge.feedback ? String(merge.feedback).slice(0, 200) : '审批里没有写意见'}。分支还留着，可以在今天页选择保留或删除。`.slice(0, 300),
      }).catch((err) => log(`标记驳回失败：${err.message}`));
      log(`T-${task.id} 合并被驳回，worktree 已清理，分支保留（不会自动删除）`);
      return;
    }
  }
  log(`T-${task.id} 等合并审批超时，worktree 保留`);
}

/**
 * 043 B：把主仓库的 main 和 origin 对齐，只走快进。
 *
 * 决策端现在频繁往 GitHub 推代码。以前 makeWorktree 直接从本地 main 开分支，合并前
 * preMergeProblem 一看「本地 main 落后远端 N 个提交」就整个拦住，只能人去 git pull。
 * 现在开工前、合并前各对齐一次：在 main 上、没有未提交改动、有 origin 时，fetch + merge --ff-only。
 *
 * 返回 `{ block, warn }`：
 * - 快进不了（两边各有自己的提交）→ block，调用方照旧拦住，原因里写清落后几个、领先几个；
 * - 拉不到网络 → 不拦，只 warn（保持 028.1「合并是纯本地操作」）；
 * - 不在 main / 有未提交改动 / 没有 origin → 什么都不做，交给调用方自己的判断。
 */
export function syncMain(project, run = git) {
  let current = '';
  try { current = run(project, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch { return { block: '', warn: '' }; }
  if (current !== 'main') return { block: '', warn: '' };
  let dirty = '';
  try { dirty = run(project, 'status', '--porcelain'); } catch { dirty = ''; }
  // 有没提交的改动就不碰：git 自己也会拒绝 fast-forward，硬来只会把人的半成品卷进来。
  if (dirty) return { block: '', warn: '' };
  // 030 新建的本地项目没有 origin；没有远端就没有「对齐」这回事。
  let remotes = '';
  try { remotes = run(project, 'remote'); } catch { remotes = ''; }
  if (!String(remotes).trim()) return { block: '', warn: '' };

  try {
    withBusy(3 * 60_000, 'git fetch（网络慢时会很久）', () => run(project, 'fetch', 'origin'));
  } catch (err) {
    // 拉不到远端不拦：推送阶段会再拉一次，被拒了任务页有「重试推送」。
    return { block: '', warn: `没能连上远端，用的是本地 main，推送时会再拉一次（${redact(err.message).slice(0, 60)}）` };
  }

  let behind = 0;
  try { behind = Number(run(project, 'rev-list', '--count', 'HEAD..origin/main')) || 0; } catch { behind = 0; }
  if (!behind) return { block: '', warn: '' };
  let ahead = 0;
  try { ahead = Number(run(project, 'rev-list', '--count', 'origin/main..HEAD')) || 0; } catch { ahead = 0; }
  try {
    withBusy(60_000, 'git merge --ff-only（把本地 main 快进到 origin/main）',
      () => run(project, 'merge', '--ff-only', 'origin/main'));
  } catch (err) {
    return {
      block: `本地 main 落后远端 ${behind} 个提交，但快进不了`
        + `（本地还有 ${ahead} 个远端没有的提交，得人工处理；${redact(err.message).slice(0, 80)}）`,
      warn: '',
    };
  }
  return { block: '', warn: '' };
}

/**
 * 013.6: the executor merges into the repo the user actually works in, so it has to look before
 * touching it.
 *
 * 028.1: 合并是纯本地操作，别把网络和它绑在一起。返回 `{ block, warn }`：
 * - `block` 非空 → 不合并（不在 main、有未提交改动、落后远端且快进不了）；
 * - `warn` 非空 → 照常合并，但把这句话写进 step 和审计（没有 origin、或者拉不到远端）。
 *
 * 043 B：落后远端不再直接拦人，先交给 syncMain 快进；快进不了才拦。
 */
export function preMergeProblem(project, run = git) {
  let current = '';
  try { current = run(project, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch (err) {
    return { block: `读不出本地仓库的分支（${redact(err.message).slice(0, 80)}）`, warn: '' };
  }
  if (current !== 'main') return { block: `本地仓库当前在 ${current} 分支上，不是 main`, warn: '' };
  let dirty = '';
  try { dirty = run(project, 'status', '--porcelain'); } catch { dirty = ''; }
  if (dirty) return { block: `本地仓库有 ${dirty.split('\n').filter(Boolean).length} 个文件没提交`, warn: '' };

  const sync = syncMain(project, run);
  if (sync.block) return { block: sync.block, warn: '' };
  return { block: '', warn: sync.warn };
}

/** Git 会把实际远端旧 SHA 交给 pre-push；它随后也用该 SHA 做远端更新的比较基准。 */
function pushApprovedMain(project, run, { base, tip, remote }) {
  if (run(project, 'remote', 'get-url', '--push', '--all', 'origin') !== remote) {
    throw new Error('origin 的推送地址变了，请重新审批');
  }
  const original = run(project, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push');
  const dir = mkdtempSync(join(tmpdir(), 'wb-push-hook-'));
  const shellPath = (path) => "'" + (process.platform === 'win32' ? path.replaceAll('\\', '/') : path).replaceAll("'", "'\\''") + "'";
  try {
    // 只允许本次 SHA 和 main。即使远端被回退，也不能把审批列表之外的历史重新发布。
    // 先保留 Git 传来的 stdin，检查完再交给项目自己的钩子（如 Git LFS）。
    writeFileSync(join(dir, 'pre-push'), `#!/bin/sh
set -eu
updates=$(cat)
printf '%s\\n' "$updates" | while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$remote_ref" ] || continue
  if [ "$remote_ref" != refs/heads/main ] || [ "$local_sha" != ${tip} ] ||
     ! git merge-base --is-ancestor ${base} "$remote_sha"; then
    echo '远端 main 已变动，审批覆盖不了这次推送，请重试推送' >&2
    exit 1
  fi
done
if [ -x ${shellPath(original)} ]; then
  printf '%s\\n' "$updates" | ${shellPath(original)} "$@"
fi
`, { mode: 0o700 });
    return run(project, '-c', `core.hooksPath=${dir}`, '-c', 'remote.origin.mirror=false',
      'push', '--no-follow-tags', '--no-recurse-submodules', 'origin', `${tip}:refs/heads/main`);
  } finally {
    // 目录由本次调用创建，只有这个钩子文件。
    try { unlinkSync(join(dir, 'pre-push')); } catch { /* keep the push result */ }
    try { rmdirSync(dir); } catch { /* keep the push result */ }
  }
}

/** A merge or push that failed for a fixable reason says so, and points at the retry button. */
export function mergeBlockedStep(why, what = '合并') {
  return `没有${what}：${why}。处理完在任务页点「重试${what}」，不用重跑编码工具`;
}

/**
 * 013.6: the second approval — the merge stays local until this one is cleared. Only after
 * `git push` actually succeeds do we tell the workbench the commit, which comments it on the issue.
 * `io` lets tests drive the approval and the sleep; git stays real so a bare repo can be the origin.
 */
export async function pushStep({ cfg, task, project, branch = '', commit = '', io = {} }) {
  const call = io.api ?? api;
  const run = io.git ?? git;
  const wait = io.sleep ?? sleep;
  const say = io.log ?? log;

  let remote = '';
  try { remote = run(project, 'remote', 'get-url', 'origin'); } catch { remote = ''; }
  if (!remote) {
    // 030 D.1：030 新建的本地项目没有远端。这是正常状态，不是失败——页面上要说明白。
    say(`T-${task.id} 没有 origin 远端，跳过推送`);
    await call(cfg, 'POST', `/api/runner/tasks/${task.id}/progress`, { step: '这个项目只在本机，没有远端，推送已跳过' })
      .catch(() => {});
    return;
  }

  let sha = commit;
  let snapshot;
  let files = [];
  let summary = '';
  try {
    const remote = run(project, 'remote', 'get-url', '--push', '--all', 'origin');
    if (!remote || remote.includes('\n')) throw new Error('origin 必须只有一个推送地址');
    const tip = run(project, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
    sha ||= tip;
    const base = run(project, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
    if (![tip, base].every((s) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s))) throw new Error('无法确认 main 的提交');
    const lines = run(project, 'log', '--no-show-signature', '--format=%H %s', `${base}..${tip}`).split('\n').filter(Boolean);
    snapshot = { tip, base, remote };
    files = run(project, 'diff', '--name-only', `${base}..${tip}`).split('\n').filter(Boolean);
    summary = [
      `本地 main 已合并 ${branch || '任务分支'}，这次只推送快照 ${tip}。`,
      lines.length ? `要推上去的提交：\n${lines.map((l) => `- ${l}`).join('\n')}` : '没有本地新增提交。',
      '用的是这台电脑上 git 自己的登录凭证，执行器不碰任何令牌。',
    ].join('\n\n');
    if (summary.length > 20_000) throw new Error('待推提交太多，审批里列不全');
  } catch {
    await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
      status: 'failed', retry: 'push', merged_commit: sha || null,
      step: '推送失败：无法完整确认待推提交和远端，请检查 origin/main 后重试推送',
      fail_reason: '没有推送：无法完整确认待推提交和远端，请检查 origin/main 后重试推送',
    }).catch(() => {});
    return;
  }

  let approval = null;
  try {
    approval = await call(cfg, 'POST', '/api/approvals', {
      title: `推送 main 到 GitHub（T-${task.id}）`,
      summary,
      risk: 'medium',
      tool_name: 'git push',
      tool_input: { branch, commit: snapshot.tip, base: snapshot.base },
      task_id: task.id,
    });
  } catch (err) {
    say(`T-${task.id} 建推送审批失败：${err.message}`);
    return;
  }
  if (!approval?.id) { say(`T-${task.id} 建推送审批没拿到 id，跳过推送`); return; }
  say(`T-${task.id} 已合并到本地 main，等推送审批（#${approval.id}）`);

  const deadline = Date.now() + Number(cfg.pushWaitMinutes ?? 30) * 60_000;
  while (Date.now() < deadline) {
    await wait(15_000);
    let row = null;
    try { row = await call(cfg, 'GET', `/api/approvals/${approval.id}`); } catch { continue; }
    if (!row || row.status === 'pending') continue;
    if (row.status !== 'approved') {
      // 013.6: a rejection is not a failure — the work is merged locally and stays there.
      await call(cfg, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', retry: '', merged_commit: sha || null, step: '已合并到本地，没有推送' })
        .catch((err) => say(`标记推送驳回时出错：${err.message}`));
      say(`T-${task.id} 推送被驳回，本地 main 已合并但没推`);
      return;
    }
    try {
      withBusy(5 * 60_000, 'git push（网络慢时会很久）', () => pushApprovedMain(project, run, snapshot));
    } catch (err) {
      const raw = redact(err.message).replace(/^git push[^\n]*失败：/, '').trim();
      // 028.1: 网络问题和权限问题是两回事，说法要不一样，否则用户会去改令牌。
      const offline = /unable to access|could not resolve|connection (refused|reset|timed out)|tls|ssl|fetch failed|network is unreachable/i.test(raw);
      const why = offline ? '现在连不上 GitHub' : raw.slice(0, 160);
      const next = offline ? '等网络好了在任务页点「重试推送」' : '修好后在任务页点「重试推送」';
      await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
        status: 'failed', retry: 'push', merged_commit: sha || null,
        step: `推送失败：${why}。${next}`,
        // 028: 推送失败也要有能读的原因，红框不该写「没有记录原因」。
        fail_reason: `没有推送：${why}。本地 main 已经合并好了，${next}，不用重跑编码工具。`.slice(0, 300),
      }).catch((e) => say(`标记推送失败时出错：${e.message}`));
      say(`T-${task.id} 推送失败：${err.message}`);
      return;
    }
    const head = snapshot.tip;
    await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
      status: 'done', retry: '', merged_commit: head, step: '已推送到 origin/main',
    }).catch((err) => say(`记推送结果失败：${err.message}`));
    await call(cfg, 'POST', `/api/runner/tasks/${task.id}/pushed`, { commit: head, branch })
      .catch((err) => say(`回报推送结果失败：${err.message}`));
    say(`T-${task.id} 已推送到 origin/main：${head}`);
    // 035 C：改了会跑在工作台里的东西，就再请人批一次部署。
    // 035.3：只看「要不要重建」不够，还得看「是不是工作台自己的仓库」。
    // 别的项目改了 src/ 不该弹部署审批，更不该在别人的目录里跑 docker compose。
    if (shouldDeploy({ files, project, repo: SELF_REPO })) {
      await deployStep({ cfg, task, project, files, io: { api: call, sleep: wait, log: say, exit: io.exit } });
    } else if (needsDeploy(files)) {
      say(`T-${task.id} 改了 ${deployDirs(files).join('、')}，但这不是工作台自己的仓库，跳过部署`);
    }
    return;
  }
  await call(cfg, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', retry: '', merged_commit: sha || null, step: '已合并到本地，等推送审批超时' })
    .catch(() => {});
  say(`T-${task.id} 等推送审批超时，本地 main 已合并但没推`);
}

async function waitForPush(cfg, task, project, opts) {
  return pushStep({ cfg, task, project, ...opts });
}

/**
 * 035 C：部署审批。推送成功、而且这次动了会跑在工作台里的东西（src/、public/、scripts/、
 * Dockerfile、docker-compose.yml、package.json）时，再请人批一次；批准后重建容器、
 * 等 /api/health 恢复，然后自己退出，让守卫用新代码拉起新进程（032 的锁保证只有一个）。
 * 失败不回滚代码，只把原因写进任务页。
 */
export async function deployStep({ cfg, task, project, files, io = {} }) {
  if (inFlight.has(task.id)) inFlight.set(task.id, 'waiting');
  const call = io.api ?? api;
  const wait = io.sleep ?? sleep;
  const say = io.log ?? log;
  const dirs = deployDirs(files);
  let approval = null;
  try {
    approval = await call(cfg, 'POST', '/api/approvals', {
      title: `部署：重建工作台并重启执行器（T-${task.id}）`,
      summary: [
        `这次推送动了 ${dirs.join('、')}，容器里的工作台还是旧代码，要重建才对得上。`,
        '批准后执行器会跑 `docker compose up -d --build`，等 /api/health 应答，然后把自己换成新进程。',
        '失败不会回滚代码：容器没起来会在任务页里写清楚原因。',
      ].join('\n\n'),
      risk: 'medium',
      tool_name: 'docker compose',
      tool_input: { dirs },
      task_id: task.id,
    });
  } catch (err) {
    say(`T-${task.id} 建部署审批失败：${err.message}`);
    return;
  }
  if (!approval?.id) { say(`T-${task.id} 建部署审批没拿到 id，跳过部署`); return; }

  const deadline = Date.now() + Number(cfg.pushWaitMinutes ?? 30) * 60_000;
  while (Date.now() < deadline) {
    await wait(15_000);
    let row = null;
    try { row = await call(cfg, 'GET', `/api/approvals/${approval.id}`); } catch { continue; }
    if (!row || row.status === 'pending') continue;
    if (row.status !== 'approved') {
      // 035.3.3：建部署审批会把任务从「已完成」翻成「等审批」，批完再翻成「运行中」；
      // 被驳回时没人再改它，任务就永远挂在「运行中」，队列「一次只允许一个在途」于是再也不建新单。
      await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
        status: 'done', retry: '',
        step: '已推送，部署没批：容器还是旧的，代码已经在 origin/main 上了',
      }).catch(() => {});
      say(`T-${task.id} 部署被驳回，代码已推送但没重建`);
      return;
    }
    const previous = deployTail;
    let unlock;
    deployTail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    let exiting = false;
    try {
      // 043.1：一次只部署一个。035.3.3 只收尾本单，不能恢复其它任务的审批轮询。
      await (io.drain ?? drainOthers)(task.id, {
        notify: (text) => call(cfg, 'POST', '/api/events', { kind: 'runner.drain', task_id: task.id, text: text.slice(0, 300) }).catch(() => {}),
      });
      const res = await runDeploy({ cfg, project, io,
        canHandoff: () => !claiming && [...inFlight.keys()].every((id) => id === task.id),
      });
      if (!res.ok) {
        await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
          status: 'failed', retry: '',
          step: `部署失败：${res.why}`,
          fail_reason: `代码已经推到 origin/main，但部署没成功：${res.why}`.slice(0, 300),
        }).catch(() => {});
        say(`T-${task.id} 部署失败：${res.why}`);
        return;
      }
      if (res.handoff) {
        // 035.3：先让工作台记下「我要退了，接下来该有一个新执行器接班」，再退出。
        // 顺序不能反——反过来工作台只会看到执行器掉线，看不出这是正常交接。
        // 页面靠心跳里的 pid / code_hash 判断接班到没到，5 分钟没等到就提醒人手动启动。
        const fingerprint = (() => {
          try { return codeFingerprint().slice(0, 8); } catch { return ''; }
        })();
        let recorded = true;
        try {
          await call(cfg, 'POST', '/api/runner/handoff', {
            runner: cfg.runnerId ?? `runner-${process.pid}`,
            pid: process.pid,
            code_hash: fingerprint,
            // 035.3.3：这个进程马上就要退出，谁都来不及给任务写结局；把 id 交给工作台，
            // 等新执行器的心跳到（或 5 分钟没人接班）时由它收尾，任务才不会永远卡在 running。
            task_id: task.id,
          });
        } catch (err) {
          recorded = false;
          say(`记「等待接班」失败：${err.message}`);
        }
        await call(cfg, 'PATCH', `/api/tasks/${task.id}`, recorded
          ? { step: `已部署（容器已重建），正在换成新执行器（接班助手 ${res.helper ?? '已起'}）` }
          // 交接没记上，服务端就不知道该给谁收尾——这一条自己结掉，别把任务留在「运行中」。
          : { status: 'done', step: `已部署（容器已重建），正在换成新执行器（接班助手 ${res.helper ?? '已起'}）；交接没记上，这一条直接结掉` },
        ).catch(() => {});
        say(`T-${task.id} 部署完成，退出让接班助手启动新实例（助手 ${res.helper ?? '未知'}）`);
        (io.exit ?? ((code) => process.exit(code)))(0);
        exiting = true;
        return;
      }
      await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
        status: 'done',
        step: res.note ? `已部署（容器已重建）；${res.note}` : '已部署',
      }).catch(() => {});
      say(`T-${task.id} 部署完成，但换进程要手动：${res.note}`);
      return;
    } finally {
      if (!exiting) endDrain();
      unlock();
    }
  }
  await call(cfg, 'PATCH', `/api/tasks/${task.id}`, {
    status: 'done',
    step: '已推送，等部署审批超时（容器还是旧的）',
  }).catch(() => {});
  say(`T-${task.id} 等部署审批超时`);
}

/** 013.6: 5s, 10s, 20s … capped at a minute — long enough to ride out a `docker compose up`. */
export function pollBackoff(errors) {
  const n = Math.max(1, Number(errors) || 1);
  return Math.min(60_000, 5_000 * 2 ** (n - 1));
}

/** One retry per claim: clear the flag first, so a crash cannot loop the same step forever. */
async function clearRetry(cfg, id) {
  await api(cfg, 'PATCH', `/api/tasks/${id}`, { retry: '' }).catch((err) => log(`清重试标记失败：${err.message}`));
}

/** 013.6: 「重试合并」 — the branch is still there, so only the merge has to happen again. */
async function retryMerge(cfg, task, project) {
  // 025: 先确认分支真的存在。以前失败任务也被写上默认分支名，于是「重试合并」会去合并一个
  // 根本不存在的分支，报出来的错也牛头不对马嘴。
  if (!task.branch) {
    await api(cfg, 'PATCH', `/api/tasks/${task.id}`, { status: 'failed', retry: '', step: '没有这个分支，不是合并失败；要重跑用「重新开始」' })
      .catch((err) => log(`记重试结果失败：${err.message}`));
    log(`T-${task.id} 没有分支，跳过重试合并`);
    return;
  }
  try {
    git(project, 'rev-parse', '--verify', `refs/heads/${task.branch}`);
  } catch {
    await api(cfg, 'PATCH', `/api/tasks/${task.id}`, { status: 'failed', retry: '', step: `本地没有分支 ${task.branch}，不是合并失败；要重跑用「重新开始」` })
      .catch((err) => log(`记重试结果失败：${err.message}`));
    log(`T-${task.id} 分支 ${task.branch} 不存在，跳过重试合并`);
    return;
  }
  // 043 B：preMergeProblem 从 028.1 起返回 { block, warn }，这里以前直接 `if (why)`——
  // 对象永远为真，于是「重试合并」一次也没真跑到合并，报出来的原因还是 [object Object]。
  const pre = preMergeProblem(project);
  if (pre.block) {
    await api(cfg, 'PATCH', `/api/tasks/${task.id}`, {
      status: 'failed', retry: 'merge', step: mergeBlockedStep(pre.block),
      fail_reason: `${mergeBlockedStep(pre.block)}（主仓库 ${basename(project)}）`.slice(0, 300),
    }).catch((err) => log(`记重试结果失败：${err.message}`));
    log(`T-${task.id} 重试合并仍然不行：${pre.block}`);
    return;
  }
  if (pre.warn) log(`T-${task.id} ${pre.warn}`);
  try {
    git(project, 'merge', '--no-ff', task.branch, '-m', `合并 ${task.branch}（T-${task.id}）`);
  } catch (err) {
    const why2 = redact(err.message).slice(0, 160);
    await api(cfg, 'PATCH', `/api/tasks/${task.id}`, {
      status: 'failed', retry: 'merge', step: `合并失败：${why2}。修好后点「重试合并」`,
      fail_reason: `没有合并：${why2}。先解决冲突（在 ${basename(project)} 里 git status 看），再点「重试合并」。`.slice(0, 300),
    }).catch((e) => log(`记合并失败时出错：${e.message}`));
    log(`T-${task.id} 重试合并失败：${err.message}`);
    return;
  }
  let head = '';
  try { head = git(project, 'rev-parse', '--short', 'HEAD'); } catch { head = ''; }
  await api(cfg, 'PATCH', `/api/tasks/${task.id}`, { status: 'done', retry: '', merged_commit: head, step: `已合并 ${task.branch}，等推送审批` })
    .catch((err) => log(`记合并结果失败：${err.message}`));
  log(`T-${task.id} 重试合并完成：${head}`);
  await waitForPush(cfg, task, project, { branch: task.branch ?? '', commit: task.merged_commit ?? head });
}

// ---------- loop ----------

/**
 * `node scripts/runner.mjs --check`: everything a real run needs, without touching a task.
 * Useful right after installing a coding CLI, and before enabling the scheduled task.
 */
export function doctor(cfg, { probeLogin = false } = {}) {
  const rows = [];
  const push = (ok, name, detail) => rows.push({ ok, name, detail });

  push(true, '配置文件', CONFIG_FILE);
  push(Boolean(cfg.workbench), '工作台地址', cfg.workbench ?? '(缺)');

  const gate = selfCheck(cfg);
  push(gate.ok, '门禁配置', gate.ok ? gate.file : gate.reason);

  const projects = Object.entries(cfg.projects ?? {});
  push(projects.length > 0, '项目路径', projects.map(([k, v]) => `${k} → ${v}`).join('，') || '(缺)');
  for (const [name, path] of projects) push(existsSync(path), `项目 ${name}`, path);

  const executors = Object.entries(cfg.executors ?? {});
  push(executors.length > 0, '执行者', executors.map(([k]) => k).join(', ') || '(缺)');
  for (const [name, spec] of executors) {
    const backends = backendsFor(spec, name);
    const toolName = backends[0]?.tool ?? 'claude';
    const found = which(toolName);
    push(Boolean(found), `编码工具（${name}）`, found || `找不到 ${toolName}，先装好再跑任务`);
    // 036：dsh 单独三行——版本锁、它那条只读底线、以及「日志不上传」这件事本身可见。
    if (String(spec?.tool ?? '') === 'dsh') {
      const gate = dshGate(spec, { name });
      const lockText = spec?.dshVersion
        ? `版本 ${gate.version}（已锁 ${spec.dshVersion}）`
        : `版本 ${gate.version}${gate.memorized ? `（没锁 dshVersion，已记下第一次的 ${gate.memorized}；变了会拒绝）` : '（没锁 dshVersion；第一次跑会记下来，之后变了就拒绝）'}`;
      push(!gate.problem, `dsh（${name}）`, gate.problem || lockText);
      push(true, `dsh 权限（${name}）`, '只读任务：DSH_PERMISSION_MODE=read-only，写文件会被沙箱拒绝');
      push(true, `dsh 日志上传（${name}）`, '已关闭：DSH_TELEMETRY_MODE=DISABLED，会话内容不会上传');
    }
    // 037：codebuddy 三行——版本、登录（--check 时才真问一次）、以及这次到底是可写还是只读。
    if (backends.some((b) => b.tool === 'codebuddy')) {
      const exe = String(spec?.codebuddyPath ?? '').trim() || which('codebuddy');
      const version = codebuddyVersion(exe);
      push(Boolean(version), `codebuddy（${name}）`, version ? `版本 ${version}` : '找不到 codebuddy，先 `npm i -g @tencent-ai/codebuddy-code`');
      if (probeLogin && exe) {
        const state = codebuddyLoginState(exe, { now: 0 }); // --check 就是要眼下的答案，不吃缓存
        push(state === 'ok', `codebuddy 登录（${name}）`, loginProblem(state) || '已登录（沿用本机状态）');
      }
      push(true, `codebuddy 权限（${name}）`, cfg.codebuddyWrite === true
        ? '可写：-y + worktree 里的 PreToolUse 钩子，命中规则的操作会等工作台审批'
        : '只读：没给 -y，且禁了 Bash/Write/Edit；真机验收过审批再在配置里开 codebuddyWrite');
    }
    // 017: one row per backend, so a half-filled fallback shows up before a real run needs it.
    for (const b of backends) {
      const model = b.model || b.env?.ANTHROPIC_MODEL || '';
      const keys = Object.keys(b.env ?? {});
      // dsh / codebuddy 的模型由工具自己管（codebuddy 不填就用账号默认模型），不按 Anthropic 那套要求。
      const selfModel = b.tool === 'dsh' || b.tool === 'codebuddy';
      push(Boolean(model) || selfModel, `后端 ${b.name}（${name}）`, model || (selfModel ? `(${b.tool} 自己管模型)` : '缺 ANTHROPIC_MODEL'));
      push(keys.length > 0 || backends.length === 1, `后端环境变量 ${b.name}（${name}）`, keys.join(', ') || '(只继承白名单)');
    }
  }
  return rows;
}

/** Cross-platform `which`, without pulling in a dependency. */
export function which(name) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * 020: what the workbench needs for the setup checklist — names only. No paths, no keys: the
 * doctor rows go through redact() and get cut to the failing item names plus a count.
 */
export function setupSnapshot(cfg, now = new Date().toISOString()) {
  const projects = Object.keys(cfg.projects ?? {});
  const backends = [...new Set(Object.entries(cfg.executors ?? {})
    .flatMap(([name, spec]) => backendsFor(spec, name).map((b) => b.name)))];
  let rows = [];
  try { rows = doctor(cfg); } catch { rows = []; }
  const bad = rows.filter((r) => !r.ok);
  const summary = rows.length
    ? (bad.length ? `自检 ${rows.length - bad.length}/${rows.length} 项就绪，没过：${bad.map((r) => r.name).join('、')}` : `自检 ${rows.length}/${rows.length} 项就绪`)
    : '自检没有结果';
  return {
    projects,
    backends,
    // 030: 只报一个布尔值——有没有配项目根目录，路径本身不出本机。
    projectsRoot: Boolean(String(cfg.projectsRoot ?? '').trim()),
    check: { ok: rows.length > 0 && bad.length === 0, at: now, summary: redact(summary).slice(0, 200) },
  };
}

function printDoctor(cfg) {
  // --check 是「现在能不能跑」的问答：codebuddy 的登录状态要真问一次，不能吃缓存。
  const rows = doctor(cfg, { probeLogin: true });
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.name}：${r.detail}`);
  const bad = rows.filter((r) => !r.ok);
  console.log(bad.length ? `\n有 ${bad.length} 项没准备好，先修好再跑任务。` : '\n一切就绪，可以跑任务了。');
  return bad.length === 0;
}

/**
 * 031a: 把每个项目的分支和 worktree 报给工作台，拿到「删哪些」的计划后自己动手。
 * 工作台不知道本机磁盘，执行器不知道哪些任务还在跑——所以判定在服务端，git 操作在这里。
 */
export async function sweepBranches(cfg) {
  const root = resolve(cfg.worktreeRoot ?? join(HOME, 'wb-worktrees'));
  const projects = cfg.projects ?? {};
  for (const [name, path] of Object.entries(projects)) {
    const project = resolve(String(path));
    if (!existsSync(join(project, '.git'))) {
      // 裸仓库或 worktree 布局都不是任务的落脚点，跳过但留一行日志。
      continue;
    }
    let scan = null;
    try { scan = scanBranches(project, root); } catch (err) { log(`扫 ${name} 的分支失败：${err.message}`); continue; }
    // 031a.1：读不出 main / merged 时整个项目跳过。上报空列表会被当成「这个项目没有分支了」，
    // 把人之前留着的待处理记录也擦掉，所以这种「读不出来」的情况直接不报。
    if (scan.skipped) { log(`${name}：${scan.skipped}`); continue; }
    // 但「读得出来、确实一条都没有」要照报：人在 git 里自己把分支删了（没走页面上的删除按钮），
    // 服务端只有收到这份空列表才会把旧记录清掉，否则页面上一直挂着已经不存在的分支。
    const plan = await api(cfg, 'POST', '/api/runner/branches', { project: name, ...scan }).catch((err) => {
      log(`上报 ${name} 的分支失败：${err.message}`);
      return null;
    });
    if (!plan) continue;
    const { cleaned, failed } = applyCleanup(project, plan);
    if (cleaned.length || failed.length) {
      if (cleaned.length) log(`${name}：清理了 ${cleaned.join('、')}`);
      if (failed.length) log(`${name}：${failed.map((f) => `${f.branch} 没删掉（${f.reason}）`).join('；')}`);
      await api(cfg, 'POST', '/api/runner/branches/done', { project: name, cleaned, failed }).catch((err) => {
        log(`回报 ${name} 的清理结果失败：${err.message}`);
      });
    }
    for (const r of plan.rejected ?? []) log(`${name}：没删 ${r.branch}——${r.reason}`);
    if (plan.report?.length) log(`${name}：${plan.report.length} 个分支待处理，等人决定`);
  }
}

/**
 * 030：工作台记的「新建项目 / 克隆 / 关联远端」请求，由执行器在本机做。
 * 只在自己配置的 projectsRoot 下面动，请求里没有路径字段——路径由名字拼出来再核对。
 */
function saveConfig(cfg) {
  let base = {};
  try { base = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { base = {}; }
  base.projects = { ...(base.projects ?? {}), ...(cfg.projects ?? {}) };
  if (cfg.projectsRoot) base.projectsRoot = cfg.projectsRoot;
  writeFileSync(CONFIG_FILE, `${JSON.stringify(base, null, 2)}\n`);
}

export async function handleProjectRequests(cfg, save = saveConfig) {
  if (!String(cfg.projectsRoot ?? '').trim()) return null; // 没配根目录就当这个功能不存在
  let req = null;
  try { req = await api(cfg, 'GET', '/api/runner/project-request'); } catch { return null; }
  if (!req || !req.id) return null;

  let res;
  if (req.kind === 'clone') res = withBusy(10 * 60_000, '克隆仓库', () => cloneProject(cfg, req.name, req.url));
  else if (req.kind === 'remote') res = addRemote(cfg, req.name, req.url);
  else res = createProject(cfg, req.name, req.note);

  if (res.ok && res.path) {
    cfg.projects = { ...(cfg.projects ?? {}), [req.name]: res.path };
    try { save(cfg); } catch (err) { log(`把 ${req.name} 写进配置失败：${err.message}`); }
  }
  log(`项目请求 ${req.kind} ${req.name}：${res.ok ? '完成' : `失败——${res.message}`}`);
  await api(cfg, 'POST', `/api/runner/project-request/${req.id}/finish`, { ok: res.ok, message: res.message })
    .catch((err) => log(`回报项目请求失败：${err.message}`));
  return res;
}

async function main() {
  const cfg = config();  if (process.argv.includes('--check')) {
    process.exit(printDoctor(cfg) ? 0 : 1);
  }
  const runnerId = cfg.runnerId ?? `runner-${process.pid}`;
  const executors = Object.keys(cfg.executors ?? {});
  if (!executors.length) throw new Error('配置里没有任何执行者');
  const once = process.argv.includes('--once');

  const gate = selfCheck(cfg);
  if (!gate.ok) {
    log(`门禁自检失败，不领任务：${gate.reason}`);
    try { await api(cfg, 'POST', '/api/events', { kind: 'runner.selfcheck', text: `执行器门禁自检失败：${gate.reason}`.slice(0, 300) }); } catch { /* offline */ }
    throw new Error(`门禁自检失败：${gate.reason}`);
  }
  log(`门禁配置就绪：${gate.file}`);

  // 046.3：上次崩溃留下的沙箱（容器、卷、网络），开工前清掉——此刻还没有在跑的任务。
  if (anySandbox(cfg)) {
    try {
      const removed = await getProvider('docker', { image: cfg.sandboxImage || 'wb-sandbox:latest' }).sweepOrphans([]);
      if (removed.length) log(`清掉上次留下的沙箱：${removed.join('、')}`);
    } catch (err) { log(`扫沙箱残留失败：${err.message}`); }
  }

  const bootHash = codeFingerprint();
  let warnedStale = false;
  let beatFails = 0;
  const metaNow = () => {
    const disk = codeFingerprint();
    const stale = disk !== bootHash;
    if (stale && !warnedStale) {
      warnedStale = true;
      log(`磁盘上的 runner 代码变了（${bootHash.slice(0, 8)} → ${disk.slice(0, 8)}），这个进程还在跑旧代码，重启后才生效`);
    }
    return {
      executors,
      pid: process.pid,
      ...setupSnapshot(cfg),
      code_hash: bootHash.slice(0, 8),
      stale_code: stale,
      // 043 A：页面上的「在跑 2 / 最多 3」。
      running: [...inFlight.entries()].map(([id, phase]) => ({ id, phase })),
      max_parallel: maxParallel(cfg),
      ...(stale ? { disk_hash: disk.slice(0, 8) } : {}),
    };
  };
  // 心跳失败原来被 `.catch(() => {})` 全吞了。2026-10-31 一天之内撞到两次「心跳停了两三个小时、
  // 日志里一个字都没有」，只能靠库里的 last_seen 停住才发现，查不出是网络、鉴权还是 metaNow() 抛的。
  // 现在：第 1 次必记，之后每 20 次（约 10 分钟）记一条，恢复时再记一条——既不刷屏，也不装没事。
  //
  // 但 2026-11-01 凌晨那次更狠：心跳和日志**同时**停住，而机器二十分钟之后才睡眠——说明不是崩溃、
  // 也不是网络，是整个进程不再执行任何代码（连定时器都不跑）。那种情况自己写不出日志，所以每跳一下
  // 就往 `runner.beat` 落一个时间戳，让 guard 从外面判断「还动不动」，卡住了就杀掉重开。
  const writeBeat = () => {
    try {
      writeFileSync(BEAT_FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }), 'utf8');
    } catch {
      /* 写不进去不该影响任务 */
    }
  };
  const heartbeat = () => {
    writeBeat();
    let meta;
    try {
      meta = metaNow();
    } catch (err) {
      if (shouldLogBeat(++beatFails)) log(`心跳失败 ${beatFails} 次（连 meta 都算不出来）：${err.message}`);
      return;
    }
    return api(cfg, 'POST', '/api/runner/heartbeat', { runner: runnerId, meta })
      .then(() => {
        if (beatFails) log(`心跳恢复（此前连续失败 ${beatFails} 次）`);
        beatFails = 0;
      })
      .catch((err) => {
        if (shouldLogBeat(++beatFails)) log(`心跳失败 ${beatFails} 次：${err.message}`);
      });
  };
  const beat = setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
  await heartbeat();
  log(`执行器 ${runnerId} 启动，执行者：${executors.join(', ')}（代码 ${bootHash.slice(0, 8)}）`);

  // 031a: 启动时扫一次，之后每 6 小时一次。扫描本身不删「有成果」的分支，删什么由工作台决定。
  const sweep = () => void sweepBranches(cfg).catch((err) => log(`整理分支时出错：${err.message}`));
  sweep();
  setInterval(sweep, 6 * 3600_000);

  let misses = 0;
  let githubRoundAt = 0;
  let githubRelaying = false;
  log(`最多同时编码 ${maxParallel(cfg)} 个任务`);
  try {
    for (;;) {
      // 043 A：名额满了（或者在为重启排空）就先不领，过一会儿再看。
      if (!canClaim(cfg)) { await sleep(2_000); continue; }
      let task = null;
      try {
        claiming = true;
        task = await api(cfg, 'GET', `/api/runner/next?executors=${encodeURIComponent(executors.join(','))}&runner=${encodeURIComponent(runnerId)}`);
        misses = 0;
      } catch (err) {
        // 013.6: recreating the container or a wifi blip used to kill the whole runner (exit 1).
        misses++;
        claiming = false;
        log(`连不上工作台（第 ${misses} 次）：${err.message}`);
        if (once) throw err;
        await sleep(pollBackoff(misses));
        continue;
      }
      claiming = false;
      if (!task) {
        if (once) break;
        if (!githubRelaying && Date.now() - githubRoundAt >= 5 * 60_000) {
          githubRoundAt = Date.now();
          githubRelaying = true;
          void githubRelayRound(cfg, { api })
            .catch(() => log('GitHub 转发没能交给工作台，下一轮再试'))
            .finally(() => { githubRelaying = false; });
        }
        // 042：空闲时先问一句「有要我拿主意的任务吗」。派完立刻再轮一次，别白睡十秒。
        let routed = 0;
        try { routed = await routeRound(cfg); } catch (err) { log(`派单时出错：${err.message}`); }
        if (routed) continue;
        // 030：空闲时顺手处理一条「新建项目」请求。执行器不在线时请求就挂着，上线后自动做。
        await handleProjectRequests(cfg).catch((err) => log(`处理项目请求出错：${err.message}`));
        await sleep(10_000);
        continue;
      }
      log(`领到 T-${task.id}「${task.title}」（编码中 ${codingCount() + 1}/${maxParallel(cfg)}）`);
      inFlight.set(task.id, task.retry === 'merge' || task.retry === 'push' ? 'waiting' : 'coding');
      const job = runTask(cfg, task)
        .catch((err) => log(`T-${task.id} 异常：${err.message}`))
        .finally(() => inFlight.delete(task.id));
      if (once) { await job; break; }
    }
  } finally {
    clearInterval(beat);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main().catch((err) => { console.error(err.message); process.exit(1); });
