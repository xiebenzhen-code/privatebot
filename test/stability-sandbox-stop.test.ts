// 真 runTask + HTTP 人工停止；只替换容器供应商，不需要 Docker 或实验性的模块 mock。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginCookie } from './helpers.ts';

const logRoot = mkdtempSync(join(tmpdir(), 'wb-sandbox-stop-log-'));
const previousLocal = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = logRoot;
process.env.WB_DB = ':memory:';
process.env.WB_TOKEN = 'test-token-not-real-sandbox-stop';
process.env.WB_PASSWORD = 'test-password-not-real-sandbox-stop';
const D = await import('../src/db.ts');
const T = await import('../src/services/tasks.ts');
const R = await import('../src/services/runner.ts');
const { handle } = await import('../src/app.ts');
const client = await import('../scripts/runner.mjs');
const server = createServer((q, s) => void handle(q, s));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
  const end = Date.now() + 20_000;
  while (!check() && Date.now() < end) await sleep(50);
  assert.ok(check(), '前置条件应在 20 秒内成立');
}

function fixture() {
  D.useDb(D.openDb(':memory:'));
  const root = mkdtempSync(join(tmpdir(), 'wb-sandbox-stop-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), 'sandbox stop fixture\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const task = T.createTask({ title: '沙箱停止回归', executor: 'pool', project: 'demo', status: 'queued' }, 'me');
  T.updateTask(task.id, { start_requested: 1 }, 'me');
  const claimed = R.claimTask(['pool'], 'sandbox-stop-test')!;
  assert.ok(claimed.run_id);
  const calls = { create: 0, agent: 0, destroy: 0 };
  let createGate: Promise<void> | undefined;
  const provider = {
    available: async () => ({ ok: true }),
    create: async () => {
      calls.create++;
      if (createGate) await createGate;
      return {
        copyIn: async () => {}, writeFile: async () => {}, kill: async () => {},
        copyOut: async (_p: string, out: string) => {
          const file = join(out, 'out.patch'); writeFileSync(file, ''); return file;
        },
        exec: async (argv: string[], opts: any) => {
          if (argv[0] === 'claude') {
            calls.agent++;
            opts.onLine?.(JSON.stringify({ type: 'result', result: '已完成只读检查', is_error: false }));
          }
          return { code: 0, timedOut: false };
        },
        // 故意不让 destroy 改变假容器行为；守卫必须显式阻止 agent，不能靠假物件替它拦。
        destroy: async () => { calls.destroy++; },
      };
    },
  };
  const cfg = {
    workbench: base, token: process.env.WB_TOKEN, projects: { demo: repo },
    worktreeRoot: join(root, 'wt'), claudeConfigDir: join(root, 'cfg'),
    sandbox: 'docker', maxParallel: 1, maxMinutes: 1, verify: false,
    executors: { pool: { tool: 'claude', args: [], env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'test-token-not-real-0000',
    } } },
  };
  return { root, claimed, calls, run: () => client.runTask(cfg, claimed, { sandboxProvider: () => provider }),
    holdCreation: (gate: Promise<void>) => { createGate = gate; } };
}
async function stop(id: number) {
  const cookie = await loginCookie(base, process.env.WB_PASSWORD!);
  const r = await fetch(`${base}/api/tasks/${id}/stop`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  await sleep(13_000); // 真实 10 秒轮询读到已关闭的 run；不靠直接调用内部 stop。
}
function stopped(id: number) {
  assert.equal(T.getTask(id)!.status, 'failed');
  assert.equal(D.db().prepare("SELECT count(*) n FROM approvals WHERE task_id=? AND status='pending'").get(id)!.n, 0);
  assert.equal(client.sandboxSlots.used(), 0);
  assert.equal(client.sandboxSlots.waiting(), 0);
}

test('沙箱停止：排队时停止，拿到名额后不创建容器、不跑 agent', { timeout: 90_000 }, async () => {
  const f = fixture();
  const release = await client.sandboxSlots.acquire(1);
  const job = f.run();
  try {
    await until(() => client.sandboxSlots.waiting() === 1);
    await stop(f.claimed.id);
    release(); await job;
    assert.equal(f.calls.create, 0);
    assert.equal(f.calls.agent, 0);
    stopped(f.claimed.id);
  } finally { release(); await job.catch(() => {}); rmSync(f.root, { recursive: true, force: true }); }
});

test('沙箱停止：创建期间停止，迟到的容器只销毁、不跑 agent', { timeout: 90_000 }, async () => {
  const f = fixture();
  let release!: () => void;
  f.holdCreation(new Promise<void>((r) => { release = r; }));
  const job = f.run();
  try {
    await until(() => f.calls.create === 1);
    await stop(f.claimed.id);
    release(); await job;
    assert.equal(f.calls.agent, 0);
    assert.equal(f.calls.destroy, 1);
    stopped(f.claimed.id);
  } finally { release(); await job.catch(() => {}); rmSync(f.root, { recursive: true, force: true }); }
});

test('沙箱停止：正常任务仍创建容器、运行 agent，并归还名额', { timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    await f.run();
    assert.deepEqual(f.calls, { create: 1, agent: 1, destroy: 1 });
    assert.equal(client.sandboxSlots.used(), 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocal;
  rmSync(logRoot, { recursive: true, force: true });
});
