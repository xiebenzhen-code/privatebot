// 020: the install logic, kept away from the terminal so it can be tested with fake input.
// No dependencies, no side effects at import time: every function takes what it needs.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { RUNNER_CMD } from './commands.mjs';

export const EXIT = { ok: 0, missing: 1, env: 2, verify: 3, other: 4 };

export const BACKENDS = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-chat',
    envKey: 'WB_SETUP_KEY_DEEPSEEK',
  },
  bailian: {
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    model: 'deepseek-v4.1-flash',
    envKey: 'WB_SETUP_KEY_BAILIAN',
  },
  custom: { label: '自定义', baseUrl: '', model: '', envKey: 'WB_SETUP_KEY_CUSTOM' },
};

/** Anything that looks like a secret, cut down to its first 4 characters. */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(Bearer)\s+[^\s,;"']{6,}/gi, '$1 ***')
    .replace(/\b(sk-[A-Za-z0-9._-]{4})[A-Za-z0-9._-]{4,}/g, '$1…')
    .replace(/((?:token|key|secret|password)["']?\s*[:=]\s*["']?)([^\s,;"'}]{4})[^\s,;"'}]*/gi, '$1$2…');
}

/** Print-safe form of a secret: first 4 characters and an ellipsis. Never the whole thing. */
export const mask = (v) => (String(v ?? '').length > 4 ? `${String(v).slice(0, 4)}…` : '…');

// ---------- arguments ----------

const FLAGS = new Set(['--yes', '--json', '--dry-run', '--help', '--lan']);
const VALUED = new Set([
  '--project', '--worktree-root', '--projects-root', '--backend', '--base-url', '--model', '--tz',
  '--backup-dir', '--start', '--key-file', '--workbench', '--name',
]);

/**
 * Parse argv. `--key` is deliberately not accepted: keys would land in shell history and in the
 * process list. They come from the environment or from a file, and the caller says so.
 */
export function parseArgs(argv = []) {
  const opts = { project: [], yes: false, json: false, dryRun: false, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (FLAGS.has(a)) {
      if (a === '--yes') opts.yes = true;
      if (a === '--json') opts.json = true;
      if (a === '--dry-run') opts.dryRun = true;
      if (a === '--help') opts.help = true;
      // 024: 让同一局域网里的手机能访问（默认只绑本机）。
      if (a === '--lan') opts.lan = true;
      continue;
    }
    if (/^--key(=|$)/.test(a) && !a.startsWith('--key-file')) {
      errors.push('key 不能用命令行参数传（会进 shell 历史和进程列表）。改成环境变量 WB_SETUP_KEY_DEEPSEEK / WB_SETUP_KEY_BAILIAN，或用 --key-file <路径>。');
      continue;
    }
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (!VALUED.has(flag)) { errors.push(`不认识的参数：${a}`); continue; }
    const value = inline ?? String(argv[++i] ?? '');
    if (!value) { errors.push(`${flag} 后面要跟一个值`); continue; }
    if (flag === '--project') {
      const eq = value.indexOf('=');
      const name = eq > 0 ? value.slice(0, eq) : '';
      const path = eq > 0 ? value.slice(eq + 1) : value;
      if (!name) errors.push('--project 要写成 名字=路径，例如 --project my-app=C:/code/my-app');
      else opts.project.push({ name, path });
      continue;
    }
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[key] = value;
  }
  if (opts.backend && !BACKENDS[opts.backend]) errors.push(`--backend 只能是 deepseek / bailian / custom，收到 ${opts.backend}`);
  if (opts.start && !['docker', 'node', 'none'].includes(opts.start)) errors.push('--start 只能是 docker / node / none');
  return { opts, errors };
}

// ---------- .env ----------

/** Tiny .env reader: `KEY=value`, `#` comments, optional quotes. No expansion, by design. */
export function envValues(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Replace values in place (keeping comments and order); append the ones that are missing. */
export function upsertEnv(text, pairs) {
  const lines = String(text ?? '').split(/\r?\n/);
  const left = { ...pairs };
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const [, indent, key, eq] = m;
    if (!(key in left)) return line;
    const value = left[key];
    delete left[key];
    return `${indent}${key}${eq}${value}`;
  });
  for (const [k, v] of Object.entries(left)) out.push(`${k}=${v}`);
  return out.join('\n').replace(/\n{3,}$/, '\n');
}

