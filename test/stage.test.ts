// 018: every task says who is doing it, which backend it runs on, and how far it got — and a run
// that went silent can be buried with one click.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-stage-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';
delete process.env.GITHUB_REPOS; // the offline banner falls back to the raw command when unset

let app: Server;
let base = '';
let cookie = '';
let db: any;
let stage: typeof import('../src/services/stage.ts');
let tasks: typeof import('../src/services/tasks.ts');
let approvals: typeof import('../src/services/approvals.ts');
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  stage = await import('../src/services/stage.ts');
  tasks = await import('../src/services/tasks.ts');
  approvals = await import('../src/services/approvals.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => app.close());

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

const get = (path: string) => fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
const backdate = (id: number, minutes: number) =>
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - minutes * 60000).toISOString(), id);

describe('018 · 阶段推导', () => {
  test('每种状态都落在唯一的阶段上', async () => {
    const mk = (input: Record<string, unknown>) => tasks.createTask({ title: 'x', executor: 'claude', ...input });
    const queued = mk({});
    const running = mk({ status: 'running' });
    const failed = mk({ status: 'failed' });
    const merged = mk({ status: 'done' });
    db.prepare('UPDATE tasks SET merged_commit = ? , step = ? WHERE id = ?').run('abc1234', '已合并到本地，等推送审批', merged.id);
    const pushed = mk({ status: 'done' });
    db.prepare('UPDATE tasks SET merged_commit = ?, step = ? WHERE id = ?').run('def5678', '已推送到 origin/main', pushed.id);
    const plain = mk({ status: 'done' });

    assert.equal(stage.stageOf(tasks.getTask(queued.id)!), 'queued');
    assert.equal(stage.stageOf(tasks.getTask(running.id)!), 'running');
    assert.equal(stage.stageOf(tasks.getTask(failed.id)!), 'failed');
    assert.equal(stage.stageOf(tasks.getTask(merged.id)!), 'merged');
    assert.equal(stage.stageOf(tasks.getTask(pushed.id)!), 'pushed');
    assert.equal(stage.stageOf(tasks.getTask(plain.id)!), 'done');
  });

  test('审批决定是「等合并」还是「等推送」', async () => {
    const t = tasks.createTask({ title: '要审的', executor: 'claude' });
    approvals.createApproval({ title: '合并 wb/T-1 到 main', task_id: t.id, tool_name: 'git merge' });
    assert.equal(stage.stageOfTask(tasks.getTask(t.id)!), 'merge');
    approvals.createApproval({ title: '推送 main', task_id: t.id, tool_name: 'git push' });
    assert.equal(stage.stageOfTask(tasks.getTask(t.id)!), 'push');
  });

  test('看板和详情都写出来了阶段', async () => {
    const t = tasks.createTask({ title: '等合并的任务', executor: 'claude' });
    approvals.createApproval({ title: '合并 wb/T-1 到 main', task_id: t.id, tool_name: 'git merge' });
    const board = await (await get('/tasks')).text();
    assert.match(board, /等你批准（合并）/);
    const drawer = await (await get(`/tasks?task=${t.id}`)).text();
    assert.match(drawer, /class="stage-bar"/);
    assert.match(drawer, /stage-cell current[^>]*><span class="stage-label">等你批准（合并）/);
  });
});

