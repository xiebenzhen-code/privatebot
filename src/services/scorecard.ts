// 041：战绩——每个执行者在每类活上到底做得怎么样。
//
// 只出事实，不打分、不排名、不下「谁更好」的结论。042 的调度大脑读这张表当「经验」，
// 所以口径必须钉在这里，不能各处自己算：
//   · 一个任务只算给第一次开跑的那个人（045：看 runs 里第一条；没有运行记录的退回 first_executor），接手之后也不改判；
//   · `me` 不计入——自己做的事不是执行者的能力；
//   · 少于 5 单标 sample='few'，页面不显示百分比（两个数算出来的比率是噪音）。
import { db } from '../db.ts';
import { dayOf } from '../domain.ts';
import type { Task } from './tasks.ts';
import type { Run } from './runs.ts';

export type Outcome = 'first_pass' | 'rework' | 'takeover' | 'failed' | 'unfinished';

/** 一个任务的「有没有返工 / 有没有被接手」。战绩只看这两件事，其余看任务本身。 */
export type Facts = { changes: number; takeover: boolean; /** 失败过至少一次（41.2）。 */ retried: boolean };

/** 少于此数就是样本太少。写死在这里，页面和接口用同一个数。 */
export const FEW = 5;

const EMPTY: Facts = { changes: 0, takeover: false, retried: false };

/**
 * 批量取事实，避免一个任务一条查询。
 * 返工有两个来源：审批里的「打回修改」，和 Issue 上的 `/wb rework`（后者不建审批，只留事件）。
 */
export function factsOf(ids: number[]): Map<number, Facts> {
  const out = new Map<number, Facts>();
  if (!ids.length) return out;
  const holes = ids.map(() => '?').join(',');
  const bump = (id: number, f: (x: Facts) => Facts) => out.set(id, f(out.get(id) ?? { ...EMPTY }));

  const decisions = db().prepare(`SELECT task_id, status FROM approvals
    WHERE task_id IN (${holes}) AND status IN ('changes', 'takeover')`).all(...ids) as { task_id: number; status: string }[];
  for (const r of decisions) {
    if (r.status === 'changes') bump(r.task_id, (x) => ({ ...x, changes: x.changes + 1 }));
    else bump(r.task_id, (x) => ({ ...x, takeover: true }));
  }

  const reworks = db().prepare(`SELECT task_id FROM events
    WHERE task_id IN (${holes}) AND kind = 'task.from_issue' AND text LIKE '%返工%'`).all(...ids) as { task_id: number }[];
  for (const r of reworks) bump(r.task_id, (x) => ({ ...x, changes: x.changes + 1 }));

  // 041.2：失败过又重跑成功的，不能算「一次过」。失败也算一次返工——用户看到的是同一单返工了一次。
  // 只认状态流转事件（`运行中 → 失败`），不猜时间点：没留下这条事件的旧任务就是没证据，不补。
  const fails = db().prepare(`SELECT task_id FROM events
    WHERE task_id IN (${holes}) AND kind = 'task.status' AND text LIKE '%→ 失败%'`).all(...ids) as { task_id: number }[];
  for (const r of fails) bump(r.task_id, (x) => ({ ...x, changes: x.changes + 1, retried: true }));
  // 运行记录是失败的直接证据；同一次失败已有事件时不再加一遍。
  const eventFailures = new Map<number, number>();
  for (const r of fails) eventFailures.set(r.task_id, (eventFailures.get(r.task_id) ?? 0) + 1);
  const runFailures = db().prepare(`SELECT r.task_id, COUNT(*) n FROM runs r
    WHERE r.task_id IN (${holes}) AND r.outcome = 'failed' AND r.backfilled = 0
      AND (EXISTS (SELECT 1 FROM runs later WHERE later.task_id = r.task_id AND later.attempt > r.attempt
        AND later.outcome IN ('done', 'failed', 'taken_over'))
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = r.task_id AND t.status = 'done'))
    GROUP BY r.task_id`)
    .all(...ids) as { task_id: number; n: number }[];
  for (const r of runFailures) bump(r.task_id, (x) => ({
    ...x, changes: x.changes + Math.max(0, r.n - (eventFailures.get(r.task_id) ?? 0)), retried: true,
  }));
  // 换人审查可留下同一轮的多条记录，一轮打回只算一次。
  const reviews = db().prepare(`SELECT task_id, COUNT(DISTINCT round) n FROM reviews
    WHERE task_id IN (${holes}) AND verdict = 'changes' GROUP BY task_id`)
    .all(...ids) as { task_id: number; n: number }[];
  for (const r of reviews) bump(r.task_id, (x) => ({ ...x, changes: x.changes + r.n }));
  const takeovers = db().prepare(`SELECT DISTINCT task_id FROM runs
    WHERE task_id IN (${holes}) AND outcome = 'taken_over' AND backfilled = 0`).all(...ids) as { task_id: number }[];
  for (const r of takeovers) bump(r.task_id, (x) => ({ ...x, takeover: true }));
  return out;
}

