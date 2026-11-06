// 030：在工作台里新建项目。工作台碰不到本机磁盘，所以请求记在库里、由执行器在本机建。
// 这里测两半：服务端的名字/地址校验与「只有人能调」，执行器侧真的建目录、跑 git、登记项目。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-projects030-0123';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = hasGit ? false : '本机没有 git';

// 这台机器不一定配了 git 身份；测试里给一个假的，不然每个仓库都提交不了。
process.env.GIT_AUTHOR_NAME = 't';
process.env.GIT_AUTHOR_EMAIL = 't@t';
process.env.GIT_COMMITTER_NAME = 't';
process.env.GIT_COMMITTER_EMAIL = 't@t';

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  cookie = await loginCookie(base, 'test-password-0123456789');
});
after(() => server.close());

async function api(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token === null) headers.Cookie = cookie;
  else headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET', headers, redirect: 'manual',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text, json };
}

const projects = async () => import('../src/services/projects.ts');

describe('030 名字校验：工作台这一侧', () => {
  const bad = ['../x', 'a/b', 'a\\b', 'C:x', 'con', 'nul', '', 'A大写', '.hidden', '-x', 'x'.repeat(41), 'a b'];
  for (const name of bad) {
    test(`拒绝「${name}」`, async () => {
      const { projectNameProblem } = await projects();
      assert.ok(projectNameProblem(name), `「${name}」应该被拒绝`);
    });
  }

  test('正常名字通过', async () => {
    const { projectNameProblem } = await projects();
    for (const name of ['demo-feed', 'a', 'my_project2', 'x'.repeat(40)]) {
      assert.equal(projectNameProblem(name), null, `「${name}」应该通过`);
    }
  });

  test('工作台已经知道这个项目名时拒绝重名', async () => {
    const { projectNameProblem } = await projects();
    await api('/api/runner/heartbeat', { method: 'POST', body: { runner: 'r-030', meta: { executors: ['pool'], projects: ['demo-feed'] } } });
    assert.match(projectNameProblem('demo-feed') ?? '', /已经有同名项目/);
  });
});

describe('030 地址校验', () => {
  test('带凭据、ssh、file、本地路径一律拒绝', async () => {
    const { remoteUrlProblem } = await projects();
    for (const url of [
      'https://u:p@example.com/x/y.git',
      'https://user@example.com/x/y.git',
      'https://github.com/x/y.git?access_token=abc',
      'https://github.com/x/y.git?token=abc',
      'ssh://git@example.com/x/y.git',
      'git@example.com:x/y.git',
      'file:///C:/code/x',
      'D:/code/x',
      'http://github.com/x/y.git',
    ]) {
      assert.ok(remoteUrlProblem(url), `${url} 应该被拒绝`);
    }
  });

  test('干净的 https 地址通过', async () => {
    const { remoteUrlProblem } = await projects();
    assert.equal(remoteUrlProblem('https://github.com/you/example.git'), null);
  });
});

