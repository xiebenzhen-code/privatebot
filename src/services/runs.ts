// 045：运行（一个任务的每一次开跑）与账号槽（执行器能直接用的一个登录目录）。
//
// 两条底线：
//   - 工作台不碰任何凭据。槽只记目录名，真实目录在执行器配置的 slotsRoot 下，登录由用户在本机做。
//   - 读不出来不等于没有（031a.1）：限额文案认不出来就当普通失败，不猜重置时间。
import { db } from '../db.ts';
import { EXECUTORS, fmtTime, nowIso, truncate } from '../domain.ts';
import { HttpError, logEvent, str } from './core.ts';
import { cleanResult } from './redact.ts';

export type RunOutcome = 'running' | 'done' | 'failed' | 'limited' | 'cancelled' | 'taken_over' | 'asked';
export const RUN_OUTCOMES: Record<RunOutcome, string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
  limited: '到额度上限',
  cancelled: '被取代',
  taken_over: '你接手了',
  asked: '等你选', // 055.2：这一次停在提问上，不是完成也不是失败
};

export type Run = {
  id: number;
  task_id: number;
  attempt: number;
  executor: string;
  harness: string;
  backend: string | null;
  model: string;
  slot: string;
  route: string;
  sandbox: string;
  started_at: string;
  ended_at: string | null;
  outcome: RunOutcome;
  reason: string | null;
  tokens: number;
  backfilled: number;
};

const COLS = 'id, task_id, attempt, executor, harness, backend, model, slot, route, sandbox, started_at, ended_at, outcome, reason, tokens, backfilled';

export function listRuns(taskId: number): Run[] {
  return db().prepare(`SELECT ${COLS} FROM runs WHERE task_id = ? ORDER BY attempt, id`).all(taskId) as Run[];
}

export function openRunOf(taskId: number): Run | undefined {
  return db().prepare(`SELECT ${COLS} FROM runs WHERE task_id = ? AND outcome = 'running' ORDER BY id DESC LIMIT 1`)
    .get(taskId) as Run | undefined;
}

/** 领取成功后调用。之前没收尾的那条（执行器崩了、被重置）标成「被取代」，不删。 */
export function openRun(taskId: number, executor: string, route: string): Run {
  const now = nowIso();
  db().prepare(`UPDATE runs SET outcome = 'cancelled', ended_at = ?, reason = COALESCE(reason, '被新的一次取代')
    WHERE task_id = ? AND outcome = 'running'`).run(now, taskId);
  const prev = db().prepare('SELECT COALESCE(MAX(attempt), 0) n FROM runs WHERE task_id = ?').get(taskId) as { n: number };
  // `tokens_base` 是 045 第一版的列：当时想用「任务累计 − 开跑时的累计」算单次，但执行器每次都从 0 开始数、
  // 并且覆盖 `tasks.tokens_used`，相减会得到 0 或负数（045.1）。列留着（老库里有），不再写不再读。
  const r = db().prepare(`INSERT INTO runs (task_id, attempt, executor, route, started_at)
    VALUES (?, ?, ?, ?, ?)`).run(taskId, prev.n + 1, executor, route, now);
  return db().prepare(`SELECT ${COLS} FROM runs WHERE id = ?`).get(Number(r.lastInsertRowid)) as Run;
}

/**
 * 045.1：这一次运行用了多少 token。口径只有一个——**执行器报上来的、这一次运行自己的累计**
 * （每次开跑从 0 数起）。进度上报和收尾上报都走这里，收尾那次是最终值，所以不到一个上报周期就结束的短任务也有数。
 * `tasks.tokens_used` 的口径没变：仍是最近一次上报，不是各次之和。账单口径是 `usage` 表（POST /api/usage），与这里分开。
 */
export function setRunTokens(taskId: number, tokens: number): void {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  db().prepare("UPDATE runs SET tokens = ? WHERE id = (SELECT id FROM runs WHERE task_id = ? AND outcome = 'running' ORDER BY id DESC LIMIT 1)")
    .run(n, taskId);
}

const NAME_RE = /^[a-z0-9_-]{1,40}$/i;
const clean = (v: unknown, max: number) => {
  const s = String(v ?? '').trim();
  return NAME_RE.test(s) ? s.slice(0, max) : '';
};

