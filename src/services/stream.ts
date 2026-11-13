// 061.1：一条流。工作台只有一种东西叫「事」，一件事只有四种状态：
//   等你   要你动手：点头（审批）、等你选、没成、等你看、等你点开始
//          （派给你自己的待办不算：不急，单独一行，见 mine）
//   在做   执行器在干，或者排着队等执行器
//   做好了 有结果了
//   没成   你说「算了」的（061.3 才有那个按钮）——不单列，进「这周做完」那一层
//
// 「等你 N」只有这一个数：侧栏徽标、手机上的形象、首页，三处同一口径，都从 waitingCount() 来。
import { db } from '../db.ts';
import { dayOf, execLabel, lastDays } from '../domain.ts';
import { listApprovals, type Approval } from './approvals.ts';
import { getTask, listTasks, type Task } from './tasks.ts';
import { sweepReviews } from './review.ts';

/** 没成的事在「等你」里留多久。再往前的不再催你，去「这周做完」那一层或任务页里找。（061.3 的「算了」之前的过渡） */
export const FAILED_DAYS = 7;

export type WaitKind = 'approve' | 'ask' | 'failed' | 'review' | 'start' | 'mine';
export type StreamItem = {
  key: string; kind: WaitKind | 'running' | 'queued' | 'done';
  title: string; why: string; who: string; href: string; at: string;
  task?: Task; approvals?: Approval[];
};

const WHY: Record<WaitKind, string> = {
  approve: '等你点头', ask: '等你选', failed: '没成，选个办法', review: '等你看结果', start: '等你点开始', mine: '你的待办',
};

const recentFail = (t: Task, now: number) => Date.parse(t.completed_at ?? t.updated_at) >= now - FAILED_DAYS * 86400_000;

/** 手动模式、还没人点过「开始」的排队任务：执行器不会自己领，等的是你。 */
function needsStart(t: Task): boolean {
  if (t.status !== 'queued' || t.start_requested) return false;
  if (t.mode !== 'auto') return true;
  const s = db().prepare('SELECT auto_allowed, enabled FROM executor_settings WHERE executor = ?').get(t.executor) as { auto_allowed: number; enabled: number } | undefined;
  return !s || !s.enabled || !s.auto_allowed;
}

function waitKind(t: Task, pendingIds: Set<number>, now: number): WaitKind | null {
  // 062：另一位还在审（或者它在按意见改）——这时候还轮不到你，哪怕合并审批已经建好了。
  if (t.review_state === 'reviewing' || t.review_state === 'fixing') return null;
  if (pendingIds.has(t.id)) return 'approve';
  if (t.status === 'asking') return 'ask';
  if (t.status === 'review') return 'review';
  if (t.status === 'failed') return !t.dismissed_at && recentFail(t, now) ? 'failed' : null;
  if (t.executor === 'me' && t.route !== 'brain' && t.status !== 'done') return 'mine';
  if (needsStart(t)) return 'start';
  return null;
}

/**
 * 点头卡上那句话。合并、推送是技术用语，普通人看不懂——换成人话；别的审批用它自己的标题。
 * （包里配了用词的，以后在这里换成包的那句，见 060 的 wording。）
 */
export function askTitle(a: Pick<Approval, 'tool_name' | 'title'>): string {
  if (a.tool_name === 'git merge') return '做好了，收下吗？';
  if (a.tool_name === 'git push') return '要传到网上的仓库吗？';
  return a.title;
}

export type Stream = { waiting: StreamItem[]; doing: StreamItem[]; mine: StreamItem[]; done: StreamItem[]; weekDone: number };

