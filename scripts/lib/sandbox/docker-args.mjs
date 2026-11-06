// 046 §2：拼 `docker run` 命令行的**唯一**地方。
//
// 纯函数、不起进程。别处不许自己拼 `docker run`——这样「容器到底给了它什么」只需要读这一个文件、
// 看这一个测试。收到任何会破坏隔离的输入（宿主路径、privileged、额外能力……）一律抛错，不静默忽略。
//
// 这个函数造的是 agent 容器。env 里只能放**假密钥和非机密**（命令行谁都看得见）；真密钥只进模型网关容器。

/** 容器里 agent 的用户。 */
export const AGENT_UID = 10001;

/** 上限写死：配置写得再大也截到这里，并告诉调用者被截了。 */
export const HARD_LIMITS = { memoryMb: 4096, cpus: 4, pids: 1024 };
export const DEFAULT_LIMITS = { memoryMb: 2048, cpus: 2, pids: 512 };

/** spec 里只认这些键。多一个就抛错——「顺手多传一个 privileged」不能悄悄通过。 */
const SPEC_KEYS = new Set(['taskId', 'runId', 'image', 'network', 'volume', 'limits', 'env', 'nameSuffix', 'hosts']);

/** agent 容器里能写死的名字：只有代理和网关两个，IP 必须是私网 IPv4（它们在任务内网里）。 */
const HOST_NAMES = new Set(['wb-proxy', 'wb-gateway']);
const PRIVATE_V4 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;
const LIMIT_KEYS = new Set(['memoryMb', 'cpus', 'pids']);

/** 宿主环境一概不继承：容器里只允许这几个名字。 */
export const ENV_ALLOW = new Set([
  'HOME', 'PATH', 'LANG', 'TERM',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  // 模型后端：基址指向网关容器，key 是假的。
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  // 关掉 Claude Code 的遥测、自动更新这类旁路流量（反正也出不去，省得它反复重试）。
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING',
  'WB_SANDBOX', 'WB_TASK_ID',
]);

const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._-]*(:[0-9]+)?(\/[a-z0-9][a-z0-9._-]*)*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

function fail(msg) {
  throw new Error(`沙箱参数不合规：${msg}`);
}

/** 内存（MB）、cpu、pids 规整到 [1, 上限]；返回被截断的项，让调用者能提示用户。 */
export function normalizeLimits(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('limits 要是个对象');
  for (const k of Object.keys(input)) if (!LIMIT_KEYS.has(k)) fail(`limits 里没有「${k}」这一项`);
  const out = { ...DEFAULT_LIMITS };
  const clamped = [];
  for (const [k, hard] of [['memoryMb', HARD_LIMITS.memoryMb], ['cpus', HARD_LIMITS.cpus], ['pids', HARD_LIMITS.pids]]) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n <= 0) fail(`limits.${k} 要是正数`);
    const v = k === 'cpus' ? Math.round(n * 100) / 100 : Math.floor(n);
    if (v < (k === 'cpus' ? 0.1 : 1)) fail(`limits.${k} 太小`);
    out[k] = Math.min(v, hard);
    if (v > hard) clamped.push({ key: k, asked: v, used: hard });
  }
  return { limits: out, clamped };
}

function checkEnv(env) {
  if (env === undefined) return [];
  if (env === null || typeof env !== 'object' || Array.isArray(env)) fail('env 要是个对象');
  const out = [];
  for (const k of Object.keys(env).sort()) {
    if (!ENV_ALLOW.has(k)) fail(`环境变量「${k}」不在白名单里（宿主环境不继承）`);
    const v = env[k];
    if (typeof v !== 'string') fail(`环境变量「${k}」的值要是字符串`);
    if (v.length > 2048) fail(`环境变量「${k}」的值太长`);
    if (/[\0\r\n]/.test(v)) fail(`环境变量「${k}」的值里有换行或空字符`);
    out.push(`${k}=${v}`);
  }
  return out;
}

/**
 * 最后一道自检：造好的命令行里，不许出现任何会开口子的东西。
 * 上面各项已经各自拒绝过，这里是「就算以后有人改坏了上面」的保险。
 */
