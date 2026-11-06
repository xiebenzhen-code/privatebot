// 046 §1：沙箱供应商接口。runner 只认这个形状，不关心下面是容器、虚拟机还是宿主。
//
//   provider.name / provider.tier            'docker'/1 · 'vm'/2 · 'none'/0
//   await provider.available()               → { ok, why }
//   const box = await provider.create({ taskId, runId, env? })
//   await box.exec(argv, { cwd, env, onLine, timeoutMs })     → { code, signal, timedOut }
//   await box.writeFile(boxPath, data)       往 tmpfs 里放文件（docker cp 写不进 tmpfs，所以走 stdin）
//   await box.copyIn(hostPath, boxPath)      只许进 /work
//   await box.copyOut(boxPath, emptyHostDir) 只许从 /work 出一个普通文件
//   await box.pause() / box.resume() / box.destroy()   destroy 幂等
//   box.info()                               → { id, provider, tier, startedAt }
//
// 所有会起进程的地方都收一个可替换的函数，测试里换成假的，不需要真 Docker。
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ENV_ALLOW, buildRunArgs, buildSidecarArgs, normalizeLimits, taskOfName } from './docker-args.mjs';
import { parseAllowlist } from './egress.mjs';
import { gatewayConfig } from './gateway-core.mjs';

const MAX_OUT_BYTES = 20 * 1024 * 1024;

/** 容器里的路径：必须是绝对的、不带 .. 、落在允许的根下。 */
export function assertBoxPath(p, roots) {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || /[\r\n]/.test(p)) throw new Error('容器里的路径不合规');
  if (!p.startsWith('/') || p.includes('\\')) throw new Error(`容器里的路径要是绝对的 posix 路径：${p.slice(0, 60)}`);
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`容器里的路径不能含 . .. 或空段：${p.slice(0, 60)}`);
  if (!roots.some((r) => p === r || p.startsWith(`${r}/`))) throw new Error(`容器里只许碰 ${roots.join('、')}：${p.slice(0, 60)}`);
  return p;
}

const defaultDocker = (args, { input, timeoutMs = 120_000 } = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, timeout: timeoutMs, windowsHide: true });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
};

// ───────────── none：今天的做法，直接在宿主上跑 ─────────────

export class NoneProvider {
  constructor(opts = {}) { this.name = 'none'; this.tier = 0; this.spawnFn = opts.spawn ?? spawn; }
  async available() { return { ok: true, why: '' }; }
  async create({ taskId }) {
    const startedAt = new Date().toISOString();
    const spawnFn = this.spawnFn;
    return {
      async exec(argv, { cwd, env, onLine, timeoutMs } = {}) { return streamExec(spawnFn, argv[0], argv.slice(1), { cwd, env }, onLine, timeoutMs, () => {}); },
      async writeFile() { /* 宿主上直接写，调用者自己管 */ },
      async copyIn() {}, async copyOut() { return null; },
      async pause() {}, async resume() {}, async destroy() {},
      info: () => ({ id: `host-T${taskId}`, provider: 'none', tier: 0, startedAt }),
    };
  }
}

// ───────────── vm：第二档，占位 ─────────────

export class VmProvider {
  constructor() { this.name = 'vm'; this.tier = 2; }
  async available() { return { ok: false, why: '第二档（真虚拟机）还没实现' }; }
  async create() { throw new Error('第二档（真虚拟机）还没实现'); }
}

// ───────────── docker：第一档 ─────────────

function streamExec(spawnFn, cmd, args, { cwd, env } = {}, onLine, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { cwd, env, windowsHide: true });
    let timedOut = false;
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (onLine) onLine(line.replace(/\r$/, '')); }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; try { onTimeout(); } catch { /* 杀不掉也要往下走 */ } try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, timeoutMs) : null;
    child.on('error', () => { if (timer) clearTimeout(timer); resolve({ code: 127, signal: null, timedOut }); });
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); if (buf && onLine) onLine(buf); resolve({ code: code ?? 1, signal: signal ?? null, timedOut }); });
  });
}

export class DockerProvider {
  /**
   * @param {{image:string, limits?:object, docker?:Function, spawn?:Function, rand?:()=>string, now?:()=>Date}} opts
   */
  constructor(opts) {
    this.name = 'docker';
    this.tier = 1;
    this.image = opts.image;
    this.limits = opts.limits ?? {};
    this.docker = opts.docker ?? defaultDocker;
    this.spawnFn = opts.spawn ?? spawn;
    this.rand = opts.rand ?? (() => Math.random().toString(36).slice(2, 8).padEnd(6, '0'));
    this.now = opts.now ?? (() => new Date());
  }