/** 收尾当前那条。没有进行中的（老任务、回填前就在跑的）就不做事：不为了好看补一条假的。 */
export function closeRun(taskId: number, outcome: Exclude<RunOutcome, 'running'>, extra: {
  reason?: string | null; backend?: string; harness?: unknown; model?: unknown; slot?: unknown;
  /** 这一次运行最终的累计 token（执行器报的）。不给就保留进度上报最后写下的值。 */
  tokens?: number;
  /** 046.3：none / docker / vm，别的值不认（当 none）。047 只让沙箱里的运行进第 ② 道，所以这里不能被随便写。 */
  sandbox?: unknown;
} = {}): Run | undefined {
  const run = openRunOf(taskId);
  if (!run) return undefined;
  const slot = clean(extra.slot, 40);
  // 报上来的槽必须真的存在、属于这个执行者——不然战绩会记到一个不存在的账号头上。
  const slotOk = slot && db().prepare("SELECT 1 FROM accounts WHERE name = ? AND executor = ? AND slot_dir <> ''").get(slot, run.executor);
  const tokens = extra.tokens === undefined ? run.tokens : Math.max(0, Math.round(Number(extra.tokens) || 0));
  const sandbox = extra.sandbox === undefined ? run.sandbox : (['docker', 'vm'].includes(String(extra.sandbox)) ? String(extra.sandbox) : 'none');
  db().prepare(`UPDATE runs SET outcome = ?, ended_at = ?, reason = ?, tokens = ?, sandbox = ?,
      backend = COALESCE(?, backend), harness = COALESCE(NULLIF(?, ''), harness),
      model = COALESCE(NULLIF(?, ''), model), slot = COALESCE(NULLIF(?, ''), slot)
    WHERE id = ?`).run(
    // 045.2：run.reason 经由 API 和备份出去，入库前和 tasks.fail_reason 走同一道打码，不能各守一半。
    outcome, nowIso(), extra.reason ? cleanResult(extra.reason, 300) : null,
    tokens, sandbox,
    extra.backend || null, clean(extra.harness, 30), String(extra.model ?? '').trim().slice(0, 80).replace(/[^\w.:/-]/g, ''),
    slotOk ? slot : '', run.id,
  );
  return db().prepare(`SELECT ${COLS} FROM runs WHERE id = ?`).get(run.id) as Run;
}

/**
 * 045.2：补一遍已经入库的运行原因。第一版 closeRun 只截断不打码，那段时间写下的原文还在表里。
 * 幂等：已经干净的不动。服务启动时跑一次；改了几条返回几。
 */
export function scrubRuns(): number {
  const rows = db().prepare('SELECT id, reason FROM runs WHERE reason IS NOT NULL').all() as { id: number; reason: string }[];
  let n = 0;
  for (const r of rows) {
    const cleaned = cleanResult(r.reason, 300);
    if (cleaned === r.reason) continue;
    db().prepare('UPDATE runs SET reason = ? WHERE id = ?').run(cleaned, r.id);
    n++;
  }
  if (n) logEvent({ actor: 'system', kind: 'runs.scrubbed', text: `补打码了 ${n} 条运行原因（045.2）` });
  return n;
}

// ───────────────────────────── 账号槽 ─────────────────────────────
/** 升级启动时修补终态任务留下的旧 running 记录；不猜仍在执行的任务。 */
export function reconcileRuns(): number {
  const result = db().prepare(`UPDATE runs SET
    outcome = (SELECT CASE WHEN t.status = 'done' THEN 'done' ELSE 'failed' END FROM tasks t WHERE t.id = runs.task_id),
    ended_at = COALESCE((SELECT completed_at FROM tasks WHERE id = runs.task_id), ?),
    reason = COALESCE(reason, '任务已结束，启动核对补收尾')
    WHERE outcome = 'running' AND task_id IN (SELECT id FROM tasks WHERE status IN ('done', 'failed'))`).run(nowIso());
  const n = Number(result.changes);
  if (n) logEvent({ actor: 'system', kind: 'runs.reconciled', text: `为 ${n} 条已结束任务的旧运行补收尾` });
  return n;
}


export type Slot = {
  name: string;
  executor: string;
  slot_dir: string;
  label: string;
  slot_enabled: number;
  slot_priority: number;
  window_pct: number | null;
  limited_until: string | null;
  expires_at: string | null;
  kind: string;
  balance: number | null;
};
export type SlotView = Slot & { state: 'ok' | 'limited' | 'expired' | 'off' | 'empty'; state_text: string };

