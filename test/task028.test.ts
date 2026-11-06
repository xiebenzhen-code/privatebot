// 028：任务的输出看得见——模型的最终回答、没有改动就不用合并、合并失败要说人话、过程记录。
// 起因是 T-17：只读任务「阅读项目 README」模型明明读完了，却显示失败、原因写「没有记录原因」、
// 答案在哪完全看不到。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginCookie } from './helpers.ts';
import { db } from '../src/db.ts';

const TOKEN = 'test-token-028-0123456789abcd';
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
});
after(() => server.close());

beforeEach(async () => {
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

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
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text, json };
}

/** 建一个排队中的任务，并让执行器领走它（这样 finish 才像真的跑过一轮）。 */
async function claimed(title = '阅读项目 README', executor = 'pool') {
  await api('/api/runner/heartbeat', { method: 'POST', body: { runner: 'r-028', meta: { executors: ['pool'], projects: ['demo-feed'] } } });
  // 前面的用例可能留下别的排队/在跑的任务（执行者有并发上限），先清场，保证领到的就是这一单。
  db().prepare("UPDATE tasks SET status = 'inbox' WHERE status = 'queued'").run();
  db().prepare("UPDATE tasks SET status = 'failed' WHERE status = 'running'").run();
  // 043 F：这组测的都是「只读任务」，就得勾上「只要一个回答」。
  const t = await api('/api/tasks', { method: 'POST', body: { title, executor, project: 'demo-feed', answer_only: true } });
  assert.equal(t.status, 201, t.text);
  db().prepare("UPDATE tasks SET status = 'queued', start_requested = 1 WHERE id = ?").run(t.json.id);
  const next = await api('/api/runner/next?executors=pool&runner=r-028');
  assert.equal(next.json?.id, t.json.id, '执行器应该领到这一单');
  return t.json.id as number;
}

const finish = (id: number, body: Record<string, unknown>) =>
  api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body });

const logRows = (id: number) =>
  db().prepare('SELECT line FROM task_log WHERE task_id = ? ORDER BY id').all(id) as { line: string }[];

