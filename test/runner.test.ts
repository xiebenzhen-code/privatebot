// 008: runner API — atomic claim, progress, finish → merge approval, runner-only hook rules.
import { dayOf } from '../src/domain.ts';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCookie } from './helpers.ts';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOKEN = 'test-token-runner-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { app.close(); });

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
  // Writes are made as a browser session: some endpoints are human-only (008.2).
  const authHeaders: Record<string, string> = init.method && init.method !== 'GET' && cookie
    ? { Cookie: cookie }
    : { Authorization: `Bearer ${TOKEN}` };
  const res = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...authHeaders, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty or html */ }
  return { status: res.status, json, text };
}

async function queuedTask(overrides: Record<string, unknown> = {}) {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '执行器任务', executor: 'pool', category: 'dev', project: 'demo', ...overrides }),
  });
  db.prepare("UPDATE tasks SET status = 'queued', start_requested = 1 WHERE id = ?").run(created.json.id);
  return created.json;
}

describe('claiming', () => {
  test('two runners racing get the same task at most once', async () => {
    const task = await queuedTask();
    const [a, b] = await Promise.all([
      api('/api/runner/next?executors=pool&runner=r1'),
      api('/api/runner/next?executors=pool&runner=r2'),
    ]);
    const got = [a, b].filter((r) => r.status === 200 && r.json?.id === task.id);
    assert.equal(got.length, 1, 'exactly one runner wins');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'running');
    assert.ok(db.prepare('SELECT runner_id FROM tasks WHERE id = ?').get(task.id).runner_id);
  });

  test('an empty queue answers 204', async () => {
    const res = await api('/api/runner/next?executors=pool&runner=r1');
    assert.equal(res.status, 204);
  });

  test('a manual task needs the start button first', async () => {
    const task = await queuedTask({ mode: 'manual' });
    db.prepare('UPDATE tasks SET start_requested = 0 WHERE id = ?').run(task.id);
    assert.equal((await api('/api/runner/next?executors=pool&runner=r1')).status, 204);

    db.prepare('UPDATE tasks SET start_requested = 1 WHERE id = ?').run(task.id);
    const res = await api('/api/runner/next?executors=pool&runner=r1');
    assert.equal(res.json.id, task.id);
  });

  test('the daily token cap and the concurrency cap both hold', async () => {
    db.prepare("UPDATE executor_settings SET daily_token_cap = 1000 WHERE executor = 'pool'").run();
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO usage (source_key, ts, day, executor, account, model, project, input_tokens, output_tokens, cache_tokens)
      VALUES ('seed', ?, ?, 'pool', '', 'x', '', 5000, 0, 0)`).run(ts, dayOf(ts));
    await queuedTask();
    assert.equal((await api('/api/runner/next?executors=pool&runner=r1')).status, 204, 'daily cap reached');

    db.prepare('DELETE FROM usage').run();
    db.prepare('UPDATE executor_settings SET max_concurrent = 1 WHERE executor = ?').run('pool');
    await queuedTask();
    db.prepare("INSERT INTO tasks (title, description, category, executor, project, status, mode, created_at, updated_at, runner_log, tokens_used, start_requested) VALUES ('占位', '', 'dev', 'pool', 'demo', 'running', 'auto', ?, ?, '', 0, 0)")
      .run(ts, ts);
    assert.equal((await api('/api/runner/next?executors=pool&runner=r1')).status, 204, 'already at max concurrency');
  });

  test('043.4 工具审批占用编码名额，编码结束后合并审批不占', async () => {
    db.prepare("UPDATE executor_settings SET max_concurrent = 1 WHERE executor = 'pool'").run();
    const a = await queuedTask();
    const b = await queuedTask();
    const next = (id: string) => api(`/api/runner/next?executors=pool&runner=${id}`);
    assert.equal((await next('r1')).json.id, a.id);
    const tool = await api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: '043.4-tool', source: 'runner', task_id: a.id,
        executor: 'pool', tool_name: 'Bash', tool_input: { command: 'cat .env.local' },
      }),
    });
    assert.equal(tool.json.action, 'wait');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(a.id).status, 'review');
    assert.equal((await next('r2')).status, 204, '模型还活着，不能借工具审批再领一单');
    const { queueBlocker } = await import('../src/services/runner.ts');
    const { getTask } = await import('../src/services/tasks.ts');
    const { decideApproval } = await import('../src/services/approvals.ts');
    assert.equal(queueBlocker(getTask(b.id)!)?.code, 'busy');
    decideApproval(tool.json.approval_id, 'approved', '');
    assert.equal((await next('r2')).status, 204, '工具放行后编码仍未结束');
    const finish = await api(`/api/runner/tasks/${a.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', changed_files: ['src/example.ts'] }),
    });
    assert.ok(finish.json.approval_id);
    assert.equal(db.prepare('SELECT status FROM approvals WHERE id = ?').get(finish.json.approval_id).status, 'pending');
    assert.equal((await next('r2')).json.id, b.id, '只剩合并审批，编码名额已释放');
  });

  test('043.4 重试推送的审批不占模型名额', async () => {
    db.prepare("UPDATE executor_settings SET max_concurrent = 1 WHERE executor = 'pool'").run();
    const a = await queuedTask();
    db.prepare("UPDATE tasks SET retry = 'push' WHERE id = ?").run(a.id);
    const next = () => api('/api/runner/next?executors=pool&runner=r1');
    assert.equal((await next()).json.id, a.id);
    const b = await queuedTask();
    const { createApproval } = await import('../src/services/approvals.ts');
    createApproval({ title: '推送', task_id: a.id, tool_name: 'git push' });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE task_id = ? AND outcome = 'running'").get(a.id).n, 0);
    assert.equal((await next()).json.id, b.id);
  });
});

