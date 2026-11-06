// 036：把 dsh 接成第二种编码工具。这里只测执行器这一侧——配置、版本锁、事件解析、环境底线。
// 事件样本是 0.2.1-rc.5 真跑出来的（--profile headless --json）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('036 dsh 事件解析', () => {
  test('session 当 init，status 里的用量算进 token', async () => {
    const { parseDshLine } = await import('../scripts/runner.mjs');
    const init = parseDshLine('{"type":"session","sessionId":"s-1","cwd":"C:/x"}');
    assert.equal(init.kind, 'init');
    const usage = parseDshLine('{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6378,"outputTokens":61,"cacheReadTokens":0,"totalTokens":6439}}');
    assert.equal(usage.tokens, 6439);
    assert.equal(usage.inputTokens, 6378);
    assert.equal(usage.outputTokens, 61);
  });

  test('tool_call 变成一句步骤，成功的 tool_result 不刷屏', async () => {
    const { parseDshLine } = await import('../scripts/runner.mjs');
    const call = parseDshLine('{"type":"tool_call","callId":"c1","tool":"glob","input":{"pattern":"*"}}');
    assert.equal(call.kind, 'step');
    assert.match(call.step, /glob/);
    assert.equal(parseDshLine('{"type":"tool_result","callId":"c1","status":"completed","result":"a.txt"}'), null);
  });

  test('失败的 tool_result 要留一句，否则用户只看到卡住', async () => {
    const { parseDshLine } = await import('../scripts/runner.mjs');
    const failed = parseDshLine('{"type":"tool_result","callId":"c1","status":"error","result":"Error: [sandbox: file access denied under read-only mode]"}');
    assert.equal(failed.kind, 'step');
    assert.match(failed.step, /read-only/);
  });

  test('final 就是交付给用户的结果，全文保留', async () => {
    const { parseDshLine } = await import('../scripts/runner.mjs');
    const long = '这个目录里只有一个文件：a.txt。';
    const final = parseDshLine(JSON.stringify({ type: 'final', text: long }));
    assert.equal(final.kind, 'result');
    assert.equal(final.text, long);
    assert.equal(final.failed, false);
  });

  test('乱行、空行、不认识的类型都不算错', async () => {
    const { parseDshLine } = await import('../scripts/runner.mjs');
    assert.equal(parseDshLine(''), null);
    assert.equal(parseDshLine('not json'), null);
    assert.equal(parseDshLine('{"type":"whatever","x":1}').kind, 'other');
  });
});

describe('036 版本锁', () => {
  test('没锁就不管；锁了就必须一致', async () => {
    const { dshVersionProblem } = await import('../scripts/runner.mjs');
    assert.equal(dshVersionProblem('0.2.1-rc.5', ''), '');
    assert.equal(dshVersionProblem('0.2.1-rc.5', '0.2.1-rc.5'), '');
    const bad = dshVersionProblem('0.2.2-alpha.2', '0.2.1-rc.5');
    assert.match(bad, /0\.2\.2-alpha\.2/);
    assert.match(bad, /0\.2\.1-rc\.5/);
    assert.match(bad, /只读任务/);
    assert.match(dshVersionProblem('', '0.2.1-rc.5'), /找不到 dsh/);
  });

  test('执行者不用 dsh 时完全不查', async () => {
    const { dshGate } = await import('../scripts/runner.mjs');
    assert.deepEqual(dshGate({ tool: 'claude' }), { problem: '', version: '', exe: '' });
    assert.deepEqual(dshGate(undefined), { problem: '', version: '', exe: '' });
  });

  test('配了 dshPath 但那个文件不存在：给人话，不去跑任务', async () => {
    const { dshGate } = await import('../scripts/runner.mjs');
    const gate = dshGate({ tool: 'dsh', dshPath: '/definitely/not/here/dsh', dshVersion: '0.2.1-rc.5' });
    assert.match(gate.problem, /找不到 dsh/);
  });
});

