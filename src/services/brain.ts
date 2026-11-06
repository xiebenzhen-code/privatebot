// 042：调度大脑。
//
// 分工只有一句话：**规则管「能不能」，大脑管「选谁」**。
//   · 合格名单由规则算（启用、能被领取、分类、额度、只读限制），大脑翻不过去；
//   · 大脑只在名单里挑一个，判难度、给理由——它跑在执行器上，用本机密钥，工作台不碰模型密钥；
//   · 大脑回话以后工作台**再校验一遍**，不认就按规则派，并记一条审计。
//
// 这里不调用任何模型：只准备材料（提示词）、发牌子（brain_calls 记账）、验收结果、兜底。
// 每个任务只发一次牌子，每天发多少块由 `dispatch_brain_cap` 定（默认 50）。
import { db } from '../db.ts';
import { EXECUTORS, READ_ONLY_EXECUTORS, catLabel, dayOf, execLabel, nowIso, truncate } from '../domain.ts';
import { HttpError, logEvent, str } from './core.ts';
import { autoPaused, getSetting, listExecutorSettings, quotaBlock, quotaLine, setSetting } from './dispatch.ts';
import { capabilities, capabilityNote, executorModels, type Capability } from './capability.ts';
import { notesForPrompt } from './notes.ts';
import { slotBlock } from './runs.ts';
import { redactAll } from './redact.ts';
import { scorecard, type Cell } from './scorecard.ts';
import { defaultMode, getTask, type Task } from './tasks.ts';

const ON_KEY = 'dispatch_brain';
const CAP_KEY = 'dispatch_brain_cap';

/** 每天最多问几次。用完当天全部退回规则——大脑不是必需品，额度是。 */
export const DEFAULT_DAILY_CALLS = 50;
/** 一轮最多领几个。执行器空闲时才跑，别让派单把干活的口子堵住。 */
export const MAX_PER_ROUND = 3;
/** 提示词上限。按字符算（中文一字约 1 token），宁少不多：超了砍说明，不砍候选。 */
export const MAX_PROMPT_CHARS = 4000;
/** 交出去这么久还没回话，就当作这次调用失败，按规则派掉，别把任务挂在收件箱。 */
export const STALE_HAND_MS = 10 * 60_000;
/** 理由最长 60 字——任务卡上就一行，写多了没人看。 */
export const REASON_MAX = 60;
/** 备忘注入上限，沿用 031c「确认过的、限量」。 */
const NOTE_LIMIT = 5;

// ---------- 开关与上限 ----------

export const brainOn = (): boolean => getSetting(ON_KEY, '0') === '1';

export function dailyCap(): number {
  const raw = Number(getSetting(CAP_KEY, String(DEFAULT_DAILY_CALLS)));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DAILY_CALLS;
  return Math.min(500, Math.max(1, Math.round(raw)));
}

export function callsToday(now = new Date()): number {
  const row = db().prepare('SELECT COUNT(*) n FROM brain_calls WHERE day = ?').get(dayOf(now)) as { n: number };
  return row.n;
}

export function brainState(now = new Date()): { on: boolean; cap: number; used: number; remaining: number; paused: boolean } {
  const cap = dailyCap();
  const used = callsToday(now);
  return { on: brainOn(), cap, used, remaining: Math.max(0, cap - used), paused: autoPaused() };
}

/** 开关和上限一起存。关掉不清理已有任务：它们仍是 route='brain'，下次打开继续等派。 */
export function saveBrainSettings(input: { on?: unknown; cap?: unknown }, actor = 'me'): ReturnType<typeof brainState> {
  const raw = input.on;
  const on = raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true';
  setSetting(ON_KEY, on ? '1' : '0');
  if (input.cap !== undefined && input.cap !== '') {
    const n = Number(input.cap);
    if (Number.isFinite(n) && n > 0) setSetting(CAP_KEY, String(Math.min(500, Math.max(1, Math.round(n)))));
  }
  logEvent({ actor, kind: 'dispatch.brain', text: on ? `打开「调度大脑」（每天最多 ${dailyCap()} 次）` : '关掉「调度大脑」' });
  return brainState();
}