describe('progress and finish', () => {
  test('progress keeps the last 2KB of log and the token count', async () => {
    const task = await queuedTask();
    const claimed = await api('/api/runner/next?executors=pool&runner=r1');
    assert.equal(claimed.json.id, task.id);

    const big = 'x'.repeat(5000) + 'TAIL';
    const res = await api(`/api/runner/tasks/${task.id}/progress`, {
      method: 'POST',
      body: JSON.stringify({ step: '跑测试', progress: 60, tokens_used: 1234, log_tail: big }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.progress, 60);
    assert.equal(res.json.tokens_used, 1234);
    assert.ok(res.json.runner_log.length <= 2048);
    assert.ok(res.json.runner_log.endsWith('TAIL'));
  });

  test('a finished task becomes a merge approval, not a merge', async () => {
    const task = await queuedTask();
    await api('/api/runner/next?executors=pool&runner=r1');
    const res = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: '加了 README 链接', diff_stat: '2 files changed, 10 insertions(+)', tests: 'npm test 96/96' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'done');

    const approval = db.prepare('SELECT * FROM approvals WHERE task_id = ?').get(task.id) as any;
    assert.ok(approval, 'one approval');
    assert.match(approval.title, /合并 wb\/T-\d+ 到 main/);
    assert.match(approval.summary, /2 files changed/);
    assert.match(approval.summary, /96\/96/);
    assert.equal(res.json.approval_id, approval.id);
    // main was not touched
    assert.equal(db.prepare('SELECT branch FROM tasks WHERE id = ?').get(task.id).branch, `wb/T-${task.id}`);
  });

  test('013.5: 审批记下分支和提交号，第二次跑拿到的是新的一条', async () => {
    const task = await queuedTask();
    await api('/api/runner/next?executors=pool&runner=r1');
    const first = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: '第一版', branch: `wb/T-${task.id}`, commit: 'abc1234def5678' }),
    });
    assert.equal(first.json.approval_id > 0, true);
    const a1 = await api(`/api/approvals/${first.json.approval_id}`);
    assert.match(a1.json.summary, new RegExp(`分支：wb/T-${task.id} · 提交：abc1234`));
    assert.deepEqual(JSON.parse(a1.json.tool_input), { branch: `wb/T-${task.id}`, commit: 'abc1234def5678' });

    // 用户批准了第一版，又要求返工：第二次完成必须是一条全新的、还悬着的审批
    await api(`/api/approvals/${first.json.approval_id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
    db.prepare("UPDATE tasks SET status = 'queued', start_requested = 1 WHERE id = ?").run(task.id);
    await api('/api/runner/next?executors=pool&runner=r1');
    const second = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: '第二版', branch: `wb/T-${task.id}-2`, commit: 'feedbeef12345678' }),
    });
    assert.notEqual(second.json.approval_id, first.json.approval_id);
    const a2 = await api(`/api/approvals/${second.json.approval_id}`);
    assert.equal(a2.json.status, 'pending');

    const { newestMerge } = await import('../scripts/runner.mjs');
    const list = (await api(`/api/approvals?task=${task.id}`)).json;
    assert.equal(newestMerge(list, task.id).id, second.json.approval_id, '最新的那条才是这次要等的');
  });

  test('013.5: 不是提交号的 commit 不会被当真', async () => {
    const task = await queuedTask();
    await api('/api/runner/next?executors=pool&runner=r1');
    const res = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: 'x', commit: 'main; rm -rf /' }),
    });
    const a = await api(`/api/approvals/${res.json.approval_id}`);
    assert.equal(JSON.parse(a.json.tool_input).commit, '');
  });

  test('a failed run produces no merge approval', async () => {
    const task = await queuedTask();
    await api('/api/runner/next?executors=pool&runner=r1');
    const res = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'failed', summary: '测试没通过' }),
    });
    assert.equal(res.json.status, 'failed');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM approvals').get() as any).n, 0);
  });
});

describe('runner heartbeat', () => {
  test('a recent heartbeat means online, an old one means offline', async () => {
    await api('/api/runner/heartbeat', { method: 'POST', body: JSON.stringify({ runner: 'r1', meta: { executors: ['zcode'] } }) });
    let list = await api('/api/runners');
    assert.equal(list.json[0].online, true);

    db.prepare('UPDATE runners SET last_seen = ? WHERE id = ?').run(new Date(Date.now() - 300000).toISOString(), 'r1');
    list = await api('/api/runners');
    assert.equal(list.json[0].online, false);
  });
});

describe('executor-only hook rules', () => {
  async function hook(source: string, tool: string, input: Record<string, unknown>) {
    return api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: 'C:/tmp/wt', tool_name: tool, tool_input: input, source }),
    });
  }

  test('installing dependencies asks for approval only for the runner', async () => {
    const asRunner = await hook('runner', 'Bash', { command: 'npm i left-pad' });
    assert.equal(asRunner.json.action, 'wait');
    assert.equal(asRunner.json.risk, 'medium');

    const asUser = await hook('', 'Bash', { command: 'npm i left-pad' });
    assert.equal(asUser.json.action, 'none', 'the user typing it themselves is not interrupted');
  });

  test('touching the workbench or .claude is high risk for the runner', async () => {
    const workbench = await hook('runner', 'Bash', { command: 'curl http://localhost:3200/api/tasks' });
    assert.equal(workbench.json.risk, 'high');

    const dotClaude = await hook('runner', 'Write', { file_path: 'C:/tmp/wt/.claude/settings.json', content: '{}' });
    assert.equal(dotClaude.json.risk, 'high');
  });
});

describe('013.5: a stray WB_TASK_ID must not hijack a task', () => {
  test('用户自己的会话带着 task_id 也不会挂到执行器的任务上', async () => {
    const task = await queuedTask();
    await api('/api/runner/next?executors=pool&runner=r1'); // 任务归执行器，status=running

    const res = await api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'user-sess-1', task_id: task.id, prompt: '我自己在终端里干活' }),
    });
    assert.equal(res.status, 200);
    const attached = db.prepare('SELECT session_id FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(attached.session_id, null, '执行器的任务没被别的会话占用');
    const mine = db.prepare("SELECT id FROM tasks WHERE session_id = 'user-sess-1'").get() as any;
    assert.ok(mine, '用户会话有自己的任务');
    assert.notEqual(mine.id, task.id);
  });

  test('执行器自己的会话仍然复用领取的任务', async () => {
    const task = await queuedTask();
    await api('/api/runner/next?executors=pool&runner=r1');
    const res = await api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'run-sess-1', task_id: task.id, source: 'runner', prompt: '干活' }),
    });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT session_id, status FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(row.session_id, 'run-sess-1');
    assert.equal((db.prepare("SELECT COUNT(*) n FROM tasks WHERE session_id = 'run-sess-1'").get() as any).n, 1);
  });
});

describe('runner helpers', () => {
  test('the prompt carries the task and the rules', async () => {
    const { buildPrompt } = await import('../scripts/runner.mjs');
    const prompt = buildPrompt({ id: 7, title: '加文档', description: '写 Windows 说明', category: 'doc' }, '守则正文');
    assert.match(prompt, /T-7/);
    assert.match(prompt, /写 Windows 说明/);
    assert.match(prompt, /守则正文/);
  });

  test('stream-json lines are understood, junk is ignored', async () => {
    const { parseStreamLine } = await import('../scripts/runner.mjs');
    const step = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '正在改 README' }], usage: { input_tokens: 10, output_tokens: 5 } } }));
    assert.equal(step.kind, 'step');
    assert.match(step.step, /正在改 README/);
    assert.equal(step.tokens, 15);

    const result = parseStreamLine(JSON.stringify({ type: 'result', result: '全部完成', is_error: false }));
    assert.equal(result.kind, 'result');
    assert.match(result.summary, /全部完成/);
    assert.equal(parseStreamLine('not json'), null);
  });

  const hasGit = spawnSync('git', ['--version']).status === 0;
  test('a worktree is created on its own branch and can be removed', { skip: hasGit ? false : '本机没有 git' }, async () => {
    const { makeWorktree, removeWorktree } = await import('../scripts/runner.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'wb-repo-'));
    const root = mkdtempSync(join(tmpdir(), 'wb-wt-'));
    const sh = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    sh('init', '-q', '-b', 'main');
    sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

    const { dir, branch } = makeWorktree(repo, root, 42);
    assert.equal(branch, 'wb/T-42');
    assert.ok(existsSync(join(dir, '.git')));
    writeFileSync(join(dir, 'note.txt'), 'hi');
    assert.match(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout, /wb\/T-42/);

    removeWorktree(repo, dir);
    assert.ok(!existsSync(dir));

    // 013.5: 返工时旧分支还在，第二次必须换个分支名，否则 worktree add -b 会失败
    const again = makeWorktree(repo, root, 42);
    assert.equal(again.branch, 'wb/T-42-2');
    assert.ok(existsSync(join(again.dir, '.git')));
    removeWorktree(repo, again.dir);
    assert.equal(makeWorktree(repo, root, 42).branch, 'wb/T-42-3');

    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test('013.5: 合并审批里新的一条才算数，旧的已批准不能顶替', async () => {
    const { newestMerge } = await import('../scripts/runner.mjs');
    // 工作台把 pending 排在前面，其余按 id 倒序；旧实现用 find 会先命中旧的已批准那条
    const list = [
      { id: 9, task_id: 4, title: '合并 wb/T-4-2 到 main', status: 'pending' },
      { id: 3, task_id: 4, title: '合并 wb/T-4 到 main', status: 'approved' },
      { id: 5, task_id: 7, title: '合并 wb/T-7 到 main', status: 'approved' },
    ];
    assert.equal(newestMerge(list, 4).id, 9);
    assert.equal(newestMerge(list, 7).id, 5);
    assert.equal(newestMerge([], 4), null);
  });

  test('013.5: 合并失败的提示写明原因，且不带令牌', async () => {
    const { mergeFailureStep } = await import('../scripts/runner.mjs');
    const step = mergeFailureStep(new Error('git merge 失败：CONFLICT (content): Merge conflict in src/app.ts; Authorization: Bearer abcdef123456'));
    assert.match(step, /^合并失败：/);
    assert.match(step, /CONFLICT/);
    assert.ok(!/abcdef123456/.test(step));
    assert.ok(step.length <= 200);
  });
});

describe('008.1 hardening', () => {
  test('the prompt reaches the tool over stdin, byte for byte', async () => {
    const { runTool } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-stdin-'));
    const fake = join(dir, 'fake-tool.mjs');
    const out = join(dir, 'received.txt');
    writeFileSync(fake, "import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], readFileSync(0, 'utf8'));\n");

    const prompt = '第一行 & echo pwned > pwned.txt\n带引号 " 和 %PATH% 的说明\n第三行';
    const res = await runTool({
      tool: 'node', args: [fake, out], cwd: dir, env: { ...process.env, WB_SOURCE: 'runner' },
      prompt, onLine: () => {}, timeoutMs: 15000,
    });
    assert.equal(res.code, 0);
    assert.equal(readFileSync(out, 'utf8'), prompt, 'stdin is passed through untouched');
    assert.ok(!existsSync(join(dir, 'pwned.txt')), 'the injection never ran');
    rmSync(dir, { recursive: true, force: true });
  });

  test('the hook config is written to its own dir and points at a real file', async () => {
    const { ensureHookConfig, selfCheck, claudeConfigDir } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-cfg-'));
    const cfg = { claudeConfigDir: dir };
    const { file } = ensureHookConfig(cfg);
    assert.equal(dir, claudeConfigDir(cfg));
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.match(command, /claude-hook\.mjs/);
    const script = (command.match(/"([^"]+)"/) ?? [])[1];
    assert.ok(existsSync(script), 'the hook script exists at the configured absolute path');
    assert.equal(selfCheck(cfg).ok, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a repo that ships .claude settings is detected', async () => {
    const { worktreeSettings } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-wt2-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
    assert.equal(worktreeSettings(dir).length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the child environment is a whitelist and never carries the workbench token', async () => {
    const { childEnv } = await import('../scripts/runner.mjs');
    const env = childEnv({ PATH: '/bin', WB_TOKEN: 'secret', DEEPSEEK_API_KEY: 'sk-x', SystemRoot: 'C:/Windows' }, { WB_SOURCE: 'runner' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.WB_SOURCE, 'runner');
    assert.equal(env.SystemRoot, 'C:/Windows');
    assert.equal(env.WB_TOKEN, undefined);
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
  });
});

describe('008.1 rule bypasses', () => {
  async function hook(tool: string, input: Record<string, unknown>, source = 'runner') {
    return api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-x', cwd: 'C:/tmp/wt', tool_name: tool, tool_input: input, source }),
    });
  }

  test('.claude is caught in shell commands, not just file paths', async () => {
    const redirect = await hook('Bash', { command: "echo '{}' > .claude/settings.json" });
    assert.equal(redirect.json.risk, 'high');
    const mkdir = await hook('Bash', { command: 'mkdir .claude' });
    assert.equal(mkdir.json.risk, 'high');
  });

  test('any host on port 3200 counts as the workbench', async () => {
    for (const cmd of ['curl http://203.0.113.5:3200/api/tasks', 'curl http://[::1]:3200/', 'curl http://host.docker.internal:3200/']) {
      const res = await hook('Bash', { command: cmd });
      assert.equal(res.json.risk, 'high', cmd);
    }
  });

  test('a nested claude is refused', async () => {
    for (const command of ['claude --resume', 'npx claude -p "hi"']) {
      const res = await hook('Bash', { command });
      assert.equal(res.json.risk, 'high', command);
    }
  });

  test('043.3 shell -c 和命令替换里的 Claude 经真实 hook 要审批', async () => {
    for (const command of [
      'bash -c "claude -p hello"',
      "sh -lc 'claude -p hello'",
      'echo "$(claude -p hello)"',
      'echo "`claude -p hello`"',
      'echo "$(echo "$(env MODE=x \'C:/bin/claude.cmd\' -p hi)")"',
      'MODE=x env -u WB_SOURCE "C:/bin/claude.cmd" -p hi',
      "cl'au'de -p hi",
    ]) {
      const res = await hook('Bash', { command });
      assert.equal(res.json.risk, 'high', command);
      assert.notEqual(res.json.action, 'allow', command);
    }
  });

  test('043.3 shell 无法静态确认执行内容时交人工', async () => {
    for (const command of ['bash -c "$SCRIPT"', '"$PROGRAM" -p hi', 'eval "$SCRIPT"', "env -S 'claude -p hi'"]) {
      const res = await hook('Bash', { command });
      assert.equal(res.json.risk, 'high', command);
    }
  });

  test('043.3 提交说明、单引号和转义的命令替换只是数据', async () => {
    for (const command of [
      'git commit -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"',
      "echo '$(claude -p hello) `claude -p hello`'",
      'echo "\\$(claude -p hello)"',
      'echo "$(pwd)"',
      'bash -c "echo hello"',
    ]) {
      const res = await hook('Bash', { command });
      assert.equal(res.json.action, 'allow', command);
    }
  });

  for (const [name, command, expected] of [
    ['node -e', `node -e "require('child_process').execSync('claude -p x')"`, 'uncertain'],
    ['python3 -c', `python3 -c 'import os; os.system("claude -p x")'`, 'uncertain'],
    ['find -exec', String.raw`find . -maxdepth 0 -exec claude -p x \;`, 'claude'],
    ['setsid', 'setsid claude -p x', 'claude'],
    ['stdbuf', 'stdbuf -oL claude -p x', 'claude'],
    ['script -qc', "script -qc 'claude -p x' /dev/null", 'uncertain'],
    ['trap', "trap 'claude -p x' EXIT", 'uncertain'],
    ['git -c', "git -c core.pager='claude -p' log", 'uncertain'],
    ['watch', 'watch -n1 claude -p x', 'claude'],
    ['su -c', "su -c 'claude -p x'", 'uncertain'],
  ] as const) {
    test(`043.3 交叉验证反例：${name}`, async () => {
      const { inspectShell } = await import('../src/services/shell-inspection.ts');
      const result = inspectShell(command);
      const res = await hook('Bash', { command });
      assert.deepEqual([result[expected], res.json.risk, res.json.action === 'allow'], [true, 'high', false], command);
    });
  }

  test('043.3 其他执行字符串的写法也交人工', async () => {
    const { inspectShell } = await import('../src/services/shell-inspection.ts');
    for (const command of [
      "node --eval='spawn(\"claude\")'", "node -p 'spawn(\"claude\")'",
      "deno eval 'new Deno.Command(\"claude\")'", "bun --eval 'Bun.spawn([\"claude\"])'",
      "perl -e 'system(\"claude\")'", "ruby -we'system(\"claude\")'", "php -r 'exec(\"claude\");'",
      "git -C repo config alias.run '!claude -p x'", "git my-alias 'claude -p x'",
      "alias start='claude -p x'", "script --command='claude -p x' /dev/null",
      "watch -n1 'claude -p x'",
    ]) {
      const { claude, uncertain } = inspectShell(command);
      const res = await hook('Bash', { command });
      assert.deepEqual([claude, uncertain, res.json.risk, res.json.action === 'allow'], [false, true, 'high', false], command);
    }
  });

  test('043.3 完整参数词支持路径，普通引号文本仍放行', async () => {
    const { inspectShell } = await import('../src/services/shell-inspection.ts');
    for (const command of ['echo claude', "wrapper '/opt/Claude Code/CLAUDE.EXE'", String.raw`wrapper 'C:\Program Files\Tools\claude.cmd'`]) {
      const res = await hook('Bash', { command });
      assert.equal(inspectShell(command).claude, true, command);
      assert.equal(res.json.risk, 'high', command);
    }
    for (const command of [
      'echo "claude -p x"', 'echo "Claude Code 的帮助"',
      "git -C repo commit -m 'Co-Authored-By: Claude Code <noreply@anthropic.com>'",
      "node --eval 'console.log(\"claudette\")'",
    ]) {
      assert.equal((await hook('Bash', { command })).json.action, 'allow', command);
    }
  });

  test('013.6: 路径里带 claude-runner 不算再启动一个 claude', async () => {
    // 执行器自己的日志在 claude-runner/ 下面，读它不该被当成「又起了一个 claude」；
    // 那里同时是门禁配置所在，所以读它仍然会走家目录那条审批——这里只钉住 claude 这一条。
    const { runnerRuleFor } = await import('../src/services/approvals.ts');
    const name = (command: string) => runnerRuleFor('Bash', { command }, 'C:/tmp/wt')?.name ?? 'allow';
    assert.equal(name('tail -n 25 "D:/runs/claude-runner/projects/x/tool-results/a.txt"'), 'allow');
    assert.equal(name('claude --resume'), '执行器里再启动一个 claude');
    assert.equal(name('npx claude -p "hi"'), '执行器里再启动一个 claude');
  });

  test('013.6: .env.example 是模板，可以改；.env 和 .env.local 不行', async () => {
    const ok = await hook('Bash', { command: 'git add .env.example && git commit -m "补两个变量"' });
    assert.equal(ok.json.action, 'allow');
    for (const command of ['cat .env', 'echo X=1 >> .env.local', 'cat .env.production']) {
      const res = await hook('Bash', { command });
      assert.equal(res.json.risk, 'high', command);
    }
  });

  test('an ordinary command is explicitly allowed for the runner', async () => {
    const res = await hook('Bash', { command: 'npm test' });
    assert.equal(res.json.action, 'allow', 'no rule matched, and headless mode must not ask');
  });

  test('013.6: 命令里只是写了自己的工作目录，不算伸手进家目录', async () => {
    const cwd = 'C:\\Users\\you\\wb-worktrees\\T-10';
    for (const command of [
      `cd "${cwd}" && npm test`,
      'cd "C:/Users/you/wb-worktrees/T-10" && git status',
      `git -C "${cwd}" log --oneline -1`,
    ]) {
      const res = await api('/api/hooks/claude', {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-home', cwd, tool_name: 'Bash', tool_input: { command }, source: 'runner' }),
      });
      assert.equal(res.json.action, 'allow', command);
    }
  });

  test('013.6: 真的去翻别处的家目录还是拦下来', async () => {
    const cwd = 'C:\\Users\\you\\wb-worktrees\\T-10';
    for (const command of [
      'type C:\\Users\\you\\.ssh\\id_rsa',
      'cat ~/.aws/credentials',
      'ls C:/Users/you/Documents',
    ]) {
      const res = await api('/api/hooks/claude', {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-home2', cwd, tool_name: 'Bash', tool_input: { command }, source: 'runner' }),
      });
      assert.equal(res.json.risk, 'high', command);
    }
  });
});

describe('008.2 worktree sandbox', () => {
  const cwd = 'C://Users//you//wb-worktrees//T-7';
  async function hook(tool: string, input: Record<string, unknown>) {
    return api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-wt', cwd, tool_name: tool, tool_input: input, source: 'runner' }),
    });
  }

  test('a path inside the worktree is allowed', async () => {
    const res = await hook('Write', { file_path: 'C://Users//you//wb-worktrees//T-7//src//a.ts', content: 'x' });
    assert.equal(res.json.action, 'allow');
  });

  test('reading outside the worktree is denied outright', async () => {
    for (const p of ['C://Users//you//.ssh//id_rsa', '/etc/passwd', 'D://other//repo//file.ts']) {
      const res = await hook('Read', { file_path: p });
      assert.equal(res.json.action, 'deny', p);
      assert.match(res.json.reason, /自己的工作目录/);
    }
  });

  test('.. and mixed separators cannot escape', async () => {
    const escaped = await hook('Write', { file_path: 'C://Users//you//wb-worktrees//T-7//..//..//evil.txt', content: 'x' });
    assert.equal(escaped.json.action, 'deny');
    const mixed = await hook('Edit', { file_path: 'C:/Users/you/wb-worktrees/T-7/../../../x' });
    assert.equal(mixed.json.action, 'deny');
    const sibling = await hook('Read', { file_path: 'C:/Users/you/wb-worktrees/T-77/x' });
    assert.equal(sibling.json.action, 'deny', 'a sibling worktree is still outside');
  });

  test('Grep without a path defaults to the worktree and passes', async () => {
    const res = await hook('Grep', { pattern: 'TODO' });
    assert.equal(res.json.action, 'allow');
  });

  test('bash near the home directory or secrets asks for approval', async () => {
    for (const command of ['cat ~/.ssh/id_rsa', 'type %USERPROFILE%\\secret.txt', 'cat .env', 'ls /Users/x/.ssh']) {
      const res = await hook('Bash', { command });
      assert.equal(res.json.action, 'wait', command);
      assert.equal(res.json.risk, 'high', command);
    }
  });
});

describe('runner self-check', () => {
  test('doctor reports what is missing instead of failing at run time', async () => {
    const { doctor, which } = await import('../scripts/runner.mjs');
    assert.ok(which('node'), 'node is on PATH');
    assert.equal(which('definitely-not-a-real-tool-xyz'), '');

    const cfg = {
      workbench: 'http://localhost:3200',
      projects: { demo: process.cwd() },
      executors: { zcode: { tool: 'definitely-not-a-real-tool-xyz', env: {} } },
      claudeConfigDir: mkdtempSync(join(tmpdir(), 'wb-doctor-')),
    };
    const rows = doctor(cfg);
    const tool = rows.find((r: any) => r.name.startsWith('编码工具'));
    assert.equal(tool.ok, false, 'a missing coding tool is caught up front');
    assert.match(tool.detail, /找不到/);
    assert.ok(rows.find((r: any) => r.name === '门禁配置')?.ok, 'the hook config is written and checked');
    assert.ok(rows.find((r: any) => r.name === '项目 demo')?.ok);
  });
});

describe('013 executor split', () => {
  test('ZCode never gets handed a task, even with 开始 pressed', async () => {
    const task = await queuedTask({ executor: 'zcode', category: 'dev' });
    db.prepare('UPDATE tasks SET start_requested = 1 WHERE id = ?').run(task.id);
    const res = await api('/api/runner/next?executors=pool&runner=r1');
    assert.equal(res.status, 204, 'ZCode only hands out work by hand, in its own app');
  });

  test('a pool task the user started is claimable, although pool never auto-runs', async () => {
    const task = await queuedTask({ executor: 'pool', category: 'dev' });
    const setting = db.prepare("SELECT auto_allowed FROM executor_settings WHERE executor = 'pool'").get() as any;
    assert.equal(setting.auto_allowed, 0, 'nothing runs by itself');

    const res = await api('/api/runner/next?executors=pool&runner=r1');
    assert.equal(res.json.id, task.id);
    assert.equal(res.json.status, 'running');
  });

  test('pool carries the tighter 013 budget limits', async () => {
    const row = db.prepare("SELECT daily_token_cap, max_minutes, task_token_cap FROM executor_settings WHERE executor = 'pool'").get() as any;
    assert.equal(row.daily_token_cap, 5_000_000);
    assert.equal(row.max_minutes, 30);
    assert.equal(row.task_token_cap, 2_000_000);
  });

  test('the single-task cap comes from the executor, not the global default', async () => {
    const task = await queuedTask({ executor: 'pool', category: 'dev' });
    await api('/api/runner/next?executors=pool&runner=r1');
    // 2.1M tokens: over pool's 2M cap, far under the global 20M default
    const res = await api(`/api/runner/tasks/${task.id}/budget`, { method: 'POST', body: JSON.stringify({ tokens: 2_100_000, minutes: 1 }) });
    assert.equal(res.json.gated, true);
    assert.match(db.prepare('SELECT summary FROM approvals WHERE task_id = ?').get(task.id)?.summary ?? '', /2000000/);
  });
});

describe('013 hook attribution', () => {
  test('a runner session hangs its approvals off the task it already claimed', async () => {
    const task = await queuedTask({ executor: 'pool', category: 'dev' });
    // 013.5：光有 task_id 不够，必须是执行器真领过的任务，所以先领取
    await api('/api/runner/next?executors=pool&runner=r1');
    const before = (await api('/api/tasks')).json.length;

    const r = await api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'sess-runner-1', cwd: 'C:/Users/me/wb-worktrees/T-99',
        tool_name: 'Bash', tool_input: { command: 'git push origin main' }, source: 'runner', task_id: task.id,
      }),
    });
    assert.equal(r.json.action, 'wait');

    const a = (await api(`/api/approvals/${r.json.approval_id}`)).json;
    assert.equal(a.task_id, task.id, 'the approval points at the claimed task, not an invented one');
    assert.equal((await api('/api/tasks')).json.length, before, 'no phantom task was created');
    assert.equal((await api(`/api/tasks/${task.id}`)).json.session_id, 'sess-runner-1', 'the session is stamped on it');

    // the next call from the same session finds it without task_id
    const r2 = await api('/api/hooks/claude', {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-runner-1', tool_name: 'Bash', tool_input: { command: 'git push --force' }, source: 'runner' }),
    });
    assert.equal((await api(`/api/approvals/${r2.json.approval_id}`)).json.task_id, task.id);
    assert.equal((await api('/api/tasks')).json.length, before);
  });
});

describe('013 merge approval', () => {
  test('approving a merge leaves the finished task finished', async () => {
    const task = await queuedTask({ executor: 'pool', category: 'dev' });
    await api('/api/runner/next?executors=pool&runner=r1');
    const fin = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: '改好了', branch: `wb/T-${task.id}`, diff_stat: '1 file changed' }),
    });
    assert.equal((await api(`/api/tasks/${task.id}`)).json.status, 'done');

    const d = await api(`/api/approvals/${fin.json.approval_id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(d.json.status, 'approved');
    const after = (await api(`/api/tasks/${task.id}`)).json;
    assert.equal(after.status, 'done', 'a finished task must not go back to 运行中 when the merge is approved');
    assert.ok(after.completed_at, 'and it keeps its completion time');
  });
});

