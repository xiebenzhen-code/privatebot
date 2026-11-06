// 042：调度大脑。
//
// 这一单最容易做错的地方是「谁说了算」：大脑是**推荐**，不是决定。所以测试分三层：
//   1. 规则算的合格名单（停用、分类、额度、只读）一条都不能被越过；
//   2. 大脑的回话（包括坏 JSON、名单外的人、超时）都退回规则，而且每次都要留一条审计；
//   3. 你改过的选择就不再算大脑派的；额度不够时，大脑派的任务换人、你手选的只写原因。
//
// 模型永远用假的：这单的测试一分钱都不该花。真模型只在验收（真机）时用一次。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-042-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let D: any;
let brain: any;
let runner: any;
let events: (opts: { limit?: number; task_id?: number }) => { kind: string; text: string; actor: string }[];
let claimTask: (executors: string[], runnerId: string) => any;

before(async () => {
  D = await import('../src/db.ts');
  D.useDb(D.openDb(':memory:'));
  const { handle } = await import('../src/app.ts');
  brain = await import('../src/services/brain.ts');
  runner = await import('../scripts/runner.mjs');
  ({ listEvents: events } = await import('../src/services/core.ts'));
  ({ claimTask } = await import('../src/services/runner.ts'));
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

type Res = { status: number; json: any; text: string };

/** 读接口用令牌；写接口默认也用令牌，`human` 才走网页会话（有几个操作只允许人做）。 */
async function api(path: string, init: RequestInit & { human?: boolean } = {}): Promise<Res> {
  const { human, ...rest } = init;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (human) headers.Cookie = cookie;
  else headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${base}${path}`, { ...rest, headers: { ...headers, ...(rest.headers as object) }, redirect: 'manual' });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const post = (path: string, body: unknown, human = false) =>
  api(path, { method: 'POST', body: JSON.stringify(body), human });

/** 打开大脑：这是每个用例自己要说的事，不靠默认值。 */
const brainOn = (cap = 50) => post('/api/settings/dispatch-brain', { on: true, cap }, true);

async function execSetting(executor: string, patch: Record<string, unknown>): Promise<void> {
  const all = (await api('/api/executors')).json as any[];
  const cur = all.find((x) => x.executor === executor) ?? { executor, priority: 99, categories: '', auto_allowed: 0, enabled: 1 };
  // 一次一条，和剧组页的「改设置」表单同一个形状：请求体是对象，里层会包成 { records } 的那种数组不收。
  const r = await api('/api/executors', { method: 'PUT', body: JSON.stringify({ ...cur, executor, ...patch }), human: true });
  assert.equal(r.status, 200, r.text);
}

const account = (name: string, executor: string, fields: Record<string, unknown>) =>
  api(`/api/accounts/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ executor, ...fields }) });

