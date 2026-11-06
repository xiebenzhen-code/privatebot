import { ago, catLabel, duration, execColor, execLabel, fmtDateTime, fmtTokens, lastDays } from '../domain.ts';
import { listEvents } from '../services/core.ts';
import { redactText } from '../services/sources.ts';
import { brainTokens, ledger, listAccounts, listMachines, periodStats, tokensByDay, tokensByExecutorSince, type Outcome } from '../services/metrics.ts';
import { brainState } from '../services/brain.ts';
import { poolStats } from '../services/cliproxyapi.ts';
import { bar, dot, empty, kpi, stackedBars } from './components.ts';
import { html, type Safe } from './html.ts';
import { tabLabel } from './routes.ts';

export type DataTab = 'usage' | 'audit' | 'machines';

export function dataPage(q: URLSearchParams, tab: DataTab): Safe {
  if (tab === 'audit') return auditPanel();
  if (tab === 'machines') return machinesPanel();
  return html`${ledgerPanel(q)}<details class="fold more-usage" id="more-usage"><summary>更多用量明细（按天 token、分类、反代池）</summary>${usagePanel(q)}</details>`;
}

/** Data › machines: what used to sit at the bottom of the overview page. */
function machinesPanel(): Safe {
  const machines = listMachines();
  return html`
  <header class="page-head">
    <div>
      <span class="eyebrow">MACHINES · ${machines.filter((m) => m.online).length} / ${machines.length} 在线</span>
      <h1>${tabLabel('machines')}</h1>
      <p class="lede">心跳每分钟上报一次。负载、内存、GPU 和容器数都来自脚本上报。</p>
    </div>
  </header>
  <section class="panel">
    <div class="panel-head"><h2>机器与容器</h2><span class="meta">配好 scripts/heartbeat.sh 就会出现在这里</span></div>
    ${machines.length ? html`<ul class="machines">${machines.map((m) => html`
      <li>
        ${dot(m.online ? 'var(--ok-dot)' : 'var(--danger)')}
        <span class="grow"><strong>${m.name}</strong><span class="meta">${m.online ? m.meta : `离线 · 最后心跳 ${ago(m.updated_at)}`}</span></span>
        <span class="mono">${m.metrics.load !== undefined ? `负载 ${m.metrics.load}` : ''}${m.metrics.temp_c !== undefined ? ` · ${m.metrics.temp_c}°C` : ''}</span>
      </li>
      ${m.metrics.mem_total_gb ? html`<li class="sub"><span class="grow">内存</span>${bar(((m.metrics.mem_used_gb ?? 0) / m.metrics.mem_total_gb) * 100, 'var(--ink)', true)}<span class="mono">${m.metrics.mem_used_gb}/${m.metrics.mem_total_gb}G</span></li>` : ''}
      ${(m.metrics.gpus ?? []).map((g, i) => html`<li class="sub"><span class="grow">GPU ${i} · ${g.name ?? ''}</span>${bar(g.mem_total ? ((g.mem_used ?? 0) / g.mem_total) * 100 : g.util, 'var(--ink)', true)}<span class="mono">${g.temp ?? '–'}°C · ${g.util ?? 0}%</span></li>`)}
      ${m.metrics.containers !== undefined ? html`<li class="sub"><span class="grow">容器</span><span class="mono">${m.metrics.containers} 个运行中</span></li>` : ''}
    `)}</ul>` : empty('还没有机器上报心跳。在服务器上配好 scripts/heartbeat.sh 即可。')}
  </section>`;
}

const OUT: Record<Outcome, { label: string; cls: string }> = {
  once: { label: '一次就过', cls: 'o-once' }, fix: { label: '让它改过', cls: 'o-fix' }, me: { label: '你自己来', cls: 'o-me' }, fail: { label: '没成', cls: 'o-fail' },
};
const ORDER: Outcome[] = ['once', 'fix', 'me', 'fail'];
const SHADES = ['o-once', 'o-fix', 'o-me', 'o-fail'];

/** 一条分段的小条 + 图例。段的深浅按排名（第一多的最饱和），不用彩色。 */
function segBar(segs: { name: string; n: number; cls: string }[], aria: string): Safe {
  const total = segs.reduce((x, y) => x + y.n, 0) || 1;
  const shown = segs.filter((g) => g.n > 0);
  return html`<span class="seg-bar" role="img" aria-label="${aria}">${shown.map((g) => html`<i class="${g.cls}" style="flex:${g.n / total}"></i>`)}</span>
    <span class="seg-legend">${shown.map((g) => html`<span><i class="${g.cls}"></i>${g.name}</span>`)}</span>`;
}

