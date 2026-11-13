// 031a：分支不能到期就删。只自动删「确定没有成果」的，其余上报等人决定。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-branch031-0123456';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = hasGit ? false : '本机没有 git';

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
const commit = (cwd: string, msg: string, file = '') => {
  if (file) writeFileSync(join(cwd, file), msg);
  sh(cwd, 'add', '-A');
  sh(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);
};

let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;
let app: Server;
let base = '';

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  const { handle } = await import('../src/app.ts');
  // 真 Git 用例在请求之间同步启动多个子进程。Windows 全量并发时可能跨过默认
  // 5 秒 keep-alive，客户端在服务端恢复处理的那一刻复用旧连接会收到 ECONNRESET。
  app = createServer({ keepAliveTimeout: 60_000 }, (req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => app.close());

beforeEach(() => {
  db = openDb(':memory:');
  useDb(db);
});

const branches = async () => import('../src/services/branches.ts');

describe('031a 判定：删什么、报什么', () => {
  test('已合并 → 删；空分支且没有 worktree → 删', async () => {
    const { planCleanup } = await branches();
    const plan = planCleanup({
      branches: [
        { branch: 'wb/T-1', tip: 'a1', ahead: 0, merged: true },
        { branch: 'wb/T-2', tip: 'b2', ahead: 0, merged: false, worktree: null },
      ],
    });
    assert.deepEqual(plan.deleteBranches.map((b: any) => b.branch), ['wb/T-1', 'wb/T-2']);
    assert.equal(plan.report.length, 0);
  });

  test('有领先提交 → 只上报，绝不删', async () => {
    const { planCleanup } = await branches();
    const plan = planCleanup({
      branches: [{ branch: 'wb/T-3', tip: 'c3', ahead: 2, merged: false, lastCommitAt: '2026-10-30T10:00:00Z' }],
    });
    assert.equal(plan.deleteBranches.length, 0);
    assert.equal(plan.report.length, 1);
    assert.equal(plan.report[0].task_id, 3);
    assert.equal(plan.report[0].ahead, 2);
  });

  test('正在跑的任务，它的分支和 worktree 都不碰、也不上报', async () => {
    const { planCleanup } = await branches();
    const plan = planCleanup({
      branches: [{ branch: 'wb/T-9', tip: 't9', ahead: 3, merged: false, worktree: { dir: '/x/T-9', dirty: true } }],
      activeTaskIds: [9],
    });
    assert.equal(plan.deleteBranches.length, 0);
    assert.equal(plan.report.length, 0);
    assert.equal(plan.deleteWorktrees.length, 0);
  });

  test('空分支但 worktree 里有没提交的改动 → 上报，不删', async () => {
    const { planCleanup } = await branches();
    const plan = planCleanup({
      branches: [{ branch: 'wb/T-4', tip: 'd4', ahead: 0, merged: false, worktree: { dir: '/x/T-4', dirty: true } }],
    });
    assert.equal(plan.deleteBranches.length, 0);
    assert.equal(plan.report[0].kind, 'worktree');
    assert.match(plan.report[0].note, /没提交的改动/);
  });

  test('干净的 worktree → 连目录一起删', async () => {
    const { planCleanup } = await branches();
    const plan = planCleanup({
      branches: [{ branch: 'wb/T-5', tip: 'e5', ahead: 0, merged: false, worktree: { dir: '/x/T-5', dirty: false } }],
    });
    assert.deepEqual(plan.deleteWorktrees, ['/x/T-5']);
    assert.equal(plan.deleteBranches.length, 1);
  });

  test('用户的删除请求：tip 一致才删，不一致就拒绝并说人话', async () => {
    const { planCleanup } = await branches();
    const ok = planCleanup({
      branches: [{ branch: 'wb/T-6', tip: 'now', ahead: 1, merged: false }],
      requests: [{ branch: 'wb/T-6', tip: 'now' }],
    });
    assert.deepEqual(ok.deleteBranches, [{ branch: 'wb/T-6', tip: 'now' }]);
    assert.equal(ok.rejected.length, 0);

    const no = planCleanup({
      branches: [{ branch: 'wb/T-7', tip: 'newer', ahead: 2, merged: false }],
      requests: [{ branch: 'wb/T-7', tip: 'older' }],
    });
    assert.equal(no.deleteBranches.length, 0);
    assert.equal(no.rejected.length, 1);
    assert.match(no.rejected[0].reason, /又有了新提交/);
  });

  test('没有对应分支、有改动的 worktree → 上报', async () => {
    const { planCleanup } = await branches();
    const plan = planCleanup({
      branches: [],
      worktrees: [{ dir: '/root/T-8', branch: '', dirty: true }],
    });
    assert.equal(plan.report.length, 1);
    assert.match(plan.report[0].note, /没有对应分支/);
  });
});

describe('031a 真仓库', { skip }, () => {
  let root = '';
  let work = '';
  let wtRoot = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-branch-'));
    work = join(root, 'work');
    wtRoot = join(root, 'wts');
    mkdirSync(wtRoot, { recursive: true });
    sh(root, 'init', '-q', '-b', 'main', work);
    writeFileSync(join(work, 'a.txt'), 'a');
    sh(work, 'add', '-A');
    sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  });

  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test('三类分支：合并的被删、空的被删、有提交的留着并上报', async () => {
    const { scanBranches, applyCleanup } = await import('../scripts/runner.mjs');
    const { planCleanup } = await branches();

    // wb/T-1：已经合并进 main
    sh(work, 'branch', 'wb/T-1', 'main');
    // wb/T-2：空分支，另起一个 worktree
    sh(work, 'worktree', 'add', '-q', '-b', 'wb/T-2', join(wtRoot, 'T-2'), 'main');
    // wb/T-3：有提交
    sh(work, 'checkout', '-q', '-b', 'wb/T-3');
    commit(work, '干了一半', 'half.txt');
    sh(work, 'checkout', '-q', 'main');

    const scan = scanBranches(work, wtRoot);
    const plan = planCleanup({ branches: scan.branches, worktrees: scan.worktrees });
    assert.deepEqual(plan.deleteBranches.map((b: any) => b.branch).sort(), ['wb/T-1', 'wb/T-2']);
    assert.deepEqual(plan.report.map((r: any) => r.branch), ['wb/T-3']);

    const done = applyCleanup(work, plan);
    assert.deepEqual(done.cleaned.sort(), ['wb/T-1', 'wb/T-2']);
    const left = sh(work, 'branch', '--format=%(refname:short)').split('\n').map((s) => s.trim());
    assert.ok(!left.includes('wb/T-1'), '已合并的该删掉');
    assert.ok(!left.includes('wb/T-2'), '空的该删掉');
    assert.ok(left.includes('wb/T-3'), '有提交的必须留着');
    assert.ok(!existsSync(join(wtRoot, 'T-2')), '空分支的 worktree 也该收掉');
  });

  test('上报后接口里出现待处理，保留 30 天就不再出现', async () => {
    const { scanBranches } = await import('../scripts/runner.mjs');
    sh(work, 'checkout', '-q', '-b', 'wb/T-4');
    commit(work, '有点成果', 'x.txt');
    sh(work, 'checkout', '-q', 'main');
    const scan = scanBranches(work, wtRoot);
    const res = await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scan }),
    });
    assert.equal(res.status, 200);
    const svc = await branches();
    const rows = svc.listStaleBranches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].branch, 'wb/T-4');
    assert.equal(rows[0].task_id, 4);
    svc.snoozeBranch(rows[0].id);
    assert.equal(svc.listStaleBranches().length, 0, '保留之后不该再出现');
  });

  test('人工在 git 里把分支删掉以后，页面上的记录要跟着消失', async () => {
    const { sweepBranches } = await import('../scripts/runner.mjs');
    const svc = await branches();
    sh(work, 'checkout', '-q', '-b', 'wb/T-6');
    commit(work, '一点成果', 'six.txt');
    sh(work, 'checkout', '-q', 'main');
    const cfg = { workbench: base, token: TOKEN, worktreeRoot: wtRoot, projects: { demo: work } };

    await sweepBranches(cfg);
    assert.equal(svc.listStaleBranches().length, 1, '有成果的分支先报上来');

    // 人自己 `git branch -D` 删的，没走页面上的「删除」按钮
    sh(work, 'branch', '-D', 'wb/T-6');
    await sweepBranches(cfg);
    assert.equal(svc.listStaleBranches().length, 0, '分支已经没了，页面上那条也得没');
  });

  test('删除请求：新提交之前点的会删掉，点完又提交的会被拒', async () => {
    const { scanBranches, applyCleanup } = await import('../scripts/runner.mjs');
    const svc = await branches();
    sh(work, 'checkout', '-q', '-b', 'wb/T-5');
    commit(work, '一', 'one.txt');
    sh(work, 'checkout', '-q', 'main');
    const scan = scanBranches(work, wtRoot);
    await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scan }),
    });
    const row = svc.listStaleBranches().find((r: any) => r.branch === 'wb/T-5')!;
    svc.requestDelete(row.id);

    // 点完之后分支上又多了一个提交
    sh(work, 'checkout', '-q', 'wb/T-5');
    commit(work, '二', 'two.txt');
    sh(work, 'checkout', '-q', 'main');

    const scan2 = scanBranches(work, wtRoot);
    const res = await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scan2 }),
    });
    const plan = await res.json();
    assert.equal(plan.deleteBranches.length, 0, '有新提交就不能删');
    assert.equal(plan.rejected.length, 1);
    applyCleanup(work, plan);
    const left = sh(work, 'branch', '--format=%(refname:short)').split('\n').map((s) => s.trim());
    assert.ok(left.includes('wb/T-5'), '被拒之后分支还在');
  });

  test('干净后再点删除，就真的删了，并写审计', async () => {
    const { scanBranches, applyCleanup } = await import('../scripts/runner.mjs');
    const svc = await branches();
    sh(work, 'checkout', '-q', '-b', 'wb/T-6');
    commit(work, '只有一', 'only.txt');
    sh(work, 'checkout', '-q', 'main');
    const scan = scanBranches(work, wtRoot);
    await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scan }),
    });
    const row = svc.listStaleBranches().find((r: any) => r.branch === 'wb/T-6')!;
    svc.requestDelete(row.id);
    const plan = await (await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scanBranches(work, wtRoot) }),
    })).json();
    const done = applyCleanup(work, plan);
    assert.deepEqual(done.cleaned, ['wb/T-6']);
    await fetch(`${base}/api/runner/branches/done`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', cleaned: done.cleaned, failed: [] }),
    });
    const notes = db.prepare("SELECT text FROM events WHERE kind = 'branch.cleaned'").all() as { text: string }[];
    assert.equal(notes.length, 1);
    assert.ok(!/[A-Z]:\\|\/home\/|\/Users\//.test(notes[0].text), `审计里不该有本机路径：${notes[0].text}`);
    assert.equal(svc.listStaleBranches().length, 0, '删掉之后列表里不该再有');
  });

  test('分支被人手动删掉后，下一次上报里就消失了', async () => {
    const { scanBranches } = await import('../scripts/runner.mjs');
    const svc = await branches();
    sh(work, 'checkout', '-q', '-b', 'wb/T-7');
    commit(work, '成果', 'y.txt');
    sh(work, 'checkout', '-q', 'main');
    await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scanBranches(work, wtRoot) }),
    });
    assert.equal(svc.listStaleBranches().length, 1);
    sh(work, 'branch', '-D', 'wb/T-7'); // 用户自己在命令行处理掉了
    await fetch(`${base}/api/runner/branches`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', ...scanBranches(work, wtRoot) }),
    });
    assert.equal(svc.listStaleBranches().length, 0);
  });

  test('有改动的孤儿 worktree 不删，干净的删', async () => {
    const { scanBranches, applyCleanup } = await import('../scripts/runner.mjs');
    const { planCleanup } = await branches();
    sh(work, 'worktree', 'add', '-q', '-b', 'wb/T-8', join(wtRoot, 'T-8'), 'main');
    writeFileSync(join(wtRoot, 'T-8', 'dirty.txt'), '没提交');
    const scan = scanBranches(work, wtRoot);
    const plan = planCleanup({ branches: scan.branches, worktrees: scan.worktrees });
    applyCleanup(work, plan);
    assert.ok(existsSync(join(wtRoot, 'T-8')), '有改动的目录不能删');
    assert.equal(plan.report.length, 1);
  });
});

