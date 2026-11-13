// 040：界面按「对象」组织。四层、一个对象一种长相、一个对象一个详情地址。
// 这一组用例检查的就是那几条规则有没有被破坏——不是「长得好不好看」，是「三页是不是同一个东西」。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-040-0123456789abc';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

let app: Server;
let base = '';
let cookie = '';
let tasks: typeof import('../src/services/tasks.ts');
let core: typeof import('../src/services/core.ts');
let domain: typeof import('../src/domain.ts');
let dbmod: typeof import('../src/db.ts');

before(async () => {
  dbmod = await import('../src/db.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  dbmod.useDb(dbmod.openDb(':memory:'));
  tasks = await import('../src/services/tasks.ts');
  core = await import('../src/services/core.ts');
  domain = await import('../src/domain.ts');
});

after(() => { app.close(); });

beforeEach(async () => {
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

// ---------- 从整页 HTML 里切出一块 ----------

/** 从 marker 所在的那个块级元素（div 或 section）开始，按同名标签配对切出整块。 */
function blockOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const inDiv = html.lastIndexOf('<div', at);
  const inSection = html.lastIndexOf('<section', at);
  const useSection = inSection > inDiv;
  const openTag = useSection ? '<section' : '<div';
  const closeTag = useSection ? '</section>' : '</div>';
  const start = useSection ? inSection : inDiv;
  let depth = 0;
  let i = start;
  while (i < html.length) {
    const o = html.indexOf(openTag, i);
    const c = html.indexOf(closeTag, i);
    if (c < 0) break;
    if (o >= 0 && o < c) { depth++; i = o + openTag.length; } else { depth--; i = c + closeTag.length; if (depth === 0) return html.slice(start, i); }
  }
  return html.slice(start);
}

const cardOf = (html: string, id: number) => blockOf(html, `data-card="task" data-task="${id}"`);

/** 一个执行者的区。区里不再嵌 details，所以第一个 </details> 就是它的结尾。 */
function sectionOf(html: string, key: string): string {
  const at = html.indexOf(`data-exec="${key}"`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<details', at);
  const end = html.indexOf('</details>', at);
  return end < 0 ? html.slice(start) : html.slice(start, end + '</details>'.length);
}

/** 标签序列：比结构时用，属性值和文字都不算。 */
const shape = (s: string) => (s.match(/<\/?[a-z]+/g) ?? []).join(' ');

/** 执行者标签（名字 + 色点）。剧组页用 hideExec 省掉它，比对前两边都摘掉。 */
const stripExecTag = (s: string) => s.replace(/<span class="avatar[^>]*>[^<]*<\/span><span class="card-exec">[^<]*<\/span>/, '');

const navCount = (html: string) => (html.match(/class="nav-item[ "]/g) ?? []).length;

// ---------- 1. 一个对象一种长相 ----------

describe('040 A · 三页同一个任务，同一张卡', () => {
  test('今天页、剧组页、看板渲染的卡片结构完全一样（差一个执行者标签除外）', async () => {
    const t = tasks.createTask({
      title: '三页一致的任务', description: '', category: 'dev', executor: 'claude',
      project: 'demo', status: 'running', step: '改代码',
    }, 'claude');

    const today = await api('/?g=run');
    const board = await api('/tasks');
    const team = await api('/team');

    const a = cardOf(today.text, t.id);
    const b = cardOf(board.text, t.id);
    const c = cardOf(team.text, t.id);
    assert.ok(a, '今天页要有这张卡');
    assert.ok(b, '看板要有这张卡');
    assert.ok(c, '剧组页要有这张卡');
    assert.ok(a.includes('data-card="task"'), '卡片带 data-card="task"');

    const A = shape(stripExecTag(a));
    assert.equal(shape(stripExecTag(b)), A, '看板和今天页结构不一样——说明有一页自己抄了一份');
    assert.equal(shape(stripExecTag(c)), A, '剧组页和今天页结构不一样');
  });

  test('整张卡指向同一个详情地址', async () => {
    const t = tasks.createTask({ title: '点我', executor: 'claude', project: 'demo', status: 'queued' }, 'claude');
    const today = await api('/?g=queue');
    const card = cardOf(today.text, t.id);
    assert.ok(card.includes(`href="/tasks?task=${t.id}"`), '卡片里要有那个唯一的详情地址');
  });

  test('卡片最多一个动作按钮，按状态决定', async () => {
    const queued = tasks.createTask({ title: '排队', executor: 'claude', project: 'demo', status: 'queued' }, 'claude');
    const failed = tasks.createTask({ title: '失败', executor: 'claude', project: 'demo', status: 'failed', fail_reason: '测试红了' }, 'claude');
    const running = tasks.createTask({ title: '在跑', executor: 'claude', project: 'demo', status: 'running' }, 'claude');
    const page = await api('/tasks');
    for (const t of [queued, failed, running]) {
      const card = cardOf(page.text, t.id);
      const acts = (card.match(/class="btn small/g) ?? []).length;
      assert.ok(acts <= 1, `T-${t.id} 的动作按钮有 ${acts} 个，规则 4 只允许一个`);
    }
    assert.match(cardOf(page.text, queued.id), /开始/, '排队中给「开始」');
    assert.match(cardOf(page.text, failed.id), /重试/, '失败给「重试」');
    assert.equal(/class="btn small/.test(cardOf(page.text, running.id)), false, '在跑不给按钮');
  });
});

// ---------- 2. 剧组页 ----------

describe('040 C · 每个执行者一个区', () => {
  test('注册表里的每个执行者（含 me）都有一个区，区里有管理块和任务块', async () => {
    tasks.createTask({ title: '在跑的活', executor: 'pool', project: 'demo', status: 'running' }, 'pool');
    const page = await api('/team');
    for (const key of Object.keys(domain.EXECUTORS)) {
      const sec = sectionOf(page.text, key);
      assert.ok(sec, `${key} 没有自己的区`);
      assert.ok(sec.includes('data-manage'), `${key} 的区里没有管理块`);
      assert.ok(sec.includes('data-exec-tasks'), `${key} 的区里没有任务状态块`);
    }
  });

  test('有在跑任务的区默认展开，空着的收起', async () => {
    tasks.createTask({ title: '还在跑', executor: 'local', project: 'demo', status: 'running' }, 'local');
    const page = await api('/team');
    assert.match(sectionOf(page.text, 'local'), /^<details[^>]*\sopen>/, 'local 有在跑的任务，应该展开');
    assert.doesNotMatch(sectionOf(page.text, 'autoclaw'), /^<details[^>]*\sopen>/, 'autoclaw 什么都没在跑，应该收起');
  });

  test('管理块只显示数值，不摆输入框（规则 5）', async () => {
    const page = await api('/team');
    for (const key of ['claude', 'pool', 'me']) {
      const manage = blockOf(sectionOf(page.text, key), 'data-manage');
      assert.ok(manage, `${key} 的管理块没切出来`);
      assert.equal(/<(input|select|textarea)\b/.test(manage), false, `${key} 的管理块里有输入框`);
      assert.match(manage, /改设置|我的待办/, `${key} 的管理块要有去改的入口或待办数`);
    }
  });

  test('「能否领取」看 claimable，不只看 enabled（zcode 是只派单）', async () => {
    const page = await api('/team');
    // zcode 的 enabled=1 但 claimable=0：只看 enabled 会写成「可以」，跟实际领不了一致不了。
    assert.match(blockOf(sectionOf(page.text, 'zcode'), 'data-manage'), /能否领取<\/dt><dd>只派单<\/dd>/);
    assert.match(blockOf(sectionOf(page.text, 'claude'), 'data-manage'), /能否领取<\/dt><dd>可以<\/dd>/);
  });

  test('「我」也是一个区，管理块只放待办数量', async () => {
    tasks.createTask({ title: '我自己要做', executor: 'me', status: 'inbox' }, 'me');
    const page = await api('/team');
    const manage = blockOf(sectionOf(page.text, 'me'), 'data-manage');
    assert.match(manage, /我的待办/);
    assert.doesNotMatch(manage, /每日 token/, '「我」不占额度，别摆额度字段');
  });

  test('41 的战绩在管理块里，口径写成年限', async () => {
    const page = await api('/team');
    const manage = blockOf(sectionOf(page.text, 'claude'), 'data-manage');
    assert.match(manage, /近 30 天/, '数字要带口径（规则 7）');
  });
});

// ---------- 3. 任务抽屉 ----------

describe('040 D · 抽屉按 结果 → 过程 → 备忘 → 审计 排', () => {
  test('审计记录只列这个任务的事件，最多 20 条', async () => {
    const mine = tasks.createTask({ title: '有审计的任务', executor: 'claude', project: 'demo', status: 'running' }, 'claude');
    const other = tasks.createTask({ title: '别的任务', executor: 'claude', project: 'demo', status: 'running' }, 'claude');
    for (let i = 0; i < 25; i++) core.logEvent({ actor: 'claude', kind: 'test', text: `第 ${i} 条`, task_id: mine.id });
    core.logEvent({ actor: 'claude', kind: 'test', text: '不该出现的别人的事件', task_id: other.id });

    const page = await api(`/tasks?task=${mine.id}`);
    const audit = blockOf(page.text, 'data-audit');
    assert.ok(audit, '抽屉里要有审计记录这一节');
    assert.match(audit, /审计记录/);
    const items = (audit.match(/<li>/g) ?? []).length;
    assert.equal(items, 20, '最多 20 条');
    assert.equal(audit.includes('不该出现的别人的事件'), false, '别把别的任务的事件列进来');
  });

  test('审计记录写清是谁做的', async () => {
    const t = tasks.createTask({ title: '谁的记录', executor: 'claude', project: 'demo', status: 'running' }, 'claude');
    core.logEvent({ actor: 'me', kind: 'test', text: '我点了一下', task_id: t.id });
    core.logEvent({ actor: 'system', kind: 'test', text: '系统做的', task_id: t.id });
    const page = await api(`/tasks?task=${t.id}`);
    const audit = blockOf(page.text, 'data-audit');
    assert.match(audit, /audit-actor[^>]*>你</, 'actor=me 写成「你」');
    assert.match(audit, /audit-actor[^>]*>系统</, 'actor=system 写成「系统」');
  });

  test('四节的先后顺序是 结果 → 过程 → 项目备忘 → 审计', async () => {
    const t = tasks.createTask({
      title: '顺序任务', executor: 'claude', project: 'demo', status: 'done', result_text: '做完了',
    }, 'claude');
    const runner = await import('../src/services/runner.ts');
    runner.appendTaskLog(t.id, '第一步');
    core.logEvent({ actor: 'claude', kind: 'test', text: '一条事件', task_id: t.id });
    const page = await api(`/tasks?task=${t.id}`);
    const at = (marker: string) => page.text.indexOf(marker);
    assert.ok(at('data-result') > 0, '有结果');
    assert.ok(at('data-process') > at('data-result'), '过程在结果后面');
    assert.ok(at('data-notes') > at('data-process'), '项目备忘在过程后面');
    assert.ok(at('data-audit') > at('data-notes'), '审计在备忘后面');
  });
});

// ---------- 4. 导航与旧地址 ----------

describe('040 E · 导航', () => {
  test('061.1：没有侧栏导航；原来的五个地方都还能打开', async () => {
    for (const path of ['/', '/team', '/media', '/data', '/settings', '/tasks', '/advanced']) assert.equal((await api(path)).status, 200, path);
    assert.ok(!(await api('/?view=classic')).text.includes('id="wb-side"'));
  });

  test('数据那几页照旧能打开', async () => {
    for (const path of ['/data', '/data/audit', '/data/machines', '/team/accounts']) {
      assert.equal((await api(path)).status, 200, path);
    }
  });

});

// ---------- 5. 今天页 ----------

describe('044 v3 · 工作台一层一层', () => {
  test('第一层：一句话现状 + 四行（等你拍板 / 在跑 / 排队 / 今天完成），不摆任务卡、数据格和小图', async () => {
    tasks.createTask({ title: '第一层不该出现的卡', executor: 'claude', project: 'demo', status: 'running' }, 'claude');
    const page = (await api('/?view=classic')).text;
    for (const k of ['you', 'run', 'queue', 'done']) assert.match(page, new RegExp(`data-group-row="${k}"`), k);
    for (const label of ['等你拍板', '在跑', '排队', '今天完成']) assert.ok(page.includes(label), label);
    assert.match(page, /class="lede-line"/);
    assert.equal(page.includes('data-card="task"'), false, '任务卡在第二层');
    assert.equal(page.includes('<svg class="mini"'), false, '小图不在工作台');
    assert.match(page, /第一层不该出现的卡/, '标题只作为一句预览出现');
  });

  test('第二层：点一行进那一组；卡片落在对的组，带回工作台的路径', async () => {
    dbmod.db().exec('DELETE FROM tasks');
    const inbox = tasks.createTask({ title: '甲 我的待办', executor: 'me', status: 'inbox' }, 'me');
    const queued = tasks.createTask({ title: '乙 排队', executor: 'zcode', project: 'demo', status: 'queued' }, 'zcode');
    const running = tasks.createTask({ title: '丙 在跑', executor: 'local', project: 'demo', status: 'running' }, 'local');
    const review = tasks.createTask({ title: '丁 等审批', executor: 'claude', project: 'demo', status: 'review' }, 'claude');
    const failed = tasks.createTask({ title: '戊 失败', executor: 'claude', project: 'demo', status: 'failed', fail_reason: '测试红了' }, 'claude');
    const done = tasks.createTask({ title: '己 做完', executor: 'claude', project: 'demo', status: 'running' }, 'claude');
    tasks.updateTask(done.id, { status: 'done' }, 'claude');
    const has = async (g: string, t: { id: number }) => (await api(`/?g=${g}`)).text.includes(`data-task="${t.id}"`);
    assert.ok(await has('you', review) && await has('you', failed) && await has('you', inbox), '等你拍板：审批、失败、我的待办');
    assert.ok(await has('run', running));
    assert.ok(await has('queue', queued));
    assert.ok(await has('done', done));
    assert.equal(await has('run', queued), false);
    const you = (await api('/?g=you')).text;
    assert.match(you, /<nav class="crumbs"[^>]*><a href="\/">工作台<\/a>/);
    assert.ok(you.indexOf(`data-task="${review.id}"`) < you.indexOf(`data-task="${inbox.id}"`), '等审批排在我的待办前面');
  });

  test('一句话里的数字和四行的数字是同一个口径', async () => {
    const page = (await api('/?view=classic')).text;
    const n = Number(page.match(/data-group-row="you"[^>]*>\s*<span class="group-n">(\d+)/)?.[1] ?? -1);
    if (n > 0) assert.match(page, new RegExp(`有 ${n} 件事等你拍板`));
  });

  test('061：派活框只在首页；别的页一屏最多一个荧光按钮', async () => {
    const home = (await api('/')).text;
    assert.match(home, /<form class="ask" data-api="\/api\/tasks\/quick"/);
    assert.equal((home.match(/class="btn accent"/g) ?? []).length, 0, '首页没有荧光按钮：亮的只有「等你」那几行');
    for (const path of ['/team', '/data', '/settings']) {
      const html = (await api(path)).text;
      assert.ok(!html.includes('data-api="/api/tasks/quick"'), path);
      assert.ok((html.match(/class="btn accent"/g) ?? []).length <= 1, path);
    }
  });

  test('7 天用量图和机器不再出现在今天页', async () => {
    const page = await api('/?view=classic');
    assert.equal(page.text.includes('近 7 天 Token 用量'), false, '用量图挪去 /data 了');
    assert.equal(/<h2>机器<\/h2>/.test(page.text), false, '机器挪去 /data 了');
  });
});

// ---------- 6. 动效 ----------

describe('040 F · 动效沿用 038', () => {
  // 只看 040 自己那一段（后面 044 的样式另有规矩）。
  const from = CSS.indexOf('040 · 按对象组织');
  const to = CSS.indexOf('044 ·', from);
  const block = CSS.slice(from, to > from ? to : undefined);

  // 044（用户 2026-11-03）：动效按体感调，不设毫秒上限。只留「减少动态效果」这条硬规则。
  test('040 那段样式还在，而且有过渡', () => {
    assert.ok(block.length > 200, '040 那段样式应该在');
    assert.ok([...block.matchAll(/transition:\s*([^;]+);/g)].length, '040 至少有一个过渡（额度条/箭头）');
  });

  test('这些过渡都在「减少动态效果」里被关掉', () => {
    const reduce = block.slice(block.lastIndexOf('@media (prefers-reduced-motion'));
    assert.ok(reduce, '要有 prefers-reduced-motion 段');
    for (const sel of ['.bar > div', '.exec-section > summary::before', '.task-grid .card']) {
      assert.ok(reduce.includes(sel), `${sel} 没在减少动态效果里关掉`);
    }
  });

  test('一屏仍然只有一个荧光按钮', async () => {
    const page = await api('/?view=classic');
    const accents = (page.text.match(/class="btn[^"]*accent/g) ?? []).length;
    assert.ok(accents <= 1, `今天页有 ${accents} 个荧光按钮`);
  });
});
