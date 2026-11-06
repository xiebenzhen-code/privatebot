// 046.8 · 收尾上报不丢：执行器断网重发，同一个 finish_key 工作台只处理一次。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

process.env.WB_TOKEN = 'test-token-0468-0123456789ab';
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server; let base = '';
let D: any; let tasks: any; let runs: any;
before(async () => {
  D = await import('../src/db.ts'); tasks = await import('../src/services/tasks.ts'); runs = await import('../src/services/runs.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => { app.close(); });
beforeEach(() => { D.useDb(D.openDb(':memory:')); });

const finish = (id: number, body: any) => fetch(`${base}/api/runner/tasks/${id}/finish`, {
  method: 'POST', headers: { Authorization: `Bearer ${process.env.WB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('同一个 finish_key 重发：只建一条合并审批、只关一次运行', async () => {
  const t = tasks.createTask({ title: '重发', executor: 'pool', status: 'running', category: 'docs' }, 'me');
  runs.openRun(t.id, 'pool', '');
  const body = { result: 'done', branch: `wb/T-${t.id}`, summary: '改好了', changed_files: ['src/a.ts'], finish_key: 'T1-abcdef-123456' };
  const a = await finish(t.id, body);
  const b = await finish(t.id, body);
  assert.equal(a.duplicate, undefined);
  assert.equal(b.duplicate, true);
  const n = D.db().prepare('SELECT COUNT(*) n FROM approvals WHERE task_id = ?').get(t.id).n;
  assert.equal(n, 1, '第二次不再建审批');
  assert.equal(D.db().prepare('SELECT COUNT(*) n FROM runs WHERE task_id = ?').get(t.id).n, 1);
});

test('不同的键、没有键、乱写的键照旧处理（老执行器不受影响）', async () => {
  const t = tasks.createTask({ title: '老执行器', executor: 'pool', status: 'running', category: 'docs' }, 'me');
  runs.openRun(t.id, 'pool', '');
  const r = await finish(t.id, { result: 'failed', summary: '坏了', finish_key: 'x y' });
  assert.equal(r.status, 'failed');
  assert.equal(r.duplicate, undefined);
});

test('finishReliably：断网重发同一个键，4xx 不重发，次数用完就放弃', async () => {
  const { finishReliably } = await import('../scripts/runner.mjs');
  const seen: any[] = [];
  let n = 0;
  const flaky = async (_c: any, _m: string, _p: string, body: any) => { seen.push(body.finish_key); if (++n < 3) throw new Error('fetch failed'); return { ok: true }; };
  const slept: number[] = [];
  const r = await finishReliably(flaky, {}, 7, { result: 'done' }, { sleep: async (ms: number) => { slept.push(ms); } });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 1, '重发用同一个键');
  assert.match(seen[0], /^T7-[a-z0-9]+-[a-z0-9]+$/);
  assert.deepEqual(slept, [2000, 5000]);

  let calls = 0;
  await assert.rejects(finishReliably(async () => { calls++; throw new Error('POST /x → 404 没有任务'); }, {}, 7, {}, { sleep: async () => {} }), /404/);
  assert.equal(calls, 1, '工作台明确拒绝的不重发');

  calls = 0;
  await assert.rejects(finishReliably(async () => { calls++; throw new Error('fetch failed'); }, {}, 7, {}, { waits: [1, 1], sleep: async () => {} }), /fetch failed/);
  assert.equal(calls, 3);
});
