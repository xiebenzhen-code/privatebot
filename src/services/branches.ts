// 031a: 分支不能到期就删。未合并的分支可能是 agent 已经干完、用户还没收的成果。
// 所以这里只自动删「确定没有成果」的三种：已经合并进 main、相对 main 没有提交且没有 worktree、
// 干净的空 worktree。其余一律上报，等人决定。
import { db } from '../db.ts';
import { nowIso } from '../domain.ts';
import { logEvent } from './core.ts';

/** 执行器扫出来的一个分支。 */
export type ScannedBranch = {
  branch: string;
  tip: string;
  /** 031a.1: null = 读不出和 main 的差别。未知一律只上报、不删。 */
  ahead: number | null;
  merged: boolean;
  lastCommitAt?: string | null;
  worktree?: { dir: string; dirty: boolean } | null;
};

/** 执行器扫出来的一个 worktree（可能在某个分支上，也可能 detached）。 */
export type ScannedWorktree = { dir: string; branch: string; dirty: boolean };

export type ScanInput = {
  branches: ScannedBranch[];
  worktrees?: ScannedWorktree[];
  /** 还在跑或在排队的任务：它们的分支和 worktree 一律不碰。 */
  activeTaskIds?: number[];
  /** 用户点过删除的分支，以及点的时候看到的 tip。 */
  requests?: { branch: string; tip: string }[];
};

export type CleanupPlan = {
  deleteBranches: { branch: string; tip: string }[];
  deleteWorktrees: string[];
  report: {
    branch: string;
    task_id: number | null;
    /** 031a.1: null = 读不出，不是 0。 */
    ahead: number | null;
    last_commit_at: string | null;
    tip: string;
    kind: 'branch' | 'worktree';
    note: string;
  }[];
  rejected: { branch: string; tip: string; requestedTip: string; reason: string }[];
};

/** `wb/T-12` 和 `wb/T-12-2`（重新开始时另开的那条）都认。 */
export function taskIdOfBranch(branch: string): number | null {
  const m = /^wb\/T-(\d+)(?:-\d+)?$/.exec(branch);
  return m ? Number(m[1]) : null;
}

/**
 * 纯函数：给定扫描结果，决定删哪些、报哪些、哪些删除请求被拒。
 * 顺序上先看用户的删除请求——那是明确指令，被拒也要给出能读懂的原因。
 */
