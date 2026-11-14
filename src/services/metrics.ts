// Usage (tokens), accounts/quotas, machines, and the aggregates the pages show.
import { mediaPulse } from './media.ts';
import { db, tx } from '../db.ts';
import { AGENT_EXECUTORS, EXECUTORS, dayOf, lastDays, nowIso } from '../domain.ts';
import { HttpError, int, logEvent, oneOf, str } from './core.ts';
import { waitingCount } from './stream.ts';
import { endedWindow, factsOf, judge } from './scorecard.ts';

// ---------- usage ----------

export type UsageRecord = {
  source_key: string; ts: string; executor: string; account?: string; model?: string; project?: string;
  input_tokens?: number; output_tokens?: number; cache_tokens?: number;
};

export function ingestUsage(records: unknown): { received: number; inserted: number } {
  if (!Array.isArray(records)) throw new HttpError(400, 'records 必须是数组');
  if (records.length > 5000) throw new HttpError(413, '一次最多 5000 条');
  const stmt = db().prepare(`INSERT OR IGNORE INTO usage (source_key, ts, day, executor, account, model, project, input_tokens, output_tokens, cache_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  tx(() => {
    for (const raw of records as Record<string, unknown>[]) {
      const key = str(raw.source_key, 300);
      const ts = str(raw.ts, 40);
      const executor = str(raw.executor, 40);
      if (!key || !ts || !executor || Number.isNaN(Date.parse(ts))) continue;
      const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
      const r = stmt.run(key, new Date(ts).toISOString(), dayOf(ts), executor, str(raw.account, 120) ?? '',
        str(raw.model, 120) ?? '', str(raw.project, 120) ?? '', n(raw.input_tokens), n(raw.output_tokens), n(raw.cache_tokens));
      inserted += Number(r.changes);
    }
  });
  return { received: records.length, inserted };
}

/**
 * 042：调度大脑自己的用量也进 usage，模型名前缀 `brain:`。它不算任何执行者的额度——
 * 不然「问一句该派给谁」会把被派的那个人的每日上限吃掉，越派越派不动。
 */
export const BRAIN_MODEL_PREFIX = 'brain:';

/** Tokens per day per executor (input + output; cache reads are reported separately). */
export function tokensByDay(days: number): { days: string[]; series: Record<string, number[]>; cache: number } {
  const ds = lastDays(days);
  const rows = db().prepare(`SELECT day, executor, SUM(input_tokens + output_tokens) t, SUM(cache_tokens) c
    FROM usage WHERE day >= ? AND model NOT LIKE '${BRAIN_MODEL_PREFIX}%' GROUP BY day, executor`).all(ds[0]) as { day: string; executor: string; t: number; c: number }[];
  const series: Record<string, number[]> = {};
  for (const e of AGENT_EXECUTORS) series[e] = ds.map(() => 0);
  let cache = 0;
  for (const r of rows) {
    const i = ds.indexOf(r.day);
    if (i < 0) continue;
    (series[r.executor] ??= ds.map(() => 0))[i] += r.t;
    cache += r.c;
  }
  return { days: ds, series, cache };
}

/** 042：调度大脑近 N 天花掉的 token（另算，不进执行者用量，只在数据页显示一句）。 */
export function brainTokens(days: number): number {
  const row = db().prepare(`SELECT IFNULL(SUM(input_tokens + output_tokens), 0) t FROM usage
    WHERE day >= ? AND model LIKE '${BRAIN_MODEL_PREFIX}%'`).get(lastDays(days)[0]) as { t: number };
  return row.t;
}

export function tokensBetween(fromDay: string, toDay: string): number {
  const r = db().prepare('SELECT IFNULL(SUM(input_tokens + output_tokens), 0) t FROM usage WHERE day >= ? AND day <= ?').get(fromDay, toDay) as { t: number };
  return r.t;
}

export function tokensByExecutorSince(day: string): Record<string, number> {
  const rows = db().prepare(`SELECT executor, SUM(input_tokens + output_tokens) t FROM usage
    WHERE day >= ? AND model NOT LIKE '${BRAIN_MODEL_PREFIX}%' GROUP BY executor`).all(day) as { executor: string; t: number }[];
  return Object.fromEntries(rows.map((r) => [r.executor, r.t]));
}

export function tokensByProject(fromDay: string, limit = 6): { project: string; t: number }[] {
  return db().prepare(`SELECT CASE project WHEN '' THEN '（未标注）' ELSE project END project, SUM(input_tokens + output_tokens) t
    FROM usage WHERE day >= ? GROUP BY 1 ORDER BY t DESC LIMIT ?`).all(fromDay, limit) as { project: string; t: number }[];
}

// ---------- accounts ----------

/** Money and credits keep their decimals, so this is a float parser rather than `int`. */
const floatOf = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `不是数字：${v}`);
  return n;
};

export type Account = {
  name: string; executor: string; via: string; window_pct: number | null; reset_note: string; status: string; updated_at: string;
  source: string; external_id: string | null; provider: string; plan: string;
  window_minutes: number | null; window_reset_at: string | null;
  window2_pct: number | null; window2_minutes: number | null; window2_reset_at: string | null;
  quota_observed_at: string | null; window_limit_tokens: number | null; limited_until: string | null;
  kind: 'window' | 'balance' | 'credits';
  /** 045：非空 = 这是一个账号槽（登录目录）；额度由 runs.ts 的选槽负责，不参与执行者整体的额度判断。 */
  slot_dir?: string;
  balance: number | null; balance_unit: string; balance_detail: string; low_threshold: number | null;
  expires_at: string | null; balance_observed_at: string | null;
  week_tokens?: number; window_estimated?: boolean; balance_estimated?: boolean;
  unpriced_tokens?: number; voucher_calibrated_at?: string | null;
};
export const ACCOUNT_STATUSES: Record<string, string> = { ok: '正常', near: '接近上限', limited: '已限流', relogin: '需重新登录', readfail: '读取失败', off: '停用' };
export const ACCOUNT_KINDS: Record<string, string> = { window: '订阅窗口', balance: '按量余额', credits: '积分' };
/** Where the numbers come from: typed by hand, an API, the CLIProxyAPI connector, or a page reader. */
export const ACCOUNT_SOURCES = ['manual', 'api', 'cliproxyapi', 'reader'];
/** 一个模型的单价，按百万 token 计；`offpeak` 是闲时那一档，缺省时沿用主价。 */
export type Price = { in?: number; out?: number; offpeak?: { in?: number; out?: number } };
export type VoucherDetail = {
  voucher_total?: number; prices?: Record<string, Price>;
  calibrated_at?: string | null; calibrated_spent?: number;
  /** The alias the dispatcher should hand out, e.g. "bl-qwen3.8-flash". */
  model_alias?: string;
  /** 闲时时段，北京时间整点，形如 "22-8"（跨零点）。百炼的 DeepSeek 闲时半价。 */
  offpeak_hours?: string;
};

/** "22-8" → [22, 8]；写坏了就按百炼的默认时段算。 */
function offpeakBounds(d: VoucherDetail): [number, number] {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(d.offpeak_hours ?? '').trim());
  if (!m) return [22, 8];
  return [Number(m[1]) % 24, Number(m[2]) % 24];
}

/** Voucher balance = total − calibrated spend − priced tokens used since the calibration. */
/**
 * 单价表的键和用量的模型名不一定是同一个写法：同一个模型在百炼上有大小写和厂商前缀两种 id
 * （`ZHIPU/GLM-5.3-Flash` vs `glm-5.3-flash`、`kimi/kimi-k3.1-pro` vs `kimi-k3.1-pro`），
 * 带日期版本号的还会多一截后缀（`deepseek-v4.1-flash-1017`）。
 * 归一后比较，免得同名的模型被算成「未定价」，余额因此偏高。
 */
export function normalizeModel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^bl-/, '')
    .replace(/^[a-z0-9._-]+\//, '') // 厂商前缀：ZHIPU/、kimi/、vanchin/
    .replace(/-\d{4}$/, '');        // 日期版本：-1017、-0813、-0731
}

export function voucherSpend(a: Account, d: VoucherDetail): { spent: number; total: number; unpriced: number } {
  const total = Number(d.voucher_total) || 0;
  const since = typeof d.calibrated_at === 'string' ? d.calibrated_at : '1970-01-01T00:00:00.000Z';
  const prices = d.prices && typeof d.prices === 'object' ? d.prices : {};
  // 归一后的索引，只在精确匹配不到时才用。
  const loose = new Map<string, { in?: number; out?: number; offpeak?: { in?: number; out?: number } }>();
  for (const [k, v] of Object.entries(prices)) {
    const nk = normalizeModel(k);
    if (!loose.has(nk)) loose.set(nk, v);
  }
  const [from, to] = offpeakBounds(d);
  // 按「模型 × 峰谷」聚合：闲时按时段内的低价结算，其余按主价。时区固定北京时间。
  const rows = db().prepare(`SELECT model, peak, SUM(i) i, SUM(o) o FROM (
      SELECT model, input_tokens i, output_tokens o,
        CASE WHEN CAST(strftime('%H', ts, '+8 hours') AS INTEGER) >= ? OR CAST(strftime('%H', ts, '+8 hours') AS INTEGER) < ?
          THEN 1 ELSE 0 END peak
      FROM usage WHERE account = ? AND ts > ?)
    GROUP BY model, peak`).all(from, to, a.name, since) as { model: string; peak: number; i: number; o: number }[];
  let spent = Number(d.calibrated_spent) || 0;
  let unpriced = 0;
  for (const r of rows) {
    // usage.model is the upstream name; the user may have typed the alias, so try both.
    const p = prices[r.model] ?? prices[r.model.replace(/^bl-/, '')] ?? prices[`bl-${r.model}`]
      ?? loose.get(normalizeModel(r.model));
    if (!p) { unpriced += (r.i || 0) + (r.o || 0); continue; }
    // 闲时只配了输入价、没配输出价时，输出沿用主价，不要当成 0。
    const q = r.peak ? p.offpeak : undefined;
    const pin = Number(q?.in ?? p.in) || 0;
    const pout = Number(q?.out ?? p.out) || 0;
    spent += ((r.i || 0) * pin + (r.o || 0) * pout) / 1e6;
  }
  return { spent, total, unpriced };
}

function withVoucherEstimate(a: Account): Account {
  if (a.kind !== 'balance') return a;
  let d: VoucherDetail;
  try { d = JSON.parse(a.balance_detail || '{}'); } catch { return a; }
  if (!(Number(d.voucher_total) > 0)) return a; // DeepSeek-style live balance, not a voucher
  const { spent, total, unpriced } = voucherSpend(a, d);
  return {
    ...a,
    balance: Math.round((total - spent) * 100) / 100,
    balance_estimated: true,
    unpriced_tokens: unpriced,
    voucher_calibrated_at: typeof d.calibrated_at === 'string' ? d.calibrated_at : null,
  };
}

/** User looked at the console: record the real spend and keep estimating from there. */
export function calibrateVoucher(name: string, body: Record<string, unknown>): Account {
  const row = db().prepare('SELECT * FROM accounts WHERE name = ?').get(name) as Account | undefined;
  if (!row) throw new HttpError(404, '没有这个账号');
  let d: VoucherDetail;
  try { d = JSON.parse(row.balance_detail || '{}'); } catch { d = {}; }
  const total = floatOf(body.voucher_total) ?? d.voucher_total;
  const spent = floatOf(body.spent);
  const remaining = floatOf(body.remaining);
  if (spent !== undefined && spent !== null) d.calibrated_spent = spent;
  else if (remaining !== undefined && remaining !== null && total) d.calibrated_spent = total - remaining;
  else throw new HttpError(400, '需要 spent（已花费）或 remaining（剩余）');
  if (total !== undefined) d.voucher_total = total;
  d.calibrated_at = nowIso();
  db().prepare('UPDATE accounts SET balance_detail = ?, balance_observed_at = ?, updated_at = ? WHERE name = ?')
    .run(JSON.stringify(d), d.calibrated_at, nowIso(), name);
  logEvent({ actor: 'me', kind: 'account.calibrated', text: `校准账号「${name}」：已花费 ${d.calibrated_spent}` });
  return listAccounts().find((a) => a.name === name)!;
}

/** No official quota signal? Fall back to tokens used in the window over a上限 the user typed in. */
function withEstimate(a: Account): Account {
  if (a.window_pct !== null || !a.window_minutes || !a.window_limit_tokens) return a;
  const from = new Date(Date.now() - a.window_minutes * 60000).toISOString();
  const row = db().prepare('SELECT IFNULL(SUM(input_tokens + output_tokens), 0) t FROM usage WHERE account = ? AND ts >= ?')
    .get(a.name, from) as { t: number };
  const pct = Math.min(100, Math.max(0, Math.round((row.t / a.window_limit_tokens) * 100)));
  return { ...a, window_pct: pct, window_estimated: true };
}

export function listAccounts(): Account[] {
  const since = lastDays(7)[0];
  const rows = db().prepare(`SELECT a.*, IFNULL((SELECT SUM(input_tokens + output_tokens) FROM usage u WHERE u.account = a.name AND u.day >= ?), 0) week_tokens
    FROM accounts a ORDER BY executor, name`).all(since) as Account[];
  return rows.map(withEstimate).map(withVoucherEstimate);
}

/** Anything that is not a JSON object is a mistake worth telling the user about. */
function parseDetail(raw: unknown): VoucherDetail {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as VoucherDetail;
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw)); } catch { throw new HttpError(400, '单价表格式不对'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '单价表格式不对');
  return parsed as VoucherDetail;
}

/** Accepts a full balance_detail JSON, or the four shorthand fields the form sends. */
function mergeDetail(existing: string, input: Record<string, unknown>): string {
  let d: VoucherDetail;
  try { d = parseDetail(existing); } catch { d = {}; } // a corrupt old row should not block the update
  if (input.balance_detail !== undefined) d = parseDetail(input.balance_detail);

  const total = floatOf(input.voucher_total);
  const model = str(input.price_model, 120);
  const pin = floatOf(input.price_in);
  const pout = floatOf(input.price_out);
  const alias = str(input.model_alias, 120);
  if (alias !== undefined) {
    if (alias) d.model_alias = alias; else delete d.model_alias;
  }
  const hours = str(input.offpeak_hours, 12);
  if (hours !== undefined) {
    if (hours) d.offpeak_hours = hours; else delete d.offpeak_hours;
  }
  const pinOff = floatOf(input.price_in_off);
  const poutOff = floatOf(input.price_out_off);
  if (total !== undefined || model || pin !== undefined || pout !== undefined || pinOff !== undefined || poutOff !== undefined) {
    if (total !== undefined && total !== null) d.voucher_total = total;
    if (model) {
      d.prices = d.prices && typeof d.prices === 'object' ? d.prices : {};
      const p = d.prices[model] ?? {};
      if (pin !== undefined && pin !== null) p.in = pin;
      if (pout !== undefined && pout !== null) p.out = pout;
      // 只填闲时价、不填主价也允许：闲时按这个价扣，其余时段没有主价就不计价。
      if ((pinOff !== undefined && pinOff !== null) || (poutOff !== undefined && poutOff !== null)) {
        const off = p.offpeak ?? {};
        if (pinOff !== undefined && pinOff !== null) off.in = pinOff;
        if (poutOff !== undefined && poutOff !== null) off.out = poutOff;
        p.offpeak = off;
      }
      d.prices[model] = p;
    }
  }
  return JSON.stringify(d);
}

export function upsertAccount(name: string, input: Record<string, unknown>): Account {
  const n = name.trim().slice(0, 120);
  if (!n) throw new HttpError(400, '账号名不能为空');
  const prev = db().prepare('SELECT * FROM accounts WHERE name = ?').get(n) as Account | undefined;
  const executor = oneOf(input.executor, Object.keys(EXECUTORS), 'executor') ?? prev?.executor;
  if (!executor) throw new HttpError(400, '新账号需要指定 executor');
  const pct = int(input.window_pct);
  const status = oneOf(input.status, Object.keys(ACCOUNT_STATUSES), 'status') ?? prev?.status ?? 'ok';
  const windowMinutes = int(input.window_minutes);
  const windowLimit = int(input.window_limit_tokens);
  const kind = oneOf(input.kind, Object.keys(ACCOUNT_KINDS), 'kind') ?? prev?.kind ?? 'window';
  const threshold = floatOf(input.low_threshold);
  const balance = floatOf(input.balance);
  const observedAt = str(input.balance_observed_at, 40) ?? (balance !== undefined ? nowIso() : undefined);
  const detail = mergeDetail(prev?.balance_detail ?? '{}', input);
  const source = oneOf(input.source, ACCOUNT_SOURCES, 'source') ?? prev?.source ?? 'manual';
  const provider = (str(input.provider, 40) ?? prev?.provider ?? '').trim().toLowerCase();
  db().prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at, window_minutes, window_limit_tokens,
      kind, balance, balance_unit, balance_detail, low_threshold, expires_at, balance_observed_at, source, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET executor = excluded.executor, via = excluded.via, window_pct = excluded.window_pct,
      reset_note = excluded.reset_note, status = excluded.status, updated_at = excluded.updated_at,
      window_minutes = excluded.window_minutes, window_limit_tokens = excluded.window_limit_tokens,
      kind = excluded.kind, balance = excluded.balance, balance_unit = excluded.balance_unit,
      balance_detail = excluded.balance_detail, low_threshold = excluded.low_threshold,
      expires_at = excluded.expires_at, balance_observed_at = excluded.balance_observed_at,
      source = excluded.source, provider = excluded.provider`).run(
    n, executor, str(input.via, 60) ?? prev?.via ?? '',
    pct === undefined ? prev?.window_pct ?? null : pct === null ? null : Math.min(100, Math.max(0, pct)),
    str(input.reset_note, 60) ?? prev?.reset_note ?? '', status, nowIso(),
    windowMinutes === undefined ? prev?.window_minutes ?? null : windowMinutes,
    windowLimit === undefined ? prev?.window_limit_tokens ?? null : windowLimit,
    kind,
    balance === undefined ? prev?.balance ?? null : balance,
    str(input.balance_unit, 10) ?? prev?.balance_unit ?? '',
    detail,
    threshold === undefined ? prev?.low_threshold ?? null : threshold,
    str(input.expires_at, 40) ?? prev?.expires_at ?? null,
    observedAt ?? prev?.balance_observed_at ?? null,
    source, provider,
  );
  if (!prev) logEvent({ actor: 'me', kind: 'account.created', text: `添加账号「${n}」` });
  else if (prev.status !== status) logEvent({ actor: 'system', kind: 'account.status', text: `账号「${n}」状态：${ACCOUNT_STATUSES[prev.status] ?? prev.status} → ${ACCOUNT_STATUSES[status]}` });
  return listAccounts().find((a) => a.name === n)!;
}

