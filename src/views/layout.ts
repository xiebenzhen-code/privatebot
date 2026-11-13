import { listAccounts, navCounts } from '../services/metrics.ts';
import { crew, waitingCount } from '../services/stream.ts';
import { runnerExecutors } from '../services/runner.ts';
import { needsAttention } from '../services/sources.ts';
import { currentExposureNote } from '../services/exposure.ts';
import { execLabel } from '../domain.ts';
import { html, type Safe } from './html.ts';
import { HASH_ROUTES, tabsFor, type SectionKey } from './routes.ts';

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
  plus: 'M12 5v14 M5 12h14',
  up: 'M12 19V5 M6 11l6-6 6 6',
  back: 'M15 6l-6 6 6 6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  panel: 'M3 3h18v18H3z M9 3v18',
  install: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  refresh: 'M21 12a9 9 0 1 1-3-6.7 M21 3v6h-6',
};

export const icon = (name: string, size = 18) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ''}"></path></svg>`;

/**
 * 044：顶部一句话派活。全站唯一的荧光按钮「派出去」在这里。
 * 执行者不在这里选——大脑开着交给大脑，关着用规则推荐；要选人、写说明，点「更多选项」去完整表单。
 */
export function askBar(): Safe {
  // 061（设计稿 11-10）：派活框只有一行。项目默认用上一次的；「@名字」指定谁来做。要选分类、写说明，去 高级 › 任务看板。
  return html`<form class="ask" data-api="/api/tasks/quick" data-toast="已派出去" aria-label="派一个活">
    <label class="sr-only" for="wb-ask">要做什么</label>
    <input id="wb-ask" name="title" required maxlength="300" autocomplete="off" placeholder="要做什么？ @ 指定谁来做">
    <button class="send" aria-label="派出去">${icon('up', 18)}</button>
    ${whoPanel()}
  </form>`;
}

/**
 * 062：谁来做、做完谁来审。点选，不靠打字；默认都交给大脑（或规则）挑。
 * 审的那位不能是干活那位——这里不拦（两排是独立的），派出去时由服务端按规则落定：点了同一位就当「不审」。
 */
function whoPanel(): Safe {
  const members = crew(runnerExecutors(), execLabel);
  if (!members.length) return html``;
  const radio = (name: string, value: string, label: string, checked = false, dashed = false) =>
    html`<label class="who-chip${dashed ? ' dashed' : ''}"><input type="radio" name="${name}" value="${value}" ${checked ? html`checked` : ''}><span>${label}</span></label>`;
  return html`<details class="ask-who" data-ask-who>
    <summary><span>谁做 · 谁审</span><span aria-hidden="true">›</span></summary>
    <fieldset class="who-row"><legend>谁来做</legend>
      ${radio('pick_executor', '', '大脑挑', true)}${members.map((m) => radio('pick_executor', m.key, m.label))}
    </fieldset>
    <fieldset class="who-row"><legend>做完谁来审</legend>
      ${radio('reviewer', 'auto', '大脑挑', true)}${members.map((m) => radio('reviewer', m.key, m.label))}${radio('reviewer', 'none', '不审', false, true)}
    </fieldset>
    <p class="who-hint">审的和干活的不是同一位。意见不过会先打回让它改，最多两轮，再到你这里；合并、推送永远是你点。</p>
  </details>`;
}

/** 061：那排头像——在线的有亮点，离线的淡；末尾「＋」；最右齿轮。只在首页那一列的最上面。 */

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
 * 044 v3 / 2026-11-12：额度。061 去掉侧栏时把它弄丢了，现在放在首页最下面那几行里。平时只是几根细竖条；轻点就地展开，每个账号一行十个小点（一格 10%）+ 百分比。
 * 只用一个色相：剩得多最亮，剩得少变淡发灰——不用红色吓人。
 */
export function quotaRail(): Safe {
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
    <summary aria-label="看额度"><span class="q-mini" aria-hidden="true">${rows.slice(0, 4).map((r) => html`<i class="${r.left === null ? 'high' : tone(r.left)}" style="height:${r.left === null ? 10 : 4 + Math.round(r.left / 10)}px"></i>`)}</span><span class="q-word">额度</span><span class="q-go" aria-hidden="true">›</span></summary>
    <div class="quota-pop" role="group" aria-label="额度">
      ${rows.map((r, i) => html`<div class="q-row">
        <div class="q-head"><span class="q-name">${r.name}</span><span class="q-pct">${r.right}</span>${r.note ? html`<span class="q-reset">${r.note}</span>` : ''}</div>
        ${r.left === null ? '' : html`<span class="q-dots" role="img" aria-label="还剩 ${r.left}%">${Array.from({ length: 10 }, (_, j) => html`<i class="${j < Math.round((r.left ?? 0) / 10) ? tone(r.left ?? 0) : ''}" style="animation-delay:${i * 40 + j * 25}ms"></i>`)}</span>`}
      </div>`)}
      <span class="q-note">一格 = 10%，亮的是还剩的</span>
    </div>
  </details>`;
}

/** 深浅色切换。061 去掉顶栏时弄丢了，现在在首页最下面。太阳⇄月亮，点一下就换，记在 cookie 里。 */
export function themeToggle(theme: '' | 'light' | 'dark' = ''): Safe {
  return html`<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="${theme === 'dark' ? 'true' : 'false'}" aria-label="${theme === 'dark' ? '切换到浅色' : '切换到深色'}" title="切换深色 / 浅色">
    <svg class="sm" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <mask id="wb-moon"><rect x="0" y="0" width="24" height="24" fill="white"></rect><circle class="sm-bite" cx="17" cy="7" r="6.5" fill="black"></circle></mask>
      <circle class="sm-core" cx="12" cy="12" r="5" fill="currentColor" mask="url(#wb-moon)"></circle>
      <g class="sm-rays" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1.5v2.2M12 20.3v2.2M1.5 12h2.2M20.3 12h2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"></path></g>
    </svg>
  </button>`;
}

/** 品牌标记：松绿底上一个 P 加一个点。2026-11-12 用户选定，替掉吉祥物。 */
export function brandMark(size = 28): Safe {
  return html`<svg class="brand-p" width="${size}" height="${size}" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#1E5B4A"></rect><path d="M34 72V28h16a14 14 0 0 1 0 28H34" fill="none" stroke="#F4F1EA" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="68" cy="68" r="7" fill="#9CCDB8"></circle></svg>`;
}

