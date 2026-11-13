// End-to-end tests: real HTTP server, in-memory SQLite, real hook/sync scripts as child processes.
//   npm test
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCookie } from './helpers.ts';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-token-0123456789abcdef';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const ROOT = join(import.meta.dirname, '..');
let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});
after(() => server.close());

async function api(path: string, opts: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  // Default to a browser session: some endpoints are human-only (008.2). Pass a token to test tokens.
  if (opts.token === undefined) { if (cookie) headers.Cookie = cookie; }
  else if (opts.token !== null) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

function run(script: string, input: string, env: Record<string, string>, timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere: point both at the temp dir.
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '', ...env };
    if (childEnv.HOME) childEnv.USERPROFILE = childEnv.HOME;
    const p = spawn(process.execPath, [join(ROOT, 'scripts', script)], { env: childEnv });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { p.kill(); reject(new Error(`${script} timed out`)); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    p.stdin.end(input);
  });
}

/** Same script, but the child records its own peak RSS on exit (maxRSS works on Windows and Linux). */
function runMeasured(script: string, env: Record<string, string>, memFile: string): Promise<{ code: number | null; stdout: string; stderr: string; maxRssKb: number }> {
  const wrapper = [
    "import { writeFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "process.on('exit', () => { try { writeFileSync(process.env.WB_MEM_OUT, String(process.resourceUsage().maxRSS)); } catch {} });",
    "await import(pathToFileURL(process.env.WB_MEM_SCRIPT).href);",
  ].join('\n');
  return new Promise((resolve, reject) => {
    const childEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...env,
      WB_MEM_OUT: memFile,
      WB_MEM_SCRIPT: join(ROOT, 'scripts', script),
    };
    if (childEnv.HOME) childEnv.USERPROFILE = childEnv.HOME;
    const p = spawn(process.execPath, ['--input-type=module', '-e', wrapper], { env: childEnv, cwd: ROOT });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { p.kill(); reject(new Error(`${script} timed out`)); }, 120000);
    p.on('close', (code) => {
      clearTimeout(t);
      let maxRssKb = 0;
      try { maxRssKb = Number(readFileSync(memFile, 'utf8')); } catch { /* wrapper failed to report */ }
      resolve({ code, stdout, stderr, maxRssKb });
    });
    p.stdin.end('');
  });
}

describe('auth', () => {
  test('health is public, API needs a token, pages redirect to login', async () => {
    assert.equal((await api('/api/health', { token: null })).status, 200);
    assert.equal((await api('/api/tasks', { token: null })).status, 401);
    assert.equal((await api('/api/tasks', { token: 'wrong-token-xxxxxxxx' })).status, 401);
    const page = await api('/', { token: null });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
  });

  test('login sets a cookie that opens pages; cross-site writes are refused', async () => {
    const bad = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
    assert.equal(bad.status, 401);
    const ok = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: process.env.WB_PASSWORD! }), redirect: 'manual' });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    assert.match(cookie, /^wb_session=/);
    for (const p of ['/', '/tasks', '/tasks/review', '/data', '/settings']) {
      assert.equal((await api(p, { token: null, headers: { Cookie: cookie } })).status, 200, p);
    }
    // 016: the old inbox address still lands on the inbox, via a redirect.
    const moved = await api('/tasks?view=review', { token: null, headers: { Cookie: cookie } });
    assert.equal(moved.status, 303);
    assert.equal(moved.headers.get('location'), '/tasks/review');
    const cross = await api('/api/tasks', { method: 'POST', token: null, body: { title: 'x' }, headers: { Cookie: cookie, Origin: 'http://evil.example' } });
    assert.equal(cross.status, 403);
    const same = await api('/api/tasks', { method: 'POST', token: null, body: { title: 'from browser' }, headers: { Cookie: cookie, Origin: base } });
    assert.equal(same.status, 201);
    assert.equal(same.json.executor, 'me');
  });
});