export function deleteAccount(name: string): void {
  const r = db().prepare('DELETE FROM accounts WHERE name = ?').run(name);
  if (!r.changes) throw new HttpError(404, '没有这个账号');
  logEvent({ actor: 'me', kind: 'account.deleted', text: `删除账号「${name}」` });
}

// ---------- machines ----------

export type GPU = { name?: string; temp?: number; util?: number; mem_used?: number; mem_total?: number };
export type MachineMetrics = {
  load?: number; cores?: number; mem_used_gb?: number; mem_total_gb?: number; disk_pct?: number;
  temp_c?: number; uptime_h?: number; containers?: number; gpus?: GPU[];
};
export type Machine = { name: string; meta: string; metrics: MachineMetrics; updated_at: string; online: boolean };

export function heartbeat(name: string, input: Record<string, unknown>): void {
  const n = name.trim().slice(0, 80);
  if (!n) throw new HttpError(400, '机器名不能为空');
  const metrics = input.metrics && typeof input.metrics === 'object' ? input.metrics : {};
  db().prepare(`INSERT INTO machines (name, meta, metrics, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET meta = excluded.meta, metrics = excluded.metrics, updated_at = excluded.updated_at`)
    .run(n, str(input.meta, 200) ?? '', JSON.stringify(metrics).slice(0, 20000), nowIso());
}

