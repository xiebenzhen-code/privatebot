// Balance-style quota sources (pay-as-you-go money, manual credits) plus the low-quota reminders
// that span all three account kinds. Adapters are a table so adding a provider is one entry.
import { db } from '../db.ts';
import { nowIso } from '../domain.ts';
import { logEvent } from './core.ts';
import { listAccounts, type Account } from './metrics.ts';
// 014: reminders are shared with the backup check; the rule (one open task per key) lives in tasks.ts.
import { remindOnce as remind } from './tasks.ts';

export type BalanceResult = {
  balance: number | null;
  unit: string;
  detail: Record<string, unknown>;
  limited?: boolean;
  expires_at?: string | null;
};

type Adapter = {
  id: string;
  /** Account name shown in the table. */
  label: string;
  via: string;
  unit: string;
  enabled: () => boolean;
  fetch: () => Promise<BalanceResult>;
};

const money = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const deepseek: Adapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  via: 'DeepSeek API · 经 CLIProxyAPI',
  unit: 'CNY',
  enabled: () => Boolean((process.env.DEEPSEEK_API_KEY ?? '').trim()),
  async fetch() {
    // DEEPSEEK_BASE_URL exists so tests can point at a local fake; production uses the official host.
    const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
    const res = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${(process.env.DEEPSEEK_API_KEY ?? '').trim()}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET /user/balance → ${res.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as {
      is_available?: boolean;
      balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[];
    };
    const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
    // CNY first, USD only when there is no CNY entry.
    const info = infos.find((i) => (i.currency ?? '').toUpperCase() === 'CNY') ?? infos[0];
    if (!info) throw new Error('余额接口没有返回 balance_infos');
    return {
      balance: money(info.total_balance), // already includes granted + topped up
      unit: (info.currency ?? 'CNY').toUpperCase(),
      detail: { granted: money(info.granted_balance), topped_up: money(info.topped_up_balance), is_available: body.is_available !== false },
      limited: body.is_available === false,
      expires_at: null,
    };
  },
};

export const ADAPTERS: Adapter[] = [deepseek];

export const balanceEnabled = (): boolean => ADAPTERS.some((a) => a.enabled());

/** 010: the sources panel can switch a source off; connectors then skip it silently. */
function sourceOff(id: string): boolean {
  const row = db().prepare('SELECT off FROM source_prefs WHERE id = ?').get(id) as { off: number } | undefined;
  return row?.off === 1;
}

// ---------- GLM Coding Plan (ZCode) ----------
// Endpoints and the raw-token Authorization header come from the official plugin
// zai-org/zai-coding-plugins › plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
//   https://open.bigmodel.cn/api/monitor/usage/quota/limit  (cn)
//   https://api.z.ai/api/monitor/usage/quota/limit          (intl)
// The script sends ANTHROPIC_AUTH_TOKEN verbatim, with no "Bearer " prefix.

const ZAI_BASE: Record<string, string> = {
  cn: 'https://open.bigmodel.cn',
  intl: 'https://api.z.ai',
};

export const glmEnabled = (): boolean => Boolean((process.env.ZAI_API_KEY ?? '').trim());

export const glmState = (): ConnectorRow => balanceState('glm');

/** Reset timestamps show up as seconds, milliseconds or ISO depending on the endpoint. */
export function toIso(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /[T:-]/.test(v) && Number.isNaN(Number(v))) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString(); // < 1e12 → seconds
}

const pctOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
};

export type GlmQuota = {
  windowPct: number | null; windowMinutes: number | null; windowResetAt: string | null;
  window2Pct: number | null; window2Minutes: number | null; window2ResetAt: string | null;
  detail: Record<string, unknown>;
};