const SLOT_COLS = 'name, executor, slot_dir, label, slot_enabled, slot_priority, window_pct, limited_until, expires_at, kind, balance';
/** 目录名只许小写字母、数字、横线：挡掉 `..`、斜杠、反斜杠、盘符。 */
export const SLOT_DIR_RE = /^[a-z0-9-]{1,32}$/;

/**
 * 049.2：能开账号槽的执行者。身份就是一个配置目录（`CLAUDE_CONFIG_DIR` /
 * `CODEBUDDY_CONFIG_DIR`），一个目录一个登录态。dsh 的身份是 API 密钥，反代池的
 * 账号轮换交给 CLIProxyAPI，都不归工作台开槽。
 * 页面和接口读同一份名单，别再各写一份。
 */
export const SLOT_EXECUTORS = new Set(['claude', 'workbuddy']);
const EXPIRING_SOON_MS = 14 * 24 * 3600 * 1000;

export function slotState(s: Slot, now = Date.now()): SlotView {
  if (!s.slot_enabled) return { ...s, state: 'off', state_text: '停用' };
  if (s.expires_at && Date.parse(s.expires_at) <= now) return { ...s, state: 'expired', state_text: '已到期' };
  if (s.limited_until && Date.parse(s.limited_until) > now) {
    return { ...s, state: 'limited', state_text: `在等 ${fmtTime(s.limited_until)} 重置` };
  }
  if (s.kind === 'balance' && s.balance != null && s.balance <= 0) return { ...s, state: 'empty', state_text: '余额用完了' };
  return { ...s, state: 'ok', state_text: '可用' };
}

export function listSlots(executor?: string, now = Date.now()): SlotView[] {
  const rows = (executor
    ? db().prepare(`SELECT ${SLOT_COLS} FROM accounts WHERE slot_dir <> '' AND executor = ? ORDER BY name`).all(executor)
    : db().prepare(`SELECT ${SLOT_COLS} FROM accounts WHERE slot_dir <> '' ORDER BY executor, name`).all()) as Slot[];
  return rows.map((s) => slotState(s, now));
}

/**
 * 045 选槽顺序：先排除不能用的；14 天内到期的先花（按到期早晚）；其余按优先级、再按窗口用得少的。
 * 工作台算，执行器照做——顺序只有一个出处。
 */
