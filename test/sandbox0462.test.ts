// 046.2 · 沙箱出网：白名单代理、模型网关、代理 / 网关容器的参数、供应商把它们串起来（假 docker）。
// 真容器里的探针在 sandbox0462-docker.test.ts，有 Docker 和镜像才跑。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
// @ts-ignore 纯 JS 模块
import { decide, hostAllowed, ipBlocked, parseAllowlist, parseConnectTarget, pickAddress } from '../scripts/lib/sandbox/egress.mjs';
// @ts-ignore
import { cleanResponseHeaders, gatewayConfig, planUpstream } from '../scripts/lib/sandbox/gateway-core.mjs';
// @ts-ignore
import { buildRunArgs, buildSidecarArgs, taskOfName } from '../scripts/lib/sandbox/docker-args.mjs';
// @ts-ignore
import { DockerProvider } from '../scripts/lib/sandbox/provider.mjs';
// @ts-ignore
import { createProxy } from '../scripts/sandbox/proxy.mjs';
// @ts-ignore
import { createGateway } from '../scripts/sandbox/gateway.mjs';

const allow = parseAllowlist(['api.deepseek.com', '.npmjs.org', 'pypi.org', 'mirror.example.com:8443']);

describe('046.2 · 逃逸清单 A2：目标写法', () => {
  test('IP 字面量的各种写法、带用户信息、大写、末尾点、内部名字一律拒绝', () => {
    for (const t of ['127.0.0.1:443', '2130706433:443', '0x7f000001:443', '0x7f.1:443', '0177.0.0.1:443', '127.1:443', '[::1]:443', '::1:443', '[::ffff:127.0.0.1]:443',
      'allowed.com@127.0.0.1:443', 'user:pw@api.deepseek.com:443', 'API.DEEPSEEK.COM:443', 'api.deepseek.com.:443', 'localhost:443', 'x.localhost:443', 'metadata.google.internal:443', 'printer.local:443',
      'api.deepseek.com', 'api.deepseek.com:0', 'api.deepseek.com:99999', 'api.deepseek.com:443/x', 'api deepseek.com:443', 'api.deepseek.com%2f:443', 'single:443', '-bad.com:443', `${'a'.repeat(64)}.com:443`]) {
      assert.ok(parseConnectTarget(t).error, `应该拒绝 ${t}`);
    }
    assert.deepEqual(parseConnectTarget('api.deepseek.com:443'), { host: 'api.deepseek.com', port: 443 });
  });

  test('白名单按完整的点分段匹配：后缀混淆不算；端口要对上', () => {
    assert.ok(hostAllowed('api.deepseek.com', 443, allow));
    assert.ok(!hostAllowed('x.api.deepseek.com', 443, allow), '不带点的项只放它自己');
    assert.ok(hostAllowed('registry.npmjs.org', 443, allow));
    assert.ok(hostAllowed('a.b.npmjs.org', 443, allow));
    assert.ok(hostAllowed('npmjs.org', 443, allow), '带点的项也放它自己');
    for (const h of ['evilnpmjs.org', 'npmjs.org.evil.com', 'deepseek.com', 'api.deepseek.com.evil.com', 'xpypi.org']) assert.ok(!hostAllowed(h, 443, allow), h);
    assert.ok(!hostAllowed('api.deepseek.com', 80, allow), '只放 443');
    assert.ok(!hostAllowed('pypi.org', 22, allow));
    assert.ok(hostAllowed('mirror.example.com', 8443, allow));
    assert.ok(!hostAllowed('mirror.example.com', 443, allow), '写了端口就只放那个端口');
    for (const bad of ['127.0.0.1', `10.0.0.0`, 'a b.com', 'x.com:99999x', '*.', '']) {
      if (bad === '') { assert.deepEqual(parseAllowlist(bad), []); continue; }
      assert.throws(() => parseAllowlist([bad]), /白名单项/, bad);
    }
  });
});

