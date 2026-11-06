// 025：新建任务别再漏填项目；失败原因看得见；「重试合并」只给合并失败的任务。
// 起因是 T-15：项目留空、任务几十秒就失败，失败原因又被「重试合并」盖掉。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';
import { db } from '../src/db.ts';

const TOKEN = 'test-token-0123456789abcdef';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});
after(() => server.close());

async function api(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token === null) { if (cookie) headers.Cookie = cookie; }
  else headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET', headers, redirect: 'manual',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; } // 页面是 HTML
  return { status: res.status, text, json };
}

/** 让工作台以为执行器报了两个项目。 */
const runnerSays = (projects: string[]) => api('/api/runner/heartbeat', {
  method: 'POST',
  // 034：清单一次只展开一步，要到第 6 步（跑第一个任务）才会看到那个按钮，
  // 所以心跳要把自检也报上——否则当前步停在「检查模型后端」。断言一条没改。
  body: { runner: 'r-025', meta: { executors: ['pool'], projects, check: { ok: true, summary: '自检 9/9 项就绪' } } },
});

describe('025 · 新建任务的项目与失败原因', () => {
  test('执行器报了两个项目：下拉里有两个项目加「其他」', async () => {
    await runnerSays(['demo-feed', 'demo-notes']);
    const page = await api('/tasks?new=1', { token: null });
    assert.equal(page.status, 200);
    assert.match(page.text, /data-project-pick/, '项目是下拉');
    assert.match(page.text, /<option value="demo-feed"/);
    assert.match(page.text, /<option value="demo-notes"/);
    assert.match(page.text, /其他（自己填）/);
    assert.match(page.text, /项目（要让 AI 改哪个仓库）/, '标签说清这是要改哪个仓库');
  });

  test('只有一个项目时默认选中它', async () => {
    await runnerSays(['demo-feed']);
    const page = await api('/tasks?new=1', { token: null });
    assert.match(page.text, /<option value="demo-feed" selected>/, '只有一个项目就直接选中');
  });

  test('执行器没报项目：退回输入框并说明去哪配', async () => {
    await runnerSays([]);
    const page = await api('/tasks?new=1', { token: null });
    assert.ok(!page.text.includes('data-project-pick'), '没有项目名就不该装成下拉');
    assert.match(page.text, /还没检测到执行器的项目名/);
    assert.match(page.text, /npm run setup/);
    await runnerSays(['demo-feed', 'demo-notes']);
  });

  test('派给 Agent 不选项目：创建被拦下，并说清怎么办（T-15 复现）', async () => {
    const bad = await api('/api/tasks', { method: 'POST', body: { title: '阅读项目 README', executor: 'pool' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /没有选项目/);
    assert.match(bad.json.error, /编辑任务/);

    const count = (db().prepare("SELECT COUNT(*) n FROM tasks WHERE title = '阅读项目 README'").get() as { n: number }).n;
    assert.equal(count, 0, '被拦下的任务不该进队列');
  });

  test('选「我」不用项目', async () => {
    const mine = await api('/api/tasks', { method: 'POST', body: { title: '给我自己的活', executor: 'me' } });
    assert.equal(mine.status, 201);
  });

  test('项目名不在执行器列表里：能建，但带一句提醒', async () => {
    const r = await api('/api/tasks', { method: 'POST', body: { title: '用个没配过的项目', executor: 'pool', project: 'nope' } });
    assert.equal(r.status, 201);
    assert.match(r.json.warning ?? '', /没有「nope」/);
    assert.match(r.json.warning ?? '', /demo-feed/);
  });

  test('开始前项目被清空：点开始也会被拦', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '项目会被清掉', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/tasks/${t.json.id}`, { method: 'PATCH', body: { project: '' } });
    const start = await api(`/api/tasks/${t.json.id}/start`, { method: 'POST', token: null });
    assert.equal(start.status, 400);
    assert.match(start.json.error, /没有选项目/);
  });

  test('失败原因：详情和卡片都能看到，编辑当前步骤不会盖掉它', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '注定失败的任务', executor: 'pool', project: 'demo-feed' } });
    const id = t.json.id as number;
    await api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body: { result: 'failed', summary: '没有配置项目路径，执行器不知道去哪干活' } });

    const detail = await api(`/tasks?task=${id}`, { token: null });
    assert.match(detail.text, /失败原因/);
    assert.match(detail.text, /没有配置项目路径/);

    const board = await api('/tasks', { token: null });
    assert.match(board.text, /card-reason/, '卡片上也要有一行原因');

    // 改「当前步骤」不该动 fail_reason
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { step: '我随便改一下当前步骤' } });
    const row = db().prepare('SELECT fail_reason, step FROM tasks WHERE id = ?').get(id) as { fail_reason: string; step: string };
    assert.match(row.fail_reason, /没有配置项目路径/);
    assert.equal(row.step, '我随便改一下当前步骤');
  });

  test('失败原因里的 key 形状串会被打码', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '带 key 的失败', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/runner/tasks/${t.json.id}/finish`, {
      method: 'POST', body: { result: 'failed', summary: '调用失败：authorization: Bearer sk-placeholder-leak-1 无效' },
    });
    const row = db().prepare('SELECT fail_reason FROM tasks WHERE id = ?').get(t.json.id) as { fail_reason: string };
    assert.ok(!row.fail_reason.includes('sk-placeholder-leak-1'), row.fail_reason);
  });

  test('失败不写默认分支；成功才写，并生成合并审批', async () => {
    const fail = await api('/api/tasks', { method: 'POST', body: { title: '失败不带分支', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/runner/tasks/${fail.json.id}/finish`, { method: 'POST', body: { result: 'failed', summary: '挂了' } });
    const failedRow = await api(`/api/tasks/${fail.json.id}`);
    assert.equal(failedRow.json.branch, null, '没报分支就是空');

    const ok = await api('/api/tasks', { method: 'POST', body: { title: '成功带默认分支', executor: 'pool', project: 'demo-feed' } });
    const done = await api(`/api/runner/tasks/${ok.json.id}/finish`, { method: 'POST', body: { result: 'done', summary: '做完了' } });
    const okRow = await api(`/api/tasks/${ok.json.id}`);
    assert.equal(okRow.json.branch, `wb/T-${ok.json.id}`, '成功时仍给默认分支');
    assert.ok(done.json.approval_id, '成功要生成合并审批');
  });

  test('页面按钮：失败但不是合并失败 → 有「重新开始」，没有「重试合并」', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '普通失败', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/runner/tasks/${t.json.id}/finish`, { method: 'POST', body: { result: 'failed', summary: '随便挂了' } });
    const page = await api(`/tasks?task=${t.json.id}`, { token: null });
    assert.match(page.text, /重新开始/);
    assert.ok(!page.text.includes('重试合并'), '不该出现「重试合并」');
  });

  test('retry-merge 在 retry 不是 merge 时拒绝（并说清用什么代替）', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '不是合并失败', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/runner/tasks/${t.json.id}/finish`, { method: 'POST', body: { result: 'failed', summary: '挂了' } });
    const res = await api(`/api/tasks/${t.json.id}/retry-merge`, { method: 'POST', token: null });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /不是合并失败/);
    assert.match(res.json.error, /重新开始/);
  });

  test('重新开始：清空失败原因并回到排队', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '要重新开始的', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/runner/tasks/${t.json.id}/finish`, { method: 'POST', body: { result: 'failed', summary: '第一次挂了' } });
    const res = await api(`/api/tasks/${t.json.id}/restart`, { method: 'POST', token: null });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'queued');
    assert.equal(res.json.fail_reason, null);
    assert.equal(res.json.start_requested, 1);
  });

  test('执行器领取时也会清掉旧的失败原因', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '领走时清理', executor: 'pool', project: 'demo-feed' } });
    await api(`/api/runner/tasks/${t.json.id}/finish`, { method: 'POST', body: { result: 'failed', summary: '挂了' } });
    db().prepare("UPDATE tasks SET status = 'queued', start_requested = 1, retry = NULL WHERE id = ?").run(t.json.id);
    // 让这条成为唯一可领的，免得领到前面用例留下的排队任务。
    db().prepare("UPDATE tasks SET status = 'failed' WHERE status = 'queued' AND id <> ?").run(t.json.id);
    const next = await api('/api/runner/next?executors=pool&runner=r-025');
    assert.equal(next.json.id, t.json.id);
    assert.equal(next.json.fail_reason, null, '重新跑就不该还挂着上次的原因');
  });
});