let session = '';
async function cookieForPages(): Promise<string> {
  if (session) return session;
  const res = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: process.env.WB_PASSWORD! }), redirect: 'manual' });
  session = res.headers.get('set-cookie')!.split(';')[0];
  return session;
}

describe('sidebar + installable app', () => {
  test('061.1: no sidebar to collapse; the wb_side cookie is harmless', async () => {
    const cookie = await cookieForPages();
    // 061.1（用户 11-10 定的设计稿）：没有侧栏了，收起侧栏的 cookie 留在旧浏览器里也不出错。
    const shut = await api('/', { token: null, headers: { Cookie: `${cookie}; wb_side=collapsed` } });
    assert.equal(shut.status, 200);
    assert.ok(!shut.text.includes('id="wb-side"'));
    assert.ok(!shut.text.includes('side-collapsed'));
  });

  test('061: the gear names settings for screen readers', async () => {
    const page = await api('/', { token: null, headers: { Cookie: await cookieForPages() } });
    assert.match(page.text, /class="gear" href="\/settings" aria-label="设置/);
  });

  test('manifest, service worker and icons are public', async () => {
    const m = await api('/manifest.webmanifest', { token: null });
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type')!, /^application\/manifest\+json/);
    const manifest = JSON.parse(m.text);
    assert.equal(manifest.name, '我的工作台');
    assert.equal(manifest.short_name, '工作台');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.background_color, '#F4F4F0');
    assert.equal(manifest.theme_color, '#1E5B4A');
    assert.equal(manifest.icons.length, 3);
    assert.ok(manifest.icons.some((i: any) => i.sizes === '192x192' && i.type === 'image/png'));
    assert.ok(manifest.icons.some((i: any) => i.sizes === '512x512' && !i.purpose));
    assert.ok(manifest.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'maskable'));

    const sw = await api('/sw.js', { token: null });
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type')!, /^text\/javascript/);
    assert.match(sw.text, /addEventListener\('fetch'/);

    const icon = await fetch(base + '/static/icon-192.png');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');

    const offline = await fetch(base + '/static/offline.html');
    assert.equal(offline.status, 200);
    assert.match(await offline.text(), /Docker Desktop/);

    assert.equal((await api('/', { token: null })).status, 302, 'pages still need a login');
  });
});

