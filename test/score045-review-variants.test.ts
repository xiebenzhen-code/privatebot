// 独立复核反例（作者测试之外自己补的变体）。
// 期望值按 041/045 已公布的口径写：首轮失败重试成功算返工、同一失败不重复计、一轮审查只算一次、
// 中性运行（limited/cancelled/asked）不进样本、归属与耗时 token 取第一条有效运行、接手优先。
import { afterEach, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WB_DB = ':memory:';
process.env.WB_TZ = 'America/Chicago';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
let score: typeof import('../src/services/scorecard.ts');
let cap: typeof import('../src/services/capability.ts');
let metrics: typeof import('../src/services/metrics.ts');
const now = new Date('2026-11-13T18:00:00Z');
const S = '2026-11-12T16:00:00Z';
const E = '2026-11-12T16:05:00Z';

before(async () => {
  D = await import('../src/db.ts'); tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts'); score = await import('../src/services/scorecard.ts');
  cap = await import('../src/services/capability.ts'); metrics = await import('../src/services/metrics.ts');
});
beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  D.db().exec('DELETE FROM tasks; DELETE FROM events; DELETE FROM reviews; DELETE FROM approvals;');
});
afterEach(() => { mock.timers.reset(); });

function task(executor = 'claude') {
  return tasks.createTask({ title: 'V', executor, category: 'dev', status: 'running' }, 'me').id;
}
function run(id: number, outcome: 'done' | 'failed' | 'limited' | 'cancelled' | 'taken_over' | 'asked',
  executor = 'claude', tokens = 10, model = 'm') {
  const r = runs.openRun(id, executor, 'brain');
  runs.closeRun(id, outcome as never, { tokens, harness: 'claude-code', model, backend: 'official' });
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run(S, E, r.id);
  return r.id;
}
function finish(id: number, status: 'done' | 'failed' = 'done') {
  D.db().prepare('UPDATE tasks SET status=?,started_at=?,completed_at=?,tokens_used=999 WHERE id=?')
    .run(status, '2026-11-13T17:00:00Z', '2026-11-13T17:01:00Z', id);
}
function ev(id: number) {
  D.db().prepare('INSERT INTO events(ts,actor,kind,task_id,text) VALUES(?,?,?,?,?)').run(E, 'system', 'task.status', id, '运行中 → 失败');
}
function review(id: number, round: number, verdict = 'changes') {
  D.db().prepare('INSERT INTO reviews(task_id,round,reviewer,verdict,summary,items,at) VALUES(?,?,?,?,?,?,?)')
    .run(id, round, 'codex', verdict, 'x', '[]', E);
}

test('V1 连续两次失败无事件后成功：返工记两次，不是零次', () => {
  const id = task(); run(id, 'failed'); run(id, 'failed'); run(id, 'done'); finish(id);
  const f = score.factsOf([id]).get(id)!;
  assert.equal(f.changes, 2);
  assert.equal(f.retried, true);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'rework');
  const row = score.scorecard({ now }).by_executor[0];
  assert.equal(row.first_pass_rate, 0);
  assert.equal(row.rework_avg, 2);
  assert.equal(row.fail_rate, 0);
});

test('V2 两次失败各有事件：不因两条证据翻成四次', () => {
  const id = task(); run(id, 'failed'); run(id, 'failed'); run(id, 'done'); finish(id); ev(id); ev(id);
  assert.equal(score.factsOf([id]).get(id)!.changes, 2);
});

test('V3 两次失败只有一条事件：补齐差的那一次，不重复', () => {
  const id = task(); run(id, 'failed'); run(id, 'failed'); run(id, 'done'); finish(id); ev(id);
  assert.equal(score.factsOf([id]).get(id)!.changes, 2);
});

test('V4 同一轮四条审查记录只算一次，两轮算两次', () => {
  const id = task(); run(id, 'done'); finish(id);
  review(id, 1); review(id, 1); review(id, 2); review(id, 2);
  assert.equal(score.factsOf([id]).get(id)!.changes, 2);
  assert.equal(metrics.ledger(365).items.find((x) => x.id === id)?.outcome, 'fix');
});

test('V5 审查判 failed（没审成）不算打回', () => {
  const id = task(); run(id, 'done'); finish(id);
  review(id, 1, 'failed');
  assert.equal(score.factsOf([id]).get(id)?.changes ?? 0, 0);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'first_pass');
});

test('V6 失败与审查打回是两件事：各记一次', () => {
  const id = task(); run(id, 'failed'); run(id, 'done'); finish(id); review(id, 1);
  assert.equal(score.factsOf([id]).get(id)!.changes, 2);
});

test('V7 首轮就是接手：不算一次过，也不算执行者失败', () => {
  const id = task(); run(id, 'taken_over'); finish(id);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'takeover');
  assert.equal(metrics.ledger(365).items.find((x) => x.id === id)?.outcome, 'me');
});

