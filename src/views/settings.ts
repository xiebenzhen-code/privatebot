import { EXECUTORS, RISKS, ago, crewPreset, execLabel, fmtDateTime, labels } from '../domain.ts';
import { listRules } from '../services/approvals.ts';
import { autoPaused, getSetting, listExecutorSettings } from '../services/dispatch.ts';
import { brainState } from '../services/brain.ts';
import { backupStatus } from '../services/backup.ts';
import { CHANNEL_KINDS, listChannels, maskUrl } from '../services/notify.ts';
import { dot, empty, riskBadge, tag } from './components.ts';
import { setupSettingsBlock } from './setup.ts';
import { setupStatus } from '../services/setup.ts';
import { selfEnabled, selfProject, selfRepo, selfdevState } from '../services/selfdev.ts';
import { digestSettings } from '../services/digest.ts';
import { EXCLUDED, listSources } from '../services/sources.ts';
import { currentMode, exposureState } from '../services/exposure.ts';
import { brandMark } from './layout.ts';
import { html, type Safe } from './html.ts';
import { tabLabel } from './routes.ts';

export type SettingsTab = 'integrations' | 'security' | 'notify' | 'appearance' | 'backup';

/**
 * 044 v3：设置的第一层。一行一类，一句状态；只有要你看的那一行亮。点一行进那一类（第二层）。
 */
export function settingsHome(): Safe {
  const sources = listSources();
  const wired = sources.filter((x) => x.state === 'connected').length;
  const todo = sources.filter((x) => x.state !== 'connected' && x.state !== 'off').length;
  const paused = autoPaused();
  const channels = listChannels();
  const bk = backupStatus();
  const theme = '跟随系统或你手动选的';
  const rows: { key: string; label: string; sub: string; hot: boolean }[] = [
    { key: 'integrations', label: '接入', sub: `${wired} 个接上${todo ? `，${todo} 个没接` : ''}`, hot: todo > 0 },
    { key: 'security', label: '安全', sub: `审批规则 ${listRules().length} 条 · 自动执行${paused ? '已暂停' : '开着'}`, hot: paused },
    { key: 'notify', label: '通知', sub: channels.length ? `${channels.length} 个推送渠道` : '还没配推送渠道', hot: false },
    { key: 'appearance', label: '外观', sub: `深浅色${theme} · 称呼`, hot: false },
    { key: 'backup', label: '备份', sub: bk.last_ok ? `上次成功 ${fmtDateTime(bk.last_ok)}` : '还没有成功过', hot: !bk.last_ok },
  ];
  const hot = rows.filter((r) => r.hot);
  return html`<div class="layer" data-layer="settings">
    <header class="lede-block"><span class="lede-date">设置</span>
      <h1 class="lede-line">${hot.length ? `有 ${hot.length} 件要你看：${hot.map((r) => r.label).join('、')}` : '都好，没有要你动的'}</h1></header>
    <section class="groups" aria-label="设置">
      ${rows.map((r) => html`<a class="group-row ${r.hot ? 'hot' : ''}" href="/settings/${r.key}" data-settings-row="${r.key}">
        <i class="crew-dot ${r.hot ? 'online' : ''}"></i>
        <span class="group-text"><span class="group-label">${tabLabel(r.key)}</span><span class="group-peek">${r.sub}</span></span>
        <span class="group-go" aria-hidden="true">›</span></a>`)}
    </section>
    <form class="logout-row" data-api="/logout" data-redirect="/login"><button class="link-btn">退出登录</button></form>
  </div>`;
}

export function settingsPage(baseUrl: string, tab: SettingsTab, collapsed = false): Safe {
  if (tab === 'security') return securityPanel();
  if (tab === 'notify') return notifyPanel();
  if (tab === 'appearance') return appearancePanel(collapsed);
  if (tab === 'backup') return backupPanel();
  return integrationsPanel(baseUrl);
}

// ---------- 接入 ----------

/**
 * 035：queue.json 那条链最近一次读的结果。读不到 / 格式不对 / 项目没登记，在这里说人话，
 * 别让人去翻日志。没配 GitHub 就整行不显示。
 */
function selfdevStatusLine(): Safe {
  if (!selfEnabled()) return '';
  const st = selfdevState();
  if (st.lastError) {
    return html`<div class="callout warn" data-selfdev><strong>自己开发自己这条链没跑通</strong><span>${st.lastError}</span></div>`;
  }
  if (!st.checkedAt) return html`<p class="hint" data-selfdev>还没读过 ${selfRepo()} 的 docs/specs/queue.json。</p>`;
  return html`<p class="hint" data-selfdev>最近一次读 ${selfRepo()} 的 queue.json 是 ${ago(st.checkedAt)}；里面排到 ${selfProject()} 的项会自动变成任务，等你点「开始」。</p>`;
}

