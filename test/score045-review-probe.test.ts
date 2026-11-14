// 独立复核探针（不判断对错，只把实际值打出来）。
// 目的：看同一单的「返工」会不会被多条证据重复累加、以及中性运行/回填/缺模型这些边界到底怎么算。
import { afterEach, before, beforeEach, mock, test } from 'node:test';

process.env.WB_DB = ':memory:';
process.env.WB_TZ = 'America/Chicago';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
let score: typeof import('../src/services/scorecard.ts');
let metrics: typeof import('../src/services/metrics.ts');
const now = new Date('2026-11-13T18:00:00Z');
const S = '2026-11-12T16:00:00Z';
const E = '2026-11-12T16:05:00Z';

before(async () => {
  D = await import('../src/db.ts'); tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts'); score = await import('../src/services/scorecard.ts');
  metrics = await import('../src/services/metrics.ts');
});
beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  D.db().exec('DELETE FROM tasks; DELETE FROM events; DELETE FROM reviews; DELETE FROM approvals;');
});
afterEach(() => { mock.timers.reset(); });

function task(executor = 'claude') {
  return tasks.createTask({ title: 'P', executor, category: 'dev', status: 'running' }, 'me').id;
}
function run(id: number, outcome: 'done' | 'failed' | 'limited' | 'cancelled' | 'taken_over' | 'asked', executor = 'claude', tokens = 10, model = 'm') {
  const r = runs.openRun(id, executor, 'brain');
  runs.closeRun(id, outcome as never, { tokens, harness: 'claude-code', model, backend: 'official' });
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run(S, E, r.id);
  return r.id;
}
function finish(id: number, status: 'done' | 'failed' = 'done') {
  D.db().prepare("UPDATE tasks SET status=?,started_at=?,completed_at=?,tokens_used=999 WHERE id=?")
    .run(status, '2026-11-13T17:00:00Z', '2026-11-13T17:01:00Z', id);
}
function ev(id: number, text: string) {
  D.db().prepare('INSERT INTO events(ts,actor,kind,task_id,text) VALUES(?,?,?,?,?)').run(E, 'system', 'task.status', id, text);
}
function review(id: number, round: number, verdict = 'changes') {
  D.db().prepare('INSERT INTO reviews(task_id,round,reviewer,verdict,summary,items,at) VALUES(?,?,?,?,?,?,?)')
    .run(id, round, 'codex', verdict, 'x', '[]', E);
}
function show(tag: string, id: number) {
  const f = score.factsOf([id]).get(id);
  const t = tasks.getTask(id)!;
  const card = score.scorecard({ now });
  const row = card.by_executor[0];
  const item = metrics.ledger(365).items.find((x) => x.id === id);
  console.log(`[PROBE] ${tag} -> outcome=${score.outcomeOf(t)} facts=${JSON.stringify(f)} ` +
    `card.n=${row?.n ?? 0} rework_avg=${row?.rework_avg ?? '-'} first_pass=${row?.first_pass_rate ?? '-'} ` +
    `ledger=${item?.outcome ?? 'ABSENT'} ledgerDay=${item?.day ?? '-'} ledgerTokens=${item?.tokens ?? '-'}`);
}

test('探针 A 两次失败无事件后成功', () => {
  const id = task(); run(id, 'failed'); run(id, 'failed'); run(id, 'done'); finish(id);
  show('A 两失败无事件+成功', id);
});

test('探针 B 一次失败：run 与事件同现', () => {
  const id = task(); run(id, 'failed'); run(id, 'done'); finish(id); ev(id, '运行中 → 失败');
  show('B 一失败run+一事件', id);
});

test('探针 C 一次失败 + 审查打回同一单', () => {
  const id = task(); run(id, 'failed'); run(id, 'done'); finish(id); review(id, 1);
  show('C 失败+审查打回', id);
});

test('探针 D 只有 asked 运行（first_executor 为空）', () => {
  const id = task(); run(id, 'asked'); finish(id);
  D.db().prepare('UPDATE tasks SET first_executor=NULL WHERE id=?').run(id);
  show('D 只有asked+无first_executor', id);
});

test('探针 E 只有 asked 运行（first_executor 有值）', () => {
  const id = task(); run(id, 'asked'); finish(id);
  show('E 只有asked+有first_executor', id);
});

test('探针 F 回填的失败运行（backfilled=1）无事件', () => {
  const id = task(); const r1 = run(id, 'failed'); run(id, 'done'); finish(id);
  D.db().prepare('UPDATE runs SET backfilled=1 WHERE id=?').run(r1);
  show('F 回填失败', id);
});

test('探针 G 旧任务无运行、first_executor 为空', () => {
  const id = task(); finish(id);
  D.db().prepare('UPDATE tasks SET first_executor=NULL WHERE id=?').run(id);
  show('G 老任务无first_executor', id);
});

test('探针 H 首轮 done 但 tokens=0，任务 tokens_used=999', () => {
  const id = task(); run(id, 'done', 'claude', 0); finish(id);
  show('H token=0', id);
});

test('探针 I 人工接手（run taken_over）但任务标 done', () => {
  const id = task(); run(id, 'taken_over'); finish(id);
  show('I taken_over', id);
});

test('探针 J 两次失败其中一条有事件', () => {
  const id = task(); run(id, 'failed'); run(id, 'failed'); run(id, 'done'); finish(id); ev(id, '运行中 → 失败');
  show('J 两失败+一事件', id);
});

test('探针 K 审查两轮各两条记录', () => {
  const id = task(); run(id, 'done'); finish(id); review(id, 1); review(id, 1); review(id, 2); review(id, 2);
  show('K 两轮四条审查', id);
});

test('探针 L 失败后成功但首轮在窗口外', () => {
  const id = task(); const r1 = run(id, 'failed'); run(id, 'done'); finish(id);
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run('2026-09-01T16:00:00Z', '2026-09-01T16:05:00Z', r1);
  const card = score.scorecard({ days: 30, now });
  const item = metrics.ledger(365).items.find((x) => x.id === id);
  console.log(`[PROBE] L 首轮窗口外 -> card.n=${card.by_executor.length} skipped=${card.skipped} ledger=${item?.outcome ?? 'ABSENT'} day=${item?.day ?? '-'}`);
});

test('探针 M 跨天任务：首轮在 10 天前结束、今天才完成', () => {
  const id = task();
  const r1 = run(id, 'done');
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run('2026-11-03T16:00:00Z', '2026-11-03T16:05:00Z', r1);
  D.db().prepare("UPDATE tasks SET status='done',started_at=?,completed_at=?,tokens_used=999 WHERE id=?")
    .run('2026-11-13T17:00:00Z', '2026-11-13T17:01:00Z', id);
  const week = metrics.ledger(7).items.find((x) => x.id === id);
  const month = metrics.ledger(30).items.find((x) => x.id === id);
  console.log(`[PROBE] M 跨天任务 -> week=${week ? week.day : 'ABSENT'} month=${month ? month.day : 'ABSENT'}`);
});
