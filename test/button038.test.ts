// 038：按钮和面板的动效——少而有用。
//
// 这一单要钉住的东西分三层：
//   1. 点了之后真的立刻有反应（禁用 + 处理中），成功有完成话、失败退回原样——用一段假 DOM
//      把 public/app.js 跑起来，走真事件、真 fetch（打的是假接口）；
//   2. 样式表里的时长全 ≤ 0.2 秒，而且「减少动态效果」时一条都不剩；
//   3. 页面真的渲染出了这几个属性（data-done / data-risk / data-status），不是只写在代码里。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import vm from 'node:vm';
import { loginCookie } from './helpers.ts';

const TOKEN = 'test-token-038-0123456789abcd';
process.env.WB_TOKEN = TOKEN;
process.env.WB_DB = ':memory:';
process.env.WB_PASSWORD = 'test-password-0123456789';

const ROOT = join(import.meta.dirname, '..');
const APP_JS = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

// ---------- 1. 把 app.js 跑在一段假 DOM 上 ----------

type Handler = (ev: any) => Promise<void> | void;

class FakeEl {
  textContent: string;
  dataset: Record<string, string>;
  className = '';
  disabled = false;
  style: Record<string, string> = {};
  width = 88;
  /** 提交按钮靠 name/value 传 decision（app.js 读的是这两个原生属性）。 */
  name = '';
  value = '';
  private attrs: Record<string, string> = {};
  private classes = new Set<string>();
  private match: (sel: string) => boolean;

  constructor(text = '', data: Record<string, string> = {}, match?: (sel: string) => boolean) {
    this.textContent = text;
    this.dataset = { ...data };
    this.match = match ?? ((sel) => sel === '[data-api-click]');
  }
  get classList() {
    const s = this.classes;
    return {
      add: (c: string) => s.add(c),
      remove: (c: string) => s.delete(c),
      contains: (c: string) => s.has(c),
      toggle: (c: string, on?: boolean) => (on ? s.add(c) : s.delete(c)),
    };
  }
  has(c: string) { return this.classes.has(c); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  getBoundingClientRect() { return { width: this.width }; }
  closest(sel: string) { return this.match(sel) ? this : null; }
  querySelector() { return null; }
  addEventListener() { /* 假 DOM：事件由测试直接派发 */ }
}

class FakeForm extends FakeEl {
  buttons: FakeEl[];
  fields = new Map<string, string>();
  constructor(data: Record<string, string>, buttons: FakeEl[]) {
    super('', data, () => false);
    this.buttons = buttons;
  }
  querySelectorAll() { return this.buttons; }
}

type Ctx = {
  handlers: Record<string, Handler[]>;
  toast: FakeEl;
  reloads: number;
  href: { to: string };
  store: Map<string, string>;
  pills: FakeEl[];
};

/** 起一个「页面」：把 app.js 在假 DOM 上执行一遍，返回可以派发事件的句柄。 */
function boot(opts: {
  respond?: (url: string, init: any) => { ok: boolean; status?: number; data?: any } | Promise<{ ok: boolean; status?: number; data?: any }>;
  pills?: FakeEl[];
  seen?: string[];
  /** 038.1: pulse 版本由用例控制，这样才能在成功态停留期间「刚好」变一次。 */
  pulse?: () => string;
  /** 038.2: pulse 的响应挂在这道闸门上，用来做「先发出去、按钮后点、响应在成功态里才回来」。 */
  pulseHold?: () => Promise<void> | null;
} = {}): Ctx {
  const handlers: Record<string, Handler[]> = { click: [], submit: [], change: [], input: [], toggle: [], keydown: [] };
  const toast = new FakeEl('');
  const store = new Map<string, string>(opts.seen ? [['wb-status-seen', JSON.stringify(opts.seen)]] : []);
  const state: Ctx = { handlers, toast, reloads: 0, href: { to: '' }, store, pills: opts.pills ?? [] };

  const document = {
    body: { getAttribute: () => null },
    hidden: false,
    activeElement: null,
    addEventListener: (type: string, fn: Handler) => { (handlers[type] ??= []).push(fn); },
    getElementById: (id: string) => (id === 'toast' ? toast : null),
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel.startsWith('.status[data-status]') ? state.pills : []),
  };
  const location = {
    pathname: '/tasks', search: '', hash: '', get href() { return state.href.to; },
    set href(v: string) { state.href.to = v; },
    reload: () => { state.reloads += 1; },
  };
  const sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const respond = opts.respond ?? (() => ({ ok: true, data: {} }));
  const fetchStub = async (url: string, init: any = {}) => {
    if (url === '/api/pulse') {
      const gate = opts.pulseHold?.() ?? null;
      if (gate) await gate;
      return { ok: true, status: 200, json: async () => ({ v: opts.pulse?.() ?? 'v1' }) };
    }
    const r = await respond(url, init);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.data ?? {} };
  };
  class FormDataStub {
    form: FakeForm;
    constructor(form: FakeForm) { this.form = form; }
    entries() { return this.form.fields.entries(); }
  }

  const ctx = vm.createContext({
    document, location, sessionStorage, fetch: fetchStub,
    navigator: {},
    window: { addEventListener: () => {}, confirm: () => true },
    HTMLFormElement: FakeForm, HTMLDetailsElement: class {},
    FormData: FormDataStub,
    setTimeout, clearTimeout, setInterval: () => 0, JSON, Promise, Array, Object, String, Math, console,
  });
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
  return state;
}

