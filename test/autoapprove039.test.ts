// 039：只改文档的合并审批自动通过——但只能「过合并」这一道，而且拿不准就宁可不放行。
//
// 用户 2026-10-31 认可这条：任务只动 docs/ 时，合并那一下点得毫无意义；改代码的合并、
// 推送、部署仍然必须人点。这里的用例分四层：
//   1. 路径判定（纯函数，含各种想混进来的写法）；
//   2. 建审批的三种结果：自动通过 / 仍等人工 / 开关关掉后不自动；
//   3. 只有合并会走这条路（推送、部署、工具审批一律照旧）；
//   4. 走整条 finish 时，任务不会被推进 review、step 说清为什么没等人。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.WB_TOKEN = 'test-token-039-0123456789ab';
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let approvals: typeof import('../src/services/approvals.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runner: typeof import('../src/services/runner.ts');
let dispatch: typeof import('../src/services/dispatch.ts');

before(async () => {
  approvals = await import('../src/services/approvals.ts');
  tasks = await import('../src/services/tasks.ts');
  runner = await import('../src/services/runner.ts');
  dispatch = await import('../src/services/dispatch.ts');
});
after(() => { delete process.env.WB_DB; });

/** 建一条正在跑的任务，返回 id（合并审批要有任务可挂）。 */
function runningTask(title = '改一句文档'): number {
  return tasks.createTask({ title, executor: 'claude', status: 'running', project: 'ai-workbench' }, 'claude').id;
}

describe('039 路径判定：只认 docs/ 下的普通相对路径', () => {
  test('只改 docs/ 里面的文件才算', () => {
    assert.equal(approvals.docsOnly(['docs/a.md']), true);
    assert.equal(approvals.docsOnly(['docs/a.md', 'docs/reports/039.md']), true); // 064 起 docs/specs/ 不自动放行，见 crew064.test.ts
    assert.equal(approvals.docsOnly(['docs\\guide\\a.md']), true, 'Windows 反斜杠也算');
    assert.equal(approvals.docsOnly(['./docs/a.md']), true, '带 ./ 也算');
  });

  test('根目录的 README 不算——这个开关只管 docs/', () => {
    assert.equal(approvals.docsOnly(['README.md']), false);
    assert.equal(approvals.docsOnly(['docs/a.md', 'README.md']), false);
  });

  test('混一个代码文件就不算', () => {
    assert.equal(approvals.docsOnly(['docs/a.md', 'src/app.ts']), false);
    assert.equal(approvals.docsOnly(['src/app.ts']), false);
  });

  test('看着像 docs/ 其实不是的一律不算', () => {
    assert.equal(approvals.docsOnly(['docs/../src/app.ts']), false, '../ 不算');
    assert.equal(approvals.docsOnly(['/docs/a.md']), false, '绝对路径不算');
    assert.equal(approvals.docsOnly(['C:/repo/docs/a.md']), false, '带盘符不算');
    assert.equal(approvals.docsOnly(['docsx/a.md']), false, '前缀像但不是这个目录');
    assert.equal(approvals.docsOnly([]), false, '空列表不算（拿不准就当有改动）');
    assert.equal(approvals.docsOnly(undefined), false);
    assert.equal(approvals.docsOnly('docs/a.md'), false, '不是数组不算');
  });

  test('超过 500 条就不看了——长到看不清的清单不配自动放行', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `docs/f${i}.md`);
    assert.equal(approvals.docsOnly(many(500)), true, '正好 500 条还在线内');
    assert.equal(approvals.docsOnly(many(501)), false, '501 条一律当有代码改动');
  });
});

