// 006: GLM Coding Plan quota adapter (fake endpoint) and the quota reader's extraction helpers.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-quota-0123456789';
const ZAI_KEY = 'test-zai-key';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.ZAI_API_KEY = ZAI_KEY;

let app: Server;
let fake: Server;
let base = '';
let quotaPayload: any = {};
let quotaStatus = 200;
let lastAuthHeader = '';
let lastPath = '';

let db: any;
let runBalances: () => Promise<any>;
let runReminders: () => number;
let parseGlmQuota: (p: any) => any;
let toIso: (v: unknown) => string | null;
let listAccounts: () => any[];
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  fake = createServer((req, res) => {
    lastAuthHeader = String(req.headers.authorization ?? '');
    lastPath = String(req.url ?? '');
    if (quotaStatus !== 200) { res.writeHead(quotaStatus).end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(quotaPayload));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const a = fake.address();
  process.env.ZAI_BASE_URL = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

  ({ openDb, useDb } = await import('../src/db.ts'));
  ({ runBalances, runReminders, parseGlmQuota, toIso } = await import('../src/services/balances.ts'));
  ({ listAccounts } = await import('../src/services/metrics.ts'));
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a2 = app.address();
  base = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
});

after(() => { app.close(); fake.close(); });

beforeEach(() => {
  db = openDb(':memory:');
  useDb(db);
  quotaStatus = 200;
  quotaPayload = {
    code: 200,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 42, resetTime: 1793200000 }, // seconds
        { type: 'TOKENS_LIMIT', percentage: 7, resetTime: 1793800000000, windowMinutes: 10080 }, // ms
        { type: 'TIME_LIMIT', percentage: 30, currentValue: 30, usage: 100 },
      ],
    },
  };
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const tasks = () => db.prepare('SELECT * FROM tasks ORDER BY id').all() as any[];

describe('glm coding plan adapter', () => {
  test('maps the 5-hour and weekly windows, converting seconds and milliseconds', async () => {
    const out = await runBalances();
    assert.equal(out.ok, true, JSON.stringify(out.results));
    assert.equal(lastPath, '/api/monitor/usage/quota/limit');
    assert.equal(lastAuthHeader, ZAI_KEY, 'the plugin sends the raw token, no Bearer prefix');

    const a = listAccounts().find((x: any) => x.name === 'GLM Coding Plan')!;
    assert.equal(a.kind, 'window');
    assert.equal(a.executor, 'zcode');
    assert.equal(a.source, 'api');
    assert.equal(a.window_pct, 42);
    assert.equal(a.window_minutes, 300);
    assert.equal(a.window_reset_at, new Date(1793200000 * 1000).toISOString(), 'seconds → ISO');
    assert.equal(a.window2_pct, 7);
    assert.equal(a.window2_minutes, 10080);
    assert.equal(a.window2_reset_at, new Date(1793800000000).toISOString(), 'milliseconds → ISO');
    assert.equal(JSON.parse(a.balance_detail).mcp.percentage, 30);
  });

  test('a failing endpoint is recorded, not thrown, and clears on the next good run', async () => {
    quotaStatus = 500;
    const bad = await runBalances();
    assert.equal(bad.ok, false);
    assert.match(db.prepare("SELECT last_error FROM connector_state WHERE name = 'glm'").get().last_error, /500/);

    quotaStatus = 200;
    const good = await runBalances();
    assert.equal(good.ok, true);
    assert.equal(db.prepare("SELECT last_error FROM connector_state WHERE name = 'glm'").get().last_error, '');
  });

  test('parses tolerantly when only one token window is present', () => {
    const q = parseGlmQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 5 }] } });
    assert.equal(q.windowPct, 5);
    assert.equal(q.window2Pct, null);
    assert.equal(q.detail.weekly_signal, 'missing');
  });

  test('toIso accepts seconds, milliseconds and ISO strings', () => {
    assert.equal(toIso(1793200000), new Date(1793200000 * 1000).toISOString());
    assert.equal(toIso(1793200000000), new Date(1793200000000).toISOString());
    assert.equal(toIso('2026-10-29T00:00:00Z'), '2026-10-29T00:00:00.000Z');
    assert.equal(toIso(null), null);
  });
});