async function newBrainTask(title: string, description = '', category = 'dev') {
  const r = await post('/api/tasks', { executor: '__brain', title, description, category, project: 'demo' });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

const getTask = async (id: number) => (await api(`/api/tasks/${id}`)).json;

/** 假执行器：真工作台 + 假模型。`reply` 可以是字符串、抛错，或者返回 {text,...}。 */
function fakeRunner(reply: string | Error | (() => any), opts: { capture?: any[] } = {}) {
  const capture = opts.capture;
  return {
    target: { baseUrl: 'http://127.0.0.1:9', token: 'fake', model: 'bl-fake' },
    api: async (_cfg: any, method: string, path: string, body: unknown) => {
      const r = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 160)}`);
      return r.json;
    },
    call: async (_target: any, messages: any) => {
      if (capture) capture.push(messages);
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply();
      return { text: reply, model: 'bl-fake', in_tokens: 11, out_tokens: 7 };
    },
  };
}

describe('042 A · 合格名单是硬约束', () => {
  test('停用、不接这分类、窗口用完、余额到提醒线、只派单、只读——都进不来', async () => {
    await execSetting('codex', { enabled: false });
    await execSetting('pool', { categories: ['content'] });
    // dsh 默认不在 executor_settings 里，用之前先登记：它只读，但确实能接活。
    await execSetting('dsh', { categories: ['dev'], enabled: 1, claimable: 1, auto_allowed: 1 });
    await account('claude-main', 'claude', { kind: 'window', window_pct: 95 });
    await account('wb-wallet', 'workbuddy', { kind: 'balance', balance: 3, balance_unit: '元', low_threshold: 10 });

    const q = brain.qualified('dev');
    const keys = q.candidates.map((c: any) => c.executor);
    assert.deepEqual(keys.sort(), ['autoclaw', 'dsh', 'local'], '只剩这三个够格');

    const why = (k: string) => q.excluded.find((e: any) => e.executor === k)?.why ?? '';
    assert.match(why('codex'), /停用/);
    assert.match(why('pool'), /不接/);
    assert.match(why('claude'), /窗口已用 95%/);
    assert.match(why('workbuddy'), /已到提醒线/);
    assert.match(why('zcode'), /只派单/, 'zcode 要在应用里手动贴，不该占名额');

    // 只读执行者：写任务拒，只读任务放
    assert.match(brain.candidateProblem(q, 'dsh', false), /只读/);
    assert.equal(brain.candidateProblem(q, 'dsh', true), '');
    // 名单外的人
    assert.match(brain.candidateProblem(q, 'zcode', true), /不在合格名单/);
  });

  test('名额按分类算：内容类任务看不见只接开发的执行者', async () => {
    await execSetting('local', { categories: ['dev', 'ops'] });
    await execSetting('dsh', { categories: ['dev'], enabled: 1, claimable: 1 });
    const q = brain.qualified('content');
    const keys = q.candidates.map((c: any) => c.executor);
    assert.ok(keys.includes('pool'), '内容类反代池接');
    assert.ok(!keys.includes('local'));
    assert.ok(!keys.includes('dsh'));
    assert.equal(q.candidates.find((c: any) => c.executor === 'pool').read_only_only, false);
  });

  test('自动执行暂停时名单是空的——大脑没有活派', async () => {
    await brainOn();
    await post('/api/dispatch/auto-paused', { paused: true }, true);
    const q = brain.qualified('dev');
    assert.equal(q.paused, true);
    assert.deepEqual(q.candidates, []);
    const view = brain.pendingRoutes();
    assert.equal(view.items.length, 0);
    assert.match(view.notes[0], /暂停/);
  });
});

describe('042 C · 执行器回话，工作台再校验一遍', () => {
  test('派单成功：执行者、难度、理由落库，状态回排队，审计写 system', async () => {
    await brainOn();
    const t = await newBrainTask('给任务页加一个筛选', '在任务列表上按执行者筛选');
    assert.equal(t.executor, 'me');
    assert.equal(t.status, 'inbox');
    assert.equal(t.route, 'brain');

    const r = await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 3, reason: '改代码，Codex 稳', read_only: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.executor, 'codex');
    assert.equal(r.json.status, 'queued');
    assert.equal(r.json.difficulty, 3);
    assert.equal(r.json.route_reason, '改代码，Codex 稳');
    assert.ok(r.json.routed_at);
    assert.match(r.json.step, /难度 3\/5/);

    const ev = events({ task_id: t.id, limit: 20 });
    const route = ev.find((e) => e.kind === 'dispatch.route')!;
    assert.ok(route, '要有 dispatch.route 这条审计');
    assert.equal(route.actor, 'system');
    assert.match(route.text, /Codex/);
  });

  test('名单外的执行者：直接 POST 返回 400，但任务已经按规则派好了', async () => {
    await brainOn();
    const t = await newBrainTask('写一段发布说明', '整理成文档', 'content');
    const r = await post(`/api/tasks/${t.id}/route`, { executor: 'zcode', difficulty: 1, reason: '便宜', read_only: false });
    assert.equal(r.status, 400, '调用方要知道自己错了');
    assert.match(r.json.error, /不在合格名单/);
    const after = await getTask(t.id);
    assert.notEqual(after.executor, 'me', '不能留在收件箱干等');
    assert.equal(after.status, 'queued');
    assert.equal(after.routed_at !== null, true);
    const kinds = events({ task_id: t.id, limit: 20 }).map((e) => e.kind);
    assert.ok(kinds.includes('dispatch.route_rejected'));
    assert.equal(kinds.includes('dispatch.route'), false, '没通过就不能写成派成功');
  });

  test('只读执行者接了要改文件的任务：400，并换人', async () => {
    await brainOn();
    await execSetting('dsh', { categories: ['dev'], enabled: 1, claimable: 1 });
    const t = await newBrainTask('修一个拼写', '改 src 里的一处拼写');
    const r = await post(`/api/tasks/${t.id}/route`, { executor: 'dsh', difficulty: 1, reason: '只读也能看', read_only: false });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /只读/);
    assert.notEqual((await getTask(t.id)).executor, 'dsh');
  });

  test('只读任务可以派给只读执行者', async () => {
    await brainOn();
    await execSetting('dsh', { categories: ['dev'], enabled: 1, claimable: 1 });
    const t = await newBrainTask('读一遍 README 说说项目是干什么的', '只读，不改任何文件');
    const r = await post(`/api/tasks/${t.id}/route`, { executor: 'dsh', difficulty: 1, reason: '只读任务，最便宜的够了', read_only: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.executor, 'dsh');
  });

  test('回坏 JSON、模型超时、没回话：都退回规则，各留一条审计', async () => {
    await brainOn();

    const t1 = await newBrainTask('坏 JSON 的任务', '说明');
    assert.equal(await runner.routeRound({ workbench: base, token: TOKEN }, fakeRunner('我觉得应该派给 codex')), 1);
    const after1 = await getTask(t1.id);
    assert.notEqual(after1.executor, 'me');
    assert.equal(after1.status, 'queued');
    assert.ok(events({ task_id: t1.id, limit: 20 }).some((e) => e.kind === 'dispatch.route_failed'));

    const t2 = await newBrainTask('模型超时的任务', '说明');
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    assert.equal(await runner.routeRound({ workbench: base, token: TOKEN }, fakeRunner(timeout)), 1);
    const after2 = await getTask(t2.id);
    assert.notEqual(after2.executor, 'me');
    assert.ok(events({ task_id: t2.id, limit: 20 }).some((e) => e.kind === 'dispatch.route_failed'));
  });

  test('没有可用模型：这一轮的每个任务都立刻退回规则，不等超时', async () => {
    await brainOn();
    // 三个待派任务，同一轮拿走
    const tasks = [
      await newBrainTask('没有模型也要回话 甲', '说明'),
      await newBrainTask('没有模型也要回话 乙', '说明'),
      await newBrainTask('没有模型也要回话 丙', '说明'),
    ];
    // 配置里既没有 brain，也没有带地址和令牌的后端 → brainTarget 返回 null
    assert.equal(await runner.routeRound({ workbench: base, token: TOKEN }), 3, '三个都处理');

    for (const t of tasks) {
      const after = await getTask(t.id);
      assert.notEqual(after.executor, 'me', `T-${t.id} 不能还挂着等超时`);
      assert.equal(after.status, 'queued');
      assert.match(String(after.route_reason), /执行器没有可用的模型密钥/);
      assert.ok(
        events({ task_id: t.id, limit: 20 }).some((e) => e.kind === 'dispatch.route_failed'),
        `T-${t.id} 要留一条退回规则的审计`,
      );
    }
  });

  test('解析回话：解释文字、代码块、缺字段都不吃，也不 eval', () => {
    const ok = runner.parseBrainReply('好的，我选这个：\n```json\n{"executor":"pool","difficulty":9,"reason":"便宜","read_only":true}\n```');
    assert.equal(ok.ok, true);
    assert.equal(ok.value.executor, 'pool');
    assert.equal(ok.value.difficulty, 5, '难度超界就夹到 1–5');
    assert.equal(ok.value.read_only, true);
    assert.equal(runner.parseBrainReply('没有 JSON').ok, false);
    assert.equal(runner.parseBrainReply('{"executor":"pool"').ok, false);
    assert.equal(runner.parseBrainReply('{"difficulty":2}').ok, false, '没有 executor 不算答案');
  });
});

describe('042 D · 每天 50 次与一次一单', () => {
  test('次数用完：接口说清楚，等派的任务立刻改走规则', async () => {
    await brainOn(1);
    const a = await newBrainTask('第一个', '说明');
    const b = await newBrainTask('第二个', '说明');

    const first = await api('/api/route/pending');
    assert.equal(first.json.items.length, 1);
    assert.equal(first.json.remaining, 0);
    assert.equal(first.json.items[0].id, a.id, '按创建时间先来先问');

    const second = await api('/api/route/pending');
    assert.equal(second.json.items.length, 0, '今天不再调用');
    assert.match(second.json.notes[0], /用完/);
    const moved = await getTask(b.id);
    assert.notEqual(moved.executor, 'me', '不能干等');
    assert.equal(moved.status, 'queued');
    assert.ok(events({ task_id: b.id, limit: 20 }).some((e) => e.kind === 'dispatch.brain_cap'));
  });

  test('同一个任务只问一次：交出去之后不会再出现', async () => {
    await brainOn();
    const t = await newBrainTask('只问一次', '说明');
    const first = await api('/api/route/pending');
    assert.equal(first.json.items.length, 1);
    const again = await api('/api/route/pending');
    assert.equal(again.json.items.length, 0);
    assert.equal(again.json.items.some((x: any) => x.id === t.id), false);
  });

  test('交出去十分钟没回话：当作失败，按规则派掉，不留悬案', async () => {
    await brainOn();
    const t = await newBrainTask('没人回话', '说明');
    await api('/api/route/pending');
    // 把这次交出时间推到 11 分钟前
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const { db } = await import('../src/db.ts');
    db().prepare('UPDATE brain_calls SET at = ? WHERE task_id = ?').run(old, t.id);
    brain.sweepStale();
    const after = await getTask(t.id);
    assert.notEqual(after.executor, 'me');
    assert.ok(events({ task_id: t.id, limit: 20 }).some((e) => e.kind === 'dispatch.route_stale'));
  });
});

describe('042 A · 额度不够时换不换人', () => {
  test('你亲手选的：不换人，只把原因写到排队原因里', async () => {
    await execSetting('codex', { auto_allowed: 1, enabled: 1, claimable: 1 });
    const t = (await post('/api/tasks', { executor: 'codex', title: '手选的任务', category: 'dev', project: 'demo', mode: 'auto' })).json;
    await account('codex-main', 'codex', { kind: 'window', window_pct: 95 });
    const claimed = claimTask(['codex'], 'r-042');
    assert.equal(claimed, null, '额度不够就不该领走');
    const after = await getTask(t.id);
    assert.equal(after.executor, 'codex', '你选的就是你选的，不擅自改');
    assert.match(after.step, /窗口已用 95%/);
  });

  test('大脑派的：额度不够就换名单里的下一个', async () => {
    await brainOn();
    await execSetting('codex', { auto_allowed: 1, enabled: 1, claimable: 1 });
    const t = await newBrainTask('大脑派的任务', '说明');
    await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 2, reason: '改代码', read_only: false });
    await account('codex-main', 'codex', { kind: 'window', window_pct: 92 });

    const claimed = claimTask(['codex'], 'r-042');
    assert.equal(claimed, null);
    const after = await getTask(t.id);
    assert.notEqual(after.executor, 'codex', '换人');
    assert.ok(brain.qualified('dev').candidates.some((c: any) => c.executor === after.executor), '换的必须是合格名单里的');
    assert.equal(after.route, 'brain', '仍然是大脑派的那条命');
    assert.ok(events({ task_id: t.id, limit: 20 }).some((e) => e.kind === 'dispatch.switch'));
  });

  test('点「开始」时也查一次：手选的只写原因', async () => {
    await execSetting('codex', { auto_allowed: 0, enabled: 1, claimable: 1 });
    const t = (await post('/api/tasks', { executor: 'codex', title: '手选，点开始', category: 'dev', project: 'demo', mode: 'manual' })).json;
    await account('codex-main', 'codex', { kind: 'window', window_pct: 93 });
    const r = await post(`/api/tasks/${t.id}/start`, {}, true);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.executor, 'codex');
    assert.match(r.json.step, /窗口已用 93%/);
    assert.equal(r.json.start_requested, 1, '等你换额度，不是把你的意图丢掉');
  });
});

describe('042 E · 看得见，改得了', () => {
  test('改执行者：route 清空、难度留着，审计里有一条「你改了」', async () => {
    await brainOn();
    const t = await newBrainTask('先让大脑派', '说明');
    await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 4, reason: '要改好几处', read_only: false });
    const r = await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ executor: 'claude' }), human: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.executor, 'claude');
    assert.equal(r.json.route, '', '改过就不再算大脑派的');
    assert.equal(r.json.route_reason, null);
    assert.equal(r.json.routed_at, null);
    assert.equal(r.json.difficulty, 4, '难度是这活的属性，留着');
    assert.ok(events({ task_id: t.id, limit: 20 }).some((e) => e.kind === 'task.route_cleared'));
  });

  test('只改标题不算改派：route 还在', async () => {
    await brainOn();
    const t = await newBrainTask('原标题', '说明');
    await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 2, reason: '改代码', read_only: false });
    const r = await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ executor: 'codex', title: '新标题' }), human: true });
    assert.equal(r.json.route, 'brain');
  });

  test('任务卡和详情上写着「大脑：派给谁 · 难度 · 理由」', async () => {
    await brainOn();
    const t = await newBrainTask('卡上要看得见', '说明');
    await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 3, reason: '改代码，它稳', read_only: false });
    const page = (await api(`/tasks?task=${t.id}`, { human: true })).text;
    assert.match(page, /data-brain/);
    assert.match(page, /难度 3\/5/);
    assert.match(page, /改代码，它稳/);
    const board = (await api('/tasks', { human: true })).text;
    assert.match(board, /card-brain/);
  });

  test('战绩按派单方式分开：大脑派的和你手选的各算各的', async () => {
    await brainOn();
    // 两单都算给 codex：一单大脑派的一次过，一单手选的失败了。
    const a = await newBrainTask('大脑派的，成了', '说明');
    await post(`/api/tasks/${a.id}/route`, { executor: 'codex', difficulty: 2, reason: '改代码', read_only: false });
    await api(`/api/tasks/${a.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'running' }), human: true });
    await api(`/api/tasks/${a.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }), human: true });
    const b = (await post('/api/tasks', { executor: 'codex', title: '手选的，砸了', category: 'dev', project: 'demo' })).json;
    await api(`/api/tasks/${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'running' }), human: true });
    await api(`/api/tasks/${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed' }), human: true });

    const card = (await api('/api/scorecard?days=30')).json;
    const brainRow = card.by_route.find((r: any) => r.executor === 'codex' && r.route === 'brain');
    const handRow = card.by_route.find((r: any) => r.executor === 'codex' && r.route === 'hand');
    assert.equal(brainRow.n, 1);
    assert.equal(brainRow.first_pass_rate, 1);
    assert.equal(handRow.n, 1);
    assert.equal(handRow.first_pass_rate, 0);
  });
});

describe('042 F · 开关关着，一切照旧', () => {
  test('接口不派、表单没有「让大脑选」、接口拒收 __brain', async () => {
    const view = await api('/api/route/pending');
    assert.equal(view.json.enabled, false);
    assert.deepEqual(view.json.items, []);

    const page = (await api('/tasks?new=1', { human: true })).text;
    assert.equal(/让大脑选/.test(page), false);

    const r = await post('/api/tasks', { executor: '__brain', title: '不该建成', category: 'dev' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /关着/);
  });

  test('打开开关，表单第一项就是它', async () => {
    await brainOn();
    const page = (await api('/tasks?new=1', { human: true })).text;
    const select = page.slice(page.indexOf('<select name="executor">'), page.indexOf('<select name="executor">') + 400);
    assert.match(select, /让大脑选/);
    assert.ok(select.indexOf('让大脑选') < select.indexOf('Claude'), '得是执行者下拉里的第一项');
  });
});

describe('042 C.2 · 发给模型的东西', () => {
  test('脱敏：说明里的 Bearer 令牌不会发出去；备忘只给确认过的', async () => {
    await brainOn();
    await api('/api/notes', { method: 'POST', body: JSON.stringify({ project: 'demo', text: '这个项目用 npm test 跑测试' }), human: true });
    const note = ((await api('/api/notes?project=demo', { human: true })).json as any[]).find((n) => n.text.includes('npm test'));
    await post(`/api/notes/${note.id}/confirm`, {}, true);

    const fakeKey = ['sk', 'live', 'abcdef123456'].join('-');
    const t = await newBrainTask(
      '带密钥的任务',
      `复现的时候用 Authorization: Bearer ${fakeKey} 这个头，别写进代码。`,
    );

    const capture: any[] = [];
    await runner.routeRound({ workbench: base, token: TOKEN }, fakeRunner('{"executor":"codex","difficulty":2,"reason":"改代码","read_only":false}', { capture }));
    assert.equal(capture.length, 1, '应该只问了一次');
    const user = capture[0].user as string;
    assert.equal(user.includes(fakeKey), false, '令牌不能出现在发给模型的正文里');
    assert.match(user, /Bearer/);
    assert.match(user, /npm test/, '确认过的备忘要带上');
    assert.match(user, /候选（只能从这里选）/);
    assert.match(user, /codex/);
    assert.ok((await getTask(t.id)).routed_at, '真派成了');
  });

  test('提示词有上限：说明写成一万字，也不会把候选挤掉', async () => {
    await brainOn();
    await newBrainTask('超长说明', '很长'.repeat(5000));
    const capture: any[] = [];
    await runner.routeRound({ workbench: base, token: TOKEN }, fakeRunner('{"executor":"codex","difficulty":2,"reason":"改代码","read_only":false}', { capture }));
    const user = capture[0].user as string;
    assert.ok(user.length <= brain.MAX_PROMPT_CHARS + 200, `实际 ${user.length}`);
    assert.match(user, /候选（只能从这里选）/);
    assert.match(user, /- codex/);
  });
});

// 042.4：输入脱敏了，输出也得脱。模型（或它背后的代理）完全可能在理由里顺手带出
// 令牌、带用户名的路径、账号邮箱。这些字会进 route_reason、审计、页面，卡在写入口最省事。
describe('042.4 模型回来的理由同样脱敏', () => {
  test('理由里的 Bearer 令牌不进 route_reason，也不进审计', async () => {
    await brainOn();
    const t = await newBrainTask('给任务页加一个筛选', '在任务列表上按执行者筛选');
    const r = await post(`/api/tasks/${t.id}/route`, {
      executor: 'codex',
      difficulty: 3,
      reason: '按上次的 Key Authorization: Bearer abcdef123456 试过就行',
      read_only: false,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.route_reason.includes('abcdef123456'), false, '令牌不能原样落库');
    assert.match(r.json.route_reason, /Authorization/);
    assert.match(r.json.route_reason, /\*\*\*/);

    const texts = events({ task_id: t.id, limit: 20 }).map((e) => e.text).join('\n');
    assert.equal(texts.includes('abcdef123456'), false, '审计里也不能有');
  });

  test('退回规则的原因（坏 JSON 原话）也要脱敏', async () => {
    await brainOn();
    const t = await newBrainTask('写一段发布说明', '整理成文档', 'docs');
    // 假模型回一段完全不是 JSON 的话，里面夹着路径与令牌——这正是「为什么退回」会进审计的原文。
    const fakeKey = ['sk', 'abcdef123456'].join('-');
    await runner.routeRound(
      { workbench: base, token: TOKEN },
      fakeRunner(`C://Users//you//secret.txt 里的 token=${fakeKey} 我没看懂题目`),
    );
    const after = await getTask(t.id);
    assert.equal(String(after.route_reason).includes(fakeKey), false, '失败原因里的令牌不能落库');
    const texts = events({ task_id: t.id, limit: 20 }).map((e) => e.text).join('\n');
    assert.equal(texts.includes(fakeKey), false, '审计同样不能有');
    assert.equal(texts.includes('Users//you'), false, '带用户名的路径也要打掉');
  });
});

