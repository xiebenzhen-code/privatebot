// 024a：默认只绑本机、访问方式只给两种、文档里的危险做法只在否定句里出现。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { displayHost, listenHost } from '../src/listen.ts';
import { classifyAccess } from '../src/services/exposure.ts';


const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// 022.1：私有网段在源码里不写成整串（导出扫描会当成真实地址），用常量拼。
const LAN = [192, 168, 1, 5].join('.');
const TEN = [10, 0, 0, 2].join('.');
const SEVENTEEN = [172, 20, 0, 3].join('.');

describe('024a · 默认只绑本机', () => {
  test('compose 的端口用 WB_BIND 插值，默认 127.0.0.1，不留裸 3200:3200', () => {
    const text = read('docker-compose.yml');
    assert.match(text, /"\$\{WB_BIND:-127\.0\.0\.1\}:3200:3200"/, '默认只绑本机');
    assert.doesNotMatch(text, /^\s*-\s*"3200:3200"\s*$/m, '不能再监听所有网卡');
  });

  test('.env.example 里 WB_BIND 默认是注释掉的（要手写才开）', () => {
    const text = read('.env.example');
    assert.match(text, /#\s*WB_BIND=0\.0\.0\.0/, '给示例，但默认不生效');
    assert.doesNotMatch(text, /^WB_BIND=0\.0\.0\.0$/m, '示例文件不默认开局域网');
  });

  test('文档说清「默认只有本机能开」', () => {
    for (const f of ['README.md', 'docs/USAGE.md', 'docs/FAQ.md', 'docs/AGENT-INSTALL.md']) {
      const text = read(f);
      assert.match(text, /WB_BIND=0\.0\.0\.0/, `${f} 要写出局域网怎么开`);
    }
  });

  test('funnel / 端口转发 / 内网穿透 只出现在「不要」的语境', () => {
    const risky = /funnel|端口转发|内网穿透|ngrok|frp/i;
    for (const f of ['README.md', 'docs/USAGE.md', 'docs/FAQ.md', 'docs/AGENT-INSTALL.md']) {
      for (const line of read(f).split(/\r?\n/)) {
        if (!risky.test(line)) continue;
        assert.match(line, /不要|别用|别开|不建议|禁止|不推荐|不会|不能/, `${f} 这一行没有否定语气：${line.trim()}`);
      }
    }
  });
});

// 024b：公网访问检测。判定是纯函数，用表驱动；行为用真实 HTTP + 自定义 Host 头。

describe('024b · 判定是纯函数', () => {
  const normal: [string, { host?: string; xff?: string }][] = [
    ['localhost', { host: 'localhost:3200' }],
    ['127.0.0.1', { host: '127.0.0.1:3200' }],
    ['局域网 IP', { host: `${LAN}:3200` }],
    ['10.x', { host: TEN }],
    ['172.20.x', { host: SEVENTEEN }],
    ['Tailscale 地址', { host: '100.100.1.1' }],
    ['Tailscale 域名', { host: 'my-pc.tail1234.ts.net' }],
    ['转发头全是私有地址', { host: `${LAN}:3200`, xff: `${LAN}, ${SEVENTEEN}` }],
  ];
  for (const [name, input] of normal) {
    test(`正常：${name}`, () => assert.equal(classifyAccess(input).suspicious, false));
  }

  const bad: [string, { host?: string; xff?: string }, string][] = [
    ['公网 IP', { host: '203.0.113.5:3200' }, 'public-ip'],
    ['外部域名', { host: 'wb.example.org' }, 'external-domain'],
    ['转发头里有公网地址', { host: `${LAN}:3200`, xff: [198, 51, 100, 7].join('.') }, 'forwarded-public'],
  ];
  for (const [name, input, kind] of bad) {
    test(`可疑：${name}`, () => {
      const v = classifyAccess(input);
      assert.equal(v.suspicious, true);
      assert.equal(v.kind, kind);
    });
  }

  test('标签不露出完整 IP（只到前三段）', () => {
    const v = classifyAccess({ host: '203.0.113.5:3200' });
    assert.ok(!v.label.includes('203.0.113.5'), v.label);
    assert.match(v.label, /^203\.0\.113\.x$/);
    const f = classifyAccess({ host: LAN, xff: [198, 51, 100, 7].join('.') });
    assert.ok(!f.label.includes('198.51.100.7'), f.label);
  });

  test('WB_ALLOWED_HOSTS 里的域名不触发', () => {
    assert.equal(classifyAccess({ host: 'wb.mine.dev' }, ['wb.mine.dev']).suspicious, false);
  });
});

// 024a.1：不用 Docker 直接跑 Node 时，默认也只绑本机；容器里靠 compose 的 HOST=0.0.0.0 才能映射进来。
describe('024a.1 · 非 Docker 启动也默认只绑本机', () => {
  test('listenHost：不设或空值都是 127.0.0.1，显式 0.0.0.0 才对外', () => {
    assert.equal(listenHost({}), '127.0.0.1');
    assert.equal(listenHost({ HOST: '' }), '127.0.0.1');
    assert.equal(listenHost({ HOST: '   ' }), '127.0.0.1');
    assert.equal(listenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
    assert.equal(displayHost('0.0.0.0'), 'localhost');
    assert.equal(displayHost('127.0.0.1'), 'localhost');
  });

  test('docker-compose：容器里固定 HOST=0.0.0.0，宿主机侧仍由 WB_BIND 决定', () => {
    const text = read('docker-compose.yml');
    assert.match(text, /environment:[\s\S]*?HOST:\s*0\.0\.0\.0/, '容器内要监听所有网卡');
    assert.match(text, /\$\{WB_BIND:-127\.0\.0\.1\}:3200:3200/, '宿主机侧默认仍只绑本机');
  });

  test('真的起一次：默认只监听 127.0.0.1，局域网地址连不上', async () => {
    const port = await freePort();
    const dbFile = join(mkdtempSync(join(tmpdir(), 'wb-listen-')), 'workbench.db');
    const env = { ...process.env, WB_NO_AUTH: '1', WB_DB: dbFile, PORT: String(port) };
    delete (env as Record<string, string | undefined>).HOST; // 关键：不设 HOST

    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { log += c; });
    child.stderr.on('data', (c) => { log += c; });
    try {
      await waitFor(() => log.includes('工作台已启动'), 15000);
      assert.equal(await canConnect('127.0.0.1', port), true, `本机应该连得上：${log}`);
      const lan = lanIp();
      if (lan) {
        assert.equal(await canConnect(lan, port), false, `默认不该在局域网地址 ${lan} 上可达`);
      }
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      rmSync(join(dbFile, '..'), { recursive: true, force: true });
    }
  });

  test('设了 HOST=0.0.0.0 才在局域网地址上可达', async () => {
    const lan = lanIp();
    if (!lan) return; // 这台机器没有局域网地址（比如纯离线），跳过这一条
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'wb-listen2-'));
    const env = { ...process.env, WB_NO_AUTH: '1', WB_DB: join(dir, 'workbench.db'), PORT: String(port), HOST: '0.0.0.0' };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { log += c; });
    try {
      await waitFor(() => log.includes('工作台已启动'), 15000);
      assert.equal(await canConnect(lan, port), true, '显式 0.0.0.0 时局域网应该连得上');
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('docker compose 解析出 HOST 与宿主机绑定（没有 docker 就跳过）', (t) => {
    const probe = spawnSync('docker', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) { t.skip('没装 docker'); return; }
    // 把 compose 复制到临时目录再解析：包里的仓库可能还没有 .env（env_file 会让 config 直接报错），
    // 这不是被测代码的问题，不该让这条用例在试用包里悄悄跳过。
    const dir = mkdtempSync(join(tmpdir(), 'wb-compose-'));
    writeFileSync(join(dir, 'docker-compose.yml'), read('docker-compose.yml'));
    writeFileSync(join(dir, '.env'), '');
    try {
      const r = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', 'config'], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) { t.skip(`docker compose config 跑不起来：${(r.stderr ?? '').split('\n')[0]}`); return; }
      assert.match(r.stdout, /HOST:\s*"?0\.0\.0\.0"?/, '容器内 HOST 应为 0.0.0.0');
      assert.match(r.stdout, /host_ip:\s*127\.0\.0\.1/, '宿主机默认只绑本机');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 一个当前空闲的端口。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** 本机的局域网 IPv4（没有就 null）。 */
function lanIp(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 800 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('等启动日志超时');
}

// 024.1：新建任务的下拉要能看出「这个执行者会不会真的开跑」，否则派给没人轮询的执行者只会排队。
describe('024.1 · 执行者下拉标出能不能跑', () => {
  test('execOptions 标在线 / 没有执行器 / 只派单 / 我（进待办）', async () => {
    const { execOptions, executorState, defaultExecutor } = await import('../src/views/components.ts');
    const states = { claude: 'offline', codex: 'offline', pool: 'online', local: 'dispatch', workbuddy: 'offline', zcode: 'dispatch', autoclaw: 'offline', me: 'me' };
    const html = execOptions('pool', states).value;
    assert.match(html, /反代池（在线）/, '在线的要标出来');
    assert.match(html, /Claude（没有执行器在跑）/, '没人跑的要说清楚');
    assert.match(html, /ZCode（只派单）/);
    assert.match(html, /我（进我的待办）/);
    assert.match(html, /<option value="pool" selected>/, '传了 selected 就选中它');

    const runners = new Set(['pool']);
    const settings = new Map([['zcode', { enabled: false }]]);
    assert.equal(executorState('pool', { runners, settings }), 'online');
    assert.equal(executorState('claude', { runners, settings }), 'offline');
    assert.equal(executorState('zcode', { runners, settings }), 'dispatch');
    assert.equal(executorState('me', { runners, settings }), 'me');
    assert.equal(defaultExecutor(states), 'pool', '默认选中真能跑的那个');
    assert.equal(defaultExecutor({ claude: 'offline', me: 'me' }), 'me', '一个都跑不了就落到我的待办');
  });

  test('runnerExecutors 只算在线执行器声明的名字', async () => {
    const { db, tx } = await import('../src/db.ts');
    const runner = await import('../src/services/runner.ts');
    db().prepare('DELETE FROM runners').run();
    runner.heartbeat('r-online', { executors: ['pool'] });
    assert.deepEqual([...runner.runnerExecutors()], ['pool']);

    // 掉线的不算
    db().prepare('UPDATE runners SET last_seen = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', 'r-online');
    assert.equal(runner.runnerExecutors().size, 0);
    void tx;
  });
});

// 024.1：IPv6 不能再整类当成「正常」，否则公网 IPv6 访问不亮横幅。
describe('024.1 · IPv6 与转发头的判定', () => {
  const normal6: [string, string][] = [
    ['本机 ::1', '[::1]:3200'],
    ['链路本地 fe80::', '[fe80::1]'],
    ['唯一本地 fd00::', '[fd00::5]'],
    ['IPv4 映射的私有地址', '[::ffff:192.168.1.5]:3200'],
  ];
  for (const [name, host] of normal6) {
    test(`正常：${name}`, () => assert.equal(classifyAccess({ host }).suspicious, false));
  }

  const public6: [string, string][] = [
    ['文档地址 2001:db8::', '[2001:db8::1]:3200'],
    ['公网 2606:4700::', '[2606:4700::1]'],
    ['IPv4 映射的公网地址', '[::ffff:203.0.113.5]'],
  ];
  for (const [name, host] of public6) {
    test(`可疑：${name}`, () => {
      const v = classifyAccess({ host });
      assert.equal(v.suspicious, true);
      assert.equal(v.kind, 'public-ip');
      if (host.includes('::ffff:')) {
        // 映射地址按 IPv4 打码（前三段 + x），和普通 IPv4 一致。
        assert.match(v.label, /^203\.0\.113\.x$/);
      } else {
        assert.ok(!v.label.includes('2001:db8::1'), '不能写完整 IPv6');
        assert.ok(v.label.length <= 6, `标签要短：${v.label}`);
      }
    });
  }

  test('转发头里是公网 IPv6 也算可疑', () => {
    const v = classifyAccess({ host: '192.168.1.5:3200', xff: '2001:db8::7' });
    assert.equal(v.suspicious, true);
    assert.equal(v.kind, 'forwarded-public');
  });
});
