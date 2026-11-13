// 046.3：执行器在沙箱里跑一次任务。runner.mjs 只调这里的三个函数，所有起进程、碰文件的地方都可替换。
//
//   sandboxPlan(backend, cfg, taskId) → 这个后端能不能进沙箱、进去带什么（假 key、网关、白名单）
//   runInSandbox({...})              → bundle 进去、容器里跑 Claude Code、补丁出来；无论成败都销毁
//   applySandboxPatch({...})         → patch-guard 审过，才在宿主 worktree 里套用并提交
//
// 第一版只支持「Claude Code + API Key 后端」（反代池、DeepSeek、百炼这类）。订阅登录（槽）、dsh、codebuddy
// 进沙箱是 046.5，现在遇到就**直接失败并说清楚**——不悄悄退回宿主上跑（046 总原则 6）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPatch, safeLabel } from './patch-guard.mjs';

export const SANDBOX_REPO = '/work/repo';
export const FAKE_KEY = 'sk-wb-sandbox-not-a-real-key';
const DEFAULT_ALLOW = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'];
const BRANCH_RE = /^wb\/T-\d+(-\d+)?$/;

/**
 * @returns {{ok:true, gateway:object, egress:object, env:Record<string,string>} | {ok:false, why:string}}
 */
export function sandboxPlan(backend = {}, cfg = {}, taskId = 0) {
  const tool = backend.tool ?? 'claude';
  if (tool !== 'claude') return { ok: false, why: `沙箱第一版只支持 Claude Code，这个后端是 ${tool}（046.5 再做）` };
  const env = backend.env ?? {};
  const base = String(env.ANTHROPIC_BASE_URL ?? '').trim();
  const token = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim();
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim();
  if (!base || !(token || apiKey)) return { ok: false, why: '沙箱第一版只支持带 API Key 的后端；用订阅登录（账号槽）的进沙箱是 046.5，还没做' };
  let u;
  try { u = new URL(base); } catch { return { ok: false, why: `后端 ${backend.name ?? ''} 的 ANTHROPIC_BASE_URL 不是合法地址` }; }
  // 反代池这类上游就在宿主上：容器里的 127.0.0.1 是容器自己，要换成 Docker Desktop 给的宿主名字。
  // 只有网关能连它，agent 连不到（agent 只接无出口的内网）。
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]') u.hostname = 'host.docker.internal';
  const upstream = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const auth = token ? 'bearer' : 'x-api-key';
  const allow = [...new Set([...DEFAULT_ALLOW, ...(Array.isArray(cfg.sandboxAllow) ? cfg.sandboxAllow : [])])];
  return {
    ok: true,
    gateway: { upstream, preset: 'anthropic', auth, key: token || apiKey },
    // 046 真机：宿主开了 Clash 一类代理的 fake-ip，白名单里的名字会解析到 198.18.x.x；配置里显式打开才放行。
    egress: { allow, ...(cfg.sandboxFakeIp === true ? { fakeIp: true } : {}) },
    env: {
      HOME: '/home/agent',
      CLAUDE_CONFIG_DIR: '/home/agent/.claude',
      ANTHROPIC_BASE_URL: 'http://wb-gateway:8080',
      ...(token ? { ANTHROPIC_AUTH_TOKEN: FAKE_KEY } : { ANTHROPIC_API_KEY: FAKE_KEY }),
      ...(backend.model ? { ANTHROPIC_MODEL: String(backend.model) } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      WB_SANDBOX: '1',
      WB_TASK_ID: String(taskId),
    },
  };
}

/**
 * 这个执行者在不在沙箱里跑。执行者自己写了 `sandbox` 就听它的，没写才看全局的。
 * 这样可以全局开沙箱、但让 WorkBuddy / dsh / 订阅登录这类还进不了沙箱的执行者写 `"sandbox": "none"` 照旧跑；
 * 也可以全局不开、只给某一个执行者开。只认 "docker"，别的值一律当 none。
 */
export function sandboxModeFor(cfg = {}, executor = '') {
  const own = cfg.executors?.[executor]?.sandbox;
  const v = own !== undefined ? own : cfg.sandbox;
  return v === 'docker' ? 'docker' : 'none';
}

