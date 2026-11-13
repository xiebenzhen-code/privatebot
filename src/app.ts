// HTTP routing. Pages are server-rendered HTML; /api/* is JSON. No framework.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { db } from './db.ts';
import {
  authOf, checkPassword, checkToken, clearCookie, createSession, destroySession, loginBlocked, loginFailed, loginOk,
  passwordProblem, sameOrigin, sessionCookieFor, sessionIdOf,
} from './auth.ts';
import { EXECUTORS, crewPreset, execLabel, fmtDateTime, labels, nowIso, saveLabels } from './domain.ts';
import { HttpError, listEvents, logEvent } from './services/core.ts';
import {
  createApproval, createRule, decideApproval, deleteRule, expireApproval, getApproval, handleClaudeHook,
  listApprovals, listRules, updateRule,
} from './services/approvals.ts';
import {
  botSnapshot, calibrateVoucher, deleteAccount, deleteMachine, heartbeat, ingestUsage, listAccounts, listMachines, periodStats, pulse, upsertAccount,
} from './services/metrics.ts';
import { createTask, deleteTask, getTask, listTasks, stopTask, updateTask, type Task } from './services/tasks.ts';
import {
  autoPaused, evaluateTaskBudget, getSetting, listExecutorSettings, nextRunnableTask,
  quotaBlock, saveExecutorSettings, setAutoPaused, setSetting, suggestExecutor,
} from './services/dispatch.ts';
import { addChannel, deleteChannel, listChannels, maskUrl, notify, notifyApproval, notifyStaleBranches, notifyTaskAsk, notifyTaskResult, sendTest } from './services/notify.ts';
import { EXCLUDED, listSources, redactText, setSourceOff } from './services/sources.ts';
import { claimTask, expectHandoff, finishTask, heartbeat as runnerHeartbeat, listRunners, reportProgress, runnerExecutors, staleRunReport } from './services/runner.ts';
import { createSlot, listRuns, listSlots, orderedSlots, updateSlot } from './services/runs.ts';
import { answerAsk, cancelAsks, hasAnswered, listAsks, openAsk, takeResume } from './services/asks.ts';
import { commentOnTask, finishComment, githubRepos, importIssues, pushComment, recordGithubSync } from './services/github.ts';
import { claimGithubJob, finishGithubJob } from './services/github-outbox.ts';
import { stuckFor } from './services/stage.ts';
import { activeTaskIds, deleteRequests, finishCleanup, reportScan, requestDelete, snoozeBranch } from './services/branches.ts';
import { createRequest as createProjectRequest, finishRequest as finishProjectRequest, listRequests as listProjectRequests, nextRequest as nextProjectRequest } from './services/projects.ts';
import {
  addNote, addSuggestionsForTask, confirmAll, confirmNote, deleteNote, listProjectNotes, notesForPrompt, rejectNote, updateNote,
} from './services/notes.ts';
import { RUNNER_CMD, dismissSetup, latestRunnerMeta, setupStatus } from './services/setup.ts';
import { scorecard } from './services/scorecard.ts';
import { capabilities } from './services/capability.ts';
import { brainState, pendingRoutes, rerouteForQuota, routeTask, saveBrainSettings } from './services/brain.ts';
import { importQueue, reportToIssue, recordSelfdevDelivery, selfRepo } from './services/selfdev.ts';
import { digestSettings, recordDigestDelivery, saveDigestSettings, sendDigest } from './services/digest.ts';
import { connectorEnabled, connectorState, pollSeconds, runCycle } from './services/cliproxyapi.ts';
import { balanceEnabled, balanceState, glmEnabled, glmState, runBalances } from './services/balances.ts';
import { backupStatus, runManualBackup, scrubCopy } from './services/backup.ts';
import {
  accessMode, allowedHosts, classifyAccess, currentExposureNote, currentMode, exposureState, recordSuspicious, saveMode, withExposureNote,
} from './services/exposure.ts';
import { dataPage, type DataTab } from './views/data.ts';
import { mediaPage } from './views/media.ts';
import { advancedPage, streamPage } from './views/stream.ts';
import { crewAddPanel, crewPanel } from './views/crew.ts';
import { setCrew } from './services/crew.ts';
import { packsPage } from './views/packs.ts';
import { addSay, resolveReview } from './services/review.ts';
import { activePacks, disablePack, enablePack } from './services/packs.ts';
import { addStats, createPost, deletePost, setAccount } from './services/media.ts';
import { html, type Safe } from './views/html.ts';
import { layout } from './views/layout.ts';
import { overviewPage } from './views/overview.ts';
import { taskPanel } from './views/tasks.ts';
import { oldPath, SECTIONS, tabLabel, type SectionKey } from './views/routes.ts';
import { loginPage, settingsHome, settingsPage, type SettingsTab } from './views/settings.ts';
import { teamPage, type TeamTab } from './views/team.ts';
import { tasksPage, type TaskTab } from './views/tasks.ts';

const ROOT = join(import.meta.dirname, '..');
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
};
const STATIC: Record<string, { body: Buffer; type: string }> = {};
for (const name of readdirSync(join(ROOT, 'public'))) {
  const type = MIME[extname(name).toLowerCase()];
  if (!type || !statSync(join(ROOT, 'public', name)).isFile()) continue;
  STATIC[name] = { body: readFileSync(join(ROOT, 'public', name)), type };
}
const ASSET_VERSION = createHash('sha1').update(Object.values(STATIC).map((s) => s.body).join('')).digest('hex').slice(0, 10);

type Ctx = {
  req: IncomingMessage; res: ServerResponse; url: URL; params: string[];
  /** 默认是 JSON 对象。声明了 `body: 'array' | 'either'` 的路由，运行期可能是数组本身
   *  （`/api/usage`、`PUT /api/executors`），读之前先 `Array.isArray(...)` 判一下。 */
  body: Record<string, unknown>; auth: 'bearer' | 'cookie' | 'off' | null;
};
type Result =
  | { json: unknown; status?: number }
  | { html: string; status?: number }
  | { redirect: string; cookie?: string }
  | { text: string; type: string; filename?: string }
  | { bytes: Buffer; type: string; filename: string };
type Handler = (c: Ctx) => Result | Promise<Result>;
/** 043：请求体收什么形状，由路由自己声明，解析器不再替谁猜。
 *  object（默认）只收 JSON 对象；array 只收数组；either 两种都收。 */
type BodyKind = 'object' | 'array' | 'either';
type Route = { method: string; re: RegExp; handler: Handler; public?: boolean; page?: boolean; human?: boolean; body?: BodyKind };

const routes: Route[] = [];
const on = (method: string, path: string, handler: Handler, opts: { public?: boolean; page?: boolean; human?: boolean; body?: BodyKind } = {}) => {
  routes.push({ method, re: new RegExp(`^${path.replace(/:[a-z]+/g, '([^/]+)')}$`), handler, ...opts });
};
const idOf = (c: Ctx, i = 0) => {
  const n = Number(c.params[i]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'id 不合法');
  return n;
};
/** 044：手动选过的主题（cookie wb_theme）。没选过就跟随系统，返回空。 */
const themeOf = (req: IncomingMessage): '' | 'light' | 'dark' => {
  const m = /(?:^|;\s*)wb_theme=(light|dark)(?:;|$)/.exec(req.headers.cookie ?? '');
  return m ? (m[1] as 'light' | 'dark') : '';
};
const sideCollapsed = (req: IncomingMessage) => /(?:^|;\s*)wb_side=collapsed(?:;|$)/.test(req.headers.cookie ?? '');
const page = (c: Ctx, title: string, section: SectionKey, tab: string | undefined, body0: Safe): Result => ({
  // 044 v3：任务页自己会画抽屉；其他页带 ?task= 时在页面末尾补上详情面板。
  html: layout({ title, section, tab, body: section === 'tasks' ? body0 : html`${body0}${taskPanel(c.url.searchParams, c.url.pathname)}`, assetVersion: ASSET_VERSION, collapsed: sideCollapsed(c.req), theme: themeOf(c.req) }),
});
const actor = (c: Ctx) => (c.auth === 'bearer' ? String(c.body.actor ?? c.url.searchParams.get('actor') ?? 'system') : 'me');