describe('tasks', () => {
  test('create, move through statuses, validate input', async () => {
    const c = await api('/api/tasks', { method: 'POST', body: { title: '写测试', executor: 'claude', project: 'wb' } });
    assert.equal(c.status, 201);
    assert.equal(c.json.status, 'queued', 'agent tasks start queued');
    const id = c.json.id;
    const r = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'running', progress: 30 } });
    assert.ok(r.json.started_at);
    const d = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'done' } });
    assert.ok(d.json.completed_at);
    assert.equal(d.json.progress, 100);
    assert.equal((await api('/api/tasks', { method: 'POST', body: { title: '' } })).status, 400);
    assert.equal((await api('/api/tasks', { method: 'POST', body: { title: 'x', executor: 'robot' } })).status, 400);
    assert.equal((await api('/api/tasks', { method: 'POST', body: { title: 'x', session_url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await api('/api/tasks/99999')).status, 404);
  });

  test('user text is escaped in pages', async () => {
    const c = await api('/api/tasks', { method: 'POST', body: { title: '<script>alert(1)</script>' } });
    const page = await api(`/tasks?task=${c.json.id}`);
    assert.ok(!page.text.includes('<script>alert(1)</script>'));
    assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

describe('approvals via Claude Code hook events', () => {
  const sid = 'sess-approval-1';

  test('prompt creates a tracked task; safe tool calls pass through', async () => {
    const r = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: '/home/me/demo-feed', prompt: '给 RSS 抓取加去重' } });
    assert.deepEqual(r.json, { action: 'none' });
    const tasks = (await api('/api/tasks?executor=claude')).json;
    const t = tasks.find((x: any) => x.session_id === sid);
    assert.equal(t.project, 'demo-feed');
    assert.equal(t.status, 'running');
    const safe = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls -la' } } });
    assert.deepEqual(safe.json, { action: 'none' });
  });

  test('risky call waits; changes needs feedback; decisions are final', async () => {
    const r = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'PreToolUse', session_id: sid, cwd: '/home/me/demo-feed', tool_name: 'Bash', tool_input: { command: 'git push origin main' } } });
    assert.equal(r.json.action, 'wait');
    assert.equal(r.json.risk, 'medium');
    const id = r.json.approval_id;
    const a = (await api(`/api/approvals/${id}`)).json;
    assert.equal(a.status, 'pending');
    assert.equal((await api(`/api/tasks/${a.task_id}`)).json.status, 'review');

    assert.equal((await api(`/api/approvals/${id}/decide`, { method: 'POST', body: { decision: 'changes' } })).status, 400);
    const d = await api(`/api/approvals/${id}/decide`, { method: 'POST', body: { decision: 'changes', feedback: '先跑测试' } });
    assert.equal(d.json.status, 'changes');
    assert.equal((await api(`/api/tasks/${a.task_id}`)).json.status, 'running');
    assert.equal((await api(`/api/approvals/${id}/decide`, { method: 'POST', body: { decision: 'approved' } })).status, 409);
  });

  test('takeover hands the task to me', async () => {
    const r = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'PreToolUse', session_id: 'sess-take', tool_name: 'Bash', tool_input: { command: 'rm -rf build/' } } });
    assert.equal(r.json.risk, 'high');
    await api(`/api/approvals/${r.json.approval_id}/decide`, { method: 'POST', body: { decision: 'takeover' } });
    const a = (await api(`/api/approvals/${r.json.approval_id}`)).json;
    const t = (await api(`/api/tasks/${a.task_id}`)).json;
    assert.equal(t.executor, 'me');
    assert.equal(t.status, 'inbox');
    assert.ok(t.events.some((e: any) => e.kind === 'approval.takeover'));
  });

  test('rules: highest risk wins, file rules match paths, disabled rules are ignored', async () => {
    const both = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'PreToolUse', session_id: 'sess-r', tool_name: 'Bash', tool_input: { command: 'git push && rm -rf dist' } } });
    assert.equal(both.json.risk, 'high');
    const env = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'PreToolUse', session_id: 'sess-r', tool_name: 'Edit', tool_input: { file_path: '/app/.env.local', old_string: 'a', new_string: 'b' } } });
    assert.equal(env.json.action, 'wait');
    const rules = (await api('/api/rules')).json;
    const push = rules.find((r: any) => r.name === '推送或合并代码');
    await api(`/api/rules/${push.id}`, { method: 'PATCH', body: { enabled: 0 } });
    const off = await api('/api/hooks/claude', { method: 'POST', body: { hook_event_name: 'PreToolUse', session_id: 'sess-r', tool_name: 'Bash', tool_input: { command: 'git push' } } });
    assert.deepEqual(off.json, { action: 'none' });
    await api(`/api/rules/${push.id}`, { method: 'PATCH', body: { enabled: 1 } });
    assert.equal((await api('/api/rules', { method: 'POST', body: { name: 'bad', tool_pattern: 'Bash', input_pattern: '(' } })).status, 400);
  });

  test('generic approvals from any script create a task', async () => {
    const r = await api('/api/approvals', { method: 'POST', body: { title: '发周报邮件', executor: 'pool', risk: 'low' } });
    assert.equal(r.status, 201);
    const t = (await api(`/api/tasks/${r.json.task_id}`)).json;
    assert.equal(t.executor, 'pool');
    assert.equal(t.status, 'review');
  });
});

