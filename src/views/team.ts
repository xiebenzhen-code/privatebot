import { CATEGORIES, EXECUTORS, ago, execColor, execLabel, fmtTokens, lastDays, sectionLabel } from '../domain.ts';
import { listApprovals } from '../services/approvals.ts';
import { capabilities, executorModels, type Capability } from '../services/capability.ts';
import { listExecutorSettings } from '../services/dispatch.ts';
import { ACCOUNT_KINDS, ACCOUNT_STATUSES, listAccounts, tokensByExecutorSince, type Account } from '../services/metrics.ts';
import { listRunners, runnerExecutors, runnerOnline } from '../services/runner.ts';
import { listSlots, SLOT_EXECUTORS, type SlotView } from '../services/runs.ts';
import { scorecard, summaryLine } from '../services/scorecard.ts';
import { listTasks, type Task } from '../services/tasks.ts';
import { avatar, bar, cardRank, dot, empty, execHead, execOptions, handoffNotice, quotaMeter, staleNotice, tag, taskCard, type ExecState } from './components.ts';
import { html, type Safe } from './html.ts';
import { icon } from './layout.ts';
import { tabLabel } from './routes.ts';

export type TeamTab = 'executors' | 'accounts';

/** 044：只能在自己应用里用的执行者（ZCode、AutoClaw）——单独一组「你手动用」。 */
const MANUAL = new Set(['zcode', 'autoclaw']);

export function teamPage(q: URLSearchParams, tab: TeamTab): Safe {
  return tab === 'accounts' ? accountsPanel() : executorsPanel(q);
}

/**
 * 040 C：一个执行者一个区。
 *
 * 收起时只有一行——谁、什么状态、额度、在跑几个，一眼扫完；
 * 展开是左边管理（账号 / 上限 / 战绩）、右边任务。以前是一屏卡片网格，
 * 想知道「后期组手上有哪些活」得跳到任务页再筛一遍。
 */
/**
 * 053「擅长」：能力档案（先验 + 战绩混合）换成五个点，一类一排。
 * 点数 = 混合值 × 5 四舍五入（0.8 → 4 点，0.6 → 3 点）——不放大，先验就是先验。
 * 悬停说清楚是先验、混合还是实战。读不出模型、没有任何一类有值，整块不出现。
 */
export function skillDots(caps: Capability[]): Safe | '' {
  const rows = Object.keys(CATEGORIES).map((cat) => caps.find((c) => c.category === cat)).filter((c): c is Capability => !!c && c.blended !== null);
  if (!rows.length) return '';
  return html`<div class="exec-block exec-skills" data-exec-skills>
    <span class="sub-cap">擅长</span>
    <div class="skills">${rows.map((c) => {
      const n = Math.max(0, Math.min(5, Math.round((c.blended ?? 0) * 5)));
      const tip = `${CATEGORIES[c.category] ?? c.category} · ${c.label} 约 ${Math.round((c.blended ?? 0) * 100)}%${c.n ? `（近 90 天 ${c.n} 单）` : ''}`;
      return html`<span class="skill ${c.label === '先验' ? 'prior' : ''}" title="${tip}" aria-label="${tip}" data-skill="${c.category}" data-dots="${n}"><b>${CATEGORIES[c.category] ?? c.category}</b><span class="pips">${[1, 2, 3, 4, 5].map((i) => html`<i class="${i <= n ? 'on' : ''}"></i>`)}</span></span>`;
    })}</div>
  </div>`;
}

