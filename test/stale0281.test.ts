// 028.1：执行器在跑旧代码这件事要看得见。
// 起因：T-18/T-19 一直失败，最后发现领任务的进程是 22:20 启动的，而 028 的代码 22:53 才提交——
// Node 启动时把 runner.mjs 读进内存，磁盘上怎么改都影响不到它。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0281-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  cookie = await loginCookie(base, 'test-password-0123456789');
});

after(() => server.close());

const beat = (id: string, meta: Record<string, unknown>) =>
  fetch(`${base}/api/runner/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runner: id, meta }),
  });

const page = async (path: string) => {
  const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  return res.text();
};

describe('028.1 代码指纹', () => {
  test('一个字节的差别就能测出来', async () => {
    const { codeFingerprint } = await import('../scripts/runner.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    try {
      const a = join(dir, 'a.mjs');
      const b = join(dir, 'b.mjs');
      writeFileSync(a, 'export const x = 1;\n');
      writeFileSync(b, 'export const x = 2;\n');
      assert.equal(codeFingerprint([a]), codeFingerprint([a]), '同样的内容，指纹要稳定');
      assert.notEqual(codeFingerprint([a]), codeFingerprint([b]), '改一个字节就该变');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('真实入口脚本能算出 8 位以上', async () => {
    const { codeFingerprint } = await import('../scripts/runner.mjs');
    assert.match(codeFingerprint(), /^[0-9a-f]{64}$/);
  });
});

describe('028.1 心跳里的 stale_code', () => {
  beforeEach(async () => {
    const res = await fetch(`${base}/api/runner/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runner: 'runner-test', meta: { executors: ['pool'], pid: 4242, code_hash: 'abc12345', stale_code: false } }),
    });
    assert.equal(res.status, 200);
  });

  test('正常情况下「执行者」页没有旧代码提示', async () => {
    const html = await page('/team');
    assert.ok(!html.includes('执行器还在跑旧代码'), '不该无缘无故提示');
  });

  test('报 stale_code 之后「执行者」页出现橙色提示和重启命令', async () => {
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'abc12345', stale_code: true });
    const html = await page('/team');
    assert.ok(html.includes('执行器还在跑旧代码'), '要提醒重启');
    assert.ok(html.includes('abc12345'), '要能看到跑的是哪一版');
    assert.ok(html.includes('Stop-ScheduledTask'), '要写明怎么重启');
    assert.ok(html.includes('data-copy'), '命令要能一键复制');
  });

  test('「今天」页也提示', async () => {
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'abc12345', stale_code: true });
    const html = await page('/');
    assert.ok(html.includes('执行器还在跑旧代码'));
  });

  test('还原成不 stale 之后提示消失', async () => {
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'abc12345', stale_code: true });
    assert.ok((await page('/team')).includes('执行器还在跑旧代码'));
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'abc12345', stale_code: false });
    assert.ok(!(await page('/team')).includes('执行器还在跑旧代码'));
  });

  test('code_hash 能在执行者数据里读到', async () => {
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'deadbeef', stale_code: false });
    const { listRunners } = await import('../src/services/runner.ts');
    const row = listRunners().find((r) => r.id === 'runner-test');
    assert.equal(row?.code_hash, 'deadbeef');
    assert.equal(row?.pid, 4242);
  });

  test('执行者页常驻显示「代码 xxxxxxxx」', async () => {
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'cafebabe', stale_code: false });
    const html = await page('/team');
    assert.ok(html.includes('代码 cafebabe'), '不用等到报警才看得到版本');
  });
});