/**
 * Fill in only what is missing. Existing values are never touched and never printed — a token
 * the user already has is a token they already know.
 */
export function ensureEnvText(text, { tz, backupDir, token, password, lan = false, created = false } = {}) {
  const have = envValues(text);
  const pair = {};
  const generated = { token: false, password: false };
  if (!have.WB_TOKEN && token) { pair.WB_TOKEN = token; generated.token = true; }
  if (!have.WB_PASSWORD && password) { pair.WB_PASSWORD = password; generated.password = true; }
  if (!have.WB_TZ && tz) pair.WB_TZ = tz;
  if (backupDir && have.WB_BACKUP_DIR !== backupDir) pair.WB_BACKUP_DIR = backupDir;
  // 024: 只有在用户明确要局域网访问、且没自己设过时才写；已设的值一律不动。
  if (lan && !have.WB_BIND) pair.WB_BIND = '0.0.0.0';
  return { text: Object.keys(pair).length ? upsertEnv(text, pair) : String(text ?? ''), generated, created };
}

// ---------- projects ----------

/** A project is usable when it exists and is the top of a git work tree. */
export function checkProject(dir, io) {
  const { exists, readdir, readFile } = io;
  const problems = [];
  if (!dir) return { ok: false, problems: ['没有路径'] };
  if (!exists(dir)) return { ok: false, problems: ['这个路径不存在'] };
  if (!exists(`${dir}/.git`) && !exists(`${dir}\\.git`)) problems.push('不是一个 git 仓库（没有 .git）');
  // The runner refuses worktrees inside a repo that ships Claude settings — say it now, not later.
  let settings = [];
  try { settings = readdir(dir).filter((f) => /^\.claude$/.test(f)); } catch { settings = []; }
  if (settings.length) {
    const inner = (() => { try { return readdir(`${dir}/.claude`); } catch { return []; } })();
    const files = inner.filter((f) => /^settings.*\.json$/.test(f));
    if (files.length) problems.push(`项目里有 .claude/${files[0]}，执行器会拒绝它（怕它替 agent 改权限）`);
  }
  void readFile;
  return { ok: problems.length === 0, problems };
}

// ---------- backend probe ----------