export function listMachines(): Machine[] {
  const rows = db().prepare('SELECT * FROM machines ORDER BY name').all() as { name: string; meta: string; metrics: string; updated_at: string }[];
  return rows.map((r) => {
    let metrics: MachineMetrics = {};
    try { metrics = JSON.parse(r.metrics); } catch { /* keep empty */ }
    return { ...r, metrics, online: Date.now() - Date.parse(r.updated_at) < 3 * 60 * 1000 };
  });
}

export function deleteMachine(name: string): void {
  db().prepare('DELETE FROM machines WHERE name = ?').run(name);
}

// ---------- page aggregates ----------

const count = (sql: string, ...args: (string | number)[]) => (db().prepare(sql).get(...args) as { n: number }).n;

export function overviewStats() {
  const today = lastDays(1)[0];
  const yesterday = lastDays(2)[0];
  const runningByExec = db().prepare("SELECT executor, COUNT(*) n FROM tasks WHERE status = 'running' GROUP BY executor").all() as { executor: string; n: number }[];
  const doneToday = (db().prepare("SELECT completed_at FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?")
    .all(new Date(Date.now() - 2 * 86400000).toISOString()) as { completed_at: string }[]).filter((r) => dayOf(r.completed_at) === today).length;
  const takeoversToday = (db().prepare("SELECT decided_at FROM approvals WHERE status = 'takeover' AND decided_at >= ?")
    .all(new Date(Date.now() - 2 * 86400000).toISOString()) as { decided_at: string }[]).filter((r) => dayOf(r.decided_at) === today).length;
  const oldestPending = db().prepare("SELECT created_at FROM approvals WHERE status = 'pending' ORDER BY id LIMIT 1").get() as { created_at: string } | undefined;
  const lastFailed = db().prepare("SELECT title FROM tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1").get() as { title: string } | undefined;
  return {
    running: runningByExec.reduce((s, r) => s + r.n, 0),
    runningByExec,
    // 055.2：等你选的卡片和待审批一样是「等你拍板」，一起算进数字。
    pending: count("SELECT (SELECT COUNT(*) FROM approvals WHERE status = 'pending') + (SELECT COUNT(*) FROM tasks WHERE status = 'asking') n"),
    oldestPending: oldestPending?.created_at ?? null,
    mine: count("SELECT COUNT(*) n FROM tasks WHERE executor = 'me' AND status NOT IN ('done', 'failed')"),
    doneToday,
    takeoversToday,
    failed: count("SELECT COUNT(*) n FROM tasks WHERE status = 'failed'"),
    lastFailed: lastFailed?.title ?? null,
    tokensToday: tokensBetween(today, today),
    tokensYesterday: tokensBetween(yesterday, yesterday),
  };
}

