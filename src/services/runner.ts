// 008: the runner-side API — claim a task atomically, report progress, finish into a merge approval.
import { db, tx } from '../db.ts';
import { catLabel, execLabel, fmtDateTime, nowIso, truncate } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';
import { createApproval } from './approvals.ts';
import { getTask, updateTask, type Task } from './tasks.ts';
import { autoPaused, getSetting, quotaBlock, setSetting } from './dispatch.ts';
import { notifyHandoffMissed } from './notify.ts';
import { tokensByExecutorSince } from './metrics.ts';
import { cleanLogLine, cleanResult } from './redact.ts';
import { lastDays } from '../domain.ts';
import { rerouteForQuota } from './brain.ts';
import { closeRun, markSlotLimited, openRun, setRunTokens, slotBlock } from './runs.ts';

export const RUNNER_FRESH_MS = 90_000; // heartbeat every 30s; two missed beats = offline

export type QueueBlocker = { code: string; text: string };

/** 工具审批暂停的是还活着的模型；合并、推送和部署审批发生在编码结束之后。 */
function activeCoding(executor: string): number {
  return (db().prepare(`SELECT COUNT(*) n FROM tasks t
    WHERE t.executor = ? AND t.status IN ('running', 'review') AND COALESCE(t.retry, '') = ''
      AND (EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.outcome = 'running' AND r.executor = t.executor)
        OR (NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id)
          AND (t.status = 'running' OR (t.runner_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.source = 'claude-hook' AND a.status = 'pending'
          )))))`).get(executor) as { n: number }).n;
}

/**
 * 033: 「排队」不等于「马上跑」。claimTask 里有六七处 continue，命中任何一处，任务就一直
 * 显示「等执行器领取」，页面却一个字都不解释——T-21 因此白等了四分钟，最后才发现是
 * 「文档」分类不在反代池的接活范围里。这里把同一套条件翻译成人话，只回答「现在为什么还没开始」。
 * 顺序必须和 claimTask 一致，否则提示会和实际行为对不上。
 */
export function queueBlocker(
  t: Pick<Task, 'status' | 'executor' | 'category' | 'mode' | 'start_requested'> & Partial<Pick<Task, 'retry'>>,
): QueueBlocker | null {
  if (t.status !== 'queued') return null;
  const who = execLabel(t.executor);
  if (autoPaused()) return { code: 'paused', text: '自动派单已暂停，恢复之后才会领取' };
  const s = db()
    .prepare('SELECT enabled, claimable, auto_allowed, categories, max_concurrent FROM executor_settings WHERE executor = ?')
    .get(t.executor) as
    | { enabled: number; claimable: number; auto_allowed: number; categories: string; max_concurrent: number | null }
    | undefined;
  if (!s) return { code: 'no-executor', text: `工作台里没有「${who}」这个执行者` };
  if (!s.enabled) return { code: 'disabled', text: `「${who}」已停用，在剧组页打开之后才会领活` };
  if (!s.claimable) return { code: 'handout', text: `「${who}」只派单、不执行——这活要在它自己的窗口里干` };
  if (!t.start_requested && !(t.mode === 'auto' && s.auto_allowed)) {
    return { code: 'wait-start', text: `等你点「开始」：「${who}」不会自己领活` };
  }
  const cats = s.categories.split(',').filter(Boolean);
  if (cats.length && !cats.includes(t.category)) {
    return {
      code: 'category',
      text: `「${who}」不接「${catLabel(t.category)}」这一分类，它只接 ${cats.map(catLabel).join(' / ')}。改一下分类，或者换一个执行者`,
    };
  }
  // 042: 窗口用到 90%、余额低于提醒线，也算「现在还开不了工」。以前只有每日 token 上限拦得住。
  const quota = quotaBlock(t.executor);
  if (quota) return quota;
  // 045：配了账号槽、但全都到上限 / 到期 / 停用。
  const slots = slotBlock(t.executor);
  if (slots) return { code: 'slots', text: `「${who}」${slots}` };
  if (dailyCapReached(t.executor)) return { code: 'cap', text: `「${who}」今天的额度用完了，明天才会继续领` };
  if (!t.retry && s.max_concurrent && activeCoding(t.executor) >= s.max_concurrent) {
    return { code: 'busy', text: `「${who}」同时在跑的任务已满（上限 ${s.max_concurrent} 个）` };
  }
  return null;
}


export type RunnerRow = { id: string; last_seen: string; meta: string };

// ---------- 035.3：部署之后的「接班」 ----------

