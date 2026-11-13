import { ago, dayOf, fmtTokens, headerStamp, lastDays } from '../domain.ts';
import { listStaleBranches } from '../services/branches.ts';
import { listApprovals } from '../services/approvals.ts';
import { autoPaused } from '../services/dispatch.ts';
import { brainBanner } from '../services/brain.ts';
import { needsAttention } from '../services/sources.ts';
import { overviewStats } from '../services/metrics.ts';
import { getTask, listTasks } from '../services/tasks.ts';
import { cardRank, dot, execTag, needCard, runnerNotice, taskCard } from './components.ts';
import { getSetting } from '../services/dispatch.ts';
import { setupCard } from './setup.ts';
import { setupStatus, latestRunnerMeta } from '../services/setup.ts';
import { runnerExecutors, runnerOnline } from '../services/runner.ts';
import { icon, brandMark } from './layout.ts';
import { html, type Safe } from './html.ts';

function stalePanel(): Safe {
  const rows = listStaleBranches();
  if (!rows.length) return html``;
  return html`<section class="panel" data-stale-branches>
    <div class="panel-head">
      <h2>有 ${rows.length} 个分支留着没收的成果</h2>
      <span class="meta">已合并和空分支执行器会自己删；这些有提交，不敢替你决定</span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>任务</th><th>分支</th><th>领先</th><th>多久没动</th><th></th></tr></thead>
      <tbody>${rows.map((r) => html`<tr>
        <td>${r.task_id ? html`<a href="/tasks?task=${r.task_id}">${r.task_title || `T-${r.task_id}`}</a>` : html`<span class="muted">${r.note || '来历不明'}</span>`}</td>
        <td class="mono small">${r.branch}${r.note && r.task_id ? html`<span class="branch-note">${r.note}</span>` : ''}</td>
        <td>${r.ahead ? `${r.ahead} 个提交` : r.kind === 'worktree' ? '未提交改动' : r.note ? '读不出' : '—'}</td>
        <td class="meta">${r.last_commit_at ? ago(r.last_commit_at).replace('前', '') : '—'}</td>
        <td class="right">
          ${r.task_id ? html`<a class="btn small" href="/tasks?task=${r.task_id}">查看任务</a>` : ''}
          <button type="button" class="btn small" data-api-click="/api/branches/${r.id}/snooze" data-method="POST" data-done="已保留 ✓">保留</button>
          <button type="button" class="btn small danger" data-api-click="/api/branches/${r.id}/delete" data-method="POST"
            data-confirm="删除分支 ${r.branch}？这会丢掉它上面 ${r.ahead} 个提交，删了就找不回来了。">删除</button>
        </td>
      </tr>`)}</tbody>
    </table></div>
    <p class="hint">「删除」会先核对提交号：如果你点完之后这条分支上又有了新提交，执行器会拒绝并在列表里说明。</p>
  </section>`;
}

/** 040 B：额度最紧的那个执行者——窗口用得最多的，没到 100 也算紧。 */
const GROUPS = [
  { key: 'you', label: '等你拍板', tone: 'hot', empty: '没有等你的事。AI 碰到规则里的危险操作时会停在这里。' },
  { key: 'run', label: '在跑', tone: 'mid', empty: '现在没有在跑的。' },
  { key: 'queue', label: '排队', tone: 'low', empty: '没有排队的。' },
  { key: 'done', label: '今天完成', tone: 'low', empty: '今天还没有做完的。' },
] as const;
type GroupKey = (typeof GROUPS)[number]['key'];

/**
 * 044 v3：工作台是一层一层的。
 *   第一层：一句话现状 + 四行（等你拍板 / 在跑 / 排队 / 今天完成），每行一个数字和一句预览。
 *   第二层：点一行（/?g=you）进那一组的列表，顶上有「工作台 › …」可以退回。
 *   第三层：点任务，详情从右侧滑出（任务详情自己的事）。
 * 数据格、小图、额度不摆在这里：额度在侧边栏，用量在「记录」。
 */
