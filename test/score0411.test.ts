// 041.1 / 041.2：战绩最容易错的两件事——「这单算谁头上」和「什么叫一次过」。
//
// 041 交付时这两处都有洞：真领取路径（执行器每 10 秒调一次的 /api/runner/next）压根不写
// first_executor，于是最常用的「领取 → 完成」全被跳过；失败一次再重跑成功的，又被算成一次过。
// 这里全部走真实 HTTP 与真实旧库，不用手改状态凑一个好看的数。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0411-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0411-0123456789';
process.env.WB_TZ = 'Asia/Shanghai';

let app: Server;
let base = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let score: typeof import('../src/services/scorecard.ts');
const dirs: string[] = [];
const files: any[] = [];

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  score = await import('../src/services/scorecard.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => {
  app.close();
  for (const db of files) { try { db.close(); } catch { /* 关过了 */ } }
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

/** 建一个「已经点了开始」的任务，等执行器来领。 */
function queued(executor: string): number {
  // 043 F：完成时报的是 no_changes，所以这些单得是「只要回答」的，否则工作台不算它完成。
  const t = tasks.createTask({ title: `T-${executor}`, project: 'ai-workbench', category: 'dev', executor, status: 'queued', answer_only: 1 }, 'me');
  // 建单接口不认 start_requested（那是「开始」按钮写的），这里走同一条更新路径。
  tasks.updateTask(t.id, { start_requested: 1 }, 'me');
  return t.id;
}

/** 执行器真的领一次（和 runner.mjs 调的是同一个接口）。 */
async function claim(executor: string, runner = 'runner-a'): Promise<any> {
  const r = await api(`/api/runner/next?executors=${executor}&runner=${runner}`);
  assert.equal(r.status, 200, `领取失败：${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

async function finish(id: number, body: Record<string, unknown>): Promise<any> {
  const r = await api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

describe('041.1 真领取路径也要记归属', () => {
  test('领取 → 完成，这单进了战绩，不再是 skipped', async () => {
    const id = queued('codex');
    const t = await claim('codex');
    assert.equal(t.id, id);
    assert.equal(t.first_executor, 'codex', '领取那一刻就该写下来');
    await finish(id, { result: 'done', no_changes: true, summary: '只读了文件' });

    const sc = score.scorecard({ days: 30 });
    assert.equal(sc.skipped, 0, '没有理由跳过');
    const row = sc.by_executor.find((c: any) => c.executor === 'codex');
    assert.ok(row, '战绩里得有 codex 这一行');
    assert.equal(row.n, 1);
    assert.equal(row.first_pass_rate, 1);
  });

  test('领了之后失败：仍旧归领它的人，算失败', async () => {
    const id = queued('codex');
    await claim('codex');
    await finish(id, { result: 'failed', summary: '跑挂了' });
    const t = tasks.getTask(id)!;
    assert.equal(t.first_executor, 'codex');
    assert.equal(score.outcomeOf(t), 'failed');
  });

  test('同一次更新里既换人又开跑：算新来的那个', async () => {
    const id = queued('codex');
    // 派给 codex 之后又改成 pool，并且在同一个 patch 里开跑（真实页面上的「改派 + 开始」）。
    const t = tasks.updateTask(id, { executor: 'pool', status: 'running' }, 'me');
    assert.equal(t.executor, 'pool');
    assert.equal(t.first_executor, 'pool', '真正开跑的是 pool，不是改之前那个');
  });

  test('失败后换人重跑：首次归属不覆盖', async () => {
    const id = queued('codex');
    await claim('codex');
    await finish(id, { result: 'failed', summary: '第一次没成' });
    tasks.updateTask(id, { status: 'queued', start_requested: 1, retry: null }, 'me');
    tasks.updateTask(id, { executor: 'pool' }, 'me');
    await claim('pool');
    await finish(id, { result: 'done', no_changes: true, summary: '这次成了' });
    // 041：一个任务只算它第一次开跑的人，换人不改判。
    assert.equal(tasks.getTask(id)!.first_executor, 'codex');
  });
});

describe('041.2 失败重试成功不算一次过', () => {
  test('失败 → 重跑 → 完成：结局是返工', async () => {
    const id = queued('codex');
    await claim('codex');
    await finish(id, { result: 'failed', summary: '第一次挂了' });
    tasks.updateTask(id, { status: 'queued', start_requested: 1, retry: null }, 'me');
    await claim('codex');
    await finish(id, { result: 'done', no_changes: true, summary: '第二次成了' });

    const t = tasks.getTask(id)!;
    assert.equal(t.status, 'done');
    assert.equal(score.outcomeOf(t), 'rework', '失败过一次就不是一次过');

    const sc = score.scorecard({ days: 30 });
    const row = sc.by_executor.find((c: any) => c.executor === 'codex')!;
    assert.equal(row.n, 1);
    assert.equal(row.first_pass_rate, 0);
    assert.equal(row.rework_avg, 1, '失败也算一次返工');
  });

  test('没失败过的完成还是一次过', async () => {
    const id = queued('codex');
    await claim('codex');
    await finish(id, { result: 'done', no_changes: true, summary: '一次做好' });
    assert.equal(score.outcomeOf(tasks.getTask(id)!), 'first_pass');
  });
});

describe('041.1 旧库重算：只认证据，不猜当前人', () => {
  /** 造一个「上一条迁移刚跑完」的库，塞进老数据，再升上来。 */
  function withOldDb(seed: (db: any) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'wb-0411-'));
    dirs.push(dir);
    const file = join(dir, 'workbench.db');
    // 停在这条重算迁移**之前**：它后面还可能有别的迁移（比如 042.2 加列），
    // 用「最后一条 - 1」会在下次加迁移时悄悄跑过这一条，测试就变成假绿。
    const at = (D.MIGRATIONS as string[]).findIndex((m) => m.includes('UPDATE tasks SET first_executor = NULL'));
    assert.ok(at > 0, '找不到 041.1 那条重算迁移');
    const old = D.openDb(file, { at });
    seed(old);
    old.close();
    return file;
  }

  function addTask(db: any, executor: string, at = '2026-10-01T10:00:00.000Z'): number {
    db.prepare(`INSERT INTO tasks (title, description, category, executor, project, status, created_at, updated_at, started_at, completed_at, first_executor)
      VALUES ('老任务', '', 'dev', ?, 'ai-workbench', 'done', ?, ?, ?, ?, 'WRONG')`).run(executor, at, at, at, at);
    return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  function addEvent(db: any, taskId: number, actor: string, kind: string, text: string): void {
    db.prepare(`INSERT INTO events (ts, actor, kind, task_id, text) VALUES (?, ?, ?, ?, ?)`)
      .run('2026-10-01T10:01:00.000Z', actor, kind, taskId, text);
  }

  test('中间换过人：按最早的执行者事件认，不认现在这个', () => {
    const file = withOldDb((db) => {
      const id = addTask(db, 'pool'); // 现在是 pool
      addEvent(db, id, 'codex', 'approval.requested', 'T-1 要合并'); // 实际是 codex 做的
      addEvent(db, id, 'me', 'task.executor', 'codex → pool');
    });
    const up = D.openDb(file);
    files.push(up);
    const row = up.prepare('SELECT first_executor FROM tasks').get() as any;
    assert.equal(row.first_executor, 'codex');
  });

  test('被领取过、从没换人：当前执行者就是当时那个', () => {
    const file = withOldDb((db) => {
      const id = addTask(db, 'codex');
      addEvent(db, id, 'system', 'task.claimed', '执行器 runner-a 领走 T-1');
    });
    const up = D.openDb(file);
    files.push(up);
    const row = up.prepare('SELECT first_executor FROM tasks').get() as any;
    assert.equal(row.first_executor, 'codex');
  });

  test('一点证据都没有：留空，不猜（旧值也清掉）', () => {
    const file = withOldDb((db) => {
      addTask(db, 'codex'); // 种子把 first_executor 写成 WRONG，模拟 041 猜出来的值
    });
    const up = D.openDb(file);
    files.push(up);
    const row = up.prepare('SELECT first_executor FROM tasks').get() as any;
    assert.equal(row.first_executor, null);
  });

  test('领过又换过人：两条证据打架，留空', () => {
    const file = withOldDb((db) => {
      const id = addTask(db, 'pool');
      addEvent(db, id, 'system', 'task.claimed', '执行器 runner-a 领走 T-1');
      addEvent(db, id, 'me', 'task.executor', 'codex → pool');
    });
    const up = D.openDb(file);
    files.push(up);
    const row = up.prepare('SELECT first_executor FROM tasks').get() as any;
    assert.equal(row.first_executor, null);
  });
});
