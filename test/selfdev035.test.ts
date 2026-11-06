// 035：工作台自己开发自己。决策端在 queue.json 排队 → 工作台建任务 → 执行器做 → 推送后部署审批。
// 这里测四段：排队文件的解析与去重、任务说明模板、部署触发条件与部署步骤、结果回 Issue。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { githubClient, relayOutbox, relayQueue } from '../scripts/lib/github-relay.mjs';

process.env.WB_DB = ':memory:';
process.env.WB_TOKEN = 'test-token-selfdev035-0123';
process.env.WB_PASSWORD = 'test-password-0123456789';

let gh: Server;
let ghBase = '';
let queueText = '';
let ghDown = false;
let posted: { path: string; body: any }[] = [];

before(async () => {
  gh = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/repos/me/workbench/contents/docs/specs/queue.json') {
      // 035.3.1：模拟执行器拉取失败。
      if (ghDown) return send(500, { message: 'boom' });
      return send(200, { encoding: 'base64', content: Buffer.from(queueText, 'utf8').toString('base64') });
    }
    if (req.method === 'GET' && url.pathname === '/repos/me/workbench/issues') {
      return send(200, [{ number: 7, body: '' }]);
    }
    if (req.method === 'POST' && url.pathname === '/repos/me/workbench/issues/7/comments') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        posted.push({ path: url.pathname, body: JSON.parse(raw || '{}') });
        send(201, { id: 1 });
      });
      return;
    }
    send(404, { message: 'not found' });
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
  const addr = gh.address();
  ghBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.GITHUB_REPOS = 'me/workbench';
  process.env.WB_SELF_REPO = 'me/workbench';
  process.env.WB_SELF_PROJECT = 'ai-workbench';
});
after(() => gh.close());

const request = (...args: [string, string, unknown?]) => githubClient({ githubToken: 'gh-test-token' }, { base: ghBase })(...args);
const selfdev = async () => {
  const m = await import('../src/services/selfdev.ts');
  return { ...m, syncQueue: async () => {
    const { heartbeat } = await import('../src/services/runner.ts');
    heartbeat('selfdev-test', {});
    return relayQueue('me/workbench', { request, call: (_method, _path, p) => m.importQueue(p.repo, p.text ?? '', p.error) });
  } };
};
const database = () => import('../src/db.ts');

const item = (id: string, status = 'ready') => ({ id, spec: `docs/specs/${id}-x.md`, title: `第 ${id} 张`, status });