// ---------- pages ----------
// 016: five top-level pages, each with segment tabs addressed by path. Old query/fragment
// addresses are redirected (fragments by public/app.js) so links already sent keep working.
type Section = Exclude<SectionKey, 'today'>;
function sectionRoute(c: Ctx, section: Section, raw: string | null, render: (tab: string) => Safe): Result {
  const old = oldPath(c.url);
  if (old) return { redirect: old };
  const tab = raw ?? SECTIONS[section][0];
  if (!SECTIONS[section].includes(tab)) return { redirect: `/${section}` };
  const name = section === 'tasks' ? '任务' : section === 'team' ? '剧组' : section === 'data' ? '记录' : '设置';
  // 044 v3：顶栏只写这一层叫什么；第一层就是区名，往下一层才是「某一类」。
  return page(c, tab === SECTIONS[section][0] && section !== 'settings' ? name : tabLabel(tab), section, tab, render(tab));
}
const baseUrlOf = (c: Ctx) => `${(c.req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'}://${c.req.headers.host ?? 'localhost:3200'}`;

on('GET', '/', (c) => {
  const old = oldPath(c.url);
  if (old) return { redirect: old };
  // 061.1：首页是一条流。原来的四行首页还在 /?view=classic，旧的分组地址（/?g=you 之类）照旧打开它。
  const q = c.url.searchParams;
  if (q.get('view') === 'classic' || q.has('g')) return page(c, '工作台', 'today', undefined, overviewPage(q));
  // 061.2：首页带 ?task= 时，那件事在右边（手机上盖上来）以线程打开，不再滑旧抽屉。
  const open = Number(q.get('task')) ? getTask(Number(q.get('task'))) : undefined;
  // 064：点头像 / 点「＋」——那位执行者（或「请谁进来」）在同一个位置打开。
  const who = open ? '' : (q.get('crew') ?? '');
  const side = who === 'add' ? crewAddPanel() : who ? crewPanel(who) : null;
  return { html: layout({ title: open ? open.title : '工作台', section: 'today', body: streamPage(Date.now(), open, side, themeOf(c.req)), assetVersion: ASSET_VERSION, theme: themeOf(c.req) }) };
}, { page: true });
on('GET', '/advanced', (c) => page(c, '高级', 'today', undefined, advancedPage()), { page: true });
on('GET', '/tasks', (c) => sectionRoute(c, 'tasks', null, (tab) => tasksPage(c.url.searchParams, tab as TaskTab).body), { page: true });
on('GET', '/tasks/:tab', (c) => sectionRoute(c, 'tasks', c.params[0], (tab) => tasksPage(c.url.searchParams, tab as TaskTab).body), { page: true });
on('GET', '/team', (c) => sectionRoute(c, 'team', null, (tab) => teamPage(c.url.searchParams, tab as TeamTab)), { page: true });
on('GET', '/team/:tab', (c) => sectionRoute(c, 'team', c.params[0], (tab) => teamPage(c.url.searchParams, tab as TeamTab)), { page: true });
// 055.1：自媒体数据看板。?p=平台 是第二层。
on('GET', '/media', (c) => page(c, '自媒体', 'media', 'media', mediaPage(c.url.searchParams)), { page: true });
on('POST', '/api/media/posts', (c) => ({ json: { post: createPost(c.body, actor(c)) } }));
on('POST', '/api/media/posts/:id/stats', (c) => ({ json: { stat: addStats(idOf(c), c.body, actor(c)) } }));
on('DELETE', '/api/media/posts/:id', (c) => { deletePost(idOf(c), actor(c)); return { json: { ok: true } }; }, { human: true });
on('POST', '/api/media/accounts', (c) => { setAccount(c.body, actor(c)); return { json: { ok: true } }; });
on('GET', '/data', (c) => sectionRoute(c, 'data', null, (tab) => dataPage(c.url.searchParams, tab as DataTab)), { page: true });
on('GET', '/data/:tab', (c) => sectionRoute(c, 'data', c.params[0], (tab) => dataPage(c.url.searchParams, tab as DataTab)), { page: true });
// 044 v3：/settings 是设置的第一层（一行一类），点进去才是某一类。
on('GET', '/settings', (c) => {
  const old = oldPath(c.url);
  if (old) return { redirect: old };
  return page(c, '设置', 'settings', '__home', settingsHome());
}, { page: true });
on('GET', '/settings/:tab', (c) => sectionRoute(c, 'settings', c.params[0], (tab) => settingsPage(baseUrlOf(c), tab as SettingsTab, sideCollapsed(c.req))), { page: true });

