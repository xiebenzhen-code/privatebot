// 045 执行器侧：用槽、认上限。
//   - 认限额文案：两种已见的写法、时区、跨天；认出「到上限」但时间读不懂 → resetAt 为空，不猜。
//   - 槽只给走登录的后端：带 API key 的后端换目录不换账号，还会丢钩子。
//   - 槽目录名再校验一遍，拼出来的路径越不出 slotsRoot。
//   - 真跑一遍：假的编码工具报「到上限」→ 工作台记槽、任务回排队；没登录的槽不开跑；钩子写进槽目录。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-r045-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-r045-0123456789';
process.env.WB_TZ = 'Asia/Shanghai';

let R: any;
let app: Server;
let base = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

before(async () => {
  R = await import('../scripts/runner.mjs');
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => {
  app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => { D.useDb(D.openDb(':memory:')); });

describe('045 · 认限额文案', () => {
  // 2026-11-03 10:00 香港 = 02:00 UTC
  const now = Date.parse('2026-11-03T02:00:00Z');

  test('五小时窗口：只有钟点，按那个时区的今天算', () => {
    const r = R.parseLimit("You've hit your session limit · resets 3pm (Asia/Hong_Kong)", now);
    assert.equal(r.kind, 'session');
    assert.equal(r.resetAt, '2026-11-03T07:00:00.000Z');
  });

  test('钟点已经过了 → 明天', () => {
    const r = R.parseLimit('You’ve hit your session limit · resets 9am (Asia/Hong_Kong)', now);
    assert.equal(r.resetAt, '2026-11-04T01:00:00.000Z');
  });

  test('每周：带月和日、带分钟', () => {
    const r = R.parseLimit("You've hit your weekly limit · resets Nov 7, 3:30pm (Asia/Hong_Kong)", now);
    assert.equal(r.kind, 'weekly');
    assert.equal(r.resetAt, '2026-11-07T07:30:00.000Z');
  });

  test('认出到上限、时间读不懂 → resetAt 为空（不猜）', () => {
    for (const s of ["You've hit your session limit · resets soon", "You've hit your weekly limit · resets 3 (Mars/Base)", "You've hit your limit"]) {
      const r = R.parseLimit(s, now);
      assert.ok(r, s);
      assert.equal(r.resetAt, null, s);
    }
  });

  test('不是到上限的话：返回 null，按普通失败走', () => {
    for (const s of ['429 Too Many Requests', 'rate limit exceeded on api', '测试没过', '']) assert.equal(R.parseLimit(s, now), null, s);
  });
});

describe('045 · 选槽与后端', () => {
  test('带 API key / 网关的后端不用槽；codebuddy 用；dsh 永远不用', () => {
    assert.equal(R.usesLogin({ tool: 'claude', env: {} }), true);
    assert.equal(R.usesLogin({ tool: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }), false);
    assert.equal(R.usesLogin({ tool: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'x' } }), false);
    assert.equal(R.usesLogin({ tool: 'codebuddy', env: {} }), true);
    assert.equal(R.usesLogin({ tool: 'dsh', env: {} }), false);
  });

  test('槽目录名再校验：带路径的、越界的跳过，取第一个合法的', () => {
    const cfg = { slotsRoot: tmp('wb-slots-') };
    const s = R.chooseSlot({ slots: [{ name: 'bad', slot_dir: '../x' }, { name: 'bad2', slot_dir: 'A/B' }, { name: 'ok', slot_dir: 'claude-b' }] }, cfg);
    assert.equal(s.name, 'ok');
    assert.equal(s.dir, join(cfg.slotsRoot, 'claude-b'));
    assert.equal(R.chooseSlot({ slots: [] }, cfg), null);
    assert.equal(R.chooseSlot({}, cfg), null);
  });

  test('钩子能写进指定目录（槽目录）', () => {
    const d = tmp('wb-slotdir-');
    const { file } = R.ensureHookConfig({}, d);
    assert.equal(file, join(d, 'settings.json'));
    assert.match(readFileSync(file, 'utf8'), /claude-hook\.mjs/);
  });
});

describe('045 · 真跑一遍（假编码工具）', { skip: process.platform === 'win32' ? '假工具用 shebang 脚本，Windows 上由真机验收覆盖' : false }, () => {
  function setup(toolBody: string) {
    const root = tmp('wb-r045-');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    g('add', '.'); g('commit', '-qm', 'init');
    const tool = join(root, 'fake-claude');
    writeFileSync(tool, `#!/usr/bin/env node\n${toolBody}\n`);
    chmodSync(tool, 0o755);
    const slotsRoot = join(root, 'slots');
    const cfg = {
      workbench: base, token: TOKEN,
      projects: { demo: repo },
      worktreeRoot: join(root, 'wt'),
      slotsRoot,
      claudeConfigDir: join(root, 'runner-cfg'),
      executors: { claude: { tool, args: [], backends: [{ name: 'sub', env: {} }] } },
      maxMinutes: 1,
    };
    return { root, cfg, slotsRoot };
  }

  async function claimed() {
    const t = tasks.createTask({ title: '045 真跑', project: 'demo', category: 'dev', executor: 'claude', status: 'queued' }, 'me');
    tasks.updateTask(t.id, { start_requested: 1 }, 'me');
    const res = await fetch(`${base}/api/runner/next?executors=claude&runner=r`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return await res.json();
  }

  test('到上限：报 limited，工作台把槽记到重置时间，任务回排队；环境里的 CLAUDE_CONFIG_DIR 是槽目录', async () => {
    const { root, cfg, slotsRoot } = setup('');
    const envFile = join(root, 'env.txt');
    writeFileSync(cfg.executors.claude.tool, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(envFile)}, process.env.CLAUDE_CONFIG_DIR || '');
console.log(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 3pm (Asia/Hong_Kong)" }));
process.exit(1);
`);
    mkdirSync(join(slotsRoot, 'claude-a'), { recursive: true });
    runs.createSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    runs.createSlot({ name: 'claude-b', executor: 'claude', slot_dir: 'claude-b', slot_priority: 99 });

    const task = await claimed();
    assert.equal(task.slots[0].name, 'claude-a');
    await R.runTask(cfg, task);

    assert.equal(readFileSync(envFile, 'utf8'), join(slotsRoot, 'claude-a'));
    assert.ok(existsSync(join(slotsRoot, 'claude-a', 'settings.json')), '钩子写进了槽目录');
    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'queued');
    const r = runs.listRuns(task.id)[0];
    assert.equal(r.outcome, 'limited');
    assert.equal(r.slot, 'claude-a');
    assert.equal(r.harness, 'claude-code');
    const a = runs.listSlots().find((s) => s.name === 'claude-a')!;
    assert.equal(a.state, 'limited');
    assert.ok(a.limited_until && Date.parse(a.limited_until) > Date.now());
  });

  test('槽目录还没建（没登录过）：不开跑，失败原因说清去哪登录', async () => {
    const { cfg } = setup(`console.log(JSON.stringify({ type: 'result', result: 'ran' }));`);
    runs.createSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const task = await claimed();
    await R.runTask(cfg, task);
    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'failed');
    assert.match(t.fail_reason ?? '', /账号槽 claude-a 的目录还没建/);
  });

  test('后端带 API key：有槽也不用，CLAUDE_CONFIG_DIR 还是执行器自己的', async () => {
    const { root, cfg, slotsRoot } = setup('');
    const envFile = join(root, 'env.txt');
    writeFileSync(cfg.executors.claude.tool, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(envFile)}, process.env.CLAUDE_CONFIG_DIR || '');
console.log(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }));
process.exit(1);
`);
    (cfg.executors.claude.backends[0] as any).env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
    mkdirSync(join(slotsRoot, 'claude-a'), { recursive: true });
    runs.createSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const task = await claimed();
    await R.runTask(cfg, task);
    assert.equal(readFileSync(envFile, 'utf8'), cfg.claudeConfigDir);
    assert.equal(runs.listRuns(task.id)[0].slot, '');
  });
});
