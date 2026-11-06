// 041：战绩——每个执行者在每类活上做得怎么样。
//
// 这一单的口径比功能重要：一个任务算给谁、什么算「一次过」、样本多小算太少。
// 算错了不会报错，只会让 042 的大脑拿着假经验派活，所以每条口径都钉一个用例。
//   1. 五种结局；2. 接手后仍算原执行者；3. 老数据回填（读不出来就不算，不猜）；
//   4. 样本太少不出百分比；5. 窗口与 WB_TZ 的午夜边界；6. 空库不报错；7. 接口要鉴权；
//   8. 剧组页真的印了那一行。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-041-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';
// 时区必须在 import domain 之前定下来：那里读一次就记住了。
process.env.WB_TZ = 'Asia/Shanghai';

let tasks: typeof import('../src/services/tasks.ts');
let approvals: typeof import('../src/services/approvals.ts');
let score: typeof import('../src/services/scorecard.ts');
let D: typeof import('../src/db.ts');

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  approvals = await import('../src/services/approvals.ts');
  score = await import('../src/services/scorecard.ts');
});
after(() => { delete process.env.WB_DB; });

/** 直接落一条「已经结束」的任务：时间和状态都要精确可控，所以不用 updateTask 的「现在」。 */
function endedAt(executor: string, completedAt: string, opts: { status?: string; category?: string; backend?: string; tokens?: number; minutes?: number } = {}): number {
  const t = tasks.createTask({ title: `T-${completedAt}`, executor, status: 'running', category: opts.category ?? 'dev' }, executor);
  const start = new Date(new Date(completedAt).getTime() - (opts.minutes ?? 10) * 60000).toISOString();
  D.db().prepare('UPDATE tasks SET status = ?, completed_at = ?, started_at = ?, backend = ?, tokens_used = ? WHERE id = ?')
    .run(opts.status ?? 'done', completedAt, start, opts.backend ?? null, opts.tokens ?? 0, t.id);
  return t.id;
}

/** 一条真的跑过一遍的任务：开跑 → （可选）审批 → 结束。顺序要照真实走，不然只是在测一个假状态。 */
function ran(opts: { executor: string; decision?: 'changes' | 'takeover'; end?: 'done' | 'failed' | 'never'; at?: string }): number {
  const at = opts.at ?? '2026-11-02T10:00:00+08:00';
  const t = tasks.createTask({ title: `T-${opts.executor}`, executor: opts.executor, status: 'running', category: 'dev' }, opts.executor);
  if (opts.decision) {
    // 审批只发生在跑的时候；建审批会把任务推到 review，决定之后又回 running。
    const a = approvals.createApproval({ title: '跑测试', task_id: t.id, tool_name: 'bash' });
    approvals.decideApproval(a.id, opts.decision, opts.decision === 'changes' ? '这里不对，重做' : '', 'me');
  }
  const end = opts.end ?? 'done';
  if (end === 'never') return t.id;
  const start = new Date(new Date(at).getTime() - 10 * 60000).toISOString();
  D.db().prepare('UPDATE tasks SET status = ?, completed_at = ?, started_at = ? WHERE id = ?').run(end, at, start, t.id);
  return t.id;
}

const now = new Date('2026-11-03T12:00:00+08:00');

describe('041 A · 五种结局', () => {
  test('一次过：done 且没有返工、没有接手', () => {
    const id = ran({ executor: 'claude' });
    assert.equal(score.outcomeOf(tasks.getTask(id)!), 'first_pass');
  });

  test('返工后过：done，被打回过一次', () => {
    const id = ran({ executor: 'codex', decision: 'changes' });
    assert.equal(score.outcomeOf(tasks.getTask(id)!), 'rework');
  });

  test('你接手：有 takeover，哪怕最后还是 done', () => {
    const id = ran({ executor: 'local', decision: 'takeover' });
    assert.equal(score.outcomeOf(tasks.getTask(id)!), 'takeover');
  });

  test('失败就是失败，不因为返工过改口径', () => {
    const id = ran({ executor: 'autoclaw', decision: 'changes', end: 'failed' });
    assert.equal(score.outcomeOf(tasks.getTask(id)!), 'failed');
  });

  test('没结束的不算（running / queued / review 都是未结束）', () => {
    const id = ran({ executor: 'claude', end: 'never' });
    assert.equal(score.outcomeOf(tasks.getTask(id)!), 'unfinished');
  });
});

