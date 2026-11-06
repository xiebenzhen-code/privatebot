// 045.1 / 045.2 / 045.3：每日审查在第一版运行与账号槽里挑出的三处——
//   045.1 每次运行的用量要记「这一次自己的累计」，重试不能互相盖掉或减成 0，短任务也要有数；
//   045.2 运行表（和它的 API、备份）里不能留着没打码的原文；
//   045.3 一个槽用满不能把同执行者其他还能用的槽一起挡住。
// 反例照审查给的时间线写，不把假数据改成实现喜欢的口径。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0451-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0451-0123456789';
process.env.WB_TZ = 'Asia/Shanghai';

let app: Server;
let base = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
let runner: typeof import('../src/services/runner.ts');
let metrics: typeof import('../src/services/metrics.ts');
let dispatch: typeof import('../src/services/dispatch.ts');
let brain: typeof import('../src/services/brain.ts');

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts');
  runner = await import('../src/services/runner.ts');
  metrics = await import('../src/services/metrics.ts');
  dispatch = await import('../src/services/dispatch.ts');
  brain = await import('../src/services/brain.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => { app.close(); });
beforeEach(() => { D.useDb(D.openDb(':memory:')); });

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init, redirect: 'manual',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

function queued(executor = 'pool'): number {
  const t = tasks.createTask({ title: '045.x 测试单', project: 'ai-workbench', category: 'dev', executor, status: 'queued' }, 'me');
  tasks.updateTask(t.id, { start_requested: 1 }, 'me');
  return t.id;
}
const claim = (executor = 'pool') => api(`/api/runner/next?executors=${executor}&runner=runner-a`);
const progress = (id: number, body: Record<string, unknown>) => api(`/api/runner/tasks/${id}/progress`, { method: 'POST', body: JSON.stringify(body) });
async function finish(id: number, body: Record<string, unknown>) {
  const r = await api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200, r.text);
  return tasks.getTask(id)!;
}
const slot = (name: string, dir: string, extra: Record<string, unknown> = {}) =>
  runs.createSlot({ name, executor: 'claude', slot_dir: dir, ...extra });

describe('045.1 · 每次运行的用量', () => {
  test('审查的反例：第 1 次报 100 后失败，重试第 2 次只报 70 就完成 → [100, 70]，不是 [100, 0]', async () => {
    const id = queued();
    assert.equal((await claim()).json.id, id);
    await progress(id, { step: '跑着', tokens_used: 100 });
    await finish(id, { result: 'failed', summary: '挂了' });
    tasks.updateTask(id, { status: 'queued', start_requested: 1 }, 'me');
    assert.equal((await claim()).json.id, id);
    await progress(id, { step: '又跑着', tokens_used: 70 });
    await finish(id, { result: 'done', no_changes: true, summary: '好', result_text: '好了' });
    assert.deepEqual(runs.listRuns(id).map((r) => r.tokens), [100, 70]);
  });

  test('短任务不到一个上报周期就结束：收尾带上最终用量，运行和任务上都有', async () => {
    const id = queued();
    await claim();
    await finish(id, { result: 'failed', summary: '很快就挂了', tokens_used: 17 });
    assert.equal(runs.listRuns(id)[0].tokens, 17);
    assert.equal(tasks.getTask(id)!.tokens_used, 17);
  });

  test('收尾的最终值盖过中途的进度值；老执行器不带 tokens_used 就保留最后一次进度', async () => {
    const a = queued();
    await claim();
    await progress(a, { tokens_used: 40 });
    await finish(a, { result: 'failed', summary: 'x', tokens_used: 55 });
    assert.equal(runs.listRuns(a)[0].tokens, 55);

    const b = queued();
    await claim();
    await progress(b, { tokens_used: 40 });
    await finish(b, { result: 'failed', summary: 'x' });
    assert.equal(runs.listRuns(b)[0].tokens, 40);
  });

  test('到上限换槽：这一次的用量记在「到上限」那条上，下一次从自己的数起', async () => {
    slot('claude-a', 'claude-a', { slot_priority: 1 });
    slot('claude-b', 'claude-b', { slot_priority: 2 });
    const id = queued('claude');
    await claim('claude');
    await progress(id, { tokens_used: 30 });
    await finish(id, { result: 'limited', slot: 'claude-a', tokens_used: 45, limit: { kind: 'session', resetAt: new Date(Date.now() + 3600_000).toISOString() } });
    await claim('claude');
    await progress(id, { tokens_used: 12 });
    await finish(id, { result: 'failed', summary: 'x', slot: 'claude-b', tokens_used: 20 });
    assert.deepEqual(runs.listRuns(id).map((r) => [r.outcome, r.tokens]), [['limited', 45], ['failed', 20]]);
  });

  test('没有进行中的运行时报进度：不会写到别的运行上', async () => {
    const id = queued();
    await claim();
    await finish(id, { result: 'failed', summary: 'x', tokens_used: 9 });
    runs.setRunTokens(id, 999);
    assert.equal(runs.listRuns(id)[0].tokens, 9);
  });
});