/**
 * 044 v3：记录 =「AI 替你干的活」。一句话 → 三张小卡（做完多少按结局、谁干的、花了多少）→ 按天，一件活一个小方块，
 * 点开那天看每件活，再点进详情。结局和「谁干的」都落在具体的活上，不是两套数字。
 */
function ledgerPanel(q: URLSearchParams): Safe {
  const period = q.get('p') === 'month' ? 'month' : 'week';
  const n = period === 'month' ? 30 : 7;
  const { items, days } = ledger(n);
  const by = (o: Outcome) => items.filter((i) => i.outcome === o).length;
  const once = by('once');
  const title = items.length
    ? `${period === 'month' ? '这个月' : '这周'}做完 ${items.length} 件${once / items.length >= 0.6 ? '，大多一次就过' : once ? `，${once} 件一次就过` : ''}`
    : `${period === 'month' ? '这个月' : '这周'}还没有做完的活`;
  const who = new Map<string, number>();
  for (const i of items) who.set(i.executor, (who.get(i.executor) ?? 0) + 1);
  const whoSegs = [...who.entries()].sort((a, b) => b[1] - a[1]).map(([k, v], idx) => ({ name: execLabel(k), n: v, cls: SHADES[Math.min(idx, 3)] }));
  const tok = tokensByExecutorSince(days[0]);
  const tokSegs = Object.entries(tok).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v], idx) => ({ name: execLabel(k), n: v, cls: SHADES[Math.min(idx, 3)] }));
  const tokTotal = Object.values(tok).reduce((x, y) => x + y, 0);
  const open = q.get('day') ?? days[days.length - 1];
  const dayLabel = (d: string) => (d === days[days.length - 1] ? '今天' : d === days[days.length - 2] ? '昨天' : d.slice(5).replace('-', '/'));
  const keep = (extra: Record<string, string>) => { const u = new URLSearchParams(q); for (const [k, v] of Object.entries(extra)) u.set(k, v); return `/data?${u}`; };
  const shownDays = [...days].reverse().filter((d, i) => i === 0 || items.some((x) => x.day === d));
  return html`<div class="layer wide" data-layer="ledger">
    <header class="ledger-head">
      <span class="lede-block"><span class="lede-date">AI 替你干的活</span><h1 class="lede-line">${title}</h1></span>
      <span class="seg-switch" role="group" aria-label="时间范围">
        <a href="${keep({ p: 'week' })}" class="${period === 'week' ? 'on' : ''}" aria-pressed="${period === 'week' ? 'true' : 'false'}">这周</a>
        <a href="${keep({ p: 'month' })}" class="${period === 'month' ? 'on' : ''}" aria-pressed="${period === 'month' ? 'true' : 'false'}">这个月</a>
      </span>
    </header>
    <section class="ledger-cards" aria-label="总览">
      <div class="lcard"><span class="lcard-label">做完</span><span class="lcard-num">${items.length}<small>件</small></span>
        ${segBar(ORDER.map((o) => ({ name: OUT[o].label, n: by(o), cls: OUT[o].cls })), `结局：${ORDER.map((o) => `${OUT[o].label} ${by(o)}`).join('，')}`)}</div>
      <div class="lcard"><span class="lcard-label">谁干的</span><span class="lcard-num">${who.size}<small>位</small></span>
        ${segBar(whoSegs, `谁干的：${whoSegs.map((g) => `${g.name} ${g.n}`).join('，')}`)}</div>
      <div class="lcard"><span class="lcard-label">花了</span><span class="lcard-num">${fmtTokens(tokTotal)}<small>token</small></span>
        ${segBar(tokSegs, `花在谁身上：${tokSegs.map((g) => `${g.name} ${fmtTokens(g.n)}`).join('，')}`)}</div>
    </section>
    <section class="ledger-days" aria-label="按天">
      <span class="ledger-cap">按天看 · 点开是那天做完的活</span>
      <div class="day-list">
      ${shownDays.map((d) => {
        const xs = items.filter((x) => x.day === d);
        const t = xs.reduce((a, b) => a + b.tokens, 0);
        const fails = xs.filter((x) => x.outcome === 'fail').length;
        return html`<details class="day" id="day-${d}" ${d === open ? 'open' : ''}>
          <summary><span class="day-name">${dayLabel(d)}</span>
            <span class="day-marks" role="img" aria-label="${dayLabel(d)} 做完 ${xs.length} 件">${xs.map((x) => html`<i class="${OUT[x.outcome].cls}" title="${x.title} · ${OUT[x.outcome].label}"></i>`)}</span>
            <span class="day-sum" title="${xs.length} 件${fails ? `，${fails} 件没成` : ''}">${xs.length ? html`${xs.length}${fails ? html`<span class="sym fail" aria-label="${fails} 件没成"> ✕ ${fails}</span>` : ''}` : '—'}</span>
            <span class="day-tok mono">${t ? fmtTokens(t) : ''}</span></summary>
          ${xs.length ? html`<div class="day-tasks">${xs.map((x) => html`<a class="day-task" href="/tasks?task=${x.id}" data-panel>
            <i class="${OUT[x.outcome].cls}"></i><span class="dt-title">${x.title}</span><span class="dt-out ${x.outcome}">${OUT[x.outcome].label}</span>
            <span class="avatar av-sm" aria-hidden="true">${[...execLabel(x.executor)][0] ?? '?'}</span><span class="dt-tok mono">${x.tokens ? fmtTokens(x.tokens) : '—'}</span></a>`)}</div>` : ''}
        </details>`;
      })}
      </div>
      <span class="ledger-note">每个小方块是一件活：越亮越省心（一次就过），越淡越费你的事（让它改过、你自己来、没成）。</span>
    </section>
    <nav class="more-links" aria-label="更多"><a href="/data/audit">审计日志 ›</a><a href="/data/machines">机器 ›</a></nav>
  </div>`;
}

