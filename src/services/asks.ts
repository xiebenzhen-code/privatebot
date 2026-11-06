// 055.2 · 提问卡片：agent 要问人的时候，执行器报上来，工作台存成卡片、等人选；选完执行器接着干。
//
// 三条底线：
//   - 卡片里的字一律是资料：只显示，只当「用户的回答」原样回给 agent，绝不解析成派活、审批或命令（同 054.8）。
//   - 只有登录会话能回答（app.ts 里 human: true）——agent 手里的令牌不能替人选。
//   - 一次回答只换一次接力：执行器取走（taken）之后就取不到了；「重新开始」是全新的一次，不带上次的回答。
import { db, tx } from '../db.ts';
import { nowIso, statusLabel, truncate } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';
import { cleanResult, redactAll } from './redact.ts';
import { appendTaskLog } from './runner.ts';
import { closeRun } from './runs.ts';
import { getTask, updateTask } from './tasks.ts';

/** 选项最多 6 个、每个限长（规格写的）；问题数、标题、正文也各有上限，免得一张卡把详情撑满。 */
export const ASK_LIMITS = { cards: 6, title: 60, text: 1000, options: 6, option: 120, answer: 1000, result: 8000, rounds: 5 };

export type AskCard = { key: string; title: string; text: string; options: string[] };
export type AskStatus = 'open' | 'answered' | 'taken' | 'cancelled';
export type AskRow = {
  id: number; task_id: number; status: AskStatus; cards: AskCard[]; answers: Record<string, string>;
  session_id: string; sandbox: string; prior_result: string;
  asked_at: string; answered_at: string | null; taken_at: string | null;
};

type Raw = {
  id: number; task_id: number; status: AskStatus; cards: string; answers: string;
  session_id: string; sandbox: string; prior_result: string;
  asked_at: string; answered_at: string | null; taken_at: string | null;
};

function parseJson<T>(text: string, fallback: T): T {
  try { return (JSON.parse(text) ?? fallback) as T; } catch { return fallback; }
}
const rowOf = (r: Raw): AskRow => ({ ...r, cards: parseJson<AskCard[]>(r.cards, []), answers: parseJson<Record<string, string>>(r.answers, {}) });

/** 单行文字：控制字符、换行都压成空格，打码，截断。 */
const flat = (v: unknown, max: number): string => {
  const one = redactAll(String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
/** 多行文字：保留换行，去掉别的控制字符，打码，截断。 */
const block = (v: unknown, max: number): string => {
  const text = redactAll(String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '').trim());
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * 把 agent 写的 `{"ask":[{title,text,options,key}]}` 收成卡片。
 * 不合格就 400 说人话——执行器收到 400 就当没有提问，原样走普通收尾，不会卡死任务。
 */
export function cleanCards(raw: unknown): AskCard[] {
  const list = Array.isArray(raw) ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { ask?: unknown }).ask) ? (raw as { ask: unknown[] }).ask : null;
  if (!list || !list.length) throw new HttpError(400, '没有可显示的问题：ask 要是一个不空的数组');
  if (list.length > ASK_LIMITS.cards) throw new HttpError(400, `一次最多问 ${ASK_LIMITS.cards} 个问题`);
  const used = new Set<string>();
  return list.map((c, i): AskCard => {
    const n = i + 1;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `第 ${n} 个问题不是对象`);
    const o = c as Record<string, unknown>;
    const title = flat(o.title, ASK_LIMITS.title);
    const text = block(o.text, ASK_LIMITS.text);
    if (!title && !text) throw new HttpError(400, `第 ${n} 个问题没有标题也没有内容`);
    const rawOpts = o.options === undefined || o.options === null ? [] : o.options;
    if (!Array.isArray(rawOpts)) throw new HttpError(400, `第 ${n} 个问题的 options 要是数组`);
    if (rawOpts.length > ASK_LIMITS.options) throw new HttpError(400, `第 ${n} 个问题的选项最多 ${ASK_LIMITS.options} 个`);
    const options: string[] = [];
    for (const x of rawOpts) {
      if (typeof x !== 'string' && typeof x !== 'number') continue;
      const t = flat(x, ASK_LIMITS.option);
      if (t && !options.includes(t)) options.push(t);
    }
    // key 是回答里认这个问题的名字；写得不合规、或者和前面重了，就按顺序给 q1 q2…，不报错。
    let key = String(o.key ?? '').trim();
    if (!/^[a-z0-9_-]{1,40}$/i.test(key) || used.has(key)) key = `q${n}`;
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    return { key, title, text, options };
  });
}

