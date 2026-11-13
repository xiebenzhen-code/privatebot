// 044：工作台顶上的一句话派活、第一次打开的说明。
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

describe('044 · 一句话派活', () => {
  test('只写一句话 + 项目就能派：执行者按推荐来，进排队', async () => {
    await runnerSays(['demo-feed']);
    const r = await api('/api/tasks/quick', { method: 'POST', token: null, body: { title: '  联网找 3 个同类项目  ', project: 'demo-feed' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.title, '联网找 3 个同类项目');
    assert.notEqual(r.json.executor, 'me', '不是派给自己');
    assert.equal(r.json.project, 'demo-feed');
    assert.equal(r.json.answer_only, 0);
  });

  test('勾了「只要回答」就是只读任务', async () => {
    const r = await api('/api/tasks/quick', { method: 'POST', token: null, body: { title: '说说这个项目是做什么的', project: 'demo-feed', answer_only: '1' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.answer_only, 1);
  });

  test('没写话：说人话拒绝；没选项目：用上一次用的那个（061）', async () => {
    const before = (db().prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
    const a = await api('/api/tasks/quick', { method: 'POST', token: null, body: { title: '   ', project: 'demo-feed' } });
    assert.equal(a.status, 400);
    assert.match(a.json.error, /写一句/);
    assert.equal((db().prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n, before);
    // 061（设计稿 11-10）：派活框只有一行，不再让人选项目。
    const last = (db().prepare("SELECT project FROM tasks WHERE project != '' ORDER BY id DESC LIMIT 1").get() as { project: string } | undefined)?.project;
    const b = await api('/api/tasks/quick', { method: 'POST', token: null, body: { title: '做点什么' } });
    if (last) { assert.equal(b.status, 201); assert.equal(b.json.project, last); db().prepare('DELETE FROM tasks WHERE id = ?').run(b.json.id); }
    else { assert.equal(b.status, 400); assert.match(b.json.error, /项目/); }
  });

  test('大脑开着时交给大脑：先落在「我」名下等派单', async () => {
    const { saveBrainSettings } = await import('../src/services/brain.ts');
    saveBrainSettings({ on: true });
    try {
      const r = await api('/api/tasks/quick', { method: 'POST', token: null, body: { title: '让大脑挑人', project: 'demo-feed' } });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.route, 'brain');
      assert.equal(r.json.executor, 'me');
      assert.equal(r.json.status, 'inbox');
    } finally {
      saveBrainSettings({ on: false });
    }
  });
});

describe('044 · 派活框的「更多」', () => {
  test('在「更多」里指定了谁来做、写了说明：照办，不问大脑或规则', async () => {
    const r = await api('/api/tasks/quick', { method: 'POST', token: null, body: { title: '指定给本机', project: 'demo-feed', pick_executor: 'local', category: 'ops', description: '跑一下构建' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.executor, 'local');
    assert.equal(r.json.category, 'ops');
    assert.equal(r.json.description, '跑一下构建');
  });
  test('061：派活框只有一行，没有「更多」和跳去任务页的链接', async () => {
    const html = (await api('/', { token: null })).text;
    assert.doesNotMatch(html, /class="ask-more"/);
    assert.match(html, /<button class="send" aria-label="派出去">/);
  });
});

describe('044 · 第一次打开的说明', () => {
  test('有一行说明，点「知道了」之后不再出现', async () => {
    const before = await api('/?view=classic', { token: null });
    assert.match(before.text, /data-first-hint/);
    const r = await api('/api/settings/hint-closed', { method: 'POST', token: null });
    assert.equal(r.status, 200);
    const after = await api('/?view=classic', { token: null });
    assert.doesNotMatch(after.text, /data-first-hint/);
  });
});

describe('053.2 · 等你拍板只列，动作在详情里', () => {
  test('挂在任务上的审批：列表里一行 ›、没有按钮；点进详情才有批准', async () => {
    const a = await api('/api/approvals', { method: 'POST', body: { title: '推送一版', risk: 'high', tool_name: 'git push' } });
    assert.equal(a.status, 201, a.text);
    const page = await api('/?g=you', { token: null });
    const row = page.text.slice(page.text.indexOf('推送一版') - 800, page.text.indexOf('推送一版') + 400);
    assert.match(row, /class="group-go"/);
    assert.doesNotMatch(row, /name="decision"/);
    const tid = a.json.task_id;
    const detail = await api(`/tasks?task=${tid}`, { token: null });
    assert.match(detail.text, /value="approved"[^>]*data-done="已批准推送 ✓"|data-done="已批准推送 ✓"/);
  });
});