/** `data.limits[]` carries one TOKENS_LIMIT (5-hour) and one TIME_LIMIT (MCP, monthly). */
export function parseGlmQuota(payload: any): GlmQuota {
  const limits: any[] = Array.isArray(payload?.data?.limits) ? payload.data.limits
    : Array.isArray(payload?.limits) ? payload.limits : [];
  const out: GlmQuota = {
    windowPct: null, windowMinutes: 300, windowResetAt: null,
    window2Pct: null, window2Minutes: null, window2ResetAt: null,
    detail: {},
  };
  const tokens = limits.filter((l) => String(l?.type ?? '').toUpperCase().includes('TOKEN'));
  const mcp = limits.find((l) => String(l?.type ?? '').toUpperCase().includes('TIME'));

  const main = tokens[0];
  if (main) {
    out.windowPct = pctOf(main.percentage);
    out.windowResetAt = toIso(main.resetTime ?? main.resetAt ?? main.nextResetTime ?? main.endTime);
    const mins = Number(main.windowMinutes ?? main.periodMinutes ?? main.durationMinutes);
    if (Number.isFinite(mins) && mins > 0) out.windowMinutes = mins;
  }
  // A second token window (weekly) is mapped when the payload has one.
  const weekly = tokens[1];
  if (weekly) {
    out.window2Pct = pctOf(weekly.percentage);
    out.window2ResetAt = toIso(weekly.resetTime ?? weekly.resetAt ?? weekly.nextResetTime ?? weekly.endTime);
    const mins = Number(weekly.windowMinutes ?? weekly.periodMinutes ?? weekly.durationMinutes);
    out.window2Minutes = Number.isFinite(mins) && mins > 0 ? mins : 10080;
  }
  if (mcp) {
    out.detail.mcp = {
      percentage: pctOf(mcp.percentage),
      current: Number(mcp.currentValue ?? 0),
      total: Number(mcp.usage ?? 0),
    };
  }
  if (tokens.length < 2) out.detail.weekly_signal = 'missing'; // the source only documents one token window
  return out;
}

async function runGlm(): Promise<{ ok: boolean; error?: string }> {
  const key = (process.env.ZAI_API_KEY ?? '').trim();
  if (!key) return { ok: true };
  const started = nowIso();
  const region = (process.env.ZAI_REGION ?? 'cn').trim() === 'intl' ? 'intl' : 'cn';
  const base = process.env.ZAI_BASE_URL?.trim() || ZAI_BASE[region];
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: key, Accept: 'application/json' }, // raw token, as the plugin does
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`quota/limit → ${res.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    // A 200 with success:false means "this account has no coding plan" — not "0% used".
    if (body && body.success === false) throw new Error(`quota/limit → ${String(body.msg ?? body.code ?? '失败').slice(0, 120)}`);
    const q = parseGlmQuota(body);
    const name = 'GLM Coding Plan';
    const observed = nowIso();
    const prev = db().prepare('SELECT name FROM accounts WHERE name = ?').get(name);
    const detail = JSON.stringify(q.detail);
    if (prev) {
      db().prepare(`UPDATE accounts SET executor = 'zcode', kind = 'window', source = 'api', provider = 'zai',
          via = 'GLM Coding Plan · 官方接口', window_pct = ?, window_minutes = ?, window_reset_at = ?,
          window2_pct = ?, window2_minutes = ?, window2_reset_at = ?, balance_detail = ?, quota_observed_at = ?, updated_at = ?
        WHERE name = ?`).run(q.windowPct, q.windowMinutes, q.windowResetAt, q.window2Pct, q.window2Minutes,
        q.window2ResetAt, detail, observed, observed, name);
    } else {
      db().prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, source,
          provider, kind, window_minutes, window_reset_at, window2_pct, window2_minutes, window2_reset_at,
          balance_detail, quota_observed_at)
        VALUES (?, 'zcode', 'GLM Coding Plan · 官方接口', ?, '', 'ok', ?, 'api', 'zai', 'window', ?, ?, ?, ?, ?, ?, ?)`).run(
        name, q.windowPct, observed, q.windowMinutes, q.windowResetAt, q.window2Pct, q.window2Minutes, q.window2ResetAt, detail, observed,
      );
      logEvent({ actor: 'system', kind: 'account.imported', text: `从 GLM Coding Plan 接口导入账号「${name}」` });
    }
    const cur = balanceState('glm');
    saveState('glm', { last_run: started, last_ok: nowIso(), last_error: '', imported: cur.imported + 1 });
    return { ok: true };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    const cur = balanceState('glm');
    saveState('glm', { last_run: started, last_error: message, failed: cur.failed + 1 });
    return { ok: false, error: message };
  }
}

export type ConnectorRow = {
  name: string; last_run: string | null; last_ok: string | null; last_error: string;
  imported: number; failed: number;
};

export function balanceState(id = 'deepseek'): ConnectorRow {
  const row = db().prepare('SELECT * FROM connector_state WHERE name = ?').get(id) as ConnectorRow | undefined;
  return row ?? { name: id, last_run: null, last_ok: null, last_error: '', imported: 0, failed: 0 };
}