const click = (ctx: Ctx, target: FakeEl) =>
  ctx.handlers.click[0]({ target, preventDefault: () => {} });

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('038 A · 点击反馈', () => {
  test('点一下立刻「处理中…」，成功后变完成话，停一下再刷新', async () => {
    let asked = '';
    const ctx = boot({ respond: (url) => { asked = url; return { ok: true, data: { ok: 1 } }; } });
    const btn = new FakeEl('开始', { apiClick: '/api/tasks/7/start', done: '已开始 ✓' });

    const run = click(ctx, btn);
    // 同步就有反应：不等网络回来
    assert.equal(btn.textContent, '处理中…');
    assert.equal(btn.disabled, true);
    assert.equal(btn.getAttribute('aria-busy'), 'true');
    assert.equal(btn.style.minWidth, '88px', '宽度要锁住，否则按钮会跳一下');

    await tick();
    assert.equal(asked, '/api/tasks/7/start');
    assert.equal(btn.textContent, '已开始 ✓', '成功之后要有完成话');
    assert.equal(btn.has('is-done'), true);
    assert.equal(ctx.reloads, 0, '完成话还没看完，不许立刻刷新');

    await run;
    assert.equal(ctx.reloads, 1, '停一下之后照旧刷新');
  });

  test('失败：按钮退回原样，旁边出现现有的那句错误文案', async () => {
    const ctx = boot({ respond: () => ({ ok: false, status: 409, data: { error: '这个任务已经被别人领走了' } }) });
    const btn = new FakeEl('开始', { apiClick: '/api/tasks/7/start' });
    await click(ctx, btn);
    assert.equal(btn.textContent, '开始', '不能停在「处理中」');
    assert.equal(btn.disabled, false);
    assert.equal(btn.has('is-done'), false);
    assert.equal(ctx.toast.textContent, '这个任务已经被别人领走了');
    assert.match(ctx.toast.className, /bad/, '失败要红');
    assert.equal(ctx.reloads, 0);
  });

  test('合并这种按钮：完成态带动作名，而且停够 1.5 秒', async () => {
    const ctx = boot({ respond: () => ({ ok: true, data: {} }) });
    const btn = new FakeEl('批准', { apiClick: '/api/approvals/9/decide', risk: 'high', done: '已批准合并 ✓' });
    const started = Date.now();
    const run = click(ctx, btn);
    await tick();
    assert.equal(btn.textContent, '已批准合并 ✓', '高风险的完成态要写清批的是什么');
    assert.equal(ctx.reloads, 0);
    await run;
    const took = Date.now() - started;
    assert.ok(took >= 1_400, `高风险至少停 1.5 秒，实际 ${took}ms`);
  });

  test('重试类按钮（data-no-done）文案不变，只是禁用一下', async () => {
    const ctx = boot({ respond: () => ({ ok: true, data: {} }) });
    const btn = new FakeEl('重试推送', { apiClick: '/api/tasks/7/retry-push', noDone: '' });
    const run = click(ctx, btn);
    assert.equal(btn.textContent, '处理中…', '处理中的提示还是要有');
    await run;
    assert.equal(btn.textContent, '重试推送', '重试按钮的文案不变');
    assert.equal(ctx.reloads, 1);
  });

  test('审批表单：按钮变处理中，成功后写「已批准合并 ✓」并把 toast 记成「已批准」', async () => {
    const ctx = boot({ respond: () => ({ ok: true, data: {} }) });
    const approve = new FakeEl('批准', { risk: 'high', done: '已批准合并 ✓' });
    approve.name = 'decision';
    approve.value = 'approved';
    const reject = new FakeEl('驳回', { done: '已驳回 ✓' });
    const form = new FakeForm({ api: '/api/approvals/9/decide' }, [reject, approve]);
    form.fields.set('decision', 'approved');

    const run = ctx.handlers.submit[0]({ target: form, submitter: approve, preventDefault: () => {} });
    assert.equal(approve.textContent, '处理中…');
    assert.equal(reject.disabled, true, '表单里的别的按钮也要锁住');
    await tick();
    assert.equal(approve.textContent, '已批准合并 ✓');
    await run;
    assert.equal(ctx.store.get('wb-toast'), '已批准', '刷新之后那一行提示说的还是「已批准」');
    assert.equal(ctx.reloads, 1);
  });

  test('审批表单失败：两个按钮都恢复，错误照旧弹出来', async () => {
    const ctx = boot({ respond: () => ({ ok: false, status: 400, data: { error: '打回修改需要写修改意见' } }) });
    const approve = new FakeEl('批准', { done: '已批准 ✓' });
    const form = new FakeForm({ api: '/api/approvals/9/decide' }, [approve]);
    await ctx.handlers.submit[0]({ target: form, submitter: approve, preventDefault: () => {} });
    assert.equal(approve.textContent, '批准');
    assert.equal(approve.disabled, false, '表单按钮失败也要恢复，不然点第二次都点不动');
    assert.equal(ctx.toast.textContent, '打回修改需要写修改意见');
  });
});

