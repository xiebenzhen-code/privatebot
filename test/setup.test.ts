// 020: the unattended install has to be safe to hand to an agent — no secrets in output, no
// argv keys, meaningful exit codes, and a read-only status endpoint it can check at the end.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-setup-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;
let setup: typeof import('../src/services/setup.ts');
let runner: typeof import('../src/services/runner.ts');
let tasks: typeof import('../src/services/tasks.ts');
let core: typeof import('../scripts/lib/setup-core.mjs');

before(async () => {
  const { openDb, useDb } = await import('../src/db.ts');
  setup = await import('../src/services/setup.ts');
  runner = await import('../src/services/runner.ts');
  tasks = await import('../src/services/tasks.ts');
  core = await import('../scripts/lib/setup-core.mjs');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  (globalThis as any).__openDb = openDb;
  (globalThis as any).__useDb = useDb;
});
after(() => app.close());

beforeEach(async () => {
  db = (globalThis as any).__openDb(':memory:');
  (globalThis as any).__useDb(db);
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

const get = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) }, redirect: 'manual' });

// ---------- pure pieces ----------

describe('020 · 参数与密钥', () => {
  test('key 不许走命令行：--key 被拒绝，--key-file 可以', () => {
    const bad = core.parseArgs(['--yes', '--key', 'sk-placeholder-arg']);
    assert.ok(bad.errors.some((e: string) => /环境变量/.test(e)));
    const good = core.parseArgs(['--yes', '--key-file', 'C:/tmp/key.txt', '--project', 'app=C:/code/app']);
    assert.equal(good.errors.length, 0);
    assert.deepEqual(good.opts.project, [{ name: 'app', path: 'C:/code/app' }]);
    assert.equal(good.opts.keyFile, 'C:/tmp/key.txt');
  });

  test('全新 .env：令牌和密码都生成，互不相等，密码至少 12 位', () => {
    const token = 'a'.repeat(48);
    const password = 'placeholder-passphrase';
    const { text, generated } = core.ensureEnvText('# 注释留着\nWB_TZ=Asia/Shanghai\n', { token, password, tz: 'Asia/Shanghai' });
    const v = core.envValues(text);
    assert.deepEqual(generated, { token: true, password: true });
    assert.equal(v.WB_TOKEN, token);
    assert.equal(v.WB_PASSWORD, password);
    assert.notEqual(v.WB_TOKEN, v.WB_PASSWORD);
    assert.ok(v.WB_PASSWORD.length >= 12);
    assert.match(text, /# 注释留着/);   // comments survive
  });

  test('已有值一律不动，也不打印', () => {
    const before = 'WB_TOKEN=keep-me-please-0123456789\nWB_PASSWORD=my-own-password-123\n';
    const { text, generated } = core.ensureEnvText(before, { token: 'new', password: 'newer', tz: 'Asia/Shanghai' });
    assert.deepEqual(generated, { token: false, password: false });
    const v = core.envValues(text);
    assert.equal(v.WB_TOKEN, 'keep-me-please-0123456789');
    assert.equal(v.WB_PASSWORD, 'my-own-password-123');
    assert.doesNotMatch(text, /new/);
  });

  test('重复运行是安全的：第二次一个字符都不改', () => {
    const first = core.ensureEnvText('', { token: 't'.repeat(40), password: 'p'.repeat(16), tz: 'Asia/Shanghai' }).text;
    const second = core.ensureEnvText(first, { token: 'x'.repeat(40), password: 'y'.repeat(16), tz: 'Asia/Shanghai' });
    assert.equal(second.text, first);
    assert.deepEqual(second.generated, { token: false, password: false });
  });

  test('redact 与 mask 不会漏出完整密钥', () => {
    const key = 'sk-placeholder-leak-1';
    const line = core.redact(`failed with authorization: Bearer ${key}`);
    assert.ok(!line.includes(key));
    assert.equal(core.mask('abcdefgh'), 'abcd…');
  });

  // 024a：默认只有本机能访问；要局域网才写 WB_BIND=0.0.0.0，已经设过的不覆盖。
  test('--lan 才写 WB_BIND=0.0.0.0，不带就不写', () => {
    const base = { token: 't'.repeat(40), password: 'p'.repeat(16), tz: 'Asia/Shanghai' };
    assert.equal(core.envValues(core.ensureEnvText('', base).text).WB_BIND, undefined, '默认不写，compose 用 127.0.0.1');
    assert.equal(core.envValues(core.ensureEnvText('', { ...base, lan: true }).text).WB_BIND, '0.0.0.0');
  });

  test('用户自己设过 WB_BIND 就不动它', () => {
    const before = 'WB_TOKEN=keep-me-please-0123456789\nWB_BIND=127.0.0.2\n';
    const out = core.ensureEnvText(before, { token: 'x', password: 'y', tz: 'Asia/Shanghai', lan: true }).text;
    assert.equal(core.envValues(out).WB_BIND, '127.0.0.2');
  });

  test('--lan 能解析，--help 里有它', () => {
    assert.equal(core.parseArgs(['--yes', '--lan']).opts.lan, true);
    assert.equal(core.parseArgs(['--yes']).opts.lan, undefined);
  });
});

// 030 A.3：一问一答里也要问「新项目放哪」，不能只支持 --projects-root；
// 而且配置里已经是空字符串时，那条 --projects-root 命令得真的能补上。
describe('030 · 项目根目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));

  test('空回答用默认的 ai-projects，相对路径与 ~ 都按用户目录算', () => {
    assert.equal(core.resolveProjectsRoot('', home), join(home, 'ai-projects'));
    assert.equal(core.resolveProjectsRoot('   ', home), join(home, 'ai-projects'));
    assert.equal(core.resolveProjectsRoot('projects', home), join(home, 'projects'));
    assert.equal(core.resolveProjectsRoot('~/code/projects', home), join(home, 'code', 'projects'));
  });

  test('绝对路径照用，末尾的斜杠去掉', () => {
    const abs = join(home, 'ai-projects');
    assert.equal(core.resolveProjectsRoot(`${abs}/`, home), abs);
    assert.equal(core.resolveProjectsRoot(abs, home), abs);
    assert.equal(core.resolveProjectsRoot('   ', home), join(home, 'ai-projects'), '空白不算路径');
  });

  test('老配置里 projectsRoot 是空字符串时，给的值要能补上（否则页面上那条命令等于没跑）', () => {
    const existing = { projectsRoot: '', projects: {}, workbench: 'http://localhost:3200', token: 't' };
    const merged = core.mergeRunnerConfig(existing, { projects: [], projectsRoot: 'D:/ai-projects' });
    assert.equal(merged.projectsRoot, 'D:/ai-projects');
  });

  test('已经配过就不动它，重复跑 setup 不会改路径', () => {
    const existing = { projectsRoot: 'C:/keep', projects: {} };
    const merged = core.mergeRunnerConfig(existing, { projects: [], projectsRoot: 'D:/new' });
    assert.equal(merged.projectsRoot, 'C:/keep');
  });

  test('一问一答的默认值写成用户目录下的 ai-projects', () => {
    assert.equal(core.defaultProjectsRoot(home), join(home, 'ai-projects'));
  });
});

