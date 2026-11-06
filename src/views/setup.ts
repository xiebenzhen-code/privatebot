// 020b: the same checklist `GET /api/setup/status` returns, drawn as a card. No keys, no paths —
// the page never asks for a secret, so it is safe to leave unlocked behind the normal login.
//
// 034: 整页只回答一件事「我现在该做哪一步」。一次只展开一步：一句话说清这是什么、一条能复制的命令、
// 一句「成功会怎样」。做完的收成一行，没轮到的灰着只留标题——不再把十条命令平铺给人看。
import { listExecutorSettings } from '../services/dispatch.ts';
import { latestRunnerMeta, RUNNER_CHECK_CMD, RUNNER_CMD, type SetupItem } from '../services/setup.ts';
import { runnerOnline } from '../services/runner.ts';
import { html, type Safe } from './html.ts';

type Status = { items: SetupItem[]; done: number; total: number; all_ok: boolean; dismissed: boolean };

/** 034：报错只留一个入口。这句话落页面前核对过：diagnose 的输出已经打码，不含密钥和本机用户名。 */
const DIAGNOSE_CMD = 'npm run diagnose';

/** 「执行器」这个词出现在哪都要跟着这句解释，所以只写一次。 */
const RUNNER_WHAT = '装在你自己的电脑上、真正替你干活的程序';

type Step = {
  /** 没做完时标题写动作，做完由 setupStatus 的 title 写结果。 */
  action: string;
  /** 这是什么。一句话。 */
  what?: string;
  /** 能直接复制的命令。 */
  cmd?: string;
  /** 在哪儿敲。整页只在需要敲命令的步骤出现。 */
  where?: string;
  /** 成功会怎样。一句话，得是能看见的东西。 */
  success?: string;
};

const PS_WHERE = '在 PowerShell 里敲（开始菜单搜 PowerShell），先 cd 到本项目的文件夹。';

const STEP: Record<string, Step> = {
  workbench: { action: '打开工作台', success: '能看到这个页面就是好了。' },
  password: {
    action: '设置网页密码',
    what: '这个页面只有你自己能看：进来要一句只有你知道的密码。',
    cmd: '# 在 .env 里加一行，然后重启工作台\nWB_PASSWORD=至少十二位\n\ndocker compose up -d --force-recreate',
    where: '在仓库目录里敲（.env 就在那）。用 npm start 起的话，改成重启那个窗口。',
    success: '重启后打开页面，先要你输密码才进得来。',
  },
  runner: {
    action: '启动执行器',
    what: `它是${RUNNER_WHAT}；没开它，任务只会排队。`,
    cmd: RUNNER_CMD,
    where: PS_WHERE,
    success: '窗口里出现「门禁配置就绪」，这一行十几秒内自己变绿。',
  },
  projects: {
    action: '配一个项目',
    what: '告诉执行器去哪个文件夹干活、用哪个模型。',
    cmd: 'npm run setup',
    where: '在同一个 PowerShell 窗口里敲。',
    success: '这一行变绿，新建任务时「项目」下拉里就能选到它。',
  },
  backend: {
    action: '检查模型后端',
    what: '模型后端是真正写代码的那个模型；执行器每次自检都会挨个问一遍。',
    cmd: RUNNER_CHECK_CMD,
    where: '在同一个 PowerShell 窗口里敲。',
    success: '最后一行是「一切就绪，可以跑任务了」。',
  },
  first_task: {
    action: '跑第一个任务',
    what: '建一个只读任务，确认从网页到执行器整条链路是通的。',
    success: '任务跑到「做完了」，结果里有它写的内容。',
  },
};

const MARK = (ok: boolean, optional: boolean): Safe => ok
  ? html`<span class="setup-mark ok" aria-label="已完成">✓</span>`
  : html`<span class="setup-mark ${optional ? 'opt' : 'todo'}" aria-label="${optional ? '可选' : '待做'}">${optional ? '·' : '!'}</span>`;

type Guide = { step: number; total: number; action: string; current: string };

