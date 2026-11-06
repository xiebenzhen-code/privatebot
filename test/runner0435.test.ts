// 043.5：结果事件里的失败信号不能再被「退出码 0」盖掉。
//   - 判定口只有一个：工具报错、没有合法最终结果、退出码、超时、登录、限额一起看。
//   - 勾了「只要一个回答」也一样：错误文本只留作记录，不能被当成成果。
//   - 已经认出的「到额度上限」仍然走 limited，不退回普通失败。
// 真跑一组：真 HTTP、真 Git、假 CLI（用 node 跑脚本，Windows/Linux 都能跑）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-r0435-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-r0435-0123456789';
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

describe('043.5 · 统一判定', () => {
  const judge = (over: Record<string, unknown> = {}) => R.judgeRun({ resultSeen: true, resultText: '好的', ...over });

  test('正常回答 → 完成', () => {
    assert.deepEqual(judge(), { failed: false, limited: false, reason: '' });
  });

  test('退出码 0 + is_error=true → 失败，原因带工具原话', () => {
    const v = judge({ resultFailed: true, resultText: 'provider request failed' });
    assert.equal(v.failed, true);
    assert.match(v.reason, /编码工具报告失败/);
    assert.match(v.reason, /provider request failed/);
  });

  test('退出码 0 但没有最终结果 → 失败', () => {
    const v = judge({ resultSeen: false, resultText: '' });
    assert.equal(v.failed, true);
    assert.match(v.reason, /没有给出最终结果/);
  });

  test('退出码 0、最终结果为空白 → 失败', () => {
    const v = judge({ resultText: '   \n' });
    assert.equal(v.failed, true);
    assert.match(v.reason, /最终结果为空/);
  });

  test('退出码非 0 / 超时 / 被暂停 / 没登录 → 各有各的原因', () => {
    assert.match(judge({ code: 2 }).reason, /退出码 2/);
    assert.match(judge({ code: null, killed: true }).reason, /时间上限/);
    assert.equal(judge({ stopped: '被总开关暂停' }).reason, '被总开关暂停');
    assert.equal(judge({ authProblem: '没登录' }).reason, '没登录');
  });

  test('认出到限额 → limited，即使同时有 is_error 和非 0 退出码', () => {
    const v = judge({ code: 1, resultFailed: true, resultText: "You've hit your session limit", limit: { kind: 'session', resetAt: null, raw: 'x' } });
    assert.deepEqual(v, { failed: false, limited: true, reason: '' });
  });

  test('人按下的暂停优先于限额，不会被改写成 limited', () => {
    const v = judge({ stopped: '触发预算闸', limit: { kind: 'session' } });
    assert.equal(v.failed, true);
    assert.equal(v.limited, false);
    assert.equal(v.reason, '触发预算闸');
  });
});

