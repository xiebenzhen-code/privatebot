// 064 · 执行者增减：请进来 / 先歇着 / 叫回来 / 移除。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WB_DB = ':memory:';
process.env.WB_TOKEN = 'test-token-064-crew-not-real';
process.env.WB_PASSWORD = 'test-password-064-crew-only';

let dbm: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let crew: typeof import('../src/services/crew.ts');
let st: typeof import('../src/services/stream.ts');
let rv: typeof import('../src/services/review.ts');

before(async () => {
  dbm = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  crew = await import('../src/services/crew.ts');
  st = await import('../src/services/stream.ts');
  rv = await import('../src/services/review.ts');
});
beforeEach(() => {
  dbm.useDb(dbm.openDb(':memory:'));
  dbm.db().prepare('UPDATE executor_settings SET enabled = 0, resting = 0').run();
  for (const e of ['codex', 'claude']) dbm.db().prepare('UPDATE executor_settings SET enabled = 1, claimable = 1 WHERE executor = ?').run(e);
});

describe('064 服务', () => {
  test('三种状态来回切；设置不丢', () => {
    dbm.db().prepare("UPDATE executor_settings SET daily_token_cap = 123456 WHERE executor = 'codex'").run();
    assert.equal(crew.crewInfo('codex')!.state, 'in');
    assert.equal(crew.setCrew('codex', 'rest', 'me').state, 'rest');
    assert.equal(crew.setCrew('codex', 'out', 'me').state, 'out');
    assert.equal(crew.setCrew('codex', 'in', 'me').state, 'in');
    assert.equal((dbm.db().prepare("SELECT daily_token_cap AS c FROM executor_settings WHERE executor = 'codex'").get() as any).c, 123456);
  });
  test('歇着的还在头像排里（灰、最后），移除的不在；都不接活、不被挑去审', () => {
    crew.setCrew('claude', 'rest', 'me');
    const row = st.crew(new Set(['codex', 'claude']), (k) => k);
    assert.deepEqual(row.map((m) => [m.key, m.resting, m.online]), [['codex', false, true], ['claude', true, false]]);
    assert.equal(rv.chooseReviewer('codex', new Set(['claude'])).who, '', '歇着的不挑去审');
    crew.setCrew('claude', 'out', 'me');
    assert.deepEqual(st.crew(new Set(), (k) => k).map((m) => m.key), ['codex']);
    assert.deepEqual(crew.crewOutside().map((m) => m.key).includes('claude'), true);
  });
  test('手上有事不能歇、不能移；做完就可以', () => {
    const t = tasks.createTask({ title: '活', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(t.id);
    assert.throws(() => crew.setCrew('codex', 'rest', 'me'), /手上还有 1 件事/);
    assert.throws(() => crew.setCrew('codex', 'out', 'me'), /手上还有 1 件事/);
    dbm.db().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t.id);
    assert.equal(crew.setCrew('codex', 'rest', 'me').state, 'rest');
  });
  test('做到一半停下来等你批准（review）、等你回话（asking）也算手上有事', () => {
    for (const status of ['queued', 'running', 'review', 'asking']) {
      const t = tasks.createTask({ title: status, executor: 'codex', project: 'demo' }, 'me');
      dbm.db().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
      assert.throws(() => crew.setCrew('codex', 'rest', 'me'), /手上还有 1 件事/, status);
      dbm.db().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t.id);
    }
    // 没成的、做完的、还没开始的不算
    for (const status of ['failed', 'done', 'inbox']) {
      const t = tasks.createTask({ title: status, executor: 'codex', project: 'demo' }, 'me');
      dbm.db().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
    }
    assert.equal(crew.busyCount('codex'), 0);
  });
  test('正在审别人的也算手上有事', () => {
    const t = tasks.createTask({ title: '被审', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'done', reviewer = 'claude', review_state = 'reviewing' WHERE id = ?").run(t.id);
    assert.throws(() => crew.setCrew('claude', 'out', 'me'), /手上还有 1 件事/);
  });
  test('「我」和不认识的名字不行', () => {
    assert.equal(crew.crewInfo('me'), null);
    assert.throws(() => crew.setCrew('me', 'out', 'me'), /没有这位/);
    assert.throws(() => crew.setCrew('__proto__', 'in', 'me'), /没有这位/);
    assert.throws(() => crew.setCrew('nobody', 'in', 'me'), /没有这位/);
  });
});

describe('064 页面和接口', () => {
  let server: import('node:http').Server; let base = ''; let cookie = '';
  before(async () => {
    const { createServer } = await import('node:http');
    const { handle } = await import('../src/app.ts');
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(async () => { const { loginCookie } = await import('./helpers.ts'); cookie = await loginCookie(base, process.env.WB_PASSWORD!); });
  const page = async (p: string) => (await fetch(base + p, { headers: { Cookie: cookie } })).text();
  const post = (key: string, to: string, headers: Record<string, string> = { Cookie: cookie }) =>
    fetch(`${base}/api/crew/${key}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });

  test('头像点开是它那一层；「＋」点开是请谁进来', async () => {
    const home = await page('/');
    assert.match(home, /href="\/\?crew=codex"[^>]*data-crew="codex"/);
    assert.match(home, /href="\/\?crew=add"[^>]*data-crew-add/);
    const one = await page('/?crew=codex');
    assert.match(one, /data-crew-panel="codex"/);
    assert.match(one, /data-crew-act="rest">先歇着/); assert.match(one, /data-crew-act="out">移除/);
    const add = await page('/?crew=add');
    assert.match(add, /data-crew-panel="add"/);
    assert.match(add, /data-crew-item="workbuddy"/); assert.ok(!add.includes('data-crew-item="codex"'));
    assert.ok(!(await page('/?crew=nobody')).includes('data-crew-panel'));
  });
  test('歇着 → 头像变灰、面板换成叫回来；移除 → 头像没了、出现在「＋」里', async () => {
    assert.equal((await post('claude', 'rest')).status, 200);
    assert.match(await page('/'), /class="crew-face  rest"|class="crew-face rest"/);
    assert.match(await page('/?crew=claude'), /data-crew-act="in">叫回来/);
    assert.match(await page('/?crew=add'), /data-crew-item="claude"[\s\S]*?歇着/);
    assert.equal((await post('claude', 'out')).status, 200);
    assert.ok(!(await page('/')).includes('data-crew="claude"'));
    assert.match(await page('/?crew=claude'), /data-crew-act="in">请进来/);
    assert.equal((await post('claude', 'in')).status, 200);
    assert.match(await page('/'), /data-crew="claude"/);
  });
  test('手上有事：接口 409，面板说明原因', async () => {
    const t = tasks.createTask({ title: '活', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id);
    const r = await post('codex', 'out');
    assert.equal(r.status, 409);
    const busy = await page('/?crew=codex');
    assert.match(busy, /data-crew-busy/); assert.ok(!busy.includes('data-crew-act'), '点了也没用的按钮不摆出来');
  });
  test('脚本令牌不能动队伍；参数不对 400', async () => {
    const r = await post('codex', 'out', { Authorization: `Bearer ${process.env.WB_TOKEN}` });
    assert.equal(r.status, 403);
    assert.equal(crew.crewInfo('codex')!.state, 'in');
    assert.equal((await post('codex', 'delete')).status, 400);
    assert.equal((await post('nobody', 'in')).status, 404);
  });
});

describe('诚实与时效（守则、提示词、点头卡）', () => {
  test('每个任务开头写今天的日期；守则里有「说实话」和「会变的事实先核对」', async () => {
    const { readFileSync } = await import('node:fs');
    const rmjs: any = await import('../scripts/runner.mjs');
    const rules = readFileSync(new URL('../scripts/runner-rules.md', import.meta.url), 'utf8');
    assert.match(rules, /12\. \*\*说实话\*\*/); assert.match(rules, /没跑的测试不说通过/);
    assert.match(rules, /13\. \*\*会变的事实先核对\*\*/); assert.match(rules, /未核实/);
    assert.equal(rmjs.todayLine(new Date(2026, 10, 11)), '今天是 2026-11-11（星期三）。');
    const prompt = rmjs.buildPrompt({ id: 3, title: '写周报', executor: 'codex' }, rules, '', '', new Date(2026, 0, 5));
    assert.ok(prompt.indexOf('今天是 2026-01-05（星期一）。') > 0 && prompt.indexOf('今天是') < prompt.indexOf('说实话'), '日期在任务开头，不在守则后面');
  });
  test('审的那位也查：删测试、写死结果、没出处的会变事实', () => {
    const p = rv.reviewPrompt({ id: 1, title: 't' } as any);
    assert.match(p, /删测试、放宽断言、把结果写死/); assert.match(p, /没有出处或「未核实」/);
  });
  test('放了一天以上的成果，点头卡提醒一句；当天的不提', async () => {
    const appr = await import('../src/services/approvals.ts');
    const { threadPanel } = await import('../src/views/thread.ts');
    const t = tasks.createTask({ title: '旧成果', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'done', branch = ? WHERE id = ?").run(`wb/T-${t.id}`, t.id);
    const a = appr.createApproval({ task_id: t.id, tool_name: 'git merge', title: '合并', summary: '', executor: 'codex' } as any);
    assert.ok(!String(threadPanel(tasks.getTask(t.id)!)).includes('data-decide-aged'));
    dbm.db().prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86_400_000 - 1000).toISOString(), a.id);
    assert.match(String(threadPanel(tasks.getTask(t.id)!)), /data-decide-aged>这是 3 天前做好的/);
  });
  test('在做区：谁在审写清楚', async () => {
    const runner = await import('../src/services/runner.ts');
    const t = tasks.createTask({ title: '被审的', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'running', reviewer = 'claude' WHERE id = ?").run(t.id);
    runner.finishTask(t.id, { result: 'done', branch: `wb/T-${t.id}`, changed_files: ['a.md'] } as any);
    const it = st.stream().doing.find((x) => x.task?.id === t.id)!;
    assert.equal(it.why, 'Claude 在审'); assert.equal(it.who, '');
  });
});

describe('不留旁路、不轻易放弃审查', () => {
  test('旧设置页关掉一位：手上有事同样 409；没事可以关', async () => {
    const dispatch = await import('../src/services/dispatch.ts');
    const t = tasks.createTask({ title: '活', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id);
    assert.throws(() => dispatch.saveExecutorSettings([{ executor: 'codex', enabled: 0 }]), /手上还有 1 件事/);
    assert.equal(crew.crewInfo('codex')!.state, 'in');
    // 不改开关、只调别的设置不受影响
    dispatch.saveExecutorSettings([{ executor: 'codex', enabled: 1, max_minutes: 30 }]);
    dbm.db().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t.id);
    dispatch.saveExecutorSettings([{ executor: 'codex', enabled: 0 }]);
    assert.notEqual(crew.crewInfo('codex')!.state, 'in');
  });
  test('没开始的事：面板上数出来，说明要你换人', async () => {
    const { crewPanel } = await import('../src/views/crew.ts');
    const t = tasks.createTask({ title: '没开始', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'inbox' WHERE id = ?").run(t.id);
    assert.equal(crew.crewInfo('codex')!.idle, 1);
    assert.match(String(crewPanel('codex')), /data-crew-idle>还有 1 件派给它、没开始的事/);
  });
  const three = () => { dbm.db().prepare("UPDATE executor_settings SET enabled = 1, claimable = 1 WHERE executor = 'workbuddy'").run(); };
  const done = async (reviewer: string) => {
    const runner = await import('../src/services/runner.ts');
    const t = tasks.createTask({ title: '要审的', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'running', reviewer = ?, review_why = '你点的' WHERE id = ?").run(reviewer, t.id);
    return { runner, t, finish: () => runner.finishTask(t.id, { result: 'done', branch: `wb/T-${t.id}`, changed_files: ['a.md'] } as any) };
  };
  const child = (pid: number) => dbm.db().prepare('SELECT * FROM tasks WHERE review_of = ? ORDER BY id DESC').get(pid) as any;
  test('你点的那位做完时已经不在队里：换一位接着审，理由写清楚', async () => {
    three();
    const x = await done('claude');
    crew.setCrew('claude', 'rest', 'me');
    x.finish();
    const p = tasks.getTask(x.t.id)!;
    assert.equal(p.review_state, 'reviewing'); assert.equal(p.reviewer, 'workbuddy');
    assert.match(p.review_why, /^原定的 Claude 不在队里，大脑挑的：/);
    assert.equal(child(p.id).executor, 'workbuddy');
  });
  test('只有两位、原定的不在：没人能接，才记没审成', async () => {
    const x = await done('claude');
    crew.setCrew('claude', 'out', 'me');
    x.finish();
    assert.equal(tasks.getTask(x.t.id)!.review_state, 'failed');
  });
  test('审的那位没交回能读的结论：换一位接着审；第二位也不成才算没审成', async () => {
    three();
    const x = await done('claude'); x.finish();
    const c1 = child(x.t.id);
    dbm.db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c1.id);
    x.runner.finishTask(c1.id, { result: 'done', no_changes: true, result_text: '我看完了，挺好的' } as any);
    let p = tasks.getTask(x.t.id)!;
    assert.equal(p.review_state, 'reviewing', '换人接着审，不是直接放弃'); assert.equal(p.reviewer, 'workbuddy'); assert.equal(p.review_round, 1);
    const recs = rv.reviewsOf(p.id);
    assert.equal(recs.length, 1); assert.equal(recs[0].verdict, 'failed'); assert.match(recs[0].summary, /换 .+ 接着审/);
    const c2 = child(p.id); assert.notEqual(c2.id, c1.id); assert.equal(c2.executor, 'workbuddy');
    dbm.db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c2.id);
    x.runner.finishTask(c2.id, { result: 'failed', summary: '崩了' } as any);
    p = tasks.getTask(x.t.id)!;
    assert.equal(p.review_state, 'failed', '每轮只换一次');
    assert.equal(rv.reviewsOf(p.id).length, 2);
  });
  test('审的那位失联：换一位接着审；换上来的那位照常能给结论', async () => {
    three();
    const x = await done('claude'); x.finish();
    const c1 = child(x.t.id);
    x.runner.heartbeat('rv-gone', { executors: ['claude'] });
    const old = new Date(Date.now() - 3600_000).toISOString();
    dbm.db().prepare("UPDATE tasks SET status = 'running', runner_id = 'rv-gone', updated_at = ? WHERE id = ?").run(old, c1.id);
    dbm.db().prepare("UPDATE runners SET last_seen = ? WHERE id = 'rv-gone'").run(old);
    assert.deepEqual(rv.sweepReviews(), [], '换人了，不算没审成');
    let p = tasks.getTask(x.t.id)!;
    assert.equal(p.review_state, 'reviewing'); assert.equal(p.reviewer, 'workbuddy');
    assert.equal(tasks.getTask(c1.id)!.status, 'failed');
    const c2 = child(p.id);
    dbm.db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c2.id);
    x.runner.finishTask(c2.id, { result: 'done', no_changes: true, result_text: '```wb-review\n{"verdict":"过","summary":"可以","items":[]}\n```' } as any);
    p = tasks.getTask(x.t.id)!;
    assert.equal(p.review_state, 'passed');
    // 失联那位后来又活了：迟到的结论不算数
    rv.finishReview(tasks.getTask(c1.id)!, '```wb-review\n{"verdict":"要改","summary":"迟到","items":[{"problem":"x"}]}\n```', true, () => { throw new Error('不该作废'); });
    assert.equal(tasks.getTask(x.t.id)!.review_state, 'passed');
  });
});

describe('062 × 039：要审的任务，只改文档也先审', () => {
  const setup = async (files: string[], reviewer = 'claude') => {
    const runner = await import('../src/services/runner.ts');
    const appr = await import('../src/services/approvals.ts');
    const t = tasks.createTask({ title: '改文档', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'running', reviewer = ? WHERE id = ?").run(reviewer, t.id);
    runner.finishTask(t.id, { result: 'done', branch: `wb/T-${t.id}`, changed_files: files } as any);
    const merge = () => appr.listApprovals({ task_id: t.id }).find((x) => x.tool_name === 'git merge')!;
    const review = (verdict: string) => {
      const c = dbm.db().prepare('SELECT id FROM tasks WHERE review_of = ? ORDER BY id DESC').get(t.id) as any;
      dbm.db().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c.id);
      runner.finishTask(c.id, { result: 'done', no_changes: true, result_text: '```wb-review\n' + JSON.stringify({ verdict, summary: 's', items: verdict === '要改' ? [{ problem: 'x' }] : [] }) + '\n```' } as any);
    };
    return { t, merge, review };
  };
  test('做完那一刻不自动过，先派审；审过了才按规则自动过', async () => {
    const x = await setup(['docs/a.md', 'docs/b.md']);
    assert.equal(x.merge().status, 'pending', '没审之前不合并');
    assert.equal(tasks.getTask(x.t.id)!.review_state, 'reviewing');
    x.review('过');
    assert.equal(tasks.getTask(x.t.id)!.review_state, 'passed');
    assert.equal(x.merge().status, 'approved');
    assert.match(x.merge().feedback ?? '', /另一位审过，而且这次只改了 docs\/ 下的 2 个文件/);
  });
  test('拿不准、要改：不自动过', async () => {
    const a = await setup(['docs/a.md']); a.review('拿不准');
    assert.equal(a.merge().status, 'pending');
    const b = await setup(['docs/a.md']); b.review('要改');
    assert.notEqual(b.merge().status, 'approved');
  });
  test('有代码改动：审过了也要你点', async () => {
    const x = await setup(['docs/a.md', 'src/a.ts']); x.review('过');
    assert.equal(x.merge().status, 'pending');
  });
  test('开关关了：审过了也要你点', async () => {
    dbm.db().prepare("INSERT INTO settings (key, value) VALUES ('auto_approve_docs', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
    const x = await setup(['docs/a.md']); x.review('过');
    assert.equal(x.merge().status, 'pending');
  });
  test('不审的任务照旧：只改文档直接自动过', async () => {
    const x = await setup(['docs/a.md'], '');
    assert.equal(x.merge().status, 'approved');
    assert.equal(tasks.getTask(x.t.id)!.review_state, '');
  });
});

describe('039：需求单和交接文档不自动放行', () => {
  test('docs/specs/ 下的改动要你点；别的 docs/ 照旧', async () => {
    const appr = await import('../src/services/approvals.ts');
    assert.equal(appr.docsOnly(['docs/USAGE.md', 'docs/reports/a.md']), true);
    assert.equal(appr.docsOnly(['docs/specs/065-wechat-entry.md']), false);
    assert.equal(appr.docsOnly(['docs/USAGE.md', 'docs/specs/README.md']), false, '混着也不行');
    assert.equal(appr.docsOnly(['docs\\specs\\a.md']), false, '反斜杠写法一样拦');
    assert.equal(appr.docsOnly(['./docs/specs/a.md']), false);
    assert.equal(appr.docsOnly(['docs/specs-old/a.md']), true, '只拦 specs 这一个目录');
  });
});

describe('039：需求单和交接文档不自动放行', () => {
  test('docs/specs/ 下的改动要你点；别的文档照旧', async () => {
    const appr = await import('../src/services/approvals.ts');
    assert.equal(appr.docsOnly(['docs/USAGE.md', 'docs/reports/a.md']), true);
    assert.equal(appr.docsOnly(['docs/specs/065-x.md']), false);
    assert.equal(appr.docsOnly(['docs/USAGE.md', 'docs/specs/README.md']), false);
    assert.equal(appr.docsOnly(['docs\\specs\\a.md']), false);
    assert.equal(appr.autoMergeReason(['docs/specs/a.md'], 'git merge'), '');
  });
});

describe('接力链：经过谁、现在停在谁手里', () => {
  const mk = async (set: string, kind: string) => {
    const { relay } = await import('../src/views/thread.ts');
    const t = tasks.createTask({ title: '链', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare(`UPDATE tasks SET ${set} WHERE id = ?`).run(t.id);
    return String(relay(tasks.getTask(t.id)!, kind));
  };
  const now = (h: string) => /data-relay="(\w+)"/.exec(h)?.[1];
  test('干活 → 审 → 你，停在哪一环哪一环加深', async () => {
    let h = await mk("status = 'running', reviewer = 'claude'", 'running');
    assert.equal(now(h), 'work'); assert.match(h, /relay-step now" data-relay-step="work">Codex 做</); assert.match(h, /relay-step next" data-relay-step="review">Claude 审</);
    h = await mk("status = 'done', reviewer = 'claude', review_state = 'reviewing'", 'other');
    assert.equal(now(h), 'review'); assert.match(h, /relay-step done" data-relay-step="work">✓ Codex 做</);
    h = await mk("status = 'queued', reviewer = 'claude', review_state = 'fixing'", 'queued');
    assert.equal(now(h), 'work', '打回了，又回到干活的手里');
    h = await mk("status = 'done', reviewer = 'claude', review_state = 'passed'", 'approve');
    assert.equal(now(h), 'you'); assert.match(h, /data-relay-step="review">✓ Claude 审</); assert.match(h, /relay-step now" data-relay-step="you">你</);
    h = await mk("status = 'asking'", 'ask'); assert.equal(now(h), 'you');
    h = await mk("status = 'failed'", 'failed'); assert.equal(now(h), 'you');
    h = await mk("status = 'inbox'", 'start'); assert.equal(now(h), 'you', '还没开始：等你点开始');
  });
  test('不审的只有两环；做完了全是过了；派给自己的不显示', async () => {
    let h = await mk("status = 'running'", 'running');
    assert.ok(!h.includes('data-relay-step="review"'));
    h = await mk("status = 'done', reviewer = 'claude', review_state = 'passed'", 'done');
    assert.equal(now(h), 'over'); assert.ok(!h.includes('relay-step now')); assert.match(h, /✓ 你/);
    assert.equal(await mk("executor = 'me'", 'other'), '');
    h = await mk("status = 'running', reviewer = 'auto'", 'running'); assert.match(h, /另一位 审/);
  });
  test('线程里出现在标题下面', async () => {
    const { threadPanel } = await import('../src/views/thread.ts');
    const t = tasks.createTask({ title: '看链', executor: 'codex', project: 'demo' }, 'me');
    dbm.db().prepare("UPDATE tasks SET status = 'running', reviewer = 'claude' WHERE id = ?").run(t.id);
    const h = String(threadPanel(tasks.getTask(t.id)!));
    assert.ok(h.indexOf('thread-title') < h.indexOf('data-relay=') && h.indexOf('data-relay=') < h.indexOf('class="says"'));
  });
});
