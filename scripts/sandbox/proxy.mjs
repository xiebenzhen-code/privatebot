// 046 §4：沙箱的白名单出网代理。跑在代理容器里（同时接内网和出网桥），零依赖。
//
// 只做 CONNECT（HTTPS 隧道）。明文 HTTP 一律 405——少一种协议少一类绕法（Host 头和目标不一致、重定向……）。
// 每条连接一行 JSON 日志到 stdout：时间、主机、放行 / 拒绝、原因。只记主机名，不记路径和内容。
//
// 环境变量：WB_PROXY_ALLOW（逗号分隔的白名单）、WB_PROXY_PORT（默认 3128）、WB_PROXY_BLOCK（额外拦的 IPv4 CIDR）、
// WB_PROXY_FAKEIP=1（宿主开了 Clash 一类代理的 fake-ip 时，对白名单里的名字放行 198.18.0.0/15）。
// 拒绝时在 403 里带 x-wb-deny 头（URL 编码的原因），只说为什么拦，不带别的。
import http from 'node:http';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { FAKE_IP_RANGE, decide, parseAllowlist } from '../lib/sandbox/egress.mjs';

const defaultLookup = (host) => Promise.race([
  dnsLookup(host, { all: true, verbatim: true }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
]);

/**
 * @param {{allow:any[], lookup?:Function, extra?:string[], log?:(o:object)=>void, connect?:Function, maxConns?:number, idleMs?:number}} opts
 */
export function createProxy(opts) {
  const allow = opts.allow;
  const lookup = opts.lookup ?? defaultLookup;
  const extra = opts.extra ?? [];
  const allowRanges = opts.allowRanges ?? [];
  const v4Only = opts.v4Only === true;
  const log = opts.log ?? ((o) => process.stdout.write(`${JSON.stringify(o)}\n`));
  const connect = opts.connect ?? ((port, address) => net.connect({ port, host: address }));
  const maxConns = opts.maxConns ?? 64;
  const idleMs = opts.idleMs ?? 120_000;
  let open = 0;

  const server = http.createServer((req, res) => {
    log({ t: new Date().toISOString(), ok: false, why: '只收 CONNECT', method: String(req.method).slice(0, 10) });
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end('only CONNECT\n');
  });

  server.on('connect', async (req, client, head) => {
    const deny = (code, why, host) => {
      log({ t: new Date().toISOString(), host, ok: false, why });
      try { client.end(`HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Error'}\r\nx-wb-deny: ${encodeURIComponent(String(why ?? '')).slice(0, 300)}\r\nconnection: close\r\n\r\n`); } catch { /* 已断 */ }
    };
    client.on('error', () => {});
    if (open >= maxConns) return deny(503, '连接数到上限');
    const d = await decide(String(req.url ?? ''), allow, lookup, extra, { allow: allowRanges, v4Only });
    if (!d.ok) return deny(403, d.why, d.host);
    open++;
    let closed = false;
    const done = () => { if (!closed) { closed = true; open--; } };
    const up = connect(d.port, d.address);
    up.on('error', () => { done(); deny(502, '连不上上游', d.host); });
    up.setTimeout?.(idleMs, () => up.destroy());
    client.setTimeout?.(idleMs, () => client.destroy());
    up.on('connect', () => {
      log({ t: new Date().toISOString(), host: d.host, ok: true });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('close', () => { done(); client.destroy(); });
    client.on('close', () => { done(); up.destroy(); });
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const allow = parseAllowlist(process.env.WB_PROXY_ALLOW ?? '');
  const extra = String(process.env.WB_PROXY_BLOCK ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const port = Number(process.env.WB_PROXY_PORT ?? 3128);
  const fakeIp = process.env.WB_PROXY_FAKEIP === '1';
  createProxy({ allow, extra, allowRanges: fakeIp ? [FAKE_IP_RANGE] : [], v4Only: fakeIp }).listen(port, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ready: true, port, allow: allow.length, fakeIp })}\n`);
  });
}
