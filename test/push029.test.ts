// 029：任务有结局时说一声。失败必推、完成可选（默认关）、同一次运行只推一次、每任务每天最多 3 条失败。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';
import { db } from '../src/db.ts';

const TOKEN = 'test-token-029-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let hook: Server;
let base = '';
let hookUrl = '';
let received: { title: string; body: string; link: string; raw: string }[] = [];
let refuse = false;
let cookie = '';

before(async () => {
  hook = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* not json */ }
      // 企业微信的正文是 markdown.content，把标题也捞出来方便断言。
      const md = parsed?.markdown?.content ?? '';
      received.push({ title: parsed.title ?? md.split('\n')[0] ?? '', body: parsed.body ?? md, link: parsed.link ?? '', raw });
      if (refuse) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url, hint: [x], from ip: 1.2.3.4' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"errcode":0,"errmsg":"ok"}');
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
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});
after(() => { app.close(); hook.close(); });

beforeEach(() => {
  received = [];
  refuse = false;
  // 每个用例干净的开始：渠道表、设置、任务都清掉。
  db().exec("DELETE FROM notify_channels");
  db().exec("DELETE FROM tasks");
  db().exec("DELETE FROM events WHERE kind LIKE 'notify.%'");
  db().prepare("DELETE FROM settings WHERE key = 'notify_task_done'").run();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text, json };
}

async function channel(kind = 'webhook') {
  // 加渠道是人的操作（human 路由），用浏览器会话。
  const r = await fetch(`${base}/api/notify/channels`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, url: hookUrl }),
  });
  assert.ok(r.status < 300, await r.text());
}

/** 改设置也是人的操作。 */
async function setDone(on: boolean) {
  const r = await fetch(`${base}/api/settings/notify-done`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: on ? '1' : '' }),
  });
  assert.ok(r.status < 300, await r.text());
}

async function newTask(title = '会失败的任务', extra: Record<string, unknown> = {}) {
  const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, executor: 'pool', project: 'demo-feed', ...extra }) });
  assert.equal(r.status, 201, r.text);
  return r.json.id as number;
}

/** 推送里的链接要用「手机访问地址」拼；没填就只推文字（007 的约定）。 */
async function setPublicUrl(url: string) {
  const r = await fetch(`${base}/api/dispatch/public-url`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  assert.ok(r.status < 300, await r.text());
}

/** 执行器报结局（走真实接口，等推送落地）。 */
async function finish(id: number, body: Record<string, unknown>) {
  const r = await api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200, r.text);
  await sleep(120);
  return r.json;
}

/** 模拟「执行器重新领走」：清掉上次的结局记录，让下一次失败能再推。 */
function rearm(id: number) {
  db().prepare("UPDATE tasks SET status = 'running', notified_state = NULL WHERE id = ?").run(id);
}

describe('029 · 失败必推', () => {
  test('一条消息，带任务号和一句原因，带链接', async () => {
    await channel();
    await setPublicUrl('https://wb.example.test');
    const id = await newTask();
    await finish(id, { result: 'failed', summary: '没有合并：本地仓库有 7 个文件没提交。后面还有一句细节。' });

    assert.equal(received.length, 1, '一个渠道一条消息');
    assert.match(received[0].title, new RegExp(`T-${id} 失败`));
    assert.match(received[0].title, /没有合并：本地仓库有 7 个文件没提交/);
    assert.ok(!received[0].title.includes('后面还有一句细节'), '只带第一句，不刷长文');
    assert.match(received[0].link, new RegExp(`/tasks\\?task=${id}$`));
  });

  test('推送里没有 key、没有本机用户名路径', async () => {
    await channel();
    const id = await newTask('带密钥的失败');
    const fakeKey = ['sk', 'abcdef123456'].join('-');
    await finish(id, {
      result: 'failed',
      summary: `调用失败：authorization: Bearer ${fakeKey} 无效，配置在 C:\\Users\\you\\proj\\.env。`,
    });
    const all = received.map((r) => `${r.title} ${r.body} ${r.raw}`).join('\n');
    assert.ok(!all.includes(fakeKey), 'key 要打码');
    assert.ok(!all.includes('Users\\you'), `用户名路径不该出现：${all}`);
  });

  test('同一次失败报两次只推一次；重新开始后再失败会再推', async () => {
    await channel();
    const id = await newTask();
    await finish(id, { result: 'failed', summary: '挂了' });
    assert.equal(received.length, 1);

    await finish(id, { result: 'failed', summary: '挂了' }); // 执行器重试上报
    assert.equal(received.length, 1, '同一次运行不重复推');

    rearm(id);
    await finish(id, { result: 'failed', summary: '又挂了' });
    assert.equal(received.length, 2, '重跑之后的新失败要再推');
    assert.match(received[1].title, /又挂了/);
  });

  test('合并阶段失败（执行器用 PATCH 标的）也会推', async () => {
    await channel();
    const id = await newTask();
    db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
    await api(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', retry: 'merge', fail_reason: '没有合并：本地仓库有 7 个文件没提交。' }),
    });
    await sleep(120);
    assert.equal(received.length, 1, '这种失败最需要人回来看');
    assert.match(received[0].title, /没有合并/);
  });

  test('每任务每天最多 3 条失败', async () => {
    await channel();
    const id = await newTask();
    for (let i = 0; i < 6; i++) {
      rearm(id);
      await finish(id, { result: 'failed', summary: `第 ${i} 次失败` });
    }
    assert.equal(received.length, 3, `应该只推 3 条，实际 ${received.length}`);
    const skipped = db().prepare("SELECT COUNT(*) n FROM events WHERE kind = 'notify.task_skipped' AND task_id = ?").get(id) as { n: number };
    assert.ok(skipped.n > 0, '被上限挡下的事要留痕');
  });
});