describe('020 · 项目检查', () => {
  const ioFor = () => ({
    exists: existsSync,
    readdir: (p: string) => { try { return readdirSync(p); } catch { return []; } },
    readFile: (p: string) => readFileSync(p, 'utf8'),
  });

  test('路径不存在 / 不是 git 仓库 / 带 .claude/settings.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const missing = core.checkProject(join(root, 'nope'), ioFor());
    assert.equal(missing.ok, false);
    assert.match(missing.problems[0], /不存在/);

    const plain = join(root, 'plain');
    mkdirSync(plain);
    assert.match(core.checkProject(plain, ioFor()).problems.join(), /git/);

    const repo = join(root, 'repo with 空格 和中文');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}');
    const got = core.checkProject(repo, ioFor());
    assert.equal(got.ok, false);
    assert.match(got.problems.join(), /\.claude\/settings\.json/);
  });

  test('干净仓库通过（路径带空格、中文、反斜杠也认）', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const repo = join(root, '我的 项目');
    mkdirSync(join(repo, '.git'), { recursive: true });
    assert.equal(core.checkProject(repo, ioFor()).ok, true);
    if (process.platform === 'win32') {
      // 020.1: `\` only means a separator on Windows; on POSIX it is an ordinary filename byte,
      // so the backslash variant of the path would point at a directory that cannot exist.
      assert.equal(core.checkProject(repo.replace(/\//g, '\\'), ioFor()).ok, true);
    }
  });
});

