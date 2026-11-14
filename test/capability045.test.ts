// 045 §4/§5：能力档案（先验 + 战绩）与战绩改读运行。守这几件事——
//   先验文件：没来源、没日期、分数越界、键重复，一律加载失败；仓库里那份必须过。
//   混合算法：0 单全是先验、5 单各半、20 单先验剩 20%；没有先验的键只看实战。
//   样本口径：近 90 天、每个任务第一条算数的运行；limited / cancelled 不算；没记框架或模型的不猜。
//   大脑：先验附在候选后面，超预算先裁先验；先验文件坏了不影响派单。
//   战绩回归：同一批数据，读运行和只读 first_executor（041 旧口径）结果必须一模一样。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-c045-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-c045-0123456789';
process.env.WB_TZ = 'Asia/Shanghai';

let app: Server;
let base = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
let approvals: typeof import('../src/services/approvals.ts');
let cap: typeof import('../src/services/capability.ts');
let score: typeof import('../src/services/scorecard.ts');
let brain: typeof import('../src/services/brain.ts');
const dirs: string[] = [];

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts');
  approvals = await import('../src/services/approvals.ts');
  cap = await import('../src/services/capability.ts');
  score = await import('../src/services/scorecard.ts');
  brain = await import('../src/services/brain.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => {
  app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => { D.useDb(D.openDb(':memory:')); });

const now = new Date('2026-11-03T12:00:00+08:00');
const DAY = 86400000;

/**
 * 一个已经结束的任务，照真实顺序走：建任务 → 开跑（可先有一次到上限）→ （审批）→ 收尾 → 落终态。
 * 终态和时间直接写库，因为窗口边界要精确可控。
 */
function finished(o: {
  executor?: string; category?: string; harness?: string; model?: string;
  rework?: boolean; fail?: boolean; takeover?: boolean;
  limitedFirst?: { harness: string; model: string };
  daysAgo?: number;
} = {}): number {
  const executor = o.executor ?? 'claude';
  const t = tasks.createTask({ title: 'cap 单', executor, status: 'running', category: o.category ?? 'dev' }, executor);
  if (o.limitedFirst) {
    runs.openRun(t.id, executor, '');
    runs.closeRun(t.id, 'limited', { harness: o.limitedFirst.harness, model: o.limitedFirst.model, reason: '到上限' });
  }
  runs.openRun(t.id, executor, '');
  if (o.rework || o.takeover) {
    const a = approvals.createApproval({ title: '改个东西', task_id: t.id, tool_name: 'bash' });
    approvals.decideApproval(a.id, o.takeover ? 'takeover' : 'changes', o.takeover ? '' : '不对，重做', 'me');
  }
  runs.closeRun(t.id, o.fail ? 'failed' : 'done', { harness: o.harness ?? 'claude-code', model: o.model ?? 'claude-opus-4-6' });
  const end = new Date(now.getTime() - (o.daysAgo ?? 1) * DAY).toISOString();
  const start = new Date(new Date(end).getTime() - 600000).toISOString();
  D.db().prepare('UPDATE tasks SET status = ?, completed_at = ?, started_at = ? WHERE id = ?').run(o.fail ? 'failed' : 'done', end, start, t.id);
  // 统计已迁到运行时间；夹具中的任务与运行必须描述同一段历史。
  D.db().prepare('UPDATE runs SET ended_at = ?, started_at = ? WHERE task_id = ?').run(end, start, t.id);
  return t.id;
}

const OK = {
  harness: 'claude-code', model: 'm-1', category: 'dev', level: 'medium',
  evidence: [{ benchmark: 'B', score: 0.5, source: 'https://example.com/x', as_of: '2026-10', vendor_reported: true }],
};
const withEv = (patch: Record<string, unknown>) => ({ ...OK, evidence: [{ ...OK.evidence[0], ...patch }] });