export function planCleanup(input: ScanInput): CleanupPlan {
  const out: CleanupPlan = { deleteBranches: [], deleteWorktrees: [], report: [], rejected: [] };
  const active = new Set(input.activeTaskIds ?? []);
  const requests = new Map((input.requests ?? []).map((r) => [r.branch, r.tip]));
  const worktrees = input.worktrees ?? [];
  const seen = new Set<string>();

  for (const b of input.branches) {
    seen.add(b.branch);
    const taskId = taskIdOfBranch(b.branch);
    const wt = b.worktree ?? worktrees.find((w) => w.branch === b.branch) ?? null;
    const requestedTip = requests.get(b.branch);

    // 用户点过删除：tip 必须和当时看到的一致，否则说明期间又有新提交。
    if (requestedTip !== undefined) {
      if (requestedTip !== b.tip) {
        const reason = '点删除之后这条分支上又有了新提交，没有删。看一眼再决定。';
        out.rejected.push({ branch: b.branch, tip: b.tip, requestedTip, reason });
        // 031a.1：被拒的分支要留在列表里，note 写原因。原来这里 continue 之后没有进 report，
        // 随后的整表删除把它的行也删了——用户点了删除，它却从页面上消失，而分支还在。
        out.report.push({
          branch: b.branch, task_id: taskId, ahead: b.ahead ?? 0, last_commit_at: b.lastCommitAt ?? null,
          tip: b.tip, kind: 'branch', note: reason,
        });
        continue;
      }
      if (wt) out.deleteWorktrees.push(wt.dir);
      out.deleteBranches.push({ branch: b.branch, tip: b.tip });
      continue;
    }

    if (taskId !== null && active.has(taskId)) continue; // 正在干活，别动

    // 031a.1：读不出和 main 的差别就什么都别删。原来读失败被当成 ahead = 0，
    // 结果「有成果但读不出来」的分支会被当成空分支删掉。
    if (b.ahead === null || b.ahead === undefined) {
      out.report.push({
        branch: b.branch, task_id: taskId, ahead: null, last_commit_at: b.lastCommitAt ?? null,
        tip: b.tip, kind: 'branch', note: '读不出和 main 的差别，没有删',
      });
      continue;
    }

    if (b.merged) {
      // 已合并也可能 still 有没提交的改动（分支指在 main 上、worktree 里改了一半）。
      // 那种情况删分支是安全的，但目录不能扔——里面的改动没进过任何 commit。
      if (wt && wt.dirty) {
        out.report.push({
          branch: b.branch, task_id: taskId, ahead: 0, last_commit_at: b.lastCommitAt ?? null,
          tip: b.tip, kind: 'worktree', note: 'worktree 里有没提交的改动（分支本身已合并）',
        });
        continue;
      }
      if (wt) out.deleteWorktrees.push(wt.dir);
      out.deleteBranches.push({ branch: b.branch, tip: b.tip });
      continue;
    }

    if (b.ahead <= 0) {
      if (wt && wt.dirty) {
        out.report.push({
          branch: b.branch, task_id: taskId, ahead: 0, last_commit_at: b.lastCommitAt ?? null,
          tip: b.tip, kind: 'worktree', note: 'worktree 里有没提交的改动',
        });
        continue;
      }
      if (wt) out.deleteWorktrees.push(wt.dir);
      out.deleteBranches.push({ branch: b.branch, tip: b.tip });
      continue;
    }

    out.report.push({
      branch: b.branch, task_id: taskId, ahead: b.ahead, last_commit_at: b.lastCommitAt ?? null,
      tip: b.tip, kind: 'branch', note: '',
    });
  }

  // 没有对应分支的 worktree（detached）：干净就删，有改动才报——它没有分支可救援，
  // 所以只把目录名写进 branch 字段当标识。
  for (const w of worktrees) {
    if (w.branch && seen.has(w.branch)) continue;
    if (!w.branch && !w.dirty) { out.deleteWorktrees.push(w.dir); continue; }
    if (!w.dirty) { out.deleteWorktrees.push(w.dir); continue; }
    const name = w.dir.split(/[\\/]/).filter(Boolean).pop() ?? w.dir;
    out.report.push({
      branch: `worktree:${name}`, task_id: /^T-(\d+)$/.exec(name) ? Number(/^T-(\d+)$/.exec(name)![1]) : null,
      ahead: 0, last_commit_at: null, tip: '', kind: 'worktree',
      note: `没有对应分支，目录里有没提交的改动：${name}`,
    });
  }

  return out;
}

/**
 * 执行器的上报：这次出现的 upsert，这次没出现的才删。
 *
 * 031a.1：原来先 `DELETE` 整个项目再重插，把 `snoozed_until`（保留 30 天）、`notified_at`
 * （只推一次）、`delete_requested_at`（点了删除）一起擦掉了——用户点完「保留」，最多 6 小时
 * 后又冒出来，还会再推一次手机。现在这些「人对旧提交做过的决定」跟着行一起留着。
 * 只有 tip 变了（分支上又有新提交）才清空：那些决定是针对旧提交做的，新提交要重新看。
 */
