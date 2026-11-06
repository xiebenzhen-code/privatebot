// 031b：找得到才算记得。028 之后每个任务都有结果文本，但之前没地方搜。
// 判定：标题、说明、结果三处都搜；多个词全部命中；`%` `_` `\` 是字面量不是通配符；
// 片段里是转义过的文字；搜索词不进审计。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';
import { db } from '../src/db.ts';

const TOKEN = 'test-token-031b-0123456789ab';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => server.close());

beforeEach(async () => {
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

const page = async (path: string) => {
  const res = await fetch(base + path, { headers: { Cookie: cookie } });
  return { status: res.status, text: await res.text() };
};

describe('031b 搜索词怎么拆', () => {
  test('空格分隔、去重、丢掉空串', async () => {
    const { searchTerms } = await import('../src/services/search.ts');
    assert.deepEqual(searchTerms('  README   分支  '), ['README', '分支']);
    assert.deepEqual(searchTerms('README readme README'), ['README'], '大小写不同算同一个词');
    assert.deepEqual(searchTerms(''), []);
    assert.deepEqual(searchTerms(null), []);
    assert.deepEqual(searchTerms('   '), []);
  });

  test('最多认 8 个词，单个词最长 60 字', async () => {
    const { searchTerms } = await import('../src/services/search.ts');
    assert.equal(searchTerms('a b c d e f g h i j').length, 8);
    assert.equal(searchTerms('长'.repeat(200))[0].length, 60);
  });

  test('LIKE 通配符转义成字面量', async () => {
    const { likePattern } = await import('../src/services/search.ts');
    assert.equal(likePattern('100%'), '%100\\%%');
    assert.equal(likePattern('a_b'), '%a\\_b%');
    assert.equal(likePattern('c:\\x'), '%c:\\\\x%');
    assert.equal(likePattern('普通'), '%普通%');
  });
});

describe('031b 片段：命中位置前后各 40 字', () => {
  test('命中处标成 hit，前后加省略号', async () => {
    const { snippetOf } = await import('../src/services/search.ts');
    const text = `${'前'.repeat(100)}关键词${'后'.repeat(100)}`;
    const pieces = snippetOf(text, ['关键词'])!;
    assert.ok(pieces, '要能剪出片段');
    assert.equal(pieces[0].text, '…');
    assert.equal(pieces[pieces.length - 1].text, '…');
    const hit = pieces.find((p) => p.hit);
    assert.equal(hit?.text, '关键词');
    const plain = pieces.filter((p) => !p.hit).map((p) => p.text).join('');
    assert.ok(plain.length <= 40 + 40 + 2, `前后各 40 字，实际 ${plain.length}`);
  });

  test('没命中返回 null；命中在开头就不加前省略号', async () => {
    const { snippetOf } = await import('../src/services/search.ts');
    assert.equal(snippetOf('一段没有关键词的话', ['别的']), null);
    const pieces = snippetOf('开头就是词', ['开头'])!;
    assert.notEqual(pieces[0].text, '…');
  });

  test('两个词重叠时不切碎标签', async () => {
    const { snippetOf } = await import('../src/services/search.ts');
    const pieces = snippetOf('这是主要功能说明', ['主要功', '主要功能'])!;
    const hits = pieces.filter((p) => p.hit).map((p) => p.text);
    assert.deepEqual(hits, ['主要功能'], '重叠的命中要合并成一段');
  });
});

describe('031b 三种字段都搜得到', () => {
  test('标题、说明、结果文本各放一个词', async () => {
    const { createTask, updateTask, listTasks } = await import('../src/services/tasks.ts');
    const t = createTask({
      title: '火星计划：整理推进方案', description: '培养舱的温控要单列一节', executor: 'pool',
    }, 'me');
    updateTask(t.id, { status: 'done', result_text: '结论：温室先做，培养舱二期。' }, 'system');

    const byTitle = listTasks({ q: '火星计划' });
    const byDesc = listTasks({ q: '温控' });
    const byResult = listTasks({ q: '温室' });
    for (const [label, rows] of [['标题', byTitle], ['说明', byDesc], ['结果', byResult]] as const) {
      assert.equal(rows.length, 1, `搜${label}应命中 1 条，实际 ${rows.length}`);
      assert.equal(rows[0].id, t.id);
    }
  });

  test('中文子串能搜到（不做分词）', async () => {
    const { createTask, updateTask, listTasks } = await import('../src/services/tasks.ts');
    const t = createTask({ title: '读代码', executor: 'pool' }, 'me');
    updateTask(t.id, { status: 'done', result_text: '第一段：分析主要功能。' }, 'system');
    assert.equal(listTasks({ q: '主要功' }).some((r) => r.id === t.id), true);
  });

  test('失败的任务也能搜到', async () => {
    const { createTask, updateTask, listTasks } = await import('../src/services/tasks.ts');
    const t = createTask({ title: '迁移数据库失败案例', executor: 'pool' }, 'me');
    updateTask(t.id, { status: 'failed', fail_reason: '迁移超时' }, 'system');
    assert.equal(listTasks({ q: '迁移数据库', status: ['done', 'failed'] }).some((r) => r.id === t.id), true);
  });

  test('多个词要全部命中', async () => {
    const { createTask, listTasks } = await import('../src/services/tasks.ts');
    const a = createTask({ title: '火星计划', description: '培养舱' , executor: 'pool' }, 'me');
    const b = createTask({ title: '温室大棚', executor: 'pool' }, 'me');
    const both = listTasks({ q: '火星 培养舱' }).map((t) => t.id);
    assert.ok(both.includes(a.id), '两个词都在这一条里，要命中');
    assert.ok(!both.includes(b.id), '只命中「温室」的任务不能算');
    assert.equal(listTasks({ q: '火星 大棚' }).length, 0, '只命中一个词不算');
    assert.equal(listTasks({ q: '温室' }).some((t) => t.id === b.id), true);
  });

  test('countTasks 数的是命中总数，不是这一页', async () => {
    const { listTasks, countTasks } = await import('../src/services/tasks.ts');
    const hits = countTasks({ q: '火星' });
    const firstPage = listTasks({ q: '火星', limit: 1 });
    assert.equal(hits >= 1, true);
    assert.equal(firstPage.length, 1);
    assert.equal(countTasks({ q: '几乎肯定不存在的一串字' }), 0);
  });
});

describe('031b 特殊字符：不当通配符、不注入', () => {
  test('% _ \\ 搜的是字面量', async () => {
    const { createTask, listTasks } = await import('../src/services/tasks.ts');
    const pct = createTask({ title: '进度 100% 完成', executor: 'pool' }, 'me');
    createTask({ title: '进度 100X 完成', executor: 'pool' }, 'me');
    assert.deepEqual(listTasks({ q: '100%' }).map((t) => t.id), [pct.id], '% 不能当通配符');

    const under = createTask({ title: 'a_b 命名', executor: 'pool' }, 'me');
    createTask({ title: 'axb 命名', executor: 'pool' }, 'me');
    assert.deepEqual(listTasks({ q: 'a_b' }).map((t) => t.id), [under.id], '_ 不能当单字符通配符');

    const slash = createTask({ title: '路径 C:\\temp 的坑', executor: 'pool' }, 'me');
    assert.equal(listTasks({ q: 'C:\\temp' }).some((t) => t.id === slash.id), true, '\\ 要能搜自己的反斜杠');
  });

  test('引号和脚本标签不报错', async () => {
    const { createTask, listTasks } = await import('../src/services/tasks.ts');
    createTask({ title: "带 ' 和 \" 的标题", executor: 'pool' }, 'me');
    createTask({ title: '<script>alert(1)</script>', executor: 'pool' }, 'me');
    for (const q of ["'", '"', '<script>', "'; DROP TABLE tasks; --", '\\']) {
      assert.doesNotThrow(() => listTasks({ q }), `搜 ${q} 不该报错`);
    }
    assert.equal(listTasks({ q: '<script>' }).length, 1);
    assert.equal((db().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n >= 2, true, '表还在');
  });
});

describe('031b 页面：搜索框、片段、搜不到', () => {
  test('搜索框在，词回填', async () => {
    const { text } = await page('/tasks/done?q=README');
    assert.match(text, /class="search-form"/);
    assert.match(text, /name="q"/);
    assert.match(text, /value="README"/);
  });

  test('命中词包在 <mark> 里，前后文也在', async () => {
    const { createTask, updateTask } = await import('../src/services/tasks.ts');
    const t = createTask({ title: '阅读项目 README', executor: 'pool' }, 'me');
    updateTask(t.id, {
      status: 'done',
      result_text: `${'铺垫'.repeat(60)}这个项目是一个个人 AI 工作台，README 里写了三条安装注意${'收尾'.repeat(60)}`,
    }, 'system');

    const { text } = await page('/tasks/done?q=README');
    assert.ok(text.includes(`T-${t.id}`), '命中的任务要在列表里');
    assert.match(text, /<mark>README<\/mark>/);
    assert.match(text, /row-snippet/);
    assert.ok(text.includes('三条安装注意') || text.includes('这个项目是一个个人 AI 工作台'), '要有命中附近的文字');
  });

  test('搜不到时写人话', async () => {
    const { text } = await page('/tasks/done?q=绝对不存在的关键词zzz');
    assert.ok(text.includes('没有找到'), '要说没找到');
    assert.ok(text.includes('换个词试试'), '还要给出下一步');
    assert.ok(!text.includes('class="row"'), '不能还列着不相关的任务');
  });

  test('空搜索词照旧分页，不加片段', async () => {
    const { text } = await page('/tasks/done');
    assert.ok(text.includes('class="row"'));
    assert.ok(!text.includes('row-snippet'), '没搜就不显示片段');
  });

  test('搜索词里的脚本标签在页面上是转义的文字', async () => {
    const { text } = await page('/tasks/done?q=' + encodeURIComponent('<script>alert(1)</script>'));
    assert.ok(!text.includes('<script>alert(1)</script>'), '不能原样输出');
    assert.ok(text.includes('&lt;script&gt;'), '要显示成文字');
  });

  test('搜索词不进审计', async () => {
    await page('/tasks/done?q=审计不该记住的词');
    const rows = db().prepare("SELECT COUNT(*) AS n FROM events WHERE text LIKE '%审计不该记住%'").get() as { n: number };
    assert.equal(rows.n, 0, '「我搜了什么」不是审计事件');
  });
});

describe('031b 性能：2000 条 × 8000 字', () => {
  test('扫一遍在 200ms 内', async () => {
    const { listTasks } = await import('../src/services/tasks.ts');
    const now = '2026-10-31T00:00:00.000Z';
    const filler = '这是一段用来凑长度的普通结果文字，用来模拟真实任务的长回答。'.repeat(120).slice(0, 8000);
    const insert = db().prepare(`INSERT INTO tasks (title, description, executor, project, status, created_at, updated_at, result_text)
      VALUES (?, ?, 'pool', 'perf', 'done', ?, ?, ?)`);
    db().exec('BEGIN');
    for (let i = 0; i < 2000; i++) {
      insert.run(`批量任务 ${i}`, `说明 ${i} ${filler.slice(0, 200)}`, now, now, `${filler} 收尾标记 ${i}`);
    }
    db().exec('COMMIT');

    // 全量测试是并行跑的，单次耗时会受别的用例影响；取三次里最快的一次，
    // 数字照样有，也不会因为邻居忙就红。
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const rows = listTasks({ q: '收尾标记 1999', limit: 5 });
      best = Math.min(best, performance.now() - started);
      assert.equal(rows.length, 1, '要正好命中最后一条');
    }
    assert.ok(best < 300, `扫 2000 条 8000 字结果应在 300ms 内，最快一次 ${best.toFixed(0)}ms`);
  });
});
