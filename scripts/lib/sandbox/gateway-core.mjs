// 046 §5：模型网关的判断部分（纯函数）。
//
// agent 容器里只有一把假 key，请求发到网关；网关换上真 key，转到**固定的**上游基址。
// 这里决定「这一条转不转、转成什么样」：
//   · 方法只放 GET / POST；路径必须落在这个后端的前缀里，不许 ..、编码过的斜杠和点、反斜杠、//、@；
//   · 拼出来的地址的 origin 必须等于配置的上游 origin（防把上游换掉）；
//   · 请求头只透传白名单里的，agent 带来的 Authorization / x-api-key / Host / Cookie 一律扔掉，换成真 key；
//   · 响应头去掉 set-cookie。
// 真 key 不经命令行、不经环境变量：runner 起好网关后用 writeFile 写进 /run/gw/key（tmpfs），网关每次请求读一次。

const PASS_HEADERS = new Set([
  'content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent',
  'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout',
]);

export const PRESETS = {
  // 前缀是相对上游基址的路径。
  anthropic: { prefixes: ['/v1/messages', '/v1/models', '/v1/complete'], auth: 'x-api-key' },
  openai: { prefixes: ['/v1/chat/completions', '/v1/completions', '/v1/models', '/v1/responses', '/chat/completions', '/models'], auth: 'bearer' },
};

/**
 * @param {{upstream:string, preset?:string, prefixes?:string[], auth?:'bearer'|'x-api-key'}} raw
 */
export function gatewayConfig(raw) {
  let u;
  try { u = new URL(String(raw.upstream)); } catch { throw new Error('网关上游地址不对'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('网关上游只能是 http / https');
  if (u.username || u.password || u.search || u.hash) throw new Error('网关上游地址里不能带用户名、查询或片段');
  const p = raw.preset ? PRESETS[raw.preset] : null;
  if (raw.preset && !p) throw new Error(`不认识的网关预设「${raw.preset}」`);
  const prefixes = raw.prefixes ?? p?.prefixes;
  const auth = raw.auth ?? p?.auth;
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some((x) => !/^\/[a-z0-9/_.-]+$/i.test(x) || x.includes('..'))) throw new Error('网关路径前缀不对');
  if (auth !== 'bearer' && auth !== 'x-api-key') throw new Error('网关鉴权方式只能是 bearer 或 x-api-key');
  return { origin: u.origin, basePath: u.pathname.replace(/\/+$/, ''), prefixes, auth };
}

/**
 * @returns {{ok:true, url:string, headers:Record<string,string>} | {ok:false, status:number, why:string}}
 */
export function planUpstream({ method, url, headers }, cfg, key) {
  const m = String(method ?? '').toUpperCase();
  if (m !== 'GET' && m !== 'POST') return { ok: false, status: 405, why: '只放 GET / POST' };
  const raw = String(url ?? '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('@') || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, status: 400, why: '路径不对' };
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? '' : raw.slice(q);
  if (/%(2e|2f|5c|00)/i.test(path)) return { ok: false, status: 400, why: '路径里有编码过的点、斜杠' };
  if (path.split('/').some((s) => s === '.' || s === '..')) return { ok: false, status: 400, why: '路径里有 . 或 ..' };
  if (!cfg.prefixes.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) return { ok: false, status: 403, why: '这个路径不转发' };
  if (!key) return { ok: false, status: 503, why: '网关还没拿到密钥' };
  const target = new URL(`${cfg.origin}${cfg.basePath}${path}${query}`);
  if (target.origin !== cfg.origin) return { ok: false, status: 400, why: '拼出来的地址换了上游' };
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lk = k.toLowerCase();
    if (PASS_HEADERS.has(lk) && typeof v === 'string' && !/[\r\n\0]/.test(v)) out[lk] = v;
  }
  if (cfg.auth === 'bearer') out.authorization = `Bearer ${key}`;
  else out['x-api-key'] = key;
  return { ok: true, url: target.href, headers: out };
}

/** 回给 agent 的响应头：去掉 set-cookie 和逐跳头。 */
export function cleanResponseHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const lk = k.toLowerCase();
    if (lk === 'set-cookie' || lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'proxy-authenticate') continue;
    out[lk] = v;
  }
  return out;
}