// 042.2：只读不是「模型说了算」，是「这个执行者到底能不能改文件」。
// 以前只有 routeTask 那一处校验，回退、额度改派都直接取名单第一位——写任务能被一路塞给 dsh。
describe('042.2 回退与改派也守能力约束', () => {
  /** 只留 codex（能写）和 dsh（只读）两个人可选，其余全停用。 */
  async function onlyCodexAndDsh() {
    await execSetting('dsh', { categories: ['dev'], enabled: 1, claimable: 1, auto_allowed: 1 });
    await execSetting('codex', { categories: ['dev'], enabled: 1, claimable: 1 });
    for (const k of ['claude', 'pool', 'local', 'workbuddy', 'autoclaw']) await execSetting(k, { enabled: false });
  }

  test('写任务回退：不会拿只读的 dsh 顶上，宁可等你定', async () => {
    await brainOn();
    await onlyCodexAndDsh();
    const t = await newBrainTask('给任务页加筛选', '要改代码');
    const routed = await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 3, reason: '改代码', read_only: false });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(routed.json.route_read_only, 0);

    // 连着 codex 也不可用了（额度/离线），名单里只剩只读的 dsh——这时只能等你定。
    await execSetting('codex', { enabled: false });
    const after = brain.fallbackRoute(await getTask(t.id), '模型超时了');
    assert.notEqual(after.executor, 'dsh', '写任务不能退回给只读执行者');
    assert.equal(after.executor, 'me', '没有能改文件的人，就留给人定');
  });

  test('只读任务回退：还是只给只读的执行者', async () => {
    await brainOn();
    await onlyCodexAndDsh();
    const t = await newBrainTask('读一遍 README 说说项目', '只读，不要改');
    const routed = await post(`/api/tasks/${t.id}/route`, { executor: 'dsh', difficulty: 1, reason: '只读', read_only: true });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(routed.json.route_read_only, 1);
    assert.equal(routed.json.executor, 'dsh');

    const after = brain.fallbackRoute(await getTask(t.id), '模型超时了');
    assert.equal(after.executor, 'dsh', '只读的活还可以给只读的人');
  });

  test('额度改派：没有第二个能写的人就不换，写清原因等人处理', async () => {
    await brainOn();
    await onlyCodexAndDsh();
    const t = await newBrainTask('给任务页加筛选', '要改代码');
    await post(`/api/tasks/${t.id}/route`, { executor: 'codex', difficulty: 3, reason: '改代码', read_only: false });
    const task = await getTask(t.id);

    const moved = brain.rerouteForQuota(task, 'Codex 窗口已用 95%');
    assert.equal(moved, null, '不能改派给只读的 dsh');
    const after = await getTask(t.id);
    assert.equal(after.executor, 'codex', '执行者不动，等额度或等你换人');
    assert.match(after.step, /95%/);
  });

  test('workbuddy 默认按只读算（037 的审批钩子还没验通），写任务选不进来', async () => {
    await brainOn();
    await execSetting('workbuddy', { categories: ['dev'], enabled: 1, claimable: 1 });
    const q = brain.qualified('dev');
    const wb = q.candidates.find((c: any) => c.executor === 'workbuddy');
    assert.ok(wb, '它还能接只读的活');
    assert.equal(wb.read_only_only, true, '名字后面得挂「只读」');
    assert.match(brain.candidateProblem(q, 'workbuddy', false), /只读/);
    assert.equal(brain.candidateProblem(q, 'workbuddy', true), '', '只读任务可以给它');
  });

  test('你改了执行者，只读约束跟着大脑的派单一起清掉', async () => {
    await brainOn();
    await execSetting('dsh', { categories: ['dev'], enabled: 1, claimable: 1 });
    const t = await newBrainTask('读一遍 README', '只读');
    await post(`/api/tasks/${t.id}/route`, { executor: 'dsh', difficulty: 1, reason: '只读', read_only: true });
    assert.equal((await getTask(t.id)).route_read_only, 1);
    await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ executor: 'codex' }) });
    const after = await getTask(t.id);
    assert.equal(after.route, '', 'route 清空');
    assert.equal(after.route_read_only, null, '只读约束也一起清掉，之后按你的意思来');
  });
});