// ---------- 1a. 049.4 / 057.1 勾掉的待办：先划线淡出，再刷新 ----------
//
// 「完成」是卡片上的按钮，点完页面立刻刷新的话，人只看到卡片闪了一下，
// 分不清是自己点对了还是页面跳了。所以成功后先给这张卡划线、淡出，再刷新。

describe('049.4 · 勾掉的待办先划线淡出', () => {
  /** 卡片上的按钮：closest 既要找到按钮自己，也要找到外面那张卡。 */
  const onCard = (btn: FakeEl, card: FakeEl) => {
    btn.closest = (sel: string) => (sel === '[data-api-click]' ? btn : sel === '[data-card="task"]' ? card : null);
    return btn;
  };

  test('「完成」成功之后这张卡带 card-done，淡出放完才刷新', async () => {
    const ctx = boot({ respond: () => ({ ok: true, data: { id: 7, status: 'done' } }) });
    const card = new FakeEl('', {}, (sel) => sel === '[data-card="task"]');
    const btn = onCard(new FakeEl('完成', { apiClick: '/api/tasks/7', method: 'PATCH', done: '已完成 ✓' }), card);

    const run = click(ctx, btn);
    await tick();
    assert.equal(btn.textContent, '已完成 ✓');
    await tick(840); // 完成话先停 0.8 秒，之后才开始淡出
    assert.equal(card.has('card-done'), true, '成功后这张卡要划线淡出');
    assert.equal(ctx.reloads, 0, '淡出还没放完，不许立刻刷新');

    await run;
    assert.equal(ctx.reloads, 1, '淡出放完照旧刷新');
  });

  test('没让任务变成完成的那一下（开始、重试）卡片不动', async () => {
    const ctx = boot({ respond: () => ({ ok: true, data: { id: 8, status: 'queued' } }) });
    const card = new FakeEl('', {}, (sel) => sel === '[data-card="task"]');
    const btn = onCard(new FakeEl('开始', { apiClick: '/api/tasks/8/start', done: '已开始 ✓' }), card);

    await click(ctx, btn);
    assert.equal(card.has('card-done'), false, '排队中的卡不该淡出');
    assert.equal(ctx.reloads, 1);
  });

  test('样式表里 card-done 就是划线 + 淡出，减少动态效果时不放过渡', () => {
    const rule = CSS.slice(CSS.indexOf('.card.card-done'));
    assert.ok(rule.length > 0, '样式表里要有 .card.card-done');
    assert.match(rule, /opacity: 0/, '整卡淡出');
    assert.match(rule, /\.card\.card-done \.card-title \{[^}]*line-through/, '标题划线');
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{ \.card\.card-done \{ transition: none;/);
  });
});

describe('038 C · 状态胶囊只闪变了的那几个', () => {
  const pill = (status: string) => new FakeEl(status, { status });

  test('上一页记的是 done/running，这一页 done/failed：只有第二个加 .status-changed', () => {
    const pills = [pill('done'), pill('failed')];
    boot({ pills, seen: ['done', 'running'] });
    assert.equal(pills[0].has('status-changed'), false, '没变的不许闪');
    assert.equal(pills[1].has('status-changed'), true);
  });

  test('第一次打开（没有记录）：一个都不闪，只把现状记下来', () => {
    const pills = [pill('done'), pill('running')];
    const ctx = boot({ pills });
    assert.equal(pills.some((p) => p.has('status-changed')), false);
    assert.equal(ctx.store.get('wb-status-seen'), JSON.stringify(['done', 'running']));
  });

  test('数量变了（换了筛选、任务增删）：干脆都不闪，免得一屏乱闪', () => {
    const pills = [pill('done')];
    boot({ pills, seen: ['done', 'running', 'failed'] });
    assert.equal(pills[0].has('status-changed'), false);
  });
});

// ---------- 1b. 038.1 自动刷新要给「请求 / 成功态」让路 ----------

/** 触发一次 visibilitychange：app.js 用它立刻跑一遍 poll（和 8 秒定时器同一个入口）。 */
const poke = async (ctx: Ctx) => { await ctx.handlers.visibilitychange[0](); };

describe('038.1 · 自动刷新不打断请求与成功态', () => {
  test('请求还没回来时 pulse 变了：不许刷新', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let v = 'v1';
    const ctx = boot({ respond: async () => { await gate; return { ok: true, data: {} }; }, pulse: () => v });
    await tick(5);
    const btn = new FakeEl('开始', { apiClick: '/api/tasks/7/start', done: '已开始 ✓' });
    const run = click(ctx, btn);
    v = 'v2';
    await tick();
    await poke(ctx);
    assert.equal(ctx.reloads, 0, '请求在路上就刷新，等于把「处理中」白做');
    release();
    await run;
    assert.equal(ctx.reloads, 1, '跑完之后照旧刷新');
  });

  test('高风险成功后 1.5 秒内 pulse 变了：完成话留得住，停够才刷', async () => {
    let v = 'v1';
    const ctx = boot({ pulse: () => v });
    await tick(5);
    const btn = new FakeEl('批准', { apiClick: '/api/approvals/9/decide', risk: 'high', done: '已批准合并 ✓' });
    const run = click(ctx, btn);
    await tick();
    assert.equal(btn.textContent, '已批准合并 ✓');
    v = 'v2';
    await tick(31);
    await poke(ctx);
    assert.equal(ctx.reloads, 0, '1.5 秒没到就被刷，等于没让人看清批了什么');
    await tick(200);
    await poke(ctx);
    assert.equal(ctx.reloads, 0, '还在停留期');
    await run;
    assert.equal(ctx.reloads, 1, '停够了照旧刷新');
  });

  test('失败之后轮询恢复：没有成功态要保护，pulse 一变就刷', async () => {
    let v = 'v1';
    const ctx = boot({ respond: () => ({ ok: false, status: 409, data: { error: '已经批过了' } }), pulse: () => v });
    await tick(5);
    const btn = new FakeEl('批准', { apiClick: '/api/approvals/9/decide', done: '已批准 ✓' });
    await click(ctx, btn);
    v = 'v2';
    await poke(ctx);
    assert.equal(ctx.reloads, 1, '失败没有成功态，不该被扣住');
  });
});