function executorsPanel(q: URLSearchParams): Safe {
  const settings = new Map(listExecutorSettings().map((s) => [s.executor, s]));
  // 读注册表本身，不写死列表：新加一个执行者不用改这里。
  const agentKeys = Object.keys(EXECUTORS).filter((k) => k !== 'me')
    .sort((a, b) => (settings.get(a)?.priority ?? 99) - (settings.get(b)?.priority ?? 99));
  // 040 C：「我」也是一个区，管理块只放待办数量。
  const keys = ['me', ...agentKeys];
  const accounts = listAccounts();
  const today = tokensByExecutorSince(lastDays(1)[0]);
  const todayKey = lastDays(1)[0];
  const openTasks = listTasks({ status: ['inbox', 'queued', 'running', 'review', 'asking'], limit: 500 });
  const recentTasks = listTasks({ status: ['done', 'failed'], limit: 300 });
  const pending = listApprovals({ status: 'pending', limit: 200 });
  const pendingIds = new Set(pending.map((a) => a.task_id).filter((x): x is number => typeof x === 'number'));
  const pendingByTask = new Map<number, typeof pending>();
  for (const a of pending) if (a.task_id) pendingByTask.set(a.task_id, [...(pendingByTask.get(a.task_id) ?? []), a]);
  const online = runnerOnline();
  const serving = runnerExecutors(); // 024.1：只有心跳里声明了这个执行者的才算在线
  const open = q.get('exec') ?? '';
  const current = open && keys.includes(open) ? open : '';
  const cur = current && current !== 'me' ? settings.get(current) : undefined;
  // 028.1: 让「跑的是哪一版」一眼可见，别等到出了问题才去翻日志。
  const liveHash = listRunners().find((r) => r.online && r.code_hash)?.code_hash ?? '';
  // 041: 一行战绩。口径在 scorecard.ts 里钉死，页面只负责显示。
  const score = scorecard({ days: 30 });
  const scoreOf = new Map(score.by_executor.map((c) => [c.executor, c]));
  /**
   * 042：大脑派的和手选的各一行。两列摆在一起才看得出大脑准不准——
   * 只看总成功率，分不清「活简单」和「派得对」。少样本照样不给百分比。
   */
  const splitOf = (k: string): string => {
    const one = (route: 'brain' | 'hand', name: string) => {
      const c = score.by_route.find((r) => r.executor === k && r.route === route);
      if (!c) return '';
      if (c.sample === 'few') return `${name} ${c.n} 单（样本太少）`;
      return `${name} ${c.n} 单 · 一次过 ${Math.round(c.first_pass_rate * 100)}%`;
    };
    return [one('brain', '大脑派'), one('hand', '手选')].filter(Boolean).join(' ｜ ');
  };

  const stateOf = (k: string): ExecState => {
    if (k === 'me') return 'me';
    if ((settings.get(k)?.enabled ?? 1) === 0) return 'dispatch';
    return serving.has(k) ? 'online' : 'offline';
  };
  /** 在办的任务：等你拍板的排最前，我的待办排最后——和今天页同一个 cardRank。 */
  const openOf = (k: string) => openTasks.filter((t) => t.executor === k)
    .sort((a, b) => cardRank(a, pendingIds) - cardRank(b, pendingIds));
  /** 接手过的任务也算原来那个人，所以先看 first_executor。 */
  const recentOf = (k: string) => recentTasks
    .filter((t) => (t.first_executor ?? t.executor) === k).slice(0, 5);
  /** 额度紧了：窗口快满，或者余额已经低于自己设的提醒线。 */
  const tightQuota = (accs: Account[]) => accs.some((a) => (a.window_pct ?? 0) >= 80
    || (a.low_threshold !== null && a.balance !== null && a.balance <= a.low_threshold));

  // 040 C：有在跑、有待审批、或额度紧了才默认展开；其余收起，一屏能扫完。
  const shouldOpen = (k: string) => {
    const mine = openOf(k);
    if (mine.some((t) => t.status === 'running')) return true;
    if (mine.some((t) => t.status === 'review' || t.status === 'asking' || pendingIds.has(t.id))) return true;
    return tightQuota(accounts.filter((a) => a.executor === k));
  };

  /**
   * 045：账号槽。执行器真正登录的那个目录，工作台只记名字、到期日和优先级，不存任何凭据。
   *
   * 只有 claude 和 workbuddy（codebuddy）能开槽——它们的身份就是一个配置目录
   * （`CLAUDE_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR`），一个目录一个登录态。
   * dsh 的身份是 API 密钥，反代池的账号轮换在 CLIProxyAPI 那边，都不在这里开，
   * 摆一句话说明为什么置灰，别让人以为坏了。
   *
   * 摆成独立一块、横跨两列，不进 `data-manage`：040 规则 5 要管理块只显示数值、不摆输入框，
   * 这里的表单塞进去就破了它。也不套 `<details>`：040 的切块函数按「第一个 </details> 就是结尾」
   * 认一个区，嵌套会让它把区截短。
   */
  const slotBlock = (k: string): Safe => {
    if (k === 'me') return '';
    const slots = listSlots(k);
    const canOpen = SLOT_EXECUTORS.has(k);
    return html`<div class="exec-block exec-slots" data-slots>
      <h3>账号槽${canOpen && slots.length ? html`<span class="meta">${slots.length} 个</span>` : ''}</h3>
      ${canOpen
        ? html`${slots.length
            ? slotRows(slots)
            : html`<p class="hint">还没有账号槽。执行器先用默认目录跑。</p>`}
          ${slots.length ? html`<p class="hint">有的厂商不允许一个人同时用多个账号，请自己确认条款。</p>` : ''}
          ${addSlotForm(k)}`
        : html`<p class="hint">${slotWhy(k)}</p>${slots.length ? slotRows(slots, false) : ''}`}
    </div>`;
  };

  /** 管理块：只显示数值，不摆输入框（040 规则 5）。改数值走「改设置」。 */
  const manageBlock = (k: string): Safe => {
    const s = settings.get(k);
    const accs = accounts.filter((a) => a.executor === k);
    const mine = openOf(k);
    if (k === 'me') {
      const doneToday = recentTasks.filter((t) => t.status === 'done'
        && (t.first_executor ?? t.executor) === 'me' && (t.completed_at ?? '').slice(0, 10) === todayKey).length;
      return html`<div class="exec-block" data-manage>
        <h3>管理</h3>
        <dl class="meta-grid">
          <dt>我的待办</dt><dd>${mine.length} 件</dd>
          <dt>今日完成</dt><dd>${doneToday} 件</dd>
        </dl>
        <p class="hint">自己的事不占额度，也不用派单。勾完成就在右边的卡片上。</p>
      </div>`;
    }
    return html`<div class="exec-block" data-manage>
      <h3>管理</h3>
      <div class="exec-accounts">
        ${accs.length
          ? accs.map((a) => html`<span class="chip">${a.name} · ${budgetText(a)}</span>`)
          : html`<span class="meta">还没登记账号</span>`}
      </div>
      <dl class="meta-grid">
        <dt>每日 token</dt><dd>${s?.daily_token_cap ? fmtTokens(s.daily_token_cap) : '不限'}</dd>
        <dt>单任务</dt><dd>${s?.max_minutes ? `${s.max_minutes} 分钟` : '不限'}</dd>
        <dt>同时跑</dt><dd>${s?.max_concurrent ?? '不限'}</dd>
        <dt>怎么跑</dt><dd>${s?.auto_allowed ? '自动跑' : '手动派'}</dd>
        <dt>能否领取</dt><dd>${!s ? '—' : !s.enabled ? '停用了' : s.claimable ? '可以' : '只派单'}</dd>
        <dt>战绩</dt><dd class="score-line">${summaryLine(scoreOf.get(k), 30)}</dd>
        ${splitOf(k) ? html`<dt>按谁派的</dt><dd class="score-line">${splitOf(k)}</dd>` : ''}
      </dl>
      <a class="btn small" href="/team?exec=${k}">改设置</a>
    </div>`;
  };

  /** 任务块（044 v3）：只放手上的活，用缩小版任务卡；做完的去「记录」看。 */
  // 053：每个执行者最近用的框架 + 模型 → 能力档案里那几类的分数。读不出来就整块不显示，不影响剧组页。
  let allCaps: Capability[] = [];
  let modelOf = new Map<string, { harness: string; model: string }>();
  try { allCaps = capabilities().items; modelOf = executorModels(); } catch { /* 先验文件坏了也别拖垮这一页 */ }
  const skillsBlock = (k: string): Safe | '' => {
    const m = modelOf.get(k);
    return m ? skillDots(allCaps.filter((c) => c.harness === m.harness && c.model === m.model)) : '';
  };

  const taskBlock = (k: string): Safe => {
    const mine = openOf(k);
    const doneN = recentOf(k).length;
    return html`<div class="exec-block exec-tasks" data-exec-tasks>
      <span class="sub-cap">手上的活${mine.length ? ` · ${mine.length}` : ''}</span>
      ${mine.length ? html`<div class="task-list">${mine.map((t) => taskCard(t, { hideExec: true, mini: true, pend: pendingByTask.get(t.id) }))}</div>` : html`<p class="quiet">手上没活。</p>`}
      <a class="more-link" href="/tasks?executor=${k}">它的全部任务${doneN ? `（含最近做完的 ${doneN} 件）` : ''} ›</a>
    </div>`;
  };

  return html`
  <div class="layer wide" data-layer="crew">
  <header class="lede-block">
    <span class="lede-date">${keys.length} 个执行者${online ? ' · 执行器在线' : ' · 执行器离线'}${liveHash ? ` · 代码 ${liveHash}` : ''}</span>
    <h1 class="lede-line">谁在帮你干活</h1>
    <span class="lede-sub">点一个，看它手上的活、账号槽和额度。</span>
  </header>

  ${handoffNotice() ?? ''}
  ${staleNotice() ?? ''}

  ${[['auto', '自动干活', keys.filter((k) => !MANUAL.has(k))], ['manual', '你手动用', keys.filter((k) => MANUAL.has(k))]].map(([gk, glabel, list]) => (list as string[]).length ? html`
  <section class="crew-group" data-crew-group="${gk as string}">
    <h2 class="crew-group-title">${glabel as string}${gk === 'manual' ? html`<span>只能在它们自己的应用里用，这里只派单、记额度</span>` : ''}</h2>
    <div class="exec-sections">
    ${(list as string[]).map((key) => {
      const accs = accounts.filter((a) => a.executor === key);
      const mine = openOf(key);
      const running = mine.filter((t) => t.status === 'running').length;
      const queued = mine.filter((t) => t.status === 'queued').length;
      const waiting = mine.filter((t) => t.status === 'review' || t.status === 'asking' || pendingByTask.has(t.id)).length;
      const st = stateOf(key);
      // 053.1：符号代替文字——▶ 在跑、‖ 排队、! 等你；悬停和读屏仍有完整说法。
      const sym = [running ? html`<span class="sym" title="在跑 ${running}" aria-label="在跑 ${running}">▶ ${running}</span>` : '', queued ? html`<span class="sym" title="排队 ${queued}" aria-label="排队 ${queued}">‖ ${queued}</span>` : '', waiting ? html`<span class="sym hot" title="等你 ${waiting}" aria-label="等你 ${waiting}">! ${waiting}</span>` : ''].filter(Boolean);
      const line = sym.length ? html`${sym}` : (st === 'offline' ? '离线' : st === 'dispatch' ? '只派单' : '空闲');
      return html`<details class="exec-section" id="exec-${key}" data-exec="${key}" ${shouldOpen(key) ? html`open` : ''}>
        <summary class="exec-section-sum">
          ${avatar(key, 'md')}
          <span class="crew-text"><span class="crew-name">${execLabel(key)}</span><span class="crew-line">${line}</span></span>
          <span hidden>${execHead(key, { kind: st, running, queued })}</span>
          ${key !== 'me' && accs.some((a) => a.window_pct !== null || a.balance !== null) ? html`<span class="exec-section-quota">${quotaMeter(accs)}</span>` : ''}
          ${today[key] ? html`<span class="meta exec-section-today" title="今天用的 token">${fmtTokens(today[key])}</span>` : ''}
          <i class="crew-dot ${st}" title="${st === 'online' ? '在线' : st === 'dispatch' ? '只派单' : st === 'me' ? '我自己' : '离线'}"></i>
        </summary>
        <div class="exec-section-body">
          ${taskBlock(key)}
          ${skillsBlock(key)}
          ${slotBlock(key)}
          ${manageBlock(key)}
        </div>
      </details>`;
    })}
    </div>
  </section>` : '')}
  <nav class="more-links" aria-label="更多"><a href="/team/accounts">${tabLabel('accounts')} ›</a></nav>
  </div>

  ${current && cur ? html`
    <a class="scrim" href="/team" aria-label="关闭"></a>
    <aside class="drawer" aria-label="执行者设置">
      <a class="drawer-close" href="/team" aria-label="关闭">${icon('close', 18)}</a>
      <div class="drawer-top">${execHead(current, { kind: stateOf(current) })}<span class="meta">${tabLabel('executors')}</span></div>
      <h2 class="drawer-title">${execLabel(current)} 的调度设置</h2>
      <form class="form" data-api="/api/executors" data-method="PUT">
        <input type="hidden" name="executor" value="${current}">
        <div class="field-row">
          <label class="field"><span>优先级（数字越小越先）</span><input name="priority" type="number" min="1" value="${cur.priority}"></label>
          <label class="field"><span>单任务最长（分钟）</span><input name="max_minutes" type="number" min="1" value="${cur.max_minutes ?? ''}" placeholder="不填不限"></label>
        </div>
        <label class="field"><span>允许的分类（逗号分开，留空表示全部）</span><input name="categories" value="${cur.categories}" placeholder="dev,docs,content"></label>
        <div class="field-row">
          <label class="field"><span>每日 token 上限</span><input name="daily_token_cap" type="number" min="0" value="${cur.daily_token_cap ?? ''}" placeholder="不填不限"></label>
          <label class="field"><span>它最多同时跑几个（执行器总共最多同时编码几个，看执行器配置的 maxParallel，默认 3）</span><input name="max_concurrent" type="number" min="1" value="${cur.max_concurrent ?? ''}" placeholder="不填就只受执行器总数限制"></label>
        </div>
        <div class="field-row">
          <label class="field"><span>自动执行</span><select name="auto_allowed">
            <option value="1" ${cur.auto_allowed ? 'selected' : ''}>允许（新任务不用点开始）</option>
            <option value="0" ${cur.auto_allowed ? '' : 'selected'}>不自动，手动点</option>
          </select></label>
          <label class="field"><span>能不能被领取</span><select name="enabled">
            <option value="1" ${cur.enabled ? 'selected' : ''}>可以（在这里跑）</option>
            <option value="0" ${cur.enabled ? '' : 'selected'}>只派单，不在这里跑</option>
          </select></label>
        </div>
        <div class="actions"><button class="btn primary">保存</button></div>
      </form>
      <p class="hint">分类白名单只影响自动执行和推荐；手动点开始的任务不看白名单。</p>
      <div class="section"><h3>这个执行者的账号</h3>
        ${accounts.filter((a) => a.executor === current).length
          ? html`<ul class="kv">${accounts.filter((a) => a.executor === current).map((a) => html`<li><span>${a.name}</span><span class="mono muted">${budgetText(a)}</span></li>`)}</ul>`
          : empty('还没有登记账号。')}
        <a class="btn small" href="/team/accounts">去「${tabLabel('accounts')}」加账号</a>
      </div>
      <div class="section"><h3>任务</h3>
        <a class="btn small" href="/tasks?executor=${current}">看它的任务</a>
      </div>
    </aside>` : ''}`;
}

