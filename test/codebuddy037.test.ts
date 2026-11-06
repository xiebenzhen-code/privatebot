// 037：WorkBuddy 的 codebuddy 接成执行器的编码工具。
// 这个工具和 Claude Code 同源，但有三处不一样，三处都吃过或差点吃到的坑：
//   1. `-p` 后面不给提示词、只往 stdin 塞纯文本时，它一个字不输出、退出码 0（实测 2.179.1）；
//   2. 没登录时也是退出码 0，回答里一句「Authentication required」——不认这条就是假成功；
//   3. 钩子文档只承诺「退出码 2 = 阻止」，permissionDecision 那套 JSON 它没写会读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEBUDDY_ENV, codebuddyArgs, codebuddyGate, codebuddyLoginState, codebuddyPrompt, codebuddyVersion,
  excludeFromGit, loginProblem, loginState, parseStreamLine, usageAccountOf, writeCodebuddyGate,
} from '../scripts/runner.mjs';

// 真机录下来的四行（2026-11-01，codebuddy 2.179.1，未登录）。顺序就是它吐的顺序。
const REAL_INIT = '{"type":"system","subtype":"init","session_id":"01a19326-x","apiKeySource":"www.codebuddy.ai","model":"default-model","tools":["Read","Write","Bash"]}';
const REAL_STATUS = '{"type":"system","subtype":"status","status":null}';
const REAL_ASSISTANT = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Authentication required. Please use /login command to sign in to your account"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}}';
const REAL_RESULT_ERROR = '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":1195,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0}';

// 跑通一次的形状（官方 headless 文档的 result 字段），用来钉住「成功时读哪几个键」。
const OK_ASSISTANT = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"先读 README"}],"usage":{"input_tokens":1200,"output_tokens":80}}}';
const OK_RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"这个仓库是个人工作台。","usage":{"input_tokens":1500,"output_tokens":120},"total_cost_usd":0.01}';

test('真机录的事件能直接喂给现有解析器，不用另写一份', () => {
  assert.equal(parseStreamLine(REAL_INIT).kind, 'init');
  assert.equal(parseStreamLine(REAL_STATUS).kind, 'other');
  const said = parseStreamLine(REAL_ASSISTANT);
  assert.equal(said.kind, 'step');
  assert.match(said.step, /Authentication required/);
  const done = parseStreamLine(OK_RESULT);
  assert.equal(done.kind, 'result');
  assert.equal(done.failed, false);
  assert.equal(done.text, '这个仓库是个人工作台。');
  assert.equal(done.tokens, 1620, 'token 要按输入输出加回来');
});

test('没登录也有退出码 0：认得出这句，任务才不会被标成已完成', () => {
  assert.equal(loginState(REAL_ASSISTANT), 'logged-out');
  // 这句话常常只出现在 assistant 正文里（当成 step 收进 tail），result 那行一个字都没有。
  // 执行器就是把这三样合起来判断的，所以这里也按合起来测。
  assert.equal(loginState([REAL_ASSISTANT, REAL_RESULT_ERROR].join(' ')), 'logged-out');
  assert.equal(loginState(REAL_RESULT_ERROR), 'ok', '只看 result 会漏掉——所以才要合起来看');
  assert.equal(loginState(OK_RESULT), 'ok');
  assert.equal(loginState(''), 'unknown');
  assert.match(loginProblem('logged-out'), /\/login/);
  assert.match(loginProblem('logged-out'), /不保存账号密码/);
  assert.match(loginProblem('unknown'), /一个字都没回/);
  assert.equal(loginProblem('ok'), '');
});

test('提示词走 stdin 的 JSON 行：换行、引号、%PATH% 都不经过 shell', () => {
  const nasty = '改这一行：\n  const a = "b" & echo %PATH% | more `who`\n然后提交';
  const line = codebuddyPrompt(nasty);
  assert.equal(line.includes('\n'), true, '结尾那一个换行是 jsonl 分隔');
  assert.equal(line.trimEnd().includes('\n'), false, '正文里的换行必须被转义掉');
  const back = JSON.parse(line);
  assert.equal(back.type, 'user');
  assert.equal(back.message.role, 'user');
  assert.equal(back.message.content[0].text, nasty, '原样送到，一个字都不能少');
});

