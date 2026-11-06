// 045：运行与账号槽。守这几件事——
//   重试是新的一条运行，旧的原样留着；老库升级时只给真开跑过的任务补一条；
//   槽只记目录名，目录名带路径一律拒；选槽顺序只有工作台一个出处；
//   到上限不算失败：运行记「到上限」，槽记重置时间，任务回到排队、下次换槽；认不出来不猜。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-045-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-045-0123456789';
process.env.WB_TZ = 'Asia/Shanghai';

let app: Server;
let base = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
let runner: typeof import('../src/services/runner.ts');
let approvals: typeof import('../src/services/approvals.ts');
const dirs: string[] = [];

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts');
  runner = await import('../src/services/runner.ts');
  approvals = await import('../src/services/approvals.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer({ keepAliveTimeout: 60_000 }, (req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => {
  app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  D.useDb(D.openDb(':memory:'));
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

// 049.2 之后只有 claude / workbuddy 能开槽，所以槽相关的用例默认由 claude 领；
// 要验「没配槽的执行者」的那两条显式传 pool。
function queued(executor = 'claude', extra: Record<string, unknown> = {}): number {
  const t = tasks.createTask({ title: '045 测试单', project: 'ai-workbench', category: 'dev', executor, status: 'queued', ...extra }, 'me');
  tasks.updateTask(t.id, { start_requested: 1 }, 'me');
  return t.id;
}

async function claim(executor = 'claude'): Promise<{ status: number; json: any }> {
  return api(`/api/runner/next?executors=${executor}&runner=runner-a`);
}

async function finish(id: number, body: Record<string, unknown>) {
  const r = await api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200, r.text);
  return tasks.getTask(id)!;
}

const slot = (name: string, dir: string, extra: Record<string, unknown> = {}) =>
  runs.createSlot({ name, executor: 'claude', slot_dir: dir, ...extra });

