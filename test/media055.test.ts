// 055.1 · 自媒体数据看板：七个平台、记内容、记数据快照（只追加）、账号粉丝、第一层一句话、第二层每条内容。
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { loginCookie } from './helpers.ts';

process.env.TZ = 'UTC';
process.env.WB_TZ = 'America/Los_Angeles';

process.env.WB_TOKEN = 'test-token-055media-0123456789';
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let D: any;
let media: any;

before(async () => {
  D = await import('../src/db.ts');
  media = await import('../src/services/media.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => { app.close(); });
beforeEach(async () => {
  D.useDb(D.openDb(':memory:'));
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, method = 'GET', body?: any): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 页面 */ }
  return { status: res.status, json, text };
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe('055.1 · 接口', () => {
  for (const [zone, expected] of [
    ['America/Los_Angeles', '2026-11-06T20:00:00.000Z'],
    ['Pacific/Auckland', '2026-11-05T23:00:00.000Z'],
  ]) {
    test(`日期录入在 ${zone} 保留当天中午`, () => {
      const probe = `
        import assert from 'node:assert/strict';
        import { createPost, addStats } from './src/services/media.ts';
        import { dayOf } from './src/domain.ts';
        Date.now = () => Date.parse('2026-11-07T00:00:00Z');
        const day = '2026-11-06';
        const post = createPost({ platform: 'x', title: '日期测试', published_at: day });
        assert.equal(dayOf(post.published_at), day);
        assert.equal(post.published_at, process.env.EXPECTED_NOON);
        assert.equal(addStats(post.id, { views: 1, at: day }).at, process.env.EXPECTED_NOON);
        assert.throws(() => createPost({ platform: 'x', title: '日期测试', published_at: '2026-02-30' }), /看不懂/);
      `;
      execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, TZ: 'UTC', WB_TZ: zone, WB_DB: ':memory:', EXPECTED_NOON: expected },
        windowsHide: true,
      });
    });
  }

  test('记一条内容：七个平台都收；平台、标题、链接、日期不对就 400，说人话', async () => {
    for (const p of ['bilibili', 'xiaohongshu', 'douyin', 'channels', 'x', 'instagram', 'facebook']) {
      const r = await api('/api/media/posts', 'POST', { platform: p, title: `EP01 ${p}`, piece: 'EP01' });
      assert.equal(r.status, 200, p);
    }
    for (const [body, re] of [
      [{ platform: 'tiktok', title: 'x' }, /平台只能是/],
      [{ platform: 'x', title: '' }, /标题不能空/],
      [{ platform: 'x', title: 'a'.repeat(201) }, /最多 200/],
      [{ platform: 'x', title: 'x', url: 'javascript:alert(1)' }, /链接/],
      [{ platform: 'x', title: 'x', url: 'ftp://a' }, /链接/],
      [{ platform: 'x', title: 'x', published_at: '下周' }, /看不懂/],
      [{ platform: 'x', title: 'x', published_at: '2999-01-01' }, /未来/],
    ] as [any, RegExp][]) {
      const r = await api('/api/media/posts', 'POST', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re);
    }
  });

  test('数据快照只追加：同一条记两次，两行都在，最新的是后记的；空表单 400；负数 400；带逗号的数照收', async () => {
    const post = (await api('/api/media/posts', 'POST', { platform: 'bilibili', title: 'EP01' })).json.post;
    assert.equal((await api(`/api/media/posts/${post.id}/stats`, 'POST', { views: '1,200', likes: '30' })).status, 200);
    assert.equal((await api(`/api/media/posts/${post.id}/stats`, 'POST', { views: '5600', comments: '12' })).status, 200);
    const all = media.statsOf(post.id);
    assert.equal(all.length, 2);
    assert.equal(all[0].views, 1200);
    assert.equal(media.postsOf('bilibili')[0].latest.views, 5600);
    assert.match((await api(`/api/media/posts/${post.id}/stats`, 'POST', {})).json.error, /至少填一个/);
    assert.match((await api(`/api/media/posts/${post.id}/stats`, 'POST', { views: -1 })).json.error, /0 或正数/);
    assert.equal((await api('/api/media/posts/99999/stats', 'POST', { views: 1 })).status, 404);
  });

  test('删除连数据一起删；只能在网页上删（脚本令牌不行）', async () => {
    const post = (await api('/api/media/posts', 'POST', { platform: 'x', title: 'gm' })).json.post;
    await api(`/api/media/posts/${post.id}/stats`, 'POST', { views: 10 });
    const bearer = await fetch(`${base}/api/media/posts/${post.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.WB_TOKEN}` } });
    assert.notEqual(bearer.status, 200);
    assert.equal((await api(`/api/media/posts/${post.id}`, 'DELETE')).status, 200);
    assert.equal(media.statsOf(post.id).length, 0);
    assert.equal(media.postsOf('x').length, 0);
  });

  test('改了数据，pulse 跟着变（页面会自动刷新）', async () => {
    const before = (await api('/api/pulse')).text;
    await api('/api/media/posts', 'POST', { platform: 'x', title: 'gm' });
    assert.notEqual((await api('/api/pulse')).text, before);
  });

  test('每次改动都进审计', async () => {
    await api('/api/media/posts', 'POST', { platform: 'douyin', title: '第一条' });
    await api('/api/media/accounts', 'POST', { platform: 'douyin', followers: 100 });
    const kinds = D.db().prepare("SELECT kind FROM events WHERE kind LIKE 'media.%'").all().map((r: any) => r.kind);
    assert.deepEqual(kinds, ['media.post', 'media.account']);
  });
});