/** 有没有任何一个执行者会用沙箱：执行器启动时据此决定要不要扫残留。 */
export function anySandbox(cfg = {}) {
  return cfg.sandbox === 'docker' || Object.values(cfg.executors ?? {}).some((e) => e?.sandbox === 'docker');
}

/** 沙箱里的 Claude Code：墙是容器，不是钩子——所以不走审批钩子，权限全开（046 总原则 1）。 */
export function agentArgv(prompt) {
  return ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
}

// ───────────── 046.7：磁盘上限、同时跑几个 ─────────────

export const DISK_DEFAULT_MB = 4096;
export const DISK_HARD_MB = 32768;
/** 每个沙箱除了 agent 容器，还有代理、网关各 256 MB。 */
const SIDECARS_MB = 512;
/** 给 Docker 自己和 WSL 里别的东西留的。 */
const RESERVE_MB = 2048;
const BOX_CAP = 3;

/** 配置里的 sandboxDiskMb：不写用 4 GB；写错了抛错；写太大截到 32 GB。 */
export function diskLimitMb(cfg = {}) {
  const v = cfg.sandboxDiskMb;
  if (v === undefined || v === null) return DISK_DEFAULT_MB;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 256) throw new Error('sandboxDiskMb 要是不小于 256 的数（单位 MB）');
  return Math.min(n, DISK_HARD_MB);
}

/**
 * 同时最多跑几个沙箱：min(执行器并行数, 3, 内存装得下几个)。
 * 内存装得下几个 = (Docker 虚拟机总内存 − 2 GB 预留) ÷ (agent 内存 + 代理网关 512 MB)；
 * 默认 2 GB 的 agent、8 GB 的 WSL 就是 floor(6144 ÷ 2560) = 2。读不出总内存就不按内存算。至少 1 个。
 */
export function sandboxCap({ maxParallel = 3, memTotalMb = null, agentMemMb = 2048 } = {}) {
  let cap = Math.min(Math.max(1, Math.floor(Number(maxParallel) || 1)), BOX_CAP);
  if (Number.isFinite(memTotalMb) && memTotalMb > 0) cap = Math.min(cap, Math.floor((memTotalMb - RESERVE_MB) / (agentMemMb + SIDECARS_MB)));
  return Math.max(1, cap);
}

/** 沙箱名额：拿到才起容器，用完还回去。等的人按先来后到。 */
export function createSlots() {
  let used = 0;
  const waiting = [];
  const next = () => { while (waiting.length && used < waiting[0].cap()) { used++; waiting.shift().resolve(); } };
  const release = () => { used = Math.max(0, used - 1); next(); };
  return {
    used: () => used,
    waiting: () => waiting.length,
    /** @param {number | (() => number)} cap @param {() => void} [onWait] 要排队时先叫一声 */
    acquire(cap, onWait) {
      const capOf = typeof cap === 'function' ? cap : () => cap;
      let done = false;
      const rel = () => { if (!done) { done = true; release(); } };
      if (!waiting.length && used < capOf()) { used++; return Promise.resolve(rel); }
      onWait?.();
      return new Promise((resolve) => waiting.push({ cap: capOf, resolve: () => resolve(rel) }));
    },
  };
}

/**
 * 每隔 everyMs 量一次 /work，超了就叫 onOver 一次并停止。返回停表函数。
 * box 没有 diskUsedMb（假容器、别的供应商）就什么都不做。
 */
export function watchDisk(box, { limitMb, everyMs = 60_000, onOver, setTimer = setInterval, clearTimer = clearInterval }) {
  if (typeof box?.diskUsedMb !== 'function') return () => {};
  let busy = false;
  let stopped = false;
  const t = setTimer(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const mb = await box.diskUsedMb();
      if (!stopped && mb !== null && mb > limitMb) { stopped = true; clearTimer(t); await onOver(mb); }
    } catch { /* 量不出来这次就算了，下次再量 */ } finally { busy = false; }
  }, everyMs);
  return () => { stopped = true; clearTimer(t); };
}