describe('045.2 · 运行表不留原文', () => {
  const fakeBearer = 'Authorization: Bearer test-token-not-real-0000';

  test('失败原因：任务、运行记录、运行接口、审计都拿不到假凭据', async () => {
    const id = queued();
    await claim();
    await finish(id, { result: 'failed', summary: `curl 挂了：${fakeBearer}`, tokens_used: 1 });
    const t = tasks.getTask(id)!;
    assert.doesNotMatch(t.fail_reason ?? '', /abc123def456/);
    const list = (await api(`/api/tasks/${id}/runs`)).json;
    assert.doesNotMatch(list[0].reason, /abc123def456/);
    assert.match(list[0].reason, /curl 挂了/, '打码不是整句丢掉');
    const dump = JSON.stringify(D.db().prepare('SELECT * FROM runs').all()) + JSON.stringify(D.db().prepare('SELECT * FROM events').all())
      + JSON.stringify(D.db().prepare('SELECT * FROM task_log').all());
    assert.doesNotMatch(dump, /abc123def456/);
  });

  test('路径：用户目录、令牌样的串都打掉，多处都打', async () => {
    const id = queued();
    await claim();
    const fakeKey = ['sk', 'test-token-not-real-0000'].join('-');
    await finish(id, { result: 'failed', summary: `读 C:\\Users\\you\\.ssh\\id_rsa 失败，key ${fakeKey} 和 /home/you/.config/x` });
    const reason = runs.listRuns(id)[0].reason ?? '';
    assert.ok(!reason.includes(fakeKey));
    assert.doesNotMatch(reason, /Users\\you/i);
  });

  test('到上限但没有真槽，退化成失败时：limit.raw 里的假凭据也不进运行记录', async () => {
    const id = queued();
    await claim();
    await finish(id, { result: 'limited', slot: 'nope', limit: { kind: 'session', raw: `hit your limit ${fakeBearer}` } });
    assert.doesNotMatch(runs.listRuns(id)[0].reason ?? '', /abc123def456/);
    assert.doesNotMatch(tasks.getTask(id)!.fail_reason ?? '', /abc123def456/);
  });

  test('closeRun 自己也打码（别的调用方传原文进来也一样）', () => {
    const id = queued();
    runs.openRun(id, 'pool', '');
    runs.closeRun(id, 'failed', { reason: `直接传：${fakeBearer}` });
    assert.doesNotMatch(runs.listRuns(id)[0].reason ?? '', /abc123def456/);
  });

  test('已经污染的旧值：scrubRuns 补打码，幂等，写一条审计', () => {
    const id = queued();
    runs.openRun(id, 'pool', '');
    runs.closeRun(id, 'failed', { reason: '干净的原因' });
    D.db().prepare('UPDATE runs SET reason = ? WHERE task_id = ?').run(`旧版本写进来的：${fakeBearer}`, id);
    assert.equal(runs.scrubRuns(), 1);
    assert.doesNotMatch(runs.listRuns(id)[0].reason ?? '', /abc123def456/);
    assert.equal(runs.scrubRuns(), 0, '第二次没有可改的');
    assert.ok((D.db().prepare("SELECT COUNT(*) n FROM events WHERE kind = 'runs.scrubbed'").get() as { n: number }).n === 1);
  });
});