describe('028 · 只读任务：结果看得见，不用合并', () => {
  test('模型回答存下来、任务完成、没有合并审批、分支是空的', async () => {
    const id = await claimed();
    const answer = '这份 README 说了三件事：\n1. 它是个人工作台\n2. 用 SQLite 存数据\n3. 审批在网页上做';
    const r = await finish(id, { result: 'done', summary: '读完了', result_text: answer, no_changes: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'done');
    assert.equal(r.json.approval_id, null, '没有改动就不该有合并审批');

    const row = db().prepare('SELECT status, step, branch, result_text FROM tasks WHERE id = ?').get(id) as any;
    assert.equal(row.status, 'done');
    assert.equal(row.branch, null, '没有改动就不该写分支');
    assert.match(row.step, /没有改动，不需要合并/);
    assert.equal(row.result_text, answer, '回答原样存下来');

    const page = await api(`/tasks?task=${id}`, { token: null });
    assert.match(page.text, /data-result/, '详情页要有一个「结果」区块');
    assert.match(page.text, />✓ 结果</); // 044 v3：结果先折着，标题前一个 ✓
    assert.ok(page.text.includes('这份 README 说了三件事'), '结论要显示出来');
    // 028.1 起结果按 Markdown 排版：编号列表变成 <ol><li>，不再是一段 pre。
    assert.ok(page.text.includes('<li>它是个人工作台</li>'), '列表要渲染成列表项');
    assert.ok(page.text.includes('<li>用 SQLite 存数据</li>'));
  });

  test('看板卡片上标「有结果」', async () => {
    const id = await claimed('再读一遍 README');
    await finish(id, { result: 'done', summary: '读完了', result_text: '结论：能干活的看板', no_changes: true });
    // 完成的任务在「已完成」列表里，卡片标记也在那里（看板只看没完成的）。
    const done = await api('/tasks/done', { token: null });
    assert.match(done.text, /有结果/);
  });

  test('有改动的任务照旧走合并审批，结果也存', async () => {
    const id = await claimed('给抓取加去重');
    const r = await finish(id, { result: 'done', summary: '改了 2 个文件', result_text: '加了 seen 集合', branch: 'wb/T-x', commit: 'abc1234' });
    assert.equal(r.json.status, 'done');
    assert.ok(r.json.approval_id, '有改动就要批合并');
    const row = db().prepare('SELECT branch, result_text FROM tasks WHERE id = ?').get(id) as any;
    assert.equal(row.branch, 'wb/T-x');
    assert.equal(row.result_text, '加了 seen 集合', '有改动的任务也存结果');
  });
});

describe('028 · 失败原因别再说「没有记录原因」', () => {
  test('失败原因不为空：红框显示它', async () => {
    const id = (await api('/api/tasks', { method: 'POST', body: { title: '会失败的', executor: 'pool', project: 'demo-feed' } })).json.id;
    await api(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: { status: 'failed', retry: 'merge', fail_reason: '没有合并：主仓库 demo-feed 里有 2 个文件没提交。先提交或暂存它们，再点「重试合并」。' },
    });
    const page = await api(`/tasks?task=${id}`, { token: null });
    assert.match(page.text, /没有合并：主仓库 demo-feed 里有 2 个文件没提交/);
    assert.match(page.text, /重试合并/);
  });

  test('失败原因为空时退而显示「当前步骤」', async () => {
    const id = (await api('/api/tasks', { method: 'POST', body: { title: '只有步骤', executor: 'pool', project: 'demo-feed' } })).json.id;
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'failed', step: '合并失败：CONFLICT in src/app.ts' } });
    const page = await api(`/tasks?task=${id}`, { token: null });
    assert.match(page.text, /CONFLICT in src\/app\.ts/);
    assert.match(page.text, /这是执行器最后报的「当前步骤」/, '要说清这只是步骤，不是专门的原因');
    assert.ok(!page.text.includes('没有记录原因'), '不能再出现「没有记录原因」');
  });

  test('两样都没有：让它说人话并指路执行器窗口', async () => {
    const id = (await api('/api/tasks', { method: 'POST', body: { title: '什么也没说', executor: 'pool', project: 'demo-feed' } })).json.id;
    db().prepare("UPDATE tasks SET status = 'failed', step = '', fail_reason = NULL WHERE id = ?").run(id);
    const page = await api(`/tasks?task=${id}`, { token: null });
    assert.match(page.text, /执行器没有告诉我原因/);
    assert.match(page.text, new RegExp(`T-${id}`));
  });

  test('重试合并不会把原因清掉（025 的规则还在）', async () => {
    const id = (await api('/api/tasks', { method: 'POST', body: { title: '要重试的', executor: 'pool', project: 'demo-feed' } })).json.id;
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'failed', retry: 'merge', fail_reason: '没有合并：本地 main 落后远端 3 个提交。' } });
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { retry: 'merge' } });
    const row = db().prepare('SELECT fail_reason FROM tasks WHERE id = ?').get(id) as any;
    assert.match(row.fail_reason, /落后远端 3 个提交/);
  });
});