// ---------- installable app (PWA) ----------
on('GET', '/manifest.webmanifest', () => ({
  text: JSON.stringify({
    name: '我的工作台',
    short_name: '工作台',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F4F4F0',
    theme_color: '#1E5B4A',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/static/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2),
  type: 'application/manifest+json',
}), { public: true });
on('GET', '/sw.js', () => ({ text: STATIC['sw.js'].body.toString('utf8'), type: 'text/javascript; charset=utf-8' }), { public: true });

on('GET', '/login', () => ({ html: loginPage(passwordProblem() || undefined) }), { public: true });
on('POST', '/login', (c) => {
  const ip = c.req.socket.remoteAddress ?? '?';
  const problem = passwordProblem();
  if (problem) return { html: loginPage(problem), status: 503 };
  if (loginBlocked(ip)) return { html: loginPage('尝试次数太多，请 10 分钟后再试'), status: 429 };
  // Only WB_PASSWORD logs a person in; the script token no longer works here.
  if (!checkPassword(String(c.body.password ?? ''))) { loginFailed(ip); return { html: loginPage('密码不对'), status: 401 }; }
  loginOk(ip);
  const id = createSession();
  return { redirect: '/', cookie: sessionCookieFor(id, c.req.headers['x-forwarded-proto'] === 'https') };
}, { public: true });
on('POST', '/logout', (c) => {
  destroySession(sessionIdOf(c.req));
  return { json: { ok: true }, cookie: clearCookie } as Result & { cookie: string };
});

// ---------- API ----------
on('GET', '/api/health', () => ({ json: { ok: true } }), { public: true });
// v 还是那个版本号（谁变了谁刷新）；bot 是顺路带回来的角色快照，只读两个计数，
// 让角色不必自己再开一条轮询——页面不可见时 app.js 本来就不轮询了。
on('GET', '/api/pulse', () => ({ json: { v: pulse(), bot: botSnapshot() } }));

on('GET', '/api/tasks', (c) => {
  const q = c.url.searchParams;
  return { json: listTasks({ status: q.get('status')?.split(',').filter(Boolean), executor: q.get('executor') ?? undefined, category: q.get('category') ?? undefined, limit: Number(q.get('limit')) || undefined }) };
});
on('POST', '/api/tasks', (c) => {
  const body = (c.body ?? {}) as Record<string, unknown>;
  projectFromBody(body);
  // 042: 表单里第一项「让大脑选」不传执行者，传的是这个记号——任务先落在「我」名下等大脑派。
  // 大脑关着时表单不显示这一项，但接口被直接调用也要拒：关着就是关着。
  if (String(body.executor ?? '') === '__brain') {
    if (!brainState().on) throw new HttpError(400, '调度大脑关着，先到设置里打开，或者直接选一个执行者');
    body.executor = 'me';
    body.route = 'brain';
    body.status = 'inbox';
  }
  // 025: 派给 Agent 却没选项目，执行器连文件夹都找不到，进队列只会立刻失败。
  assertProjectForAgent(String(body.executor ?? 'me'), String(body.project ?? ''));
  const task = createTask(body, actor(c));
  const unknown = unknownProjectWarning(task.executor, task.project);
  return { json: unknown ? { ...task, warning: unknown } : task, status: 201 };
});
// 044：工作台顶上那一行说明，点「知道了」就不再出现。
on('POST', '/api/settings/hint-closed', () => { setSetting('wb_hint_closed', '1'); return { json: { ok: true } }; }, { human: true });
// 044：顶部一句话派活。只收「做什么 / 哪个项目 / 只要回答」，执行者不在这里选：
// 大脑开着就交给大脑，关着就用规则推荐（和新建任务表单里那句「建议：…」是同一个推荐）。
/** 061：一句话派活。派活框、包的按钮都走这里。 */
function quickTask(body: Record<string, unknown>, who: string): Task {
  let title = String(body.title ?? '').trim();
  // 061：派活框只有一行。「@名字」= 指定谁来做（名字或代号都行），从这句话里拿掉。
  const at = /(?:^|\s)@([^\s@]{1,20})/.exec(title);
  if (at && !body.pick_executor) {
    const want = at[1].toLowerCase();
    const hit = Object.keys(EXECUTORS).find((k) => k !== 'me' && (k === want || execLabel(k).toLowerCase() === want));
    if (hit) { body.pick_executor = hit; title = title.replace(at[0], ' ').replace(/\s+/g, ' ').trim(); }
  }
  if (!title) throw new HttpError(400, '先写一句让它做什么');
  projectFromBody(body);
  // 061：不选项目就用上一次用的那个；没有就用执行器报上来的第一个。
  if (!String(body.project ?? '').trim()) {
    const known = latestRunnerMeta().projects ?? [];
    const last = (db().prepare("SELECT project FROM tasks WHERE project != '' ORDER BY id DESC LIMIT 1").get() as { project: string } | undefined)?.project;
    body.project = last && (!known.length || known.includes(last)) ? last : (known[0] ?? '');
  }
  const project = String(body.project ?? '').trim();
  const answerOnly = body.answer_only === true || body.answer_only === '1' || body.answer_only === 'on';
  const category = String(body.category ?? '') || 'dev';
  const description = String(body.description ?? '').slice(0, 4000);
  const chosen = String(body.pick_executor ?? body.executor ?? '').trim();
  const input: Record<string, unknown> = { title: title.slice(0, 300), project, answer_only: answerOnly ? 1 : 0, category, description };
  if (chosen) {
    // 「更多选项」里指定了人：照办，不再问大脑或规则。
    input.executor = chosen;
  } else if (brainState().on) {
    Object.assign(input, { executor: 'me', route: 'brain', status: 'inbox' });
  } else {
    const pick = suggestExecutor(category).executor;
    if (!pick) throw new HttpError(400, '现在没有能接活的执行者：先到剧组里打开一个，或者用「更多选项」派给自己');
    input.executor = pick;
  }
  if (!project && input.executor !== 'me') throw new HttpError(400, '选一个项目：它得知道去哪个文件夹干活');
  if (!project && input.route === 'brain') throw new HttpError(400, '选一个项目：它得知道去哪个文件夹干活');
  const task = createTask(input, who);
  // 062：谁来审。默认大脑 / 规则挑一位不是干活的；只读的活、派给自己的活不审。大脑派的活等派定了人再挑（见 routeTask）。
  if (!answerOnly && input.executor !== 'me') {
    const pick = resolveReview(body.reviewer, String(input.executor), runnerExecutors());
    if (pick.who) db().prepare('UPDATE tasks SET reviewer = ?, review_why = ? WHERE id = ?').run(pick.who, pick.why, task.id);
  } else if (input.route === 'brain' && !answerOnly) {
    db().prepare('UPDATE tasks SET reviewer = ? WHERE id = ?').run(String(body.reviewer ?? 'auto') === 'none' ? '' : String(body.reviewer ?? 'auto').slice(0, 40), task.id);
  }
  return getTask(task.id)!;
}
on('POST', '/api/tasks/quick', (c) => ({ json: quickTask((c.body ?? {}) as Record<string, unknown>, actor(c)), status: 201 }));
// 060.2：包。启用 / 关闭 / 点按钮都只许人点；按钮派出去的是一件普通的事，走正常的点头。
on('GET', '/advanced/packs', (c) => page(c, '包', 'today', undefined, packsPage()), { page: true });
on('POST', '/api/packs/:name/enable', (c) => ({ json: enablePack(String(c.params[0]), String(c.body?.hash ?? ''), 'me') }), { human: true });
on('POST', '/api/packs/:name/disable', (c) => { disablePack(String(c.params[0]), 'me'); return { json: { ok: true } }; }, { human: true });
on('POST', '/api/packs/:name/actions/:id', (c) => {
  const pack = activePacks().find((p) => p.name === String(c.params[0]));
  const act = pack?.actions[Number(c.params[1])];
  if (!pack || !act) throw new HttpError(404, '这个包没启用，或者没有这个按钮');
  // {输入} 只填你当场敲的字：去掉看不见的字符，压成一行，限长。
  const typed = String(c.body?.input ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (act.input === 'required' && !typed) throw new HttpError(400, '先写一句');
  const body: Record<string, unknown> = { title: typed ? `${act.label}：${typed}`.slice(0, 120) : act.label, description: act.prompt.replaceAll('{输入}', typed) };
  if (act.executor !== 'any') body.pick_executor = act.executor;
  const task = quickTask(body, 'me');
  logEvent({ actor: 'me', kind: 'pack.action', task_id: task.id, text: `用包「${pack.label}」的按钮「${act.label}」派了 T-${task.id}` });
  return { json: task, status: 201 };
}, { human: true });
on('GET', '/api/tasks/:id', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, '没有这个任务');
  return { json: { ...t, approvals: listApprovals({ task_id: t.id }), events: listEvents({ task_id: t.id }) } };
});
on('PATCH', '/api/tasks/:id', (c) => {
  const body = (c.body ?? {}) as Record<string, unknown>;
  projectFromBody(body);
  const before = getTask(idOf(c));
  const task = updateTask(idOf(c), body, actor(c));
  // 029: 合并/推送失败是执行器用 PATCH 标的，这种失败最需要人回来看——也推。
  // 只有「状态真的变了」才推，改个标题不该发消息。
  const settled = task.status === 'failed' || task.status === 'done';
  if (settled && before?.status !== task.status) void notifyTaskResult(task.id).catch(() => 0);
  return { json: task };
});
on('DELETE', '/api/tasks/:id', (c) => { deleteTask(idOf(c), actor(c)); return { json: { ok: true } }; }, { human: true });

on('GET', '/api/approvals', (c) => ({
  json: listApprovals({
    status: c.url.searchParams.get('status') ?? undefined,
    // The runner asks for one task's approvals; ignoring the filter made it act on another
    // task's merge approval (?task= was silently dropped).
    task_id: Number(c.url.searchParams.get('task')) || undefined,
  }),
}));
on('POST', '/api/approvals', (c) => {
  const a = createApproval(c.body);
  void notifyApproval(a); // fire and forget; a missing channel must not fail the hook
  return { json: a, status: 201 };
});
on('GET', '/api/approvals/:id', (c) => {
  const a = getApproval(idOf(c));
  if (!a) throw new HttpError(404, '没有这条审批');
  return { json: a };
});
on('POST', '/api/approvals/:id/decide', (c) => ({ json: decideApproval(idOf(c), c.body.decision, c.body.feedback, actor(c) === 'system' ? 'me' : actor(c)) }), { human: true });
on('POST', '/api/approvals/:id/expire', (c) => ({ json: expireApproval(idOf(c)) }));

on('POST', '/api/hooks/claude', (c) => ({ json: handleClaudeHook(c.body) }));

// 043：这个接口明确收数组（批量上报），也兼容老调用方发 { records: [...] }。
on('POST', '/api/usage', (c) => ({
  json: ingestUsage(Array.isArray(c.body) ? c.body : (c.body as Record<string, unknown>).records),
}), { body: 'either' });
on('GET', '/api/stats', (c) => ({ json: periodStats([7, 14, 30].includes(Number(c.url.searchParams.get('days'))) ? Number(c.url.searchParams.get('days')) : 14) }));

// 041: 战绩。执行器（042 的大脑）用 Bearer 读，所以鉴权和别的接口一样走默认那道门。
on('GET', '/api/scorecard', (c) => {
  const raw = Number(c.url.searchParams.get('days') ?? 30);
  return { json: scorecard({ days: Number.isFinite(raw) && raw > 0 ? raw : 30 }) };
});

