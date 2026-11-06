// 046 §4：白名单代理的判断部分（纯函数）。代理本身（scripts/sandbox/proxy.mjs）只是把这些串起来。
//
// 代理同时接着内网和出网桥，它自己**能**连到宿主和局域网——所以「连到哪」必须由它自己守：
//   1. 目标只收主机名，不收 IP 字面量（任何写法）、不收用户信息、不规范化；
//   2. 主机名按完整的点分段匹配白名单；
//   3. 解析出来的**每一个**地址都过黑名单，有一个落在内网就整条拒绝（防「公网 + 内网」两条记录）；
//   4. 拿检查过的那个 IP 去连，不让底层再解析一次（防 DNS 重绑定）。
import net from 'node:net';

// ───────────── 目标 ─────────────

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 每一段都长得像数字（十进制、十六进制、八进制）——`2130706433`、`0x7f.1`、`127.1` 这类 IP 的别名。 */
function looksNumeric(host) {
  return host.split('.').every((l) => /^(0x[0-9a-f]*|[0-9]+)$/i.test(l));
}

/**
 * CONNECT 的目标 `host:port`。只返回 { host, port } 或 { error }。
 * 不做任何「帮你改好」：大写、末尾点、IP、方括号、@ 一律当错。
 */
export function parseConnectTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return { error: '目标格式不对' };
  if (/[@\s/\\%?#\[\]]/.test(raw)) return { error: '目标里有不允许的字符' };
  const m = /^([^:]+):([0-9]{1,5})$/.exec(raw);
  if (!m) return { error: '目标要写成 主机名:端口' };
  const host = m[1];
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return { error: '端口不对' };
  if (host !== host.toLowerCase()) return { error: '主机名要小写' };
  if (net.isIP(host) || looksNumeric(host)) return { error: '不接受 IP 地址，只接受主机名' };
  if (host.length > 253 || host.endsWith('.') || !host.includes('.')) return { error: '主机名不对' };
  if (!host.split('.').every((l) => LABEL.test(l))) return { error: '主机名不对' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return { error: '本机 / 内部名字不放行' };
  return { host, port };
}

/**
 * 白名单项：`api.deepseek.com`（只这一个）、`.deepseek.com`（它和所有子域）、
 * 可带端口 `host:8443`（不写就只放 443）。按完整的点分段比，`evilnpmjs.org` 不匹配 `npmjs.org`。
 */
export function parseAllowlist(input) {
  const items = (Array.isArray(input) ? input : String(input ?? '').split(','))
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return items.map((it) => {
    const m = /^(\*?\.)?([a-z0-9.-]+?)(?::([0-9]{1,5}))?$/.exec(it);
    if (!m || looksNumeric(m[2]) || net.isIP(m[2]) || !m[2].split('.').every((l) => LABEL.test(l))) throw new Error(`白名单项不对：${it.slice(0, 60)}`);
    return { suffix: Boolean(m[1]), host: m[2], port: m[3] ? Number(m[3]) : 443 };
  });
}

export function hostAllowed(host, port, allow) {
  for (const a of allow) {
    if (a.port !== port) continue;
    if (host === a.host) return true;
    if (a.suffix && host.endsWith(`.${a.host}`)) return true;
  }
  return false;
}

// ───────────── 地址黑名单 ─────────────

const V4_BLOCK = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inV4(ip, cidr) {
  const [b, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(b) & mask) >>> 0);
}

/** 展开成 8 个 16 位数；末尾可带点分 IPv4。 */
function v6Words(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dot = s.lastIndexOf(':');
  const v4 = s.slice(dot + 1);
  if (v4.includes('.')) {
    if (!net.isIPv4(v4)) return null;
    const n = v4ToInt(v4);
    s = `${s.slice(0, dot + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [l, r] = s.split('::');
  const L = l ? l.split(':') : [];
  const R = r !== undefined ? (r ? r.split(':') : []) : null;
  const words = R === null ? L : [...L, ...Array(8 - L.length - R.length).fill('0'), ...R];
  if (words.length !== 8) return null;
  return words.map((w) => parseInt(w || '0', 16));
}

const wordsToV4 = (a, b) => `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;

/**
 * Clash / Mihomo 等本机代理的 fake-ip 段：开了 fake-ip，所有域名都解析到这里，真正的连接由宿主上的代理软件代为发出。
 * 它属于保留段（198.18.0.0/15），默认拦；只有执行器配置里 `sandboxFakeIp: true` 时才对**白名单里的名字**放行。
 */
export const FAKE_IP_RANGE = '198.18.0.0/15';

/**
 * 这个地址能不能连。返回原因（拒绝）或 ''（放行）。
 * @param {string} ip
 * @param {string[]} [extra] 额外要拦的 IPv4 CIDR（当前网桥网关、Docker Desktop 宿主网段）——优先于放行
 * @param {{allow?: string[]}} [opts] 额外放行的 IPv4 CIDR（只用于 fake-ip 段）
 */
export function ipBlocked(ip, extra = [], opts = {}) {
  if (net.isIPv4(ip)) {
    for (const c of extra) if (inV4(ip, c)) return `内网 / 保留地址 ${ip}`;
    for (const c of opts.allow ?? []) if (inV4(ip, c)) return '';
    for (const c of V4_BLOCK) if (inV4(ip, c)) return `内网 / 保留地址 ${ip}${inV4(ip, FAKE_IP_RANGE) ? '（像是本机代理的 fake-ip，见 046 单「fake-ip」）' : ''}`;
    if (ip === '255.255.255.255') return '广播地址';
    return '';
  }
  if (!net.isIPv6(ip)) return `不是 IP：${String(ip).slice(0, 40)}`;
  const w = v6Words(ip);
  if (!w) return `IPv6 地址解析不了：${ip}`;
  const zero = (n) => w.slice(0, n).every((x) => x === 0);
  if (zero(8)) return '未指定地址 ::';
  if (zero(7) && w[7] === 1) return '回环 ::1';
  // 内嵌 IPv4 的几种写法：按里面的 v4 判。
  // 内嵌 IPv4 的几种写法：按里面的 v4 判（fake-ip 放行只认纯 IPv4，这里不带 opts）。
  if (zero(5) && w[5] === 0xffff) return ipBlocked(wordsToV4(w[6], w[7]), extra) || '';
  if (zero(6)) return ipBlocked(wordsToV4(w[6], w[7]), extra) || '';                 // ::a.b.c.d（已废弃的兼容写法）
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return ipBlocked(wordsToV4(w[6], w[7]), extra) || '';
  if (w[0] === 0x2002) return ipBlocked(wordsToV4(w[1], w[2]), extra) || '';          // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return 'IPv6 私网 fc00::/7';
  if ((w[0] & 0xffc0) === 0xfe80) return 'IPv6 链路本地 fe80::/10';
  if ((w[0] & 0xff00) === 0xff00) return 'IPv6 多播';
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'IPv6 文档地址';
  if (w[0] === 0x2001 && w[1] === 0) return 'Teredo 隧道地址';
  if (w[0] === 0x0100 && w.slice(1, 4).every((x) => x === 0)) return 'IPv6 丢弃地址';
  return '';
}

/**
 * 解析结果里挑一个能连的。**有一个被拦就整条拒绝**——不赌「这次连到的是公网那条」。
 * @param {{address:string,family:number}[]} addrs
 */
export function pickAddress(addrs, extra = [], opts = {}) {
  if (!Array.isArray(addrs)) return { error: '解析不到地址' };
  // fake-ip 模式只看、只连 IPv4：Clash 一类代理会同时给一个 IPv6 假地址（落在 fc00::/7），
  // 我们反正不连它，不该让它连累整条。IPv4 里只要混了一个内网地址，照样整条拒绝。
  if (opts.v4Only) addrs = addrs.filter((a) => a && a.family === 4 && net.isIPv4(a.address));
  if (!addrs.length) return { error: '解析不到地址' };
  for (const a of addrs) {
    const why = ipBlocked(a.address, extra, opts);
    if (why) return { error: why };
  }
  const v4 = addrs.find((a) => a.family === 4);
  return { address: (v4 ?? addrs[0]).address, family: (v4 ?? addrs[0]).family };
}

/**
 * 一次完整的判断：目标 → 白名单 → 解析 → 黑名单。lookup 可替换，测试里不用真 DNS。
 * @returns {Promise<{ok:true,host:string,port:number,address:string,family:number}|{ok:false,host?:string,why:string}>}
 */
export async function decide(raw, allow, lookup, extra = [], opts = {}) {
  const t = parseConnectTarget(raw);
  if (t.error) return { ok: false, why: t.error };
  if (!hostAllowed(t.host, t.port, allow)) return { ok: false, host: t.host, why: '不在白名单里' };
  let addrs;
  try { addrs = await lookup(t.host); } catch { return { ok: false, host: t.host, why: '解析失败' }; }
  const p = pickAddress(addrs, extra, opts);
  if (p.error) return { ok: false, host: t.host, why: p.error };
  return { ok: true, host: t.host, port: t.port, address: p.address, family: p.family };
}
