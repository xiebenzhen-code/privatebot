// 044（用户 2026-11-03）：取消「简洁版 / 完整版」。只有一种界面；旧接口退役，旧设置不再让任何东西被藏起来。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginCookie } from './helpers.ts';
import { db, openDb, useDb } from '../src/db.ts';

const TOKEN = 'test-token-027-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const ROOT = join(import.meta.dirname, '..');

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => server.close());

beforeEach(async () => {
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token === null) { if (cookie) headers.Cookie = cookie; }
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

const navCount = (html: string) => (html.match(/class="nav-item[ "]/g) ?? []).length;
const tabCount = (html: string) => (html.match(/class="seg-item[ "]/g) ?? []).length;
const runnerSays = (projects: string[]) => api('/api/runner/heartbeat', {
  method: 'POST', body: { runner: 'r-027', meta: { executors: ['pool'], projects } },
});

describe('044 · 简洁版已取消', () => {
  test('全新安装是完整版，迁移把存过 simple 的也改回 full', () => {
    const fresh = openDb(':memory:');
    const mode = fresh.prepare("SELECT value FROM settings WHERE key = 'ui_mode'").get() as { value: string } | undefined;
    assert.equal(mode?.value, 'full');
    fresh.close();
  });

  test('旧写接口退役：POST /api/ui-mode 返回 410，不再改任何东西', async () => {
    const r = await api('/api/ui-mode', { method: 'POST', body: { mode: 'simple' }, token: null });
    assert.equal(r.status, 410);
    assert.match(String(r.json?.error ?? ''), /简洁版已取消/);
    const page = await api('/', { token: null });
    assert.doesNotMatch(page.text, /ui-simple|page-help/);
  });

  test('库里残留 ui_mode=simple 也不会藏任何东西（代码不再读这个设置）', async () => {
    db().prepare("INSERT INTO settings (key, value) VALUES ('ui_mode', 'simple') ON CONFLICT(key) DO UPDATE SET value = 'simple'").run();
    try {
      const today = await api('/', { token: null });
      assert.equal(navCount(today.text), 5, '导航还是完整的');
      assert.doesNotMatch(today.text, /ui-simple|page-help/);
      assert.match(today.text, /今日 Token/, '数据格一个不少');
      assert.equal(tabCount((await api('/tasks', { token: null })).text), 4);
      assert.equal((((await api('/settings', { token: null })).text).match(/data-settings-row=/g) ?? []).length, 5);
      const security = await api('/settings/security', { token: null });
      assert.match(security.text, /新增规则/, '安全页的规则表照常露出');
      const integrations = await api('/settings/integrations', { token: null });
      assert.match(integrations.text, /Claude Code 钩子/);
      assert.doesNotMatch(integrations.text, /\+ 接入更多/);
    } finally {
      db().prepare("UPDATE settings SET value = 'full' WHERE key = 'ui_mode'").run();
    }
  });

  test('外观页没有「界面版本」表单，侧边栏没有切换链接', async () => {
    const appearance = await api('/settings/appearance', { token: null });
    assert.equal(appearance.status, 200);
    assert.doesNotMatch(appearance.text, /界面版本|data-api="\/api\/ui-mode"|简洁版/);
    const today = await api('/', { token: null });
    assert.doesNotMatch(today.text, /切到简洁版|切到完整版/);
  });

  test('代码里不留简洁版的东西：服务文件、帮助、样式都删了', () => {
    assert.equal(existsSync(join(ROOT, 'src', 'services', 'ui-mode.ts')), false);
    assert.equal(existsSync(join(ROOT, 'src', 'views', 'help.ts')), false);
    const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
    assert.doesNotMatch(css, /ui-simple|ui-full|\.page-help|\.side-mode/);
  });

  test('失败原因直接给全文，不再折成一句话', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: { title: '会失败的一单', executor: 'pool', project: 'demo-feed' } });
    const long = '没有合并：主仓库 demo-feed 里有 2 个文件没提交。先提交或暂存它们，再点「重试合并」。第二句是细节。';
    await api(`/api/tasks/${t.json.id}`, { method: 'PATCH', body: { status: 'failed', retry: 'merge', branch: 'wb/T-x', step: long, fail_reason: long } });
    const page = await api(`/tasks?task=${t.json.id}`, { token: null });
    assert.ok(page.text.includes('第二句是细节'));
    assert.match(page.text, /data-api-click="\/api\/tasks\/\d+\/retry-merge"/);
  });
});

describe('027 · 表单里的 hidden', () => {
  test('带 hidden 的输入框真的不显示（.field 的 display:flex 会盖掉浏览器默认规则）', () => {
    const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
    assert.match(css, /\[hidden\] \{ display: none !important; \}/, '否则新建任务里那个「项目名」会一直冒出来');
  });
});

describe('027 · 一键跑通第一个任务', () => {
  test('没有执行器时说清差什么，不显示按钮', async () => {
    db().exec('DELETE FROM tasks');
    db().prepare('DELETE FROM runners').run();
    const page = await api('/', { token: null });
    assert.match(page.text, /还差一步/);
    assert.ok(!page.text.includes('data-api-click="/api/tasks/first-run"'));
  });

  test('有执行器和项目：一个按钮，点了就建只读任务并开始', async () => {
    await runnerSays(['demo-feed']);
    const page = await api('/', { token: null });
    assert.match(page.text, /data-api-click="\/api\/tasks\/first-run"/);
    assert.match(page.text, /让 AI 读一遍你的项目/);

    const r = await api('/api/tasks/first-run', { method: 'POST', token: null });
    assert.equal(r.status, 201, r.text);
    const row = db().prepare('SELECT executor, project, status, start_requested, description FROM tasks WHERE id = ?').get(r.json.id) as any;
    assert.equal(row.executor, 'pool', '用在线那个执行者');
    assert.equal(row.project, 'demo-feed');
    assert.equal(row.status, 'queued');
    assert.equal(row.start_requested, 1, '点了就该马上开工');
    assert.match(row.description, /只读/);
  });

  test('已经有任务以后不再摆这个面板', async () => {
    await api('/api/tasks', { method: 'POST', body: { title: '有任务了', executor: 'pool', project: 'demo' } });
    const page = await api('/', { token: null });
    assert.ok(!page.text.includes('data-first-run'));
  });
});