describe('028 · 结果里不能有 key 和用户名', () => {
  test('key 形状与本机用户目录都打码', async () => {
    const id = await claimed('读一下配置');
    const fakeKey = ['sk', 'abcdef123456'].join('-');
    const dirty = [
      `配置文件里有 ${fakeKey} 这个 key。`,
      '路径是 C:\\Users\\you\\project\\a.txt',
      '另外 /home/you/b.md 和 /Users/you/c.md 也提到了。',
    ].join('\n');
    await finish(id, { result: 'done', result_text: dirty, no_changes: true });

    const row = db().prepare('SELECT result_text FROM tasks WHERE id = ?').get(id) as any;
    assert.ok(!row.result_text.includes(fakeKey), 'key 要打码');
    assert.ok(!row.result_text.includes('Users\\you'), `用户名要打码：${row.result_text}`);
    assert.match(row.result_text, /sk-\*\*\*/);
    assert.match(row.result_text, /\\Users\\~/);

    const page = await api(`/tasks?task=${id}`, { token: null });
    assert.ok(!page.text.includes(fakeKey), '页面也不能带 key');
    assert.ok(!page.text.includes('C:\\Users\\you'), '页面不能带用户名路径');
  });

  test('超过 8000 字被截断', async () => {
    const id = await claimed('写一大段');
    // 用句子拼，而不是同一个字符重复——连续 32 个字母数字在本项目里会被当成密钥打码。
    const long = '这一句是模型的回答，用来把长度撑过上限。'.repeat(600);
    await finish(id, { result: 'done', result_text: long, no_changes: true });
    const row = db().prepare('SELECT result_text FROM tasks WHERE id = ?').get(id) as any;
    assert.equal(row.result_text.length, 8000);
  });

  test('重新执行时旧结果被清掉（新一轮是新结果）', async () => {
    const id = await claimed('跑两轮');
    await finish(id, { result: 'done', result_text: '第一轮的答案', no_changes: true });
    db().prepare("UPDATE tasks SET status = 'queued', start_requested = 1 WHERE id = ?").run(id);
    await api('/api/runner/next?executors=pool&runner=r-028');
    const row = db().prepare('SELECT result_text FROM tasks WHERE id = ?').get(id) as any;
    assert.equal(row.result_text, null);
  });
});

describe('028 · 过程记录', () => {
  test('同一个步骤报十次只记一行，换步骤才加', async () => {
    const id = await claimed('看过程');
    for (let i = 0; i < 10; i++) await api(`/api/runner/tasks/${id}/progress`, { method: 'POST', body: { step: '读 README', tokens_used: 100 + i } });
    assert.equal(logRows(id).length, 2, '「领走」一行 + 「读 README」一行'); // claim + 一次
    await api(`/api/runner/tasks/${id}/progress`, { method: 'POST', body: { step: '跑测试' } });
    const lines = logRows(id).map((r) => r.line);
    assert.equal(lines.filter((l) => l === '读 README').length, 1);
    assert.ok(lines.includes('跑测试'));
  });

  test('工具输出不会进过程记录', async () => {
    const id = await claimed('看过程2');
    await api(`/api/runner/tasks/${id}/progress`, {
      method: 'POST', body: { step: '编译', log_tail: 'TOOLOUTPUT-SHOULD-NOT-APPEAR-0123456789abcdef' },
    });
    const all = logRows(id).map((r) => r.line).join('\n');
    assert.ok(!all.includes('TOOLOUTPUT-SHOULD-NOT-APPEAR'), '只记步骤，不记工具输出');
  });

  test('每任务最多 200 行，旧的被丢掉', async () => {
    const id = await claimed('很多步');
    for (let i = 0; i < 260; i++) {
      await api(`/api/runner/tasks/${id}/progress`, { method: 'POST', body: { step: `第 ${i} 步`, progress: Math.min(99, i) } });
    }
    const rows = logRows(id);
    assert.equal(rows.length, 200, `应该有 200 行，实际 ${rows.length}`);
    assert.ok(!rows.some((r) => r.line === '第 0 步'), '最旧的被丢掉');
    assert.ok(rows.some((r) => r.line === '第 259 步'), '最新的还在');
  });

  test('任务删了，过程记录也删了', async () => {
    const id = await claimed('马上删');
    await api(`/api/runner/tasks/${id}/progress`, { method: 'POST', body: { step: '开始读' } });
    assert.ok(logRows(id).length > 0);
    await api(`/api/tasks/${id}`, { method: 'DELETE', token: null });
    assert.equal(logRows(id).length, 0, '没有孤儿记录');
  });

  test('详情页有一个折叠的「过程」', async () => {
    const id = await claimed('看抽屉');
    await api(`/api/runner/tasks/${id}/progress`, { method: 'POST', body: { step: '读 README' } });
    const page = await api(`/tasks?task=${id}`, { token: null });
    assert.match(page.text, /<details class="fold section" data-process><summary>过程/);
    assert.match(page.text, /读 README/);
  });
});

