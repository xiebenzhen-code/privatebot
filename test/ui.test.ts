// 016: five top-level pages, segment tabs by path, and the design language that goes with them.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginCookie } from './helpers.ts';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-ui-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const ROOT = join(import.meta.dirname, '..');
let app: Server;
let base = '';
let cookie = '';
let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;
let domain: any;

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  domain = await import('../src/domain.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { app.close(); });

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
  domain.clearLabelCache();
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

const navCount = (html: string) => (html.match(/class="nav-item[ "]/g) ?? []).length;

describe('016 · old addresses still work', () => {
  test('query addresses redirect to the segment path', async () => {
    const cases: [string, string][] = [
      ['/tasks?view=review', '/tasks/review'],
      ['/tasks?executor=me', '/tasks/mine'],
      ['/tasks?tab=done', '/tasks/done'],
      ['/team?tab=accounts', '/team/accounts'],
      ['/data?tab=audit', '/data/audit'],
      ['/settings?tab=backup', '/settings/backup'],
    ];
    for (const [from, to] of cases) {
      const r = await api(from);
      assert.equal(r.status, 303, from);
      assert.equal(r.headers.get('location'), to, from);
    }
    // A task drawer still opens on the board: that link is not "old", it is the current one.
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '看板里的抽屉' }) });
    const board = await api('/tasks?executor=me&task=1');
    assert.equal(board.status, 200);
  });

  test('fragment addresses are mapped by the page and the script', async () => {
    const page = await api('/');
    const raw = page.text.match(/data-hash-routes="([^"]+)"/)?.[1];
    assert.ok(raw, 'the page carries the map');
    const map = JSON.parse(raw!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as [string, string][];
    const pairs = Object.fromEntries(map);
    assert.equal(pairs['/settings#integrations'], '/settings/integrations');
    assert.equal(pairs['/data#accounts'], '/team/accounts');
    assert.equal(pairs['/data#audit'], '/data/audit');
    assert.equal(pairs['/#machines'], '/data/machines');
    assert.equal(pairs['/settings#labels'], '/settings/appearance');
    const js = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(js, /data-hash-routes/, 'the script reads the map');
    assert.match(js, /location\.replace/, 'and replaces the address');
  });
});

