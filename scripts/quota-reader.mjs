#!/usr/bin/env node
// Quota reader: opens a dedicated Edge profile, reads the usage pages of tools that have no API,
// and reports the numbers to the workbench. Only ever visits the URLs in the config.
//
//   node scripts/quota-reader.mjs login <site>   open the login page, you log in by hand
//   node scripts/quota-reader.mjs run            headless pass over every site, then report
//   node scripts/quota-reader.mjs probe <site>   dump JSON endpoints (url + top-level field names)
//
// Config: ~/.ai-workbench-readers.json (see docs/readers.example.json)
// Browser profile: %LOCALAPPDATA%\ai-workbench\reader-profile — never the everyday Edge profile.
// No dependencies: system Edge + Node's built-in WebSocket (CDP).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = homedir();
const CONFIG_FILE = join(HOME, '.ai-workbench-readers.json');
const WB_CONFIG = join(HOME, '.ai-workbench.json');
const PROFILE = join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'ai-workbench', 'reader-profile');
const DEBUG_PORT = Number(process.env.READER_DEBUG_PORT ?? 9333);
const TIMEOUT_MS = 120_000;

// ---------- pure helpers (unit tested, no browser) ----------

/** Read `a.b.0.c` out of a parsed JSON body. */
export function getByPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)];
    return typeof acc === 'object' ? acc[key] : undefined;
  }, obj);
}

/** Numbers may arrive as 1 234 / "1,234.5 积分" / "12.5". */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Pick the first rule value that resolves, over the JSON bodies the page fetched itself. */
export function extractFromJson(bodies, rule) {
  if (!rule || !Array.isArray(bodies)) return null;
  const hits = bodies.filter((b) => !rule.urlIncludes || String(b.url ?? '').includes(rule.urlIncludes));
  for (let i = hits.length - 1; i >= 0; i--) {
    const balance = toNumber(getByPath(hits[i].json, rule.balancePath));
    if (balance !== null) {
      return {
        balance,
        expires_at: rule.expiresPath ? (getByPath(hits[i].json, rule.expiresPath) ?? null) : null,
        source: 'network',
      };
    }
  }
  return null;
}

/** Fallback: pull the number out of the page text with a regex. */
export function extractFromText(text, rule) {
  if (!rule || typeof text !== 'string' || !rule.regex) return null;
  let re;
  try { re = new RegExp(rule.regex); } catch { return null; }
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1] ?? m[0];
  const balance = toNumber(raw);
  return balance === null ? null : { balance, expires_at: null, source: 'text' };
}

export function extractQuota(site, bodies, text) {
  const ex = site?.extract;
  if (ex && ex.type !== 'text') {
    const hit = extractFromJson(bodies, ex);
    if (hit) return hit;
  }
  return site?.fallback ? extractFromText(text, site.fallback) : null;
}

/** The site bounced us to a login/auth page. */
export function looksLikeLogin(url, site) {
  if (!url) return false;
  if (site?.loginUrl && url.startsWith(site.loginUrl)) return true;
  return /(^|\/)(login|signin|sign-in|auth|passport)(\/|$|\?)/i.test(url);
}

/** Resolve `fn`, or give up after ms and call onTimeout. Keeps a stuck CDP call from hanging the run. */
export function withDeadline(fn, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new Error(`超时（${ms}ms）`));
    }, ms);
    Promise.resolve().then(fn).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------- reporting ----------

function endpoints() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(WB_CONFIG, 'utf8')); } catch { /* no config */ }
  const url = (process.env.WB_URL || cfg.url || '').replace(/\/+$/, '');
  const token = process.env.WB_TOKEN || cfg.token || '';
  if (!url || !token) throw new Error('缺少工作台地址或令牌：写 ~/.ai-workbench.json');
  return { url, token };
}

async function call(method, path, body, label) {
  const { url, token } = endpoints();
  const res = await withDeadline(
    () => fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    }),
    15000,
  );
  if (!res.ok) {
    // status only: response bodies can echo account data
    console.warn(`${label} 失败：HTTP ${res.status}`);
    return false;
  }
  return true;
}

async function report(site, hit) {
  return call('PUT', `/api/accounts/${encodeURIComponent(site.account)}`, {
    kind: 'credits',
    executor: site.executor ?? 'workbuddy',
    source: 'reader',
    balance: hit.balance,
    balance_unit: '积分',
    status: 'ok',
    ...(hit.expires_at ? { expires_at: String(hit.expires_at) } : {}),
    balance_detail: JSON.stringify({ reader: { site: site.name, via: hit.source, at: new Date().toISOString() } }),
  }, `上报 ${site.name}`);
}

async function mark(site, status, text) {
  const okStatus = await call('PUT', `/api/accounts/${encodeURIComponent(site.account)}`,
    { status, source: 'reader' }, `${site.name} 状态`);
  const okEvent = await call('POST', '/api/events', { kind: 'reader.failed', text: text.slice(0, 300) }, `${site.name} 审计`);
  return okStatus && okEvent;
}

// ---------- browser ----------

function edgePath() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('找不到 Edge，请确认已安装');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(url, headless) {
  mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    ...(headless ? ['--headless=new'] : []),
    url,
  ];
  return spawn(edgePath(), args, { stdio: 'ignore' });
}

async function endpointWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Edge 调试端口没起来');
}

/** Minimal CDP client over Node's built-in WebSocket. Every call is bounded. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      return withDeadline(() => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
      }), 15000, () => { try { ws.close(); } catch { /* gone */ } });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

/** Kill the whole Edge tree; the profile stays locked otherwise and every later run fails. */
export function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
      return;
    }
    proc.kill('SIGKILL');
  } catch { /* already dead */ }
}

