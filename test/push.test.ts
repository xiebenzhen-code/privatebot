// 013.6: don't merge into a repo that is not ready, and make the push its own approval.
// Everything here runs against a real bare repo on disk — no network, no fakes for git.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = hasGit ? false : '本机没有 git';

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

const commit = (cwd: string, msg: string) =>
  sh(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);

/** A working repo with `origin` pointing at a bare repo next to it, both on main. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'wb-push-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  sh(root, 'init', '--bare', '-q', origin);
  // A bare repo defaults to master, so a later clone would land on an unborn branch.
  sh(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  sh(root, 'init', '-q', '-b', 'main', work);
  sh(work, 'remote', 'add', 'origin', origin);
  commit(work, 'init');
  sh(work, 'push', '-q', '-u', 'origin', 'main');
  return { root, origin, work, clean: () => rmSync(root, { recursive: true, force: true }) };
}

/** A second clone, used to move the bare repo without touching `work`. */
function pusher(root: string, origin: string) {
  const dir = join(root, `pusher-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  sh(root, 'clone', '-q', origin, dir);
  return dir;
}

/** Fake workbench: records what the runner would have done, answers the approval the way we want. */
function fakeApi(status: 'approved' | 'rejected' | 'pending') {
  const calls: { method: string; path: string; body: any }[] = [];
  const api = async (_cfg: any, method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/api/approvals') return { id: 5 };
    if (method === 'GET' && path === '/api/approvals/5') return { id: 5, status };
    return { ok: true };
  };
  return { api, calls };
}

const quiet = () => {};

describe('043.2 推送审批绑定提交集合', { skip }, () => {
  for (const approveB of [false, true]) {
    test(approveB ? '两单各自获批，按各自快照推送' : '先驳回 B 再批准 A，B 不能随旧审批推出', async () => {
      const { pushStep } = await import('../scripts/runner.mjs');
      const box = sandbox();
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
      try {
        const a = fakeApi('approved');
        commit(box.work, '提交 A');
        const shaA = sh(box.work, 'rev-parse', 'main');
        const first = pushStep({ cfg: {}, task: { id: 1 }, project: box.work, io: { ...a, sleep: () => gate, log: quiet } });
        let second: Promise<unknown> | undefined;
        try {
          assert.doesNotMatch(a.calls[0].body.summary, /提交 B/);
          commit(box.work, '提交 B');
          const b = fakeApi(approveB ? 'approved' : 'rejected');
          second = pushStep({ cfg: {}, task: { id: 2 }, project: box.work,
            io: { ...b, sleep: approveB ? () => gateB : quiet, log: quiet } });
          assert.match(b.calls[0].body.summary, /提交 B/);
          if (!approveB) await second;
          releaseA();
          try {
            await first;
            assert.equal(sh(box.origin, 'rev-parse', 'main'), shaA);
            assert.equal(a.calls.find((c) => c.path.endsWith('/pushed'))?.body.commit, shaA);
          } finally { releaseB(); }
          await second;
          assert.equal(sh(box.origin, 'rev-parse', 'main'), approveB ? sh(box.work, 'rev-parse', 'main') : shaA);
        } finally { releaseA(); releaseB(); await Promise.allSettled([first, second]); }
      } finally { box.clean(); }
    });
  }

  test('审批后远端分叉则不强推，重试重新展示全部待推提交', async () => {
    const { pushStep } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      commit(box.work, '我的改动');
      const local = sh(box.work, 'rev-parse', 'main');
      const other = pusher(box.root, box.origin);
      const a = fakeApi('approved');
      let moved = false;
      await pushStep({ cfg: {}, task: { id: 1 }, project: box.work, io: { ...a, log: quiet, sleep: () => {
        if (moved) return;
        moved = true;
        commit(other, '别人的改动');
        sh(other, 'push', 'origin', 'main');
      } } });
      assert.equal(sh(box.origin, 'rev-parse', 'main'), sh(other, 'rev-parse', 'main'));
      assert.equal(a.calls.find((c) => c.method === 'PATCH')?.body.retry, 'push');
      sh(box.work, 'fetch', 'origin');
      sh(box.work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', 'origin/main');
      commit(box.work, '重试前多出的改动');
      const tip = sh(box.work, 'rev-parse', 'main');
      const retry = fakeApi('approved');
      await pushStep({ cfg: {}, task: { id: 1 }, project: box.work, commit: local,
        io: { ...retry, sleep: quiet, log: quiet } });
      assert.match(retry.calls[0].body.summary, /重试前多出的改动/);
      assert.equal(retry.calls[0].body.tool_input.commit, tip);
      assert.equal(sh(box.origin, 'rev-parse', 'main'), tip);
    } finally { box.clean(); }
  });

  test('远端回退后不能借旧审批重新发布未列出的提交', async () => {
    const { pushStep } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      const initial = sh(box.origin, 'rev-parse', 'main');
      commit(box.work, '审批前已经在远端的提交');
      sh(box.work, 'push', 'origin', 'main');
      commit(box.work, '待审批的新提交');
      const reply = fakeApi('approved');
      await pushStep({ cfg: {}, task: { id: 1 }, project: box.work, io: { ...reply, log: quiet, sleep: () => {
        sh(box.origin, 'update-ref', 'refs/heads/main', initial);
      } } });
      assert.doesNotMatch(reply.calls[0].body.summary, /审批前已经在远端的提交/);
      assert.equal(sh(box.origin, 'rev-parse', 'main'), initial);
      assert.equal(reply.calls.find((c) => c.method === 'PATCH')?.body.retry, 'push');
    } finally { box.clean(); }
  });
});

describe('013.6 合并前先看本地仓库', { skip }, () => {
  test('干净、在 main、不落后 → 可以合并', async () => {
    const { preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      const pre = preMergeProblem(box.work);
      assert.equal(pre.block, '');
      assert.equal(pre.warn, '');
    } finally { box.clean(); }
  });

  test('有没提交的改动 → 不合并', async () => {
    const { preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      writeFileSync(join(box.work, 'half-done.txt'), '改了一半');
      assert.match(preMergeProblem(box.work).block, /本地仓库有 1 个文件没提交/);
    } finally { box.clean(); }
  });

  test('不在 main 上 → 不合并', async () => {
    const { preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      sh(box.work, 'checkout', '-q', '-b', 'feature');
      assert.match(preMergeProblem(box.work).block, /在 feature 分支上/);
    } finally { box.clean(); }
  });

  test('本地 main 落后远端 1 个提交 → 自动快进，不再拦人', async () => {
    const { preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      const other = pusher(box.root, box.origin);
      commit(other, '别人推的');
      sh(other, 'push', '-q', 'origin', 'main');
      const pre = preMergeProblem(box.work);
      assert.equal(pre.block, '', '能快进就别拦人');
      assert.equal(sh(box.work, 'rev-parse', 'HEAD'), sh(box.origin, 'rev-parse', 'main'), '本地 main 应该已经跟上远端');
    } finally { box.clean(); }
  });

  test('028.1 拉不到远端也照常合并，只记一句', async () => {
    const { preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      sh(box.work, 'remote', 'set-url', 'origin', join(box.root, 'nope.git'));
      const pre = preMergeProblem(box.work);
      assert.equal(pre.block, '', '网络不通不该拦住纯本地的合并');
      assert.match(pre.warn, /没能连上远端/);
    } finally { box.clean(); }
  });

  test('028.1 没有 origin 的仓库（030 新建的本地项目）→ 直接可以合并', async () => {
    const { preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      sh(box.work, 'remote', 'remove', 'origin');
      const pre = preMergeProblem(box.work);
      assert.equal(pre.block, '');
      assert.equal(pre.warn, '', '没有远端不是问题，不该提示');
    } finally { box.clean(); }
  });
});

// 043 B：决策端频繁往 GitHub 推代码。以前本地 main 落后就整个拦住，只能人去 pull；
// 现在开工前、合并前各对齐一次，只走快进。
describe('043 B 开工前先和 origin 对齐 main', { skip }, () => {
  /** 往远端推 N 个提交（改真文件，好让 worktree 里能验证拿到的是不是新的）。 */
  function pushFrom(root: string, origin: string, files: string[]) {
    const other = pusher(root, origin);
    for (const f of files) {
      writeFileSync(join(other, f), f);
      sh(other, 'add', '-A');
      sh(other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `远端加 ${f}`);
    }
    sh(other, 'push', '-q', 'origin', 'main');
  }

  test('本地落后 2 个提交：开工前快进，之后合并成功', async () => {
    const { makeWorktree, preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      pushFrom(box.root, box.origin, ['a.txt', 'b.txt']);
      const wt = makeWorktree(box.work, join(box.root, 'wt'), 61);
      assert.equal(wt.block, '', wt.block);
      assert.equal(readFileSync(join(wt.dir, 'b.txt'), 'utf8'), 'b.txt', 'worktree 应该开在对齐后的 main 上');

      // 分支上做一处改动、提交，再走合并前的检查：已经对齐过，不该再拦。
      writeFileSync(join(wt.dir, 'c.txt'), 'c');
      sh(wt.dir, 'add', '-A');
      sh(wt.dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'T-61 的改动');
      const pre = preMergeProblem(box.work);
      assert.equal(pre.block, '', '刚刚快进过，合并前不该再拦');
      sh(box.work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-ff', wt.branch, '-m', '合并 wb/T-61');
      assert.equal(readFileSync(join(box.work, 'c.txt'), 'utf8'), 'c', '合并应该成功');
      assert.equal(readFileSync(join(box.work, 'a.txt'), 'utf8'), 'a.txt', '远端那 2 个提交也在');
    } finally { box.clean(); }
  });

  test('本地多出提交、远端也有新的 → 快进不了，拦住并写清原因', async () => {
    const { makeWorktree, preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      pushFrom(box.root, box.origin, ['remote.txt']);
      commit(box.work, '本地自己的提交');
      const head = sh(box.work, 'rev-parse', 'HEAD');

      const pre = preMergeProblem(box.work);
      assert.match(pre.block, /快进不了/);
      assert.match(pre.block, /落后远端 1 个提交/);
      assert.match(pre.block, /1 个远端没有的提交/);

      const wt = makeWorktree(box.work, join(box.root, 'wt2'), 62);
      assert.match(wt.block, /快进不了/, '开工前就该拦住，别改完再卡合并');
      assert.equal(sh(box.work, 'rev-parse', 'HEAD'), head, '不许硬合');
    } finally { box.clean(); }
  });

  test('有未提交改动 → 不碰本地，也不快进，合并照旧拦住', async () => {
    const { makeWorktree, preMergeProblem } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      pushFrom(box.root, box.origin, ['remote.txt']);
      writeFileSync(join(box.work, 'half-done.txt'), '改了一半');
      const head = sh(box.work, 'rev-parse', 'HEAD');

      assert.match(preMergeProblem(box.work).block, /1 个文件没提交/);
      assert.equal(sh(box.work, 'rev-parse', 'HEAD'), head, '有未提交改动时不该去动 main');

      const wt = makeWorktree(box.work, join(box.root, 'wt3'), 63);
      assert.equal(wt.block, '', '未提交改动是合并那步的事，不该拦住开工');
      assert.equal(sh(box.work, 'rev-parse', 'HEAD'), head, '开工时也没动 main');
    } finally { box.clean(); }
  });
});

describe('013.6 推送是单独一道审批', { skip }, () => {
  const task = { id: 77, title: '加一行链接', branch: 'wb/T-77' };

  test('批准 → 真的推上去了，才记完成并回报提交号', async () => {
    const { pushStep } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      const { api, calls } = fakeApi('approved');
      commit(box.work, '任务改动');
      await pushStep({ cfg: {}, task, project: box.work, branch: 'wb/T-77', io: { api, sleep: quiet, log: quiet } });

      const head = sh(box.work, 'rev-parse', 'HEAD');
      assert.equal(sh(box.origin, 'rev-parse', 'main'), head, '裸仓库拿到了这次提交');

      const approval = calls.find((c) => c.method === 'POST' && c.path === '/api/approvals');
      assert.ok(approval, '建了一条推送审批');
      assert.match(approval!.body.title, /推送 main 到 GitHub/);
      assert.match(approval!.body.summary, /要推上去的提交/);
      assert.match(approval!.body.summary, /任务改动/, '摘要里能看见要推什么');

      const patch = calls.find((c) => c.method === 'PATCH');
      assert.equal(patch!.body.status, 'done');
      assert.equal(patch!.body.step, '已推送到 origin/main');
      assert.equal(patch!.body.retry, '');

      const pushed = calls.find((c) => c.path === '/api/runner/tasks/77/pushed');
      assert.ok(pushed, '推成功后回报工作台');
      assert.match(pushed!.body.commit, /^[0-9a-f]{7,40}$/);
    } finally { box.clean(); }
  });

  test('驳回 → 不推，任务仍是完成，step 写明没推', async () => {
    const { pushStep } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      const before = sh(box.origin, 'rev-parse', 'main');
      commit(box.work, '不该上去的改动');
      const { api, calls } = fakeApi('rejected');
      await pushStep({ cfg: {}, task, project: box.work, branch: 'wb/T-77', io: { api, sleep: quiet, log: quiet } });

      assert.equal(sh(box.origin, 'rev-parse', 'main'), before, '远端的 main 一动没动');
      const patch = calls.find((c) => c.method === 'PATCH');
      assert.equal(patch!.body.status, 'done');
      assert.equal(patch!.body.step, '已合并到本地，没有推送');
      assert.ok(!calls.some((c) => c.path.endsWith('/pushed')), '没推就不该回报提交号');
    } finally { box.clean(); }
  });

  test('推送失败（远端有新提交）→ 任务记失败，可以重试推送', async () => {
    const { pushStep } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      const other = pusher(box.root, box.origin);
      commit(other, '别人先推了');
      sh(other, 'push', '-q', 'origin', 'main');
      commit(box.work, '我的改动');

      const { api, calls } = fakeApi('approved');
      await pushStep({ cfg: {}, task, project: box.work, branch: 'wb/T-77', io: { api, sleep: quiet, log: quiet } });

      const patch = calls.find((c) => c.method === 'PATCH');
      assert.equal(patch!.body.status, 'failed', '推不上去就不是已完成');
      assert.equal(patch!.body.retry, 'push', '任务页上会多一个「重试推送」');
      assert.match(patch!.body.merged_commit, /^[0-9a-f]{7,40}$/, '重试推送要知道合的是哪个提交');
      assert.match(patch!.body.step, /^推送失败：/);
      assert.match(patch!.body.step, /重试推送/);
      // 028：红框里要有人话，而不是「没有记录原因」。
      assert.match(patch!.body.fail_reason, /没有推送：/, '失败原因也要写，红框才有话说');
      assert.match(patch!.body.fail_reason, /重试推送/, '原因里要说下一步怎么办');
      assert.ok(!calls.some((c) => c.path.endsWith('/pushed')), '没推成功就不能报提交号');
    } finally { box.clean(); }
  });

  test('没有 origin 的项目直接跳过，不弹审批', async () => {
    const { pushStep } = await import('../scripts/runner.mjs');
    const box = sandbox();
    try {
      sh(box.work, 'remote', 'remove', 'origin');
      const { api, calls } = fakeApi('approved');
      await pushStep({ cfg: {}, task, project: box.work, branch: 'wb/T-77', io: { api, sleep: quiet, log: quiet } });
      assert.ok(!calls.some((c) => c.path.includes('/approvals')), '没有远端不该弹推送审批');
      // 030 D.1：跳过也要在任务页说一句，不能让人以为推送失败了。
      const note = calls.find((c) => c.path.endsWith('/progress'));
      assert.match(String(note?.body?.step ?? ''), /只在本机|没有远端/, '要写一句「只在本机，推送已跳过」');
    } finally { box.clean(); }
  });
});
