import { DECISIONS, EXECUTORS, RISKS, STATUSES, ago, catLabel, execColor, execLabel, fmtDateTime, fmtTokens, truncate } from '../domain.ts';
import type { Approval } from '../services/approvals.ts';
import type { Account } from '../services/metrics.ts';
import type { Task } from '../services/tasks.ts';
import { handoffState, runnerExecutors, runnerOnline, staleRunner } from '../services/runner.ts';
import { getSetting } from '../services/dispatch.ts';
import { RUNNER_CMD } from '../services/setup.ts';
import { STAGE_FLOW, backendLabel, stageDef, stageOf, stuckFor, type StageKey } from '../services/stage.ts';
import { html, type Safe } from './html.ts';

export const dot = (color: string) => html`<span class="dot" style="background:${color}" aria-hidden="true"></span>`;
export const execTag = (k: string) => html`<span class="exec">${dot(execColor(k))}${execLabel(k)}</span>`;

/** 026: every state is one capsule, and CSS alone decides its colour — 见 style.css 的 .status 表. */
const TONE_CLASS: Record<string, string> = { ok: 'done', warn: 'review', bad: 'failed', info: 'running' };
export function tag(text: string, tone: '' | 'ok' | 'warn' | 'bad' | 'info' = ''): Safe {
  const k = TONE_CLASS[tone] ?? 'queued';
  // 038 C：带上状态本身，页面刷新后 app.js 才知道哪几个胶囊变了（变了的才淡淡换一次色）。
  return html`<span class="status ${k}" data-status="${k}"><span class="dot" aria-hidden="true"></span>${text}</span>`;
}

export function panelHead(title: string, aside?: Safe | string): Safe {
  return html`<div class="panel-head"><h2>${title}</h2>${aside ? html`<span class="panel-aside">${aside}</span>` : ''}</div>`;
}

/** 016: risk and status use the same dot-plus-word capsule as every other state. */
const RISK_TONE: Record<string, '' | 'ok' | 'warn' | 'bad' | 'info'> = { low: '', medium: 'warn', high: 'bad' };

export function riskBadge(risk: string): Safe {
  return tag(RISKS[risk]?.label ?? risk, RISK_TONE[risk] ?? 'info');
}
/** 026: the class is the status key itself, so the colour table lives only in style.css. */
export function statusBadge(status: string): Safe {
  return html`<span class="status ${status}" data-status="${status}"><span class="dot" aria-hidden="true"></span>${STATUSES[status]?.label ?? status}</span>`;
}

/** quota=true: a usage meter, turns red above 80%. Otherwise a neutral bar (progress, shares). */
export function bar(pct: number | null | undefined, color = 'var(--ink)', quota = false): Safe {
  const p = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const c = quota && p > 80 ? 'var(--danger)' : color;
  return html`<div class="bar" role="img" aria-label="${p}%"><div style="width:${p}%;background:${c}"></div></div>`;
}

/** 040：数据条上每一格都是 kpi。传 href 就整格可点（数据条的格子都点去 /data）。 */
export function kpi(label: string, value: string | number, sub: string | Safe, tone: '' | 'warn' | 'bad' = '', href?: string): Safe {
  const inner = html`<span class="kpi-label">${label}</span><span class="kpi-num">${value}</span><span class="kpi-sub">${sub}</span>`;
  return href ? html`<a class="kpi ${tone}" href="${href}">${inner}</a>` : html`<div class="kpi ${tone}">${inner}</div>`;
}

export const empty = (text: string) => html`<div class="empty">${text}</div>`;

/** 018: the one-line answer to "where is this task" — used on cards and in the drawer. */
export function stageTag(k: StageKey): Safe {
  const d = stageDef(k);
  return tag(d.label, d.tone);
}

/** 018: the same stages as a horizontal bar, current cell filled.
 *  028.1: 只读任务没走合并和推送，那四格显示成「跳过」而不是和真走过的一样亮。 */