/** Open the page, wait, and collect every JSON body the page fetched plus its text. */
async function readPage(target, site, { collectText = true } = {}) {
  const cdp = connect(target);
  await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const bodies = [];
  const requests = [];
  cdp.on((msg) => {
    if (msg.method === 'Network.responseReceived') {
      const { requestId, response } = msg.params;
      requests.push(response.url);
      if ((response.mimeType ?? '').includes('json')) {
        void cdp.send('Network.getResponseBody', { requestId }, sessionId)
          .then((r) => {
            if (!r?.body) return;
            try { bodies.push({ url: response.url, json: JSON.parse(r.body) }); } catch { /* not json */ }
          }).catch(() => {});
      }
    }
  });
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: site.usageUrl }, sessionId);
  await sleep(6000);

  let text = '';
  let finalUrl = site.usageUrl;
  if (collectText) {
    const loc = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId).catch(() => null);
    if (loc?.result?.value) finalUrl = loc.result.value;
    const body = await cdp.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""', returnByValue: true,
    }, sessionId).catch(() => null);
    text = String(body?.result?.value ?? '').slice(0, 200_000);
  }
  cdp.close();
  return { bodies, text, requests, finalUrl };
}

// ---------- commands ----------

async function cmdLogin(name) {
  const site = loadSites().find((s) => s.name === name);
  if (!site) throw new Error(`配置里没有站点 ${name}`);
  console.log(`用专用配置打开 Edge：${PROFILE}`);
  console.log('请在弹出的窗口里自己完成登录，登录完成后关闭窗口即可。');
  const proc = launch(site.loginUrl || site.usageUrl, false);
  await new Promise((r) => proc.on('exit', r));
}

async function cmdRun() {
  const sites = loadSites();
  const off = await offSourceIds();
  const active = sites.filter((s) => !off.has(`reader:${s.name}`));
  if (active.length < sites.length) console.log(`跳过 ${sites.length - active.length} 个已停用的来源`);
  const started = Date.now();
  const browser = launch('about:blank', true);
  // Hard stop: a stuck CDP step must not leave Edge holding the profile hostage.
  const watchdog = setTimeout(() => {
    console.warn(`超过 ${TIMEOUT_MS}ms，强制结束 Edge`);
    killTree(browser);
    process.exit(2);
  }, TIMEOUT_MS);
  let failed = 0;
  try {
    const ws = await endpointWs();
    for (const site of active) {
      if (Date.now() - started > TIMEOUT_MS) { console.warn('总时长超时，停止'); break; }
      try {
        const { bodies, text, finalUrl } = await readPage(ws, site);
        if (looksLikeLogin(finalUrl, site)) {
          await mark(site, 'relogin', `读取 ${site.name} 需要重新登录：运行 node scripts/quota-reader.mjs login ${site.name}`);
          console.log(`${site.name}: 需要重新登录`);
          failed++;
          continue;
        }
        const hit = extractQuota(site, bodies, text);
        if (!hit) {
          await mark(site, 'readfail', `读取 ${site.name} 失败：页面可能改版`);
          console.log(`${site.name}: 没读到数字，已记审计`);
          failed++;
          continue;
        }
        if (!(await report(site, hit))) { failed++; continue; }
        console.log(`${site.name}: ${hit.balance} 积分（${hit.source}）`);
      } catch (err) {
        failed++;
        console.warn(`${site.name}: ${err.message}`);
      }
    }
  } finally {
    clearTimeout(watchdog);
    killTree(browser);
  }
  return failed;
}

async function cmdProbe(name) {
  const site = loadSites().find((s) => s.name === name);
  if (!site) throw new Error(`配置里没有站点 ${name}`);
  const browser = launch('about:blank', true);
  try {
    const ws = await endpointWs();
    const { bodies, text, requests } = await readPage(ws, site);
    console.log('JSON 响应（只列地址和顶层字段名）：');
    for (const b of bodies) {
      const keys = b.json && typeof b.json === 'object' ? Object.keys(b.json) : [];
      console.log(`  ${b.url}  {${keys.join(', ')}}`);
    }
    if (!bodies.length) console.log('  （这次没抓到 JSON，可能是页面直出）');
    console.log(`请求总数：${requests.length}`);
    const snippet = text.split('\n').filter((l) => l.includes('积分')).slice(0, 10);
    console.log('包含「积分」的文本：');
    for (const line of snippet) console.log(`  ${line.trim().slice(0, 120)}`);
  } finally {
    killTree(browser);
  }
}

function loadSites() {
  if (!existsSync(CONFIG_FILE)) throw new Error(`缺少配置：${CONFIG_FILE}（参考 docs/readers.example.json）`);
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  return Array.isArray(cfg.sites) ? cfg.sites : [];
}

/** 010: the workbench decides which sources are switched off; a reader that cannot ask runs everything. */
async function offSourceIds() {
  try {
    const { url, token } = endpoints();
    const res = await withDeadline(() => fetch(`${url}/api/sources`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    }), 12000);
    if (!res.ok) return new Set();
    const body = await res.json();
    const off = (body.sources ?? []).filter((s) => s.state === 'off').map((s) => s.id);
    return new Set(off);
  } catch {
    return new Set();
  }
}

const [, , cmd, arg] = process.argv;
const run = async () => {
  if (cmd === 'login') return cmdLogin(arg);
  if (cmd === 'probe') return cmdProbe(arg);
  if (cmd === 'run') process.exitCode = (await cmdRun()) ? 1 : 0;
  else {
    console.log('用法：node scripts/quota-reader.mjs login <站点> | run | probe <站点>');
    process.exitCode = 1;
  }
};

// Only act when invoked as a script; importing this file (tests) must not run the CLI.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) run().catch((err) => { console.error(err.message); process.exit(1); });