/**
 * 部署完等新执行器的心跳：5 分钟。
 * 正常情况下交接是几秒钟的事（旧进程退出 → 接班助手启动新实例），5 分钟还没到就不是「慢」，
 * 是接班失败了——这时候执行器其实停着，页面必须说出来，不能只显示「离线」让人自己猜。
 */
export const HANDOFF_WAIT_MS = 5 * 60_000;
const HANDOFF_KEY = 'runner_handoff';

export type HandoffRecord = {
  runner: string;
  /** 要退出的那个执行器：新心跳只要不是它，就算接班到了。 */
  from_pid: number;
  from_hash: string;
  at: string;
  /**
   * 035.3.3：这次交接是谁引起的。部署完执行器就退出了，跑完那一步的人已经不在了——
   * 记下任务 id，等新执行器真的接管（或者超过 5 分钟没人接管）时由这边给它结账，
   * 否则任务永远停在「running」，而队列「一次只允许一个在途」会因此再也不建新单。
   */
  task_id?: number;
  /** 已经为「没接班」推过一条，别每 60 秒推一次。 */
  notified?: boolean;
};

export type HandoffView = {
  state: 'none' | 'waiting' | 'missed';
  runner: string;
  from_pid: number;
  from_hash: string;
  at: string;
  waited_ms: number;
  minutes: number;
};

export function readHandoff(): HandoffRecord | null {
  const raw = getSetting(HANDOFF_KEY, '');
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as HandoffRecord;
    if (!rec || !(Number(rec.from_pid) > 0) || !rec.at) return null;
    return rec;
  } catch {
    return null; // 坏记录当没有：它只影响一条提示，不该让页面 500
  }
}

function writeHandoff(rec: HandoffRecord | null): void {
  setSetting(HANDOFF_KEY, rec ? JSON.stringify(rec) : '');
}

/** 要退出的执行器在退出前调这里：记下「谁要走」，让页面知道接下来该有一个新执行器出现。 */
export function expectHandoff(input: { runner?: string; pid?: number; code_hash?: string; task_id?: number }): HandoffRecord {
  const pid = Math.round(Number(input.pid) || 0);
  if (!(pid > 0)) throw new HttpError(400, 'pid 要是正整数：得知道是哪一个执行器要走，才知道要等谁接班');
  const taskId = Math.round(Number(input.task_id) || 0);
  const rec: HandoffRecord = {
    runner: String(input.runner ?? '').slice(0, 80),
    from_pid: pid,
    from_hash: String(input.code_hash ?? '').slice(0, 12),
    at: nowIso(),
    ...(taskId > 0 ? { task_id: taskId } : {}),
  };
  writeHandoff(rec);
  logEvent({
    actor: 'system', kind: 'runner.handoff_expected',
    text: `部署完成：${rec.runner || '执行器'}（pid ${rec.from_pid}，代码 ${rec.from_hash || '未知'}）要退出，等新执行器接班`,
  });
  return rec;
}

/**
 * 这条心跳是不是「新来的那一个」：换过进程号，或者换过代码指纹。
 * 旧进程自己在交接期间还会跳一两次，pid 和指纹都没变，不算——否则刚记下就被自己的心跳撤掉了。
 */
export function handoffArrived(rec: HandoffRecord, meta: Record<string, unknown>): boolean {
  const pid = Math.round(Number(meta.pid) || 0);
  if (pid > 0 && pid !== Number(rec.from_pid)) return true;
  const hash = String(meta.code_hash ?? '');
  return Boolean(hash) && Boolean(rec.from_hash) && hash !== rec.from_hash;
}

/**
 * 没配 `runnerId` 的执行器，id 是按进程号生成的 `runner-12345`——换进程号就等于换 id。
 * 所以在判断「这是不是同一台机器上那一个」时，这种默认格式不能按 id 比。
 */
export function isProcessScopedRunnerId(id: string): boolean {
  return /^runner-\d+$/.test(String(id ?? ''));
}

/**
 * 这条心跳算不算「这条记录的主人家里的执行器」（含接班后的新实例）。
 *
 * 035.3.1：原来只看 `rec.runner !== runnerId` 就跳过。可执行器没配 runnerId 时 id 默认是
 * `runner-<进程号>`，新进程的 id 必然和旧的不同，于是新心跳在比 pid 之前就被当成「别的执行器」，
 * 记录永远撤不掉——新执行器明明接班了，页面 5 分钟后照样报「没有接班」还推一条。
 */
