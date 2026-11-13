// 061.2：一件事点开是一条线程——你说的话、执行者说的话按顺序排；决定卡在最后；底下一句话就能让它改。
// 「详情 ›」里是原来的任务详情，一项不少（溯源都在那儿）。
// 线程里的字全是资料：html`` 自动转义，不渲染 Markdown、不出链接。
import { execLabel } from '../domain.ts';
import { listApprovals, type Approval } from '../services/approvals.ts';
import { runnerExecutors } from '../services/runner.ts';
import { askTitle, crew, stream } from '../services/stream.ts';
import { reviewsOf, saysOf, type Review } from '../services/review.ts';
import { verifyLine, verifyOf, type VerifyLine } from '../services/verify.ts';
import type { Task } from '../services/tasks.ts';
import { html, type Safe } from './html.ts';
import { icon } from './layout.ts';
import { askBlock, detail, failReasonOf } from './tasks.ts';

const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s);

function bubble(who: 'me' | string, text: string, opts: { strong?: string } = {}): Safe {
  const mine = who === 'me';
  const mark = mine ? '你' : (crew(new Set(), execLabel).find((m) => m.key === who)?.mark ?? execLabel(who).slice(0, 1));
  return html`<div class="say ${mine ? 'me' : ''}">
    <span class="say-face" aria-hidden="true">${mark}</span>
    <p class="say-text"><span class="sr-only">${mine ? '你' : execLabel(who)}：</span>${opts.strong ? html`<strong>${opts.strong}</strong>` : ''}${text}</p>
  </div>`;
}

const sendBtn = (label: string) => html`<button class="send" aria-label="${label}">${icon('up', 18)}</button>`;

const faceOf = (who: string) => crew(new Set(), execLabel).find((m) => m.key === who)?.mark ?? execLabel(who).slice(0, 1);
const VERDICT: Record<string, string> = { pass: '过', changes: '要改', unsure: '拿不准', failed: '没审成' };

/** 062：审的意见。要改的是一张大卡（总评 + 逐条）；过、拿不准、没审成是一张小卡。全是另一个模型写的字，转义显示。 */
function reviewCard(r: Review, t: Task, last: boolean): Safe {
  const head = html`<div class="review-head"><span class="say-face" aria-hidden="true">${faceOf(r.reviewer)}</span><strong>${execLabel(r.reviewer)} 审过：${VERDICT[r.verdict] ?? r.verdict}</strong><span class="review-round">第 ${r.round} 轮</span></div>`;
  if (r.verdict !== 'changes') {
    return html`<div class="review-card small" data-review="${r.verdict}">${head}${r.summary ? html`<p>${r.summary}</p>` : r.verdict === 'failed' ? html`<p>它没交回能读的结论。这一版没人审过，你自己多看一眼。</p>` : ''}</div>`;
  }
  const foot = !last ? '' : t.review_state === 'fixing' ? `已打回给 ${execLabel(t.executor)} 照着改。` : t.review_state === 'stuck' ? '审了两轮还有意见，不再打回，交给你定。' : '';
  return html`<div class="review-card" data-review="changes">${head}
    ${r.summary ? html`<p>${r.summary}</p>` : ''}
    <ol class="review-items">${r.items.map((it) => html`<li>${it.file ? html`<strong>${it.file}</strong>：` : ''}${it.problem}${it.fix ? html` 建议：${it.fix}` : ''}</li>`)}</ol>
    ${foot ? html`<p class="review-foot">${foot}</p>` : ''}
  </div>`;
}

/**
 * 接力链：这件事经过谁、现在停在谁手里。「Codex 做 → Claude 审 → 你」。
 * 走过的一环淡、带 ✓；现在这一环加深；还没到的更淡。只有名字和箭头，不加说明文字。
 * 派给自己的事、审别人的子任务没有接力，不显示。
 */
export function relay(t: Task, kind: string): Safe | '' {
  if (t.executor === 'me' || t.review_of) return '';
  const reviewing = t.review_state === 'reviewing';
  const working = !reviewing && (t.review_state === 'fixing' || ['running', 'queued', 'inbox'].includes(t.status)) && kind !== 'start';
  const over = kind === 'done' || kind === 'failed-old';
  // 现在停在哪一环：0 干活的，1 审的，2 你。全做完了是 3。
  const hasReview = !!t.reviewer;
  const at = over ? 3 : reviewing ? 1 : working ? 0 : 2;
  const steps: { key: string; label: string; pos: number }[] = [
    { key: 'work', label: `${execLabel(t.executor)} 做`, pos: 0 },
    ...(hasReview ? [{ key: 'review', label: `${t.reviewer === 'auto' ? '另一位' : execLabel(t.reviewer)} 审`, pos: 1 }] : []),
    { key: 'you', label: '你', pos: 2 },
  ];
  const state = (pos: number) => (pos === at ? 'now' : pos < at ? 'done' : 'next');
  const names = steps.map((s) => `${s.label}${state(s.pos) === 'now' ? '（现在）' : state(s.pos) === 'done' ? '（过了）' : ''}`).join('，然后 ');
  return html`<p class="relay" data-relay="${steps.find((s) => s.pos === at)?.key ?? 'over'}" aria-label="${names}">
    ${steps.map((s, i) => html`${i ? html`<i aria-hidden="true">→</i>` : ''}<span class="relay-step ${state(s.pos)}" data-relay-step="${s.key}">${state(s.pos) === 'done' ? '✓ ' : ''}${s.label}</span>`)}
  </p>`;
}