// 045: 能力档案——评测先验 + 自己近 90 天的战绩，按「框架 + 模型 + 分类」。先验文件校验不过就明说，不悄悄少给。
on('GET', '/api/capabilities', () => {
  try { return { json: capabilities() }; } catch (e) { throw new HttpError(500, e instanceof Error ? e.message : '能力先验读不出来'); }
});

on('GET', '/api/accounts', () => ({ json: listAccounts() }));
on('PUT', '/api/accounts/:name', (c) => ({ json: upsertAccount(decodeURIComponent(c.params[0]), c.body) }));
on('DELETE', '/api/accounts/:name', (c) => { deleteAccount(decodeURIComponent(c.params[0])); return { json: { ok: true } }; });

on('GET', '/api/machines', () => ({ json: listMachines() }));
on('POST', '/api/machines/:name/heartbeat', (c) => { heartbeat(decodeURIComponent(c.params[0]), c.body); return { json: { ok: true } }; });
on('DELETE', '/api/machines/:name', (c) => { deleteMachine(decodeURIComponent(c.params[0])); return { json: { ok: true } }; });

on('GET', '/api/rules', () => ({ json: listRules() }));
on('POST', '/api/connectors/cliproxyapi/run', async () => {
  if (!connectorEnabled()) throw new HttpError(400, '连接器未启用：在 .env 里设置 CPA_URL 和 CPA_MANAGEMENT_KEY');
  return { json: await runCycle() };
});
on('GET', '/api/connectors/cliproxyapi', () => ({ json: { enabled: connectorEnabled(), poll_seconds: pollSeconds(), ...connectorState() } }));
on('POST', '/api/connectors/deepseek/run', async () => {
  if (!balanceEnabled()) throw new HttpError(400, '余额连接器未启用：在 .env 里设置 DEEPSEEK_API_KEY');
  return { json: await runBalances() };
});
on('GET', '/api/connectors/deepseek', () => ({ json: { enabled: balanceEnabled(), ...balanceState('deepseek') } }));
on('POST', '/api/connectors/glm/run', async () => {
  if (!glmEnabled()) throw new HttpError(400, 'GLM 连接器未启用：在 .env 里设置 ZAI_API_KEY');
  return { json: await runBalances() };
});
on('GET', '/api/connectors/glm', () => ({ json: { enabled: glmEnabled(), region: process.env.ZAI_REGION ?? 'cn', ...glmState() } }));