describe('046.2 · 逃逸清单 A1 / A3：地址黑名单', () => {
  test('回环、私网、链路本地、元数据、CGNAT、Docker Desktop 宿主网段都拦', () => {
    for (const ip of ['127.0.0.1', '127.255.255.254', `10.1.2.3`, `172.16.0.1`, `172.17.0.1`, `172.31.255.255`, `192.168.1.1`, `192.168.65.254`, '169.254.169.254', '100.64.0.1', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1']) assert.ok(ipBlocked(ip), ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.128.0.1', '203.0.114.1']) assert.equal(ipBlocked(ip), '', ip);
  });

  test('IPv6：回环、私网、链路本地、多播、各种内嵌 IPv4 都按里面的 v4 判', () => {
    for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2001::1', '::ffff:127.0.0.1', '::ffff:7f00:1', `::ffff:10.0.0.1`, '::127.0.0.1', '64:ff9b::7f00:1', `64:ff9b::192.168.0.1`, '2002:7f00:1::1', '2002:c0a8:4101::', '100::1']) assert.ok(ipBlocked(ip), ip);
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2400:3200::1']) assert.equal(ipBlocked(ip), '', ip);
  });

  test('额外的 CIDR（当前网桥网关）也拦', () => {
    assert.equal(ipBlocked('203.0.114.9'), '');
    assert.ok(ipBlocked('203.0.114.9', ['203.0.114.0/24']));
  });

  test('A3 · 解析结果里有一条落在内网就整条拒绝；放行时拿的是检查过的那个 IP', () => {
    assert.ok(pickAddress([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]).error);
    assert.ok(pickAddress([{ address: '2606:4700::1', family: 6 }, { address: '::1', family: 6 }]).error);
    assert.ok(pickAddress([]).error);
    assert.deepEqual(pickAddress([{ address: '2606:4700::1', family: 6 }, { address: '1.1.1.1', family: 4 }]), { address: '1.1.1.1', family: 4 });
  });

  test('decide：每一步都要过；解析超时 / 失败当拒绝', async () => {
    const dns = (map: Record<string, string[]>) => async (h: string) => { if (!map[h]) throw new Error('nx'); return map[h].map((a) => ({ address: a, family: net.isIPv6(a) ? 6 : 4 })); };
    const lk = dns({ 'api.deepseek.com': ['1.2.3.4'], 'registry.npmjs.org': [`10.0.0.5`], 'pypi.org': ['1.2.3.5', '127.0.0.1'] });
    assert.deepEqual(await decide('api.deepseek.com:443', allow, lk), { ok: true, host: 'api.deepseek.com', port: 443, address: '1.2.3.4', family: 4 });
    assert.match((await decide('registry.npmjs.org:443', allow, lk)).why, /内网/, '白名单里的名字解析到内网（DNS 重绑定）也拒绝');
    assert.match((await decide('pypi.org:443', allow, lk)).why, /内网/);
    assert.match((await decide('evil.com:443', allow, lk)).why, /白名单/);
    assert.match((await decide('a.npmjs.org:443', allow, lk)).why, /解析失败/);
    assert.match((await decide('127.0.0.1:443', allow, lk)).why, /IP/);
  });
});

