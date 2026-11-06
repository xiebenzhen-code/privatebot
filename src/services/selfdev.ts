// 035：工作台自己开发自己。决策端在 `docs/specs/queue.json` 里排队，执行器每 5 分钟转发一次，
// 把第一个 `ready` 的项建成任务（项目 = 这个工作台自己）。用户仍然要亲手点「开始」。
//
// 三条硬规矩：
//   - 只读仓库：执行器只需要 Issues 读写 + Contents 只读，从不回写 queue.json；
//   - 不改状态：`ready` / `done` / `hold` 只有决策端能改，工作台只在自己库里记「这项建过任务」；
//   - 一次一个：只取第一个 ready 且没建过任务的项，避免并行改同一个仓库。
import { db } from '../db.ts';
import { nowIso, truncate } from '../domain.ts';
import { logEvent } from './core.ts';
import { createTask } from './tasks.ts';
import { githubRepos } from './github.ts';
import { enqueueGithub, GITHUB_REPO, type GithubJob, type Delivery } from './github-outbox.ts';
import { runnerOnline } from './runner.ts';
import { redactText } from './sources.ts';

export type QueueItem = { id: string; spec: string; title: string; status: string };
export type QueueParse = { items: QueueItem[]; problem: string };

const STATUSES = new Set(['ready', 'taken', 'done', 'hold']);
const SPEC_PATH = /^docs\/specs\/[\w.-]+\.md$/;

/** 排队文件。格式不对就返回一句人话，不猜、不建任务。 */
export function parseQueue(text: string): QueueParse {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { items: [], problem: 'queue.json 不是合法的 JSON' };
  }
  const list = raw?.items;
  if (!Array.isArray(list)) return { items: [], problem: 'queue.json 里没有 items 数组' };
  const items: QueueItem[] = [];
  for (const [i, it] of list.entries()) {
    const id = String(it?.id ?? '').trim();
    const spec = String(it?.spec ?? '').trim();
    const status = String(it?.status ?? '').trim();
    const title = String(it?.title ?? '').trim();
    if (!id) return { items: [], problem: `queue.json 第 ${i + 1} 项没有 id` };
    if (!SPEC_PATH.test(spec)) return { items: [], problem: `queue.json 第 ${i + 1} 项（${id}）的 spec 不是 docs/specs/ 下的 .md` };
    if (!STATUSES.has(status)) return { items: [], problem: `queue.json 第 ${i + 1} 项（${id}）的 status 只能是 ready / taken / done / hold，现在是「${status}」` };
    items.push({ id, spec, title: title || id, status });
  }
  return { items, problem: '' };
}

/** 第一个 ready 且这个库里没建过任务的项；没有就返回 null。 */
export function pickNext(items: QueueItem[], seen: (id: string) => boolean): QueueItem | null {
  for (const it of items) {
    if (it.status !== 'ready') continue;
    if (seen(it.id)) continue;
    return it;
  }
  return null;
}

/** 任务说明：固定模板，执行器照做。需求单路径写死在里面，模型不用猜。 */
export function taskDescription(item: QueueItem): string {
  return [
    `按需求单 ${item.spec} 实现。`,
    '',
    '1. 先读仓库根目录的 CLAUDE.md 和 docs/specs/README.md 的流程。',
    '2. 只做需求单里写的事；需求单没覆盖、拿不准的，停下来，在结果里写清楚问题，不要自己扩大范围。',
    '3. npm test 必须全绿。',
    '4. 在需求单末尾追加「## 回报（执行器，T-<n>）」，按 README 的回报模板写；和代码放在同一个分支里。',
    '5. 不要改 queue.json 和状态表里的「审查通过」。',
  ].join('\n');
}

export const selfRepo = (): string => {
  const explicit = (process.env.WB_SELF_REPO ?? '').trim();
  if (GITHUB_REPO.test(explicit)) return explicit;
  return githubRepos()[0] ?? '';
};
export const selfProject = (): string => (process.env.WB_SELF_PROJECT ?? '').trim() || 'ai-workbench';
export const selfEnabled = (): boolean => Boolean(selfRepo());

const seenItem = (id: string) => Boolean(db().prepare('SELECT 1 FROM selfdev_queue WHERE item_id = ?').get(id));

export type QueueSync = { created: number; problem: string; item: QueueItem | null };

