import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectShell } from '../src/services/shell-inspection.ts';

test('054.3a awk 系程序中的 claude 交人工', () => {
  for (const cmd of ['awk', 'gawk', 'mawk']) {
    assert.equal(inspectShell(`${cmd} 'BEGIN{system("claude -p x")}'`).uncertain, true, cmd);
  }
});

test('054.3a 包管理器启动 Claude Code 官方包直接拦', () => {
  for (const cmd of ['npx', 'npm exec', 'pnpm dlx', 'bunx']) {
    assert.equal(inspectShell(`${cmd} @anthropic-ai/claude-code -p x`).claude, true, cmd);
  }
});
