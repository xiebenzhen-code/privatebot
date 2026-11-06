// 035.3：部署之后「换执行器」这件事，要有交接，不能靠「点一下计划任务然后自己退出」。
//
// 背景：计划任务是 -MultipleInstances IgnoreNew，启动脚本里还有一道「已经有人在跑就跳过」的守卫。
// 旧执行器活着的时候点它等于什么都没发生，而 Start-ScheduledTask 照样返回 0；旧的随后退出，
// 于是机器上可能一个执行器都不剩，页面只显示「离线」。
//
// 这里分三层钉住：
//   1. 助手自己的判断（纯函数）；
//   2. 真的起两个子进程走一遍交接（旧的先退、新的才起、锁里的 pid 变了、旧的赖着不走就报失败）；
//   3. 工作台这边的状态（等待接班 → 接班到了就撤；5 分钟没到就橙色提示 + 推一条）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0353-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const HANDOFF = fileURLToPath(new URL('../scripts/lib/handoff.mjs', import.meta.url));

// ---------- 1. 助手自己的判断 ----------

describe('035.3 接班助手的判断', () => {
  test('锁文件带 BOM、坏 JSON 都不会让助手崩', async () => {
    const { parseLock } = await import('../scripts/lib/handoff.mjs');
    assert.deepEqual(parseLock('\uFEFF{"pid":42}'), { pid: 42 });
    assert.deepEqual(parseLock('{"pid":42}'), { pid: 42 });
    assert.equal(parseLock(''), null);
    assert.equal(parseLock('不是 json'), null);
    assert.equal(parseLock('123'), null, '不是对象就当没有锁');
  });

  test('自己不算「还活着」（助手自己也可能被当成占位者）', async () => {
    const { pidAlive } = await import('../scripts/lib/handoff.mjs');
    assert.equal(pidAlive(process.pid, process.pid), false);
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive('不是数字'), false);
  });

  test('旧进程退了但锁还指着它，也算让开了', async () => {
    const { canStart } = await import('../scripts/lib/handoff.mjs');
    const dead = 999_999; // 这个 pid 不会存在
    assert.equal(canStart({ pid: dead, lockText: JSON.stringify({ pid: dead }), isAlive: () => false }), true,
      '守卫被杀时锁文件可能没删掉，不能因此一直等');
    assert.equal(canStart({ pid: dead, lockText: '', isAlive: () => false }), true);
    assert.equal(canStart({ pid: dead, lockText: '', isAlive: () => true }), false, '进程还在就不算让开');
    assert.equal(canStart({ pid: dead, lockText: JSON.stringify({ pid: 7 }), isAlive: (p: number) => p === 7 }), false,
      '锁已经被别人占着，再起一个就是两个执行器');
  });

  test('新实例到位 = 锁里有个活着的、不是旧的那个 pid', async () => {
    const { successorPid } = await import('../scripts/lib/handoff.mjs');
    assert.equal(successorPid({ lockText: JSON.stringify({ pid: 100 }), fromPid: 1, isAlive: () => true }), 100);
    assert.equal(successorPid({ lockText: JSON.stringify({ pid: 1 }), fromPid: 1, isAlive: () => true }), 0, '还是旧的那个');
    assert.equal(successorPid({ lockText: JSON.stringify({ pid: 100 }), fromPid: 1, isAlive: () => false }), 0, 'pid 不在了');
    assert.equal(successorPid({ lockText: '', fromPid: 1, isAlive: () => true }), 0);
  });

  test('轮询会在超时处停，不会空转', async () => {
    const { waitUntil } = await import('../scripts/lib/handoff.mjs');
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    const never = await waitUntil(() => false, { timeoutMs: 3_000, everyMs: 1_000, sleep, now });
    assert.equal(never.ok, false);
    assert.equal(t >= 3_000, true, '要在超时附近停住');
    let calls = 0;
    const yes = await waitUntil(() => ++calls === 3, { timeoutMs: 10_000, everyMs: 100, sleep, now });
    assert.equal(yes.ok, true);
    assert.equal(calls, 3);
  });

  test('没有计划任务、也没有启动脚本：给一句人话，不许假装成功', async () => {
    const { startRunner } = await import('../scripts/lib/handoff.mjs');
    const r = startRunner({
      platform: 'win32', taskName: 'Nope',
      run: () => ({ status: 1, stderr: 'No MSFT_ScheduledTask objects found' }),
      exists: () => false,
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /请手动启动/);
    const mac = startRunner({ platform: 'darwin' });
    assert.equal(mac.ok, false);
    assert.match(mac.why, /手动重启/);
  });

  test('有计划任务就点它，并回报「怎么起的」', async () => {
    const { startRunner } = await import('../scripts/lib/handoff.mjs');
    const seen: string[] = [];
    const r = startRunner({
      platform: 'win32', taskName: 'AI Workbench Runner',
      run: (cmd: string, args: string[]) => { seen.push(`${cmd} ${args.join(' ')}`); return { status: 0, stdout: '', stderr: '' }; },
      exists: () => false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.how, '计划任务');
    assert.match(seen[0], /Start-ScheduledTask/);
  });

  test('计划任务点不动、但有启动脚本：退到脚本，仍然算起来了', async () => {
    const { startRunner } = await import('../scripts/lib/handoff.mjs');
    let launched = '';
    const r = startRunner({
      platform: 'win32',
      run: () => ({ status: 1, stderr: '拒绝访问' }),
      autostart: 'C:/tmp/runner-autostart.cmd',
      exists: () => true,
      launch: (p: string) => { launched = p; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.how, '启动脚本');
    assert.match(launched, /runner-autostart\.cmd/);
  });
});

// ---------- 2. 真的起进程走一遍 ----------

const OLD = (ms: number) => `
import { writeFileSync } from 'node:fs';
const [lock, markFile] = process.argv.slice(2);
writeFileSync(lock, JSON.stringify({ pid: process.pid }), 'utf8');
setTimeout(() => { writeFileSync(markFile, String(Date.now()), 'utf8'); process.exit(0); }, ${ms});
`;

const OLD_STUCK = `
import { writeFileSync } from 'node:fs';
const [lock] = process.argv.slice(2);
writeFileSync(lock, JSON.stringify({ pid: process.pid }), 'utf8');
setInterval(() => {}, 1000);
`;

const NEW = `
import { writeFileSync } from 'node:fs';
const [lock, markFile] = process.argv.slice(2);
writeFileSync(lock, JSON.stringify({ pid: process.pid }), 'utf8');
writeFileSync(markFile, String(Date.now()), 'utf8');
setInterval(() => {}, 1000);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('035.3 交接：真实子进程', () => {
  let dir = '';
  let lock = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-handoff-'));
    lock = join(dir, 'runner.lock');
    writeFileSync(join(dir, 'new.mjs'), NEW, 'utf8');
    writeFileSync(join(dir, 'old.mjs'), OLD(700), 'utf8');
    writeFileSync(join(dir, 'stuck.mjs'), OLD_STUCK, 'utf8');
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const startCmd = (script: string, markFile: string) =>
    `"${process.execPath}" "${join(dir, script)}" "${lock}" "${markFile}"`;

  const readJson = (f: string) => {
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  };

  /**
   * 异步跑助手并等它结束。
   *
   * **不能用 `spawnSync`**：它把测试进程的事件循环卡死，假执行器 0.7 秒后退出却没人收尸，
   * 在 Linux 上变成僵尸进程；而 `kill(pid, 0)` 对僵尸照样返回成功，助手于是永远认为
   * 「旧的还活着」，10 秒后报失败——Linux 上必红，Windows 上完全看不出来（035.3.1）。
   * 改成异步 spawn 之后事件循环是活的，libuv 会把退出的子进程收掉，pid 才真的消失。
   */
  const runNode = (args: string[], timeoutMs = 30_000) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });

  test('旧的退出之后新的才起，锁里的 pid 换成新的', async () => {
    const log = join(dir, 'case1.log');
    const oldMark = join(dir, 'case1-old.txt');
    const newMark = join(dir, 'case1-new.txt');
    rmSync(lock, { force: true });

    const oldProc = spawn(process.execPath, [join(dir, 'old.mjs'), lock, oldMark], { stdio: 'ignore' });
    // 等旧进程真的把锁写下来，否则助手会看到「没有锁」，测的就不是交接了
    for (let i = 0; i < 50 && !existsSync(oldMark); i++) {
      if (readJson(lock)?.pid) break;
      await sleep(50);
    }
    await sleep(100);
    const oldPid = readJson(lock)?.pid as number;
    assert.ok(oldPid > 0, '旧进程没写下锁');

    const r = await runNode([HANDOFF, '--pid', String(oldPid), '--lock', lock, '--log', log,
      '--start-cmd', startCmd('new.mjs', newMark), '--wait-exit', '10000', '--wait-start', '10000']);

    let newPid = 0;
    try {
      assert.equal(r.status, 0, `助手没有成功退出：${readFileSync(log, 'utf8')}`);
      const text = readFileSync(log, 'utf8');
      assert.match(text, /旧执行器 \d+ 已经退出/);
      assert.match(text, /接班成功/);

      newPid = Number(readJson(lock)?.pid);
      assert.ok(newPid > 0 && newPid !== oldPid, '锁里的 pid 要是新的');

      // 顺序：新实例的启动时间不早于旧进程的退出时间。
      const oldExit = Number(readFileSync(oldMark, 'utf8'));
      const newStart = Number(readFileSync(newMark, 'utf8'));
      assert.ok(newStart >= oldExit, `新的比旧的还早（${newStart} < ${oldExit}）`);
      // 旧进程确实没了
      assert.throws(() => process.kill(oldPid, 0));
    } finally {
      oldProc.kill('SIGKILL');
      if (newPid) { try { process.kill(newPid, 'SIGKILL'); } catch { /* 已经没了 */ } }
    }
  });

  test('旧的赖着不走：超时报失败，而且不启动新的', async () => {
    const log = join(dir, 'case2.log');
    const stuckMark = join(dir, 'case2-old.txt');
    const newMark = join(dir, 'case2-new.txt');
    rmSync(lock, { force: true });
    rmSync(newMark, { force: true });

    const stuck = spawn(process.execPath, [join(dir, 'stuck.mjs'), lock, stuckMark], { stdio: 'ignore' });
    let stuckPid = 0;
    try {
      for (let i = 0; i < 50; i++) {
        stuckPid = Number(readJson(lock)?.pid) || 0;
        if (stuckPid) break;
        await sleep(50);
      }
      assert.ok(stuckPid > 0, '假执行器没写下锁');

      const r = await runNode([HANDOFF, '--pid', String(stuckPid), '--lock', lock, '--log', log,
        '--start-cmd', startCmd('new.mjs', newMark), '--wait-exit', '1200', '--wait-start', '3000']);
      assert.notEqual(r.status, 0, '旧的没退就不能报成功');
      const text = readFileSync(log, 'utf8');
      assert.match(text, /没有退出/);
      assert.equal(existsSync(newMark), false, '旧的还活着就不许起新的——两个执行器会花两遍额度');
    } finally {
      if (stuckPid) { try { process.kill(stuckPid, 'SIGKILL'); } catch { /* 已经没了 */ } }
    }
  });
});

// ---------- 3. 工作台这边：等待、接班、超时 ----------

let server: Server;
let hook: Server;
let base = '';
let cookie = '';
let hookUrl = '';
let received: string[] = [];

before(async () => {
  hook = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      received.push(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"errcode":0,"errmsg":"ok"}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  const a = hook.address();
  hookUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/hook`;

  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a2 = server.address();
  base = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});
after(() => { server.close(); hook.close(); });

beforeEach(async () => {
  received = [];
  const { db } = await import('../src/db.ts');
  db().exec("DELETE FROM settings WHERE key = 'runner_handoff'");
  db().exec('DELETE FROM notify_channels');
  db().exec("DELETE FROM events WHERE kind LIKE 'runner.handoff%' OR kind = 'notify.handoff_missed'");
  db().exec('DELETE FROM runners');
});

const beat = (runner: string, meta: Record<string, unknown>) =>
  fetch(`${base}/api/runner/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runner, meta }),
  });

const expect = (body: Record<string, unknown>) =>
  fetch(`${base}/api/runner/handoff`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).text();

describe('035.3 工作台的「等待接班」', () => {
  test('登记之后：执行者页显示等待新执行器接班', async () => {
    const res = await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    assert.equal(res.status, 200);
    const html = await page('/team');
    assert.ok(html.includes('等待新执行器接班'));
    assert.ok(html.includes('4242'), '要能看出走的是哪个进程');
  });

  test('旧进程自己再跳几拍不算接班', async () => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'aaaa1111' });
    assert.ok((await page('/team')).includes('等待新执行器接班'), '同一个 pid 的心跳不能把等待撤掉');
  });

  test('换了 pid 的心跳就是接班：提示消失', async () => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    await beat('runner-test', { executors: ['pool'], pid: 5252, code_hash: 'bbbb2222' });
    const html = await page('/team');
    assert.ok(!html.includes('等待新执行器接班'));
    assert.ok(!html.includes('执行器没有接班'));
  });

  test('没换 pid 但代码指纹变了，也算接班（重启后 pid 复用的情况）', async () => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    await beat('runner-test', { executors: ['pool'], pid: 4242, code_hash: 'cccc3333' });
    assert.ok(!(await page('/team')).includes('等待新执行器接班'));
  });

  test('别的执行器的心跳不算：就算 pid 不同也还是等着', async () => {
    await expect({ runner: 'runner-a', pid: 4242, code_hash: 'aaaa1111' });
    await beat('runner-b', { executors: ['pool'], pid: 9999, code_hash: 'bbbb2222' });
    assert.ok((await page('/team')).includes('等待新执行器接班'), '别的机器来了不等于这台接班了');
    const { readHandoff } = await import('../src/services/runner.ts');
    assert.ok(readHandoff(), '记录也得留着');
  });

  // 035.3.1：没配 runnerId 时 id 默认是 runner-<进程号>，新进程的 id 必然和旧的不同。
  // 原来先比 id 再比 pid，新心跳直接当成「别的执行器」跳过，于是一个真的接班了，
  // 页面 5 分钟后照样报「没有接班」并推一条。
  test('没配 runnerId（默认 runner-<进程号>）：换了进程号也算接班', async () => {
    await expect({ runner: 'runner-111', pid: 111, code_hash: 'aaaa1111' });
    await beat('runner-222', { executors: ['pool'], pid: 222, code_hash: 'bbbb2222' });
    const { readHandoff } = await import('../src/services/runner.ts');
    assert.equal(readHandoff(), null, '默认 id 换进程号就是接班，记录要撤');
    assert.ok(!(await page('/team')).includes('等待新执行器接班'));
  });

  test('固定 id、pid 变了但代码没变：也算接班', async () => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    await beat('runner-test', { executors: ['pool'], pid: 4343, code_hash: 'aaaa1111' });
    const { readHandoff } = await import('../src/services/runner.ts');
    assert.equal(readHandoff(), null);
  });

  test('pid 不是正整数：400，说清楚为什么', async () => {
    const res = await expect({ runner: 'runner-test', pid: 0 });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /pid/);
  });

  test('超过 5 分钟：橙色提示「执行器没有接班，请手动启动」', async () => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    const { db } = await import('../src/db.ts');
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    db().prepare("UPDATE settings SET value = ? WHERE key = 'runner_handoff'")
      .run(JSON.stringify({ runner: 'runner-test', from_pid: 4242, from_hash: 'aaaa1111', at: old }));
    const html = await page('/team');
    assert.ok(html.includes('执行器没有接班，请手动启动'));
    assert.ok(html.includes('Start-ScheduledTask'), '要写明怎么启动');
    assert.ok(html.includes('data-copy'), '命令要能一键复制');
  });

  test('刚好不到 5 分钟还是「等待」，不催人', async () => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    const { db } = await import('../src/db.ts');
    const recent = new Date(Date.now() - 60_000).toISOString();
    db().prepare("UPDATE settings SET value = ? WHERE key = 'runner_handoff'")
      .run(JSON.stringify({ runner: 'runner-test', from_pid: 4242, from_hash: 'aaaa1111', at: recent }));
    assert.ok(!(await page('/team')).includes('执行器没有接班'));
  });
});

describe('035.3 没接班要推一条', () => {
  const aged = async (minutes = 6) => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    const { db } = await import('../src/db.ts');
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    db().prepare("UPDATE settings SET value = ? WHERE key = 'runner_handoff'")
      .run(JSON.stringify({ runner: 'runner-test', from_pid: 4242, from_hash: 'aaaa1111', at }));
  };

  const addChannel = async () => {
    const r = await fetch(`${base}/api/notify/channels`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'webhook', url: hookUrl }),
    });
    assert.equal(r.status, 201, await r.text());
  };

  test('推一条，之后再巡检不重复推', async () => {
    await aged();
    await addChannel();
    const { checkHandoffMissed } = await import('../src/services/runner.ts');
    assert.equal(await checkHandoffMissed(), 1);
    assert.equal(received.length, 1);
    assert.match(received[0], /接班/);
    assert.equal(await checkHandoffMissed(), 0, '推过了就别再推');
    assert.equal(received.length, 1);
  });

  test('时间没到不推', async () => {
    await aged(1);
    await addChannel();
    const { checkHandoffMissed } = await import('../src/services/runner.ts');
    assert.equal(await checkHandoffMissed(), 0);
    assert.equal(received.length, 0);
  });

  test('没有渠道时什么也不做，而且不标「推过了」——以后配好了还能推', async () => {
    await aged();
    const { checkHandoffMissed, readHandoff } = await import('../src/services/runner.ts');
    assert.equal(await checkHandoffMissed(), 0);
    assert.equal(readHandoff()?.notified ?? false, false);
    await addChannel();
    assert.equal(await checkHandoffMissed(), 1, '配好渠道之后应该还能推出去');
  });

  test('接班到了就没有记录可提醒', async () => {
    await aged();
    await addChannel();
    await beat('runner-test', { executors: ['pool'], pid: 7777, code_hash: 'dddd4444' });
    const { checkHandoffMissed, readHandoff } = await import('../src/services/runner.ts');
    assert.equal(readHandoff(), null);
    assert.equal(await checkHandoffMissed(), 0);
    assert.equal(received.length, 0);
  });
});

// 035.3.3：部署那一步的执行器马上要退出，它没机会给任务写结局。
// T-33 就是这么挂住的：任务停在「运行中」，而队列「一次只允许一个在途」再也不建新单，
// 整条自举链停在那儿，页面只显示一句「正在换成新执行器」。
describe('035.3.3 部署完由谁给任务结账', () => {
  const DEPLOYED = '已部署（容器已重建），正在换成新执行器（接班助手 1）';

  const deployedTask = async (step = DEPLOYED) => {
    const { createTask, getTask } = await import('../src/services/tasks.ts');
    const t = createTask({ title: '部署验收', status: 'running', step }, 'me');
    return { id: t.id, read: () => getTask(t.id)! };
  };

  /** 登记交接，然后把它的时间挪到 N 分钟前（模拟「等了一会儿」）。 */
  const agedWith = async (minutes: number, taskId?: number) => {
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111', ...(taskId ? { task_id: taskId } : {}) });
    const { db } = await import('../src/db.ts');
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    db().prepare("UPDATE settings SET value = ? WHERE key = 'runner_handoff'")
      .run(JSON.stringify({ runner: 'runner-test', from_pid: 4242, from_hash: 'aaaa1111', at, ...(taskId ? { task_id: taskId } : {}) }));
  };

  test('新执行器接班：任务结掉，页面写清是谁接的班', async () => {
    const t = await deployedTask();
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111', task_id: t.id });
    await beat('runner-test', { executors: ['pool'], pid: 5252, code_hash: 'bbbb2222' });
    const now = t.read();
    assert.equal(now.status, 'done', '没人收尾就一直挂在「运行中」，队列再也不建新单');
    assert.match(now.step, /已接班/);
    assert.match(now.step, /5252/, '要能看出是哪个进程接的');
    assert.ok(now.completed_at, '结账要落完成时间');
  });

  test('没人接班：按失败结账，并说明代码其实已经上线；没配渠道也照样结', async () => {
    const t = await deployedTask();
    await agedWith(6, t.id);
    const { checkHandoffMissed } = await import('../src/services/runner.ts');
    assert.equal(await checkHandoffMissed(), 0, '没配渠道，没什么可推的');
    const now = t.read();
    assert.equal(now.status, 'failed', '不结账的话「一次只允许一个在途」会把整条链堵死');
    assert.match(now.step, /没有执行器接班/);
    assert.match(String(now.fail_reason), /已经上线/, '要写清代码已经在跑了，别让人以为要重做');
    assert.match(String(now.fail_reason), /启动/);
  });

  test('再巡检一次不会把已经结过的又改一遍', async () => {
    const t = await deployedTask();
    await agedWith(6, t.id);
    const { checkHandoffMissed } = await import('../src/services/runner.ts');
    await checkHandoffMissed();
    const first = t.read().step;
    await checkHandoffMissed();
    assert.equal(t.read().step, first);
    assert.equal(t.read().status, 'failed');
  });

  test('老记录（没有任务 id）：谁的账都不结', async () => {
    const t = await deployedTask();
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111' });
    await beat('runner-test', { executors: ['pool'], pid: 5252, code_hash: 'bbbb2222' });
    assert.equal(t.read().status, 'running', '不知道是哪条任务，就不要乱动');
  });

  test('任务已经结过了：不改它的结局', async () => {
    const t = await deployedTask();
    const { updateTask } = await import('../src/services/tasks.ts');
    updateTask(t.id, { status: 'failed', step: '部署失败：容器没起来' }, 'system');
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111', task_id: t.id });
    await beat('runner-test', { executors: ['pool'], pid: 5252, code_hash: 'bbbb2222' });
    assert.equal(t.read().status, 'failed');
    assert.match(t.read().step, /容器没起来/);
  });

  // 交接记录会挂到人来处理为止；这中间人点「重新开始」，任务又跑起来了。
  test('任务又跑起来了（不是在等交接）：不许拿旧记录把它标成完成', async () => {
    const t = await deployedTask('重新开始：正在跑编码工具（第 2 次）');
    await expect({ runner: 'runner-test', pid: 4242, code_hash: 'aaaa1111', task_id: t.id });
    await beat('runner-test', { executors: ['pool'], pid: 5252, code_hash: 'bbbb2222' });
    assert.equal(t.read().status, 'running', '正在跑的活不能被旧交接记录收掉');
  });
});
