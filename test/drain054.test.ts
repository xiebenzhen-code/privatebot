import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { canClaim, deployStep, drainOthers, inFlight, resetParallelState } from '../scripts/runner.mjs';

afterEach(resetParallelState);

function deploy(id: number, io: Record<string, unknown> = {}) {
  return deployStep({
    cfg: { workbench: 'http://127.0.0.1:9' }, task: { id }, project: '.', files: ['src/app.ts'],
    io: {
      api: async (_cfg: unknown, _method: string, path: string) => path === '/api/approvals'
        ? { id } : { status: 'approved' },
      sleep: async () => {}, log: () => {}, probe: async () => true,
      run: async () => ({ status: 0 }), handoff: () => ({ ok: false }), exit: () => {},
      ...io,
    },
  });
}

test('043.1 部署失败后恢复领取', async () => {
  await deploy(1, { probe: async () => false });
  assert.equal(canClaim({}), true);
});

test('043.1 容器成功但没有交接后恢复领取', async () => {
  await deploy(1);
  assert.equal(canClaim({}), true);
});

test('043.1 真交接保持停止领取', async () => {
  let exited = false;
  await deploy(1, { handoff: () => ({ ok: true }), exit: () => { exited = true; } });
  assert.equal(exited, true);
  assert.equal(canClaim({}), false);
});

test('043.1 排空只等编码，不等合并审批', async () => {
  inFlight.set(2, 'coding');
  inFlight.set(9, 'waiting');
  let waits = 0;
  await drainOthers(1, { wait: async () => {
    assert.equal(++waits, 1, '编码结束后应该直接返回');
    assert.equal(canClaim({}), false);
    inFlight.delete(2);
  } });
  assert.equal(waits, 1);
  assert.equal(inFlight.get(9), 'waiting');
});

test('043.1 两个部署串行构建，保留待审批任务的后续流程', async () => {
  inFlight.set(1, 'waiting');
  inFlight.set(2, 'waiting');
  let builds = 0;
  let handoffs = 0;
  let release!: () => void;
  let started!: () => void;
  const firstBuild = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async () => {
    if (++builds === 1) { started(); await gate; }
    return { status: 0 };
  };
  const opts = {
    run,
    drain: (id: number) => drainOthers(id, { wait: async () => assert.fail('两个部署互等') }),
    handoff: () => { handoffs++; return { ok: true }; },
  };
  const first = deploy(1, opts).finally(() => inFlight.delete(1));
  const second = deploy(2, opts).finally(() => inFlight.delete(2));
  try {
    await Promise.race([firstBuild, first, second]);
    assert.equal(builds, 1);
    assert.equal(canClaim({}), false);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
  await Promise.all([first, second]);
  assert.equal(builds, 2);
  assert.equal(handoffs, 1, '还有后续流程时不退出，最后一个部署可以交接');
});