export function openAskOf(taskId: number): AskRow | undefined {
  const r = db().prepare("SELECT * FROM task_asks WHERE task_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(taskId) as Raw | undefined;
  return r ? rowOf(r) : undefined;
}

export function listAsks(taskId: number): AskRow[] {
  return (db().prepare('SELECT * FROM task_asks WHERE task_id = ? ORDER BY id').all(taskId) as Raw[]).map(rowOf);
}

/** 有没有一份「你回答了、执行器还没来取」的回答。/api/runner/next 据此告诉执行器这次是接着干。 */
export function hasAnswered(taskId: number): boolean {
  return Boolean(db().prepare("SELECT 1 FROM task_asks WHERE task_id = ? AND status = 'answered'").get(taskId));
}

/** 一句话说清卡片问的是什么（步骤、日志、审计用）。 */
function gist(cards: AskCard[]): string {
  const first = cards[0].title || truncate(cards[0].text, 40);
  return cards.length > 1 ? `${first} 等 ${cards.length} 个问题` : first;
}

export type OpenAskInput = {
  ask?: unknown; session_id?: unknown; sandbox?: unknown; result_text?: unknown;
  tokens_used?: unknown; slot?: unknown; harness?: unknown; model?: unknown; backend?: unknown;
};

/**
 * 执行器报上来一张卡：这次运行在这里收尾（记「等你选」，不是完成也不是失败），任务停在「等你选」。
 * 不占名额：运行已经收了，`activeCoding` 只数还开着的运行；也不花 token：没有进程在等。
 */
export function openAsk(taskId: number, input: OpenAskInput = {}): AskRow {
  const t = getTask(taskId);
  if (!t) throw new HttpError(404, `没有任务 T-${taskId}`);
  if (t.status !== 'running') throw new HttpError(400, `T-${taskId} 现在是「${statusLabel(t.status)}」，不是运行中，不能提问`);
  const cards = cleanCards(input.ask);
  const sandbox = input.sandbox === 'docker' ? 'docker' : 'none';
  // 沙箱里的会话文件随容器销毁，不带出容器（规格 055.2）：沙箱任务不记会话，接着干开新容器。
  const rawSession = String(input.session_id ?? '').trim();
  const session = sandbox === 'docker' || !/^[A-Za-z0-9._:-]{1,120}$/.test(rawSession) ? '' : rawSession;
  const prior = cleanResult(String(input.result_text ?? ''), ASK_LIMITS.result);
  const rawBackend = String(input.backend ?? '').trim();
  const backend = /^[a-z0-9_-]{1,20}$/i.test(rawBackend) ? rawBackend.toLowerCase() : undefined;
  const tokens = input.tokens_used === undefined || input.tokens_used === null ? undefined : Math.max(0, Math.round(Number(input.tokens_used) || 0));
  const step = `等你选：${gist(cards)}`.slice(0, 300);
  return tx(() => {
    // 一个任务同时只留一张等你选的卡：执行器重报时，老的作废。
    db().prepare("UPDATE task_asks SET status = 'cancelled' WHERE task_id = ? AND status IN ('open', 'answered')").run(taskId);
    const res = db().prepare(`INSERT INTO task_asks (task_id, status, cards, session_id, sandbox, prior_result, asked_at)
      VALUES (?, 'open', ?, ?, ?, ?, ?)`).run(taskId, JSON.stringify(cards), session, sandbox, prior, nowIso());
    const id = Number(res.lastInsertRowid);
    if (tokens !== undefined) db().prepare('UPDATE tasks SET tokens_used = ? WHERE id = ?').run(tokens, taskId);
    closeRun(taskId, 'asked', { reason: `提了问题：${gist(cards)}`, backend, harness: input.harness, model: input.model, slot: input.slot, tokens, sandbox });
    // 状态不走 updateTask：「等你选」只能由这里设，不接受 PATCH（见 tasks.ts 的 STATUS_KEYS）。
    const moved = db().prepare("UPDATE tasks SET status = 'asking', step = ?, result_text = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(step, prior || null, nowIso(), taskId);
    if (moved.changes !== 1) throw new HttpError(409, `T-${taskId} 的状态刚刚变了，这次提问没有记下`);
    logEvent({ actor: 'system', kind: 'task.status', task_id: taskId, text: `T-${taskId}「${truncate(t.title, 50)}」${statusLabel('running')} → ${statusLabel('asking')}` });
    logEvent({ actor: 'system', kind: 'task.asked', task_id: taskId, text: `T-${taskId} 提了 ${cards.length} 个问题，等你选` });
    appendTaskLog(taskId, `提问：${gist(cards)}，等你选`);
    return rowOf(db().prepare('SELECT * FROM task_asks WHERE id = ?').get(id) as Raw);
  });
}

const cleanAnswer = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, ASK_LIMITS.answer)
    : '';

/**
 * 你选了 / 写了：存下回答，任务回到排队并标「已请求开始」，等执行器来领，领到后接着干。
 * 回答的来源，按这个顺序取：自己写的 `t:<key>` → 点的选项 `a:<key>` → `answers.<key>`；
 * 只有一个问题时也认平铺的 `text` / `choice`。每个问题都要有回答。
 */
export function answerAsk(taskId: number, body: Record<string, unknown> = {}, actor = 'me'): { ask: AskRow; task: NonNullable<ReturnType<typeof getTask>> } {
  const t = getTask(taskId);
  if (!t) throw new HttpError(404, `没有任务 T-${taskId}`);
  const ask = openAskOf(taskId);
  if (!ask || t.status !== 'asking') throw new HttpError(400, `T-${taskId} 现在没有等你回答的问题`);
  const given = body.ask_id;
  if (given !== undefined && given !== null && given !== '' && Number(given) !== ask.id) {
    throw new HttpError(409, '这张卡已经换了（或者已经答过），刷新页面再选');
  }
  const nested = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers as Record<string, unknown> : {};
  const answers: Record<string, string> = {};
  const missing: string[] = [];
  for (const c of ask.cards) {
    const v = cleanAnswer(body[`t:${c.key}`]) || cleanAnswer(body[`a:${c.key}`]) || cleanAnswer(nested[c.key]);
    if (v) answers[c.key] = v; else missing.push(c.title || c.key);
  }
  if (ask.cards.length === 1 && missing.length) {
    const v = cleanAnswer(body.text) || cleanAnswer(body.choice) || cleanAnswer(body.answer);
    if (v) { answers[ask.cards[0].key] = v; missing.length = 0; }
  }
  if (missing.length) {
    throw new HttpError(400, ask.cards.length === 1 ? '先选一个，或者自己写一句' : `还有 ${missing.length} 个问题没回答：${missing.join('、')}`);
  }
  tx(() => {
    const r = db().prepare("UPDATE task_asks SET status = 'answered', answers = ?, answered_at = ? WHERE id = ? AND status = 'open'")
      .run(JSON.stringify(answers), nowIso(), ask.id);
    if (r.changes !== 1) throw new HttpError(409, '这张卡已经有人答过了，刷新页面看看');
    updateTask(taskId, { status: 'queued', start_requested: 1, step: '已回答，等执行器接着干' }, actor);
    logEvent({ actor, kind: 'task.answered', task_id: taskId, text: `T-${taskId} 回答了提问（${ask.cards.length} 个问题）` });
    appendTaskLog(taskId, `你回答了：${truncate(Object.values(answers).join(' / '), 100)}`);
  });
  return { ask: listAsks(taskId).find((a) => a.id === ask.id)!, task: getTask(taskId)! };
}

export type ResumeInfo = {
  ask_id: number; session_id: string; sandbox: string; prior_result: string;
  /** 这个任务到现在为止问过、也答过的几轮（旧的在前，最后一项就是这次的）。接不上原会话时，靠它把上下文补回去。 */
  rounds: { cards: AskCard[]; answers: Record<string, string> }[];
};

/**
 * 执行器领到任务后来取回答。**只取一次**：取走就标 taken，再取是 null；
 * 任务不在「运行中」也是 null——不能在执行器还没领之前把回答取空。
 */
export function takeResume(taskId: number): ResumeInfo | null {
  const t = getTask(taskId);
  if (!t || t.status !== 'running') return null;
  return tx(() => {
    const r = db().prepare("SELECT * FROM task_asks WHERE task_id = ? AND status = 'answered' ORDER BY id DESC LIMIT 1").get(taskId) as Raw | undefined;
    if (!r) return null;
    const took = db().prepare("UPDATE task_asks SET status = 'taken', taken_at = ? WHERE id = ? AND status = 'answered'").run(nowIso(), r.id);
    if (took.changes !== 1) return null;
    const earlier = (db().prepare("SELECT * FROM task_asks WHERE task_id = ? AND id < ? AND status IN ('answered', 'taken') ORDER BY id DESC LIMIT ?")
      .all(taskId, r.id, ASK_LIMITS.rounds - 1) as Raw[]).reverse().map(rowOf);
    const cur = rowOf(r);
    logEvent({ actor: 'system', kind: 'task.resumed', task_id: taskId, text: `T-${taskId} 执行器取走了你的回答，接着干` });
    return {
      ask_id: r.id, session_id: cur.session_id, sandbox: cur.sandbox, prior_result: cur.prior_result,
      rounds: [...earlier, cur].map((x) => ({ cards: x.cards, answers: x.answers })),
    };
  });
}

/** 你终止 / 重新开始 / 删任务时，没走完的卡作废。重新开始只作废还没答的：答过没来得及取的，执行器还要取。 */
export function cancelAsks(taskId: number, statuses: AskStatus[] = ['open', 'answered']): number {
  const marks = statuses.map(() => '?').join(',');
  return Number(db().prepare(`UPDATE task_asks SET status = 'cancelled' WHERE task_id = ? AND status IN (${marks})`).run(taskId, ...statuses).changes);
}
