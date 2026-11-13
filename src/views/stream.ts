// 061.1：首页就是一条流。从上到下：警告条（平时没有）→ 等你 → 在做 → 做好了 →「这周做完 N 件 ›」→「高级 ›」。
// 一行一件事；点一行，详情从侧边滑出来（就是原来的任务详情，/?task=）。亮的只有「等你」那一组。
import { ago, execLabel } from '../domain.ts';
import { autoPaused } from '../services/dispatch.ts';
import { setupStatus } from '../services/setup.ts';
import { listTasks } from '../services/tasks.ts';
import { askTitle, stream, type StreamItem } from '../services/stream.ts';
import { dot, runnerNotice } from './components.ts';
import { setupCard } from './setup.ts';
import { html, type Safe } from './html.ts';
import { firstRunPanel } from './overview.ts';
import { askBar, crewRow, quotaRail, themeToggle } from './layout.ts';
import { packButtons } from './packs.ts';
import type { Task } from '../services/tasks.ts';
import { threadPanel } from './thread.ts';

/** 「等你」最多亮这么几件；再多就折起来——满屏都亮，就等于没有亮。 */
const LIT = 3;

const MARK: Record<StreamItem['kind'], string> = {
  approve: '✓', ask: '?', failed: '✕', review: '◎', start: '▸', mine: '○', running: '↻', queued: '…', done: '✓',
};

let openKey = '';
function row(it: StreamItem, tone: 'hot' | 'mid' | 'low'): Safe {
  const who = it.who ? execLabel(it.who) : '';
  // 设计稿 11-10：等你的行，大字是「要你做什么」（存进内容库？/ 没成，选个办法），小字才是哪件事、谁做的。
  const ask = tone === 'hot' ? (it.kind === 'approve' && it.approvals?.[0] && it.task ? askTitle(it.approvals[0]) : it.why) : '';
  const title = ask && it.task ? ask : it.title;
  const sub = tone === 'low' ? '' : ask && it.task ? [it.title, who].filter(Boolean).join(' · ') : [it.why, who].filter(Boolean).join(' · ');
  return html`<a class="flow-row ${tone}${it.key === openKey ? ' open' : ''}" href="${it.href}" data-flow-row="${it.key}" data-kind="${it.kind}"${it.key === openKey ? html` aria-current="true"` : ''}>
    <span class="flow-mark" aria-hidden="true">${MARK[it.kind]}</span>
    <span class="flow-text"><span class="flow-title">${title}</span>${sub ? html`<span class="flow-sub">${sub}</span>` : ''}</span>
    ${tone === 'low' ? html`<span class="flow-when">${ago(it.at)}</span>` : html`<span class="flow-go" aria-hidden="true">›</span>`}
  </a>`;
}

function group(key: string, label: string, n: number | null, body: Safe): Safe {
  return html`<section class="flow-group" data-flow-group="${key}" aria-label="${label}">
    <h2 class="flow-head">${label}${n !== null ? html`<span class="flow-n"> · ${n}</span>` : ''}</h2>
    ${body}
  </section>`;
}

/** 平时没有。只说三件事：自动执行被停了、执行器没开、还没装好。对公网暴露的警告在外壳里，每页都有、折不掉。 */
function warnings(): Safe {
  const st = setupStatus();
  const missing = st.items.filter((i) => !i.ok && !i.optional);
  return html`
    ${autoPaused() ? html`<p class="runner-line off" role="alert" data-paused>${dot('var(--warn)')}<span>自动执行已暂停：执行器不会领新任务</span><a href="/settings/security">去设置</a></p>` : ''}
    ${runnerNotice()}
    ${!st.dismissed && !st.all_ok ? html`<details class="setup-fold" id="setup-fold" data-setup-line>
      <summary>${dot('var(--warn)')}<span>开始使用：还差 ${missing.length} 项</span><span class="setup-open">展开步骤</span></summary>
      ${setupCard(st)}
    </details>` : ''}`;
}