describe('055.1 · 第一层', () => {
  test('发布日期默认工作台时区当天，系统 UTC 不覆盖 WB_TZ', async () => {
    for (const [instant, expected] of [
      ['2026-11-06T00:30:00Z', '2026-11-05'],
      ['2026-11-06T20:30:00Z', '2026-11-06'],
      ['2026-11-01T01:30:00Z', '2026-10-31'],
    ]) {
      mock.timers.enable({ apis: ['Date'], now: Date.parse(instant) });
      try {
        const response = await api('/media');
        assert.equal(response.status, 200);
        const value = /name="published_at" type="date" value="([^"]+)"/.exec(response.text)?.[1];
        assert.equal(value, expected, instant);
      } finally {
        mock.timers.reset();
      }
    }
  });

  test('什么都没记：一句话叫你记第一条，七个平台一行一个，全灭', async () => {
    const r = await api('/media');
    assert.equal(r.status, 200);
    assert.match(r.text, /还没记过数据/);
    assert.equal((r.text.match(/data-media-row="/g) ?? []).length, 7);
    for (const label of ['B站', '小红书', '抖音', '视频号', 'X', 'Instagram', 'Facebook']) assert.ok(r.text.includes(`<span class="group-label">${label}</span>`), label);
    assert.ok(!r.text.includes('media-mark lit'));
    // 061.1：没有侧栏；自媒体从「高级」进，顶上是「工作台 › 自媒体」。
    assert.match(r.text, /<nav class="crumbs layer-crumbs"[^>]*><a href="\/">工作台<\/a>/);
  });

  test('这周发了：一句话报条数、播放和最好的一条；发过的平台亮；涨粉按 7 天前的快照算', async () => {
    const a = media.createPost({ platform: 'bilibili', title: 'EP01', published_at: daysAgo(2) });
    media.addStats(a.id, { views: 12000 });
    const b = media.createPost({ platform: 'xiaohongshu', title: 'EP01', published_at: daysAgo(1) });
    media.addStats(b.id, { views: 800 });
    media.createPost({ platform: 'x', title: 'old', published_at: daysAgo(30) });
    D.db().prepare('INSERT INTO media_accounts (platform, handle, followers, at) VALUES (?, ?, ?, ?)').run('bilibili', '@me', 100, daysAgo(10));
    media.setAccount({ platform: 'bilibili', followers: 220 });
    const r = await api('/media');
    assert.match(r.text, /这周发了 2 条，1\.3万 次播放，B站那条最好（1\.2万）/);
    assert.match(r.text, /data-media-row="bilibili"[\s\S]*?media-mark lit/);
    assert.match(r.text, /220 粉 ↑120/);
    const o = media.mediaOverview();
    assert.equal(o.platforms.find((p: any) => p.key === 'x').posts7, 0);
  });
});

describe('055.1 · 第二层', () => {
  test('一个平台：路径、粉丝一句话、每条内容最新的数用符号；点开有历史表；表单都折着', async () => {
    const p = media.createPost({ platform: 'instagram', title: 'Reel 01 <script>', url: 'https://instagram.com/p/x' });
    media.addStats(p.id, { views: 300, likes: 20 });
    media.addStats(p.id, { views: 900, likes: 41, comments: 3 });
    media.setAccount({ platform: 'instagram', handle: '@me', followers: 1500 });
    const r = await api('/media?p=instagram');
    assert.match(r.text, /<nav class="crumbs"[^>]*><a href="\/media">自媒体<\/a>/);
    assert.match(r.text, /1,500 粉 · 共 1 条/);
    assert.match(r.text, /aria-label="播放 900">▶ 900/);
    assert.match(r.text, /aria-label="评论 3">✉ 3/);
    assert.ok(r.text.includes('Reel 01 &lt;script&gt;'), '标题转义');
    assert.ok(!r.text.includes('<script>'));
    assert.equal((r.text.match(/<tr><td class="mono small">/g) ?? []).length, 2, '两次记录都在历史表里');
    assert.match(r.text, /<details class="fold" id="fold-addpost-instagram"><summary>＋ 记一条/);
    assert.match(r.text, /<details class="fold" id="fold-account-instagram"><summary>⚙ 账号/);
    assert.match(r.text, /<svg class="mini"/, '两次以上有小曲线');
    assert.ok(!/<details class="fold"[^>]* open/.test(r.text), '录入表单默认都不展开');
  });

  test('不认识的平台回第一层', async () => {
    const r = await api('/media?p=tiktok');
    assert.match(r.text, /data-layer="media"/);
  });
});
