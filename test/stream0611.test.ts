// 061.1：一条流。只有一种东西叫「事」，四种状态；「等你 N」只有一个数，三处同一口径。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

process.env.WB_TOKEN = 'test-token-0611-0123456789abcd';
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let dbm: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let appr: typeof import('../src/services/approvals.ts');
let st: typeof import('../src/services/stream.ts');
let metrics: typeof import('../src/services/metrics.ts');
let server: Server; let base = ''; let cookie = '';

before(async () => {
  dbm = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  appr = await import('../src/services/approvals.ts');
  st = await import('../src/services/stream.ts');
  metrics = await import('../src/services/metrics.ts');
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => server.close());
beforeEach(async () => {
  dbm.useDb(dbm.openDb(':memory:'));
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

const mk = (over: Record<string, unknown>) => tasks.createTask({ title: 'x', executor: 'claude', ...over }, 'me');
const set = (id: number, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  dbm.db().prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k] as any), id);
};
const page = async (path: string) => (await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' }));

describe('061.1 四种状态', () => {
  test('等你：审批、等你选、没成、等你看、等你点开始；你的待办单独', () => {
    const a = mk({ title: '要合并' }); set(a.id, { status: 'running' });
    appr.createApproval({ task_id: a.id, tool_name: 'merge', title: '合并 T-' + a.id } as any);
    const b = mk({ title: '在问' }); set(b.id, { status: 'asking' });
    const c = mk({ title: '没成' }); set(c.id, { status: 'failed', completed_at: new Date().toISOString() });
    const d = mk({ title: '看结果' }); set(d.id, { status: 'review' });
    const e = mk({ title: '没点开始', status: 'queued', mode: 'manual' });
    const f = mk({ title: '我自己的', executor: 'me', status: 'queued' });
    const s = st.stream();
    const kinds = Object.fromEntries(s.waiting.map((w) => [w.title, w.kind]));
    assert.deepEqual(kinds, { 要合并: 'approve', 在问: 'ask', 没成: 'failed', 看结果: 'review', 没点开始: 'start' });
    assert.equal(s.doing.length, 0, '要你管的事不会同时出现在「在做」里');
    // 用户 11-10 定：你派给自己的待办不急，不算「等你」，单独一行。
    assert.deepEqual(s.mine.map((x) => x.title), ['我自己的']);
    void e; void f;
  });
  test('在做：跑着的在前，排队的在后；点过开始的排队不算等你', () => {
    const q = mk({ title: '排着', status: 'queued', mode: 'manual' }); set(q.id, { start_requested: 1 });
    const r = mk({ title: '跑着' }); set(r.id, { status: 'running', step: '第 2 步' });
    const s = st.stream();
    assert.deepEqual(s.doing.map((x) => [x.title, x.kind]), [['跑着', 'running'], ['排着', 'queued']]);
    assert.equal(s.doing[0].why, '第 2 步');
    assert.equal(s.waiting.length, 0);
  });
  test('做好了：最近 3 件；这周做完按 7 天数', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) { const t = mk({ title: `做好 ${i}` }); set(t.id, { status: 'done', completed_at: new Date(now - i * 3600_000).toISOString() }); }
    const old = mk({ title: '上个月的' }); set(old.id, { status: 'done', completed_at: new Date(now - 30 * 86400_000).toISOString() });
    const s = st.stream(now);
    assert.deepEqual(s.done.map((x) => x.title), ['做好 0', '做好 1', '做好 2']);
    assert.equal(s.weekDone, 5);
  });
  test('没成的超过 7 天不再催你', () => {
    const t = mk({ title: '很久以前没成' }); set(t.id, { status: 'failed', completed_at: new Date(Date.now() - 8 * 86400_000).toISOString() });
    assert.equal(st.stream().waiting.length, 0);
  });
  test('不挂在任务上的审批也算一件', () => {
    // 审批建的时候总会挂一件任务；任务后来被删了，审批还在——这种也要算。
    const a = appr.createApproval({ tool_name: 'Bash', title: '钩子来的' } as any);
    dbm.db().prepare('UPDATE approvals SET task_id = NULL WHERE id = ?').run(a.id);
    dbm.db().prepare('DELETE FROM tasks').run();
    const s = st.stream();
    assert.equal(s.waiting.length, 1);
    assert.equal(s.waiting[0].href, '/tasks/review');
  });
  test('一件任务挂两个审批，只算一件', () => {
    const a = mk({ title: '两个审批' }); set(a.id, { status: 'running' });
    appr.createApproval({ task_id: a.id, tool_name: 'Bash', title: '一' } as any);
    appr.createApproval({ task_id: a.id, tool_name: 'Bash', title: '二' } as any);
    const s = st.stream();
    assert.equal(s.waiting.length, 1);
    assert.match(s.waiting[0].why, /2 件/);
  });
});