export function sameRunnerOwner(rec: HandoffRecord, runnerId: string): boolean {
  const mine = String(rec.runner ?? '');
  const theirs = String(runnerId ?? '');
  if (!mine || !theirs) return true; // 老记录 / 心跳没带 id：按同一个人处理，否则提示永远撤不掉
  if (mine === theirs) return true;
  return isProcessScopedRunnerId(mine) || isProcessScopedRunnerId(theirs);
}

/** 心跳到了：确认接班就撤掉记录。别的执行器（id 不同）的心跳不算接班。 */
function settleHandoff(runnerId: string, metaText: string): void {
  const rec = readHandoff();
  if (!rec) return;
  if (!sameRunnerOwner(rec, runnerId)) return;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(metaText) as Record<string, unknown>; } catch { return; }
  if (!handoffArrived(rec, meta)) return;
  writeHandoff(null);
  logEvent({
    actor: 'system', kind: 'runner.handoff_done',
    text: `新执行器已接班（pid ${meta.pid ?? '未知'}，代码 ${String(meta.code_hash ?? '未知')}），比旧的多等了 ${Math.max(0, Math.round((Date.now() - Date.parse(rec.at)) / 1000))} 秒`,
  });
  // 035.3.3：部署那一步的执行器已经退出了，跑完 deployStep 的那个进程不在，没人给任务收尾。
  finishDeployedTask(rec, `已部署；新执行器（pid ${meta.pid ?? '未知'}、代码 ${String(meta.code_hash ?? '未知').slice(0, 8) || '未知'}）已接班`);
}

/**
 * 这条任务现在是不是「部署完、正等着换执行器」的那条。
 *
 * 交接记录可能挂很久（没人接班时会挂到人来处理）。这中间人完全可能在任务页点「重新开始」或
 * 「重试部署」，任务又跑起来了——这时候拿旧记录去结账，就是把正在跑的活硬标成 done。
 * 所以只认那句话对得上的：部署那一步写下来的 step。
 */
function awaitingHandoffStep(t: Task): boolean {
  return t.status === 'running' && /已部署/.test(String(t.step ?? ''));
}

/** 部署后由接班负责收尾：只有还停在 running 的才动，别的状态一律不碰。 */
function finishDeployedTask(rec: HandoffRecord, step: string): void {
  const id = Math.round(Number(rec.task_id) || 0);
  if (!(id > 0)) return; // 老记录 / 不是部署引起的交接：没有任务可收
  const t = getTask(id);
  if (!t || !awaitingHandoffStep(t)) return;
  updateTask(id, { status: 'done', step }, 'system');
}

/** 没人接班：这条链上不会再有进程给任务写结局了，按失败结账并说清「代码其实已经上线」。 */
function markHandoffLost(rec: HandoffRecord, minutes: number): void {
  const id = Math.round(Number(rec.task_id) || 0);
  if (!(id > 0)) return;
  const t = getTask(id);
  if (!t || !awaitingHandoffStep(t)) return;
  updateTask(id, {
    status: 'failed',
    step: `部署完成，但 ${minutes} 分钟没有执行器接班；容器是新的，执行器要手动启动一次`,
    fail_reason: `部署完执行器退出后没人接班（旧 pid ${rec.from_pid}）。代码已经上线，把执行器启动起来就能接着用`,
  }, 'system');
}

/** 页面用：现在是「等着接班」还是「没人接班」。纯读，不改状态。 */
export function handoffState(now = Date.now()): HandoffView {
  const rec = readHandoff();
  if (!rec) return { state: 'none', runner: '', from_pid: 0, from_hash: '', at: '', waited_ms: 0, minutes: 0 };
  const waited = Math.max(0, now - Date.parse(rec.at));
  return {
    state: waited > HANDOFF_WAIT_MS ? 'missed' : 'waiting',
    runner: rec.runner,
    from_pid: rec.from_pid,
    from_hash: rec.from_hash,
    at: rec.at,
    waited_ms: waited,
    minutes: Math.round(waited / 60_000),
  };
}

/**
 * 超过 5 分钟还没人接班：推一条（029 的渠道），然后记下推过了。
 * 没配渠道时不标 notified——下次巡检再试，否则「推不出去」会被当成「已经说过了」。
 */
