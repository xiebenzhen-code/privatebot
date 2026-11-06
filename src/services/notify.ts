// 007: push a short notice to the phone. Title, risk and a link only — never command text,
// file contents or secrets. Failures are logged, never retried in a loop.
import { db } from '../db.ts';
import { RISKS, dayOf, nowIso } from '../domain.ts';
import { HttpError, logEvent, oneOf } from './core.ts';
import { getSetting } from './dispatch.ts';
import { getTask } from './tasks.ts';
import { branchesToNotify, markNotified } from './branches.ts';
import { redactAll } from './redact.ts';

export type Channel = { id: number; kind: string; url: string; enabled: number; created_at: string };
export const CHANNEL_KINDS: Record<string, string> = { wecom: '企业微信群机器人', feishu: '飞书群机器人', bark: 'Bark（iOS）', webhook: '通用 webhook' };

export type Notice = {
  title: string;
  body?: string;
  risk?: string;
  link?: string;
  /** Set for approvals so the same one is never pushed twice. */
  approvalId?: number;
};

export function listChannels(): Channel[] {
  return db().prepare('SELECT * FROM notify_channels ORDER BY id').all() as Channel[];
}

export function addChannel(input: Record<string, unknown>): Channel {
  const kind = oneOf(input.kind, Object.keys(CHANNEL_KINDS), 'kind');
  const url = String(input.url ?? '').trim();
  if (!kind) throw new HttpError(400, '要选推送渠道类型');
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, '推送地址需要以 http(s):// 开头');
  const res = db().prepare('INSERT INTO notify_channels (kind, url, enabled, created_at) VALUES (?, ?, 1, ?)').run(kind, url, nowIso());
  logEvent({ actor: 'me', kind: 'notify.channel', text: `添加推送渠道 ${CHANNEL_KINDS[kind]}` });
  return db().prepare('SELECT * FROM notify_channels WHERE id = ?').get(Number(res.lastInsertRowid)) as Channel;
}

export function deleteChannel(id: number): void {
  const row = db().prepare('SELECT kind FROM notify_channels WHERE id = ?').get(id) as { kind: string } | undefined;
  if (!row) throw new HttpError(404, '没有这个推送渠道');
  db().prepare('DELETE FROM notify_channels WHERE id = ?').run(id);
  logEvent({ actor: 'me', kind: 'notify.channel', text: `删除推送渠道 ${CHANNEL_KINDS[row.kind] ?? row.kind}` });
}

/** Each platform wants a different shape; the payload deliberately stays tiny. */
export function buildPayload(kind: string, notice: Notice): { body: unknown; method: string; url: string } {
  const text = [notice.title, notice.body].filter(Boolean).join('\n');
  const link = notice.link ?? '';
  if (kind === 'wecom') {
    return { method: 'POST', body: { msgtype: 'markdown', markdown: { content: `${notice.title}\n${notice.body ?? ''}\n${link ? `[打开工作台](${link})` : ''}` } }, url: '' };
  }
  if (kind === 'feishu') {
    return { method: 'POST', body: { msg_type: 'text', content: { text: `${text}${link ? `\n${link}` : ''}` } }, url: '' };
  }
  if (kind === 'bark') {
    return { method: 'POST', body: { title: notice.title, body: notice.body ?? '', url: link }, url: '' };
  }
  return { method: 'POST', body: { title: notice.title, body: notice.body ?? '', risk: notice.risk ?? '', link }, url: '' };
}

async function post(channel: Channel, notice: Notice): Promise<boolean> {
  const payload = buildPayload(channel.kind, notice);
  try {
    const res = await fetch(channel.url, {
      method: payload.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logEvent({ actor: 'system', kind: 'notify.failed', text: `推送到 ${CHANNEL_KINDS[channel.kind] ?? channel.kind} 失败：HTTP ${res.status}` });
      return false;
    }
    // Feishu and WeCom answer 200 even when they refuse the message (wrong keyword, sign check on,
    // bot removed). Trusting the status code alone marks the approval as notified and the user
    // never hears about it again, so the body has to be checked too.
    const code = await refusalCode(channel.kind, res);
    if (code !== null) {
      logEvent({ actor: 'system', kind: 'notify.failed', text: `推送到 ${CHANNEL_KINDS[channel.kind] ?? channel.kind} 被拒：${code}` });
      return false;
    }
    return true;
  } catch (err) {
    logEvent({ actor: 'system', kind: 'notify.failed', text: `推送到 ${CHANNEL_KINDS[channel.kind] ?? channel.kind} 失败：${String((err as Error)?.message ?? err).slice(0, 120)}` });
    return false;
  }
}

/** `null` = accepted. Only the two platforms that report errors inside a 200 body are inspected. */
async function refusalCode(kind: string, res: Response): Promise<string | null> {
  if (kind !== 'feishu' && kind !== 'wecom') return null;
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return null; // not JSON: let the status code be the verdict
  }
  const raw = body.code ?? body.StatusCode ?? body.errcode;
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (n === 0) return null;
  const msg = String(body.msg ?? body.errmsg ?? '').slice(0, 80);
  return `code ${n}${msg ? `（${msg}）` : ''}`;
}