describe('035 排队文件', () => {
  test('只取第一个 ready；hold 跳过', async () => {
    const { parseQueue, pickNext } = await selfdev();
    const { items, problem } = parseQueue(JSON.stringify({ items: [item('empty', 'hold'), item('001'), item('002')] }));
    assert.equal(problem, '');
    const next = pickNext(items, () => false);
    assert.equal(next?.id, '001');
  });

  test('已经建过任务的那项不再取，接着取下一个', async () => {
    const { parseQueue, pickNext } = await selfdev();
    const { items } = parseQueue(JSON.stringify({ items: [item('001'), item('002')] }));
    assert.equal(pickNext(items, (id) => id === '001')?.id, '002');
  });

  test('格式不对：一句人话，不猜', async () => {
    const { parseQueue } = await selfdev();
    assert.match(parseQueue('{ 不是 json').problem, /不是合法的 JSON/);
    assert.match(parseQueue('{"items":{}}').problem, /没有 items 数组/);
    assert.match(parseQueue(JSON.stringify({ items: [{ id: '1', spec: '../etc/passwd', status: 'ready' }] })).problem, /spec/);
    assert.match(parseQueue(JSON.stringify({ items: [{ id: '1', spec: 'docs/specs/a.md', status: 'doing' }] })).problem, /status/);
  });

  test('任务说明按模板来，带需求单路径', async () => {
    const { taskDescription } = await selfdev();
    const text = taskDescription({ id: '035', spec: 'docs/specs/035-self-hosting.md', title: 't', status: 'ready' });
    assert.match(text, /按需求单 docs\/specs\/035-self-hosting\.md 实现/);
    assert.match(text, /npm test 必须全绿/);
    assert.match(text, /不要改 queue\.json/);
    assert.match(text, /## 回报（执行器，T-<n>）/);
  });
});

describe('035 读队列建任务', () => {
  test('两个 ready 只建第一个，再读一次不会重复建', async () => {
    const { syncQueue } = await selfdev();
    const { db } = await database();
    const id = `A${Math.floor(Math.random() * 1e6)}`;
    const id2 = `${id}b`;
    queueText = JSON.stringify({ items: [item(id), item(id2)] });
    const before = (db().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

    const first = await syncQueue();
    assert.equal(first.created, 1, first.problem);
    assert.equal(first.item?.id, id);
    const after1 = (db().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    assert.equal(after1, before + 1);

    const second = await syncQueue();
    assert.equal(second.created, 0, '同一项建了两次');
    const after2 = (db().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    assert.equal(after2, after1);

    const t = db().prepare('SELECT title, description, project, status, mode FROM tasks ORDER BY id DESC LIMIT 1').get() as any;
    assert.match(t.title, new RegExp(`^${id} `));
    assert.match(t.description, new RegExp(`docs/specs/${id}-x\\.md`));
    assert.equal(t.project, 'ai-workbench');
    assert.equal(t.status, 'queued', '建完要等用户点开始，不能自动跑');
    assert.equal(t.mode, 'manual');
  });

  test('格式坏掉：不建任务，并且给一句人话', async () => {
    const { syncQueue, selfdevState } = await selfdev();
    const { db } = await database();
    queueText = '{ 坏掉的';
    const before = (db().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    const r = await syncQueue();
    assert.equal(r.created, 0);
    assert.match(r.problem, /不是合法的 JSON/);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, before);
    assert.match(selfdevState().lastError, /queue\.json/);
  });
});

// 035.3.1（审查建议修）：读队列失败也要落状态，而且同一个错误只记一条审计。
// 原来网络失败直接 return，状态表停在「上次成功」，接入页就一直是绿的；
// saveState 又是先写后读，「旧值」永远等于新值，selfdev.problem 事件一条都写不出来。
describe('035.3.1 读队列失败的状态', () => {
  beforeEach(async () => {
    ghDown = false;
    const { db } = await database();
    // 清掉上一组留下的任务：syncQueue 一次只让一个在途，否则成功路径也被挡住。
    db().exec('DELETE FROM selfdev_queue');
    db().exec('DELETE FROM tasks');
    db().exec('DELETE FROM selfdev_state');
    db().exec("DELETE FROM events WHERE kind = 'selfdev.problem'");
  });

  const problemEvents = async () => {
    const { db } = await database();
    return (db().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'selfdev.problem'").get() as { n: number }).n;
  };

  test('先成功、再网络失败：绿色要立刻灭掉，并写明读不到', async () => {
    const { syncQueue, selfdevState } = await selfdev();
    queueText = JSON.stringify({ items: [item(`F${Math.floor(Math.random() * 1e6)}`)] });
    const ok = await syncQueue();
    assert.equal(ok.created, 1, ok.problem);
    assert.equal(selfdevState().lastError, '');

    ghDown = true;
    const bad = await syncQueue();
    assert.equal(bad.created, 0);
    assert.match(bad.problem, /读不到/);
    const st = selfdevState();
    assert.match(st.lastError, /读不到/);
    assert.equal(st.ok, false, '这一刻读不到队列，不能还亮着「上次成功」');
    assert.equal(await problemEvents(), 1, '第一次失败要留一条审计');
  });

  test('同一个错误连着几次：审计只记一条', async () => {
    const { syncQueue } = await selfdev();
    ghDown = true;
    await syncQueue();
    await syncQueue();
    await syncQueue();
    assert.equal(await problemEvents(), 1, '每 5 分钟一条同样的记要，等于把事件流刷成噪声');
  });

  test('恢复之后错误清掉；再坏一次又是一条新的', async () => {
    const { syncQueue, selfdevState } = await selfdev();
    ghDown = true;
    await syncQueue();
    ghDown = false;
    queueText = JSON.stringify({ items: [item(`R${Math.floor(Math.random() * 1e6)}`)] });
    const back = await syncQueue();
    assert.equal(back.created, 1, back.problem);
    assert.equal(selfdevState().lastError, '');
    assert.equal(selfdevState().ok, true, '恢复之后要重新是绿的');

    ghDown = true;
    await syncQueue();
    assert.equal(await problemEvents(), 2, '错误变了（从没有到有）要重新记一条');
  });
});

describe('035 部署触发条件', () => {
  test('动了 src/ 要部署，只动 docs/ 不用', async () => {
    const { needsDeploy, deployDirs } = await import('../scripts/lib/deploy.mjs');
    assert.equal(needsDeploy(['src/app.ts', 'docs/x.md']), true);
    assert.equal(needsDeploy(['docs/x.md', 'README.md']), false);
    assert.equal(needsDeploy(['scripts/runner.mjs']), true);
    assert.equal(needsDeploy(['docker-compose.yml']), true);
    assert.equal(needsDeploy(['public/style.css']), true);
    assert.equal(needsDeploy(['package-lock.json']), false);
    assert.deepEqual(deployDirs(['src/a.ts', 'src/b.ts', 'docs/c.md']), ['src/']);
  });
});

describe('035 部署步骤', () => {
  const fakeCall = (status: string, calls: any[]) => async (_cfg: any, method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (path === '/api/approvals') return { id: 9 };
    if (path === '/api/approvals/9') return { status };
    return {};
  };

  test('批准后重建、健康检查通过、交接后退出', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    let exited: number | null = null;
    let handed = false;
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1, deployHealthWaitMs: 50, deployHealthEveryMs: 5 },
      task: { id: 3 }, project: '/tmp', files: ['src/app.ts'],
      io: {
        api: fakeCall('approved', calls),
        sleep: async () => {},
        log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        probe: async () => true,
        handoff: () => { handed = true; return { ok: true, pid: 111 }; },
        exit: (c: number) => { exited = c; },
      },
    });
    const created = calls.find((c) => c.path === '/api/approvals');
    assert.ok(created, '没有建部署审批');
    assert.match(created.body.title, /部署/);
    assert.match(created.body.summary, /src\//);
    assert.equal(created.body.tool_name, 'docker compose');
    assert.equal(handed, true, '要先起接班助手，再退出');
    // 035.3：退出之前必须让工作台记下「等着换新执行器」，否则页面只会显示「执行器掉线」。
    const report = calls.find((c) => c.path === '/api/runner/handoff');
    assert.ok(report, '没有登记「等待新执行器接班」');
    assert.equal(report.body.pid, process.pid);
    assert.match(report.body.code_hash, /^[0-9a-f]{8}$/);
    const step = calls.filter((c) => c.method === 'PATCH').pop();
    assert.match(step.body.step, /换成新执行器/, '任务页要看得出这是正常交接');
    assert.equal(exited, 0, '交接助手起来之后这个进程才退出');
  });

  test('接班助手起不来：不退出，任务页写明要手动重启', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    let exited = false;
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1, deployHealthWaitMs: 50, deployHealthEveryMs: 5 },
      task: { id: 31 }, project: '/tmp', files: ['src/app.ts'],
      io: {
        api: fakeCall('approved', calls), sleep: async () => {}, log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        probe: async () => true,
        handoff: () => ({ ok: false, why: '起接班助手失败：spawn EPERM' }),
        exit: () => { exited = true; },
      },
    });
    // 容器已经是新的了，这不算部署失败；但执行器还活着，代码没换，人得知道。
    assert.equal(exited, false, '助手没起来就退出，等于把自己关在门外');
    const step = calls.filter((c) => c.method === 'PATCH').pop();
    assert.match(step.body.step, /手动/, '要写明还得手动重启一次');
    assert.equal(step.body.status, 'done', '这不是部署失败，但也不能留在「运行中」——容器已经是新的了');
  });

  test('健康检查一直不应答：标部署失败，原因是人话，不退出', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    let exited = false;
    let probes = 0;
    let restarted = false;
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1, deployHealthWaitMs: 20, deployHealthEveryMs: 5 },
      task: { id: 4 }, project: '/tmp', files: ['src/app.ts'],
      io: {
        api: fakeCall('approved', calls),
        sleep: async () => {},
        log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        // 第一次是部署前的「这个地址现在应答吗」，让它过；之后才是重建后的健康检查。
        probe: async () => { probes += 1; return probes === 1; },
        handoff: () => { restarted = true; return { ok: true, pid: 111 }; },
        exit: () => { exited = true; },
      },
    });
    assert.ok(probes > 1, '重建之后得真去探测过（这条正是「配置项读错、一次没探测」的守卫）');
    assert.equal(restarted, false, '健康检查没通过就不该换进程');
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patch.body.status, 'failed');
    assert.match(patch.body.step, /部署失败/);
    assert.match(patch.body.step, /health/);
    assert.equal(exited, false);
  });

  // 035.3.3：部署之后这个进程就退出了，跑完这一步的人已经不在了，没人会给任务写结局。
  // 所以交接登记里要带上任务 id，让工作台在新执行器接班（或 5 分钟没人接班）时收尾。
  test('交接退出：任务 id 跟着交接一起交出去', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1, deployHealthWaitMs: 50, deployHealthEveryMs: 5 },
      task: { id: 91 }, project: '/tmp', files: ['src/app.ts'],
      io: {
        api: fakeCall('approved', calls), sleep: async () => {}, log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        probe: async () => true,
        handoff: () => ({ ok: true, pid: 111 }),
        exit: () => {},
      },
    });
    const report = calls.find((c) => c.path === '/api/runner/handoff');
    assert.equal(report.body.task_id, 91, '不带任务 id，工作台就不知道该给谁结账');
    const step = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(step.body.status, undefined, '交接记上了就交给服务端收尾，别在这里抢着写');
  });

  test('交接没记上：这一条自己结掉，不留「运行中」', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    const api = async (_cfg: any, method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (path === '/api/runner/handoff') throw new Error('502');
      if (path === '/api/approvals') return { id: 9 };
      if (path === '/api/approvals/9') return { status: 'approved' };
      return {};
    };
    let exited = false;
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1, deployHealthWaitMs: 50, deployHealthEveryMs: 5 },
      task: { id: 92 }, project: '/tmp', files: ['src/app.ts'],
      io: {
        api, sleep: async () => {}, log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        probe: async () => true,
        handoff: () => ({ ok: true, pid: 111 }),
        exit: () => { exited = true; },
      },
    });
    const step = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(step.body.status, 'done', '交接没记上，服务端不会来收尾，只能自己结');
    assert.equal(exited, true, '容器已经换新了，该退还是得退');
  });

  // 035.3.3：等审批超时原来只写一句 step，任务照样挂在「运行中」。
  test('等部署审批超时：代码已推送，任务结掉', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 0 },
      task: { id: 93 }, project: '/tmp', files: ['src/a.ts'],
      io: { api: fakeCall('pending', calls), sleep: async () => {}, log: () => {}, exit: () => {} },
    });
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.match(patch.body.step, /超时/);
    assert.equal(patch.body.status, 'done', '超时不是失败，但也不能一直挂在「运行中」');
  });

  test('容器没起来：退出码写进原因', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1 },
      task: { id: 5 }, project: '/tmp', files: ['Dockerfile'],
      io: {
        api: fakeCall('approved', calls),
        sleep: async () => {},
        log: () => {},
        run: () => ({ status: 1, stdout: '', stderr: 'no such service: workbench' }),
        probe: async () => true,
        handoff: () => ({ ok: true, pid: 111 }),
        exit: () => {},
      },
    });
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patch.body.status, 'failed');
    assert.match(patch.body.step, /容器没起来/);
  });

  test('部署被驳回：代码已经推上去了，容器还是旧的', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:9', pushWaitMinutes: 1 },
      task: { id: 6 }, project: '/tmp', files: ['src/a.ts'],
      io: { api: fakeCall('rejected', calls), sleep: async () => {}, log: () => {}, exit: () => {} },
    });
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.match(patch.body.step, /部署没批/);
    // 035.3.3：驳回不算失败（代码已经推上去了），但也得结掉。建部署审批会把任务从
    // 「已完成」翻成「等审批」、批完再翻成「运行中」；驳回时没人再改它，任务就永远挂着，
    // 队列「一次只允许一个在途」于是再也不建新单——T-33 就是这样把自举链堵死的。
    assert.equal(patch.body.status, 'done', '驳回之后任务要结掉，不能一直挂在「运行中」');
  });

  // 035.3：原来读的是 cfg.baseUrl（配置里根本没有这个键），base 永远是空串，再撞上
  // 「没配就按成功算」，等于一次健康检查都没发过。下面两条钉住「查不了 ≠ 成功，且不许动容器」。
  test('配置里没有 workbench 地址：不动容器，直接标部署失败', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    let ranDocker = false;
    let restarted = false;
    let exited = false;
    await deployStep({
      cfg: { workbench: '', pushWaitMinutes: 1 },
      task: { id: 7 }, project: '/tmp', files: ['src/a.ts'],
      io: {
        api: fakeCall('approved', calls), sleep: async () => {}, log: () => {},
        run: () => { ranDocker = true; return { status: 0, stdout: '', stderr: '' }; },
        probe: async () => true,
        handoff: () => { restarted = true; return { ok: true, pid: 111 }; },
        exit: () => { exited = true; },
      },
    });
    assert.equal(ranDocker, false, '连地址都没有就不该去重建容器');
    assert.equal(restarted, false, '部署没成不能换进程');
    assert.equal(exited, false, '部署没成不能退出执行器');
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patch.body.status, 'failed');
    assert.match(patch.body.step, /workbench/);
    assert.match(patch.body.fail_reason, /没动容器/);
  });

  test('workbench 不是 http 地址：同样不动容器', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    let ranDocker = false;
    await deployStep({
      cfg: { workbench: 'localhost:3200', pushWaitMinutes: 1 },
      task: { id: 8 }, project: '/tmp', files: ['package.json'],
      io: {
        api: fakeCall('approved', calls), sleep: async () => {}, log: () => {},
        run: () => { ranDocker = true; return { status: 0, stdout: '', stderr: '' }; },
        probe: async () => true,
        handoff: () => ({ ok: true, pid: 111 }),
        exit: () => {},
      },
    });
    assert.equal(ranDocker, false);
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patch.body.status, 'failed');
    assert.match(patch.body.step, /http/);
  });

  // 035.3.2：地址格式合法但根本连不上（端口写错就是这样）——以前会先重建容器，
  // 两分钟后再宣布「查不到」，容器已经动过。现在必须一个容器都不动。
  test('workbench 是合法 http 但连不上：跑 docker 之前就失败', async () => {
    const { deployStep } = await import('../scripts/runner.mjs');
    const calls: any[] = [];
    let ranDocker = false;
    let restarted = false;
    let exited = false;
    await deployStep({
      cfg: { workbench: 'http://127.0.0.1:1', pushWaitMinutes: 1 },
      task: { id: 81 }, project: '/tmp', files: ['src/a.ts'],
      io: {
        api: fakeCall('approved', calls), sleep: async () => {}, log: () => {},
        run: () => { ranDocker = true; return { status: 0, stdout: '', stderr: '' }; },
        probe: async () => false,
        handoff: () => { restarted = true; return { ok: true, pid: 111 }; },
        exit: () => { exited = true; },
      },
    });
    assert.equal(ranDocker, false, '地址连不上就不该去重建容器');
    assert.equal(restarted, false);
    assert.equal(exited, false);
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patch.body.status, 'failed');
    assert.match(patch.body.step, /没动容器/);
    assert.match(patch.body.fail_reason, /127\.0\.0\.1:1/, '要把读到的地址写出来，人才知道错在哪');
  });
});