export function reportScan(project: string, input: ScanInput): CleanupPlan {
  const plan = planCleanup(input);
  const now = nowIso();
  const d = db();
  d.exec('BEGIN');
  try {
    const before = d.prepare('SELECT branch FROM stale_branches WHERE project = ?').all(project) as { branch: string }[];
    const up = d.prepare(`INSERT INTO stale_branches
      (project, branch, task_id, ahead, last_commit_at, tip, kind, note, reported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, branch) DO UPDATE SET
        task_id = excluded.task_id, ahead = excluded.ahead, last_commit_at = excluded.last_commit_at,
        tip = excluded.tip, kind = excluded.kind, note = excluded.note, reported_at = excluded.reported_at,
        snoozed_until = CASE WHEN stale_branches.tip <> excluded.tip THEN NULL ELSE stale_branches.snoozed_until END,
        delete_requested_at = CASE WHEN stale_branches.tip <> excluded.tip THEN NULL ELSE stale_branches.delete_requested_at END,
        notified_at = CASE WHEN stale_branches.tip <> excluded.tip THEN NULL ELSE stale_branches.notified_at END`);
    const keep = new Set<string>();
    for (const r of plan.report) {
      // 读不出 ahead 的存 0，页面靠 note 说明「读不出」，不用另一个哨兵值污染统计。
      up.run(project, r.branch, r.task_id, r.ahead ?? 0, r.last_commit_at, r.tip, r.kind, r.note, now);
      keep.add(r.branch);
    }
    const del = d.prepare('DELETE FROM stale_branches WHERE project = ? AND branch = ?');
    for (const row of before) if (!keep.has(row.branch)) del.run(project, row.branch);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return plan;
}

/** 执行器删完之后回报：删成功的移出列表，失败的原样留着并记下原因。 */
export function finishCleanup(project: string, cleaned: string[], failed: { branch: string; reason: string }[] = []): void {
  const d = db();
  for (const branch of cleaned) {
    d.prepare('DELETE FROM stale_branches WHERE project = ? AND branch = ?').run(project, branch);
    logEvent({ actor: 'system', kind: 'branch.cleaned', text: `清理了 ${project} 的 ${branch}` });
  }
  for (const f of failed) {
    d.prepare('UPDATE stale_branches SET note = ? WHERE project = ? AND branch = ?')
      .run(`删除失败：${f.reason}`.slice(0, 200), project, f.branch);
  }
}

export type StaleBranch = {
  id: number;
  project: string;
  branch: string;
  task_id: number | null;
  ahead: number;
  last_commit_at: string | null;
  tip: string;
  kind: string;
  note: string;
  reported_at: string;
  snoozed: boolean;
  task_title: string | null;
};

/** 页面上要显示的那些：被「保留」的 30 天内不出现。 */
export function listStaleBranches(): StaleBranch[] {
  const now = nowIso();
  const rows = db().prepare(`SELECT b.*, t.title AS task_title FROM stale_branches b
    LEFT JOIN tasks t ON t.id = b.task_id
    WHERE b.snoozed_until IS NULL OR b.snoozed_until < ?
    ORDER BY b.ahead DESC, b.last_commit_at ASC`).all(now) as (StaleBranch & { snoozed_until: string | null })[];
  return rows.map((r) => ({ ...r, snoozed: false }));
}

/** 「保留」：30 天内不再提醒，也不再推。 */
export function snoozeBranch(id: number, days = 30): void {
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  const row = db().prepare('SELECT project, branch FROM stale_branches WHERE id = ?').get(id) as { project: string; branch: string } | undefined;
  if (!row) return;
  db().prepare('UPDATE stale_branches SET snoozed_until = ?, notified_at = COALESCE(notified_at, ?) WHERE id = ?')
    .run(until, nowIso(), id);
  logEvent({ actor: 'me', kind: 'branch.snoozed', text: `保留 ${row.project} 的 ${row.branch}，30 天内不再提醒` });
}

/** 「删除」：只记请求，真正删是执行器下一次扫描时做的事。 */
export function requestDelete(id: number): { ok: boolean; why?: string } {
  const row = db().prepare('SELECT project, branch, tip FROM stale_branches WHERE id = ?').get(id) as
    | { project: string; branch: string; tip: string }
    | undefined;
  if (!row) return { ok: false, why: '这条分支已经不在列表里了' };
  db().prepare('UPDATE stale_branches SET delete_requested_at = ?, note = ? WHERE id = ?')
    .run(nowIso(), '等执行器下次扫描时删除', id);
  logEvent({ actor: 'me', kind: 'branch.delete_requested', text: `请求删除 ${row.project} 的 ${row.branch}` });
  return { ok: true };
}

/** 执行器上报时带上：还有哪些任务在跑/在排队/等你选（它们的 worktree 不许碰——等你选的要用原目录接着干，055.2）。 */
export function activeTaskIds(): number[] {
  return (db().prepare("SELECT id FROM tasks WHERE status IN ('running', 'queued', 'asking')").all() as { id: number }[]).map((r) => r.id);
}

/** 还没推过的、没被保留的 → 一条消息里合并推一次。 */
export function branchesToNotify(): StaleBranch[] {
  const now = nowIso();
  const rows = db().prepare(`SELECT b.*, t.title AS task_title FROM stale_branches b
    LEFT JOIN tasks t ON t.id = b.task_id
    WHERE b.notified_at IS NULL AND (b.snoozed_until IS NULL OR b.snoozed_until < ?)`).all(now) as StaleBranch[];
  return rows;
}

export function markNotified(ids: number[]): void {
  const now = nowIso();
  const st = db().prepare('UPDATE stale_branches SET notified_at = ? WHERE id = ?');
  for (const id of ids) st.run(now, id);
}

/** 用户点删除时的请求清单，交给执行器。 */
export function deleteRequests(): { branch: string; tip: string }[] {
  return db().prepare('SELECT branch, tip FROM stale_branches WHERE delete_requested_at IS NOT NULL')
    .all() as { branch: string; tip: string }[];
}

/** 待处理数量：今天页和导航用。 */
export function staleBranchCount(): number {
  const now = nowIso();
  const row = db().prepare('SELECT COUNT(*) n FROM stale_branches WHERE snoozed_until IS NULL OR snoozed_until < ?').get(now) as { n: number };
  return row.n;
}