const VIA_LABEL: Record<string, string> = { proxy: '反代', api: '官方接口', reader: '网页读取器', manual: '手动录入', sync: '用量同步' };
const QUOTA_LABEL: Record<string, string> = { window: '订阅窗口', balance: '按量余额', credits: '积分', usage: '用量' };
const STATE_LABEL: Record<string, string> = { connected: '已接入', action: '待你操作', off: '停用' };

/** What to do about one source, folded into its own card. */
function sourceHelp(id: string): Safe | null {
  if (id === 'deepseek') return html`<p>在 <code>.env</code> 里填 <code>DEEPSEEK_API_KEY</code>，重启后每 10 分钟查一次余额。低于提醒线会给你建一条待办。</p>`;
  if (id === 'cliproxyapi') return html`<p>在 <code>.env</code> 里填 <code>CPA_URL</code> 和 <code>CPA_MANAGEMENT_KEY</code>，重启后自动同步账号和用量；队列取出即删除，不会重复计数。</p>`;
  if (id === 'github') return html`<p>在执行器配置里填 <code>githubToken</code>（Issues 读写、Contents 只读），在工作台 <code>.env</code> 里填 <code>GITHUB_REPOS</code> 和 <code>GITHUB_ALLOWED_AUTHORS</code>。执行器空闲时每 5 分钟转发一次。带 <code>wb-task</code> 标签的 Issue 会变成待开始的任务。</p>`;
  if (id === 'workbuddy' || id === 'autoclaw') return html`<p>这两个只能在客户端里看额度，读取器跑在登录了账号的电脑上，把结果 POST 到 <code>/api/usage</code>，失败会记一条 <code>reader.*</code> 审计。工具不提供、也不汇总账号。</p>`;
  if (id === 'zai' || id === 'glm') return html`<p>在 <code>.env</code> 里填 <code>ZAI_API_KEY</code>（海外账号再加 <code>ZAI_REGION=global</code>），重启后每 10 分钟查一次 Coding Plan 窗口。</p>`;
  return null;
}

/**
 * 044 v3 · 接入的第二层：一个来源一行。只靠黄绿深浅分轻重——要你动手的最亮，接上的淡一档，停用的灰着收起来。
 * 点开一行才看到它的说明、变量名和开关；说明里的代码会换行，不撑破版面。
 */
function sourceRow(s: ReturnType<typeof listSources>[number]): Safe {
  const help = sourceHelp(s.id);
  const canSync = s.state !== 'off' && (s.id === 'deepseek' || s.id === 'cliproxyapi');
  const peek = s.state === 'off' ? '停用' : s.lastOk ? `上次成功 ${ago(s.lastOk)}` : '还没成功过';
  return html`<details class="src-row ${s.state}" id="src-${s.id}" data-source="${s.id}">
    <summary>
      <i class="crew-dot ${s.state === 'action' ? 'online' : s.state === 'connected' ? 'dispatch' : ''}" aria-hidden="true"></i>
      <span class="src-text"><span class="src-name">${s.label}</span><span class="src-peek">${s.state === 'action' ? '⚠ ' : ''}${peek}</span></span>
      <span class="sr-only">${STATE_LABEL[s.state] ?? s.state}</span>
      <span class="group-go" aria-hidden="true">›</span>
    </summary>
    <div class="src-body">
      ${s.state === 'action' ? html`<p class="src-next">${s.nextStep}</p>` : ''}
      ${help ?? ''}
      <p class="src-meta">${VIA_LABEL[s.via] ?? s.via} · ${QUOTA_LABEL[s.quota] ?? s.quota}${s.envNames.length ? html` · 变量 ${s.envNames.map((n, i) => html`${i ? ' / ' : ''}<code>${n}</code>`)}` : ''}</p>
      <div class="src-actions">
        ${s.state === 'action' ? html`<button type="button" class="link-btn" data-api-click="/api/connectors/${s.id}/run" data-method="POST" data-no-done>↻ 立即重试</button>` : ''}
        ${canSync ? html`<button type="button" class="link-btn" data-api-click="/api/connectors/${s.id}/run" data-method="POST" data-no-done>↻ 立即同步</button>` : ''}
        ${s.state === 'off'
          ? html`<button type="button" class="link-btn" data-api-click="/api/sources/${encodeURIComponent(s.id)}" data-method="PATCH" data-body='{"off":false}' data-done="已启用 ✓">启用</button>`
          : html`<button type="button" class="link-btn quiet-text" data-api-click="/api/sources/${encodeURIComponent(s.id)}" data-method="PATCH" data-body='{"off":true}' data-done="已停用 ✓">停用</button>`}
      </div>
    </div>
  </details>`;
}

