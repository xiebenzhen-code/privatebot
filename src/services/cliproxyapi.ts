// CLIProxyAPI connector: mirrors upstream accounts (with their official quota windows)
// and drains the destructive usage queue into the local `usage` table.
// Read-only against CLIProxyAPI, except turning usage statistics on at startup.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, tx } from '../db.ts';
import { dayOf, nowIso } from '../domain.ts';
import { logEvent } from './core.ts';

const NAME = 'cliproxyapi';
const QUEUE_BATCH = 500;
const QUEUE_ROUNDS = 20;
/** A 429 without a known window reset keeps the account limited this long. */
const LIMITED_FALLBACK_MS = 15 * 60 * 1000;

const baseUrl = () => (process.env.CPA_URL ?? '').trim().replace(/\/+$/, '');
const managementKey = () => (process.env.CPA_MANAGEMENT_KEY ?? '').trim();

export const connectorEnabled = () => Boolean(baseUrl() && managementKey());
export function pollSeconds(): number {
  const n = Number(process.env.CPA_POLL_SECONDS);
  return Math.max(15, Number.isFinite(n) && n > 0 ? Math.round(n) : 60);
}

export type ConnectorState = {
  name: string; last_run: string | null; last_ok: string | null; last_error: string;
  imported: number; failed: number;
};

export function connectorState(): ConnectorState {
  const row = db().prepare('SELECT * FROM connector_state WHERE name = ?').get(NAME) as ConnectorState | undefined;
  return row ?? { name: NAME, last_run: null, last_ok: null, last_error: '', imported: 0, failed: 0 };
}

function saveState(patch: Partial<ConnectorState>): void {
  const cur = connectorState();
  db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_ok = excluded.last_ok,
      last_error = excluded.last_error, imported = excluded.imported, failed = excluded.failed`)
    .run(NAME, patch.last_run ?? cur.last_run, patch.last_ok ?? cur.last_ok,
      patch.last_error ?? cur.last_error, patch.imported ?? cur.imported, patch.failed ?? cur.failed);
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      Authorization: `Bearer ${managementKey()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return null; }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v).slice(0, 300));
const isoFromUnix = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

// ---------- accounts ----------

type Quota = {
  window_pct: number | null; window_minutes: number | null; window_reset_at: string | null;
  window2_pct: number | null; window2_minutes: number | null; window2_reset_at: string | null;
  observed_at: string | null;
};

const EMPTY_QUOTA: Quota = {
  window_pct: null, window_minutes: null, window_reset_at: null,
  window2_pct: null, window2_minutes: null, window2_reset_at: null, observed_at: null,
};

const warnedProviders = new Set<string>();

/** Per-provider signal tables. Add Claude here when it starts reporting quota. */
function quotaOf(file: Record<string, any>): Quota {
  const provider = text(file.provider || file.type).toLowerCase();
  let signals: Record<string, unknown> = file.quota?.signals ?? {};
  let observed = file.quota?.observed_at ?? null;
  if (!Object.keys(signals).length && file.model_quotas && typeof file.model_quotas === 'object') {
    const entries = Object.values(file.model_quotas as Record<string, any>)
      .filter((m) => m && typeof m === 'object')
      .sort((a, b) => Date.parse(b.observed_at ?? 0) - Date.parse(a.observed_at ?? 0));
    if (entries[0]) {
      signals = entries[0].signals ?? {};
      observed = entries[0].observed_at ?? observed;
    }
  }
  if (!Object.keys(signals).length) return EMPTY_QUOTA;

  if (provider !== 'codex') {
    if (!warnedProviders.has(provider)) {
      warnedProviders.add(provider);
      // Field names only — values can carry account identifiers.
      console.log(`[cliproxyapi] ${provider}: 暂不解析额度信号，字段：${Object.keys(signals).join(', ')}`);
    }
    return { ...EMPTY_QUOTA, observed_at: observed ? new Date(observed).toISOString() : null };
  }

  const pct = (k: string) => {
    const v = signals[k];
    return v === undefined ? null : Math.min(100, Math.max(0, Math.round(num(v))));
  };
  const mins = (k: string) => {
    const v = signals[k];
    return v === undefined ? null : Math.round(num(v));
  };
  return {
    window_pct: pct('X-Codex-Primary-Used-Percent'),
    window_minutes: mins('X-Codex-Primary-Window-Minutes'),
    window_reset_at: isoFromUnix(signals['X-Codex-Primary-Reset-At']),
    window2_pct: pct('X-Codex-Secondary-Used-Percent'),
    window2_minutes: mins('X-Codex-Secondary-Window-Minutes'),
    window2_reset_at: isoFromUnix(signals['X-Codex-Secondary-Reset-At']),
    observed_at: observed ? new Date(observed).toISOString() : null,
  };
}