describe('016 · navigation', () => {
  test('061: no sidebar, no top bar; home has the crew row and gear, other pages lead back home', async () => {
    for (const path of ['/', '/tasks', '/tasks/review', '/team', '/data/audit', '/settings']) {
      const page = await api(path);
      assert.equal(page.status, 200, path);
      assert.ok(!page.text.includes('id="wb-side"'), path);
      assert.ok(!page.text.includes('class="shell-head"'), path);
      if (path !== '/') assert.match(page.text, /<nav class="crumbs layer-crumbs"[^>]*><a href="\/">工作台<\/a>/, path);
    }
    const home = await api('/');
    assert.match(home.text, /data-crew-row/);
    assert.match(home.text, /data-gear/);
  });

  test('a new executor adds a filter and a card', async () => {
    domain.EXECUTORS.newbie = { label: '新来的', color: '#0891B2' };
    try {
      const tasks = await api('/tasks');
      assert.ok(tasks.text.includes('executor=newbie'), 'board filter knows it');
      const team = await api('/team');
      assert.ok(team.text.includes('新来的'), 'team page shows a card');
      assert.equal((team.text.match(/class="exec-section"/g) ?? []).length, Object.keys(domain.EXECUTORS).length, '每个执行者一个区，含「我」');
    } finally {
      delete domain.EXECUTORS.newbie;
    }
  });

  test('every segment address opens directly and marks itself current', async () => {
    const paths = ['/tasks', '/tasks/review', '/tasks/mine', '/tasks/done'];
    // 044 v3：剧组、记录不用分段标签；下一层顶上是「区名 › 某类」。
    for (const [path, home] of [['/team/accounts', '/team'], ['/data/audit', '/data'], ['/data/machines', '/data']]) {
      const page = await api(path);
      assert.equal(page.status, 200, path);
      // 061.1：顶上先是「工作台 ›」，再是区名。
      assert.match(page.text, new RegExp(`<nav class="crumbs layer-crumbs"[^>]*><a href="/">工作台</a><span aria-hidden="true">›</span><a href="${home}">`), path);
    }
    for (const path of ['/team', '/data']) assert.equal((await api(path)).status, 200, path);
    for (const path of paths) {
      const page = await api(path);
      assert.equal(page.status, 200, path);
      assert.ok(page.text.includes(`href="${path}" aria-selected="true"`), `${path} marks its tab`);
      assert.equal((page.text.match(/aria-selected="true"/g) ?? []).length, 1, `${path} marks one tab`);
    }
    // 044 v3：设置不用分段标签——/settings 是一行一类的总览，每一类自己的页面顶上是「设置 › 某类」。
    const home = await api('/settings');
    for (const k of ['integrations', 'security', 'notify', 'appearance', 'backup']) assert.match(home.text, new RegExp(`href="/settings/${k}" data-settings-row="${k}"`));
    for (const k of ['integrations', 'security', 'notify', 'appearance', 'backup']) {
      const page = await api(`/settings/${k}`);
      assert.equal(page.status, 200, k);
      assert.match(page.text, /<nav class="crumbs layer-crumbs"[^>]*><a href="\/">工作台<\/a><span aria-hidden="true">›<\/span><a href="\/settings">设置<\/a>/, k);
    }
  });

  test('a segment that does not exist falls back to the first tab', async () => {
    for (const path of ['/tasks/nope', '/team/nope', '/data/nope', '/settings/nope']) {
      const r = await api(path);
      assert.equal(r.status, 303, path);
      assert.equal(r.headers.get('location'), path.split('/').slice(0, 2).join('/'), path);
    }
  });

  test('the settings page is five pages now, each with its own subject', async () => {
    const expectations: [string, string][] = [
      ['/settings/integrations', '接入状态'],
      ['/settings/security', '审批规则'],
      ['/settings/notify', '推送渠道'],
      ['/settings/appearance', '称呼'],
      ['/settings/backup', '自动备份'],
    ];
    for (const [path, word] of expectations) {
      const page = await api(path);
      assert.ok(page.text.includes(word), `${path} has ${word}`);
    }
    const appearance = await api('/settings/appearance');
    // 061 之后没有侧栏了，外观里不该再出现「侧边栏」这个开关。
    assert.ok(!appearance.text.includes('data-side-default'), 'no sidebar default to set');
    assert.ok(!appearance.text.includes('侧边栏'), 'no sidebar panel left in 外观');
    const security = await api('/settings/security');
    assert.ok(security.text.includes('暂停所有自动执行') || security.text.includes('恢复自动执行'));
  });
});

describe('016 · names follow 011', () => {
  test('the crew preset renames the tabs', async () => {
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'crew' }) });
    const team = await api('/team');
    assert.ok(team.text.includes('预算表 ›'), 'accounts link follows the preset');
    const tasks = await api('/tasks');
    assert.ok(tasks.text.includes('>拍摄进度<'));
    assert.ok(tasks.text.includes('>审片<'));
    assert.ok(tasks.text.includes('>制片待办<'));

    await api('/api/labels', { method: 'POST', body: JSON.stringify({ preset: 'default' }) });
    const back = await api('/team');
    assert.ok(back.text.includes('账号与额度 ›'));
  });
});

