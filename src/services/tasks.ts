import { db } from '../db.ts';
import { CATEGORIES, EXECUTORS, STATUSES, execLabel, nowIso, statusLabel, truncate } from '../domain.ts';
import { HttpError, int, logEvent, oneOf, str } from './core.ts';
import { redactAll } from './redact.ts';
import { likePattern, searchTerms } from './search.ts';

export type Task = {
  id: number; title: string; description: string; category: string; executor: string;
  project: string; status: string; progress: number | null; step: string;
  session_id: string | null; session_url: string;
  created_at: string; updated_at: string; started_at: string | null; completed_at: string | null;
  mode: 'auto' | 'manual';
  runner_id: string | null; runner_log: string; branch: string | null;
  tokens_used: number; start_requested: number;
  issue_url: string | null; issue_number: number | null;
  retry: 'merge' | 'push' | null; merged_commit: string | null;
  /** 017: which backend did the run (bailian / deepseek). Null for tasks no runner touched. */
  backend: string | null;
  /** 025: why it failed；重试/编辑/当前步骤都不覆盖它，任务重新开始时清空。 */
  fail_reason: string | null;
  /** 028: 模型的最终回答（已打码、已截断到 8000）。只读任务的成果就在这里。 */
  result_text: string | null;
  /** 028.1: 这次没有改动（只读任务）。阶段条据此把合并/推送四格显示成跳过。 */
  no_changes: number;
  /** 029: 这次运行推过没有（'failed' / 'done'）。重新开始时清空，重试后的新结果能再推一次。 */
  notified_state: string | null;
  /**
   * 041: 真正做这件事的人。第一次进入 running 时写死，之后 `takeover` 把 executor 改成 me 也不动。
   * 老数据可能为空（读不出来），空的不计入战绩——不是「没有」，是「不知道」。
   */
  first_executor: string | null;
  /**
   * 042: 这单是谁派的。`'brain'` = 调度大脑选的；空 = 你自己选的（或者你后来改过）。
   * 只在「让大脑选」建出来的任务上写，改了执行者就清空——改过就不再算大脑的判断。
   */
  route: string;
  /** 042: 大脑给的理由（≤60 字）。 */
  route_reason: string | null;
  /** 042: 大脑判的难度，1–5。改执行者时留着：难度是这活的属性，不是派单的属性。 */
  difficulty: number | null;
  /** 042: 派单时间。有值就表示大脑已经派过，不会派第二次。 */
  routed_at: string | null;
  /**
   * 042.2: 这活只读、不改文件（1 = 是）。跟着任务走，不跟着某次回话走——
   * 额度改派、回退规则都要看它，否则写任务能被塞给只读执行者。
   */
  route_read_only: number | null;
  /** 043 F：1 = 只要一个回答、不改文件。0 的任务跑完没改任何文件，不算完成。 */
  answer_only: number;
};

const EXEC_KEYS = Object.keys(EXECUTORS);
// 055.2：「等你选」只能由 asks.ts 设（提了问题才有），不接受 PATCH 手动改——手动设了会停在没有卡片的死状态。
const STATUS_KEYS = Object.keys(STATUSES).filter((k) => k !== 'asking');