// ---------- 账号槽（045） ----------

// 能开槽的执行者名单在 services/runs.ts：页面和接口读同一份，别再各写一份。
const SLOT_TONE: Record<SlotView['state'], '' | 'ok' | 'warn' | 'bad'> = {
  ok: 'ok', limited: 'warn', expired: 'bad', empty: 'bad', off: '',
};
const slotWhy = (k: string): string => (k === 'dsh'
  ? 'dsh 用 API 密钥标识身份，不做登录目录槽'
  : '这个执行者走反代池，账号轮换交给 CLIProxyAPI');

/** 一个槽一行：名字、标签、状态、目录与到期；能开槽的才带上停用/启用和改期。 */
function slotRows(slots: SlotView[], editable = true): Safe {
  return html`<ul class="slot-list">${slots.map((s) => {
    const url = `/api/slots/${encodeURIComponent(s.name)}`;
    return html`<li data-slot="${s.name}">
      <div class="slot-head">
        <strong>${s.name}</strong>
        ${s.label ? html`<span class="meta">${s.label}</span>` : ''}
        ${tag(s.state_text, SLOT_TONE[s.state])}
        <span class="meta">目录 <span class="mono">${s.slot_dir}</span></span>
        <span class="meta">${s.expires_at ? `到期 ${expiryText(s.expires_at)}` : '不过期'}</span>
      </div>
      ${editable ? html`<div class="slot-ops">
        <form class="inline-mini" data-api="${url}" data-method="PUT">
          <input type="hidden" name="slot_enabled" value="${s.slot_enabled ? '0' : '1'}">
          <button class="btn small">${s.slot_enabled ? '停用' : '启用'}</button>
        </form>
        <form class="form inline-form" data-api="${url}" data-method="PUT">
          <label class="field"><span>优先级（小的先用）</span><input name="slot_priority" type="number" min="0" max="999" value="${s.slot_priority}"></label>
          <label class="field"><span>到期日（清空=不过期）</span><input name="expires_at" type="date" value="${s.expires_at ? s.expires_at.slice(0, 10) : ''}"></label>
          <button class="btn small">保存</button>
        </form>
      </div>` : ''}
    </li>`;
  })}</ul>`;
}