export async function checkHandoffMissed(now = Date.now()): Promise<number> {
  const rec = readHandoff();
  if (!rec) return 0;
  const view = handoffState(now);
  if (view.state !== 'missed') return 0;
  // 035.3.3：先给任务结账，和「推送有没有成功」分开。绑在一起的话，没配渠道时任务会永远挂在
  // running 上，队列「一次只允许一个在途」于是再也不建新单——一次推送失败拖死整条自举链。
  markHandoffLost(rec, view.minutes);
  if (rec.notified) return 0;
  const sent = await notifyHandoffMissed({ from_pid: rec.from_pid, minutes: view.minutes });
  if (!sent) return 0;
  writeHandoff({ ...rec, notified: true });
  logEvent({
    actor: 'system', kind: 'notify.handoff_missed',
    text: `部署后 ${view.minutes} 分钟没有执行器接班，已推送 ${sent} 个渠道`,
  });
  return sent;
}

/** 每分钟看一眼有没有该提醒的。真正的判断在 checkHandoffMissed 里，这里只负责节奏。 */
export function startHandoffWatch(): void {
  setInterval(() => { void checkHandoffMissed().catch(() => 0); }, 60_000).unref?.();
}

export function heartbeat(id: string, meta?: unknown): RunnerRow {
  const rid = String(id ?? '').trim().slice(0, 80);
  if (!rid) throw new HttpError(400, '缺少执行器 id');
  const metaText = typeof meta === 'string' ? meta : JSON.stringify(meta ?? {});
  db().prepare(`INSERT INTO runners (id, last_seen, meta) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, meta = excluded.meta`).run(rid, nowIso(), metaText.slice(0, 2000));
  // 035.3：这一跳正好证明了「新执行器来了」——部署后那条「等待接班」的提示到这里才该消失。
  settleHandoff(rid, metaText);
  return { id: rid, last_seen: nowIso(), meta: metaText };
}

export type RunnerView = {
  id: string;
  last_seen: string;
  online: boolean;
  /** 028.1: 执行器启动时加载的代码指纹前 8 位，排查「到底跑的是哪一版」。 */
  code_hash: string;
  /** 028.1: 磁盘上的代码已经变了、这个进程还在跑旧的。 */
  stale: boolean;
  pid: number | null;
};

export function listRunners(): RunnerView[] {
  const rows = db().prepare('SELECT id, last_seen, meta FROM runners ORDER BY id').all() as RunnerRow[];
  return rows.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = (JSON.parse(r.meta ?? '{}') ?? {}) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    return {
      id: r.id,
      last_seen: r.last_seen,
      online: Date.now() - Date.parse(r.last_seen) < RUNNER_FRESH_MS,
      code_hash: String(meta.code_hash ?? '').slice(0, 12),
      stale: Boolean(meta.stale_code),
      pid: Number(meta.pid) > 0 ? Number(meta.pid) : null,
    };
  });
}

/** 028.1: 在线、却在跑旧代码的那一个。页面据此提醒「重启执行器新功能才生效」。 */
export function staleRunner(): RunnerView | null {
  return listRunners().find((r) => r.online && r.stale) ?? null;
}

export const runnerOnline = () => listRunners().some((r) => r.online);

/**
 * 在线执行器真正认领的执行者名字（来自心跳里的 meta.executors）。
 * 024.1：以前只有「有没有任何执行器在线」一个布尔，于是「新建任务」里 Claude、Codex
 * 这些根本没人轮询的执行者也显示得像能用——派过去就一直排队。
 */
export function runnerExecutors(): Set<string> {
  const fresh = Date.now() - RUNNER_FRESH_MS;
  const rows = db().prepare('SELECT last_seen, meta FROM runners').all() as { last_seen: string; meta: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    if (Date.parse(r.last_seen) <= fresh) continue; // 掉线的执行器不算
    try {
      const meta = JSON.parse(r.meta) as { executors?: unknown };
      if (Array.isArray(meta.executors)) for (const e of meta.executors) if (typeof e === 'string' && e) out.add(e);
    } catch { /* meta 不是 JSON 就当没有 */ }
  }
  return out;
}

/** Gate checks that do not depend on which task we are looking at. */
function dailyCapReached(executor: string): boolean {
  const row = db().prepare('SELECT daily_token_cap FROM executor_settings WHERE executor = ?').get(executor) as { daily_token_cap: number | null } | undefined;
  if (!row?.daily_token_cap) return false;
  const used = tokensByExecutorSince(lastDays(1)[0])[executor] ?? 0;
  return used >= row.daily_token_cap;
}

/**
 * 042：额度不够、你又亲手选了这个执行者——不换人，只把原因写到 `step` 上（033 的原因显示会读它）。
 * 每轮轮询都会走到这里，所以只在文字变了时写一次，不然审计会被刷屏。
 */
