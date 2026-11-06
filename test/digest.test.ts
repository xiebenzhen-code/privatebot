// 019: one comment a day, overview only. The digest must never leak a command, a path or a title
// unless the user asked for titles — and it must never send twice in one day.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';
import { githubClient, relayIssues, relayOutbox } from '../scripts/lib/github-relay.mjs';

const TOKEN = 'test-token-digest-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';
process.env.GITHUB_REPOS = 'me/ai-workbench';
process.env.WB_TZ = 'Asia/Shanghai';

let app: Server;
let gh: Server;
let base = '';
let ghBase = '';
let cookie = '';
let db: any;
let digest: typeof import('../src/services/digest.ts');
let tasks: typeof import('../src/services/tasks.ts');
let approvals: typeof import('../src/services/approvals.ts');
let github: typeof import('../src/services/github.ts');
let outbox: typeof import('../src/services/github-outbox.ts');
let sources: typeof import('../src/services/sources.ts');

/** 019.1 的基线：备份刚成功、所有来源都停用——这时日报才有资格「安静」。 */
function seedQuiet(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connector_state (name, last_run, last_ok) VALUES ('backup', ?, ?)
     ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_ok = excluded.last_ok`,
  ).run(now, now);
  for (const s of sources.SOURCES) sources.setSourceOff(s.id, true);
}
let openDb: (f?: string) => any;
let useDb: (d: any) => void;

// What the fake GitHub saw.
const seen: { method: string; path: string; body: any }[] = [];
const state = { fail: false, issues: [] as any[], comments: [] as string[] };

before(async () => {
  ({ openDb, useDb } = await import('../src/db.ts'));
  digest = await import('../src/services/digest.ts');
  tasks = await import('../src/services/tasks.ts');
  approvals = await import('../src/services/approvals.ts');
  github = await import('../src/services/github.ts');
  outbox = await import('../src/services/github-outbox.ts');
  sources = await import('../src/services/sources.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });

  gh = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, path: req.url!, body });
      if (state.fail) { res.writeHead(500).end('{}'); return; }
      const url = req.url!;
      if (req.method === 'GET' && url.startsWith('/repos/me/ai-workbench/issues?')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.issues));
        return;
      }
      if (req.method === 'POST' && url === '/repos/me/ai-workbench/issues') {
        const issue = { number: 21, html_url: 'https://github.com/me/ai-workbench/issues/21', title: body?.title, labels: (body?.labels ?? []).map((name: string) => ({ name })) };
        state.issues.push(issue);
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(issue));
        return;
      }
      if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(url)) {
        state.comments.push(body.body);
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 900 + state.comments.length }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
  });

  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
  const a: any = app.address();
  const g: any = gh.address();
  base = `http://127.0.0.1:${a.port}`;
  ghBase = `http://127.0.0.1:${g.port}`;
});
after(() => { app.close(); gh.close(); });

beforeEach(async () => {
  db = openDb(':memory:');
  useDb(db);
  db.prepare(`DELETE FROM connector_state`).run();
  db.prepare(`DELETE FROM settings`).run();
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
  seen.length = 0;
  state.fail = false;
  state.issues = [];
  state.comments = [];
});

const post = (path: string, body: any, headers: Record<string, string>) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const request = (...args: [string, string, unknown?]) => githubClient({ githubToken: 'gh-test-token' }, { base: ghBase })(...args);
async function flushDigest(now = new Date()) {
  await relayOutbox({ request, call: (method, path, data) => {
    if (method === 'GET') return { job: outbox.claimGithubJob(now) };
    return outbox.finishGithubJob(Number(path.split('/').at(-1)), data, digest.recordDigestDelivery, now);
  } });
}
async function maybeRunDigest(now: Date) {
  const result = await digest.maybeRunDigest(now);
  await flushDigest(now);
  return result;
}
async function sendDigest(opts: { manual: boolean; now?: Date }) {
  const result = await digest.sendDigest(opts);
  await flushDigest(opts.now);
  return result;
}

