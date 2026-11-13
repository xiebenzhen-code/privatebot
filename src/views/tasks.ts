import { BOARD_COLUMNS, CATEGORIES, EXECUTORS, STATUSES, ago, catLabel, duration, execColor, execLabel, fmtDateTime, fmtTime, fmtTokens, truncate } from '../domain.ts';
import { RUN_OUTCOMES, listRuns, type Run } from '../services/runs.ts';
import { listEvents } from '../services/core.ts';
import { openAskOf, type AskCard } from '../services/asks.ts';
import { listApprovals } from '../services/approvals.ts';
import { countTasks, getTask, listTasks, siblingRuns, type Task } from '../services/tasks.ts';
import { approvalCard, defaultExecutor, dot, empty, execOptions, executorState, execTag, panelHead, runnerNotice, stageBar, stageDots, statusBadge, taskCard } from './components.ts';
import { listExecutorSettings } from '../services/dispatch.ts';
import { brainState } from '../services/brain.ts';
import { listRequests as listProjectRequests } from '../services/projects.ts';
import { listProjectNotes, suggestionsOfTask } from '../services/notes.ts';
import { runnerExecutors, listTaskLog, queueBlocker } from '../services/runner.ts';
import { RUNNER_CMD, latestRunnerMeta } from '../services/setup.ts';
import { backendLabel, backendSwitchNote, stageDef, stageOf, stuckFor } from '../services/stage.ts';
import { redactText } from '../services/sources.ts';
import { searchTerms, snippetOf } from '../services/search.ts';
import { href, html, type Safe } from './html.ts';
import { renderMarkdown } from './markdown.ts';
import { icon } from './layout.ts';
import { tabLabel } from './routes.ts';

export type TaskTab = 'board' | 'review' | 'mine' | 'done';

const DONE_PAGE = 20;
const OPEN_STATUSES = ['inbox', 'queued', 'running', 'review', 'asking'];

export function tasksPage(q: URLSearchParams, tab: TaskTab): { body: Safe; tab: TaskTab } {
  const inner = tab === 'review' ? inbox(q) : tab === 'done' ? doneList(q) : tab === 'mine' ? mineList(q) : board(q);
  return { body: html`${runnerNotice()}${inner}`, tab };
}

/** 057.2：任务那几页是「工作台 › 看板」的第二层，顶上先说自己在哪，跟设置、剧组那边一样。 */
function crumbs(tab: TaskTab): Safe {
  return html`<nav class="crumbs" aria-label="位置"><a href="/">工作台</a><span aria-hidden="true">›</span><strong>${tabLabel(tab)}</strong></nav>`;
}

function board(q: URLSearchParams): Safe {
  const category = q.get('category') ?? '';
  const executor = q.get('executor') ?? '';
  const all = listTasks({ category: category || undefined, executor: executor || undefined });
  const pending = listApprovals({ status: 'pending', limit: 200 });
  const pendingByTask = new Map<number, typeof pending>();
  for (const a of pending) if (a.task_id) pendingByTask.set(a.task_id, [...(pendingByTask.get(a.task_id) ?? []), a]);

  const selectedId = Number(q.get('task')) || 0;
  const selected = selectedId ? getTask(selectedId) : undefined;
  const drawerOpen = !!q.get('new') || !!selected;

  const chip = (label: string, key: string, value: string, current: string) => html`
    <a class="pill ${current === value ? 'on' : ''}" href="${href('/tasks', q, { [key]: value || null, task: null, new: null })}">${label}</a>`;

  const columns = BOARD_COLUMNS.filter((c) => c.key !== 'done');
  const running = all.filter((t) => t.status === 'running').length;
  const queued = all.filter((t) => t.status === 'queued').length;
  const body = html`
  ${crumbs('board')}
  <header class="page-head">
    <div class="lede-block">
      <span class="lede-date">${all.length} 个任务${pending.length ? ` · ${pending.length} 件待审批` : ''}</span>
      <h1 class="lede-line">${pending.length
        ? `有 ${pending.length} 件事等你拍板。`
        : running + queued ? `${running + queued} 件在跑或在排队，没有要你管的。` : '现在没有在跑的任务。'}</h1>
    </div>
    <div class="head-actions"><a class="btn primary" href="${href('/tasks', q, { new: 1, task: null })}">${icon('board', 16)}新建任务</a></div>
  </header>

  <div class="filters">
    <div class="filter-row"><span class="filter-label">${dot('var(--accent-ink)')}执行者</span>
      ${chip('全部', 'executor', '', executor)}
      ${Object.entries(EXECUTORS).filter(([k]) => k !== 'me').map(([k, v]) => chip(v.label, 'executor', k, executor))}
    </div>
    <div class="filter-row"><span class="filter-label">${dot('var(--info)')}分类</span>
      ${chip('全部', 'category', '', category)}
      ${Object.entries(CATEGORIES).map(([k, v]) => chip(v, 'category', k, category))}
    </div>
  </div>

  <div class="board-scroll">
    <div class="board">
      ${columns.map((col) => {
        const items = all.filter((t) => col.statuses.includes(t.status));
        return html`<section class="column" aria-label="${col.label}">
          <div class="column-head"><span>${dot(STATUSES[col.statuses[0]].color)}${col.label}</span><span class="mono muted">${items.length}</span></div>
          ${items.length ? items.map((t) => taskCard(t, {
            href: href('/tasks', q, { task: t.id, new: null }),
            on: t.id === selected?.id,
            pend: pendingByTask.get(t.id),
          })) : html`<div class="column-empty">空</div>`}
        </section>`;
      })}
    </div>
  </div>
  <p class="hint">做完的任务在 <a href="/tasks/done">已完成</a> 里，可以翻页。</p>
  ${q.get('newproject') ? projectDrawer(q) : ''}
  ${drawerOpen ? drawer(q, selected, '/tasks') : ''}`;
  return body;
}

