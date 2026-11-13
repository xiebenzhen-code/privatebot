// 060.2（最小的一版）：包在界面上的两处——首页派活框下面那排按钮；高级 › 包 里一包一行，启用是一次点头。
// 包里的字全是资料：html`` 自动转义。按钮的完整提示词在启用之前摆给你看。
import { activePacks, listPacks, type Pack, type PackInfo } from '../services/packs.ts';
import { html, type Safe } from './html.ts';
import { icon } from './layout.ts';

/** 首页：已启用的包给的常用活。不要输入的点一下就派；要输入的点开是一行字。没有启用的包，这一排就没有。 */
export function packButtons(): Safe {
  let packs: Pack[] = [];
  try { packs = activePacks(); } catch { packs = []; }
  const acts = packs.flatMap((p) => p.actions.map((a, i) => ({ p, a, i }))).slice(0, 8);
  if (!acts.length) return html``;
  return html`<div class="pack-row" data-pack-row>
    ${acts.map(({ p, a, i }) => a.input === 'none'
      ? html`<button type="button" class="pack-btn" data-api-click="/api/packs/${p.name}/actions/${i}" data-method="POST" data-done="已派出去 ✓" data-pack-action="${p.name}:${i}"><span aria-hidden="true">${p.symbol}</span> ${a.label}</button>`
      : html`<details class="pack-ask" data-pack-action="${p.name}:${i}">
          <summary class="pack-btn"><span aria-hidden="true">${p.symbol}</span> ${a.label}</summary>
          <form class="reply" data-api="/api/packs/${p.name}/actions/${i}" data-toast="已派出去">
            <label class="sr-only" for="pk-${p.name}-${i}">${a.label}</label>
            <input id="pk-${p.name}-${i}" name="input" maxlength="500" autocomplete="off" ${a.input === 'required' ? html`required` : ''} placeholder="${a.label}：${a.input === 'required' ? '写一句' : '补一句（可不写）'}">
            <button class="send" aria-label="派出去">${icon('up', 18)}</button>
          </form>
        </details>`)}
  </div>`;
}

const STATUS: Record<PackInfo['status'], string> = {
  found: '没启用', on: '已启用', off: '已关闭', changed: '文件变了，再看一眼', invalid: '没过校验', missing: '文件夹不见了',
};

export function packsPage(): Safe {
  const list = listPacks();
  return html`<div class="layer" data-layer="packs">
    <nav class="crumbs" aria-label="位置"><a href="/">工作台</a><span aria-hidden="true">›</span><a href="/advanced">高级</a><span aria-hidden="true">›</span><strong>包</strong></nav>
    ${list.length ? '' : html`<p class="quiet">还没有包。把包的文件夹放进 packs/ 或 private/packs/，这里就会出现。</p>`}
    ${list.map((p) => html`<section class="panel pack" data-pack="${p.name}" data-pack-status="${p.status}">
      <div class="panel-head"><h2>${p.pack ? html`${p.pack.symbol} ${p.pack.label}` : p.name}</h2><span class="meta">${p.name} · ${STATUS[p.status]}</span></div>
      ${p.problems.length ? html`<ul class="pack-problems">${p.problems.slice(0, 12).map((x) => html`<li>${x}</li>`)}</ul>` : ''}
      ${p.pack ? html`
        ${p.pack.actions.length ? html`<p class="hint">启用后，首页会多出这些按钮。点按钮时，下面这段话会原样交给 AI（{输入} 换成你当场写的字）：</p>
          <dl class="pack-acts">${p.pack.actions.map((a) => html`<dt>${a.label}</dt><dd class="desc">${a.prompt}</dd>`)}</dl>` : html`<p class="hint">这个包没有按钮。</p>`}
        ${p.pack.skills.length ? html`<p class="hint">带 ${p.pack.skills.length} 个插件（只在执行器里用）：${p.pack.skills.map((s) => `${s.name}${s.env.length ? `（要变量 ${s.env.join('、')}）` : ''}`).join('；')}</p>` : ''}
        <div class="actions">
          ${p.status === 'on'
            ? html`<button type="button" class="btn" data-api-click="/api/packs/${p.name}/disable" data-method="POST" data-done="已关闭 ✓">关掉</button>`
            : html`<button type="button" class="btn solid" data-api-click="/api/packs/${p.name}/enable" data-method="POST" data-body="${JSON.stringify({ hash: p.hash })}" data-done="已启用 ✓">${p.status === 'changed' ? '看过了，重新启用' : '启用'}</button>`}
        </div>` : ''}
    </section>`)}
  </div>`;
}