/** 脚本和钩子：一项一个折叠，默认全收着。 */
function setupFold(id: string, title: string, body: Safe): Safe {
  return html`<details class="fold" id="fold-${id}"><summary>${title}</summary>${body}</details>`;
}

function integrationsPanel(baseUrl: string): Safe {
  const sources = listSources();
  const action = sources.filter((s) => s.state === 'action');
  const on = sources.filter((s) => s.state === 'connected');
  const off = sources.filter((s) => s.state === 'off');
  const hook = (matcher: string | null, timeout: number) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: 'node ~/ai-workbench/scripts/claude-hook.mjs', timeout }],
  });
  const settingsJson = JSON.stringify({
    hooks: {
      PreToolUse: [hook('Bash|Edit|Write|MultiEdit', 1800)],
      UserPromptSubmit: [hook(null, 15)],
      Stop: [hook(null, 15)],
      SessionEnd: [hook(null, 15)],
    },
  }, null, 2);
  const configJson = JSON.stringify({ url: baseUrl, token: '<你的 WB_TOKEN>' }, null, 2);
  // 一句话只说几个；名字在下面一行一个，不在标题里排队。
  const line = action.length ? `有 ${action.length} 个要你动手` : `${on.length} 个都接上了`;

  return html`<div class="layer" data-layer="integrations">
  <header class="lede-block"><span class="lede-date">接入状态 · ${on.length} 个接上${off.length ? ` · ${off.length} 个停用` : ''}</span>
    <h1 class="lede-line">${line}</h1>
    <span class="lede-sub">状态由工作台自己判断；密钥都写在 <code>.env</code> 和执行器配置里，这里不显示。</span></header>

  ${setupSettingsBlock(setupStatus())}
  ${selfdevStatusLine()}

  <section class="src-list" aria-label="接入">
    ${[...action, ...on].map((s) => sourceRow(s))}
  </section>

  ${off.length || EXCLUDED.length ? html`<details class="fold" id="fold-sources-off"><summary>停用和不接的 ${off.length + EXCLUDED.length} 个</summary>
    <section class="src-list">
      ${off.map((s) => sourceRow(s))}
      ${EXCLUDED.map((e) => html`<div class="src-row excluded static"><div class="src-sum"><i class="crew-dot" aria-hidden="true"></i>
        <span class="src-text"><span class="src-name">${e.label}</span><span class="src-peek">不接 · ${e.reason}</span></span></div></div>`)}
    </section>
  </details>` : ''}

  <details class="fold" id="fold-scripts"><summary>⚙ 脚本和钩子</summary>
    ${setupFold('hook', 'Claude Code 钩子 · 审批 + 自动建任务', html`<ol class="steps">
        <li><p>把仓库里的 <code>scripts/claude-hook.mjs</code> 放到运行 Claude Code 的电脑上（下面假设在 <code>~/ai-workbench/scripts/</code>）。</p></li>
        <li><p>新建 <code>~/.ai-workbench.json</code>：</p>
          <div class="code"><button type="button" class="copy" data-copy>复制</button><pre>${configJson}</pre></div></li>
        <li><p>在 <code>~/.claude/settings.json</code> 里加上 hooks（已有 hooks 的话合并进去）：</p>
          <div class="code"><button type="button" class="copy" data-copy>复制</button><pre>${settingsJson}</pre></div></li>
        <li><p>重开 Claude Code。命中规则的操作会停下来等你批准；工作台连不上时 hook 会放行给终端原有的确认流程。</p></li>
      </ol>`)}
    ${setupFold('sync', '用量同步', html`<p>读本地会话记录（<code>~/.claude/projects</code>、<code>~/.codex/sessions</code>）上报 token 数，不传对话内容，不用登录任何账号。</p>
        <div class="code"><button type="button" class="copy" data-copy>复制</button><pre>node ~/ai-workbench/scripts/sync-usage.mjs

