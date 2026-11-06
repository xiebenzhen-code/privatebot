// 024b: 判断「这次访问看起来是从公网来的吗」。
//
// 为什么不能只看来源 IP：工作台通常跑在 Docker 里，Windows 的 Docker Desktop 上，
// 外面进来的连接在容器里看到的都是 Docker 网关（172.x），真实来源看不出来。
// 所以综合三样：Host 头（浏览器里敲的是什么）、转发头、以及不用 Docker 时的真实来源地址。
//
// 这是**防误用**，不是防攻击：Host 头可以伪造，但伪造它并不比不伪造更有利
// ——他本来就要过密码那一关。目的是让「不小心把端口开到公网」的人及时看见。

import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db.ts';
import { logEvent, HttpError } from './core.ts';
import { getSetting, setSetting } from './dispatch.ts';
import { notify } from './notify.ts';
import { nowIso } from '../domain.ts';

export type ExposureKind = 'public-ip' | 'external-domain' | 'forwarded-public';

export type Verdict = {
  suspicious: boolean;
  kind?: ExposureKind;
  /** 给人看的标签：IP 只留前半段，域名原样。审计和横幅都用它，不记完整 IP。 */
  label: string;
};

const PRIVATE_V4 = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
];

/** 100.64.0.0/10：Tailscale 在这段里分地址。 */
const isCgnat = (ip: string): boolean => {
  const m = ip.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};

const isPrivateV4 = (ip: string): boolean => PRIVATE_V4.some((re) => re.test(ip)) || isCgnat(ip);

const normalizeHost = (host: string): string => {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return (end > 0 ? h.slice(1, end) : h.slice(1)).replace(/\.$/, ''); // [::1]:3200 → ::1
  }
  if ((h.match(/:/g) ?? []).length === 1) h = h.split(':')[0]; // host:port
  return h.replace(/\.$/, '');
};

/** IPv6 字面量：::1 本机、fe80::/10 链路本地、fc00::/7 唯一本地（家里常见）算正常，其余按公网处理。 */
function classifyV6(ip: string): Verdict | null {
  if (!ip.includes(':')) return null;
  if (ip === '::1' || ip === '::') return { suspicious: false, label: ip };
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return { suspicious: false, label: ip };        // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return { suspicious: false, label: ip };        // fc00::/7
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);                     // ::ffff:a.b.c.d
  if (mapped) return classifyV4(mapped[1]);
  // 只露前 4 个字符，和 IPv4 的「前三段 + x」一样，不把完整地址写进审计。
  return { suspicious: true, kind: 'public-ip', label: `${ip.slice(0, 4)}…` };
}

function classifyV4(ip: string): Verdict {
  if (ip === '127.0.0.1') return { suspicious: false, label: ip };
  if (isPrivateV4(ip)) return { suspicious: false, label: ip };
  return { suspicious: true, kind: 'public-ip', label: maskIp(ip) };
}

/** IP 只留前两段：203.0.113.5 → 203.0.113.x。审计里绝不能变成别人的 IP 清单。 */
const maskIp = (ip: string): string => {
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : ip;
};

/**
 * 判断一次请求。`host` 是 Host 头，`xff` 是 X-Forwarded-For，`remote` 是不用 Docker 时的真实来源。
 * `allowed` 是用户自己加的域名（WB_ALLOWED_HOSTS）。
 */
export function classifyAccess(
  { host, xff, remote }: { host?: string; xff?: string; remote?: string },
  allowed: string[] = [],
): Verdict {
  const admit = new Set(allowed.map((a) => normalizeHost(a)).filter(Boolean));
  const h = normalizeHost(host ?? '');

  // 1) 转发头里有公网地址 → 可疑（Tailscale serve 转的是本机，不会带公网地址）
  const forwarded = String(xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const ip of forwarded) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
      if (!isPrivateV4(ip) && ip !== '127.0.0.1') return { suspicious: true, kind: 'forwarded-public', label: maskIp(ip) };
    } else if (ip.includes(':')) {
      const v = classifyV6(ip);
      if (v?.suspicious) return { suspicious: true, kind: 'forwarded-public', label: v.label };
    }
  }

  if (!h) return { suspicious: false, label: '' };
  if (admit.has(h)) return { suspicious: false, label: h };
  // 024.1：IPv6 以前整类被当成「正常」，公网 IPv6 进来不亮横幅、refuse 也不拒。
  const v6 = classifyV6(h);
  if (v6) return v6;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return { suspicious: false, label: h };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(h)) return { suspicious: false, label: h }; // Tailscale 自己的域名
  if (/\.local$/.test(h)) return { suspicious: false, label: h };                              // mDNS

  // 2) Host 是 IP：私有地址正常，公网地址可疑
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return classifyV4(h);

  // 3) Host 是普通域名：没登记就算可疑（局域网里没人用域名访问本机）
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return { suspicious: true, kind: 'external-domain', label: h };

  // 4) 兜底：不用 Docker 直跑时，看真实来源
  const r = normalizeHost(remote ?? '');
  const v6r = r ? classifyV6(r) : null;
  if (v6r) return v6r;
  if (r && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(r)) return classifyV4(r);
  return { suspicious: false, label: h };
}