describe('039 合并审批：只改文档就自己过', () => {
  test('只改 docs/ → 已通过，理由写清「推送和部署仍要你点」', () => {
    const id = runningTask();
    const a = approvals.createApproval({
      title: '合并 wb/T-1 到 main', task_id: id, tool_name: 'git merge',
      changed_files: ['docs/a.md', 'docs/b.md'],
    });
    assert.equal(a.status, 'approved');
    assert.match(a.feedback, /只改了 docs\/ 下的 2 个文件/);
    assert.match(a.feedback, /推送和部署/);
    assert.ok(a.decided_at, '要有处理时间');
  });

  test('自动通过之后，任务不许被推进「等审批」', () => {
    const id = runningTask();
    approvals.createApproval({ title: '合并到 main', task_id: id, tool_name: 'git merge', changed_files: ['docs/a.md'] });
    assert.equal(tasks.getTask(id)!.status, 'running');
  });

  test('改了代码 → 照旧等人点，任务停在 review', () => {
    const id = runningTask();
    const a = approvals.createApproval({
      title: '合并 wb/T-2 到 main', task_id: id, tool_name: 'git merge',
      changed_files: ['docs/a.md', 'src/app.ts'],
    });
    assert.equal(a.status, 'pending');
    assert.equal(a.feedback, '');
    assert.equal(tasks.getTask(id)!.status, 'review');
  });

  test('推送审批即使只改文档也不自动过', () => {
    const id = runningTask('只改文档但要推送');
    const a = approvals.createApproval({
      title: '推送 main 到 GitHub', task_id: id, tool_name: 'git push', changed_files: ['docs/a.md'],
    });
    assert.equal(a.status, 'pending', '推上去的东西别人能看见，必须人点');
  });

  test('部署审批同样不自动过', () => {
    const id = runningTask('只改文档但要部署');
    const a = approvals.createApproval({
      title: '重建容器', task_id: id, tool_name: 'docker compose', changed_files: ['docs/a.md'],
    });
    assert.equal(a.status, 'pending');
  });

  test('501 个文档文件的合并也等人点：上限在规则入口就挡住，不靠调用方自觉', () => {
    const id = runningTask('一口气改 501 个文档');
    const a = approvals.createApproval({
      title: '合并到 main', task_id: id, tool_name: 'git merge',
      changed_files: Array.from({ length: 501 }, (_, i) => `docs/f${i}.md`),
    });
    assert.equal(a.status, 'pending');
    assert.equal(tasks.getTask(id)!.status, 'review');
  });

  test('开关关掉（auto_approve_docs=0）就全手动', () => {
    dispatch.setSetting('auto_approve_docs', '0');
    try {
      const id = runningTask();
      const a = approvals.createApproval({
        title: '合并到 main', task_id: id, tool_name: 'git merge', changed_files: ['docs/a.md'],
      });
      assert.equal(a.status, 'pending');
      assert.equal(tasks.getTask(id)!.status, 'review');
    } finally {
      dispatch.setSetting('auto_approve_docs', '1');
    }
  });
});

describe('039 执行器侧：文件清单怎么取', () => {
  test('按 merge-base 比，不看分支上有几个提交', async () => {
    const { taskFiles } = await import('../scripts/runner.mjs');
    const calls: string[][] = [];
    const run = (_cwd: string, ...args: string[]) => {
      calls.push(args);
      if (args[0] === 'merge-base') return 'abc1234';
      return 'docs/a.md\ndocs/specs/b.md\n';
    };
    assert.deepEqual(taskFiles('/tmp/wt', run), ['docs/a.md', 'docs/specs/b.md']);
    assert.deepEqual(calls[0], ['merge-base', 'main', 'HEAD']);
    assert.deepEqual(calls[1], ['diff', '--no-renames', '--name-only', 'abc1234...HEAD']);
  });

  test('git 报错就当「有改动」，返回空清单', async () => {
    const { taskFiles } = await import('../scripts/runner.mjs');
    const run = () => { throw new Error('not a git repository'); };
    assert.deepEqual(taskFiles('/tmp/nope', run), []);
  });

  test('找不到基准（空输出）也返回空清单，不去 diff', async () => {
    const { taskFiles } = await import('../scripts/runner.mjs');
    let diffed = false;
    const run = (_cwd: string, ...args: string[]) => {
      if (args[0] === 'merge-base') return '';
      diffed = true;
      return 'docs/a.md';
    };
    assert.deepEqual(taskFiles('/tmp/wt', run), []);
    assert.equal(diffed, false);
  });
});

describe('039 走完整 finish：任务不会卡在「等合并」', () => {
  test('只改文档 → 审批已通过，step 说明自动通过、推送还要人点', () => {
    const id = runningTask();
    const r = runner.finishTask(id, {
      result: 'done', summary: '改了一句文档', branch: 'wb/T-9',
      changed_files: ['docs/a.md'],
    });
    assert.ok(r.approval_id, '仍要建审批——留记录，不是静默合并');
    const a = approvals.getApproval(r.approval_id!)!;
    assert.equal(a.status, 'approved');
    const t = tasks.getTask(id)!;
    assert.equal(t.status, 'done');
    assert.match(t.step, /自动通过/);
    assert.match(t.step, /推送仍要你点/);
  });

  test('改了代码 → 照旧「等合并」', () => {
    const id = runningTask('改了代码');
    const r = runner.finishTask(id, {
      result: 'done', summary: '改了 src', branch: 'wb/T-10',
      changed_files: ['src/app.ts'],
    });
    assert.equal(approvals.getApproval(r.approval_id!)!.status, 'pending');
    assert.match(tasks.getTask(id)!.step, /等合并/);
  });

  test('没传文件清单（老执行器）→ 一律人工，不赌', () => {
    const id = runningTask('老执行器');
    const r = runner.finishTask(id, { result: 'done', summary: '改了点什么', branch: 'wb/T-11' });
    assert.equal(approvals.getApproval(r.approval_id!)!.status, 'pending');
  });

  test('文件太多（>500）→ 一律人工，不拿半份清单放行', () => {
    const id = runningTask('一次改几百个文件');
    const many = Array.from({ length: 501 }, (_, i) => `docs/x${i}.md`);
    const r = runner.finishTask(id, { result: 'done', summary: '批量改文档', branch: 'wb/T-12', changed_files: many });
    assert.equal(approvals.getApproval(r.approval_id!)!.status, 'pending');
  });
});