export function getTask(id: number): Task | undefined {
  return db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

/**
 * 036 D：同一个任务交给不同编码工具跑，把几份结果摆在一起看。
 * 只按「标题 + 项目」配对——标题改过就不算同一件事，宁可少配也不配错；
 * 顺序按创建时间，当前这条不参与（调用方自己放在最前面）。
 */
export function siblingRuns(task: Task, limit = 4): Task[] {
  if (!task.title.trim()) return [];
  return db().prepare(`SELECT * FROM tasks
    WHERE title = ? AND project = ? AND id != ?
    ORDER BY created_at LIMIT ?`).all(task.title, task.project, task.id, limit) as Task[];
}

export type TaskFilter = {
  status?: string[]; executor?: string; category?: string;
  /** 031b: 空格分隔的词，标题、说明、结果文本三处都要命中才算。 */
  q?: string;
  limit?: number; offset?: number;
};

/** 列表和计数要一套 WHERE，不然「第 2 / 3 页」和实际条数会打架。 */
function whereOf(f: TaskFilter): { sql: string; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.status?.length) { where.push(`status IN (${f.status.map(() => '?').join(',')})`); args.push(...f.status); }
  if (f.executor) { where.push('executor = ?'); args.push(f.executor); }
  if (f.category) { where.push('category = ?'); args.push(f.category); }
  for (const term of searchTerms(f.q)) {
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR result_text LIKE ? ESCAPE '\\')");
    const p = likePattern(term);
    args.push(p, p, p);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

export function listTasks(f: TaskFilter = {}): Task[] {
  const { sql: where, args } = whereOf(f);
  const sql = `SELECT * FROM tasks ${where}
    ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'asking' THEN 0 WHEN 'failed' THEN 1 WHEN 'running' THEN 2 ELSE 3 END, updated_at DESC
    LIMIT ? OFFSET ?`;
  args.push(Math.min(f.limit ?? 500, 2000), Math.max(f.offset ?? 0, 0));
  return db().prepare(sql).all(...args) as Task[];
}

/** 031b: 分页要的是「命中了多少条」，不是「这一页拿了多少条」。 */
export function countTasks(f: TaskFilter = {}): number {
  const { sql: where, args } = whereOf(f);
  const row = db().prepare(`SELECT COUNT(*) AS n FROM tasks ${where}`).get(...args) as { n: number };
  return row.n;
}

export type TaskInput = Partial<Pick<Task, 'title' | 'description' | 'category' | 'executor' | 'project' | 'status' | 'progress' | 'step' | 'session_id' | 'session_url' | 'mode' | 'start_requested' | 'branch' | 'retry' | 'merged_commit' | 'backend' | 'fail_reason' | 'result_text' | 'no_changes' | 'route' | 'route_reason' | 'difficulty' | 'routed_at' | 'answer_only'>>;

/** A fresh task only runs by itself when its executor is allowed to and the category is whitelisted. */
export function defaultMode(executor: string, category: string): 'auto' | 'manual' {
  const row = db().prepare('SELECT categories, auto_allowed, enabled FROM executor_settings WHERE executor = ?')
    .get(executor) as { categories: string; auto_allowed: number; enabled: number } | undefined;
  if (!row || !row.enabled || !row.auto_allowed) return 'manual';
  const cats = row.categories.split(',').filter(Boolean);
  return !cats.length || cats.includes(category) ? 'auto' : 'manual';
}

function clean(input: Record<string, unknown>): TaskInput {
  const out: TaskInput = {};
  const title = str(input.title, 300); if (title !== undefined) out.title = title.trim();
  const description = str(input.description, 10000); if (description !== undefined) out.description = description;
  const category = str(input.category, 40); if (category !== undefined && category !== '') out.category = category;
  const executor = oneOf(input.executor, EXEC_KEYS, 'executor'); if (executor) out.executor = executor;
  const project = str(input.project, 120); if (project !== undefined) out.project = project.trim();
  // 055.2：编辑表单的状态下拉会把「等你选」原样带回来，当没改；别的脚本想手动设它也一样被忽略。
  const status = input.status === 'asking' ? undefined : oneOf(input.status, STATUS_KEYS, 'status'); if (status) out.status = status;
  const progress = int(input.progress);
  if (progress !== undefined) out.progress = progress === null ? null : Math.min(100, Math.max(0, progress));
  const step = str(input.step, 300); if (step !== undefined) out.step = redactAll(step);
  const sid = str(input.session_id, 200); if (sid !== undefined) out.session_id = sid || null;
  const mode = oneOf(input.mode, ['auto', 'manual'], 'mode'); if (mode) out.mode = mode as 'auto' | 'manual';
  if (input.start_requested !== undefined) out.start_requested = input.start_requested ? 1 : 0;
  const branch = str(input.branch, 200); if (branch !== undefined) out.branch = branch || null;
  const retry = oneOf(input.retry, ['merge', 'push'], 'retry'); if (retry) out.retry = retry as 'merge' | 'push';
  else if (input.retry === '' || input.retry === null) out.retry = null;
  const failReason = str(input.fail_reason, 300);
  // 028.1: 执行器通过 PATCH 写 step / fail_reason 的路径以前只截断不打码，地址里的凭据会漏。
  // 打码幂等，finish 路径已经打过一遍也不会有问题。
  if (failReason !== undefined) out.fail_reason = failReason ? redactAll(failReason) : null;
  else if (input.fail_reason === null) out.fail_reason = null; // 显式清空（重新开始时用）
  // 028: 结果只能由执行器写（finishTask 里已经打过码），不接受随便改；这里照样收，因为要能清空。
  const result = str(input.result_text, 8000);
  if (result !== undefined) out.result_text = result || null;
  else if (input.result_text === null) out.result_text = null;
  const merged = str(input.merged_commit, 40); if (merged !== undefined) out.merged_commit = merged || null;
  // 028.1: 只读任务跑完没有改动，阶段条要把合并/推送四格标成跳过。
  if (input.no_changes !== undefined) out.no_changes = input.no_changes ? 1 : 0;
  // 043 F：表单的勾选框送来 'on' / '1'，接口送来 true；没勾的勾选框根本不送这个字段。
  if (input.answer_only !== undefined) {
    const v = input.answer_only;
    out.answer_only = v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0;
  }
  // 017: a backend name is short and lower-case; anything else is a typo or an injection attempt.
  const backend = str(input.backend, 40);
  if (backend !== undefined) out.backend = /^[a-z0-9_-]{1,20}$/i.test(backend) ? backend.toLowerCase() : null;
  const url = str(input.session_url, 1000);
  if (url !== undefined) {
    if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, '会话链接需以 http(s):// 开头');
    out.session_url = url;
  }
  // 042: 只有「让大脑选」这一条路会写 route。'brain' 以外的值一律当没设——空串是「人定的」。
  if (input.route !== undefined) {
    const route = str(input.route, 20) ?? '';
    if (route && route !== 'brain') throw new HttpError(400, 'route 只能是 brain 或留空');
    out.route = route;
  }
  const routeReason = str(input.route_reason, 200);
  if (routeReason !== undefined) out.route_reason = routeReason || null;
  else if (input.route_reason === null) out.route_reason = null;
  // 难度是 1–5 的整数；0 或 6 不是「更小/更大」，是写错了。
  if (input.difficulty !== undefined) {
    const d = int(input.difficulty);
    if (d === null) out.difficulty = null;
    else if (d !== undefined) {
      if (d < 1 || d > 5) throw new HttpError(400, '难度只能是 1–5');
      out.difficulty = d;
    }
  }
  const routedAt = str(input.routed_at, 40);
  if (routedAt !== undefined) out.routed_at = routedAt || null;
  else if (input.routed_at === null) out.routed_at = null;
  return out;
}