test('V7b 接手的单不进能力样本（041：接手不算执行者的失败）', () => {
  const id = task(); run(id, 'taken_over'); finish(id);
  assert.deepEqual(cap.samples(90, now), []);
});

test('V8 失败后人工接手再完成：接手优先，不记失败', () => {
  const id = task(); run(id, 'failed'); run(id, 'taken_over', 'me'); finish(id);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'takeover');
  assert.equal(score.scorecard({ now }).by_executor[0].fail_rate, 0);
});

test('V9 中性运行夹在中间不改变首轮：归属、耗时、token 仍取那次 failed', () => {
  const id = task();
  const r1 = run(id, 'failed', 'claude', 11, 'model-a');
  run(id, 'asked', 'codex', 999, 'model-z');
  run(id, 'done', 'codex', 777, 'model-y');
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run('2026-11-12T10:00:00Z', '2026-11-12T10:10:00Z', r1);
  finish(id);
  const card = score.scorecard({ now });
  const row = card.by_executor.find((x) => x.executor === 'claude')!;
  assert.equal(row.n, 1);
  assert.equal(row.avg_tokens, 11);
  assert.equal(row.median_ms, 600000);
  assert.equal(card.by_backend[0].backend, 'official');
  assert.equal(score.factsOf([id]).get(id)!.changes, 1);
  assert.equal(cap.samples(90, now)[0]?.model, 'model-a');
});

test('V10 asked/limited 全中性：不进战绩、不进能力、不进完成账目', () => {
  const id = task(); run(id, 'asked'); run(id, 'limited'); finish(id);
  assert.equal(metrics.ledger(365).items.length, 0);
  assert.equal(score.scorecard({ now }).by_executor.length, 0);
  assert.equal(cap.samples(90, now).length, 0);
});

test('V11 只有失败没有后续运行、任务终态失败：记失败，不记返工', () => {
  const id = task(); run(id, 'failed'); finish(id, 'failed');
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'failed');
  assert.equal(score.factsOf([id]).get(id)?.changes ?? 0, 0);
  assert.equal(metrics.ledger(365).items.find((x) => x.id === id)?.outcome, 'fail');
});

test('V12 账目与战绩同一单口径一致：首轮失败重试成功两边都算返工', () => {
  const id = task(); run(id, 'failed'); run(id, 'done'); finish(id);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'rework');
  assert.equal(metrics.ledger(365).items.find((x) => x.id === id)?.outcome, 'fix');
});

test('V13 回填失败运行（backfilled=1）不算返工 —— 记录当前行为', () => {
  const id = task(); const r1 = run(id, 'failed'); run(id, 'done'); finish(id);
  D.db().prepare('UPDATE runs SET backfilled=1 WHERE id=?').run(r1);
  assert.equal(score.factsOf([id]).get(id)?.changes ?? 0, 0);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'first_pass');
});

test('V14 回填运行但没有归属：不进战绩，账目按旧字段进出', () => {
  const id = task(); const r1 = run(id, 'limited');
  D.db().prepare('UPDATE runs SET backfilled=1 WHERE id=?').run(r1);
  D.db().prepare('UPDATE tasks SET first_executor=NULL WHERE id=?').run(id);
  finish(id);
  const card = score.scorecard({ now });
  assert.equal(card.by_executor.length, 0);
  assert.equal(card.skipped, 1);
  assert.equal(metrics.ledger(365).items.find((x) => x.id === id)?.outcome, 'once');
});

test('V15 跨周任务：今天做完的，周账目必须看得到，且记在完成任务那一天', () => {
  const id = task();
  const r1 = run(id, 'done', 'claude', 41);
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run('2026-11-03T16:00:00Z', '2026-11-03T16:05:00Z', r1);
  finish(id);
  const week = metrics.ledger(7).items.find((x) => x.id === id);
  assert.ok(week, '今天完成的单不能从周账目里消失');
  assert.equal(week.day, '2026-11-13');
  assert.equal(week.tokens, 41, 'token 仍取首轮运行，不取任务累计 999');
});

test('V16 跨周任务：账目按完成日收，战绩与能力窗口仍按首轮（两边口径不互相污染）', () => {
  const id = task();
  const r1 = run(id, 'done');
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run('2026-11-03T16:00:00Z', '2026-11-03T16:05:00Z', r1);
  finish(id);
  assert.equal(score.scorecard({ days: 7, now }).by_executor.length, 0, '首轮在窗口外，战绩不收');
  assert.equal(cap.samples(7, now).length, 0, '能力窗口同口径');
  assert.equal(metrics.ledger(7).items.find((x) => x.id === id)?.day, '2026-11-13', '账目按完成日照收');
});

test('V17 没有运行记录的旧任务：分桶日与统计值都退回任务原字段', () => {
  const id = task(); finish(id);
  const item = metrics.ledger(7).items.find((x) => x.id === id);
  assert.equal(item?.day, '2026-11-13');
  assert.equal(item?.tokens, 999);
});