/**
 * 五种结局。**接手优先**：一个你接过去的任务，不管最后成没成，都不能算作执行者的失败。
 * 没结束的不计入（返回 'unfinished'，调用方自己跳过）。
 */
export function judge(task: Task, facts?: Facts): Outcome {
  const f = facts ?? EMPTY;
  // 接手有两个信号：审批里的 takeover，以及执行者被改成 me（手工改的也认）。
  const tookOver = f.takeover || (!!task.first_executor && task.first_executor !== 'me' && task.executor === 'me');
  if (tookOver) return 'takeover';
  if (task.status === 'failed') return 'failed';
  if (task.status !== 'done') return 'unfinished';
  // 041.2：失败→重跑→成功的单子是返工，不是一次过。需求 B 写的是「没有失败重试」才算一次过。
  return f.changes > 0 || f.retried ? 'rework' : 'first_pass';
}

/** 单条的便捷入口（测试和诊断用）。列表请用 factsOf 批量取。 */
export function outcomeOf(task: Task): Outcome {
  return judge(task, factsOf([task.id]).get(task.id));
}

export type Cell = {
  executor: string;
  /** 分类；按「执行者」汇总的那份是 ''。 */
  category: string;
  /** 后端；只有按「执行者 × 后端」那份才有值。 */
  backend: string;
  n: number;
  /** 0–1，保留两位。 */
  first_pass_rate: number;
  /** 平均返工次数（次/单），保留两位。 */
  rework_avg: number;
  fail_rate: number;
  takeover_rate: number;
  /** started_at → completed_at 的中位数（毫秒）。没有起止时间的单不参与。 */
  median_ms: number;
  avg_tokens: number;
  sample: 'ok' | 'few';
};

export type Scorecard = {
  days: number;
  /** 窗口起点（WB_TZ 下的日历日，含当天）。 */
  from: string;
  /** 执行者 × 分类——页面和大脑都用这份。 */
  rows: Cell[];
  /** 执行者一行（不分分类）——剧组页那行字用这份。 */
  by_executor: Cell[];
  /** 执行者 × 后端（017 的百炼 / 官方 DeepSeek 要能分开看），只在接口里给。 */
  by_backend: Cell[];
  /**
   * 042：执行者 × 派单方式。`brain` = 调度大脑派的，`hand` = 你自己选的。
   * 两列摆在一起才看得出大脑准不准——只看总成功率，分不清是活简单还是派得对。
   */
  by_route: RouteSplit[];
  /** 窗口内有多少单因为不知道是谁做的（first_executor 为空）被跳过。 */
  skipped: number;
};

/** 一种派单方式下的一份战绩。少样本照样标 few，页面不给百分比。 */
export type RouteSplit = {
  executor: string;
  route: 'brain' | 'hand';
  n: number;
  first_pass_rate: number;
  sample: 'ok' | 'few';
};

