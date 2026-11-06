// Connector tests: a fake CLIProxyAPI serves the real (redacted) sample payloads from test/fixtures.
//   npm test
import { dayOf } from '../src/domain.ts';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-token-cliproxyapi-0123456789';
const MGMT_KEY = 'test-management-key-0123456789';
const ROOT = join(import.meta.dirname, '..');
const AUTH_FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'cpa-auth-files.json'), 'utf8'));
const QUEUE_FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'cpa-usage-queue.json'), 'utf8'));

process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.CPA_MANAGEMENT_KEY = MGMT_KEY;

let app: Server;
let cpa: Server;
let base = '';
let cpaBase = '';
let mode: 'ok' | '500' = 'ok';
let batches: unknown[][] = [];
let authPayload: unknown = AUTH_FIXTURE;
let queueCalls = 0;
let db: any;
let runCycle: () => Promise<any>;
let connectorState: () => any;
let listAccounts: () => any[];
let openDb: (file?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  cpa = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://cpa');
    if (mode === '500') { res.writeHead(500).end('boom'); return; }
    if (req.headers.authorization !== `Bearer ${MGMT_KEY}`) { res.writeHead(401).end('no key'); return; }
    if (url.pathname === '/v0/management/auth-files') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(authPayload));
      return;
    }
    if (url.pathname === '/v0/management/usage-queue') {
      queueCalls++;
      const batch = batches.shift() ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(batch));
      return;
    }
    if (url.pathname === '/v0/management/usage-statistics-enabled') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => cpa.listen(0, '127.0.0.1', () => r()));
  const addr = cpa.address();
  cpaBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.CPA_URL = cpaBase;
  process.env.CPA_POLL_SECONDS = '15';

  ({ openDb, useDb } = await import('../src/db.ts'));
  ({ runCycle, connectorState } = await import('../src/services/cliproxyapi.ts'));
  ({ listAccounts } = await import('../src/services/metrics.ts'));
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a2 = app.address();
  base = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
});

after(() => { app.close(); cpa.close(); });

beforeEach(() => {
  db = openDb(':memory:');
  useDb(db);
  mode = 'ok';
  batches = [];
  queueCalls = 0;
  authPayload = AUTH_FIXTURE;
});

