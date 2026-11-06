import { navCounts } from '../services/metrics.ts';
import { autoPaused } from '../services/dispatch.ts';
import { runnerOnline } from '../services/runner.ts';
import { needsAttention } from '../services/sources.ts';
import { currentExposureNote } from '../services/exposure.ts';
import { latestRunnerMeta } from '../services/setup.ts';
import { listAccounts } from '../services/metrics.ts';
import { CATEGORIES, EXECUTORS, execLabel } from '../domain.ts';
import { html, type Safe } from './html.ts';
import { HASH_ROUTES, navItems, tabsFor, type SectionKey } from './routes.ts';

export const ICONS: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  board: 'M3 3h18v18H3z M9 3v18 M15 3v18',
  todo: 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  spark: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M5.6 5.6l2.8 2.8 M15.6 15.6l2.8 2.8 M5.6 18.4l2.8-2.8 M15.6 8.4l2.8-2.8',
  term: 'M4 17l6-6-6-6 M12 19h8',
  proxy: 'M16 3h5v5 M4 20 21 3 M21 16v5h-5 M15 15l6 6 M4 4l5 5',
  cpu: 'M4 4h16v16H4z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M20 9h3 M20 14h3 M1 9h3 M1 14h3',
  server: 'M2 2h20v8H2z M2 14h20v8H2z M6 6h.01 M6 18h.01',
  key: 'M15.5 7.5l3 3L22 7l-3-3 M21 2l-9.6 9.6 M7.5 22a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z',
  chart: 'M3 3v18h18 M7 16v-5 M12 16V8 M17 16V9',
  play: 'M6 4l14 8-14 8z',
  log: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  plug: 'M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4',
  close: 'M18 6 6 18 M6 6l12 12',
  panel: 'M3 3h18v18H3z M9 3v18',
  install: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  refresh: 'M21 12a9 9 0 1 1-3-6.7 M21 3v6h-6',
};

export const icon = (name: string, size = 18) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ''}"></path></svg>`;

/**
 * 044：顶部一句话派活。全站唯一的荧光按钮「派出去」在这里。
 * 执行者不在这里选——大脑开着交给大脑，关着用规则推荐；要选人、写说明，点「更多选项」去完整表单。
 */
function askBar(): Safe {
  const projects = latestRunnerMeta().projects ?? [];
  return html`<form class="ask" data-api="/api/tasks/quick" data-toast="已派出去" aria-label="派一个活">
    <label class="sr-only" for="wb-ask">让 AI 做什么</label>
    <input id="wb-ask" name="title" required maxlength="300" autocomplete="off" placeholder="让 AI 做什么？例：联网找 3 个同类开源项目，写成 docs/compare.md">
    ${projects.length
      ? html`<label class="ask-chip"><span class="sr-only">项目</span><select name="project" aria-label="项目">${projects.map((p, i) => html`<option value="${p}" ${i === 0 ? 'selected' : ''}>${p}</option>`)}</select></label>`
      : html`<input class="ask-chip" name="project" maxlength="120" placeholder="项目" aria-label="项目">`}
    <label class="ask-chip toggle"><input type="checkbox" name="answer_only" value="1"><span>只要回答</span></label>
    <details class="ask-more">
      <summary aria-label="更多选项：指定谁来做、分类、补充说明" title="更多选项"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></summary>
      <div class="ask-pop">
        <label class="field"><span>谁来做</span><select name="pick_executor"><option value="">让它自己挑</option>${Object.entries(EXECUTORS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
        <label class="field"><span>分类</span><select name="category">${Object.entries(CATEGORIES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <label class="field"><span>补充说明</span><textarea name="description" rows="3" placeholder="背景、验收标准、注意事项（可不填）"></textarea></label>
      </div>
    </details>
    <button class="btn accent">派出去</button>
  </form>`;
}