export function stageBar(k: StageKey, opts: { noChanges?: boolean } = {}): Safe {
  const d = stageDef(k);
  const failed = k === 'failed';
  // STAGE_FLOW 里第 2–5 格是合并/推送那两步；没有改动时它们没有被跳过以外的可能。
  const skipFrom = 2;
  const skipTo = 5;
  return html`<ol class="stage-bar" aria-label="阶段：${d.label}">
    ${STAGE_FLOW.map((label, i) => {
      const skipped = Boolean(opts.noChanges) && !failed && i >= skipFrom && i <= skipTo;
      const state = skipped ? 'skipped' : failed ? 'todo' : i < d.step ? 'done' : i === d.step ? 'current' : 'todo';
      return html`<li class="stage-cell ${state}"><span class="stage-label">${label}</span>${skipped ? html`<em class="stage-skip">跳过</em>` : ''}</li>`;
    })}
    ${failed ? html`<li class="stage-cell bad"><span>失败</span></li>` : ''}
  </ol>`;
}

/**
 * 028.1: 执行器在跑旧代码时的橙色提示。
 * runner.mjs 是启动时读进内存的，磁盘上改了代码、不重启就还在跑旧逻辑——
 * T-18 / T-19 就是被这个坑了一整轮：模型明明读完了，页面却显示没有改动判断、没有结果。
 */
export function staleNotice(): Safe | null {
  const r = staleRunner();
  if (!r) return null;
  const cmd = 'Stop-ScheduledTask -TaskName "AI Workbench Runner"; Start-ScheduledTask -TaskName "AI Workbench Runner"';
  return html`<div class="callout warn stale-code">
    <strong>执行器还在跑旧代码</strong>
    <p>${r.id} 启动时加载的是 <code class="mono">${r.code_hash || '未知'}</code> 那一版，磁盘上的 runner 已经改过了。
      重启执行器之后新功能才生效；重启前它仍会按旧逻辑干活。</p>
    <div class="code"><button type="button" class="copy" data-copy>复制</button><pre>${cmd}</pre></div>
    <p class="hint">自己手动开着的执行器：在它的窗口按 Ctrl+C，再重新跑一次 <code class="mono">${RUNNER_CMD}</code>。</p>
  </div>`;
}

/**
 * 035.3：部署之后的交接。
 *
 * 部署完、旧执行器退出、新执行器还没来的那几秒钟，「执行器离线」是正常的，不该报警；
 * 但超过 5 分钟就说明接班失败了——旧进程是真的走了，机器上没人干活。
 * 这两种状态都得说出来，否则页面只会显示「离线」，人以为是网络问题。
 */
export function handoffNotice(): Safe | null {
  const h = handoffState();
  if (h.state === 'none') return null;
  const cmd = 'Start-ScheduledTask -TaskName "AI Workbench Runner"';
  if (h.state === 'waiting') {
    return html`<div class="callout info handoff">
      <strong>等待新执行器接班</strong>
      <p>部署完成，旧执行器（pid ${h.from_pid}，代码 <code class="mono">${h.from_hash || '未知'}</code>）已经退出，
        接班助手正在启动新实例${h.minutes ? `，已经等了 ${h.minutes} 分钟` : ''}。正常情况下十几秒就好。</p>
    </div>`;
  }
  return html`<div class="callout warn handoff-missed">
    <strong>执行器没有接班，请手动启动</strong>
    <p>部署完成已经 ${h.minutes} 分钟，还是没有新执行器的第一跳心跳（旧 pid ${h.from_pid}）。
      这几分钟里任务不会有人领，看一眼 <code class="mono">runner-autostart.log</code> 再启动一次。</p>
    <div class="code"><button type="button" class="copy" data-copy>复制</button><pre>${cmd}</pre></div>
    <p class="hint">自己手动开着的执行器：在它的窗口按 Ctrl+C，再重新跑一次 <code class="mono">${RUNNER_CMD}</code>。</p>
  </div>`;
}

/**
 * 018: "is a runner awake?" belongs at the top of the two pages someone opens first. It is the
 * single most common reason a task just sits in 排队.
 */
export function runnerNotice(): Safe {
  const handoff = handoffNotice();
  if (handoff) return handoff;
  const stale = staleNotice();
  if (stale) return stale;
  // 044 v3：在线是常态，不占一行（侧边栏底部那个小点已经说了）；只有出问题才说话。
  if (runnerOnline()) return html``;
  // 034：橙条不再把人送去 README 自己找——直接落到清单里「启动执行器」那一步。
  // 清单被「不再提示」收起来时，设置 › 接入 里那份还在，锚点也一样。
  const dismissed = getSetting('setup_dismissed') === '1';
  const where = dismissed ? '/settings/integrations#setup-runner' : '/#setup-runner';
  return html`<p class="runner-line off">${dot('var(--warn)')}<span>执行器没开，点开始后任务会排队。</span>
    <a href="${where}">怎么开 ↗</a></p>`;
}

