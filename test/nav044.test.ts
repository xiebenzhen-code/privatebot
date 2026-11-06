// 044.1 / 044.2：局部换页。
//   044.1 换页之后新页面上的交互要和「直接打开」一样能用（项目选择器、推荐执行者、账号类型…），
//         旧页的「脏」标记、补刷计划不能带到新页。
//   044.2 最后一次点的算数：旧请求、过时的自动刷新、被视图过渡推迟的那一步都不许覆盖它。
//
// 这里跑的是真的 public/app.js，只是 DOM 换成一个能解析「页面」、能记历史的小替身，
// 而且 DOMParser / history / URL 都在——不能再用会提前跳过换页逻辑的旧假 DOM。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_JS = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
const TASK_FORM_SEL = 'form[data-api="/api/tasks"], form[data-api^="/api/tasks?"]';

type Handler = (ev: any) => any;

// ---------- 替身节点 ----------

function makeEl(sels: string[], props: Record<string, any> = {}): any {
  const attrs: Record<string, string> = {};
  const el: any = {
    dataset: {}, hidden: false, disabled: false, value: '', textContent: '', isConnected: true, options: [], open: false,
    kids: {} as Record<string, any>, lists: {} as Record<string, any[]>, up: {} as Record<string, any>, byId: {} as Record<string, any>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    matches: (s: string) => sels.includes(s),
    closest: (s: string) => (sels.includes(s) ? el : (el.up[s] ?? null)),
    setAttribute: (k: string, v: unknown) => { attrs[k] = String(v); },
    getAttribute: (k: string) => attrs[k] ?? null,
    removeAttribute: (k: string) => { delete attrs[k]; },
    hasAttribute: (k: string) => k in attrs,
    querySelector: (s: string) => el.kids[s] ?? null,
    querySelectorAll: (s: string) => el.lists[s] ?? [],
    focus() {}, replaceWith() {},
    ...props,
  };
  return el;
}

type PageOpts = { picker?: boolean; taskForm?: boolean; kind?: boolean; openDetails?: boolean };
type Built = { title: string; main: any; nav: any; status: any; pick?: any; other?: any; custom?: any; exec?: any; cat?: any; hint?: any; kind?: any; voucher?: any; themeBtn?: any };

const SHAPES: Record<string, PageOpts> = {
  today: {}, tasks: {}, team: {}, data: {},
  newtask: { picker: true, taskForm: true },
  accounts: { kind: true },
  settings: { kind: false },
};

function buildPage(name: string): Built {
  const o = SHAPES[name] ?? {};
  const main = makeEl(['main.main'], { name });
  const nav = makeEl(['nav'], { name });
  const status = makeEl(['status'], { name });
  const b: Built = { title: `${name} · 我的工作台`, main, nav, status };
  b.themeBtn = makeEl(['[data-theme-toggle]']);
  main.lists['[data-theme-toggle]'] = [b.themeBtn];
  if (o.picker) {
    const form = makeEl(['form']);
    b.custom = makeEl(['input'], { value: 'x' });
    b.other = makeEl([], { hidden: true, kids: { 'input[name="project_custom"]': b.custom } });
    form.kids['[data-project-other]'] = b.other;
    b.pick = makeEl(['[data-project-pick]'], { value: 'demo', up: { form } });
    b.custom.disabled = false;
    main.lists['[data-project-pick]'] = [b.pick];
  }
  if (o.taskForm) {
    const form = makeEl([TASK_FORM_SEL]);
    b.exec = makeEl(['select[name="executor"]'], { value: 'claude', options: [{ value: 'claude' }, { value: 'pool' }], up: { [TASK_FORM_SEL]: form } });
    b.cat = makeEl(['select[name="category"]'], { value: 'dev', up: { [TASK_FORM_SEL]: form } });
    form.kids['select[name="executor"]'] = b.exec;
    form.kids['select[name="category"]'] = b.cat;
    b.hint = makeEl([], { hidden: true });
    main.kids[TASK_FORM_SEL] = form;
    main.kids['[data-suggest-hint]'] = b.hint;
  }
  if (o.kind) {
    const voucher = makeEl(['.voucher-fields'], { classes: new Set<string>() });
    voucher.classList = {
      add(c: string) { voucher.classes.add(c); }, remove(c: string) { voucher.classes.delete(c); },
      toggle(c: string, on: boolean) { if (on) voucher.classes.add(c); else voucher.classes.delete(c); }, contains: (c: string) => voucher.classes.has(c),
    };
    const form = makeEl(['form'], { kids: { '.voucher-fields': voucher } });
    b.kind = makeEl(['select[name="kind"]'], { value: 'window', up: { form } });
    b.voucher = voucher;
    main.lists['select[name="kind"]'] = [b.kind];
  }
  return b;
}

