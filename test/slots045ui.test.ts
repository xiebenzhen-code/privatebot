// 045：剧组页的账号槽。
//
// 钉住三件事：
//   1. 页面上真的能看到槽——名字、状态文字（可用 / 在等几点重置 / 已到期 / 停用）、到期日；
//   2. 能开槽的（claude、workbuddy）有能提交的表单；dsh 和走反代池的置灰，一个能提交的表单都没有；
//   3. 同一个执行者已经有一个槽时，添加表单上方会多一句厂商条款的提示，但表单照样能开。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-045ui-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let db: any;
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
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
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 空响应 */ }
  return { status: res.status, json };
}

/** 剧组页一段 HTML 里，某个执行者那一条（从 data-exec 到下一个 data-exec）。 */
function sectionOf(html: string, key: string): string {
  const tag = `data-exec="${key}"`;
  const i = html.indexOf(tag);
  if (i < 0) return '';
  const next = html.indexOf('data-exec="', i + tag.length);
  return html.slice(i, next < 0 ? html.length : next);
}

async function teamHtml(): Promise<string> {
  const res = await fetch(`${base}/team`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);
  return res.text();
}

async function addSlot(input: Record<string, unknown>): Promise<void> {
  const r = await api('/api/slots', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(r.status, 201, `建槽失败：${JSON.stringify(r.json)}`);
}

describe('剧组页的账号槽', () => {
  test('claude：槽名、状态文字、到期日都在页面上', async () => {
    await addSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a', label: '主力', expires_at: '2027-06-30' });
    await addSlot({ name: 'claude-b', executor: 'claude', slot_dir: 'claude-b', label: '备用', expires_at: '2026-01-05' });
    await addSlot({ name: 'claude-c', executor: 'claude', slot_dir: 'claude-c' });
    const off = await api('/api/slots/claude-c', { method: 'PUT', body: JSON.stringify({ slot_enabled: 0 }) });
    assert.equal(off.status, 200);

    const html = await teamHtml();
    const claude = sectionOf(html, 'claude');
    assert.ok(claude, '剧组页应该有 claude 那一条');

    // 三个槽都在
    for (const name of ['claude-a', 'claude-b', 'claude-c']) {
      assert.match(claude, new RegExp(`data-slot="${name}"`), `${name} 应该出现在页面上`);
    }
    // 标签和三种状态文字
    assert.match(claude, /主力/);
    assert.match(claude, /可用/);
    assert.match(claude, /已到期/); // 2026-01-05 早过期了
    assert.match(claude, /停用/);
    // 到期日按天写在槽上
    assert.match(claude, /2027-06-30/);
    // 目录名也照原样显示，不拼成路径
    assert.match(claude, /目录 <span class="mono">claude-a<\/span>/);
  });

  test('claude：能停用、能改优先级和到期日，都是走 data-api 的表单', async () => {
    await addSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const claude = sectionOf(await teamHtml(), 'claude');

    // 停用：一个带 slot_enabled 隐藏字段的 PUT 表单
    assert.match(claude, /data-api="\/api\/slots\/claude-a" data-method="PUT"/);
    assert.match(claude, /name="slot_enabled" value="0"/);
    // 改期：优先级和到期日两个字段，同一个 PUT
    assert.match(claude, /name="slot_priority"/);
    assert.match(claude, /name="expires_at"/);
    // 添加表单：POST /api/slots，executor 用隐藏字段带上
    assert.match(claude, /data-api="\/api\/slots" data-method="POST"/);
    assert.match(claude, /name="executor" value="claude"/);
    for (const f of ['name="name"', 'name="slot_dir"', 'name="label"']) {
      assert.ok(claude.includes(f), `添加表单里应该有 ${f}`);
    }
  });

  test('第一个槽和第二个槽：第二个才提醒厂商条款，表单照样能提交', async () => {
    const hint = '有的厂商不允许一个人同时用多个账号，请自己确认条款';
    assert.ok(!sectionOf(await teamHtml(), 'claude').includes(hint), '还没有槽的时候不该提这句');

    await addSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const claude = sectionOf(await teamHtml(), 'claude');
    assert.ok(claude.includes(hint), '已经有一个槽了，添加前要提一句');
    assert.match(claude, /data-api="\/api\/slots" data-method="POST"/); // 提示不挡操作
  });

  test('dsh 和走反代池的置灰：说清原因，一个能提交的表单都没有', async () => {
    await addSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    const html = await teamHtml();

    const dsh = sectionOf(html, 'dsh');
    assert.ok(dsh.includes('dsh 用 API 密钥标识身份，不做登录目录槽'));
    assert.ok(!dsh.includes('data-api="/api/slots'), 'dsh 不该有添加账号槽的表单');
    assert.ok(!dsh.includes('data-method="PUT"'), 'dsh 不该有能改槽的表单');

    const pool = sectionOf(html, 'pool');
    assert.ok(pool.includes('这个执行者走反代池，账号轮换交给 CLIProxyAPI'));
    assert.ok(!pool.includes('data-api="/api/slots'), '反代池不该有添加账号槽的表单');

    // workbuddy（codebuddy）和 claude 一样能开
    const wb = sectionOf(html, 'workbuddy');
    assert.match(wb, /data-api="\/api\/slots" data-method="POST"/);
    assert.match(wb, /name="executor" value="workbuddy"/);
  });

  test('workbuddy 也有自己的槽，不会和 claude 的串在一起', async () => {
    await addSlot({ name: 'claude-a', executor: 'claude', slot_dir: 'claude-a' });
    await addSlot({ name: 'cb-a', executor: 'workbuddy', slot_dir: 'cb-a', label: '第二个号' });
    const html = await teamHtml();
    assert.match(sectionOf(html, 'workbuddy'), /data-slot="cb-a"/);
    assert.ok(!sectionOf(html, 'workbuddy').includes('data-slot="claude-a"'), 'workbuddy 区块里不该出现 claude 的槽');
    assert.ok(!sectionOf(html, 'claude').includes('data-slot="cb-a"'), 'claude 区块里不该出现 workbuddy 的槽');
  });
});
