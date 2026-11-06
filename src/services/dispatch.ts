// 007: which executor should take a task, and the gates that stop one mid-flight.
// Ordering principle: burn what expires first (GLM's daily grant), then subscription windows,
// then real money (DeepSeek balance), and finally fall back to the human.
import { db } from '../db.ts';
import { CATEGORIES, EXECUTORS, catLabel, execLabel, lastDays, nowIso, truncate } from '../domain.ts';
import { HttpError, logEvent, oneOf } from './core.ts';
import { listAccounts } from './metrics.ts';
import { createApproval } from './approvals.ts';
import { tokensByExecutorSince } from './metrics.ts';
import { listSlots } from './runs.ts';
import { updateTask } from './tasks.ts';

export type ExecutorSetting = {
  executor: string; priority: number; categories: string; auto_allowed: number;
  daily_token_cap: number | null; max_concurrent: number | null; max_minutes: number | null; enabled: number;
  // 042：只派单、不自己领取（zcode）。040 C4 的「能否领取」要按它算，不能只看 enabled。
  claimable: number;
};

const CAT_KEYS = Object.keys(CATEGORIES);

export function listExecutorSettings(): ExecutorSetting[] {
  return db().prepare('SELECT * FROM executor_settings ORDER BY priority, executor').all() as ExecutorSetting[];
}

export function saveExecutorSettings(input: unknown): ExecutorSetting[] {
  const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : null;
  if (!list) throw new HttpError(400, '需要一组执行者配置');
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const executor = oneOf(r.executor, Object.keys(EXECUTORS), 'executor');
    if (!executor) continue;
    const cats = Array.isArray(r.categories)
      ? r.categories.filter((c): c is string => typeof c === 'string' && CAT_KEYS.includes(c))
      : String(r.categories ?? '').split(',').map((c) => c.trim()).filter((c) => CAT_KEYS.includes(c));
    db().prepare(`INSERT INTO executor_settings (executor, priority, categories, auto_allowed, daily_token_cap, max_concurrent, max_minutes, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(executor) DO UPDATE SET priority = excluded.priority, categories = excluded.categories,
        auto_allowed = excluded.auto_allowed, daily_token_cap = excluded.daily_token_cap,
        max_concurrent = excluded.max_concurrent, max_minutes = excluded.max_minutes, enabled = excluded.enabled`).run(
      executor,
      intOr(r.priority, 99), cats.join(','), flag(r.auto_allowed, false),
      intOr(r.daily_token_cap, null), intOr(r.max_concurrent, null), intOr(r.max_minutes, null),
      flag(r.enabled, true),
    );
  }
  logEvent({ actor: 'me', kind: 'dispatch.settings', text: '更新执行者与调度设置' });
  return listExecutorSettings();
}

/** 016: the drawer posts a form, so "0" arrives as a string. A string "0" used to mean 开. */
const flag = (v: unknown, dflt: boolean): number => {
  if (v === undefined || v === null || v === '') return dflt ? 1 : 0;
  return v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0;
};

const intOr = (v: unknown, dflt: number | null): number | null => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : dflt;
};

// ---------- global switch ----------

export function autoPaused(): boolean {
  const row = db().prepare("SELECT value FROM settings WHERE key = 'auto_paused'").get() as { value: string } | undefined;
  return row?.value === '1';
}