describe('045.3 · 一个槽满了不挡别的槽', () => {
  const fullWindow = (name: string, pct: number) => D.db().prepare('UPDATE accounts SET window_pct = ? WHERE name = ?').run(pct, name);

  test('审查的反例：a 窗口 100%、b 窗口 5% 且可用 → 照常领取，且 b 排在前面', async () => {
    slot('claude-a', 'claude-a');
    slot('claude-b', 'claude-b');
    fullWindow('claude-a', 100);
    fullWindow('claude-b', 5);
    const id = queued('claude');
    const r = await claim('claude');
    assert.equal(r.json?.id, id, '以前这里是 204');
    assert.deepEqual(r.json.slots.map((s: any) => s.name), ['claude-b', 'claude-a']);
    assert.equal(runner.queueBlocker(tasks.getTask(id)!), null);
  });

  test('a 到上限（limited）、b 满窗口但没被标限额：b 仍可领，不被 a 的上限拖住', async () => {
    slot('claude-a', 'claude-a');
    slot('claude-b', 'claude-b');
    runs.markSlotLimited('claude-a', new Date(Date.now() + 3600_000).toISOString());
    fullWindow('claude-b', 95);
    const id = queued('claude');
    assert.equal((await claim('claude')).json?.id, id);
  });

  test('a 停用、b 到期：没有能用的槽，排队并说清没有可用的槽', async () => {
    slot('claude-a', 'claude-a', { slot_enabled: 0 });
    slot('claude-b', 'claude-b', { expires_at: new Date(Date.now() - 1000).toISOString() });
    const id = queued('claude');
    assert.equal((await claim('claude')).status, 204);
    assert.match(tasks.getTask(id)!.step, /没有可用的账号槽/);
    assert.equal(runner.queueBlocker(tasks.getTask(id)!)?.code, 'slots');
  });

  test('全都到上限：排队，写最早的重置时间', async () => {
    slot('claude-a', 'claude-a');
    slot('claude-b', 'claude-b');
    const early = new Date(Date.now() + 1800_000).toISOString();
    runs.markSlotLimited('claude-a', new Date(Date.now() + 7200_000).toISOString());
    runs.markSlotLimited('claude-b', early);
    const id = queued('claude');
    assert.equal((await claim('claude')).status, 204);
    assert.match(tasks.getTask(id)!.step, /在等 .* 重置/);
    assert.ok(tasks.getTask(id)!.step.includes(new Date(early).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })), tasks.getTask(id)!.step);
  });

  test('执行者整体的额度（不是槽）照旧拦：网关账号窗口 95% → 不领', async () => {
    metrics.upsertAccount('gateway', { executor: 'pool', via: 'proxy', window_pct: 95, kind: 'window' });
    const id = queued();
    assert.equal((await claim()).status, 204);
    assert.equal(dispatch.quotaBlock('pool')?.code, 'quota');
    assert.ok(tasks.getTask(id));
  });

  test('槽满不算执行者额度；没有槽数据的执行者“读不到不等于没有”照旧', () => {
    slot('claude-a', 'claude-a');
    fullWindow('claude-a', 100);
    assert.equal(dispatch.quotaBlock('claude'), null);
    assert.equal(dispatch.quotaBlock('codex'), null);
  });

  test('给大脑看的额度说明：说几个槽能用，不并进 100%', () => {
    slot('claude-a', 'claude-a');
    slot('claude-b', 'claude-b');
    fullWindow('claude-a', 100);
    runs.markSlotLimited('claude-a', new Date(Date.now() + 3600_000).toISOString());
    assert.equal(dispatch.quotaLine('claude'), '账号槽 1/2 个可用');
  });

  test('大脑的合格名单：槽都不能用的执行者被排除并说明；有一个能用就留着', () => {
    const q0 = brain.qualified('dev');
    const first = q0.candidates.find((c) => runs.SLOT_EXECUTORS.has(c.executor));
    assert.ok(first, '默认设置里至少有一个能开槽的候选');
    const ex = first.executor;
    runs.createSlot({ name: `${ex}-a`, executor: ex, slot_dir: `${ex}-a` });
    runs.createSlot({ name: `${ex}-b`, executor: ex, slot_dir: `${ex}-b` });
    runs.markSlotLimited(`${ex}-a`, new Date(Date.now() + 3600_000).toISOString());
    assert.ok(brain.qualified('dev').candidates.some((c) => c.executor === ex), 'b 还能用');
    runs.markSlotLimited(`${ex}-b`, new Date(Date.now() + 3600_000).toISOString());
    const q = brain.qualified('dev');
    assert.ok(!q.candidates.some((c) => c.executor === ex));
    assert.match(q.excluded.find((e) => e.executor === ex)?.why ?? '', /重置/);
  });
});