/**
 * 030：新建项目的抽屉。工作台只能记请求——真正建文件夹的是执行器，所以这里写完就等它。
 * 没配 projectsRoot 时不装作能建，直接说要先设一个根目录（也不让网页写路径）。
 */
function projectDrawer(q: URLSearchParams): Safe {
  const meta = latestRunnerMeta();
  const ready = Boolean(meta.projectsRoot);
  const rows = listProjectRequests(5);
  const statusText: Record<string, string> = {
    pending: '等执行器来领（它不在线就挂着，上线后自动创建）',
    running: '执行器正在建，几秒后下拉里就有',
    done: '建好了，项目下拉里已经能选',
    failed: '没建成',
  };
  return html`
    <a class="scrim" href="${href('/tasks', q, { newproject: null })}" aria-label="关闭"></a>
    <aside class="drawer" aria-label="新建项目">
      <a class="drawer-close" href="${href('/tasks', q, { newproject: null })}" aria-label="关闭">${icon('close', 18)}</a>
      <h2 class="drawer-title">新建项目</h2>
      ${ready ? html`
        <form class="form" data-api="/api/projects" data-redirect="/tasks?newproject=1">
          <label class="field"><span>项目名<span class="label-req">必填</span></span>
            <input name="name" required maxlength="40" pattern="[a-z0-9][a-z0-9_\\-]{0,39}"
              placeholder="小写字母、数字、- 和 _，例如 demo-feed" autocomplete="off">
            <span class="hint">会在执行器的项目根目录下建一个同名文件夹，不接受路径和中文。</span>
          </label>
          <label class="field"><span>一句话说明<span class="label-opt">可选</span></span>
            <input name="note" maxlength="200" placeholder="这个项目是干什么的（会写进 CLAUDE.md）">
          </label>
          <p class="hint">建好后执行器会做：建文件夹 → git init -b main → 写 .gitignore 和 CLAUDE.md → 第一次提交。
            工作台不碰你的磁盘，也不会去 GitHub 建仓库。</p>
          <div class="actions"><button class="btn primary">建</button></div>
        </form>`
      : html`<div class="callout warn"><strong>执行器还没配项目根目录</strong>
          <span>新建项目只能在执行器那台电脑上做，需要先给它一个专门放项目的文件夹（不要放进已有仓库里）：</span>
          <pre class="mono small">npm run setup --projects-root D:/ai-projects</pre>
          <span class="small muted">配好后执行器会自己重启，这个按钮就能用了。</span>
        </div>`}
      ${rows.length ? html`<div class="section"><h3>最近的请求</h3>
        <ul class="timeline">${rows.map((r) => html`<li>
          <span class="mono muted">${fmtTime(r.updated_at)}</span>
          <span>${r.name} · ${statusText[r.status] ?? r.status}${r.message ? html` · <span class="small muted">${r.message}</span>` : ''}</span>
        </li>`)}</ul></div>` : ''}
    </aside>`;
}

/**
 * 044 v3：任务详情在哪一页都能从右侧滑出。工作台、剧组、记录的地址带上 ?task=12 就是「这一页 + 详情开着」，
 * 刷新、书签、后退都照旧；点卡片时 app.js 只取回这一块插进来，页面本身不动。
 */
export function taskPanel(q: URLSearchParams, base: string): Safe {
  const id = Number(q.get('task')) || 0;
  const t = id ? getTask(id) : undefined;
  return t ? drawer(q, t, base) : html``;
}

function drawer(q: URLSearchParams, selected: Task | undefined, base: string): Safe {
  return html`
    <a class="scrim" href="${href(base, q, { task: null, new: null })}" aria-label="关闭详情"></a>
    <aside class="drawer" aria-label="任务详情">
      <a class="drawer-close" href="${href(base, q, { task: null, new: null })}" aria-label="关闭">${icon('close', 18)}</a>
      ${selected && !q.get('new') ? detail(selected, listApprovals({ status: 'pending', task_id: selected.id })) : newTaskForm(q, q.get('executor') ?? '')}
    </aside>`;
}

/**
 * 036 D：同一个任务交给不同编码工具跑，用时和 token 摆在一起看。不做自动评分。
 * 配对规则在 siblingRuns（标题 + 项目），这里只负责显示。
 */
function compareBlock(t: Task): Safe {
  const others = siblingRuns(t);
  if (!others.length) return html``;
  const runs = [t, ...others];
  /** 一次运行的时长：跑完的按开始到完成算，在跑的按到现在算。 */
  const spent = (r: Task) => {
    const from = r.started_at ? Date.parse(r.started_at) : 0;
    const to = r.completed_at ? Date.parse(r.completed_at) : r.status === 'running' ? Date.parse(r.updated_at) : 0;
    if (!from || !to || to < from) return '—';
    const sec = Math.round((to - from) / 1000);
    if (sec < 90) return `${Math.max(1, sec)} 秒`;
    const min = Math.round(sec / 60);
    return min < 90 ? `${min} 分钟` : `${(min / 60).toFixed(1)} 小时`;
  };
  return html`
    <div class="section" data-compare>
      <h3>对比 · 同一个任务跑了 ${runs.length} 次</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>执行者</th><th>后端</th><th>用时</th><th>token</th><th>状态</th></tr></thead>
        <tbody>${runs.map((r) => html`<tr>
          <td>${execTag(r.executor)}${r.id === t.id
            ? html` <span class="meta">本条</span>`
            : html` <a class="meta" href="/tasks?task=${r.id}">T-${r.id}</a>`}</td>
          <td>${r.backend ? backendLabel(r.backend) : '—'}</td>
          <td class="mono">${spent(r)}</td>
          <td class="mono">${r.tokens_used ? fmtTokens(r.tokens_used) : '—'}</td>
          <td>${statusBadge(r.status)}</td>
        </tr>`)}</tbody>
      </table></div>
      <div class="grid-2">${runs.map((r) => html`<div class="panel">
        <div class="panel-head"><h2>${execTag(r.executor)}</h2><span class="meta">T-${r.id} · ${spent(r)} · ${r.tokens_used ? fmtTokens(r.tokens_used) : '没有记 token'}</span></div>
        <p class="small">${r.result_text ? truncate(r.result_text, 400) : '这条没有留下结果。'}</p>
      </div>`)}</div>
      <p class="hint">费用没折算成金额：任务只记了总 token，没拆输入和输出，硬乘单价会算错。模型单价在「账号与额度」页。</p>
    </div>`;
}