function linkFor(path: string): string {
  const base = getSetting('public_url', '').replace(/\/+$/, '');
  return base ? `${base}${path}` : '';
}

export function approvalLink(approvalId: number, taskId: number | null): string {
  // 016: the inbox has its own address now; approvals that belong to a task still name it.
  return linkFor(taskId ? `/tasks/review?approval=${approvalId}&task=${taskId}` : `/tasks/review?approval=${approvalId}`);
}

/** Fire and forget: returns how many channels accepted the message. */
export async function notify(notice: Notice): Promise<number> {
  if (notice.approvalId) {
    const row = db().prepare('SELECT notified_at FROM approvals WHERE id = ?').get(notice.approvalId) as { notified_at: string | null } | undefined;
    if (!row) return 0;
    if (row.notified_at) return 0; // already pushed once
  }
  const channels = listChannels().filter((c) => c.enabled);
  let sent = 0;
  for (const c of channels) {
    if (await post(c, notice)) sent++;
  }
  if (notice.approvalId && sent > 0) {
    db().prepare('UPDATE approvals SET notified_at = ? WHERE id = ?').run(nowIso(), notice.approvalId);
  }
  return sent;
}

export async function sendTest(): Promise<{ sent: number; channels: number }> {
  const channels = listChannels().filter((c) => c.enabled);
  let sent = 0;
  for (const c of channels) {
    if (await post(c, { title: '工作台测试消息', body: '如果你看到这条，说明推送渠道可用。', link: linkFor('/') })) sent++;
  }
  return { sent, channels: channels.length };
}

/** The only thing a push may say about the action; never the command, path or file contents. */
export function actionCategory(tool: string): string {
  const t = String(tool ?? '').toLowerCase();
  if (t === 'bash') return '运行命令';
  if (t === 'write') return '写入文件';
  if (t === 'edit' || t === 'multiedit') return '编辑文件';
  return '调用工具';
}

/** Host plus the last four characters; the path and query often hold the real key. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const tail = raw.slice(-4);
    return `${u.host} …${tail}`;
  } catch {
    return '（地址无效）';
  }
}

/** One approval → one push. The approval row remembers it was sent. */
export async function notifyApproval(a: { id: number; risk: string; tool_name?: string; task_id: number | null }): Promise<number> {
  const risk = RISKS[a.risk]?.label ?? a.risk;
  return notify({
    title: `待审批 · ${risk} · ${actionCategory(a.tool_name ?? '')}${a.task_id ? ` · T-${a.task_id}` : ''}`,
    body: `风险等级：${risk}`,
    risk: a.risk,
    link: approvalLink(a.id, a.task_id),
    approvalId: a.id,
  });
}

/**
 * 035.3：部署完了、旧执行器退了、新执行器 5 分钟还没来。
 * 这时候「执行器离线」不是网络抖动，是真停了：不推一条，人只会在几个小时后发现任务一直排队。
 * 只说事实和该做什么，不带代码和日志。
 */
export async function notifyHandoffMissed(info: { from_pid: number; minutes: number }): Promise<number> {
  return notify({
    title: `执行器没有接班 · 已经 ${info.minutes} 分钟`,
    body: `部署完成后，旧执行器（pid ${info.from_pid}）退出了，但没有新的执行器来接班。打开工作台看一眼，然后在机器上手动启动一次执行器。`,
    risk: 'high',
    link: linkFor('/team'),
  });
}

// ---------- 029: 任务有结局时说一声 ----------

/** 每天最多推几条失败（同一个任务）。循环失败的任务不该把群刷满。 */
export const FAILED_PUSH_PER_DAY = 3;

/** 今天已经为这个任务推过几条失败。按工作日历算，和日报用的是同一个时区。 */
function failedPushesToday(taskId: number, now = new Date()): number {
  const day = dayOf(now);
  const rows = db().prepare(`SELECT ts FROM events WHERE kind = 'notify.task_failed' AND task_id = ?
    ORDER BY id DESC LIMIT 30`).all(taskId) as { ts: string }[];
  return rows.filter((r) => dayOf(r.ts) === day).length;
}

/** 一句话的失败原因：已经打过码，再压成一行、截短，推送里不放长文。 */
function oneLine(text: string | null | undefined, max = 60): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[。！？])/)[0]?.trim() || s;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * 029: 任务失败必推；完成要不要推由「任务完成也推送」开关决定（默认关）。
 * 同一次运行只推一次（tasks.notified_state），重新开始会清掉它。
 * 推送里只有标题、一句原因和链接——不推结果、日志、diff。
 */
