import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInSandbox } from '../scripts/lib/sandbox/run.mjs';

test('062 沙箱导出补丁应逐字节保留 GBK 文本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb062-gbk-export-'));
  const patch = Buffer.concat([
    Buffer.from('diff --git a/gbk.txt b/gbk.txt\nnew file mode 100644\n--- /dev/null\n+++ b/gbk.txt\n@@ -0,0 +1 @@\n+'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]),
  ]);
  try {
    const result = await runInSandbox({
      provider: {
        async create() {
          return {
            async copyIn() {},
            async exec() { return { code: 0, timedOut: false }; },
            async copyOut(_path: string, target: string) {
              mkdirSync(target, { recursive: true });
              const file = join(target, 'out.patch');
              writeFileSync(file, patch);
              return file;
            },
            async destroy() {},
          };
        },
      },
      task: { id: 7 }, project: root, branch: 'wb/T-7',
      plan: { env: {}, egress: {}, gateway: null }, prompt: '验收',
      timeoutMs: 1000, onLine() {}, tmpRoot: root,
      gitRun(_cwd: string, ...args: string[]) { writeFileSync(args[2], 'bundle'); return ''; },
    });
    assert.equal(result.problem, '');
    assert.deepEqual(Buffer.from(result.patch), patch, '沙箱出补丁时不能把 GBK 字节按 UTF-8 解码');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('062 沙箱补丁套回宿主：GBK 文本、二进制逐字节一致；被拒时存下来的也是原样字节', async () => {
  const { applySandboxPatch } = await import('../scripts/lib/sandbox/run.mjs');
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'wb062-gbk-apply-'));
  const src = join(root, 'src'); const dst = join(root, 'dst');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const id = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); const bin = Buffer.from([0, 1, 2, 255, 128, 42]);
  try {
    for (const d of [src, dst]) { mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'core.autocrlf', 'false'); git(d, ...id, 'commit', '--allow-empty', '-qm', 'base'); }
    writeFileSync(join(src, 'gbk.txt'), gbk); writeFileSync(join(src, 'binary.bin'), bin); writeFileSync(join(src, 'utf8.md'), '中文\n');
    git(src, 'add', '-A'); git(src, ...id, 'commit', '-qm', 'work');
    // 和容器里 HARVEST 同一条命令，按字节取
    const patch = execFileSync('git', ['diff', '--binary', '--full-index', 'HEAD~1..HEAD'], { cwd: src, windowsHide: true });
    git(dst, 'config', 'user.name', 'T'); git(dst, 'config', 'user.email', 't@example.com');
    const ap: any = applySandboxPatch({ dir: dst, patch, taskId: 7, gitRun: git, rejectsDir: join(root, 'rej'), tmpRoot: root });
    assert.equal(ap.ok, true, JSON.stringify(ap));
    assert.deepEqual(readFileSync(join(dst, 'gbk.txt')), gbk);
    assert.deepEqual(readFileSync(join(dst, 'binary.bin')), bin);
    assert.equal(readFileSync(join(dst, 'utf8.md'), 'utf8'), '中文\n');
    // 被检查器拒掉的补丁：存盘的是原样字节，不是解码后再写的
    const bad = Buffer.concat([Buffer.from('diff --git a/.git/hooks/x b/.git/hooks/x\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/x\n@@ -0,0 +1 @@\n+'), gbk]);
    const rej: any = applySandboxPatch({ dir: dst, patch: bad, taskId: 8, gitRun: git, rejectsDir: join(root, 'rej'), tmpRoot: root });
    assert.equal(rej.ok, false);
    assert.deepEqual(readFileSync(join(root, 'rej', readdirSync(join(root, 'rej'))[0])), bad);
    // 老调用方传字符串照旧能用
    assert.equal((applySandboxPatch({ dir: dst, patch: '', taskId: 9, gitRun: git, rejectsDir: join(root, 'rej'), tmpRoot: root }) as any).empty, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