describe('quota reader helpers', () => {
  let getByPath: any, toNumber: any, extractFromJson: any, extractFromText: any, extractQuota: any, looksLikeLogin: any;
  before(async () => {
    ({ getByPath, toNumber, extractFromJson, extractFromText, extractQuota, looksLikeLogin } = await import('../scripts/quota-reader.mjs'));
  });

  test('getByPath walks objects and array indexes', () => {
    const json = { data: { credits: { balance: 1200 }, list: [{ n: 5 }] } };
    assert.equal(getByPath(json, 'data.credits.balance'), 1200);
    assert.equal(getByPath(json, 'data.list.0.n'), 5);
    assert.equal(getByPath(json, 'data.missing.deep'), undefined);
  });

  test('toNumber handles commas, units and plain numbers', () => {
    assert.equal(toNumber('1,234.5 积分'), 1234.5);
    assert.equal(toNumber(88), 88);
    assert.equal(toNumber('没有数字'), null);
  });

  test('network rule wins, text regex is the fallback', () => {
    const site = {
      extract: { type: 'network', urlIncludes: '/api/credits', balancePath: 'data.balance', expiresPath: 'data.expiresAt' },
      fallback: { type: 'text', regex: '积分余额[:：]?\\s*([\\d,]+(?:\\.\\d+)?)' },
    };
    const bodies = [
      { url: 'https://x/api/other', json: { data: { balance: 1 } } },
      { url: 'https://x/api/credits', json: { data: { balance: 1500, expiresAt: '2026-12-01' } } },
    ];
    const hit = extractQuota(site, bodies, '积分余额：999');
    assert.deepEqual(hit, { balance: 1500, expires_at: '2026-12-01', source: 'network' });
    assert.deepEqual(extractQuota(site, [], '积分余额：999'), { balance: 999, expires_at: null, source: 'text' });
    assert.equal(extractQuota(site, [], '随便一段话'), null);
  });

  test('login redirects are recognised', () => {
    assert.equal(looksLikeLogin('https://www.codebuddy.cn/login', { loginUrl: 'https://www.codebuddy.cn/login' }), true);
    assert.equal(looksLikeLogin('https://www.codebuddy.cn/sign-in?next=/usage', {}), true);
    assert.equal(looksLikeLogin('https://www.codebuddy.cn/profile/usage', {}), false);
  });
});

describe('reader reporting', () => {
  test('a credits report lands on the account, and relogin turns into a reminder', async () => {
    await api('/api/accounts/WorkBuddy', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'credits', executor: 'workbuddy', source: 'reader', balance: 3210, balance_unit: '积分' }),
    });
    let a = listAccounts().find((x: any) => x.name === 'WorkBuddy')!;
    assert.equal(a.balance, 3210);
    assert.equal(a.kind, 'credits');
    assert.equal(a.source, 'reader');

    await api('/api/accounts/WorkBuddy', { method: 'PUT', body: JSON.stringify({ status: 'relogin' }) });
    runReminders();
    a = listAccounts().find((x: any) => x.name === 'WorkBuddy')!;
    assert.equal(a.status, 'relogin');
    assert.equal(tasks().filter((t) => /重新登录 WorkBuddy 读取器/.test(t.title)).length, 1);
  });

  test('readfail is a valid status and asks the user to look at the page', async () => {
    await api('/api/accounts/WorkBuddy', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'credits', executor: 'workbuddy', source: 'reader', balance: 100, balance_unit: '积分' }),
    });
    const res = await api('/api/accounts/WorkBuddy', { method: 'PUT', body: JSON.stringify({ status: 'readfail' }) });
    assert.equal(res.status, 200, 'the reader must be able to set this');
    assert.equal(listAccounts().find((x: any) => x.name === 'WorkBuddy')!.status, 'readfail');

    runReminders();
    const hits = tasks().filter((t) => /读取失败，页面可能改版/.test(t.title));
    assert.equal(hits.length, 1);
    runReminders();
    assert.equal(tasks().filter((t) => /读取失败，页面可能改版/.test(t.title)).length, 1, 'deduped');
  });

  test('only reader.* events may be written from outside', async () => {
    const good = await api('/api/events', { method: 'POST', body: JSON.stringify({ kind: 'reader.failed', text: '读取 WorkBuddy 失败：页面可能改版' }) });
    assert.equal(good.status, 201);
    const bad = await api('/api/events', { method: 'POST', body: JSON.stringify({ kind: 'task.created', text: '伪造一条' }) });
    assert.equal(bad.status, 400);
  });
});

describe('reader safety', () => {
  test('withDeadline gives up instead of hanging forever', async () => {
    const { withDeadline } = await import('../scripts/quota-reader.mjs');
    let killed = false;
    const started = Date.now();
    await assert.rejects(
      () => withDeadline(() => new Promise(() => {}), 40, () => { killed = true; }),
      /超时/,
    );
    assert.equal(killed, true, 'the watchdog hook ran');
    assert.ok(Date.now() - started < 1000, 'it did not wait for the stuck task');
  });

  test('withDeadline passes values and errors through', async () => {
    const { withDeadline } = await import('../scripts/quota-reader.mjs');
    assert.equal(await withDeadline(() => 42, 100), 42);
    await assert.rejects(() => withDeadline(() => Promise.reject(new Error('boom')), 100), /boom/);
  });
});

describe('glm without a coding plan', () => {
  test('a 200 carrying success:false is a failure, not "0% used"', async () => {
    const saved = quotaPayload;
    // This is what a real account without a plan returns (2026-10-29):
    // {"code":500,"msg":"当前用户不存在coding plan","success":false}
    quotaPayload = { code: 500, msg: '当前用户不存在coding plan', success: false };
    db.prepare('DELETE FROM accounts WHERE name = ?').run('GLM Coding Plan');
    db.prepare('DELETE FROM connector_state WHERE name = ?').run('glm');

    const out = await runBalances();
    assert.equal(out.ok, false);
    const row = db.prepare("SELECT last_error FROM connector_state WHERE name = 'glm'").get() as any;
    assert.match(row.last_error, /当前用户不存在coding plan/);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM accounts WHERE name = ?').get('GLM Coding Plan') as any).n, 0,
      'no phantom account with 0% usage');

    quotaPayload = saved;
  });
});
