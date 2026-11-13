import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasPrior, makeWorktree, materialFiles, priorBranch, reviewPatch, writeMaterials } from '../scripts/runner.mjs';

test('062 打回后重新开工必须能取得上一版文件或补丁', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-062-return-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo }); // 断言不看本机 Git 的换行设置
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'main');
  let current;
  try {
    const first = makeWorktree(repo, join(root, 'work'), 7, git);
    writeFileSync(join(first.dir, 'first-version.md'), '上一版独有的内容\n');
    git(first.dir, 'add', 'first-version.md');
    git(first.dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first version');
    git(repo, 'worktree', 'remove', first.dir);
    current = makeWorktree(repo, join(root, 'work'), 7, git);
    writeMaterials(current.dir, materialFiles({ id: 7, branch: first.branch, review_notes: '请缩短上一版', review_state: 'fixing' }, repo, git), git);
    let prior = '';
    for (const file of ['first-version.md', '.wb/changes.patch']) {
      try { prior += readFileSync(join(current.dir, file), 'utf8'); } catch {}
    }
    assert.ok(prior.includes('上一版独有的内容'), '新目录来自 main，意见存在但上一版文件和补丁均丢失');
  } finally {
    if (current?.dir) git(repo, 'worktree', 'remove', '--force', current.dir);
    rmSync(root, { recursive: true, force: true });
  }
});

test('062 打回后旧目录已清：新分支从上一版分支起，上一版文件直接在目录里', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-062-return2-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo }); // 断言不看本机 Git 的换行设置
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const id = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
  git(repo, ...id, 'commit', '--allow-empty', '-qm', 'main');
  let current;
  try {
    const first = makeWorktree(repo, join(root, 'work'), 7, git);
    writeFileSync(join(first.dir, 'first-version.md'), '上一版独有的内容\n');
    git(first.dir, 'add', 'first-version.md');
    git(first.dir, ...id, 'commit', '-qm', 'first version');
    git(repo, 'worktree', 'remove', first.dir);
    const task = { id: 7, branch: first.branch, review_notes: '请缩短', review_state: 'fixing' };
    assert.equal(priorBranch(task), 'wb/T-7');
    current = makeWorktree(repo, join(root, 'work'), 7, git, priorBranch(task));
    assert.equal(current.branch, 'wb/T-7-2');
    assert.equal(hasPrior(current.dir, 'wb/T-7', git), true);
    assert.equal(readFileSync(join(current.dir, 'first-version.md'), 'utf8'), '上一版独有的内容\n');
    // 相对 main 的改动仍然算得出来（合并审批、下一轮审查都靠它）
    assert.ok(reviewPatch(repo, current.branch, git).includes('上一版独有的内容'));
  } finally {
    if (current?.dir) git(repo, 'worktree', 'remove', '--force', current.dir);
    rmSync(root, { recursive: true, force: true });
  }
});

test('062 上一版分支不合规或已被清理：照旧从 main 起，不报错', () => {
  assert.equal(priorBranch({ branch: 'main', review_notes: 'x' }), '');
  assert.equal(priorBranch({ branch: 'wb/T-7; rm -rf', review_notes: 'x' }), '');
  assert.equal(priorBranch({ branch: 'wb/T-7', review_notes: '' }), '');
  assert.equal(priorBranch({ branch: 'wb/T-7', review_notes: 'x', review_of: 3 }), '');
  const root = mkdtempSync(join(tmpdir(), 'wb-062-return3-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo }); // 断言不看本机 Git 的换行设置
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'main');
  let wt;
  try {
    wt = makeWorktree(repo, join(root, 'work'), 9, git, 'wb/T-9-3');
    assert.equal(wt.branch, 'wb/T-9');
    assert.equal(hasPrior(wt.dir, 'wb/T-9-3', git), false, '上一版分支不在：算没恢复，要留说明');
  } finally {
    if (wt?.dir) git(repo, 'worktree', 'remove', '--force', wt.dir);
    rmSync(root, { recursive: true, force: true });
  }
});