async function api(path: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const usageRows = () => db.prepare('SELECT * FROM usage ORDER BY id').all() as any[];
const events = () => db.prepare('SELECT * FROM events ORDER BY id').all() as any[];

describe('cliproxyapi connector', () => {
  test('syncs the account with its official quota windows', async () => {
    await runCycle();
    const accounts = (await api('/api/accounts')).json as any[];
    const a = accounts.find((x) => x.name === 'user@example.com');
    assert.ok(a, 'account imported');
    assert.equal(a.source, 'cliproxyapi');
    assert.equal(a.executor, 'pool');
    assert.equal(a.plan, 'plus');
    assert.equal(a.provider, 'codex');
    assert.equal(a.window_pct, 14);
    assert.equal(a.window2_pct, 2);
    assert.equal(a.window_minutes, 300);
    assert.equal(a.window2_minutes, 10080);
    assert.equal(a.window_reset_at, new Date(1793187313 * 1000).toISOString());
    assert.equal(a.window2_reset_at, new Date(1793774113 * 1000).toISOString());
    assert.equal(a.status, 'ok');
  });

  test('imports usage and keeps private fields out of the database', async () => {
    batches = [QUEUE_FIXTURE];
    await runCycle();
    const rows = usageRows();
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.input_tokens, 308);
    assert.equal(r.output_tokens, 5);
    assert.equal(r.cache_tokens, 0);
    assert.equal(r.model, 'gpt-5.6-luna');
    assert.equal(r.account, 'user@example.com');
    assert.equal(r.executor, 'pool');
    assert.equal(r.failed, 0);
    assert.equal(r.latency_ms, 3483);
    assert.equal(r.source_key, 'cpa:01a18100000000000000000000000547');

    const dump = JSON.stringify(
      ['usage', 'accounts', 'events', 'connector_state'].flatMap((t) => db.prepare(`SELECT * FROM ${t}`).all()),
    );
    for (const secret of ['sk-REDACTED', '__cf_bm', '203.0.113.19', '56cb3c0000000000000000000000a0b1', 'response_headers']) {
      assert.ok(!dump.includes(secret), `${secret} must not be stored`);
    }
  });

  test('drains several queue batches and never imports twice', async () => {
    const second = { ...QUEUE_FIXTURE[0], request_id: 'req-second', timestamp: '2026-10-28T17:00:00.000Z' };
    batches = [QUEUE_FIXTURE, [second]];
    const first = await runCycle();
    assert.equal(first.ok, true);
    assert.equal(usageRows().length, 2);
    assert.equal(queueCalls, 3, 'two batches then one empty answer');

    batches = [QUEUE_FIXTURE, [second]];
    await runCycle();
    assert.equal(usageRows().length, 2, 'source_key keeps duplicates out');
  });

  test('a 500 from CLIProxyAPI is recorded, not thrown, and recovers next cycle', async () => {
    mode = '500';
    const bad = await runCycle();
    assert.equal(bad.ok, false);
    assert.match(connectorState().last_error, /500/);
    mode = 'ok';
    const good = await runCycle();
    assert.equal(good.ok, true);
    assert.equal(connectorState().last_error, '');
  });

  test('a renamed account keeps its name on the next sync', async () => {
    await runCycle();
    db.prepare('UPDATE accounts SET name = ? WHERE external_id = ?').run('我的 Codex', AUTH_FIXTURE.files[0].id);
    await runCycle();
    const names = listAccounts().map((a) => a.name);
    assert.ok(names.includes('我的 Codex'), 'manual rename survives');
    assert.ok(!names.includes('user@example.com'), 'no duplicate row');
  });

  test('the account is keyed by the auth file, not by auth_index', async () => {
    const base = AUTH_FIXTURE.files[0];
    batches = [QUEUE_FIXTURE];
    await runCycle();
    assert.equal(db.prepare("SELECT external_id FROM accounts WHERE name = 'user@example.com'").get().external_id, base.id);

    // CLIProxyAPI restarts: same file, brand new auth_index
    const fresh = 'ffff0000ffff0000';
    authPayload = { ...AUTH_FIXTURE, files: [{ ...base, auth_index: fresh }] };
    const rec = { ...QUEUE_FIXTURE[0], request_id: 'after-restart', timestamp: new Date().toISOString(), auth_index: fresh };
    batches = [[rec]];
    await runCycle();

    assert.equal(listAccounts().filter((a) => a.executor === 'pool').length, 1, 'no duplicate account');
    const accounts = db.prepare("SELECT account FROM usage WHERE source_key IN ('cpa:01a18100000000000000000000000547', 'cpa:after-restart')").all() as any[];
    assert.equal(accounts.length, 2);
    for (const r of accounts) assert.equal(r.account, 'user@example.com', 'usage stays on one account');
  });

  test('legacy auth_index rows are rewritten to the auth file id', async () => {
    const base = AUTH_FIXTURE.files[0];
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, source, external_id, provider)
      VALUES ('user@example.com', 'pool', 'CLIProxyAPI · codex', 14, '', 'ok', ?, 'cliproxyapi', ?, 'codex')`)
      .run(new Date().toISOString(), base.auth_index);
    const res = await runCycle();
    assert.equal(res.migration?.rewritten, 1);
    assert.equal(db.prepare('SELECT external_id FROM accounts').get().external_id, base.id);
    assert.equal(listAccounts().length, 1);
  });

  test('a 429 limits the account until the window resets, and a sync does not undo it', async () => {
    // the fixture's reset time is a fixed date, so pin a future one for this case
    const resetAt = Math.floor((Date.now() + 2 * 3600 * 1000) / 1000);
    const base = AUTH_FIXTURE.files[0];
    authPayload = {
      ...AUTH_FIXTURE,
      files: [{ ...base, quota: { observed_at: new Date().toISOString(), signals: { ...base.quota.signals, 'X-Codex-Primary-Reset-At': String(resetAt) } } }],
    };
    await runCycle(); // import the account (fixture carries a primary reset time)
    const r429 = { ...QUEUE_FIXTURE[0], request_id: 'req-429', timestamp: new Date().toISOString(), failed: true, fail: { status_code: 429, body: '' } };
    batches = [[r429]];
    await runCycle();
    const a = listAccounts()[0];
    assert.equal(a.status, 'limited');
    assert.equal(a.limited_until, new Date(resetAt * 1000).toISOString(), 'reset time from the quota signals');

    // the auth file still says "active": limited_until must win
    await runCycle();
    assert.equal(listAccounts()[0].status, 'limited');
    assert.equal(events().filter((e) => /limited/.test(e.text)).length, 1, 'one audit entry, no flapping');
  });

  test('5xx and network failures never mark the account limited', async () => {
    await runCycle();
    const bad = (id: string) => ({ ...QUEUE_FIXTURE[0], request_id: id, timestamp: new Date().toISOString(), failed: true, fail: { status_code: 502, body: '' } });
    batches = [[bad('f1'), bad('f2'), bad('f3'), bad('f4')]];
    await runCycle();
    assert.equal(listAccounts()[0].status, 'ok', 'upstream noise is not a quota problem');
    const row = db.prepare("SELECT failed, fail_status FROM usage WHERE source_key = 'cpa:f1'").get() as any;
    assert.equal(row.failed, 1);
    assert.equal(row.fail_status, 502, 'status code kept for later breakdowns');
  });

  test('a batch that cannot be written is dumped without secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpafail-'));
    process.env.CPA_FAIL_DIR = dir;
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON usage BEGIN SELECT RAISE(FAIL, 'boom'); END");
    batches = [QUEUE_FIXTURE];
    const res = await runCycle();
    assert.equal(res.ok, false);
    const files = readdirSync(dir);
    assert.equal(files.length, 1, 'one dump file');
    const dump = readFileSync(join(dir, files[0]), 'utf8');
    for (const secret of ['sk-REDACTED', '__cf_bm', '203.0.113.19', '56cb3c0000000000000000000000a0b1', 'response_headers']) {
      assert.ok(!dump.includes(secret), `${secret} must not reach disk`);
    }
    assert.ok(dump.includes('gpt-5.6-luna'), 'the token accounting still survives');
    delete process.env.CPA_FAIL_DIR;
  });

  test('an OpenAI-compatible upstream maps to its balance account, never to the raw key', async () => {
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, source, provider, kind)
      VALUES ('DeepSeek', 'pool', 'DeepSeek API · 经 CLIProxyAPI', NULL, '', 'ok', ?, 'api', 'deepseek', 'balance')`)
      .run(new Date().toISOString());
    const rec = {
      ...QUEUE_FIXTURE[0],
      request_id: 'ds-1', timestamp: new Date().toISOString(),
      provider: 'openai-compatible-deepseek', auth_index: 'd61e9c163545a830',
      source: 'sk-testkey000000000000000000000000',
      model: 'deepseek-flash', alias: 'deepseek-flash', response_model: 'deepseek-flash',
    };
    batches = [[rec]];
    await runCycle();
    const row = db.prepare("SELECT account, model, executor FROM usage WHERE source_key = 'cpa:ds-1'").get() as any;
    assert.equal(row.account, 'DeepSeek', 'matched through the provider, not the credential');
    assert.equal(row.model, 'deepseek-flash');
    assert.equal(row.executor, 'pool');

    const dump = JSON.stringify(db.prepare('SELECT * FROM usage').all());
    assert.ok(!dump.includes('sk-testkey'), 'the credential never reaches the usage table');
  });

  test('a bailian record lands on the voucher account, not the official DeepSeek one', async () => {
    for (const [name, provider] of [['DeepSeek', 'deepseek'], ['百炼代金券', 'bailian']]) {
      db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, source, provider, kind)
        VALUES (?, 'pool', 'test', NULL, '', 'ok', ?, 'api', ?, 'balance')`)
        .run(name, new Date().toISOString(), provider);
    }
    const base = { ...QUEUE_FIXTURE[0], timestamp: new Date().toISOString(), source: 'sk-placeholder-fixture-0001', auth_index: 'not-an-oauth-file' };
    batches = [[
      { ...base, request_id: 'bl-1', provider: 'openai-compatible-bailian', model: 'bl-deepseek-v4-flash', response_model: 'bl-deepseek-v4-flash' },
      { ...base, request_id: 'ds-2', provider: 'openai-compatible-deepseek', model: 'deepseek-flash', response_model: 'deepseek-flash' },
    ]];
    await runCycle();
    const rows = db.prepare("SELECT source_key, account, model FROM usage WHERE source_key IN ('cpa:bl-1', 'cpa:ds-2')").all() as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.source_key === 'cpa:bl-1').account, '百炼代金券');
    assert.equal(rows.find((r) => r.source_key === 'cpa:ds-2').account, 'DeepSeek');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM usage').all()).includes('sk-placeholder-fixture'));
  });

  test('two live files for one e-mail stay two accounts, and the migration never re-runs', async () => {
    const base = AUTH_FIXTURE.files[0];
    const team = { ...base, id: 'codex-team-2.json', name: 'codex-team-2.json', auth_index: 'idx-team' };
    authPayload = { ...AUTH_FIXTURE, files: [base, team] };

    for (let i = 0; i < 3; i++) {
      batches = [];
      await runCycle();
    }
    const accs = listAccounts().filter((a) => a.executor === 'pool');
    assert.equal(accs.length, 2, 'both files keep their own account');
    assert.ok(accs.some((a) => a.name === 'user@example.com'));
    assert.ok(accs.some((a) => a.name === 'user@example.com · 2'));
    assert.equal(events().filter((e) => e.kind === 'account.merged').length, 0, 'nothing merged');
    assert.equal(events().filter((e) => e.kind === 'account.imported').length, 2, 'imported once each');

    // usage follows the auth_index of the team file
    batches = [[{ ...QUEUE_FIXTURE[0], request_id: 'team-1', timestamp: new Date().toISOString(), auth_index: 'idx-team' }]];
    await runCycle();
    const row = db.prepare("SELECT account FROM usage WHERE source_key = 'cpa:team-1'").get() as any;
    assert.equal(row.account, 'user@example.com · 2');
  });

  test('an orphan is reported once, and never while the file list is empty', async () => {
    const base = AUTH_FIXTURE.files[0];
    await runCycle();

    authPayload = { ...AUTH_FIXTURE, files: [{ ...base, id: 'another.json', name: 'another.json', auth_index: 'idx-other' }] };
    for (let i = 0; i < 3; i++) {
      batches = [];
      await runCycle();
    }
    assert.equal(events().filter((e) => e.kind === 'account.orphan').length, 1, 'one entry, not one per cycle');

    authPayload = { ...AUTH_FIXTURE, files: [] };
    batches = [];
    await runCycle();
    assert.equal(events().filter((e) => e.kind === 'account.orphan').length, 1, 'empty list says nothing');
  });

  test('falls back to an estimate when there is no official signal', async () => {
    authPayload = { files: [], observed_at: AUTH_FIXTURE.observed_at };
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, window_minutes, window_limit_tokens)
      VALUES ('手动号', 'pool', '官方会话', NULL, '', 'ok', ?, 300, 1000)`).run(new Date().toISOString());
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO usage (source_key, ts, day, executor, account, model, project, input_tokens, output_tokens, cache_tokens)
      VALUES ('manual:1', ?, ?, 'pool', '手动号', 'x', '', 200, 50, 0)`).run(now, dayOf(now));

    const a = (await api('/api/accounts')).json.find((x: any) => x.name === '手动号');
    assert.equal(a.window_pct, 25);
    assert.equal(a.window_estimated, true);
  });
});
