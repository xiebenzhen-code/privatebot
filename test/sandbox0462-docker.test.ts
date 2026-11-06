// 046.2 · 真容器里的探针。有 Docker、镜像也建好了才跑；否则整组 skip 并说明原因（不算红）。
//
//   npm run sandbox:build && node --test test/sandbox0462-docker.test.ts
//
// 这组测试回答 046 逃逸清单 A1 / A6 / B8–B11 在**你这台电脑**上的答案，Windows（Docker Desktop）上必须跑一遍。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
// @ts-ignore 纯 JS 模块
import { DockerProvider } from '../scripts/lib/sandbox/provider.mjs';

const IMAGE = process.env.WB_SANDBOX_IMAGE || 'wb-sandbox:latest';
const docker = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8', timeout: 20_000 });
const why = (() => {
  if (docker('version', '--format', '{{.Server.Version}}').status !== 0) return '没有 Docker';
  if (docker('image', 'inspect', IMAGE).status !== 0) return `镜像 ${IMAGE} 还没建（npm run sandbox:build）`;
  return '';
})();

// 容器里跑的探针：每一项输出 true / false，最后一行一个 JSON。
const PROBE = String.raw`
const fs = require('fs'), net = require('net'), dns = require('dns');
const r = {};
const st = fs.readFileSync('/proc/self/status', 'utf8');
r.capEff = (/CapEff:\s*([0-9a-f]+)/.exec(st) || [])[1];
r.uid = process.getuid();
const canWrite = (p) => { try { fs.writeFileSync(p, 'x'); return true; } catch { return false; } };
r.writeRoot = canWrite('/x'); r.writeEtc = canWrite('/etc/x'); r.writeWork = canWrite('/work/x'); r.writeTmp = canWrite('/tmp/x'); r.writeProcSys = canWrite('/proc/sys/kernel/hostname');
for (const p of ['/var/run/docker.sock', '/run/docker.sock', '/mnt/host', '/mnt/c', '/host_mnt', '/mnt/wsl']) r['exists:' + p] = fs.existsSync(p);
const tcp = (host, port) => new Promise((ok) => { const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); ok(false); }, 3000); s.on('connect', () => { clearTimeout(t); s.destroy(); ok(true); }); s.on('error', () => { clearTimeout(t); ok(false); }); });
const resolveVia = (server) => new Promise((ok) => { const R = new dns.Resolver({ timeout: 3000, tries: 1 }); if (server) R.setServers([server]); R.resolve4('example.com', (e, a) => ok(!e && a && a.length > 0)); });
const connectVia = (target) => new Promise((ok) => { const s = net.connect({ host: 'wb-proxy', port: 3128 }); let b = ''; const t = setTimeout(() => { s.destroy(); ok('timeout'); }, 8000); s.on('data', (d) => { b += d; if (b.includes('\r\n\r\n')) { clearTimeout(t); s.destroy(); const deny = (/x-wb-deny: ([^\r\n]*)/i.exec(b) || [])[1]; ok(b.split('\r\n')[0] + (deny ? ' · ' + decodeURIComponent(deny) : '')); } }); s.on('error', (e) => { clearTimeout(t); ok('error ' + e.code); }); s.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'); });
(async () => {
  const P = Number(process.env.WB_PROBE_PORT);
  r.tcpHostDockerInternal = await tcp('host.docker.internal', P);
  r.tcpGatewayDockerInternal = await tcp('gateway.docker.internal', P);
  r.tcp172_17_0_1 = await tcp('172.17.0.1', P);
  r.tcp192_168_65_254 = await tcp('192.168.65.254', P);
  r.tcp192_168_65_2 = await tcp('192.168.65.2', P);
  r.tcpPublic443 = await tcp('1.1.1.1', 443);
  r.tcpPublic53 = await tcp('8.8.8.8', 53);
  r.dnsDefault = await resolveVia(null);
  r.dnsEmbedded = await resolveVia('127.0.0.11');
  r.dnsPublic = await resolveVia('8.8.8.8');
  r.proxyAllowed = await connectVia('registry.npmjs.org:443');
  r.proxyDenied = await connectVia('example.com:443');
  r.proxyInternal = await connectVia('host.docker.internal:' + P);
  console.log(JSON.stringify(r));
})();
`;