/** One message with max_tokens 1: enough to prove the key works, cheap enough to forget. */
export async function probeBackend({ baseUrl, model, key, fetchImpl = fetch, timeoutMs = 20000, extraHeaders } = {}) {
  if (!baseUrl) return { ok: false, code: 'nobase', message: '没有填接口地址' };
  if (!key) return { ok: false, code: 'nokey', message: '没有拿到 key' };
  if (!model) return { ok: false, code: 'nomodel', message: '没有填模型名' };
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${key}`,
        'x-api-key': key,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctl.signal,
    });
    const raw = await res.text().catch(() => '');
    if (res.status === 200) return { ok: true, code: 'ok', status: 200, message: '可用' };
    const detail = redact(raw).slice(0, 200);
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth', status: res.status, message: 'key 不对，或者这个账号没开通这个模型' };
    if (res.status === 404) return { ok: false, code: 'notfound', status: 404, message: `地址或模型名不对（${detail || '404'}）` };
    if (res.status === 429) return { ok: false, code: 'quota', status: 429, message: '被限流或额度用完了，等一会儿再试' };
    return { ok: false, code: 'http', status: res.status, message: `接口返回 ${res.status}：${detail}` };
  } catch (err) {
    const message = err?.name === 'AbortError' ? '连不上（超时 20 秒）' : `连不上：${redact(err?.message ?? err)}`;
    return { ok: false, code: 'network', message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- runner config ----------

/** Merge into an existing config without dropping a single field the user typed by hand. */
/**
 * 030 A.3：新建项目的根目录（`projectsRoot`）。一问一答里回车就用它，用户目录下的 `ai-projects`。
 */
export const defaultProjectsRoot = (home = homedir()) => join(home, 'ai-projects');

/**
 * 把一问一答里的回答变成一个绝对路径：空回答用默认值，`~` 展开，相对路径按用户目录算，
 * 末尾斜杠去掉（`D:/` 这种盘符根留着）。不检查目录在不在——建项目时执行器会自己建。
 */
export function resolveProjectsRoot(answer, home = homedir()) {
  const raw = String(answer ?? '').trim();
  if (!raw) return defaultProjectsRoot(home);
  const expanded = raw === '~' ? home : /^~[\\/]/.test(raw) ? join(home, raw.slice(2)) : raw;
  const abs = isAbsolute(expanded) ? expanded : resolve(home, expanded);
  const root = parse(abs).root;
  return abs.length > root.length ? abs.replace(/[\\/]+$/, '') : abs;
}

export function mergeRunnerConfig(existing, input) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const projects = { ...(base.projects ?? {}) };
  for (const p of input.projects ?? []) projects[p.name] = p.path;
  const executors = { ...(base.executors ?? {}) };
  const pool = { ...(executors.pool ?? { tool: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose'] }) };
  if (input.backends?.length) pool.backends = input.backends;
  if (Object.keys(pool).length) executors.pool = pool;
  return {
    ...base,
    workbench: base.workbench ?? input.workbench ?? 'http://localhost:3200',
    token: base.token ?? input.token ?? '',
    projects,
    worktreeRoot: base.worktreeRoot ?? input.worktreeRoot ?? '',
    // 030: 新建项目只能建在这个文件夹的直接子目录下。老配置里没有就留空——功能不可用，
    // 而不是猜一个路径。空字符串等于没配，所以这里用 `||`：页面上那条
    // `npm run setup --projects-root …` 得真能把空值补上；已经配过的不动。
    projectsRoot: base.projectsRoot || input.projectsRoot || '',
    executors,
    runnerId: base.runnerId,
  };
}

/** A stable runner id per machine+config, so restarts show up as one runner, not five. */
export const runnerIdFor = (seed) => `runner-${createHash('sha256').update(String(seed)).digest('hex').slice(0, 6)}`;

// ---------- the unattended run ----------

/**
 * Everything `--yes` does, with the terminal and the filesystem passed in. Returns the events an
 * agent parses and the exit code it acts on.
 */
export async function runUnattended(opts, io) {
  const events = [];
  const emit = (step, status, detail) => events.push({ step, status, ...(detail ? { detail } : {}) });
  const { readFile, writeFile, exists, mkdirp, homedir, env } = io;

  if (!opts.project?.length) {
    emit('project', 'missing', '没有项目。加 --project 名字=路径（可重复）；只是先看看就加 --dry-run。');
    return { events, code: EXIT.missing, summary: { done: true, ok: false, code: EXIT.missing } };
  }
  for (const p of opts.project) {
    const check = checkProject(p.path, io);
    emit('project', check.ok ? 'ok' : 'bad', check.ok ? `${p.name} 可用` : `${p.name}：${check.problems.join('；')}`);
    if (!check.ok) return { events, code: EXIT.verify, summary: { done: true, ok: false, code: EXIT.verify } };
  }

  const backend = opts.backend ?? 'deepseek';
  const spec = BACKENDS[backend];
  const baseUrl = opts.baseUrl || spec.baseUrl;
  const model = opts.model || spec.model;
  const key = opts.keyFile ? String(readFile(opts.keyFile, 'utf8') ?? '').split(/\r?\n/)[0].trim() : (env[spec.envKey] ?? '');
  if (!key) {
    emit('backend', 'missing', `没有 key：设 ${spec.envKey}，或用 --key-file <路径>（文件第一行）。`);
    return { events, code: EXIT.missing, summary: { done: true, ok: false, code: EXIT.missing } };
  }
  const probe = await probeBackend({ baseUrl, model, key, fetchImpl: io.fetchImpl ?? fetch });
  emit('backend', probe.ok ? 'ok' : 'bad', `${spec.label} ${model}：${probe.message}`);
  if (!probe.ok) return { events, code: EXIT.verify, summary: { done: true, ok: false, code: EXIT.verify } };

  // ---- files ----
  if (io.gitignorePath && exists(io.gitignorePath)) {
    const ignore = String(readFile(io.gitignorePath, 'utf8'));
    if (!/^\s*\.env\s*$/m.test(ignore)) {
      emit('env', 'blocked', '.gitignore 里没有 .env，先加一行再跑（不然密码和令牌会被提交）。');
      return { events, code: EXIT.env, summary: { done: true, ok: false, code: EXIT.env } };
    }
  }
  const envPath = io.envPath;
  const envText = exists(envPath) ? String(readFile(envPath, 'utf8')) : '';
  const next = ensureEnvText(envText, {
    tz: opts.tz || 'Asia/Shanghai',
    backupDir: opts.backupDir,
    token: io.generateToken(),
    password: io.generatePassword(),
    lan: opts.lan === true,
  });
  if (opts.dryRun) {
    emit('env', 'dry-run', `会写 ${envPath}（WB_TOKEN${next.generated.token ? ' 会生成' : ' 已有'}、WB_PASSWORD${next.generated.password ? ' 会生成' : ' 已有'}）`);
  } else {
    mkdirp(io.dirname(envPath));
    writeFile(envPath, next.text);
    emit('env', 'ok', `WB_TOKEN ${next.generated.token ? '已生成' : '已有'}，WB_PASSWORD ${next.generated.password ? '已生成' : '已有'}`);
    // The one and only time a generated password leaves this script — see AGENT-INSTALL.md.
    if (next.generated.password) {
      events.push({ step: 'password', status: 'generated', once: true, value: envValues(next.text).WB_PASSWORD });
    }
  }
  const envNow = envValues(next.text);
  // 024: 说清这次的访问范围，别让人以为自己默认就能用手机打开。
  emit('net', 'ok', envNow.WB_BIND === '0.0.0.0'
    ? '同一局域网里的手机能访问（WB_BIND=0.0.0.0）。别在路由器上做端口转发，出门用 Tailscale。'
    : '只有这台电脑能访问（默认）。要让同一 Wi-Fi 下的手机也能开，加 --lan 或自己设 WB_BIND=0.0.0.0。');

  const cfgPath = io.configPath;
  const existing = exists(cfgPath) ? JSON.parse(String(readFile(cfgPath, 'utf8'))) : null;
  const worktreeRoot = opts.worktreeRoot || `${io.dirname(opts.project[0].path)}/wb-worktrees`;
  const merged = mergeRunnerConfig(existing, {
    projects: opts.project,
    worktreeRoot,
    // 030: 给「新建项目」一个根目录；不给就留空，网页上那个功能显示成「先配一个根目录」。
    projectsRoot: opts.projectsRoot ?? '',
    workbench: opts.workbench || `http://localhost:${io.port ?? 3200}`,
    token: envNow.WB_TOKEN ?? '',
    backends: [{
      name: backend,
      model,
      ...(backend === 'bailian' ? { account: '百炼' } : {}),
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model },
    }],
  });
  if (opts.dryRun) {
    emit('config', 'dry-run', `会写 ${cfgPath}（项目 ${opts.project.map((p) => p.name).join('、')}，后端 ${backend}）`);
  } else {
    mkdirp(io.dirname(cfgPath));
    if (existing) writeFile(`${cfgPath}.bak`, String(readFile(cfgPath, 'utf8')));
    writeFile(cfgPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    emit('config', 'ok', `项目 ${opts.project.map((p) => p.name).join('、')}；后端 ${backend}`);
  }

  // --start only writes the config; it never launches anything itself, so say what to run next
  // instead of implying something already started.
  const howToStart = opts.start === 'docker' ? 'docker compose up -d --build' : 'npm start';
  emit('start', 'skipped', opts.start && opts.start !== 'none'
    ? `没替你启动（${opts.start} 只写在配置里）。下一步自己跑：${howToStart}`
    : `没替你启动。下一步自己跑：${howToStart}`);
  return {
    events,
    code: EXIT.ok,
    summary: {
      done: true,
      ok: true,
      next: [
        '启动工作台：docker compose up -d（没有 Docker 就 npm start）',
        `启动执行器：${RUNNER_CMD}（窗口别关）`,
        '打开 http://localhost:3200 用 WB_PASSWORD 登录',
        '看清单：curl -H "Authorization: Bearer $WB_TOKEN" http://localhost:3200/api/setup/status',
      ],
      home: homedir,
    },
  };
}
