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
const firstStart = '2026-11-12T16:00:00Z';
const firstEnd = '2026-11-12T16:05:00Z';

before(async () => {
  D = await import('../src/db.ts'); tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts'); score = await import('../src/services/scorecard.ts');
  cap = await import('../src/services/capability.ts'); metrics = await import('../src/services/metrics.ts');
});
beforeEach(() => {
  mock.timers.enable({apis:['Date'],now:now.getTime()});
  D.db().exec('DELETE FROM tasks; DELETE FROM events;');
});
afterEach(() => { mock.timers.reset(); });
function task() {
  const t = tasks.createTask({title:'统计收尾测试',executor:'claude',category:'dev',status:'running'}, 'me');
  return t.id;
}
function run(id: number, outcome: 'done'|'failed'|'limited'|'cancelled'|'taken_over', executor='claude', tokens=41, model='model-a') {
  const r = runs.openRun(id, executor, 'brain');
  runs.closeRun(id,outcome,{tokens,harness:'claude-code',model,backend:'official'});
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE id=?').run(firstStart,firstEnd,r.id);
}
function done(id: number) {
  D.db().prepare("UPDATE tasks SET status='done',started_at=?,completed_at=?,tokens_used=999,backend='latest',executor='codex' WHERE id=?")
    .run('2026-11-13T17:00:00Z','2026-11-13T17:01:00Z',id);
}
function reviewed(id: number, round: number) {
  D.db().prepare('INSERT INTO reviews(task_id,round,reviewer,verdict,summary,items,at) VALUES(?,?,?,?,?,?,?)')
    .run(id,round,'codex','changes','需要修改','[]',firstEnd);
}

test('首次失败后重试成功：没有失败事件也记返工，不冒充一次过',()=>{
  const id=task(); run(id,'failed'); run(id,'done','codex',20); done(id);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'rework');
  const row=score.scorecard({now}).by_executor.find(x=>x.executor==='claude')!;
  assert.equal(row.first_pass_rate,0); assert.equal(row.rework_avg,1);
  assert.equal(row.fail_rate,0,'最终成功是返工成功，不改成最终失败');
  assert.equal(cap.samples(90,now)[0]?.pass,false);
});
test('审查打回算返工，同一轮重复记录只算一次',()=>{
  const id=task(); run(id,'done'); done(id); reviewed(id,1); reviewed(id,1); reviewed(id,2);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'rework');
  assert.equal(score.factsOf([id]).get(id)?.changes,2);
  assert.equal(cap.samples(90,now)[0]?.pass,false);
});
test('运行失败和对应失败事件不能重复算两次返工',()=>{
  const id=task(); run(id,'failed'); run(id,'done'); done(id);
  D.db().prepare('INSERT INTO events(ts,actor,kind,task_id,text) VALUES(?,?,?,?,?)')
    .run(firstEnd,'system','task.status',id,'运行中 → 失败');
  assert.equal(score.factsOf([id]).get(id)?.changes,1);
});
test('limited/cancelled跳过：战绩归给第一条有效运行的执行者',()=>{
  const id=task(); run(id,'limited'); run(id,'cancelled'); run(id,'done','codex',73,'model-b'); done(id);
  const card=score.scorecard({now});
  assert.equal(card.by_executor.find(x=>x.executor==='claude'),undefined);
  assert.equal(card.by_executor.find(x=>x.executor==='codex')?.first_pass_rate,1);
  assert.equal(cap.samples(90,now)[0]?.model,'model-b');
});
test('只有limited/cancelled不计战绩、能力或完成账目',()=>{
  const id=task(); run(id,'limited'); run(id,'cancelled'); done(id);
  assert.equal(score.scorecard({now}).by_executor.length,0);
  assert.equal(cap.samples(90,now).length,0);
  assert.equal(metrics.ledger(365).items.length,0);
});
test('耗时、token、后端取首次有效运行；账目分桶日按任务完成日',()=>{
  const id=task(); run(id,'done','claude',41); run(id,'done','codex',999); done(id);
  const card=score.scorecard({now});
  const row=card.by_executor.find(x=>x.executor==='claude')!;
  assert.equal(row.avg_tokens,41); assert.equal(row.median_ms,300000);
  assert.equal(card.by_backend[0].backend,'official');
  const entry=metrics.ledger(365).items.find(x=>x.id===id)!;
  assert.equal(entry.tokens,41);
  // 2026-11-14 返修：分桶日不再跟首轮走。首轮 11-12 结束、任务 11-13 才完成，
  // 跨周的活必须算在完成那一周，否则「这周做完几件」会整单丢掉（独立复核 B1）。
  assert.equal(entry.day,'2026-11-13');
});
test('首轮结束在窗口外，不能借最后一次重试时间重新进样本',()=>{
  const id=task(); run(id,'failed'); run(id,'done'); done(id);
  D.db().prepare('UPDATE runs SET started_at=?,ended_at=? WHERE task_id=? AND attempt=1')
    .run('2026-09-01T16:00:00Z','2026-09-01T16:05:00Z',id);
  assert.equal(score.scorecard({days:30,now}).by_executor.length,0);
  assert.equal(cap.samples(30,now).length,0);
});
test('没有运行记录的旧任务保留原有统计，不凭空补运行',()=>{
  const id=task(); done(id);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'first_pass');
  assert.equal(score.scorecard({now}).by_executor[0].n,1);
  assert.equal(runs.listRuns(id).length,0);
});
test('运行记录已明确人工接手，没有审批事件也不能算一次过',()=>{
  const id=task(); run(id,'taken_over'); done(id);
  assert.equal(score.outcomeOf(tasks.getTask(id)!), 'takeover');
});
test('首次有效运行缺模型证据，不跳去后一次模型冒充首次',()=>{
  const id=task(); run(id,'failed','claude',1,''); run(id,'done','codex',2,'model-b'); done(id);
  assert.equal(cap.samples(90,now).length,0);
});
test('记录账目兼容自己做的旧任务，仍然标为人工而不是AI一次过',()=>{
  const id=task(); done(id);
  D.db().prepare("UPDATE tasks SET executor='me',first_executor='me' WHERE id=?").run(id);
  assert.equal(metrics.ledger(365).items.find(x=>x.id===id)?.outcome,'me');
});
