// 035 C：部署审批。推送成功以后，如果这次改动动了会跑在工作台进程里的东西
// （src/、public/、scripts/、Dockerfile、docker-compose.yml、package.json），
// 执行器要再请人批一次，然后重建容器、等健康检查、把自己换成新进程。
//
// 三件事都不自动做：不动代码、不回滚、失败只标「部署失败」。
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_NAME, spawnHandoff } from './handoff.mjs';

const COMPOSE_FILE = 'docker-compose.yml';

/**
 * 035.3：部署只对「执行器自己正在跑的这个仓库」成立。
 *
 * 原来只要文件名命中 DEPLOY_TRIGGERS 就弹部署审批，不看是哪个项目——别的项目改了 `src/app.ts`
 * 也会出现「重建工作台并重启执行器」，批准后还会在**那个项目的目录**里跑 docker compose。
 *
 * 用真实路径比项目名可靠：名字可以重复、可以改，符号链接还能指到别处。
 * 比较前只在 Windows 上忽略大小写（那边文件系统本来就不区分）。
 */
export function deployApplies({ project, repo, fs = { realpathSync, existsSync } }) {
  try {
    const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
    const a = norm(fs.realpathSync(project));
    const b = norm(fs.realpathSync(repo));
    if (a !== b) return false;
    return Boolean(fs.existsSync(join(fs.realpathSync(repo), COMPOSE_FILE)));
  } catch {
    return false;
  }
}

/** 这次推送要不要走部署：动了会跑在工作台里的东西 **且** 这个项目就是工作台自己。 */
export function shouldDeploy({ files, project, repo, fs }) {
  return needsDeploy(files) && deployApplies({ project, repo, fs });
}