function saveState(id: string, patch: Partial<ConnectorRow>): void {
  const cur = balanceState(id);
  db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_ok = excluded.last_ok,
      last_error = excluded.last_error, imported = excluded.imported, failed = excluded.failed`)
    .run(id, patch.last_run ?? cur.last_run, patch.last_ok ?? cur.last_ok,
      patch.last_error ?? cur.last_error, patch.imported ?? cur.imported, patch.failed ?? cur.failed);
}

function saveBalance(a: Adapter, r: BalanceResult): void {
  const name = a.label;
  const status = r.limited ? 'limited' : 'ok';
  const prev = db().prepare('SELECT name, status, kind FROM accounts WHERE name = ?').get(name) as { status: string; kind: string } | undefined;
  const observed = nowIso();
  if (prev) {
    db().prepare(`UPDATE accounts SET executor = 'pool', kind = 'balance', source = 'api', via = ?, provider = ?,
        balance = ?, balance_unit = ?, balance_detail = ?, expires_at = ?, balance_observed_at = ?, status = ?, updated_at = ?
      WHERE name = ?`).run(
      a.via, a.id, r.balance, r.unit, JSON.stringify(r.detail), r.expires_at ?? null, observed, status, observed, name,
    );
    if (prev.status !== status) {
      logEvent({ actor: 'system', kind: 'account.status', text: `账号「${name}」状态：${prev.status} → ${status}（余额接口）` });
    }
    return;
  }
  db().prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at,
      source, provider, kind, balance, balance_unit, balance_detail, expires_at, balance_observed_at)
    VALUES (?, 'pool', ?, NULL, '', ?, ?, 'api', ?, 'balance', ?, ?, ?, ?, ?)`).run(
    name, a.via, status, observed, a.id, r.balance, r.unit, JSON.stringify(r.detail), r.expires_at ?? null, observed,
  );
  logEvent({ actor: 'system', kind: 'account.imported', text: `从 ${a.label} 余额接口导入账号「${name}」` });
}

export type BalanceRun = { ok: boolean; results: { id: string; balance: number | null; error?: string }[] };

export async function runBalances(): Promise<BalanceRun> {
  const results: BalanceRun['results'] = [];
  let ok = true;
  for (const a of ADAPTERS) {
    if (!a.enabled()) continue;
    if (sourceOff(a.id)) continue; // 010: switched off on the sources panel
    const started = nowIso();
    try {
      const r = await a.fetch();
      saveBalance(a, r);
      const cur = balanceState(a.id);
      saveState(a.id, { last_run: started, last_ok: nowIso(), last_error: '', imported: cur.imported + 1 });
      results.push({ id: a.id, balance: r.balance });
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      const cur = balanceState(a.id);
      saveState(a.id, { last_run: started, last_error: message, failed: cur.failed + 1 });
      results.push({ id: a.id, balance: null, error: message });
      ok = false;
    }
  }

  if (glmEnabled() && !sourceOff('glm')) {
    const r = await runGlm();
    results.push({ id: 'glm', balance: null, error: r.error });
    if (!r.ok) ok = false;
  }

  runReminders();
  return { ok, results };
}

// ---------- reminders ----------

const DAY = 86400000;

const money2 = (v: number, unit: string) => (unit === 'CNY' ? `¥${v.toFixed(2)}` : unit === 'USD' ? `$${v.toFixed(2)}` : `${v} ${unit}`);

/** "WorkBuddy" → "workbuddy" for the reader command hint. */
const readerSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'workbuddy';

