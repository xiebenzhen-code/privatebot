// 005: balance adapters, the three quota kinds, and the cross-kind reminders.
import { dayOf } from '../src/domain.ts';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-balances-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

let app: Server;
let fake: Server;
let base = '';
let payable: any = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.20', granted_balance: '0.00', topped_up_balance: '8.20' }] };
let db: any;
let runBalances: () => Promise<any>;
let runReminders: () => number;
let listAccounts: () => any[];
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  fake = createServer((req, res) => {
    if (req.url === '/user/balance') {
      if (req.headers.authorization !== `Bearer ${process.env.DEEPSEEK_API_KEY}`) { res.writeHead(401).end('bad key'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payable));
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const a = fake.address();
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

  ({ openDb, useDb } = await import('../src/db.ts'));
  ({ runBalances, runReminders } = await import('../src/services/balances.ts'));
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
  // 027：这些用例看的是完整版的今天页和执行者卡片（额度/积分就在那儿显示）。
  db.prepare("INSERT INTO settings (key, value) VALUES ('ui_mode', 'full') ON CONFLICT(key) DO UPDATE SET value = 'full'").run();
  payable = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.20', granted_balance: '0.00', topped_up_balance: '8.20' }] };
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const tasks = () => db.prepare('SELECT * FROM tasks ORDER BY id').all() as any[];

describe('deepseek balance', () => {
  test('reads the CNY balance and keeps it on the DeepSeek account', async () => {
    const out = await runBalances();
    assert.equal(out.ok, true);
    const a = listAccounts().find((x: any) => x.name === 'DeepSeek')!;
    assert.equal(a.kind, 'balance');
    assert.equal(a.executor, 'pool');
    assert.equal(a.source, 'api');
    assert.equal(a.balance, 8.2);
    assert.equal(a.balance_unit, 'CNY');
    const detail = JSON.parse(a.balance_detail);
    assert.equal(detail.granted, 0);
    assert.equal(detail.topped_up, 8.2);
  });

  test('below the threshold it creates one task, not one per run', async () => {
    await runBalances();
    db.prepare("UPDATE accounts SET low_threshold = 10 WHERE name = 'DeepSeek'").run();
    runReminders();
    const first = tasks().filter((t) => /DeepSeek 余额只剩/.test(t.title));
    assert.equal(first.length, 1);
    assert.match(first[0].title, /¥8\.20/);
    assert.equal(first[0].executor, 'me');
    assert.equal(first[0].category, 'personal');

    runReminders();
    await runBalances();
    assert.equal(tasks().filter((t) => /DeepSeek 余额只剩/.test(t.title)).length, 1, 'no duplicate while it is open');
  });

  test('余额恰好等于提醒线也算到线，照样建一条待办（042-H4）', async () => {
    await runBalances();
    db.prepare("UPDATE accounts SET balance = 10, low_threshold = 10 WHERE name = 'DeepSeek'").run();
    runReminders();
    const rows = tasks().filter((t) => /DeepSeek 余额只剩/.test(t.title));
    assert.equal(rows.length, 1, '等于线也要提醒，不能卡在边界上不吭声');
  });

  test('is_available=false marks the account limited', async () => {
    payable = { ...payable, is_available: false };
    await runBalances();
    assert.equal(listAccounts().find((x: any) => x.name === 'DeepSeek')!.status, 'limited');
  });

  test('an unreachable API records the error instead of throwing', async () => {
    process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1';
    const out = await runBalances();
    assert.equal(out.ok, false);
    const row = db.prepare("SELECT * FROM connector_state WHERE name = 'deepseek'").get() as any;
    assert.ok(row.last_error.length > 0);
    process.env.DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL;
  });
});

describe('manual credits account', () => {
  function creditsAccount(expiresInDays: number | null) {
    const expires = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 86400000).toISOString();
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, kind, balance, balance_unit, expires_at, balance_observed_at)
      VALUES ('WorkBuddy', 'workbuddy', '手动', NULL, '', 'ok', ?, 'credits', 1200, '积分', ?, ?)`)
      .run(new Date().toISOString(), expires, new Date().toISOString());
  }

  test('updating credits refreshes the observation time', async () => {
    creditsAccount(null);
    const before = listAccounts().find((a: any) => a.name === 'WorkBuddy')!.balance_observed_at;
    await new Promise((r) => setTimeout(r, 5));
    const res = await api('/api/accounts/WorkBuddy', { method: 'PUT', body: JSON.stringify({ balance: 900 }) });
    assert.equal(res.status, 200);
    const after = listAccounts().find((a: any) => a.name === 'WorkBuddy')!;
    assert.equal(after.balance, 900);
    assert.notEqual(after.balance_observed_at, before);
  });

  test('credits expiring within three days produce a task', async () => {
    creditsAccount(2);
    runReminders();
    const t = tasks().filter((x) => /WorkBuddy 有积分/.test(x.title));
    assert.equal(t.length, 1);
    assert.match(t[0].title, /2 天后到期/);
    runReminders();
    assert.equal(tasks().filter((x) => /WorkBuddy 有积分/.test(x.title)).length, 1);
  });

  test('credits untouched for over a week ask to be refreshed', async () => {
    creditsAccount(null);
    db.prepare("UPDATE accounts SET balance_observed_at = ? WHERE name = 'WorkBuddy'")
      .run(new Date(Date.now() - 9 * 86400000).toISOString());
    runReminders();
    assert.equal(tasks().filter((t) => /更新一下 WorkBuddy 积分/.test(t.title)).length, 1);
  });
});

describe('bailian voucher estimate', () => {
  function voucherAccount(expiresInDays: number, total = 50, prices: Record<string, any> = { 'deepseek-v4-flash': { in: 1, out: 2 } }) {
    const detail = { voucher_total: total, prices, calibrated_at: null, calibrated_spent: 0 };
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, source, provider,
        kind, balance, balance_unit, balance_detail, expires_at, balance_observed_at)
      VALUES ('百炼代金券', 'pool', '阿里云百炼 · 经 CLIProxyAPI', NULL, '', 'ok', ?, 'api', 'bailian',
        'balance', NULL, 'USD', ?, ?, ?)`).run(
      new Date().toISOString(), JSON.stringify(detail),
      new Date(Date.now() + expiresInDays * 86400000).toISOString(), new Date().toISOString(),
    );
  }
  function spend(id: string, input: number, output: number, model = 'deepseek-v4-flash', ts = new Date().toISOString()) {
    db.prepare(`INSERT INTO usage (source_key, ts, day, executor, account, model, project, input_tokens, output_tokens, cache_tokens)
      VALUES (?, ?, ?, 'pool', '百炼代金券', ?, '', ?, ?, 0)`).run(id, ts, dayOf(ts), model, input, output);
  }

  test('estimates the remaining voucher from priced usage', async () => {
    voucherAccount(120);
    spend('v1', 1_000_000, 500_000);
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 48); // 50 − (1M×1 + 0.5M×2)/1M
    assert.equal(a.balance_estimated, true);
    assert.equal(a.balance_unit, 'USD');
  });

  test('calibration restarts the estimate from the real spend', async () => {
    voucherAccount(120);
    spend('v1', 1_000_000, 500_000);
    const res = await api('/api/accounts/百炼代金券/calibrate', { method: 'POST', body: JSON.stringify({ spent: 10 }) });
    assert.equal(res.status, 200);
    assert.equal(res.json.balance, 40); // 50 − 10，之前的用量不再重复扣

    spend('v2', 1_000_000, 0);
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 39); // 校准点之后又用了 1 美元
  });

  test('a voucher expiring soon with plenty left is nudged once', async () => {
    voucherAccount(10);
    spend('v1', 1000, 500);
    runReminders();
    const hits = tasks().filter((t) => /天后到期，可以多派点任务/.test(t.title));
    assert.equal(hits.length, 1);
    runReminders();
    assert.equal(tasks().filter((t) => /天后到期，可以多派点任务/.test(t.title)).length, 1);
  });

  test('prices keyed by the bl- alias apply to the upstream model name', async () => {
    voucherAccount(120, 50, { 'bl-deepseek-v4-flash': { in: 1, out: 2 } });
    spend('a1', 1_000_000, 0, 'deepseek-v4-flash'); // usage stores the upstream name
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 49);
    assert.equal(a.unpriced_tokens, 0);
  });

  test('vendor-prefixed and dated model ids still find their price', async () => {
    voucherAccount(120, 50, { 'glm-5.3-flash': { in: 1, out: 2 }, 'deepseek-v4.1-flash': { in: 2, out: 8 } });
    spend('n1', 1_000_000, 0, 'ZHIPU/GLM-5.3-Flash');     // 大小写 + 厂商前缀
    spend('n2', 1_000_000, 0, 'deepseek-v4.1-flash-1017'); // 带日期版本
    spend('n3', 1_000_000, 0, 'kimi/kimi-k3.1-pro');       // 确实没定价的仍然算未定价
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 47); // 50 − 1 − 2
    assert.equal(a.unpriced_tokens, 1_000_000);
  });

  test('tokens used at night are charged the off-peak price', async () => {
    voucherAccount(120, 50, { 'deepseek-v4.1-flash': { in: 2, out: 8, offpeak: { in: 1, out: 4 } } });
    spend('p1', 1_000_000, 0, 'deepseek-v4.1-flash', '2026-10-30T03:00:00.000Z'); // 北京 11:00，忙时
    spend('p2', 1_000_000, 0, 'deepseek-v4.1-flash', '2026-10-30T15:00:00.000Z'); // 北京 23:00，闲时
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 47); // 50 − 2（忙时）− 1（闲时）
  });

  test('a model with no separate off-peak price keeps charging the main price at night', async () => {
    voucherAccount(120, 50, { 'deepseek-v4.1-flash': { in: 2, out: 8 } });
    spend('q1', 1_000_000, 0, 'deepseek-v4.1-flash', '2026-10-30T23:00:00.000Z'); // 北京次日 07:00，闲时
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 48);
  });

  test('tokens without a price are reported instead of silently costing nothing', async () => {
    voucherAccount(120, 50, {});
    spend('u1', 1_000_000, 500_000, 'deepseek-v4.1-flash');
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(a.balance, 50, 'nothing to subtract');
    assert.equal(a.unpriced_tokens, 1_500_000, 'so the page can warn about it');
  });

  test('a broken price table is rejected instead of being stored', async () => {
    voucherAccount(120);
    const res = await api('/api/accounts/百炼代金券', { method: 'PUT', body: JSON.stringify({ balance_detail: 'not-json' }) });
    assert.equal(res.status, 400);
    assert.match(res.json.error ?? res.json.message ?? '', /单价表格式不对/);
    const a = listAccounts().find((x: any) => x.name === '百炼代金券')!;
    assert.equal(JSON.parse(a.balance_detail).voucher_total, 50, 'the old table survives');
  });

  test('a voucher expiring within three days is reminded about', async () => {
    voucherAccount(2);
    spend('v1', 10_000_000, 0); // 用掉 10 美元，剩一半以下，不会触发「多派任务」那条
    runReminders();
    assert.equal(tasks().filter((t) => /代金券 2 天后到期/.test(t.title)).length, 1);
  });

  test('a nearly spent voucher is not nudged for expiry', async () => {    voucherAccount(10);
    spend('v1', 40_000_000, 0); // 用掉 40 美元，只剩 10
    runReminders();
    assert.equal(tasks().filter((t) => /可以多派点任务/.test(t.title)).length, 0);
  });
});

