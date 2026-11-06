// 010: one place that knows every quota source — what it is, whether it is wired up,
// how fresh its data is, and what the user has to do next. Adding a source = one entry here.
import { db } from '../db.ts';
import { nowIso } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';
import { connectorEnabled, pollSeconds } from './cliproxyapi.ts';
import { glmEnabled } from './balances.ts';
import { githubEnabled } from './github.ts';
import { runnerOnline } from './runner.ts';

export type SourceVia = 'proxy' | 'api' | 'reader' | 'manual' | 'sync';
export type SourceQuota = 'window' | 'balance' | 'credits' | 'usage';
export type SourceState = 'connected' | 'action' | 'off';

export type SourceDef = {
  id: string;
  label: string;
  via: SourceVia;
  quota: SourceQuota;
  configured: () => boolean;
  envNames?: string[];
  freshWithinMs: number;
  lastOk: () => string | null;
  lastError: () => string;
  accountStatus?: () => string | null;
  nextStep: () => string;
};

export type SourceView = {
  id: string; label: string; via: SourceVia; quota: SourceQuota;
  state: SourceState; nextStep: string; lastOk: string | null;
  envNames: string[]; configured: boolean;
};

const MIN = 60_000;

/** Anything that smells like a credential is stripped before it can reach a page.
 *  028: the implementation lives in redact.ts (which imports nothing); re-exported here so every
 *  existing `from './sources.ts'` keeps working. */
import { redactText } from './redact.ts';
export { redactText };

/** One line for the source panel: redacted and trimmed to 120 characters. */
export function redact(text: string): string {
  return redactText(text).slice(0, 120);
}

const stateRow = (name: string) =>
  db().prepare('SELECT last_ok, last_run, last_error FROM connector_state WHERE name = ?').get(name) as
    { last_ok: string | null; last_run: string; last_error: string } | undefined;

const stateOf = (name: string) => stateRow(name)?.last_ok ?? null;
const errorOf = (name: string) => stateRow(name)?.last_error ?? '';

function account(name: string): { status: string; observed: string | null } | null {
  const row = db().prepare('SELECT status, balance_observed_at, updated_at FROM accounts WHERE name = ?')
    .get(name) as { status: string; balance_observed_at: string | null; updated_at: string } | undefined;
  return row ? { status: row.status, observed: row.balance_observed_at ?? row.updated_at } : null;
}

const readerSource = (id: string, label: string, accountName: string): SourceDef => ({
  id,
  label,
  via: 'reader',
  quota: 'credits',
  configured: () => {
    const row = db().prepare('SELECT 1 FROM accounts WHERE name = ? AND source = ?').get(accountName, 'reader');
    return Boolean(row);
  },
  envNames: [],
  freshWithinMs: 6 * 60 * MIN,
  lastOk: () => account(accountName)?.observed ?? null,
  lastError: () => '',
  accountStatus: () => account(accountName)?.status ?? null,
  nextStep: () => `在专用浏览器里登录一次：node scripts/quota-reader.mjs login ${id.split(':')[1]}`,
});

export const SOURCES: SourceDef[] = [
  {
    id: 'cliproxyapi',
    label: 'Codex（经 CLIProxyAPI）',
    via: 'proxy',
    quota: 'window',
    configured: connectorEnabled,
    envNames: ['CPA_URL', 'CPA_MANAGEMENT_KEY'],
    freshWithinMs: pollSeconds() * 3 * 1000,
    lastOk: () => stateOf('cliproxyapi'),
    lastError: () => errorOf('cliproxyapi'),
    nextStep: () => '确认 CLIProxyAPI 在运行，并检查 .env 里的 CPA_URL 与管理密钥',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（官方余额）',
    via: 'api',
    quota: 'balance',
    configured: () => Boolean((process.env.DEEPSEEK_API_KEY ?? '').trim()),
    envNames: ['DEEPSEEK_API_KEY'],
    freshWithinMs: 30 * MIN,
    lastOk: () => stateOf('deepseek'),
    lastError: () => errorOf('deepseek'),
    nextStep: () => '在 .env 填 DEEPSEEK_API_KEY 后重启容器',
  },
  {
    id: 'bailian',
    label: '百炼代金券（deepseek-v4.1-flash）',
    via: 'api',
    quota: 'balance',
    // The workbench never calls Bailian itself: the proxy reports its usage back, but what Claude Code
    // spends through its direct connection is invisible here — the balance is an estimate needing a
    // manual recalibration. No key is stored in the workbench; each side keeps its own.
    configured: () => {
      const row = db().prepare("SELECT balance_detail FROM accounts WHERE name = '百炼代金券'").get() as { balance_detail: string } | undefined;
      if (!row) return false;
      let total = 0;
      try { total = Number(JSON.parse(row.balance_detail || '{}').voucher_total) || 0; } catch { total = 0; }
      return total > 0 && connectorEnabled();
    },
    envNames: [],
    freshWithinMs: pollSeconds() * 3 * 1000,
    lastOk: () => stateOf('cliproxyapi'), // its usage rides the CLIProxyAPI queue
    lastError: () => '',
    nextStep: () => 'Claude Code 直连：把 base-url 指到 /apps/anthropic、模型用 deepseek-v4.1-flash；反代那条继续供用量回传。代金券总额和单价在「执行者 › 账号与额度」里填，用完手动校准',
  },
  {
    id: 'glm',
    label: 'GLM Coding Plan',
    via: 'api',
    quota: 'window',
    configured: glmEnabled,
    envNames: ['ZAI_API_KEY', 'ZAI_REGION'],
    freshWithinMs: 30 * MIN,
    lastOk: () => stateOf('glm'),
    lastError: () => errorOf('glm'),
    nextStep: () => '没有 Coding Plan，GLM 额度不可用（2026-10-29 核对：当前用户不存在 coding plan）；续费后再在 .env 填 ZAI_API_KEY',
  },
  {
    id: 'github',
    label: 'GitHub 任务通道',
    via: 'api',
    quota: 'usage',
    configured: githubEnabled,
    envNames: ['GITHUB_REPOS', 'GITHUB_ALLOWED_AUTHORS'],
    freshWithinMs: 15 * 60 * 1000, // polls every 5 minutes
    lastOk: () => stateOf('github'),
    lastError: () => errorOf('github'),
    nextStep: () => '在执行器配置里填 githubToken，在工作台配置仓库和作者白名单',
  },
  readerSource('reader:workbuddy', 'WorkBuddy 积分', 'WorkBuddy'),
  readerSource('reader:autoclaw', 'AutoClaw 积分', 'AutoClaw'),
  {
    id: 'sync:claude-code',
    label: 'Claude Code 用量同步',
    via: 'sync',
    quota: 'usage',
    // sync-usage.mjs writes source_key 'claude:…' / 'codex:…'; the machines table is the
    // heartbeat from heartbeat.sh, which is a different thing entirely.
    configured: () => Boolean(db().prepare("SELECT 1 FROM usage WHERE source_key LIKE 'claude:%' OR source_key LIKE 'codex:%' LIMIT 1").get()),
    envNames: [],
    freshWithinMs: 7 * 24 * 60 * MIN, // two quiet days are normal for Claude Code
    lastOk: () => {
      const row = db().prepare("SELECT MAX(ts) t FROM usage WHERE source_key LIKE 'claude:%' OR source_key LIKE 'codex:%'").get() as { t: string | null };
      return row.t;
    },
    lastError: () => '',
    nextStep: () => '在这台电脑上跑 node scripts/sync-usage.mjs（或注册它的计划任务）',
  },
];