const SETUP = 'set -e; git clone -q --branch main /work/repo.bundle "$2"; cd "$2"; git checkout -q -b "$1"; git remote remove origin; git config user.name wb-sandbox; git config user.email sandbox@localhost; rm -f /work/repo.bundle';
// 054.8：外部资料放进容器里的仓库，并加本地忽略——HARVEST 的 `git add -A` 不会把它收进补丁。
const MATERIAL_DIR = 'set -e; mkdir -p "$1/.wb" "$1/.git/info"; printf \'.wb/\\n\' >> "$1/.git/info/exclude"';
const MATERIAL_PATHS = ['.wb/issue.md', '.wb/changes.patch', '.wb/review.md', '.wb/previous.patch'];
// 062：打回重做时，容器里的仓库是从 main 克隆的，上一版不在——照补丁恢复并提交一次。
// 恢复不了（补丁被截断、对不上）不算失败：补丁文件还在，提示词里说了「没有就照补丁恢复」。
// 用的是完整补丁（--binary，不截断）；先 --check，整份能套才套，不留半截。
const RESTORE = 'set -e; cd "$1"; git apply --check --index --whitespace=nowarn .wb/previous.patch; git apply --index --whitespace=nowarn .wb/previous.patch; git commit -q -m "上一版（打回前）"; git tag wb-base';
const RESTORE_FAILED = '上一版没能自动恢复到这个目录（补丁太大、对不上，或上一版的分支已被清理）。\n可读的改动在 .wb/changes.patch（可能被截断，二进制文件不在里面）。\n先尽量照它恢复，再按 .wb/review.md 的意见改；恢复不了的部分在结果里明说，不要当它不存在。\n';
// 062：补丁的起点要和宿主那边一致。打回重做时宿主的工作目录里已经有上一版（从上一版分支起，或者就是上一版的目录），
// 所以恢复成功后从恢复出来的那一版（wb-base）算起，只交这一轮新改的；不然上一版会被再加一遍，套不上去。
const HARVEST = 'set -e; cd "$2"; git add -A; git diff --cached --quiet || git commit -q -m "$1"; base=main; if git rev-parse -q --verify refs/tags/wb-base >/dev/null; then base=wb-base; fi; git diff --binary --full-index "$base"..HEAD > /work/out.patch';
export const SANDBOX_SCRIPTS = { RESTORE, HARVEST };

/**
 * @param {{provider:any, task:{id:number,title?:string}, runId?:number, project:string, branch:string, plan:any, prompt:string,
 *          timeoutMs:number, onLine:(line:string)=>void, onBox?:(box:any)=>void, gitRun:(cwd:string,...a:string[])=>string, tmpRoot?:string,
 *          diskMb?:number, diskEveryMs?:number}} o
 * @returns {Promise<{code:number, killed:boolean, patch:Buffer|string, problem:string}>}  成功时 patch 是原样字节（Buffer）；出问题时是空串
 */