describe('041 B · 接手之后仍算原来那个人', () => {
  test('排队建、后来才开跑：第一次进 running 时记下当时的执行者', () => {
    const t = tasks.createTask({ title: '排队的活', executor: 'codex', category: 'docs' }, 'me');
    assert.equal(t.first_executor, null, '还没开跑就是不知道，不能先写上');

    const started = tasks.updateTask(t.id, { status: 'running' }, 'codex');
    assert.equal(started.first_executor, 'codex', '开跑那一刻是谁就是谁');

    const moved = tasks.updateTask(t.id, { executor: 'pool' }, 'me');
    assert.equal(moved.first_executor, 'codex', '事后换执行者是派单，不是重做');
  });

  test('takeover 把 executor 改成 me，战绩还是算给原执行者，且没有 me 这一行', () => {
    const id = ran({ executor: 'workbuddy', decision: 'takeover', at: '2026-11-02T11:00:00+08:00' });

    const t = tasks.getTask(id)!;
    assert.equal(t.executor, 'me', '任务当前确实在我手上');
    assert.equal(t.first_executor, 'workbuddy', '但第一次是谁做的要留着');

    const card = score.scorecard({ days: 30, now });
    const c = card.by_executor.find((x) => x.executor === 'workbuddy')!;
    assert.ok(c, '要有一条 workbuddy 的战绩');
    assert.equal(c.n, 1);
    assert.equal(c.takeover_rate, 1, '这一单算「你接手」');
    assert.equal(card.by_executor.some((x) => x.executor === 'me'), false, 'me 不进战绩');
  });
});

