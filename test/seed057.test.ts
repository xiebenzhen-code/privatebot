// 057.3：演示数据里要有自媒体。
//
// 以前 `npm run seed` 只写任务、用量、审批，截图里 /media 是空的。
// 这条用例真的跑一遍 scripts/seed.ts（另起一个进程、指到一个临时库），
// 再看那个库上 /media 第一层还是不是「还没记过数据」。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const DIR = mkdtempSync(join(tmpdir(), 'wb-seed057-'));
process.env.WB_TOKEN = 'test-token-057-0123456789abcd';
process.env.WB_DB = join(DIR, 'seed.db');
process.env.WB_PASSWORD = 'test-password-0123456789';

// seed 是个脚本，不是函数：跑完，WB_DB 指的这个库就是「满数据的演示库」。
execFileSync(process.execPath, [join(ROOT, 'scripts', 'seed.ts')], { cwd: ROOT, env: { ...process.env }, stdio: 'pipe' });

const { MEDIA_PLATFORMS } = await import('../src/domain.ts');
const { db } = await import('../src/db.ts');
const { mediaOverview, postsOf } = await import('../src/services/media.ts');

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

after(() => {
  server.close();
  // Windows 上连接没关就删不动这个文件，先关库；删不掉也不影响用例结论（临时目录，系统自己会清）。
  try { db().close(); } catch { /* 已经关了 */ }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 还锁着就算了 */ }
});

test('七个平台都有内容，每条都有数据快照', () => {
  const missing = MEDIA_PLATFORMS.filter((p) => postsOf(p.key).length === 0).map((p) => p.label);
  assert.deepEqual(missing, [], `这几个平台还是空的：${missing.join('、')}`);
  for (const p of MEDIA_PLATFORMS) {
    for (const post of postsOf(p.key)) {
      assert.ok(post.snapshots >= 1 && post.snapshots <= 3, `${p.label}「${post.title}」有 ${post.snapshots} 次快照，应在 1–3 之间`);
      assert.ok((post.latest?.views ?? 0) > 0, `${p.label}「${post.title}」最后一次快照没有播放数`);
      assert.match(post.url, /^https:\/\/example\.com\//, '链接只能是 example.com 的虚构地址');
    }
  }
});

test('同一条内容在几个平台上用的是同一个 piece', () => {
  const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => { const s = m.get(k) ?? new Set<V>(); s.add(v); m.set(k, s); };
  const titles = new Map<string, Set<string>>();
  const platforms = new Map<string, Set<string>>();
  for (const p of MEDIA_PLATFORMS) {
    for (const post of postsOf(p.key)) {
      if (!post.piece) assert.fail(`${p.label}「${post.title}」没写 piece，看不出是同一个内容`);
      add(titles, post.piece, post.title);
      add(platforms, post.piece, p.key);
    }
  }
  for (const [piece, set] of titles) {
    assert.equal(set.size, 1, `piece ${piece} 在不同平台上的标题不一样：${[...set].join(' / ')}`);
  }
  // 至少有一条内容在不止一个平台上出现，否则「同一个 piece」就白写了。
  assert.ok([...platforms.values()].some((s) => s.size > 1), '没有一个 piece 跨平台');
});

test('每个平台都有一份账号快照，账号名是虚构的 @demo-…', () => {
  const o = mediaOverview();
  for (const p of o.platforms) {
    assert.match(p.handle, /^@demo[.\-_]/, `${p.label} 的账号名应该像 @demo-xxx`);
    assert.ok((p.followers ?? 0) > 0, `${p.label} 没有粉丝数`);
  }
});

test('/media 第一层那句话不是「还没记过数据」', async () => {
  const res = await fetch(base + '/media', { headers: { Cookie: cookie } });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.doesNotMatch(text, /还没记过数据/, '/media 第一层还在说「还没记过数据」');
  assert.match(text, /class="lede-line">这周发了 \d+ 条/, '第一层应该直接说这周发了几条');
});
