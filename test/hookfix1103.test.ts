// 2026-11-03 用户截图里的两个误伤：
//   1. 提交说明里写着「Co-Authored-By: Claude Code」，一次普通的 git commit 被当成「执行器里再启动一个 claude」，要人批；
//   2. Claude Code 的后台任务通知（<task-notification>…）被当成用户输入，建出一个乱码标题的任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WB_DB = ':memory:';
const { runnerRuleFor, systemPrompt } = await import('../src/services/approvals.ts');

test('提交说明里提到 Claude 不算再起一个 claude', () => {
  const cmd = 'git add hello.txt && git commit -m "新增 hello.txt\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"';
  assert.equal(runnerRuleFor('Bash', { command: cmd })?.name ?? null, null);
  assert.equal(runnerRuleFor('Bash', { command: "echo 'run claude later'" })?.name ?? null, null);
});

test('真的起 claude 仍然拦', () => {
  for (const cmd of ['claude -p "做点事"', 'npx claude', 'cd x && claude.exe --help', '"C:/bin/claude.cmd" -p hi']) {
    assert.equal(runnerRuleFor('Bash', { command: cmd })?.name, '执行器里再启动一个 claude', cmd);
  }
});

test('后台任务通知不是人说的话', () => {
  assert.equal(systemPrompt('<task-notification> <task-id>b2st1</task-id>'), true);
  assert.equal(systemPrompt('  <system-reminder>x'), true);
  assert.equal(systemPrompt('帮我改一下 <b> 标签'), false);
  assert.equal(systemPrompt(''), false);
});
