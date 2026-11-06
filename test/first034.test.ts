// 034：第一次打开不迷路。整页只回答一件事——「我现在该做哪一步」。
// 先把断言写死：一次只展开一步、命令只有一个来源、橙条跳到那一步、按钮点得下去。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-first034-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;
let runner: typeof import('../src/services/runner.ts');
let tasks: typeof import('../src/services/tasks.ts');
let setup: typeof import('../src/services/setup.ts');

before(async () => {
  const { openDb, useDb } = await import('../src/db.ts');
  setup = await import('../src/services/setup.ts');
  runner = await import('../src/services/runner.ts');
  tasks = await import('../src/services/tasks.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  (globalThis as any).__openDb = openDb;
  (globalThis as any).__useDb = useDb;
});
after(() => app.close());

beforeEach(async () => {
  db = (globalThis as any).__openDb(':memory:');
  (globalThis as any).__useDb(db);
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

const get = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) }, redirect: 'manual' });

/** 把某一步的那个 <li> 抠出来——按 id 找，不靠顺序。 */
function stepHtml(text: string, key: string): string {
  const at = text.indexOf(`id="setup-${key}"`);
  if (at < 0) return '';
  const from = text.lastIndexOf('<li', at);
  const next = text.indexOf('<li', at + 10);
  return text.slice(from < 0 ? at : from, next > 0 ? next : Math.min(text.length, at + 3000));
}

const expanded = (text: string) => (text.match(/class="setup-row[^"]*current/g) ?? []).length;

describe('034A · 命令只有一个来源', () => {
  test('手动启动命令是找守卫，不是直接开 runner', () => {
    assert.equal(setup.RUNNER_CMD, 'node scripts/runner-guard.mjs');
    assert.equal(setup.RUNNER_CHECK_CMD, 'node scripts/runner.mjs --check', '--check 还是直接问 runner 本体');
  });

  test('页面、README、AGENT-INSTALL 用同一句', () => {
    for (const f of ['README.md', 'docs/AGENT-INSTALL.md', 'docs/USAGE.md']) {
      const text = readFileSync(f, 'utf8');
      assert.ok(text.includes(setup.RUNNER_CMD), `${f} 里的手动启动命令和代码不一致`);
    }
  });

  test('文档里没有把计划任务指到 runner.mjs 的写法', () => {
    const win = readFileSync('docs/INSTALL-WINDOWS.md', 'utf8');
    assert.match(win, /runner-guard\.mjs/, '自启要指向守卫');
    assert.doesNotMatch(win, /-Argument\s+["'`][^"'`\n]*scripts\\+runner\.mjs/, '不能把计划任务指到 runner 本体');
  });

  test('USAGE 不自己抄一份计划任务命令，改成链接 INSTALL-WINDOWS', () => {
    const usage = readFileSync('docs/USAGE.md', 'utf8');
    assert.doesNotMatch(usage, /任务计划程序\s*→\s*创建任务/, '开机自启只有 INSTALL-WINDOWS 一份写法');
    assert.match(usage, /INSTALL-WINDOWS\.md/, '要告诉人去哪看');
    const agent = readFileSync('docs/AGENT-INSTALL.md', 'utf8');
    assert.doesNotMatch(agent, /它没有「后台模式」/, '这句已经不成立了：守卫 + 计划任务就是后台');
    assert.match(agent, /INSTALL-WINDOWS\.md/);
  });
});

describe('034B · 清单只亮当前这一步', () => {
  test('什么都还没做：只展开第 3 步「启动执行器」，前两步收成一行', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /下一步：<strong>启动执行器<\/strong>/, '顶部要写下一步做什么');
    assert.match(html, /第 3 步，共 6 步/);
    assert.equal(expanded(html), 1, '一次只展开一步');

    const password = stepHtml(html, 'password');
    assert.ok(password.includes('网页密码已设置'), '做完的那步写结果');
    assert.ok(!password.includes('setup-what'), '做完的不展开');
    assert.ok(!password.includes('data-copy'), '做完的不给命令');

    const runnerStep = stepHtml(html, 'runner');
    assert.ok(runnerStep.includes('current'), '第 3 步是当前步');
    assert.match(runnerStep, /装在你自己的电脑上/, '执行器要说清是什么');
    assert.ok(runnerStep.includes(setup.RUNNER_CMD), '要给一条能直接复制的命令');
    assert.match(runnerStep, /data-copy/, '要有复制按钮');
    assert.match(runnerStep, /PowerShell/, '要说在哪儿敲');
    assert.match(runnerStep, /成功会怎样/);
    assert.match(runnerStep, /npm run diagnose/, '报错只留一个入口');
    assert.match(runnerStep, /id="setup-runner"/);
  });

  test('没轮到的步骤只显示标题，不带命令', async () => {
    const html = await (await get('/')).text();
    const projects = stepHtml(html, 'projects');
    assert.ok(projects.includes('配一个项目'), '没做时标题写成动作');
    assert.ok(!projects.includes('setup-what'), '没轮到的别展开');
    assert.ok(!projects.includes('data-copy'));

    const backend = stepHtml(html, 'backend');
    assert.ok(backend.includes('检查模型后端'));
  });

  test('执行器连上后：展开第 4 步，第 3 步收成「执行器已连上」并给自启入口', async () => {
    runner.heartbeat('r1', { executors: ['pool'] });
    const html = await (await get('/')).text();
    assert.match(html, /下一步：<strong>配一个项目<\/strong>/);
    assert.match(html, /第 4 步，共 6 步/);
    assert.equal(expanded(html), 1);

    const runnerStep = stepHtml(html, 'runner');
    assert.ok(runnerStep.includes('执行器已连上'), '做完了写结果');
    assert.ok(!runnerStep.includes('current'));
    assert.match(runnerStep, /开机自动启动/, '自启不单独拆步骤，就一行小字');
    assert.match(runnerStep, /INSTALL-WINDOWS|docs\/INSTALL/);
  });

  test('全部做完：写「全好了」，一个展开项都没有', async () => {
    runner.heartbeat('r1', { projects: ['p'], check: { ok: true, summary: '自检 9/9 项就绪' } });
    const t = tasks.createTask({ title: '装好了', executor: 'pool' });
    db.prepare(`UPDATE tasks SET status = 'done', runner_id = 'r1' WHERE id = ?`).run(t.id);
    const html = await (await get('/settings/integrations')).text();
    assert.match(html, /全好了/);
    assert.equal(expanded(html), 0, '都做完了就别再指路');
    assert.doesNotMatch(html, /下一步：/);
  });

  test('页面上没有没解释的词', async () => {
    const html = await (await get('/')).text();
    const card = html.slice(html.indexOf('id="setup"'), html.indexOf('</section>', html.indexOf('id="setup"')));
    assert.doesNotMatch(card, /worktree/, '这个词不该出现在清单里');
    assert.doesNotMatch(card, /心跳/, '这个词不该出现在清单里');
    assert.match(card, /装在你自己的电脑上、真正替你干活的程序/, '「执行器」出现就要有一句话解释');
  });
});