// ---------- 合格名单 ----------

export type Candidate = {
  executor: string;
  label: string;
  /** 一句话简介，来自 domain.ts 的 EXECUTORS。 */
  brief: string;
  /** 这个分类上近 30 天的战绩（少样本不给百分比），后面可能接着一句这个执行者所用模型的先验 / 实战（045）。 */
  score: string;
  /** 同上但不带先验——提示词超预算时先裁先验、保留实战。 */
  score_lean: string;
  /** 一句额度说明。 */
  quota: string;
  /** 只会读的执行者：派它做要改文件的活得先有 read_only=true。 */
  read_only_only: boolean;
};

export type Qualified = { candidates: Candidate[]; excluded: { executor: string; why: string }[]; paused: boolean };

/** 一个分类上的战绩，说人话。样本太少就直说，不给百分比。 */
function scoreLine(cells: Cell[], executor: string, category: string): string {
  const c = cells.find((r) => r.executor === executor && r.category === category);
  if (!c) return '近 30 天没做过这类活';
  if (c.sample === 'few') return `近 30 天做过 ${c.n} 单（样本太少）`;
  return `近 30 天 ${c.n} 单 · 一次过 ${Math.round(c.first_pass_rate * 100)}% · 平均返工 ${c.rework_avg} 次`;
}

/**
 * 规则算出的硬约束名单。顺序就是 executor_settings 的 priority，大脑选不选由它，但只能在这里面选。
 * 顺序即是兜底顺序：大脑没回话时派给第一个。
 */
export function qualified(category: string): Qualified {
  const paused = autoPaused();
  const excluded: { executor: string; why: string }[] = [];
  const candidates: Candidate[] = [];
  if (paused) return { candidates, excluded, paused: true };

  const rows = listExecutorSettings();
  const cells = scorecard({ days: 30 }).rows;
  // 045：每个执行者背后的框架 + 模型，和这个分类上那个模型的先验 / 实战。先验文件坏了不能把派单带崩，当作没有。
  let caps: Capability[] = [];
  try { caps = capabilities().items; } catch { /* 校验不过就不加这一句，规则照常派 */ }
  const models = executorModels();
  for (const s of rows) {
    const who = execLabel(s.executor);
    if (!EXECUTORS[s.executor]) { excluded.push({ executor: s.executor, why: '工作台不认识这个执行者' }); continue; }
    if (!s.enabled) { excluded.push({ executor: s.executor, why: `${who} 已停用` }); continue; }
    // 只派单、不自己执行的（ZCode 那种要在应用里贴）：派了也不会开跑，不该占一个名额。
    const claimable = (s as { claimable?: number }).claimable ?? 1;
    if (!claimable) { excluded.push({ executor: s.executor, why: `${who} 只派单、不自己执行` }); continue; }
    const cats = String(s.categories ?? '').split(',').filter(Boolean);
    if (cats.length && !cats.includes(category)) {
      excluded.push({ executor: s.executor, why: `${who} 不接「${catLabel(category)}」` });
      continue;
    }
    const block = quotaBlock(s.executor);
    if (block) { excluded.push({ executor: s.executor, why: block.text }); continue; }
    // 045.3：槽都不能用的执行者派过去也只会排队，不放进名单。有一个槽能用就放行。
    const slotWait = slotBlock(s.executor);
    if (slotWait) { excluded.push({ executor: s.executor, why: slotWait }); continue; }
    // 045：附加而不是替换。带框架 / 模型的运行要攒一阵才有样本，现在就换掉，过渡期大脑会丢掉已有的战绩。
    const m = models.get(s.executor);
    const note = capabilityNote(m ? caps.find((c) => c.harness === m.harness && c.model === m.model && c.category === category) : undefined);
    const base = scoreLine(cells, s.executor, category);
    candidates.push({
      executor: s.executor,
      label: who,
      brief: EXECUTORS[s.executor].brief,
      score: note?.full ? `${base}；${note.full}` : base,
      score_lean: note?.lean ? `${base}；${note.lean}` : base,
      quota: quotaLine(s.executor),
      read_only_only: READ_ONLY_EXECUTORS.has(s.executor),
    });
  }
  return { candidates, excluded, paused };
}