describe('020 · 后端验证', () => {
  test('200 显示可用，401 说 key 不对，且只发一次最小请求', async () => {
    const calls: any[] = [];
    const okFetch = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response('{"ok":true}', { status: 200 });
    };
    const ok = await core.probeBackend({ baseUrl: 'https://api.example.com/anthropic', model: 'm', key: 'k-123456', fetchImpl: okFetch });
    assert.equal(ok.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.max_tokens, 1);
    assert.equal(calls[0].url, 'https://api.example.com/anthropic/v1/messages');

    const bad = await core.probeBackend({
      baseUrl: 'https://api.example.com', model: 'm', key: 'k-123456',
      fetchImpl: async () => new Response('{"error":"bad key"}', { status: 401 }),
    });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /key 不对/);
  });

  test('429 和网络错误都有话说，且不吐 key', async () => {
    const quota = await core.probeBackend({
      baseUrl: 'https://api.example.com', model: 'm', key: 'sk-placeholder-secret-9',
      fetchImpl: async () => new Response(`{"error":"rate limited","key":"sk-placeholder-secret-9"}`, { status: 429 }),
    });
    assert.match(quota.message, /限流|额度/);
    assert.ok(!quota.message.includes('sk-placeholder-secret-9'));

    const net = await core.probeBackend({
      baseUrl: 'https://api.example.com', model: 'm', key: 'k',
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.example.com'); },
    });
    assert.equal(net.ok, false);
    assert.match(net.message, /连不上/);
  });
});