export function orderedSlots(executor: string, now = Date.now()): SlotView[] {
  const ok = listSlots(executor, now).filter((s) => s.state === 'ok');
  const soon = (s: SlotView) => s.expires_at != null && Date.parse(s.expires_at) - now <= EXPIRING_SOON_MS;
  return ok.sort((a, b) => {
    const sa = soon(a), sb = soon(b);
    if (sa !== sb) return sa ? -1 : 1;
    if (sa && sb) return Date.parse(a.expires_at!) - Date.parse(b.expires_at!);
    if (a.slot_priority !== b.slot_priority) return a.slot_priority - b.slot_priority;
    const pa = a.window_pct ?? 0, pb = b.window_pct ?? 0;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 这个执行者配了槽、但一个都用不了 → 返回排队原因；没配槽（走反代池的）→ null，照旧领取。
 */
export function slotBlock(executor: string, now = Date.now()): string | null {
  const all = listSlots(executor, now);
  if (!all.length) return null;
  if (all.some((s) => s.state === 'ok')) return null;
  const waits = all.filter((s) => s.state === 'limited').map((s) => s.limited_until!).sort();
  return waits.length ? `在等 ${fmtTime(waits[0])} 重置（${all.length} 个账号槽都到上限了）` : '没有可用的账号槽';
}

function slotInput(input: Record<string, unknown>, creating: boolean) {
  const out: Record<string, unknown> = {};
  if (creating) {
    const name = String(input.name ?? '').trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, '槽的名字只能用字母、数字、横线和下划线，最多 40 个字');
    const executor = String(input.executor ?? '');
    if (!EXECUTORS[executor] || executor === 'me') throw new HttpError(400, '没有这个执行者');
    if (!SLOT_EXECUTORS.has(executor)) throw new HttpError(400, '这个执行者不用账号槽');
    out.name = name;
    out.executor = executor;
  }
  if (creating || input.slot_dir !== undefined) {
    const dir = String(input.slot_dir ?? '');
    if (!SLOT_DIR_RE.test(dir)) throw new HttpError(400, '目录名只能用小写字母、数字和横线，最多 32 个字（不能带路径）');
    out.slot_dir = dir;
  }
  if (input.label !== undefined) out.label = str(input.label, 60) ?? '';
  if (input.slot_enabled !== undefined) out.slot_enabled = input.slot_enabled === true || input.slot_enabled === 1 || input.slot_enabled === '1' ? 1 : 0;
  if (input.slot_priority !== undefined) {
    const n = Number(input.slot_priority);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw new HttpError(400, '优先级要是 0 到 999 的整数');
    out.slot_priority = n;
  }
  if (input.expires_at !== undefined) {
    const v = input.expires_at;
    if (v === null || v === '') out.expires_at = null;
    else if (Number.isNaN(Date.parse(String(v)))) throw new HttpError(400, '到期时间看不懂');
    else out.expires_at = new Date(String(v)).toISOString();
  }
  return out;
}

export function createSlot(input: Record<string, unknown>, actor = 'me'): SlotView {
  const v = slotInput(input, true);
  if (db().prepare('SELECT 1 FROM accounts WHERE name = ?').get(v.name)) throw new HttpError(409, `已经有叫 ${v.name} 的账号了`);
  if (db().prepare("SELECT 1 FROM accounts WHERE executor = ? AND slot_dir = ?").get(v.executor, v.slot_dir)) {
    throw new HttpError(409, `这个执行者已经有一个槽用目录 ${v.slot_dir}`);
  }
  db().prepare(`INSERT INTO accounts (name, executor, via, source, kind, slot_dir, label, slot_enabled, slot_priority, expires_at, updated_at)
    VALUES (?, ?, 'slot', 'slot', 'window', ?, ?, ?, ?, ?, ?)`).run(
    v.name as string, v.executor as string, v.slot_dir as string, (v.label as string) ?? '',
    (v.slot_enabled as number) ?? 1, (v.slot_priority as number) ?? 50, (v.expires_at as string | null) ?? null, nowIso(),
  );
  logEvent({ actor, kind: 'slot.created', text: `给 ${v.executor} 加了账号槽 ${v.name}（目录 ${v.slot_dir}）` });
  return slotState(db().prepare(`SELECT ${SLOT_COLS} FROM accounts WHERE name = ?`).get(v.name as string) as Slot);
}

export function updateSlot(name: string, input: Record<string, unknown>, actor = 'me'): SlotView {
  const cur = db().prepare(`SELECT ${SLOT_COLS} FROM accounts WHERE name = ? AND slot_dir <> ''`).get(name) as Slot | undefined;
  if (!cur) throw new HttpError(404, `没有叫 ${name} 的账号槽`);
  // 049.2：老库里可能有反代池 / dsh 的槽，那也不许再改——开了就收不回来，至少别再维护它。
  if (!SLOT_EXECUTORS.has(cur.executor)) throw new HttpError(400, '这个执行者不用账号槽');
  const v = slotInput(input, false);
  const keys = Object.keys(v);
  if (!keys.length) return slotState(cur);
  // 改目录也得查重：两个槽指向同一个目录，名义上两个账号，实际是同一个登录态。
  if (typeof v.slot_dir === 'string' && v.slot_dir !== cur.slot_dir
    && db().prepare('SELECT 1 FROM accounts WHERE executor = ? AND slot_dir = ? AND name <> ?').get(cur.executor, v.slot_dir, name)) {
    throw new HttpError(409, `这个执行者已经有一个槽用目录 ${v.slot_dir}`);
  }
  db().prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE name = ?`)
    .run(...keys.map((k) => v[k] as any), nowIso(), name);
  logEvent({ actor, kind: 'slot.updated', text: `改了账号槽 ${name}：${keys.join('、')}` });
  return slotState(db().prepare(`SELECT ${SLOT_COLS} FROM accounts WHERE name = ?`).get(name) as Slot);
}

/** 到上限：记到槽上。resetAt 认不出来就 60 分钟后再试，并说清「重置时间未知」。 */
export function markSlotLimited(name: string, resetAt: string | null, now = Date.now()): { until: string; known: boolean } {
  const known = resetAt != null && !Number.isNaN(Date.parse(resetAt)) && Date.parse(resetAt) > now;
  const until = known ? new Date(resetAt!).toISOString() : new Date(now + 60 * 60 * 1000).toISOString();
  db().prepare("UPDATE accounts SET limited_until = ?, reset_note = ?, updated_at = ? WHERE name = ? AND slot_dir <> ''")
    .run(until, known ? '' : '重置时间未知，1 小时后再试', nowIso(), name);
  return { until, known };
}