describe('claude-hook.mjs (real script)', () => {
  const env = () => ({ WB_URL: base, WB_TOKEN: TOKEN, HOME: mkdtempSync(join(tmpdir(), 'wbh-')) });

  test('approve in the workbench → hook prints allow', async () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-hook-1', cwd: '/x/proj', tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    const running = run('claude-hook.mjs', payload, env());
    let pending: any;
    for (let i = 0; i < 50 && !pending; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pending = (await api('/api/approvals?status=pending')).json.find((a: any) => a.session_id === 'sess-hook-1');
    }
    assert.ok(pending, 'approval appeared');
    await api(`/api/approvals/${pending.id}/decide`, { method: 'POST', body: { decision: 'approved' } });
    const out = await running;
    assert.equal(out.code, 0);
    const j = JSON.parse(out.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(j.hookSpecificOutput.permissionDecision, 'allow');
  });

  test('reject with a note → deny carrying the note', async () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-hook-2', tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } });
    const running = run('claude-hook.mjs', payload, env());
    let pending: any;
    for (let i = 0; i < 50 && !pending; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pending = (await api('/api/approvals?status=pending')).json.find((a: any) => a.session_id === 'sess-hook-2');
    }
    await api(`/api/approvals/${pending.id}/decide`, { method: 'POST', body: { decision: 'rejected', feedback: '别删依赖' } });
    const j = JSON.parse((await running).stdout);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /别删依赖/);
  });

  test('no decision in time → ask, and the approval is closed', async () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-hook-3', tool_name: 'Bash', tool_input: { command: 'sudo apt install jq' } });
    const out = await run('claude-hook.mjs', payload, { ...env(), WB_WAIT_SECONDS: '1' });
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'ask');
    const a = (await api('/api/approvals')).json.find((x: any) => x.session_id === 'sess-hook-3');
    assert.equal(a.status, 'expired');
  });

  test('safe calls and an unreachable workbench both exit silently', async () => {
    const safe = await run('claude-hook.mjs', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's4', tool_name: 'Read', tool_input: { file_path: '/a' } }), env());
    assert.equal(safe.code, 0); assert.equal(safe.stdout, '');
    const down = await run('claude-hook.mjs', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's5', tool_name: 'Bash', tool_input: { command: 'git push' } }), { ...env(), WB_URL: 'http://127.0.0.1:9' });
    assert.equal(down.code, 0); assert.equal(down.stdout, '');
    const unconfigured = await run('claude-hook.mjs', '{}', { HOME: mkdtempSync(join(tmpdir(), 'wbh-')) });
    assert.equal(unconfigured.code, 0); assert.equal(unconfigured.stdout, '');
  });
});

describe('usage', () => {
  test('ingest dedupes by source_key', async () => {
    const recs = [{ source_key: 'k1', ts: new Date().toISOString(), executor: 'claude', input_tokens: 100, output_tokens: 50 }];
    assert.deepEqual((await api('/api/usage', { method: 'POST', body: { records: recs } })).json, { received: 1, inserted: 1 });
    assert.deepEqual((await api('/api/usage', { method: 'POST', body: { records: recs } })).json, { received: 1, inserted: 0 });
  });

  test('批量上报可以直接发数组，不用包成 records', async () => {
    const recs = [{ source_key: 'k-array', ts: new Date().toISOString(), executor: 'pool', input_tokens: 10, output_tokens: 5 }];
    assert.deepEqual((await api('/api/usage', { method: 'POST', body: recs })).json, { received: 1, inserted: 1 });
    // 老形状仍然收：执行器某些版本发的是 { records: [...] }
    assert.deepEqual((await api('/api/usage', { method: 'POST', body: { records: recs } })).json, { received: 1, inserted: 0 });
  });

  test('sync-usage.mjs reads Claude Code and Codex logs incrementally', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wbs-'));
    mkdirSync(join(home, '.claude', 'projects', '-x-proj'), { recursive: true });
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', timestamp: now, message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: now, cwd: '/x/proj', message: { id: 'msg_A', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 } } },
      { type: 'assistant', timestamp: now, cwd: '/x/proj', message: { id: 'msg_A', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 } } },
      { type: 'assistant', timestamp: now, cwd: '/x/proj', message: { id: 'msg_B', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 7 } } },
    ];
    writeFileSync(join(home, '.claude', 'projects', '-x-proj', 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    mkdirSync(join(home, '.codex', 'sessions', '2026', '10', '27'), { recursive: true });
    const codex = [
      { timestamp: now, type: 'session_meta', payload: { cwd: '/y/other' } },
      { timestamp: now, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 40 } } } },
    ];
    writeFileSync(join(home, '.codex', 'sessions', '2026', '10', '27', 'rollout-1.jsonl'), codex.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const e = { WB_URL: base, WB_TOKEN: TOKEN, HOME: home };
    const first = await run('sync-usage.mjs', '', e);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /新增 3 条/);
    const second = await run('sync-usage.mjs', '', e);
    assert.match(second.stdout, /扫描 0 个/);
    const stats = (await api('/api/stats?days=7')).json;
    assert.ok(stats.tokens >= 10 + 20 + 5 + 7 + 200 + 40);
    assert.ok(stats.projects.some((p: any) => p.project === 'proj'));
  });
});