export function overviewPage(q: URLSearchParams = new URLSearchParams()): Safe {
  const s = overviewStats();
  const pending = listApprovals({ status: 'pending', limit: 50 });
  const open = listTasks({ status: ['inbox', 'queued', 'running', 'review', 'asking', 'failed'], limit: 200 });
  const today = lastDays(1)[0];
  const doneToday = listTasks({ status: ['done'], limit: 100 }).filter((t) => t.completed_at && dayOf(t.completed_at) === today);
  const paused = autoPaused();
  const attention = needsAttention();
  const totalTasks = listTasks({ limit: 1 }).length;

  const pendingByTask = new Map<number, typeof pending>();
  for (const a of pending) if (a.task_id) pendingByTask.set(a.task_id, [...(pendingByTask.get(a.task_id) ?? []), a]);
  const pendingIds = new Set(pendingByTask.keys());
  const needsYou = (t: (typeof open)[number]) => pendingIds.has(t.id) || t.status === 'review' || t.status === 'asking' || t.status === 'failed' || (t.executor === 'me' && t.route !== 'brain');
  const byRecent = (a: (typeof open)[number], b: (typeof open)[number]) => cardRank(a, pendingIds) - cardRank(b, pendingIds) || Date.parse(b.updated_at) - Date.parse(a.updated_at);
  const cards: Record<GroupKey, typeof open> = {
    you: open.filter(needsYou).sort(byRecent),
    run: open.filter((t) => !needsYou(t) && t.status === 'running').sort(byRecent),
    queue: open.filter((t) => !needsYou(t) && (t.status === 'queued' || t.status === 'inbox')).sort(byRecent),
    done: doneToday,
  };
  // 不挂在任务上的审批（hook 发起、任务被删）也要算进「等你拍板」，否则数字对不上。
  const loose = pending.filter((a) => !a.task_id || !open.some((t) => t.id === a.task_id));
  const count = (k: GroupKey) => cards[k].length + (k === 'you' ? loose.length : 0);

  const notices = html`
  ${paused ? html`<p class="runner-line off" role="alert" data-paused>${dot('var(--warn)')}<span>自动执行已暂停：执行器不会领新任务</span><a href="/settings/security">去设置</a></p>` : ''}
  ${runnerNotice()}
  ${(() => {
    const st = setupStatus();
    if (st.dismissed || st.all_ok) return '';
    const missing = st.items.filter((i) => !i.ok && !i.optional);
    return html`<details class="setup-fold" id="setup-fold" data-setup-line>
      <summary>${dot('var(--warn)')}<span>开始使用：还差 ${missing.length} 项${missing.length ? `（${missing.map((i) => i.title).join('、')}）` : ''}</span><span class="setup-open">展开步骤</span></summary>
      ${setupCard(st)}
    </details>`;
  })()}
  ${attention ? html`<p class="runner-line off">${dot('var(--warn)')}<span>${attention} 个接入等你处理</span><a href="/settings/integrations">去看</a></p>` : ''}
  ${brainBanner() ? html`<p class="runner-line off" data-brain-banner>${dot('var(--warn)')}<span>${brainBanner()}</span><a href="/settings/security">去设置</a></p>` : ''}`;

  if (q.get('g') === 'branches') {
    return html`<div class="layer wide" data-layer="group" data-group="branches">
      <nav class="crumbs" aria-label="位置"><a href="/">工作台</a><span aria-hidden="true">›</span><strong>留着没收的分支</strong></nav>
      ${stalePanel()}
    </div>`;
  }
  const g = GROUPS.find((x) => x.key === q.get('g'));
  if (g) {
    const list = cards[g.key];
    return html`<div class="layer" data-layer="group" data-group="${g.key}">
      <nav class="crumbs" aria-label="位置"><a href="/">工作台</a><span aria-hidden="true">›</span><strong>${g.label}</strong><span class="crumb-n">${count(g.key)}</span></nav>
      ${g.key === 'you' && pending.length ? html`<div class="need-list" data-pending-panel>${pending.map((a) => needCard(a, a.task_id ? getTask(a.task_id) : undefined))}</div>` : ''}
      ${list.length ? html`<div class="task-list" data-task-grid>${list.filter((t) => !(g.key === 'you' && pendingIds.has(t.id))).map((t) => taskCard(t, { pend: pendingByTask.get(t.id), action: g.key !== 'you' }))}</div>`
        : (g.key === 'you' && pending.length ? '' : html`<p class="quiet">${g.empty}</p>`)}
    </div>`;
  }

  const peek = (k: GroupKey): string => {
    if (k === 'you' && loose.length) return loose.map((a) => a.title).slice(0, 2).join(' · ');
    const xs = cards[k];
    if (!xs.length) return GROUPS.find((x) => x.key === k)!.empty;
    return xs.slice(0, 3).map((t) => t.title).join(' · ') + (xs.length > 3 ? ' · …' : '');
  };
  const youN = count('you');
  const busyN = count('run') + count('queue');
  const sentence = youN
    ? `有 ${youN} 件事等你拍板${busyN ? `，其余 ${busyN} 件 AI 在自己干` : ''}。`
    : busyN ? `没有要你管的，${busyN} 件 AI 在自己干。` : '现在很安静。在上面写一句话派个活吧。';
  const hint = getSetting('wb_hint_closed') !== '1';

  return html`<div class="layer" data-layer="home">
  ${hint ? html`<div class="first-hint" data-first-hint>
    <span><b>这是你的 AI 工作台。</b>在上面写一句话派活；AI 干到危险操作会停下来等你点头。</span>
    <button type="button" class="link-btn" data-api-click="/api/settings/hint-closed" data-method="POST" data-no-done aria-label="不再显示这句说明">知道了</button>
  </div>` : ''}
  <div class="notices">${notices}</div>
  ${totalTasks === 0 ? firstRunPanel() : ''}
  <header class="lede-block" data-stat-strip>
    <span class="lede-date"><span class="runner-lamp ${runnerOnline() ? 'on' : ''}" role="img" aria-label="${runnerOnline() ? '执行器在线' : '执行器离线'}" title="${runnerOnline() ? '执行器在线' : '执行器离线'}" data-runner-lamp>${icon('term', 13)}</span>${headerStamp()}</span>
    <h1 class="lede-line">${sentence}</h1>
    <span class="sr-only">今日完成 ${s.doneToday}，今日 Token ${fmtTokens(s.tokensToday)}</span>
  </header>
  <section class="groups" aria-label="现在">
    ${GROUPS.map((x) => html`<a class="group-row ${x.tone}" href="/?g=${x.key}" data-group-row="${x.key}">
      <span class="group-n">${count(x.key)}</span>
      <span class="group-text"><span class="group-label">${x.label}</span><span class="group-peek">${peek(x.key)}</span></span>
      <span class="group-go" aria-hidden="true">›</span>
    </a>`)}
  </section>
  ${(() => {
    const n = listStaleBranches().length;
    return n ? html`<a class="side-row" href="/?g=branches" data-stale-row><span class="group-n">${n}</span><span>个分支留着没收的成果，留还是删你说了算</span><span class="group-go" aria-hidden="true">›</span></a>` : '';
  })()}
</div>`;
}