const round = (x: number) => Math.round(x * 100) / 100;

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function aggregate(tasks: Task[], facts: Map<number, Facts>, keyOf: (t: Task) => { executor: string; category: string; backend: string }): Cell[] {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = keyOf(t);
    const id = `${k.executor}\u0000${k.category}\u0000${k.backend}`;
    const list = groups.get(id);
    if (list) list.push(t); else groups.set(id, [t]);
  }
  const out: Cell[] = [];
  for (const [id, list] of groups) {
    const [executor, category, backend] = id.split('\u0000');
    const n = list.length;
    let firstPass = 0;
    let failed = 0;
    let takeover = 0;
    let tokens = 0;
    const spans: number[] = [];
    for (const t of list) {
      const f = facts.get(t.id) ?? EMPTY;
      const o = judge(t, f);
      if (o === 'first_pass') firstPass++;
      if (o === 'failed') failed++;
      if (o === 'takeover') takeover++;
      tokens += t.tokens_used ?? 0;
      if (t.started_at && t.completed_at) {
        const span = new Date(t.completed_at).getTime() - new Date(t.started_at).getTime();
        if (Number.isFinite(span) && span >= 0) spans.push(span);
      }
    }
    // 返工次数按「一共被打回几次」算，不是「有几单被打回过」——单子越大返工越多次，要能看出来。
    const changes = list.reduce((sum, t) => sum + (facts.get(t.id)?.changes ?? 0), 0);
    out.push({
      executor, category, backend, n,
      first_pass_rate: round(firstPass / n),
      rework_avg: round(changes / n),
      fail_rate: round(failed / n),
      takeover_rate: round(takeover / n),
      median_ms: median(spans),
      avg_tokens: Math.round(tokens / n),
      sample: n >= FEW ? 'ok' : 'few',
    });
  }
  const byExec = (a: Cell, b: Cell) => a.executor.localeCompare(b.executor);
  return out.sort((a, b) => byExec(a, b) || a.category.localeCompare(b.category) || a.backend.localeCompare(b.backend));
}

/**
 * 这条任务算给谁；算不出来（老数据留空、或就是你自己）返回 null。
 * 045：第一次开跑的运行（`firstRun`）说了算；没有运行记录的（hook 造的会话任务、更早的老任务）
 * 才退回 `first_executor`。两边都有时必然是同一个人——领取时同一个事务里先后写下的。
 */
function accountable(t: Task, firstRun?: string): string | null {
  const who = String(firstRun || t.first_executor || '').trim();
  if (!who || who === 'me') return null;
  return who;
}

/**
 * 每个任务第一条有效运行；到限额、取消、提问暂停、进行中不作为能力样本。
 * 回填来的运行、而任务本身又没记过 first_executor 的**不算**：回填时拿「现在的执行者」顶上是猜的，
 * 041 的底线是读不出来就留空，不能因为换了张表就把猜的数算进战绩（031a.1）。
 */
export function firstScoredRuns(ids: number[]): { first: Map<number, Run>; recorded: Set<number> } {
  const first = new Map<number, Run>();
  const recorded = new Set<number>();
  if (!ids.length) return { first, recorded };
  const holes = ids.map(() => '?').join(',');
  const rows = db().prepare(`SELECT r.*, t.first_executor
    FROM runs r JOIN tasks t ON t.id = r.task_id
    WHERE r.task_id IN (${holes})
    ORDER BY r.task_id, r.attempt, r.id`).all(...ids) as (Run & { first_executor: string | null })[];
  for (const r of rows) {
    recorded.add(r.task_id);
    if (first.has(r.task_id) || !['done', 'failed', 'taken_over'].includes(r.outcome) || !r.ended_at) continue;
    if (r.backfilled && !String(r.first_executor ?? '').trim()) continue;
    first.set(r.task_id, r);
  }
  return { first, recorded };
}

export function firstRunExecutors(ids: number[]): Map<number, string> {
  return new Map([...firstScoredRuns(ids).first].map(([id, r]) => [id, r.executor]));
}

/**
 * 最近 `days` 天（默认 30）的已结束任务；有运行记录时按首次有效运行结束日、耗时和token，旧任务退回原字段。
 * 窗口是「今天 + 前 days-1 天」：days=30 时，第 31 天完成的不算。
 * 战绩和能力档案（capability.ts）共用这一份，窗口口径不能各算各的。
 *
 * `by`：窗口按哪一天算。默认 `'run'`（首轮有效运行结束日）——战绩/能力要的是「这单第一次交活是什么时候」。
 * 完成账目传 `'finished'`（任务真正完成的那一天）：跨周的活今天才做完，得算在这周，
 * 否则它既进不了上周也进不了这周，「这周做完几件」会整单丢掉。
 */