describe('013 approvals filter', () => {
  test('?task= really filters, so the runner cannot pick up another task\'s merge approval', async () => {
    const a = await queuedTask({ executor: 'pool', category: 'dev' });
    const b = await queuedTask({ executor: 'pool', category: 'dev' });
    await api('/api/runner/next?executors=pool&runner=r1');
    const fin = await api(`/api/runner/tasks/${a.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: '改好了', branch: `wb/T-${a.id}` }),
    });
    assert.ok(fin.json.approval_id);

    const mine = (await api(`/api/approvals?task=${a.id}`)).json;
    assert.ok(mine.length > 0);
    assert.ok(mine.every((x: any) => x.task_id === a.id));
    assert.equal((await api(`/api/approvals?task=${b.id}`)).json.length, 0, 'another task sees none of them');
  });
});

describe('013 pause reason', () => {
  test('the reason a run stopped comes before the model summary', async () => {
    const { finishSummary } = await import('../scripts/runner.mjs');
    const long = '我把六个需求单都读完了。'.repeat(200); // 2400 chars, like a real summary
    const s = finishSummary('被总开关暂停，当前这一步结束后停止', long);
    assert.ok(s.startsWith('被总开关暂停'), 'the reason survives the 200-character step field');
    assert.ok(s.includes('读完了'));
    assert.ok(s.length <= 4000);
    assert.equal(finishSummary('', long), long.slice(0, 4000), 'a normal run is just the summary');
  });
});

describe('013.6 断线不退出', () => {
  test('连不上工作台时按 5s/10s/20s 退避，最多一分钟', async () => {
    const { pollBackoff } = await import('../scripts/runner.mjs');
    assert.equal(pollBackoff(1), 5_000);
    assert.equal(pollBackoff(2), 10_000);
    assert.equal(pollBackoff(3), 20_000);
    assert.equal(pollBackoff(9), 60_000, '一直连不上也不无限等');
    assert.equal(pollBackoff(0), 5_000);
  });
});

describe('013.6 重试合并 / 重试推送', () => {
  const failed = async (extra: Record<string, unknown> = {}) => {
    const t = await queuedTask({ executor: 'pool' });
    // 025：「重试合并」只给执行器自己标记过 merge 的任务，夹具要带上 retry。
    db.prepare("UPDATE tasks SET status = 'failed', branch = ?, merged_commit = ?, retry = ? WHERE id = ?")
      .run(extra.branch ?? `wb/T-${t.id}`, extra.merged_commit ?? null, extra.retry ?? 'merge', t.id);
    return t;
  };

  test('合并被挡下的任务可以只重试合并，不用重跑编码工具', async () => {
    const t = await failed();
    const res = await api(`/api/tasks/${t.id}/retry-merge`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'queued');
    assert.equal(res.json.start_requested, 1);
    assert.equal(res.json.retry, 'merge');
    assert.match(res.json.step, /重试合并/);
    assert.equal(res.json.completed_at, null, '回到队列就要清掉完成时间');
  });

  test('没有分支就没有可合并的东西', async () => {
    const t = await queuedTask({ executor: 'pool' });
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(t.id);
    const res = await api(`/api/tasks/${t.id}/retry-merge`, { method: 'POST' });
    assert.equal(res.status, 400);
  });

  test('还没合并过的任务不能重试推送', async () => {
    const t = await failed();
    const res = await api(`/api/tasks/${t.id}/retry-push`, { method: 'POST' });
    assert.equal(res.status, 400);
  });

  test('合并过、推送失败的任务可以重试推送', async () => {
    const t = await failed({ merged_commit: 'abc1234' });
    const res = await api(`/api/tasks/${t.id}/retry-push`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.retry, 'push');
    assert.equal(res.json.start_requested, 1);
  });

  test('这两个按钮只认网页登录，令牌推不动仓库', async () => {
    const t = await failed({ merged_commit: 'abc1234' });
    const before = db.prepare('SELECT status, retry, start_requested FROM tasks WHERE id = ?').get(t.id) as any;
    for (const path of ['retry-merge', 'retry-push']) {
      const res = await fetch(`${base}/api/tasks/${t.id}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403, `${path} 必须是人点的`);
    }
    // 025：夹具本身就带着 retry='merge'，所以要断言「没被改动」，而不是「还是空」。
    const row = db.prepare('SELECT status, retry, start_requested FROM tasks WHERE id = ?').get(t.id) as any;
    assert.deepEqual(
      { status: row.status, retry: row.retry, start_requested: row.start_requested },
      { status: before.status, retry: before.retry, start_requested: before.start_requested },
      '令牌点不动这两个按钮',
    );
  });
});