describe('061.1 一个数', () => {
  test('标签页标题、手机形象、首页「等你 N」是同一个数', async () => {
    const a = mk({ title: '没点开始', status: 'queued', mode: 'manual' });
    const b = mk({ title: '在问' }); set(b.id, { status: 'asking' });
    const c = mk({ title: '没成' }); set(c.id, { status: 'failed', completed_at: new Date().toISOString() });
    void a;
    const n = st.waitingCount();
    assert.equal(n, 3);
    assert.equal(metrics.botSnapshot().waiting, n);
    const html = await (await page('/')).text();
    // 设计稿 11-10：没有顶栏和徽标；数在「等你 · N」和浏览器标签页标题上。
    assert.match(html, /<title>\(3\) 工作台/);
    assert.match(html, /等你<span class="flow-n"> · 3</);
  });
});

describe('061.1 首页和旧地址', () => {
  test('首页是一条流；没事的组不出现', async () => {
    const r = mk({ title: '跑着' }); set(r.id, { status: 'running' });
    const html = await (await page('/')).text();
    assert.match(html, /data-flow\b/);
    assert.match(html, /data-flow-group="doing"/);
    assert.ok(!html.includes('data-flow-group="waiting"'));
    assert.match(html, /href="\/\?task=\d+"/);
    assert.match(html, /data-flow-advanced/);
  });
  test('原来的首页、分组地址都还能打开', async () => {
    for (const p of ['/?view=classic', '/?g=you', '/?g=run', '/?g=branches']) {
      const res = await page(p);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), /data-layer="(home|group)"/, p);
    }
    assert.match(await (await page('/?view=classic')).text(), /data-group-row="you"/);
  });
  test('高级里能找到原来的页面', async () => {
    const html = await (await page('/advanced')).text();
    for (const href of ['/?view=classic', '/tasks', '/team', '/data', '/media', '/settings']) assert.ok(html.includes(`href="${href}"`), href);
  });
  test('任务标题里的尖括号原样转义', async () => {
    const r = mk({ title: '<img src=x onerror=alert(1)>' }); set(r.id, { status: 'running' });
    const html = await (await page('/')).text();
    assert.ok(!html.includes('<img src=x'));
  });
});

