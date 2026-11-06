// 014: one snapshot a day into a folder the user picks. Any cloud-drive sync folder works —
// the workbench never talks to a drive itself, it just writes a file and lets the client upload it.
//
// Rules that matter:
//  • the copy is built next to the final name as *.db.tmp, verified, then renamed — a syncing
//    client must never pick up half a database;
//  • `sessions` is emptied in the copy: those rows are as good as a password;
//  • the password fingerprint row goes too: with 015.4's scrypt it is no longer trivially
//    guessable, but it is still an offline witness to the password and a backup needs none;
//  • only files this feature wrote are ever deleted, and only beyond the newest 30.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { db } from '../db.ts';
import { minutesOfDay, nowIso, stampOf } from '../domain.ts';
import { logEvent, HttpError } from './core.ts';
import { redact, redactText } from './sources.ts';
import { remindOnce } from './tasks.ts';

/** How many snapshots stay on disk. Everything older goes, sidecar included. */
export const KEEP = 30;
/** A backup older than this is worth a reminder task. */
const STALE_DAYS = 3;
const DAY = 86400000;

/** Default 03:30 in WB_TZ. WB_BACKUP_AT=HH:MM moves it (also how the timer gets tested). */
export function slot(): string {
  const raw = (process.env.WB_BACKUP_AT ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return '03:30';
}
const slotMinute = () => Number(slot().slice(0, 2)) * 60 + Number(slot().slice(3));

export type BackupResult = {
  ok: boolean;
  /** File name, not the full path: the panel shows it next to the folder. */
  file: string;
  bytes: number;
  at: string;
  dir: string;
  reason: string;
  error?: string;
};

export type BackupStatus = {
  dir: string;
  hostDir: string;
  exists: boolean;
  last_run: string | null;
  last_ok: string | null;
  last_error: string;
  file: string;
  bytes: number;
  ok_count: number;
  fail_count: number;
  keep: number;
  at: string;
  name: string;
  version: string;
};

/** Inside Docker this is always /backups; only a bare `node src/server.ts` needs the env var. */
export function backupDir(): string {
  const explicit = (process.env.WB_BACKUP_PATH ?? '').trim();
  if (explicit) return explicit;
  // In Docker /backups is the volume mounted from WB_BACKUP_DIR, and it is the only path the
  // container can write to. Run bare (`npm start`) and there is no such mount, so honour the
  // folder the README tells people to set — otherwise the copy lands in C:\backups.
  if (existsSync('/.dockerenv')) return '/backups';
  return (process.env.WB_BACKUP_DIR ?? '').trim() || '/backups';
}

/** Project name in the file name. Anything a filesystem or a cloud client dislikes becomes '-'. */
export function backupName(): string {
  const raw = (process.env.WB_BACKUP_NAME ?? '').trim() || 'ai-workbench';
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ai-workbench';
}

/** The commit the image was built from; 'dev' when it was not told. */
export function buildVersion(): string {
  const raw = (process.env.WB_VERSION ?? '').trim() || 'dev';
  return raw.replace(/[^A-Za-z0-9._-]+/g, '') || 'dev';
}

type StateRow = { last_run: string | null; last_ok: string | null; last_error: string; imported: number; failed: number; detail: string };

function stateRow(): StateRow | undefined {
  return db().prepare('SELECT last_run, last_ok, last_error, imported, failed, detail FROM connector_state WHERE name = ?')
    .get('backup') as StateRow | undefined;
}

function detailOf(row: StateRow | undefined): { file?: string; bytes?: number } {
  try { return JSON.parse(row?.detail || '{}') as { file?: string; bytes?: number }; } catch { return {}; }
}

function saveState(p: { at: string; ok: boolean; file?: string; bytes?: number; error?: string }): void {
  const prev = stateRow();
  const imported = (prev?.imported ?? 0) + (p.ok ? 1 : 0);
  const failed = (prev?.failed ?? 0) + (p.ok ? 0 : 1);
  const lastOk = p.ok ? p.at : prev?.last_ok ?? null;
  const lastError = p.ok ? '' : String(p.error ?? '').slice(0, 500);
  const detail = p.ok ? JSON.stringify({ file: p.file ?? '', bytes: p.bytes ?? 0 }) : prev?.detail ?? '';
  db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed, detail)
    VALUES ('backup', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_ok = excluded.last_ok,
      last_error = excluded.last_error, imported = excluded.imported, failed = excluded.failed,
      detail = excluded.detail`)
    .run(p.at, lastOk, lastError, imported, failed, detail);
}

export function backupStatus(): BackupStatus {
  const row = stateRow();
  const detail = detailOf(row);
  const dir = backupDir();
  return {
    dir,
    hostDir: (process.env.WB_BACKUP_DIR ?? '').trim(),
    exists: existsSync(dir),
    last_run: row?.last_run ?? null,
    last_ok: row?.last_ok ?? null,
    last_error: row?.last_error ?? '',
    file: detail.file ?? '',
    bytes: detail.bytes ?? 0,
    ok_count: row?.imported ?? 0,
    fail_count: row?.failed ?? 0,
    keep: KEEP,
    at: slot(),
    name: backupName(),
    version: buildVersion(),
  };
}

/** SQLite has no bind parameters in VACUUM INTO, so the path is quoted by hand. */
const sqlPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`;

/** Names this feature writes; nothing else in the folder is ever touched. */
function ours(name: string): boolean {
  const esc = backupName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}_\\d{4}-\\d{2}-\\d{2}_\\d{4}_[A-Za-z0-9._-]+\\.db$`).test(name);
}

function listOurs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => ours(n)).sort().reverse(); // date_time in the name sorts by time
  } catch { return []; }
}

function prune(dir: string): number {
  const files = listOurs(dir);
  let removed = 0;
  for (const name of files.slice(KEEP)) {
    const base = join(dir, name);
    try {
      unlinkSync(base);
      const sidecar = `${base.slice(0, -3)}.json`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
      removed++;
    } catch { /* a file the drive client is holding open will go next time */ }
  }
  return removed;
}

/** Same minute, same name — the second click gets a suffix rather than an error. */
function uniquePath(dir: string, stem: string): string {
  let candidate = join(dir, `${stem}.db`);
  for (let i = 2; existsSync(candidate) || existsSync(`${candidate}.tmp`); i++) {
    candidate = join(dir, `${stem}_${i}.db`);
  }
  return candidate;
}

/** Every copy that leaves the workbench loses these rows: sessions are as good as a password,
 *  and the password fingerprint is an offline witness to it. Startup re-remembers the fingerprint
 *  ('first') without dropping any session, so scrubbing costs nothing. */
export function scrubCopy(copy: DatabaseSync): void {
  copy.exec('DELETE FROM sessions');
  copy.prepare(`DELETE FROM connector_state WHERE name = 'auth.password_fingerprint'`).run();
}

function counts(file: string): { tasks: number; approvals: number; usage: number; accounts: number; migrations: number } {
  const copy = new DatabaseSync(file);
  try {
    const one = (sql: string) => Number((copy.prepare(sql).get() as { n: number }).n);
    const migrations = Number((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    scrubCopy(copy);
    // The order matters: verify after the edit, or the check says nothing about the file we keep.
    const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (check.integrity_check !== 'ok') throw new Error(`副本校验没通过：${check.integrity_check}`);
    return {
      tasks: one('SELECT COUNT(*) n FROM tasks'),
      approvals: one('SELECT COUNT(*) n FROM approvals'),
      usage: one('SELECT COUNT(*) n FROM usage'),
      accounts: one('SELECT COUNT(*) n FROM accounts'),
      migrations,
    };
  } finally { copy.close(); }
}

export function runBackup(reason: 'manual' | 'daily' | 'catch-up' = 'daily'): BackupResult {
  const at = nowIso();
  const dir = backupDir();
  const { date, time } = stampOf(new Date(at));
  const stem = `${backupName()}_${date}_${time}_${buildVersion()}`;
  let file = '';
  try {
    mkdirSync(dir, { recursive: true });
    const target = uniquePath(resolve(dir), stem);
    file = basename(target);
    const tmp = `${target}.tmp`;
    db().exec(`VACUUM INTO ${sqlPath(tmp)}`);
    const info = counts(tmp);
    const bytes = statSync(tmp).size;
    renameSync(tmp, target);
    // The sidecar is what makes the folder readable months later, without opening a database.
    writeFileSync(`${target.slice(0, -3)}.json`, JSON.stringify({
      project: backupName(),
      file,
      at,
      local_time: `${date} ${time.slice(0, 2)}:${time.slice(2)}`,
      timezone: process.env.WB_TZ ?? 'Asia/Shanghai',
      version: buildVersion(),
      migrations: info.migrations,
      counts: { tasks: info.tasks, approvals: info.approvals, usage: info.usage, accounts: info.accounts },
      bytes,
      note: '登录会话已从副本中删除；恢复后需要重新登录。',
    }, null, 2));
    const pruned = prune(resolve(dir));
    saveState({ at, ok: true, file, bytes });
    logEvent({
      actor: 'system', kind: 'backup.ok',
      text: `备份完成：${file}（${Math.round(bytes / 1024)} KB${pruned ? `，清掉 ${pruned} 份旧备份` : ''}）`,
    });
    return { ok: true, file, bytes, at, dir, reason };
  } catch (err) {
    const raw = String((err as Error)?.message ?? err);
    const error = redactText(raw).slice(0, 300);
    saveState({ at, ok: false, error });
    logEvent({ actor: 'system', kind: 'backup.failed', text: `备份失败（${dir}）：${redact(error)}` });
    checkStale();
    return { ok: false, file, bytes: 0, at, dir, reason, error };
  }
}

/**
 * Three days without a successful snapshot is worth a task. One reminder per reason: the key
 * carries a short digest of the error, so a fixed problem and a new one are told apart.
 */
export function checkStale(now = Date.now()): boolean {
  const st = backupStatus();
  const last = st.last_ok ? Date.parse(st.last_ok) : NaN;
  const days = Number.isFinite(last) ? Math.floor((now - last) / DAY) : null;
  const neverFailedYet = !st.last_ok && st.fail_count === 0;
  if (neverFailedYet) return false; // fresh install, nothing to nag about before the first try
  if (days !== null && days < STALE_DAYS) return false;
  const reason = st.last_error ? redact(st.last_error) : '没有成功记录';
  const digest = createHash('sha1').update(reason).digest('hex').slice(0, 8);
  const when = days === null ? '还没有成功备份过' : `上次成功是 ${days} 天前（${st.last_ok?.slice(0, 10) ?? '—'}）`;
  return remindOnce(
    `backup:stale:${digest}`,
    `工作台已经${days === null ? '很久' : ` ${days} 天`}没备份成功：${reason}`,
    `${when}。备份目录：${st.dir}。错误：${reason}\n\n修好后点设置页的「立即备份」确认一次。`,
  );
}

// ---------- scheduling ----------

let daily: NodeJS.Timeout | null = null;

export function stopBackup(): void {
  if (daily) clearTimeout(daily);
  daily = null;
}

/** Milliseconds until the next slot in WB_TZ — always in the future, never 0. */
export function msUntilNext(now = new Date()): number {
  const left = ((slotMinute() - minutesOfDay(now) + 24 * 60) % (24 * 60)) * 60_000;
  return left === 0 ? 24 * 60 * 60_000 : left;
}

function scheduleNext(): void {
  daily = setTimeout(() => {
    const r = runBackup('daily');
    if (!r.ok) console.warn(`[backup] 定时备份失败：${r.error}`);
    scheduleNext();
  }, msUntilNext());
  daily.unref?.();
}

/** On boot: a snapshot older than a day means the machine was off at the slot — take one now. */
export function catchUpIfStale(now = Date.now()): BackupResult | null {
  const st = backupStatus();
  const last = st.last_ok ? Date.parse(st.last_ok) : NaN;
  if (Number.isFinite(last) && now - last <= DAY) return null;
  const r = runBackup('catch-up');
  console.log(`[backup] 启动补备份：${r.ok ? r.file : `失败（${r.error}）`}`);
  return r;
}

export function startBackup(): void {
  if (process.env.WB_BACKUP_OFF === '1') {
    console.log('[backup] 已关闭（WB_BACKUP_OFF=1）');
    return;
  }
  // A tick later, so a slow disk never delays the first HTTP response.
  const kick = setTimeout(() => { catchUpIfStale(); checkStale(); }, 1500);
  kick.unref?.();
  scheduleNext();
  console.log(`[backup] 每天 ${slot()} 备份到 ${backupDir()}，保留 ${KEEP} 份`);
}

/** A person clicked the button; a failure has to reach the page as an error, not a silent row. */
export function runManualBackup(): BackupResult {
  const r = runBackup('manual');
  if (!r.ok) throw new HttpError(500, `备份失败：${r.error}`);
  return r;
}