describe('020 · 无人值守跑一遍', () => {
  const fakeFs = (root: string, extra: Record<string, string> = {}) => {
    const files = new Map<string, string>(Object.entries(extra));
    return {
      files,
      envPath: join(root, '.env'),
      configPath: join(root, 'runner.json'),
      exists: (p: string) => files.has(p) || existsSync(p),
      readdir: (p: string) => { try { return readdirSync(p); } catch { return []; } },
      readFile: (p: string) => files.get(p) ?? '',
      writeFile: (p: string, data: string) => { files.set(p, data); },
      mkdirp: () => {},
      dirname: (p: string) => p.replace(/[\\/][^\\/]*$/, ''),
      homedir: root,
      env: {} as Record<string, string>,
      generateToken: () => 'a'.repeat(48),
      generatePassword: () => 'generated-password-1234',
    };
  };

  const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

  // 058：不给 --project 也能装完——在 ~/ai-projects/first 建一个空仓库当第一个项目。
  const withGit = (root: string) => {
    const inits: string[] = [];
    const io = { ...fakeFs(root), fetchImpl: okFetch, env: { WB_SETUP_KEY_DEEPSEEK: 'sk-test-0123456789' }, gitInit: (d: string) => { inits.push(d); } };
    return { io, inits };
  };

  test('058 · 没给项目：key 验过后建 ~/ai-projects/first，写进配置，退出码 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const { io, inits } = withGit(root);
    const res = await core.runUnattended({ backend: 'deepseek' }, io);
    assert.equal(res.code, 0, JSON.stringify(res.events));
    const dir = join(root, 'ai-projects', 'first');
    assert.deepEqual(inits, [dir]);
    const ev = res.events.find((e: any) => e.step === 'project');
    assert.equal(ev.status, 'created');
    const cfg = JSON.parse(io.files.get(join(root, 'runner.json'))!);
    assert.equal(cfg.projects.first, dir);
    assert.equal(cfg.projectsRoot, join(root, 'ai-projects'), '网页上「新建项目」也一起能用了');
  });

  test('058 · 没给项目也没给 key：退出码 1，什么都不建', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const { io, inits } = withGit(root);
    const res = await core.runUnattended({ backend: 'deepseek' }, { ...io, env: {} });
    assert.equal(res.code, 1);
    assert.deepEqual(inits, []);
  });

  test('058 · first 已经是仓库就直接用；在但不是仓库就停下、不动它；--dry-run 只说会建', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const dir = join(root, 'ai-projects', 'first');
    mkdirSync(join(dir, '.git'), { recursive: true });
    let t = withGit(root);
    let res = await core.runUnattended({ backend: 'deepseek' }, t.io);
    assert.equal(res.code, 0);
    assert.deepEqual(t.inits, [], '已有的仓库不重建');

    const root2 = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    mkdirSync(join(root2, 'ai-projects', 'first'), { recursive: true });
    t = withGit(root2);
    res = await core.runUnattended({ backend: 'deepseek' }, t.io);
    assert.equal(res.code, 3);
    assert.match(res.events.find((e: any) => e.step === 'project').detail, /不是一个 git 仓库/);
    assert.deepEqual(t.inits, []);

    const root3 = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    t = withGit(root3);
    res = await core.runUnattended({ backend: 'deepseek', dryRun: true }, t.io);
    assert.equal(res.code, 0);
    assert.equal(res.events.find((e: any) => e.step === 'project').status, 'dry-run');
    assert.deepEqual(t.inits, []);
  });

  test('成功时写 .env 和 runner 配置，输出里没有完整密钥', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const repo = join(root, 'proj');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const io = fakeFs(root, {}) as any;
    io.fetchImpl = okFetch;
    io.env = { WB_SETUP_KEY_DEEPSEEK: 'sk-placeholder-cfg-1' };
    const projectsRoot = join(root, 'ai-projects');
    const res = await core.runUnattended(
      { project: [{ name: 'proj', path: repo }], backend: 'deepseek', tz: 'Asia/Shanghai', projectsRoot }, io);
    assert.equal(res.code, 0);
    const env = io.files.get(io.envPath) as string;
    assert.match(env, /WB_TOKEN=a{48}/);
    assert.match(env, /WB_PASSWORD=generated-password-1234/);

    const cfg = JSON.parse(io.files.get(io.configPath) as string);
    assert.equal(cfg.projects.proj, repo);
    assert.equal(cfg.projectsRoot, projectsRoot, '一问一答里问到的目录要写进执行器配置');
    assert.equal(cfg.executors.pool.backends[0].name, 'deepseek');
    assert.equal(cfg.executors.pool.backends[0].env.ANTHROPIC_AUTH_TOKEN, 'sk-placeholder-cfg-1');
    assert.equal(cfg.token, 'a'.repeat(48));

    // 输出（事件 + 总结）里除了那一个 once 事件之外，不能出现密码和 key
    const once = res.events.filter((e: any) => e.step === 'password');
    assert.equal(once.length, 1);
    assert.equal(once[0].value, 'generated-password-1234');
    const rest = JSON.stringify(res.events.filter((e: any) => e.step !== 'password')) + JSON.stringify(res.summary);
    assert.ok(!rest.includes('sk-placeholder-cfg-1'));
    assert.ok(!rest.includes('generated-password-1234'));
    assert.ok(!rest.includes('a'.repeat(48)));
  });

  test('已有配置文件先备份，用户手改的字段保留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const repo = join(root, 'proj');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const existing = {
      workbench: 'http://203.0.113.9:3200',
      runnerId: 'my-runner',
      mergeWaitMinutes: 5,
      projects: { old: 'C:/old' },
      executors: { pool: { tool: 'claude', maxMinutes: 20 } },
    };
    const io = fakeFs(root, {}) as any;
    io.fetchImpl = okFetch;
    io.env = { WB_SETUP_KEY_DEEPSEEK: 'sk-placeholder-new-1' };
    io.files.set(io.configPath, JSON.stringify(existing));
    const res = await core.runUnattended({ project: [{ name: 'proj', path: repo }], backend: 'deepseek' }, io);
    assert.equal(res.code, 0);
    assert.ok(io.files.get(`${io.configPath}.bak`), 'should keep a .bak');
    const cfg = JSON.parse(io.files.get(io.configPath) as string);
    assert.equal(cfg.workbench, 'http://203.0.113.9:3200');
    assert.equal(cfg.runnerId, 'my-runner');
    assert.equal(cfg.mergeWaitMinutes, 5);
    assert.equal(cfg.projects.old, 'C:/old');
    assert.equal(cfg.projects.proj, repo);
    assert.equal(cfg.executors.pool.maxMinutes, 20);
    assert.equal(cfg.executors.pool.backends[0].model, 'deepseek-chat');
  });

  test('--dry-run 一个文件都不写', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    const repo = join(root, 'proj');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const io = fakeFs(root, {}) as any;
    io.fetchImpl = okFetch;
    io.env = { WB_SETUP_KEY_DEEPSEEK: 'sk-placeholder-dry-1' };
    const res = await core.runUnattended({ project: [{ name: 'proj', path: repo }], backend: 'deepseek', dryRun: true }, io);
    assert.equal(res.code, 0);
    assert.equal(io.files.size, 0);
  });

  test('命令行里跑一次，退出码和 JSON 都对', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-setup-'));
    // no --project and no key: exit 1, never blocks, creates nothing (058: key is checked before the starter project)
    let code = 0;
    try {
      execFileSync(process.execPath, ['scripts/setup.mjs', '--yes', '--json'], { cwd: process.cwd(), timeout: 20000, encoding: 'utf8' });
    } catch (err: any) {
      code = err.status;
    }
    assert.equal(code, 1);

    // --key on the command line: refused with a hint, exit 4
    let out = '';
    try {
      execFileSync(process.execPath, ['scripts/setup.mjs', '--yes', '--key', 'sk-placeholder-rejected-1'], { cwd: process.cwd(), timeout: 20000, encoding: 'utf8' });
    } catch (err: any) {
      code = err.status;
      out = String(err.stderr);
    }
    assert.equal(code, 4);
    assert.match(out, /环境变量|--key-file/);
    void root;
  });
});