// ---- 007: dispatch, gates, push ----
on('GET', '/api/executors', () => ({ json: listExecutorSettings() }));
// 043：一次改多个执行者就发数组，改一个发对象，两种形状都收（saveExecutorSettings 自己分）。
on('PUT', '/api/executors', (c) => ({ json: saveExecutorSettings(c.body) }), { human: true, body: 'either' });
on('GET', '/api/dispatch/suggest', (c) => ({ json: suggestExecutor(
  c.url.searchParams.get('category') ?? undefined,
  // 017: the runner pins the executor it already claimed, to get that one's model hint.
  c.url.searchParams.get('executor') ?? undefined,
) }));
on('GET', '/api/dispatch/state', () => ({ json: { auto_paused: autoPaused(), public_url: getSetting('public_url') } }));
on('POST', '/api/dispatch/auto-paused', (c) => {
  // Pausing is always safe, so a token may do it; resuming needs a person.
  if (c.body?.paused === false && c.auth === 'bearer') throw new HttpError(403, '这个操作只能在网页上做');
  const paused = setAutoPaused(Boolean(c.body?.paused));
  void notify({ title: paused ? '已暂停所有自动执行' : '已恢复自动执行', link: getSetting('public_url') ? `${getSetting('public_url').replace(/\/+$/, '')}/` : '' });
  return { json: { auto_paused: paused } };
});
on('POST', '/api/dispatch/public-url', (c) => {
  const url = String(c.body?.url ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, '地址需要以 http(s):// 开头');
  setSetting('public_url', url.replace(/\/+$/, ''));
  return { json: { public_url: url } };
}, { human: true });
// 042: 调度大脑。开关和上限只有人能动；待派列表和执行器回话走 Bearer。
// 大脑跑在执行器上（用本机密钥），这里只发材料、收结果、再校验。
on('POST', '/api/settings/dispatch-brain', (c) => ({ json: saveBrainSettings((c.body ?? {}) as Record<string, unknown>, actor(c)) }), { human: true });
on('GET', '/api/route/pending', () => ({ json: pendingRoutes() }));
on('POST', '/api/tasks/:id/route', (c) => ({ json: routeTask(idOf(c), (c.body ?? {}) as Record<string, unknown>) }));
// 028: 结果要不要回写 Issue 由人来定（默认关），因为模型的回答里可能引用文件内容。
on('POST', '/api/settings/issue-result', (c) => {
  const raw = c.body?.on;
  const on = raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true';
  setSetting('issue_result_comment', on ? '1' : '0');
  return { json: { on } };
}, { human: true });
// 044：简洁版 / 完整版已取消（只是少了点东西，还会吞东西）。老脚本还在调这个接口时给一句明白话，而不是假装成功。
on('POST', '/api/ui-mode', () => { throw new HttpError(410, '简洁版已取消，现在只有一种界面'); }, { human: true });
// 029: 任务完成要不要也推一条。默认关——完成是常态，推多了就没人看了。
on('POST', '/api/settings/notify-done', (c) => {
  const raw = c.body?.on;
  const on = raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true';
  setSetting('notify_task_done', on ? '1' : '0');
  return { json: { on } };
}, { human: true });
// 055.2: 任务停在「等你选」要不要推一条。默认关，跟「完成也推」一样由你决定。
on('POST', '/api/settings/notify-ask', (c) => {
  const raw = c.body?.on;
  const on = raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true';
  setSetting('notify_task_ask', on ? '1' : '0');
  return { json: { on } };
}, { human: true });
// 039: 只改 docs/ 的合并审批自动通过。默认开；关掉就是全人工，和以前一样。
on('POST', '/api/settings/auto-approve-docs', (c) => {
  const raw = c.body?.on;
  const on = raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true';
  setSetting('auto_approve_docs', on ? '1' : '0');
  logEvent({ actor: 'me', kind: 'settings.auto_approve', text: on ? '打开「只改文档的合并自动通过」' : '关掉「只改文档的合并自动通过」' });
  return { json: { on } };
}, { human: true });
// 027: 「试一个」——只读任务，项目取执行器报的第一个，执行者取在线的那个。不改任何文件。
on('POST', '/api/tasks/first-run', (c) => {
  const projects = latestRunnerMeta().projects ?? [];
  const online = [...runnerExecutors()][0] ?? '';
  if (!projects.length) throw new HttpError(400, '还没有可用的项目：先运行 npm run setup，或在执行器配置里写上 projects');
  if (!online) throw new HttpError(400, `执行器没在线：先启动执行器（${RUNNER_CMD}）`);
  const task = createTask({
    title: '阅读项目 README，分析项目的主要功能',
    description: '只读任务：读 README 和主要文档，用中文说清楚这个项目是做什么的、有哪几块功能。不要改任何文件，也不要跑会改文件的命令。',
    category: 'dev',
    executor: online,
    project: projects[0],
    answer_only: 1, // 043 F：这一单的成果就是回答
  }, actor(c));
  updateTask(task.id, { start_requested: 1, mode: 'manual', step: '已请求开始，等执行器领取' }, actor(c));
  return { json: { id: task.id }, status: 201 };
}, { human: true });
// 008: the runner asks here; a paused switch means "nothing to do" (204).
on('GET', '/api/runner/next', (c) => {
  const execs = (c.url.searchParams.get('executors') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const runnerId = (c.url.searchParams.get('runner') ?? 'runner').slice(0, 80);
  const notReady = (c.url.searchParams.get('not_ready') ?? '').split(',').filter(Boolean);
  const busyCoding = [...new Set((c.url.searchParams.get('busy') ?? '').split(',').map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  const task = claimTask(execs, runnerId, notReady, busyCoding);
  if (task) void commentOnTask(task, `执行器已开始干活（T-${task.id}）。`);
  // 045：顺手带上这个执行者能用的账号槽（排好序，执行器取第一个）。只有目录名，没有凭据。
  const slots = task ? orderedSlots(task.executor).map((s) => ({ name: s.name, slot_dir: s.slot_dir })) : [];
  // 055.2：你回答过提问、回答还没被取走，就告诉执行器这次是接着干（它再来 POST /resume 取回答）。
  // 062：这件事是在审别人的——告诉执行器被审的是哪条分支，它会把改动写成补丁文件递进去。
  const reviewBranch = task?.review_of ? String(getTask(task.review_of)?.branch ?? '') : '';
  return task ? { json: { ...task, slots, resume: hasAnswered(task.id), ...(/^wb\/T-\d+(-\d{1,2})?$/.test(reviewBranch) ? { review_branch: reviewBranch } : {}) } } : { json: null, status: 204 };
});
on('GET', '/api/runner/slots', (c) => ({
  json: orderedSlots(String(c.url.searchParams.get('executor') ?? '')).map((s) => ({ name: s.name, slot_dir: s.slot_dir })),
}));
on('GET', '/api/tasks/:id/runs', (c) => ({ json: listRuns(idOf(c)) }));
on('GET', '/api/slots', () => ({ json: listSlots() }));
// 045：加槽、改槽是改设置——只能在网页上点（008.3 的权限分层）。
on('POST', '/api/slots', (c) => ({ json: createSlot((c.body ?? {}) as Record<string, unknown>, actor(c)), status: 201 }), { human: true });
on('PUT', '/api/slots/:name', (c) => ({ json: updateSlot(decodeURIComponent(String(c.params[0] ?? '')), (c.body ?? {}) as Record<string, unknown>, actor(c)) }), { human: true });
// 055.2 · 提问卡片。执行器把 agent 末尾的 wb-ask 报上来（和 finish 一样，令牌或会话都能调）；
// 报上来的内容服务端重新校验，不合格返回 400，执行器就当没有提问、走普通收尾。
on('POST', '/api/runner/tasks/:id/ask', (c) => {
  const a = openAsk(idOf(c), (c.body ?? {}) as Record<string, unknown>);
  void notifyTaskAsk(a.task_id).catch(() => 0); // 默认关；开了才推，去重在里面
  return { json: { ok: true, ask_id: a.id, task_id: a.task_id } };
});
// 执行器领到「resume: true」的任务后来取回答；只取一次，取走就空了。
on('POST', '/api/runner/tasks/:id/resume', (c) => ({ json: { resume: takeResume(idOf(c)) } }));
// 回答只有登录会话能做：agent 手里的令牌不能替人选。
on('POST', '/api/tasks/:id/answer', (c) => {
  const r = answerAsk(idOf(c), (c.body ?? {}) as Record<string, unknown>, actor(c));
  return { json: { ok: true, id: r.task.id, status: r.task.status } };
}, { human: true });
on('GET', '/api/tasks/:id/asks', (c) => ({ json: listAsks(idOf(c)) }));
on('POST', '/api/runner/tasks/:id/progress', (c) => ({ json: reportProgress(idOf(c), c.body ?? {}) }));
on('POST', '/api/runner/tasks/:id/finish', (c) => {
  const r = finishTask(idOf(c), (c.body ?? {}) as any);
  // 046.8：重发的同一次收尾：已经处理过，不再推送、不再回写 Issue。
  if ((r as any).duplicate) return { json: { ok: true, task_id: r.task.id, status: r.task.status, approval_id: null, duplicate: true } };
  if (r.approval_id) void notifyApproval(getApproval(r.approval_id));
  // 029: 失败必推、完成看开关；去重和每天上限都在 notifyTaskResult 里。
  void notifyTaskResult(r.task.id).catch(() => 0);
  const body = (c.body ?? {}) as any;
  // 028: 结果回写 Issue 默认关——模型的回答里可能引用文件内容，要不要给决策端看得人来定。
  const withResult = getSetting('issue_result_comment') === '1' ? String(r.task.result_text ?? '') : '';
  void commentOnTask(r.task, r.task.status === 'done'
    ? finishComment(r.task, String(body.summary ?? ''), String(body.diff_stat ?? ''), String(body.tests ?? ''), withResult)
    : `T-${r.task.id} 执行失败：${String(body.summary ?? '').slice(0, 300)}`);
  // 035 E：失败的任务不自动重试，但要让决策端看见「它做不动」。
  if (r.task.status === 'failed') void reportToIssue(r.task).catch(() => false);
  return { json: { ok: true, task_id: r.task.id, status: r.task.status, approval_id: r.approval_id ?? null } };
});
// 012.2: the runner reports the commit only after the push really landed; the issue learns it here.
on('POST', '/api/runner/tasks/:id/pushed', (c) => {
  const task = getTask(idOf(c));
  if (!task) throw new HttpError(404, `没有任务 T-${idOf(c)}`);
  const commit = String((c.body ?? {}).commit ?? '').trim().slice(0, 40);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new HttpError(400, 'commit 要是 7–40 位十六进制的提交号');
  void commentOnTask(task, pushComment(task, commit, String((c.body ?? {}).branch ?? task.branch ?? '').slice(0, 120)));
  // 035 D：自己开发自己的任务，结果前 1500 字回到固定的 wb-selfdev Issue（028 已打码）。
  void reportToIssue({ ...task, merged_commit: commit }).catch(() => false);
  return { json: { ok: true } };
});
on('POST', '/api/runner/heartbeat', (c) => ({ json: runnerHeartbeat(String(c.body?.runner ?? c.body?.id ?? ''), c.body?.meta) }));
function githubRunnerOnly(c: Ctx): void {
  if (c.auth !== 'bearer') throw new HttpError(403, 'GitHub 转发只接受执行器令牌');
}
on('POST', '/api/runner/github/inbox', (c) => {
  githubRunnerOnly(c);
  const { kind, repo, items, text, error } = c.body;
  if (kind === 'issues' && typeof repo === 'string' && Array.isArray(items)) return { json: importIssues(repo, items) };
  if (kind === 'queue' && typeof repo === 'string' && (typeof text === 'string' || typeof error === 'string')) {
    return { json: importQueue(repo, typeof text === 'string' ? text : '', typeof error === 'string' ? error : '') };
  }
  if (kind === 'status' && typeof error === 'string') {
    recordGithubSync(error);
    return { json: { ok: true } };
  }
  throw new HttpError(400, 'GitHub 转发数据格式不对');
});
on('GET', '/api/runner/github/outbox', (c) => {
  githubRunnerOnly(c);
  return { json: { repos: githubRepos(), self_repo: selfRepo(), job: c.url.searchParams.has('peek') ? null : claimGithubJob() } };
});
on('POST', '/api/runner/github/outbox/:id', (c) => {
  githubRunnerOnly(c);
  const ok = finishGithubJob(idOf(c), c.body, (job, result) => {
    if (job.kind === 'digest') recordDigestDelivery(job, result);
    if (job.kind === 'selfdev') recordSelfdevDelivery(job, result);
  });
  if (!ok) throw new HttpError(409, '这条回写已处理或领取已失效');
  return { json: { ok } };
});
// 035.3：部署成功后、退出之前，执行器在这里登记「我要走了，接下来该有一个新的接班」。
// 页面据此显示「等待新执行器接班」；新进程的第一跳心跳会把它撤掉，5 分钟没等到就提醒人。
on('POST', '/api/runner/handoff', (c) => ({
  json: expectHandoff({
    runner: String(c.body?.runner ?? ''),
    pid: Number(c.body?.pid),
    code_hash: String(c.body?.code_hash ?? ''),
    // 035.3.3：部署完执行器就退出了，跑完那一步的进程不在了；把任务 id 记在交接上，
    // 等新执行器接班（或者超时没人接班）时由服务端给任务结账。
    task_id: Number(c.body?.task_id),
  }),
}));
on('GET', '/api/runners', () => ({ json: listRunners() }));
// 030: 新建 / 克隆项目、关联远端。**只有登录会话能调**（human）——脚本令牌可以让 agent
// 给自己加项目，那等于让它扩大自己的地盘。
on('POST', '/api/projects', (c) => ({ json: createProjectRequest(c.body ?? {}, actor(c)), status: 201 }), { human: true });
on('GET', '/api/projects/requests', () => ({ json: listProjectRequests() }));
// 执行器轮询：一次领一条，领走就标 running。
on('GET', '/api/runner/project-request', () => ({ json: nextProjectRequest() }));
on('POST', '/api/runner/project-request/:id/finish', (c) => {
  const id = Number(c.params[0]) || 0;
  return { json: finishProjectRequest(id, c.body?.ok === true, String(c.body?.message ?? '')) };
});
// 031a: 执行器每次扫描上报分支与 worktree，这里回一份「删哪些、报哪些」的计划。
// 策略在服务端（它知道哪些任务还在跑），执行 git 的只有执行器。
on('POST', '/api/runner/branches', (c) => {
  const project = String(c.body?.project ?? '').slice(0, 120);
  if (!project) throw new HttpError(400, '缺少项目名');
  const plan = reportScan(project, {
    branches: Array.isArray(c.body?.branches) ? c.body.branches : [],
    worktrees: Array.isArray(c.body?.worktrees) ? c.body.worktrees : [],
    activeTaskIds: activeTaskIds(),
    requests: deleteRequests(),
  });
  if (plan.report.length) void notifyStaleBranches().catch(() => 0);
  return { json: plan };
});
on('POST', '/api/runner/branches/done', (c) => {
  const project = String(c.body?.project ?? '').slice(0, 120);
  finishCleanup(project, Array.isArray(c.body?.cleaned) ? c.body.cleaned.map(String) : [], Array.isArray(c.body?.failed) ? c.body.failed : []);
  return { json: { ok: true } };
});
on('POST', '/api/branches/:id/snooze', (c) => { snoozeBranch(idOf(c)); return { json: { ok: true } }; });
on('POST', '/api/branches/:id/delete', (c) => ({ json: requestDelete(idOf(c)) }));
// 031c: 项目备忘。执行器开工前取「确认过的笔记」（用它拼提示），收工后把自己建议的报上来。
// 两条都只碰 confirmed/unverified，**没有**「脚本直接确认」的入口——确认只能在网页上点。
on('GET', '/api/runner/notes', (c) => {
  const project = String(c.url.searchParams.get('project') ?? '').slice(0, 120);
  if (!project) throw new HttpError(400, '缺少项目名');
  return { json: notesForPrompt(project, String(c.url.searchParams.get('title') ?? '').slice(0, 300),
    String(c.url.searchParams.get('description') ?? '').slice(0, 2000)) };
});
on('POST', '/api/runner/notes', (c) => {
  const project = String(c.body?.project ?? '').slice(0, 120);
  if (!project) throw new HttpError(400, '缺少项目名');
  const list = Array.isArray(c.body?.suggestions) ? c.body.suggestions : [];
  const taskId = Number(c.body?.task_id) || null;
  // 执行器已经截到 3 条，这里再兜一次：接口是公开的脚本口子，不能信客户端。
  // 同一个任务号只收一次，重复上报整批忽略并记审计（031c.1）。
  const added = addSuggestionsForTask(project, taskId, list.map(String));
  return { json: { ok: true, added } };
});
on('GET', '/api/notes', (c) => {
  const project = String(c.url.searchParams.get('project') ?? '').slice(0, 120);
  if (!project) throw new HttpError(400, '缺少项目名');
  return { json: listProjectNotes(project) };
}, { human: true });
on('POST', '/api/notes', (c) => {
  const project = String(c.body?.project ?? '').slice(0, 120);
  if (!project) throw new HttpError(400, '缺少项目名');
  const row = addNote({ project, text: String(c.body?.text ?? '') }, actor(c));
  if (!row) throw new HttpError(400, '备忘不能为空');
  return { json: row };
}, { human: true });
on('PATCH', '/api/notes/:id', (c) => ({ json: updateNote(idOf(c), String(c.body?.text ?? ''), actor(c)) }), { human: true });
on('DELETE', '/api/notes/:id', (c) => { deleteNote(idOf(c), actor(c)); return { json: { ok: true } }; }, { human: true });
on('POST', '/api/notes/:id/confirm', (c) => ({ json: confirmNote(idOf(c), actor(c)) }), { human: true });
on('POST', '/api/notes/:id/reject', (c) => ({ json: rejectNote(idOf(c), actor(c)) }), { human: true });
on('POST', '/api/notes/confirm-all', (c) => {
  const project = String(c.body?.project ?? '').slice(0, 120);
  if (!project) throw new HttpError(400, '缺少项目名');
  return { json: { ok: true, confirmed: confirmAll(project, actor(c)) } };
}, { human: true });
// 025: 表单里「其他（自己填）」把值放在 project_custom；统一收进 project。
function projectFromBody(body: Record<string, unknown>): void {
  const custom = body.project_custom;
  if (custom !== undefined) {
    body.project = String(custom ?? '').trim();
    delete body.project_custom;
  }
  if (body.project === '__other') body.project = '';
}

// 025: 派给 Agent 却没选项目，执行器找不到文件夹，进队列只会立刻失败——在创建/开始这一步就说清楚。
function assertProjectForAgent(executor: string, project: string): void {
  if (!executor || executor === 'me') return;
  if (String(project ?? '').trim()) return;
  throw new HttpError(400, '这个任务没有选项目，执行器不知道去哪个文件夹干活。先在「编辑任务」里选一个。');
}

/** 项目名不在执行器报上来的列表里：不拦（执行器可能刚改配置还没重启），但要提醒。 */
function unknownProjectWarning(executor: string, project: string): string {
  if (!executor || executor === 'me' || !project) return '';
  const known = latestRunnerMeta().projects ?? [];
  if (!known.length || known.includes(project)) return '';
  return `执行器配置里没有「${project}」这个项目名，开始后可能会失败。配置里的项目：${known.join('、')}`;
}

// The user's two buttons on a task page.
on('POST', '/api/tasks/:id/start', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, '没有任务');
  assertProjectForAgent(t.executor, t.project);
  // 042 A：点「开始」也再看一眼额度（执行器领取时还会看一眼，那是最后一道）。
  // 大脑派的任务换人；你亲手选的只写原因——你选的就是你选的。
  const quota = quotaBlock(t.executor);
  if (quota) {
    if (t.route === 'brain') {
      const moved = rerouteForQuota(t, quota.text);
      return { json: updateTask(t.id, { start_requested: 1, step: moved ? `额度用完，已改派给 ${execLabel(moved.executor)}，等执行器领取` : quota.text }, actor(c)) };
    }
    return { json: updateTask(t.id, { start_requested: 1, step: quota.text }, actor(c)) };
  }
  return { json: updateTask(t.id, { start_requested: 1, step: '已请求开始，等执行器领取' }, actor(c)) };
}, { human: true });
// 025: 失败但不是合并失败的任务，用「重新开始」而不是「重试合并」。
on('POST', '/api/tasks/:id/restart', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, '没有任务');
  assertProjectForAgent(t.executor, t.project);
  cancelAsks(t.id, ['open']); // 055.2：重新开始是全新的一次，没答的卡作废
  undismiss(t.id);
  return { json: updateTask(t.id, {
    status: 'queued', start_requested: 1, retry: null, fail_reason: null, step: '重新排队，等执行器领取',
  }, actor(c)) };
}, { human: true });
// 061：没成之后的三个办法，和「回一句话让它改」。都只许人点。
const againFields = { status: 'queued', start_requested: 1, retry: null, fail_reason: null } as const;
// 你亲手让它再来：收起来的放出来，自动重试的次数清零。
const undismiss = (id: number) => { db().prepare('UPDATE tasks SET dismissed_at = NULL, auto_retries = 0 WHERE id = ?').run(id); };
// 064：执行者请进来 / 先歇着 / 移除。只有你能动队伍，脚本令牌不行。
on('POST', '/api/crew/:key', (c) => {
  const to = String(c.body?.to ?? '');
  if (to !== 'in' && to !== 'rest' && to !== 'out') throw new HttpError(400, '要做什么：in / rest / out');
  return { json: setCrew(String(c.params[0] ?? ''), to, actor(c)) };
}, { human: true });
on('POST', '/api/tasks/:id/dismiss', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, '没有任务');
  if (t.status !== 'failed') throw new HttpError(400, '只有没成的事才能收起来');
  db().prepare('UPDATE tasks SET dismissed_at = ? WHERE id = ?').run(nowIso(), t.id);
  logEvent({ actor: actor(c), kind: 'task.dismissed', task_id: t.id, text: `T-${t.id} 没成，你选了「算了」` });
  return { json: getTask(t.id) };
}, { human: true });
on('POST', '/api/tasks/:id/handover', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, '没有任务');
  if (t.status === 'running') throw new HttpError(400, '它还在做，先等它停下');
  const to = String(c.body?.executor ?? '');
  const ok = db().prepare("SELECT 1 FROM executor_settings WHERE executor = ? AND enabled = 1 AND executor != 'me'").get(to);
  if (!ok || to === t.executor) throw new HttpError(400, '换不了：这位执行者没开，或者就是原来那位');
  assertProjectForAgent(to, t.project);
  cancelAsks(t.id, ['open']);
  undismiss(t.id);
  return { json: updateTask(t.id, { ...againFields, executor: to, route: '', step: `换 ${execLabel(to)} 来做，等执行器领取` }, actor(c)) };
}, { human: true });
on('POST', '/api/tasks/:id/reply', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, '没有任务');
  const text = String(c.body?.text ?? '').trim().slice(0, 2000);
  if (!text) throw new HttpError(400, '先写一句话');
  if (t.status === 'running') throw new HttpError(400, '它还在做，等它停下再说');
  if (t.status === 'asking') throw new HttpError(400, '它在等你选，先回答上面的问题');
  if (t.executor !== 'me') assertProjectForAgent(t.executor, t.project);
  cancelAsks(t.id, ['open']);
  undismiss(t.id);
  // 你说的话是指令：接在说明后面，下一轮它会读到。
  addSay(t.id, 'me', text);
  const description = `${t.description}\n\n---\n你后来补的：${text}`.trim().slice(0, 10000);
  return { json: updateTask(t.id, { ...againFields, description, step: '按你说的重做，等执行器领取' }, actor(c)) };
}, { human: true });
on('POST', '/api/tasks/:id/stop', (c) => {
  const task = stopTask(idOf(c), '用户终止了任务', actor(c));
  return { json: task };
}, { human: true });
// 018: a run that stopped reporting is not coming back. The task keeps saying "running" forever
// because nothing will ever send its last word — this is the button that buries it.
// 020: the install checklist, readable by an agent with the token (read-only, no paths, no keys).
on('GET', '/api/setup/status', () => ({ json: setupStatus() }));
// 019: the morning digest. Reading it is fine for a token; changing it or sending by hand is not.
on('GET', '/api/digest', () => ({ json: digestSettings() }));
on('POST', '/api/digest', (c) => ({ json: saveDigestSettings(c.body ?? {}) }), { human: true });
on('POST', '/api/digest/send', async () => ({ json: await sendDigest({ manual: true }) }), { human: true });
on('POST', '/api/setup/dismiss', (c) => {
  dismissSetup(c.body?.on !== false, actor(c));
  return { json: { ok: true } };
}, { human: true });