describe('036 运行', () => {
  test('假 dsh：任务走 stdin，--json 事件按 dsh 的格式解析，环境里带着只读与关日志上传', async () => {
    const { runTool, parseDshLine, DSH_ENV, DSH_ARGS } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-dsh-'));
    const fake = join(dir, 'fake-dsh.mjs');
    const seen = join(dir, 'seen.json');
    // 假 dsh：把收到的 argv / stdin / 两个 DSH_* 记下来，再按 dsh 的格式吐几行事件。
    writeFileSync(fake, `
import { readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), stdin, env: { DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE } }));
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'glob', input: {} }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '看完了，只有一个 a.txt。' }) + '\\n');
`);

    const lines = [];
    const res = await runTool({
      tool: 'node', args: [fake, seen], cwd: dir, parse: parseDshLine, prompt: '列出这个目录里的文件',
      env: { ...process.env, ...DSH_ENV }, timeoutMs: 20000, onLine: (m) => lines.push(m),
    });

    assert.equal(res.code, 0);
    const got = JSON.parse(readFileSync(seen, 'utf8'));
    assert.equal(got.stdin, '列出这个目录里的文件', '任务说明走 stdin');
    assert.equal(got.env.DSH_PERMISSION_MODE, 'read-only');
    assert.equal(got.env.DSH_TELEMETRY_MODE, 'DISABLED');
    assert.deepEqual(DSH_ARGS, ['--profile', 'headless', '--json']);

    const result = lines.find((l) => l.kind === 'result');
    assert.equal(result.text, '看完了，只有一个 a.txt。');
    const tokenLine = lines.find((l) => l.tokens > 0);
    assert.equal(tokenLine.tokens, 120);
    rmSync(dir, { recursive: true, force: true });
  });
});

// 036.1（审查建议修）：没锁 dshVersion 时，第一次真跑看到的版本要记下来，之后变了就拒绝。
// 需求单要的是版本锁；只靠 doctor 一句提醒，dsh 升级一次就能把事件解析悄悄弄坏。
describe('036.1 版本记忆（没锁 dshVersion 时）', () => {
  /** 造一个只会 `--version` 的假 dsh；两个平台都要能跑，所以按平台挑扩展名。 */
  const fakeDsh = (dir, version) => {
    if (process.platform === 'win32') {
      const p = join(dir, `dsh-${version}.cmd`);
      writeFileSync(p, `@echo off\r\necho ${version}\r\n`, 'utf8');
      return p;
    }
    const p = join(dir, `dsh-${version}`);
    writeFileSync(p, `#!/bin/sh\necho ${version}\n`, 'utf8');
    chmodSync(p, 0o755);
    return p;
  };

  test('第一次记下来；同版本放行；版本变了就拒绝并说清楚怎么改', async () => {
    const { dshGate, readDshVersions } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-dshver-'));
    const file = join(dir, 'dsh-versions.json');
    try {
      const v1 = fakeDsh(dir, '0.2.1-rc.5');
      const first = dshGate({ tool: 'dsh', dshPath: v1 }, { name: 'dsh', remember: true, versionFile: file });
      assert.equal(first.problem, '', first.problem);
      assert.deepEqual(readDshVersions(file), { dsh: '0.2.1-rc.5' }, '第一次要把版本记下来');

      const again = dshGate({ tool: 'dsh', dshPath: v1 }, { name: 'dsh', remember: true, versionFile: file });
      assert.equal(again.problem, '', '同版本不能因为「有记录」就拒绝');

      const v2 = fakeDsh(dir, '0.2.2-alpha.2');
      const changed = dshGate({ tool: 'dsh', dshPath: v2 }, { name: 'dsh', remember: true, versionFile: file });
      assert.match(changed.problem, /版本变了/);
      assert.match(changed.problem, /0\.2\.1-rc\.5/);
      assert.match(changed.problem, /dshVersion 改成 0\.2\.2-alpha\.2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('只看不写：doctor 那一路不会替你把版本记下来', async () => {
    const { dshGate } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-dshver-'));
    const file = join(dir, 'dsh-versions.json');
    try {
      const exe = fakeDsh(dir, '0.2.1-rc.5');
      const gate = dshGate({ tool: 'dsh', dshPath: exe }, { name: 'dsh', versionFile: file });
      assert.equal(gate.problem, '');
      assert.equal(existsSync(file), false, 'doctor 只是看一眼，不该落盘');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('已经锁了 dshVersion：不写版本记忆（锁本身就是判据）', async () => {
    const { dshGate } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wb-dshver-'));
    const file = join(dir, 'dsh-versions.json');
    try {
      const exe = fakeDsh(dir, '0.2.1-rc.5');
      const gate = dshGate({ tool: 'dsh', dshPath: exe, dshVersion: '0.2.1-rc.5' }, { name: 'dsh', remember: true, versionFile: file });
      assert.equal(gate.problem, '');
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