export async function notifyTaskResult(taskId: number): Promise<number> {
  const t = getTask(taskId);
  if (!t) return 0;
  const state = t.status === 'failed' ? 'failed' : t.status === 'done' ? 'done' : '';
  if (!state) return 0;
  if (state === 'done' && getSetting('notify_task_done') !== '1') return 0;
  if (t.notified_state === state) return 0; // 这次运行已经推过
  if (state === 'failed' && failedPushesToday(taskId) >= FAILED_PUSH_PER_DAY) {
    logEvent({ actor: 'system', kind: 'notify.task_skipped', task_id: taskId, text: `T-${taskId} 今天已经推过 ${FAILED_PUSH_PER_DAY} 条失败，不再推` });
    return 0;
  }
  // 028.1: 来源理论上已经打过码，但这条是发给企业微信/飞书的第三方，再包一层不嫌多。
  const why = redactAll(oneLine(t.fail_reason || t.step));
  const sent = await notify({
    title: state === 'failed' ? `T-${t.id} 失败${why ? ` · ${why}` : ''}` : `T-${t.id} 完成`,
    body: state === 'failed' ? '打开工作台看它卡在哪。' : '打开工作台看结果。',
    risk: state === 'failed' ? 'high' : 'low',
    link: linkFor(`/tasks?task=${t.id}`),
  });
  if (sent > 0) {
    db().prepare('UPDATE tasks SET notified_state = ? WHERE id = ?').run(state, taskId);
    logEvent({
      actor: 'system', task_id: taskId, kind: state === 'failed' ? 'notify.task_failed' : 'notify.task_done',
      text: `T-${taskId} ${state === 'failed' ? '失败' : '完成'}，已推送 ${sent} 个渠道`,
    });
  }
  return sent;
}

/**
 * 055.2：任务停在「等你选」时推一条。默认关（设置 › 通知 › 「提问也推送」），开了才推。
 * 一张卡只推一次（tasks.notified_state = 'ask:<卡号>'，重新开始会清掉）；同一个任务再问一轮是新的一张卡，会再推。
 * 推送里只有「哪个任务在等你」和几个问题，不带问题、选项、正文——那是 agent 写的字，只在工作台里看。
 * 这里不引 asks.ts：它经 runner.ts 又引回 notify.ts，直接读表就够了。
 */
export async function notifyTaskAsk(taskId: number): Promise<number> {
  if (getSetting('notify_task_ask') !== '1') return 0;
  const t = getTask(taskId);
  if (!t || t.status !== 'asking') return 0;
  const ask = db().prepare("SELECT id, cards FROM task_asks WHERE task_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { id: number; cards: string } | undefined;
  if (!ask) return 0;
  const state = `ask:${ask.id}`;
  if (t.notified_state === state) return 0; // 这张卡已经推过
  let n = 1;
  try { const list = JSON.parse(ask.cards); if (Array.isArray(list) && list.length) n = list.length; } catch { /* 当作 1 个问题 */ }
  const sent = await notify({
    title: `T-${t.id} 等你选${n > 1 ? ` · ${n} 个问题` : ''}`,
    body: '打开工作台选一下，选完它接着干。',
    risk: 'low',
    link: linkFor(`/tasks?task=${t.id}`),
  });
  if (sent > 0) {
    db().prepare('UPDATE tasks SET notified_state = ? WHERE id = ?').run(state, taskId);
    logEvent({ actor: 'system', task_id: taskId, kind: 'notify.task_asked', text: `T-${taskId} 等你选，已推送 ${sent} 个渠道` });
  }
  return sent;
}

/**
 * 031a: 待处理分支，一条消息里合并多个，每个分支只推一次（notified_at）。
 * 不推内容、不推 diff，只说「有 N 个分支留着没收的成果」+ 链接。
 * 没有启用的渠道时什么都不做——推不出去也就别把 notified_at 标上。
 */
export async function notifyStaleBranches(): Promise<number> {
  const rows = branchesToNotify();
  if (!rows.length) return 0;
  const channels = listChannels().filter((c) => c.enabled);
  if (!channels.length) return 0;
  const n = rows.length;
  const first = rows[0];
  const title = `有 ${n} 个分支留着没收的成果`;
  const body = rows.slice(0, 3).map((r) => `${r.project} · ${r.branch}（领先 ${r.ahead} 个提交）`).join('；')
    + (n > 3 ? `；还有 ${n - 3} 个` : '') + '。打开工作台决定留还是删。';
  const sent = await notify({
    title,
    body, // 分支名和数量，不含代码内容
    risk: 'low',
    link: linkFor(`/?stale=${first.id}`),
  });
  if (sent > 0) {
    markNotified(rows.map((r) => r.id));
    logEvent({ actor: 'system', kind: 'notify.stale_branches', text: `${n} 个待处理分支，已推送 ${sent} 个渠道` });
  }
  return sent;
}