// 042.3：模型一开口就花过钱了。以前只有「派单成功」才上报用量，坏 JSON / 名单外 400 这两条路
// 费用已经发生、账上是零，等于自己糊弄自己。
describe('042.3 失败也要记已知用量', () => {
  const brainRows = () => D.db().prepare("SELECT input_tokens, output_tokens, model, executor FROM usage WHERE model LIKE 'brain:%'").all() as any[];

  test('坏 JSON：派单没成，用量照记（12 进 / 5 出）', async () => {
    await brainOn();
    const t = await newBrainTask('给任务页加筛选', '要改代码');
    await runner.routeRound(
      { workbench: base, token: TOKEN },
      fakeRunner(() => ({ text: '这不是 JSON，我只是随便说说', model: 'bl-fake', in_tokens: 12, out_tokens: 5 })),
    );
    const rows = brainRows();
    assert.equal(rows.length, 1, '应该记了一笔');
    assert.equal(rows[0].input_tokens, 12);
    assert.equal(rows[0].output_tokens, 5);
    assert.match(rows[0].model, /^brain:/);
    assert.equal(rows[0].executor, 'me', '记在调度自己名下，不占执行者额度');
    assert.equal((await getTask(t.id)).route_reason !== null, true, '这单还是被退回规则了');
  });

  test('名单外的人：工作台回 400，用量也照记', async () => {
    await brainOn();
    await newBrainTask('给任务页加筛选', '要改代码');
    // 停掉 codex 之外的所有能写的人，再让假模型选 codex 以外的人 → 400。
    await execSetting('codex', { enabled: false });
    await runner.routeRound(
      { workbench: base, token: TOKEN },
      fakeRunner(() => ({ text: '{"executor":"local","difficulty":2,"reason":"随便","read_only":false}', model: 'bl-fake', in_tokens: 30, out_tokens: 9 })),
    );
    const rows = brainRows();
    assert.equal(rows.length, 1, '400 也是花过钱的一次调用');
    assert.equal(rows[0].input_tokens, 30);
  });

  test('调度用量不算进任何执行者的额度', async () => {
    await brainOn();
    await newBrainTask('给任务页加筛选', '要改代码');
    await runner.routeRound(
      { workbench: base, token: TOKEN },
      fakeRunner(() => ({ text: '乱码', model: 'bl-fake', in_tokens: 500, out_tokens: 500 })),
    );
    const metrics = await import('../src/services/metrics.ts');
    const used = metrics.tokensByExecutorSince('2000-01-01');
    assert.equal(used.me ?? 0, 0, 'me 的额度不该被调度用量吃掉');
    assert.ok(metrics.brainTokens(7) >= 1000, '但数据页那一句里看得见');
  });
});