/** 044：工作台数据格的小图——最近 n 天（含今天）每天完成几件、用了多少 token。按 WB_TZ 的日子算。 */
export function dailySeries(n = 7): { days: string[]; done: number[]; tokens: number[] } {
  const days = lastDays(n);
  const since = new Date(Date.now() - (n + 1) * 86400000).toISOString();
  const rows = db().prepare("SELECT completed_at FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?")
    .all(since) as { completed_at: string }[];
  const byDay = new Map<string, number>();
  for (const r of rows) { const d = dayOf(r.completed_at); byDay.set(d, (byDay.get(d) ?? 0) + 1); }
  return { days, done: days.map((d) => byDay.get(d) ?? 0), tokens: days.map((d) => tokensBetween(d, d)) };
}

/**
 * 044 v3：「AI 替你干的活」账本。每件结束了的活（完成 / 失败）一行，带结局：
 *   once 一次就过 · fix 让它改过（有过「让它改」的审批）· me 你自己来（接手过）· fail 没成。
 * 结局 = 这件活费了你多少事，记录页的颜色深浅就按它。
 */
export type Outcome = 'once' | 'fix' | 'me' | 'fail';
export type LedgerItem = { id: number; title: string; executor: string; day: string; tokens: number; outcome: Outcome };
export function ledger(days: number): { items: LedgerItem[]; days: string[] } {
  const ds = lastDays(days);
  const { ended: rows } = endedWindow(days, undefined, { by: 'finished' });
  const facts = factsOf(rows.map((r) => r.id));
  const inRange = new Set(ds);
  const items = rows.map((r) => ({
    // 分桶日按任务真正完成的那一天（`finished_at`），不是首轮结束日：
    // 跨周的活今天才做完，就得算在这周，否则它从「这周做完几件」里整单消失。统计值仍取首轮。
    id: r.id, title: r.title, executor: r.first_executor || r.executor, day: dayOf(r.finished_at ?? r.completed_at!), tokens: r.tokens_used || 0,
    outcome: (r.executor === 'me' ? 'me' : { failed: 'fail', takeover: 'me', rework: 'fix', first_pass: 'once', unfinished: 'once' }[judge(r, facts.get(r.id))]) as Outcome,
  })).filter((x) => inRange.has(x.day));
  return { items, days: ds };
}