describe('030 接口：只有人能建，脚本令牌不行', () => {
  test('Bearer 令牌调用 → 403', async () => {
    const res = await api('/api/projects', { method: 'POST', body: { name: 'by-agent' } });
    assert.equal(res.status, 403, res.text);
  });

  test('登录会话可以，写审计、只写项目名', async () => {
    const res = await api('/api/projects', { method: 'POST', body: { name: 'demo-new', note: '一句话说明' }, token: null });
    assert.equal(res.status, 201, res.text);
    const { db } = await import('../src/db.ts');
    const rows = db().prepare("SELECT text FROM events WHERE kind = 'project.create'").all() as { text: string }[];
    assert.equal(rows.length, 1);
    assert.ok(rows[0].text.includes('demo-new'));
    assert.ok(!/[A-Z]:\\|\/home\/|\/Users\//.test(rows[0].text), `审计里不该有本机路径：${rows[0].text}`);
  });

  test('同一个名字 60 秒内重复请求不重复排', async () => {
    await api('/api/projects', { method: 'POST', body: { name: 'demo-dup' }, token: null });
    await api('/api/projects', { method: 'POST', body: { name: 'demo-dup' }, token: null });
    const { listRequests } = await projects();
    assert.equal(listRequests().filter((r: any) => r.name === 'demo-dup').length, 1);
  });

  test('失败后一分钟内点重试，要真的重排一次', async () => {
    for (;;) {
      const r = await api('/api/runner/project-request', {});
      if (!r.json) break;
      await api(`/api/runner/project-request/${r.json.id}/finish`, { method: 'POST', body: { ok: true } });
    }
    const first = await api('/api/projects', { method: 'POST', body: { name: 'demo-retry' }, token: null });
    const claimed = await api('/api/runner/project-request', {});
    assert.equal(claimed.json.id, first.json.id);
    await api(`/api/runner/project-request/${claimed.json.id}/finish`, { method: 'POST', body: { ok: false, message: 'git 还没有配置身份' } });

    const second = await api('/api/projects', { method: 'POST', body: { name: 'demo-retry' }, token: null });
    assert.notEqual(second.json.id, first.json.id, '失败后重试不能被 60 秒去重吞掉');
    assert.equal(second.json.status, 'pending');
    await api(`/api/runner/project-request/${second.json.id}/finish`, { method: 'POST', body: { ok: true } });
  });

  test('执行器只能一条一条领：领走之后状态变 running', async () => {
    // 先把前面用例留下的请求处理掉，保证队头就是这一条。
    for (;;) {
      const r = await api('/api/runner/project-request', {});
      if (!r.json) break;
      await api(`/api/runner/project-request/${r.json.id}/finish`, { method: 'POST', body: { ok: true } });
    }
    await api('/api/projects', { method: 'POST', body: { name: 'demo-one' }, token: null });
    const first = await api('/api/runner/project-request', {});
    assert.equal(first.status, 200);
    assert.equal(first.json.name, 'demo-one');
    assert.equal(first.json.status, 'running');
    const again = await api('/api/runner/project-request', {});
    assert.equal(again.json, null, '一次只处理一条');
    await api(`/api/runner/project-request/${first.json.id}/finish`, { method: 'POST', body: { ok: true, message: '' } });
  });
});

describe('030 执行器真的建项目', { skip }, () => {
  let root = '';

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wb-proj030-')); });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test('建文件夹、git init -b main、.gitignore 与 CLAUDE.md、第一次提交', async () => {
    const { createProject } = await import('../scripts/lib/projects.mjs');
    const res = createProject({ projectsRoot: root }, 'demo-feed', '一个演示用的信息流');
    assert.equal(res.ok, true, res.message);
    const dir = join(root, 'demo-feed');
    assert.ok(existsSync(join(dir, '.git')));
    assert.equal(sh(dir, 'branch', '--show-current'), 'main');
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /node_modules/);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes('demo-feed'));
    assert.ok(md.includes('一个演示用的信息流'));
    assert.match(sh(dir, 'log', '--oneline'), /初始化/);
  });

  test('目标文件夹已存在且非空 → 拒绝，里面文件不动', async () => {
    const { createProject } = await import('../scripts/lib/projects.mjs');
    const dir = join(root, 'busy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mine.txt'), '我的东西');
    const res = createProject({ projectsRoot: root }, 'busy', '');
    assert.equal(res.ok, false);
    assert.match(res.message, /已经有东西/);
    assert.equal(readFileSync(join(dir, 'mine.txt'), 'utf8'), '我的东西');
  });

  test('名字带路径想跳出根目录 → 拒绝', async () => {
    const { createProject } = await import('../scripts/lib/projects.mjs');
    const res = createProject({ projectsRoot: root }, '../../Windows', '');
    assert.equal(res.ok, false);
    assert.ok(!existsSync(join(root, '..', '..', 'Windows')), '不能真去动别人目录');
  });

  test('没配 git 身份：给人话、文件夹留着、配好后重试能接着做', async () => {
    const { createProject } = await import('../scripts/lib/projects.mjs');
    const fake = (cwd: string, ...args: string[]) => {
      if (args[0] === 'commit') throw new Error('git commit 失败：Author identity unknown. Please tell me who you are.');
      return sh(cwd, ...args);
    };
    const first = createProject({ projectsRoot: root }, 'noident', '', fake);
    assert.equal(first.ok, false);
    assert.match(first.message, /git config --global user\.name/);
    assert.ok(existsSync(join(root, 'noident', 'CLAUDE.md')), '文件夹和文件要留着');

    const second = createProject({ projectsRoot: root }, 'noident', '');
    assert.equal(second.ok, true, second.message);
    assert.match(sh(join(root, 'noident'), 'log', '--oneline'), /初始化/, '重试要能成功，且只有一条提交');
  });

  test('克隆：默认分支不是 main → 拒绝并说人话', async () => {
    const { cloneProject } = await import('../scripts/lib/projects.mjs');
    const src = join(root, 'src-master');
    mkdirSync(src, { recursive: true });
    sh(src, 'init', '-q', '-b', 'master');
    writeFileSync(join(src, 'a.txt'), 'a');
    sh(src, 'add', '-A');
    sh(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

    const res = cloneProject({ projectsRoot: root }, 'cloned', src, { allowLocal: true });
    assert.equal(res.ok, false);
    assert.match(res.message, /不是 main/);
  });

  test('克隆：main 的仓库能克隆成功', async () => {
    const { cloneProject } = await import('../scripts/lib/projects.mjs');
    const src = join(root, 'src-main');
    mkdirSync(src, { recursive: true });
    sh(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, 'a.txt'), 'a');
    sh(src, 'add', '-A');
    sh(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

    const res = cloneProject({ projectsRoot: root }, 'cloned-main', src, { allowLocal: true });
    assert.equal(res.ok, true, res.message);
    assert.ok(existsSync(join(root, 'cloned-main', 'a.txt')));
  });

  test('关联远端：带凭据的地址拒绝，干净的写进 origin', async () => {
    const { createProject, addRemote } = await import('../scripts/lib/projects.mjs');
    const made = createProject({ projectsRoot: root }, 'with-remote', '');
    assert.equal(made.ok, true, made.message);
    const cfg = { projectsRoot: root, projects: { 'with-remote': join(root, 'with-remote') } };

    const bad = addRemote(cfg, 'with-remote', 'https://u:p@example.com/x/y.git');
    assert.equal(bad.ok, false);

    const good = addRemote(cfg, 'with-remote', 'https://github.com/x/y.git');
    assert.equal(good.ok, true, good.message);
    assert.equal(sh(join(root, 'with-remote'), 'remote', 'get-url', 'origin'), 'https://github.com/x/y.git');
  });
});