describe('usage sync: streaming, resume, legacy state', () => {
  const stamp = '2026-10-28T10:00:00.000Z';
  const claudeLine = (id: string, input = 10, output = 20) => JSON.stringify({
    type: 'assistant', timestamp: stamp, cwd: '/x/big',
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output } },
  });
  const tempHome = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

  test('resumes from the last complete line', async () => {
    const h = tempHome('wbr-');
    const dir = join(h, '.claude', 'projects', '-x-resume');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 's.jsonl');
    writeFileSync(file, `${claudeLine('rs-1')}\n${claudeLine('rs-2')}\n`);
    const env = { WB_URL: base, WB_TOKEN: TOKEN, HOME: h };

    const first = await run('sync-usage.mjs', '', env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /新增 2 条/);

    // one finished line plus a line that is still being written (no trailing newline)
    appendFileSync(file, `${claudeLine('rs-3')}\n${claudeLine('rs-4')}`);
    const second = await run('sync-usage.mjs', '', env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /新增 1 条/, 'the unfinished line is left for next time');

    const partial = JSON.parse(readFileSync(join(h, '.ai-workbench-usage-state.json'), 'utf8'));
    assert.ok(partial[file].offset < statSync(file).size, 'bookmark stops before the partial line');
    assert.equal(partial[file].lines, undefined, 'state stores byte offsets, not line counts');

    appendFileSync(file, '\n');
    const third = await run('sync-usage.mjs', '', env);
    assert.equal(third.code, 0, third.stderr);
    assert.match(third.stdout, /新增 1 条/);
    const done = JSON.parse(readFileSync(join(h, '.ai-workbench-usage-state.json'), 'utf8'));
    assert.equal(done[file].offset, statSync(file).size);
  });

  test('a 30MB log is streamed, with correct counts and bounded memory', async () => {
    const h = tempHome('wbm-');
    const dir = join(h, '.claude', 'projects', '-x-big');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'big.jsonl');
    const filler = `${JSON.stringify({ type: 'user', timestamp: stamp, message: { role: 'user', content: 'x'.repeat(300) } })}\n`;
    const target = 30 * 1024 * 1024;
    const fd = openSync(file, 'w');
    let written = 0, lines = 0, usage = 0, buf = '';
    while (written < target) {
      buf += filler; written += Buffer.byteLength(filler); lines++;
      if (lines % 4000 === 0) {
        const u = `${claudeLine(`big-${lines}`)}\n`;
        buf += u; written += Buffer.byteLength(u); usage++;
      }
      if (buf.length > (1 << 20)) { writeSync(fd, buf); buf = ''; }
    }
    writeSync(fd, buf);
    closeSync(fd);
    assert.ok(statSync(file).size > 29 * 1024 * 1024, 'log is about 30MB');

    const memFile = join(h, 'rss.txt');
    const out = await runMeasured('sync-usage.mjs', { WB_URL: base, WB_TOKEN: TOKEN, HOME: h }, memFile);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`新增 ${usage} 条`));
    assert.ok(out.maxRssKb > 0, 'peak RSS was reported');
    assert.ok(out.maxRssKb < 200 * 1024, `peak RSS ${Math.round(out.maxRssKb / 1024)}MB should stay under 200MB`);
  });

  test('an old {size, lines} state is re-read without duplicating', async () => {
    const h = tempHome('wbl-');
    const dir = join(h, '.claude', 'projects', '-x-legacy');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 's.jsonl');
    writeFileSync(file, `${claudeLine('lg-1')}\n${claudeLine('lg-2')}\n`);
    const env = { WB_URL: base, WB_TOKEN: TOKEN, HOME: h };
    assert.match((await run('sync-usage.mjs', '', env)).stdout, /新增 2 条/);

    const stateFile = join(h, '.ai-workbench-usage-state.json');
    writeFileSync(stateFile, JSON.stringify({ [file]: { size: statSync(file).size, lines: 2 } }));
    const again = await run('sync-usage.mjs', '', env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /上报 2 条/, 'old records are read again');
    assert.match(again.stdout, /新增 0 条/, 'the server dedupes them');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(st[file].offset, statSync(file).size);
  });
  test('a skipped over-long line still moves the bookmark to the end', async () => {
    const h = tempHome('wbs-');
    const dir = join(h, '.codex', 'sessions', '2026', '10', '28');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-huge.jsonl');
    const meta = JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { cwd: '/x/huge' } });
    const count = JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } } } });
    const huge = JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'noise', data: 'x'.repeat(11 * 1024 * 1024) } });
    writeFileSync(file, `${meta}\n${count}\n${huge}\n`);
    const env = { WB_URL: base, WB_TOKEN: TOKEN, HOME: h };

    const first = await run('sync-usage.mjs', '', env, 60000);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /新增 1 条/);
    assert.match(first.stdout, /跳过 1 行/);
    const st = JSON.parse(readFileSync(join(h, '.ai-workbench-usage-state.json'), 'utf8'));
    assert.equal(st[file].offset, statSync(file).size, 'bookmark moved past the skipped line');

    const second = await run('sync-usage.mjs', '', env, 60000);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /扫描 0 个有变化的会话文件/, 'nothing left to read');
  });
});