export function navCounts() {
  return {
    // 055.2：等你选的卡片和待审批一样是「等你拍板」，一起算进数字。
    pending: count("SELECT (SELECT COUNT(*) FROM approvals WHERE status = 'pending') + (SELECT COUNT(*) FROM tasks WHERE status = 'asking') n"),
    mine: count("SELECT COUNT(*) n FROM tasks WHERE executor = 'me' AND status NOT IN ('done', 'failed')"),
  };
}

export function periodStats(days: number) {
  const ds = lastDays(days * 2);
  const prevFrom = ds[0], prevTo = ds[days - 1], from = ds[days], to = ds[ds.length - 1];
  const fromIso = new Date(Date.now() - days * 86400000).toISOString();
  const prevIso = new Date(Date.now() - 2 * days * 86400000).toISOString();
  const finished = (since: string, until: string) => db().prepare(
    "SELECT status, started_at, completed_at FROM tasks WHERE completed_at >= ? AND completed_at < ? AND status IN ('done', 'failed')",
  ).all(since, until) as { status: string; started_at: string | null; completed_at: string }[];
  const cur = finished(fromIso, new Date(Date.now() + 60000).toISOString());
  const prev = finished(prevIso, fromIso);
  const done = cur.filter((r) => r.status === 'done').length;
  const prevDone = prev.filter((r) => r.status === 'done').length;
  const rate = (rows: typeof cur) => (rows.length ? rows.filter((r) => r.status === 'done').length / rows.length : null);
  const durs = cur.filter((r) => r.started_at).map((r) => Date.parse(r.completed_at) - Date.parse(r.started_at!));
  const prevDurs = prev.filter((r) => r.started_at).map((r) => Date.parse(r.completed_at) - Date.parse(r.started_at!));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const interventions = db().prepare("SELECT status, COUNT(*) n FROM approvals WHERE decided_at >= ? AND status IN ('takeover', 'changes') GROUP BY status")
    .all(fromIso) as { status: string; n: number }[];
  const iv = Object.fromEntries(interventions.map((r) => [r.status, r.n]));

  const byCategory = db().prepare(`SELECT category, COUNT(*) n,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) bad
    FROM tasks WHERE created_at >= ? GROUP BY category ORDER BY n DESC`).all(fromIso) as { category: string; n: number; ok: number; bad: number }[];

  const appr = db().prepare("SELECT status, created_at, decided_at FROM approvals WHERE created_at >= ?").all(fromIso) as { status: string; created_at: string; decided_at: string | null }[];
  const decided = appr.filter((a) => a.decided_at && a.status !== 'expired');
  const topRules = db().prepare(`SELECT CASE rule_name WHEN '' THEN '手动发起' ELSE rule_name END name, COUNT(*) n
    FROM approvals WHERE created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 5`).all(fromIso) as { name: string; n: number }[];

  return {
    tokens: tokensBetween(from, to), prevTokens: tokensBetween(prevFrom, prevTo),
    done, prevDone, successRate: rate(cur), prevSuccessRate: rate(prev),
    avgDuration: avg(durs), prevAvgDuration: avg(prevDurs),
    takeovers: iv.takeover ?? 0, changes: iv.changes ?? 0,
    byCategory,
    approvals: {
      total: appr.length,
      approvedRate: decided.length ? decided.filter((a) => a.status === 'approved').length / decided.length : null,
      avgWait: avg(decided.map((a) => Date.parse(a.decided_at!) - Date.parse(a.created_at))),
      topRules,
    },
    projects: tokensByProject(from),
  };
}