on('POST', '/api/tasks/:id/mark-failed', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, `没有任务 T-${idOf(c)}`);
  if (t.status !== 'running') throw new HttpError(400, '只有运行中的任务需要这样标记，其它状态直接改状态就行');
  const stuck = stuckFor(t);
  const why = stuck ? `${stuck.minutes} 分钟没有进度更新` : '执行器那边没有回应';
  return { json: stopTask(t.id, `看起来卡住了（${why}），你标记为失败`, actor(c)) };
}, { human: true });
// 013.6: a merge blocked by a dirty/behind repo, or a push that lost the network, is retried
// without paying for the coding run again — the branch and the local merge are still there.
on('POST', '/api/tasks/:id/retry-merge', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, `没有任务 T-${idOf(c)}`);
  // 025: 只有执行器自己标记「合并被挡住」的任务才有可重试的合并。以前只要失败且有 branch
  // 就放行，结果点了会把真正的失败原因盖掉。
  if (t.retry !== 'merge') throw new HttpError(400, '这个任务不是合并失败，没有可重试的合并。要重跑用「重新开始」。');
  if (!t.branch) throw new HttpError(400, '这个任务没有分支，没有可合并的东西');
  return { json: updateTask(t.id, { status: 'queued', start_requested: 1, retry: 'merge', step: '等你处理完仓库状态，执行器会重试合并' }, actor(c)) };
}, { human: true });
on('POST', '/api/tasks/:id/retry-push', (c) => {
  const t = getTask(idOf(c));
  if (!t) throw new HttpError(404, `没有任务 T-${idOf(c)}`);
  if (!t.merged_commit) throw new HttpError(400, '这个任务还没合并到本地，先「重试合并」');
  return { json: updateTask(t.id, { status: 'queued', start_requested: 1, retry: 'push', step: '执行器会重试推送，等它领取' }, actor(c)) };
}, { human: true });
on('POST', '/api/runner/tasks/:id/budget', (c) => {
  const task = getTask(idOf(c));
  if (task && staleRunReport(task, c.body?.run_id)) return { json: { gated: false, ignored: true } };
  const r = evaluateTaskBudget(idOf(c), c.body ?? {});
  if (r.gated && r.approval_id) void notifyApproval(getApproval(r.approval_id));
  if (r.gated) void commentOnTask(getTask(idOf(c))!, '触发了预算闸，任务暂停，等工作台决定继续还是终止。');
  return { json: r };
});
// The full URL stays in the database and is only used when sending; what leaves here is masked.
on('GET', '/api/notify/channels', () => ({ json: listChannels().map((c) => ({ id: c.id, kind: c.kind, url: maskUrl(c.url), enabled: c.enabled })) }));
on('POST', '/api/notify/channels', (c) => ({ json: addChannel(c.body), status: 201 }), { human: true });
on('DELETE', '/api/notify/channels/:id', (c) => { deleteChannel(idOf(c)); return { json: { ok: true } }; }, { human: true });
on('POST', '/api/notify/test', async () => ({ json: await sendTest() }), { human: true });