describe('019 · 开关与发送', () => {
  test('默认关着：到点也不发', async () => {
    const res = await maybeRunDigest(new Date('2026-10-30T09:00:00+08:00'));
    assert.equal(res.skipped, true);
    assert.equal(state.comments.length, 0);
  });

  test('打开后到点发一条，自己建 Issue 并打 wb-digest 标签', async () => {
    digest.saveDigestSettings({ on: true, repo: 'me/ai-workbench', at: '08:00', titles: false });
    const res = await maybeRunDigest(new Date('2026-10-30T08:05:00+08:00'));
    assert.equal(res.ok, true);
    assert.equal(state.comments.length, 1);
    const created = seen.find((s) => s.method === 'POST' && s.path === '/repos/me/ai-workbench/issues');
    assert.ok(created, 'issue should be created');
    assert.deepEqual(created!.body.labels, ['wb-digest']);
    assert.match(state.comments[0], /^工作台日报 · 2026-10-30/);
  });

  test('同一天只发一条；第二次跳过', async () => {
    digest.saveDigestSettings({ on: true, at: '08:00' });
    await maybeRunDigest(new Date('2026-10-30T08:05:00+08:00'));
    const again = await maybeRunDigest(new Date('2026-10-30T14:00:00+08:00'));
    assert.equal(again.skipped, true);
    assert.equal(state.comments.length, 1);
  });

  test('错过时间（当天下午才开机）补发，内容带「补发」', async () => {
    digest.saveDigestSettings({ on: true, at: '08:00' });
    await maybeRunDigest(new Date('2026-10-30T13:00:00+08:00'));
    assert.match(state.comments[0], /（补发）/);
  });

  test('019.1 失败退避：窗口内不重试、审计只 1 条；30 分钟后再试 1 次、同一错误不重复记', async () => {
    digest.saveDigestSettings({ on: true, at: '08:00' });
    state.fail = true;
    await maybeRunDigest(new Date('2026-10-30T08:05:00+08:00'));
    const afterFirst = seen.length;
    assert.ok(afterFirst > 0, '第一次真的发了请求');

    await maybeRunDigest(new Date('2026-10-30T08:06:00+08:00'));
    await maybeRunDigest(new Date('2026-10-30T08:07:00+08:00'));
    assert.equal(seen.length, afterFirst, '退避窗口内一个请求都没有');
    let audit = db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'digest.failed'`).get() as { n: number };
    assert.equal(audit.n, 1, '失败只写一条审计');

    await maybeRunDigest(new Date('2026-10-30T08:36:00+08:00'));
    assert.ok(seen.length > afterFirst, '过了退避期重试了一次');
    audit = db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'digest.failed'`).get() as { n: number };
    assert.equal(audit.n, 1, '同一个错误不重复写审计');
  });

  test('019.1 成功后清掉退避：第二天再失败立刻就试，且因为错误是新的一轮、审计再记一条', async () => {
    digest.saveDigestSettings({ on: true, at: '08:00' });
    state.fail = true;
    await maybeRunDigest(new Date('2026-10-30T08:05:00+08:00'));

    state.fail = false;
    await sendDigest({ manual: true, now: new Date('2026-10-30T08:10:00+08:00') });
    assert.equal(state.comments.length, 1, '成功发出（手动发送不受退避限制）');
    assert.equal(digest.digestSettings().next_try, '', '退避已清掉');

    state.fail = true;
    const before = seen.length;
    await maybeRunDigest(new Date('2026-10-31T08:05:00+08:00'));
    assert.ok(seen.length > before, '退避清掉后定时器立刻重试');
    const audit = db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'digest.failed'`).get() as { n: number };
    assert.equal(audit.n, 2, '成功过一轮之后，同样的错误也算新问题');
  });

  test('GitHub 不可用：记错误、写审计，不抛出去', async () => {
    digest.saveDigestSettings({ on: true, at: '08:00' });
    state.fail = true;
    const res = await sendDigest({ manual: true });
    assert.equal(res.queued, true);
    const s = digest.digestSettings();
    assert.ok(s.last_error.includes('500'));
    const audit = db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'digest.failed'`).get() as { n: number };
    assert.equal(audit.n, 1);
    // 工作台其他页面照常
    const home = await fetch(base + '/', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(home.status, 200);
  });
});