// ---------- 一个页面：真 app.js + 小替身 ----------

type Req = { url: string; deliver: (page: string, finalUrl?: string) => void; fail: () => void; aborted: boolean };

function boot(start: string, opts: { transitions?: boolean; ignoreAbort?: boolean; pulse?: () => string; suggest?: () => { executor: string; reason: string } } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const winHandlers: Record<string, Handler[]> = {};
  const origin = 'http://wb.test';
  const loc: any = {
    href: origin + start, pathname: '', search: '', hash: '', origin,
    reload() { state.reloads += 1; },
  };
  const setLoc = (u: string) => {
    const url = new URL(u, origin);
    loc.href = url.href; loc.pathname = url.pathname; loc.search = url.search; loc.hash = url.hash;
  };
  setLoc(start);
  const initial = start.replace(/^\//, '').split(/[/?]/)[0] || 'today';
  const doc: any = { cur: buildPage(initial), title: '' };
  const toast = makeEl(['#toast']);
  const store = new Map<string, string>();
  const reqs: Req[] = [];
  const state = {
    reloads: 0, reqs, toast, doc, loc, store, pulseCalls: 0,
    entries: [origin + start] as string[],
    transitionQueue: [] as (() => void)[],
    suggestCalls: 0,
  };

  // 替身 main 被换掉：旧节点标记为断开，新节点接上。
  const attachMain = (next: any) => { doc.cur.main.isConnected = false; next.isConnected = true; };
  const document: any = {
    body: { getAttribute: () => null },
    hidden: false, activeElement: null,
    documentElement: makeEl(['html'], { dataset: {} as Record<string, string>, classList: { add() {}, remove() {} } }),
    cookie: '',
    addEventListener: (t: string, fn: Handler) => { (handlers[t] ??= []).push(fn); },
    dispatchEvent: (ev: any) => { for (const h of handlers[ev.type] ?? []) h(ev); },
    getElementById: (id: string) => (id === 'toast' ? toast : (doc.cur.main.byId[id] ?? null)),
    querySelector: (s: string) => {
      if (s === 'main.main') return doc.cur.main;
      if (s === '#wb-side .nav') return doc.cur.nav;
      if (s === '#wb-side .side-status') return doc.cur.status;
      return doc.cur.main.kids[s] ?? null;
    },
    querySelectorAll: (s: string) => doc.cur.main.lists[s] ?? [],
    startViewTransition: opts.transitions ? (cb: () => void) => { state.transitionQueue.push(cb); } : undefined,
  };
  // main.replaceWith(next)：真的把当前页换成 next 对应的页面对象（nextMain 带着自己那一页）。
  const swapIn = (nextMain: any) => {
    attachMain(nextMain);
    doc.cur = nextMain.page;
  };
  class DOMParserStub {
    parseFromString(text: string) {
      const { page } = JSON.parse(text) as { page: string };
      const b = buildPage(page);
      b.main.page = b; b.main.replaceWith = () => {};
      return {
        title: b.title,
        querySelector: (s: string) => (s === 'main.main' ? b.main : s === '#wb-side .nav' ? b.nav : s === '#wb-side .side-status' ? b.status : null),
      };
    }
  }
  // 让「当前 main.replaceWith(next)」生效：每个 main 创建后都挂上这个行为。
  const origBuild = buildPage;
  void origBuild;
  const wireCurrent = () => {
    doc.cur.main.page = doc.cur;
    doc.cur.main.replaceWith = swapIn;
    doc.cur.nav.replaceWith = () => {};
    doc.cur.status.replaceWith = () => {};
  };
  wireCurrent();
  // 每次换页后重新挂行为
  document.addEventListener('wb:page', wireCurrent);

  const history = {
    state: null as any,
    pushState(s: any, _t: string, u: string) { history.state = s; setLoc(u); state.entries.push(loc.href); },
    replaceState(s: any, _t: string, u?: string) { history.state = s; if (u) { setLoc(u); state.entries[state.entries.length - 1] = loc.href; } },
  };

  const fetchStub = (url: string, init: any = {}) => {
    if (url.includes('/api/pulse')) {
      state.pulseCalls += 1;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ v: opts.pulse?.() ?? 'v1' }) });
    }
    if (url.includes('/api/dispatch/suggest')) {
      state.suggestCalls += 1;
      const s = opts.suggest?.() ?? { executor: 'pool', reason: '这类活它最拿手' };
      return Promise.resolve({ ok: true, status: 200, json: async () => s });
    }
    return new Promise((resolve, reject) => {
      const req: Req = {
        url, aborted: false,
        deliver: (page, finalUrl) => resolve({
          url: finalUrl ?? url,
          headers: { get: () => 'text/html; charset=utf-8' },
          text: async () => JSON.stringify({ page }),
        }),
        fail: () => reject(new Error('offline')),
      };
      if (!opts.ignoreAbort) init.signal?.addEventListener?.('abort', () => { req.aborted = true; const e: any = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      reqs.push(req);
    });
  };

  const win: any = {
    addEventListener: (t: string, fn: Handler) => { (winHandlers[t] ??= []).push(fn); },
    history, scrollY: 0, scrollTo() {}, confirm: () => true,
  };
  const ctx = vm.createContext({
    document, location: loc, history, window: win, fetch: fetchStub,
    URL, URLSearchParams, DOMParser: DOMParserStub, AbortController,
    CustomEvent: class { type: string; detail: any; constructor(t: string, i: any) { this.type = t; this.detail = i?.detail; } },
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    navigator: {},
    HTMLFormElement: class {}, HTMLDetailsElement: class {}, HTMLInputElement: class {},
    FormData: class { entries() { return [][Symbol.iterator](); } },
    setTimeout, clearTimeout, setInterval: () => 0, JSON, Promise, Array, Object, String, Math, console, Set, WeakSet,
  });
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
  // 不能用展开：reloads / suggestCalls 是数字，展开会把它们定格在这一刻。
  return Object.assign(state, { handlers, winHandlers, history, document, win });
}