describe('043.5 · 真跑一遍（假 CLI 退出码 0）', () => {
  function setup(toolBody: string) {
    const root = tmp('wb-r0435-');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    g('add', '.'); g('commit', '-qm', 'init');
    const tool = join(root, 'fake-claude.mjs');
    writeFileSync(tool, `${toolBody}\n`);
    chmodSync(tool, 0o755);
    const slotsRoot = join(root, 'slots');
    const cfg = {
      workbench: base, token: TOKEN,
      projects: { demo: repo },
      worktreeRoot: join(root, 'wt'),
      slotsRoot,
      claudeConfigDir: join(root, 'runner-cfg'),
      // 假 CLI 用 node 直接跑：不靠 shebang，Windows 上也能真跑。
      // claude 也挂同一支假 CLI：049.2 之后只有它能开账号槽，验限额要它。
      executors: {
        pool: { tool: 'node', args: [tool], backends: [{ name: 'sub', env: {} }] },
        claude: { tool: 'node', args: [tool], backends: [{ name: 'sub', env: {} }] },
      },
      maxMinutes: 1,
      mergeWaitMinutes: 0,
    };
    return { root, cfg, slotsRoot };
  }

  async function claimed(extra: Record<string, unknown> = {}, executor = 'pool') {
    const t = tasks.createTask({ title: '043.5 真跑', project: 'demo', category: 'dev', executor, status: 'queued', ...extra }, 'me');
    tasks.updateTask(t.id, { start_requested: 1 }, 'me');
    const res = await fetch(`${base}/api/runner/next?executors=${executor}&runner=r`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return await res.json();
  }

  test('exit0 + is_error=true：任务失败、运行失败，错误文本只留记录；原因里的凭据已打码', async () => {
    const { cfg } = setup(`console.log(JSON.stringify({
      type: 'result', is_error: true,
      result: 'provider request failed\\nAuthorization: Bearer test-token-not-real-0000',
    }));`);
    const task = await claimed({ answer_only: 1 });
    await R.runTask(cfg, task);

    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'failed', '退出码 0 不能盖过 is_error');
    assert.match(t.fail_reason ?? '', /编码工具报告失败/);
    assert.match(t.fail_reason ?? '', /provider request failed/);
    assert.doesNotMatch(t.fail_reason ?? '', /test-token-not-real-0000/, '失败原因里的凭据要打码');
    assert.match(t.result_text ?? '', /provider request failed/, '原结果保留下来给人看');
    assert.doesNotMatch(t.result_text ?? '', /test-token-not-real-0000/, '原结果也要打码');
    assert.equal(runs.listRuns(task.id)[0].outcome, 'failed');
  });

  test('exit0 但没有最终结果：任务失败并说清原因', async () => {
    const { cfg } = setup(`console.log(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: '我在做了' }] },
    }));`);
    const task = await claimed({ answer_only: 1 });
    await R.runTask(cfg, task);

    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'failed');
    assert.match(t.fail_reason ?? '', /没有给出最终结果/);
    assert.equal(runs.listRuns(task.id)[0].outcome, 'failed');
  });

  test('exit0、最终结果为空：任务失败', async () => {
    const { cfg } = setup(`console.log(JSON.stringify({ type: 'result', is_error: false, result: '' }));`);
    const task = await claimed({ answer_only: 1 });
    await R.runTask(cfg, task);

    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'failed');
    assert.match(t.fail_reason ?? '', /最终结果为空/);
  });

  test('正常回答（只要一个回答、没有改动）：照旧完成', async () => {
    const { cfg } = setup(`console.log(JSON.stringify({
      type: 'result', is_error: false, result: '这个项目是一个自托管的 AI 工作台。', usage: { input_tokens: 3, output_tokens: 4 },
    }));`);
    const task = await claimed({ answer_only: 1 });
    await R.runTask(cfg, task);

    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'done');
    assert.equal(t.no_changes, 1);
    assert.match(t.result_text ?? '', /自托管的 AI 工作台/);
    assert.equal(runs.listRuns(task.id)[0].outcome, 'done');
  });

  test('有改动、正常完成：照旧完成并留下分支', async () => {
    const { cfg } = setup(`import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
writeFileSync('made.txt', 'x\\n');
execFileSync('git', ['add', '.'], { stdio: 'ignore' });
execFileSync('git', ['commit', '-qm', 'fake change'], { stdio: 'ignore' });
console.log(JSON.stringify({ type: 'result', is_error: false, result: '改好了' }));`);
    const task = await claimed();
    await R.runTask(cfg, task);

    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'done');
    assert.equal(t.no_changes, 0);
    assert.equal(t.branch, `wb/T-${task.id}`);
    assert.equal(runs.listRuns(task.id)[0].outcome, 'done');
  });

  test('限额组合：exit0 + is_error=true + 认出到上限 → 走 limited，任务回排队', async () => {
    const { cfg, slotsRoot } = setup(`console.log(JSON.stringify({
      type: 'result', is_error: true,
      result: "You've hit your session limit · resets 3pm (Asia/Hong_Kong)",
    }));`);
    mkdirSync(join(slotsRoot, 'claude-a'), { recursive: true });
    runs.createSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const task = await claimed({}, 'claude');
    assert.equal(task.slots[0].name, 'claude-a');
    await R.runTask(cfg, task);

    const t = tasks.getTask(task.id)!;
    assert.equal(t.status, 'queued', '到上限不是普通失败，回排队换槽');
    const r = runs.listRuns(task.id)[0];
    assert.equal(r.outcome, 'limited');
    assert.equal(r.slot, 'claude-a');
    assert.equal(runs.listSlots().find((s) => s.name === 'claude-a')!.state, 'limited');
  });
});