/** 名单里能不能派这个执行者做这活；不能就说为什么（这句话会写进审计和 400 的正文）。 */
export function candidateProblem(q: Qualified, executor: string, readOnly: boolean): string {
  const c = q.candidates.find((x) => x.executor === executor);
  if (!c) {
    const why = q.excluded.find((e) => e.executor === executor)?.why;
    return why ? `不在合格名单里（${why}）` : '不在合格名单里';
  }
  if (c.read_only_only && !readOnly) return `${c.label} 只能做只读任务，这活要改文件`;
  return '';
}

/** 名单里除某个人以外的下一个，按 priority。`needReadOnly` 时只挑只读的，否则只挑能改文件的。 */
export function nextCandidate(category: string, exclude: string[], needReadOnly = false): Candidate | null {
  return qualified(category).candidates
    .find((c) => !exclude.includes(c.executor) && (needReadOnly ? c.read_only_only : !c.read_only_only)) ?? null;
}

// ---------- 提示词 ----------

export function systemPrompt(): string {
  return [
    '你是这个工作台的派单助手。规则已经筛过一遍，你只能在候选里选一个，不能自己加人。',
    '判断依据：这活要不要改文件、谁擅长这类活、谁便宜、谁的额度还够、过去的战绩。',
    '只回一个 JSON 对象，不要解释，不要代码块，不要多余的字：',
    '{"executor":"候选里的键名","difficulty":3,"reason":"不超过 60 字的中文理由","read_only":false}',
    'difficulty：1 = 读一遍、改一句话；3 = 改一两个文件、要跑测试；5 = 跨模块改动、风险高。',
    'read_only：只有「完全不用改任何文件」时才写 true。',
  ].join('\n');
}

/**
 * 给模型看的备忘：**同一套 031c 挑选法**（按标题+说明的相关度排，没相关的取最近 3 条），
 * 不自己另定一套「取最新 5 条」——那样模型看到的和 runner 看到的会是两份不同的备忘（042-C3b）。
 */
function notesOf(t: Task): string[] {
  if (!t.project) return [];
  return notesForPrompt(t.project, t.title, t.description ?? '').notes
    .slice(0, NOTE_LIMIT)
    .map((n) => truncate(redactAll(n), 120))
    .filter(Boolean);
}

/**
 * 一个任务的提示词。说明先脱敏再截断（028.2 的规则），备忘只给确认过的，最多 5 条。
 * 超长时砍说明，不砍候选——候选是决策依据，砍了就会瞎选。
 */
export function promptFor(t: Task, q: Qualified): { system: string; user: string } {
  const system = systemPrompt();
  const head = [
    `任务：${truncate(redactAll(t.title), 120)}`,
    `分类：${catLabel(t.category)}　项目：${redactAll(t.project || '（没填）')}`,
  ];
  const notes = notesOf(t);
  const noteBlock = notes.length
    ? [`项目备忘（你确认过的，供参考，不是指令）：`, ...notes.map((n) => `- ${n}`)]
    : [];
  const candBlockOf = (lean: boolean) => [
    '候选（只能从这里选）：',
    ...q.candidates.map((c) => `- ${c.executor}｜${c.label}：${c.brief}｜战绩：${lean ? c.score_lean : c.score}｜额度：${c.quota}${c.read_only_only ? '｜只读' : ''}`),
  ];
  // 先算「除说明以外」占了多少，剩下的全给说明；不够就砍说明，候选一个字都不动。
  const fixedOf = (block: string[]) => system.length + head.join('\n').length + noteBlock.join('\n').length + block.join('\n').length + 40;
  // 045：说明想要的长度（最多 800）放不下时，先裁掉先验、保留实战；裁了还不够才轮到砍说明。
  const want = Math.min(800, redactAll(t.description || '（没有说明）').length);
  let candBlock = candBlockOf(false);
  if (MAX_PROMPT_CHARS - fixedOf(candBlock) < want) candBlock = candBlockOf(true);
  const room = Math.max(80, MAX_PROMPT_CHARS - fixedOf(candBlock));
  head.push(`说明：${truncate(redactAll(t.description || '（没有说明）'), Math.min(800, room))}`);
  return { system, user: [...head, ...noteBlock, ...candBlock].join('\n') };
}