/** Stacked daily bars, one segment per executor. */
export function stackedBars(days: string[], series: Record<string, number[]>, height = 180): Safe {
  const keys = Object.keys(series).filter((k) => series[k].some((v) => v > 0));
  const totals = days.map((_, i) => keys.reduce((s, k) => s + series[k][i], 0));
  const max = Math.max(1, ...totals);
  const dense = days.length > 10;
  return html`
    <div class="legend">${(keys.length ? keys : Object.keys(series)).map((k) => html`<span>${dot(execColor(k))}${execLabel(k)}</span>`)}</div>
    <div class="chart" role="img" aria-label="每日 Token 用量堆叠柱状图" style="height:${height + 22}px">
      ${days.map((d, i) => html`
        <div class="col" title="${d}：${fmtTokens(totals[i])}">
          ${dense ? '' : html`<span class="col-num">${totals[i] ? fmtTokens(totals[i]) : ''}</span>`}
          <div class="stack" style="height:${Math.round((totals[i] / max) * height)}px">
            ${keys.map((k) => series[k][i] ? html`<div style="flex:${series[k][i]};background:${execColor(k)}"></div>` : '')}
          </div>
        </div>`)}
    </div>
    <div class="chart-x">${days.map((d) => html`<span>${dense ? d.slice(8) : d.slice(5).replace('-', '/')}</span>`)}</div>`;
}

/**
 * 038 A：合并 / 推送 / 部署这三种按钮点下去是有后果的——成功态要带上动作名（「已批准合并 ✓」），
 * 而且由 app.js 多停 1.5 秒，让人看清自己刚批了什么。
 */
export function riskyAction(a: Pick<Approval, 'tool_name' | 'risk'>): string {
  const byTool: Record<string, string> = { 'git merge': '合并', 'git push': '推送', 'docker compose': '部署' };
  return byTool[a.tool_name] ?? (a.risk === 'high' ? '高风险操作' : '');
}

export function approvalCard(a: Approval, task: Task | undefined, opts: { full?: boolean; accent?: boolean } = {}): Safe {
  const executor = task?.executor ?? 'claude';
  const risky = riskyAction(a);
  const head = html`
    <div class="approval-head">
      <div class="approval-title">
        <strong>${a.title}</strong>
        <span class="meta">${execTag(executor)}${task?.project ? html` · <span class="mono">${task.project}</span>` : ''} · ${ago(a.created_at)}</span>
      </div>
      ${riskBadge(a.risk)}
    </div>
    <div class="chips">
      <span class="chip">触发规则：${a.rule_name || '手动发起'}</span>
      ${a.tool_name ? html`<span class="chip mono">${a.tool_name}</span>` : ''}
    </div>`;
  if (a.status !== 'pending') {
    return html`<div class="approval done">${head}
      <div class="decision">${DECISIONS[a.status] ?? (a.status === 'expired' ? '超时' : a.status)} · ${fmtDateTime(a.decided_at)}${a.feedback ? html` · ${a.feedback}` : ''}</div></div>`;
  }
  return html`
    <form class="approval" data-api="/api/approvals/${a.id}/decide" data-risk="${risky ? 'high' : ''}">
      ${head}
      ${a.summary ? (opts.full ? html`<pre class="summary">${a.summary}</pre>` : html`<details><summary>查看详情</summary><pre class="summary">${a.summary}</pre></details>`) : ''}
      <div class="actions decide">
        <button class="btn solid" name="decision" value="approved"
          data-risk="${risky ? 'high' : ''}" data-done="已批准${risky} ✓">批准</button>
        ${opts.full ? html`<details class="fix">
          <summary class="btn">不行，让它改…</summary>
          <label class="field"><span>告诉它哪里不对。这句话会原样发给它，它按你说的改完再来问你。</span><textarea name="feedback" rows="2" placeholder="例：先补一条去重的测试再推送"></textarea></label>
          <button class="btn" name="decision" value="changes" data-done="已发给它 ✓">发给它</button>
        </details>` : html`<a class="btn" href="/tasks?task=${a.task_id ?? ''}" data-panel>不行，让它改…</a>`}
        <span class="decide-rest">
          <button class="link-btn" name="decision" value="takeover" data-done="归你了 ✓" title="AI 停下，这件事转到你的待办">我自己来</button>
          <button class="link-btn" name="decision" value="rejected" data-done="已驳回 ✓" title="不做这一步，AI 换个办法或停下">驳回</button>
        </span>
      </div>
    </form>`;
}

