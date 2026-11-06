// 043：执行器松绑。这一组守三件事——
//   F 没干活不能算完成（被拒了权限、或者要产出却什么都没改）；
//   C 分类白名单的出厂默认清空，用户自己设的不动；
//   E 审批钩子管全部工具，读网页不再因为「没人能点确认」被一律拒掉。
// 全部走真实 HTTP、真实旧库升级。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const TOKEN = 'test-token-043-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-043-0123456789';
process.env.WB_TZ = 'Asia/Shanghai';

let app: Server;
let base = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let dispatch: typeof import('../src/services/dispatch.ts');
const dirs: string[] = [];
const files: any[] = [];

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  dispatch = await import('../src/services/dispatch.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => {
  app.close();
  for (const db of files) { try { db.close(); } catch { /* 关过了 */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  D.useDb(D.openDb(':memory:'));
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

/** 建单 → 点开始 → 执行器真领一次。 */
async function running(extra: Record<string, unknown> = {}): Promise<number> {
  const t = tasks.createTask({ title: '043 测试单', project: 'ai-workbench', category: 'dev', executor: 'pool', status: 'queued', ...extra }, 'me');
  tasks.updateTask(t.id, { start_requested: 1 }, 'me');
  const r = await api('/api/runner/next?executors=pool&runner=runner-a');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.id, t.id);
  return t.id;
}

async function finish(id: number, body: Record<string, unknown>) {
  const r = await api(`/api/runner/tasks/${id}/finish`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 200, r.text);
  return tasks.getTask(id)!;
}

describe('043 F · 没干活不算完成', () => {
  test('退出码 0、被拒了权限、什么都没改 → 失败，写清是哪个工具被拦', async () => {
    const id = await running({ answer_only: 1 });
    const t = await finish(id, { result: 'done', no_changes: true, result_text: '我没法联网', denials: ['WebFetch', 'WebFetch', 'Write'] });
    assert.equal(t.status, 'failed');
    assert.match(t.fail_reason ?? '', /被拦住了：WebFetch、Write/);
    assert.equal(t.result_text, '我没法联网', '它说了什么照样留着，方便你看');
  });

  test('要产出（没勾只要回答）却一个文件都没改 → 失败，告诉你怎么办', async () => {
    const id = await running();
    const t = await finish(id, { result: 'done', no_changes: true, result_text: '我觉得可以这样做……' });
    assert.equal(t.status, 'failed');
    assert.match(t.fail_reason ?? '', /没有产出任何文件/);
    assert.match(t.fail_reason ?? '', /只要一个回答/);
  });

  test('勾了只要回答、没被拦 → 照 028 直接完成', async () => {
    const id = await running({ answer_only: 1 });
    const t = await finish(id, { result: 'done', no_changes: true, result_text: '这个项目是……' });
    assert.equal(t.status, 'done');
  });

  test('大脑判成只读的（route_read_only）也算只要回答', async () => {
    const id = await running();
    D.db().prepare('UPDATE tasks SET route_read_only = 1 WHERE id = ?').run(id);
    const t = await finish(id, { result: 'done', no_changes: true });
    assert.equal(t.status, 'done');
  });

  test('有改动的正常完成不受影响：照样等合并', async () => {
    const id = await running();
    const t = await finish(id, { result: 'done', no_changes: false, branch: `wb/T-${id}`, commit: 'abcdef1' });
    assert.equal(t.status, 'done');
    assert.match(t.step, /等合并/, '有改动就照旧去等合并审批');
  });

  test('新建任务表单有「只要一个回答」，接口收 on / true / 1', () => {
    for (const v of ['on', true, '1', 1]) {
      const t = tasks.createTask({ title: 'x', executor: 'me', answer_only: v }, 'me');
      assert.equal(t.answer_only, 1, `answer_only=${String(v)}`);
    }
    assert.equal(tasks.createTask({ title: 'y', executor: 'me' }, 'me').answer_only, 0);
  });

  test('执行器解析 Claude Code 结果事件里的 permission_denials', async () => {
    const { parseStreamLine } = await import('../scripts/runner.mjs');
    const msg = parseStreamLine(JSON.stringify({
      type: 'result', result: '没权限', is_error: false,
      permission_denials: [{ tool_name: 'WebFetch', tool_use_id: 'a', tool_input: {} }, { tool_name: 'Bash' }],
    }));
    assert.deepEqual(msg.denials, ['WebFetch', 'Bash']);
    const plain = parseStreamLine(JSON.stringify({ type: 'result', result: 'ok' }));
    assert.deepEqual(plain.denials, []);
  });
});

describe('043 C · 分类白名单默认不拦', () => {
  test('新库：所有执行者的分类都是空（= 全接）', () => {
    for (const s of dispatch.listExecutorSettings()) {
      assert.equal(s.categories, '', `${s.executor} 不该默认带白名单`);
    }
  });

  test('老库升级：出厂默认清空，用户自己设的不动；只要回答的老单补上标记', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-043-'));
    dirs.push(dir);
    const file = join(dir, 'workbench.db');
    const old = D.openDb(file, { at: D.versionAfter('ADD COLUMN route_read_only') });
    old.exec(`UPDATE executor_settings SET categories = 'ops' WHERE executor = 'claude'`);
    old.exec(`UPDATE executor_settings SET categories = 'dev,docs,content' WHERE executor = 'pool'`);
    old.exec(`INSERT INTO tasks (title, created_at, updated_at, status, no_changes) VALUES ('读 README', 'x', 'x', 'done', 1)`);
    old.exec(`INSERT INTO tasks (title, created_at, updated_at, status, no_changes) VALUES ('改代码', 'x', 'x', 'done', 0)`);
    old.close();

    const up = D.openDb(file);
    files.push(up);
    D.useDb(up);
    const cats = Object.fromEntries(dispatch.listExecutorSettings().map((s) => [s.executor, s.categories]));
    assert.equal(cats.claude, 'ops', '用户自己改过的白名单不碰');
    assert.equal(cats.pool, '', '反代池不再只能做开发');
    const rows = up.prepare('SELECT title, answer_only FROM tasks ORDER BY id').all() as any[];
    assert.deepEqual(rows.map((r) => r.answer_only), [1, 0]);
  });
});

describe('043 E · 审批钩子管全部工具', () => {
  test('钩子配置匹配所有工具，读网页不再落回无头模式的「一律拒」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-043-hook-'));
    dirs.push(dir);
    const { ensureHookConfig } = await import('../scripts/runner.mjs');
    const { file } = ensureHookConfig({ claudeConfigDir: dir });
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    const matcher = settings.hooks.PreToolUse[0].matcher;
    for (const tool of ['WebFetch', 'WebSearch', 'Bash', 'Write', 'mcp__x__y']) {
      assert.ok(new RegExp(`^(?:${matcher})$`).test(tool), `${tool} 要经过钩子`);
    }
  });

  test('后端不支持搜索时，提示 agent 用读网页打开搜索页', async () => {
    const { searchHint } = await import('../scripts/runner.mjs');
    assert.match(searchHint({}), /WebFetch/);
    assert.match(searchHint({}), /cn\.bing\.com\/search\?q=/);
    assert.match(searchHint({ searchUrl: 'https://example.com/s' }), /example\.com\/s\?q=/);
  });
});