// ---------- 039.1 真仓库：移动文件不能把「删了代码」说成「只改文档」 ----------
//
// 审查（2026-11-01）用真仓库复现过：`git mv src/critical.ts docs/critical.ts` 在默认的重命名
// 检测下只报目标路径，taskFiles 拿到 `['docs/critical.ts']`，合并审批当场自动通过——那条合并
// 实际删掉的是 src 里的代码。所以这一组必须跑真 git，不能喂一份手写清单：喂进去的清单本来就
// 是答案，测不出取清单这一步会漏什么。

const hasGit = spawnSync('git', ['--version']).status === 0;
const noGit = hasGit ? false : '本机没有 git';

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

describe('039.1 真仓库：重命名/移动', { skip: noGit }, () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-039-'));
    sh(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'src', 'critical.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'docs', 'a.md'), '# 文档\n');
    sh(root, 'add', '-A');
    sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
    // 任务分支：和真的执行器一样，从 main 拉一条 wb/T-x 出来干活
    sh(root, 'checkout', '-q', '-b', 'wb/T-1');
  });

  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  /** 把这个真仓库当前分支的清单交给真审批逻辑，返回审批状态和清单本身。 */
  async function judge(): Promise<{ files: string[]; status: string; step: string }> {
    const { taskFiles } = await import('../scripts/runner.mjs');
    const files = taskFiles(root) as string[];
    const id = runningTask('真仓库里的移动');
    const r = runner.finishTask(id, { result: 'done', summary: '搬了个文件', branch: 'wb/T-1', changed_files: files });
    const a = approvals.getApproval(r.approval_id!)!;
    return { files, status: a.status, step: tasks.getTask(id)!.step };
  }

  test('src 里的代码移动进 docs/：清单要带上源路径，审批等人点', async () => {
    sh(root, 'mv', 'src/critical.ts', 'docs/critical.ts');
    sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', '移动');
    const { files, status, step } = await judge();
    assert.ok(files.includes('src/critical.ts'), `源路径必须在清单里，实际 ${JSON.stringify(files)}`);
    assert.ok(files.includes('docs/critical.ts'), '目标路径也要在');
    assert.equal(status, 'pending', '这条合并会删掉 src 里的代码，不能自动过');
    assert.match(step, /等合并/);
  });

  test('docs 里的文档移动进 src/：同样等人点', async () => {
    sh(root, 'mv', 'docs/a.md', 'src/a.md');
    sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', '搬进 src');
    assert.equal((await judge()).status, 'pending');
  });

  test('docs/ 内部搬家：两头都是文档，照旧自动过', async () => {
    sh(root, 'mv', 'docs/a.md', 'docs/b.md');
    sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', '文档改名');
    const { files, status } = await judge();
    assert.deepEqual(files.sort(), ['docs/a.md', 'docs/b.md']);
    assert.equal(status, 'approved');
  });

  test('普通改一句文档：还是自动过（这次修复没有把正常的路一起堵死）', async () => {
    writeFileSync(join(root, 'docs', 'a.md'), '# 文档\n改了一句\n');
    sh(root, 'add', '-A');
    sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', '改一句');
    const { files, status } = await judge();
    assert.deepEqual(files, ['docs/a.md']);
    assert.equal(status, 'approved');
  });

  test('同一份内容在 docs/ 里挪位置，又顺手改了 src：仍然等人点', async () => {
    sh(root, 'mv', 'docs/a.md', 'docs/specs.md');
    writeFileSync(join(root, 'src', 'critical.ts'), 'export const x = 2;\n');
    sh(root, 'add', '-A');
    sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', '文档搬家 + 改代码');
    assert.equal((await judge()).status, 'pending');
  });
});