describe('019 · 内容', () => {
  const makeYesterday = (t: { id: number }) => {
    const y = new Date(Date.now() - 86400000).toISOString();
    db.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?').run(y, y, t.id);
  };

  test('数字对得上，默认不带任务标题', async () => {
    const done = tasks.createTask({ title: '做完了这个', executor: 'pool' });
    tasks.updateTask(done.id, { status: 'done' }, 'system');
    makeYesterday(done);
    const failed = tasks.createTask({ title: '失败的那个', executor: 'pool' });
    tasks.updateTask(failed.id, { status: 'failed' }, 'system');
    makeYesterday(failed);
    approvals.createApproval({ title: '合并 wb/T-1', tool_name: 'git merge', risk: 'high' });

    const text = digest.buildDigest({ now: new Date() });
    assert.match(text, /完成 1 个，失败 1 个/);
    assert.match(text, /待审批 1 条（最高风险：高）/);
    assert.doesNotMatch(text, /做完了这个/);
    assert.doesNotMatch(text, /失败的那个/);
  });

  test('打开标题开关：只列失败、等审批、卡住的，标题里的 key 形字符串被打码', async () => {
    const failed = tasks.createTask({ title: '失败 sk-placeholder-leak', executor: 'pool' });
    tasks.updateTask(failed.id, { status: 'failed' }, 'system');
    const done = tasks.createTask({ title: '已经做完的', executor: 'pool' });
    tasks.updateTask(done.id, { status: 'done' }, 'system');
    const stuck = tasks.createTask({ title: '大概卡住了', executor: 'pool' });
    tasks.updateTask(stuck.id, { status: 'running' }, 'system');
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 240 * 60000).toISOString(), stuck.id);

    const text = digest.buildDigest({ now: new Date(), titles: true });
    assert.match(text, /T-\d+ 失败/);
    assert.match(text, /可能卡住/);
    assert.doesNotMatch(text, /已经做完的/);
    assert.ok(!text.includes('sk-placeholder-leak'), text);
  });

  test('没有命令、没有路径：标题里夹的都不出现', async () => {
    const t = tasks.createTask({ title: '改 C:/Users/me/secret/app.ts 并跑 npm run deploy', executor: 'pool' });
    tasks.updateTask(t.id, { status: 'failed' }, 'system');
    const text = digest.buildDigest({ now: new Date(), titles: true });
    assert.ok(!text.includes('C:/Users/me/secret'), text);
    assert.ok(!text.includes('npm run deploy'), text);
  });

  test('没有等你的事时只有一句话（019.1：备份、额度、接入都得先干净）', async () => {
    seedQuiet();
    const text = digest.buildDigest({ now: new Date() });
    assert.match(text, /没有等你的事/);
    assert.doesNotMatch(text, /等你处理/);
  });

  test('019.1 安静判定：备份 5 天前 / 额度偏低 / 接入待操作，任何一个都不算安静', async () => {
    seedQuiet();

    // 备份 5 天没成功
    db.prepare(`UPDATE connector_state SET last_ok = ? WHERE name = 'backup'`)
      .run(new Date(Date.now() - 5 * 86400000).toISOString());
    let text = digest.buildDigest({ now: new Date() });
    assert.doesNotMatch(text, /没有等你的事/);
    assert.match(text, /备份/);
    seedQuiet();

    // 额度偏低
    db.prepare(`INSERT INTO accounts (name, executor, status, updated_at) VALUES ('测试账号', 'pool', 'near', ?)`)
      .run(new Date().toISOString());
    text = digest.buildDigest({ now: new Date() });
    assert.doesNotMatch(text, /没有等你的事/);
    assert.match(text, /偏低/);
    db.prepare(`DELETE FROM accounts WHERE name = '测试账号'`).run();

    // 接入待操作：启用一个没配置的来源（glm 没有 key → action）
    sources.setSourceOff('glm', false);
    text = digest.buildDigest({ now: new Date() });
    assert.doesNotMatch(text, /没有等你的事/);
    assert.match(text, /接入/);
  });

  test('对外地址配了才写最后一行，且不会是 localhost', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('public_url', ?)`).run('https://wb.example.com');
    const text = digest.buildDigest({ now: new Date(), titles: false });
    assert.match(text, /打开工作台处理：https:\/\/wb\.example\.com/);
  });
});

describe('019 · 不与 012 通道混在一起', () => {
  test('拉 Issue 只问 wb-task 标签，日报 Issue 不会变成任务', async () => {
    digest.saveDigestSettings({ on: true, at: '08:00' });
    await sendDigest({ manual: true });
    assert.ok(state.issues.length, 'digest issue exists');

    seen.length = 0;
    await relayIssues(['me/ai-workbench'], { request, call: (_method, _path, data) => {
      if (data.kind === 'issues') return github.importIssues(data.repo, data.items);
      github.recordGithubSync(data.error);
    } });
    const pull = seen.find((s) => s.method === 'GET' && s.path.includes('/issues?'));
    assert.ok(pull, 'sync should pull issues');
    assert.match(pull!.path, /labels=wb-task/);
    const count = db.prepare(`SELECT COUNT(*) n FROM tasks`).get() as { n: number };
    assert.equal(count.n, 0);
  });
});

describe('019 · 权限', () => {
  test('改设置和「现在发一条」只能用网页 Cookie', async () => {
    const viaToken = await post('/api/digest', { on: true, at: '09:00' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(viaToken.status, 403);
    const sendViaToken = await post('/api/digest/send', {}, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(sendViaToken.status, 403);

    const viaCookie = await post('/api/digest', { on: true, repo: 'me/ai-workbench', at: '09:00' }, { Cookie: cookie });
    assert.equal(viaCookie.status, 200);
    assert.equal((await viaCookie.json() as any).on, true);

    const sendViaCookie = await post('/api/digest/send', {}, { Cookie: cookie });
    assert.equal(sendViaCookie.status, 200);
    assert.equal((await sendViaCookie.json() as any).queued, true);
    assert.equal(state.comments.length, 0);
    await flushDigest();
    assert.equal(state.comments.length, 1);
    const audit = db.prepare(`SELECT COUNT(*) n FROM events WHERE kind IN ('digest.sent','digest.settings')`).get() as { n: number };
    assert.ok(audit.n >= 2);
  });

  test('Bearer 能读设置（只读）', async () => {
    const res = await fetch(base + '/api/digest', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.on, false);
    assert.equal(body.at, '08:00');
  });
});