// 025.1：上手清单里的「试试这个」不带项目，点下去直接 400——新用户的第一下就是失败。
describe('025.1 上手清单的示例任务要能真的建成', () => {
  /** 把清单里那个表单的 hidden 字段抓出来，就像用户真的点了按钮。 */
  async function sampleForm(): Promise<Record<string, string> | null> {
    const page = await api('/', { token: null });
    // 清单的提示语里也写着「读一遍 README」，所以只认它出现在 <input name="title"> 里的那种。
    const at = page.text.indexOf('name="title" value="读一遍');
    if (at < 0) return null;
    const form = page.text.slice(page.text.lastIndexOf('<form', at), page.text.indexOf('</form>', at));
    const out: Record<string, string> = {};
    for (const m of form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
  }

  test('执行器报了项目：示例任务带项目，点下去 201', async () => {
    await runnerSays(['demo-feed']);
    const form = await sampleForm();
    assert.ok(form, '清单上要有这个按钮');
    assert.equal(form!.project, 'demo-feed', '示例任务必须带上项目，否则执行器找不到文件夹');
    assert.equal(form!.executor, 'pool', '执行者要是执行器真的有的那个');

    const created = await api('/api/tasks', { method: 'POST', body: form });
    assert.equal(created.status, 201, `清单上的按钮不能一点就 400：${created.text}`);
    assert.equal(created.json.project, 'demo-feed');
  });

  test('没有项目时不给按钮，直接说清楚先去配项目', async () => {
    await runnerSays([]);
    const form = await sampleForm();
    assert.equal(form, null, '没项目就别摆一个点了会失败的按钮');
    const page = await api('/', { token: null });
    assert.match(page.text, /配一个项目/, '要告诉用户下一步');
    await runnerSays(['demo-feed']);
  });
});

// 025.1 第二半：执行器那句「没有配置项目路径」原来带着 CONFIG_FILE 的完整路径（含 Windows 用户名）。
describe('025.1 执行器的失败原因不带本机路径', () => {
  test('提示语里没有配置路径，只说要改哪个名字', async () => {
    const { missingProjectMessage } = await import('../scripts/runner.mjs');
    const msg = missingProjectMessage('demo-feed');
    assert.ok(!/[A-Za-z]:[\\/]/.test(msg), `不该出现盘符路径：${msg}`);
    assert.ok(!msg.includes('.ai-workbench-runner'), '不该出现配置文件');
    assert.match(msg, /demo-feed/, '要说清是哪个项目名没有');
    assert.match(msg, /npm run setup/, '要给下一步');
  });

  test('执行器的打码也会去掉 Windows 用户名', async () => {
    const { redact } = await import('../scripts/runner.mjs');
    const out = redact(String.raw`C:/Users/bob/.ai-workbench-runner.json 读不了`);
    assert.ok(!out.includes('bob'), `用户名漏了：${out}`);
  });
});