# Windows：每 10 分钟一次（管理员 PowerShell 里跑一次）
schtasks /Create /SC MINUTE /MO 10 /TN "ai-workbench sync" /TR "node %USERPROFILE%\\ai-workbench\\scripts\\sync-usage.mjs"

# macOS / Linux：crontab -e
*/10 * * * * node ~/ai-workbench/scripts/sync-usage.mjs &gt;&gt; ~/.ai-workbench-sync.log 2&gt;&amp;1</pre></div>`)}
    ${setupFold('heartbeat', '机器心跳', html`<p>在要看的机器上每分钟上报 CPU、内存、GPU、容器数：</p>
        <div class="code"><button type="button" class="copy" data-copy>复制</button><pre>WB_URL=${baseUrl} WB_TOKEN=&lt;令牌&gt; bash scripts/heartbeat.sh

# crontab -e
* * * * * WB_URL=${baseUrl} WB_TOKEN=&lt;令牌&gt; bash /opt/ai-workbench/scripts/heartbeat.sh</pre></div>`)}
    ${setupFold('api', 'API · 脚本令牌', html`<p class="meta">请求头 <code>Authorization: Bearer &lt;WB_TOKEN&gt;</code>，详见 README。审批、改规则、改设置、导出整库只能在网页上做。</p>
        <ul class="kv mono small">
          <li><span>GET / POST /api/tasks</span><span>列出 / 新建任务</span></li>
          <li><span>PATCH /api/tasks/:id</span><span>更新状态、进度、步骤</span></li>
          <li><span>POST /api/approvals</span><span>发起审批</span></li>
          <li><span>GET /api/approvals/:id</span><span>轮询审批结果</span></li>
          <li><span>POST /api/usage</span><span>批量上报用量</span></li>
          <li><span>PUT /api/accounts/:name</span><span>更新账号额度</span></li>
          <li><span>POST /api/machines/:name/heartbeat</span><span>机器心跳</span></li>
        </ul>`)}
  </details>

  <details class="fold" id="fold-issue-result"><summary>Issue 回写 · ${getSetting('issue_result_comment') === '1' ? '已开' : '关着'}</summary>
    <form class="inline-form" data-api="/api/settings/issue-result" data-method="POST">
      <label class="check"><input type="checkbox" name="on" value="1" ${getSetting('issue_result_comment') === '1' ? 'checked' : ''}>把任务结果（模型最后那段回答，前 1500 字）写回 Issue</label>
      <button class="btn">保存</button>
    </form>
    <p class="hint">只对从 Issue 来的任务生效。回答里可能引用文件内容，所以默认关；打开前想清楚这个 Issue 谁能看到。</p>
  </details>

  <details class="fold" id="fold-digest"><summary>日报</summary>${digestPanel()}</details>
  </div>`;
}


/** 019: the morning digest. Off by default; only the person can turn it on or send one. */
function digestPanel(): Safe {
  const d = digestSettings();
  const status = d.last_error
    ? html`<p class="hint warn-text">上次没发出去：${d.last_error}${d.next_try ? html` · 下次重试 ${fmtDateTime(d.next_try)}（点「现在发一条」可以不用等）` : ''}</p>`
    : d.last_ok
      ? html`<p class="hint">上次发出：${fmtDateTime(d.last_ok)}${d.issue ? html` · <a href="${d.issue}" target="_blank" rel="noreferrer">打开那个 Issue ↗</a>` : ''}</p>`
      : html`<p class="hint">还没发过。</p>`;
  return html`<section class="panel" id="digest">
    <div class="panel-head"><h2>日报</h2><span class="meta">每天早上一条，写到一个固定 Issue</span></div>
    <p class="hint">只有概况：昨天完成/失败几个、等你处理几件、执行器在不在、备份多久没做。默认<b>不带任务标题</b>，不带命令、路径和日志。工作台只往这个 Issue 写，不读它的评论。</p>
    <form class="form-grid" data-api="/api/digest" data-method="POST">
      <label class="switch-line"><input type="checkbox" name="on" value="1" ${d.on ? 'checked' : ''}> 打开日报</label>
      <label>仓库<input class="mono" name="repo" value="${d.repo}" placeholder="用户名/仓库名"></label>
      <label>发送时间<input class="mono" name="at" value="${d.at}" placeholder="08:00"></label>
      <label class="switch-line"><input type="checkbox" name="titles" value="1" ${d.titles ? 'checked' : ''}> 带上任务标题（只列失败的、等审批的、卡住的，标题会打码）</label>
      <div class="form-actions"><button class="btn">保存</button></div>
    </form>
    <div class="panel-foot">
      <button class="btn small" data-api-click="/api/digest/send" data-method="POST" data-done="已排队 ✓">现在发一条</button>
      <span class="meta">日报先排队，由执行器用 <code>githubToken</code> 发送；令牌需要这个仓库的 Issues 读写权限。</span>
    </div>
    ${status}
  </section>`;
}

