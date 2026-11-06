// 024b 的行为测试：真实 HTTP 服务 + 自定义 Host 头（模拟「有人从公网地址打开」）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0123456789abcdef';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let server: Server;
let base = '';
let port = 0;
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});
after(() => server.close());

/** 发一个可以自定义 Host 头的请求（fetch 改不了 Host）。 */
function withHost(path: string, host: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: opts.method ?? 'GET',
      headers: { Host: host, ...(opts.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const asMode = (mode: string) => withHost('/api/exposure', `127.0.0.1:${port}`, {
  method: 'POST',
  body: JSON.stringify({ mode }),
  headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
});

describe('024b · 公网访问的处理', () => {
  test('warn：页面顶部出现横幅，审计一天只写一条，且不含完整 IP', async () => {
    const { db } = await import('../src/db.ts');
    const first = await withHost('/', '203.0.113.5:3200', { headers: { Cookie: cookie } });
    assert.equal(first.status, 200);
    assert.match(first.body, /公网地址/, '要有横幅');
    assert.ok(!first.body.includes('203.0.113.5'), '横幅里不能出现完整 IP');

    const second = await withHost('/', '203.0.113.5:3200', { headers: { Cookie: cookie } });
    assert.equal(second.status, 200);

    const rows = db().prepare("SELECT text FROM events WHERE kind = 'net.public_access'").all() as { text: string }[];
    assert.equal(rows.length, 1, '同一来源一天只写一条');
    assert.ok(!rows[0].text.includes('203.0.113.5'), '审计里也不写完整 IP');
    assert.match(rows[0].text, /203\.0\.113\.x/);
  });

  test('refuse：网页被拒，脚本接口（Bearer）照常', async () => {
    const r = await asMode('refuse');
    assert.equal(r.status, 200);

    const page = await withHost('/', '203.0.113.9:3200', { headers: { Cookie: cookie } });
    assert.equal(page.status, 403);
    assert.match(page.body, /不允许从公网地址访问/);

    const api = await withHost('/api/tasks', '203.0.113.9:3200', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(api.status, 200, '执行器、心跳不能被拦');
  });

  test('allow：什么都不做，也没有横幅', async () => {
    await asMode('allow');
    const page = await withHost('/', '203.0.113.77:3200', { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes('公网地址'), '不该有横幅');
  });

  test('WB_ALLOWED_HOSTS 里的域名不触发', async () => {
    await asMode('warn');
    const before = process.env.WB_ALLOWED_HOSTS;
    process.env.WB_ALLOWED_HOSTS = 'wb.mine.dev';
    try {
      const page = await withHost('/', 'wb.mine.dev', { headers: { Cookie: cookie } });
      assert.equal(page.status, 200);
      assert.ok(!page.body.includes('这次是从公网地址打开的'), '登记过的域名不该提醒');
    } finally {
      if (before === undefined) delete process.env.WB_ALLOWED_HOSTS; else process.env.WB_ALLOWED_HOSTS = before;
    }
  });

  test('局域网地址正常，不提醒', async () => {
    const page = await withHost('/', `${[192, 168, 1, 5].join('.')}:${port}`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes('这次是从公网地址打开的'));
  });

  test('改模式是人的动作：脚本令牌会被拒', async () => {
    const r = await withHost('/api/exposure', `127.0.0.1:${port}`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'allow' }),
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    });
    assert.equal(r.status, 403);
  });
});

// 024.1：推送与审计不能被刷屏——每天最多 3 条，同一天按来源集合去重。
describe('024.1 · 可疑访问的提醒上限', () => {
  test('同一天 a、b 交替来 10 次：审计与推送总共不超过 3 条', async () => {
    const { recordSuspicious, exposureState } = await import('../src/services/exposure.ts');
    const { db } = await import('../src/db.ts');
    db().prepare("DELETE FROM events WHERE kind = 'net.public_access'").run();
    db().prepare("DELETE FROM connector_state WHERE name = 'net.exposure'").run();

    const day = '2026-10-31T';
    let notified = 0;
    for (let i = 0; i < 10; i++) {
      const label = i % 2 === 0 ? 'a.example.org' : 'b.example.org';
      if (recordSuspicious({ suspicious: true, kind: 'external-domain', label }, `${day}0${i}:00:00.000Z`)) notified++;
    }
    assert.equal(notified, 2, '两个来源就两条，交替重复不重复提醒');

    // 再来第三个、第四个不同来源：上限 3 条，第 3 条要注明后面不再逐条提醒。
    recordSuspicious({ suspicious: true, kind: 'external-domain', label: 'c.example.org' }, `${day}09:00:00.000Z`);
    const more = recordSuspicious({ suspicious: true, kind: 'external-domain', label: 'd.example.org' }, `${day}09:30:00.000Z`);
    assert.equal(more, false, '超过三条就不再提醒');

    const rows = db().prepare("SELECT text FROM events WHERE kind = 'net.public_access'").all() as { text: string }[];
    assert.equal(rows.length, 3, '审计也最多三条');
    assert.match(rows[2].text, /今天还有更多，不再逐条提醒/, '第三条要说明后面不再提醒');

    const st = exposureState();
    assert.deepEqual(st?.seen?.sort(), ['a.example.org', 'b.example.org', 'c.example.org', 'd.example.org']);
    assert.equal(st?.count, 3);
  });

  test('跨天重新计数', async () => {
    const { recordSuspicious } = await import('../src/services/exposure.ts');
    const { db } = await import('../src/db.ts');
    db().prepare("DELETE FROM events WHERE kind = 'net.public_access'").run();
    db().prepare("DELETE FROM connector_state WHERE name = 'net.exposure'").run();

    for (let i = 0; i < 5; i++) recordSuspicious({ suspicious: true, kind: 'public-ip', label: '203.0.113.x' }, `2026-11-01T0${i}:00:00.000Z`);
    const before = (db().prepare("SELECT COUNT(*) n FROM events WHERE kind = 'net.public_access'").get() as { n: number }).n;
    assert.equal(before, 1, '同一来源一天只有一条');

    const nextDay = recordSuspicious({ suspicious: true, kind: 'public-ip', label: '203.0.113.x' }, '2026-11-02T09:00:00.000Z');
    assert.equal(nextDay, true, '第二天重新计数');
  });
});