/** 我的待办: tasks whose executor is you. */
function mineList(q: URLSearchParams): Safe {
  const open = listTasks({ executor: 'me', status: OPEN_STATUSES, limit: 200 });
  const recent = listTasks({ executor: 'me', status: ['done', 'failed'], limit: 10 });
  const selected = Number(q.get('task')) ? getTask(Number(q.get('task'))) : undefined;
  return html`
  ${crumbs('mine')}
  <header class="page-head">
    <div class="lede-block">
      <span class="lede-date">${open.length} 件等你亲手做</span>
      <h1 class="lede-line">${open.length ? '勾掉就算完成，点标题看详情。' : '现在没有要你亲手做的事。'}</h1>
    </div>
    <div class="head-actions"><a class="btn primary" href="/tasks?new=1&executor=me">${icon('board', 16)}新建给我</a></div>
  </header>
  <section class="panel">
    ${panelHead('还没做的', `${open.length} 件`)}
    ${open.length ? html`<ul class="todo">${open.map((t) => html`
      <li>
        <input type="checkbox" id="todo-${t.id}" data-api-toggle="/api/tasks/${t.id}" data-field="status" data-on="done" data-off="inbox" aria-label="完成「${t.title}」">
        <label for="todo-${t.id}"><span>${t.title}</span><span class="meta">${catLabel(t.category)}${t.project ? ` · ${t.project}` : ''}${t.step ? ` · ${t.step}` : ''}</span></label>
        ${statusBadge(t.status)}
        <a class="meta" href="/tasks/mine?task=${t.id}">详情</a>
      </li>`)}</ul>` : empty('没有需要你亲自做的事。')}
  </section>
  ${recent.length ? html`<section class="panel">
    <div class="panel-head"><h2>最近做完的</h2><a href="/tasks/done?executor=me">全部</a></div>
    ${recent.map((t) => row(t, '/tasks/done', new URLSearchParams({ executor: 'me' })))}
  </section>` : ''}
  ${selected ? drawer(q, selected, '/tasks/mine') : ''}`;
}

/** 已完成: what used to be the twelfth-card column, now with pages.
 *  031b：这里也是唯一能搜的地方——标题、说明、结果文本（含失败的），多个词要全部命中。 */
function doneList(q: URLSearchParams): Safe {
  const executor = q.get('executor') ?? '';
  const raw = (q.get('q') ?? '').trim();
  const terms = searchTerms(raw);
  const searching = terms.length > 0;
  const page = Math.max(1, Number(q.get('page')) || 1);
  const filter = { executor: executor || undefined, status: ['done', 'failed'], q: searching ? raw : undefined };
  const total = countTasks(filter);
  const pages = Math.max(1, Math.ceil(total / DONE_PAGE));
  const current = Math.min(page, pages);
  const rows = listTasks({ ...filter, limit: DONE_PAGE, offset: (current - 1) * DONE_PAGE });
  const selected = Number(q.get('task')) ? getTask(Number(q.get('task'))) : undefined;
  return html`
  ${crumbs('done')}
  <header class="page-head">
    <div class="lede-block">
      <span class="lede-date">${searching ? `找到 ${total} 件` : `${total} 件完成或失败`}</span>
      <h1 class="lede-line">${searching ? `「${raw}」的结果都在下面。` : '做完和失败的活都记在这里，新的在上面。'}</h1>
    </div>
    <div class="head-actions">
      <a class="pill ${executor ? '' : 'on'}" href="${href('/tasks/done', q, { executor: null, page: null })}">全部</a>
      ${Object.entries(EXECUTORS).map(([k, v]) => html`<a class="pill ${executor === k ? 'on' : ''}" href="${href('/tasks/done', q, { executor: k, page: null })}">${v.label}</a>`)}
    </div>
  </header>
  <section class="panel">
    ${searchForm(raw, executor, searching, q)}
    ${rows.length ? html`<div class="rows">${rows.map((t) => row(t, '/tasks/done', q, terms))}</div>`
      : searching ? searchEmpty(raw) : empty('还没有完成的任务。')}
    ${pages > 1 ? html`<div class="pager">
      ${current > 1 ? html`<a class="btn small" href="${href('/tasks/done', q, { page: current - 1 })}">上一页</a>` : ''}
      <span class="meta">第 ${current} / ${pages} 页</span>
      ${current < pages ? html`<a class="btn small" href="${href('/tasks/done', q, { page: current + 1 })}">下一页</a>` : ''}
    </div>` : ''}
  </section>
  ${selected ? drawer(q, selected, '/tasks/done') : ''}`;
}