describe('045 · 运行', () => {
  test('领取开一条、收尾关一条；重试是第 2 条，第 1 条原样留着', async () => {
    const id = queued();
    assert.equal((await claim()).json.id, id);
    let list = (await api(`/api/tasks/${id}/runs`)).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].outcome, 'running');
    assert.equal(list[0].route, 'me');

    const t = await finish(id, { result: 'failed', summary: '测试挂了', backend: 'bailian' });
    assert.equal(t.status, 'failed');
    tasks.updateTask(id, { status: 'queued', start_requested: 1 }, 'me');
    assert.equal((await claim()).json.id, id);
    await finish(id, { result: 'done', no_changes: true, result_text: '好了' });

    list = (await api(`/api/tasks/${id}/runs`)).json;
    assert.deepEqual(list.map((r: any) => [r.attempt, r.outcome]), [[1, 'failed'], [2, 'failed']],
      '第二次没改文件又没勾只要回答 → 043 判没干活，仍是失败；关键是第 1 条还在');
    assert.equal(list[0].reason, '测试挂了');
    assert.equal(list[0].backend, 'bailian');
  });

  test('执行器崩了没收尾，再领一次：旧的那条标「被取代」，不删', async () => {
    const id = queued();
    await claim();
    tasks.updateTask(id, { status: 'queued', start_requested: 1 }, 'me');
    await claim();
    const list = runs.listRuns(id);
    assert.deepEqual(list.map((r) => r.outcome), ['cancelled', 'running']);
  });

  test('审批挂到当前那次运行上；你接手 → 这次运行记「你接手了」', async () => {
    const id = queued();
    await claim();
    const a = approvals.createApproval({ title: '跑个命令', task_id: id, tool_name: 'Bash', tool_input: { command: 'ls' } } as any);
    const run = runs.openRunOf(id)!;
    const row = D.db().prepare('SELECT run_id FROM approvals WHERE id = ?').get(a.id) as { run_id: number };
    assert.equal(row.run_id, run.id);
    approvals.decideApproval(a.id, 'takeover', '', 'me');
    assert.equal(runs.listRuns(id)[0].outcome, 'taken_over');
  });

  test('老库升级：只给真开跑过的任务补一条，读不出来的不猜', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-045-'));
    dirs.push(dir);
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    const at = D.versionAfter('CREATE TABLE IF NOT EXISTS runs') - 1;
    for (const m of D.MIGRATIONS.slice(0, at)) old.exec(m);
    old.exec(`PRAGMA user_version = ${at}`);
    const ts = new Date().toISOString();
    const ins = old.prepare(`INSERT INTO tasks (title, status, executor, first_executor, started_at, completed_at, fail_reason, tokens_used, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('做完的', 'done', 'pool', 'pool', ts, ts, null, 1200, ts, ts);
    ins.run('接手过的', 'failed', 'me', 'pool', ts, ts, '挂了', 0, ts, ts);
    ins.run('在跑的', 'running', 'pool', 'pool', ts, null, null, 0, ts, ts);
    ins.run('没开始的', 'inbox', 'pool', null, null, null, null, 0, ts, ts);
    old.close();

    const db = D.openDb(file);
    const rows = db.prepare(`SELECT t.title, r.executor, r.outcome, r.reason, r.tokens, r.backfilled
      FROM runs r JOIN tasks t ON t.id = r.task_id ORDER BY t.id`).all() as any[];
    db.close();
    assert.deepEqual(rows.map((r) => [r.title, r.executor, r.outcome]), [
      ['做完的', 'pool', 'done'],
      ['接手过的', 'pool', 'failed'],
      ['在跑的', 'pool', 'running'],
    ]);
    assert.equal(rows[0].tokens, 1200);
    assert.equal(rows[1].reason, '挂了');
    assert.ok(rows.every((r) => r.backfilled === 1));
  });
});

describe('045 · 账号槽', () => {
  test('目录名只要名字：带路径、盘符、上一级、空、超长一律拒', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', 'C:', '', 'Claude-A', 'x'.repeat(33)]) {
      assert.throws(() => slot(`s${Math.random().toString(36).slice(2, 8)}`, bad), /目录名/, bad);
    }
    assert.equal(slot('claude-a', 'claude-a').state, 'ok');
  });

  test('加槽、改槽只能在网页上：脚本令牌调不动', async () => {
    const r = await api('/api/slots', { method: 'POST', body: JSON.stringify({ name: 'x', executor: 'claude', slot_dir: 'x' }) });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    assert.equal(runs.listSlots().length, 0);
  });

  test('选槽顺序：排除不能用的 → 14 天内到期的先花 → 优先级 → 用得少的', () => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    slot('a-normal', 'a', { slot_priority: 10 });
    slot('b-soon', 'b', { expires_at: new Date(now + 3 * day).toISOString() });
    slot('c-sooner', 'c', { expires_at: new Date(now + 1 * day).toISOString() });
    slot('d-later', 'd', { expires_at: new Date(now + 60 * day).toISOString(), slot_priority: 10 });
    slot('e-off', 'e', { slot_enabled: 0 });
    slot('f-expired', 'f', { expires_at: new Date(now - day).toISOString() });
    slot('g-limited', 'g');
    runs.markSlotLimited('g-limited', new Date(now + 3600_000).toISOString(), now);
    D.db().prepare("UPDATE accounts SET window_pct = 80 WHERE name = 'a-normal'").run();
    assert.deepEqual(runs.orderedSlots('claude', now).map((s) => s.name), ['c-sooner', 'b-soon', 'd-later', 'a-normal']);
  });

  test('领取时带上排好序的槽，只有名字和目录名', async () => {
    slot('claude-a', 'claude-a');
    queued();
    const r = await claim();
    assert.deepEqual(r.json.slots, [{ name: 'claude-a', slot_dir: 'claude-a' }]);
  });

  test('槽全都到上限：不领，任务卡写清在等几点重置', async () => {
    slot('claude-a', 'claude-a');
    runs.markSlotLimited('claude-a', new Date(Date.now() + 3600_000).toISOString());
    const id = queued();
    assert.equal((await claim()).status, 204);
    assert.match(tasks.getTask(id)!.step, /在等 .* 重置/);
    assert.equal(runner.queueBlocker(tasks.getTask(id)!)?.code, 'slots');
  });

  test('没配槽的执行者（走反代池的）照旧领取', async () => {
    const id = queued('pool');
    assert.equal((await claim('pool')).json.id, id);
  });
});

describe('045 · 到额度上限', () => {
  test('报上来的槽真实存在：运行记「到上限」，槽记重置时间，任务回到排队，下一次换槽', async () => {
    slot('claude-a', 'claude-a', { slot_priority: 1 });
    slot('claude-b', 'claude-b', { slot_priority: 2 });
    const id = queued();
    assert.equal((await claim()).json.slots[0].name, 'claude-a');
    const reset = new Date(Date.now() + 2 * 3600_000).toISOString();
    const t = await finish(id, { result: 'limited', slot: 'claude-a', harness: 'claude-code', limit: { kind: 'session', resetAt: reset, raw: 'You\'ve hit your session limit' } });
    assert.equal(t.status, 'queued');
    assert.equal(t.start_requested, 1);
    const r1 = runs.listRuns(id)[0];
    assert.equal(r1.outcome, 'limited');
    assert.equal(r1.slot, 'claude-a');
    assert.equal(r1.harness, 'claude-code');
    const a = runs.listSlots().find((s) => s.name === 'claude-a')!;
    assert.equal(a.state, 'limited');
    assert.equal(a.limited_until, reset);

    const again = await claim();
    assert.equal(again.json.id, id);
    assert.deepEqual(again.json.slots.map((s: any) => s.name), ['claude-b']);
    assert.equal(runs.listRuns(id).length, 2);
  });

  test('重置时间认不出来：1 小时后再试，并写明不知道，不猜', async () => {
    slot('claude-a', 'claude-a');
    const id = queued();
    await claim();
    const before = Date.now();
    await finish(id, { result: 'limited', slot: 'claude-a', limit: { kind: 'weekly', resetAt: 'Nov 7 sometime' } });
    const a = D.db().prepare("SELECT limited_until, reset_note FROM accounts WHERE name = 'claude-a'").get() as any;
    const ms = Date.parse(a.limited_until) - before;
    assert.ok(ms > 55 * 60_000 && ms < 65 * 60_000, String(ms));
    assert.match(a.reset_note, /未知/);
  });

  test('没有槽（或槽不是这个执行者的）却报到上限：当普通失败，不原地打转', async () => {
    const id = queued();
    await claim();
    const t = await finish(id, { result: 'limited', slot: 'nope', limit: { kind: 'session', raw: 'hit your limit' } });
    assert.equal(t.status, 'failed');
    assert.match(t.fail_reason ?? '', /额度上限/);
    assert.equal(runs.listRuns(id)[0].outcome, 'failed');
  });

  test('槽上报不是这个执行者名下的：运行里不记它', async () => {
    runs.createSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const id = queued('pool');
    await claim('pool');
    await finish(id, { result: 'failed', summary: 'x', slot: 'claude-a' });
    assert.equal(runs.listRuns(id)[0].slot, '');
  });
});
