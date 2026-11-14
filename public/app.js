// 016: fragment links that were already sent out (…/settings#backup) must land on the new path.
// The server cannot see a fragment, so this runs before anything else paints.
(function () {
  const raw = document.body && document.body.getAttribute('data-hash-routes');
  if (!raw || !location.hash) return;
  const here = location.pathname + location.hash;
  try {
    for (const [from, to] of JSON.parse(raw)) {
      if (from === here) { location.replace(to); return; }
    }
  } catch (e) { /* malformed map: stay put */ }
  const fallback = JSON.parse(raw).find(([from]) => from.endsWith(location.hash));
  if (fallback) location.replace(fallback[1]);
})();

// Progressive enhancement for server-rendered pages. No framework.
//   <form data-api="/api/x" data-method="PATCH" data-redirect="/tasks?task={id}">  → JSON request, then reload/redirect
//   <button data-api-click="/api/x" data-method="DELETE" data-confirm="…">          → one-shot request
//   <input type=checkbox data-api-toggle="/api/x" data-field="status" data-on="done" data-off="inbox">
//   {field} in a URL is filled from the form; {field} in data-redirect from the JSON response.
(function () {
  // 044：每个页面（含局部换页之后的新页面）要做的初始化都登记在这里。
  // 以前这些事写成「脚本执行时做一次」，局部换页之后新页面上的下拉框、表单就没人管了。
  // 规矩：登记的函数每次要能重复跑（先看有没有做过），并且只碰当前文档里的东西；
  // 事件优先用 document 上的委托，不要给页面里的节点各绑一份。
  const pageInits = [];
  const onPage = (fn) => { pageInits.push(fn); };
  const runPageInits = () => {
    for (const fn of pageInits) {
      try { fn(); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
  };

  const toast = (msg, bad) => {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.className = ''; }, 2600);
  };

  // 038.1：请求还在路上、或成功态正停在屏幕上，自动刷新要让路。
  // pulse 每 8 秒一跳，审批一改任务版本就变；不挡它，「已批准合并 ✓」那 1.5 秒会被当场刷掉。
  let inflight = 0;
  let holdUntil = 0;
  // 038.2：pulse 早就发出去了，回来时人正在看「已批准合并 ✓」——这一版变化记下来，让完路再刷。
  // 只「不刷」等于把变化吞掉：版本号已经用过了，下一次 pulse 就看不见它。
  let pendingReload = false;
  const holding = () => inflight > 0 || Date.now() < holdUntil;
  // 后一次成功态不许把前一次的长停留缩短（连着点两个按钮时，风险高的那个还得停够 1.5 秒）。
  const holdFor = (ms) => { holdUntil = Math.max(holdUntil, Date.now() + ms); };

  async function call(url, method, body) {
    inflight++;
    try { return await request(url, method, body); } finally { inflight--; }
  }

  async function request(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 401) { location.href = '/login'; throw new Error('请重新登录'); }
    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  const fill = (tpl, obj, encode) => tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = obj && obj[k] != null ? String(obj[k]) : '';
    return encode ? encodeURIComponent(v) : v;
  });

  // 038 A：点了就立刻有反应——禁用、换字、宽度锁住（不跳）；成功后一句完成话，失败就退回原样。
  // 高风险（合并 / 推送 / 部署）的成功态要带上动作名，还得多停一会儿：批完得看清自己批了什么。
  const BUSY = '处理中…';
  const DONE = '已完成 ✓';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (b) => (b.textContent || '').trim();
  const isRisky = (b) => !!b && b.dataset.risk === 'high';

  function markBusy(b) {
    if (!b) return;
    const w = Math.round(b.getBoundingClientRect().width || 0);
    if (w) b.style.minWidth = `${w}px`; // 换字不改变宽度，按钮不会跳
    if (b.dataset.label == null) b.dataset.label = textOf(b);
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    b.textContent = BUSY;
  }

  // 返回要停多久（毫秒）。0 = 不显示完成态（重试类按钮的文案保持不变，等页面刷新就行）。
  function markDone(b) {
    if (!b) return 0;
    b.removeAttribute('aria-busy');
    if (b.dataset.noDone != null) { b.textContent = b.dataset.label ?? textOf(b); return 0; }
    b.classList.add('is-done');
    b.textContent = b.dataset.done || DONE;
    return isRisky(b) ? 1500 : 800;
  }

  function restore(b) {
    if (!b) return;
    b.removeAttribute('aria-busy');
    b.classList.remove('is-done');
    if (b.dataset.label != null) { b.textContent = b.dataset.label; delete b.dataset.label; }
    b.style.minWidth = '';
    b.disabled = false;
  }

  function done(redirect, data, msg) {
    pendingReload = false; // 这一页马上就要换了，别再补一次刷新
    sessionStorage.setItem('wb-toast', msg || '已保存');
    if (redirect) goTo(fill(redirect, data, false));
    else reloadNow();
  }

  document.addEventListener('submit', async (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.api) return;
    ev.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(form).entries()) body[k] = v;
    const sub = ev.submitter;
    if (sub && sub.name) body[sub.name] = sub.value;
    // 「已批准合并 ✓」里的动作名来自按钮自己的字；换了字之后就读不到了，先记下来。
    const label = sub ? textOf(sub) : '';
    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    markBusy(sub);
    try {
      const data = await call(fill(form.dataset.api, body, true), form.dataset.method || 'POST', body);
      // 派活回来只算「接住」：角色把卡收下去，但不写成完成——排队 ≠ 执行。
      if (window.PrivateBot && data && data.id && /\/api\/tasks(\/quick)?$/.test(form.dataset.api) && (form.dataset.method || 'POST') === 'POST') {
        window.PrivateBot.receive(data);
      }
      const stay = markDone(sub);
      const msg = sub && sub.name === 'decision' ? `已${label}` : (form.dataset.toast || null);
      // 044：审批卡就地变色、写清批了什么（data-settle），让人看清了再收起，然后才刷新。
      const settle = form.dataset.settle != null;
      if (settle) {
        form.classList.add('settled', `settled-${body.decision || 'done'}`);
        const line = form.querySelector('.need-done');
        if (line && sub && sub.dataset.settled) line.textContent = sub.dataset.settled;
      }
      const hold = settle ? Math.max(stay, 900) : stay;
      holdFor(hold + (settle ? 450 : 0));
      if (hold) await wait(hold);
      if (settle) { form.classList.add('collapsing'); await wait(reduced() ? 0 : 420); }
      done(form.dataset.redirect, data, msg);
    } catch (e) {
      buttons.forEach((b) => { b.disabled = false; });
      restore(sub);
      toast(e.message, true);
    }
  });

  document.addEventListener('click', async (ev) => {
    const copy = ev.target.closest('[data-copy]');
    if (copy) {
      const text = copy.parentElement.querySelector('pre').textContent;
      try { await navigator.clipboard.writeText(text); toast('已复制'); } catch (e) { toast('复制失败，请手动选择', true); }
      return;
    }
    const btn = ev.target.closest('[data-api-click]');
    if (!btn) return;
    ev.preventDefault();
    if (btn.dataset.confirm && !window.confirm(btn.dataset.confirm)) return;
    markBusy(btn);
    try {
      const body = btn.dataset.body ? JSON.parse(btn.dataset.body) : null;
      const data = await call(btn.dataset.apiClick, btn.dataset.method || 'POST', body);
      // 回包说 status=done 才是真完成；「开始」「重试」这类回包不触发庆祝。
      if (window.PrivateBot && data && data.status === 'done') window.PrivateBot.succeed('这一单干完了');
      const stay = markDone(btn);
      holdFor(stay);
      if (stay) await wait(stay);
      // 049.4：卡片上的「完成」真把任务变成 done 之后，先给这张卡划线、淡出，看清「这件事过去了」再刷新。
      // 只认真变成 done 的那一下——「开始」「重试」的卡片不该跟着淡。
      // 「减少动态效果」时不动画，直接刷新。
      const card = data && data.status === 'done' ? btn.closest('[data-card="task"]') : null;
      const fade = card && !reduced() ? 420 : 0;
      if (fade) {
        card.classList.add('card-done');
        holdFor(fade);
        await wait(fade);
      }
      done(btn.dataset.redirect, data, '已完成');
    } catch (e) { restore(btn); toast(e.message, true); }
  });

  // 038 C：自动刷新之后，只有「变了的那几个」状态胶囊慢慢换色，不是整页闪一下。
  // 按页面里的先后位置比：同一个地址刷新前后结构一样，位置就是这个胶囊的身份。
  // 044：记录按地址分开存——局部换页后，别的页面留下的记录不该拿来比。
  const SEEN = 'wb-status-seen';
  onPage(function statusShift() {
    const pills = Array.from(document.querySelectorAll('.status[data-status]'));
    if (!pills.length) return;
    const key = typeof location.pathname === 'string' ? `${SEEN}:${location.pathname}${location.search || ''}` : SEEN;
    let seen = [];
    try { seen = JSON.parse(sessionStorage.getItem(key) || sessionStorage.getItem(SEEN) || '[]'); } catch (e) { seen = []; }
    const now = pills.map((p) => p.dataset.status);
    // 数量对不上（换了筛选、任务增删）就不猜，免得一屏乱闪。
    if (seen.length === now.length) {
      now.forEach((k, i) => { if (k !== seen[i]) pills[i].classList.add('status-changed'); });
    }
    sessionStorage.setItem(key, JSON.stringify(now));
    sessionStorage.setItem(SEEN, JSON.stringify(now));
  });

  // 038 B：折叠区真的点开时才淡入一下（打开页面不算），连点两次也能再放一遍。
  document.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;
    if (d.classList.contains('quota') || d.classList.contains('ask-more') || d.classList.contains('day')) return; // 弹出卡片自己有动画，别再让整块晃一下
    if (d.hasAttribute('data-restored')) { d.removeAttribute('data-restored'); return; } // 刷新时按原样还原的，不再放一遍淡入
    d.classList.remove('just-opened');
    void d.offsetWidth;
    d.classList.add('just-opened');
  }, true);

  document.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement) || !el.dataset.apiToggle) return;
    const value = el.checked ? el.dataset.on : el.dataset.off;
    try {
      await call(el.dataset.apiToggle, 'PATCH', { [el.dataset.field]: value });
      done(null, null, '已更新');
    } catch (e) { toast(e.message, true); el.checked = !el.checked; }
  });

  // Live refresh: poll a cheap version stamp; reload only when something changed and you're not typing.
  let version = null;
  let dirty = false;
  document.addEventListener('input', () => { dirty = true; });

  // 038.3：自动刷新的每个出口都要过这一道——补刷原来只看 holding，会把没保存的输入冲掉。
  const busyForInput = () => {
    const a = document.activeElement;
    return Boolean(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || dirty;
  };

  function flushPending() {
    if (!pendingReload || document.hidden || holding()) return;
    if (busyForInput()) return; // 留着 pendingReload，下一次 poll 再看，别把「有更新」吞掉
    pendingReload = false;
    reloadSoft();
  }
  // 停留期一过就补刷；万一那时又点了别的按钮，flushPending 会自己再退出，交给下一次安全检查。
  const laterFlush = () => { pendingReload = true; setTimeout(flushPending, Math.max(0, holdUntil - Date.now()) + 30); };

  async function poll() {
    if (document.hidden) return;
    if (holding()) { if (pendingReload) laterFlush(); return; }
    if (pendingReload) { flushPending(); return; }
    try {
      const snap = await call('/api/pulse', 'GET');
      const v = snap && snap.v;
      // 角色只关心「在跑几个 / 等你拍板几个」，跟着这次轮询一起回来；
      // 页面不可见时上面已经 return 了，所以它天然跟着一起停。
      // 包一层 try：角色是装饰，刷新决不能被它连累（没有 CustomEvent 的老环境就退回不动）。
      try { document.dispatchEvent(new CustomEvent('wb:pulse', { detail: snap })); } catch (e) { /* 不影响刷新 */ }
      if (version && v !== version) {
        // 请求在路上这几十毫秒里可能刚点了按钮（inflight 归零、成功态开始），回来的这一刻再判一次。
        if (holding()) laterFlush();
        else if (busyForInput()) pendingReload = true; // 别丢：等输入结束再补
        else reloadSoft();
      }
      version = v;
    } catch (e) { /* offline; try again later */ }
  }
  if (!location.pathname.startsWith('/login')) {
    poll();
    setInterval(poll, 8000);
    document.addEventListener('visibilitychange', poll);
  }

  // 044：深浅色。点一下在浅色和深色之间切；选择记在 cookie 里，服务端下次直接写进 <html>，不会闪白
  // （不用 localStorage + 内联脚本：服务端一开始就知道，省一段必须内联的脚本）。
  // 想回到「跟随系统」：设置 › 外观。顶栏会随页面一起被换掉，所以用委托，不绑在按钮本身上。
  const sysDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const themeNow = () => {
    const root = document.documentElement;
    return (root && root.dataset && root.dataset.theme) || (sysDark() ? 'dark' : 'light');
  };
  // 按钮上的字和状态永远跟着「现在」走：aria-label 写下一步会变成什么，aria-pressed 表示深色是否开着。
  const paintThemeButtons = () => {
    if (!document.documentElement) return;
    const dark = themeNow() === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      const label = dark ? '切换到浅色' : '切换到深色';
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', dark ? 'true' : 'false');
      b.setAttribute('title', label);
    });
  };
  onPage(paintThemeButtons);
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', paintThemeButtons);
  }
  const fadeTheme = () => {
    const root = document.documentElement;
    root.classList.add('theme-fading');
    setTimeout(() => root.classList.remove('theme-fading'), 600);
  };
  document.addEventListener('click', (ev) => {
    const themeBtn = ev.target.closest && ev.target.closest('[data-theme-toggle]');
    if (!themeBtn) return;
    const next = themeNow() === 'dark' ? 'light' : 'dark';
    fadeTheme();
    document.documentElement.dataset.theme = next;
    document.cookie = `wb_theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    paintThemeButtons();
  });

  // 设置 › 外观：跟随系统 / 浅色 / 深色。
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-theme-set]');
    if (!b) return;
    const v = b.dataset.themeSet;
    const root = document.documentElement;
    fadeTheme();
    if (v === 'system') {
      delete root.dataset.theme;
      document.cookie = 'wb_theme=; Path=/; Max-Age=0; SameSite=Lax';
    } else {
      root.dataset.theme = v;
      document.cookie = `wb_theme=${v}; Path=/; Max-Age=31536000; SameSite=Lax`;
    }
    paintThemeButtons();
  });

  // Install as a desktop app (settings page panel). 按钮在设置页里，局部换页后是新节点：点击走委托，提示每页重画。
  let installEvent = null;
  const showHint = (show) => {
    const btn = document.getElementById('install-app');
    const hint = document.getElementById('install-hint');
    if (btn) btn.hidden = show;
    if (hint) hint.hidden = !show;
  };
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    installEvent = ev;
    showHint(false);
  });
  document.addEventListener('click', async (ev) => {
    if (!(ev.target.closest && ev.target.closest('#install-app')) || !installEvent) return;
    installEvent.prompt();
    try { await installEvent.userChoice; } catch (e) { /* dismissed */ }
    installEvent = null;
    showHint(true);
  });
  window.addEventListener('appinstalled', () => { installEvent = null; showHint(true); });
  // 服务端渲染的默认是「按钮藏着、提示显示」；已经收到过安装事件的话，换到这一页要把按钮亮出来。
  onPage(() => showHint(!installEvent));

  // Service worker: only used for the offline page when the workbench is down.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // 刚做完一件事、然后换了页（或整页刷新）：那一行提示在新页面上出现。
  onPage(() => {
    const pendingToast = sessionStorage.getItem('wb-toast');
    if (pendingToast) { sessionStorage.removeItem('wb-toast'); toast(pendingToast); }
  });

  // ---------- 044：局部换页 ----------
  // 点站内链接只换 <main> 和侧边栏的导航，地址栏照常变化，刷新、书签、后退都照旧能用。
  // 浏览器支持时配一层视图过渡。拿不准的情况（不是 HTML、被重定向到登录页、页面结构对不上）
  // 一律退回普通跳转，宁可整页刷新也不显示错东西。
  // 老浏览器、测试里的假 DOM 没有这些就不接管，链接照旧整页跳转。
  const canSwap = typeof URL === 'function' && typeof DOMParser === 'function' && typeof fetch === 'function'
    && !!window.history && typeof history.pushState === 'function';
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const SKIP = /^\/(api|static|logout|login|manifest|sw\.js)/;

  // 谁说了算：最后一次点的那个。
  //   navSeq —— 每次「手动去某页」（点链接、后退、提交后跳转）加一；
  //   relSeq —— 每次「原地刷新」加一。刷新不加 navSeq，所以刷新一定输给之后的手动导航；
  //   响应回来、以及视图过渡把真正换内容推迟到下一帧之后，都要再核对一遍编号，旧的一律丢掉：
  //   不更新内容、不改地址、不进历史。
  let navSeq = 0;
  let relSeq = 0;
  let swaps = 0;
  let navPending = 0;
  let ctl = null;

  async function swap(url, o) {
    o = o || {};
    const reload = !!o.reload;
    // 自动刷新给在路上的任何换页让路：它们回来的内容本来就是最新的。
    if (reload && !o.force && swaps > 0) return;
    // 手动导航在路上时，连「做完一件事后的刷新」也不必发：新页面本来就带着最新状态。
    if (reload && navPending > 0) return;
    const nav = reload ? navSeq : ++navSeq;
    const rel = reload ? ++relSeq : relSeq;
    const stale = () => nav !== navSeq || rel !== relSeq;
    if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
    const mine = ctl = typeof AbortController === 'function' ? new AbortController() : null;
    swaps++;
    if (!reload) navPending++;
    try {
      let res;
      let text;
      try {
        res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' }, signal: mine ? mine.signal : undefined });
        if (stale()) return;
        const ct = res.headers.get('content-type') || '';
        const finalUrl0 = res.url || url;
        if (new URL(finalUrl0, location.href).pathname.startsWith('/login') || !ct.includes('text/html')) { location.href = finalUrl0; return; }
        text = await res.text();
      } catch (e) {
        if (!stale()) location.href = url; // 请求本身失败（离线等）：交给浏览器，它会给出自己的错误页
        return;
      }
      if (stale()) return;
      const finalUrl = res.url || url;
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const nextMain = doc.querySelector('main.main');
      if (!nextMain || !document.querySelector('main.main')) { location.href = finalUrl; return; }
      const y = window.scrollY;
      const apply = () => {
        // 视图过渡会把这一步推迟到下一帧之后；这期间如果又点了别的，这一步就作废。
        if (stale()) return;
        // 自动刷新回来的这一刻，人刚好开始输入、或一个成功态正停在屏幕上：留着，等安全了再补。
        if (reload && !o.force && (holding() || busyForInput())) { pendingReload = true; return; }
        const curMain = document.querySelector('main.main');
        if (!curMain) { location.href = finalUrl; return; }
        // 刷新前每个折叠区开着还是关着（按 id 记）、详情面板滚到哪儿：刷新后原样还原，别让人看着它自己跳。
        const sameP = new URL(finalUrl, location.href).pathname === location.pathname;
        const openState = reload || sameP ? Array.from(curMain.querySelectorAll('details[id]')).map((d) => [d.id, d.open]) : [];
        const oldDrawer = curMain.querySelector('aside.drawer');
        const drawerY = oldDrawer ? oldDrawer.scrollTop : 0;
        // 同一页换参数（这周 ↔ 这个月、进出详情）：内容原地换，不再放一遍「抬上来」的进场动画。
        if (new URL(finalUrl, location.href).pathname === location.pathname) nextMain.classList.add('no-enter');
        curMain.replaceWith(nextMain);
        document.title = doc.title;
        if (!reload && o.push !== false) {
          try { history.replaceState({ wb: 1, y }, ''); } catch (e) { /* 记不下离开时的滚动位置也无妨 */ }
          history.pushState({ wb: 1 }, '', finalUrl);
        } else if (reload && finalUrl !== location.href) history.replaceState({ wb: 1 }, '', finalUrl);
        // 同一页只换参数（7 天 ↔ 30 天、这周 ↔ 这个月）：停在原处，展开着的照样展开——看起来只是那一块的数字变了。
        // 先把折叠区按原样还原，再滚动：顺序反了，页面高度在滚完之后才变，会回跳一截（Codex 实测约 40 像素）。
        openState.forEach(([id, open]) => {
          const d = document.getElementById(id);
          if (d && d.open !== open) { d.setAttribute('data-restored', ''); d.open = open; }
        });
        window.scrollTo(0, o.keepScroll || (sameP && o.push !== false) ? y : (o.y || 0));
        if ((reload || sameP) && drawerY) { const nd = nextMain.querySelector('aside.drawer'); if (nd) nd.scrollTop = drawerY; }
        if (!reload) { try { nextMain.setAttribute('tabindex', '-1'); nextMain.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        document.dispatchEvent(new CustomEvent('wb:page', { detail: { reload } }));
      };
      // 自动刷新不做过渡：内容在原地更新，不该晃一下。
      const samePage = new URL(finalUrl, location.href).pathname === location.pathname;
      if (document.startViewTransition && !reduced() && !reload && !samePage) document.startViewTransition(apply);
      else apply();
    } finally {
      swaps--;
      if (!reload) navPending--;
      if (ctl === mine) ctl = null;
    }
  }

  const goTo = (url) => { if (canSwap) return swap(url); location.href = url; return undefined; };
  // 做完一件事之后的刷新：必须刷（除非用户已经去了别处）。
  const reloadNow = () => (canSwap ? swap(location.href, { reload: true, force: true, push: false, keepScroll: true }) : location.reload());
  // 自动刷新：人在输入或成功态还在屏幕上就让路。
  const reloadSoft = () => (canSwap ? swap(location.href, { reload: true, push: false, keepScroll: true }) : location.reload());
  window.wbSwap = (url) => goTo(url);
  window.wbReload = () => reloadNow();

  // 每次换页之后：旧页的「脏」标记和补刷计划作废（新页是刚从服务端拿的），再把新页要做的初始化跑一遍。
  // 没保存的输入仍然受保护——它们只在 busyForInput() 里挡自动刷新，而手动离开本来就是用户自己的决定。
  document.addEventListener('wb:page', () => {
    if (typeof lastKey !== 'undefined') lastKey = location.pathname + location.search;
    dirty = false;
    pendingReload = false;
    runPageInits();
  });

  if (canSwap) {
    document.addEventListener('click', (ev) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = ev.target.closest && ev.target.closest('a[href]');
      if (!a || a.target || a.hasAttribute('download') || a.dataset.noSwap != null) return;
      const u = new URL(a.getAttribute('href'), location.href);
      if (u.origin !== location.origin || SKIP.test(u.pathname)) return;
      if (u.pathname === location.pathname && u.search === location.search && u.hash) return; // 页内锚点
      ev.preventDefault();
      swap(u.href);
    });
    window.addEventListener('popstate', () => {
      if (panelOnly()) return;
      const st = history.state;
      swap(location.href, { push: false, y: st && typeof st.y === 'number' ? st.y : 0 });
    });
  }

  // ---------- 044 v3：任务详情从右侧滑出 ----------
  // 点任务卡（a[data-panel]）：地址变成「这一页 + ?task=12」，只取回详情那一块插进来，页面本身不动。
  // 关掉：滑出去、地址去掉 task。后退 / 前进只差 task 时就地开关面板，不重画整页。
  const pageKey = (u) => { const x = new URL(u, location.href); x.searchParams.delete('task'); x.hash = ''; return x.pathname + x.search; };
  let panelSeq = 0;
  const closePanel = (animate) => {
    const main = document.querySelector('main.main');
    if (!main) return;
    const d = main.querySelector('aside.drawer[aria-label="任务详情"]');
    const sc = main.querySelector('a.scrim');
    if (!d) { if (sc) sc.remove(); return; }
    const done = () => { d.remove(); if (sc) sc.remove(); };
    if (animate && !reduced()) { d.classList.add('closing'); if (sc) sc.classList.add('closing'); setTimeout(done, 220); } else done();
  };
  async function openPanel(url, push) {
    const my = ++panelSeq;
    let text;
    try {
      const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
      if (!(res.headers.get('content-type') || '').includes('text/html')) { location.href = url; return; }
      text = await res.text();
    } catch (e) { location.href = url; return; }
    if (my !== panelSeq) return;
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const d = doc.querySelector('aside.drawer[aria-label="任务详情"]');
    const sc = doc.querySelector('a.scrim');
    const main = document.querySelector('main.main');
    if (!d || !main) { location.href = url; return; }
    closePanel(false);
    if (sc) main.appendChild(sc);
    main.appendChild(d);
    if (push) { history.pushState({ wb: 1, panel: 1 }, '', url); lastKey = location.pathname + location.search; }
    try { d.setAttribute('tabindex', '-1'); d.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('wb:panel'));
  }
  if (canSwap) {
    document.addEventListener('click', (ev) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const t = ev.target.closest && ev.target.closest('a[data-panel], a.drawer-close, a.scrim');
      if (!t) return;
      const u = new URL(t.getAttribute('href'), location.href);
      if (t.matches('a[data-panel]')) {
        const id = u.searchParams.get('task');
        if (!id) return;
        const here = new URL(location.href);
        here.searchParams.set('task', id);
        here.hash = '';
        ev.preventDefault();
        openPanel(here.pathname + here.search, true);
        return;
      }
      // 关闭：只差 task 才就地收起，否则交给普通换页。
      if (pageKey(u.href) !== pageKey(location.href)) return;
      ev.preventDefault();
      panelSeq++;
      closePanel(true);
      history.pushState({ wb: 1 }, '', u.pathname + u.search);
      lastKey = location.pathname + location.search;
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const main = document.querySelector('main.main');
      if (!main || !main.querySelector('aside.drawer[aria-label="任务详情"]')) return;
      const u = new URL(location.href);
      if (!u.searchParams.has('task')) return;
      u.searchParams.delete('task');
      panelSeq++;
      closePanel(true);
      history.pushState({ wb: 1 }, '', u.pathname + u.search);
      lastKey = location.pathname + location.search;
    });
  }
  // 后退 / 前进：只差 task 的就地开关面板（返回 true 表示已处理）。
  let lastKey = typeof location.pathname === 'string' ? location.pathname + (location.search || '') : '';
  const panelOnly = () => {
    const prev = lastKey;
    lastKey = location.pathname + location.search;
    if (!prev || pageKey(prev) !== pageKey(location.href)) return false;
    const id = new URL(location.href).searchParams.get('task');
    if (id) openPanel(location.pathname + location.search, false); else { panelSeq++; closePanel(true); }
    return true;
  };
  window.wbPanelOnly = panelOnly;

  // 额度小卡片、派活的「更多」：点外面收起。
  document.addEventListener('click', (ev) => {
    for (const sel of ['details.quota', 'details.ask-more']) {
      const open = document.querySelector(`${sel}[open]`);
      if (open && !(ev.target.closest && ev.target.closest(sel))) open.open = false;
    }
  });

  // ---------- 每个页面要做的初始化（局部换页之后也会重新跑） ----------

  // Account form: the voucher fields only matter for pay-as-you-go balances.
  const syncKind = (select) => {
    const f = select.closest && select.closest('form');
    const box = f ? f.querySelector('.voucher-fields') : null;
    if (box) box.classList.toggle('on', select.value === 'balance');
  };
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('select[name="kind"]')) syncKind(t);
  });
  onPage(() => document.querySelectorAll('select[name="kind"]').forEach(syncKind));

  // 025: 「项目」选「其他（自己填）」时才显示输入框；选已有项目时直接提交那个名字。
  const syncProject = (sel) => {
    const form = sel.closest && sel.closest('form');
    if (!form) return;
    const other = form.querySelector('[data-project-other]');
    const input = other ? other.querySelector('input[name="project_custom"]') : null;
    const isOther = sel.value === '__other';
    if (other) other.hidden = !isOther;
    if (input) { input.disabled = !isOther; if (!isOther) input.value = ''; }
    sel.setAttribute('name', isOther ? 'project_pick' : 'project');
  };
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('[data-project-pick]')) syncProject(t);
  });
  onPage(() => document.querySelectorAll('[data-project-pick]').forEach(syncProject));

  // New-task form: pre-select the executor the dispatcher recommends, and say why.
  // 换了分类就重新问一次；用户自己动过执行者之后不再替他改。
  // 状态记在表单节点上：局部换页后新表单是新节点，天然从头开始，不会和旧页的事件混在一起。
  const touchedExec = new WeakSet();
  const suggestFor = async (form) => {
    const exec = form.querySelector('select[name="executor"]');
    const cat = form.querySelector('select[name="category"]');
    if (!exec || !cat) return;
    const hint = (form.parentElement && form.parentElement.querySelector('[data-suggest-hint]')) || document.querySelector('[data-suggest-hint]');
    // A link like /tasks?new=1&executor=codex already made the choice; keep showing the hint only.
    const linked = new URLSearchParams(location.search).get('executor');
    try {
      const res = await fetch(`/api/dispatch/suggest?category=${encodeURIComponent(cat.value)}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const sug = await res.json();
      if (!form.isConnected) return; // 等回答的时候页面已经换了
      if (sug && sug.executor && !touchedExec.has(form) && !linked && [...exec.options].some((o) => o.value === sug.executor)) {
        exec.value = sug.executor;
      }
      if (hint) {
        hint.textContent = sug && sug.reason ? `建议：${sug.reason}` : '';
        hint.hidden = !(sug && sug.reason);
      }
    } catch (e) { /* offline or logged out: leave the default */ }
  };
  const taskForm = () => document.querySelector('form[data-api="/api/tasks"], form[data-api^="/api/tasks?"]');
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.matches) return;
    const form = t.closest && t.closest('form[data-api="/api/tasks"], form[data-api^="/api/tasks?"]');
    if (!form) return;
    if (t.matches('select[name="executor"]')) touchedExec.add(form);
    else if (t.matches('select[name="category"]')) suggestFor(form);
  });
  onPage(() => { const f = taskForm(); if (f) suggestFor(f); });

  runPageInits();
})();

// 044：地址带着 #setup-runner 这类锚点进来时，把折起来的「开始使用」打开再滚过去。
(function () {
  const open = () => {
    if (!location.hash || typeof document.getElementById !== 'function') return;
    let el = null;
    try { el = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (e) { el = null; }
    const fold = el && el.closest ? el.closest('details') : null;
    if (fold && !fold.open) { fold.open = true; el.scrollIntoView({ block: 'start' }); }
  };
  open();
  if (typeof window.addEventListener === 'function') window.addEventListener('hashchange', open);
})();