/** Changes whenever something on screen would change; the browser polls it to decide when to refresh. */
export function pulse(): string {
  const r = db().prepare(`SELECT
    (SELECT IFNULL(MAX(updated_at), '') FROM tasks) t,
    (SELECT IFNULL(MAX(id), 0) FROM events) e,
    (SELECT IFNULL(MAX(updated_at), '') FROM machines) m,
    (SELECT IFNULL(MAX(id), 0) FROM usage) u,
    (SELECT IFNULL(MAX(updated_at), '') FROM accounts) a,
    (SELECT IFNULL(MAX(updated_at), '') FROM source_prefs) s,
    (SELECT IFNULL(value, '') FROM settings WHERE key = 'labels') l,
    (SELECT IFNULL(value, '0') FROM settings WHERE key = 'auto_paused') p,
    (SELECT IFNULL(MAX(last_seen), '') FROM runners) r,
    (SELECT IFNULL(last_run, '') FROM connector_state WHERE name = 'github') gh,
    (SELECT IFNULL(checked_at, '') FROM selfdev_state WHERE id = 1) sd`).get() as Record<string, string | number>;
  return `${r.t}|${r.e}|${r.m}|${r.u}|${r.a}|${r.s}|${r.l}|${r.p}|${r.r}|${r.gh ?? ''}|${r.sd ?? ''}|${mediaPulse()}`;
}