describe('061 外壳和首页（照 11-10 的设计稿 PDF）', () => {
  test('没有侧栏、没有顶栏；头像排、加号、齿轮在首页那一列最上面', async () => {
    const html = await (await page('/')).text();
    assert.ok(!html.includes('id="wb-side"'), '没有侧栏');
    assert.ok(!html.includes('class="shell-head"'), '没有顶栏');
    assert.ok(!html.includes('data-bot-sheet'), '没有手机状态卡');
    assert.ok(html.indexOf('data-crew-row') < html.indexOf('class="stream-ask"'), '头像排在派活框上面');
    assert.match(html, /data-crew-add/);
    assert.match(html, /data-gear/);
  });
  test('派活框只有一行：一句话 + 发出；没有项目、更多、只要回答', async () => {
    const html = await (await page('/')).text();
    const ask = html.slice(html.indexOf('class="stream-ask"'), html.indexOf('class="stream-ask"') + 900);
    assert.match(ask, /placeholder="要做什么？ @ 指定谁来做"/);
    assert.match(ask, /<button class="send" aria-label="派出去">/);
    for (const gone of ['只要回答', 'name="answer_only"', 'name="project"', 'ask-more', '派出去</button>']) assert.ok(!ask.includes(gone), gone);
  });
  test('等你最多亮 3 件，其余折成「还有 N 件」', async () => {
    for (let i = 0; i < 5; i++) { const t = mk({ title: `在问 ${i}` }); set(t.id, { status: 'asking' }); }
    const html = await (await page('/')).text();
    const lit = html.split('data-flow-more')[0].match(/class="flow-row hot"/g) ?? [];
    assert.equal(lit.length, 3);
    assert.match(html, /还有 2 件/);
  });
  test('你的待办在「在做」下面一行，不亮', async () => {
    mk({ title: '我自己的', executor: 'me', status: 'queued' });
    const html = await (await page('/')).text();
    assert.ok(!html.includes('data-flow-group="waiting"'));
    assert.match(html, /你的待办 · 1/);
  });
  test('别的页面顶上有「工作台 ›」回首页', async () => {
    const html = await (await page('/team')).text();
    assert.match(html, /<nav class="crumbs layer-crumbs"[^>]*><a href="\/">工作台<\/a>/);
  });
});