/** 接收执行器读回的 queue.json 文本或脱敏后的错误。 */
export function importQueue(repo: string, text: string, error = ''): QueueSync {
  if (!selfEnabled() || repo.toLowerCase() !== selfRepo().toLowerCase()) return { created: 0, problem: '', item: null };
  if (error) {
    const why = '读不到 ' + repo + ' 的 queue.json（' + redactText(error).slice(0, 80) + '）';
    saveState(why);
    return { created: 0, problem: why, item: null };
  }
  const { items, problem } = parseQueue(text);
  if (problem) {
    saveState(problem);
    return { created: 0, problem, item: null };
  }
  // 一次只有一个在途：上一张还没做完，不建下一张，免得两个任务同时改同一个仓库。
  const inflight = db().prepare(`SELECT q.item_id FROM selfdev_queue q JOIN tasks t ON t.id = q.task_id
    WHERE t.status NOT IN ('done', 'failed') LIMIT 1`).get() as { item_id: string } | undefined;
  if (inflight) {
    saveState('');
    return { created: 0, problem: '', item: null };
  }
  const next = pickNext(items, seenItem);
  if (!next) {
    saveState('');
    return { created: 0, problem: '', item: null };
  }
  const project = selfProject();
  if (!projectRegistered(project)) {
    const why = `执行器配置里没有项目「${project}」，${next.id} 没法派给它`;
    saveState(why);
    return { created: 0, problem: why, item: null };
  }

  const task = createTask({
    title: `${next.id} ${next.title}`.slice(0, 120),
    description: taskDescription(next),
    project,
    category: 'dev',
    executor: 'pool',
    status: 'queued',
    mode: 'manual', // 035：绝不自动开始，用户点「开始」
  }, 'system');
  db().prepare('INSERT INTO selfdev_queue (item_id, spec, task_id, created_at) VALUES (?, ?, ?, ?)')
    .run(next.id, next.spec, task.id, nowIso());
  logEvent({ actor: 'system', kind: 'task.from_queue', task_id: task.id, text: `从 queue.json 的 ${next.id} 建了 T-${task.id}，等你在工作台点「开始」` });
  saveState('');
  return { created: 1, problem: '', item: next };
}

/** 项目在不在执行器的 projects 里，看最近一次心跳。 */
function projectRegistered(project: string): boolean {
  const row = db().prepare('SELECT meta FROM runners ORDER BY last_seen DESC LIMIT 1').get() as { meta: string } | undefined;
  if (!row) return true; // 执行器还没上报过：先建，跑的时候它会自己说没有这个项目
  try {
    const meta = JSON.parse(row.meta ?? '{}');
    const projects = meta.projects;
    if (!Array.isArray(projects)) return true;
    return projects.includes(project);
  } catch {
    return true;
  }
}

/** 接入页那一行。只存最近一次的结论，不存正文。 */
function saveState(problem: string): void {
  const now = nowIso();
  // 035.3.1：先读旧值再写。原来先 upsert 后读，「旧值」永远等于刚写进去的新值，
  // 于是 `prev.last_error !== problem` 恒为假，selfdev.problem 这条审计事件一次都写不出来。
  const prev = db().prepare('SELECT last_error FROM selfdev_state WHERE id = 1').get() as { last_error: string } | undefined;
  db().prepare(`INSERT INTO selfdev_state (id, last_ok, last_error, checked_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_ok = excluded.last_ok, last_error = excluded.last_error, checked_at = excluded.checked_at`)
    .run(problem ? '' : now, problem, now);
  // 同一个错误只记一次：每 5 分钟一条同样的记要，等于把事件流刷成噪声。
  if (problem && prev?.last_error !== problem) {
    logEvent({ actor: 'system', kind: 'selfdev.problem', text: `自己开发自己这条链有问题：${truncate(problem, 160)}` });
  }
}

export function selfdevState(): { ok: boolean; lastError: string; checkedAt: string } {
  const row = db().prepare('SELECT last_ok, last_error, checked_at FROM selfdev_state WHERE id = 1').get() as
    { last_ok: string; last_error: string; checked_at: string } | undefined;
  if (selfEnabled() && !runnerOnline()) {
    return { ok: false, lastError: '执行器离线，GitHub 通道暂停', checkedAt: row?.checked_at ?? '' };
  }
  return { ok: Boolean(row?.last_ok), lastError: row?.last_error ?? '', checkedAt: row?.checked_at ?? '' };
}

// ---------- D：结果回到 Issue ----------

/** 结果先排队，确认评论成功才写 selfdev_reports。 */
export async function reportToIssue(task: { id: number; title: string; result_text?: string | null; merged_commit?: string | null; project?: string | null }): Promise<boolean> {
  const repo = selfRepo();
  if (!repo || String(task.project ?? '') !== selfProject()) return false;
  if (db().prepare('SELECT 1 FROM selfdev_reports WHERE task_id = ?').get(task.id)) return false;
  const text = [
    `**T-${task.id}「${task.title}」**`,
    task.merged_commit ? `提交：\`${task.merged_commit}\`` : '',
    '',
    truncate(redactText(String(task.result_text ?? '').trim()), 1500) || '（执行器没有留下结果正文）',
  ].join('\n');
  enqueueGithub({ repo, kind: 'selfdev', body: text, dedupe: 'selfdev:' + task.id, subject: String(task.id) });
  return true;
}

export function recordSelfdevDelivery(job: GithubJob, result: Delivery): void {
  if (result.ok) db().prepare('INSERT OR IGNORE INTO selfdev_reports (task_id, issue_number, reported_at) VALUES (?, ?, ?)')
    .run(Number(job.subject), result.issueNumber, result.now);
}