/** 动了这些路径就要重建 / 重启。 */
export const DEPLOY_TRIGGERS = [/^src\//, /^public\//, /^scripts\//, /^Dockerfile$/, /^docker-compose\.yml$/, /^package\.json$/];

export function needsDeploy(files) {
  return (files ?? []).some((f) => DEPLOY_TRIGGERS.some((re) => re.test(String(f).replace(/\\/g, '/'))));
}

/** 审批里列出来的那几项（去重、只列顶层目录/文件名）。 */
export function deployDirs(files) {
  const out = new Set();
  for (const raw of files ?? []) {
    const f = String(raw).replace(/\\/g, '/');
    if (!needsDeploy([f])) continue;
    const top = f.includes('/') ? `${f.split('/')[0]}/` : f;
    out.add(top);
  }
  return [...out].sort();
}

/** 推送之前算：这次要推上去的提交改了哪些文件。origin/main 还是旧的，正好当基准。 */
export function changedFiles(project, run) {
  try {
    return run(project, 'diff', '--name-only', 'origin/main..HEAD').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真的部署。`io` 让测试能用假命令：run（跑到 docker 的那一步）、probe（健康检查）、
 * restart（换进程）、sleep、log。
 */
export async function runDeploy({ cfg, project, io = {}, canHandoff = () => true }) {
  // 035.4：构建允许跑 10 分钟，原来是 spawnSync——主线程被钉住，心跳定时器跟着停，
  // 守卫 5 分钟没看到心跳就把一条合法的构建杀了，部署回报和任务收尾都来不及写。
  // 改成异步等待：事件循环活着，心跳照常推进，日志（docker 的输出）也不用憋到最后一起吐。
  const run = io.run ?? ((cwd, cmd, args, opts = {}) => new Promise((done) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeout
      ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, opts.timeout)
      : null;
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => { if (timer) clearTimeout(timer); done({ error, status: null, stdout, stderr }); });
    child.on('close', (status) => { if (timer) clearTimeout(timer); done({ status, stdout, stderr }); });
  }));
  const probe = io.probe ?? (async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  });
  const wait = io.sleep ?? sleep;
  const say = io.log ?? (() => {});
  // 035.3：这里原来读的是 `cfg.baseUrl`，而执行器配置里工作台地址叫 `workbench`
  // （`runner.mjs` 的 config() 和自检都用这个名字）。读错的结果是 base 永远是空串，
  // 再撞上「没配就按成功算」，于是一次健康检查都没发过：容器还没起来也宣布成功，然后把自己退出。
  const base = String(cfg.workbench ?? '').replace(/\/+$/, '');

  // 查不了 ≠ 成功。地址缺失或不像个地址，就在动容器**之前**失败——否则容器停在半新半旧，
  // 而任务页写着「已部署」，比直接报错更难收拾。
  if (!base) {
    return { ok: false, why: '执行器配置里没有 workbench 地址，没法确认部署是否成功，这次没动容器' };
  }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, why: `执行器配置里的 workbench 不是 http/https 地址（读到的是「${base.slice(0, 60)}」），这次没动容器` };
  }

  // 035.3.2：格式对不代表地址对。端口写错一个数字、域名改成别的机器，都还是「合法 http 地址」，
  // 按原来的顺序会先把容器重建了，两分钟后再宣布「查不到」——容器已经动过，正是要避免的「半新半旧」。
  // 所以动手之前先问一次：这个地址现在真的应答吗。不应答就停在这里，一个容器都不动。
  say('部署前先确认 workbench 地址现在应答（/api/health）');
  if (!(await probe(`${base}/api/health`))) {
    return {
      ok: false,
      why: `部署前查了一次 ${base}/api/health，没有应答：地址可能写错了，或者工作台正停着。这次没动容器`,
    };
  }

  say('重建工作台容器（docker compose up -d --build）');
  const build = await run(project, 'docker', ['compose', 'up', '-d', '--build'], { timeout: 10 * 60_000 });
  if (!build) return { ok: false, why: '没跑起来 docker compose（这台机器上没有 docker？）' };
  if (build.error) return { ok: false, why: `docker compose 跑不动：${build.error.message}` };
  if (build.status !== 0) {
    const tail = String(build.stderr || build.stdout || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, why: `容器没起来（退出码 ${build.status}）${tail ? `：${tail.slice(0, 200)}` : ''}` };
  }

  // 容器起来到能应答有一段时间：最多等 2 分钟，每 5 秒问一次（测试里会调小）。
  say('等工作台恢复（/api/health，最多 2 分钟）');
  const healthMs = Number(cfg.deployHealthWaitMs ?? 2 * 60_000);
  const every = Number(cfg.deployHealthEveryMs ?? 5000);
  const deadline = Date.now() + healthMs;
  let alive = false;
  while (Date.now() < deadline) {
    if (await probe(`${base}/api/health`)) { alive = true; break; }
    await wait(every);
  }
  if (!alive) return { ok: false, why: '容器重建了，但两分钟内 /api/health 没应答' };
  if (!canHandoff()) {
    return { ok: true, note: '还有任务的审批流程没有结束，执行器继续运行；等它们结束后再手动重启' };
  }

  // 035.3：重启改成「交接」。原来是旧执行器还活着的时候点计划任务——计划任务配的是
  // `-MultipleInstances IgnoreNew`，启动脚本里还有一道「已经有人在跑就跳过」，等于什么都没发生，
  // 而 Start-ScheduledTask 照样返回 0；旧的随后退出，最后可能一个执行器都不剩。
  // 现在只做一件事：起一个脱身的助手，它会在旧进程真的退出之后才启动新实例，并把结果写进日志。
  say('交接：起一个脱身的助手，等这个进程退出后由它启动新实例');
  const handoffStep = io.handoff ?? (() => spawnHandoff({ pid: process.pid, taskName: cfg.runnerTaskName ?? TASK_NAME }));
  const h = await handoffStep();
  // 助手没起来不算部署失败：容器已经是新的了，只是还得人手动重启一下执行器。
  if (!h || h.ok === false) {
    const why = h?.why ? `${h.why}；执行器还得手动重启一次` : '没能起接班助手，执行器还得手动重启一次';
    return { ok: true, why: '', note: why };
  }
  return { ok: true, why: '', handoff: true, helper: h.pid };
}