// ---------- 030.2：符号链接 / junction 不能把项目建到根目录外面 ----------
describe('030.2 链接越界', { skip }, () => {
  let root = '';
  let outside = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-proj030b-'));
    outside = mkdtempSync(join(tmpdir(), 'wb-outside-'));
  });
  after(() => {
    for (const d of [root, outside]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** Windows 上普通用户没有创建符号链接的权限，用目录联接（junction）。 */
  function link(target: string, path: string): boolean {
    try {
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }

  test('根目录里放一个指到外面的链接：新建拒绝，外面一个文件都不多', async () => {
    const { createProject } = await import('../scripts/lib/projects.mjs');
    const dir = join(root, 'escape');
    if (!link(outside, dir)) return; // 建不出链接的环境跳过

    const res = createProject({ projectsRoot: root }, 'escape', '');
    assert.equal(res.ok, false, '链接指向外面居然建成了');
    assert.match(res.message, /链接/);
    assert.deepEqual(readdirSync(outside), [], '外面被写进了东西');
  });

  test('克隆到链接上同样拒绝，外面一个文件都不多', async () => {
    const { cloneProject } = await import('../scripts/lib/projects.mjs');
    const src = join(root, 'srclink');
    mkdirSync(src, { recursive: true });
    sh(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, 'a.txt'), 'a');
    sh(src, 'add', '-A');
    sh(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

    const dir = join(root, 'escape2');
    if (!link(outside, dir)) return;
    const res = cloneProject({ projectsRoot: root }, 'escape2', src, { allowLocal: true });
    assert.equal(res.ok, false, '链接指向外面居然克隆成功了');
    assert.match(res.message, /链接/);
    assert.deepEqual(readdirSync(outside), []);
  });

  test('关联远端：项目目录是个链接 → 拒绝', async () => {
    const { addRemote } = await import('../scripts/lib/projects.mjs');
    const dir = join(outside, 'somewhere');
    mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q', '-b', 'main');
    const linked = join(root, 'remote-link');
    if (!link(dir, linked)) return;

    const res = addRemote({ projectsRoot: root, projects: { demo: linked } }, 'demo', 'https://github.com/a/b.git');
    assert.equal(res.ok, false, '不该往链接指向的目录里写 origin');
    assert.match(res.message, /链接/);
    const remotes = spawnSync('git', ['remote'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    assert.equal(remotes, '', '外面那个仓库被加了 origin');
  });

  test('普通目录照旧能建（别把正常路径也拦了）', async () => {
    const { createProject } = await import('../scripts/lib/projects.mjs');
    const res = createProject({ projectsRoot: root }, 'normal', '');
    assert.equal(res.ok, true, res.message);
    assert.ok(existsSync(join(root, 'normal', '.git')));
  });
});
