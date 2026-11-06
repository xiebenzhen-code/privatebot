// 053 · 剧组「擅长」五点：能力档案（先验 + 战绩）换成点数，一类一排。
//
// 钉住：点数 = 混合值 × 5 四舍五入；先验的点淡一档（class prior）；没跑过任何任务的执行者整块不出现；
// 页面上每一排带悬停说明（先验 / 混合 / 实战 + 百分比），读屏也能读到。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-053skills-0123456789';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

let app: Server;
let base = '';
let cookie = '';
let D: typeof import('../src/db.ts');
let tasks: typeof import('../src/services/tasks.ts');
let runs: typeof import('../src/services/runs.ts');
let team: typeof import('../src/views/team.ts');

before(async () => {
  D = await import('../src/db.ts');
  tasks = await import('../src/services/tasks.ts');
  runs = await import('../src/services/runs.ts');
  team = await import('../src/views/team.ts');
  const { handle } = await import('../src/app.ts');
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

const cap = (category: string, blended: number | null, label: '先验' | '混合' | '实战' = '先验', n = 0) => ({
  harness: 'h', model: 'm', category, n, own_rate: null, prior_level: null, prior_rate: null,
  blended, prior_share: 1, label, sample: 'ok' as const, evidence: [],
});

/** 剧组页一段 HTML 里，某个执行者那一条（从 data-exec 到下一个 data-exec）。 */
function sectionOf(html: string, key: string): string {
  const tag = `data-exec="${key}"`;
  const i = html.indexOf(tag);
  if (i < 0) return '';
  const next = html.indexOf('data-exec="', i + tag.length);
  return html.slice(i, next < 0 ? html.length : next);
}

async function crew(): Promise<string> {
  const res = await fetch(`${base}/team`, { headers: { Cookie: cookie }, redirect: 'manual' });
  return res.text();
}

describe('053 · skillDots（纯函数）', () => {
  test('点数 = 混合值 × 5 四舍五入，夹在 0–5', () => {
    const out = String(team.skillDots([cap('dev', 0.8), cap('docs', 0.6), cap('ops', 0.4), cap('content', 1.2), cap('personal', 0)]));
    const dots = (c: string) => Number(new RegExp(`data-skill="${c}" data-dots="(\\d)"`).exec(out)?.[1]);
    assert.equal(dots('dev'), 4);
    assert.equal(dots('docs'), 3);
    assert.equal(dots('ops'), 2);
    assert.equal(dots('content'), 5, '超过 1 也只给 5 点');
    assert.equal(dots('personal'), 0);
  });

  test('先验的点带 prior，实战 / 混合不带；每排有悬停和读屏说明', () => {
    const out = String(team.skillDots([cap('dev', 0.8, '先验'), cap('docs', 0.7, '实战', 12)]));
    assert.match(out, /class="skill prior"[^>]*data-skill="dev"/);
    assert.match(out, /class="skill "[^>]*data-skill="docs"/);
    assert.match(out, /title="开发 · 先验 约 80%"/);
    assert.match(out, /aria-label="文档 · 实战 约 70%（近 90 天 12 单）"/);
  });

  test('没有任何一类有值，整块不出现；值为 null 的类跳过', () => {
    assert.equal(String(team.skillDots([])), '');
    assert.equal(String(team.skillDots([cap('dev', null)])), '');
    const out = String(team.skillDots([cap('dev', null), cap('docs', 0.6)]));
    assert.ok(!out.includes('data-skill="dev"'));
    assert.ok(out.includes('data-skill="docs"'));
  });

  test('类别按固定顺序排，不按档案里的先后', () => {
    const out = String(team.skillDots([cap('personal', 0.6), cap('dev', 0.6)]));
    assert.ok(out.indexOf('data-skill="dev"') < out.indexOf('data-skill="personal"'));
  });
});

describe('053 · 剧组页', () => {
  test('跑过任务、模型有先验的执行者，展开里有「擅长」；没跑过的没有', async () => {
    const t = tasks.createTask({ title: '擅长单', executor: 'claude', status: 'running', category: 'dev' }, 'claude');
    runs.openRun(t.id, 'claude', '');
    runs.closeRun(t.id, 'done', { harness: 'claude-code', model: 'claude-opus-4-6' });
    const end = new Date(Date.now() - 86400000).toISOString();
    D.db().prepare('UPDATE tasks SET status = ?, completed_at = ?, started_at = ? WHERE id = ?').run('done', end, end, t.id);

    const html = await crew();
    const claude = sectionOf(html, 'claude');
    assert.match(claude, /data-exec-skills/);
    assert.match(claude, /data-skill="dev" data-dots="4"/, '先验 0.8 + 1 单全对，混合约 0.83 → 4 点');
    const codex = sectionOf(html, 'codex');
    assert.ok(codex, '剧组页有 codex 这一条');
    assert.ok(!codex.includes('data-exec-skills'), '没跑过任务读不出模型，不显示');
  });
});