describe('045 §4 · 先验文件校验', () => {
  test('合格的过得去，note 可选', () => {
    const p = cap.parsePriors([OK, { ...OK, model: 'm-2', evidence: [{ ...OK.evidence[0], as_of: '2026-10-19', note: '二手' }] }]);
    assert.equal(p.length, 2);
    assert.equal(p[1].evidence[0].note, '二手');
  });

  test('缺来源 / 来源不是网址 / 缺日期 / 日期乱写 / 分数越界 / 没写厂商自报：全部加载失败', () => {
    const cases: [unknown, RegExp][] = [
      [withEv({ source: undefined }), /来源不是网址/],
      [withEv({ source: 'abhs.in/blog/x' }), /来源不是网址/],
      [withEv({ source: 'ftp://example.com/x' }), /来源不是网址/],
      [withEv({ source: 'https://localhost/x' }), /来源不是网址/],
      [withEv({ as_of: undefined }), /缺日期/],
      [withEv({ as_of: '2026-13' }), /缺日期/],
      [withEv({ as_of: 'last month' }), /缺日期/],
      [withEv({ score: 80.8 }), /0~1/],
      [withEv({ score: '0.8' }), /0~1/],
      [withEv({ vendor_reported: undefined }), /vendor_reported/],
      [{ ...OK, evidence: [] }, /至少要有一条/],
      [{ ...OK, evidence: undefined }, /至少要有一条/],
      [{ ...OK, level: 'great' }, /level/],
      [{ ...OK, category: 'cooking' }, /不是已知分类/],
      [{ ...OK, model: '' }, /model 不合法/],
    ];
    for (const [entry, re] of cases) assert.throws(() => cap.parsePriors([entry]), re, JSON.stringify(entry).slice(0, 80));
  });

  test('键重复、不是数组：失败，并且说是第几条', () => {
    assert.throws(() => cap.parsePriors([OK, OK]), /第 2 条.*重复/);
    assert.throws(() => cap.parsePriors({}), /数组/);
    assert.throws(() => cap.parsePriors([OK, { ...OK, model: 'm-2', evidence: [] }]), /第 2 条/);
  });

  test('仓库里那份先验能过，且每条证据都有网址和日期', () => {
    const priors = cap.loadPriors();
    assert.ok(priors.length > 0);
    for (const p of priors) for (const e of p.evidence) {
      assert.match(e.source, /^https:\/\//);
      assert.match(e.as_of, /^\d{4}-\d{2}/);
    }
  });
});

describe('045 §4 · 混合算法', () => {
  test('0 单全是先验；5 单各占一半；20 单先验只剩 20%', () => {
    assert.deepEqual(cap.blend(0, null, 'medium'), { value: 0.6, prior_share: 1 });
    const five = cap.blend(5, 1, 'medium');
    assert.equal(five.prior_share, 0.5);
    assert.ok(Math.abs(five.value! - 0.8) < 1e-9);
    const twenty = cap.blend(20, 0.5, 'strong');
    assert.ok(Math.abs(twenty.prior_share - 0.2) < 1e-9);
    assert.ok(Math.abs(twenty.value! - 0.56) < 1e-9);
  });

  test('strong / medium / weak 分别是 0.8 / 0.6 / 0.4', () => {
    assert.equal(cap.blend(0, null, 'strong').value, 0.8);
    assert.equal(cap.blend(0, null, 'medium').value, 0.6);
    assert.equal(cap.blend(0, null, 'weak').value, 0.4);
  });

  test('没有先验：只看实战；没样本就没有值', () => {
    assert.deepEqual(cap.blend(4, 0.25, null), { value: 0.25, prior_share: 0 });
    assert.deepEqual(cap.blend(0, null, null), { value: null, prior_share: 0 });
  });
});

describe('045 §4 · 能力档案（读运行）', () => {
  const priors = (level: 'strong' | 'medium' | 'weak' = 'medium') => cap.parsePriors([{ ...OK, model: 'm-1', level }]);
  const find = (items: any[], model: string) => items.find((i) => i.model === model);

  test('随样本变：先验 → 混合 → 实战，标签和占比跟着走', () => {
    let r = cap.capabilities({ now, priors: priors() });
    const zero = find(r.items, 'm-1');
    assert.equal(zero.label, '先验');
    assert.equal(zero.n, 0);
    assert.equal(zero.blended, 0.6);
    assert.equal(zero.prior_share, 1);
    assert.equal(zero.own_rate, null);

    for (let i = 0; i < 5; i++) finished({ model: 'm-1' });
    r = cap.capabilities({ now, priors: priors() });
    const five = find(r.items, 'm-1');
    assert.equal(five.n, 5);
    assert.equal(five.own_rate, 1);
    assert.equal(five.label, '混合');
    assert.equal(five.prior_share, 0.5);
    assert.equal(five.blended, 0.8);

    for (let i = 0; i < 15; i++) finished({ model: 'm-1', rework: i < 10 });
    r = cap.capabilities({ now, priors: priors() });
    const twenty = find(r.items, 'm-1');
    assert.equal(twenty.n, 20);
    // 前 5 单 + 后 15 单里 5 单没返工 = 10 单一次过
    assert.equal(twenty.own_rate, 0.5);
    assert.equal(twenty.label, '实战');
    assert.equal(twenty.prior_share, 0.2);
    assert.equal(twenty.blended, 0.52); // 0.8 × 0.5 + 0.2 × 0.6
  });

  test('返工、失败都不算一次过；它们仍然是样本', () => {
    finished({ model: 'm-1' });
    finished({ model: 'm-1', rework: true });
    finished({ model: 'm-1', fail: true });
    const it = find(cap.capabilities({ now, priors: [] }).items, 'm-1');
    assert.equal(it.n, 3);
    assert.equal(it.own_rate, 0.33);
  });

  test('limited 不算：第一次到上限、第二次做完，样本记在第二次用的模型上', () => {
    finished({ model: 'm-b', limitedFirst: { harness: 'claude-code', model: 'm-a' } });
    const items = cap.capabilities({ now, priors: [] }).items;
    assert.equal(find(items, 'm-a'), undefined, 'm-a 只是到了上限，不是它做砸了');
    assert.equal(find(items, 'm-b').n, 1);
  });

  test('只有 limited / cancelled 的任务不进样本', () => {
    const t = tasks.createTask({ title: 'x', executor: 'claude', status: 'running' }, 'claude');
    runs.openRun(t.id, 'claude', '');
    runs.closeRun(t.id, 'limited', { harness: 'claude-code', model: 'm-1' });
    runs.openRun(t.id, 'claude', '');                  // 上一条没收尾的会被标成「被取代」
    runs.openRun(t.id, 'claude', '');
    D.db().prepare("UPDATE runs SET outcome = 'cancelled' WHERE task_id = ?").run(t.id);
    D.db().prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(new Date(now.getTime() - DAY).toISOString(), t.id);
    assert.equal(cap.samples(90, now).length, 0);
  });

  test('没记框架或模型的运行、回填来的运行，一律不进样本（不猜）', () => {
    finished({ harness: '' as any, model: 'm-1' });          // closeRun 里空框架不会覆盖，仍是空
    finished({ model: '' as any });
    const id = finished({ model: 'm-1' });
    D.db().prepare('UPDATE runs SET harness = ?, backfilled = 1 WHERE task_id = ?').run('', id);
    assert.equal(cap.samples(90, now).length, 0);
  });

  test('窗口 90 天：91 天前完成的不算；不同分类各记各的', () => {
    finished({ model: 'm-1', daysAgo: 91 });
    finished({ model: 'm-1', daysAgo: 89 });
    finished({ model: 'm-1', category: 'docs' });
    const items = cap.capabilities({ now, priors: [] }).items;
    assert.equal(items.find((i) => i.category === 'dev')!.n, 1);
    assert.equal(items.find((i) => i.category === 'docs')!.n, 1);
  });

  test('没有先验的键：只显示实战；不到 5 单标样本太少', () => {
    for (let i = 0; i < 4; i++) finished({ model: 'm-x' });
    let it = find(cap.capabilities({ now, priors: [] }).items, 'm-x');
    assert.equal(it.label, '实战');
    assert.equal(it.prior_level, null);
    assert.equal(it.prior_share, 0);
    assert.equal(it.sample, 'few');
    finished({ model: 'm-x' });
    it = find(cap.capabilities({ now, priors: [] }).items, 'm-x');
    assert.equal(it.sample, 'ok');
  });

  test('接口：要令牌；返回混合值、n、先验占比、标签和出处', async () => {
    const no = await fetch(`${base}/api/capabilities`, { redirect: 'manual' });
    assert.notEqual(no.status, 200);
    const res = await fetch(`${base}/api/capabilities`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const j = await res.json() as { days: number; items: any[] };
    assert.equal(j.days, 90);
    const opus = j.items.find((i) => i.model === 'claude-opus-4-6');
    assert.ok(opus, '仓库里的先验应该出现，哪怕一单都没跑过');
    assert.equal(opus.label, '先验');
    assert.equal(opus.n, 0);
    assert.equal(opus.blended, 0.8);
    assert.match(opus.evidence[0].source, /^https:\/\//);
    assert.ok(opus.evidence[0].as_of);
  });
});

describe('045 §4 · 给大脑的那一句', () => {
  test('候选后面追加这个执行者所用模型的先验；lean 版没有先验', () => {
    // 200 天前的一单：只让工作台知道「这个执行者用的是什么模型」，不进 90 天样本。
    finished({ executor: 'claude', daysAgo: 200 });
    assert.deepEqual(cap.executorModels().get('claude'), { harness: 'claude-code', model: 'claude-opus-4-6' });
    const c = brain.qualified('dev').candidates.find((x) => x.executor === 'claude');
    assert.ok(c, '默认设置里应该有 claude');
    assert.match(c.score, /评测先验约 80%（厂商自报，还没跑过）/);
    assert.doesNotMatch(c.score_lean, /先验/);
  });

  test('执行者还没有带模型的运行：照旧只有战绩那句', () => {
    const c = brain.qualified('dev').candidates[0];
    assert.equal(c.score, c.score_lean);
    assert.doesNotMatch(c.score, /先验/);
  });

  test('capabilityNote 的几种说法', () => {
    const base = { harness: 'h', model: 'm', category: 'dev', prior_level: null, prior_rate: null, evidence: [] };
    const prior = { ...base, n: 0, own_rate: null, blended: 0.6, prior_share: 1, label: '先验', sample: 'ok' } as any;
    assert.deepEqual(cap.capabilityNote(prior), { full: 'm 评测先验约 60%（厂商自报，还没跑过）', lean: '' });
    const mixed = { ...base, n: 6, own_rate: 0.5, blended: 0.55, prior_share: 0.45, label: '混合', sample: 'ok' } as any;
    const m = cap.capabilityNote(mixed)!;
    assert.match(m.full, /近 90 天 6 单 · 一次过 50%；混合约 55%（先验占 45%）/);
    assert.doesNotMatch(m.lean, /先验|混合/);
    const few = { ...base, n: 3, own_rate: 1, blended: 0.7, prior_share: 0.6, label: '混合', sample: 'ok' } as any;
    assert.match(cap.capabilityNote(few)!.lean, /3 单（样本太少）/);
    assert.equal(cap.capabilityNote(undefined), null);
  });

  test('提示词超预算：先裁掉先验、保留实战；放得下就都留着', () => {
    const t = tasks.createTask({ title: '长说明', description: '字'.repeat(1200), project: '', category: 'dev' }, 'me');
    const mk = (n: number) => ({
      paused: false, excluded: [],
      candidates: Array.from({ length: n }, (_, i) => ({
        executor: `e${i}`, label: '某某', brief: '简介', quota: '额度够',
        score: `近 30 天 6 单；${'先验'.repeat(50)}`, score_lean: '近 30 天 6 单', read_only_only: false,
      })),
    });
    const small = brain.promptFor(tasks.getTask(t.id)!, mk(3) as any);
    assert.match(small.user, /先验先验/, '放得下就不裁');
    const big = brain.promptFor(tasks.getTask(t.id)!, mk(30) as any);
    assert.doesNotMatch(big.user, /先验先验/, '放不下，先验先走');
    assert.equal((big.user.match(/^- e\d+｜/gm) ?? []).length, 30, '候选一个不少');
    assert.ok(big.system.length + big.user.length <= brain.MAX_PROMPT_CHARS + 120, `长度 ${big.system.length + big.user.length}`);
  });
});

describe('045 §5 · 战绩改读运行：新旧口径必须一致', () => {
  /** 同一个库，先按现在的（读运行）算，再把运行表清空——只剩 first_executor，就是 041 的旧口径。 */
  function sameWithAndWithoutRuns(): { withRuns: any; legacy: any } {
    const withRuns = score.scorecard({ now });
    D.db().exec('DELETE FROM runs');
    const legacy = score.scorecard({ now });
    return { withRuns, legacy };
  }

  test('正常领取的任务：完成、返工、失败、接手各来几单，结果一模一样', () => {
    finished({ executor: 'claude' });
    finished({ executor: 'claude', rework: true });
    finished({ executor: 'claude', fail: true, category: 'ops' });
    finished({ executor: 'codex' });
    finished({ executor: 'codex', takeover: true });
    finished({ executor: 'claude', limitedFirst: { harness: 'claude-code', model: 'm-a' } });
    // 会话任务（hook 造的）：没有运行记录，只有 first_executor
    const h = tasks.createTask({ title: '会话', executor: 'claude', status: 'running' }, 'claude');
    D.db().prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(new Date(now.getTime() - DAY).toISOString(), h.id);
    // 自己做的：不计入
    const me = tasks.createTask({ title: '我做的', executor: 'me', status: 'done' }, 'me');
    D.db().prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(new Date(now.getTime() - DAY).toISOString(), me.id);

    const { withRuns, legacy } = sameWithAndWithoutRuns();
    assert.ok(withRuns.rows.length >= 3 && withRuns.by_executor.length === 2, '人群得有点样子');
    assert.deepEqual(withRuns, legacy);
  });

  test('老库升级后回填的运行：与旧数字对得上；第一次是谁不知道的仍然跳过，不拿「现在的执行者」顶', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-c045-'));
    dirs.push(dir);
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    const at = D.versionAfter('CREATE TABLE IF NOT EXISTS runs') - 1;
    for (const m of D.MIGRATIONS.slice(0, at)) old.exec(m);
    old.exec(`PRAGMA user_version = ${at}`);
    const ts = new Date(now.getTime() - DAY).toISOString();
    const ins = old.prepare(`INSERT INTO tasks (title, status, executor, first_executor, started_at, completed_at, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'dev', ?, ?)`);
    ins.run('claude 做完', 'done', 'claude', 'claude', ts, ts, ts, ts);
    ins.run('claude 失败', 'failed', 'claude', 'claude', ts, ts, ts, ts);
    ins.run('codex 接手前做的', 'done', 'me', 'codex', ts, ts, ts, ts);
    ins.run('不知道谁做的', 'done', 'pool', null, ts, ts, ts, ts);
    ins.run('不知道谁做的（空串）', 'failed', 'claude', '', ts, ts, ts, ts);
    old.close();

    const fileDb = D.openDb(file);
    D.useDb(fileDb);
    // useDb 不会替你关旧连接。文件库不关，Windows 上 after() 删临时目录会 EBUSY：先切回内存库，再关这个。
    t.after(() => { D.useDb(D.openDb(':memory:')); fileDb.close(); });
    const guessed = D.db().prepare("SELECT COUNT(*) n FROM runs WHERE backfilled = 1 AND executor <> ''").get() as { n: number };
    assert.equal(guessed.n, 5, '回填确实给每个开跑过的任务补了一条（含猜的那两条）');
    const { withRuns, legacy } = sameWithAndWithoutRuns();
    assert.equal(withRuns.skipped, 2, '不知道谁做的：两条都跳过');
    assert.equal(withRuns.by_executor.reduce((s: number, c: any) => s + c.n, 0), 3);
    assert.deepEqual(withRuns, legacy);
  });

  test('有运行、没有 first_executor：运行说了算（接手也认），删掉运行就退回跳过', () => {
    const id = finished({ executor: 'claude' });
    D.db().prepare("UPDATE tasks SET first_executor = NULL, executor = 'me' WHERE id = ?").run(id);
    const a = score.scorecard({ now });
    assert.equal(a.skipped, 0);
    assert.equal(a.by_executor.length, 1);
    assert.equal(a.by_executor[0].executor, 'claude');
    assert.equal(a.by_executor[0].takeover_rate, 1, '执行者被改成 me，算接手');
    D.db().exec('DELETE FROM runs');
    const b = score.scorecard({ now });
    assert.equal(b.skipped, 1);
    assert.equal(b.by_executor.length, 0);
  });
});