// ---- 010: source registry ----
on('GET', '/api/sources', () => ({ json: { sources: listSources(), excluded: EXCLUDED } }));
on('PATCH', '/api/sources/:id', (c) => {
  const id = decodeURIComponent(c.params[0]);
  setSourceOff(id, Boolean(c.body?.off));
  return { json: { ok: true, off: Boolean(c.body?.off) } };
}, { human: true });

// ---- 011: display labels (the keys never change) ----
on('GET', '/api/labels', () => ({ json: { ...labels(), preset_labels: crewPreset() } }));
on('POST', '/api/labels', (c) => {
  const body = (c.body ?? {}) as Record<string, unknown>;
  // the settings form posts flat fields: exec_<key> / sec_<key>
  const executors: Record<string, unknown> = { ...(body.executors as object ?? {}) };
  const sections: Record<string, unknown> = { ...(body.sections as object ?? {}) };
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith('exec_')) executors[k.slice(5)] = v;
    if (k.startsWith('sec_')) sections[k.slice(4)] = v;
  }
  const saved = saveLabels({ preset: String(body.preset ?? 'default'), executors, sections });
  logEvent({ actor: 'me', kind: 'labels.saved', text: `更新称呼：预设 ${saved.preset}` });
  return { json: saved };
}, { human: true });
on('POST', '/api/accounts/:name/calibrate', (c) => ({ json: calibrateVoucher(decodeURIComponent(c.params[0]), c.body) }));
on('POST', '/api/rules', (c) => ({ json: createRule(c.body), status: 201 }), { human: true });
on('PATCH', '/api/rules/:id', (c) => ({ json: updateRule(idOf(c), c.body) }), { human: true });
on('DELETE', '/api/rules/:id', (c) => { deleteRule(idOf(c)); return { json: { ok: true } }; }, { human: true });