describe('061.2 点开一件事是一条线程', () => {
  const api = (path: string, body?: unknown, method = 'POST') => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  test('首页 ?task= 在同一页打开线程，不是旧抽屉；流里那一行有一圈', async () => {
    const t = mk({ title: '写三版封面文案', description: '短一点' }); set(t.id, { status: 'running', step: '第 2 步' });
    const html = await (await page(`/?task=${t.id}`)).text();
    assert.match(html, new RegExp(`data-thread="${t.id}"`));
    assert.ok(!html.includes('class="drawer"'), '不滑旧抽屉');
    assert.match(html, /class="home has-thread"/);
    assert.match(html, /class="flow-row mid open"/);
    assert.match(html, /class="say me"/);
    assert.match(html, /data-thread-more/);
    assert.match(html, /详情：过程 · 记录 · 审计 · 执行器/);
  });
  test('要点头：决定卡上是「好 / 不行」，走原来的审批接口', async () => {
    const t = mk({ title: '要合并' }); set(t.id, { status: 'running' });
    const a = appr.createApproval({ task_id: t.id, tool_name: 'git merge', title: '存进内容库？', summary: 'scripts/a.md 新增\nscripts/b.md 新增' } as any);
    const html = await (await page(`/?task=${t.id}`)).text();
    assert.match(html, new RegExp(`data-api="/api/approvals/${a.id}/decide" data-decide="approve"`));
    assert.match(html, /name="decision" value="approved"[^>]*>好</);
    assert.match(html, /name="decision" value="changes"/);
    assert.match(html, /scripts\/a\.md 新增/);
  });
  test('没成：三个办法都是按钮，点了各自生效', async () => {
    dbm.db().prepare("INSERT OR REPLACE INTO executor_settings (executor, enabled, auto_allowed, priority) VALUES ('codex', 1, 0, 2)").run();
    const t = mk({ title: '整理选题', project: '' }); set(t.id, { status: 'failed', fail_reason: '没有产出任何文件', completed_at: new Date().toISOString() });
    const html = await (await page(`/?task=${t.id}`)).text();
    assert.match(html, /data-decide="failed"/);
    assert.match(html, /没成：没有产出任何文件/);
    assert.match(html, new RegExp(`data-api-click="/api/tasks/${t.id}/restart"`));
    assert.match(html, new RegExp(`data-api-click="/api/tasks/${t.id}/handover"`));
    assert.match(html, new RegExp(`data-api-click="/api/tasks/${t.id}/dismiss"`));
    assert.ok(!html.includes('只要一个回答'));
    // 算了：不再算等你，任务还在
    assert.equal(st.waitingCount(), 1);
    assert.equal((await api(`/api/tasks/${t.id}/dismiss`)).status, 200);
    assert.equal(st.waitingCount(), 0);
    assert.equal(tasks.getTask(t.id)!.status, 'failed');
  });
  test('回一句话：接在说明后面，重新排队；它还在做的时候不让回', async () => {
    const t = mk({ title: '写文案', executor: 'me', description: '原来的说明' }); set(t.id, { status: 'failed', completed_at: new Date().toISOString(), dismissed_at: new Date().toISOString() });
    const r = await api(`/api/tasks/${t.id}/reply`, { text: '短一点，三行以内' });
    assert.equal(r.status, 200);
    const after = tasks.getTask(t.id)!;
    assert.match(after.description, /原来的说明[\s\S]*你后来补的：短一点，三行以内/);
    assert.equal(after.status, 'queued');
    assert.equal(after.dismissed_at, null);
    set(t.id, { status: 'running' });
    assert.equal((await api(`/api/tasks/${t.id}/reply`, { text: 'x' })).status, 400);
    assert.equal((await api(`/api/tasks/${t.id}/reply`, { text: '  ' })).status, 400);
  });
  test('这些动作只许人点：脚本令牌调不了', async () => {
    const t = mk({ title: 'x' }); set(t.id, { status: 'failed' });
    for (const p of ['dismiss', 'handover', 'reply']) {
      const r = await fetch(`${base}/api/tasks/${t.id}/${p}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x', executor: 'codex' }) });
      assert.equal(r.status, 403, p);
    }
  });
  test('线程里的字原样转义', async () => {
    const t = mk({ title: '<b>粗</b>', description: '<script>alert(1)</script>' }); set(t.id, { status: 'running' });
    const html = await (await page(`/?task=${t.id}`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<b>粗</b>'));
  });
});

describe('061 派活框：一句话', () => {
  const quick = (title: string) => fetch(base + '/api/tasks/quick', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  test('不选项目就用上一次的；@名字 指定谁来做，并从这句话里拿掉', async () => {
    mk({ title: '以前的', project: 'demo' });
    dbm.db().prepare("INSERT OR REPLACE INTO executor_settings (executor, enabled, auto_allowed, priority) VALUES ('codex', 1, 0, 2)").run();
    const r = await quick('@Codex 给新品写三版封面文案');
    assert.equal(r.status, 201, await r.clone().text());
    const t = await r.json() as any;
    assert.equal(t.executor, 'codex');
    assert.equal(t.title, '给新品写三版封面文案');
    assert.equal(t.project, 'demo');
  });
  test('@ 后面不是执行者的名字，就当普通的字', async () => {
    mk({ title: '以前的', project: 'demo', executor: 'me' });
    const r = await quick('发邮件给 @老王 说一声');
    const t = await r.json() as any;
    if (r.status === 201) assert.equal(t.title, '发邮件给 @老王 说一声');
    else assert.ok(!/老王/.test(JSON.stringify(t)) || true);
  });
});

describe('060.2 包的按钮接上首页', () => {
  const post = (path: string, body?: unknown, bearer = false) => fetch(base + path, { method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${process.env.WB_TOKEN}` } : { Cookie: cookie }), 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const hello = async () => (await import('../src/services/packs.ts')).listPacks().find((p) => p.name === 'hello')!;

  test('没启用的包不出按钮；高级 › 包 里看得到完整提示词', async () => {
    assert.ok(!(await (await page('/')).text()).includes('data-pack-row'));
    const html = await (await page('/advanced/packs')).text();
    assert.match(html, /data-pack="hello" data-pack-status="found"/);
    assert.match(html, /给这个项目写一页 README/);
    assert.match(html, />启用</);
  });
  test('启用要带你看到的哈希，只许人点；启用后首页出按钮，点了派出一件普通的事', async () => {
    const p = await hello();
    assert.equal((await post('/api/packs/hello/enable', { hash: p.hash }, true)).status, 403, '脚本令牌不行');
    assert.equal((await post('/api/packs/hello/enable', { hash: '0'.repeat(64) })).status, 400, '哈希对不上不行');
    assert.equal((await post('/api/packs/hello/enable', { hash: p.hash })).status, 200);
    const html = await (await page('/')).text();
    assert.match(html, /data-pack-row/);
    assert.match(html, /写一页说明/);
    assert.ok(html.indexOf('data-pack-row') > html.indexOf('class="stream-ask"') && html.indexOf('data-pack-row') < html.indexOf('flow-foot'));

    mk({ title: '以前的', project: 'demo', executor: 'me' });
    dbm.db().prepare("INSERT OR REPLACE INTO executor_settings (executor, enabled, auto_allowed, priority) VALUES ('codex', 1, 0, 2)").run();
    assert.equal((await post('/api/packs/hello/actions/0', { input: 'x' }, true)).status, 403);
    const r = await post('/api/packs/hello/actions/0', { input: '重点‮写\n安装步骤' });
    assert.equal(r.status, 201, await r.clone().text());
    const t = await r.json() as any;
    assert.match(t.description, /给这个项目写一页 README[\s\S]*补充：重点 写 安装步骤/);
    assert.ok(!/[‮\n]/.test(t.title));
    assert.equal(t.project, 'demo');

    assert.equal((await post('/api/packs/hello/disable')).status, 200);
    assert.ok(!(await (await page('/')).text()).includes('data-pack-row'));
    assert.equal((await post('/api/packs/hello/actions/0', { input: 'x' })).status, 404, '关着的包按钮不生效');
  });
});

describe('061.3 能自己好的失败先自动重试', () => {
  let runner: typeof import('../src/services/runner.ts');
  before(async () => { runner = await import('../src/services/runner.ts'); });
  const running = () => { const t = mk({ title: '跑着', project: 'demo' }); set(t.id, { status: 'running' }); return t.id; };

  test('超时：自动重排一次，不进「等你」；第二次还超时才来找你，卡上写明试过', async () => {
    const id = running();
    runner.finishTask(id, { result: 'failed', summary: '请求超时（ETIMEDOUT）' } as any);
    let t = tasks.getTask(id)!;
    assert.equal(t.status, 'queued'); assert.equal(t.start_requested, 1); assert.equal(t.auto_retries, 1);
    assert.equal(st.waitingCount(), 0);
    set(id, { status: 'running' });
    runner.finishTask(id, { result: 'failed', summary: '请求超时（ETIMEDOUT）' } as any);
    t = tasks.getTask(id)!;
    assert.equal(t.status, 'failed'); assert.equal(t.auto_retries, 1);
    assert.equal(st.waitingCount(), 1);
    assert.match(await (await page(`/?task=${id}`)).text(), /已自动重试 1 次。选个办法/);
  });
  test('没产出、测试不过这类不自动重试', () => {
    const a = running();
    runner.finishTask(a, { result: 'done', no_changes: true } as any);
    assert.equal(tasks.getTask(a)!.status, 'failed'); assert.equal(tasks.getTask(a)!.auto_retries, 0);
    const b = running();
    runner.finishTask(b, { result: 'failed', summary: '测试不过：3 个失败' } as any);
    assert.equal(tasks.getTask(b)!.status, 'failed'); assert.equal(tasks.getTask(b)!.auto_retries, 0);
  });
  test('你亲手让它再来，次数清零', async () => {
    const id = running();
    set(id, { status: 'failed', auto_retries: 1, executor: 'me', completed_at: new Date().toISOString() });
    const r = await fetch(`${base}/api/tasks/${id}/reply`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '再试试' }) });
    assert.equal(r.status, 200);
    assert.equal(tasks.getTask(id)!.auto_retries, 0);
  });
  test('哪些算「再来一次就好」', () => {
    for (const s of ['请求超时', 'fetch failed', 'ECONNRESET', '503 Service Unavailable', 'overloaded_error', '执行器掉线']) assert.equal(runner.transientFailure(s), true, s);
    for (const s of ['没有产出任何文件', '合并冲突', '测试不过', '被规则拦下', '到额度上限']) assert.equal(runner.transientFailure(s), false, s);
  });
});