describe('accounts, machines, export', () => {
  test('upsert account and heartbeat show up', async () => {
    const a = await api('/api/accounts/' + encodeURIComponent('Claude Max · 主号'), { method: 'PUT', body: { executor: 'claude', window_pct: 62, status: 'ok' } });
    assert.equal(a.json.window_pct, 62);
    const b = await api('/api/accounts/' + encodeURIComponent('Claude Max · 主号'), { method: 'PUT', body: { status: 'near' } });
    assert.equal(b.json.window_pct, 62, 'partial update keeps other fields');
    await api('/api/machines/demo-PC/heartbeat', { method: 'POST', body: { meta: 'linux', metrics: { load: 1.2, gpus: [{ name: 'T10', temp: 40 }] } } });
    const m = (await api('/api/machines')).json[0];
    assert.equal(m.online, true);
    assert.equal(m.metrics.gpus[0].name, 'T10');
    const csv = await api('/api/events.csv');
    assert.match(csv.text, /时间,操作者,类型,任务,内容/);
    const backup = await fetch(base + '/api/backup', { headers: { Cookie: cookie } });
    assert.equal(backup.status, 200);
    assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  });
});

// 015.3: a changed WB_PASSWORD has to invalidate every browser that is still logged in. Sessions
// are random ids in the database, so on their own they are unrelated to the password.
describe('password fingerprint (015.3)', () => {
  const sync = async (pw?: string) => (await import('../src/auth.ts')).syncPasswordFingerprint(pw);
  const fpRow = async () => {
    const { db } = await import('../src/db.ts');
    return (db().prepare('SELECT detail FROM connector_state WHERE name = ?').get('auth.password_fingerprint') as { detail: string } | undefined)?.detail ?? '';
  };

  test('first run only remembers the password, never deletes sessions', async () => {
    assert.equal(await fpRow(), '', 'a fresh database has no fingerprint yet');
    assert.equal(await sync(), 'first');
    assert.equal((await api('/', { token: null, headers: { Cookie: cookie } })).status, 200, 'the existing login survives');
  });

  test('the same password on restart keeps everyone logged in', async () => {
    assert.equal(await sync(), 'same');
    assert.equal((await api('/', { token: null, headers: { Cookie: cookie } })).status, 200);
  });

  test('the database holds a slow-hash fingerprint, not the password (015.4)', async () => {
    const fp = await fpRow();
    assert.match(fp, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/, 'scrypt record with a fresh random salt');
    assert.ok(!fp.includes(process.env.WB_PASSWORD!), 'no plaintext');
    assert.ok(fp !== process.env.WB_PASSWORD!);
  });

  test('a legacy sha256 fingerprint upgrades in place and keeps sessions (015.4)', async () => {
    const { db } = await import('../src/db.ts');
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256')
      .update('ai-workbench/password-fingerprint/v1').update('\0').update(process.env.WB_PASSWORD!)
      .digest('hex');
    db().prepare(`UPDATE connector_state SET detail = ? WHERE name = 'auth.password_fingerprint'`).run(legacy);
    assert.equal(await sync(), 'same', 'the legacy record still verifies against the same password');
    assert.match(await fpRow(), /^scrypt:/, 'silently rewritten in the slow format');
    assert.equal((await api('/', { token: null, headers: { Cookie: cookie } })).status, 200, 'nobody was logged out');
  });

  test('a backup copy carries neither sessions nor the fingerprint (015.4)', async () => {
    const backup = await fetch(base + '/api/backup', { headers: { Cookie: cookie } });
    assert.equal(backup.status, 200);
    const file = join(tmpdir(), `wb-fp-test-${Date.now()}.db`);
    writeFileSync(file, Buffer.from(await backup.arrayBuffer()));
    const { DatabaseSync } = await import('node:sqlite');
    const copy = new DatabaseSync(file);
    try {
      assert.equal((copy.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n, 0, 'no sessions in the copy');
      assert.equal(
        (copy.prepare(`SELECT COUNT(*) n FROM connector_state WHERE name = 'auth.password_fingerprint'`).get() as { n: number }).n,
        0,
        'no password fingerprint in the copy',
      );
    } finally { copy.close(); }
  });

  test('changing the password drops old sessions and writes an audit line', async () => {
    const old = cookie;
    assert.equal(await sync('another-password-0123456789'), 'changed');
    const after = await api('/', { token: null, headers: { Cookie: old } });
    assert.equal(after.status, 302, 'the old browser is out');
    assert.equal(after.headers.get('location'), '/login');
    const { db } = await import('../src/db.ts');
    const ev = db().prepare('SELECT text FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1').get('auth.password_changed') as { text: string } | undefined;
    assert.ok(ev, 'audited');
    assert.match(ev.text, /清掉 \d+ 个已登录的浏览器会话/);
    const left = (db().prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n;
    assert.equal(left, 0, 'nothing is left signed in');
    // Put the real password back and log in again so nothing later in this file is left signed out.
    assert.equal(await sync(process.env.WB_PASSWORD!), 'changed');
    cookie = await loginCookie(base, process.env.WB_PASSWORD!);
    session = '';
  });
});

// 043：请求体形状由路由声明，对不上就 400。以前解析器把任何数组包成 { records }，
// 只收对象的接口收到数组会静默按对象处理、还回 200（PUT /api/executors 踩过一次）。
describe('请求体形状', () => {
  test('只收对象的接口收到数组：400，而不是 200 什么都没存', async () => {
    const before = ((await api('/api/tasks')).json as unknown[]).length;
    const r = await api('/api/tasks', { method: 'POST', body: [{ title: '数组不该建出任务' }] });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /需要一个 JSON 对象/);
    const after = ((await api('/api/tasks')).json as unknown[]).length;
    assert.equal(after, before, '一条都不该建出来');
  });

  test('JSON 标量也按 400 处理', async () => {
    const r = await api('/api/tasks', { method: 'POST', body: 'not-an-object' });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /需要一个 JSON 对象/);
  });
});
