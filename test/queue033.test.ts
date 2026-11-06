// 033：排队中的任务，为什么还没开始 —— 页面要说清，而不是永远「等执行器领取」。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-queue033-01234567';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;
let app: Server;
let base = '';
let cookie = '';

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  const { handle } = await import('../src/app.ts');
  const { loginCookie } = await import('./helpers.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  cookie = await loginCookie(base, 'test-password-0123456789');
});

after(() => app.close());

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
});

const load = async () => ({
  ...(await import('../src/services/runner.ts')),
  ...(await import('../src/services/tasks.ts')),
});

/** 建一个排队中的任务，并按需点「开始」（createTask 本身不写 start_requested）。 */
async function queued(at: { executor: string; category: string; started?: boolean; title?: string }) {
  const { createTask, updateTask } = await load();
  const t = createTask({ title: at.title ?? '读 README', executor: at.executor, category: at.category }, 'me');
  if (at.started !== false) updateTask(t.id, { start_requested: 1, mode: 'manual' }, 'me');
  return (await load()).getTask(t.id)!;
}

describe('033 排队没开始的原因', () => {
  test('分类不在执行者的接活范围里 → 说清它只接哪些', async () => {
    const { queueBlocker } = await load();
    db.prepare("UPDATE executor_settings SET categories = 'dev,content' WHERE executor = 'pool'").run();
    const b = queueBlocker(await queued({ executor: 'pool', category: 'docs' }));
    assert.ok(b, '应当给出原因');
    assert.equal(b!.code, 'category');
    assert.match(b!.text, /不接「文档」/);
    assert.match(b!.text, /开发 \/ 内容/, `要列出它接什么，实际：${b!.text}`);
  });

  test('分类对上了就不报，只是等轮询', async () => {
    const { queueBlocker } = await load();
    db.prepare("UPDATE executor_settings SET categories = 'dev,content' WHERE executor = 'pool'").run();
    assert.equal(queueBlocker(await queued({ executor: 'pool', category: 'dev' })), null);
  });

  test('手动起手的执行者，没点开始就说「等你点开始」', async () => {
    const { queueBlocker } = await load();
    db.prepare("UPDATE executor_settings SET categories = 'dev,content', auto_allowed = 0 WHERE executor = 'pool'").run();
    const t = await queued({ executor: 'pool', category: 'dev', started: false });
    assert.equal(t.mode, 'manual');
    const b = queueBlocker(t);
    assert.equal(b?.code, 'wait-start');
    assert.match(b!.text, /等你点「开始」/);
  });

  test('只派单不执行的（ZCode）说清要去它自己的窗口里干', async () => {
    const { queueBlocker } = await load();
    const b = queueBlocker(await queued({ executor: 'zcode', category: 'dev' }));
    assert.equal(b?.code, 'handout');
    assert.match(b!.text, /只派单、不执行/);
  });

  test('执行者停用了也说得出来', async () => {
    const { queueBlocker } = await load();
    db.prepare("UPDATE executor_settings SET enabled = 0 WHERE executor = 'pool'").run();
    assert.equal(queueBlocker(await queued({ executor: 'pool', category: 'dev' }))?.code, 'disabled');
  });

  test('自动派单暂停时优先说暂停', async () => {
    const { queueBlocker } = await load();
    db.prepare("INSERT INTO settings (key, value) VALUES ('auto_paused', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    assert.equal(queueBlocker(await queued({ executor: 'pool', category: 'dev' }))?.code, 'paused');
  });

  test('并发满了说满，不跑偏说「等你点开始」', async () => {
    const { queueBlocker, createTask } = await load();
    db.prepare("UPDATE executor_settings SET categories = 'dev,content', max_concurrent = 1 WHERE executor = 'pool'").run();
    createTask({ title: '正在跑', executor: 'pool', category: 'dev', status: 'running' }, 'me');
    assert.equal(queueBlocker(await queued({ executor: 'pool', category: 'dev' }))?.code, 'busy');
  });

  test('不是排队状态就不该有这个提示', async () => {
    const { queueBlocker, createTask } = await load();
    const done = createTask({ title: '完事了', executor: 'pool', category: 'dev', status: 'done' }, 'me');
    assert.equal(queueBlocker(done), null);
  });

  test('详情抽屉把原因显示出来', async () => {
    const { loginCookie } = await import('./helpers.ts');
    const c = await loginCookie(base, 'test-password-0123456789');
    db.prepare("UPDATE executor_settings SET categories = 'dev,content' WHERE executor = 'pool'").run();
    const t = await queued({ executor: 'pool', category: 'docs' });
    const html = await (await fetch(`${base}/tasks?task=${t.id}`, { headers: { Cookie: c } })).text();
    assert.match(html, /data-queue-blocker/, '抽屉里要有这块提示');
    assert.match(html, /不接「文档」/);
  });

  test('正常排队的任务不会多出这块提示', async () => {
    const { loginCookie } = await import('./helpers.ts');
    const c = await loginCookie(base, 'test-password-0123456789');
    db.prepare("UPDATE executor_settings SET categories = 'dev,content' WHERE executor = 'pool'").run();
    const t = await queued({ executor: 'pool', category: 'dev' });
    const html = await (await fetch(`${base}/tasks?task=${t.id}`, { headers: { Cookie: c } })).text();
    assert.ok(!html.includes('data-queue-blocker'));
  });
});