/** 当前这一步 = 第一个没做完的必做项。编号按必做项的顺序算，所以「执行器」永远是第 3 步。 */
function guideOf(s: Status): Guide {
  const required = s.items.filter((i) => !i.optional);
  const idx = required.findIndex((i) => !i.ok);
  const item = required[idx < 0 ? required.length - 1 : idx];
  const actionOf = (i: SetupItem) => (i.ok ? i.title : (STEP[i.key]?.action ?? i.title));
  return {
    step: (idx < 0 ? required.length : idx) + 1,
    total: required.length,
    action: item ? actionOf(item) : '',
    current: idx < 0 ? '' : item.key,
  };
}

/** 自启不单独拆一步：执行器连上之后，在这一行的完成态下面挂一句就够。 */
function autostartLine(): Safe {
  const repo = (process.env.GITHUB_REPOS ?? '').split(',')[0]?.trim();
  const text = '想开机自动启动？见 INSTALL-WINDOWS 文档';
  return repo
    ? html`<a class="setup-also" href="https://github.com/${repo}/blob/main/docs/INSTALL-WINDOWS.md#让执行器runner也开机自启" target="_blank" rel="noreferrer">${text}</a>`
    : html`<span class="setup-also">${text}：docs/INSTALL-WINDOWS.md</span>`;
}

const row = (i: SetupItem, g: Guide): Safe => {
  const id = `setup-${i.key}`;
  const step = STEP[i.key] ?? { action: i.title };
  if (i.ok) {
    return html`<li class="setup-row ok" id="${id}">
      ${MARK(true, false)}
      <div class="setup-body">
        <span class="setup-title">${i.title}</span>
        ${i.key === 'runner' ? autostartLine() : ''}
      </div>
    </li>`;
  }
  if (i.key !== g.current) {
    return html`<li class="setup-row todo later" id="${id}">
      ${MARK(false, false)}
      <div class="setup-body"><span class="setup-title">${step.action}</span></div>
    </li>`;
  }
  return html`<li class="setup-row todo current" id="${id}">
    ${MARK(false, false)}
    <div class="setup-body">
      <span class="setup-title">${step.action}</span>
      ${step.what ? html`<p class="setup-what">${step.what}</p>` : ''}
      ${step.cmd ? html`<div class="setup-cmd">
        <pre class="mono small">${step.cmd}</pre>
        <button type="button" class="btn small" data-copy>复制</button>
      </div>` : ''}
      ${step.where ? html`<span class="setup-where">${step.where}</span>` : ''}
      ${i.key === 'first_task' ? sampleTaskForm() : ''}
      ${step.success ? html`<span class="setup-success">成功会怎样：${step.success}</span>` : ''}
      <span class="setup-help">不行？先运行 <span class="mono small">${DIAGNOSE_CMD}</span>，把输出发给帮你的人。</span>
    </div>
  </li>`;
};

/** 可选项不参与指路：不做也能开始用，所以永远是一行说明。 */
const optRow = (i: SetupItem): Safe => html`
  <li class="setup-row ${i.ok ? 'ok' : 'opt'}" id="setup-${i.key}">
    ${MARK(i.ok, true)}
    <div class="setup-body">
      <span class="setup-title">${i.title}${i.ok ? '' : html`<span class="chip tiny">可选</span>`}</span>
      ${i.ok ? '' : html`<span class="setup-hint">${i.hint}</span>`}
    </div>
  </li>`;

/**
 * 034C / 025.1：示例任务必须带项目、带执行器真的会领的执行者。
 * 点不了就明说为什么、并且指回该做的那一步——摆一个点了没反应的按钮比没有按钮更糟。
 */
export function sampleTaskForm(): Safe {
  const meta = latestRunnerMeta();
  const project = (meta.projects ?? [])[0];
  const dead = (reason: Safe) => html`<div class="setup-mini">
    <button type="button" class="btn small" disabled>试试这个：建一个只读任务</button>
    <span class="setup-reason">${reason}</span>
  </div>`;

  if (!runnerOnline()) {
    return dead(html`先把执行器开起来，<a href="#setup-runner">见上面第 3 步</a>。`);
  }
  if (!project) {
    return html`<span class="setup-hint">还没有项目——先做上面第 4 步「配一个项目」（<span class="mono small">npm run setup</span>），
      再回来点这个按钮。没有项目的话，任务一进队列就会失败。</span>`;
  }
  const executor = sampleExecutor(meta.executors ?? []);
  if (!executor) {
    return dead(html`执行者被暂停了，<a href="/team/executors">去「执行者」页</a>打开一个再回来。`);
  }
  return html`<form class="inline-mini" data-api="/api/tasks" data-method="POST" data-redirect="/tasks">
    <input type="hidden" name="title" value="读一遍 README，用三句话说这个项目做什么">
    <input type="hidden" name="category" value="dev">
    <input type="hidden" name="executor" value="${executor}">
    <input type="hidden" name="project" value="${project}">
    <input type="hidden" name="mode" value="manual">
    <button class="btn small">试试这个：建一个只读任务</button>
  </form>`;
}

