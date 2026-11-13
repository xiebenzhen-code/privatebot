import { db, tx } from '../db.ts';
import { DECISIONS, EXECUTORS, RISKS, execLabel, nowIso, truncate } from '../domain.ts';
import { HttpError, logEvent, oneOf, str } from './core.ts';
import { createTask, getTask, sessionTask, updateTask, type Task } from './tasks.ts';
import { closeRun, openRunOf } from './runs.ts';
import { inspectShell } from './shell-inspection.ts';

export type Approval = {
  id: number; task_id: number | null; source: string; session_id: string | null; cwd: string;
  tool_name: string; tool_input: string; rule_id: number | null; rule_name: string; risk: string;
  title: string; summary: string; status: string; feedback: string; created_at: string; decided_at: string | null;
};
export type Rule = {
  id: number; name: string; tool_pattern: string; input_pattern: string; risk: string; enabled: number; created_at: string;
};

// ---------- rules ----------

export function listRules(): Rule[] {
  return db().prepare('SELECT * FROM rules ORDER BY id').all() as Rule[];
}

function checkRegex(src: string, field: string): void {
  try { new RegExp(src); } catch { throw new HttpError(400, `${field} 不是合法的正则表达式`); }
}

export function createRule(input: Record<string, unknown>): Rule {
  const name = str(input.name, 120)?.trim();
  const tool = str(input.tool_pattern, 200)?.trim();
  const pattern = str(input.input_pattern, 1000) ?? '';
  const risk = oneOf(input.risk, Object.keys(RISKS), 'risk') ?? 'medium';
  if (!name || !tool) throw new HttpError(400, '规则名和工具匹配不能为空');
  checkRegex(tool, '工具匹配'); checkRegex(pattern, '内容匹配');
  const r = db().prepare('INSERT INTO rules (name, tool_pattern, input_pattern, risk, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, tool, pattern, risk, nowIso());
  logEvent({ actor: 'me', kind: 'rule.created', text: `新增审批规则「${name}」` });
  return db().prepare('SELECT * FROM rules WHERE id = ?').get(Number(r.lastInsertRowid)) as Rule;
}

export function updateRule(id: number, input: Record<string, unknown>): Rule {
  const rule = db().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Rule | undefined;
  if (!rule) throw new HttpError(404, '没有这条规则');
  if (input.enabled !== undefined) {
    const on = input.enabled === true || input.enabled === 1 || input.enabled === '1' || input.enabled === 'true';
    db().prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id);
    logEvent({ actor: 'me', kind: 'rule.toggled', text: `${on ? '启用' : '停用'}审批规则「${rule.name}」` });
  }
  const risk = oneOf(input.risk, Object.keys(RISKS), 'risk');
  if (risk) db().prepare('UPDATE rules SET risk = ? WHERE id = ?').run(risk, id);
  return db().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Rule;
}

export function deleteRule(id: number): void {
  const rule = db().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Rule | undefined;
  if (!rule) throw new HttpError(404, '没有这条规则');
  db().prepare('DELETE FROM rules WHERE id = ?').run(id);
  logEvent({ actor: 'me', kind: 'rule.deleted', text: `删除审批规则「${rule.name}」` });
}

/** What a rule's content pattern is tested against: the command, the file path, or the whole input. */
export function ruleTarget(toolInput: Record<string, unknown>): string {
  if (typeof toolInput.command === 'string') return toolInput.command;
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;
  return JSON.stringify(toolInput);
}

/** Highest-risk enabled rule matching this tool call, if any. */
export function matchRule(toolName: string, toolInput: Record<string, unknown>): Rule | null {
  const target = ruleTarget(toolInput);
  let best: Rule | null = null;
  for (const r of listRules()) {
    if (!r.enabled) continue;
    let toolOk = false, inputOk = false;
    try { toolOk = new RegExp(`^(?:${r.tool_pattern})$`).test(toolName); } catch { continue; }
    if (!toolOk) continue;
    try { inputOk = !r.input_pattern || new RegExp(r.input_pattern, 'i').test(target); } catch { continue; }
    if (!inputOk) continue;
    if (!best || (RISKS[r.risk]?.rank ?? 0) > (RISKS[best.risk]?.rank ?? 0)) best = r;
  }
  return best;
}

// ---------- approvals ----------

export function getApproval(id: number): Approval | undefined {
  return db().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined;
}