function resetIn(iso: string | null): string {
  if (!iso) return '';
  const left = Date.parse(iso) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return '';
  const m = Math.round(left / 60000);
  if (m < 60) return `${m} 分钟后重置`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小时后重置` : `${Math.round(h / 24)} 天后重置`;
}

function windowName(a: Account): string {
  if (a.window_minutes && a.window_minutes % 60 === 0) return `${a.window_minutes / 60} 小时额度`;
  return '额度';
}

/** Creates one task per (account, reason) while the condition holds; never auto-closes them. */
export function runReminders(): number {
  let created = 0;
  for (const a of listAccounts()) {
    // 042-H4：等于提醒线也算到线（「高于提醒线」才该继续派），所以用 <=。
    if (a.kind === 'balance' && a.balance !== null && a.low_threshold !== null && a.balance <= a.low_threshold) {
      if (remind(`balance:${a.name}`, `${a.name} 余额只剩 ${money2(a.balance, a.balance_unit)}，考虑充值`, `余额 ${money2(a.balance, a.balance_unit)}，已到提醒线 ${money2(a.low_threshold, a.balance_unit)}。`)) created++;
    }
    if ((a.kind === 'credits' || a.kind === 'balance') && a.expires_at) {
      const left = Date.parse(a.expires_at) - Date.now();
      if (left > 0 && left <= 3 * DAY) {
        const days = Math.max(1, Math.ceil(left / DAY));
        const what = a.kind === 'credits' ? '有积分' : '代金券';
        if (remind(`expires:${a.name}:${a.expires_at.slice(0, 10)}`, `${a.name} ${what} ${days} 天后到期`,
          `到期时间 ${a.expires_at}，当前 ${a.balance ?? '—'} ${a.balance_unit}。`)) created++;
      }
    }
    if (a.kind === 'credits' && a.balance_observed_at && Date.now() - Date.parse(a.balance_observed_at) > 7 * DAY) {
      if (remind(`stale:${a.name}`, `更新一下 ${a.name} 积分`, `上次更新是 ${a.balance_observed_at}，超过 7 天了。`)) created++;
    }
    // The page reader could not log in, or could not find the number.
    if (a.status === 'relogin') {
      if (remind(`relogin:${a.name}`, `重新登录 ${a.name} 读取器：node scripts/quota-reader.mjs login ${readerSlug(a.name)}`,
        `账号「${a.name}」的读取器登录状态已失效。`)) created++;
    }
    if (a.status === 'readfail') {
      if (remind(`readfail:${a.name}`, `${a.name} 读取失败，页面可能改版`,
        `账号「${a.name}」的读取器取不到数字，可以先用「更新」手动填一次。`)) created++;
    }
    if (a.kind === 'window' && a.status !== 'off' && (a.window_pct ?? 0) >= 90) {
      const tail = resetIn(a.window_reset_at);
      if (remind(`window:${a.name}`, `${a.name} ${windowName(a)}已用 ${a.window_pct}%${tail ? `，${tail}` : ''}`, `窗口用量 ${a.window_pct}%。`)) created++;
    }
    // Voucher about to expire while plenty of money is left: nudge the user to spend it.
    if (a.kind === 'balance' && a.expires_at && a.balance !== null) {
      let total = 0;
      try { total = Number(JSON.parse(a.balance_detail || '{}').voucher_total) || 0; } catch { /* not a voucher */ }
      const left = Date.parse(a.expires_at) - Date.now();
      if (total > 0 && left > 0 && left <= 14 * DAY && a.balance > total / 2) {
        const days = Math.max(1, Math.ceil(left / DAY));
        if (remind(`voucher:${a.name}:${a.expires_at.slice(0, 10)}`,
          `${a.name} 还剩 ${money2(a.balance, a.balance_unit)}，${days} 天后到期，可以多派点任务给百炼`,
          `代金券总额 ${money2(total, a.balance_unit)}，估算剩余 ${money2(a.balance, a.balance_unit)}。`)) created++;
      }
    }
  }
  return created;
}

// ---------- scheduling ----------

let timer: NodeJS.Timeout | null = null;
let daily: NodeJS.Timeout | null = null;

export function startBalances(): void {
  if (!balanceEnabled() && !glmEnabled()) return;
  const tick = () => { void runBalances().then((r) => {
    for (const x of r.results) if (x.error) console.warn(`[balances] ${x.id} 失败：${x.error}`);
  }); };
  tick();
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref?.();
  scheduleDaily();
  const names = ADAPTERS.filter((a) => a.enabled()).map((a) => a.label);
  if (glmEnabled()) names.push('GLM Coding Plan');
  console.log('[balances] 额度来源已启用：' + names.join(', '));
}

/** One reminder pass a day at 09:00 in WB_TZ, on top of the ones after each balance run. */
function scheduleDaily(): void {
  const tz = process.env.WB_TZ ?? 'Asia/Shanghai';
  const next = () => {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const minutesNow = Number(parts.hour) * 60 + Number(parts.minute);
    const delay = ((9 * 60 - minutesNow + 24 * 60) % (24 * 60) || 24 * 60) * 60 * 1000;
    daily = setTimeout(() => { runReminders(); next(); }, delay);
    daily.unref?.();
  };
  next();
}

export function stopBalances(): void {
  if (timer) clearInterval(timer);
  if (daily) clearTimeout(daily);
  timer = null;
  daily = null;
}