/** 添加表单：只登记目录名，登录在执行器那台机器上做。 */
function addSlotForm(k: string): Safe {
  return html`<form class="form inline-form" data-api="/api/slots" data-method="POST">
    <input type="hidden" name="executor" value="${k}">
    <label class="field"><span>名字</span><input name="name" required maxlength="40" placeholder="claude-b"></label>
    <label class="field"><span>目录名</span><input name="slot_dir" required maxlength="32" placeholder="claude-b"></label>
    <label class="field"><span>标签（可不填）</span><input name="label" maxlength="60" placeholder="备用账号"></label>
    <label class="field"><span>到期日（可不填）</span><input name="expires_at" type="date"></label>
    <button class="btn primary small">添加账号槽</button>
  </form>
  <p class="hint">目录在执行器的 slotsRoot 下（默认 ~/.workbench-slots/目录名）。先在本机登录好，再回来登记；工作台只记目录名。</p>`;
}

const budgetText = (a: Account): string => {
  if (a.balance === null) return '—';
  if (a.kind === 'credits') return `${a.balance} ${a.balance_unit}`;
  return `${a.balance_estimated ? '≈ ' : ''}${a.balance} ${a.balance_unit}`;
};

// ---------- 账号与额度（原「数据」页，016 挪到这里） ----------