export function listApprovals(f: { status?: string; task_id?: number; limit?: number } = {}): Approval[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (f.task_id) { where.push('task_id = ?'); args.push(f.task_id); }
  args.push(Math.min(f.limit ?? 100, 500));
  return db().prepare(`SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC LIMIT ?`).all(...args) as Approval[];
}

export type ApprovalInput = {
  title?: unknown; summary?: unknown; risk?: unknown; task_id?: unknown; executor?: unknown;
  project?: unknown; source?: unknown; session_id?: unknown; cwd?: unknown;
  tool_name?: unknown; tool_input?: unknown; rule_id?: unknown; rule_name?: unknown;
  // 039: 这次改动碰了哪些文件。只有合并审批看它，别的审批传了也不会自动放行。
  changed_files?: unknown;
};

/** 设置读过就走，别和 dispatch.ts 互相 import（那边已经 import 了这里）。 */
function setting(key: string, fallback = ''): string {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

/**
 * 039：这次改动是不是「只碰了文档」。
 *
 * 只认 `docs/` 下面的普通相对路径；`docs/specs/`（需求单、交接）除外。空列表、绝对路径、带 `..` 的、盘符开头的，一律不算——
 * 拿不准就当有代码改动，让人点一下；自动放行错一次，省下的那一下点击一点都不划算。
 */
/** 039.1：清单长到这个数就不看内容了。一份长到看不清的清单，不配自动放行。 */
const MAX_AUTO_FILES = 500;

export function docsOnly(files: unknown): boolean {
  if (!Array.isArray(files) || files.length === 0) return false;
  // 上限放在规则入口，而不是只靠 finish 那边归一化：以后多加一个调用方也漏不掉。
  if (files.length > MAX_AUTO_FILES) return false;
  return files.every((raw) => {
    const p = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p || p.startsWith('/') || /^[a-z]:/i.test(p)) return false;
    if (p.split('/').includes('..')) return false;
    // 需求单和交接文档不算「普通文档」：后面的 AI 开工前会把它们当要求来读，改它们要你看一眼。
    if (p.startsWith('docs/specs/')) return false;
    return p.startsWith('docs/');
  });
}

/**
 * 039：哪一类审批可以自己过。**只有合并**，而且必须两边都成立：
 * 这次只改了 docs/，并且设置里的开关没关（`auto_approve_docs=0` 就一律手动）。
 * 推送、部署、工具调用的审批永远由人点——它们改的是线上和别人的机器。
 */
export function autoMergeReason(files: unknown, toolName: unknown): string {
  if (String(toolName ?? '') !== 'git merge') return '';
  if (setting('auto_approve_docs', '1') === '0') return '';
  if (!docsOnly(files)) return '';
  const n = (files as unknown[]).length;
  return `按规则自动通过：这次只改了 docs/ 下的 ${n} 个文件，没有代码变动（推送和部署仍然要你点）`;
}

/**
 * 062 × 039：要审的任务，只改文档也不在做完那一刻自动过——先让另一位看。
 * 审过了（结论是「过」），而且这次确实只改了 docs/、开关也还开着，这条合并审批才按规则自己过。
 * 放行的是「只改文档」这条规则，不是审的那位：它给的是「过」，点头的资格还是规则给的；
 * 「要改」「拿不准」「没审成」一律留给你点。返回是否放行了。
 */
/** 这件事最近一轮，执行器自己跑测试的结果是不是「没过」。 */
function testsFailed(taskId: number): boolean {
  const row = db().prepare('SELECT verify FROM tasks WHERE id = ?').get(taskId) as { verify: string } | undefined;
  try { return !!row?.verify && (JSON.parse(row.verify) as { status?: string }).status === 'fail'; } catch { return false; }
}