/** 执行器报过哪些执行者就用哪些；报过但全被暂停就返回空字符串，让按钮明说点不了。 */
function sampleExecutor(advertised: string[]): string {
  const rows = listExecutorSettings() as { executor: string; enabled?: number }[];
  const enabled = rows.filter((r) => r.enabled !== 0).map((r) => r.executor);
  // 老执行器还没报 executors 时退回本地设置，别因为一个新字段把按钮整个关掉。
  if (!advertised.length) return enabled[0] ?? 'pool';
  return advertised.find((e) => enabled.includes(e)) ?? '';
}

export function setupCard(s: Status, opts: { dismissible?: boolean } = {}): Safe {
  const left = s.total - s.done;
  const g = guideOf(s);
  const required = s.items.filter((i) => !i.optional);
  const optional = s.items.filter((i) => i.optional);
  return html`<section class="panel setup-card" id="setup">
    <div class="panel-head">
      <h2>开始使用 ${s.all_ok ? html`<span class="count ok">全好了</span>` : html`<span class="count warn">还差 ${left} 项</span>`}</h2>
      ${opts.dismissible === false ? '' : html`<form class="inline-mini" data-api="/api/setup/dismiss" data-method="POST">
        <input type="hidden" name="on" value="1">
        <button class="btn small">不再提示</button>
      </form>`}
    </div>
    ${s.all_ok
      ? html`<p class="setup-next ok">六步都做完了，不用再走这里。</p>`
      : html`<p class="setup-next">下一步：<strong>${g.action}</strong><span class="meta">第 ${g.step} 步，共 ${g.total} 步</span></p>`}
    <p class="hint">这一页只做检查，不收任何密钥；要写 key 的地方在终端里（<span class="mono small">npm run setup</span>）。
      先记住一句：执行器 = ${RUNNER_WHAT}。</p>
    <ol class="setup-list">${required.map((i) => row(i, g))}</ol>
    ${optional.length ? html`<p class="setup-sub">可选项，不做也能开始用</p>
      <ol class="setup-list compact">${optional.map(optRow)}</ol>` : ''}
  </section>`;
}

/** 设置 › 接入 里的入口：清单随时能打开，哪怕已经点过「不再提示」。 */
export function setupSettingsBlock(s: Status): Safe {
  const g = guideOf(s);
  const required = s.items.filter((i) => !i.optional);
  return html`<div class="panel" id="setup-settings">
    <div class="panel-head"><h2>上手清单</h2>
      <span class="meta">${s.all_ok ? html`<span class="count ok">全好了</span>` : `${s.done}/${s.total} 项必做`}</span></div>
    ${s.dismissed ? html`<p class="hint">今天页上的清单已经收起来了，这里随时能看。</p>` : ''}
    ${s.all_ok
      ? html`<p class="setup-next ok">六步都做完了，不用再走这里。</p>`
      : html`<p class="setup-next">下一步：<strong>${g.action}</strong><span class="meta">第 ${g.step} 步，共 ${g.total} 步</span></p>`}
    <ol class="setup-list compact">${required.map((i) => row(i, g))}</ol>
    <div class="panel-foot">
      ${s.dismissed ? html`<form class="inline-mini" data-api="/api/setup/dismiss" data-method="POST">
        <input type="hidden" name="on" value="0"><button class="btn small">在「今天」页重新显示</button>
      </form>` : ''}
      <span class="meta">让 agent 自己读清单：<span class="mono small">curl -H "Authorization: Bearer $WB_TOKEN" /api/setup/status</span></span>
    </div>
  </div>`;
}