test('只读档不给 -y 并禁掉写盘工具；写档才给 -y', () => {
  const ro = codebuddyArgs();
  assert.ok(ro.includes('--input-format'), '不给 input-format 它就闷着不输出');
  assert.equal(ro.includes('-y'), false, '只读档绝不能给 -y');
  assert.ok(ro.includes('--disallowedTools'));
  const denied = ro[ro.indexOf('--disallowedTools') + 1];
  for (const tool of ['Bash', 'Write', 'Edit']) assert.ok(denied.includes(tool), `要禁 ${tool}`);
  const rw = codebuddyArgs({ write: true });
  assert.ok(rw.includes('-y'));
  assert.equal(rw.includes('--disallowedTools'), false);
});

test('后端给了模型就透传 --model', () => {
  const args = codebuddyArgs({ model: 'deepseek-v4-pro', write: true });
  assert.equal(args[args.indexOf('--model') + 1], 'deepseek-v4-pro');
});

test('不是 codebuddy 的执行者，门禁一概不管', () => {
  assert.equal(codebuddyGate({ tool: 'claude' }).problem, '');
  assert.equal(codebuddyGate({ backends: [{ name: 'deepseek', model: 'x' }] }).problem, '');
});

test('找不着命令：说清楚怎么装，并且不领任务', () => {
  const gate = codebuddyGate({ tool: 'codebuddy' }, { probe: () => 'ok', find: () => '' });
  assert.match(gate.problem, /npm i -g @tencent-ai\/codebuddy-code/);
});

test('codebuddyPath 指错地方：直说文件不存在，不去猜', () => {
  const gate = codebuddyGate({ tool: 'codebuddy', codebuddyPath: join(tmpdir(), '__wb_no_such_codebuddy__') }, { probe: () => 'ok' });
  assert.match(gate.problem, /不存在/);
});

test('没登录：领任务之前就挡住，原因写的是「怎么登录」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-cb-exe-'));
  const exe = join(dir, 'codebuddy');
  writeFileSync(exe, '#!/bin/sh\nexit 1\n');
  const gate = codebuddyGate({ tool: 'codebuddy', codebuddyPath: exe }, { probe: () => 'logged-out' });
  assert.match(gate.problem, /没登录/);
  assert.equal(gate.state, 'logged-out');
});

// 2026-11-01 真机：从 WorkBuddy 宿主里起的进程带着 SERVER__PORT（桌面端 daemon 的端口），
// codebuddy 读到就去 listen，直接 EADDRINUSE 起不来。这条钉住「环境里给空值」。
test('SERVER__PORT 不能漏给 codebuddy（否则它去抢桌面端的端口，起都起不来）', () => {
  assert.equal(CODEBUDDY_ENV.SERVER__PORT, '', '要给空串：等于不指定，它自己分配端口');
});

test('起来了但崩了：不能把报错读成「已登录」', () => {
  const crashed = 'Error: listen EADDRINUSE: address already in use 127.0.0.1:65255 (use --port <number> to choose another port)';
  assert.equal(loginState(crashed), 'unknown', '端口被占时它一个字没答，读成 ok 就会派任务上去空转');
  assert.equal(loginState("Error: Cannot find module '/x/codebuddy'"), 'unknown');
  assert.equal(loginState('Client network socket disconnected before secure TLS connection was established'), 'unknown');
  assert.match(loginProblem('unknown'), /一个字都没回/, '原因要指向「它自己没起来」');
});