export function crewRow(): Safe {
  const members = crew(runnerExecutors(), execLabel);
  const attention = needsAttention();
  return html`<div class="crew-bar">
    <nav class="crew-row" aria-label="执行者" data-crew-row>
      ${members.slice(0, 6).map((m) => html`<a class="crew-face ${m.online ? 'on' : ''}${m.resting ? ' rest' : ''}" href="/?crew=${m.key}" title="${m.label}${m.resting ? '，歇着' : m.online ? '，在线' : '，离线'}" aria-label="${m.label}${m.resting ? '，歇着' : m.online ? '，在线' : '，离线'}" data-crew="${m.key}">${m.mark}${m.online ? html`<i class="crew-dot" aria-hidden="true"></i>` : m.resting ? '' : html`<i class="crew-dot off" aria-hidden="true"></i>`}</a>`)}
      ${members.length > 6 ? html`<a class="crew-face more" href="/?crew=add" aria-label="还有 ${members.length - 6} 位执行者">+${members.length - 6}</a>` : ''}
      <a class="crew-face add" href="/?crew=add" aria-label="请执行者进来" title="请执行者进来" data-crew-add>${icon('plus', 16)}</a>
    </nav>
    <a class="gear" href="/settings" aria-label="${attention ? `设置，${attention} 个接入等你处理` : '设置'}" title="设置" data-gear>${icon('gear', 22)}${attention ? html`<i class="gear-dot" aria-hidden="true"></i>` : ''}</a>
  </div>`;
}





/** 016: one nav row per top-level item; executors live inside 剧组/看板 as filters and cards. */
export function layout(opts: {
  title: string; section: SectionKey; tab?: string; body: Safe; assetVersion: string; collapsed?: boolean;
  /** 044：'light' / 'dark' = 用户手动选的；空 = 跟随系统。存在 cookie 里，服务端直接写进 <html>，不会先白后黑。 */
  theme?: '' | 'light' | 'dark';
  /** 044：页面壳左上角标题下面那一小行。 */
  sub?: string;
}): string {
  const attention = needsAttention();
  // 044 v3：设置不用分段标签，用「设置 › 接入」这样的路径；总览页什么都不摆。
  // 044 v3：不用分段标签。剧组、记录、设置的第一层就是本页；往下一层顶上是「区名 › 某类」，点区名回去。
  //（任务那几页是工作台的第二层，暂时保留它们自己的标签。）
  const counts = navCounts();
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
<title>${waitingCount() ? `(${waitingCount()}) ` : ''}${opts.title} · 我的工作台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' rx='22' fill='%231E5B4A'/%3E%3Cpath d='M34 72V28h16a14 14 0 0 1 0 28H34' fill='none' stroke='%23F4F1EA' stroke-width='10' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='68' cy='68' r='7' fill='%239CCDB8'/%3E%3C/svg%3E">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1E5B4A">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<link rel="stylesheet" href="/static/style.css?v=${opts.assetVersion}">
<script src="/static/app.js?v=${opts.assetVersion}" defer></script>
</head>
<body data-hash-routes="${JSON.stringify(HASH_ROUTES)}">
<div class="app shell-top">
  <main class="main">
    <div class="shell-body">
    ${currentExposureNote() ? html`<div class="callout warn" role="alert" style="margin-bottom:var(--s3)">
      <strong>注意：这次是从公网地址打开的</strong>
      <span>${currentExposureNote()}</span>
    </div>` : ''}
    ${opts.section !== 'today' ? html`<nav class="crumbs layer-crumbs" aria-label="位置"><a href="/">工作台</a><span aria-hidden="true">›</span>${crumb ? html`<a href="${crumb.home}">${crumb.name}</a><span aria-hidden="true">›</span><strong>${crumb.label}</strong>` : html`<strong>${opts.title}</strong>`}</nav>` : ''}
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