/** 031b：搜索词只走 URL，不写审计也不写日志——「我搜了什么」不是审计事件。 */
function searchForm(raw: string, executor: string, searching: boolean, q: URLSearchParams): Safe {
  return html`<form class="search-form" method="get" action="/tasks/done" role="search">
    ${executor ? html`<input type="hidden" name="executor" value="${executor}">` : ''}
    <input type="search" name="q" value="${raw}" maxlength="200" autocomplete="off"
      placeholder="搜标题、说明、结果（多个词用空格隔开）" aria-label="搜索已完成的任务">
    <button class="btn small">搜索</button>
    ${searching ? html`<a class="btn small" href="${href('/tasks/done', q, { q: null, page: null })}">清空</a>` : ''}
    ${searching ? html`<span class="meta search-note">「${raw}」· 每个词都要命中</span>` : ''}
  </form>`;
}

function searchEmpty(raw: string): Safe {
  return html`<div class="empty" data-search-empty>
    <strong>没有找到「${raw}」</strong>
    <span>换个词试试。只搜标题、说明和结果文字，不搜代码。</span>
  </div>`;
}

/** 片段优先取结果（那是任务的成果），其次说明，最后才是标题。 */
function snippetFor(t: Task, terms: string[]): Safe | null {
  for (const field of [t.result_text, t.description, t.title, t.material]) {
    const pieces = field ? snippetOf(field, terms) : null;
    if (pieces) {
      return html`${pieces.map((p) => (p.hit ? html`<mark>${p.text}</mark>` : p.text))}`;
    }
  }
  return null;
}

function row(t: Task, base: string, q: URLSearchParams, terms: string[] = []): Safe {
  const snippet = terms.length ? snippetFor(t, terms) : null;
  return html`<a class="row" href="${href(base, q, { task: t.id })}">
    <span class="row-main"><span class="row-title">${t.title}</span>
      ${snippet ? html`<span class="row-snippet">${snippet}</span>` : ''}
      <span class="meta">T-${t.id}${t.project ? ` · ${t.project}` : ''} · ${catLabel(t.category)}${t.result_text ? ' · 有结果' : ''}</span></span>
    ${execTag(t.executor)}
    ${statusBadge(t.status)}
    <span class="meta mono">${fmtDateTime(t.updated_at)}</span>
  </a>`;
}

function inbox(q: URLSearchParams): Safe {
  const pending = listApprovals({ status: 'pending', limit: 200 });
  const decided = listApprovals({ limit: 40 }).filter((a) => a.status !== 'pending').slice(0, 10);
  const focus = Number(q.get('approval')) || 0;
  return html`
  ${crumbs('review')}
  <header class="page-head">
    <div class="lede-block">
      <span class="lede-date">${pending.length} 件待审批</span>
      <h1 class="lede-line">${pending.length ? '点开一件，看清它要动什么再决定。' : '收件箱是空的，没有等你决定的事。'}</h1>
    </div>
    <div class="head-actions"><a class="btn" href="/settings/security">调整审批规则</a></div>
  </header>
  <section class="inbox">
    ${pending.length ? pending.map((a, i) => {
      const t = a.task_id ? getTask(a.task_id) : undefined;
      return html`<div class="inbox-item ${focus === a.id ? 'focus' : ''}" id="a-${a.id}">
        ${t ? html`<a class="inbox-task" href="/tasks?task=${t.id}">T-${t.id} · ${t.title}</a>` : ''}
        ${approvalCard(a, t, { full: true, accent: i === 0 })}
      </div>`;
    }) : empty('收件箱是空的，没有等你决定的事。')}
  </section>
  ${decided.length ? html`<section class="panel"><div class="panel-head"><h2>最近处理过的</h2><a href="/data/audit">审计日志</a></div>
    ${decided.map((a) => approvalCard(a, a.task_id ? getTask(a.task_id) : undefined))}</section>` : ''}`;
}