describe('046.2 · 模型网关：只转固定上游、固定路径，换上真 key', () => {
  const cfg = gatewayConfig({ upstream: 'https://api.deepseek.com/anthropic', preset: 'anthropic' });
  const req = (over: any = {}) => ({ method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-fake', authorization: 'Bearer fake', host: 'evil.com', cookie: 'a=b', 'anthropic-version': '2023-06-01', 'x-forwarded-for': '1.2.3.4' }, ...over });

  test('正常请求：拼到上游基址下，agent 带来的鉴权 / Host / Cookie 全扔掉，换真 key', () => {
    const p = planUpstream(req(), cfg, 'sk-real');
    assert.equal(p.ok, true);
    assert.equal(p.url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.deepEqual(p.headers, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-real' });
    const o = planUpstream(req({ url: '/v1/chat/completions?stream=true' }), gatewayConfig({ upstream: 'http://host.docker.internal:1455', preset: 'openai' }), 'k');
    assert.equal(o.url, 'http://host.docker.internal:1455/v1/chat/completions?stream=true');
    assert.equal(o.headers.authorization, 'Bearer k');
    assert.ok(!('x-api-key' in o.headers));
  });

  test('路径：不在前缀里、..、编码过的点和斜杠、//、@、反斜杠、控制字符一律拒绝', () => {
    for (const url of ['/v1/files', '/admin', '/', '/v1/messages/../../admin', '/v1/messages/%2e%2e/x', '/v1/messages%2f..%2fadmin', '//evil.com/v1/messages', '/v1/messages@evil.com', '/v1\\messages', 'http://evil.com/v1/messages', 'v1/messages', '/v1/messages\r\nHost: x', '/v1/messagesX']) {
      const p = planUpstream(req({ url }), cfg, 'k');
      assert.equal(p.ok, false, url);
    }
    assert.equal(planUpstream(req({ url: '/v1/messages/count_tokens' }), cfg, 'k').ok, true);
  });

  test('方法只放 GET / POST；没拿到 key 回 503', () => {
    for (const method of ['PUT', 'DELETE', 'CONNECT', 'TRACE', 'OPTIONS', 'PATCH']) assert.equal(planUpstream(req({ method }), cfg, 'k').status, 405, method);
    assert.equal(planUpstream(req(), cfg, '').status, 503);
  });

  test('配置：上游带用户名 / 查询、非 http(s)、不认识的预设都拒绝', () => {
    for (const upstream of ['ftp://x.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f', 'not a url', 'file:///etc/passwd']) assert.throws(() => gatewayConfig({ upstream, preset: 'openai' }), /网关/, upstream);
    assert.throws(() => gatewayConfig({ upstream: 'https://x.com', preset: 'nope' }), /预设/);
    assert.throws(() => gatewayConfig({ upstream: 'https://x.com', prefixes: ['/../x'], auth: 'bearer' }), /前缀/);
  });

  test('响应头去掉 set-cookie 和逐跳头', () => {
    assert.deepEqual(cleanResponseHeaders({ 'Set-Cookie': ['a'], 'content-type': 'x', connection: 'keep-alive', 'transfer-encoding': 'chunked' }), { 'content-type': 'x' });
  });
});

describe('046.2 · 代理 / 网关容器的参数', () => {
  const sc = (kind: string, over: any = {}) => buildSidecarArgs(kind, { taskId: 7, runId: 1, image: 'wb-sandbox:latest', network: 'wb-sbx-net-T7-abc123', nameSuffix: 'abc123', ...over });

  test('和 agent 一样加固；只接任务内网并带别名；入口固定', () => {
    for (const kind of ['proxy', 'gateway']) {
      const a = sc(kind);
      for (const x of ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--rm', '--init']) assert.ok(a.includes(x), `${kind} 缺 ${x}`);
      assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
      assert.equal(a[a.indexOf('--network') + 1], 'wb-sbx-net-T7-abc123');
      assert.equal(a[a.indexOf('--network-alias') + 1], kind === 'proxy' ? 'wb-proxy' : 'wb-gateway');
      assert.ok(!a.includes('--mount') && !a.includes('-v'));
      assert.equal(a.at(-1), kind === 'proxy' ? '/opt/wb/sandbox/proxy.mjs' : '/opt/wb/sandbox/gateway.mjs');
      assert.equal(taskOfName(a[a.indexOf('--name') + 1]), 7, '孤儿扫描认得出它属于哪个任务');
    }
    assert.ok(sc('proxy').includes('host.docker.internal:127.0.0.1'), '代理盖掉宿主别名');
    assert.ok(!sc('gateway').includes('host.docker.internal:127.0.0.1'), '网关不盖：反代池上游就在宿主上');
  });

  test('环境变量只收各自那几个名字——真 key 不许从这里进', () => {
    assert.throws(() => sc('gateway', { env: { WB_GW_KEY: 'sk-real' } }), /白名单/);
    assert.throws(() => sc('gateway', { env: { ANTHROPIC_API_KEY: 'x' } }), /白名单/);
    assert.throws(() => sc('proxy', { env: { WB_GW_UPSTREAM: 'x' } }), /白名单/);
    assert.throws(() => sc('proxy', { env: { WB_PROXY_ALLOW: 'a\nb' } }), /不合规/);
    assert.throws(() => sc('dns'), /不认识/);
    assert.throws(() => sc('proxy', { privileged: true }), /不认识的参数/);
  });

  test('agent 的 hosts：只许写 wb-proxy / wb-gateway，地址必须是私网 IPv4', () => {
    const base = { taskId: 7, image: 'x:1', network: 'wb-sbx-n', volume: 'wb-sbx-v' };
    assert.ok(buildRunArgs({ ...base, hosts: { 'wb-proxy': `172.18.0.2`, 'wb-gateway': `10.1.0.3` } }).includes(`wb-gateway:10.1.0.3`));
    for (const hosts of [{ 'api.deepseek.com': `172.18.0.2` }, { 'wb-proxy': '8.8.8.8' }, { 'wb-proxy': '127.0.0.1' }, { 'wb-proxy': `172.18.0.999` }, { 'wb-proxy': 'x' }, { 'host.docker.internal': `172.18.0.2` }]) {
      assert.throws(() => buildRunArgs({ ...base, hosts }), /hosts|地址/, JSON.stringify(hosts));
    }
  });
});

const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function rawRequest(port: number, text: string, after?: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let got = '';
    let sent = false;
    s.on('data', (d) => {
      got += d.toString();
      if (after && !sent && got.includes('\r\n\r\n') && got.startsWith('HTTP/1.1 200')) { sent = true; s.write(after); }
      if (!after || got.includes(`echo:${after}`)) s.end();
    });
    s.on('end', () => resolve(got));
    s.on('error', () => resolve(got));
    s.write(text);
  });
}

describe('046.2 · 代理跑起来（本机，假 DNS、假上游）', () => {
  test('白名单里的名字：200 打通隧道，连的是检查过的 IP；其余 403 且根本不去连；明文 HTTP 405', async () => {
    const echo = net.createServer((c) => c.on('data', (d) => c.write(`echo:${d}`)));
    const echoPort = await listen(echo);
    const dialed: string[] = [];
    const logs: any[] = [];
    const map: Record<string, string[]> = { 'api.deepseek.com': ['1.2.3.4'], 'registry.npmjs.org': ['127.0.0.1'] };
    const proxy = createProxy({
      allow,
      lookup: async (h: string) => (map[h] ?? []).map((address) => ({ address, family: 4 })),
      connect: (port: number, address: string) => { dialed.push(`${address}:${port}`); return net.connect(echoPort, '127.0.0.1'); },
      log: (o: any) => logs.push(o),
    });
    const port = await listen(proxy);
    try {
      const ok = await rawRequest(port, 'CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n', 'ping');
      assert.match(ok, /^HTTP\/1\.1 200/);
      assert.match(ok, /echo:ping/);
      assert.deepEqual(dialed, ['1.2.3.4:443']);
      for (const t of ['evil.com:443', 'registry.npmjs.org:443', '127.0.0.1:443', 'api.deepseek.com:22', 'localhost:443']) {
        const r = await rawRequest(port, `CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`);
        assert.match(r, /^HTTP\/1\.1 403/, t);
      }
      assert.deepEqual(dialed, ['1.2.3.4:443'], '被拒的一个都没去连');
      const plain = await rawRequest(port, 'GET http://api.deepseek.com/v1/x HTTP/1.1\r\nHost: api.deepseek.com\r\n\r\n');
      assert.match(plain, /^HTTP\/1\.1 405/);
      assert.ok(logs.some((l) => l.ok && l.host === 'api.deepseek.com'));
      assert.ok(!JSON.stringify(logs).includes('/v1/x'), '日志里不记路径');
    } finally { proxy.close(); echo.close(); }
  });
});

describe('046.2 · 网关跑起来（本机假上游）', () => {
  test('换上真 key、扔掉 agent 的鉴权和 Cookie；路径不对不去打上游；没 key 回 503', async () => {
    const seen: any[] = [];
    const upstream = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: b }); res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1' }); res.end('{"ok":true}'); });
    });
    const upPort = await listen(upstream);
    let key: string | null = 'test-token-not-real-0000';
    const gw = createGateway({ cfg: gatewayConfig({ upstream: `http://127.0.0.1:${upPort}`, preset: 'openai' }), readKey: () => { if (key === null) throw new Error('no'); return key; }, log: () => {} });
    const gwPort = await listen(gw);
    const call = (path: string, headers: any = {}) => fetch(`http://127.0.0.1:${gwPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fake', cookie: 'x=1', ...headers }, body: '{"m":1}' });
    try {
      const r = await call('/v1/chat/completions');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('set-cookie'), null);
      assert.equal(await r.text(), '{"ok":true}');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.authorization, 'Bearer test-token-not-real-0000');
      assert.equal(seen[0].headers.cookie, undefined);
      assert.equal(seen[0].body, '{"m":1}');
      assert.equal((await call('/admin')).status, 403);
      assert.equal((await call('/v1/chat/completions/../../admin')).status, 403);
      assert.equal(seen.length, 1, '被拒的请求没打到上游');
      key = null;
      assert.equal((await call('/v1/chat/completions')).status, 503);
    } finally { gw.close(); upstream.close(); }
  });
});

describe('046.2 · 供应商把代理、网关串起来（假 docker）', () => {
  const fake = (fail?: string) => {
    const calls: { args: string[]; input?: any }[] = [];
    const fn = (args: string[], opts: any = {}) => {
      calls.push({ args, input: opts.input });
      if (fail && args[0] === 'run' && args.some((a) => a.endsWith(fail))) return { code: 1, stdout: '', stderr: 'boom' };
      if (args[0] === 'inspect') return { code: 0, stdout: args.at(-1)!.endsWith('-gw') ? `172.18.0.3\n` : `172.18.0.2\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { fn, calls };
  };
  const mk = (d: any) => new DockerProvider({ image: 'wb-sandbox:latest', docker: d.fn, rand: () => 'abc123' });
  const opts = { taskId: 7, egress: { allow: ['api.deepseek.com', '.npmjs.org'] }, gateway: { upstream: 'https://api.deepseek.com/anthropic', preset: 'anthropic', key: 'test-token-not-real-SECRET-0000' }, env: { ANTHROPIC_BASE_URL: 'http://wb-gateway:8080', ANTHROPIC_API_KEY: 'sk-fake' } };

  test('顺序：内网（--internal）→ 出网桥 → 卷 → 代理接出网桥 → 网关接出网桥并经 stdin 拿 key → agent 只接内网', async () => {
    const d = fake();
    const box = await mk(d).create(opts);
    const v = d.calls.map((c) => c.args.slice(0, 2).join(' '));
    assert.deepEqual(v, ['network create', 'network create', 'volume create', 'run -d', 'network connect', 'inspect -f', 'run -d', 'network connect', 'exec -i', 'inspect -f', 'run -d']);
    assert.ok(d.calls[0].args.includes('--internal') && d.calls[0].args.at(-1) === 'wb-sbx-net-T7-abc123');
    assert.ok(!d.calls[1].args.includes('--internal') && d.calls[1].args.at(-1) === 'wb-sbx-egr-T7-abc123');
    assert.deepEqual(d.calls[4].args, ['network', 'connect', 'wb-sbx-egr-T7-abc123', 'wb-sbx-T7-abc123-proxy']);
    assert.deepEqual(d.calls[7].args, ['network', 'connect', 'wb-sbx-egr-T7-abc123', 'wb-sbx-T7-abc123-gw']);
    assert.equal(d.calls[8].input, 'test-token-not-real-SECRET-0000');
    const agent = d.calls[10].args;
    assert.equal(agent[agent.indexOf('--network') + 1], 'wb-sbx-net-T7-abc123', 'agent 只接内网');
    assert.ok(!agent.includes('wb-sbx-egr-T7-abc123'));
    assert.ok(agent.includes(`wb-proxy:172.18.0.2`) && agent.includes(`wb-gateway:172.18.0.3`));
    assert.ok(agent.includes('HTTPS_PROXY=http://wb-proxy:3128') && agent.includes('NO_PROXY=wb-gateway'));
    assert.ok(!d.calls.some((c) => c.args.join(' ').includes('SECRET')), '真 key 不出现在任何命令行里');
    const proxyEnv = d.calls[3].args.find((a) => a.startsWith('WB_PROXY_ALLOW='));
    assert.equal(proxyEnv, 'WB_PROXY_ALLOW=api.deepseek.com:443,.npmjs.org:443');

    const n = d.calls.length;
    await box.destroy();
    assert.deepEqual(d.calls.slice(n).map((c) => c.args.join(' ')), [
      'rm -f wb-sbx-T7-abc123', 'rm -f wb-sbx-T7-abc123-proxy', 'rm -f wb-sbx-T7-abc123-gw',
      'volume rm -f wb-sbx-vol-T7-abc123', 'network rm wb-sbx-net-T7-abc123', 'network rm wb-sbx-egr-T7-abc123',
    ]);
  });

  test('网关起不来：已经起的代理、卷、两张网全拆', async () => {
    const d = fake('-gw');
    await assert.rejects(() => mk(d).create(opts), /起网关失败/);
    const tail = d.calls.slice(-4).map((c) => c.args.join(' '));
    assert.deepEqual(tail, ['rm -f wb-sbx-T7-abc123-proxy', 'volume rm -f wb-sbx-vol-T7-abc123', 'network rm wb-sbx-egr-T7-abc123', 'network rm wb-sbx-net-T7-abc123']);
  });

  test('不给 egress：完全没有出口——不建出网桥、不起代理、agent 没有代理变量', async () => {
    const d = fake();
    await mk(d).create({ taskId: 7 });
    assert.deepEqual(d.calls.map((c) => c.args.slice(0, 2).join(' ')), ['network create', 'volume create', 'run -d']);
    assert.ok(!d.calls[2].args.some((a) => a.includes('PROXY')));
  });

  test('坏参数在动 Docker 之前就拒绝：网关 key 带换行、上游不对、白名单写了 IP', async () => {
    for (const o of [
      { ...opts, gateway: { ...opts.gateway, key: 'a\nb' } },
      { ...opts, gateway: { ...opts.gateway, key: '' } },
      { ...opts, gateway: { ...opts.gateway, upstream: 'file:///etc/passwd' } },
      { ...opts, egress: { allow: ['127.0.0.1'] } },
    ]) {
      const d = fake();
      await assert.rejects(() => mk(d).create(o));
      assert.equal(d.calls.length, 0);
    }
  });
});

describe('046 真机复核 · fake-ip 与拦截原因', () => {
  test('198.18.0.0/15 默认拦（并提示像 fake-ip）；显式放行后只放这一段，额外拦的段仍优先', async () => {
    // @ts-ignore
    const { FAKE_IP_RANGE } = await import('../scripts/lib/sandbox/egress.mjs');
    assert.match(ipBlocked('198.18.3.4'), /fake-ip/);
    assert.equal(ipBlocked('198.18.3.4', [], { allow: [FAKE_IP_RANGE] }), '');
    assert.equal(ipBlocked('198.19.255.1', [], { allow: [FAKE_IP_RANGE] }), '');
    for (const ip of ['127.0.0.1', '169.254.169.254', '192.168.65.254', '100.64.0.1', '198.51.100.1']) assert.ok(ipBlocked(ip, [], { allow: [FAKE_IP_RANGE] }), ip);
    assert.equal(ipBlocked('198.20.0.1'), '', '198.20 已经是公网，不在 fake-ip 段里');
    assert.ok(ipBlocked('198.18.3.4', ['198.18.3.0/24'], { allow: [FAKE_IP_RANGE] }), '额外拦的段优先于放行');
    assert.ok(ipBlocked('::ffff:198.18.3.4', [], { allow: [FAKE_IP_RANGE] }), 'IPv6 内嵌写法不吃放行');
    const lk = async () => [{ address: '198.18.0.9', family: 4 }];
    assert.match((await decide('registry.npmjs.org:443', allow, lk)).why, /fake-ip/);
    assert.equal((await decide('registry.npmjs.org:443', allow, lk, [], { allow: [FAKE_IP_RANGE] })).ok, true);
    assert.match((await decide('evil.com:443', allow, lk, [], { allow: [FAKE_IP_RANGE] })).why, /白名单/, '放行 fake-ip 不等于放行白名单外的名字');
  });

  test('代理的 403 带 x-wb-deny 原因；fake-ip 开关只在显式配置时进代理容器', async () => {
    const proxy = createProxy({ allow, lookup: async () => [{ address: '198.18.0.9', family: 4 }], connect: () => { throw new Error('不该去连'); }, log: () => {} });
    const port = await listen(proxy);
    try {
      const r = await rawRequest(port, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
      assert.match(r, /^HTTP\/1\.1 403/);
      const why = decodeURIComponent((/x-wb-deny: ([^\r\n]*)/i.exec(r) ?? [])[1] ?? '');
      assert.match(why, /fake-ip/);
    } finally { proxy.close(); }
    // @ts-ignore
    const { sandboxPlan } = await import('../scripts/lib/sandbox/run.mjs');
    const b = { tool: 'claude', env: { ANTHROPIC_BASE_URL: 'https://x.example.com', ANTHROPIC_API_KEY: 'k' } };
    assert.equal(sandboxPlan(b, {}).egress.fakeIp, undefined);
    assert.equal(sandboxPlan(b, { sandboxFakeIp: 'yes' }).egress.fakeIp, undefined, '只认 true');
    assert.equal(sandboxPlan(b, { sandboxFakeIp: true }).egress.fakeIp, true);
    const calls: string[][] = [];
    const docker = (args: string[]) => { calls.push(args); return { code: 0, stdout: args[0] === 'inspect' ? '172.18.0.2\n' : '', stderr: '' }; };
    await new DockerProvider({ image: 'wb-sandbox:latest', docker, rand: () => 'abc123' }).create({ taskId: 7, egress: { allow: ['registry.npmjs.org'], fakeIp: true } });
    assert.ok(calls.find((c) => c.includes('wb-sbx-T7-abc123-proxy') && c[0] === 'run')!.includes('WB_PROXY_FAKEIP=1'));
    calls.length = 0;
    await new DockerProvider({ image: 'wb-sandbox:latest', docker, rand: () => 'abc124' }).create({ taskId: 7, egress: { allow: ['registry.npmjs.org'] } });
    assert.ok(!calls.some((c) => c.includes('WB_PROXY_FAKEIP=1')));
  });
});

describe('046 真机复测 · Clash 同时给 IPv4 和 IPv6 两个 fake-ip', () => {
  test('开了 fake-ip：只看 IPv4、只连 IPv4，IPv6 那条假地址不再连累整条；没开时照旧整条拒绝', async () => {
    // @ts-ignore
    const { FAKE_IP_RANGE } = await import('../scripts/lib/sandbox/egress.mjs');
    const lk = async () => [{ address: 'fdfe:dcba:9876::9', family: 6 }, { address: '198.18.0.30', family: 4 }];
    assert.equal((await decide('registry.npmjs.org:443', allow, lk)).ok, false);
    assert.match((await decide('registry.npmjs.org:443', allow, lk, [], { allow: [FAKE_IP_RANGE] })).why, /fc00::\/7/, '只放行 IPv4 段还不够（Codex 真机复现的就是这个）');
    const d = await decide('registry.npmjs.org:443', allow, lk, [], { allow: [FAKE_IP_RANGE], v4Only: true });
    assert.deepEqual([d.ok, d.address, d.family], [true, '198.18.0.30', 4]);
    const onlyV6 = async () => [{ address: 'fdfe:dcba:9876::9', family: 6 }];
    assert.match((await decide('registry.npmjs.org:443', allow, onlyV6, [], { allow: [FAKE_IP_RANGE], v4Only: true })).why, /解析不到/);
    const mixed = async () => [{ address: '198.18.0.30', family: 4 }, { address: '10.0.0.5', family: 4 }];
    assert.equal((await decide('registry.npmjs.org:443', allow, mixed, [], { allow: [FAKE_IP_RANGE], v4Only: true })).ok, false, 'IPv4 里混了内网地址照样整条拒绝');
  });
});