describe('018 · 换过后端的说明', () => {
  test('详情写清换了谁、为什么，原因已脱敏', async () => {
    const t = tasks.createTask({ title: '换过后端', executor: 'pool', status: 'done' });
    tasks.updateTask(t.id, { backend: 'deepseek' });
    db.prepare('INSERT INTO events (ts, actor, kind, task_id, text) VALUES (?, ?, ?, ?, ?)').run(
      new Date().toISOString(), 'system', 'runner.backend_fallback', t.id,
      `T-${t.id}：bailian 失败（401 Unauthorized {"token":"sk-placeholder-leak-long"}），已换到 deepseek`,
    );
    const html = await (await get(`/tasks?task=${t.id}`)).text();
    assert.match(html, /换过后端：百炼 失败/);
    assert.match(html, /已换到 DeepSeek 官方/);
    assert.ok(!html.includes('sk-placeholder-leak-long'), 'key 不能出现在页面里');
    // The note is redacted on the way in, too: a runner posting an error body stores no secret.
    assert.doesNotMatch(stage.backendSwitchNote(t.id), /sk-placeholder-leak-long/);
  });

  test('事件接口入库前就脱敏，并记住是哪条任务', async () => {
    const t = tasks.createTask({ title: '事件脱敏', executor: 'pool' });
    const res = await fetch(base + '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ kind: 'runner.backend_fallback', task_id: t.id, text: `T-${t.id}：403 {"api_key":"sk-placeholder-stage-1"}` }),
    });
    assert.equal(res.status, 201);
    const row = db.prepare('SELECT task_id, text FROM events WHERE kind = ?').get('runner.backend_fallback') as { task_id: number; text: string };
    assert.equal(row.task_id, t.id);
    assert.ok(!row.text.includes('sk-placeholder-stage-1'), row.text);
  });
});

describe('018 · 执行器在线与否', () => {
  test('没开的时候，任务页和今天页都说清楚，并给出怎么开', async () => {
    for (const path of ['/tasks', '/']) {
      const html = await (await get(path)).text();
      assert.match(html, /执行器没开，点开始后任务会排队/, path);
      // 034：不再甩一句命令，而是把人带到清单里「启动执行器」那一步
      assert.match(html, /怎么开 ↗/, path);
      assert.match(html, /#setup-runner/, path);
      assert.doesNotMatch(html, /执行器在线/, path);
    }
  });

  test('在线时只说在线，不再劝开', async () => {
    await fetch(base + '/api/runner/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runner: 'r-1' }),
    });
    // 044 v3：在线是常态，只在工作台日期前点亮一盏小灯（不再占一行字）。
    const home = await (await get('/')).text();
    assert.match(home, /class="runner-lamp on"[^>]*aria-label="执行器在线"/);
    for (const path of ['/tasks', '/']) assert.doesNotMatch(await (await get(path)).text(), /执行器没开/, path);
  });
});

describe('018 · 卡住的任务', () => {
  test('两倍时长没动静的卡片标橙，详情能一眼看出', async () => {
    const t = tasks.createTask({ title: '一直转圈', executor: 'claude', status: 'running' });
    backdate(t.id, 3 * 45 * 2); // three times the 2× limit (45 min default → 90)
    const board = await (await get('/tasks')).text();
    assert.match(board, /可能卡住了/);
    assert.match(board, /class="card [^"]*stuck/);
    const drawer = await (await get(`/tasks?task=${t.id}`)).text();
    assert.match(drawer, /看起来卡住了/);
    assert.match(drawer, /标记失败/);
  });

  test('刚跑起来的任务不算卡住', async () => {
    const t = tasks.createTask({ title: '刚开始', executor: 'claude', status: 'running' });
    assert.equal(stage.stuckFor(tasks.getTask(t.id)!), null);
    assert.doesNotMatch(await (await get('/tasks')).text(), /可能卡住了/);
  });

  test('标记失败只让人做：令牌 403、网页会话成功并留审计', async () => {
    const t = tasks.createTask({ title: '卡住的', executor: 'claude', status: 'running' });
    backdate(t.id, 300);
    const viaToken = await fetch(base + `/api/tasks/${t.id}/mark-failed`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(viaToken.status, 403);
    const viaCookie = await fetch(base + `/api/tasks/${t.id}/mark-failed`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(viaCookie.status, 200);
    const after = tasks.getTask(t.id)!;
    assert.equal(after.status, 'failed');
    assert.match(after.step, /看起来卡住了（300 分钟没有进度更新）/);
    const ev = db.prepare("SELECT actor, text FROM events WHERE task_id = ? AND kind = 'task.status'").get(t.id) as { actor: string; text: string };
    assert.equal(ev.actor, 'me');
    assert.match(ev.text, /运行中 → 失败/);
  });
});