const FORBIDDEN_TOKENS = [
  /^-v$/, /^--volume(=|$)/, /^--privileged(=|$)/, /^--cap-add(=|$)/, /^--device(=|$)/,
  /^--network=host$/, /^--net=host$/, /^--pid(=|$)/, /^--ipc(=|$)/, /^--uts(=|$)/, /^--userns(=|$)/,
  /^--cgroupns(=|$)/, /^--volumes-from(=|$)/, /^--env-file(=|$)/, /^--security-opt=(seccomp|apparmor|label)[=:]?(unconfined|disable)/i,
  /docker\.sock/i, /unconfined/i, /\bbind\b/i, /^\/mnt\//, /^\/host_mnt\//, /^[A-Za-z]:[\\/]/, /^\\\\/,
];
export function assertSafeArgs(args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) fail('命令行要是字符串数组');
  for (const a of args) {
    for (const re of FORBIDDEN_TOKENS) if (re.test(a)) fail(`命令行里出现了不许出现的东西：${a.slice(0, 60)}`);
  }
  // --mount 只许一种：命名卷挂 /work。
  args.forEach((a, i) => {
    if (a === '--mount' || a.startsWith('--mount=')) {
      const v = a === '--mount' ? args[i + 1] : a.slice('--mount='.length);
      if (!/^type=volume,source=wb-sbx-[A-Za-z0-9_-]+,target=\/work$/.test(v ?? '')) fail(`不认识的 --mount：${String(v).slice(0, 60)}`);
    }
  });
  return args;
}

/**
 * @param {{taskId:number, runId?:number|string, image:string, network:string, volume:string,
 *          limits?:{memoryMb?:number,cpus?:number,pids?:number}, env?:Record<string,string>, nameSuffix?:string}} spec
 * @param {{rand?:()=>string}} [opts]
 * @returns {string[]} 以 `run` 开头的参数（不含 `docker` 本身）
 */