describe('016 · design language', () => {
  test('style.css only uses the four corner sizes', () => {
    const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
    for (const name of ['--r-card', '--r-inner', '--r-control', '--r-pill']) {
      assert.ok(css.includes(`${name}:`), `${name} is defined`);
    }
    const radii = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(radii.length > 20, 'the stylesheet styles things');
    for (const value of radii) {
      // A shorthand may zero one side (a drawer glued to the screen edge); the rest must be a token.
      for (const part of value.split(/\s+/)) {
        assert.match(part, /^(var\(--r-(card|inner|control|pill)\)|0)$/, `unexpected corner: ${value}`);
      }
    }
  });

  test('one border colour and two shadows, both named', () => {
    const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
    assert.ok(css.includes('--line: #E7E6E0'));
    assert.ok(css.includes('--line-strong: #D6D5CE'));
    assert.ok(css.includes('--shadow-card:'));
    assert.ok(css.includes('--shadow-float:'));
    assert.ok(css.includes('prefers-reduced-motion'));
  });
});

describe('016 · what each page shows', () => {
  const makeTask = async (title: string, executor = 'claude') => {
    // 025：派给 Agent 必须选项目，否则创建就被拦下（这测的是页面，不是那条规则）。
    const body = executor === 'me' ? { title, executor } : { title, executor, project: 'demo-feed' };
    const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 201, title);
    return r.json.id as number;
  };

  // 061.1：只有一个数——「等你」。审批和你自己的待办都是要你动手的事，合在一个徽标里。
  // 061.1（用户 11-10 定的设计稿）：只有一个数——「等你」，挂在左上角回首页的头像上。审批算；你派给自己的待办不急，不算。
  test('one number: 等你 (approvals count, your own todos do not)', async () => {
    await makeTask('归我管的', 'me');
    await api('/api/approvals', { method: 'POST', body: JSON.stringify({ title: '删文件', risk: 'medium', tool_name: 'Bash' }) });
    const page = await api('/');
    assert.match(page.text, /等你<span class="flow-n"> · 1</);
    assert.match(page.text, /你的待办 · 1/);
  });

  test('the board no longer holds finished work, and 已完成 pages through it', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 22; i++) ids.push(await makeTask(`做完了 ${i}`));
    for (const id of ids) await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });

    const board = await api('/tasks');
    assert.ok(!board.text.includes('aria-label="已完成"'), 'no finished column on the board');
    assert.ok(!board.text.includes('做完了 1'), 'and no finished card');

    const first = await api('/tasks/done');
    assert.ok(first.text.includes('第 1 / 2 页'));
    assert.equal((first.text.match(/class="row"/g) ?? []).length, 20);
    const second = await api('/tasks/done?page=2');
    assert.ok(second.text.includes('第 2 / 2 页'));
    assert.equal((second.text.match(/class="row"/g) ?? []).length, 2);
  });

  test('我的待办 is exactly executor=me', async () => {
    await makeTask('我的私事', 'me');
    await makeTask('导演的活', 'claude');
    const mine = await api('/tasks/mine');
    assert.ok(mine.text.includes('我的私事'));
    assert.ok(!mine.text.includes('导演的活'));
  });

  test('an executor card carries its quota, today tokens, running count and mode', async () => {
    const page = await api('/team');
    assert.ok(page.text.includes('自动跑') || page.text.includes('手动派'));
    const drawer = await api('/team?exec=claude');
    for (const field of ['name="priority"', 'name="categories"', 'name="daily_token_cap"', 'name="max_minutes"', 'name="auto_allowed"', 'name="enabled"']) {
      assert.ok(drawer.text.includes(field), field);
    }
  });

  test('the phone layout is one column: no bottom bar, tabs scroll sideways', () => {
    const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
    const start = css.indexOf('@media (max-width: 820px)');
    const phone = css.slice(start, css.indexOf('/* ---------- page header', start));
    // 061 之后没有侧栏，也就没有手机底栏；旧侧栏样式不该再回来
    assert.ok(!phone.includes('position: fixed'), 'no bottom bar on a phone');
    assert.ok(!/\.nav-/.test(phone), 'no old nav labels');
    assert.match(phone, /\.field-row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(css, /\.seg \{[^}]*overflow-x: auto/);
    assert.match(css, /body \{ overflow-x: hidden; \}/);
  });
});