const ACCOUNT_KIND_TITLE: Record<string, string> = { window: '订阅窗口', balance: '按量余额', credits: '积分' };

const money = (v: number, unit: string): string => {
  if (unit === 'CNY') return `¥${v.toFixed(2)}`;
  if (unit === 'USD') return `$${v.toFixed(2)}`;
  return `${v} ${unit}`.trim();
};
const expiryText = (iso: string | null): string => {
  if (!iso) return '—';
  const left = Date.parse(iso) - Date.now();
  if (!Number.isFinite(left)) return '—';
  const day = iso.slice(0, 10);
  if (left <= 0) return `${day} · 已过期`;
  return `${day} · ${Math.ceil(left / 86400000)} 天后`;
};
const spanText = (minutes: number | null): string => {
  if (!minutes) return '';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
};
const resetText = (iso: string | null): string => {
  const left = iso ? Date.parse(iso) - Date.now() : NaN;
  if (!Number.isFinite(left) || left <= 0) return '';
  const m = Math.round(left / 60000);
  if (m < 60) return `${m} 分钟后重置`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}后重置`;
  return `${Math.floor(h / 24)} 天后重置`;
};

function windowCell(a: Account, value: number | null, minutes: number | null, resetAt: string | null): Safe {
  if (value === null && !minutes) return html`<td class="mono small muted">—</td>`;
  const stale = a.quota_observed_at && Date.now() - Date.parse(a.quota_observed_at) > 30 * 60 * 1000
    ? `${ago(a.quota_observed_at)}的数据` : '';
  const parts = [spanText(minutes), resetText(resetAt), stale].filter(Boolean).join(' · ');
  return html`<td class="progress-cell">
    <div class="progress">${bar(value, 'var(--ink)', true)}<span class="mono small">${value === null ? '—' : `${value}%`}</span></div>
    ${a.window_estimated && value !== null ? html`<div class="meta">估算</div>` : ''}
    ${parts ? html`<div class="meta">${parts}</div>` : ''}
  </td>`;
}

function accountsPanel(): Safe {
  const accounts = listAccounts();
  return html`
  <header class="page-head">
    <div>
      <span class="eyebrow">QUOTA · ${accounts.length} 个账号</span>
      <h1>${tabLabel('accounts')}</h1>
      <p class="lede">订阅窗口自动同步，余额定时查询，积分手动更新。</p>
    </div>
    <div class="head-actions"><a class="btn" href="/settings/integrations">接入与来源</a></div>
  </header>
  <section class="panel">
    ${accounts.length ? html`
      ${(['window', 'balance', 'credits'] as const).map((kind) => {
        const rows = accounts.filter((a) => a.kind === kind);
        if (!rows.length) return '';
        return html`<h3 class="group-title">${ACCOUNT_KIND_TITLE[kind]}</h3>
        <div class="table-wrap"><table>
          <thead><tr>${kind === 'window'
            ? html`<th>账号</th><th>来源</th><th>主窗口</th><th>副窗口</th><th>近 7 天 Token</th><th>状态</th><th></th>`
            : kind === 'balance'
              ? html`<th>账号</th><th>来源</th><th>余额</th><th>提醒线</th><th>查询时间</th><th>状态</th><th></th>`
              : html`<th>账号</th><th>余额</th><th>上次更新</th><th>到期</th><th>状态</th><th>更新</th><th></th>`}</tr></thead>
          <tbody>${rows.map((a) => html`<tr>
            <td><span class="exec">${dot(execColor(a.executor))}<strong>${a.name}</strong></span>${a.plan ? html`<div class="meta">${a.plan}</div>` : ''}</td>
            ${kind === 'window' ? html`
              <td class="small">${a.source === 'cliproxyapi' ? 'CLIProxyAPI' : '手动'}</td>
              ${windowCell(a, a.window_pct, a.window_minutes, a.window_reset_at)}
              ${windowCell(a, a.window2_pct, a.window2_minutes, a.window2_reset_at)}
              <td class="mono small">${fmtTokens(a.week_tokens ?? 0)}</td>`
            : kind === 'balance' ? html`
              <td class="small">${a.source === 'api' ? '接口' : '手动'}</td>
              <td class="mono">${a.balance === null ? '—' : `${a.balance_estimated ? '≈ ' : ''}${money(a.balance, a.balance_unit)}`}${a.balance_estimated ? html` <span class="badge">估算</span>` : ''}
                ${a.balance_estimated ? html`<div class="meta">${a.voucher_calibrated_at ? `上次校准 ${ago(a.voucher_calibrated_at)}` : '还没校准过'}</div>` : ''}
                ${a.unpriced_tokens ? html`<div class="meta warn-text">有 ${fmtTokens(a.unpriced_tokens)} token 没填单价，估算偏低</div>` : ''}
                ${a.balance_estimated ? html`<form class="inline-mini" data-api="/api/accounts/${encodeURIComponent(a.name)}/calibrate" data-method="POST">
                  <input name="remaining" type="number" step="any" min="0" placeholder="控制台剩余" aria-label="控制台看到的剩余金额">
                  <button class="btn small">校准</button>
                </form>` : ''}
              </td>
              <td class="mono small muted">${a.low_threshold === null ? '—' : money(a.low_threshold, a.balance_unit)}</td>
              <td class="small muted">${a.balance_observed_at ? ago(a.balance_observed_at) : '—'}</td>`
            : html`
              <td class="mono">${a.balance === null ? '—' : `${a.balance} ${a.balance_unit}`}</td>
              <td class="small muted">${a.balance_observed_at ? ago(a.balance_observed_at) : '从没更新过'}</td>
              <td class="small muted">${expiryText(a.expires_at)}</td>`}
            <td><span class="badge acct-${a.status}">${ACCOUNT_STATUSES[a.status] ?? a.status}</span></td>
            ${kind === 'credits' ? html`<td>
              <form class="inline-mini" data-api="/api/accounts/${encodeURIComponent(a.name)}" data-method="PUT">
                <input name="balance" type="number" step="any" min="0" placeholder="${a.balance ?? 0}" aria-label="当前积分">
                <button class="btn small">更新</button>
              </form></td>` : ''}
            <td class="right"><button type="button" class="link-btn danger-text" data-api-click="/api/accounts/${encodeURIComponent(a.name)}" data-method="DELETE" data-confirm="删除账号「${a.name}」？用量记录会保留。">删除</button></td>
          </tr>`)}</tbody></table></div>`;
      })}` : empty('还没有登记账号。下面添加一个；用量同步脚本上报时用同样的账号名即可关联。')}
    <details class="edit">
      <summary>添加或更新账号</summary>
      <form class="form inline-form" data-api="/api/accounts/{name}" data-method="PUT">
        <label class="field"><span>账号名</span><input name="name" required maxlength="120" placeholder="DeepSeek / WorkBuddy"></label>
        <label class="field"><span>类型</span><select name="kind">${Object.entries(ACCOUNT_KINDS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <label class="field"><span>执行者</span><select name="executor">${execOptions('claude')}</select></label>
        <label class="field"><span>接入方式</span><input name="via" maxlength="60" placeholder="官方会话 / CLI 反代"></label>
        <label class="field"><span>当前余额 / 积分</span><input name="balance" type="number" step="any"></label>
        <label class="field"><span>单位</span><input name="balance_unit" maxlength="10" placeholder="CNY / USD / 积分"></label>
        <label class="field"><span>低于多少提醒</span><input name="low_threshold" type="number" step="any"></label>
        <label class="field"><span>最近到期</span><input name="expires_at" type="date"></label>
        <label class="field"><span>窗口用量 %</span><input name="window_pct" type="number" min="0" max="100"></label>
        <label class="field"><span>窗口时长（分钟）</span><input name="window_minutes" type="number" min="0" placeholder="300"></label>
        <label class="field"><span>估算上限（token）</span><input name="window_limit_tokens" type="number" min="0" placeholder="拿不到官方额度时用"></label>
        <label class="field"><span>重置</span><input name="reset_note" maxlength="60" placeholder="1h 48m / 周一"></label>
        <label class="field"><span>状态</span><select name="status">${Object.entries(ACCOUNT_STATUSES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <div class="voucher-fields">
          <label class="field"><span>代金券总额</span><input name="voucher_total" type="number" step="any" min="0" placeholder="按量余额/代金券填"></label>
          <label class="field"><span>计费模型名</span><input name="price_model" maxlength="120" placeholder="deepseek-v4.1-flash"></label>
          <label class="field"><span>派单用的模型名</span><input name="model_alias" maxlength="120" placeholder="留空则取单价表里第一个模型；这里只是记录，Claude Code 那边的模型名不从这里读"></label>
          <label class="field"><span>输入单价</span><input name="price_in" type="number" step="any" min="0" placeholder="每百万 token"></label>
          <label class="field"><span>输出单价</span><input name="price_out" type="number" step="any" min="0" placeholder="每百万 token"></label>
          <label class="field"><span>闲时输入价</span><input name="price_in_off" type="number" step="any" min="0" placeholder="22:00–08:00，留空按主价"></label>
          <label class="field"><span>闲时输出价</span><input name="price_out_off" type="number" step="any" min="0" placeholder="22:00–08:00，留空按主价"></label>
        </div>
        <div class="actions"><button class="btn primary">保存</button></div>
      </form>
      <p class="hint">填了窗口时长和估算上限、又拿不到官方额度时，百分比按该窗口内的 token 用量估算，表里会标「估算」。</p>
      <p class="hint">「代金券总额 / 单价」只对「按量余额」有效，单价按每百万 token 填，币种跟单位一致。</p>
      <p class="hint">百炼的 DeepSeek 分忙时和闲时计价，闲时是北京时间 22:00 到次日 08:00，价格通常是忙时的一半；闲时价留空就按忙时价算，估出来的余额会偏低。</p>
      <p class="hint">反代回传的用量会自动从余额里扣；在 Claude Code 里直连花掉的部分工作台看不到，所以「估算」会偏高，用完回来点一次校准。</p>
    </details>
  </section>
  <p class="hint">用量同步脚本上报时用的账号名和这里一致，就会自动关联。在「设置 › 接入」里能看到同步命令。</p>`;
}
