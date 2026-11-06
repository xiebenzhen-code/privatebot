// 019: the morning digest — one comment a day on a fixed Issue, so the decision side can read
// it before the user opens anything. Optional, off by default, and write-only: nothing here
// ever reads the Issue back, and no comment on it is treated as a command.
import { db } from '../db.ts';
import { dayOf, fmtTokens, lastDays, nowIso } from '../domain.ts';
import { logEvent } from './core.ts';
import { getSetting, setSetting } from './dispatch.ts';
import { listApprovals } from './approvals.ts';
import { listAccounts, tokensBetween } from './metrics.ts';
import { runnerOnline } from './runner.ts';
import { stuckFor } from './stage.ts';
import { needsAttention, redact, redactText } from './sources.ts';
import { backupStatus } from './backup.ts';
import { enqueueGithub, type Delivery, type GithubJob } from './github-outbox.ts';

const STATE = 'digest';
const DEFAULT_REPO = () => (process.env.GITHUB_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean)[0] ?? '';
export type DigestSettings = {
  on: boolean;
  repo: string;
  at: string;
  titles: boolean;
  last_ok: string;
  last_error: string;
  last_day: string;
  issue: string;
  next_try: string;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const REPO_OK = /^[\w.-]+\/[\w.-]+$/;

export function digestSettings(): DigestSettings {
  const row = db().prepare('SELECT * FROM connector_state WHERE name = ?').get(STATE) as
    { last_run?: string; last_ok?: string; last_error?: string } | undefined;
  const detail = (() => {
    try { return JSON.parse(getSetting('digest.detail', '{}')) as { issue?: string; last_day?: string; next_try?: string }; } catch { return {}; }
  })();
  return {
    on: getSetting('digest.on') === '1',
    repo: getSetting('digest.repo', DEFAULT_REPO()),
    at: getSetting('digest.at', '08:00'),
    titles: getSetting('digest.titles') === '1',
    last_ok: row?.last_ok ?? '',
    last_error: row?.last_error ?? '',
    last_day: detail.last_day ?? '',
    issue: detail.issue ?? '',
    next_try: detail.next_try ?? '',
  };
}

export function saveDigestSettings(input: Record<string, unknown>): DigestSettings {
  const at = String(input.at ?? '08:00');
  if (!HHMM.test(at)) throw new Error('发送时间要写成 HH:MM，例如 08:00');
  const repo = String(input.repo ?? DEFAULT_REPO()).trim();
  if (input.on === true && !REPO_OK.test(repo)) throw new Error('仓库要写成 用户名/仓库名');
  if (repo && !REPO_OK.test(repo)) throw new Error('仓库要写成 用户名/仓库名');
  setSetting('digest.on', input.on === true ? '1' : '0');
  setSetting('digest.repo', repo);
  setSetting('digest.at', at);
  setSetting('digest.titles', input.titles === true ? '1' : '0');
  logEvent({ actor: 'me', kind: 'digest.settings', text: `日报：${input.on === true ? '开' : '关'}，${at}，仓库 ${repo || '未填'}，标题${input.titles === true ? '带' : '不带'}` });
  return digestSettings();
}

function saveState(patch: { last_ok?: string; last_error?: string; issue?: string; last_day?: string; next_try?: string }): void {
  const cur = db().prepare('SELECT * FROM connector_state WHERE name = ?').get(STATE) as { last_run?: string; last_ok?: string; last_error?: string; imported?: number; failed?: number } | undefined;
  const detail = (() => {
    try { return JSON.parse(getSetting('digest.detail', '{}')) as { issue?: string; last_day?: string; next_try?: string }; } catch { return {}; }
  })();
  const nextDetail = {
    issue: patch.issue ?? detail.issue ?? '',
    last_day: patch.last_day ?? detail.last_day ?? '',
    // 019.1: '' means the backoff is cleared; undefined keeps whatever was there.
    next_try: patch.next_try === '' ? '' : (patch.next_try ?? detail.next_try ?? ''),
  };
  setSetting('digest.detail', JSON.stringify(nextDetail));
  db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_ok = excluded.last_ok,
      last_error = excluded.last_error, imported = excluded.imported, failed = excluded.failed`)
    .run(STATE, nowIso(), patch.last_ok ?? cur?.last_ok ?? '', patch.last_error ?? '', cur?.imported ?? 0, cur?.failed ?? 0);
}

/** When the timer may try again after a failure. Empty string = free to go. */
const nextTryAt = (): string => {
  try { return (JSON.parse(getSetting('digest.detail', '{}')) as { next_try?: string }).next_try ?? ''; } catch { return ''; }
};

// ---------- content ----------

type Counts = {
  done: number; failed: number; tokens: number; pending: number; risk: string;
  mine: number; stuck: number; runner: boolean; low: string[]; backup: string; action: number;
  backup_days: number | null; // null = a backup has never succeeded
};

const count = (sql: string, ...args: (string | number)[]): number =>
  (db().prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;

/** Everything a person would want to know before opening the workbench, from the same tables. */
export function digestCounts(now = new Date()): Counts {
  const today = dayOf(now);
  const yesterday = dayOf(new Date(now.getTime() - 86400000));
  void today;
  const doneYday = (db().prepare(`SELECT completed_at FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?`)
    .all(new Date(now.getTime() - 3 * 86400000).toISOString()) as { completed_at: string }[])
    .filter((r) => dayOf(r.completed_at) === yesterday).length;
  const failedYday = (db().prepare(`SELECT updated_at FROM tasks WHERE status = 'failed' AND updated_at >= ?`)
    .all(new Date(now.getTime() - 3 * 86400000).toISOString()) as { updated_at: string }[])
    .filter((r) => dayOf(r.updated_at) === yesterday).length;
  const pending = listApprovals({ status: 'pending', limit: 200 });
  const risk = pending.some((a) => a.risk === 'high') ? 'high' : pending.some((a) => a.risk === 'medium') ? 'medium' : pending.length ? 'low' : '';
  const running = db().prepare(`SELECT status, executor, updated_at FROM tasks WHERE status = 'running'`).all() as
    { status: string; executor: string; updated_at: string }[];
  const low = listAccounts()
    .filter((a) => (a.kind === 'balance' && a.balance !== null && a.low_threshold !== null && a.balance < a.low_threshold)
      || a.status === 'near' || a.status === 'limited')
    .map((a) => a.name);
  const b = backupStatus();
  const days = b.last_ok ? Math.floor((now.getTime() - Date.parse(b.last_ok)) / 86400000) : -1;
  return {
    done: doneYday,
    failed: failedYday,
    tokens: tokensBetween(yesterday, yesterday),
    pending: pending.length,
    risk,
    mine: count(`SELECT COUNT(*) n FROM tasks WHERE executor = 'me' AND status NOT IN ('done', 'failed')`),
    stuck: running.filter((t) => stuckFor(t as never)).length,
    runner: runnerOnline(),
    low,
    backup: days < 0 ? '还没成功备份过' : days === 0 ? '今天备份过' : `${days} 天前成功备份`,
    backup_days: days < 0 ? null : days,
    action: needsAttention(),
  };
}

const RISK_WORD: Record<string, string> = { high: '高', medium: '中', low: '低' };

/**
 * 019.1: for digest titles, redacting secrets is not enough — the spec forbids commands and
 * paths too. `redactText` only masks credentials, so titles get an extra pass: absolute paths
 * collapse to … and obvious command invocations keep only the program name.
 */
function stripPathsAndCommands(t: string): string {
  return redactText(t)
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g, '…')
    .replace(/\b(npm|npx|pnpm|yarn|git|docker|node|python3?|pip|curl|wget|ssh|scp|rm|mv|cp)\b\s+[^\n,，;；]*/gi, '$1 …');
}

/** Titles are opt-in and only for the three things someone has to act on. */
function titleLines(c: Counts): string[] {
  const rows = db().prepare(`SELECT id, title, status FROM tasks
    WHERE status IN ('failed', 'review', 'asking')
    ORDER BY updated_at DESC LIMIT 5`).all() as { id: number; title: string; status: string }[];
  const stuck = db().prepare(`SELECT id, title, status, executor, updated_at FROM tasks WHERE status = 'running'`)
    .all() as { id: number; title: string; status: string; executor: string; updated_at: string }[];
  const stuckIds = new Set(stuck.filter((t) => stuckFor(t as never)).map((t) => t.id));
  const pick = rows.filter((r) => r.status === 'failed' || r.status === 'review' || r.status === 'asking');
  const lines = pick.map((r) => `- T-${r.id} ${r.status === 'failed' ? '失败' : r.status === 'asking' ? '等你选' : '等审批'}：${stripPathsAndCommands(r.title).slice(0, 80)}`);
  for (const t of stuck) {
    if (!stuckIds.has(t.id)) continue;
    lines.push(`- T-${t.id} 可能卡住：${stripPathsAndCommands(t.title).slice(0, 80)}`);
  }
  void c;
  return lines.slice(0, 6);
}

export function buildDigest(opts: { now?: Date; titles?: boolean; late?: boolean } = {}): string {
  const now = opts.now ?? new Date();
  const c = digestCounts(now);
  const day = dayOf(now);
  const head = `工作台日报 · ${day}${opts.late ? '（补发）' : ''}`;
  // 019.1: "nothing to do" must be a real all-clear — a stale backup, a low account or an
  // integration waiting on the user each break the quiet, otherwise the quiet line would
  // bury exactly the problems the digest exists to surface. The runner being off is NOT a
  // problem by itself (nothing to run), so it only shows in a non-quiet digest.
  const backupStale = c.backup_days === null || c.backup_days > 3;
  const quiet = !c.pending && !c.mine && !c.stuck && !c.failed && !backupStale && c.low.length === 0 && c.action === 0;
  const url0 = getSetting('public_url');
  if (quiet) return [`${head}`, '', '没有等你的事。', ...(url0 ? ['', `打开工作台处理：${url0}`] : [])].join('\n');

  const lines = [head, ''];
  lines.push(`**昨天**：完成 ${c.done} 个，失败 ${c.failed} 个，用了 ${fmtTokens(c.tokens)} token。`);
  lines.push('');
  lines.push('**等你处理**');
  lines.push(`- 待审批 ${c.pending} 条${c.risk ? `（最高风险：${RISK_WORD[c.risk]}）` : ''}`);
  lines.push(`- 你亲自要做的 ${c.mine} 条`);
  if (c.stuck) lines.push(`- 可能卡住 ${c.stuck} 个`);
  const titles = opts.titles ? titleLines(c) : [];
  if (titles.length) lines.push('', '**具体这些**', ...titles);
  lines.push('', `**执行器**：${c.runner ? '在线' : '没开'}`);
  if (c.low.length) lines.push(`**额度**：${c.low.map((n) => redact(n)).join('、')} 偏低`);
  lines.push(`**备份**：${c.backup}`);
  if (c.action) lines.push(`**接入**：${c.action} 项等你操作`);
  const url = getSetting('public_url');
  if (url) lines.push('', `打开工作台处理：${url}`);
  return lines.join('\n').slice(0, 1900);
}

export type DigestResult = { ok: boolean; queued?: boolean; skipped?: boolean; issue?: string; error?: string };

export async function sendDigest(opts: { manual?: boolean; now?: Date; late?: boolean } = {}): Promise<DigestResult> {
  const s = digestSettings();
  if (!s.repo) {
    const error = '没配日报仓库';
    saveState({ last_error: error });
    return { ok: false, error };
  }
  const day = dayOf(opts.now ?? new Date());
  const subject = JSON.stringify({ day, manual: !!opts.manual, late: !!opts.late });
  enqueueGithub({ repo: s.repo, kind: 'digest', body: buildDigest({ now: opts.now, titles: s.titles, late: opts.late }),
    subject, dedupe: 'digest:' + s.repo + ':' + day, retryNow: opts.manual }, opts.now);
  return { ok: true, queued: true };
}

export function recordDigestDelivery(job: GithubJob, result: Delivery): void {
  if (!result.ok) {
    if (result.error !== digestSettings().last_error) {
      logEvent({ actor: 'system', kind: 'digest.failed', text: '日报没发出去：' + result.error });
    }
    saveState({ last_error: result.error, next_try: result.nextTry });
    return;
  }
  const subject = JSON.parse(job.subject) as { day: string; late: boolean; manual: boolean };
  const issue = 'https://github.com/' + job.repo + '/issues/' + result.issueNumber;
  saveState({ last_ok: result.now, last_error: '', issue, last_day: subject.day, next_try: '' });
  logEvent({ actor: 'system', kind: 'digest.sent', text: '日报已发到 #' + result.issueNumber + (subject.late ? '（补发）' : '') });
}

/** Minutes since midnight in the display time zone, so `at` means the same thing everywhere. */
function minutesNow(now: Date): number {
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.WB_TZ || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Has today's gone out already? Restarts must not send twice. */
const sentToday = (now: Date): boolean => digestSettings().last_day === dayOf(now);

/**
 * Called on a timer. Sends when the clock passes `at` and today has no digest yet — a machine
 * that was off at 8:00 sends one late (marked 补发) the next time it wakes up.
 */
export async function maybeRunDigest(now = new Date()): Promise<DigestResult> {
  const s = digestSettings();
  if (!s.on) return { ok: false, skipped: true };
  if (sentToday(now)) return { ok: true, skipped: true };
  const [h, m] = s.at.split(':').map(Number);
  const due = h * 60 + m;
  if (minutesNow(now) < due) return { ok: true, skipped: true };
  // 019.1: inside the backoff window the timer stays quiet; the retry after it is one attempt.
  const waitUntil = nextTryAt();
  if (waitUntil && Date.parse(waitUntil) > now.getTime()) return { ok: true, skipped: true };
  const late = minutesNow(now) > due + 10;
  return sendDigest({ now, late });
}

export function startDigest(): void {
  const tick = async () => { try { await maybeRunDigest(); } catch { /* the digest must never break the app */ } };
  void tick();
  setInterval(tick, 60_000).unref?.();
}

/** Kept for the settings page: how many days the backup is behind, in words. */
export const backupLine = (): string => digestCounts().backup;