function statusOf(file: Record<string, any>, q: Quota, cooldownUntil: string | null): string {
  if (file.disabled) return 'off';
  if ((q.window_pct !== null && q.window_pct >= 100) || cooldownUntil || file.unavailable) return 'limited';
  if (file.status && file.status !== 'active') return 'relogin';
  return 'ok';
}

function cooldownEnd(file: Record<string, any>): string | null {
  const list = Array.isArray(file.cooldowns) ? file.cooldowns : [];
  const untils = list.map((c: any) => c?.until ?? c?.end ?? c?.expires_at).filter(Boolean)
    .map((v: string) => Date.parse(v)).filter((t: number) => Number.isFinite(t) && t > Date.now());
  return untils.length ? new Date(Math.max(...untils)).toISOString() : null;
}

/** Failures are counted from `usage`, so "3 failures in ten minutes" survives across cycles. */

function uniqueName(preferred: string): string {
  let name = preferred.slice(0, 110);
  for (let i = 2; i < 50; i++) {
    const exists = db().prepare('SELECT 1 FROM accounts WHERE name = ?').get(name);
    if (!exists) return name;
    name = `${preferred.slice(0, 105)} · ${i}`;
  }
  return `${preferred.slice(0, 100)} · ${Date.now()}`;
}

function upsertFromFile(file: Record<string, any>): void {
  // `auth_index` changes whenever CLIProxyAPI restarts, so the account is keyed by the auth file itself.
  const externalId = text(file.id) || text(file.name) || text(file.auth_index);
  if (!externalId) return;
  const provider = text(file.provider || file.type).toLowerCase();
  const plan = text(file.id_token?.plan_type);
  const cooldown = cooldownEnd(file);
  const q = quotaOf(file);
  const status = statusOf(file, q, cooldown);
  const prev = db().prepare('SELECT name, status, limited_until FROM accounts WHERE external_id = ?')
    .get(externalId) as { name: string; status: string; limited_until: string | null } | undefined;

  // A 429 sets limited_until; the auth file still says "active", so remember the flag until it expires.
  const heldUntil = prev?.limited_until && Date.parse(prev.limited_until) > Date.now() ? prev.limited_until : null;
  const effective = status === 'ok' && heldUntil ? 'limited' : status;
  let limitedUntil: string | null = null;
  if (effective === 'limited') limitedUntil = status === 'limited' ? cooldown ?? q.window_reset_at : heldUntil;

  if (prev) {
    db().prepare(`UPDATE accounts SET executor = 'pool', source = 'cliproxyapi', provider = ?, plan = ?,
        via = ?, window_pct = ?, status = ?, updated_at = ?,
        window_minutes = ?, window_reset_at = ?, window2_pct = ?, window2_minutes = ?, window2_reset_at = ?,
        quota_observed_at = ?, limited_until = ?
      WHERE external_id = ?`).run(
      provider, plan, `CLIProxyAPI · ${provider}`,
      q.window_pct, effective, nowIso(),
      q.window_minutes, q.window_reset_at, q.window2_pct, q.window2_minutes, q.window2_reset_at,
      q.observed_at, limitedUntil, externalId,
    );
    if (prev.status !== effective) {
      const reason = effective !== status ? '限流未到期' : text(file.status_message);
      logEvent({ actor: 'system', kind: 'account.status', text: `账号「${prev.name}」状态：${prev.status} → ${effective}${reason ? `（${reason}）` : ''}` });
    }
    return;
  }

  const preferred = text(file.label) || text(file.email) || text(file.account) || text(file.name) || externalId;
  const name = uniqueName(preferred);
  db().prepare(`INSERT INTO accounts (name, executor, via, window_pct, reset_note, status, updated_at,
      source, external_id, provider, plan, window_minutes, window_reset_at, window2_pct, window2_minutes,
      window2_reset_at, quota_observed_at, limited_until)
    VALUES (?, 'pool', ?, ?, '', ?, ?, 'cliproxyapi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name, `CLIProxyAPI · ${provider}`, q.window_pct, status, nowIso(),
    externalId, provider, plan, q.window_minutes, q.window_reset_at, q.window2_pct, q.window2_minutes,
    q.window2_reset_at, q.observed_at, limitedUntil,
  );
  logEvent({ actor: 'system', kind: 'account.imported', text: `从 CLIProxyAPI 导入账号「${name}」（${provider}）` });
}

async function syncAccounts(): Promise<{ files: Record<string, any>[]; migration: Migration }> {
  const res = await call('GET', '/v0/management/auth-files') as { files?: Record<string, any>[] } | null;
  const files = Array.isArray(res?.files) ? res!.files! : [];
  const migration = migrateExternalIds(files);
  tx(() => { for (const f of files) upsertFromFile(f); });
  buildAuthIndex(files);
  migration.orphans.push(...checkOrphans(files));
  return { files, migration };
}

// ---------- account identity ----------

export type Migration = { rewritten: number; merged: number; mergedRows: number; orphans: string[] };

/** Set once after the 005.1 rewrite; the migration is not supposed to run again afterwards. */
const MIGRATION_FLAG = 'cliproxyapi-migrate-005.1';
const migrationDone = () => Boolean(db().prepare('SELECT 1 FROM connector_state WHERE name = ?').get(MIGRATION_FLAG));
const markMigrationDone = () => db().prepare(`INSERT OR IGNORE INTO connector_state (name, last_run, last_ok, last_error, imported, failed)
  VALUES (?, ?, ?, '', 0, 0)`).run(MIGRATION_FLAG, nowIso(), nowIso());

/** One-shot: key accounts by auth file id, and merge duplicates left over from the auth_index era. */
function migrateExternalIds(files: Record<string, any>[]): Migration {
  const out: Migration = { rewritten: 0, merged: 0, mergedRows: 0, orphans: [] };
  if (migrationDone()) return out;

  const fileIds = new Set<string>();
  for (const f of files) {
    const fileId = text(f.id) || text(f.name);
    if (!fileId) continue;
    fileIds.add(fileId);
    const authIndex = text(f.auth_index);
    if (!authIndex) continue;
    const row = db().prepare("SELECT name FROM accounts WHERE external_id = ? AND source = 'cliproxyapi'")
      .get(authIndex) as { name: string } | undefined;
    if (!row) continue;
    try {
      db().prepare('UPDATE accounts SET external_id = ? WHERE name = ?').run(fileId, row.name);
      out.rewritten++;
      logEvent({ actor: 'system', kind: 'account.migrated', text: `账号「${row.name}」的外部 id 从 auth_index 改为认证文件 ${fileId}` });
    } catch { /* another row already holds this file id; the merge below sorts it out */ }
  }

  // Only stale duplicates are merged: two live auth files for the same e-mail (personal + team)
  // are legitimate and must stay two accounts.
  const dups = db().prepare("SELECT name, external_id FROM accounts WHERE source = 'cliproxyapi' AND name GLOB '* · [0-9]*'")
    .all() as { name: string; external_id: string | null }[];
  for (const d of dups) {
    const base = d.name.replace(/ · \d+$/, '');
    const orig = db().prepare('SELECT name, external_id FROM accounts WHERE name = ?').get(base) as { name: string; external_id: string | null } | undefined;
    if (!orig) continue;
    const baseLive = Boolean(orig.external_id && fileIds.has(orig.external_id));
    const dupLive = Boolean(d.external_id && fileIds.has(d.external_id));
    if (baseLive && dupLive) continue;
    // the surviving row should end up pointing at a live file
    if (!baseLive && dupLive && d.external_id) {
      try { db().prepare('UPDATE accounts SET external_id = ? WHERE name = ?').run(d.external_id, base); } catch { /* keep the old id */ }
    }
    const moved = db().prepare('UPDATE usage SET account = ? WHERE account = ?').run(base, d.name).changes;
    db().prepare('DELETE FROM accounts WHERE name = ?').run(d.name);
    out.merged++;
    out.mergedRows += Number(moved);
    logEvent({ actor: 'system', kind: 'account.merged', text: `合并重复账号「${d.name}」到「${base}」，迁移用量 ${moved} 条` });
  }

  markMigrationDone();
  return out;
}

/** Orphans are reported only when an account *becomes* orphaned, and never on an empty file list. */
const orphaned = new Set<string>();
function checkOrphans(files: Record<string, any>[]): string[] {
  if (!files.length) return []; // CLIProxyAPI restarting: no information, not "everything is gone"
  const ids = new Set(files.map((f) => text(f.id) || text(f.name)).filter(Boolean));
  const fresh: string[] = [];
  for (const row of db().prepare("SELECT name, external_id FROM accounts WHERE source = 'cliproxyapi' AND external_id IS NOT NULL")
    .all() as { name: string; external_id: string }[]) {
    if (ids.has(row.external_id)) { orphaned.delete(row.name); continue; }
    if (orphaned.has(row.name)) continue;
    orphaned.add(row.name);
    fresh.push(row.name);
    logEvent({ actor: 'system', kind: 'account.orphan', text: `账号「${row.name}」在 CLIProxyAPI 里找不到对应认证文件（${row.external_id}），保留不删` });
  }
  return fresh;
}

/** auth_index is only used inside one cycle to attribute usage; it is never stored. */
function buildAuthIndex(files: Record<string, any>[]): void {
  accountByAuthIndex.clear();
  for (const f of files) {
    const fileId = text(f.id) || text(f.name);
    const authIndex = text(f.auth_index);
    if (!fileId || !authIndex) continue;
    const row = db().prepare('SELECT name FROM accounts WHERE external_id = ?').get(fileId) as { name: string } | undefined;
    if (row) accountByAuthIndex.set(authIndex, row.name);
  }
}

// ---------- usage ----------

const accountByAuthIndex = new Map<string, string>();
/** provider suffix → account name, e.g. "deepseek" → "DeepSeek" (see balances.ts). */
const accountByProvider = new Map<string, string>();

function refreshProviderIndex(): void {
  accountByProvider.clear();
  const rows = db().prepare("SELECT provider, name FROM accounts WHERE provider <> '' AND source = 'api'")
    .all() as { provider: string; name: string }[];
  for (const r of rows) accountByProvider.set(r.provider.toLowerCase(), r.name);
}

/**
 * `source` for OpenAI-compatible upstreams can be the upstream credential itself, so anything that
 * looks like a secret or an opaque token is dropped rather than written into the `usage` table.
 */
function safeSource(v: unknown): string {
  const s = text(v);
  if (!s) return '';
  if (s.includes('@')) return s; // account e-mail, fine
  if (/^sk-/i.test(s) || /^[A-Za-z0-9_-]{24,}$/.test(s)) return '';
  return s;
}

function accountOf(r: Record<string, any>): string {
  const byIndex = accountByAuthIndex.get(text(r.auth_index));
  if (byIndex) return byIndex;
  const provider = text(r.provider).toLowerCase();
  const suffix = provider.startsWith('openai-compatible-') ? provider.slice('openai-compatible-'.length) : provider;
  const byProvider = accountByProvider.get(suffix);
  if (byProvider) return byProvider;
  const src = safeSource(r.source);
  if (src) return src;
  return suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : '';
}

type UsageRow = {
  source_key: string; ts: string; executor: string; account: string; model: string; project: string;
  input_tokens: number; output_tokens: number; cache_tokens: number; failed: number;
  fail_status: number | null; latency_ms: number | null;
};

/** Map one queue record. Deliberately ignores response_headers / api_key / client_ip / access_token_sha256. */
function toUsageRow(r: Record<string, any>): UsageRow | null {
  const ts = text(r.timestamp);
  if (!ts || Number.isNaN(Date.parse(ts))) return null;
  const tb = r.token_breakdown;
  const complete = tb?.quality === 'complete';
  const tokens = r.tokens ?? {};
  const cached = num(tokens.cache_read_tokens) || num(tokens.cached_tokens);
  const input = complete
    ? num(tb.input?.uncached_tokens)
    : Math.max(0, num(tokens.input_tokens) - cached);
  const cache = complete
    ? num(tb.input?.cache_read_tokens) + num(tb.input?.cache_write_tokens)
    : cached + num(tokens.cache_creation_tokens);
  const output = complete
    ? num(tb.output?.total_tokens)
    : num(tokens.output_tokens) + num(tokens.reasoning_tokens);
  const status = num(r.fail?.status_code);
  const failed = r.failed === true || status >= 400 ? 1 : 0;
  const authIndex = text(r.auth_index);
  const key = text(r.request_id)
    || createHash('sha1').update(`${ts}|${authIndex}|${text(r.model)}|${text(r.execution_id)}`).digest('hex');
  const account = accountOf(r);
  return {
    source_key: `cpa:${key}`.slice(0, 300),
    ts: new Date(ts).toISOString(),
    executor: 'pool',
    account,
    model: (text(r.response_model) || text(r.alias) || text(r.model)).slice(0, 120),
    project: '',
    input_tokens: Math.max(0, Math.round(input)),
    output_tokens: Math.max(0, Math.round(output)),
    cache_tokens: Math.max(0, Math.round(cache)),
    failed,
    fail_status: status >= 400 ? status : null,
    latency_ms: Number.isFinite(Number(r.latency_ms)) ? Math.round(Number(r.latency_ms)) : null,
  };
}

function insertRows(rows: UsageRow[]): number {
  if (!rows.length) return 0;
  const stmt = db().prepare(`INSERT OR IGNORE INTO usage
    (source_key, ts, day, executor, account, model, project, input_tokens, output_tokens, cache_tokens, failed, fail_status, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  tx(() => {
    for (const r of rows) {
      const res = stmt.run(r.source_key, r.ts, dayOf(r.ts), r.executor, r.account, r.model, r.project,
        r.input_tokens, r.output_tokens, r.cache_tokens, r.failed, r.fail_status, r.latency_ms);
      inserted += Number(res.changes);
    }
  });
  return inserted;
}

/** A queue batch that could not be written is kept on disk — stripped of anything sensitive first. */
function dumpFailedBatch(records: unknown[], err: unknown): void {
  try {
    const dir = process.env.CPA_FAIL_DIR || join(process.cwd(), 'data');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `cpa-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const PRIVATE = ['api_key', 'response_headers', 'client_ip', 'resolved_client_ip', 'x_forwarded_for', 'access_token_sha256', 'id_token'];
    const redacted = records.map((r) => {
      if (!r || typeof r !== 'object') return r;
      const copy: Record<string, unknown> = { ...(r as Record<string, unknown>) };
      for (const k of PRIVATE) delete copy[k];
      return copy;
    });
    writeFileSync(file, JSON.stringify({ error: String((err as Error)?.message ?? err), records: redacted }, null, 2));
  } catch { /* nothing else we can do */ }
}

/** The queue is take-and-delete: write this batch before asking for the next one. */
async function collectUsage(): Promise<{ imported: number; failed: number }> {
  refreshProviderIndex();
  let imported = 0, failedCount = 0;
  for (let round = 0; round < QUEUE_ROUNDS; round++) {
    const raw = await call('GET', `/v0/management/usage-queue?count=${QUEUE_BATCH}`);
    const batch = Array.isArray(raw) ? raw as Record<string, any>[]
      : Array.isArray((raw as any)?.records) ? (raw as any).records : [];
    if (!batch.length) break;

    const rows: UsageRow[] = [];
    for (const r of batch) {
      const row = toUsageRow(r);
      if (row) { rows.push(row); if (row.failed) failedCount++; }
    }
    try {
      imported += insertRows(rows);
    } catch (err) {
      dumpFailedBatch(batch, err);
      throw err;
    }
    applyFailureSignals(batch);
  }
  return { imported, failed: failedCount };
}

/** Only a 429 means the account is out of quota; 5xx and TLS failures are upstream/network noise. */
function applyFailureSignals(batch: Record<string, any>[]): void {
  const hit = new Set<string>();
  for (const r of batch) {
    if (num(r.fail?.status_code) !== 429) continue;
    const name = accountOf(r);
    if (name) hit.add(name);
  }
  for (const name of hit) markLimited(name);
}

function markLimited(name: string): void {
  const row = db().prepare('SELECT status, window_reset_at FROM accounts WHERE name = ?')
    .get(name) as { status: string; window_reset_at: string | null } | undefined;
  if (!row) return;
  const reset = row.window_reset_at && Date.parse(row.window_reset_at) > Date.now() ? row.window_reset_at : null;
  const until = reset ?? new Date(Date.now() + LIMITED_FALLBACK_MS).toISOString();
  if (row.status === 'limited' && reset) return;
  db().prepare("UPDATE accounts SET status = 'limited', limited_until = ?, updated_at = ? WHERE name = ?")
    .run(until, nowIso(), name);
  if (row.status !== 'limited') {
    logEvent({ actor: 'system', kind: 'account.status', text: `账号「${name}」状态：${row.status} → limited（请求被上游限流 429）` });
  }
}

// ---------- cycle ----------

export type CycleResult = {
  ok: boolean; accounts: number; imported: number; failed: number; error?: string;
  migration?: Migration; skipped?: boolean;
};

/** 010: the sources panel can switch a source off without touching the connector itself. */
function sourceOff(id: string): boolean {
  const row = db().prepare('SELECT off FROM source_prefs WHERE id = ?').get(id) as { off: number } | undefined;
  return row?.off === 1;
}

export async function runCycle(): Promise<CycleResult> {
  const started = nowIso();
  let accounts = 0, imported = 0, failed = 0;
  let migration: Migration | undefined;
  // 010: switched off on the sources panel → do nothing, and do not report an error either.
  if (sourceOff('cliproxyapi')) return { ok: true, accounts: 0, imported: 0, failed: 0, skipped: true };
  try {
    const sync = await syncAccounts();
    accounts = sync.files.length;
    migration = sync.migration;
    const usage = await collectUsage();
    imported = usage.imported;
    failed = usage.failed;
    const cur = connectorState();
    saveState({ last_run: started, last_ok: nowIso(), last_error: '', imported: cur.imported + imported, failed: cur.failed + failed });
    return { ok: true, accounts, imported, failed, migration };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    saveState({ last_run: started, last_error: message });
    return { ok: false, accounts, imported, failed, error: message, migration };
  }
}

async function enableStatistics(): Promise<void> {
  try {
    await call('PUT', '/v0/management/usage-statistics-enabled', { value: true });
  } catch (err) {
    console.warn(`[cliproxyapi] 打开用量统计失败：${(err as Error).message}`);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startConnector(): void {
  if (!connectorEnabled()) return;
  void enableStatistics();
  const tick = () => { void runCycle().then((r) => {
    if (!r.ok) console.warn(`[cliproxyapi] 采集失败：${r.error}`);
  }); };
  tick();
  timer = setInterval(tick, pollSeconds() * 1000);
  timer.unref?.();
  console.log(`[cliproxyapi] 连接器已启用：${baseUrl()}，每 ${pollSeconds()} 秒采集一次`);
}

export function stopConnector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Recent request stats for the data page. 429 (quota) is reported apart from other failures. */
export function poolStats(days: number): { requests: number; failed: number; limited: number; other: number; avgLatency: number | null; byDay: { day: string; n: number; bad: number }[] } {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const row = db().prepare(`SELECT COUNT(*) n, IFNULL(SUM(failed), 0) bad,
      IFNULL(SUM(CASE WHEN fail_status = 429 THEN 1 ELSE 0 END), 0) limited,
      IFNULL(SUM(CASE WHEN failed = 1 AND IFNULL(fail_status, 0) <> 429 THEN 1 ELSE 0 END), 0) other,
      AVG(latency_ms) lat
    FROM usage WHERE executor = 'pool' AND source_key LIKE 'cpa:%' AND day >= ?`).get(since) as { n: number; bad: number; limited: number; other: number; lat: number | null };
  const byDay = db().prepare(`SELECT day, COUNT(*) n, IFNULL(SUM(failed), 0) bad FROM usage
    WHERE executor = 'pool' AND source_key LIKE 'cpa:%' AND day >= ? GROUP BY day ORDER BY day`).all(since) as { day: string; n: number; bad: number }[];
  return { requests: row.n, failed: row.bad, limited: row.limited, other: row.other, avgLatency: row.lat, byDay };
}
