// 046.4 · 任务详情的运行记录标出在不在沙箱里跑：沙箱是黄绿小签，宿主只写淡字（老任务都是宿主，不刷警告）。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

process.env.WB_TOKEN = 'test-token-0464-0123456789ab';
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server; let base = ''; let cookie = '';
let D: any; let tasks: any; let runs: any;
before(async () => {
  D = await import('../src/db.ts'); tasks = await import('../src/services/tasks.ts'); runs = await import('../src/services/runs.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => { app.close(); });
beforeEach(async () => { D.useDb(D.openDb(':memory:')); cookie = await loginCookie(base, process.env.WB_PASSWORD!); });

test('两次运行：一次宿主、一次沙箱，详情里各自标清', async () => {
  const t = tasks.createTask({ title: '沙箱标记', executor: 'pool', status: 'running', category: 'docs' }, 'me');
  runs.openRun(t.id, 'pool', ''); runs.closeRun(t.id, 'failed', { reason: '第一次' });
  runs.openRun(t.id, 'pool', ''); runs.closeRun(t.id, 'done', { sandbox: 'docker' });
  const html = await (await fetch(`${base}/tasks?task=${t.id}`, { headers: { Cookie: cookie } })).text();
  assert.equal((html.match(/data-run-sandbox="docker"/g) ?? []).length, 1);
  assert.equal((html.match(/data-run-sandbox="none"/g) ?? []).length, 1);
  assert.match(html, /▣ 沙箱/);
});
