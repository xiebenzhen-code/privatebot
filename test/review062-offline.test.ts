import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.WB_DB=':memory:';
process.env.WB_PASSWORD='test-password-062-offline';
test('062 审查执行器失联一天后应交还用户，不能一直在审',async()=>{
 const d=await import('../src/db.ts');
 const t=await import('../src/services/tasks.ts');
 const r=await import('../src/services/runner.ts');
 const s=await import('../src/services/stream.ts');
 d.useDb(d.openDb(':memory:'));
 d.db().prepare('UPDATE executor_settings SET enabled=0').run(); // 064：只留这两位——有第三位在队里时会换人接着审，不是这条要测的
 for(const e of ['codex','claude'])d.db().prepare('UPDATE executor_settings SET enabled=1, claimable=1 WHERE executor=?').run(e);
 const p=t.createTask({title:'离线验收',executor:'codex',project:'demo'},'me');
 d.db().prepare("UPDATE tasks SET status='running',reviewer='claude' WHERE id=?").run(p.id);
 r.finishTask(p.id,{result:'done',branch:'wb/T-'+p.id,changed_files:['a.md']});
 const c=d.db().prepare('SELECT id FROM tasks WHERE review_of=?').get(p.id);
 r.heartbeat('reviewer-offline',{executors:['claude']});
 d.db().prepare("UPDATE tasks SET status='running', runner_id='reviewer-offline' WHERE id=?").run(c.id);
 const old=new Date(Date.now()-86400000).toISOString();
 d.db().prepare('UPDATE runners SET last_seen=? WHERE id=?').run(old,'reviewer-offline');
 d.db().prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(old,c.id);
 s.stream();
 assert.equal(t.getTask(p.id).review_state,'failed','审查者失联，无 finish 回报时父任务仍卡在 reviewing');
});

test('062 失联收尾：只收一次；迟到的 finish 不改结论；在线的、刚排上的不动',async()=>{
 const d=await import('../src/db.ts');
 const t=await import('../src/services/tasks.ts');
 const r=await import('../src/services/runner.ts');
 const rv=await import('../src/services/review.ts');
 const a=await import('../src/services/approvals.ts');
 d.useDb(d.openDb(':memory:'));
 d.db().prepare('UPDATE executor_settings SET enabled=0').run(); // 064：只留这两位——有第三位在队里时会换人接着审，不是这条要测的
 for(const e of ['codex','claude'])d.db().prepare('UPDATE executor_settings SET enabled=1, claimable=1 WHERE executor=?').run(e);
 const mk=(title)=>{const p=t.createTask({title,executor:'codex',project:'demo'},'me');
  d.db().prepare("UPDATE tasks SET status='running',reviewer='claude' WHERE id=?").run(p.id);
  r.finishTask(p.id,{result:'done',branch:'wb/T-'+p.id,changed_files:['a.md']});
  return {p,c:d.db().prepare('SELECT id FROM tasks WHERE review_of=?').get(p.id)};};
 const ago=(ms)=>new Date(Date.now()-ms).toISOString();

 // 在线执行器正在审：不动
 const live=mk('在线');
 r.heartbeat('rv-live',{executors:['claude']});
 d.db().prepare("UPDATE tasks SET status='running', runner_id='rv-live', updated_at=? WHERE id=?").run(ago(3600_000),live.c.id);
 // 刚排上：不动；排了两小时：收
 const fresh=mk('刚排上');
 const waited=mk('排太久'); d.db().prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(ago(2*3600_000),waited.c.id);
 // 失联
 const lost=mk('失联');
 r.heartbeat('rv-lost',{executors:['claude']});
 d.db().prepare("UPDATE tasks SET status='running', runner_id='rv-lost', updated_at=? WHERE id=?").run(ago(3600_000),lost.c.id);
 d.db().prepare('UPDATE runners SET last_seen=? WHERE id=?').run(ago(3600_000),'rv-lost');

 // 「排太久」那件在上面的心跳里已经被顺手收掉了（心跳也会扫）；这里收的是失联那件
 assert.equal(t.getTask(waited.p.id).review_state,'failed');
 assert.deepEqual(rv.sweepReviews(),[lost.p.id]);
 assert.equal(t.getTask(live.p.id).review_state,'reviewing');
 assert.equal(t.getTask(fresh.p.id).review_state,'reviewing');
 assert.equal(t.getTask(lost.p.id).review_state,'failed');
 assert.equal(t.getTask(lost.c.id).status,'failed');
 assert.match(t.getTask(lost.c.id).fail_reason,/失联/);
 assert.equal(rv.reviewsOf(lost.p.id).length,1);
 // 合并审批还在等你，没被替你点头，也没作废
 assert.equal(a.listApprovals({task_id:lost.p.id}).find(x=>x.tool_name==='git merge').status,'pending');
 // 再扫一次：什么都不做
 assert.deepEqual(rv.sweepReviews(),[]);
 assert.equal(rv.reviewsOf(lost.p.id).length,1);
 // 执行器后来又活了，迟到的结论（哪怕是「要改」）不再改写、不打回
 rv.finishReview(t.getTask(lost.c.id),'```wb-review\n{"verdict":"要改","summary":"迟到","items":[{"problem":"x"}]}\n```',true,()=>{throw new Error('不该作废审批');});
 assert.equal(t.getTask(lost.p.id).review_state,'failed');
 assert.equal(rv.reviewsOf(lost.p.id).length,1);
 assert.notEqual(t.getTask(lost.p.id).status,'queued');
});