/** 点头卡上那一行：谁做的、谁审的、审的结果。 */
function reviewLine(t: Task, reviews: Review[]): string {
  if (!t.reviewer || !reviews.length) return '';
  const who = `${execLabel(t.executor)} 做`;
  const by = execLabel(t.reviewer);
  const fixed = reviews.filter((r) => r.verdict === 'changes').length;
  // 066：审的那位看的是改动本身；工作台自己跑的测试没过时，两件事都要说，不让一个「过」盖住另一个「没过」。
  if (t.review_state === 'passed') return `${who} · ${by} 审过${fixed ? `（改了 ${fixed} 轮）` : ''}${verifyOf(t)?.status === 'fail' ? '，但测试没过' : ''}`;
  if (t.review_state === 'stuck') return `${who} · ${by} 审了 ${reviews.length} 轮还有意见`;
  if (t.review_state === 'unsure') return `${who} · ${by} 拿不准`;
  if (t.review_state === 'failed') return `${who} · 没审成`;
  return '';
}

function approveCard(a: Approval, note = '', now: number = Date.now(), checked: VerifyLine | null = null, failTail = ''): Safe {
  // 时效：放了一天以上的成果，提醒一句——它是按当时的仓库做的。
  const aged = Math.floor((now - (Date.parse(a.created_at) || now)) / 86_400_000);
  // 分支名、后端这些是给详情看的，不上点头卡。
  const lines = (a.summary ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(分支|后端|提交)[:：]/.test(l)).slice(0, 6);
  return html`<form class="decide-card" data-api="/api/approvals/${a.id}/decide" data-decide="approve">
    <h3>${askTitle(a)}</h3>
    ${note ? html`<p class="decide-sub" data-review-line>${note}</p>` : ''}
    ${checked ? html`<p class="decide-sub verify-${checked.level}" data-verify="${checked.level}">${checked.level === 'ok' ? '✓ ' : checked.level === 'warn' ? '! ' : ''}${checked.text}</p>` : ''}
    ${checked && failTail ? html`<details class="verify-more" data-verify-more><summary>哪几条没过 · 不一定和这次改动有关</summary>
      <p class="decide-sub">工作台只知道「跑出来没过」，不知道是不是这次改动造成的：可能原来就没过，也可能是环境里缺东西。下面是测试最后的输出，你或者审的那位可以对一下。</p>
      <pre class="verify-tail">${failTail}</pre></details>` : ''}
    ${aged ? html`<p class="decide-sub" data-decide-aged>这是 ${aged} 天前做好的，这期间可能有别的改动进来；收不下会告诉你。</p>` : ''}
    ${lines.length ? html`<ul class="decide-lines">${lines.map((l) => html`<li>${clip(l, 80)}</li>`)}</ul>` : ''}
    <div class="decide-row">
      <button class="btn-ink" name="decision" value="approved" data-done="好 ✓">好</button>
      <details class="decide-no">
        <summary class="btn-line">不行</summary>
        <label class="sr-only" for="fb-${a.id}">哪里不对</label>
        <textarea id="fb-${a.id}" name="feedback" rows="2" placeholder="哪里不对？这句话会原样发给它"></textarea>
        <button class="btn-line" name="decision" value="changes" data-done="已发给它 ✓">发给它</button>
      </details>
    </div>
    <a class="decide-link" href="/tasks?task=${a.task_id ?? ''}">看改了什么</a>
  </form>`;
}

function failedCard(t: Task): Safe {
  const online = runnerExecutors();
  const other = crew(online, execLabel).find((m) => m.key !== t.executor);
  return html`<div class="decide-card" data-decide="failed">
    <h3>没成：${clip(failReasonOf(t), 60)}</h3>
    <p class="decide-sub">${t.auto_retries ? `已自动重试 ${t.auto_retries} 次。` : ''}选个办法：</p>
    <button type="button" class="btn-ink wide" data-api-click="/api/tasks/${t.id}/restart" data-method="POST" data-done="重做 ✓">${icon('refresh', 16)}<span>再做一次</span></button>
    ${other ? html`<button type="button" class="btn-line wide" data-api-click="/api/tasks/${t.id}/handover" data-method="POST" data-body="${JSON.stringify({ executor: other.key })}" data-done="换人 ✓">${icon('spark', 16)}<span>换 ${other.label} 来做</span></button>` : ''}
    <button type="button" class="decide-link" data-api-click="/api/tasks/${t.id}/dismiss" data-method="POST" data-redirect="/" data-done="收起来了">算了，收起来</button>
  </div>`;
}

function simpleCard(kind: string, title: string, sub: string, action: Safe): Safe {
  return html`<div class="decide-card" data-decide="${kind}"><h3>${title}</h3>${sub ? html`<p class="decide-sub">${sub}</p>` : ''}${action}</div>`;
}