describe('046.2 · 真容器探针', { skip: why || false }, () => {
  let box: any;
  let hostSrv: net.Server;
  let port = 0;
  const taskId = 900000 + Math.floor(Math.random() * 9999);
  let result: any = {};

  before(async () => {
    // 宿主上开一个监听 0.0.0.0 的端口，扮演工作台 / 反代池：容器必须连不上它。
    hostSrv = net.createServer((c) => c.end('host'));
    await new Promise<void>((r) => hostSrv.listen(0, '0.0.0.0', () => r()));
    port = (hostSrv.address() as net.AddressInfo).port;
    // 宿主开了 Clash 一类代理的 fake-ip 时，跑之前设 WB_SANDBOX_FAKEIP=1（和执行器配置 sandboxFakeIp 一个意思）。
    box = await new DockerProvider({ image: IMAGE }).create({ taskId, egress: { allow: ['registry.npmjs.org'], ...(process.env.WB_SANDBOX_FAKEIP === '1' ? { fakeIp: true } : {}) } });
    const lines: string[] = [];
    // 端口经 sh 传给探针（WB_PROBE_PORT 不在 agent 的环境变量白名单里，也不该加）。
    await box.exec(['sh', '-c', `WB_PROBE_PORT=${port} exec node -e "$0"`, PROBE], { onLine: (l: string) => lines.push(l), timeoutMs: 90_000 });
    const last = lines.reverse().find((l) => l.startsWith('{'));
    result = last ? JSON.parse(last) : {};
    console.log('探针结果：', JSON.stringify(result, null, 1));
  });

  after(async () => {
    await box?.destroy();
    hostSrv?.close();
  });

  test('B11 · 没有能力、不是 root', () => {
    assert.equal(result.capEff, '0000000000000000');
    assert.equal(result.uid, 10001);
  });

  test('B8 · 只能写 /work 和 /tmp', () => {
    assert.equal(result.writeRoot, false);
    assert.equal(result.writeEtc, false);
    assert.equal(result.writeProcSys, false);
    assert.equal(result.writeWork, true);
    assert.equal(result.writeTmp, true);
  });

  test('B9 / B10 · 摸不到宿主文件系统和 docker.sock', () => {
    for (const k of Object.keys(result).filter((k) => k.startsWith('exists:'))) assert.equal(result[k], false, k);
  });

  test('A1 · 连不上宿主上的服务（host.docker.internal、网关、Docker Desktop 网段）', () => {
    for (const k of ['tcpHostDockerInternal', 'tcpGatewayDockerInternal', 'tcp172_17_0_1', 'tcp192_168_65_254', 'tcp192_168_65_2']) assert.equal(result[k], false, k);
  });

  test('A6 · 不经代理出不去：直连公网 TCP、DNS（默认、内置 127.0.0.11、公网）都不通', () => {
    assert.equal(result.tcpPublic443, false);
    assert.equal(result.tcpPublic53, false);
    assert.equal(result.dnsDefault, false);
    assert.equal(result.dnsPublic, false);
    assert.equal(result.dnsEmbedded, false, 'Docker 内置 DNS 如果替内网解析外网名字，就是一条 DNS 外传通道（逃逸清单 A6）');
  });

  test('A2 · 经代理：白名单外 403，内部名字 403；白名单里的能通（机器能上网时）', () => {
    assert.match(String(result.proxyDenied), /403/);
    assert.match(String(result.proxyInternal), /403/);
    if (!/200/.test(String(result.proxyAllowed))) console.log(`白名单里的 registry.npmjs.org 没打通：${result.proxyAllowed}（宿主不能上网时正常）`);
  });

  test('销毁后什么都不剩', () => {
    // after 里才销毁；这里先销毁再查，after 再调一次是幂等的。
    return box.destroy().then(() => {
      const left = docker('ps', '-a', '--filter', `label=wb.task=${taskId}`, '--format', '{{.Names}}').stdout.trim();
      assert.equal(left, '');
      assert.equal(docker('volume', 'ls', '-q', '--filter', `label=wb.task=${taskId}`).stdout.trim(), '');
      assert.equal(docker('network', 'ls', '-q', '--filter', `label=wb.task=${taskId}`).stdout.trim(), '');
    });
  });
});

if (why) test(`046.2 真容器探针跳过：${why}`, { skip: why }, () => {});