on('GET', '/api/events', (c) => ({ json: listEvents({ limit: Number(c.url.searchParams.get('limit')) || 100 }) }));
// The quota reader and the executor report their own failures; nothing else may write audit
// entries from outside. 017: the runner needs this to say which backend it fell back to —
// its own self-check event was silently rejected until now, for the same reason.
on('POST', '/api/events', (c) => {
  const kind = String(c.body?.kind ?? '');
  if (!/^(reader|runner)\.[a-z]/.test(kind)) throw new HttpError(400, '只接受 reader.* 与 runner.* 事件');
  // 018: these texts are upstream error bodies, so they pass through the same redaction as
  // everything else before they land in the audit log.
  const text = redactText(String(c.body?.text ?? '')).slice(0, 300);
  if (!text) throw new HttpError(400, '事件内容不能为空');
  const tid = Number(c.body?.task_id);
  logEvent({ actor: 'system', kind, task_id: Number.isInteger(tid) && tid > 0 ? tid : null, text });
  return { json: { ok: true }, status: 201 };
});
on('GET', '/api/events.csv', () => {
  const rows = listEvents({ limit: 500 });
  const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csv = '\ufeff时间,操作者,类型,任务,内容\n' + rows.map((e) => [fmtDateTime(e.ts), e.actor, e.kind, e.task_id ? `T-${e.task_id}` : '', e.text].map(q).join(',')).join('\n');
  return { text: csv, type: 'text/csv; charset=utf-8', filename: 'workbench-audit.csv' };
}, { human: true });

// Consistent snapshot of the whole database (safe while running, unlike copying the file).
// The download is scrubbed like any other copy that leaves the workbench (015.4): no sessions,
// no password fingerprint — startup re-remembers the fingerprint without logging anyone out.
on('GET', '/api/backup', () => {
  const file = join(tmpdir(), `workbench-backup-${Date.now()}.db`);
  db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try {
    const copy = new DatabaseSync(file);
    try { scrubCopy(copy); } finally { copy.close(); }
    return { bytes: readFileSync(file), type: 'application/vnd.sqlite3', filename: `workbench-${new Date().toISOString().slice(0, 10)}.db` };
  } finally { rmSync(file, { force: true }); }
}, { human: true });

// 014: the button on the settings page. A token may download a backup, but writing into the
// user's sync folder is a person's call — and so is seeing where that folder is.
on('GET', '/api/backup/state', () => ({ json: backupStatus() }));
on('POST', '/api/backup/run', () => ({ json: runManualBackup() }), { human: true });

// 024b: 公网访问检测。读是只读的（令牌也行）；改处理方式是人的决定。
on('GET', '/api/exposure', () => ({
  json: { mode: currentMode(), env_mode: accessMode(), allowed_hosts: allowedHosts().length, last: exposureState() },
}));
on('POST', '/api/exposure', (c) => {
  saveMode(String(c.body?.mode ?? ''), actor(c));
  return { json: { ok: true, mode: currentMode() } };
}, { human: true });

// ---------- plumbing ----------

/**
 * 043：解析器不再替任何接口偷改形状。以前顶层数组一律包成 `{ records: v }`，
 * 于是「收对象的接口收到数组」不报错、默默按对象处理、最后还回 200（PUT /api/executors 就踩过）。
 * 现在形状由路由声明，对不上就 400，让调用方立刻知道。
 */
async function readBody(req: IncomingMessage, kind: BodyKind = 'object'): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new HttpError(413, '请求体太大');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, '请求体不是合法 JSON'); }
  if (Array.isArray(v)) {
    if (kind === 'array' || kind === 'either') return v as unknown as Record<string, unknown>;
    throw new HttpError(400, '需要一个 JSON 对象');
  }
  if (!v || typeof v !== 'object') throw new HttpError(400, '需要一个 JSON 对象');
  if (kind === 'array') throw new HttpError(400, '需要一个 JSON 数组');
  return v as Record<string, unknown>;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
};

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

/**
 * 024b：判断这次访问是不是「看起来从公网来的」，并按模式决定只提醒、拒绝，还是不管。
 * 脚本接口（Bearer）永远不拦：执行器和心跳可能合法地走局域网 IP，拦了会把自己家里的东西搞坏。
 */
function checkExposure(req: IncomingMessage, auth: 'bearer' | 'cookie' | 'off' | null): { refused: boolean; message: string; note: string } {
  const mode = currentMode();
  if (mode === 'allow') return { refused: false, message: '', note: '' };
  const v = classifyAccess(
    {
      host: req.headers.host,
      xff: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'].join(',') : '',
      remote: req.socket.remoteAddress ?? '',
    },
    allowedHosts(),
  );
  if (!v.suspicious) return { refused: false, message: '', note: '' };
  recordSuspicious(v);
  if (mode === 'refuse' && auth !== 'bearer') {
    return {
      refused: true,
      message: '这个工作台不允许从公网地址访问。要用手机，请在同一局域网里打开，或者用 Tailscale（tailscale serve）——实在需要自己的域名，把它加进 WB_ALLOWED_HOSTS。',
      note: '',
    };
  }
  return {
    refused: false,
    message: '',
    note: `有人通过公网地址访问了工作台（${v.label}）。如果这不是你有意设置的，请马上关掉端口转发或隧道，并换掉 WB_PASSWORD。`,
  };
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const isApi = url.pathname.startsWith('/api/');
  try {
    if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
      const f = STATIC[url.pathname.slice(8)];
      if (!f) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
      return send(res, 200, { 'Content-Type': f.type, 'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache' }, f.body);
    }
    const matches = routes.filter((r) => r.re.test(url.pathname));
    if (!matches.length) throw new HttpError(404, '没有这个页面');
    const route = matches.find((r) => r.method === req.method);
    if (!route) throw new HttpError(405, '方法不支持');

    const auth = authOf(req);
    if (!route.public && !auth) {
      if (route.page) return send(res, 302, { Location: '/login' }, '');
      throw new HttpError(401, '未登录或令牌无效');
    }
    if (auth === 'cookie' && req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, '来源不被允许');
    // 008.2: decisions a person has to make cannot be made by a leaked token.
    if (route.human && auth === 'bearer') throw new HttpError(403, '这个操作只能在网页上做');

    // 024b: 这次访问看起来是从公网来的吗？只提醒或拒绝网页，脚本接口放行（执行器、心跳
    // 可能合法地走局域网 IP，拦了会把家里自己的东西搞坏）。
    const exposure = checkExposure(req, auth);
    if (exposure.refused) throw new HttpError(403, exposure.message);

    const body = await readBody(req, route.body ?? 'object');
    const params = (url.pathname.match(route.re) ?? []).slice(1);
    const out = await withExposureNote(exposure.note, () => route.handler({ req, res, url, params, body, auth })) as Result & { cookie?: string };
    const cookieHeader: Record<string, string> = out.cookie ? { 'Set-Cookie': out.cookie } : {};
    if ('redirect' in out) return send(res, 303, { Location: out.redirect, ...cookieHeader }, '');
    if ('html' in out) return send(res, out.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...cookieHeader }, out.html);
    if ('bytes' in out) return send(res, 200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' }, out.bytes);
    if ('text' in out) return send(res, 200, { 'Content-Type': out.type, ...(out.filename ? { 'Content-Disposition': `attachment; filename="${out.filename}"` } : {}) }, out.text);
    return send(res, out.status ?? 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cookieHeader }, JSON.stringify(out.json));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const message = err instanceof HttpError ? err.message : '服务器出错了，详情见日志';
    if (isApi || req.method !== 'GET') return send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ error: message }));
    return send(res, status, { 'Content-Type': 'text/html; charset=utf-8' }, `<!doctype html><meta charset="utf-8"><title>${status}</title><p style="font-family:sans-serif;padding:40px">${status} · ${message.replace(/</g, '&lt;')} · <a href="/">回到概览</a></p>`);
  }
}