const ACTOR_COLOR: Record<string, string> = { me: '#0F766E', system: '#5F5E58' };

function auditPanel(): Safe {
  const events = listEvents({ limit: 200 });
  return html`
  <header class="page-head">
    <div>
      <span class="eyebrow">AUDIT · 最近 ${events.length} 条</span>
      <h1>${tabLabel('audit')}</h1>
      <p class="lede">谁在什么时候做了什么。导出的 CSV 和这里看到的一样。</p>
    </div>
    <div class="head-actions"><a class="btn" href="/api/events.csv">导出 CSV</a></div>
  </header>
  <section class="panel">
    ${events.length ? html`<ul class="audit">${events.map((e) => html`
      <li><span class="mono muted">${fmtDateTime(e.ts)}</span><strong style="color:${ACTOR_COLOR[e.actor] ?? execColor(e.actor)}">${e.actor === 'me' ? '我' : e.actor === 'system' ? '系统' : execLabel(e.actor)}</strong><span>${e.task_id ? html`<a href="/tasks?task=${e.task_id}">${redactText(e.text)}</a>` : redactText(e.text)}</span></li>`)}</ul>` : empty('暂无记录')}
  </section>`;
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
function change(cur: number, prev: number, unit = ''): string {
  if (!prev) return '上期无数据';
  const d = Math.round(((cur - prev) / prev) * 100);
  return `较上期 ${d >= 0 ? '+' : ''}${d}%${unit}`;
}

function usagePanel(q: URLSearchParams): Safe {
  const days = [7, 14, 30].includes(Number(q.get('days'))) ? Number(q.get('days')) : 14;
  const s = periodStats(days);
  const chart = tokensByDay(days);
  const pool = poolStats(days);
  const range = lastDays(days);
  const maxCat = Math.max(1, ...s.byCategory.map((c) => c.n));
  const maxProj = Math.max(1, ...s.projects.map((p) => p.t));
  const accounts = listAccounts();
  // 042：调度大脑自己的开销，另算一行。
  const brain = { ...brainState(), tokens: brainTokens(days) };

  return html`
  <header class="page-head">
    <div>
      <span class="eyebrow">DATA · ${range[0].slice(5).replace('-', '/')} – ${range[range.length - 1].slice(5).replace('-', '/')}</span>
      <h1>${tabLabel('usage')}</h1>
    </div>
    <div class="seg inline" role="group" aria-label="时间范围">
      ${[7, 14, 30].map((d) => html`<a href="/data?days=${d}" class="seg-item ${d === days ? 'on' : ''}">${d} 天</a>`)}
    </div>
  </header>

  <section class="kpis" aria-label="汇总指标">
    ${kpi('Token 合计', fmtTokens(s.tokens), change(s.tokens, s.prevTokens))}
    ${kpi('完成任务', s.done, s.prevDone ? `较上期 ${s.done - s.prevDone >= 0 ? '+' : ''}${s.done - s.prevDone}` : '上期无数据')}
    ${kpi('成功率', pct(s.successRate), s.prevSuccessRate === null || s.successRate === null ? '完成 ÷（完成 + 失败）' : `较上期 ${Math.round((s.successRate - s.prevSuccessRate) * 100) >= 0 ? '+' : ''}${Math.round((s.successRate - s.prevSuccessRate) * 100)}%`)}
    ${kpi('平均耗时', s.avgDuration === null ? '—' : duration(s.avgDuration), '从开始运行到完成')}
    ${kpi('人工介入', s.takeovers + s.changes, `接管 ${s.takeovers} · 打回 ${s.changes}`)}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Token 用量 · 按执行者</h2><span class="meta">输入 + 输出；缓存读写另计 ${fmtTokens(chart.cache)}</span></div>
    ${stackedBars(chart.days, chart.series, 200)}
    ${brain.tokens
      ? html`<p class="hint">调度大脑另外用了 ${fmtTokens(brain.tokens)} token（${brain.on ? `每天上限 ${brain.cap} 次` : '已关'}）。这笔不算进任何执行者的额度——问一句该派给谁，不该把被派的那个人的额度吃掉。</p>`
      : ''}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>反代池请求</h2><span class="meta">近 ${days} 天，来自 CLIProxyAPI</span></div>
    ${pool.requests ? html`<div class="mini-kpis">
      <div><b class="mono">${pool.requests}</b><span>请求数</span></div>
      <div><b class="mono">${Math.round((pool.failed / pool.requests) * 100)}%</b><span>失败率</span></div>
      <div><b class="mono">${pool.limited}</b><span>限流（429）</span></div>
      <div><b class="mono">${pool.other}</b><span>其他失败</span></div>
      <div><b class="mono">${pool.avgLatency === null ? '—' : `${(pool.avgLatency / 1000).toFixed(1)}s`}</b><span>平均延迟</span></div>
    </div>` : empty('这段时间没有经过反代池的请求。')}
  </section>

  <section class="grid-3">
    <div class="panel">
      <div class="panel-head"><h2>任务 · 按分类</h2></div>
      ${s.byCategory.length ? html`<div class="hbars">${s.byCategory.map((c) => html`
        <div class="hbar"><span>${catLabel(c.category)}</span>${bar((c.n / maxCat) * 100)}<span class="mono small muted">${c.n} · ${c.ok + c.bad ? pct(c.ok / (c.ok + c.bad)) : '—'}</span></div>`)}</div>
        <p class="hint">右侧：新建任务数 · 成功率</p>` : empty('这段时间没有新任务')}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>审批</h2></div>
      <div class="mini-kpis">
        <div><b class="mono">${s.approvals.total}</b><span>发起</span></div>
        <div><b class="mono">${pct(s.approvals.approvedRate)}</b><span>直接批准</span></div>
        <div><b class="mono">${s.approvals.avgWait === null ? '—' : duration(s.approvals.avgWait)}</b><span>平均等待</span></div>
      </div>
      <h3>最常触发的规则</h3>
      ${s.approvals.topRules.length ? html`<ul class="kv">${s.approvals.topRules.map((r) => html`<li><span>${r.name}</span><span class="mono muted">${r.n} 次</span></li>`)}</ul>` : empty('还没有审批')}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Token · 按项目</h2></div>
      ${s.projects.length ? html`<div class="hbars">${s.projects.map((p) => html`
        <div class="hbar"><span class="mono small ellipsis" title="${p.project}">${p.project}</span>${bar((p.t / maxProj) * 100, 'var(--ink-2)')}<span class="mono small muted">${fmtTokens(p.t)}</span></div>`)}</div>` : empty('还没有用量数据。跑一次 scripts/sync-usage.mjs 就有了。')}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>额度概览</h2><a href="/team/accounts">${tabLabel('accounts')}</a></div>
    ${accounts.length ? html`<div class="mini-kpis">
      ${accounts.slice(0, 6).map((a) => html`<div><b class="mono">${a.balance === null ? (a.window_pct === null ? '—' : `${a.window_pct}%`) : `${a.balance_estimated ? '≈ ' : ''}${a.balance}`}</b><span>${a.name}</span></div>`)}
    </div>` : empty('还没有登记账号。')}
  </section>`;
}