/** Decisions already made: these are deliberately not connected. */
export const EXCLUDED: { id: string; label: string; reason: string }[] = [
  { id: 'claude-proxy', label: 'Claude（反代）', reason: 'Claude 只作决策端，走官方客户端，不在 CLIProxyAPI 里登录' },
  { id: 'workbuddy-proxy', label: 'WorkBuddy（反代）', reason: '没有官方接口，转 API 有违反服务条款和封号的风险' },
  { id: 'autoclaw-proxy', label: 'AutoClaw（反代）', reason: '同上，只读自己的用量页，不做反代' },
  { id: 'workbuddy-checkin', label: 'WorkBuddy 自动签到', reason: '不代替你使用这些服务' },
];

export function sourceOff(id: string): boolean {
  const row = db().prepare('SELECT off FROM source_prefs WHERE id = ?').get(id) as { off: number } | undefined;
  return row?.off === 1;
}

export function setSourceOff(id: string, off: boolean): void {
  if (!SOURCES.some((s) => s.id === id)) {
    const excluded = EXCLUDED.find((e) => e.id === id);
    throw new HttpError(400, excluded ? '这个是「不接」的来源，不需要开关' : `没有来源 ${id}`);
  }
  db().prepare(`INSERT INTO source_prefs (id, off, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET off = excluded.off, updated_at = excluded.updated_at`).run(id, off ? 1 : 0, nowIso());
  logEvent({ actor: 'me', kind: off ? 'source.off' : 'source.on', text: `${off ? '停用' : '启用'}来源 ${id}` });
}

function stateFor(s: SourceDef): SourceState {
  if (sourceOff(s.id)) return 'off';
  if (!s.configured()) return 'action';
  if (s.id === 'github' && !runnerOnline()) return 'action';
  const st = s.accountStatus?.();
  if (st === 'relogin' || st === 'readfail') return 'action';
  const ok = s.lastOk();
  if (!ok) return 'action';
  // A failure newer than the last success means it is broken right now, even when the last
  // success is still inside the freshness window (a plan that just expired looks like this).
  const row = stateRow(s.id);
  if (row?.last_error && Date.parse(row.last_run || '') >= Date.parse(row.last_ok || '')) return 'action';
  const age = Date.now() - Date.parse(ok);
  if (!Number.isFinite(age) || age > s.freshWithinMs) return 'action';
  return 'connected';
}

function nextStepFor(s: SourceDef, state: SourceState): string {
  if (s.id === 'github' && state !== 'off' && s.configured()) {
    if (!runnerOnline()) return '执行器离线，GitHub 通道暂停';
    if (state === 'connected') {
      const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(s.lastOk()!)) / MIN));
      return minutes ? `执行器 ${minutes} 分钟前转发过` : '执行器刚刚转发过';
    }
  }
  if (state !== 'action') return s.nextStep();
  if (!s.configured()) return s.nextStep();
  const st = s.accountStatus?.();
  if (st === 'relogin') return s.nextStep();
  if (st === 'readfail') return '页面可能改版，先用「更新」手动填一次，再跑 probe 看接口';
  const err = s.lastError();
  const ok = s.lastOk();
  if (err) return `上次失败：${redact(err)}`;
  if (ok) return `上次成功是 ${ok}，已经超过 ${Math.round(s.freshWithinMs / MIN)} 分钟没更新`;
  return s.nextStep();
}

export function listSources(): (SourceView & { excluded?: false })[] {
  return SOURCES.map((s) => {
    const state = stateFor(s);
    return {
      id: s.id,
      label: s.label,
      via: s.via,
      quota: s.quota,
      state,
      nextStep: nextStepFor(s, state),
      lastOk: s.lastOk(),
      envNames: s.envNames ?? [],
      configured: s.configured(),
    };
  });
}

/** How many sources are waiting on the user. */
export function needsAttention(): number {
  return listSources().filter((s) => s.state === 'action').length;
}
