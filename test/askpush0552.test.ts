// 055.2 · 「等你选」推送：默认关；开了才推；一张卡只推一次；推送里不带问题、选项、正文。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0552p-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0552p-0123456789';

let app: Server;
let hook: Server;
let base = '';
let hookUrl = '';
let cookie = '';
let received: { title: string; body: string; link: string; raw: string }[] = [];
let refuse = false;
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let notify: typeof import('../src/services/notify.ts');

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  notify = await import('../src/services/notify.ts');
  hook = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* not json */ }
      received.push({ title: parsed.title ?? '', body: parsed.body ?? '', link: parsed.link ?? '', raw });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(refuse ? '{"errcode":93000,"errmsg":"refused"}' : '{"errcode":0,"errmsg":"ok"}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  const a = hook.address();
  hookUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/hook`;
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a2 = app.address();
  base = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
});
after(() => { app.close(); hook.close(); });
beforeEach(async () => {
  D.useDb(D.openDb(':memory:'));
  received = [];
  refuse = false;
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

type Res = { status: number; json: any; text: string };
async function call(path: string, method: string, body: unknown, as: 'token' | 'cookie'): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: base };
  if (as === 'cookie') headers.Cookie = cookie; else headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(base + path, { method, redirect: 'manual', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 页面 */ }
  return { status: res.status, json, text };
}
const runner = (path: string, body?: unknown, method = 'POST') => call(path, method, body, 'token');
const human = (path: string, method = 'GET', body?: unknown) => call(path, method, body, 'cookie');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ok: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await sleep(25); }
  return ok();
}

async function claimed(): Promise<number> {
  const t = tasks.createTask({ title: '055.2 推送测试', project: 'ai-workbench', category: 'dev', executor: 'pool', status: 'queued' }, 'me');
  tasks.updateTask(t.id, { start_requested: 1 }, 'me');
  const r = await runner('/api/runner/next?executors=pool&runner=runner-a', undefined, 'GET');
  assert.equal(r.json?.id, t.id, r.text);
  return t.id;
}
const SECRET_Q = '要不要把生产库的密码换掉';
const CARD = [{ key: 'k', title: SECRET_Q, text: '背景：旧密码 hunter2-in-text', options: ['选项甲-保密', '选项乙-保密'] }];
const ask = (id: number, cards: unknown = CARD) => runner(`/api/runner/tasks/${id}/ask`, { ask: cards, result_text: '做到一半', session_id: 's', sandbox: 'none' });
async function channel(kind = 'webhook'): Promise<void> {
  const r = await human('/api/notify/channels', 'POST', { kind, url: hookUrl });
  assert.equal(r.status, 201, r.text);
}
const turnOn = async () => assert.equal((await human('/api/settings/notify-ask', 'POST', { on: '1' })).status, 200);

describe('055.2 · 「等你选」推送', () => {
  test('默认关：配了渠道、任务停在等你选，也不推', async () => {
    await channel();
    const id = await claimed();
    assert.equal((await ask(id)).status, 200);
    await sleep(250);
    assert.equal(received.length, 0);
    assert.equal(await notify.notifyTaskAsk(id), 0);
  });

  test('开关只有登录会话能改；开了再关，值跟着变', async () => {
    const denied = await runner('/api/settings/notify-ask', { on: '1' });
    assert.equal(denied.status, 403);
    assert.deepEqual((await human('/api/settings/notify-ask', 'POST', { on: '1' })).json, { on: true });
    assert.deepEqual((await human('/api/settings/notify-ask', 'POST', { on: '0' })).json, { on: false });
    assert.deepEqual((await human('/api/settings/notify-ask', 'POST', {})).json, { on: false });
  });

  test('开了：只推一条，只说哪个任务在等你；问题、选项、正文都不在推送里', async () => {
    await channel();
    await turnOn();
    assert.equal((await human('/api/dispatch/public-url', 'POST', { url: 'https://wb.example.test' })).status, 200);
    const id = await claimed();
    assert.equal((await ask(id)).status, 200);
    assert.ok(await waitFor(() => received.length >= 1), '应该推了一条');
    await sleep(150);
    assert.equal(received.length, 1);
    assert.equal(received[0].title, `T-${id} 等你选`);
    assert.match(received[0].body, /打开工作台/);
    assert.equal(received[0].link, `https://wb.example.test/tasks?task=${id}`);
    for (const leak of [SECRET_Q, '选项甲', '选项乙', 'hunter2', '做到一半']) {
      assert.ok(!received[0].raw.includes(leak), `推送里不该有：${leak}`);
    }
    const ev = D.db().prepare("SELECT COUNT(*) n FROM events WHERE kind = 'notify.task_asked' AND task_id = ?").get(id) as { n: number };
    assert.equal(ev.n, 1);
  });

  test('一张卡只推一次：重复触发不再推；多个问题时标题写个数', async () => {
    await channel();
    await turnOn();
    const id = await claimed();
    await ask(id, [{ key: 'a', title: '一', options: ['x'] }, { key: 'b', title: '二', options: [] }]);
    assert.ok(await waitFor(() => received.length >= 1));
    assert.equal(received[0].title, `T-${id} 等你选 · 2 个问题`);
    assert.equal(await notify.notifyTaskAsk(id), 0);
    await sleep(150);
    assert.equal(received.length, 1);
  });

  test('回答之后同一个任务再问一轮：是新的一张卡，再推一次', async () => {
    await channel();
    await turnOn();
    const id = await claimed();
    await ask(id);
    assert.ok(await waitFor(() => received.length >= 1));
    assert.equal((await human(`/api/tasks/${id}/answer`, 'POST', { 'a:k': '选项甲-保密' })).status, 200);
    assert.equal((await runner('/api/runner/next?executors=pool&runner=runner-a', undefined, 'GET')).json.id, id);
    await ask(id);
    assert.ok(await waitFor(() => received.length >= 2), '第二张卡应该再推');
    assert.equal(received.length, 2);
  });

  test('推不出去不算推过：渠道拒收时不标已推，渠道好了之后还能补推', async () => {
    await channel('wecom'); // 只有企业微信和飞书会在 200 的正文里报拒收
    await turnOn();
    refuse = true;
    const id = await claimed();
    await ask(id);
    assert.ok(await waitFor(() => received.length >= 1));
    await sleep(100);
    assert.equal(tasks.getTask(id)!.notified_state ?? '', '');
    refuse = false;
    assert.equal(await notify.notifyTaskAsk(id), 1);
    assert.match(tasks.getTask(id)!.notified_state ?? '', /^ask:\d+$/);
  });

  test('不在「等你选」的任务不推；没配渠道也不报错', async () => {
    await turnOn();
    const id = await claimed();
    assert.equal(await notify.notifyTaskAsk(id), 0, '还在跑，没有提问');
    await ask(id);
    assert.equal(await notify.notifyTaskAsk(id), 0, '没配渠道');
    assert.equal(tasks.getTask(id)!.notified_state ?? '', '');
    assert.equal(await notify.notifyTaskAsk(99999), 0);
  });

  test('设置页：通知那一页有「提问也推送」，默认不勾，开了就勾上', async () => {
    const off = (await human('/settings/notify')).text;
    assert.match(off, /data-api="\/api\/settings\/notify-ask"/);
    assert.ok(!/name="on" value="1" checked>提问也推送/.test(off));
    await turnOn();
    assert.match((await human('/settings/notify')).text, /name="on" value="1" checked>提问也推送/);
  });
});
