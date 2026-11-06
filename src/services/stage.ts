// 018: one line that answers "where is this task". Everything is derived from fields we already
// have — status, the pending approval, `merged_commit` — so no new status and no new migration.
import { db } from '../db.ts';
import type { Task } from './tasks.ts';
import { redact } from './sources.ts';

export type StageKey =
  | 'inbox' | 'queued' | 'running' | 'ask' | 'approve' | 'merge'
  | 'merged' | 'push' | 'pushed' | 'done' | 'failed';

export type StageTone = '' | 'ok' | 'warn' | 'bad' | 'info';

type StageDef = { label: string; step: number; tone: StageTone };

/** `step` is the position on the progress bar (0–6); -1 means "not on it" (收件箱 / 失败). */
const STAGES: Record<StageKey, StageDef> = {
  inbox: { label: '收件 · 待分派', step: -1, tone: '' },
  queued: { label: '排队', step: 0, tone: '' },
  running: { label: '运行中', step: 1, tone: 'info' },
  ask: { label: '等你选', step: 1, tone: 'warn' }, // 055.2：运行到一半停下来问你
  approve: { label: '等你批准', step: 2, tone: 'warn' },
  merge: { label: '等你批准（合并）', step: 2, tone: 'warn' },
  merged: { label: '已合并', step: 3, tone: 'info' },
  push: { label: '等你批准（推送）', step: 4, tone: 'warn' },
  pushed: { label: '已推送', step: 5, tone: 'ok' },
  done: { label: '完成', step: 6, tone: 'ok' },
  failed: { label: '失败', step: -1, tone: 'bad' },
};

/** The happy path, in order. Two of the seven cells are approvals, not actions. */
export const STAGE_FLOW = ['排队', '运行中', '等你批准（合并）', '已合并', '等你批准（推送）', '已推送', '完成'];

export const stageDef = (k: StageKey): StageDef => STAGES[k];
export const stageLabel = (k: StageKey): string => STAGES[k].label;

/** The merge/push approvals are ordinary rows with these tool names (see runner.finishTask). */
export const MERGE_TOOL = 'git merge';
export const PUSH_TOOL = 'git push';

const TOOLS: Record<string, StageKey> = { [MERGE_TOOL]: 'merge', [PUSH_TOOL]: 'push' };

/** Which stage a task is in, given the tool names of its pending approvals. */
export function stageOf(t: Pick<Task, 'status' | 'step' | 'merged_commit'>, tools: string[] = []): StageKey {
  if (t.status === 'failed') return 'failed';
  if (t.status === 'inbox') return 'inbox';
  if (t.status === 'queued') return 'queued';
  if (t.status === 'running') return 'running';
  if (t.status === 'asking') return 'ask';
  // Waiting on a person: the approval says which step it is gating.
  const pending = tools.map((x) => TOOLS[x]).filter(Boolean) as StageKey[];
  if (pending.includes('push')) return 'push';
  if (pending.includes('merge')) return 'merge';
  if (t.status === 'review') return 'approve';
  // Done: how far did it get? `merged_commit` is written by the runner after the merge landed.
  if (t.merged_commit) return /已推送/.test(t.step) ? 'pushed' : 'merged';
  return 'done';
}

const CHUNK = 400;

/** Pending approval tool names for a batch of tasks — one query per 400 ids, not one per task. */
export function pendingTools(ids: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const rows = db().prepare(`SELECT task_id, tool_name FROM approvals
      WHERE status = 'pending' AND task_id IN (${part.map(() => '?').join(',')})`).all(...part) as
      { task_id: number; tool_name: string }[];
    for (const r of rows) out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.tool_name]);
  }
  return out;
}

export const stageOfTask = (t: Pick<Task, 'id' | 'status' | 'step' | 'merged_commit'>): StageKey =>
  stageOf(t, pendingTools([t.id]).get(t.id) ?? []);

/** Runner-side wall clock for one task; the workbench's per-executor limit when it has one. */
function maxMinutes(executor: string): number {
  const row = db().prepare('SELECT max_minutes FROM executor_settings WHERE executor = ?').get(executor) as
    { max_minutes: number | null } | undefined;
  return row?.max_minutes ?? 45; // the runner's own default when nothing is configured here
}

/**
 * 018: running and silent for twice the executor's time limit. The progress reports bump
 * `updated_at`, so silence means the process is gone (killed, machine slept, runner closed).
 */
export function stuckFor(t: Pick<Task, 'status' | 'executor' | 'updated_at'>): { minutes: number; limit: number } | null {
  if (t.status !== 'running') return null;
  const limit = maxMinutes(t.executor) * 2;
  const minutes = Math.floor((Date.now() - Date.parse(t.updated_at)) / 60000);
  return Number.isFinite(minutes) && minutes >= limit ? { minutes, limit } : null;
}

const BACKENDS: Record<string, string> = { bailian: '百炼', deepseek: 'DeepSeek 官方' };

/** 017 stores the raw backend id; the UI says the name a person recognises. */
export const backendLabel = (k: string | null | undefined): string => (k ? BACKENDS[k] ?? k : '');

/**
 * 018.2: the last automatic backend switch, redacted — the reason is an upstream error body.
 * Old rows carry no task_id (the runner only sent text), so the `T-<id>：` prefix is the fallback.
 */
export function backendSwitchNote(taskId: number): string {
  const row = db().prepare(`SELECT text FROM events WHERE kind = 'runner.backend_fallback'
    AND (task_id = ? OR text LIKE ? OR text LIKE ?) ORDER BY id DESC LIMIT 1`)
    .get(taskId, `T-${taskId}：%`, `T-${taskId}:%`) as { text: string } | undefined;
  if (!row) return '';
  const text = row.text.replace(/^T-\d+[：:]\s*/, '').replace(/\b(bailian|deepseek)\b/g, (m) => BACKENDS[m] ?? m);
  return redact(text);
}
