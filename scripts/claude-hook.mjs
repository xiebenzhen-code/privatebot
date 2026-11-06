#!/usr/bin/env node
// Claude Code hook → 个人工作台.
// Register it for PreToolUse (approvals) and UserPromptSubmit / Stop / SessionEnd (task tracking).
// See /settings/integrations in the workbench for the exact settings.json snippet.
//
// Config (first match wins):
//   env  WB_URL, WB_TOKEN, optional WB_EXECUTOR (claude|codex|pool|local), WB_WAIT_SECONDS
//   file ~/.ai-workbench.json  {"url": "http://<服务器IP>:3200", "token": "...", "executor": "claude"}
//
// Behaviour:
//   - Workbench unreachable / not configured → exit 0 silently, Claude Code's normal permission flow applies.
//   - PreToolUse matching an approval rule → blocks until you decide in the workbench:
//       批准 → allow · 驳回 / 打回修改 / 我来接管 → deny with your note as the reason Claude sees
//       no decision within WB_WAIT_SECONDS → "ask": falls back to the terminal prompt.
// Requires Node 18+. No dependencies.
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

function config() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(homedir(), '.ai-workbench.json'), 'utf8')); } catch { /* optional */ }
  return {
    url: (process.env.WB_URL || file.url || '').replace(/\/+$/, ''),
    token: process.env.WB_TOKEN || file.token || '',
    executor: process.env.WB_EXECUTOR || file.executor || 'claude',
    wait: Number(process.env.WB_WAIT_SECONDS || file.waitSeconds || 1500),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function trim(v, depth = 0) {
  if (typeof v === 'string') return v.length > 8000 ? v.slice(0, 8000) + `…（截断，共 ${v.length} 字符）` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trim(x, depth + 1));
  if (v && typeof v === 'object' && depth < 4) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

async function api(cfg, path, method = 'GET', body) {
  const res = await fetch(cfg.url + path, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

const HEADLESS = process.env.WB_SOURCE === 'runner';
// 037：codebuddy 的钩子接口和 Claude Code 同源，但文档只承诺「退出码 2 = 阻止」这一条，
// hookSpecificOutput 里的 permissionDecision 它没写会读。所以在这个变体里把决定翻成退出码：
// 拦就是 2（原因写 stdout，它会当成阻止理由交给模型），放行就是 0。
const CODEBUDDY = process.env.WB_HOOK_VARIANT === 'codebuddy';

function decide(permissionDecision, permissionDecisionReason) {
  // In headless mode there is nobody to confirm: "ask" would silently become a pass, so deny.
  const decision = HEADLESS && permissionDecision === 'ask' ? 'deny' : permissionDecision;
  if (CODEBUDDY) {
    if (decision === 'deny') {
      process.stdout.write(permissionDecisionReason || '执行器不同意这个操作');
      process.exit(2);
    }
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason } }));
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = config();
  if (!cfg.url || !cfg.token) return;
  let payload;
  try { payload = JSON.parse(await readStdin()); } catch { return; }
  const event = payload.hook_event_name;

  let reply;
  try {
    reply = await api(cfg, '/api/hooks/claude', 'POST', {
      hook_event_name: event, session_id: payload.session_id, cwd: payload.cwd, prompt: payload.prompt,
      tool_name: payload.tool_name, tool_input: trim(payload.tool_input), executor: cfg.executor, host: hostname(),
      source: process.env.WB_SOURCE || '',
      // The runner knows which task it is working on; without this the session would get its own
      // phantom task and every approval would point at the wrong one.
      task_id: Number(process.env.WB_TASK_ID) || undefined,
    });
  } catch (err) {
    if (process.env.WB_DEBUG) console.error('[workbench]', err.message);
    // A runner without the workbench has no gate at all; refuse instead of failing open.
    if (HEADLESS && event === 'PreToolUse') return decide('deny', '工作台连不上，执行器在无审批的情况下不继续');
    return; // fail open: normal Claude Code permissions apply
  }
  if (event !== 'PreToolUse') return;
  // A runner session gets an explicit allow when no rule matched, so headless mode never asks.
  if (reply.action === 'allow') return decide('allow', '没有命中审批规则，执行器放行');
  // 008.2: paths outside the worktree are refused here; there is nothing to wait for.
  if (reply.action === 'deny') return decide('deny', reply.reason || '执行器只能访问自己的工作目录');
  if (reply.action !== 'wait') return;

  const id = reply.approval_id;
  const deadline = Date.now() + cfg.wait * 1000;
  let misses = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    let a;
    try { a = await api(cfg, `/api/approvals/${id}`); misses = 0; } catch {
      if (++misses >= 15) return decide('ask', '工作台连不上，改回终端确认');
      continue;
    }
    const note = a.feedback ? `：${a.feedback}` : '';
    if (a.status === 'approved') return decide('allow', `已在工作台批准（规则：${reply.rule}）${note}`);
    if (a.status === 'rejected') return decide('deny', `用户在工作台驳回了这个操作${note}。不要重试同样的操作，换个做法或先问用户。`);
    if (a.status === 'changes') return decide('deny', `用户要求修改后再继续${note}`);
    if (a.status === 'takeover') return decide('deny', `用户已接管这个任务${note}。请停止当前操作，简要总结进度，然后等用户指示。`);
    if (a.status === 'expired') return decide('ask', '工作台审批已关闭，改回终端确认');
  }
  try { await api(cfg, `/api/approvals/${id}/expire`, 'POST', {}); } catch { /* best effort */ }
  return decide('ask', `工作台 ${Math.round(cfg.wait / 60)} 分钟内没有处理，改回终端确认`);
}

main().catch((err) => {
  if (process.env.WB_DEBUG) console.error('[workbench]', err);
  process.exit(0);
});