describe('031a 页面与推送', () => {
  test('今天页出现待处理分支，带三个按钮', async () => {
    const svc = await branches();
    // 简洁版 + 一件任务都没有时会走「先试一件事」，那页没有面板；这里先放一个任务。
    const { createTask } = await import('../src/services/tasks.ts');
    createTask({ title: '占位', executor: 'me' }, 'me');
    svc.reportScan('demo', { branches: [{ branch: 'wb/T-11', tip: 'x', ahead: 2, merged: false, lastCommitAt: new Date().toISOString() }] });
    const { loginCookie } = await import('./helpers.ts');
    const cookie = await loginCookie(base, 'test-password-0123456789');
    // 044 v3：工作台第一层只留一行，点进去（/?g=branches）才是带按钮的那一块。
    // 061.1：旧分支不上首页（用户 11-09 定），在「高级」和原来的首页里。
    const flow = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
    assert.ok(!flow.includes('data-stale-row'), '新首页不提旧分支');
    const home = await (await fetch(`${base}/?view=classic`, { headers: { Cookie: cookie } })).text();
    assert.match(home, /data-stale-row/);
    assert.ok(!home.includes('data-stale-branches'), '第一层不摆整张表');
    const html = await (await fetch(`${base}/?g=branches`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /data-stale-branches/);
    assert.match(html, /有 1 个分支留着没收的成果/);
    assert.match(html, /\/api\/branches\/1\/snooze/);
    assert.match(html, /\/api\/branches\/1\/delete/);
    assert.match(html, /data-confirm/, '删除要二次确认');
  });

  test('没有待处理分支时今天页不多出这一块', async () => {
    const { createTask } = await import('../src/services/tasks.ts');
    createTask({ title: '占位', executor: 'me' }, 'me');
    const { loginCookie } = await import('./helpers.ts');
    const cookie = await loginCookie(base, 'test-password-0123456789');
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
    assert.ok(!html.includes('data-stale-branches'));
    assert.ok(!html.includes('data-stale-row'));
  });

  test('每个分支只推一次；没有渠道时不标已推', async () => {
    const { notifyStaleBranches } = await import('../src/services/notify.ts');
    const svc = await branches();
    svc.reportScan('demo', { branches: [{ branch: 'wb/T-12', tip: 'y', ahead: 1, merged: false }] });
    assert.equal(await notifyStaleBranches(), 0, '没有渠道就推不出去');
    assert.equal(svc.branchesToNotify().length, 1, '不能因为推不出去就标成已推');

    db.prepare("INSERT INTO notify_channels (kind, url, enabled, created_at) VALUES ('webhook', 'http://127.0.0.1:1/hook', 1, ?)")
      .run(new Date().toISOString());
    assert.equal(await notifyStaleBranches(), 0, '推失败也不算推过');
    assert.equal(svc.branchesToNotify().length, 1);
    svc.markNotified([svc.listStaleBranches()[0].id]);
    assert.equal(svc.branchesToNotify().length, 0, '推过就不再推');
  });
});

// 031a.1：审查发现的三类边界——「读不出来」被当成「没有」、跨扫描周期的保留被重写清掉、
// 被拒的删除从列表里消失。每一条都先写成会在旧代码上失败的用例。
describe('031a.1 读不出 main / ahead 时只上报不删', { skip }, () => {
  let root = '';
  let work = '';
  let wtRoot = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-branch0311-'));
    work = join(root, 'work');
    wtRoot = join(root, 'wts');
    mkdirSync(wtRoot, { recursive: true });
  });

  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test('仓库默认分支是 master：整个项目跳过，有提交的分支一条都不能删', async () => {
    const { scanBranches } = await import('../scripts/runner.mjs');
    const { planCleanup } = await branches();
    sh(root, 'init', '-q', '-b', 'master', work);
    writeFileSync(join(work, 'a.txt'), 'a');
    sh(work, 'add', '-A');
    sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    sh(work, 'checkout', '-q', '-b', 'wb/T-5');
    commit(work, '干了一半', 'half.txt');
    sh(work, 'checkout', '-q', 'master');

    const scan = scanBranches(work, wtRoot);
    assert.ok(scan.skipped, `没有 main 要整个跳过，实际 skipped=${scan.skipped}`);
    assert.match(scan.skipped, /没有 main/);
    assert.deepEqual(scan.branches, [], '跳过时一条分支都不报，避免被当成空分支删掉');

    const plan = planCleanup({ branches: scan.branches, worktrees: scan.worktrees });
    assert.deepEqual(plan.deleteBranches, []);
    const left = sh(work, 'branch', '--format=%(refname:short)').split('\n').map((s) => s.trim());
    assert.ok(left.includes('wb/T-5'), '有提交的分支必须还在');
  });

  test('rev-list 读不出来 → ahead 是 null，只上报不删', async () => {
    const { scanBranches } = await import('../scripts/runner.mjs');
    const { planCleanup } = await branches();
    sh(root, 'init', '-q', '-b', 'main', work);
    writeFileSync(join(work, 'a.txt'), 'a');
    sh(work, 'add', '-A');
    sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    sh(work, 'checkout', '-q', '-b', 'wb/T-6');
    commit(work, '一点成果', 'x.txt');
    sh(work, 'checkout', '-q', 'main');

    // 只让 rev-list 失败，别的命令照常——模拟坏 ref / 权限问题
    const run = (cwd: string, ...args: string[]) => {
      if (args[0] === 'rev-list') throw new Error('git rev-list 失败：坏 ref');
      return sh(cwd, ...args);
    };
    const scan = scanBranches(work, wtRoot, run);
    const row = scan.branches.find((b: any) => b.branch === 'wb/T-6');
    assert.ok(row, '分支还是要列出来');
    assert.equal(row.ahead, null, '读不出来就是 null，不能写 0');

    const plan = planCleanup({ branches: scan.branches, worktrees: scan.worktrees });
    assert.deepEqual(plan.deleteBranches, [], '读不出差别就绝不删');
    assert.equal(plan.report.length, 1);
    assert.match(plan.report[0].note, /读不出/);
  });

  test('正常仓库行为不变：合并的删、空的删、有提交的报', async () => {
    const { scanBranches } = await import('../scripts/runner.mjs');
    const { planCleanup } = await branches();
    sh(root, 'init', '-q', '-b', 'main', work);
    writeFileSync(join(work, 'a.txt'), 'a');
    sh(work, 'add', '-A');
    sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    sh(work, 'branch', 'wb/T-1', 'main');
    sh(work, 'branch', 'wb/T-2', 'main');
    sh(work, 'checkout', '-q', '-b', 'wb/T-3');
    commit(work, '有提交', 'c.txt');
    sh(work, 'checkout', '-q', 'main');

    const scan = scanBranches(work, wtRoot);
    assert.equal(scan.skipped, null);
    const plan = planCleanup({ branches: scan.branches, worktrees: scan.worktrees });
    assert.deepEqual(plan.deleteBranches.map((b: any) => b.branch).sort(), ['wb/T-1', 'wb/T-2']);
    assert.deepEqual(plan.report.map((r: any) => r.branch), ['wb/T-3']);
  });

  test('applyCleanup 带旧值删：扫描之后又提交，就删不动', async () => {
    const { scanBranches, applyCleanup } = await import('../scripts/runner.mjs');
    const { planCleanup } = await branches();
    sh(root, 'init', '-q', '-b', 'main', work);
    writeFileSync(join(work, 'a.txt'), 'a');
    sh(work, 'add', '-A');
    sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    sh(work, 'branch', 'wb/T-9', 'main');

    const plan = planCleanup({ branches: scanBranches(work, wtRoot).branches });
    assert.deepEqual(plan.deleteBranches.map((b: any) => b.branch), ['wb/T-9']);

    // 扫描到删除之间，别人又往这条分支上提交了一个
    sh(work, 'checkout', '-q', 'wb/T-9');
    commit(work, '扫描之后的新提交', 'late.txt');
    sh(work, 'checkout', '-q', 'main');

    const done = applyCleanup(work, plan);
    const left = sh(work, 'branch', '--format=%(refname:short)').split('\n').map((s) => s.trim());
    assert.ok(left.includes('wb/T-9'), '有新提交就不能删');
    assert.deepEqual(done.cleaned, []);
    assert.equal(done.failed.length, 1, '删不动要记一笔');
    assert.equal(done.failed[0].branch, 'wb/T-9');
  });
});