// ---------- 1c. 038.2 已经发出去的 pulse，回来时也得再判一次 ----------
//
// 038.1 只在 poll 入口判「要不要让路」。可 pulse 是几毫秒前发出去的：响应回来时，
// 人可能刚点了「批准合并」，成功态正停在屏幕上——原来的写法这时候直接 reload，
// 1.5 秒白留。复审用 31ms 这个时间点复现过。

describe('038.2 · 先发出去的 pulse，回来时也让路', () => {
  /** 造一道闸门：pulse 的响应停在闸门上，由用例决定什么时候放行。 */
  function gatePulse() {
    let release!: () => void;
    let gate: Promise<void> | null = null;
    const arm = () => { gate = new Promise<void>((r) => { release = r; }); };
    return { arm, release: () => release(), hold: () => gate };
  }

  test('poll 先发出 → 按钮后点 → 响应在成功态里回来：不刷新，停够再看变化', async () => {
    const g = gatePulse();
    let v = 'v1';
    const ctx = boot({ pulse: () => v, pulseHold: g.hold });
    await tick(5); // 第一次 poll 建立版本（闸门还没架）

    v = 'v2';
    g.arm();
    const p = poke(ctx); // 这一次 poll 发出去了，响应挂在闸门上
    await tick(5);

    const btn = new FakeEl('批准', { apiClick: '/api/approvals/9/decide', risk: 'high', done: '已批准合并 ✓' });
    const run = click(ctx, btn);
    await tick();
    assert.equal(btn.textContent, '已批准合并 ✓');

    g.release(); // 成功之后 31ms 左右，旧的那次 pulse 回来了
    await tick(31);
    await p;
    assert.equal(ctx.reloads, 0, '响应回来时成功态还在，刷掉等于白留那 1.5 秒');

    await run; // 按钮自己停够 1.5 秒后刷新
    assert.equal(ctx.reloads, 1, '停够了照旧刷新');
    await tick(200);
    assert.equal(ctx.reloads, 1, '不能补刷成两次');
  });

  test('poll 先发出 → 按钮请求还没回来 → 响应先回来：仍然不刷', async () => {
    const g = gatePulse();
    let openButton!: () => void;
    const buttonGate = new Promise<void>((r) => { openButton = r; });
    let v = 'v1';
    const ctx = boot({
      pulse: () => v, pulseHold: g.hold,
      respond: async () => { await buttonGate; return { ok: true, data: {} }; },
    });
    await tick(5);

    v = 'v2';
    g.arm();
    const p = poke(ctx);
    await tick(5);

    const btn = new FakeEl('开始', { apiClick: '/api/tasks/7/start', done: '已开始 ✓' });
    const run = click(ctx, btn);
    await tick();

    g.release(); // pulse 先回来，按钮还挂着
    await tick(20);
    await p;
    assert.equal(ctx.reloads, 0, '请求还在路上就刷新，等于把「处理中」白做');
    assert.equal(btn.textContent, '处理中…');

    openButton();
    await run;
    assert.equal(ctx.reloads, 1);
  });

  test('先发出的 poll 撞上失败（没有成功态）：该刷就刷，别误伤', async () => {
    const g = gatePulse();
    let v = 'v1';
    const ctx = boot({
      pulse: () => v, pulseHold: g.hold,
      respond: () => ({ ok: false, status: 409, data: { error: '已经批过了' } }),
    });
    await tick(5);

    v = 'v2';
    g.arm();
    const p = poke(ctx);
    await tick(5);
    await click(ctx, new FakeEl('批准', { apiClick: '/api/approvals/9/decide', done: '已批准 ✓' }));

    g.release();
    await tick(20);
    await p;
    assert.equal(ctx.reloads, 1, '失败没有成功态要保护，pulse 一变就该刷');
  });

  test('后一次的短停留不许把前一次的高风险停留缩短', async () => {
    let v = 'v1';
    const ctx = boot({ pulse: () => v });
    await tick(5);

    const risky = new FakeEl('批准', { apiClick: '/api/approvals/9/decide', risk: 'high', done: '已批准合并 ✓' });
    const run = click(ctx, risky);
    await tick(50); // 高风险成功，停留到期时刻 = 现在 + 1500ms 左右

    // 又点了一个跳转类按钮：它的停留是 0，不能把上面那 1.5 秒抹掉
    const jump = new FakeEl('看任务', { apiClick: '/api/tasks/7/start', redirect: '/tasks?task=7' });
    await click(ctx, jump);

    v = 'v2';
    await tick(200);
    await poke(ctx);
    assert.equal(ctx.reloads, 0, '后面这个 0 秒停留不该把高风险的 1.5 秒缩短');

    await run;
    assert.equal(ctx.reloads, 1);
  });
});