// ---------- 安全 ----------

function securityPanel(): Safe {
  const paused = autoPaused();
  const rules = listRules();
  const rows = listExecutorSettings();
  const brain = brainState();
  const mode = currentMode();
  const last = exposureState();
  const modeLabel = mode === 'refuse' ? '直接拒绝' : mode === 'allow' ? '不处理' : '提醒';
  return html`
  <header class="page-head"><div><span class="eyebrow">SETTINGS · 安全</span><h1>${tabLabel('security')}</h1>
    <p class="lede">总开关、审批规则，以及各执行者的预算上限。改上限去「<a href="/team">${tabLabel('executors')}</a>」里对应执行者的抽屉。</p></div></header>

  <section class="panel">
    <div class="panel-head"><h2>自动执行总开关</h2><span class="meta">${paused ? '已暂停' : '自动执行开着'}</span></div>
    <p class="hint">暂停只停「自动开始」的新任务；你手动点开始的任务照常跑。暂停随时可以用脚本令牌做，恢复必须由你在网页上点。</p>
    <div class="actions">
      <form class="inline-mini" data-api="/api/dispatch/auto-paused" data-method="POST">
        <input type="hidden" name="paused" value="${paused ? '0' : '1'}">
        <button class="btn ${paused ? 'primary' : 'danger-text'}">${paused ? '恢复自动执行' : '暂停所有自动执行'}</button>
      </form>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>公网访问检测</h2><span class="meta">当前：${modeLabel}</span></div>
    <p class="hint">工作台默认只绑本机。这里只在「不小心把端口开到公网」时提醒你：判断看的是浏览器里敲的地址（Host 头）和转发头，不是对方 IP（Docker 里看不到真实来源），所以它是**防误用**的兜底，不是防护。</p>
    ${last
      ? html`<p class="hint warn-text">最近一次可疑访问：${fmtDateTime(last.last_at)}，来自 ${last.label}</p>`
      : html`<p class="hint">还没有发现过可疑访问。</p>`}
    <form class="inline-mini" data-api="/api/exposure" data-method="POST">
      <select name="mode" aria-label="公网访问处理方式">
        <option value="warn" ${mode === 'warn' ? html`selected` : ''}>提醒（默认）</option>
        <option value="refuse" ${mode === 'refuse' ? html`selected` : ''}>直接拒绝网页访问</option>
        <option value="allow" ${mode === 'allow' ? html`selected` : ''}>不处理</option>
      </select>
      <button class="btn">保存</button>
    </form>
    <p class="hint">脚本接口（Bearer 令牌）任何模式下都不拦——执行器和心跳可能合法地走局域网 IP。确实有自己的域名（比如在 HTTPS 反代后面），在 <code>.env</code> 里设 <code>WB_ALLOWED_HOSTS</code>，就不再提醒。</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>审批规则</h2><span class="meta">${rules.filter((r) => r.enabled).length}/${rules.length} 条开着</span></div>
    <p class="hint">Agent 的工具调用命中任一启用的规则，就会暂停等你审批；同时命中多条取风险最高的。</p>
    <details class="fold" id="fold-rules"><summary>管理规则</summary>
    <div class="table-wrap"><table>
      <thead><tr><th>启用</th><th>规则</th><th>工具</th><th>内容匹配（正则，不区分大小写）</th><th>风险</th><th></th></tr></thead>
      <tbody>${rules.map((r) => html`<tr>
        <td><input type="checkbox" aria-label="启用「${r.name}」" ${r.enabled ? 'checked' : ''} data-api-toggle="/api/rules/${r.id}" data-field="enabled" data-on="1" data-off="0"></td>
        <td><strong>${r.name}</strong></td>
        <td class="mono small">${r.tool_pattern}</td>
        <td class="mono small break">${r.input_pattern || '（任意内容）'}</td>
        <td>${riskBadge(r.risk)}</td>
        <td class="right"><button type="button" class="link-btn danger-text" data-api-click="/api/rules/${r.id}" data-method="DELETE" data-confirm="删除规则「${r.name}」？">删除</button></td>
      </tr>`)}</tbody>
    </table></div>
    <details class="edit">
      <summary>新增规则</summary>
      <form class="form inline-form" data-api="/api/rules">
        <label class="field"><span>规则名</span><input name="name" required maxlength="120" placeholder="改数据库迁移"></label>
        <label class="field"><span>工具（正则）</span><input name="tool_pattern" required value="Bash" class="mono"></label>
        <label class="field wide"><span>内容匹配（正则，留空 = 任意）</span><input name="input_pattern" class="mono" placeholder="\\bprisma\\s+migrate\\b"></label>
        <label class="field"><span>风险</span><select name="risk">${Object.entries(RISKS).map(([k, v]) => html`<option value="${k}" ${k === 'medium' ? 'selected' : ''}>${v.label}</option>`)}</select></label>
        <div class="actions"><button class="btn primary">添加</button></div>
      </form>
      <p class="hint">Bash 匹配的是命令本身；Edit / Write 匹配的是文件路径；其他工具匹配整段输入 JSON。</p>
    </details>
    </details>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>低风险自动放行</h2><span class="meta">${getSetting('auto_approve_docs', '1') === '0' ? '已关' : '已开'}</span></div>
    <form class="inline-form" data-api="/api/settings/auto-approve-docs" data-method="POST">
      <label class="check"><input type="checkbox" name="on" value="1" ${getSetting('auto_approve_docs', '1') === '0' ? '' : 'checked'}>任务只改了 <code>docs/</code> 里的文件时，合并审批自动通过</label>
      <button class="btn">保存</button>
    </form>
    <p class="hint">只过「合并」这一道：推送和部署照样停下来等你点。改了一个代码文件、或者文件清单拿不准，都退回人工。每次自动通过都会记在审计里，审批卡片上也写着理由。</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>调度大脑</h2><span class="meta">${brain.on ? `已开 · 今天用了 ${brain.used}/${brain.cap} 次` : '已关'}</span></div>
    <form class="inline-form" data-api="/api/settings/dispatch-brain" data-method="POST">
      <label class="check"><input type="checkbox" name="on" value="1" ${brain.on ? 'checked' : ''}>让模型在合格名单里挑执行者，并判难度</label>
      <label class="field"><span>每天最多问几次</span><input name="cap" type="number" min="1" max="500" value="${brain.cap}"></label>
      <button class="btn">保存</button>
    </form>
    <p class="hint">规则先筛出合格名单（启用、能被领取、分类、额度、只读限制），大脑只能从里面挑一个，判个难度、写句理由。它跑在执行器那台电脑上，用本机已有的密钥——工作台不保存模型密钥。关着时一切照旧，新建任务里也不会出现「让大脑选」。次数用完当天自动退回规则推荐。</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>各执行者的上限</h2><a href="/team">去执行者页改</a></div>
    <div class="table-wrap"><table>
      <thead><tr><th>执行者</th><th>每日 token 上限</th><th>单任务最长</th><th>自动执行</th><th>能被领取</th></tr></thead>
      <tbody>${rows.map((s) => html`<tr>
        <td><a class="exec" href="/team?exec=${s.executor}">${dot(EXECUTORS[s.executor]?.color ?? '#9CA3AF')}<strong>${execLabel(s.executor)}</strong></a></td>
        <td class="mono small">${s.daily_token_cap ? s.daily_token_cap.toLocaleString('en-US') : '不限'}</td>
        <td class="mono small">${s.max_minutes ? `${s.max_minutes} 分钟` : '不限'}</td>
        <td>${s.auto_allowed ? tag('自动跑', 'ok') : tag('手动派')}</td>
        <td>${s.enabled ? tag('可以', 'ok') : tag('只派单', 'warn')}</td>
      </tr>`)}</tbody>
    </table></div>
    <p class="hint">预算是闸，不是账本：超了会在任务中途停下来等你，不会直接杀掉。</p>
  </section>`;
}