describe('017 several backends per executor', () => {
  const mod = () => import('../scripts/runner.mjs');

  test('a plain single-tool spec is still one backend', async () => {
    const { backendsFor } = await mod();
    const one = backendsFor({ tool: 'claude', model: 'deepseek-chat', env: { ANTHROPIC_MODEL: 'deepseek-chat' } }, 'pool');
    assert.equal(one.length, 1, '013 style config keeps working unchanged');
    assert.equal(one[0].name, 'pool');
    assert.equal(one[0].model, 'deepseek-chat');
  });

  test('an ordered backend list keeps its order and shares tool and args', async () => {
    const { backendsFor } = await mod();
    const list = backendsFor({
      tool: 'claude',
      backends: [{ name: 'bailian', model: 'deepseek-v4.1-flash' }, { name: 'deepseek', model: 'deepseek-chat' }],
    });
    assert.deepEqual(list.map((b: any) => b.name), ['bailian', 'deepseek']);
    assert.equal(list[0].tool, 'claude');
    assert.deepEqual(list[0].args, ['-p', '--output-format', 'stream-json', '--verbose']);
    assert.equal(list[1].model, 'deepseek-chat');
  });

  test('a voucher hint picks bailian, anything else picks deepseek', async () => {
    const { backendsFor, pickBackend } = await mod();
    const list = backendsFor({ backends: [{ name: 'bailian' }, { name: 'deepseek' }] });
    assert.equal(pickBackend(list, 'bl-qwen3.8-omni-flash').name, 'bailian');
    assert.equal(pickBackend(list, 'deepseek-flash').name, 'deepseek');
    assert.equal(pickBackend(list, '').name, 'deepseek', 'no suggestion means the official balance');
    assert.equal(pickBackend(list, 'something-else').name, 'deepseek');
    assert.equal(pickBackend(backendsFor([{ name: 'bailian' }]), 'deepseek-flash').name, 'bailian',
      'with one backend configured there is nothing to choose');
  });

  test('only credit and permission answers justify another backend', async () => {
    const { backendSignal, backendUnavailable } = await mod();
    for (const text of [
      '403 AccessDenied.Unpurchased', 'HTTP 401 unauthorized', '429 Too Many Requests',
      'insufficient_quota', '账户余额不足', 'Invalid API key provided',
    ]) {
      assert.ok(backendUnavailable(text), text);
    }
    for (const text of ['2 tests failed', 'TypeError: x is not a function', '超过单任务时间上限（45 分钟）', '合并失败']) {
      assert.equal(backendUnavailable(text), false, `${text} must not trigger a fallback`);
    }
    assert.equal(backendSignal('upstream said 403 forbidden'), '403');
  });

  test('finish records the backend and the task page shows it', async () => {
    const task = await queuedTask();
    const res = await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', summary: '做完了', backend: 'bailian' }),
    });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT backend FROM tasks WHERE id = ?').get(task.id).backend, 'bailian');
    const page = await api(`/tasks?task=${task.id}`, { headers: { Cookie: cookie } });
    assert.ok(page.text.includes('后端 bailian'), 'the run says which model did it');
  });

  test('a junk backend name is dropped instead of stored', async () => {
    const task = await queuedTask();
    await api(`/api/runner/tasks/${task.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result: 'done', backend: 'DROP TABLE tasks' }),
    });
    assert.equal(db.prepare('SELECT backend FROM tasks WHERE id = ?').get(task.id).backend, null);
  });

  test('a backend can name the account its tokens are billed to', async () => {
    const { backendsFor } = await mod();
    const list = backendsFor({ backends: [{ name: 'bailian', model: 'm', account: '百炼代金券' }, { name: 'deepseek', model: 'd' }] });
    assert.equal(list[0].account, '百炼代金券');
    assert.equal(list[1].account, '', 'no account means the proxy queue does the accounting');
  });

  test('stream lines keep input and output apart, because they are priced apart', async () => {
    const { parseStreamLine } = await mod();
    const line = JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 310, output_tokens: 40 } });
    const parsed = parseStreamLine(line);
    assert.equal(parsed.tokens, 350);
    assert.equal(parsed.inputTokens, 310);
    assert.equal(parsed.outputTokens, 40);
    assert.equal(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'x' })).tokens, 0);
  });

  test('the runner may write runner.* audit lines, and nothing else may', async () => {
    const ok = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ kind: 'runner.backend_fallback', text: 'T-1 百炼不可用，改用 DeepSeek' }),
    });
    assert.equal(ok.status, 201);
    assert.ok(db.prepare("SELECT 1 FROM events WHERE kind = 'runner.backend_fallback'").get());
    const bad = await api('/api/events', { method: 'POST', body: JSON.stringify({ kind: 'task.forged', text: 'x' }) });
    assert.equal(bad.status, 400);
  });
});
