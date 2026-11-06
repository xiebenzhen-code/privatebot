// Single-user auth, two separate credentials:
// - WB_TOKEN: scripts and agents (`Authorization: Bearer …`).
// - WB_PASSWORD: the human, typed into the login page.
// A successful login creates a random server-side session; the cookie is an unguessable id,
// never a value derived from either secret.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { db } from './db.ts';
import { logEvent } from './services/core.ts';

const TOKEN = process.env.WB_TOKEN ?? '';
const PASSWORD = process.env.WB_PASSWORD ?? '';
export const AUTH_DISABLED = process.env.WB_NO_AUTH === '1';
export const COOKIE = 'wb_session';
const SESSION_DAYS = 30;

export function authConfigured(): boolean {
  return AUTH_DISABLED || TOKEN.length >= 12;
}

/** The login page is useless without a password; say so instead of pretending. */
export const passwordConfigured = (): boolean => AUTH_DISABLED || PASSWORD.length >= 12;

export function passwordProblem(): string {
  if (AUTH_DISABLED) return '';
  if (!PASSWORD) return '还没设置 WB_PASSWORD（至少 12 位），网页登录已关闭。在 .env 里加一行 WB_PASSWORD=… 后重启。';
  if (PASSWORD.length < 12) return 'WB_PASSWORD 太短（至少 12 位），网页登录已关闭。';
  if (PASSWORD === TOKEN) return 'WB_PASSWORD 不能和 WB_TOKEN 相同，两者要分别设置。';
  return '';
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const checkToken = (t: string) => !!TOKEN && same(t, TOKEN);
export const checkPassword = (p: string) => !!PASSWORD && PASSWORD.length >= 12 && PASSWORD !== TOKEN && same(p, PASSWORD);

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- server-side sessions ----------

export function createSession(): string {
  const id = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db().prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)')
    .run(id, now.toISOString(), expires.toISOString());
  db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString()); // housekeeping
  return id;
}

export function sessionValid(id: string): boolean {
  if (!id) return false;
  const row = db().prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as { expires_at: string } | undefined;
  if (!row) return false;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db().prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return false;
  }
  return true;
}

export function destroySession(id: string): void {
  if (id) db().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ---------- password fingerprint: changing the password logs every browser out ----------
// A session is a random id in the database, unrelated to the password by design. That means a
// leaked password could be replaced and the attacker's already-open browser would keep working,
// which is the opposite of what "change the password" is supposed to buy you. So we remember a
// salted hash of the current password (never the password) and drop all sessions when it changes.
// 015.4: the stored fingerprint is now scrypt (slow) with a fresh random salt per record, so the
// stored value no longer tolerates fast offline guessing of a weak password. The earlier sha256
// fingerprint (fixed salt) is verified and silently upgraded in place — no session is dropped.
const FP_NAME = 'auth.password_fingerprint';
const FP_SALT = 'ai-workbench/password-fingerprint/v1'; // fixed salt of the legacy sha256 record

const hashSlow = (password: string, saltHex: string): string =>
  scryptSync(password, Buffer.from(saltHex, 'hex'), 32).toString('hex');

const newRecord = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${hashSlow(password, salt)}`;
};

const matchesRecord = (password: string, record: string): boolean => {
  if (record.startsWith('scrypt:')) {
    const [, salt, hash] = record.split(':');
    if (!salt || !hash) return false;
    return same(hashSlow(password, salt), hash);
  }
  const legacy = createHash('sha256').update(FP_SALT).update('\0').update(password).digest('hex');
  return same(legacy, record);
};

/** Called once at startup. 'off' = auth disabled or no password; 'first' = nothing to compare, just remember. */
export function syncPasswordFingerprint(password: string = PASSWORD): 'off' | 'first' | 'same' | 'changed' {
  if (AUTH_DISABLED || !password) return 'off';
  const record = newRecord(password);
  const row = db().prepare('SELECT detail FROM connector_state WHERE name = ?').get(FP_NAME) as { detail: string } | undefined;
  const prev = (row?.detail ?? '').trim();
  const ts = new Date().toISOString();
  const save = () => db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed, detail)
      VALUES (?, ?, ?, '', 0, 0, ?)
      ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, detail = excluded.detail`)
    .run(FP_NAME, ts, ts, record);

  if (!prev) { save(); return 'first'; }   // first run on this database: remember, never delete
  if (matchesRecord(password, prev)) {
    if (!prev.startsWith('scrypt:')) save(); // legacy sha256 record: upgrade in place, sessions stay
    return 'same';
  }
  const n = db().prepare('DELETE FROM sessions').run().changes;
  save();
  logEvent({ actor: 'system', kind: 'auth.password_changed', text: `WB_PASSWORD 换过了，已清掉 ${n} 个已登录的浏览器会话` });
  return 'changed';
}

export const sessionCookieFor = (id: string, secure: boolean): string =>
  `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}${secure ? '; Secure' : ''}`;

/** 'bearer' | 'cookie' | 'off' | null */
export function authOf(req: IncomingMessage): 'bearer' | 'cookie' | 'off' | null {
  if (AUTH_DISABLED) return 'off';
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ') && checkToken(h.slice(7).trim())) return 'bearer';
  const c = cookies(req)[COOKIE];
  if (c && sessionValid(c)) return 'cookie';
  return null;
}

export const sessionIdOf = (req: IncomingMessage): string => cookies(req)[COOKIE] ?? '';

/** Cookie-authenticated writes must come from our own pages (blocks cross-site form posts). */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Naive brute-force brake for the login form.
const failures = new Map<string, { n: number; until: number }>();
export function loginBlocked(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.n >= 8 && Date.now() < f.until;
}
export function loginFailed(ip: string): void {
  const f = failures.get(ip) ?? { n: 0, until: 0 };
  f.n += 1; f.until = Date.now() + 10 * 60 * 1000;
  failures.set(ip, f);
}
export function loginOk(ip: string): void { failures.delete(ip); }

export const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
