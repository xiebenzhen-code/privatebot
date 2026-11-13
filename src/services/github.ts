// 012: GitHub Issues as the channel between the decision side and this machine.
// The runner handles GitHub requests; the workbench only imports and queues.
import { db, tx } from '../db.ts';
import { nowIso, truncate } from '../domain.ts';
import { logEvent } from './core.ts';
import { setMaterial, createTask, getTask, updateTask, type Task } from './tasks.ts';
import { redactText } from './redact.ts';
import { enqueueGithub, GITHUB_REPO } from './github-outbox.ts';

export const githubRepos = () => [...new Set((process.env.GITHUB_REPOS ?? '').split(',').map((r) => r.trim()).filter((r) => GITHUB_REPO.test(r)))];
// 015: no default author. An empty whitelist means "nobody", so a fresh clone can never be
// driven by a stranger's Issue just because the default happened to match a real account.
const ALLOWED = () => (process.env.GITHUB_ALLOWED_AUTHORS ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);

/** The sources panel reads connector_state('github'); keep it honest. */
function lastSyncError(): string {
  const row = db().prepare("SELECT last_error FROM connector_state WHERE name = 'github'").get() as { last_error: string } | undefined;
  return row?.last_error ?? '';
}

function markSync(ok: boolean, error = ''): void {
  const now = nowIso();
  const cur = db().prepare("SELECT imported, failed FROM connector_state WHERE name = 'github'").get() as { imported: number; failed: number } | undefined;
  db().prepare(`INSERT INTO connector_state (name, last_run, last_ok, last_error, imported, failed) VALUES ('github', ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_ok = excluded.last_ok,
      last_error = excluded.last_error, imported = excluded.imported, failed = excluded.failed`)
    .run(now, ok ? now : '', error, (cur?.imported ?? 0) + (ok ? 1 : 0), (cur?.failed ?? 0) + (ok ? 0 : 1));
}

export const githubEnabled = (): boolean => githubRepos().length > 0;
export const authorAllowed = (login: string): boolean => ALLOWED().includes(String(login ?? '').toLowerCase());

export function recordGithubSync(problem: unknown): void {
  const reason = redactText(String(problem ?? '')).replace(/[\r\n]/g, ' ').slice(0, 120);
  const previous = lastSyncError();
  markSync(!reason, reason);
  if (reason && reason !== previous) {
    logEvent({ actor: 'system', kind: 'github.failed', text: '执行器拉取 Issue 失败：' + reason });
  } else if (!reason && previous) {
    logEvent({ actor: 'system', kind: 'github.recovered', text: githubRepos().join('、') + ' 的 Issue 又能转发了' });
  }
}

// ---------- parsing (pure, tested) ----------

export type IssueTask = { title: string; description: string; project: string; category: string; executor: string | null };