test('stderr 里有 setProxy 那种无害告警时，按 stdout 的回答判', () => {
  // 实测：带代理变量跑时 stderr 必现 `fetch config failed TypeError ... instanceof is not callable`，
  // 但回答是正常的。两边合起来判会把好结果读成崩了。
  const state = codebuddyLoginState('C:/fake/stdout-ok', {
    now: 0,
    run: () => ({ stdout: OK_RESULT, stderr: 'fetch config failed TypeError: Right-hand side of instanceof is not callable' }),
  });
  assert.equal(state, 'ok');
  const noAnswer = codebuddyLoginState('C:/fake/stdout-crash', {
    now: 0,
    run: () => ({ stdout: '', stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:65255' }),
  });
  assert.equal(noAnswer, 'unknown', '没有回答、只有报错，就是没起来');
});

test('登录探测 30 分钟内不重复问（每次都问等于每次任务白烧一次请求）', () => {
  let calls = 0;
  const run = () => { calls += 1; return { stdout: '{"result":"ok"}', stderr: '' }; };
  const exe = 'C:/fake/codebuddy-037';
  assert.equal(codebuddyLoginState(exe, { now: 1_000, run }), 'ok');
  assert.equal(codebuddyLoginState(exe, { now: 2_000, run }), 'ok');
  assert.equal(calls, 1, '同一个可执行文件、30 分钟内只问一次');
  assert.equal(codebuddyLoginState(exe, { now: 31 * 60_000, run }), 'ok');
  assert.equal(calls, 2, '过了 30 分钟要重新问');
});

test('token 记到 WorkBuddy 账号，别落在账外', () => {
  assert.equal(usageAccountOf({ tool: 'codebuddy' }), 'WorkBuddy');
  assert.equal(usageAccountOf({ tool: 'codebuddy', account: '我的号' }), '我的号', '配了账号就听配置的');
  assert.equal(usageAccountOf({ tool: 'claude' }), '', '别的工具没配账号就不瞎记');
});

test('版本号只认第一个 x.y.z', () => {
  const exe = join(tmpdir(), '__wb_ver__');
  assert.equal(codebuddyVersion(''), '', '没有可执行文件就别瞎猜');
  assert.equal(codebuddyVersion(exe), '', '跑不起来就返回空串');
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-cb-'));
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  return dir;
}

test('门禁写进 worktree 的 .codebuddy/settings.local.json，并且被 git 忽略', () => {
  const dir = tempRepo();
  const gate = writeCodebuddyGate(dir);
  assert.equal(gate.ok, true, gate.why);
  const settings = JSON.parse(readFileSync(gate.file, 'utf8'));
  const pre = settings.hooks.PreToolUse[0];
  assert.match(pre.matcher, /Bash/);
  assert.match(pre.matcher, /Write/);
  const cmd = pre.hooks[0].command;
  assert.match(cmd, /claude-hook\.mjs/, '要指向现有的钩子脚本，不另写一份');
  assert.match(cmd, /^node "/, 'codebuddy 在 Windows 上固定用 Git Bash 跑钩子，命令得是 bash 能直接执行的形状');
  const hookPath = cmd.match(/"([^"]+)"/)[1];
  assert.equal(existsSync(hookPath), true, '钩子脚本必须真的在');
  assert.ok(settings.hooks.Stop && settings.hooks.UserPromptSubmit, '任务跟踪也要挂上');

  const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.equal(status, '', '门禁文件不能出现在 git status 里，否则只读任务也会变成「有改动」');
});

test('再来一次还是同一份，不因为已存在就拒绝', () => {
  const dir = tempRepo();
  assert.equal(writeCodebuddyGate(dir).ok, true);
  const again = writeCodebuddyGate(dir);
  assert.equal(again.ok, true, '重试/复用 worktree 时不能把自己写的文件当成仓库自带的');
});

test('仓库自带 settings.local.json：宁可不装，也不假装门禁在', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, '.codebuddy'), { recursive: true });
  writeFileSync(join(dir, '.codebuddy/settings.local.json'), '{"hooks":{}}');
  const gate = writeCodebuddyGate(dir);
  assert.equal(gate.ok, false);
  assert.match(gate.why, /仓库自带/);
});

test('info/exclude 只加一次', () => {
  const dir = tempRepo();
  const file = excludeFromGit(dir, '.codebuddy/');
  excludeFromGit(dir, '.codebuddy/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() === '.codebuddy/');
  assert.equal(lines.length, 1);
});

test('codebuddy 变体：拦下就是退出码 2，原因走 stdout', () => {
  const hook = new URL('../scripts/claude-hook.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [process.platform === 'win32' ? hook.slice(1) : hook], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'git push' } }),
    encoding: 'utf8',
    env: { ...process.env, WB_SOURCE: 'runner', WB_HOOK_VARIANT: 'codebuddy', WB_TASK_ID: '7', WB_URL: 'http://127.0.0.1:9', WB_TOKEN: 'x' },
    timeout: 60_000,
  });
  assert.equal(r.status, 2, 'codebuddy 只认退出码 2 是「阻止」');
  assert.match(r.stdout, /工作台连不上/);
});

test('同一个脚本不带变体时，仍然是 Claude Code 那套 JSON 决定', () => {
  const hook = new URL('../scripts/claude-hook.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [process.platform === 'win32' ? hook.slice(1) : hook], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'git push' } }),
    encoding: 'utf8',
    env: { ...process.env, WB_SOURCE: 'runner', WB_URL: 'http://127.0.0.1:9', WB_TOKEN: 'x', WB_HOOK_VARIANT: '' },
    timeout: 60_000,
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});