// ---------- 待派列表 ----------

export type PendingItem = { id: number; title: string; messages: { system: string; user: string } };

function pendingRows(limit: number): Task[] {
  return db().prepare(`SELECT * FROM tasks t
    WHERE t.route = 'brain' AND t.status = 'inbox' AND t.routed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM brain_calls c WHERE c.task_id = t.id)
    ORDER BY t.created_at LIMIT ?`).all(limit) as Task[];
}

/** 牌子记一笔：这个任务的唯一一次调用机会已经用掉了。 */
function handOut(taskId: number, now: Date): void {
  db().prepare('INSERT INTO brain_calls (task_id, day, at, state) VALUES (?, ?, ?, ?)')
    .run(taskId, dayOf(now), now.toISOString(), 'handed');
}

/**
 * 没回话的那些：交出去超过 10 分钟还挂着，按调用失败处理（退回规则）。
 * 不这么做，执行器一崩，任务就永远停在「收件 · 待分派」，还没人解释。
 */
export function sweepStale(now = new Date()): number {
  const rows = db().prepare("SELECT * FROM brain_calls WHERE state = 'handed' AND at < ?")
    .all(new Date(now.getTime() - STALE_HAND_MS).toISOString()) as { id: number; task_id: number }[];
  for (const r of rows) {
    db().prepare("UPDATE brain_calls SET state = 'failed' WHERE id = ?").run(r.id);
    const t = getTask(r.task_id);
    if (t && t.route && !t.routed_at) fallbackRoute(t, '大脑十分钟没有回话，已按规则派', 'dispatch.route_stale');
  }
  return rows.length;
}

/** 今天没次数了：把还在等的大脑任务全部按规则派掉，别让它们干等。 */
function sweepNoBudget(why: string): number {
  const rows = pendingRows(100);
  for (const t of rows) fallbackRoute(t, why, 'dispatch.brain_cap');
  return rows.length;
}

export type PendingView = { enabled: boolean; remaining: number; items: PendingItem[]; notes: string[] };

/**
 * 执行器来问「有什么要我拿主意」。每次最多 3 个，名额当场扣掉。
 * 名单空、暂停、没次数时都返回空——空不是错，说明里写清楚为什么。
 */
export function pendingRoutes(now = new Date()): PendingView {
  if (!brainOn()) return { enabled: false, remaining: 0, items: [], notes: [] };
  sweepStale(now);
  const st = brainState(now);
  if (autoPaused()) return { enabled: true, remaining: st.remaining, items: [], notes: ['自动执行已暂停，大脑不派单'] };
  if (st.remaining <= 0) {
    const n = sweepNoBudget('今天的大脑调用次数用完了，已按规则派');
    return {
      enabled: true,
      remaining: 0,
      items: [],
      notes: [`今天的大脑调用次数用完了（${st.cap} 次）${n ? `，${n} 个等派的任务已改走规则推荐` : ''}`],
    };
  }

  const items: PendingItem[] = [];
  const notes: string[] = [];
  for (const t of pendingRows(MAX_PER_ROUND)) {
    const q = qualified(t.category);
    if (!q.candidates.length) {
      fallbackRoute(t, '没有合格执行者，已按规则等你定', 'dispatch.brain_empty');
      notes.push(`T-${t.id} 没有合格执行者，留在收件箱等你定`);
      continue;
    }
    items.push({ id: t.id, title: t.title, messages: promptFor(t, q) });
    handOut(t.id, now);
    if (items.length >= Math.min(MAX_PER_ROUND, st.remaining)) break;
  }
  return { enabled: true, remaining: Math.max(0, st.remaining - items.length), items, notes };
}