// ---------- 040：一个对象一种长相 ----------

/** 钱的写法只有一处。以前 overview 和 team 各有一份 balanceText / budgetText，口径还不完全一样。 */
export const money = (v: number, unit: string): string =>
  unit === 'CNY' ? `¥${v.toFixed(2)}` : unit === 'USD' ? `$${v.toFixed(2)}` : `${v} ${unit}`.trim();

export type ExecState = 'me' | 'online' | 'dispatch' | 'offline';

/**
 * 040：执行者头。剧组页每个区的收起行、抽屉标题都用它，
 * 所以「在线 / 只派单 / 离线」在哪儿都是同一组词和同一个颜色。
 */
export function execHead(key: string, state: { kind: ExecState; running?: number; queued?: number }): Safe {
  const chip = state.kind === 'online' ? tag('在线', 'ok')
    : state.kind === 'dispatch' ? tag('只派单', 'warn')
      : state.kind === 'me' ? tag('我自己', 'info')
        : tag('离线');
  const busy = state.running ?? 0;
  const queued = state.queued ?? 0;
  const now = busy ? `${busy} 个在跑` : '空闲';
  return html`<span class="exec-head" data-exec-head="${key}">${execTag(key)}${chip}<span class="meta">${queued ? `${now} · ${queued} 个排队` : now}</span></span>`;
}

/**
 * 040：一个执行者的额度合成一行。
 * 有窗口就画条（百分比跟着条走），余额和积分写成文字，什么都没有就写「额度 —」。
 */
export function quotaMeter(accounts: Account[]): Safe {
  const win = accounts.filter((a) => a.kind === 'window' && a.window_pct !== null);
  const pct = win.length ? Math.max(...win.map((a) => a.window_pct ?? 0)) : null;
  const bal = accounts.find((a) => a.kind === 'balance' && a.balance !== null);
  const cred = accounts.find((a) => a.kind === 'credits' && a.balance !== null);
  const bits: string[] = [];
  if (bal) bits.push(`余额 ${bal.balance_estimated ? '≈ ' : ''}${money(bal.balance!, bal.balance_unit)}`);
  if (cred) bits.push(`积分 ${cred.balance}`);
  // 窗口百分比不写成字：条本身就是它，写两遍在数据条那种窄格子里会打架。
  return html`<span class="quota-meter" data-quota>
    ${pct === null ? '' : bar(pct, 'var(--ink)', true)}
    ${bits.length ? html`<span class="quota-text">${bits.join(' · ')}</span>`
      : pct === null ? html`<span class="quota-text">额度 —</span>` : ''}
  </span>`;
}

export type TaskCardOpts = {
  /** 默认 `/tasks?task=<id>`；看板传自己的筛选地址，点开抽屉时筛选不丢。 */
  href?: string;
  on?: boolean;
  /** 执行者自己的块里不再重复写执行者（其余结构不变，好让测试比对）。 */
  hideExec?: boolean;
  pend?: { risk: string; tool_name?: string }[];
  /** 规则 4：卡片最多一个动作。块自己已经有主按钮时传 false。 */
  action?: boolean;
  /** 剧组展开里的缩小版：同一个结构，字和间距小一号。 */
  mini?: boolean;
};

/** 卡片上那唯一的动作：等审批给「去审批」，排队给「开始」，失败给「重试」，我的待办给「完成」。 */
function cardAction(t: Task, pend: { risk: string; tool_name?: string }[]): Safe | null {
  if (t.status === 'asking') return html`<a class="btn small" href="/tasks?task=${t.id}">去选</a>`; // 055.2
  if (pend.length || t.status === 'review') return html`<a class="btn small" href="/tasks?task=${t.id}">去审批</a>`;
  // 040：我的待办进了同一个网格，勾掉这件事得跟着过来——不然卡片一上线，待办就没法标完成。
  if (t.executor === 'me' && (t.status === 'inbox' || t.status === 'queued')) {
    return html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}" data-method="PATCH"
      data-body="${JSON.stringify({ status: 'done' })}" data-done="已完成 ✓">完成</button>`;
  }
  if (t.status === 'queued') return html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/start" data-method="POST" data-no-done>开始</button>`;
  // 040.1：合并/推送失败的任务已经有成果了，只能接着那一步重试。
  // 以前这里一律给 /restart，点一下 retry 就被清成 null、整段编码重跑一遍——白烧一遍 token。
  if (t.status === 'failed' && t.retry === 'merge' && t.branch) {
    return html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/retry-merge" data-method="POST" data-no-done>重试合并</button>`;
  }
  if (t.status === 'failed' && t.retry === 'push') {
    return html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/retry-push" data-method="POST" data-no-done>重试推送</button>`;
  }
  if (t.status === 'failed') return html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/restart" data-method="POST" data-confirm="重新排队跑一遍 T-${t.id}？" data-no-done>重试</button>`;
  return null;
}

