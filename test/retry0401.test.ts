// 040.1：任务卡上的「重试」得看失败发生在哪一步。
//
// 卡片以前把所有 failed 都接到 /restart，而 /restart 会把 retry 清成 null、整段编码重跑一遍。
// 合并或推送失败的任务其实已经有成果了，重跑等于白烧一遍 token，也违背 025 的分阶段重试。
// 这组用例只走真实 HTTP：建一个「合并失败 / 推送失败 / 运行失败」的任务，看卡片给的是哪个动作，
// 再真的调一次，确认 retry 没被清掉、阶段没被倒回编码。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-0401-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0401-0123456789';

let app: Server;
let base = '';
let cookie = '';
let dbmod: typeof import('../src/db.ts');

before(async () => {
  dbmod = await import('../src/db.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  dbmod.useDb(dbmod.openDb(':memory:'));
});

after(() => { app.close(); });

beforeEach(async () => {
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

/** 造一个「停在某一阶段失败」的任务：真的落库，不是拼 HTML。 */
async function failedTask(patch: Record<string, unknown> = {}) {
  // 建单接口不认 retry / branch（那是执行器写回来的），所以先建出来再按执行器的方式更新一次。
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `T-${Math.random().toString(16).slice(2, 8)}`,
      project: 'ai-workbench',
      category: 'dev',
      executor: 'codex',
      status: 'running',
    }),
  });
  assert.equal(created.status, 201, created.text);
  const patched = await api(`/api/tasks/${created.json.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'failed', fail_reason: '这一步没成', ...patch }),
  });
  assert.equal(patched.status, 200, patched.text);
  return patched.json;
}

/** 卡片上那个动作按钮指向哪、写着什么。按 `data-card="task"` 切块，比正则配整卡可靠。 */
function cardAction(html: string, id: number): { url: string; label: string } | null {
  const chunk = html.split('data-card="task"').find((c) => c.startsWith(` data-task="${id}"`));
  if (!chunk) return null;
  const scope = chunk.slice(0, 2500);
  const btn = scope.match(/<button[^>]*data-api-click="([^"]+)"[^>]*>([^<]+)<\/button>/);
  if (btn) return { url: btn[1], label: btn[2].trim() };
  const link = scope.match(/<a class="btn small" href="([^"]+)">([^<]+)<\/a>/);
  return link ? { url: link[1], label: link[2].trim() } : null;
}

describe('040.1 卡片重试按失败阶段继续', () => {
  test('推送失败：卡片给「重试推送」，不是重新开始', async () => {
    const t = await failedTask({ retry: 'push', branch: 'wb/T-901', merged_commit: 'abc1234' });
    const page = (await api('/tasks')).text;
    const act = cardAction(page, t.id);
    assert.ok(act, '卡片上得有动作按钮');
    assert.equal(act!.url, `/api/tasks/${t.id}/retry-push`);
    assert.match(act!.label, /重试推送/);
  });

  test('合并失败：卡片给「重试合并」', async () => {
    const t = await failedTask({ retry: 'merge', branch: 'wb/T-902' });
    const page = (await api('/tasks')).text;
    const act = cardAction(page, t.id);
    assert.equal(act!.url, `/api/tasks/${t.id}/retry-merge`);
    assert.match(act!.label, /重试合并/);
  });

  test('执行阶段失败（没配项目路径）不留 retry=merge，卡片给「重试」', async () => {
    // 复刻 T-15：早先合并失败过一次（retry=merge、有分支），后来又领了一次，
    // 这次连项目检查都没过，执行器回报「没有配置项目路径」。
    const t = await failedTask({ retry: 'merge', branch: 'wb/T-906' });
    const fin = await api(`/api/runner/tasks/${t.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({
        result: 'failed',
        summary: '没有配置项目路径：执行器的 projects 里没有「」这个名字。',
      }),
    });
    assert.equal(fin.status, 200, fin.text);
    const after = await api(`/api/tasks/${t.id}`);
    assert.equal(after.json.status, 'failed');
    assert.equal(after.json.retry, null, '没走到合并的失败不能留下「可重试的合并」');
    const act = cardAction((await api('/tasks')).text, t.id);
    assert.ok(act, '卡片上得有动作按钮');
    assert.equal(act!.url, `/api/tasks/${t.id}/restart`);
    assert.match(act!.label, /^重试$/);
  });

  test('迁移洗掉老数据里的 retry=merge（T-15 那种行），真正的合并失败不动', async () => {
    // 用真实旧库：停在这次新增的迁移之前，造两条 043 之前的行，再按正常启动流程打开它。
    const file = join(mkdtempSync(join(tmpdir(), 'wb-mig-')), 'old.db');
    const old = new DatabaseSync(file);
    // 045 起后面又追加了迁移：按「哪一条洗 retry」定位，别再用 length - 1（db.ts 的 versionAfter 说明）。
    const before = dbmod.versionAfter('UPDATE tasks SET retry = NULL') - 1;
    for (const m of dbmod.MIGRATIONS.slice(0, before)) old.exec(m);
    old.exec(`PRAGMA user_version = ${before}`);
    const ts = new Date().toISOString();
    const ins = old.prepare(`INSERT INTO tasks (title, status, retry, branch, project, executor, fail_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('阅读项目 README', 'failed', 'merge', 'wb/T-15', '', 'pool', '没有配置项目路径：执行器的 projects 里没有「」这个名字。', ts, ts);
    ins.run('合并冲突', 'failed', 'merge', 'wb/T-16', 'ai-workbench', 'pool', '合并失败：本地有冲突，修好后点「重试合并」', ts, ts);
    old.close();

    dbmod.useDb(dbmod.openDb(file)); // 打开就会把剩下那条迁移跑完
    try {
      // 换了库，之前的会话不在这个库里，重新登一次。
      cookie = await loginCookie(base, process.env.WB_PASSWORD!);
      const list = (await api('/api/tasks')).json as { id: number; title: string; retry: string | null }[];
      const stale = list.find((t) => t.title === '阅读项目 README')!;
      const real = list.find((t) => t.title === '合并冲突')!;
      assert.equal(stale.retry, null, '执行阶段失败的老数据要清成空');
      assert.equal(real.retry, 'merge', '真正的合并失败不该被误伤');
      const page = (await api('/tasks')).text;
      assert.equal(cardAction(page, stale.id)!.url, `/api/tasks/${stale.id}/restart`);
      assert.match(cardAction(page, stale.id)!.label, /^重试$/);
      assert.equal(cardAction(page, real.id)!.url, `/api/tasks/${real.id}/retry-merge`);
      assert.match(cardAction(page, real.id)!.label, /重试合并/);
    } finally {
      dbmod.useDb(dbmod.openDb(':memory:'));
    }
  });

  test('运行阶段失败：还是完整重跑', async () => {
    const t = await failedTask({ retry: null });
    const page = (await api('/tasks')).text;
    const act = cardAction(page, t.id);
    assert.equal(act!.url, `/api/tasks/${t.id}/restart`);
  });

  test('合并失败但没分支：退回完整重跑（没有东西可合）', async () => {
    const t = await failedTask({ retry: 'merge', branch: '' });
    const page = (await api('/tasks')).text;
    assert.equal(cardAction(page, t.id)!.url, `/api/tasks/${t.id}/restart`);
  });

  test('点卡片上的重试推送：retry 还是 push，阶段没倒回编码', async () => {
    const t = await failedTask({ retry: 'push', branch: 'wb/T-903', merged_commit: 'abc1234' });
    const act = cardAction((await api('/tasks')).text, t.id)!;
    const r = await api(act.url, { method: 'POST' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.retry, 'push', 'retry 不能被清成 null');
    assert.equal(r.json.status, 'queued');
    assert.equal(r.json.merged_commit, 'abc1234', '已合并的事实要留着');
    assert.match(r.json.step, /推送/, '排队原因得说清是接着推送');
    assert.doesNotMatch(r.json.step, /重新排队/);
  });

  test('点卡片上的重试合并：retry 还是 merge', async () => {
    const t = await failedTask({ retry: 'merge', branch: 'wb/T-904' });
    const act = cardAction((await api('/tasks')).text, t.id)!;
    const r = await api(act.url, { method: 'POST' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.retry, 'merge');
    assert.match(r.json.step, /合并/);
  });

  test('三个页面同一张卡给同一个动作', async () => {
    const t = await failedTask({ retry: 'push', branch: 'wb/T-905' });
    const found: string[] = [];
    for (const p of ['/tasks', '/team']) {
      const act = cardAction((await api(p)).text, t.id);
      if (act) found.push(act.url);
    }
    assert.ok(found.length >= 1, '任务页要有这张卡的动作');
    // 053.2：工作台「等你拍板」里的卡不带按钮，动作只在详情里。
    assert.equal(cardAction((await api('/?g=you')).text, t.id), null);
    assert.deepEqual([...new Set(found)], [`/api/tasks/${t.id}/retry-push`], '每页都得是同一个重试入口');
  });
});