function noteQuotaWait(id: number, text: string): void {
  const t = getTask(id);
  if (!t || t.step === text) return;
  db().prepare('UPDATE tasks SET step = ?, updated_at = ? WHERE id = ?').run(text, nowIso(), id);
  logEvent({ actor: 'system', kind: 'dispatch.quota_wait', task_id: id, text: `T-${id} ${text}` });
}

/**
 * Claim one task. Check the executor cap and reserve the run in the same transaction.
 */
export function claimTask(executors: string[], runnerId: string): Task | null {
  if (autoPaused()) return null;
  // No ?executors= means "any executor this workbench is allowed to run" — the per-task
  // auto_allowed check below decides whether a task may start without a person.
  const wanted = executors.filter(Boolean).length
    ? executors.filter(Boolean)
    : (db().prepare('SELECT executor FROM executor_settings WHERE enabled = 1').all() as { executor: string }[])
      .map((r) => r.executor);
  if (!wanted.length) return null;

  const placeholders = wanted.map(() => '?').join(',');
  const rows = db().prepare(`SELECT t.id, t.executor, t.category, t.mode, t.start_requested, t.route, t.retry FROM tasks t
    JOIN executor_settings s ON s.executor = t.executor
    WHERE t.status = 'queued'
      AND t.executor IN (${placeholders})
      AND s.enabled = 1 AND s.claimable = 1
      -- auto_allowed only governs "start without a person"; a task the user pressed 开始 on
      -- can be claimed by any enabled executor (013: ZCode and pool are manual-only).
      AND (t.start_requested = 1 OR (t.mode = 'auto' AND s.auto_allowed = 1))
    ORDER BY t.created_at LIMIT 20`).all(...wanted) as
    { id: number; executor: string; category: string; mode: string; start_requested: number; route: string; retry: Task['retry'] }[];

  for (const row of rows) {
    const setting = db().prepare('SELECT categories FROM executor_settings WHERE executor = ?')
      .get(row.executor) as { categories: string } | undefined;
    const cats = (setting?.categories ?? '').split(',').filter(Boolean);
    if (cats.length && !cats.includes(row.category)) continue;
    // 042 A：开跑前再看一眼额度。大脑派的任务换人，你亲手选的只把原因写出来（不擅自改你的决定）。
    const quota = quotaBlock(row.executor);
    if (quota) {
      const task = getTask(row.id);
      if (task && task.route === 'brain') rerouteForQuota(task, quota.text);
      else noteQuotaWait(row.id, quota.text);
      continue;
    }
    // 045：顺序和 queueBlocker 一致——额度之后、每日上限之前。
    const slots = slotBlock(row.executor);
    if (slots) { noteQuotaWait(row.id, slots); continue; }
    if (dailyCapReached(row.executor)) continue;
    const claimed = tx(() => {
      const limit = (db().prepare('SELECT max_concurrent FROM executor_settings WHERE executor = ?')
        .get(row.executor) as { max_concurrent: number | null } | undefined)?.max_concurrent;
      if (!row.retry && limit && activeCoding(row.executor) >= limit) return null;
      // 041.1：只在还没有归属时写 first_executor，重试、换人都不覆盖第一次开跑的人。
      const claim = db().prepare(`UPDATE tasks SET status = 'running', runner_id = ?, started_at = ?,
        first_executor = COALESCE(NULLIF(first_executor, ''), ?),
        start_requested = 0, fail_reason = NULL, result_text = NULL, notified_state = NULL, no_changes = 0, updated_at = ?
        WHERE id = ? AND status = 'queued'`).run(runnerId, nowIso(), row.executor, nowIso(), row.id);
      if (claim.changes !== 1) return null;
      // 重新编码是新运行；只重试合并或推送不启动模型。
      if (row.retry) closeRun(row.id, 'cancelled', { reason: '转到合并或推送重试' });
      else openRun(row.id, row.executor, row.route === 'brain' ? 'brain' : row.start_requested ? 'me' : 'rule');
      logEvent({ actor: 'system', kind: 'task.claimed', task_id: row.id, text: `执行器 ${runnerId} 领走 T-${row.id}` });
      appendTaskLog(row.id, `执行器 ${runnerId} 领走，开始执行`);
      return getTask(row.id)!;
    });
    if (claimed) return claimed;
  }
  return null;
}