type Page = ReturnType<typeof boot>;

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 点一个站内链接：走 document 上登记的所有 click 处理器，和浏览器一样。 */
function clickLink(p: Page, href: string) {
  const a: any = makeEl(['a[href]'], { target: undefined, dataset: {} });
  a.getAttribute = (k: string) => (k === 'href' ? href : null);
  const ev: any = { target: a, button: 0, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
  for (const h of p.handlers.click ?? []) h(ev);
  return ev;
}
const changeOn = (p: Page, target: any) => { for (const h of p.handlers.change ?? []) h({ target }); };
const typeInto = (p: Page) => { for (const h of p.handlers.input ?? []) h({}); };
const popstate = (p: Page) => { for (const h of p.winHandlers.popstate ?? []) h({}); };
const poll = async (p: Page) => { await p.handlers.visibilitychange[0](); await flush(); };
const nameOf = (p: Page) => p.doc.cur.name ?? p.doc.cur.main.name;

// ---------- 044.2 最后一次点的算数 ----------

describe('044.2 · 旧响应不覆盖最后一次选择', () => {
  test('先点团队再点任务，任务先回、团队后回：停在任务，地址也是任务', async () => {
    const p = boot('/');
    clickLink(p, '/team');
    clickLink(p, '/tasks');
    assert.equal(p.reqs.length, 2);
    p.reqs[1].deliver('tasks');
    await flush();
    assert.equal(nameOf(p), 'tasks');
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(nameOf(p), 'tasks', '旧响应回来也不能把内容换回去');
    assert.match(p.loc.pathname, /^\/tasks$/);
    assert.deepEqual(p.entries.map((u) => new URL(u).pathname), ['/', '/tasks'], '历史里没有被丢掉的那一页');
  });

  // 取消只是省流量；真正兜底的是编号。响应已经在路上、取消不及时（或浏览器没有 AbortController）时同样要对。
  test('即使取消没生效（响应照样回来），旧响应也不覆盖最后一次选择', async () => {
    const p = boot('/', { ignoreAbort: true });
    clickLink(p, '/team');
    clickLink(p, '/tasks');
    p.reqs[1].deliver('tasks');
    await flush();
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(nameOf(p), 'tasks');
    assert.equal(p.loc.pathname, '/tasks');
    assert.deepEqual(p.entries.map((u) => new URL(u).pathname), ['/', '/tasks']);
  });

  test('即使取消没生效，迟到的自动刷新也不覆盖手动导航', async () => {
    let v = 'v1';
    const p = boot('/tasks', { ignoreAbort: true, pulse: () => v });
    await poll(p);
    v = 'v2';
    await poll(p);
    clickLink(p, '/team');
    p.reqs[1].deliver('team');
    await flush();
    p.reqs[0].deliver('tasks');
    await flush();
    assert.equal(nameOf(p), 'team');
    assert.equal(p.loc.pathname, '/team');
  });

  test('旧响应先到、新响应后到：旧的也不能闪一下再被换掉（只有最后一次生效）', async () => {
    const p = boot('/', { ignoreAbort: true });
    clickLink(p, '/team');
    clickLink(p, '/tasks');
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(nameOf(p), 'today', '旧的先到，也不该显示');
    p.reqs[1].deliver('tasks');
    await flush();
    assert.equal(nameOf(p), 'tasks');
    assert.deepEqual(p.entries.map((u) => new URL(u).pathname), ['/', '/tasks']);
  });

  test('点了第二个链接，第一个请求被取消', async () => {
    const p = boot('/');
    clickLink(p, '/team');
    clickLink(p, '/tasks');
    assert.equal(p.reqs[0].aborted, true);
    assert.equal(p.reqs[1].aborted, false);
  });

  test('被取消的请求不会退化成整页跳转', async () => {
    const p = boot('/');
    clickLink(p, '/team');
    clickLink(p, '/tasks');
    await flush();
    p.reqs[1].deliver('tasks');
    await flush();
    assert.equal(p.loc.pathname, '/tasks');
    assert.equal(p.reloads, 0);
  });

  test('自动刷新在路上时点了别的页：刷新结果丢掉，不把地址或内容改回去', async () => {
    let v = 'v1';
    const p = boot('/tasks', { pulse: () => v });
    await poll(p); // 记下基线
    v = 'v2';
    await poll(p); // pulse 变了 → 发出刷新
    assert.equal(p.reqs.length, 1, '刷新请求发出去了');
    clickLink(p, '/team');
    assert.equal(p.reqs.length, 2);
    p.reqs[1].deliver('team');
    await flush();
    assert.equal(nameOf(p), 'team');
    p.reqs[0].deliver('tasks'); // 迟到的刷新
    await flush();
    assert.equal(nameOf(p), 'team', '过时的刷新不许把页面换回任务页');
    assert.equal(p.loc.pathname, '/team');
  });

  test('手动导航在路上时，自动刷新根本不发', async () => {
    let v = 'v1';
    const p = boot('/tasks', { pulse: () => v });
    await poll(p);
    clickLink(p, '/team');
    v = 'v2';
    await poll(p);
    assert.equal(p.reqs.length, 1, '只有那一个导航请求');
  });

  test('做完一件事后的刷新（必刷）发出去之后又点了别的页：刷新结果丢掉', async () => {
    const p = boot('/tasks');
    p.win.wbReload();
    assert.equal(p.reqs.length, 1);
    clickLink(p, '/team');
    p.reqs[1].deliver('team');
    await flush();
    p.reqs[0].deliver('tasks');
    await flush();
    assert.equal(nameOf(p), 'team');
    assert.equal(p.loc.pathname, '/team');
  });

  test('做完一件事连着两次刷新：后发的算数，先发的被取消', async () => {
    const p = boot('/tasks');
    p.win.wbReload();
    p.win.wbReload();
    assert.equal(p.reqs.length, 2);
    assert.equal(p.reqs[0].aborted, true);
    p.reqs[1].deliver('team'); // 内容是什么无所谓，只看谁生效
    await flush();
    assert.equal(nameOf(p), 'team');
    p.reqs[0].deliver('data');
    await flush();
    assert.equal(nameOf(p), 'team');
  });

  test('视图过渡把换内容推迟到下一帧：这期间又点了别的页，旧的那一步作废', async () => {
    const p = boot('/', { transitions: true });
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(p.transitionQueue.length, 1, '换内容被排进了过渡');
    clickLink(p, '/tasks');
    p.reqs[1].deliver('tasks');
    await flush();
    assert.equal(p.transitionQueue.length, 2);
    // 浏览器按顺序执行过渡回调：先旧后新
    p.transitionQueue[0]();
    assert.equal(nameOf(p), 'today', '旧的那一步不能生效');
    assert.equal(p.entries.length, 1);
    p.transitionQueue[1]();
    assert.equal(nameOf(p), 'tasks');
    assert.equal(p.loc.pathname, '/tasks');
    assert.deepEqual(p.entries.map((u) => new URL(u).pathname), ['/', '/tasks']);
  });

  test('后退：回到上一页时，还在路上的前进请求不能再把页面带回去', async () => {
    const p = boot('/');
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(nameOf(p), 'team');
    clickLink(p, '/tasks'); // 在路上
    // 浏览器后退：地址先回到 /，再触发 popstate
    p.history.state = { wb: 1, y: 120 };
    (p as any).loc.href = 'http://wb.test/'; (p as any).loc.pathname = '/'; (p as any).loc.search = '';
    popstate(p);
    assert.equal(p.reqs[1].aborted, true, '前进请求被取消');
    p.reqs[2].deliver('today');
    await flush();
    p.reqs[1].deliver('tasks'); // 就算它迟到
    await flush();
    assert.equal(nameOf(p), 'today');
  });

  test('请求失败（离线）才退回整页跳转，而且只在它还是最后一次选择时', async () => {
    const p = boot('/');
    clickLink(p, '/team');
    p.reqs[0].fail();
    await flush();
    assert.ok(String(p.loc.href).endsWith('/team'), '最后一次选择失败：交给浏览器');
    const q = boot('/');
    clickLink(q, '/team');
    clickLink(q, '/tasks');
    q.reqs[0].fail(); // 已经过时的那个失败，不该动地址
    await flush();
    assert.ok(String(q.loc.href).endsWith('/'), '过时请求失败不许跳转');
  });
});

// ---------- 044.1 换页后交互和直接打开一致 ----------

describe('044.1 · 局部进入 = 直接打开', () => {
  const chooseOther = (p: Page) => {
    const pick = p.doc.cur.pick;
    pick.value = '__other';
    changeOn(p, pick);
    return p.doc.cur;
  };

  test('直接打开新建任务：选「其他」后输入可见、可填、字段名换成 project_pick', () => {
    const p = boot('/newtask');
    const cur = chooseOther(p);
    assert.equal(cur.other.hidden, false);
    assert.equal(cur.custom.disabled, false);
    assert.equal(cur.pick.getAttribute('name'), 'project_pick');
  });

  test('从别的页局部切到新建任务：同样的操作得到同样的结果', async () => {
    const p = boot('/');
    clickLink(p, '/newtask');
    p.reqs[0].deliver('newtask');
    await flush();
    assert.equal(nameOf(p), 'newtask');
    // 刚换进来：和直接打开一样，输入先藏着、字段名是 project
    assert.equal(p.doc.cur.other.hidden, true);
    assert.equal(p.doc.cur.custom.disabled, true);
    assert.equal(p.doc.cur.pick.getAttribute('name'), 'project');
    const cur = chooseOther(p);
    assert.equal(cur.other.hidden, false, '选「其他」后输入要出现——这是 044.1 当时坏的地方');
    assert.equal(cur.custom.disabled, false);
    assert.equal(cur.pick.getAttribute('name'), 'project_pick');
  });

  test('再换走再换回来，不会叠出两份处理（选一次其他只生效一次）', async () => {
    const p = boot('/newtask');
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    clickLink(p, '/newtask');
    p.reqs[1].deliver('newtask');
    await flush();
    const cur = chooseOther(p);
    assert.equal(cur.other.hidden, false);
    cur.pick.value = 'demo';
    changeOn(p, cur.pick);
    assert.equal(cur.other.hidden, true);
    assert.equal(cur.custom.disabled, true);
  });

  test('新建任务：换页后按分类重新问一次推荐执行者，并写出理由', async () => {
    const p = boot('/');
    clickLink(p, '/newtask');
    p.reqs[0].deliver('newtask');
    await flush(); await flush();
    assert.equal(p.suggestCalls, 1);
    assert.equal(p.doc.cur.exec.value, 'pool');
    assert.match(p.doc.cur.hint.textContent, /这类活它最拿手/);
    assert.equal(p.doc.cur.hint.hidden, false);
  });

  test('用户自己改过执行者，之后换分类不再替他改；换到新表单后又从头开始', async () => {
    const p = boot('/newtask');
    await flush(); await flush();
    const cur = p.doc.cur;
    cur.exec.value = 'claude';
    changeOn(p, cur.exec); // 手动选的
    changeOn(p, cur.cat);
    await flush(); await flush();
    assert.equal(cur.exec.value, 'claude', '他选了就别替他改');
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    clickLink(p, '/newtask');
    p.reqs[1].deliver('newtask');
    await flush(); await flush();
    assert.equal(p.doc.cur.exec.value, 'pool', '新表单是新的一次，不继承旧的「已动过」');
  });

  test('账号类型：局部进入后切到「余额」会露出凭证字段', async () => {
    const p = boot('/');
    clickLink(p, '/accounts');
    p.reqs[0].deliver('accounts');
    await flush();
    const cur = p.doc.cur;
    cur.kind.value = 'balance';
    changeOn(p, cur.kind);
    assert.equal(cur.voucher.classList.contains('on'), true);
  });

  test('主题按钮：每次换页后文字和 aria-pressed 跟着当前主题', async () => {
    const p = boot('/');
    assert.equal(p.doc.cur.themeBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(p.doc.cur.themeBtn.getAttribute('aria-label'), '切换到深色');
    (p.document as any).documentElement.dataset.theme = 'dark';
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(p.doc.cur.themeBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(p.doc.cur.themeBtn.getAttribute('aria-label'), '切换到浅色');
  });

  test('做完一件事留下的提示，换页之后照样出现（以前只在整页刷新时才读）', async () => {
    const p = boot('/');
    p.store.set('wb-toast', '已批准');
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(p.toast.textContent, '已批准');
    assert.equal(p.store.has('wb-toast'), false);
  });
});

describe('044.1 · 旧页的状态不带到新页', () => {
  test('在旧页输入过（脏）→ 手动换页后，自动刷新恢复正常', async () => {
    let v = 'v1';
    const p = boot('/newtask', { pulse: () => v });
    await poll(p);
    typeInto(p);
    v = 'v2';
    await poll(p);
    assert.equal(p.reqs.length, 0, '正在输入时不刷新');
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    v = 'v3';
    await poll(p);
    assert.equal(p.reqs.length, 2, '换页后不再被旧页的输入拦着，该刷新就刷新');
  });

  test('补刷计划（pendingReload）换页后作废，不会在新页上突然补刷', async () => {
    let v = 'v1';
    const p = boot('/newtask', { pulse: () => v });
    await poll(p);
    typeInto(p);
    v = 'v2';
    await poll(p); // 变了但在输入 → 记下「待补刷」
    clickLink(p, '/team');
    p.reqs[0].deliver('team');
    await flush();
    await poll(p); // 版本没再变；旧的补刷计划若还在，这里会发刷新
    assert.equal(p.reqs.length, 1, '只有那一次导航，没有多出来的刷新');
  });

  test('自动刷新回来的那一刻刚好开始输入：这次刷新不换内容，留着等安全了再补', async () => {
    let v = 'v1';
    const p = boot('/tasks', { pulse: () => v });
    await poll(p);
    v = 'v2';
    await poll(p);
    assert.equal(p.reqs.length, 1);
    typeInto(p); // 响应在路上，人开始打字
    p.reqs[0].deliver('team');
    await flush();
    assert.equal(nameOf(p), 'tasks', '输入的东西不能被刷掉');
  });
});

describe('044.1 · 其它出口', () => {
  test('只带哈希的页内链接不接管', async () => {
    const p = boot('/settings');
    const ev = clickLink(p, '/settings#backup');
    assert.equal(ev.defaultPrevented, false);
    assert.equal(p.reqs.length, 0);
  });

  test('api / 静态资源 / 登出 的链接不接管', async () => {
    const p = boot('/');
    for (const h of ['/api/events.csv', '/static/app.js', '/logout']) {
      assert.equal(clickLink(p, h).defaultPrevented, false, h);
    }
    assert.equal(p.reqs.length, 0);
  });

  test('被重定向到登录页：整页跳转，不显示登录页的碎片', async () => {
    const p = boot('/');
    clickLink(p, '/team');
    p.reqs[0].deliver('team', 'http://wb.test/login');
    await flush();
    assert.ok(String(p.loc.href).includes('/login'));
    assert.equal(nameOf(p), 'today');
  });

  test('不接管时（老浏览器没有 DOMParser）链接照旧整页跳转', () => {
    const src = APP_JS;
    assert.match(src, /typeof DOMParser === 'function'/);
    assert.match(src, /const canSwap = /);
  });
});