// ---------- 收结果 ----------

type RouteInput = Record<string, unknown>;

function difficultyOf(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function markCall(taskId: number, state: 'ok' | 'failed', tokens = 0): void {
  db().prepare("UPDATE brain_calls SET state = ?, tokens = ? WHERE task_id = ? AND state = 'handed'").run(state, tokens, taskId);
}

/** 派给别人：执行者、难度、理由一次写完，状态回到排队。改执行者的清空逻辑不适用——这是大脑自己写的。 */
function applyRoute(t: Task, executor: string, difficulty: number | null, reason: string | null, now: string, readOnly: boolean | null = null): Task {
  const status = executor === 'me' ? 'inbox' : 'queued';
  // 042.4：理由来自模型/执行器，可能顺手带出 token 或路径。输入我们脱敏了，输出也得脱——
  // 这一行是 route_reason 唯一的写入口，卡在这里，页面、审计、提示词就都干净了。
  const why = reason ? truncate(redactAll(reason), 200) : null;
  db().prepare(`UPDATE tasks SET executor = ?, route_reason = ?, difficulty = ?, routed_at = ?, status = ?, mode = ?, step = ?, route_read_only = ?, updated_at = ?
    WHERE id = ?`).run(
    executor, why, difficulty, now, status, defaultMode(executor, t.category),
    executor === 'me' ? '没有合格执行者，等你定' : `大脑派给 ${execLabel(executor)}${difficulty ? ` · 难度 ${difficulty}/5` : ''}`,
    readOnly === null ? t.route_read_only : (readOnly ? 1 : 0),
    now, t.id,
  );
  return getTask(t.id)!;
}

/**
 * 退回规则：派给名单里的第一个。名单空就留在收件箱（`route_reason` 写着为什么），别硬塞给谁。
 * 这是所有「大脑没成」路径的唯一出口，所以审计文案只有一处，不会各处各说一套。
 */
export function fallbackRoute(t: Task, whyRaw: string, kind = 'dispatch.route_fallback'): Task {
  const now = nowIso();
  // 042.4：退回规则的原因常常就是模型/执行器原话（「坏 JSON：…」），一样先脱敏再进审计与页面。
  const why = truncate(redactAll(whyRaw), 200);
  // 042.2：退回也要守能力约束。写任务不能「反正没人接就塞给只读的」——那等于派了个做不动的活；
  // 只读的活也别硬塞给要动文件的人（那是浪费额度和审批次数）。约束没记下来（null）按「要改文件」算，从严。
  const need = t.route_read_only === 1;
  const fits = (c: { read_only_only: boolean }) => (need ? c.read_only_only : !c.read_only_only);
  const pick = qualified(t.category).candidates.find(fits)?.executor ?? '';
  const after = applyRoute(t, pick || 'me', pick ? t.difficulty ?? null : null, why, now, need);
  markCall(t.id, 'failed');
  logEvent({
    actor: 'system',
    kind,
    task_id: t.id,
    text: pick
      ? `T-${t.id} ${why}；已改用规则推荐：${execLabel(pick)}`
      : `T-${t.id} ${why}；没有合格执行者，等你定`,
  });
  return after;
}

/**
 * 执行器把大脑的答案送回来。工作台再校验一遍——这是这一单唯一可信的地方，
 * 因为「执行器说什么」和「规则允许什么」不是一回事。
 *
 * 模型自己失败（failed:true）→ 直接退回规则。
 * 答案里的执行者不合规 → **400**（调用方要知道自己错了），但任务已经按规则派好了，
 * 不留着不动：卡在收件箱比派错更糟。
 */
export function routeTask(id: number, input: RouteInput, actor = 'system'): Task {
  const t = getTask(id);
  if (!t) throw new HttpError(404, `没有任务 T-${id}`);
  if (!t.route) throw new HttpError(400, '这单不是大脑派的，不用再派');
  if (t.routed_at) throw new HttpError(400, '这单已经派过了');

  if (input.failed === true) {
    const why = truncate(String(input.why ?? ''), 80) || '没有说明';
    return fallbackRoute(t, `大脑这次没给出结果（${why}）`, 'dispatch.route_failed');
  }

  const executor = (str(input.executor, 40) ?? '').trim();
  const readOnly = input.read_only === true;
  const q = qualified(t.category);
  const problem = candidateProblem(q, executor, readOnly);
  if (problem) {
    const after = fallbackRoute(t, `大脑选了「${executor || '空'}」，${problem}`, 'dispatch.route_rejected');
    throw new HttpError(400, `${problem}。已按规则派给 ${execLabel(after.executor)}`);
  }

  const difficulty = difficultyOf(input.difficulty);
  // 042.4：先脱敏一次，落库和审计用同一份干净文本——审计里带原文等于把令牌抄了一份进事件表。
  const reason = truncate(redactAll(truncate(str(input.reason, 200) ?? '', REASON_MAX)), REASON_MAX);
  const now = nowIso();
  const after = applyRoute(t, executor, difficulty, reason || null, now, readOnly);
  markCall(t.id, 'ok', Math.max(0, Math.round(Number(input.tokens) || 0)));
  logEvent({
    actor,
    kind: 'dispatch.route',
    task_id: t.id,
    text: `大脑把 T-${t.id} 派给 ${execLabel(executor)} · 难度 ${difficulty}/5${reason ? ` · ${reason}` : ''}`,
  });
  return after;
}

/**
 * 开跑前发现额度不够，而且这单是大脑派的：换名单里的下一个。
 * 你亲手选的**不换**——那是你的决定，工作台只把原因写出来（见 claimTask / 开始按钮）。
 */
export function rerouteForQuota(t: Task, whyRaw: string): Task | null {
  const why = truncate(redactAll(whyRaw), 300); // 042.4：额度说明里可能带账号邮箱/令牌
  // 042.2：只在「能力够」的人里换。写任务换给只读执行者，等于把活派进了死胡同。
  const next = nextCandidate(t.category, [t.executor], t.route_read_only === 1);
  if (!next) {
    db().prepare('UPDATE tasks SET step = ?, updated_at = ? WHERE id = ?').run(truncate(why, 300), nowIso(), t.id);
    logEvent({ actor: 'system', kind: 'dispatch.no_quota', task_id: t.id, text: `T-${t.id} ${why}；名单里没有别的执行者，先等着` });
    return null;
  }
  db().prepare(`UPDATE tasks SET executor = ?, route_reason = ?, status = 'queued', mode = ?, step = ?, updated_at = ? WHERE id = ?`).run(
    next.executor, truncate(why, 200), defaultMode(next.executor, t.category), `额度用完，改派给 ${execLabel(next.executor)}`, nowIso(), t.id,
  );
  logEvent({
    actor: 'system',
    kind: 'dispatch.switch',
    task_id: t.id,
    text: `T-${t.id} ${why}；大脑派的任务已改派给 ${execLabel(next.executor)}`,
  });
  return getTask(t.id)!;
}

/** 今天页那句提示。没开、还有次数都返回空串——不占地方。 */
export function brainBanner(now = new Date()): string {
  const st = brainState(now);
  if (!st.on) return '';
  if (st.remaining <= 0) return `调度大脑今天的 ${st.cap} 次用完了，新任务按规则派。`;
  if (st.paused) return '自动执行暂停中，大脑也不派单。';
  return '';
}