describe('029 · 完成推送（默认关）', () => {
  test('默认不推', async () => {
    await channel();
    const id = await newTask('会完成的任务', { answer_only: true }); // 043 F：没改动的完成只给「只要回答」
    await finish(id, { result: 'done', summary: '做完了', no_changes: true });
    assert.equal(received.length, 0);
  });

  test('打开后才推，且不带结果正文', async () => {
    await channel();
    await setDone(true);
    const id = await newTask('有结果的任务', { answer_only: true });
    await finish(id, {
      result: 'done', summary: '做完了', no_changes: true,
      result_text: 'RESULT-MARKER-不该出现在推送里',
    });
    assert.equal(received.length, 1);
    assert.match(received[0].title, new RegExp(`T-${id} 完成`));
    const all = received.map((r) => r.raw).join('\n');
    assert.ok(!all.includes('RESULT-MARKER'), '推送不带结果正文');
  });

  test('开关只有人能改', async () => {
    const res = await fetch(`${base}/api/settings/notify-done`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: '1' }),
    });
    assert.equal(res.status, 403, '脚本令牌不能替人打开推送');
  });
});

describe('029 · 渠道拒绝不刷屏', () => {
  test('企业微信回 200 + errcode：记 notify.failed，不重试成循环', async () => {
    refuse = true;
    await channel('wecom');
    const id = await newTask('关键词不符');
    await finish(id, { result: 'failed', summary: '挂了' });
    await sleep(120);

    const failed = db().prepare("SELECT text FROM events WHERE kind = 'notify.failed'").all() as { text: string }[];
    assert.ok(failed.length >= 1, '被拒要留一条审计');
    assert.match(failed[0].text, /93000|被拒/);
    // 没送出去就不算推过：任务还是可以再试，而且只发了一次请求
    assert.equal(received.length, 1, '一个渠道只请求一次，不重试');
    const row = db().prepare('SELECT notified_state FROM tasks WHERE id = ?').get(id) as { notified_state: string | null };
    assert.equal(row.notified_state, null, '没送达就不能标记成已推送');
  });
});

describe('028.1 执行器 PATCH 写进来的原因也打码', () => {
  test('地址里的凭据在库里、推送里都不出现', async () => {
    await channel();
    const id = await newTask('推不上去');
    db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
    await api(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        retry: 'push',
        fail_reason: '没有推送：unable to access https://user:secret@example.com/x/y.git（403）',
      }),
    });
    await sleep(160);

    const row = db().prepare('SELECT fail_reason FROM tasks WHERE id = ?').get(id) as { fail_reason: string };
    assert.ok(row.fail_reason.includes('***@example.com'), `库里要打码，实际 ${row.fail_reason}`);
    assert.ok(!row.fail_reason.includes('secret'), '密码不该留下');

    const all = received.map((r) => `${r.title} ${r.raw}`).join('\n');
    assert.ok(!all.includes('secret'), `推送里也不该有密码：${all}`);
    assert.ok(all.includes('***@') || all.includes('github.com'), '地址本身可以留');
  });
});