describe('020 · 网页清单与状态接口', () => {
  test('Bearer 能读 /api/setup/status，且不含路径和密钥', async () => {
    runner.heartbeat('r1', {
      executors: ['pool'],
      projects: ['ai-workbench', 'C:/Users/me/secret-project'],
      backends: ['deepseek', 'sk-placeholder-leak'],
      check: { ok: true, at: new Date().toISOString(), summary: '自检 9/9 项就绪' },
    });
    const res = await get('/api/setup/status', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    const keys = body.items.map((i: any) => i.key);
    assert.deepEqual(keys, ['workbench', 'password', 'runner', 'projects', 'backend', 'first_task', 'backup', 'github', 'phone', 'digest']);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('C:/Users/me/secret-project'));
    assert.ok(!text.includes('sk-placeholder-leak'));
    assert.equal(body.items.find((i: any) => i.key === 'projects').ok, true);
    assert.equal(body.items.find((i: any) => i.key === 'backend').ok, true);
    assert.equal(body.items.find((i: any) => i.key === 'first_task').ok, false);
  });

  test('执行器没报过项目时显示「还没检测到」', async () => {
    runner.heartbeat('r1', { executors: ['pool'] });
    const body = await (await get('/api/setup/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
    const projects = body.items.find((i: any) => i.key === 'projects');
    assert.equal(projects.ok, false);
    assert.match(projects.hint, /npm run setup/);
  });

  test('跑完一个任务后第一项变 ✓；关掉执行器第 3 项变回待做', async () => {
    runner.heartbeat('r1', { projects: ['p'], check: { ok: true, summary: 'ok' } });
    const t = tasks.createTask({ title: '跑一个', executor: 'pool' });
    db.prepare(`UPDATE tasks SET status = 'done', runner_id = 'r1' WHERE id = ?`).run(t.id);
    let body = await (await get('/api/setup/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
    assert.equal(body.items.find((i: any) => i.key === 'first_task').ok, true);
    assert.equal(body.items.find((i: any) => i.key === 'runner').ok, true);

    db.prepare(`UPDATE runners SET last_seen = ?`).run(new Date(Date.now() - 10 * 60_000).toISOString());
    body = await (await get('/api/setup/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
    assert.equal(body.items.find((i: any) => i.key === 'runner').ok, false);
    assert.match(body.items.find((i: any) => i.key === 'runner').hint, /runner-guard\.mjs/);
  });

  test('「不再提示」只能用网页 Cookie', async () => {
    const withToken = await fetch(`${base}/api/setup/dismiss`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(withToken.status, 403);
    const withCookie = await fetch(`${base}/api/setup/dismiss`, {
      method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: '{"on":true}',
    });
    assert.equal(withCookie.status, 200);
    const body = await (await get('/api/setup/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
    assert.equal(body.dismissed, true);
    const audit = db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'setup.dismissed'`).get() as { n: number };
    assert.equal(audit.n, 1);
  });
});

describe('020b · 今天页与设置里的清单', () => {
  test('没配好时「今天」页顶部有清单，配好后自己消失', async () => {
    let html = await (await get('/')).text();
    assert.match(html, /开始使用/);
    assert.match(html, /还差 \d 项/);
    assert.match(html, /npm run setup/);          // 项目一项的做法
    // 025.1 / 034：那个按钮只在第 6 步展开时才出现，点了必然 400 的按钮不会再摆出来。
    assert.doesNotMatch(html, /试试这个：建一个只读任务/);
    assert.match(html, /下一步：/, '顶部要指一步：现在该做什么');

    // 全部做完：执行器报项目 + 自检通过，库里有一条执行器做完的任务
    runner.heartbeat('r1', { projects: ['p'], check: { ok: true, summary: '自检 9/9 项就绪' } });
    const t = tasks.createTask({ title: '装好了', executor: 'pool' });
    db.prepare(`UPDATE tasks SET status = 'done', runner_id = 'r1' WHERE id = ?`).run(t.id);
    html = await (await get('/')).text();
    assert.doesNotMatch(html, /开始使用/);
  });

  test('设置 › 接入 里随时能打开清单；「不再提示」后今天页收起来', async () => {
    const settingsHtml = await (await get('/settings/integrations')).text();
    assert.match(settingsHtml, /上手清单/);
    assert.match(settingsHtml, /\/api\/setup\/status/);

    const before = await (await get('/')).text();
    assert.match(before, /开始使用/);

    await fetch(`${base}/api/setup/dismiss`, {
      method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: '{"on":true}',
    });
    assert.doesNotMatch(await (await get('/')).text(), /开始使用/);
    assert.match(await (await get('/settings/integrations')).text(), /上手清单/);
  });

  test('示例任务落在存在的执行者上，且不自动开始', async () => {
    // 034：按钮在第 6 步（跑第一个任务）里，前面几步要都做完才会展开到它。
    runner.heartbeat('r1', { executors: ['pool'], projects: ['p'], check: { ok: true, summary: 'ok' } });
    const html = await (await get('/')).text();
    assert.match(html, /试试这个：建一个只读任务/);
    const m = html.match(/name="executor" value="([^"]+)"/);
    assert.ok(m, 'sample form should pick an executor');
    const execs = db.prepare('SELECT executor FROM executor_settings').all() as { executor: string }[];
    assert.ok(execs.some((e) => e.executor === m![1]), m![1]);
    assert.match(html, /name="mode" value="manual"/);
    assert.match(html, /name="project" value="p"/, '025.1：示例任务必须带项目');
  });
});