/**
 * 角色要的两个数：真正在跑几个、等你拍板几个；再带「最后完成 / 最后失败」是哪一单。
 * 只读，不碰任何调度；页面拿它决定 PrivateBot 摆什么姿态。
 * 最后那两单的标识是给前端认「刚刚真的完成了一次」用的——第一次拿到快照不放庆祝，
 * 之后只有这个标识换人了才算数，避免把「本来就有历史完成记录」当成刚发生的事。
 */
export function botSnapshot(): { running: number; waiting: number; lastDone: string | null; lastFail: string | null } {
  const r = db().prepare(`SELECT
    (SELECT COUNT(*) FROM tasks WHERE status = 'running') running,
    (SELECT COUNT(*) FROM approvals WHERE status = 'pending') ask,
    (SELECT COUNT(*) FROM tasks WHERE status = 'asking') mine,
    (SELECT id || '@' || IFNULL(completed_at, '') FROM tasks WHERE status = 'done' ORDER BY IFNULL(completed_at, '') DESC LIMIT 1) lastDone,
    (SELECT id || '@' || IFNULL(completed_at, '') FROM tasks WHERE status = 'failed' ORDER BY IFNULL(completed_at, '') DESC LIMIT 1) lastFail`).get() as {
    running: number; ask: number; mine: number; lastDone: string | null; lastFail: string | null;
  };
  return {
    running: r.running,
    // 061.1：和侧栏、首页同一个数（services/stream.ts 的「等你」）。
    waiting: waitingCount(),
    lastDone: r.lastDone ?? null,
    lastFail: r.lastFail ?? null,
  };
}