// ---------- 通知 ----------

function notifyPanel(): Safe {
  const channels = listChannels();
  const url = getSetting('public_url');
  const list = html`
    ${channels.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>类型</th><th>地址</th><th></th></tr></thead>
      <tbody>${channels.map((c) => html`<tr>
        <td>${CHANNEL_KINDS[c.kind] ?? c.kind}</td>
        <td class="mono small muted">${maskUrl(c.url)}</td>
        <td class="right"><button type="button" class="link-btn danger-text" data-api-click="/api/notify/channels/${c.id}" data-method="DELETE" data-confirm="删除这个推送渠道？">删除</button></td>
      </tr>`)}</tbody></table></div>` : empty('还没配推送渠道，配一个就能在手机上收到审批提醒。')}
    <div class="actions"><button type="button" class="btn" data-api-click="/api/notify/test" data-method="POST" data-done="已发送 ✓">发送测试消息</button></div>
    <details class="fold" id="fold-addchannel"><summary>加渠道</summary>
      <form class="inline-form" data-api="/api/notify/channels" data-method="POST">
        <label class="field"><span>类型</span><select name="kind">${Object.entries(CHANNEL_KINDS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <label class="field"><span>Webhook 地址</span><input name="url" required placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"></label>
        <button class="btn">添加</button>
      </form>
    </details>
    <div class="form-group">
      <span class="subhead">推什么</span>
      <p class="hint">等你审批、任务失败，一定会推（各推一次，不会重复）。</p>
      <form class="inline-form" data-api="/api/settings/notify-done" data-method="POST">
        <label class="check"><input type="checkbox" name="on" value="1" ${getSetting('notify_task_done') === '1' ? 'checked' : ''}>任务完成也推送（只有标题和链接，不带结果）</label>
        <button class="btn">保存</button>
      </form>
      <form class="inline-form" data-api="/api/settings/notify-ask" data-method="POST">
        <label class="check"><input type="checkbox" name="on" value="1" ${getSetting('notify_task_ask') === '1' ? 'checked' : ''}>提问也推送（只说哪个任务在等你选，不带问题内容）</label>
        <button class="btn">保存</button>
      </form>
    </div>`;
  return html`
  <header class="page-head"><div><span class="eyebrow">SETTINGS · 通知</span><h1>${tabLabel('notify')}</h1>
    <p class="lede">只推标题、风险等级和链接，不带命令和文件内容。</p></div></header>

  <section class="panel">
    <div class="panel-head"><h2>推送渠道</h2><span class="meta">${channels.length} 个</span></div>
    ${list}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>手机访问地址</h2><span class="meta">${url ? '已填' : '没填'}</span></div>
    <p class="hint">推送里的链接用这个前缀。没填就只推文字、不带链接。</p>
    <details class="fold" id="fold-publicurl"><summary>改地址</summary>
      <form class="inline-form" data-api="/api/dispatch/public-url" data-method="POST">
        <label class="field"><span>地址</span><input name="url" value="${url}" placeholder="http://你的服务器IP:3200"></label>
        <button class="btn">保存</button>
      </form>
      <p class="hint">用 Tailscale 的话填 Tailscale 里的地址。</p>
    </details>
  </section>`;
}

// ---------- 外观 ----------

const SECTION_ITEMS: [string, string][] = [['inbox', '审批'], ['board', '看板'], ['mine', '我的待办'], ['done', '已完成'], ['executors', '执行者'], ['accounts', '账号与额度']];

function appearancePanel(collapsed: boolean): Safe {
  const l = labels();
  const crew = crewPreset();
  return html`
  <header class="page-head"><div><span class="eyebrow">SETTINGS · 外观</span><h1>${tabLabel('appearance')}</h1>
    <p class="lede">只改界面上的字和侧边栏的样子，内部的 key、接口、审计都不变。</p></div></header>

  <section class="panel">
    <div class="panel-head"><h2>称呼</h2><span class="meta">预设和自定义；留空就用预设的写法，限 1–12 个字</span></div>
    <form class="inline-form" data-api="/api/labels" data-method="POST">
      <label class="field"><span>预设</span><select name="preset">
        <option value="default" ${l.preset === 'default' ? 'selected' : ''}>默认</option>
        <option value="crew" ${l.preset === 'crew' ? 'selected' : ''}>剧组</option>
      </select></label>
      <div class="field-row">
        ${Object.keys(EXECUTORS).map((k) => html`<label class="field"><span>${k}</span>
          <input name="exec_${k}" maxlength="12" value="${l.executors[k] ?? ''}" placeholder="${crew.executors[k] ?? EXECUTORS[k].label}"></label>`)}
      </div>
      <div class="field-row">
        ${SECTION_ITEMS.map(([k, def]) => html`<label class="field"><span>${def}</span>
          <input name="sec_${k}" maxlength="12" value="${l.sections[k] ?? ''}" placeholder="${crew.sections[k] ?? def}"></label>`)}
      </div>
      <div class="actions"><button class="btn primary">保存称呼</button></div>
    </form>
    <p class="hint">改名后侧边栏、分段标签、看板列和概览卡片会一起变。</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>侧边栏</h2><span class="meta">现在默认${collapsed ? '收起' : '展开'}</span></div>
    <p class="hint">桌面宽度下侧边栏可以收成图标条；手机宽度下会自动变成底部标签栏。</p>
    <div class="seg inline" role="group" aria-label="侧边栏默认状态">
      <button type="button" class="seg-item ${collapsed ? '' : 'on'}" data-side-default="open">默认展开</button>
      <button type="button" class="seg-item ${collapsed ? 'on' : ''}" data-side-default="collapsed">默认收起</button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>深浅色</h2><span class="meta">右上角的太阳 / 月亮随时切</span></div>
    <p class="hint">手动切过之后就一直按你选的来；想让它跟着系统的白天黑夜走，点「跟随系统」。</p>
    <div class="seg inline" role="group" aria-label="深浅色">
      <button type="button" class="seg-item" data-theme-set="system">跟随系统</button>
      <button type="button" class="seg-item" data-theme-set="light">浅色</button>
      <button type="button" class="seg-item" data-theme-set="dark">深色</button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>桌面应用</h2><span class="meta">独立窗口、开始菜单和任务栏图标</span></div>
    <p>装成桌面应用后从开始菜单直接进，不用每次开浏览器输地址。工作台没起来时会显示离线页，而不是浏览器的报错页。</p>
    <div class="actions"><button type="button" class="btn primary" id="install-app" hidden>安装为桌面应用</button></div>
    <p class="hint" id="install-hint">在 Edge 地址栏点「安装此站点为应用」；手机可用浏览器的「添加到主屏幕」。</p>
  </section>`;
}

// ---------- 备份 ----------

function backupPanel(): Safe {
  const st = backupStatus();
  return html`
  <header class="page-head"><div><span class="eyebrow">SETTINGS · 备份</span><h1>${tabLabel('backup')}</h1>
    <p class="lede">每天 ${st.at}（${process.env.WB_TZ ?? 'Asia/Shanghai'}）存一份，保留最近 ${st.keep} 份。</p></div></header>
  <section class="panel">
    <div class="panel-head"><h2>自动备份</h2>
      <span class="meta">${st.last_ok ? `上次成功 ${ago(st.last_ok)}` : '还没成功过'}</span></div>
    <div class="mini-kpis">
      <div><b class="mono">${st.last_ok ? `${fmtDateTime(st.last_ok)} · ${ago(st.last_ok)}` : '还没成功过'}</b><span>上次成功</span></div>
      <div><b class="mono">${st.bytes ? `${(st.bytes / 1024 / 1024).toFixed(1)} MB` : '—'}</b><span>这份的大小</span></div>
      <div><b class="mono">${st.ok_count}</b><span>累计份数</span></div>
      <div><b class="mono">${st.fail_count}</b><span>失败次数</span></div>
    </div>
    ${st.file ? html`<p class="hint">最新一份：<code>${st.file}</code>，同目录下还有一份同名 <code>.json</code> 记着时间、版本和各项数量。</p>` : ''}
    ${st.last_error ? html`<p class="hint warn-text">上次失败：${st.last_error}</p>` : ''}
    <details class="fold" id="fold-backupdir"><summary>备份在哪</summary>
    <p class="hint">备份写在 <code>${st.dir}</code>${st.hostDir
      ? html`，对应这台电脑上的 <code>${st.hostDir}</code>（<code>WB_BACKUP_DIR</code>）。`
      : html`；想让网盘自动同步，在 <code>.env</code> 里设 <code>WB_BACKUP_DIR</code> 指向网盘的同步文件夹后重启。`}
      超过 3 天没备份成功会给你建一条待办。备份里删掉了登录会话，恢复后要重新登录。
      ${st.exists ? '' : '这个目录还不存在，第一次备份时会自动建出来。'}</p>
    </details>
    <div class="actions">
      <button type="button" class="btn solid" data-api-click="/api/backup/run" data-done="已备份 ✓">立即备份</button>
      <a class="btn" href="/api/backup">下载数据库备份</a>
    </div>
  </section>`;
}

export function loginPage(error?: string): string {
  return html`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · 我的工作台</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="login-body">
<form class="login" method="post" action="/login">
  <span class="brand-p-wrap">${brandMark(56)}</span>
  <h1>我的工作台</h1>
  <label class="field"><span>密码（WB_PASSWORD）</span><input type="password" name="password" required autofocus autocomplete="current-password"></label>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
  <button class="btn primary block">进入</button>
</form>
</body></html>`.value;
}