describe('041 C · 老数据回填', () => {
  const dirs: string[] = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  /** 造一个「041 那一版」的库：停在加 first_executor 那条迁移之后，再塞两条老数据进去。 */
  function oldDb(seed: (d: any) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'wb-041-'));
    dirs.push(dir);
    const file = join(dir, 'workbench.db');
    // 停在「加 first_executor 之前」：这样重开时会真的跑 041 那条迁移，回填才有机会发生。
    // 按「哪条迁移加了这一列」定位版本，而不是 `user_version - 1`：后者只在 041 是最后一条时成立，
    // 042 一进来就会把「老库」造在 042 之后，于是重复加列。
    const first = D.openDb(file, { at: D.versionAfter('first_executor') - 1 });
    seed(first);
    first.close();
    return file;
  }

  const insert = (d: any, id: number, executor: string) => d.prepare(`INSERT INTO tasks
    (id, title, description, category, executor, project, status, created_at, updated_at)
    VALUES (?, '老任务', '', 'dev', ?, '', 'running', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(id, executor);

  test('接手过（executor 已经是 me）的老任务：从事件里找回原来的执行者', () => {
    const file = oldDb((d) => {
      insert(d, 501, 'me');
      d.prepare("INSERT INTO events (ts, actor, kind, task_id, text) VALUES ('2026-10-01T01:00:00Z','claude','approval.requested',501,'claude 请求审批')").run();
    });
    const back = D.openDb(file);
    const row = back.prepare('SELECT first_executor FROM tasks WHERE id = 501').get() as { first_executor: string | null };
    assert.equal(row.first_executor, 'claude');
    back.close();
  });

  // 041.1：以前这条写的是「直接用当前执行者」——那正是被审查挡回来的猜法。
  // 现在只有「被领取过 + 从没换过人」才认当前执行者（见 score0411 那组）；连领取记录都没有的，
  // 谁做的已经查不出来了，宁可留空。
  test('没证据的老任务：留空，不按当前执行者猜', () => {
    const file = oldDb((d) => { insert(d, 502, 'codex'); });
    const back = D.openDb(file);
    const row = back.prepare('SELECT first_executor FROM tasks WHERE id = 502').get() as { first_executor: string | null };
    assert.equal(row.first_executor, null);
    back.close();
  });

  test('什么都查不到就留空——空的不计入战绩，不猜', () => {
    const file = oldDb((d) => {
      insert(d, 503, 'me');
      d.prepare("INSERT INTO events (ts, actor, kind, task_id, text) VALUES ('2026-10-01T01:00:00Z','me','task.created',503,'自己建的')").run();
    });
    const back = D.openDb(file);
    const row = back.prepare('SELECT first_executor FROM tasks WHERE id = 503').get() as { first_executor: string | null };
    assert.equal(row.first_executor, null, '读不出来不等于没有，但也不能编一个');
    back.close();
  });
});

describe('041 D · 样本太少不出百分比', () => {
  const days = 30;
  const at = (h: number) => `2026-11-02T${String(h).padStart(2, '0')}:00:00+08:00`;

  test('3 单：sample=few，页面那行写「样本太少」且没有百分比', () => {
    for (let i = 0; i < 3; i++) endedAt('pool', at(10 + i), { category: 'ops' });
    const c = score.scorecard({ days, now }).by_executor.find((x) => x.executor === 'pool')!;
    assert.equal(c.n, 3);
    assert.equal(c.sample, 'few');
    const line = score.summaryLine(c, days);
    assert.match(line, /近 30 天 3 单，样本太少/);
    assert.equal(line.includes('%'), false, '样本太少就别摆百分比，那是两个数算出来的噪音');
  });

  test('凑到 5 单：sample=ok，一次过率按事实算', () => {
    for (let i = 0; i < 2; i++) endedAt('pool', at(14 + i), { category: 'ops' });
    const c = score.scorecard({ days, now }).by_executor.find((x) => x.executor === 'pool')!;
    assert.equal(c.n, 5);
    assert.equal(c.sample, 'ok');
    assert.equal(c.first_pass_rate, 1);
    assert.match(score.summaryLine(c, days), /一次过 100%/);
  });
});

describe('041 E · 时间窗口（WB_TZ 的日历日）', () => {
  test('第 30 天算、第 31 天不算：窗口是今天 + 前 29 天', () => {
    // now = 11-03 12:00 (+08) → 窗口从 10-05 起
    const inWindow = endedAt('zcode', '2026-10-05T09:00:00+08:00', { category: 'docs' });
    const outWindow = endedAt('zcode', '2026-10-04T09:00:00+08:00', { category: 'docs' });
    const r = score.scorecard({ days: 30, now });
    assert.equal(r.from, '2026-10-05');
    const ids = r.rows.filter((x) => x.executor === 'zcode').reduce((n, x) => n + x.n, 0);
    assert.equal(ids, 1, '窗口里只应该有 10-05 那条');
    assert.ok(inWindow && outWindow);
  });

  test('跨午夜那一小时按 +08 算：UTC 还是前一天，本地已经是今天', () => {
    // 2026-10-04T15:30Z = 10-04 23:30 (+08)，在窗口外
    // 2026-10-04T16:30Z = 10-05 00:30 (+08)，在窗口内
    endedAt('dsh', '2026-10-04T15:30:00Z', { category: 'docs' });
    endedAt('dsh', '2026-10-04T16:30:00Z', { category: 'docs' });
    const c = score.scorecard({ days: 30, now }).by_executor.find((x) => x.executor === 'dsh')!;
    assert.equal(c.n, 1, 'UTC 同一天的两条，按本地日算应该只进一条');
  });
});

describe('041 F · 接口与页面', () => {
  let server: Server;
  let base = '';
  let cookie = '';

  before(async () => {
    const { handle } = await import('../src/app.ts');
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  after(() => { server.close(); });

  test('不带鉴权 → 401', async () => {
    const res = await fetch(`${base}/api/scorecard`);
    assert.equal(res.status, 401);
  });

  test('带 Bearer → 拿到表和两份分组', async () => {
    const res = await fetch(`${base}/api/scorecard?days=30`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const j = await res.json() as any;
    assert.equal(j.days, 30);
    assert.ok(Array.isArray(j.rows) && Array.isArray(j.by_executor) && Array.isArray(j.by_backend));
    assert.ok(j.rows.every((r: any) => 'sample' in r && 'median_ms' in r && 'avg_tokens' in r));
  });

  test('剧组页每个执行者下面有一行战绩', async () => {
    cookie = await loginCookie(base, process.env.WB_PASSWORD!);
    const res = await fetch(`${base}/team`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /近 30 天 \d+ 单/);
    assert.match(page, /class="score-line"/, '战绩那一行还在（040 之后挪进了管理块）');
  });

  test('空库：接口给空列表，页面写「还没有战绩」，都不报错', async () => {
    const prev = D.db();
    const fresh = D.openDb(':memory:');
    D.useDb(fresh);
    try {
      const r = score.scorecard({ days: 30, now });
      assert.deepEqual(r.rows, []);
      assert.equal(score.summaryLine(undefined, 30), '近 30 天还没有战绩');
      const res = await fetch(`${base}/api/scorecard`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const j = await res.json() as any;
      assert.deepEqual(j.rows, []);
    } finally {
      D.useDb(prev);
      fresh.close();
    }
  });
});