/**
 * 一件任务都还没有时，在最上面放一个「先试一件事」：让 AI 读一遍你的项目，告诉你它是做什么的。
 * 不改任何文件；点完就去看结果。
 */
export function firstRunPanel(): Safe {
  const projects = latestRunnerMeta().projects ?? [];
  const execs = runnerExecutors();
  const online = [...execs][0] ?? '';
  const ready = Boolean(projects.length && online);
  // 044 v3 + 品牌形象：一件活都还没有的时候，才让完整形象出场。
  // 它站在右边一列、随内容走流式布局，不压任何按钮和文字；窄屏自动收成一列。
  return html`
  <section class="panel first-run" data-first-run>
    <div class="first-run-body">
      <div class="panel-head"><h2>先试一件事</h2></div>
      <p class="lede">还什么都没跑过。下面这个不会改你的代码，只是让它读一遍、说说这项目是做什么的。</p>
      ${ready ? html`
        <p>会建一个只读任务：项目 <span class="mono">${projects[0]}</span>，执行者 ${execTag(online)}。跑完在任务详情里能看到它写的结果。</p>
        <div class="actions"><button type="button" class="btn solid" data-api-click="/api/tasks/first-run" data-method="POST" data-redirect="/tasks?task={id}">试一个：让 AI 读一遍你的项目</button></div>`
        : html`<div class="callout warn"><strong>还差一步</strong><span>执行器没连上，或者没配项目。先按「怎么开」把执行器跑起来，这里就会出现那个按钮。</span></div>`}
    </div>
    <div class="first-run-bot" aria-hidden="true">${brandMark(96)}</div>
  </section>`;
}