export function streamPage(now: number = Date.now(), open?: Task, side?: Safe | null, theme: '' | 'light' | 'dark' = ''): Safe {
  const s = stream(now);
  openKey = open ? `t${open.id}` : '';
  const empty = !s.waiting.length && !s.doing.length && !s.mine.length && !s.done.length;
  const lit = s.waiting.slice(0, LIT);
  const rest = s.waiting.slice(LIT);
  // 061（设计稿 11-10）：电脑上左边是流、右边是点开的那件事；手机上点开就盖上来。
  return html`<div class="home${open || side ? ' has-thread' : ''}" data-layer="home"><div class="stream" data-flow>
    <h1 class="sr-only">工作台</h1>
    ${crewRow()}
    <div class="stream-ask">${askBar()}</div>
    ${packButtons()}
    <div class="notices">${warnings()}</div>
    ${empty && listTasks({ limit: 1 }).length === 0 ? firstRunPanel() : ''}
    ${s.waiting.length ? group('waiting', '等你', s.waiting.length, html`<div class="flow-list">
      ${lit.map((it) => row(it, 'hot'))}
      ${rest.length ? html`<details class="flow-more" data-flow-more><summary class="flow-row hot-ghost"><span class="flow-text"><span class="flow-title">还有 ${rest.length} 件</span></span><span class="flow-go" aria-hidden="true">›</span></summary>
        <div class="flow-list">${rest.map((it) => row(it, 'hot'))}</div></details>` : ''}
    </div>`) : ''}
    ${s.doing.length || s.mine.length ? group('doing', '在做', s.doing.length, html`<div class="flow-list">
      ${s.doing.map((it) => row(it, 'mid'))}
      ${s.mine.length ? html`<details class="flow-more" data-flow-mine><summary class="flow-row mid"><span class="flow-mark" aria-hidden="true">○</span><span class="flow-text"><span class="flow-title">你的待办 · ${s.mine.length}</span></span><span class="flow-go" aria-hidden="true">›</span></summary>
        <div class="flow-list">${s.mine.map((it) => row(it, 'mid'))}</div></details>` : ''}
    </div>`) : ''}
    ${s.done.length ? group('done', '做好了', null, html`<div class="flow-list">${s.done.map((it) => row(it, 'low'))}</div>`) : ''}
    ${!s.waiting.length && !s.doing.length && !s.mine.length && !empty ? html`<p class="quiet" data-flow-quiet>没有要你管的事。</p>` : ''}
    <nav class="flow-foot" aria-label="更多">
      <a href="/data" data-flow-week><span>这周做完 ${s.weekDone} 件</span><span aria-hidden="true">›</span></a>
      ${quotaRail()}
      <a href="/advanced" data-flow-advanced><span>高级</span><span aria-hidden="true">›</span></a>
    </nav>
    <div class="flow-tools">${themeToggle(theme)}</div>
  </div>${open ? threadPanel(open) : side ?? ''}</div>`;
}

/** 061.1：「高级」——原来的页面都住在这里，地址一个都没变。061.5 会把它挪进齿轮里。 */
export function advancedPage(): Safe {
  const rows: [string, string, string][] = [
    ['/?view=classic', '原来的首页', '四行：等你拍板 / 在跑 / 排队 / 今天完成'],
    ['/tasks', '任务看板', '全部任务、审批、我的待办、已完成'],
    ['/team', '剧组', '执行者、账号槽'],
    ['/data', '记录', '用量、审计、机器'],
    ['/media', '自媒体', '实验'],
    ['/advanced/packs', '包', '行业的常用活、模板、插件'],
    ['/?g=branches', '留着没收的分支', ''],
    ['/settings', '设置', ''],
  ];
  return html`<div class="layer" data-layer="advanced">
    <nav class="crumbs" aria-label="位置"><a href="/">工作台</a><span aria-hidden="true">›</span><strong>高级</strong></nav>
    <div class="flow-list" data-advanced>
      ${rows.map(([href, label, sub]) => html`<a class="flow-row low" href="${href}"><span class="flow-text"><span class="flow-title">${label}</span>${sub ? html`<span class="flow-sub">${sub}</span>` : ''}</span><span class="flow-go" aria-hidden="true">›</span></a>`)}
    </div>
  </div>`;
}