describe('034B · 今天页的橙条跳到那一步', () => {
  test('执行器没开：链接带锚点，锚点在清单里真实存在', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /href="\/#setup-runner"/, '橙条要带到执行器那一步');
    assert.match(html, /id="setup-runner"/);
  });

  test('点过「不再提示」：跳到设置里那份清单，那里也有这个锚点', async () => {
    await fetch(`${base}/api/setup/dismiss`, {
      method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: '{"on":true}',
    });
    const html = await (await get('/')).text();
    assert.match(html, /href="\/settings\/integrations#setup-runner"/);
    assert.match(await (await get('/settings/integrations')).text(), /id="setup-runner"/);
  });
});

describe('034C · 「试试这个」按钮', () => {
  test('执行者全被暂停：按钮置灰，旁边一句指回去', async () => {
    runner.heartbeat('r1', { executors: ['pool'], projects: ['p'], check: { ok: true, summary: 'ok' } });
    db.prepare('UPDATE executor_settings SET enabled = 0').run();
    const html = await (await get('/')).text();
    const step = stepHtml(html, 'first_task');
    assert.ok(step.includes('current'), '走到第 6 步才谈这个按钮');
    assert.match(step, /<button[^>]*disabled[^>]*>试试这个/, '点不了的按钮要明确置灰');
    assert.match(step, /执行者被暂停/, '要说清为什么点不了');
    assert.match(step, /\/team\/executors/, '要指到能改的地方');
  });

  test('执行器没开：原因指向上一步（第 3 步）', async () => {
    const { sampleTaskForm } = await import('../src/views/setup.ts');
    // 离线但还留着上次的项目列表——最容易误判成「可以点」的情形
    runner.heartbeat('r1', { executors: ['pool'], projects: ['p'] });
    db.prepare('UPDATE runners SET last_seen = ?').run(new Date(Date.now() - 10 * 60_000).toISOString());
    const html = String(sampleTaskForm());
    assert.match(html, /disabled/, '离线时按钮不能是能点的样子');
    assert.match(html, /先把执行器开起来，<a href="#setup-runner">见上面第 3 步<\/a>/);
  });

  test('能点了：带项目和执行器真会领的执行者，且不自动开始', async () => {
    runner.heartbeat('r1', { executors: ['pool'], projects: ['p'], check: { ok: true, summary: 'ok' } });
    const html = await (await get('/')).text();
    const step = stepHtml(html, 'first_task');
    assert.match(step, /name="project" value="p"/);
    assert.match(step, /name="executor" value="pool"/);
    assert.match(step, /name="mode" value="manual"/);
    assert.doesNotMatch(step, /disabled/);
  });
});
