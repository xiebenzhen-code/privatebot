// 046 §5：模型网关。跑在网关容器里（接内网 + 出网桥），agent 用假 key 打它，它换上真 key 转给固定上游。
//
// 环境变量（都不是机密）：WB_GW_UPSTREAM、WB_GW_PRESET（anthropic / openai）、WB_GW_AUTH（bearer / x-api-key，可选）、WB_GW_PORT（默认 8080）。
// 真 key：文件 /run/gw/key（runner 起好容器后经 stdin 写进 tmpfs），每次请求读一次，读不到回 503。
// 日志：每条一行 JSON（时间、路径、状态），不记请求体和响应体。
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanResponseHeaders, gatewayConfig, planUpstream } from '../lib/sandbox/gateway-core.mjs';

const MAX_BODY = 8 * 1024 * 1024;

export function createGateway({ cfg, readKey, log, request }) {
  const say = log ?? ((o) => process.stdout.write(`${JSON.stringify(o)}\n`));
  const send = request ?? ((url, opts) => (url.startsWith('https:') ? https : http).request(url, opts));
  return http.createServer((req, res) => {
    const fail = (status, why) => {
      say({ t: new Date().toISOString(), path: String(req.url).slice(0, 80), status, why });
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'wb_gateway', message: why } }));
    };
    let key = '';
    try { key = String(readKey() ?? '').trim(); } catch { key = ''; }
    const plan = planUpstream({ method: req.method, url: req.url, headers: req.headers }, cfg, key);
    if (!plan.ok) { req.resume(); return fail(plan.status, plan.why); }
    let size = 0;
    const up = send(plan.url, { method: req.method, headers: plan.headers, timeout: 600_000 });
    up.on('response', (r) => {
      say({ t: new Date().toISOString(), path: new URL(plan.url).pathname, status: r.statusCode });
      res.writeHead(r.statusCode ?? 502, cleanResponseHeaders(r.headers));
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => fail(502, '上游连不上'));
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { up.destroy(); req.destroy(); fail(413, '请求体太大'); return; }
      up.write(c);
    });
    req.on('end', () => up.end());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = gatewayConfig({ upstream: process.env.WB_GW_UPSTREAM, preset: process.env.WB_GW_PRESET, ...(process.env.WB_GW_AUTH ? { auth: process.env.WB_GW_AUTH } : {}) });
  const port = Number(process.env.WB_GW_PORT ?? 8080);
  createGateway({ cfg, readKey: () => readFileSync('/run/gw/key', 'utf8') }).listen(port, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ready: true, port, upstream: cfg.origin })}\n`);
  });
}