describe('043 A · 同时跑多个任务', () => {
  test('maxParallel：默认 3，夹在 1–8', async () => {
    const r = await import('../scripts/runner.mjs');
    assert.equal(r.maxParallel({}), 3);
    assert.equal(r.maxParallel({ maxParallel: 0 }), 1);
    assert.equal(r.maxParallel({ maxParallel: 20 }), 8);
    assert.equal(r.maxParallel({ maxParallel: 'x' }), 3);
  });

  test('只有编码中的占名额，等审批的不占', async () => {
    const r = await import('../scripts/runner.mjs');
    r.resetParallelState();
    r.inFlight.set(1, 'coding');
    r.inFlight.set(2, 'coding');
    assert.equal(r.canClaim({ maxParallel: 2 }), false, '两个在编码，名额满了');
    r.inFlight.set(2, 'waiting');
    assert.equal(r.canClaim({ maxParallel: 2 }), true, '一个改完在等你批，让出名额');
    r.resetParallelState();
  });

  test('重启前排空：不再领新活，等别的任务做完；等久了只提醒、不杀', async () => {
    const r = await import('../scripts/runner.mjs');
    r.resetParallelState();
    r.inFlight.set(10, 'coding'); // 部署的那个任务自己
    r.inFlight.set(11, 'coding');
    let t = 0;
    const said: string[] = [];
    const notes: string[] = [];
    let rounds = 0;
    const done = r.drainOthers(10, {
      now: () => t,
      remindMs: 1000,
      say: (s: string) => said.push(s),
      notify: async (s: string) => { notes.push(s); },
      wait: async () => {
        rounds++;
        t += 600;
        assert.equal(r.canClaim({ maxParallel: 8 }), false, '排空期间一个都不领');
        if (rounds === 4) r.inFlight.delete(11); // 第 11 号做完了
      },
    });
    await done;
    assert.equal(rounds, 4, '等到别人做完才返回');
    assert.ok(notes.length >= 1 && /T-11/.test(notes[0]), '等久了要说清楚在等谁');
    assert.ok(r.inFlight.has(10), '自己不算');
    r.resetParallelState();
  });

  test('主循环不再一个一个等：领到就放出去跑', () => {
    const src = readFileSync(new URL('../scripts/runner.mjs', import.meta.url), 'utf8');
    const main = src.slice(src.indexOf('async function main()'));
    assert.doesNotMatch(main, /try \{ await runTask\(cfg, task\); \}/, '旧的串行写法不该再出现');
    assert.match(main, /const job = runTask\(cfg, task\)/);
  });
});

describe('043 B · 不弹黑框', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  test('git 这类叶子进程都带 windowsHide', () => {
    for (const p of ['scripts/runner.mjs', 'scripts/lib/projects.mjs', 'scripts/diagnose.mjs']) {
      for (const m of read(p).matchAll(/spawnSync\('git'[^;]*?\);/gs)) {
        assert.match(m[0], /windowsHide: true/, `${p}：${m[0].slice(0, 80)}`);
      }
    }
  });

  test('编码工具在 Windows 上继承执行器的控制台（不带 windowsHide）', async () => {
    const src = read('scripts/runner.mjs');
    assert.match(src, /spawn\(tool, args\.map\(quote\), \{[^}]*windowsHide: INHERIT_CONSOLE \? false : true/);
    const r = await import('../scripts/runner.mjs');
    assert.equal(r.INHERIT_CONSOLE, process.platform === 'win32');
  });

  test('守卫在 Windows 上不 detached、不 windowsHide，runner 挂在它的隐藏控制台上', () => {
    const src = read('scripts/runner-guard.mjs');
    assert.match(src, /windowsHide: !win,/);
    assert.match(src, /detached: !win,/);
  });

  test('计划任务用隐藏窗口的 PowerShell 起守卫', () => {
    const doc = read('docs/INSTALL-WINDOWS.md');
    assert.match(doc, /-WindowStyle Hidden[^\n]*runner|\$guard[^\n]*-WindowStyle Hidden|-WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '\$node' '\$guard'`"/);
  });
});
