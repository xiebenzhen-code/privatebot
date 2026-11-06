// 011: display labels — names change, keys never do.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCookie } from './helpers.ts';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-labels-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;
let domain: any;

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  domain = await import('../src/domain.ts');
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
  domain.clearLabelCache();
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
  // Writes are made as a browser session: some endpoints are human-only (008.2).
  const authHeaders: Record<string, string> = init.method && init.method !== 'GET' && cookie
    ? { Cookie: cookie }
    : { Authorization: `Bearer ${TOKEN}` };
  const res = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...authHeaders, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const page = async (path: string): Promise<string> => {
  await api('/login-placeholder').catch(() => {});
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return res.text();
};

describe('labels', () => {
  test('the crew preset renames executors, and one item can be overridden', async () => {
    let r = await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'crew' }) });
    assert.equal(r.status, 200);
    assert.equal(domain.execLabel('me'), '制片人');
    assert.equal(domain.execLabel('claude'), '导演');
    assert.equal(domain.sectionLabel('board', '任务看板'), '拍摄进度');

    r = await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'crew', exec_zcode: '灯光组' }) });
    assert.equal(domain.execLabel('zcode'), '灯光组');
    assert.equal(domain.execLabel('me'), '制片人', 'others keep the preset');
    assert.deepEqual(r.json.executors, { zcode: '灯光组' }, 'only the override is stored');
  });

  test('back to the default preset restores the original words', async () => {
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'crew', exec_me: '老板' }) });
    assert.equal(domain.execLabel('me'), '老板');
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'default' }) });
    assert.equal(domain.execLabel('me'), '我');
    assert.equal(domain.sectionLabel('board', '任务看板'), '任务看板');
  });

  test('renaming does not move the keys the API and audit use', async () => {
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'crew', exec_zcode: '灯光组' }) });
    const created = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '改个称呼', executor: 'zcode', category: 'dev', project: 'demo-feed' }) });
    assert.equal(created.json.executor, 'zcode', 'the API still speaks keys');

    const listed = await api('/api/tasks');
    assert.ok(listed.json.some((t: any) => t.executor === 'zcode'));
    const audit = db.prepare("SELECT text FROM events WHERE kind = 'task.created'").get() as any;
    assert.match(audit.text, /（zcode）/, 'the audit keeps the key next to the display name');
  });

  test('a name with markup is escaped, not rendered', async () => {
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'default', exec_claude: '<b>x</b>' }) });
    const html = await page('/settings/appearance');
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), 'escaped');
    assert.ok(!html.includes('<b>x</b>'), 'never raw');
  });

  test('names are trimmed and capped at 12 characters', async () => {
    const r = await api('/api/labels', {
      method: 'POST',
      body: JSON.stringify({ preset: 'default', exec_codex: '  一二三四五六七八九十一二三四五  ' }),
    });
    assert.equal(r.json.executors.codex, '一二三四五六七八九十一二三'.slice(0, 12));
  });

  test('the sidebar lists every executor from the registry', async () => {
    const html = await page('/tasks');
    for (const key of Object.keys(domain.EXECUTORS)) {
      if (key === 'me') continue;
      assert.ok(html.includes(`executor=${key}`), `sidebar has ${key}`);
    }
  });
});