export function buildRunArgs(spec, opts = {}) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) fail('spec 要是个对象');
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) fail(`不认识的参数「${k}」`);

  const taskId = Number(spec.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) fail('taskId 要是正整数');
  const runId = spec.runId === undefined ? 0 : spec.runId;
  if (!/^[0-9]{1,12}$/.test(String(runId))) fail('runId 要是数字');
  if (typeof spec.image !== 'string' || !IMAGE_RE.test(spec.image) || spec.image.length > 200) fail('镜像名不合规');
  if (typeof spec.network !== 'string' || !/^wb-sbx-/.test(spec.network) || !NAME_PART.test(spec.network)) fail('网络名要以 wb-sbx- 开头，只含字母数字下划线横线');
  if (spec.network === 'host' || spec.network === 'bridge' || spec.network === 'none') fail('网络不能是 Docker 自带的');
  if (typeof spec.volume !== 'string' || !/^wb-sbx-/.test(spec.volume) || !NAME_PART.test(spec.volume)) fail('卷名要以 wb-sbx- 开头，只含字母数字下划线横线（不是宿主目录）');

  const { limits } = normalizeLimits(spec.limits ?? {});
  const env = checkEnv(spec.env);
  const hosts = [];
  if (spec.hosts !== undefined) {
    if (spec.hosts === null || typeof spec.hosts !== 'object' || Array.isArray(spec.hosts)) fail('hosts 要是个对象');
    for (const [h, ip] of Object.entries(spec.hosts)) {
      if (!HOST_NAMES.has(h)) fail(`hosts 里只能写 wb-proxy / wb-gateway，不能写「${String(h).slice(0, 30)}」`);
      if (typeof ip !== 'string' || !PRIVATE_V4.test(ip) || ip.split('.').some((x) => Number(x) > 255)) fail(`${h} 的地址要是任务内网里的 IPv4`);
      hosts.push('--add-host', `${h}:${ip}`);
    }
  }

  const rand = opts.rand ?? (() => Math.random().toString(36).slice(2, 8).padEnd(6, '0'));
  const suffix = spec.nameSuffix ?? rand();
  if (!/^[a-z0-9]{6}$/.test(suffix)) fail('nameSuffix 要是 6 位小写字母数字');
  const name = `wb-sbx-T${taskId}-${suffix}`;

  const args = [
    'run', '-d', '--rm', '--init',
    '--name', name,
    '--user', `${AGENT_UID}:${AGENT_UID}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    `--memory=${limits.memoryMb}m`, `--memory-swap=${limits.memoryMb}m`,
    `--cpus=${limits.cpus}`, `--pids-limit=${limits.pids}`,
    '--ulimit', 'nofile=4096:4096', '--ulimit', 'core=0',
    // 只接这个任务专用的 --internal 网络；解析不出外网名字；盖掉 Docker Desktop 自带的宿主别名。
    '--network', spec.network,
    '--dns', '127.0.0.1',
    '--add-host', 'host.docker.internal:127.0.0.1',
    '--add-host', 'gateway.docker.internal:127.0.0.1',
    ...hosts,
    // 命名卷住在 Docker 自己的磁盘里，不是宿主目录。
    '--mount', `type=volume,source=${spec.volume},target=/work`,
    '--tmpfs', `/tmp:rw,nosuid,nodev,mode=1777,size=512m`,
    '--tmpfs', `/run/wb:rw,noexec,nosuid,nodev,uid=${AGENT_UID},gid=${AGENT_UID},size=4m`,
    '--tmpfs', `/home/agent:rw,nosuid,nodev,uid=${AGENT_UID},gid=${AGENT_UID},size=256m`,
    '-w', '/work',
    '--label', 'wb.sandbox=1', '--label', `wb.task=${taskId}`, '--label', `wb.run=${runId}`,
  ];
  for (const e of env) args.push('-e', e);
  args.push(spec.image, 'sleep', 'infinity');
  return assertSafeArgs(args);
}

// ───────────── 代理 / 网关容器 ─────────────

const SIDECARS = {
  proxy: { alias: 'wb-proxy', entry: '/opt/wb/sandbox/proxy.mjs', env: new Set(['WB_PROXY_ALLOW', 'WB_PROXY_PORT', 'WB_PROXY_BLOCK', 'WB_PROXY_FAKEIP']), tmpfs: [] },
  gateway: { alias: 'wb-gateway', entry: '/opt/wb/sandbox/gateway.mjs', env: new Set(['WB_GW_UPSTREAM', 'WB_GW_PRESET', 'WB_GW_PORT', 'WB_GW_AUTH']), tmpfs: [`/run/gw:rw,noexec,nosuid,nodev,uid=${AGENT_UID},gid=${AGENT_UID},size=1m`] },
};

/**
 * 代理、网关容器：和 agent 一样加固（非 root、cap-drop ALL、只读、不挂目录），资源更小；
 * 先只接任务内网（带别名），出网桥由调用者 `docker network connect` 接上。
 * env 只收这一种容器自己的几个名字——**真密钥不在这里**，网关的 key 起好后经 stdin 写进 /run/gw/key。
 */
export function buildSidecarArgs(kind, spec) {
  const sc = SIDECARS[kind];
  if (!sc) fail(`不认识的辅助容器「${String(kind).slice(0, 20)}」`);
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) fail('spec 要是个对象');
  for (const k of Object.keys(spec)) if (!['taskId', 'runId', 'image', 'network', 'nameSuffix', 'env'].includes(k)) fail(`不认识的参数「${k}」`);
  const taskId = Number(spec.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) fail('taskId 要是正整数');
  const runId = spec.runId === undefined ? 0 : spec.runId;
  if (!/^[0-9]{1,12}$/.test(String(runId))) fail('runId 要是数字');
  if (typeof spec.image !== 'string' || !IMAGE_RE.test(spec.image) || spec.image.length > 200) fail('镜像名不合规');
  if (typeof spec.network !== 'string' || !/^wb-sbx-/.test(spec.network) || !NAME_PART.test(spec.network)) fail('网络名要以 wb-sbx- 开头');
  if (!/^[a-z0-9]{6}$/.test(String(spec.nameSuffix))) fail('nameSuffix 要是 6 位小写字母数字');
  const env = [];
  for (const k of Object.keys(spec.env ?? {}).sort()) {
    if (!sc.env.has(k)) fail(`环境变量「${k}」不在 ${kind} 的白名单里`);
    const v = spec.env[k];
    if (typeof v !== 'string' || v.length > 4096 || /[\0\r\n]/.test(v)) fail(`环境变量「${k}」的值不合规`);
    env.push('-e', `${k}=${v}`);
  }
  const name = `wb-sbx-T${taskId}-${spec.nameSuffix}-${kind === 'gateway' ? 'gw' : 'proxy'}`;
  const args = [
    'run', '-d', '--rm', '--init', '--name', name,
    '--user', `${AGENT_UID}:${AGENT_UID}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
    '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--pids-limit=128',
    '--ulimit', 'nofile=4096:4096', '--ulimit', 'core=0',
    '--network', spec.network, '--network-alias', sc.alias,
    // 代理盖掉宿主别名（它自己还会按 IP 黑名单拦）。网关不盖：它只连配置里那个固定上游，
    // 反代池这类上游就在宿主上（host.docker.internal:1455），agent 改不了它连哪。
    ...(kind === 'proxy' ? ['--add-host', 'host.docker.internal:127.0.0.1', '--add-host', 'gateway.docker.internal:127.0.0.1'] : []),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    ...sc.tmpfs.flatMap((t) => ['--tmpfs', t]),
    '--label', 'wb.sandbox=1', '--label', `wb.task=${taskId}`, '--label', `wb.run=${runId}`, '--label', `wb.role=${kind}`,
    ...env,
    spec.image, 'node', sc.entry,
  ];
  return assertSafeArgs(args);
}

/** 容器名里取任务号，给孤儿扫描用。认不出返回 null。 */
export function taskOfName(name) {
  const m = /^wb-sbx-T(\d+)-[a-z0-9]{6}(-proxy|-gw)?$/.exec(String(name));
  return m ? Number(m[1]) : null;
}