export function createTask(input: Record<string, unknown>, actor = 'me'): Task {
  const t = clean(input);
  if (!t.title) throw new HttpError(400, '任务标题不能为空');
  // 042: 「让大脑选」的任务一定先落在「我」名下、停在收件箱，等大脑派。执行者不能同时钉死一个，
  // 否则 route 和 executor 会各说一套。
  if (t.route === 'brain') {
    t.executor = 'me';
    t.status = 'inbox';
  }
  const now = nowIso();
  const status = t.status ?? (t.executor && t.executor !== 'me' ? 'queued' : 'inbox');
  const res = db().prepare(`INSERT INTO tasks (title, description, category, executor, project, status, progress, step, session_id, session_url, created_at, updated_at, started_at, completed_at, mode, fail_reason, result_text, no_changes, first_executor, route, difficulty, answer_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    t.title, t.description ?? '', t.category ?? 'dev', t.executor ?? 'me', t.project ?? '', status,
    t.progress ?? null, t.step ?? '', t.session_id ?? null, t.session_url ?? '', now, now,
    status === 'running' ? now : null, status === 'done' || status === 'failed' ? now : null,
    t.mode ?? defaultMode(t.executor ?? 'me', t.category ?? 'dev'), t.fail_reason ?? null, t.result_text ?? null,
    // 028.1: 创建时也要认这个字段，否则从接口建一个"没有改动"的任务会被静默丢掉，
    // 阶段条不会显示跳过——表现和 updateTask 不一致，很难查。
    t.no_changes ? 1 : 0,
    // 041: 一建出来就在跑的（hook 造的任务）也算它的战绩。
    status === 'running' && (t.executor ?? 'me') !== 'me' ? (t.executor ?? 'me') : null,
    t.route ?? '', t.difficulty ?? null, t.answer_only ? 1 : 0,
  );
  const id = Number(res.lastInsertRowid);
  logEvent({ actor, kind: 'task.created', task_id: id, text: `创建任务 T-${id}「${truncate(t.title, 60)}」，交给 ${execLabel(t.executor ?? 'me')}（${t.executor ?? 'me'}）` });
  return getTask(id)!;
}

export function updateTask(id: number, input: Record<string, unknown>, actor = 'me'): Task {
  const before = getTask(id);
  if (!before) throw new HttpError(404, `没有任务 T-${id}`);
  const t = clean(input);
  if (t.title === '') throw new HttpError(400, '任务标题不能为空');
  const fields = Object.keys(t) as (keyof TaskInput)[];
  if (!fields.length) return before;
  const now = nowIso();
  const sets = fields.map((k) => `${k} = ?`);
  const args: (string | number | null)[] = fields.map((k) => (t[k] ?? null) as string | number | null);
  if (t.status && t.status !== before.status) {
    if (t.status === 'running' && !before.started_at) {
      sets.push('started_at = ?'); args.push(now);
      // 041: 只在第一次开跑时记住是谁做的。重试、接手、等审批后继续都不覆盖。
      // 041.1: 同一次更新里既改执行者又开跑时，真正开跑的是**新**执行者，不是改之前那个。
      const runner = (t.executor ?? before.executor) || 'me';
      if (!before.first_executor && runner !== 'me') {
        sets.push('first_executor = ?'); args.push(runner);
      }
    }
    if (t.status === 'done' || t.status === 'failed') { sets.push('completed_at = ?'); args.push(now); }
    else if (before.completed_at) { sets.push('completed_at = NULL'); }
    if (t.status === 'done' && t.progress === undefined) { sets.push('progress = 100'); }
  }
  // 042：你改了大脑的选择，这条就不再算「大脑派的」——route 清空，难度留着（那是这活的属性）。
  // 两件事必须在同一条 UPDATE 里：先改执行者再清 route，中间那一刻页面会显示「大脑派给新的人」。
  const routeCleared = Boolean(before.route) && Boolean(t.executor) && t.executor !== before.executor;
  if (routeCleared) { sets.push("route = ''", 'route_reason = NULL', 'routed_at = NULL', 'route_read_only = NULL'); }
  sets.push('updated_at = ?'); args.push(now);
  db().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  if (t.status && t.status !== before.status) {
    logEvent({ actor, kind: 'task.status', task_id: id, text: `T-${id}「${truncate(before.title, 50)}」${statusLabel(before.status)} → ${statusLabel(t.status)}` });
  }
  if (t.executor && t.executor !== before.executor) {
    logEvent({ actor, kind: 'task.executor', task_id: id, text: `T-${id} 执行者 ${execLabel(before.executor)} → ${execLabel(t.executor)}` });
  }
  if (routeCleared) {
    logEvent({ actor, kind: 'task.route_cleared', task_id: id, text: `T-${id} 你改了大脑的选择（原本派给 ${execLabel(before.executor)}），这单之后按你选的算` });
  }
  return getTask(id)!;
}

export function deleteTask(id: number, actor = 'me'): void {
  const t = getTask(id);
  if (!t) throw new HttpError(404, `没有任务 T-${id}`);
  db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  db().prepare('DELETE FROM task_log WHERE task_id = ?').run(id); // 028: 过程记录跟着任务走
  db().prepare('DELETE FROM task_asks WHERE task_id = ?').run(id); // 055.2：提问卡片也一样
  logEvent({ actor, kind: 'task.deleted', text: `删除任务 T-${id}「${truncate(t.title, 60)}」` });
}

/** A reminder is just a task for 「我」; one open task per key is enough, however often we check. */
export function remindOnce(key: string, title: string, note: string): boolean {
  const open = db().prepare("SELECT 1 FROM tasks WHERE dedupe_key = ? AND status NOT IN ('done', 'failed')").get(key);
  if (open) return false;
  const t = createTask({ title, description: note, category: 'personal', executor: 'me' }, 'system');
  try { db().prepare('UPDATE tasks SET dedupe_key = ? WHERE id = ?').run(key, t.id); } catch { /* already taken */ }
  return true;
}

/** Find or create the task that tracks an agent session (Claude Code hooks). */
export function sessionTask(sessionId: string, opts: { executor: string; cwd?: string; title?: string }): Task {
  const found = db().prepare('SELECT * FROM tasks WHERE session_id = ?').get(sessionId) as Task | undefined;
  if (found) return found;
  const project = opts.cwd ? opts.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
  return createTask({
    title: opts.title ? truncate(opts.title, 80) : `${execLabel(opts.executor)} 会话 · ${project || sessionId.slice(0, 8)}`,
    executor: opts.executor, project, status: 'running', category: 'dev', session_id: sessionId,
  }, opts.executor);
}

export const CATEGORY_KEYS = Object.keys(CATEGORIES);