export async function runInSandbox(o) {
  if (!BRANCH_RE.test(o.branch)) return { code: -1, killed: false, patch: '', problem: `分支名不对：${safeLabel(o.branch, 40)}` };
  const tmp = mkdtempSync(join(o.tmpRoot ?? tmpdir(), 'wb-sbx-'));
  let box = null;
  try {
    const bundle = join(tmp, 'repo.bundle');
    // 主仓库是用户自己的可信数据；bundle 只读它，不进容器的是宿主 worktree。
    o.gitRun(o.project, 'bundle', 'create', bundle, 'main');
    box = await o.provider.create({ taskId: o.task.id, runId: o.runId ?? 0, env: o.plan.env, egress: o.plan.egress, gateway: o.plan.gateway });
    o.onBox?.(box);
    await box.copyIn(bundle, '/work/repo.bundle');
    const setupLines = [];
    const setup = await box.exec(['sh', '-c', SETUP, 'sh', o.branch, SANDBOX_REPO], { cwd: '/work', onLine: (l) => setupLines.push(l), timeoutMs: 5 * 60_000 });
    if (setup.code !== 0) return { code: setup.code, killed: false, patch: '', problem: `沙箱里克隆代码失败：${safeLabel(setupLines.slice(-3).join(' '), 200)}` };

    // 054.8 / 062：资料文件（Issue 原文、要审的补丁、审查意见）。位置只许这三个，别的一律不放。
    const materials = [...(o.material?.text ? [o.material] : []), ...(Array.isArray(o.materials) ? o.materials : [])].filter((m) => m?.text);
    if (materials.length) {
      if (materials.some((m) => !MATERIAL_PATHS.includes(m.path))) return { code: -1, killed: false, patch: '', problem: '资料文件的位置不对' };
      const made = await box.exec(['sh', '-c', MATERIAL_DIR, 'sh', SANDBOX_REPO], { cwd: '/work', timeoutMs: 60_000 });
      if (made.code !== 0) return { code: made.code, killed: false, patch: '', problem: '沙箱里放不进资料文件' };
      for (const m of materials) await box.writeFile(`${SANDBOX_REPO}/${m.path}`, m.text);
    }
    // restored：要求恢复时，恢复成没成（不要求时为 null）。宿主据此判断补丁的起点对不对得上。
    let restored = null;
    if (o.restore) {
      // 恢复不了不算任务失败，但必须明说：留一份说明文件，提示词会叫它先读。
      restored = false;
      if (materials.some((m) => m.path === '.wb/previous.patch')) {
        const r = await box.exec(['sh', '-c', RESTORE, 'sh', SANDBOX_REPO], { cwd: '/work', timeoutMs: 5 * 60_000 }).catch(() => null);
        restored = r?.code === 0;
      }
      if (!restored) {
        const made = await box.exec(['sh', '-c', MATERIAL_DIR, 'sh', SANDBOX_REPO], { cwd: '/work', timeoutMs: 60_000 });
        if (made.code !== 0) return { code: made.code, killed: false, patch: '', problem: '沙箱里放不进资料文件' };
        await box.writeFile(`${SANDBOX_REPO}/.wb/restore-failed.txt`, RESTORE_FAILED);
      }
    }

    let full = 0;
    const limitMb = o.diskMb ?? DISK_DEFAULT_MB;
    const stopWatch = watchDisk(box, { limitMb, everyMs: o.diskEveryMs ?? 60_000, onOver: async (mb) => { full = mb; await box.kill?.(); } });
    let run;
    try {
      run = await box.exec(agentArgv(o.prompt), { cwd: SANDBOX_REPO, onLine: o.onLine, timeoutMs: o.timeoutMs });
    } finally { stopWatch(); }
    // 写满了：改动不收（可能是半截），直接停。
    if (full) return { code: run.code || 1, killed: true, patch: '', problem: `写满了：/work 用了 ${full} MB，上限 ${limitMb} MB，任务停了` };

    const msg = `T-${o.task.id} ${String(o.task.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 72)}`;
    const harvestLines = [];
    const h = await box.exec(['sh', '-c', HARVEST, 'sh', msg, SANDBOX_REPO], { cwd: '/work', onLine: (l) => harvestLines.push(l), timeoutMs: 5 * 60_000 });
    if (h.code !== 0) return { code: run.code, killed: run.timedOut, patch: '', problem: `从沙箱里取改动失败：${safeLabel(harvestLines.slice(-3).join(' '), 200)}` };
    // 066：改动已经收进 /work/out.patch 了，这时候再在容器里把测试跑一遍——测试生成的文件不会进补丁。
    // 容器本身是隔离，所以不管它有没有改测试命令；跑不起来（没装依赖、没网络）会如实记成没过，由人判断。
    let verify = null;
    if (o.verify?.cmd?.length && run.code === 0 && !run.timedOut) {
      const lines = [];
      const started = Date.now();
      try {
        const v = await box.exec(o.verify.cmd, { cwd: SANDBOX_REPO, onLine: (l) => { lines.push(l); if (lines.length > 400) lines.shift(); }, timeoutMs: o.verify.timeoutMs });
        verify = { status: v.timedOut ? 'timeout' : v.code === 0 ? 'pass' : 'fail', code: typeof v.code === 'number' ? v.code : -1, tail: lines.join('\n').slice(-1500), ms: Date.now() - started };
      } catch (err) {
        verify = { status: 'error', code: -1, tail: safeLabel(err?.message ?? err, 200), ms: Date.now() - started };
      }
    }
    const out = join(tmp, 'out');
    mkdirSync(out);
    const file = await box.copyOut('/work/out.patch', out);
    // 按字节取（Buffer）：补丁里可能有非 UTF-8 的文本（GBK 等），按字符串读一遍就成了替换字符，套回宿主就是坏文件。
    return { code: run.code, killed: run.timedOut, patch: readFileSync(file), problem: '', verify, restored };
  } catch (err) {
    return { code: -1, killed: false, patch: '', problem: `沙箱出错：${safeLabel(err?.message ?? err, 200)}` };
  } finally {
    try { await box?.destroy(); } catch { /* 孤儿扫描会收 */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 补丁 → patch-guard → 宿主 worktree。宿主上套用和提交都不跑任何钩子（core.hooksPath 指向空目录）。
 * @returns {{ok:true, empty:boolean, flags:{code:string,label:string,path:string}[], files:string[]} | {ok:false, reasons:string[], saved:string}}
 */
export function applySandboxPatch({ dir, patch, taskId, gitRun, rejectsDir, tmpRoot }) {
  // 两份：bytes 是容器里出来的原样字节，存盘、套用都只用它；text 是按 UTF-8 解出来给检查器看的。
  // 检查器只认结构行（diff --git、文件头、模式、@@），这些都是 ASCII，解码不会改变它们；
  // 非 UTF-8 的内容行在 text 里会变成替换字符，但换行不会多也不会少，所以检查到的结构和 git 套用的是同一份。
  const bytes = Buffer.isBuffer(patch) ? patch : Buffer.from(String(patch ?? ''), 'utf8');
  const text = bytes.toString('utf8');
  if (!text.trim()) return { ok: true, empty: true, flags: [], files: [] };
  const r = inspectPatch(text);
  if (!r.ok) {
    let saved = '';
    try {
      mkdirSync(rejectsDir, { recursive: true });
      saved = join(rejectsDir, `T-${Number(taskId)}-${Date.now()}.patch`);
      writeFileSync(saved, bytes);
    } catch { saved = ''; }
    return { ok: false, reasons: r.reasons, saved };
  }
  const tmp = mkdtempSync(join(tmpRoot ?? tmpdir(), 'wb-apply-'));
  try {
    const hooks = join(tmp, 'no-hooks');
    mkdirSync(hooks);
    const file = join(tmp, 'sandbox.patch');
    writeFileSync(file, bytes);
    // 046 真机复测：只套到暂存区（--cached），不碰工作区——工作区是按宿主的换行设置检出的（Windows 默认 CRLF），
    // 补丁是容器里按原样出的，直接拿工作区对补丁会「对不上」。提交后再把工作区按宿主设置重新检出。
    // 不再强行改 core.autocrlf：检出和套用用同一套宿主设置，才不会自相矛盾。
    const safe = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'commit.gpgsign=false'];
    // .gitattributes 可以选择宿主已有的过滤器。整个套用过程只用原始内容，不执行外部过滤命令。
    const filters = new Set(String(gitRun(dir, 'config', '--null', '--name-only', '--list'))
      .split('\0').map((key) => /^filter\.(.+)\.(?:clean|smudge|process|required)$/s.exec(key)?.[1]).filter(Boolean));
    for (const filter of filters) {
      if (filter.includes('=')) throw new Error('Git 过滤器名称无法安全覆盖，已停止套用补丁');
      safe.push('-c', `filter.${filter}.clean=`, '-c', `filter.${filter}.smudge=`,
        '-c', `filter.${filter}.process=`, '-c', `filter.${filter}.required=false`);
    }
    gitRun(dir, ...safe, 'apply', '--cached', '--binary', '--whitespace=nowarn', file);
    gitRun(dir, ...safe, 'commit', '-q', '--no-verify', '-m', `T-${Number(taskId)} 沙箱里的改动（${r.files.length} 个文件，已过补丁检查）`);
    // worktree 是执行器为这个任务新建的，里面没有别人的改动；按刚提交的内容重新检出。
    gitRun(dir, ...safe, 'reset', '-q', '--hard', 'HEAD');
    return { ok: true, empty: false, flags: r.flags, files: r.files.map((f) => f.path) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 给任务摘要的一句：哪些改动要人看一眼。 */
export function flagLine(flags) {
  if (!flags?.length) return '';
  const uniq = [...new Map(flags.map((f) => [`${f.code}:${f.path}`, f])).values()].slice(0, 5);
  return `⚠ 要人看：${uniq.map((f) => `${f.label}（${safeLabel(f.path, 50)}）`).join('；')}`;
}