/** 008: what the executor is doing, and the two buttons the user needs. */
function runnerBlock(t: Task): Safe {
  const canStart = t.mode === 'manual' && !t.start_requested && (t.status === 'queued' || t.status === 'inbox');
  const bits = [
    t.mode === 'auto' ? '自动执行' : '手动开始',
    t.runner_id ? `执行器 ${t.runner_id}` : '',
    // 017: a run that fell back to another model reads as a different task otherwise.
    t.backend ? `后端 ${t.backend}` : '',
    t.branch ? `分支 ${t.branch}` : '',
    t.tokens_used ? `已用 ${fmtTokens(t.tokens_used)} token` : '',
  ].filter(Boolean);
  return html`<div class="section">
    <h3>执行器</h3>
    <p class="small muted">${bits.join(' · ')}</p>
    <div class="actions">
      ${canStart ? html`<button type="button" class="btn small solid" data-api-click="/api/tasks/${t.id}/start" data-method="POST" data-done="已开始 ✓">开始</button>` : ''}
      ${t.status === 'running' ? html`<button type="button" class="btn small danger" data-api-click="/api/tasks/${t.id}/stop" data-method="POST" data-confirm="终止 T-${t.id}？" data-done="已终止 ✓">终止</button>` : ''}
      ${t.status === 'failed' && t.retry === 'merge' && t.branch
        ? html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/retry-merge" data-method="POST" data-no-done>重试合并</button>` : ''}
      ${t.retry === 'push'
        ? html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/retry-push" data-method="POST" data-no-done>重试推送</button>` : ''}
      ${t.status === 'failed' && t.retry !== 'merge'
        ? html`<button type="button" class="btn small" data-api-click="/api/tasks/${t.id}/restart" data-method="POST" data-confirm="重新排队跑一遍 T-${t.id}？" data-no-done>重新开始</button>` : ''}
      ${t.start_requested ? html`<span class="meta">已请求开始，等执行器领取</span>` : ''}
    </div>
    ${t.runner_log ? html`<pre class="runner-log mono small">${t.runner_log}</pre>` : ''}
  </div>`;
}

/** 028: 红框该写什么。三档退让：专门的失败原因 → 执行器最后报的步骤 → 干脆说「没告诉我」。 */
export function failReasonOf(t: Task): string {
  return t.fail_reason || t.step || `执行器没有告诉我原因，请看执行器窗口里 T-${t.id} 的最后几行。`;
}

/** 024.1：每个执行者当前「会不会真的开跑」，下拉里直接标出来。 */
function executorStates(): Record<string, string> {
  const runners = runnerExecutors();
  const settings = new Map(listExecutorSettings().map((s) => [s.executor, { enabled: s.enabled !== 0 && s.enabled !== false }]));
  const out: Record<string, string> = {};
  for (const k of Object.keys(EXECUTORS)) out[k] = executorState(k, { runners, settings });
  return out;
}

/** 025：「项目」别再是一个容易漏的输入框——执行器报过项目名就给下拉，没报过才退回输入框。
 *  026：派给机器时它必填，派给自己时可以空着，标签上直接写清楚。 */
function projectField(current: string, states: Record<string, string>, executor: string): Safe {
  const known = latestRunnerMeta().projects ?? [];
  const mark = executor === 'me'
    ? html`<span class="label-opt">选「我」时不用填</span>`
    : html`<span class="label-req">必填</span>`;
  if (!known.length) {
    return html`<label class="field"><span>项目（要让 AI 改哪个仓库）${mark}</span>
      <input name="project" maxlength="120" value="${current}" placeholder="和执行器配置里 projects 的名字一致">
      <span class="hint">还没检测到执行器的项目名（执行器没连上或没配项目）。先运行 <code>npm run setup</code>，或看今天页的「开始使用」清单。</span>
    </label>`;
  }
  const isOther = !!current && !known.includes(current);
  const picked = current || (known.length === 1 ? known[0] : '__other');
  return html`<label class="field"><span>项目（要让 AI 改哪个仓库）${mark}</span>
    <select name="project" data-project-pick>
      ${known.map((p) => html`<option value="${p}" ${picked === p ? 'selected' : ''}>${p}</option>`)}
      <option value="__other" ${picked === '__other' ? 'selected' : ''}>其他（自己填）</option>
    </select>
  </label>
  <label class="field" data-project-other ${picked === '__other' ? '' : 'hidden'}><span>项目名</span>
    <input name="project_custom" maxlength="120" value="${isOther ? current : ''}" placeholder="和执行器配置里 projects 的名字一致" ${picked === '__other' ? '' : 'disabled'}>
  </label>`;
}

function newTaskForm(q: URLSearchParams, executor: string): Safe {
  const states = executorStates();
  const picked = executor || defaultExecutor(states);
  const online = Object.values(states).includes('online');
  const execAndCat = html`
    <div class="field-row">
      <label class="field"><span>执行者<span class="label-req">必填</span></span><select name="executor">${execOptions(picked, states, { brain: brainState().on })}</select></label>
      <label class="field"><span>分类</span><select name="category">${Object.entries(CATEGORIES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
    </div>`;
  return html`
    <h2 class="drawer-title">新建任务</h2>
    <form class="form" data-api="/api/tasks" data-redirect="/tasks?task={id}">
      <div class="form-group">
        <span class="subhead">① 做什么</span>
        <label class="field"><span>标题<span class="label-req">必填</span></span><input name="title" required maxlength="300" placeholder="例如：给 RSS 抓取加去重与重试"></label>
        <label class="field"><span>说明<span class="label-opt">可选</span></span><textarea name="description" rows="4" placeholder="背景、验收标准、注意事项"></textarea></label>
        <p class="hint">没勾的任务跑完必须改出文件，否则不算完成。</p>
      </div>

      <div class="form-group">
        <span class="subhead">② 谁来做</span>
        ${execAndCat}
        ${projectField('', states, picked)}
        <p class="hint"><a href="${href('/tasks', q, { newproject: 1, new: null })}">＋ 新建项目</a>（在执行器那台电脑上建文件夹和 git 仓库）</p>
        <p class="hint" data-suggest-hint hidden></p>
        ${online
          ? html`<div class="callout info"><span>标着<span class="mark">「在线」</span>的才会真的开跑；「没有执行器在跑」的派过去只会一直排队。</span></div>`
          : html`<div class="callout warn"><strong>现在没有执行器在线</strong><span>派给 Agent 的任务会一直停在排队。先启动执行器（<code>${RUNNER_CMD}</code>），或者这一单派给「我」。</span></div>`}
      </div>

      <div class="form-group">
        <span class="subhead">③ 关联</span>
        <label class="field"><span>会话链接<span class="label-opt">可选</span></span><input name="session_url" type="url" placeholder="https://claude.ai/code/…"></label>
        <p class="hint">选「我」会进入你的待办，不用选项目；选 Agent 会进入排队，没选项目创建不了。</p>
      </div>

      <div class="actions">${q.get('new') ? html`<a class="btn" href="${href('/tasks', q, { new: null })}">取消</a>` : ''}<button class="btn primary">创建</button></div>
    </form>`;
}

export function detail(t: Task, pend: ReturnType<typeof listApprovals>): Safe {
  const history = listApprovals({ task_id: t.id, limit: 20 }).filter((a) => a.status !== 'pending');
  // 040 D：审计记录就是这个任务自己的事件，最近 20 条；完整记录还在 /data/audit。
  const audit = listEvents({ task_id: t.id, limit: 20 });
  const taskLog = listTaskLog(t.id);
  const stage = stageOf(t, pend.map((a) => a.tool_name ?? ''));
  const stuck = stuckFor(t);
  const blocked = queueBlocker(t);
  const switched = backendSwitchNote(t.id);
  return html`
    <div class="drawer-top">${statusBadge(t.status)}<span class="mono muted">T-${t.id}</span></div>
    <h2 class="drawer-title">${t.title}</h2>
    ${t.route === 'brain'
      ? html`<p class="card-brain block" data-brain>${t.routed_at
        ? html`${icon('spark', 14)}大脑派给 ${execLabel(t.executor)}${t.difficulty ? ` · 难度 ${t.difficulty}/5` : ''}${t.route_reason ? `：${t.route_reason}` : ''} <span class="muted">（${fmtDateTime(t.routed_at)}）</span>`
        : '等大脑派单：执行器空闲时会问一次模型，在合格名单里挑一个。'}</p>`
      : ''}
    <p class="detail-stage">${stageDots(stage, { noChanges: Boolean(t.no_changes) })}<span>${stageDef(stage).label}</span></p>
    ${fold('◔ 全部阶段', stageBar(stage, { noChanges: Boolean(t.no_changes) }))}
    ${pend.length ? html`<div class="detail-ask" data-detail-ask>${pend.map((a) => approvalCard(a, t, { full: true }))}</div>` : ''}
    ${t.status === 'asking' ? askBlock(t) : ''}
    ${blocked ? html`<div class="callout warn" data-queue-blocker>
      <strong>排队中，但还不会开始</strong>
      <span>${blocked.text}</span>
    </div>` : ''}
    ${t.status === 'failed' ? html`<div class="callout danger" role="alert" data-fail-reason>
      <strong>失败原因</strong>
      <span>${failReasonOf(t)}</span>
      ${!t.fail_reason && t.step ? html`<span class="small muted">这是执行器最后报的「当前步骤」，不是专门的失败原因。</span>` : ''}
    </div>` : ''}
    ${t.result_text ? html`<details class="fold section" id="fold-result" data-result>
      <summary title="模型最后写的那段话（不含命令和文件内容）">✓ 结果</summary>
      ${renderMarkdown(t.result_text)}
    </details>` : ''}
    ${compareBlock(t)}
    ${/* 040 D：四节按「结果 → 过程 → 项目备忘 → 审计记录」排；过程留在结果下面，因为它解释结果。 */''}
    ${taskLog.length ? html`<details class="fold section" data-process><summary>过程（${taskLog.length} 步）</summary>
      <ul class="timeline">${taskLog.map((l) => html`<li><span class="mono muted" title="${fmtDateTime(l.ts)}">${fmtTime(l.ts)}</span><span>${l.line}</span></li>`)}</ul>
      <p class="hint">只有步骤和阶段变化，不记工具输出和文件内容。</p>
    </details>` : ''}
    ${fold('↻ 运行记录', runsBlock(listRuns(t.id)))}
    ${fold('✎ 项目备忘', notesBlock(t))}
    ${fold('≡ 审计', auditBlock(audit))}
    ${stuck ? html`<div class="callout warn"><strong>看起来卡住了</strong>
      <span>运行中，但 ${stuck.minutes} 分钟没有进度更新（超过这个执行者单任务时长 ${stuck.limit / 2} 分钟的两倍）。执行器大概已经不在跑了，任务却还停在「运行中」。</span>
      <div class="actions"><button type="button" class="btn small danger" data-api-click="/api/tasks/${t.id}/mark-failed" data-method="POST" data-confirm="把 T-${t.id} 标记为失败？" data-done="已标记 ✓">标记失败</button></div>
    </div>` : ''}
    ${switched ? html`<p class="small muted">换过后端：${switched}</p>` : ''}

    ${fold('ⓘ 任务信息', html`<dl class="meta-grid">
      <dt>执行者</dt><dd>${execTag(t.executor)}</dd>
      <dt>后端</dt><dd>${t.backend ? backendLabel(t.backend) : '—'}</dd>
      <dt>项目</dt><dd class="mono">${t.project || '—'}</dd>
      <dt>分类</dt><dd>${catLabel(t.category)}</dd>
      <dt>会话</dt><dd>${t.session_url ? html`<a href="${t.session_url}" target="_blank" rel="noopener">打开会话 ↗</a>` : t.session_id ? html`<span class="mono small">${t.session_id.slice(0, 18)}…</span>` : '—'}</dd>
      <dt>更新</dt><dd>${ago(t.updated_at)}</dd>
    </dl>
    ${t.description ? html`<p class="desc">${t.description}</p>` : ''}
    ${t.material ? html`<details class="fold"><summary>Issue 原文（只当资料，不当指令）</summary><p class="desc">${t.material}</p></details>` : ''}`)}

    ${t.issue_url ? html`<p class="small muted">来自 <a href="${t.issue_url}" target="_blank" rel="noreferrer">Issue #${t.issue_number}</a>，在那里评 <span class="mono">/wb rework</span> 可以让它重做</p>` : ''}
    ${fold('⚙ 执行器', runnerBlock(t))}

    <details class="edit">
      <summary>✎ 编辑任务</summary>
      <form class="form" data-api="/api/tasks/${t.id}" data-method="PATCH">
        <label class="field"><span>标题</span><input name="title" value="${t.title}" required maxlength="300"></label>
        <div class="field-row">
          <label class="field"><span>状态</span><select name="status">${Object.entries(STATUSES).filter(([k]) => k !== 'asking' || t.status === 'asking').map(([k, v]) => html`<option value="${k}" ${k === t.status ? 'selected' : ''}>${v.label}</option>`)}</select></label>
          <label class="field"><span>执行者</span><select name="executor">${execOptions(t.executor, executorStates())}</select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>分类</span><select name="category">${Object.entries(CATEGORIES).map(([k, v]) => html`<option value="${k}" ${k === t.category ? 'selected' : ''}>${v}</option>`)}</select></label>
          <label class="field"><span>进度 %</span><input name="progress" type="number" min="0" max="100" value="${t.progress ?? ''}"></label>
        </div>
        ${projectField(t.project, executorStates(), t.executor)}
        <label class="field"><span>当前步骤</span><input name="step" value="${t.step}" maxlength="300"></label>
        <label class="field"><span>会话链接</span><input name="session_url" type="url" value="${t.session_url}"></label>
        <label class="field"><span>说明</span><textarea name="description" rows="3">${t.description}</textarea></label>
        <div class="actions">
          <button type="button" class="btn danger" data-api-click="/api/tasks/${t.id}" data-method="DELETE" data-confirm="删除 T-${t.id}？审批记录会保留。" data-redirect="/tasks">删除</button>
          <button class="btn primary">保存</button>
        </div>
      </form>
    </details>

    ${history.length ? html`<div class="section"><h3>审批记录</h3>${history.map((a) => approvalCard(a, t))}</div>` : ''}
  `;
}

/**
 * 055.2 · 提问卡片：agent 停下来问你，卡片就挂在详情最上面。
 * 一层一层：问题一句话 → 选项是小按钮，点一下就答完 → 都不合适，下面一行自己写，回车发送。
 * 卡片上的字全是资料——html`` 自动转义，不渲染 Markdown、不出链接；回答只会原样回给 agent，不会变成别的操作。
 * 一个问题：点选项直接发；多个问题：每个问题选一个（或自己写），最后一起发。
 */
export function askBlock(t: Task): Safe {
  const ask = openAskOf(t.id);
  if (!ask) {
    return html`<div class="callout warn" data-ask-missing>
      <strong>在等你选，但提问卡不见了</strong>
      <span>在「编辑任务」里把状态改回排队，或者用「重新开始」。</span>
    </div>`;
  }
  const api = `/api/tasks/${t.id}/answer`;
  const attrs = html`data-api="${api}" data-method="POST" data-toast="已回答，接着干"`;
  const hidden = html`<input type="hidden" name="ask_id" value="${ask.id}">`;
  const head = (c: AskCard): Safe => {
    const title = c.title || truncate(c.text.split('\n')[0], 60);
    const body = c.title ? c.text : (c.text.length > title.length ? c.text : '');
    return html`<p class="qa-title"><span class="qa-mark" aria-hidden="true">?</span>${title}</p>${body ? html`<p class="qa-text">${body}</p>` : ''}`;
  };
  if (ask.cards.length === 1) {
    const c = ask.cards[0];
    return html`<section class="qa" data-ask="${ask.id}" aria-label="等你选">
      ${head(c)}
      ${c.options.length ? html`<form class="qa-opts" ${attrs}>${hidden}${c.options.map((o) => html`<button class="qa-opt" name="${`a:${c.key}`}" value="${o}">${o}</button>`)}</form>` : ''}
      <form class="qa-write" ${attrs}>${hidden}
        <input name="${`t:${c.key}`}" placeholder="✎ ${c.options.length ? '或者自己写' : '写下你的回答'}" aria-label="自己写回答" maxlength="1000" autocomplete="off" ${c.options.length ? '' : 'required'}>
        <button class="qa-send" aria-label="发送" title="发送">↵</button>
      </form>
    </section>`;
  }
  return html`<section class="qa" data-ask="${ask.id}" aria-label="等你选">
    <form class="qa-multi" ${attrs}>${hidden}
      ${ask.cards.map((c) => html`<div class="qa-card">
        ${head(c)}
        ${c.options.length ? html`<div class="qa-opts">${c.options.map((o) => html`<label class="qa-opt"><input type="radio" name="${`a:${c.key}`}" value="${o}"><span>${o}</span></label>`)}</div>` : ''}
        <input class="qa-line" name="${`t:${c.key}`}" placeholder="✎ ${c.options.length ? '或者自己写' : '写下你的回答'}" aria-label="${`自己写：${c.title || c.key}`}" maxlength="1000" autocomplete="off">
      </div>`)}
      <div class="qa-foot"><button class="qa-send" aria-label="一起发送" title="一起发送">↵</button></div>
    </form>
  </section>`;
}

/**
 * 045：这个任务跑过几次、每次谁、用哪个账号、结局。只有一次就折起来——大多数任务一次就完，
 * 没必要在详情里占一块；跑过两次以上默认展开，因为那正是你想看的。好看的版本在 044 第二段。
 */
function runsBlock(rows: Run[]): Safe {
  if (!rows.length) return '';
  const tone = (o: string) => (o === 'failed' ? 'danger-text' : o === 'limited' ? 'warn-text' : '');
  return html`<details class="fold section" data-runs ${rows.length > 1 ? 'open' : ''}>
    <summary>运行记录（${rows.length} 次）</summary>
    <ul class="timeline">${rows.map((r) => html`<li>
      <span class="mono muted" title="${fmtDateTime(r.started_at)}">#${r.attempt}</span>
      <span>${execLabel(r.executor)}${r.model ? html` · <span class="mono">${r.model}</span>` : ''}${r.slot ? html` · 账号 <span class="mono">${r.slot}</span>` : ''}${r.sandbox === 'docker' ? html` · <span class="run-sbx" title="在一次性沙箱容器里跑的" data-run-sandbox="docker">▣ 沙箱</span>` : html` · <span class="muted small" title="直接在执行器那台电脑上跑的，没有沙箱" data-run-sandbox="none">宿主</span>`}
        · <span class="${tone(r.outcome)}">${RUN_OUTCOMES[r.outcome] ?? r.outcome}</span>${r.ended_at ? ` · ${duration(Date.parse(r.ended_at) - Date.parse(r.started_at))}` : ''}${r.tokens ? ` · ${fmtTokens(r.tokens)}` : ''}${r.backfilled ? html` <span class="muted small">（升级前的记录，信息不全）</span>` : ''}
        ${r.reason && r.outcome !== 'done' ? html`<br><span class="small muted">${redactText(r.reason)}</span>` : ''}</span>
    </li>`)}</ul>
  </details>`;
}

/** 040 D：谁、什么时候、做了什么。`me` / `system` 写成中文，执行者用注册表里的名字。 */
const auditActor = (a: string): string => (a === 'me' ? '你' : a === 'system' ? '系统' : execLabel(a));

function auditBlock(rows: ReturnType<typeof listEvents>): Safe {
  return html`<div class="section" data-audit>
    <h3>审计记录</h3>
    ${rows.length ? html`<ul class="timeline audit-list">${rows.map((e) => html`<li>
      <span class="mono muted" title="${fmtDateTime(e.ts)}">${fmtTime(e.ts)}</span>
      <span class="audit-actor">${auditActor(e.actor)}</span>
      <span>${redactText(e.text)}</span>
    </li>`)}</ul>` : empty('这个任务还没有记录。')}
    <p class="hint">最近 ${rows.length} 条${rows.length >= 20 ? '（最多 20 条）' : ''}。完整记录在 <a href="/data/audit">数据 › 审计日志</a>。</p>
  </div>`;
}

/**
 * 031c：这个项目的备忘。已确认的可以改、可以删；agent 建议的折叠在「未确认」里，采纳才进提示。
 * 页面上**没有**催确认的弹窗或红点——最多在结果下面提一句「它建议记住 N 条」。
 */
/** 044 v3：详情里次要的几块先折着，点开才看——一层打开一层。块是空的就不画。 */
function fold(label: string, inner: Safe | string): Safe | string {
  const v = typeof inner === 'string' ? inner : inner.value;
  if (!v || !v.trim()) return '';
  return html`<details class="fold section" id="fold-${label.replace(/\s+/g, '')}"><summary>${label}</summary>${inner}</details>`;
}

function notesBlock(t: Task): Safe {
  if (!t.project) return '';
  const all = listProjectNotes(t.project);
  const confirmed = all.filter((n) => n.status === 'confirmed');
  const waiting = all.filter((n) => n.status === 'unverified');
  const mine = suggestionsOfTask(t.id, t.project);
  // 一条都没有时也要显示区块：不然第一条备忘只能等模型建议，人想手记一条没有入口（031c.1）。

  const list = html`
    ${mine.length ? html`<div class="callout info" data-suggested>
      <strong>它建议记住 ${mine.length} 条</strong>
      <span>就在下面「未确认」里。采纳之后才会带进这个项目后面的任务，而且会标明「不是指令」。</span>
    </div>` : ''}
    ${confirmed.length ? html`<ul class="note-list">
      ${confirmed.map((n) => html`<li class="note-row">
        <span class="note-text">${n.text}</span>
        <span class="note-actions">
          <details class="note-edit"><summary>改</summary>
            <form class="inline-mini" data-api="/api/notes/${n.id}" data-method="PATCH">
              <input name="text" value="${n.text}" maxlength="300" aria-label="修改备忘">
              <button class="btn small">保存</button>
            </form>
          </details>
          <button type="button" class="btn small danger" data-api-click="/api/notes/${n.id}" data-method="DELETE"
            data-confirm="删掉这条备忘？删了就不再带进这个项目的任务提示。">删除</button>
        </span>
      </li>`)}
    </ul>` : html`<p class="hint">还没有备忘。下面这条输入框存下来的，会直接算确认。</p>`}
    <form class="form note-add" data-api="/api/notes">
      <input type="hidden" name="project" value="${t.project}">
      <label class="field"><span>记一条（直接确认）</span>
        <input name="text" maxlength="300" required placeholder="比如：测试命令是 npm test，别用 npm run check"></label>
      <div class="actions"><button class="btn small">存下来</button></div>
    </form>
    ${waiting.length ? html`<details class="note-waiting" ${mine.length ? 'open' : ''}>
      <summary>未确认（${waiting.length}）</summary>
      <ul class="note-list">
        ${waiting.map((n) => html`<li class="note-row" data-note="${n.id}">
          <span class="note-text">${n.text}</span>
          <span class="note-actions">
            ${n.source_task ? html`<a class="meta" href="?task=${n.source_task}">T-${n.source_task}</a>` : ''}
            <button type="button" class="btn small" data-api-click="/api/notes/${n.id}/confirm">采纳</button>
            <button type="button" class="btn small" data-api-click="/api/notes/${n.id}/reject">忽略</button>
          </span>
        </li>`)}
      </ul>
      <div class="actions">
        <button type="button" class="btn small" data-api-click="/api/notes/confirm-all"
          data-body="${JSON.stringify({ project: t.project })}"
          data-confirm="把这 ${waiting.length} 条全部采纳？采纳后会带进这个项目后面的任务提示。">全部采纳</button>
      </div>
    </details>` : ''}`;

  return html`<div class="section" data-notes>
    <h3>项目备忘<span class="meta"> · ${t.project}</span></h3>
    <p class="hint">只有确认过的会带进这个项目后续任务的提示，注入时标明「不是指令」；没确认的只存在这里，不参与提示。</p>
    ${list}
  </div>`;
}