/** 054.8：外部来的一行字——控制字符、换行、零宽和双向覆盖字符都拿掉，压成一行、限长。 */
export function externalLine(text: unknown, max = 120): string {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `项目: x` / `分类: y` / `执行者: z` on the first lines, then `---`, then the task text. */
export function parseIssue(issue: { title?: string; body?: string }, repoName: string): IssueTask {
  const body = String(issue.body ?? '');
  const [head, ...rest] = body.split(/\r?\n---\r?\n/);
  const looksLikeHeader = /^\s*(项目|分类|执行者)\s*[:：]/m.test(head) && rest.length > 0;
  const meta: Record<string, string> = {};
  if (looksLikeHeader) {
    for (const line of head.split(/\r?\n/)) {
      const m = line.match(/^\s*(项目|分类|执行者)\s*[:：]\s*(.+?)\s*$/);
      if (m) meta[m[1]] = m[2];
    }
  }
  const title = externalLine(issue.title, 300) || `Issue #${(issue as any).number ?? '?'}`;
  const category = meta['分类'] || 'dev';
  return {
    title,
    description: (looksLikeHeader ? rest.join('\n---\n') : body).trim(),
    project: meta['项目'] || repoName,
    category,
    executor: meta['执行者'] || null,
  };
}

/** Only a line that is exactly the command counts; `/wb rework` inside a sentence does not. */
export function parseCommand(body: string): { cmd: 'rework' | 'cancel'; feedback: string } | null {
  const lines = String(body ?? '').split(/\r?\n/);
  const idx = lines.findIndex((l) => {
    const t = l.trim();
    return t === '/wb rework' || t === '/wb cancel';
  });
  if (idx === -1) return null;
  const cmd = lines[idx].trim() === '/wb cancel' ? 'cancel' : 'rework';
  return { cmd, feedback: lines.slice(idx + 1).join('\n').trim() };
}

// ---------- outbound ----------

/**
 * A line starting with /wb would come back to us as a command: the token belongs to the same
 * account as the allowlist, so our own comments look authoritative. Make them unparseable.
 */
export function defuseCommands(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) => (/^\s*\/wb\b/.test(line) ? line.replace(/^(\s*)\//, '$1／') : line))
    .join('\n');
}

/** Redacted (never truncated to 120), /wb lines defused, capped at 3000 for GitHub. */
export function commentBody(text: string): string {
  return defuseCommands(redactText(text)).slice(0, 3000);
}

export function commentOnIssue(repo: string, number: number, text: string): void {
  if (!githubRepos().some((r) => r.toLowerCase() === repo.toLowerCase())) return;
  if (!Number.isSafeInteger(number) || number < 1) return;
  enqueueGithub({ repo, issue_number: number, kind: 'comment', body: commentBody(text) });
}

export function commentOnTask(task: { issue_url?: string | null; issue_number?: number | null }, text: string): void {
  if (!task.issue_url || !task.issue_number) return;
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(task.issue_url);
  if (m && Number(m[2]) === task.issue_number) commentOnIssue(m[1], task.issue_number, text);
}

export type SyncResult = { created: number; commands: number; skipped: number };

/** The runner forwards raw GitHub Issue/comment records; the author check stays on the workbench. */
export function importIssues(repo: string, items: unknown[]): SyncResult {
  const out: SyncResult = { created: 0, commands: 0, skipped: 0 };
  if (!githubRepos().some((r) => r.toLowerCase() === repo.toLowerCase())) return out;
  const repoName = repo.split('/')[1];
  for (const entry of items as { issue?: any; comments?: any[] }[]) {
    const issue = entry?.issue;
    const n = Number(issue?.number);
    const issueUrl = 'https://github.com/' + repo + '/issues/' + n;
    if (!issue || issue.pull_request || !Number.isSafeInteger(n) || n < 1 ||
        typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== issueUrl.toLowerCase()) continue;
    if (!Array.isArray(issue.labels) || !issue.labels.some((l: any) => l?.name === 'wb-task' || l === 'wb-task')) continue;
    if (!authorAllowed(issue.user?.login)) { out.skipped++; continue; }
    tx(() => {
      let known = db().prepare('SELECT id FROM tasks WHERE issue_url = ? COLLATE NOCASE').get(issueUrl) as { id: number } | undefined;
      if (!known) {
        const parsed = parseIssue(issue, repoName);
        const task = createTask({
          // 054.8：正文不进 description（那是给 agent 的指令位），下面单独存成资料。
          title: parsed.title, description: '', project: parsed.project,
          category: parsed.category, executor: parsed.executor ?? 'pool', status: 'queued', mode: 'manual',
        }, 'system');
        known = task;
        db().prepare('UPDATE tasks SET issue_url = ?, issue_number = ? WHERE id = ?').run(issueUrl, n, task.id);
        setMaterial(task.id, parsed.description);
        logEvent({ actor: 'system', kind: 'task.from_issue', task_id: task.id, text: '从 Issue #' + n + ' 建了 T-' + task.id });
        commentOnIssue(repo, n, '已收到，任务 T-' + task.id + '，等你在工作台点「开始」。');
        out.created++;
      }
      for (const c of Array.isArray(entry.comments) ? entry.comments : []) {
        if (!Number.isSafeInteger(c?.id) || c.id < 1 || !authorAllowed(c.user?.login)) continue;
        const seen = db().prepare('INSERT OR IGNORE INTO github_comments (id, issue_url, seen_at) VALUES (?, ?, ?)')
          .run(c.id, issueUrl, nowIso());
        if (!seen.changes) continue;
        const cmd = parseCommand(c.body);
        if (!cmd) continue;
        applyCommand(known.id, cmd);
        out.commands++;
      }
    });
  }
  return out;
}

export function applyCommand(taskId: number, cmd: { cmd: 'rework' | 'cancel'; feedback: string }): void {
  const task = getTask(taskId);
  if (!task) return;
  if (cmd.cmd === 'cancel') {
    updateTask(taskId, { status: 'failed', step: 'Issue 上要求取消' }, 'system');
    logEvent({ actor: 'system', kind: 'task.from_issue', task_id: taskId, text: `T-${taskId} 被 Issue 指令取消` });
    return;
  }
  // 054.8：修改意见也是外部文字，接在资料后面，不碰 description。
  if (cmd.feedback) setMaterial(taskId, `${task.material ?? ''}\n\n---\n修改意见（来自 Issue）：\n${cmd.feedback}`.trim());
  updateTask(taskId, { status: 'queued', mode: 'manual', step: '按修改意见重做，等点开始', start_requested: 0 }, 'system');
  logEvent({ actor: 'system', kind: 'task.from_issue', task_id: taskId, text: `T-${taskId} 收到返工意见，回到队列` });
}

/** Summary posted back when a task finishes; never the full log. */
export function finishComment(task: Task, summary: string, diff: string, tests: string, result = ''): string {
  const lines = [
    `T-${task.id} 完成，等你批合并。`,
    summary ? `\n${summary}` : '',
    diff ? `\n改动：${diff}` : '',
    tests ? `\n测试：${tests}` : '',
    task.branch ? `\n分支：${task.branch}` : '',
    // 017: say which model actually ran it — a fallback run would otherwise look identical.
    task.backend ? `后端：${task.backend}` : '',
    // 028: opt-in only (设置 › 接入 › Issue 回写). The first 1500 characters of the model's answer;
    // anything longer is file content territory.
    result ? `\n## 结果\n${String(result).slice(0, 1500)}` : '',
    `\n任务：${truncate(task.title, 60)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 012.2: the last line of the loop — only after the push really landed does the issue learn the
 * commit. Never says "pushed" from the merge alone; a merge stays local until the user approves.
 */
export function pushComment(task: Task, commit: string, branch: string): string {
  // 12 characters is plenty to find a commit, and it stays under the "long token" rule in
  // redactText() — a full 40-char sha would come out as *** and read like a redaction bug.
  const sha = String(commit ?? '').trim().slice(0, 12);
  return [
    `T-${task.id} 已推送到 origin/main：${sha}`,
    branch ? `分支：${branch}` : '',
    `任务：${truncate(task.title, 60)}`,
  ].filter(Boolean).join('\n');
}