export function autoApproveReviewed(taskId: number): boolean {
  if (setting('auto_approve_docs', '1') === '0') return false;
  const a = (db().prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' AND tool_name = 'git merge' ORDER BY id DESC LIMIT 1").get(taskId)) as Approval | undefined;
  if (!a) return false;
  let n = 0;
  try { n = Number((JSON.parse(a.tool_input || '{}') as { docs_files?: unknown }).docs_files) || 0; } catch { n = 0; }
  if (n <= 0) return false;
  // 066：工作台自己跑测试没过的，不自动放行——哪怕审的那位说过、哪怕只改了文档。留给你看一眼。
  if (testsFailed(taskId)) return false;
  const why = `按规则自动通过：另一位审过，而且这次只改了 docs/ 下的 ${n} 个文件，没有代码变动（推送和部署仍然要你点）`;
  db().prepare('UPDATE approvals SET status = ?, feedback = ?, decided_at = ? WHERE id = ?').run('approved', why, nowIso(), a.id);
  logEvent({ actor: 'system', kind: 'approval.auto', task_id: taskId, approval_id: a.id, text: `「${truncate(a.title, 80)}」自动通过：审过了，只改了文档` });
  return true;
}

export function createApproval(input: ApprovalInput): Approval {
  const title = str(input.title, 300)?.trim();
  if (!title) throw new HttpError(400, '审批标题不能为空');
  const risk = oneOf(input.risk, Object.keys(RISKS), 'risk') ?? 'medium';
  const executor = oneOf(input.executor, Object.keys(EXECUTORS), 'executor') ?? 'claude';
  return tx(() => {
    let taskId = input.task_id ? Number(input.task_id) : null;
    if (taskId && !getTask(taskId)) throw new HttpError(404, `没有任务 T-${taskId}`);
    if (!taskId) {
      taskId = createTask({ title, executor, project: str(input.project, 120) ?? '', status: 'review' }, executor).id;
    }
    const toolInput = typeof input.tool_input === 'string' ? input.tool_input : JSON.stringify(input.tool_input ?? {});
    const r = db().prepare(`INSERT INTO approvals (task_id, source, session_id, cwd, tool_name, tool_input, rule_id, rule_name, risk, title, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      taskId, str(input.source, 40) ?? 'api', str(input.session_id, 200) ?? null, str(input.cwd, 500) ?? '',
      str(input.tool_name, 100) ?? '', toolInput.slice(0, 20000), input.rule_id ? Number(input.rule_id) : null,
      str(input.rule_name, 120) ?? '', risk, title, str(input.summary, 20000) ?? '', nowIso(),
    );
    const id = Number(r.lastInsertRowid);
    // 045：审批挂到当前那次运行上（没有在跑的就留空）。
    const run = openRunOf(taskId);
    if (run) db().prepare('UPDATE approvals SET run_id = ? WHERE id = ?').run(run.id, id);
    const task = getTask(taskId)!;
    // 039: 只改文档的合并审批自己过。任务不许被推进 review——它还得接着往下走（合并、推送审批）。
    const auto = autoMergeReason(input.changed_files, input.tool_name);
    if (auto) {
      db().prepare('UPDATE approvals SET status = ?, feedback = ?, decided_at = ? WHERE id = ?')
        .run('approved', auto, nowIso(), id);
      logEvent({ actor: 'system', kind: 'approval.auto', task_id: taskId, approval_id: id,
        text: `「${truncate(title, 80)}」自动通过：只改了文档，没有代码变动` });
      return getApproval(id)!;
    }
    if (task.status !== 'review') updateTask(taskId, { status: 'review' }, task.executor);
    logEvent({ actor: task.executor, kind: 'approval.requested', task_id: taskId, approval_id: id,
      text: `${execLabel(task.executor)} 请求审批「${truncate(title, 80)}」${input.rule_name ? `（规则：${input.rule_name}）` : ''}，已暂停等待` });
    return getApproval(id)!;
  });
}

export function decideApproval(id: number, decision: unknown, feedback: unknown, actor = 'me'): Approval {
  const d = oneOf(decision, Object.keys(DECISIONS), 'decision');
  if (!d) throw new HttpError(400, 'decision 不能为空');
  const fb = str(feedback, 4000)?.trim() ?? '';
  if (d === 'changes' && !fb) throw new HttpError(400, '打回修改需要写修改意见');
  return tx(() => {
    const a = getApproval(id);
    if (!a) throw new HttpError(404, '没有这条审批');
    if (a.status !== 'pending') throw new HttpError(409, `这条审批已经处理过（${DECISIONS[a.status] ?? a.status}）`);
    db().prepare('UPDATE approvals SET status = ?, feedback = ?, decided_at = ? WHERE id = ?').run(d, fb, nowIso(), id);
    if (a.task_id) {
      const task = getTask(a.task_id);
      const stillPending = (db().prepare("SELECT COUNT(*) n FROM approvals WHERE task_id = ? AND status = 'pending'").get(a.task_id) as { n: number }).n;
      if (d === 'takeover') {
        updateTask(a.task_id, { status: 'inbox', executor: 'me' }, actor);
        closeRun(a.task_id, 'taken_over', { reason: '你接手了' });
      }
      // Only a session that was blocked mid-run goes back to 运行中. A merge approval is decided
      // after the run already ended — resuming it would make a finished task look busy again.
      else if (!stillPending && task?.status === 'review') updateTask(a.task_id, { status: 'running' }, actor);
    }
    logEvent({ actor, kind: `approval.${d}`, task_id: a.task_id, approval_id: id,
      text: `${DECISIONS[d]}「${truncate(a.title, 80)}」${fb ? `，意见：${truncate(fb, 120)}` : ''}` });
    return getApproval(id)!;
  });
}

/** Approvals never answered before the agent gave up are closed so they stop showing as pending. */
export function expireApproval(id: number): Approval {
  const a = getApproval(id);
  if (!a) throw new HttpError(404, '没有这条审批');
  if (a.status !== 'pending') return a;
  db().prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(nowIso(), id);
  if (a.task_id) {
    const n = (db().prepare("SELECT COUNT(*) n FROM approvals WHERE task_id = ? AND status = 'pending'").get(a.task_id) as { n: number }).n;
    const t = getTask(a.task_id);
    if (!n && t?.status === 'review') updateTask(a.task_id, { status: 'running' }, 'system');
  }
  logEvent({ actor: 'system', kind: 'approval.expired', task_id: a.task_id, approval_id: id, text: `审批超时，交回终端处理：「${truncate(a.title, 80)}」` });
  return getApproval(id)!;
}

// ---------- Claude Code hook receiver ----------

export type HookPayload = {
  hook_event_name?: string; session_id?: string; cwd?: string; prompt?: string;
  tool_name?: string; tool_input?: Record<string, unknown>; executor?: string; host?: string;
  /** 008: 'runner' when the call comes from an executor run, empty for the user's own sessions. */
  source?: string;
  /** 013: the task the runner already claimed; the session belongs to that one. */
  task_id?: number;
};
export type HookReply = { action: 'none' } | { action: 'allow' } | { action: 'deny'; reason: string } | { action: 'wait'; approval_id: number; risk: string; rule: string };

function describeCall(tool: string, input: Record<string, unknown>): { title: string; summary: string } {
  if (typeof input.command === 'string') {
    return {
      title: `运行：${truncate(input.command, 110)}`,
      summary: `${input.description ? `说明：${input.description}\n` : ''}$ ${input.command}`,
    };
  }
  if (typeof input.file_path === 'string') {
    const body = typeof input.content === 'string' ? input.content
      : typeof input.new_string === 'string' ? `- ${String(input.old_string ?? '').slice(0, 1500)}\n+ ${input.new_string}` : '';
    return { title: `${tool === 'Write' ? '写入' : '编辑'}：${input.file_path}`, summary: `${tool} ${input.file_path}\n\n${body.slice(0, 4000)}` };
  }
  return { title: `调用 ${tool}`, summary: JSON.stringify(input, null, 2).slice(0, 4000) };
}

// 008.2: an executor may only touch its own worktree. Normalising by hand because the
// workbench runs in Linux while the paths are Windows ones.
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);

export function normPath(p: string): string {
  const raw = String(p ?? '').trim().replace(/\\/g, '/');
  const abs = raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw);
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return ((abs ? '/' : '') + parts.join('/')).toLowerCase();
}

export function withinDir(target: string, cwd: string): boolean {
  if (!cwd) return false;
  const t = normPath(target);
  const base = normPath(cwd);
  return t === base || t.startsWith(`${base}/`);
}

/** The workbench has to tell headless sessions "deny" outright, not "ask". */
export type PreToolVerdict = { action: 'deny'; reason: string } | null;

export function runnerPathVerdict(tool: string, input: Record<string, unknown>, cwd?: string): PreToolVerdict {
  if (!PATH_TOOLS.has(tool)) return null;
  // A glob can list names outside the worktree without ever naming a path.
  const glob = tool === 'Glob' ? input.pattern : tool === 'Grep' ? input.glob : undefined;
  if (typeof glob === 'string' && glob.trim()) {
    const g = glob.trim();
    if (g.includes('..') || /^([a-zA-Z]:[\\/]|[\\/])/.test(g) || /^~/.test(g)) {
      return { action: 'deny', reason: '执行器只能访问自己的工作目录' };
    }
  }
  const raw = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof raw !== 'string' || !raw.trim()) return null; // Grep/Glob without a path mean cwd
  if (/^~|^%USERPROFILE%/i.test(raw.trim())) return { action: 'deny', reason: '执行器只能访问自己的工作目录' };
  if (!withinDir(raw, cwd ?? '')) return { action: 'deny', reason: '执行器只能访问自己的工作目录' };
  return null;
}

/**
 * 013.6: the command with its own working directory taken out, so the home-dir rule only fires on
 * paths that really point elsewhere. Both separators count — Git Bash passes mixed paths.
 */
export function withoutOwnDir(cmd: string, cwd: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const own = cwd ? norm(cwd) : '';
  let out = norm(cmd);
  if (own) out = out.split(own).join('');
  return out;
}

/**
 * 008: rules that exist only for executor runs. The user's own sessions keep the old behaviour,
 * so a stray `npm i` they type themselves is not sent to the approval inbox.
 */
export function runnerRuleFor(tool: string, input: Record<string, unknown>, cwd = ''): { name: string; risk: string } | null {
  const cmd = typeof input.command === 'string' ? input.command : '';
  const path = typeof input.file_path === 'string' ? input.file_path : '';
  const body = typeof input.content === 'string' ? input.content
    : typeof input.new_string === 'string' ? input.new_string : '';
  const touched = `${path} ${body}`;
  const isBash = tool === 'Bash';
  const shell = isBash ? inspectShell(cmd) : null;
  const inspected = shell ? [cmd, ...shell.commands].join('\n') : cmd;

  // The workbench on any address: LAN IP, 0.0.0.0, [::1], host.docker.internal.
  if (isBash && (/:3200\b/.test(inspected) || /\.ai-workbench/i.test(inspected))) {
    return { name: '执行器访问工作台或改工作台配置', risk: 'high' };
  }
  // A nested `claude` could clear WB_SOURCE and step outside the executor rules.
  // 013.6: only a real command word counts — the runner's own log lives under `claude-runner/`,
  // and reading that is not "starting another claude".
  if (shell?.claude) {
    return { name: '执行器里再启动一个 claude', risk: 'high' };
  }
  if (shell?.uncertain) return { name: '无法确认这条命令会执行什么', risk: 'high' };
  // `.claude` also appears in shell redirections, not just in file paths.
  if (isBash && /(^|[\s"'=/>])\.claude($|[\s"';/\\])/.test(inspected)) {
    return { name: '执行器改 .claude 目录', risk: 'high' };
  }
  if (isBash && /\b(npm\s+(i|install)|pnpm\s+(add|i)|yarn\s+add|pip3?\s+install|winget\s+install|choco\s+install)\b/i.test(inspected)) {
    return { name: '执行器安装依赖', risk: 'medium' };
  }
  // Home directory and other obvious secrets: an executor has no business there.
  // The worktree usually sits under the home folder (C:\Users\<you>\wb-worktrees), so a command
  // that only names its own directory must not read as "reaching into the home folder".
  if (isBash && /(^|[\s"'=])(~|\$HOME|%USERPROFILE%|\/users\/|[a-z]:[\\/]users[\\/]|\.ssh|id_rsa|id_ed25519)/i.test(withoutOwnDir(inspected, cwd))) {
    return { name: '执行器访问家目录或密钥', risk: 'high' };
  }
  // 013.6: `.env.example` / `.env.sample` are templates people commit; only the real files count.
  if (isBash && /(^|[\s"'=/])(\.env(?!\.(example|sample|template|dist)\b)(?![\w])|secrets\.txt|cliproxyapi\b)/i.test(inspected)) {
    return { name: '执行器访问密钥文件', risk: 'high' };
  }
  if (/(^|[\s"'=/>])\.claude($|[\s"';/\\])/.test(touched)) {
    return { name: '执行器改 .claude 目录', risk: 'high' };
  }
  return null;
}

/**
 * 013: a runner session belongs to the task the runner already claimed (the hook sends WB_TASK_ID).
 * Without this, the first hook call would create a *second* task for the same run, and every
 * approval would hang off that phantom task instead of the one the user is watching.
 */
/**
 * 013.5: a stray WB_TASK_ID in the user's own terminal must not attach their session to a task
 * the executor owns. Only a runner-sourced call, on a task a runner actually claimed, counts.
 */
function runnerOwnsTask(p: HookPayload, id: number): boolean {
  if (p.source !== 'runner') return false;
  const known = getTask(id);
  return Boolean(known?.runner_id) && (known!.status === 'running' || known!.status === 'review');
}

/** Claude Code 自己塞进对话的系统消息（后台任务通知、命令回显等），以一个 XML 样的标签开头。 */
export function systemPrompt(prompt: unknown): boolean {
  return /^\s*<(task-notification|system-reminder|command-name|local-command-stdout|bash-notification)\b/i.test(String(prompt ?? ''));
}

function taskForHook(p: HookPayload, opts: { executor: string; title?: string }): Task {
  const id = Number(p.task_id ?? 0);
  if (Number.isFinite(id) && id > 0 && runnerOwnsTask(p, id)) {
    const known = getTask(id)!;
    // Stamp the session on it once, so later calls (and SessionEnd) match without WB_TASK_ID.
    if (!known.session_id && p.session_id) {
      db().prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(p.session_id, id);
      return getTask(id)!;
    }
    return known;
  }
  return sessionTask(p.session_id!, { executor: opts.executor, cwd: p.cwd, title: opts.title });
}

export function handleClaudeHook(p: HookPayload): HookReply {
  const event = p.hook_event_name ?? '';
  const sessionId = p.session_id;
  const executor = p.executor && EXECUTORS[p.executor] ? p.executor : 'claude';
  if (!sessionId) throw new HttpError(400, '缺少 session_id');

  // 2026-11-03：Claude Code 把后台任务的完成通知也当成一次「用户输入」发过来（<task-notification>…），
  // 以前会拿这串标记建出一个乱码标题的新任务。这类系统消息不是人说的话，不建任务、不改步骤。
  if (event === 'UserPromptSubmit' && systemPrompt(p.prompt)) return { action: 'none' };
  if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    const task = taskForHook(p, { executor, title: p.prompt });
    if (event === 'UserPromptSubmit' && p.prompt) {
      const patch: Record<string, unknown> = { step: `处理中：${truncate(p.prompt, 60)}` };
      if (task.status === 'done' || task.status === 'inbox' || task.status === 'queued') patch.status = 'running';
      updateTask(task.id, patch, executor);
    }
    return { action: 'none' };
  }
  if (event === 'Stop') {
    const task = taskForHook(p, { executor });
    if (task.status === 'running') updateTask(task.id, { step: '本轮完成 · 等你下一步指令' }, executor);
    return { action: 'none' };
  }
  if (event === 'SessionEnd') {
    const found = db().prepare('SELECT id FROM tasks WHERE session_id = ?').get(sessionId) as { id: number } | undefined;
    if (found) updateTask(found.id, { step: '会话已结束' }, executor);
    return { action: 'none' };
  }
  if (event === 'PreToolUse') {
    const tool = p.tool_name ?? '';
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    // 008.2: a path outside the worktree is refused outright, before any rule is consulted.
    if (p.source === 'runner') {
      const verdict = runnerPathVerdict(tool, input, p.cwd);
      if (verdict) return verdict;
    }
    const dbRule = matchRule(tool, input);
    const extra = p.source === 'runner' ? runnerRuleFor(tool, input, p.cwd) : null;
    // A runner session is told "allow" explicitly, so headless mode never falls back to asking.
    if (!dbRule && !extra) return p.source === 'runner' ? { action: 'allow' } : { action: 'none' };
    const rank = (r?: string) => (r ? RISKS[r]?.rank ?? 0 : 0);
    const useExtra = rank(extra?.risk) > rank(dbRule?.risk);
    const risk = useExtra ? extra!.risk : dbRule?.risk ?? 'medium';
    const ruleName = useExtra ? extra!.name : dbRule!.name;
    const task = taskForHook(p, { executor });
    const { title, summary } = describeCall(tool, input);
    const a = createApproval({
      title, summary: `${p.cwd ? `目录：${p.cwd}${p.host ? ` @ ${p.host}` : ''}\n` : ''}${summary}`, risk, task_id: task.id,
      source: 'claude-hook', session_id: sessionId, cwd: p.cwd, tool_name: tool, tool_input: input,
      rule_id: useExtra ? null : dbRule!.id, rule_name: ruleName,
    });
    return { action: 'wait', approval_id: a.id, risk, rule: ruleName };
  }
  return { action: 'none' };
}
