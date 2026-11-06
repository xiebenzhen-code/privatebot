// Events (audit log), errors, and small coercion helpers used by every service.
import { db } from '../db.ts';
import { nowIso } from '../domain.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type EventRow = {
  id: number; ts: string; actor: string; kind: string;
  task_id: number | null; approval_id: number | null; text: string;
};

export function logEvent(e: { actor: string; kind: string; text: string; task_id?: number | null; approval_id?: number | null }): void {
  db().prepare('INSERT INTO events (ts, actor, kind, task_id, approval_id, text) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(), e.actor, e.kind, e.task_id ?? null, e.approval_id ?? null, e.text);
}

export function listEvents(opts: { limit?: number; task_id?: number } = {}): EventRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  if (opts.task_id) {
    return db().prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(opts.task_id, limit) as EventRow[];
  }
  return db().prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as EventRow[];
}

export function str(v: unknown, max = 2000): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v).slice(0, max);
}
export function int(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `不是数字：${v}`);
  return Math.round(n);
}
export function oneOf(v: unknown, allowed: string[], field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (!allowed.includes(s)) throw new HttpError(400, `${field} 只能是 ${allowed.join(' / ')}`);
  return s;
}