describe('035 结果回 Issue', () => {
  test('写到 wb-selfdev Issue：已打码、≤1500 字、每个任务一次', async () => {
    const { reportToIssue, recordSelfdevDelivery } = await selfdev();
    const { claimGithubJob, finishGithubJob } = await import('../src/services/github-outbox.ts');
    posted = [];
    const fakeKey = ['sk', 'abcdef1234567890abcdef'].join('-');
    const secret = `Authorization: Bearer ${fakeKey}`;
    const long = `${secret}\n${'很长的结果。'.repeat(400)}`;
    const task = {
      id: 901, title: '改了文案', project: 'ai-workbench',
      result_text: long, merged_commit: 'abc1234',
    };
    assert.equal(await reportToIssue(task), true);
    assert.equal(posted.length, 0, '工作台只排队');
    await relayOutbox({ request, call: (method, path, data) => {
      if (method === 'GET') return { job: claimGithubJob() };
      return finishGithubJob(Number(path.split('/').at(-1)), data, recordSelfdevDelivery);
    } });
    assert.equal(posted.length, 1);
    const body = String(posted[0].body.body ?? '');
    assert.ok(body.length <= 1600, `评论太长了：${body.length}`);
    assert.ok(!body.includes(fakeKey), '令牌没打码');
    assert.match(body, /T-901/);
    assert.match(body, /abc1234/);

    // 第二次不再重复写
    assert.equal(await reportToIssue(task), false);
    assert.equal(posted.length, 1);
  });

  test('别的项目的任务不往这个 Issue 里写', async () => {
    const { reportToIssue } = await selfdev();
    posted = [];
    assert.equal(await reportToIssue({ id: 902, title: 'x', project: 'demo-first', result_text: 'y' }), false);
    assert.equal(posted.length, 0);
  });
});