describe('045 · 改槽目录也要查重', () => {
  test('把 b 的目录改成 a 的：409，不改', () => {
    slot('claude-a', 'claude-a');
    slot('claude-b', 'claude-b');
    assert.throws(() => runs.updateSlot('claude-b', { slot_dir: 'claude-a' }), /已经有一个槽用目录/);
    assert.equal(runs.listSlots().find((s) => s.name === 'claude-b')!.slot_dir, 'claude-b');
    assert.doesNotThrow(() => runs.updateSlot('claude-b', { slot_dir: 'claude-b' }), '改成自己原来的不算重复');
  });
});

describe('049.2 · 谁能开账号槽', () => {
  test('名单只有 claude、workbuddy；dsh 和反代池都不在内', () => {
    assert.deepEqual([...runs.SLOT_EXECUTORS].sort(), ['claude', 'workbuddy']);
  });

  test('新建槽：不在名单里的执行者 400「这个执行者不用账号槽」，一条也不落库', () => {
    for (const executor of ['pool', 'dsh', 'codex', 'local']) {
      assert.throws(
        () => runs.createSlot({ name: `s-${executor}`, executor, slot_dir: `s-${executor}` }),
        (e: any) => e.status === 400 && e.message === '这个执行者不用账号槽',
        executor,
      );
    }
    assert.equal(runs.listSlots().length, 0);
  });

  test('网页接口也拦：浏览器会话 POST 反代池 → 400，没落库', async () => {
    const cookie = await loginCookie(base, process.env.WB_PASSWORD!);
    const res = await fetch(`${base}/api/slots`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pool-x', executor: 'pool', slot_dir: 'pool-x' }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /这个执行者不用账号槽/);
    assert.equal(runs.listSlots().length, 0);
  });

  test('老库里已经有的反代池槽：改它也是 400，不动数据', () => {
    // 旧版本能通过接口建出来；这里直接塞一条，模拟老数据。
    D.db().prepare(`INSERT INTO accounts (name, executor, via, source, kind, slot_dir, label, slot_enabled, slot_priority, updated_at)
      VALUES ('legacy-pool', 'pool', 'slot', 'slot', 'window', 'legacy-pool', '', 1, 50, ?)`)
      .run(new Date().toISOString());
    assert.throws(
      () => runs.updateSlot('legacy-pool', { slot_enabled: 0 }),
      (e: any) => e.status === 400 && e.message === '这个执行者不用账号槽',
    );
    const row = D.db().prepare("SELECT slot_enabled FROM accounts WHERE name = 'legacy-pool'").get() as { slot_enabled: number };
    assert.equal(row.slot_enabled, 1);
  });

  test('claude / workbuddy 照常能开', () => {
    assert.equal(runs.createSlot({ name: 'claude-x', executor: 'claude', slot_dir: 'claude-x' }).state, 'ok');
    assert.equal(runs.createSlot({ name: 'wb-x', executor: 'workbuddy', slot_dir: 'wb-x' }).state, 'ok');
  });
});
