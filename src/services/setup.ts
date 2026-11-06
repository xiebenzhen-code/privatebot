// 020: "did the install actually work?" — one read-only checklist that both the web page (020b)
// and an agent's `GET /api/setup/status` read. Nothing here ever leaves a path or a key in the JSON.
import { db } from '../db.ts';
import { passwordConfigured } from '../auth.ts';
import { getSetting, setSetting } from './dispatch.ts';
import { logEvent } from './core.ts';
import { runnerOnline, listRunners } from './runner.ts';
import { redact } from './sources.ts';
import { githubEnabled } from './github.ts';

/**
 * 034：手动启动执行器的命令只有一份，在 scripts/lib/commands.mjs（setup 向导也用同一份）。
 * 走守卫而不是 runner 本体：守卫用 pid 锁保证同时只有一个 runner，手动开和开机自启撞在一起也不会双份额度。
 */
import { DIAGNOSE_CMD, RUNNER_CHECK_CMD, RUNNER_CMD } from '../../scripts/lib/commands.mjs';
export { DIAGNOSE_CMD, RUNNER_CHECK_CMD, RUNNER_CMD };

export type SetupItem = {
  key: string;
  title: string;
  ok: boolean;
  optional: boolean;
  /** One short sentence: what to do when `ok` is false. Never a path, never a key. */
  hint: string;
};

type RunnerMeta = {
  executors?: string[];
  projects?: string[];
  backends?: string[];
  check?: { ok?: boolean; at?: string; summary?: string };
};

const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

/** A project/backend label is a name, not a path and not a key. Anything else is dropped. */
export function cleanName(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/[\\/:]/.test(s) || /sk-|bearer|token|key/i.test(s)) return '';
  return NAME_OK.test(s) ? s : '';
}

export const cleanNames = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map(cleanName).filter(Boolean).slice(0, 20);

/** The freshest heartbeat wins: a runner that restarted must not inherit the old project list. */
export function latestRunnerMeta(): RunnerMeta {
  const row = db().prepare(`SELECT meta FROM runners ORDER BY last_seen DESC LIMIT 1`).get() as
    { meta?: string } | undefined;
  if (!row?.meta) return {};
  try {
    const raw = JSON.parse(row.meta) as Record<string, unknown>;
    const check = (raw.check ?? {}) as Record<string, unknown>;
    return {
      executors: cleanNames(raw.executors),
      projects: cleanNames(raw.projects),
      backends: cleanNames(raw.backends),
      check: {
        ok: check.ok === true,
        at: typeof check.at === 'string' ? check.at.slice(0, 40) : '',
        summary: redact(String(check.summary ?? '')).slice(0, 200),
      },
    };
  } catch {
    return {};
  }
}

const firstTaskDone = (): boolean => {
  const row = db().prepare(`SELECT COUNT(*) n FROM tasks
    WHERE runner_id IS NOT NULL AND runner_id <> '' AND status IN ('done', 'failed')`).get() as { n: number };
  return row.n > 0;
};

/** 020 checklist. Same data for the page and for agents — the only difference is how it is drawn. */
export function setupStatus(): { items: SetupItem[]; done: number; total: number; all_ok: boolean; dismissed: boolean } {
  const meta = latestRunnerMeta();
  const online = runnerOnline();
  const projects = meta.projects ?? [];
  const backends = meta.backends ?? [];
  const check = meta.check ?? {};

  const items: SetupItem[] = [
    { key: 'workbench', title: '工作台在运行', ok: true, optional: false, hint: '能看到这个页面就是好了。' },
    {
      key: 'password', title: '网页密码已设置', ok: passwordConfigured(), optional: false,
      hint: '在 .env 里填 WB_PASSWORD（至少 12 位，不能和 WB_TOKEN 相同），然后重启工作台。',
    },
    {
      key: 'runner', title: '执行器已连上', ok: online, optional: false,
      hint: `在项目目录里运行 ${RUNNER_CMD}，保持那个窗口开着。`,
    },
    {
      key: 'projects', title: '至少配了一个项目', ok: projects.length > 0, optional: false,
      hint: online
        ? '执行器起来了，但配置里没有项目。运行 npm run setup，或在执行器的配置文件里加一行 projects。'
        : '还没检测到。先运行 npm run setup（或者在执行器配置里加一行项目）。',
    },
    {
      key: 'backend', title: '模型后端可用', ok: check.ok === true, optional: false,
      hint: check.ok
        ? '执行器自检通过。'
        : (check.summary || `运行 ${RUNNER_CHECK_CMD} 看哪一项没过。`),
    },
    {
      key: 'first_task', title: '跑过第一个任务', ok: firstTaskDone(), optional: false,
      hint: '新建一个只读任务试试：让它读一遍 README，用三句话说这个项目做什么，然后点「开始」。',
    },
    {
      key: 'backup', title: '自动备份目录', ok: Boolean((process.env.WB_BACKUP_DIR ?? '').trim()), optional: true,
      hint: '设置 › 数据 › 备份：填一个文件夹（可以是网盘同步目录），默认每天 03:30。',
    },
    {
      key: 'github', title: 'GitHub Issue 通道', ok: githubEnabled() && runnerOnline(), optional: true,
      hint: '执行器配置填 githubToken；工作台配置仓库和作者白名单。不接也能自己建任务。',
    },
    {
      key: 'phone', title: '手机访问与推送', ok: Boolean(getSetting('public_url')), optional: true,
      hint: '用 Tailscale 让手机能看到这个页面，设置 › 调度里填网址。别用 funnel 开到公网。',
    },
    {
      key: 'digest', title: '工作台日报', ok: getSetting('digest.on') === '1', optional: true,
      hint: '设置 › 接入 › 日报：打开开关，每天早上把概况写到一个固定 Issue。默认关。',
    },
  ];

  // Optional rows only count as "done" for display; the pass/fail gate is the required ones.
  const required = items.filter((i) => !i.optional);
  return {
    items,
    done: required.filter((i) => i.ok).length,
    total: required.length,
    all_ok: required.every((i) => i.ok),
    dismissed: getSetting('setup_dismissed') === '1',
  };
}

export const dismissSetup = (on: boolean, actor: string): void => {
  setSetting('setup_dismissed', on ? '1' : '0');
  logEvent({ actor, kind: 'setup.dismissed', text: on ? '点了「不再提示」' : '重新打开上手清单' });
};

/** For the page: is anyone home, and how fresh is the last beat. */
export const setupRunnerInfo = () => {
  const runners = listRunners();
  const fresh = runners.filter((r) => r.online)[0] ?? runners[0];
  return { online: runnerOnline(), runners: runners.length, last_seen: fresh?.last_seen ?? '' };
};
