// 026: 视觉层级与色彩标注——一个色系，颜色只在「状态」上用，荧光黄绿只做填充。
// 对比度不靠肉眼：从 :root 读变量，按 WCAG 公式算，够不够写在断言里。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-026-0123456789abc';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

let app: Server;
let base = '';
let cookie = '';
let db: any;

before(async () => {
  const { openDb, useDb } = await import('../src/db.ts');
  const { handle } = await import('../src/app.ts');
  app = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const a = app.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  db = openDb(':memory:');
  useDb(db);
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

// ---------- WCAG ----------
const vars = (() => {
  const root = CSS.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) out[m[1]] = m[2];
  return out;
})();

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
const WHITE = '#FFFFFF';

describe('026 · 对比度', () => {
  test(':root 里该有的颜色变量都在', () => {
    for (const name of ['--bg', '--ink', '--accent', '--accent-soft', '--accent-ink', '--warn', '--warn-bg', '--danger', '--danger-bg', '--ok', '--ok-bg', '--info', '--info-bg', '--muted', '--faint']) {
      assert.ok(vars[name], `缺 ${name}`);
    }
  });

  const cases: [string, string, string, number][] = [
    ['深橄榄字 / 白底', '--accent-ink', WHITE, 7],
    ['深橄榄字 / 荧光底', '--accent-ink', '--accent-soft', 7],
    ['墨色字 / 荧光黄绿按钮', '--ink', '--accent', 7],
    ['注意色 / 注意底', '--warn', '--warn-bg', 4.5],
    ['正文灰 / 白底', '--muted', WHITE, 4.5],
    ['浅灰 / 纸底', '--faint', '--bg', 4.5],
    ['进行中 / 蓝底', '--info', '--info-bg', 4.5],
    ['成功 / 绿底', '--ok', '--ok-bg', 4.5],
    ['危险 / 红底', '--danger', '--danger-bg', 4.5],
  ];
  for (const [label, fg, bg, min] of cases) {
    test(`${label} ≥ ${min}:1`, () => {
      const f = vars[fg] ?? fg;
      const b = vars[bg] ?? bg;
      const ratio = contrast(f, b);
      assert.ok(ratio >= min, `${fg} on ${bg} = ${ratio.toFixed(2)}:1，要求 ${min}:1`);
    });
  }
});

describe('026 · 荧光黄绿只做填充', () => {
  // 每一段选择器 + 声明块，看看谁把 --accent 当字色用。
  const blocks = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

  test('color: var(--accent) 只出现在墨色底上（品牌标记、深色按钮里的图标）', () => {
    const offenders = blocks.filter((b) => /(^|[^-])color:\s*var\(--accent\)/.test(b.body));
    assert.ok(offenders.length > 0, '这几处本来就该存在（否则测试没测到东西）');
    for (const b of offenders) {
      // 044：深浅两套里「墨色块」统一叫 --solid（浅色是墨色，深色是浅色块配墨字）。
      const onInk = /background:\s*var\(--(ink|solid|brand-bg)\)/.test(b.body) || /background:\s*#18181B/i.test(b.body);
      // 图标规则只写颜色，底色由它所在的那个深色按钮给（.btn.primary svg 之类）。
      const iconOnDark = /(svg|brand-mark)/.test(b.sel);
      assert.ok(onInk || iconOnDark, `「${b.sel}」把荧光黄绿当字色，但底色不是墨色：${b.body.trim()}`);
    }
    assert.ok(blocks.some((b) => /background:\s*var\(--(ink|solid|brand-bg)\)/.test(b.body) && /color:\s*var\(--accent\)/.test(b.body)), '至少有一处是「墨底 + 荧光字」');
  });

  test('没有把 --accent 用在 border-color 以外的白色背景上', () => {
    // 荧光黄绿可以当边框、当标记条、当底色；不能当白底上的文字。
    const asText = [...CSS.matchAll(/\b(color|fill):\s*var\(--accent\)/g)];
    assert.equal(asText.length, blocks.filter((b) => /(^|[^-])color:\s*var\(--accent\)/.test(b.body)).length);
  });
});

describe('026 · 一套按钮', () => {
  test('推荐按钮只有一个定义，.approve 只是别名', () => {
    const accent = [...CSS.matchAll(/\.btn\.accent[^{]*\{/g)].map((m) => m[0]);
    const base = accent.filter((sel) => !/:hover|svg/.test(sel));
    assert.equal(base.length, 1, `推荐按钮应该只有一条基础规则，实际 ${base.length} 条`);
    assert.match(base[0], /\.btn\.approve/, '.approve 和 .accent 写在同一条选择器里，不是两套');
    assert.ok(!/^\s*\.btn\.approve\s*,?\s*$/m.test(CSS), '.btn.approve 不该单独占一条选择器');
  });

  test('页面里不再输出 .btn.approve（新名字是 .btn.accent）', async () => {
    const page = await api('/tasks?new=1');
    assert.equal(page.status, 200);
    assert.ok(!/class="btn approve/.test(page.text.replace(/btn accent/g, '')), '页面不该再用旧类名');
  });

  test('五种按钮的类都在样式表里', () => {
    const buttons = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /(^|,)\s*[^{,]*\.btn(\.[a-z]+)?\b/.test(m[1]));
    const decl = buttons.map((m) => m[2]).join(' ');
    for (const need of ['background: var(--solid)', 'background: var(--accent)', 'color: var(--danger)', 'border: 1px solid var(--line)']) {
      assert.ok(decl.includes(need), `按钮缺「${need}」`);
    }
    assert.match(CSS, /\.btn\[disabled\]/, '禁用态也要有');
  });
});

describe('026 · 状态标签', () => {
  test('六个变体都在样式表里，且圆点用 currentColor（颜色只有一处定义）', () => {
    for (const key of ['queued', 'running', 'review', 'done', 'failed', 'offline']) {
      assert.match(CSS, new RegExp(`\\.status\\.${key}\\b`), `缺 .status.${key}`);
    }
    assert.match(CSS, /\.status \.dot \{ background: currentColor; \}/);
  });

  test('看板上每种状态都渲染出对应 class', async () => {
    const mk = async (title: string, status: string) => {
      const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, executor: 'pool', project: 'demo-feed' }) });
      assert.equal(r.status, 201, r.text);
      const id = r.json.id;
      if (status !== 'inbox') {
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
      }
      return id;
    };
    await mk('排队的一单', 'queued');
    await mk('跑着的一单', 'running');
    await mk('等我批的一单', 'review');
    await mk('失败的一单', 'failed');

    const board = await api('/tasks');
    // 044：任务卡不再挂状态胶囊；卡片带 data-state，现状写成一句话（不只靠底色）。
    for (const key of ['queued', 'running', 'review', 'failed']) {
      assert.match(board.text, new RegExp(`data-card="task" data-task="\\d+" data-state="${key}"`), `看板上没有 ${key} 的卡`);
    }
    assert.match(board.text, /data-state="review"[\s\S]*?class="card-note warn">! 等你拍板/, '等你的卡要写出来，不只靠橙底');

    const done = await mk('做完的一单', 'done');
    await api(`/api/tasks/${done}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    const donePage = await api('/tasks/done');
    assert.match(donePage.text, /class="status done"/);
  });
});

describe('026 · 新建任务表单', () => {
  test('三段分组 + 必填/可选标记 + 重要提示用 callout', async () => {
    const page = await api('/tasks?new=1');
    const html = page.text;
    assert.match(html, /① 做什么/);
    assert.match(html, /② 谁来做/);
    assert.match(html, /③ 关联/);
    assert.equal((html.match(/class="form-group"/g) ?? []).length, 3, '三段');

    assert.match(html, /<span>标题<span class="label-req">必填<\/span><\/span>/, '标题必须标必填');
    assert.match(html, /<span class="label-opt">可选<\/span>/, '选填要有「可选」');

    const callout = html.match(/class="callout (info|warn)"/)?.[1];
    assert.ok(callout, '说明那一块应该是 callout');
    if (callout === 'info') assert.match(html, /class="mark"/, '关键词要用荧光笔标出来');
  });

  test('一个执行器都不在线时，提示变成橙色警告', async () => {
    db.prepare('DELETE FROM runners').run();
    const page = await api('/tasks?new=1');
    assert.match(page.text, /class="callout warn"/);
    assert.match(page.text, /现在没有执行器在线/);
  });

  test('在线时是浅绿说明块，并告诉人「在线」才会跑', async () => {
    db.prepare('DELETE FROM runners').run();
    const { heartbeat } = await import('../src/services/runner.ts');
    heartbeat('r-026', { executors: ['pool'] });
    const page = await api('/tasks?new=1');
    assert.match(page.text, /class="callout info"/);
    assert.match(page.text, /class="mark">「在线」/);
  });
});

describe('026 · 一屏一个荧光按钮', () => {
  test('今天页有几件待审批，荧光「批准」也只有一个', async () => {
    for (const title of ['删掉旧日志', '推送一版', '改个配置']) {
      const r = await api('/api/approvals', { method: 'POST', body: JSON.stringify({ title, risk: 'medium', tool_name: 'Bash' }) });
      assert.equal(r.status, 201, r.text);
    }
    const page = await api('/tasks/review'); // 044 v3：工作台二层只列，审批页里批
    const accent = (page.text.match(/class="btn accent"/g) ?? []).length;
    // 061.1：派活框只在首页；审批页最多一个荧光按钮。
    assert.ok(accent <= 1, `荧光按钮最多一个，实际 ${accent} 个`);
    assert.equal((page.text.match(/value="approved"/g) ?? []).length, 3, '三个批准按钮都在，只是只有一个亮');
  });

  test('审片页同理', async () => {
    const page = await api('/tasks/review');
    const accent = (page.text.match(/class="btn accent"/g) ?? []).length;
    assert.ok(accent <= 1);
  });
});

describe('026 · 等你批准的卡片要抢眼', () => {
  test('待审批卡片左边有橙色竖线', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '要批准的一单', executor: 'pool', project: 'demo-feed' }) });
    await api('/api/approvals', { method: 'POST', body: JSON.stringify({ title: '动一下仓库', risk: 'high', tool_name: 'Bash', task_id: t.json.id }) });
    const board = await api('/tasks');
    assert.match(board.text, /card needs-you/, '卡片要有 needs-you 类');
    assert.match(CSS, /\.card\.needs-you \{[^}]*inset 3px 0 0 var\(--warn\)/, '橙线写在 CSS 里，不是行内样式');
  });

  test('失败卡片有红线和红字原因（黑白也分得清）', async () => {
    assert.match(CSS, /\.card\.failed \{[^}]*inset 3px 0 0 var\(--danger\)/);
    assert.match(CSS, /\.card-reason \{[^}]*color: var\(--danger\)/);
  });
});

describe('026 · 样式说明页', () => {
  const guide = readFileSync(join(ROOT, 'docs', 'design', 'style-guide.html'), 'utf8');

  test('直接读线上那份 CSS，零依赖', () => {
    assert.match(guide, /href="\.\.\/\.\.\/public\/style\.css"/);
    assert.ok(!/<script/i.test(guide), '说明页不该带脚本');
    assert.ok(!/https?:\/\//.test(guide.replace(/<!DOCTYPE[^>]*>/i, '')), '不引外部资源');
  });

  test('六种状态、四种提示、五种按钮都各有一例', () => {
    for (const key of ['queued', 'running', 'review', 'done', 'failed', 'offline']) {
      assert.match(guide, new RegExp(`class="status ${key}"`), `说明页缺 .status.${key}`);
    }
    for (const tone of ['info', 'warn', 'danger', 'ok']) {
      assert.match(guide, new RegExp(`class="callout ${tone}"`));
    }
    for (const cls of ['btn accent', 'btn primary', 'btn danger']) {
      assert.match(guide, new RegExp(`class="${cls}"`), `说明页缺 ${cls}`);
    }
  });

  test('页面里没有真实数据（邮箱、IP、机器名、人名）', () => {
    assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(guide), '不该有邮箱');
    assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(guide), '不该有 IP');
    const localUser = process.env.USERNAME || process.env.USER;
    if (localUser) assert.ok(!guide.includes(localUser), '不该有本机用户名');
  });
});