describe('028 · 结果不出现在日报、推送和审计里', () => {
  const MARK = 'RESULTMARKER-只在详情里出现';

  test('审计、日报、审批摘要都不带结果正文', async () => {
    const id = await claimed('带结果的任务');
    const r = await finish(id, { result: 'done', summary: '读了 README', result_text: MARK, no_changes: true });

    const events = await api('/api/events?limit=200');
    assert.ok(!JSON.stringify(events.json).includes(MARK), '审计里不能有结果正文');

    const { buildDigest } = await import('../src/services/digest.ts');
    assert.ok(!buildDigest({ titles: true }).includes(MARK), '日报里不能有结果正文');

    // 推送和审批摘要同源：审批的 summary 由 finish 的 summary/diff/tests 拼出来。
    const approvals = await api(`/api/approvals?task=${id}`);
    assert.ok(!JSON.stringify(approvals.json).includes(MARK), '审批摘要里也不能有结果正文');
    assert.equal(r.json.approval_id, null);
  });
});

describe('028 · Issue 回写（默认关）', () => {
  const task = { id: 7, title: '来自 Issue 的任务', branch: null, backend: 'bailian', result_text: null } as any;

  test('不给结果时，评论里没有「结果」那一段', async () => {
    const { finishComment } = await import('../src/services/github.ts');
    const text = finishComment(task, '读完了', '', '');
    assert.ok(!text.includes('## 结果'));
  });

  test('给结果时只带前 1500 字', async () => {
    const { finishComment } = await import('../src/services/github.ts');
    const long = '字'.repeat(3000);
    const text = finishComment(task, '读完了', '', '', long);
    assert.match(text, /## 结果/);
    const body = text.split('## 结果')[1];
    assert.ok(body.length < 1700, `应该只带 1500 字，实际 ${body.length}`);
  });

  test('开关默认关；打开后写入设置，并且只能人来改', async () => {
    const { getSetting } = await import('../src/services/dispatch.ts');
    assert.notEqual(getSetting('issue_result_comment'), '1', '默认不该是开的');

    const bearer = await api('/api/settings/issue-result', { method: 'POST', body: { on: true } });
    assert.equal(bearer.status, 403, '只能人在网页上改');

    const on = await api('/api/settings/issue-result', { method: 'POST', body: { on: '1' }, token: null });
    assert.equal(on.json.on, true);
    assert.equal(getSetting('issue_result_comment'), '1');

    const off = await api('/api/settings/issue-result', { method: 'POST', body: {}, token: null });
    assert.equal(off.json.on, false);
    assert.equal(getSetting('issue_result_comment'), '0');
  });
});

describe('028 · 抽屉里别把块压扁（顺手修的老 bug）', () => {
  test('抽屉是固定高度 flex 列，子元素不许缩，否则阶段条会被压成 0 高', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.drawer > \* \{ flex: none; \}/, '抽屉里的块一律不缩');
    assert.match(css, /\.stage-bar \{[^}]*flex: none/, '阶段条自己也不许缩');
  });
});

describe('028 · 执行器侧：真的没有改动才算没改动', () => {
  const hasGit = spawnSync('git', ['--version']).status === 0;

  test('分支没有提交、工作区干净 → 没有改动；有提交或脏文件 → 有改动', { skip: hasGit ? false : '本机没有 git' }, async () => {
    const { nothingChanged } = await import('../scripts/runner.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'wb-028-'));
    const sh = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    sh('init', '-q', '-b', 'main');
    sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    sh('branch', 'wb/T-1');

    assert.equal(nothingChanged(repo, 'wb/T-1'), true, '空分支 + 干净 = 没有改动');

    writeFileSync(join(repo, 'note.txt'), 'draft');
    assert.equal(nothingChanged(repo, 'wb/T-1'), false, '有未提交文件就算有改动');

    sh('add', '.');
    sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'note');
    assert.equal(nothingChanged(repo, 'wb/T-1'), true, '提交在 main 上，分支还是没动');

    sh('checkout', '-q', 'wb/T-1');
    writeFileSync(join(repo, 'x.txt'), 'x');
    sh('add', '.');
    sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
    sh('checkout', '-q', 'main');
    assert.equal(nothingChanged(repo, 'wb/T-1'), false, '分支上有自己的提交 = 有改动');

    rmSync(repo, { recursive: true, force: true });
  });
});