describe('window accounts and the workbuddy executor', () => {
  test('a window at 90% or more produces one task', async () => {
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, kind, window_minutes, window_reset_at)
      VALUES ('Codex', 'pool', 'CLIProxyAPI', 92, '', 'ok', ?, 'window', 300, ?)`)
      .run(new Date().toISOString(), new Date(Date.now() + 2 * 3600000).toISOString());
    runReminders();
    const t = tasks().filter((x) => /Codex 5 小时额度已用 92%/.test(x.title));
    assert.equal(t.length, 1);
    runReminders();
    assert.equal(tasks().filter((x) => /已用 92%/.test(x.title)).length, 1);
  });

  test('workbuddy can own a task and shows its credits on the overview', async () => {
    db.prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, kind, balance, balance_unit, balance_observed_at)
      VALUES ('WorkBuddy', 'workbuddy', '手动', NULL, '', 'ok', ?, 'credits', 1200, '积分', ?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    const created = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '用 WorkBuddy 跑一下', executor: 'workbuddy', project: 'demo-feed' }) });
    assert.equal(created.status, 201);
    assert.equal(created.json.executor, 'workbuddy');

    // 040：概览不再铺执行者网格，额度跟着执行者挪到了剧组页的管理块里。
    const page = await api('/team');
    assert.equal(page.status, 200);
    assert.match(page.text, /积分 1200/);
    assert.match(page.text, /WorkBuddy/);
  });
});