/** 'warn'（默认）| 'refuse' | 'allow' */
export const accessMode = (env: Record<string, string | undefined> = process.env): 'warn' | 'refuse' | 'allow' => {
  const v = String(env.WB_PUBLIC_ACCESS ?? 'warn').trim().toLowerCase();
  return v === 'refuse' || v === 'allow' ? v : 'warn';
};

export const allowedHosts = (env: Record<string, string | undefined> = process.env): string[] =>
  String(env.WB_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** 网页上可以改的模式（存数据库），没设过就听环境变量的。 */
export function currentMode(): 'warn' | 'refuse' | 'allow' {
  const saved = getSetting('public_access_mode', '').trim();
  return saved === 'refuse' || saved === 'allow' || saved === 'warn' ? saved : accessMode();
}

export function saveMode(mode: string, actor = 'human'): 'warn' | 'refuse' | 'allow' {
  if (mode !== 'warn' && mode !== 'refuse' && mode !== 'allow') throw new HttpError(400, '模式只能是 warn / refuse / allow');
  setSetting('public_access_mode', mode);
  logEvent({ actor, kind: 'net.exposure_mode', text: `公网访问处理方式改成「${mode === 'warn' ? '提醒' : mode === 'refuse' ? '拒绝' : '不处理'}」` });
  return mode;
}

// ---------- 记录与提醒 ----------


const NAME = 'net.exposure';

export type ExposureState = {
  last_at: string; label: string; kind: string;
  /** 当天的日期（YYYY-MM-DD）；跨天就重新计数。 */
  audited_day: string;
  /** 当天已经提醒过的来源（上限 20），用来去重。 */
  seen?: string[];
  /** 当天已发出的提醒条数（上限 3）。 */
  count?: number;
};

export function exposureState(): ExposureState | null {
  const row = db().prepare('SELECT detail FROM connector_state WHERE name = ?').get(NAME) as { detail: string } | undefined;
  if (!row?.detail) return null;
  try { return JSON.parse(row.detail) as ExposureState; } catch { return null; }
}

function saveState(s: ExposureState): void {
  const ts = nowIso();
  db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed, detail)
      VALUES (?, ?, ?, '', 0, 0, ?)
      ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, detail = excluded.detail`)
    .run(NAME, ts, ts, JSON.stringify(s));
}

/**
 * 记下这次可疑访问：状态每次都更新（设置页要显示「最近一次」），
 * 审计和推送同一天只做一次，免得变成刷屏器。返回这次是否写了审计。
 */
const MAX_PER_DAY = 3;   // 每天最多 3 条审计与推送
const MAX_SEEN = 20;     // 记住当天见过的来源，最多 20 个

export function recordSuspicious(v: Verdict, now = nowIso()): boolean {
  const day = now.slice(0, 10);
  const prev = exposureState();
  // 024.1：以前只和「上一次」比，a.com/b.com 交替访问就会每条都推。
  // 现在按「当天见过的来源集合」去重，并且每天硬上限 3 条。
  const fresh = prev?.audited_day === day ? prev : null;
  const seen = new Set<string>(fresh?.seen ?? []);
  const count = fresh?.count ?? 0;
  const known = seen.has(v.label);
  if (!known && seen.size < MAX_SEEN) seen.add(v.label);

  const notifyNow = !known && count < MAX_PER_DAY;
  saveState({
    last_at: now,
    label: v.label,
    kind: v.kind ?? '',
    audited_day: day,
    seen: [...seen].slice(0, MAX_SEEN),
    count: notifyNow ? count + 1 : count,
  });
  if (!notifyNow) return false;

  const nth = count + 1;
  logEvent({
    actor: 'system',
    kind: 'net.public_access',
    text: `有人通过公网地址访问了工作台（${v.label}，${v.kind === 'forwarded-public' ? '转发头里有公网地址' : v.kind === 'external-domain' ? '外部域名' : '公网 IP'}）`
      + (nth >= MAX_PER_DAY ? `。今天还有更多，不再逐条提醒` : ''),
  });
  // 只带标题，不带链接和内容——这条提醒本身不该泄露地址。
  void notify({ title: '有人通过公网地址访问了工作台', body: '如果不是你有意设置的，请马上关掉端口转发或隧道，并换掉 WB_PASSWORD。' }).catch(() => 0);
  return true;
}

// 横幅：用 AsyncLocalStorage 传，避免并发请求互相串台。
const noteStore = new AsyncLocalStorage<string>();

export const withExposureNote = <T>(note: string, fn: () => T): T => noteStore.run(note, fn);

export const currentExposureNote = (): string => noteStore.getStore() ?? '';