/**
 * 040：任务卡只有这一个实现。今天页、剧组页、任务看板调的是同一个函数，
 * 所以同一个任务在哪一页都长得一样，改卡片只改这里。
 * 整张卡可点（标题的 ::after 铺满卡片），底部那个动作按钮用 z-index 浮在上面。
 */
/**
 * 042：一句话说清「谁派的、多难、为什么」。只在大脑派的任务上出现——
 * 你自己选的任务不需要再解释一遍。
 */
export function brainLine(t: Task): Safe {
  if (t.route !== 'brain') return html``;
  if (!t.routed_at) return html`<span class="card-brain waiting">等大脑派单</span>`;
  const diff = t.difficulty ? `难度 ${t.difficulty}/5` : '难度没给';
  return html`<span class="card-brain" data-brain>${dot(execColor(t.executor))}大脑：${execLabel(t.executor)} · ${diff}${t.route_reason ? ` · ${truncate(t.route_reason, 40)}` : ''}</span>`;
}

/** 044 原子：执行者头像——一个带执行者颜色的小圆，里面是名字的第一个字。 */
export function avatar(k: string, size: 'sm' | 'md' | 'lg' = 'sm'): Safe {
  const name = execLabel(k);
  // 044 v3：头像统一墨色，不再带执行者颜色（也不再写内联样式）。
  return html`<span class="avatar av-${size}" aria-hidden="true">${[...name][0] ?? '?'}</span>`;
}

/** 044 原子：五个阶段点（领取、编码、合并、推送、完成）。走过的实心，正在走的那一个跳动。 */
const DOT_STAGES: [string, number][] = [['领取', 0], ['编码', 1], ['合并', 3], ['推送', 5], ['完成', 6]];
export function stageDots(k: StageKey, opts: { noChanges?: boolean } = {}): Safe {
  const d = stageDef(k);
  const failed = k === 'failed';
  const label = `阶段：${d.label}`;
  return html`<span class="stage-dots${failed ? ' bad' : ''}" role="img" aria-label="${label}" title="${label}">${DOT_STAGES.map(([name, reach], i) => {
    const skipped = Boolean(opts.noChanges) && (i === 2 || i === 3);
    const state = skipped ? 'skip' : d.step > reach || (d.step === reach && reach === 6) ? 'done' : d.step === reach ? 'now' : 'todo';
    return html`<i class="sd ${state}" data-stage="${name}"></i>`;
  })}</span>`;
}

/** 044 原子：细进度条。只在真有百分比时出现。 */
export function progressBar(pct: number, color: string): Safe {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return html`<span class="pbar" role="img" aria-label="进度 ${p}%"><span style="width:${p}%;background:${color}"></span></span>`;
}

/** 卡片底下那一句现状：被拦住说原因，在跑说步骤，排队说在等什么。 */
function cardNote(t: Task, stuck: boolean, pend: { risk: string }[]): { text: string; tone: '' | 'warn' | 'bad' } {
  if (t.status === 'failed') return { text: `✕ ${t.fail_reason ? truncate(t.fail_reason, 60) : '没成'}`, tone: 'bad' };
  if (stuck) return { text: '⚠ 可能卡住了', tone: 'bad' };
  // 055.2：等你选。符号代替文字：? 后面就是它问的那句话。
  if (t.status === 'asking') return { text: `? ${truncate(String(t.step ?? '').replace(/^等你选[：:]\s*/, '') || '等你选', 40)}`, tone: 'warn' };
  if (pend.length || t.status === 'review') return { text: pend.length > 1 ? `! ${pend.length} 件等你拍板` : '! 等你拍板', tone: 'warn' };
  if (t.status === 'running') return { text: `▶ ${t.step ? truncate(t.step, 40) : '在干活'}`, tone: '' };
  if (t.status === 'done') return { text: t.result_text ? '✓ 有结果' : '✓', tone: '' };
  if (t.route === 'brain' && !t.routed_at) return { text: '⋯ 等大脑派单', tone: '' };
  if (t.executor === 'me') return { text: '☐ 你的待办', tone: '' };
  return { text: '‖ 排队', tone: '' };
}