export function threadPanel(t: Task): Safe {
  const pend = listApprovals({ status: 'pending', task_id: t.id });
  const s = stream();
  const item = [...s.waiting, ...s.doing, ...s.mine, ...s.done].find((x) => x.key === `t${t.id}`);
  const kind = item?.kind ?? (t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed-old' : 'other');
  // 标题就在上面，气泡里放你补的那句说明；没有说明才重复标题。
  const said = t.description ? clip(t.description, 300) : t.title;

  const reviews = reviewsOf(t.id);
  const inReview = t.review_state === 'reviewing' || t.review_state === 'fixing';
  const card: Safe | '' =
    kind === 'approve' ? html`${pend.map((a) => approveCard(a, a.tool_name === 'git merge' ? reviewLine(t, reviews) : '', Date.now(), a.tool_name === 'git merge' ? verifyLine(t) : null, a.tool_name === 'git merge' && verifyOf(t)?.status === 'fail' ? verifyOf(t)!.tail : ''))}`
    : kind === 'ask' ? html`<div class="decide-card" data-decide="ask">${askBlock(t)}</div>`
    : kind === 'failed' || kind === 'failed-old' ? failedCard(t)
    : kind === 'review' ? simpleCard('review', '做完了，看一眼', '', html`<button type="button" class="btn-ink wide" data-api-click="/api/tasks/${t.id}" data-method="PATCH" data-body="${JSON.stringify({ status: 'done' })}" data-done="收下 ✓">好，收下</button>`)
    : kind === 'start' ? simpleCard('start', '还没开始', `交给 ${execLabel(t.executor)}。点了它才动手。`, html`<button type="button" class="btn-ink wide" data-api-click="/api/tasks/${t.id}/start" data-method="POST" data-done="开始 ✓">开始</button>`)
    : '';

  // 按时间排：执行者每一轮说的话、你回的话、另一位的审查意见，谁先谁在上。
  // 老任务没有逐轮的话，就用它最后的结果顶上。
  const says = saysOf(t.id);
  const timeline: { at: string; say?: (typeof says)[number]; review?: Review }[] = [
    ...says.map((say) => ({ at: say.at, say })), ...reviews.map((review) => ({ at: review.at, review })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.say ? 0 : 1) - (y.say ? 0 : 1));
  if (!says.length && t.result_text && t.executor !== 'me') timeline.unshift({ at: t.updated_at, say: { id: 0, task_id: t.id, who: t.executor, text: t.result_text, at: t.updated_at } });
  // 为什么是这位来审：你点的，还是大脑按什么挑的。
  const whyLine: Safe | '' = t.reviewer && t.review_why
    ? html`<p class="review-why" data-review-why>${execLabel(t.reviewer)} 来审 · ${t.review_why}</p>` : '';
  const canReply = t.status !== 'running' && t.status !== 'asking' && !inReview;
  return html`<article class="thread" data-thread="${t.id}" aria-label="${t.title}">
    <header class="thread-top">
      <a class="thread-back" href="/" aria-label="返回">${icon('back', 22)}</a>
      <span class="thread-id">T-${t.id}</span>
    </header>
    <h2 class="thread-title">${t.title}</h2>
    ${relay(t, kind)}
    <div class="says">
      ${bubble('me', said)}
      ${timeline.map((x) => x.review ? html`${x.review === reviews[0] ? whyLine : ''}${reviewCard(x.review, t, x.review === reviews.at(-1))}` : bubble(x.say!.who, clip(x.say!.text, 400)))}
      ${!reviews.length && t.review_state === 'reviewing' ? whyLine : ''}
      ${t.status === 'running' && t.step ? bubble(t.executor, clip(t.step, 200)) : ''}
    </div>
    ${t.review_state === 'reviewing' ? html`<p class="thread-live" data-reviewing><span class="flow-mark spin" aria-hidden="true">↻</span>${execLabel(t.reviewer)} 在审（第 ${t.review_round} 轮）</p>` : ''}
    ${card}
    ${t.status === 'running' ? html`<p class="thread-live"><span class="flow-mark spin" aria-hidden="true">↻</span>${execLabel(t.executor)} 在做
      <button type="button" class="decide-link" data-api-click="/api/tasks/${t.id}/stop" data-method="POST" data-confirm="让它停下？" data-done="已停 ✓">停</button></p>` : ''}
    ${canReply ? html`<form class="reply" data-api="/api/tasks/${t.id}/reply" data-toast="已发给它">
      <label class="sr-only" for="reply-${t.id}">回一句话，让它改</label>
      <input id="reply-${t.id}" name="text" required maxlength="2000" autocomplete="off" placeholder="回一句话，让它改">
      ${sendBtn('发送')}
    </form>` : ''}
    <details class="thread-more" data-thread-more>
      <summary><span>详情：过程 · 记录 · 审计 · 执行器</span><span aria-hidden="true">›</span></summary>
      <div class="thread-detail">${detail(t, pend)}</div>
    </details>
  </article>`;
}