describe('042-H4 · 余额贴线就不派', () => {
  test('余额恰好等于提醒线：也算没余量，不进名单', async () => {
    await execSetting('workbuddy', { enabled: 1, claimable: 1, categories: ['dev'], auto_allowed: 1 });
    await account('wb-wallet', 'workbuddy', { kind: 'balance', balance: 10, balance_unit: '元', low_threshold: 10 });
    const why = brain.qualified('dev').excluded.map((e: any) => `${e.executor}:${e.why}`).join(' | ');
    assert.match(why, /workbuddy:.*已到提醒线/, `等于线也要拦，实际：${why}`);
  });

  test('比线多一分钱：还能派', async () => {
    await execSetting('workbuddy', { enabled: 1, claimable: 1, categories: ['dev'], auto_allowed: 1 });
    await account('wb-wallet', 'workbuddy', { kind: 'balance', balance: 10.01, balance_unit: '元', low_threshold: 10 });
    const why = brain.qualified('dev').excluded.map((e: any) => `${e.executor}:${e.why}`).join(' | ');
    assert.ok(!why.includes('workbuddy:'), `高于线就该留下，实际：${why}`);
  });
});

describe('042-C3b · 备忘沿用 031c 的挑法', () => {
  test('和任务相关的那条，排在最新 5 条之外也要带上', async () => {
    await brainOn();
    const t = await newBrainTask('给任务页加筛选', '按分类筛');
    // 相关那条最早确认，后面再压 5 条无关的：按「最新 5 条」挑会把它挤掉。
    await post('/api/notes', { project: 'demo', text: '任务页的筛选走 URL 参数，不要自己存前端状态' }, true);
    for (let i = 1; i <= 5; i++) {
      await post('/api/notes', { project: 'demo', text: `发布相关的第 ${i} 条备忘：只在收工之后动线上` }, true);
    }
    const p = brain.promptFor(await getTask(t.id), brain.qualified('dev'));
    assert.match(p.user, /URL 参数/, '相关的那条必须在提示里');
  });

  test('一条都不相关时只取最近 3 条，不是 5 条', async () => {
    await brainOn();
    const t = await newBrainTask('把按钮改大一点', '纯视觉');
    for (let i = 1; i <= 6; i++) {
      await post('/api/notes', { project: 'demo', text: `数据库备份落在凌晨，第 ${i} 号脚本，跑完看日志` }, true);
    }
    const p = brain.promptFor(await getTask(t.id), brain.qualified('dev'));
    const got = (p.user.match(/^- 数据库备份落在凌晨/gm) ?? []).length;
    assert.equal(got, 3, `实际带了 ${got} 条`);
  });
});
