// 008.2: some operations belong to a person at a browser, not to a bearer token.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCookie } from './helpers.ts';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-human-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { app.close(); });

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `password=${process.env.WB_PASSWORD}`,
      redirect: 'manual',
    });
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
});

async function api(path: string, init: RequestInit = {}, as: 'bearer' | 'cookie' = 'bearer') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) };
  if (as === 'cookie') headers.Cookie = cookie; else headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(base + path, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, json, text };
}

async function pendingApproval() {
  const res = await api('/api/approvals', {
    method: 'POST',
    body: JSON.stringify({ title: '删库', risk: 'high', executor: 'claude', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }),
  });
  return res.json;
}

describe('bearer tokens cannot do human-only work', () => {
  test('deciding an approval needs a browser session', async () => {
    const a = await pendingApproval();
    const viaToken = await api(`/api/approvals/${a.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(viaToken.status, 403);
    assert.match(viaToken.json.error, /只能在网页上做/);

    const viaCookie = await api(`/api/approvals/${a.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, 'cookie');
    assert.equal(viaCookie.status, 200);
    assert.equal(viaCookie.json.status, 'approved');
  });

  test('rules, executors, labels, channels and sources are human-only', async () => {
    const rule = await api('/api/rules', { method: 'POST', body: JSON.stringify({ name: 'x', tool_pattern: 'Bash', input_pattern: 'x', risk: 'low' }) });
    assert.equal(rule.status, 403);
    assert.equal((await api('/api/rules/1', { method: 'DELETE' })).status, 403);
    assert.equal((await api('/api/executors', { method: 'PUT', body: JSON.stringify({ executor: 'zcode', priority: 9 }) })).status, 403);
    assert.equal((await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'crew' }) })).status, 403);
    assert.equal((await api('/api/notify/channels', { method: 'POST', body: JSON.stringify({ kind: 'webhook', url: 'https://x.test/h' }) })).status, 403);
    assert.equal((await api('/api/sources/deepseek', { method: 'PATCH', body: JSON.stringify({ off: true }) })).status, 403);
    assert.equal((await api('/api/backup')).status, 403);
    assert.equal((await api('/api/events.csv')).status, 403);
  });

  test('tasks: start and stop need a person, reading does not', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '任务', executor: 'zcode', category: 'dev', project: 'demo-feed' }) });
    assert.equal(t.status, 201, 'creating a task from a token is fine');
    assert.equal((await api(`/api/tasks/${t.json.id}/start`, { method: 'POST' })).status, 403);
    assert.equal((await api(`/api/tasks/${t.json.id}/stop`, { method: 'POST' })).status, 403);
    assert.equal((await api(`/api/tasks/${t.json.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await api('/api/tasks')).status, 200);
  });

  test('pausing with a token is allowed, resuming is not', async () => {
    const on = await api('/api/dispatch/auto-paused', { method: 'POST', body: JSON.stringify({ paused: true }) });
    assert.equal(on.status, 200, 'pausing only makes things safer');
    const off = await api('/api/dispatch/auto-paused', { method: 'POST', body: JSON.stringify({ paused: false }) });
    assert.equal(off.status, 403);
    const offCookie = await api('/api/dispatch/auto-paused', { method: 'POST', body: JSON.stringify({ paused: false }) }, 'cookie');
    assert.equal(offCookie.status, 200);
  });
});

describe('the scripts still work with a token', () => {
  test('hook, runner, usage, heartbeat, reader and sources keep working', async () => {
    assert.equal((await api('/api/hooks/claude', { method: 'POST', body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) })).status, 200);
    assert.equal((await api('/api/runner/next?executors=zcode&runner=r1')).status, 204);
    assert.equal((await api('/api/runner/heartbeat', { method: 'POST', body: JSON.stringify({ runner: 'r1' }) })).status, 200);
    assert.equal((await api('/api/usage', { method: 'POST', body: JSON.stringify({ records: [] }) })).status, 200);
    assert.equal((await api('/api/machines/box/heartbeat', { method: 'POST', body: JSON.stringify({ metrics: {} }) })).status, 200);
    assert.equal((await api('/api/accounts/WorkBuddy', { method: 'PUT', body: JSON.stringify({ kind: 'credits', executor: 'workbuddy', source: 'reader', balance: 5, balance_unit: '积分' }) })).status, 200);
    assert.equal((await api('/api/events', { method: 'POST', body: JSON.stringify({ kind: 'reader.failed', text: 'x' }) })).status, 201);
    assert.equal((await api('/api/pulse')).status, 200);
    assert.equal((await api('/api/sources')).status, 200);
  });
});

describe('008.3 password, sessions and glob escapes', () => {
  test('the script token no longer logs a person in', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    assert.equal(res.status, 401, 'WB_TOKEN is not a password');
  });

  test('the password works, and the cookie is an opaque server-side id', async () => {
    assert.match(cookie, /^wb_session=[0-9a-f]{64}$/, '32 random bytes, not an HMAC of anything');
    const page = await api('/', {}, 'cookie');
    assert.equal(page.status, 200);
  });

  test('a cookie forged from the old HMAC scheme is refused', async () => {
    const { createHmac } = await import('node:crypto');
    const forged = createHmac('sha256', TOKEN).update('wb-session-v1').digest('hex');
    const res = await api('/api/tasks', {}, 'bearer'); // sanity: token still works for APIs
    assert.equal(res.status, 200);
    const bad = await fetch(`${base}/`, { headers: { Cookie: `wb_session=${forged}` }, redirect: 'manual' });
    assert.equal(bad.status, 302, 'forged cookie is not a session');
    assert.equal(bad.headers.get('location'), '/login');
  });

  test('logging out kills the session server-side', async () => {
    const out = await api('/logout', { method: 'POST' }, 'cookie');
    assert.equal(out.status, 200);
    const after = await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(after.status, 302);
    cookie = await loginCookie(base, process.env.WB_PASSWORD!); // restore for later tests
  });

  test('Glob and Grep cannot look outside the worktree', async () => {
    const cwd = 'C://Users//you//wb-worktrees//T-9';
    const call = (tool: string, input: Record<string, unknown>) => api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's-glob', cwd, tool_name: tool, tool_input: input, source: 'runner' }),
    });
    assert.equal((await call('Glob', { pattern: '../../**' })).json.action, 'deny');
    assert.equal((await call('Glob', { pattern: 'C:/Users/**' })).json.action, 'deny');
    assert.equal((await call('Grep', { pattern: 'x', glob: '../*.ts' })).json.action, 'deny');
    assert.equal((await call('Glob', { pattern: 'src/**/*.ts' })).json.action, 'allow');
  });
});
