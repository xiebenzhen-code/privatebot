// 036 D：同一个只读任务交给两个执行者跑，详情里要能并排看到用时和 token。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-compare-036-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;

before(async () => {
  const { openDb, useDb } = await import('../src/db.ts');
  const { handle } = await import('../src/app.ts');
  db = openDb(':memory:');
  useDb(db);
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { app.close(); });

beforeEach(async () => {
  const { openDb, useDb } = await import('../src/db.ts');
  db = openDb(':memory:');
  useDb(db);
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

async function newTask(body: Record<string, unknown>) {
  const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  return r.json.id as number;
}

/** 执行器写不了的两个字段（用时、token）在服务层不开放，直接写库，模拟跑完的那一条。 */
function pretendRan(id: number, tokens: number, startedAt: string, completedAt: string) {
  db.prepare('UPDATE tasks SET status = ?, tokens_used = ?, started_at = ?, completed_at = ? WHERE id = ?')
    .run('done', tokens, startedAt, completedAt, id);
}

describe('036 · 同一个任务的两个执行者并排', () => {
  test('同标题的两条任务在详情里合成一个对比块', async () => {
    const a = await newTask({ title: '读一遍 README', executor: 'dsh', project: 'ai-workbench' });
    const b = await newTask({ title: '读一遍 README', executor: 'pool', project: 'ai-workbench' });
    pretendRan(a, 3237, '2026-10-31T09:53:57.000Z', '2026-10-31T09:54:26.000Z');
    pretendRan(b, 9100, '2026-10-31T10:00:00.000Z', '2026-10-31T10:02:00.000Z');

    const page = await api(`/tasks?task=${a}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-compare/);
    assert.match(page.text, /对比 · 同一个任务跑了 2 次/);
    // 两个执行者都在表里，且当前这条打了「本条」
    assert.match(page.text, /dsh 只读/);
    assert.match(page.text, /反代池/);
    assert.match(page.text, /本条/);
    // 用时和 token 都换成了人话
    assert.match(page.text, /29 秒/);
    assert.match(page.text, /2 分钟/);
    assert.match(page.text, /3\.2K/);
    assert.match(page.text, /9\.1K/);
    // 费用不硬算，明说为什么
    assert.match(page.text, /费用没折算成金额/);
  });

  test('标题不一样的同名项目不进对比', async () => {
    const a = await newTask({ title: '读一遍 README', executor: 'dsh', project: 'ai-workbench' });
    await newTask({ title: '顺手改个拼写', executor: 'pool', project: 'ai-workbench' });
    const page = await api(`/tasks?task=${a}`);
    assert.doesNotMatch(page.text, /data-compare/);
  });

  test('项目不一样的同标题任务不进对比', async () => {
    const a = await newTask({ title: '读一遍 README', executor: 'dsh', project: 'ai-workbench' });
    await newTask({ title: '读一遍 README', executor: 'pool', project: 'demo-first' });
    const page = await api(`/tasks?task=${a}`);
    assert.doesNotMatch(page.text, /data-compare/);
  });

  test('只有一条运行记录时不显示对比块', async () => {
    const a = await newTask({ title: '读一遍 README', executor: 'dsh', project: 'ai-workbench' });
    const page = await api(`/tasks?task=${a}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /data-compare/);
  });
});

describe('036 · siblingRuns 自己', () => {
  test('按创建时间排序，最多四条，不含自己', async () => {
    const { siblingRuns, getTask } = await import('../src/services/tasks.ts');
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(await newTask({ title: '同一件事', executor: i % 2 ? 'pool' : 'dsh', project: 'ai-workbench' }));
    }
    const first = getTask(ids[0])!;
    const others = siblingRuns(first);
    assert.equal(others.length, 4);
    assert.ok(others.every((t) => t.id !== first.id));
    const times = others.map((t) => t.created_at);
    assert.deepEqual(times, [...times].sort());
  });

  test('标题为空的任务不配对，免得把一堆空标题串成一组', async () => {
    const { siblingRuns, getTask } = await import('../src/services/tasks.ts');
    const a = await newTask({ title: 'x', executor: 'dsh', project: 'ai-workbench' });
    const b = await newTask({ title: 'x', executor: 'pool', project: 'ai-workbench' });
    db.prepare('UPDATE tasks SET title = ? WHERE id IN (?, ?)').run('   ', a, b);
    assert.deepEqual(siblingRuns(getTask(a)!), []);
  });
});