export function reportProgress(id: number, body: Record<string, unknown>): Task {
  const task = getTask(id);
  if (!task) throw new HttpError(404, `没有任务 T-${id}`);
  const step = String(body.step ?? '').slice(0, 300);
  const progress = body.progress === undefined ? undefined : Math.min(100, Math.max(0, Math.round(Number(body.progress) || 0)));
  const tokens = body.tokens_used === undefined ? undefined : Math.max(0, Math.round(Number(body.tokens_used) || 0));
  const logTail = body.log_tail === undefined ? undefined : String(body.log_tail).slice(-2048);
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (step) { sets.push('step = ?'); args.push(step); }
  if (progress !== undefined) { sets.push('progress = ?'); args.push(progress); }
  if (tokens !== undefined) { sets.push('tokens_used = ?'); args.push(tokens); }
  if (logTail !== undefined) { sets.push('runner_log = ?'); args.push(logTail); }
  if (!sets.length) return task;
  sets.push('updated_at = ?'); args.push(nowIso());
  db().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  // 045.1：同一个数也记到进行中的那条运行上——它是这一次自己的累计，重试不会把上一次的盖掉。
  if (tokens !== undefined) setRunTokens(id, tokens);
  // 028: 过程记录只收「步骤变了」这件事——执行器每 30 秒报一次同样的 step，不该刷屏。
  if (step && step !== task.step) appendTaskLog(id, step);
  return getTask(id)!;
}

export type FinishInput = {
  result?: string; summary?: string; branch?: string; diff_stat?: string; tests?: string;
  /** The commit the run ended on. Approval is for this exact tree, not for the branch tip later. */
  commit?: string;
  /** 017: the backend that actually produced this run (bailian / deepseek). */
  backend?: string;
  /** 028: 模型的最终回答。只读任务的成果就是它，最长 8000 字，落库前打码。 */
  result_text?: string;
  /** 028: 分支相对 main 没有提交、worktree 也没有未提交改动 → 不需要合并审批。 */
  no_changes?: boolean;
  /** 039: 这个任务改了哪些文件（相对仓库根）。只改 docs/ 时合并审批自动通过。 */
  changed_files?: string[];
  /** 043 F：这次运行里被拒掉的工具（Claude Code 结果事件的 permission_denials）。 */
  denials?: string[];
  /** 045：这次用的账号槽、执行框架、模型。槽必须是这个执行者名下真实存在的。 */
  slot?: string; harness?: string; model?: string;
  /** 045.1：这一次运行最终的累计 token（从 0 数起）。不到一个上报周期就结束的短任务靠它才有数。 */
  tokens_used?: number;
  /** 045：result = 'limited' 时带上。resetAt 认不出来就给 null，工作台不猜。 */
  limit?: { kind?: string; resetAt?: string | null; raw?: string };
  /** 046.3：这次在哪跑：none（宿主上）/ docker（第一档沙箱）。别的值一律当 none。 */
  sandbox?: string;
};

const LIMIT_KINDS: Record<string, string> = { session: '五小时窗口的', weekly: '本周的', other: '' };

/**
 * 045.1：收尾时执行器报的最终累计。给了就同步到任务上（口径同 reportProgress：最近一次上报），
 * 并返回给 closeRun 记到这一次运行上；没给（老执行器）返回 undefined，运行保留进度上报最后写下的值。
 */
function finalTokens(id: number, input: FinishInput): number | undefined {
  if (input.tokens_used === undefined || input.tokens_used === null) return undefined;
  const n = Math.max(0, Math.round(Number(input.tokens_used) || 0));
  db().prepare('UPDATE tasks SET tokens_used = ? WHERE id = ?').run(n, id);
  return n;
}

/**
 * 045：到额度上限不是失败——这次运行记「到上限」、槽记上重置时间、任务回到排队，下一轮自动换槽。
 * 只有报上来的槽真实存在才这么做；没有槽（走反代池的）就照普通失败处理，不然会原地打转。
 */
