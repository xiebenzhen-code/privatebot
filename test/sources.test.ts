// 010: the source registry behind the status panel.
import { dayOf } from '../src/domain.ts';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCookie } from './helpers.ts';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-sources-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';
delete process.env.ZAI_API_KEY;

let app: Server;
let fake: Server;
let base = '';
let cookie = '';
let balanceHits = 0;

let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;
let runBalances: () => Promise<any>;

before(async () => {
  fake = createServer((req, res) => {
    if (req.url === '/user/balance') {
      balanceHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '9.00', granted_balance: '0.00', topped_up_balance: '9.00' }],
      }));
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const a = fake.address();
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  process.env.DEEPSEEK_API_KEY = 'sk-placeholder-value-1';

  ({ openDb, useDb } = await import('../src/db.ts'));
  ({ runBalances } = await import('../src/services/balances.ts'));
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a2 = app.address();
  base = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
});

after(() => { app.close(); fake.close(); });

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
  balanceHits = 0;
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

const sourceOf = async (id: string) => (await api('/api/sources')).json.sources.find((s: any) => s.id === id);

describe('source status', () => {
  test('glm without a key asks for the env var, and no secret is echoed', async () => {
    delete process.env.ZAI_API_KEY;
    const res = await api('/api/sources');
    const glm = res.json.sources.find((s: any) => s.id === 'glm');
    assert.equal(glm.state, 'action');
    assert.match(glm.nextStep, /ZAI_API_KEY/);
    assert.deepEqual(glm.envNames, ['ZAI_API_KEY', 'ZAI_REGION']);
    assert.ok(!res.text.includes('sk-placeholder-value-1'), 'the key never leaves the server');
    process.env.ZAI_API_KEY = 'test-zai';
  });

  test('a reader in relogin needs attention; a fresh one is connected', async () => {
    await api('/api/accounts/WorkBuddy', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'credits', executor: 'workbuddy', source: 'reader', balance: 100, balance_unit: '积分', status: 'relogin' }),
    });
    let s = await sourceOf('reader:workbuddy');
    assert.equal(s.state, 'action');
    assert.match(s.nextStep, /login workbuddy/);

    await api('/api/accounts/WorkBuddy', { method: 'PUT', body: JSON.stringify({ status: 'ok' }) });
    s = await sourceOf('reader:workbuddy');
    assert.equal(s.state, 'connected', 'just updated, so within six hours');
  });

  test('stale data shows a redacted error summary', async () => {
    const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    db.prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed)
      VALUES ('glm', ?, ?, ?, 1, 3)`).run(old, old, 'quota/limit → 401 with key sk-placeholder-abc-1 invalid');
    const s = await sourceOf('glm');
    assert.equal(s.state, 'action');
    assert.ok(!s.nextStep.includes('sk-placeholder-abc-1'), 'the token is stripped');
    assert.match(s.nextStep, /\*\*\*/, 'something was masked');
  });

  test('switching deepseek off stops the balance poll and is audited', async () => {
    const off = await api('/api/sources/deepseek', { method: 'PATCH', body: JSON.stringify({ off: true }) });
    assert.equal(off.status, 200);
    assert.equal((await sourceOf('deepseek')).state, 'off');
    assert.ok((db.prepare('SELECT * FROM events').all() as any[]).some((e) => e.kind === 'source.off'));

    await runBalances();
    assert.equal(balanceHits, 0, 'no request while it is off');

    await api('/api/sources/deepseek', { method: 'PATCH', body: JSON.stringify({ off: false }) });
    await runBalances();
    assert.equal(balanceHits, 1, 'back on, the poll resumes');
    assert.ok((db.prepare('SELECT * FROM events').all() as any[]).some((e) => e.kind === 'source.on'));
  });

  test('the excluded list is fixed and cannot be toggled', async () => {
    const res = await api('/api/sources');
    assert.ok(res.json.excluded.length >= 3);
    assert.ok(res.json.excluded.some((e: any) => e.id === 'claude-proxy'));
    for (const e of res.json.excluded) {
      assert.ok(e.reason.length > 0, 'every exclusion explains itself');
      const bad = await api(`/api/sources/${encodeURIComponent(e.id)}`, { method: 'PATCH', body: JSON.stringify({ off: true }) });
      assert.equal(bad.status, 400);
    }
  });

  test('bailian does not ask the workbench to hold a key', async () => {
    process.env.CPA_URL = 'http://127.0.0.1:8317';
    process.env.CPA_MANAGEMENT_KEY = 'mgmt-key';
    let s = await sourceOf('bailian');
    assert.equal(s.configured, false, 'no voucher account yet');
    assert.deepEqual(s.envNames, []);
    assert.match(s.nextStep, /\/apps\/anthropic/, 'names the direct-connect endpoint');
    assert.match(s.nextStep, /反代那条继续供用量回传/, 'the proxy path still reports usage');
    assert.ok(!s.nextStep.includes('BAILIAN_API_KEY'), 'never asks for a second copy of the key');

    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, kind, balance_unit, balance_detail)
      VALUES ('百炼代金券', 'pool', '', NULL, '', 'ok', ?, 'balance', 'CNY', ?)`)
      .run(new Date().toISOString(), JSON.stringify({ voucher_total: 300, prices: {} }));
    s = await sourceOf('bailian');
    assert.equal(s.configured, true, 'account + CLIProxyAPI is all it takes');
  });

  test('usage sync watches the usage table, not the heartbeat', async () => {
    db.prepare('INSERT INTO machines (name, meta, metrics, updated_at) VALUES (?, ?, ?, ?)')
      .run('box', '', '{}', new Date().toISOString());
    let s = await sourceOf('sync:claude-code');
    assert.equal(s.configured, false, 'a heartbeat is not a usage sync');

    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO usage (source_key, ts, day, executor, account, model, project, input_tokens, output_tokens, cache_tokens)
      VALUES ('claude:abc', ?, ?, 'claude', '', 'x', '', 10, 0, 0)`).run(ts, dayOf(ts));
    s = await sourceOf('sync:claude-code');
    assert.equal(s.state, 'connected');
  });
});

describe('redaction', () => {
  test('credentials are stripped in the shapes they actually appear', async () => {
    const { redact } = await import('../src/services/sources.ts');
    assert.ok(!redact('failed with tokenAbCdEf123').includes('tokenAbCdEf123'));
    // 028.1：Bearer 后面的值要「像令牌」才打（≥16 位且含数字，或有 eyJ/sk-/ghp_ 这类前缀）。
    assert.ok(!redact('Authorization: Bearer test-token-not-real-0000').includes('test-token-not-real-0000'));
    assert.ok(!redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9').includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.ok(!redact('bad api_key=XYZ12345 here').includes('XYZ12345'));
    assert.ok(!redact('401 with key sk-placeholder-abc-1').includes('sk-placeholder-abc-1'));
  });

  test('ordinary words are left alone', async () => {
    const { redact } = await import('../src/services/sources.ts');
    assert.equal(redact('keyboard 坏了'), 'keyboard 坏了');
    assert.equal(redact('the key is missing'), 'the key is missing');
  });
});

describe('a source that just broke', () => {
  test('a failure newer than the last success means 待你操作, not 已接入', async () => {
    process.env.ZAI_API_KEY = 'test-zai';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed)
      VALUES ('glm', ?, ?, ?, 1, 1)`).run(now, now, '当前用户不存在coding plan');
    let s = await sourceOf('glm');
    assert.equal(s.state, 'action', 'the stale success must not hide a fresh failure');
    assert.match(s.nextStep, /当前用户不存在coding plan/);

    // a later success clears it
    const later = new Date(Date.now() + 1000).toISOString();
    db.prepare("UPDATE connector_state SET last_run = ?, last_ok = ?, last_error = '' WHERE name = 'glm'").run(later, later);
    s = await sourceOf('glm');
    assert.equal(s.state, 'connected');
  });
});