export function endedWindow(daysIn: number | undefined, now: Date = new Date(), opts: { by?: 'run' | 'finished' } = {}): { days: number; from: string; ended: Task[] } {
  const raw = Number(daysIn ?? 30);
  const days = Math.min(Math.max(Number.isFinite(raw) ? Math.trunc(raw) : 30, 1), 365);
  const from = dayOf(new Date(now.getTime() - (days - 1) * 86400000));
  // 先按 ISO 粗筛（多留一天，免得时区把边界上的那单切掉），再用日历日精确判。
  const coarse = new Date(now.getTime() - (days + 1) * 86400000).toISOString();
  const candidates = db().prepare(`SELECT * FROM tasks
    WHERE status IN ('done', 'failed') AND completed_at IS NOT NULL AND completed_at >= ?
    ORDER BY completed_at DESC`).all(coarse) as Task[];
  const { first, recorded } = firstScoredRuns(candidates.map((t) => t.id));
  const ended = candidates.flatMap((t): Task[] => {
    const r = first.get(t.id);
    if (!r) {
      // 只有中性运行的不进样本；来源不明的历史回填仍交给skipped计数。
      if (recorded.has(t.id) && String(t.first_executor ?? '').trim()) return [];
      return [t];
    }
    return [{ ...t, first_executor: r.executor, started_at: r.started_at, completed_at: r.ended_at,
      tokens_used: r.tokens, backend: r.backend, route: r.route, finished_at: t.completed_at }];
  })
    .filter((t) => dayOf((opts.by === 'finished' ? (t.finished_at ?? t.completed_at) : t.completed_at)!) >= from);
  return { days, from, ended };
}

export function scorecard(opts: { days?: number; now?: Date } = {}): Scorecard {
  const { days, from, ended } = endedWindow(opts.days, opts.now);

  const facts = factsOf(ended.map((t) => t.id));
  const firstRun = firstRunExecutors(ended.map((t) => t.id));
  const counted: Task[] = [];
  let skipped = 0;
  for (const t of ended) {
    const who = accountable(t, firstRun.get(t.id));
    // 把算给谁写回这份拷贝：下面的聚合和 judge 的「接手」判断都只看 first_executor，不用各自再查一遍。
    if (who) counted.push(who === t.first_executor ? t : { ...t, first_executor: who }); else skipped++;
  }

  return {
    days,
    from,
    rows: aggregate(counted, facts, (t) => ({ executor: accountable(t)!, category: t.category, backend: '' })),
    by_executor: aggregate(counted, facts, (t) => ({ executor: accountable(t)!, category: '', backend: '' })),
    by_backend: aggregate(counted, facts, (t) => ({ executor: accountable(t)!, category: '', backend: t.backend ?? '' })),
    // 042: 借 aggregate 的分母和口径，只把「分类」这一格换成派单方式——省得再写一遍统计。
    by_route: aggregate(counted, facts, (t) => ({ executor: accountable(t)!, category: t.route === 'brain' ? 'brain' : 'hand', backend: '' }))
      .map((c) => ({ executor: c.executor, route: (c.category === 'brain' ? 'brain' : 'hand') as 'brain' | 'hand', n: c.n, first_pass_rate: c.first_pass_rate, sample: c.sample })),
    skipped,
  };
}

/** 剧组页那一行字。少于 5 单不显示百分比，也不藏起来——照实说样本太少。 */
export function summaryLine(c: Cell | undefined, days = 30): string {
  if (!c || !c.n) return `近 ${days} 天还没有战绩`;
  if (c.sample === 'few') return `近 ${days} 天 ${c.n} 单，样本太少`;
  const mins = Math.round(c.median_ms / 60000);
  return `近 ${days} 天 ${c.n} 单 · 一次过 ${Math.round(c.first_pass_rate * 100)}% · 平均返工 ${c.rework_avg.toFixed(1)} 次 · 中位 ${mins} 分钟`;
}