function finishLimited(task: Task, input: FinishInput): { task: Task } | null {
  const slot = String(input.slot ?? '').trim();
  const real = slot && db().prepare("SELECT 1 FROM accounts WHERE name = ? AND executor = ? AND slot_dir <> ''").get(slot, task.executor);
  if (!real) return null;
  const kind = LIMIT_KINDS[String(input.limit?.kind ?? 'other')] ?? '';
  const { until, known } = markSlotLimited(slot, input.limit?.resetAt ?? null);
  const why = `账号槽 ${slot} 用到了${kind}上限${known ? '' : '（重置时间没认出来，1 小时后再试）'}`;
  const tokens = finalTokens(task.id, input);
  closeRun(task.id, 'limited', { reason: why, slot, harness: input.harness, model: input.model, tokens,
    backend: /^[a-z0-9_-]{1,20}$/i.test(String(input.backend ?? '')) ? String(input.backend).toLowerCase() : undefined });
  updateTask(task.id, { status: 'queued', step: `${why}，换下一个账号继续`, start_requested: 1 }, 'system');
  appendTaskLog(task.id, `${why}；回到排队，换下一个账号`);
  logEvent({ actor: 'system', kind: 'slot.limited', task_id: task.id,
    text: `T-${task.id}：${why}，${fmtDateTime(until)} 之前不再用它` });
  return { task: getTask(task.id)! };
}

/**
 * 043 F：退出码 0 不等于干完了。agent 被拒了权限、一个字没写，照样退出码 0；
 * 028 又让「没有改动」直接算完成——两条叠起来就是假完成。这里是唯一的判定口：
 * 没有改动时，只有「只要一个回答」的任务、而且没有被拦过，才算完成。
 */
export function hollowRun(task: Pick<Task, 'answer_only' | 'route_read_only'>, input: FinishInput): string {
  if (input.result !== 'done' || input.no_changes !== true) return '';
  const denials = [...new Set((Array.isArray(input.denials) ? input.denials : []).map((d) => String(d).trim()).filter(Boolean))].slice(0, 5);
  if (denials.length) return `被拦住了：${denials.join('、')} 没有放行，什么都没写成。去设置 › 安全看是哪条规则，放开后点重试`;
  const answerOnly = task.answer_only === 1 || task.route_read_only === 1;
  if (!answerOnly) return '没有产出任何文件。如果这件事只需要一个回答，勾上「只要一个回答」再重试';
  return '';
}

// ---------- 028: 过程记录 ----------

/** 每个任务最多留这么多行，超过丢最旧的。 */
export const TASK_LOG_MAX = 200;

/** 记一行「做了什么」。只收步骤短句，工具输出和文件内容不该走到这里。 */
export function appendTaskLog(taskId: number, line: string): void {
  const text = cleanLogLine(line);
  if (!text) return;
  db().prepare('INSERT INTO task_log (task_id, ts, line) VALUES (?, ?, ?)').run(taskId, nowIso(), text);
  db().prepare(`DELETE FROM task_log WHERE task_id = ? AND id NOT IN (
    SELECT id FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT ?)`).run(taskId, taskId, TASK_LOG_MAX);
}

/** 旧的在上，和详情页「过程」的顺序一致。 */
export function listTaskLog(taskId: number, limit = TASK_LOG_MAX): { ts: string; line: string }[] {
  return db().prepare('SELECT ts, line FROM task_log WHERE task_id = ? ORDER BY id ASC LIMIT ?')
    .all(taskId, limit) as { ts: string; line: string }[];
}

/** A finished task never merges itself: success turns into an approval the user has to clear —
 *  028: unless the run changed nothing (a read-only task), in which case there is nothing to merge. */