describe('031a.1 跨扫描周期：保留和拒删都留得住', () => {
  test('点了保留，下一次同样的扫描还是保留', async () => {
    const svc = await branches();
    const scan = { branches: [{ branch: 'wb/T-21', tip: 'a1', ahead: 2, merged: false, lastCommitAt: '2026-10-30T10:00:00Z' }] };
    svc.reportScan('demo', scan);
    const row = svc.listStaleBranches()[0];
    svc.snoozeBranch(row.id);
    svc.markNotified([row.id]);
    assert.equal(svc.listStaleBranches().length, 0, '保留之后立刻不出现');

    svc.reportScan('demo', scan); // 六小时后再扫一遍，结果一模一样
    assert.equal(svc.listStaleBranches().length, 0, '保留要跨过下一次扫描');
    assert.equal(svc.branchesToNotify().length, 0, '同一批不该再推一次');
  });

  test('tip 变了：保留作废、重新提醒一次', async () => {
    const svc = await branches();
    svc.reportScan('demo', { branches: [{ branch: 'wb/T-22', tip: 'old', ahead: 1, merged: false }] });
    const row = svc.listStaleBranches()[0];
    svc.snoozeBranch(row.id);
    svc.markNotified([row.id]);
    assert.equal(svc.listStaleBranches().length, 0);

    svc.reportScan('demo', { branches: [{ branch: 'wb/T-22', tip: 'new', ahead: 2, merged: false }] });
    assert.equal(svc.listStaleBranches().length, 1, '分支上又有新提交，要重新出现');
    assert.equal(svc.branchesToNotify().length, 1, '也要重新提醒');
  });

  test('删除被拒后留在列表里，写人话，并清掉删除请求', async () => {
    const svc = await branches();
    svc.reportScan('demo', { branches: [{ branch: 'wb/T-23', tip: 'tip1', ahead: 1, merged: false }] });
    const row = svc.listStaleBranches()[0];
    svc.requestDelete(row.id);
    assert.equal(svc.deleteRequests().length, 1);

    const plan = svc.reportScan('demo', {
      branches: [{ branch: 'wb/T-23', tip: 'tip2', ahead: 2, merged: false }],
      requests: svc.deleteRequests(), // 接口层会带上
    });
    assert.equal(plan.rejected.length, 1);
    const after = svc.listStaleBranches();
    assert.equal(after.length, 1, '被拒的分支不能从列表里消失');
    assert.equal(after[0].branch, 'wb/T-23');
    assert.match(after[0].note, /又有了新提交/, '拒绝的原因要写在列表里');
    assert.equal(svc.deleteRequests().length, 0, '请求已作废，不然下次 tip 对上了就会被删');

    const again = svc.reportScan('demo', { branches: [{ branch: 'wb/T-23', tip: 'tip2', ahead: 2, merged: false }] });
    assert.equal(again.deleteBranches.length, 0, '再扫一次也不能删');
  });
});