  async available() {
    const v = this.docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
    if (v.code !== 0) return { ok: false, why: '没装 Docker，或者 Docker Desktop 没启动' };
    const img = this.docker(['image', 'inspect', '--format', '{{.Id}}', this.image], { timeoutMs: 15_000 });
    if (img.code !== 0) return { ok: false, why: `镜像 ${this.image} 还没建（先跑 npm run sandbox:build）` };
    return { ok: true, why: '' };
  }

  /**
   * @param {{taskId:number, runId?:number, env?:Record<string,string>,
   *          egress?:{allow:string[], block?:string[]},
   *          gateway?:{upstream:string, preset:string, key:string}}} o
   *   egress 不给 = 完全没有出口（连代理都不起）；gateway 不给 = 不起网关。
   */
  async create({ taskId, runId = 0, env, egress, gateway } = {}) {
    const sfx = this.rand();
    const net = `wb-sbx-net-T${taskId}-${sfx}`;
    const egr = `wb-sbx-egr-T${taskId}-${sfx}`;
    const vol = `wb-sbx-vol-T${taskId}-${sfx}`;
    const name = `wb-sbx-T${taskId}-${sfx}`;
    const proxyName = `${name}-proxy`;
    const gwName = `${name}-gw`;
    const image = this.image;
    // 先把能抛错的参数都造好、校验好，还没创建任何东西。
    if (gateway && (typeof gateway.key !== 'string' || !gateway.key || /[\r\n\0]/.test(gateway.key))) throw new Error('网关密钥不对');
    if (gateway) gatewayConfig({ upstream: gateway.upstream, preset: gateway.preset, ...(gateway.auth ? { auth: gateway.auth } : {}) });
    const proxyArgs = egress ? buildSidecarArgs('proxy', {
      taskId, runId, image, network: net, nameSuffix: sfx,
      env: { WB_PROXY_ALLOW: parseAllowlist(egress.allow ?? []).map((a) => `${a.suffix ? '.' : ''}${a.host}:${a.port}`).join(','), ...(egress.block?.length ? { WB_PROXY_BLOCK: egress.block.join(',') } : {}), ...(egress.fakeIp === true ? { WB_PROXY_FAKEIP: '1' } : {}) },
    }) : null;
    const gwArgs = gateway ? buildSidecarArgs('gateway', { taskId, runId, image, network: net, nameSuffix: sfx, env: { WB_GW_UPSTREAM: gateway.upstream, WB_GW_PRESET: gateway.preset, ...(gateway.auth ? { WB_GW_AUTH: gateway.auth } : {}) } }) : null;
    const agentEnv = { ...(env ?? {}) };
    if (egress) Object.assign(agentEnv, { HTTPS_PROXY: 'http://wb-proxy:3128', https_proxy: 'http://wb-proxy:3128', NO_PROXY: 'wb-gateway', no_proxy: 'wb-gateway' });
    buildRunArgs({ taskId, runId, image, network: net, volume: vol, limits: this.limits, env: agentEnv, nameSuffix: sfx });

    const made = [];
    const docker = this.docker;
    const must = (args, what, opts) => {
      const r = docker(args, opts);
      if (r.code !== 0) throw new Error(`${what}失败：${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      return r;
    };
    const ipOf = (c) => {
      const r = must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, c], '查内网地址');
      const ip = r.stdout.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`读不出 ${c} 的内网地址`);
      return ip;
    };
    try {
      must(['network', 'create', '--internal', '--driver', 'bridge', '--label', 'wb.sandbox=1', '--label', `wb.task=${taskId}`, net], '建内网');
      made.push(['network', 'rm', net]);
      if (egress || gateway) {
        must(['network', 'create', '--driver', 'bridge', '--label', 'wb.sandbox=1', '--label', `wb.task=${taskId}`, egr], '建出网桥');
        made.push(['network', 'rm', egr]);
      }
      must(['volume', 'create', '--label', 'wb.sandbox=1', '--label', `wb.task=${taskId}`, vol], '建卷');
      made.push(['volume', 'rm', '-f', vol]);
      const hosts = {};
      if (proxyArgs) {
        must(proxyArgs, '起代理');
        made.push(['rm', '-f', proxyName]);
        must(['network', 'connect', egr, proxyName], '代理接出网桥');
        hosts['wb-proxy'] = ipOf(proxyName);
      }
      if (gwArgs) {
        must(gwArgs, '起网关');
        made.push(['rm', '-f', gwName]);
        must(['network', 'connect', egr, gwName], '网关接出网桥');
        // 真 key 经 stdin 写进网关的 tmpfs：不上命令行、不进环境变量、不落宿主磁盘。
        must(['exec', '-i', gwName, 'sh', '-c', 'umask 077; cat > /run/gw/key'], '给网关密钥', { input: gateway.key });
        hosts['wb-gateway'] = ipOf(gwName);
      }
      must(buildRunArgs({ taskId, runId, image, network: net, volume: vol, limits: this.limits, env: agentEnv, nameSuffix: sfx, ...(Object.keys(hosts).length ? { hosts } : {}) }), '起容器');
      made.push(['rm', '-f', name]);
    } catch (err) {
      for (const a of made.reverse()) { try { docker(a); } catch { /* 清不掉的留给孤儿扫描 */ } }
      throw err;
    }
    return this.#box({ name, net, egr: egress || gateway ? egr : null, vol, sidecars: [proxyArgs ? proxyName : null, gwArgs ? gwName : null].filter(Boolean), taskId, startedAt: this.now().toISOString() });
  }

  #box({ name, net, egr, vol, sidecars, taskId, startedAt }) {
    const docker = this.docker;
    const spawnFn = this.spawnFn;
    let destroyed = false;
    const alive = () => { if (destroyed) throw new Error('这个沙箱已经销毁了'); };
    return {
      async exec(argv, { cwd = '/work', env, onLine, timeoutMs } = {}) {
        alive();
        if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('exec 的命令要是非空字符串数组');
        assertBoxPath(cwd, ['/work', '/tmp', '/home/agent']);
        const envArgs = [];
        for (const [k, v] of Object.entries(env ?? {})) {
          if (!ENV_ALLOW.has(k)) throw new Error(`环境变量「${k}」不在白名单里`);
          if (typeof v !== 'string' || /[\0\r\n]/.test(v)) throw new Error(`环境变量「${k}」的值不合规`);
          envArgs.push('-e', `${k}=${v}`);
        }
        // 到点直接 docker kill：只杀 docker exec 这个客户端，容器里的进程会继续跑。
        return streamExec(spawnFn, 'docker', ['exec', '-w', cwd, ...envArgs, name, ...argv], {}, onLine, timeoutMs, () => docker(['kill', name]));
      },
      async writeFile(boxPath, data) {
        alive();
        assertBoxPath(boxPath, ['/home/agent', '/run/wb', '/tmp', '/work']);
        // 路径当位置参数传给 sh，不拼进命令字符串。
        const r = docker(['exec', '-i', name, 'sh', '-c', 'umask 077; cat > "$1"', 'sh', boxPath], { input: data });
        if (r.code !== 0) throw new Error(`写容器文件失败：${r.stderr.trim().slice(0, 200)}`);
      },
      async copyIn(hostPath, boxPath) {
        alive();
        assertBoxPath(boxPath, ['/work']);
        const r = docker(['cp', hostPath, `${name}:${boxPath}`]);
        if (r.code !== 0) throw new Error(`复制进沙箱失败：${r.stderr.trim().slice(0, 200)}`);
      },
      async copyOut(boxPath, hostDir, { maxBytes = MAX_OUT_BYTES } = {}) {
        alive();
        assertBoxPath(boxPath, ['/work']);
        // 1) 先在容器里看一眼：必须是普通文件，大小在上限内。
        const st = docker(['exec', name, 'stat', '-c', '%F|%s', boxPath]);
        if (st.code !== 0) throw new Error('补丁文件不存在');
        const [kind, size] = st.stdout.trim().split('|');
        if (kind !== 'regular file' && kind !== 'regular empty file') throw new Error(`要拷出来的不是普通文件（${kind}）`);
        if (!(Number(size) <= maxBytes)) throw new Error(`文件太大（${size} 字节，上限 ${maxBytes}）`);
        // 2) 目标必须是宿主刚建的空目录，文件名固定。
        if (readdirSync(hostDir).length) throw new Error('目标目录不是空的');
        const dest = join(hostDir, basename(boxPath));
        const r = docker(['cp', `${name}:${boxPath}`, dest]);
        if (r.code !== 0) throw new Error(`从沙箱复制出来失败：${r.stderr.trim().slice(0, 200)}`);
        // 3) 复制完再看一次：仍然是普通文件、不是符号链接、大小没变大。
        const ls = lstatSync(dest);
        if (!ls.isFile() || ls.isSymbolicLink()) throw new Error('拷出来的不是普通文件');
        if (ls.size > maxBytes) throw new Error('拷出来的文件超过上限');
        return dest;
      },
      /** 046.7：/work 用了多少 MB。Docker Desktop 不能按容器限磁盘，只能自己量；量不出来返回 null。 */
      async diskUsedMb() {
        alive();
        // 有读不了的文件时 du 会返回非 0，但总数照样打出来，所以只看输出。
        const r = docker(['exec', name, 'du', '-sxk', '/work'], { timeoutMs: 30_000 });
        const m = /^(\d+)\s/m.exec(r.stdout ?? '');
        return m ? Math.ceil(Number(m[1]) / 1024) : null;
      },
      /** 046.7：立刻停掉容器里正在跑的东西（docker exec 随之返回）。容器本身留给 destroy 删。 */
      async kill() { if (!destroyed) docker(['kill', name]); },
      async pause() { alive(); docker(['pause', name]); },
      async resume() { alive(); docker(['unpause', name]); },
      async destroy() {
        if (destroyed) return;
        destroyed = true;
        // 每一步都试，哪一步失败都不挡后面；残留的靠孤儿扫描。
        docker(['rm', '-f', name]);
        for (const c of sidecars) docker(['rm', '-f', c]);
        docker(['volume', 'rm', '-f', vol]);
        docker(['network', 'rm', net]);
        if (egr) docker(['network', 'rm', egr]);
      },
      info: () => ({ id: name, provider: 'docker', tier: 1, startedAt, taskId }),
    };
  }

  /** 046.7：Docker 那台虚拟机（WSL2）一共有多少内存，MB。读不出来返回 null。 */
  memTotalMb() {
    const r = this.docker(['info', '--format', '{{.MemTotal}}'], { timeoutMs: 15_000 });
    const n = Number(String(r.stdout ?? '').trim());
    return r.code === 0 && Number.isFinite(n) && n > 0 ? Math.floor(n / 1024 / 1024) : null;
  }

  /** 执行器启动时调：按标签找出对不上任何在跑任务的沙箱，全部删掉。返回删了什么。 */
  async sweepOrphans(aliveTaskIds = []) {
    const alive = new Set(aliveTaskIds.map(Number));
    const removed = [];
    const ls = (args) => { const r = this.docker(args); return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []; };
    for (const name of ls(['ps', '-a', '--filter', 'label=wb.sandbox=1', '--format', '{{.Names}}'])) {
      const id = taskOfName(name);
      if (id !== null && alive.has(id)) continue;       // 认得出任务号且任务还在跑：留着（代理、网关也一样）
      this.docker(['rm', '-f', name]); removed.push(`容器 ${name}`);
    }
    const idOf = (n) => { const m = /-T(\d+)-[a-z0-9]{6}$/.exec(n); return m ? Number(m[1]) : null; };
    for (const name of ls(['volume', 'ls', '-q', '--filter', 'label=wb.sandbox=1'])) {
      const id = idOf(name);
      if (id !== null && alive.has(id)) continue;
      this.docker(['volume', 'rm', '-f', name]); removed.push(`卷 ${name}`);
    }
    for (const name of ls(['network', 'ls', '--filter', 'label=wb.sandbox=1', '--format', '{{.Name}}'])) {
      const id = idOf(name);
      if (id !== null && alive.has(id)) continue;
      this.docker(['network', 'rm', name]); removed.push(`网络 ${name}`);
    }
    return removed;
  }
}

/** 取供应商。名字不认识就抛错——不悄悄退回宿主上跑（046 总原则 6）。 */
export function getProvider(name, opts = {}) {
  if (name === 'none' || name === undefined || name === '') return new NoneProvider(opts);
  if (name === 'docker') {
    if (!opts.image) throw new Error('sandbox: "docker" 需要配置 sandboxImage');
    normalizeLimits(opts.limits ?? {});
    return new DockerProvider(opts);
  }
  if (name === 'vm') return new VmProvider(opts);
  throw new Error(`不认识的沙箱类型「${String(name).slice(0, 20)}」（只有 none / docker / vm）`);
}