export function finishTask(id: number, input: FinishInput): { task: Task; approval_id?: number } {
  const task = getTask(id);
  if (!task) throw new HttpError(404, `没有任务 T-${id}`);
  if (input.result === 'limited') {
    const r = finishLimited(task, input);
    if (r) return r;
    input = { ...input, result: 'failed', summary: input.summary || `到额度上限：${String(input.limit?.raw ?? '').slice(0, 200)}` };
  }
  const hollow = hollowRun(task, input);
  const ok = input.result === 'done' && !hollow;
  const noChanges = ok && input.no_changes === true;
  // 045.2：打码在这里做一次。下面的审批说明、当前步骤、过程记录、失败原因、运行原因都从它取，不各守一半。
  const summary = hollow || cleanResult(String(input.summary ?? ''), 4000);
  // 025: 失败时绝不写默认分支——以前无条件写 wb/T-<id>，于是任何失败的任务都长出「重试合并」按钮，
  // 点一下就把真正的失败原因（step）盖掉了。028：没有改动也一样不写，分支本来就是空的。
  const reportedBranch = String(input.branch ?? '').slice(0, 200);
  const branch = ok && !noChanges ? (reportedBranch || `wb/T-${id}`) : reportedBranch;
  const diff = String(input.diff_stat ?? '').slice(0, 2000);
  const tests = String(input.tests ?? '').slice(0, 2000);
  // Only a real object id is worth recording; anything else would make the merge step guess.
  const commit = /^[0-9a-f]{7,40}$/i.test(String(input.commit ?? '').trim()) ? String(input.commit).trim() : '';
  // 017: same idea for the backend name — it ends up in the UI and the issue comment.
  const rawBackend = String(input.backend ?? '').trim();
  const backend = /^[a-z0-9_-]{1,20}$/i.test(rawBackend) ? rawBackend.toLowerCase() : '';
  // 028: 模型的最终回答。打码 + 截断都在这里做一次，后面所有出口都拿到干净文本。
  const resultText = cleanResult(String(input.result_text ?? ''));

  // createApproval parks the task in 'review'; the run itself has finished, so mark it done after.
  let approvalId: number | undefined;
  // 039: 只改文档的合并审批会被审批服务自己过掉，所以这里拿到的是「已通过」——step 要说清为什么没等你。
  let autoMerged = false;
  if (ok && !noChanges) {
    const approval = createApproval({
      title: `合并 ${branch} 到 main`,
      summary: [
        `分支：${branch}${commit ? ` · 提交：${commit.slice(0, 7)}` : ''}${backend ? ` · 后端：${backend}` : ''}`,
        summary,
        diff && `改动：${diff}`,
        tests && `测试：${tests}`,
      ].filter(Boolean).join('\n\n'),
      risk: 'medium',
      executor: task.executor,
      task_id: id,
      tool_name: 'git merge',
      tool_input: { branch, commit },
      changed_files: (() => {
        const files = Array.isArray(input.changed_files) ? input.changed_files.map(String) : [];
        // 039：超过 500 个文件的任务不猜——直接当「有代码改动」，让人点。截断清单再判定等于拿半份证据放行。
        return files.length > 500 ? [] : files;
      })(),
    });
    approvalId = approval.id;
    autoMerged = approval.status === 'approved';
  }

  const finalStep = ok
    ? (noChanges
      ? '已完成（没有改动，不需要合并）'
      : autoMerged ? `已完成，文档改动自动通过合并审批（推送仍要你点）` : `已完成，等合并 ${branch}`)
    : truncate(summary || '执行器报告失败', 200);

  updateTask(id, {
    status: ok ? 'done' : 'failed',
    progress: ok ? 100 : task.progress ?? 0,
    step: finalStep,
    // 025: 失败原因单独存，重试/编辑/改当前步骤都不会动它；下次领取时清空。
    // 043: 走到这里的失败都是执行阶段挂的（连合并都没开始），不能留下「可重试的合并」——
    // 以前 retry 一路不清，于是一个早期合并失败的标记会赖在任务上：卡片永远给「重试合并」，
    // 点一次还是卡在项目检查上再挂一次（T-15 就是这样）。
    ...(ok ? {} : { fail_reason: truncate(cleanResult(summary || '执行器报告失败', 300), 300), retry: null }),
    ...(resultText ? { result_text: resultText } : {}),
    ...(branch ? { branch } : {}),
    ...(backend ? { backend } : {}),
    // 028.1: 记下来，阶段条才知道这次没有走合并/推送。
    ...(ok ? { no_changes: noChanges ? 1 : 0 } : {}),
  }, 'system');
  appendTaskLog(id, ok
    ? (noChanges ? '完成：没有改动，不需要合并'
      : autoMerged ? `完成：只改了文档，合并自动通过（${branch}）` : `完成：等合并 ${branch}`)
    : `失败：${truncate(summary || '执行器没有给出原因', 160)}`);
  if (backend) appendTaskLog(id, `后端：${backend}`);
  closeRun(id, ok ? 'done' : 'failed', {
    reason: ok ? null : (summary || '执行器报告失败'), backend: backend || undefined,
    slot: input.slot, harness: input.harness, model: input.model, tokens: finalTokens(id, input), sandbox: input.sandbox,
  });
  logEvent({
    actor: 'system', kind: ok ? 'task.finished' : 'task.failed', task_id: id,
    text: `T-${id}「${truncate(task.title, 40)}」${ok ? (noChanges ? '执行完成（没有改动）'
      : autoMerged ? '执行完成，只改文档，合并自动通过' : '执行完成，等待合并审批') : '执行失败'}${backend ? `（后端 ${backend}）` : ''}`,
  });
  return { task: getTask(id)!, approval_id: approvalId };
}

/** Where the runner's log lives, so the task page can say "look here" without shipping keys. */
export const runnerLogHint = (): string => getSetting('runner_log_path', '%LOCALAPPDATA%\\ai-workbench\\runner.log');