/** 还要多久重置：「2 小时后」「明天」这样，不写时刻。 */
function untilText(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '快重置了';
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} 分钟后重置`;
  if (h < 24) return `${Math.round(h)} 小时后重置`;
  return `${Math.round(h / 24)} 天后重置`;
}

/**
 * 044 v3：额度收在侧边栏左下角。平时只是几根细竖条；轻点弹出小卡片，每个账号一行十个小点（一格 10%）+ 百分比。
 * 只用一个色相：剩得多最亮，剩得少变淡发灰——不用红色吓人。
 */
function quotaRail(): Safe {
  // 每个账号都画成十个点（一格 10%，亮的是还剩的）：
  //   窗口额度按「还剩多少」；代金券按「剩余 / 面额」；余额只有提醒线时按「余额 / 提醒线的 5 倍」封顶。
  //   实在没有可比的上限（普通余额、没设提醒线），只给金额，不编百分比。
  const rows = listAccounts().filter((a) => a.status !== 'off').map((a) => {
    const name = `${execLabel(a.executor)}${a.slot_dir || a.kind !== 'window' ? ` · ${a.name}` : ''}`;
    if (a.kind === 'window' && a.window_pct !== null) {
      const left = Math.max(0, Math.min(100, 100 - Math.round(a.window_pct)));
      return { name, left, right: `${left}%`, note: untilText(a.window_reset_at) };
    }
    if ((a.kind === 'balance' || a.kind === 'credits') && a.balance !== null) {
      let total = 0;
      try { total = Number(JSON.parse(a.balance_detail || '{}').voucher_total) || 0; } catch { total = 0; }
      const cap = total || (a.low_threshold ? a.low_threshold * 5 : 0);
      const left = cap ? Math.max(0, Math.min(100, Math.round((a.balance / cap) * 100))) : null;
      const amount = a.kind === 'credits' ? `${a.balance} 积分` : `${a.balance_estimated ? '≈' : ''}${a.balance_unit === 'USD' ? '$' : '¥'}${a.balance.toFixed(2)}`;
      return { name, left, right: total ? `${left}%` : amount, note: total ? amount : '' };
    }
    return null;
  }).filter((r): r is { name: string; left: number | null; right: string; note: string } => r !== null)
    .sort((x, y) => (x.left ?? 101) - (y.left ?? 101));
  if (!rows.length) return html``;
  const tone = (left: number) => (left < 20 ? 'low' : left < 50 ? 'mid' : 'high');
  return html`<details class="quota" data-quota-rail>
    <summary aria-label="看额度"><span class="q-mini" aria-hidden="true">${rows.slice(0, 4).map((r) => html`<i class="${r.left === null ? 'high' : tone(r.left)}" style="height:${r.left === null ? 10 : 4 + Math.round(r.left / 10)}px"></i>`)}</span><span class="q-word">额度</span></summary>
    <div class="quota-pop" role="group" aria-label="额度">
      ${rows.map((r, i) => html`<div class="q-row">
        <div class="q-head"><span class="q-name">${r.name}</span><span class="q-pct">${r.right}</span>${r.note ? html`<span class="q-reset">${r.note}</span>` : ''}</div>
        ${r.left === null ? '' : html`<span class="q-dots" role="img" aria-label="还剩 ${r.left}%">${Array.from({ length: 10 }, (_, j) => html`<i class="${j < Math.round((r.left ?? 0) / 10) ? tone(r.left ?? 0) : ''}" style="animation-delay:${i * 40 + j * 25}ms"></i>`)}</span>`}
      </div>`)}
      <span class="q-note">一格 = 10%，亮的是还剩的</span>
    </div>
  </details>`;
}

/** 016: one nav row per top-level item; executors live inside 剧组/看板 as filters and cards. */
export function layout(opts: {
  title: string; section: SectionKey; tab?: string; body: Safe; assetVersion: string; collapsed?: boolean;
  /** 044：'light' / 'dark' = 用户手动选的；空 = 跟随系统。存在 cookie 里，服务端直接写进 <html>，不会先白后黑。 */
  theme?: '' | 'light' | 'dark';
  /** 044：页面壳左上角标题下面那一小行。 */
  sub?: string;
}): string {
  const counts = navCounts();
  const attention = needsAttention();
  const online = runnerOnline();
  const paused = autoPaused();
  const items = navItems({ pending: counts.pending, mine: counts.mine, attention, runnerOnline: online, paused });
  const collapsed = opts.collapsed === true;
  // 任务那几页没有自己的导航项，算在工作台下面。
  const navOn = opts.section === 'tasks' ? 'today' : opts.section;
  // 044 v3：设置不用分段标签，用「设置 › 接入」这样的路径；总览页什么都不摆。
  // 044 v3：不用分段标签。剧组、记录、设置的第一层就是本页；往下一层顶上是「区名 › 某类」，点区名回去。
  //（任务那几页是工作台的第二层，暂时保留它们自己的标签。）
  const tabs = opts.section === 'tasks' ? tabsFor('tasks', opts.tab ?? '', counts) : [];
  const SECTION_NAME: Record<string, string> = { team: '剧组', data: '记录', settings: '设置' };
  const first = opts.section !== 'today' && opts.section !== 'tasks' && opts.section !== 'settings' ? tabsFor(opts.section, '', counts)[0]?.key : undefined;
  const crumb = SECTION_NAME[opts.section] && opts.tab && opts.tab !== '__home' && opts.tab !== first
    ? { home: `/${opts.section}`, name: SECTION_NAME[opts.section], label: tabsFor(opts.section as 'team' | 'data' | 'settings', opts.tab, counts).find((t) => t.on)?.label ?? '' } : undefined;

  return html`<!doctype html>