export function setAutoPaused(paused: boolean): boolean {
  const next = paused ? '1' : '0';
  db().prepare("INSERT INTO settings (key, value) VALUES ('auto_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(next);
  logEvent({ actor: 'me', kind: 'dispatch.paused', text: paused ? '打开「暂停所有自动执行」' : '关闭「暂停所有自动执行」' });
  return paused;
}

export function getSetting(key: string, fallback = ''): string {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- suggestion ----------

export type Suggestion = { executor: string; reason: string; fallback?: boolean; model_hint?: string; mode?: 'auto' | 'manual' };

const pct = (n: number | null | undefined): string => `${Math.round(Number(n) || 0)}%`;

/**
 * Accounts tell us about windows and balances; usage tells us what was burned today.
 * 017: `only` narrows the answer to one executor. The runner already has a task in hand and only
 * wants that executor's model hint — asking "who is cheapest overall" answered zcode and threw
 * the voucher hint away.
 */
export function suggestExecutor(category?: string, only?: string): Suggestion {
  const settings = listExecutorSettings().filter((s) => s.enabled && (s.executor === 'zcode' || s.executor === 'codex' || s.executor === 'pool' || s.executor === 'workbuddy' || s.executor === 'autoclaw'));
  const candidates = only ? settings.filter((s) => s.executor === only) : settings;
  const accounts = listAccounts();
  const today = tokensByExecutorSince(lastDays(1)[0]); // "today" in WB_TZ, not UTC
  const reasons: string[] = [];

  for (const s of candidates) {
    const cats = s.categories.split(',').filter(Boolean);
    if (category && cats.length && !cats.includes(category)) {
      reasons.push(`${execLabel(s.executor)} 不接${catLabel(category)}`);
      continue;
    }
    const accs = accounts.filter((a) => a.executor === s.executor);
    const used = today[s.executor] ?? 0;

    if (s.executor === 'zcode') {
      // 013: the quota cannot be read through the API, so no percentage here.
      // It is still the cheapest option — it just has to be pasted into ZCode by hand.
      return {
        executor: 'zcode',
        mode: 'manual',
        reason: 'ZCode 每天送的额度只能在应用里用，当天不用就作废：建议把这个任务贴进 ZCode',
      };
    }
    if (s.executor === 'codex') {
      const win = accs.find((a) => a.kind === 'window');
      if (!win) { reasons.push('Codex 还没登记账号'); continue; }
      if ((win.window_pct ?? 0) >= 90) { reasons.push(`Codex 5 小时窗口已用 ${pct(win.window_pct)}`); continue; }
      return { executor: 'codex', mode: 'manual', reason: `Codex 5 小时窗口还剩 ${100 - Math.round(win.window_pct ?? 0)}%` };
    }
    if (s.executor === 'pool') {
      const balances = accs.filter((a) => a.kind === 'balance' && a.balance !== null);
      // Voucher money expires and cannot be spent elsewhere, so it goes before real balance.
      const voucher = balances.find((a) => {
        let total = 0;
        try { total = Number(JSON.parse(a.balance_detail || '{}').voucher_total) || 0; } catch { total = 0; }
        const live = !a.expires_at || Date.parse(a.expires_at) > Date.now();
        return total > 0 && (a.balance ?? 0) > 0 && live;
      });
      if (voucher) {
        const days = voucher.expires_at ? Math.max(1, Math.ceil((Date.parse(voucher.expires_at) - Date.now()) / 86400000)) : null;
        return {
          executor: 'pool',
          mode: 'manual',
          model_hint: voucherAlias(voucher),
          reason: `用百炼代金券（还剩 ${voucher.balance} ${voucher.balance_unit}${days ? `，${days} 天后到期` : ''}）`,
        };
      }
      const official = balances.find((a) => a.provider === 'deepseek') ?? balances[0];
      if (!official) { reasons.push('DeepSeek 没有余额信息'); continue; }
      // 042-H4 要求「余额高于提醒线」才派：等于线也算没余量，不能卡在边界上继续烧。
      if (official.low_threshold !== null && (official.balance ?? 0) <= official.low_threshold) { reasons.push('DeepSeek 余额已到提醒线'); continue; }
      return {
        executor: 'pool',
        mode: 'manual',
        model_hint: 'deepseek-flash',
        reason: `DeepSeek 余额 ${official.balance} ${official.balance_unit}，还有余量`,
      };
    }
    // workbuddy / autoclaw: credits that do not expire, no automation
    const cred = accs.find((a) => a.kind === 'credits' && a.balance !== null);
    if (cred) return { executor: s.executor, reason: `${execLabel(s.executor)} 还有 ${cred.balance} ${cred.balance_unit}` };
  }

  return { executor: 'me', reason: reasons.length ? `没有可自动用的额度（${reasons[0]}）` : '没有可用的执行者额度', fallback: true };
}

/** Which model the voucher should pay for: the configured alias, else the first priced model. */
export function voucherAlias(a: { balance_detail: string }): string {
  let d: { model_alias?: string; prices?: Record<string, unknown> } = {};
  try { d = JSON.parse(a.balance_detail || '{}'); } catch { d = {}; }
  const explicit = (d.model_alias ?? '').trim();
  if (explicit) return explicit;
  const first = Object.keys(d.prices ?? {})[0] ?? '';
  if (!first) return '';
  return first.startsWith('bl-') ? first : `bl-${first}`;
}

function resetHint(iso: string): string {
  const left = Date.parse(iso) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return '额度已重置';
  const h = Math.round(left / 3600000);
  return h <= 24 ? `${h} 小时后重置` : `${Math.round(h / 24)} 天后重置`;
}

// ---------- 042: 额度闸（规则部分，不问模型） ----------

/** 窗口用到这个数就不许再开新活：再跑一次就把窗口耗光，任务会跑到一半断掉。 */
export const QUOTA_MAX_PCT = 90;

/**
 * 这个执行者还开得了工吗？只回答两件真能读到的事：
 *   · 订阅窗口用到 90% 以上；
 *   · 按量余额不高于提醒线（等于线也算：042-H4 要求「高于」才派）。
 * 一条账号都没有的执行者**不算用完**——「读不到」不等于「没有额度」（041 同一条底线）。
 * 具体怎么换人由调用方决定：大脑派的任务换下一个，你亲手选的只改排队原因。
 *
 * 045.3：账号槽（`slot_dir` 非空）不在这里算。槽是互相替代的登录——a 用满了，b 还能用——
 * 它们的可用与否由 `slotBlock` 看（所有槽都不能用才排队）。要是在这里取「最坏窗口」，
 * 一个槽满了就会把同执行者的其他健康槽一并挡住，「用完换下一个」就成了「用完全停」。
 */
export function quotaBlock(executor: string): { code: string; text: string } | null {
  const accs = listAccounts().filter((a) => a.executor === executor && !a.slot_dir);
  const worst = accs
    .filter((a) => a.kind === 'window' && a.window_pct !== null)
    .sort((a, b) => (b.window_pct ?? 0) - (a.window_pct ?? 0))[0];
  if (worst && (worst.window_pct ?? 0) >= QUOTA_MAX_PCT) {
    return {
      code: 'quota',
      text: `「${execLabel(executor)}」的窗口已用 ${Math.round(worst.window_pct ?? 0)}%，等重置或换执行者`,
    };
  }
  const low = accs.find((a) => a.kind === 'balance' && a.balance !== null && a.low_threshold !== null && (a.balance ?? 0) <= a.low_threshold);
  if (low) {
    return {
      code: 'quota',
      text: `「${execLabel(executor)}」的余额 ${low.balance} ${low.balance_unit} 已到提醒线 ${low.low_threshold}，等充值或换执行者`,
    };
  }
  return null;
}

/** 给大脑看的一句话额度说明。读不到就说读不到，不编一个百分比。 */
export function quotaLine(executor: string): string {
  const base = ownQuotaLine(executor);
  // 045.3：配了账号槽的，说一句「几个槽能用」；槽自己的窗口不并进执行者整体的百分比。
  const slots = listSlots(executor);
  if (!slots.length) return base;
  const ok = slots.filter((s) => s.state === 'ok').length;
  const text = `账号槽 ${ok}/${slots.length} 个可用`;
  return base === '没有额度数据' ? text : `${base}；${text}`;
}

function ownQuotaLine(executor: string): string {
  const accs = listAccounts().filter((a) => a.executor === executor && !a.slot_dir);
  if (!accs.length) return '没有额度数据';
  const win = accs
    .filter((a) => a.kind === 'window' && a.window_pct !== null)
    .sort((a, b) => (b.window_pct ?? 0) - (a.window_pct ?? 0))[0];
  if (win) return `窗口已用 ${Math.round(win.window_pct ?? 0)}%`;
  const bal = accs.find((a) => a.kind === 'balance' && a.balance !== null);
  if (bal) return `余额 ${bal.balance} ${bal.balance_unit}`;
  const credit = accs.find((a) => a.kind === 'credits' && a.balance !== null);
  if (credit) return `积分 ${credit.balance}`;
  return '没有额度数据';
}

// ---------- runner hand-off (008 calls this) ----------
/** The oldest queued task that may start on its own; paused switch short-circuits before this. */
export function nextRunnableTask(): { id: number; title: string; executor: string; category: string } | null {
  const rows = db().prepare(`SELECT t.id, t.title, t.executor, t.category FROM tasks t
    JOIN executor_settings s ON s.executor = t.executor
    WHERE t.status = 'queued' AND t.mode = 'auto' AND s.auto_allowed = 1 AND s.enabled = 1
    ORDER BY t.created_at LIMIT 5`).all() as { id: number; title: string; executor: string; category: string }[];
  for (const r of rows) {
    const s = db().prepare('SELECT categories, max_concurrent FROM executor_settings WHERE executor = ?').get(r.executor) as { categories: string; max_concurrent: number | null } | undefined;
    const cats = (s?.categories ?? '').split(',').filter(Boolean);
    if (cats.length && !cats.includes(r.category)) continue;
    if (s?.max_concurrent) {
      const running = db().prepare("SELECT COUNT(*) n FROM tasks WHERE executor = ? AND status = 'running'").get(r.executor) as { n: number };
      if (running.n >= s.max_concurrent) continue;
    }
    return r;
  }
  return null;
}

// ---------- budget gate ----------

export const TASK_TOKEN_CAP = 20_000_000; // per task, unless the executor has its own cap

export type BudgetInput = { minutes?: number; tokens?: number };

/** Over the time or token cap: park the task for a decision instead of letting it run on. */
export function evaluateTaskBudget(taskId: number, input: BudgetInput): { gated: boolean; approval_id?: number } {
  const task = db().prepare('SELECT id, title, executor, status, started_at FROM tasks WHERE id = ?').get(taskId) as
    { id: number; title: string; executor: string; status: string; started_at: string | null } | undefined;
  if (!task) throw new HttpError(404, `没有任务 T-${taskId}`);
  // 测试期间可以整体关掉：settings 里 budget_gate = off，超时/超用量一律不拦，也不建审批。
  if (getSetting('budget_gate', 'on') === 'off') return { gated: false };
  const setting = db().prepare('SELECT max_minutes, task_token_cap FROM executor_settings WHERE executor = ?').get(task.executor) as
    { max_minutes: number | null; task_token_cap: number | null } | undefined;
  const taskCap = setting?.task_token_cap ?? TASK_TOKEN_CAP;
  const maxMinutes = setting?.max_minutes ?? null;
  const minutes = input.minutes ?? (task.started_at ? Math.round((Date.now() - Date.parse(task.started_at)) / 60000) : 0);
  const tokens = input.tokens ?? 0;

  const overTime = maxMinutes !== null && minutes > maxMinutes;
  const overTokens = tokens > taskCap;
  if (!overTime && !overTokens) return { gated: false };

  const why = overTime ? `已运行 ${minutes} 分钟，超过上限 ${maxMinutes} 分钟` : `用量 ${tokens} token，超过单任务上限 ${taskCap}`;
  // The runner re-checks on every progress tick; one task gets one 继续 / 终止, not a pile of them.
  const existing = db().prepare("SELECT id FROM approvals WHERE task_id = ? AND status = 'pending' AND title LIKE ?").get(task.id, '%超出预算%') as { id: number } | undefined;
  if (existing) return { gated: true, approval_id: existing.id };
  const approval = createApproval({
    title: `任务 T-${task.id}「${truncate(task.title, 40)}」超出预算`,
    summary: `${why}。继续会继续消耗额度，终止会结束这个任务。`,
    risk: 'medium',
    executor: task.executor,
    task_id: task.id,
  });
  updateTask(task.id, { status: 'review', step: `预算闸：${why}` }, 'system');
  logEvent({ actor: 'system', kind: 'dispatch.budget', task_id: task.id, text: `T-${task.id} 触发预算闸：${why}` });
  return { gated: true, approval_id: approval.id };
}
