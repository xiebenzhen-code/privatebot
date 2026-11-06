// 038.3：自动补刷不能把没保存的输入冲掉。
//
// 038.2 修好了「成功态别被刷掉」，但补刷那条路（flushPending / poll 的 pendingReload 分支）
// 只看了 holding，绕过了输入保护。审查给的真实顺序是：
//   版本变了 → 恰好在等按钮响应（holding）→ 补刷排队 → 你在输入框里打字 → 按钮失败 → 补刷执行。
// 这一组就照这个顺序跑真 app.js（假 DOM、假接口），断言「一个刷新都没发生」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(import.meta.dirname, '..');
const APP_JS = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

class El {
  textContent: string;
  dataset: Record<string, string>;
  disabled = false;
  style: Record<string, string> = {};
  className = '';
  name = '';
  value = '';
  tagName = 'BUTTON';
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
    return { add: (c: string) => s.add(c), remove: (c: string) => s.delete(c), contains: (c: string) => s.has(c), toggle: (c: string, on?: boolean) => (on ? s.add(c) : s.delete(c)) };
  }
  has(c: string) { return this.classes.has(c); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  getBoundingClientRect() { return { width: 88 }; }
  closest(sel: string) { return this.match(sel) ? this : null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() { /* 事件由用例直接派发 */ }
}

type Handler = (ev: any) => any;

/** 起一个页面：真 app.js、假 DOM、假接口。pulse 的版本和挂起时机都由用例控制。 */
function boot(opts: {
  pulse: string[];
  onButton?: () => Promise<{ ok: boolean; status?: number; data?: any }>;
  /** 第二次及以后的 pulse 挂在这道闸门上——「请求在路上时你点了按钮」那种时序。 */
  pulseHold?: Promise<unknown>;
}) {
  const handlers: Record<string, Handler[]> = {};
  const toast = new El('');
  const state = {
    reloads: 0, polls: 0, toast, handlers, dirtyDispatched: false,
    poll: async (): Promise<void> => {},
    doc: null as any,
  };

  const document = {
    body: { getAttribute: () => null },
    hidden: false,
    activeElement: null as any,
    addEventListener: (t: string, fn: Handler) => { (handlers[t] ??= []).push(fn); },
    getElementById: (id: string) => (id === 'toast' ? toast : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const location = {
    pathname: '/tasks', search: '', hash: '', href: '',
    reload: () => { state.reloads += 1; },
  };
  const fetchStub = async (url: string) => {
    if (url === '/api/pulse') {
      state.polls += 1;
      if (opts.pulseHold && state.polls > 1) await opts.pulseHold;
      const v = opts.pulse.length > 1 ? opts.pulse.shift()! : opts.pulse[0];
      return { ok: true, status: 200, json: async () => ({ v }) };
    }
    const r = await (opts.onButton?.() ?? { ok: true, data: {} });
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.data ?? {} };
  };
  class FormDataStub { entries() { return [][Symbol.iterator](); } }

  const ctx = vm.createContext({
    document, location, sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: fetchStub, navigator: {},
    window: { addEventListener: () => {}, confirm: () => true },
    HTMLFormElement: class {}, HTMLDetailsElement: class {}, FormData: FormDataStub,
    setTimeout, clearTimeout, setInterval: (fn: any) => { state.poll = fn; return 0; }, clearInterval: () => {},
    JSON, Promise, Array, Object, String, Math, console, Date,
  });
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
  state.doc = document;
  return state;
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/** 手写一个「点了按钮、响应还没回来」的请求。 */
const clickStart = (b: ReturnType<typeof boot>) => {
  const btn = new El('开始', { apiClick: '/api/tasks/7/start' });
  return b.handlers.click[0]({ target: btn, preventDefault: () => {} });
};

describe('038.3 补刷也要让着没保存的输入', () => {
  test('在输入框打字时，迟到的补刷不会刷新页面，更新也没被吞掉', async () => {
    let releasePulse: (v?: any) => void = () => {};
    const pulseGate = new Promise((r) => { releasePulse = r; });
    let releaseBtn: (v: any) => void = () => {};
    const btnGate = new Promise((r) => { releaseBtn = r; });

    const b = boot({
      pulse: ['v1', 'v2'],
      pulseHold: pulseGate,
      onButton: () => btnGate as any,
    });

    await tick(); // 第一轮 poll → v1
    assert.equal(b.polls, 1);

    // 第二轮 poll 已经发出去、还没回来
    const second = b.poll();
    await tick();

    // 这一轮的路上：点了「开始」（inflight=1），又在输入框里打了字
    const clicked = clickStart(b);
    const input = new El('', {}, () => false);
    input.tagName = 'INPUT';
    for (const fn of b.handlers.input ?? []) fn({ target: input });

    // pulse 带着 v2 回来了：此刻还在等按钮 → 补刷排队
    releasePulse();
    await second;
    await tick();

    // 按钮失败（409），恢复原样
    releaseBtn({ ok: false, status: 409, data: { error: '这个任务已经被别人领走了' } });
    await clicked;
    await tick(150);

    assert.equal(b.reloads, 0, '有没保存的输入，一个刷新都不许发生');
  });

  test('没人在打字时，版本一变就照常刷新（别把这个修复修成不刷新）', async () => {
    const b = boot({ pulse: ['v1', 'v2'] });
    await tick();
    await b.poll(); // v1，没有变化
    await tick();
    await b.poll(); // v2
    await tick();
    assert.equal(b.reloads, 1, '没人碰输入，就该刷');
  });

  test('焦点在输入框也算：先不刷，挪开焦点后补上', async () => {
    const b = boot({ pulse: ['v1', 'v2'] });
    await tick();
    const input = new El('', {}, () => false);
    input.tagName = 'INPUT';
    b.doc.activeElement = input;

    await b.poll(); // v1
    await b.poll(); // v2，但焦点在输入框
    await tick();
    assert.equal(b.reloads, 0, '有焦点不刷');

    b.doc.activeElement = null;
    await b.poll(); // 版本没变，但 pendingReload 还在
    await tick();
    assert.equal(b.reloads, 1, '更新没被吞掉，输入结束后补上');
  });
});