/**
 * 044 分子：任务卡——全站只有这一种。工作台的任务流、剧组展开里的「手上的活」、看板，调的都是它。
 * 标题、头像、阶段点、进度条、一句现状；被拦住是红底，等你是橙底。
 * 整张卡可点（标题链接的 ::after 铺满卡片），点开从右侧滑出详情；最多一个动作按钮浮在上面。
 */
export function taskCard(t: Task, opts: TaskCardOpts = {}): Safe {
  const pend = opts.pend ?? [];
  const risk = pend.length
    ? [...pend].map((p) => p.risk).sort((a, b) => (a === 'high' ? -1 : b === 'high' ? 1 : 0))[0]
    : null;
  const stage = stageOf(t, pend.map((p) => p.tool_name ?? ''));
  const stuck = Boolean(stuckFor(t));
  const blocked = t.status === 'failed' || stuck;
  const cls = ['card', opts.on ? 'on' : '', pend.length || t.status === 'asking' ? 'needs-you' : '', t.status === 'failed' ? 'failed' : '', stuck ? 'stuck' : '', opts.mini ? 'mini' : '']
    .filter(Boolean).join(' ');
  const href = opts.href ?? `/tasks?task=${t.id}`;
  const act = opts.action === false ? null : cardAction(t, pend);
  const note = cardNote(t, stuck, pend);
  const showBar = t.status === 'running' && t.progress !== null && t.progress !== undefined && !blocked;
  return html`<div class="${cls}" data-card="task" data-task="${t.id}" data-state="${t.status}">
    <a class="card-title" href="${href}" data-panel>${t.title}</a>
    <span class="card-row">
      ${opts.hideExec ? '' : html`${avatar(t.executor)}<span class="card-exec">${execLabel(t.executor)}</span>`}
      <span class="card-proj mono">${t.project || `T-${t.id}`}</span>
      ${risk ? riskBadge(risk) : ''}
      ${stageDots(stage, { noChanges: Boolean(t.no_changes) })}
    </span>
    ${showBar ? progressBar(t.progress ?? 0, execColor(t.executor)) : ''}
    ${brainLine(t)}
    <span class="card-foot">
      <span class="card-note ${note.tone}${t.status === 'failed' ? ' card-reason' : ''}">${note.text}</span>
      ${act ? html`<span class="card-act">${act}</span>` : ''}
    </span>
  </div>`;
}

/** 040：任务该按什么顺序出现——等你拍板的排最前，我的待办排最后。今天页和执行者区都用这一份。 */
export function cardRank(t: Task, pending: Set<number>): number {
  return pending.has(t.id) || t.status === 'review' || t.status === 'asking' ? 0
    : t.status === 'running' ? 1
      : t.status === 'queued' ? 2
        : 3;
}

/**
 * 024.1：执行者下拉要能看出「这个选真的会开跑吗」。
 * 以前只有名字，于是新建任务默认选中 Claude（没人轮询），派过去就一直排队。
 */
export function executorState(k: string, opts: { runners: Set<string>; settings?: Map<string, { enabled?: boolean }> }): 'me' | 'online' | 'dispatch' | 'offline' {
  if (k === 'me') return 'me';
  if (opts.settings?.get(k)?.enabled === false) return 'dispatch'; // 用户在剧组页设成「只派单」
  return opts.runners.has(k) ? 'online' : 'offline';
}

const STATE_SUFFIX: Record<string, string> = { me: '（进我的待办）', online: '（在线）', dispatch: '（只派单）', offline: '（没有执行器在跑）' };

/** `states` 传了才标状态；不传就是纯名字（保持老调用方不变）。`brain` 打开时第一项是「让大脑选」。 */
export function execOptions(selected?: string, states?: Record<string, string>, opts: { brain?: boolean } = {}): Safe {
  return html`${opts.brain ? html`<option value="__brain" ${selected === '__brain' ? 'selected' : ''}>让大脑选（按战绩和额度挑一个）</option>` : ''}${Object.entries(EXECUTORS).map(([k, v]) => html`<option value="${k}" ${k === selected ? 'selected' : ''}>${v.label}${states?.[k] ? STATE_SUFFIX[states[k]] ?? '' : ''}</option>`)}`;
}