<html lang="zh-CN"${opts.theme ? html` data-theme="${opts.theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · 我的工作台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%2318181B'/%3E%3Cpath d='M6 16l4-4-4-4M12 17h6' stroke='%23D7F25A' stroke-width='2.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#18181B">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<link rel="stylesheet" href="/static/style.css?v=${opts.assetVersion}">
<script src="/static/app.js?v=${opts.assetVersion}" defer></script>
</head>
<body data-hash-routes="${JSON.stringify(HASH_ROUTES)}">
<div class="app${collapsed ? ' side-collapsed' : ''}">
  <nav class="side" id="wb-side" aria-label="主导航">
    <div class="side-top">
      <a class="brand" href="/">
        <span class="brand-mark">${icon('term')}</span>
        <span class="brand-text"><strong>PrivateBot</strong><span>个人 AI 工作台</span></span>
      </a>
      <button type="button" class="side-toggle" data-side-toggle aria-controls="wb-side" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? '展开侧边栏' : '收起侧边栏'}" title="收起 / 展开（快捷键 [）">${icon('panel', 16)}</button>
    </div>
    <div class="nav">
      ${items.map((it) => html`
        <a href="${it.href}" class="nav-item ${it.key === navOn ? 'on' : ''}" title="${it.label}" ${it.key === navOn ? html`aria-current="page"` : ''}>
          ${icon(it.icon)}<span class="nav-label">${it.label}</span>
          <span class="nav-badges">
            ${it.pending ? html`<span class="nav-badge hot" aria-label="${it.pending} 件待审批">${it.pending}</span>` : ''}
            ${it.mine ? html`<span class="nav-badge" aria-label="${it.mine} 件你的待办">${it.mine}</span>` : ''}
            ${it.attention ? html`<span class="nav-badge" aria-label="${it.attention} 个接入等你处理">${it.attention}</span>` : ''}
            ${it.offlineDot ? html`<span class="nav-offline" title="执行器离线" aria-label="执行器离线"></span>` : ''}
          </span>
        </a>`)}
    </div>
    <div class="side-foot">
      ${quotaRail()}
    </div>
  </nav>
  <main class="main">
    <header class="shell-head">
      <div class="shell-title"><strong>${opts.title}</strong>${opts.sub ? html`<span>${opts.sub}</span>` : ''}</div>
      ${askBar()}
      <button type="button" class="theme-toggle" data-theme-toggle aria-pressed="${opts.theme === 'dark' ? 'true' : 'false'}" aria-label="${opts.theme === 'dark' ? '切换到浅色' : '切换到深色'}" title="切换深色 / 浅色">
        <svg class="sm" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <mask id="wb-moon"><rect x="0" y="0" width="24" height="24" fill="white"></rect><circle class="sm-bite" cx="17" cy="7" r="6.5" fill="black"></circle></mask>
          <circle class="sm-core" cx="12" cy="12" r="5" fill="currentColor" mask="url(#wb-moon)"></circle>
          <g class="sm-rays" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1.5v2.2M12 20.3v2.2M1.5 12h2.2M20.3 12h2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"></path></g>
        </svg>
        <span class="theme-manual" aria-hidden="true"></span>
      </button>
    </header>
    <div class="shell-body">
    ${currentExposureNote() ? html`<div class="callout warn" role="alert" style="margin-bottom:var(--s3)">
      <strong>注意：这次是从公网地址打开的</strong>
      <span>${currentExposureNote()}</span>
    </div>` : ''}
    ${crumb ? html`<nav class="crumbs layer-crumbs" aria-label="位置"><a href="${crumb.home}">${crumb.name}</a><span aria-hidden="true">›</span><strong>${crumb.label}</strong></nav>` : ''}
    ${tabs.length ? html`<div class="seg" role="tablist" aria-label="分段标签">
      ${tabs.map((t) => html`<a role="tab" class="seg-item ${t.on ? 'on' : ''}" href="${t.href}" ${t.on ? html`aria-selected="true"` : html`aria-selected="false"`}>${t.label}${t.count ? html`<span class="seg-count ${t.hot ? 'hot' : ''}">${t.count}</span>` : ''}</a>`)}
    </div>` : ''}
    ${opts.body}
    </div>
  </main>
</div>
<div id="toast" role="status" aria-live="polite"></div>
</body>
</html>`.value;
}