export function stream(now: number = Date.now()): Stream {
  sweepReviews(now); // 审的那位失联了，就别让被审的事一直挂在「在审」
  const pending = listApprovals({ status: 'pending', limit: 200 });
  const byTask = new Map<number, Approval[]>();
  for (const a of pending) if (a.task_id) byTask.set(a.task_id, [...(byTask.get(a.task_id) ?? []), a]);
  const open = listTasks({ status: ['inbox', 'queued', 'running', 'review', 'asking', 'failed'], limit: 500 });
  // 跑完了、等你点头合并的事，任务自己的状态已经是 done——但对你来说它还没完：等你（或者另一位还在审）。
  // 这些要按任务本身进流（点开是线程），不能只当一条没主的审批。
  const more = new Set<number>([...byTask.keys(), ...(db().prepare("SELECT id FROM tasks WHERE review_state = 'reviewing'").all() as { id: number }[]).map((r) => r.id)]);
  for (const id of more) { if (open.some((x) => x.id === id)) continue; const t = getTask(id); if (t) open.push(t); }
  const openIds = new Set(open.map((t) => t.id));
  const pendingIds = new Set(byTask.keys());

  const waiting: StreamItem[] = [];
  const doing: StreamItem[] = [];
  // 061.1（用户 11-10 定）：你派给自己的待办不急，不亮、不算「等你」，在「在做」下面单独一行。
  const mine: StreamItem[] = [];
  for (const t of open) {
    // 062：审别人的那件只读的事不单独占一行，它是被审那件事的一部分。
    if (t.review_of) continue;
    const k = waitKind(t, pendingIds, now);
    const base = { title: t.title, who: t.executor, href: `/?task=${t.id}`, at: t.updated_at, task: t };
    if (k === 'mine') {
      mine.push({ ...base, key: `t${t.id}`, kind: 'mine', why: WHY.mine });
    } else if (k) {
      const n = byTask.get(t.id)?.length ?? 0;
      waiting.push({ ...base, key: `t${t.id}`, kind: k, why: k === 'approve' && n > 1 ? `等你点头（${n} 件）` : WHY[k], approvals: byTask.get(t.id) });
    } else if (t.review_state === 'reviewing') {
      doing.push({ ...base, key: `t${t.id}`, kind: 'running', why: `${execLabel(t.reviewer)} 在审`, who: '' });
    } else if (t.status === 'running') {
      doing.push({ ...base, key: `t${t.id}`, kind: 'running', why: t.review_state === 'fixing' ? '按意见改' : t.step || '在做' });
    } else if (t.status === 'queued' || t.status === 'inbox') {
      doing.push({ ...base, key: `t${t.id}`, kind: 'queued', why: t.review_state === 'fixing' ? '按意见改，排着' : '排队' });
    }
  }
  // 不挂在任务上的审批（钩子直接发起的、任务已经删了的）也是要你点头的事，单独一行。
  for (const a of pending) {
    if (a.task_id && openIds.has(a.task_id)) continue;
    if (a.task_id && byTask.get(a.task_id)?.[0] !== a) continue;
    waiting.push({ key: `a${a.id}`, kind: 'approve', title: a.title, why: WHY.approve, who: '', href: '/tasks/review', at: a.created_at, approvals: [a] });
  }
  // 等你：最早的在上面（等得最久的先处理）；在做：正在跑的在前，排队的按先来后到。
  waiting.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  doing.sort((a, b) => (a.kind === b.kind ? Date.parse(a.at) - Date.parse(b.at) : a.kind === 'running' ? -1 : 1));

  const week = new Set(lastDays(7));
  const doneRows = listTasks({ status: ['done'], limit: 200 }).filter((t) => t.completed_at && !t.review_of && !pendingIds.has(t.id) && t.review_state !== 'reviewing');
  doneRows.sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!));
  const done = doneRows.slice(0, 3).map((t): StreamItem => ({ key: `t${t.id}`, kind: 'done', title: t.title, why: '', who: t.executor, href: `/?task=${t.id}`, at: t.completed_at!, task: t }));
  const weekDone = doneRows.filter((t) => week.has(dayOf(t.completed_at!))).length;
  mine.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { waiting, doing, mine, done, weekDone };
}

/** 唯一的「等你 N」。 */
export function waitingCount(now: number = Date.now()): number {
  return stream(now).waiting.length;
}

export type CrewMember = { key: string; label: string; mark: string; online: boolean; resting: boolean };
const MARKS: Record<string, string> = { claude: 'C', codex: 'X', pool: '池', local: '本', workbuddy: 'W', zcode: 'Z', autoclaw: 'A', dsh: 'D' };

/** 061.1：顶上那排头像。开着的执行者（「我」不算），在线的在前。 */
export function crew(online: Set<string>, label: (k: string) => string): CrewMember[] {
  // 064：歇着的也在这排里（灰的，排最后）；移除了的不在。
  const rows = db().prepare("SELECT executor, enabled FROM executor_settings WHERE (enabled = 1 OR resting = 1) AND executor != 'me' ORDER BY priority, executor").all() as { executor: string; enabled: number }[];
  const out = rows.map((r) => ({ key: r.executor, label: label(r.executor), mark: MARKS[r.executor] ?? label(r.executor).slice(0, 1).toUpperCase(), online: !!r.enabled && online.has(r.executor), resting: !r.enabled }));
  return [...out.filter((m) => m.online), ...out.filter((m) => !m.online && !m.resting), ...out.filter((m) => m.resting)];
}
