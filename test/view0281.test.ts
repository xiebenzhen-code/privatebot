// 028.1：结果区的 Markdown 排版（先转义再加格式）和只读任务的「跳过」阶段条。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';
import { renderMarkdown } from '../src/views/markdown.ts';

const TOKEN = 'test-token-view0281-01234567';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const out = (s: string) => renderMarkdown(s).value;

describe('028.1 Markdown：只认几种写法', () => {
  test('标题、加粗、行内代码', () => {
    assert.match(out('# 一'), /<h4>一<\/h4>/);
    assert.match(out('## 二'), /<h5>二<\/h5>/);
    assert.match(out('### 三'), /<h6>三<\/h6>/);
    assert.match(out('这是 **重点** 和 `code`'), /<strong>重点<\/strong>/);
    assert.match(out('这是 **重点** 和 `code`'), /<code>code<\/code>/);
  });

  test('无序列表和有序列表', () => {
    assert.equal(out('- 甲\n- 乙'), '<div class="md"><ul><li>甲</li><li>乙</li></ul></div>');
    assert.equal(out('1. 甲\n2. 乙'), '<div class="md"><ol><li>甲</li><li>乙</li></ol></div>');
  });

  test('代码块', () => {
    const html = out('```\nnpm test\n```');
    assert.match(html, /<pre class="code-block"><code>npm test<\/code><\/pre>/);
  });

  test('空行分段', () => {
    const html = out('第一段\n\n第二段');
    assert.equal((html.match(/<p>/g) ?? []).length, 2);
  });

  test('引用块不留裸 >', () => {
    const html = out('> 原话\n> 第二行');
    assert.match(html, /<blockquote>原话 第二行<\/blockquote>/);
    assert.ok(!html.includes('&gt;'), '页面上的 > 要去掉，不能当正文');
  });
});

describe('028.1 Markdown：HTML 一律当文字', () => {
  test('script 标签被转义，不会变成元素', () => {
    const html = out('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'), '不能留下可执行的标签');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('img onerror 被转义', () => {
    const html = out('<img src=x onerror="alert(1)">');
    assert.ok(!html.includes('<img'), '不能留下 img 标签');
    assert.ok(html.includes('&lt;img'));
  });

  test('链接语法原样当文字，不生成 a 标签', () => {
    const html = out('[点我](javascript:alert(1))');
    assert.ok(!html.includes('<a '), '不做链接化');
    assert.ok(html.includes('[点我](javascript:alert(1))'));
  });

  test('加粗里的尖括号也被转义', () => {
    const html = out('**<b>x</b>**');
    assert.ok(!html.includes('<b>'));
    assert.match(html, /<strong>&lt;b&gt;x&lt;\/b&gt;<\/strong>/);
  });
});

describe('028.1 只读任务的阶段条显示跳过', () => {
  let server: Server;
  let base = '';
  let cookie = '';
  let doneId = 0;

  before(async () => {
    const { handle } = await import('../src/app.ts');
    const { createTask, updateTask } = await import('../src/services/tasks.ts');
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    cookie = await loginCookie(base, 'test-password-0123456789');

    const t = createTask({ title: '读一遍 README', executor: 'pool' }, 'me');
    updateTask(t.id, {
      status: 'done',
      progress: 100,
      step: '已完成（没有改动，不需要合并）',
      result_text: '## 三条结论\n1. 个人工作台\n2. SQLite',
      no_changes: 1,
    }, 'system');
    doneId = t.id;
  });

  after(() => server.close());

  test('合并和推送那四格是 skipped', async () => {
    const res = await fetch(`${base}/tasks?task=${doneId}`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /stage-cell skipped/, '要有跳过样式');
    const skipped = (html.match(/stage-cell skipped/g) ?? []).length;
    assert.equal(skipped, 4, `四格要跳过，实际 ${skipped}`);
    assert.ok(html.includes('跳过'), '文字上也要说明');
  });

  test('普通任务没有跳过格', async () => {
    const { createTask } = await import('../src/services/tasks.ts');
    const t = createTask({ title: '改一行', executor: 'pool' }, 'me');
    const res = await fetch(`${base}/tasks?task=${t.id}`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.ok(!html.includes('stage-cell skipped'));
  });

  test('结果按 Markdown 渲染进页面', async () => {
    const res = await fetch(`${base}/tasks?task=${doneId}`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.ok(html.includes('<h5>三条结论</h5>'), '## 在抽屉里渲染成 h5（h2 是任务标题、h3 是「结果」）');
    assert.ok(html.includes('<li>个人工作台</li>'));
  });
});

describe('028.1 创建时就标「没有改动」', () => {
  test('从接口建的任务，no_changes 不会被静默丢掉', async () => {
    const { createTask } = await import('../src/services/tasks.ts');
    const t = createTask({ title: '只读任务', executor: 'pool', no_changes: 1, status: 'done' } as any, 'me');
    assert.equal(t.no_changes, 1, 'createTask 也要认这个字段，不能只 updateTask 认');
  });
});
