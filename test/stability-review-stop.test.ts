import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
process.env.WB_DB = ':memory:';
const D = await import('../src/db.ts');
const T = await import('../src/services/tasks.ts');
const R = await import('../src/services/runner.ts');
const U = await import('../src/services/runs.ts');
const V = await import('../src/services/review.ts');
const A = await import('../src/services/approvals.ts');
beforeEach(() => D.useDb(D.openDb(':memory:')));

function reviewing() {
  const parent = T.createTask({ title: '停止审查流程', executor: 'pool', project: 'demo', status: 'running' }, 'me');
  D.db().prepare("UPDATE tasks SET reviewer = 'claude' WHERE id = ?").run(parent.id);
  R.finishTask(parent.id, { result: 'done', branch: 'wb/T-' + parent.id, changed_files: ['a.txt'] });
  const child = D.db().prepare('SELECT id FROM tasks WHERE review_of = ? ORDER BY id DESC LIMIT 1').get(parent.id)!;
  return { parent, child: T.getTask(Number(child.id))! };
}

test('停止主任务也停止关联审查，迟到的要改不再重新派活', () => {
  const { parent, child } = reviewing();
  const claimed = R.claimTask(['claude'], 'review-runner')!;
  assert.equal(claimed.id, child.id);
  T.stopTask(parent.id, '用户终止了任务');
  assert.equal(T.getTask(child.id)!.status, 'failed');
  assert.equal(U.openRunOf(child.id), undefined);
  assert.notEqual(T.getTask(parent.id)!.review_state, 'reviewing');
  const reply = '```wb-review\n' + JSON.stringify({ verdict: 'changes', summary: '要修改', items: [{ file: 'a.txt', problem: '不符要求', fix: '修正' }] }) + '\n```';
  V.finishReview(T.getTask(child.id)!, reply, true, () => assert.fail('终止后不能处理审查结论'));
  assert.equal(T.getTask(parent.id)!.status, 'failed');
  assert.notEqual(T.getTask(parent.id)!.review_state, 'fixing');
});

test('停止任务后，原先未批准的合并审批不再可批准', () => {
  const { parent } = reviewing();
  assert.ok(A.listApprovals({ task_id: parent.id, status: 'pending' }).length);
  T.stopTask(parent.id, '用户终止了任务');
  assert.equal(A.listApprovals({ task_id: parent.id, status: 'pending' }).length, 0);
});