/** 新建任务时的默认执行者：优先在线且能接活的，其次「我」，最后第一个。 */
export function defaultExecutor(states: Record<string, string>): string {
  const first = Object.keys(EXECUTORS).find((k) => states[k] === 'online');
  return first ?? 'me';
}

// ---------- 044：数据格、小图、审批卡（工作台用） ----------

/** 044 分子：数据格——一个标签、一个大数字、右下一个小图。整格可点，点进去落到这个数字说的那些东西上。 */
export function tile(o: { label: string; value: string | number | Safe; chart?: Safe; href?: string; tone?: '' | 'warn' | 'bad'; title?: string }): Safe {
  const inner = html`<span class="tile-label">${o.label}</span><span class="tile-body"><span class="tile-num">${o.value}</span>${o.chart ?? ''}</span>`;
  return o.href
    ? html`<a class="kpi tile ${o.tone ?? ''}" href="${o.href}"${o.title ? html` title="${o.title}"` : ''}>${inner}</a>`
    : html`<div class="kpi tile ${o.tone ?? ''}">${inner}</div>`;
}

/** 044 原子：7 根小柱。最后一根（今天）用墨色，其余淡一些。 */
export function miniBars(values: number[], label: string): Safe {
  const max = Math.max(1, ...values);
  const w = 8, gap = 4, h = 28;
  return html`<svg class="mini" width="${values.length * (w + gap) - gap}" height="${h}" viewBox="0 0 ${values.length * (w + gap) - gap} ${h}" role="img" aria-label="${label}">${values.map((v, i) => {
    const bh = v ? Math.max(3, Math.round((v / max) * h)) : 2;
    return html`<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="2" class="${i === values.length - 1 ? 'now' : ''}"></rect>`;
  })}</svg>`;
}

/** 044 原子：折线小图，末端一个点。 */
export function miniLine(values: number[], label: string): Safe {
  const max = Math.max(1, ...values);
  const W = 86, H = 28, step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values.map((v, i) => [Math.round(i * step * 10) / 10, Math.round((H - 3 - (v / max) * (H - 6)) * 10) / 10]);
  const last = pts[pts.length - 1] ?? [W, H];
  return html`<svg class="mini" width="${W}" height="${H}" viewBox="-3 0 ${W + 6} ${H}" role="img" aria-label="${label}">
    <polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
    <circle cx="${last[0]}" cy="${last[1]}" r="3"></circle></svg>`;
}

/**
 * 044 分子：审批卡（工作台「需要你」里那种）。一行说清是谁要做什么，右边驳回 / 批准。
 * 点了之后整张卡就地变色、写清批了什么，停一下再收起（app.js 看 data-settle）。
 * 打回修改要写意见，那个在详情面板里做——点标题打开。
 */
export function needCard(a: Approval, task: Task | undefined, opts: { inline?: boolean } = {}): Safe {
  const executor = task?.executor ?? 'claude';
  const risky = riskyAction(a);
  const what = risky || a.tool_name || '这一步';
  return html`<form class="need" data-api="/api/approvals/${a.id}/decide" data-settle data-risk="${risky ? 'high' : ''}" data-approval="${a.id}">
    ${avatar(executor, 'md')}
    <a class="need-main" href="/tasks?task=${a.task_id ?? ''}" data-panel>
      <span class="need-title">${a.title}</span>
      <span class="need-sub">${a.risk === 'high' ? html`<b class="need-risk">高风险</b> · ` : ''}${execLabel(executor)} · ${what}${task?.project ? ` · ${task.project}` : ''} · ${ago(a.created_at)}</span>
    </a>
    ${a.task_id && !opts.inline ? html`<span class="group-go" aria-hidden="true">›</span>` : html`<span class="need-acts">
      <button class="btn" name="decision" value="rejected" data-done="已驳回 ✓" data-settled="已驳回：${risky || truncate(a.title, 30)}">驳回</button>
      <button class="btn solid" name="decision" value="approved" data-risk="${risky ? 'high' : ''}" data-done="已批准${risky} ✓" data-settled="已批准：${risky || truncate(a.title, 30)}">批准</button>
    </span>`}
    <span class="need-done" aria-live="polite"></span>
  </form>`;
}
