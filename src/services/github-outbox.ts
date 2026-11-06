import { randomUUID } from 'node:crypto';
import { db, tx } from '../db.ts';
import { HttpError, logEvent } from './core.ts';
import { redactText } from './redact.ts';

export const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
export type GithubJob = {
  id: number; message_key: string; repo: string; issue_number: number;
  kind: 'comment' | 'selfdev' | 'digest'; body: string; subject: string;
  attempts: number; lease: string; available_at: string; last_error: string; sent_at: string;
};

export function enqueueGithub(job: Pick<GithubJob, 'repo' | 'kind' | 'body'> &
  Partial<Pick<GithubJob, 'issue_number' | 'subject'>> & { dedupe?: string; retryNow?: boolean }, now = new Date()): void {
  if (!GITHUB_REPO.test(job.repo)) throw new HttpError(400, '仓库要写成 用户名/仓库名');
  db().prepare(`INSERT OR IGNORE INTO github_outbox
    (message_key, dedupe, repo, issue_number, kind, body, subject, available_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), job.dedupe ?? null, job.repo, job.issue_number ?? 0, job.kind,
      redactText(job.body).replace(/^(\s*)\/wb\b/gm, '$1／wb').slice(0, 3000), job.subject ?? '', now.toISOString());
  if (job.retryNow && job.dedupe) {
    db().prepare("UPDATE github_outbox SET available_at = ? WHERE dedupe = ? AND sent_at = '' AND lease = ''")
      .run(now.toISOString(), job.dedupe);
  }
}

export function claimGithubJob(now = new Date()) {
  return tx(() => {
    const at = now.toISOString();
    const row = db().prepare(`SELECT * FROM github_outbox WHERE sent_at = '' AND available_at <= ?
      AND NOT EXISTS (SELECT 1 FROM github_outbox WHERE sent_at = '' AND lease <> '' AND available_at > ?)
      ORDER BY id LIMIT 1`).get(at, at) as GithubJob | undefined;
    if (!row) return null;
    const lease = randomUUID();
    const attempts = row.attempts + 1;
    db().prepare('UPDATE github_outbox SET lease = ?, attempts = ?, available_at = ? WHERE id = ?')
      .run(lease, attempts, new Date(now.getTime() + 5 * 60_000).toISOString(), row.id);
    return { id: row.id, message_key: row.message_key, repo: row.repo, issue_number: row.issue_number,
      kind: row.kind, body: row.body, attempts, lease };
  });
}

export type Delivery = { ok: boolean; issueNumber: number; commentId: number; error: string; nextTry: string; now: string };

export function finishGithubJob(id: number, payload: Record<string, unknown>,
  onResult: (job: GithubJob, result: Delivery) => void, date = new Date()): boolean {
  return tx(() => {
    const job = db().prepare("SELECT * FROM github_outbox WHERE id = ? AND sent_at = '' AND lease = ? AND lease <> ''")
      .get(id, String(payload.lease ?? '')) as GithubJob | undefined;
    if (!job) return false;
    const ok = payload.ok === true;
    const issueNumber = Number(payload.issue_number);
    const commentId = Number(payload.comment_id);
    const valid = (n: number) => Number.isSafeInteger(n) && n > 0;
    if (ok && (!valid(issueNumber) || !valid(commentId) || (job.issue_number && job.issue_number !== issueNumber))) {
      throw new HttpError(400, '回写结果缺少有效 Issue 或评论编号');
    }
    const now = date.toISOString();
    const error = ok ? '' : (redactText(String(payload.error ?? '')).replace(/[\r\n]/g, ' ').slice(0, 160) || '执行器回写失败');
    const nextTry = ok ? '' : new Date(date.getTime() + Math.min(120, 30 * 2 ** Math.min(job.attempts - 1, 2)) * 60_000).toISOString();
    db().prepare("UPDATE github_outbox SET lease = '', available_at = ?, last_error = ?, sent_at = ? WHERE id = ?")
      .run(nextTry || now, error, ok ? now : '', id);
    if (ok) {
      db().prepare('INSERT OR IGNORE INTO github_comments (id, issue_url, seen_at) VALUES (?, ?, ?)')
        .run(commentId, `https://github.com/${job.repo}/issues/${issueNumber}`, now);
    } else if (job.kind !== 'digest' && error !== job.last_error) {
      logEvent({ actor: 'system', kind: 'github.outbox_failed', text: `回写 GitHub 失败：${error}` });
    }
    onResult(job, { ok, issueNumber, commentId, error, nextTry, now });
    return true;
  });
}