// ---------- 2. 样式表 ----------

const section038 = CSS.slice(CSS.indexOf('/* ---------- 038'));

const durations = (text: string) => {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:transition|animation)(?:-duration)?\s*:\s*([^;}]+)/g)) {
    for (const d of m[1].matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
      out.push(d[2] === 's' ? Number(d[1]) * 1000 : Number(d[1]));
    }
  }
  return out;
};

describe('038 · 样式表守则', () => {
  // 044（用户 2026-11-03）：动效按体感调，0.2 秒上限作废；只检查 038 这一段还在、确实有过渡。
  test('038 这一段还在，确实有过渡', () => {
    assert.ok(section038.length > 200, '样式表里要有 038 这一段');
    assert.ok(durations(section038).length >= 4, '至少要有几处过渡');
  });

  test('「减少动态效果」时这些都关掉（全局那条 + 038 自己再写一遍）', () => {
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*transition: none !important; animation: none !important/);
    const own = section038.slice(section038.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(own, /transition: none/);
    assert.match(own, /animation: none/);
  });

  test('该有的三条规则都在：按钮完成态、状态胶囊、折叠区/抽屉', () => {
    assert.match(section038, /\.btn\[aria-busy="true"\]/);
    assert.match(section038, /\.btn\.is-done/);
    assert.match(section038, /\.status \{ transition: background-color 200ms/);
    assert.match(section038, /\.status\.status-changed \{ animation: status-shift 200ms/);
    assert.match(section038, /details::details-content/);
    assert.match(section038, /\.drawer \{ animation: drawer-in 200ms/);
  });

  test('折叠区的过渡只在真的点开时才放（打开页面不算）', () => {
    assert.match(section038, /details\.just-opened > \*:not\(summary\)/);
    assert.match(APP_JS, /addEventListener\('toggle'/);
  });
});

describe('038 · 没有破坏老规矩', () => {
  test('不引外部库、不新增依赖', () => {
    assert.equal(/https?:\/\//.test(APP_JS.replace(/127\.0\.0\.1/g, '')), false, 'app.js 里不该出现外链');
    assert.equal(/import\s+.*from|require\(/.test(APP_JS), false, '还是零依赖的一个脚本');
  });
});

// ---------- 3. 页面上真的带上了这些属性 ----------

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  const { handle } = await import('../src/app.ts');
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { server.close(); });

beforeEach(async () => {
  cookie = await loginCookie(base, process.env.WB_PASSWORD!);
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

describe('038 · 页面上的属性', () => {
  test('任务卡上的「开始」带 data-done，状态胶囊带 data-status', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '038 验收', executor: 'me' }) });
    assert.equal(t.status, 201, t.text);
    const page = await api(`/tasks?task=${t.json.id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-status="inbox"|data-status="queued"/, '胶囊要带上状态本身');
    assert.match(page.text, /data-done="已开始 ✓"/, '开始按钮的完成话');
  });

  test('合并审批的「批准」带 data-risk=high，完成话里有动作名', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '038 合并验收', executor: 'me' }) });
    const a = await api('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({ title: `合并 wb/T-${t.json.id} 到 main`, tool_name: 'git merge', risk: 'medium', task_id: t.json.id }),
    });
    assert.equal(a.status, 201, a.text);
    const page = await api(`/tasks?task=${t.json.id}`); // 044 v3：带任务的审批在详情里批
    assert.equal(page.status, 200);
    assert.match(page.text, /data-done="已批准合并 ✓"/);
    assert.match(page.text, /data-risk="high"/);
  });

  test('推送、部署各说各的动作名', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '038 推送验收', executor: 'me' }) });
    for (const [tool, word] of [['git push', '推送'], ['docker compose', '部署']] as const) {
      const a = await api('/api/approvals', {
        method: 'POST',
        body: JSON.stringify({ title: `审批 ${tool}（T-${t.json.id}）`, tool_name: tool, risk: 'medium', task_id: t.json.id }),
      });
      assert.equal(a.status, 201, a.text);
      const page = await api(`/tasks?task=${t.json.id}`); // 044 v3：带任务的审批在详情里批
      assert.ok(page.text.includes(`data-done="已批准${word} ✓"`), `${tool} 的完成话里要有「${word}」`);
    }
  });

  test('普通审批（低风险）不加 high，成功话就是「已批准」', async () => {
    const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '038 普通审批', executor: 'me' }) });
    await api('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({ title: '跑一条命令', tool_name: 'bash', risk: 'high', task_id: t.json.id }),
    });
    const page = await api(`/tasks?task=${t.json.id}`); // 044 v3：带任务的审批在详情里批
    assert.ok(page.text.includes('data-done="已批准高风险操作 ✓"'), '高风险但工具未知时也要带上一句人话');
  });
});
