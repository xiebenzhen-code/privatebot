// 064 · 点头像 / 点「＋」打开的那一层。和线程用同一个位置：电脑上在右边，手机上盖上来。
import { crewInfo, crewOutside, type CrewInfo } from '../services/crew.ts';
import { runnerExecutors } from '../services/runner.ts';
import { html, type Safe } from './html.ts';
import { icon } from './layout.ts';

const act = (key: string, to: 'in' | 'rest' | 'out', label: string, cls: string, done: string, confirm = ''): Safe =>
  html`<button type="button" class="${cls}" data-api-click="/api/crew/${key}" data-method="POST" data-body="${JSON.stringify({ to })}" data-done="${done}" ${confirm ? html`data-confirm="${confirm}"` : ''} data-crew-act="${to}">${label}</button>`;

/** 简介开头的「名字：」去掉——标题已经是名字了。 */
const short = (brief: string): string => brief.replace(/^[^：:]{1,24}[：:]\s*/, '');

function shell(title: string, body: Safe, attr: string): Safe {
  return html`<article class="thread crew-panel" data-crew-panel="${attr}" aria-label="${title}">
    <header class="thread-top"><a class="thread-back" href="/" aria-label="返回">${icon('back', 22)}</a></header>
    <h2 class="thread-title">${title}</h2>
    ${body}
  </article>`;
}

/** 点一个头像：它是谁、在不在线、手上几件事；歇着 / 叫回来 / 移除。 */
export function crewPanel(key: string): Safe | null {
  const m = crewInfo(key);
  if (!m) return null;
  const online = runnerExecutors().has(key);
  const status = m.state === 'out' ? '不在队里' : m.state === 'rest' ? '歇着，不接活' : `${online ? '在线' : '离线'}${m.busy ? ` · 手上 ${m.busy} 件` : ' · 手上没事'}`;
  return shell(m.label, html`
    <p class="crew-status" data-crew-status>${status}</p>
    <p class="crew-brief">${short(m.brief)}</p>
    ${m.state === 'in' && !online ? html`<p class="crew-brief">离线：这台电脑上的执行器还没带上它。<a href="/settings">去设置看看</a></p>` : ''}
    ${m.state === 'in' && m.busy ? html`<p class="crew-brief" data-crew-busy>手上有事，现在不能歇、不能移。等它做完，或者把活换给别人。</p>` : ''}
    ${m.idle ? html`<p class="crew-brief" data-crew-idle>还有 ${m.idle} 件派给它、没开始的事。${m.state === 'in' ? '它歇着或被移除后，这些事不会自己换人——' : '它不在，这些事没人做——'}点开那件事可以换人。</p>` : ''}
    ${m.state === 'in' && m.busy ? '' : html`<div class="decide-row">
      ${m.state === 'in' ? html`${act(key, 'rest', '先歇着', 'btn-ink', '歇着了 ✓')}${act(key, 'out', '移除', 'btn-line', '移除了 ✓', `把 ${m.label} 移出队伍？设置会留着，随时能请回来。`)}`
      : m.state === 'rest' ? html`${act(key, 'in', '叫回来', 'btn-ink', '回来了 ✓')}${act(key, 'out', '移除', 'btn-line', '移除了 ✓')}`
      : act(key, 'in', '请进来', 'btn-ink', '进来了 ✓')}
    </div>`}
    <a class="decide-link" href="/team">细调：能接哪类活、每天用量上限</a>`, key);
}

const outsideRow = (m: CrewInfo): Safe => html`<li class="crew-item" data-crew-item="${m.key}">
  <a class="crew-item-text" href="/?crew=${m.key}"><b>${m.label}</b>${m.state === 'rest' ? html`<i>歇着</i>` : ''}<span>${short(m.brief)}</span></a>
  ${act(m.key, 'in', m.state === 'rest' ? '叫回来' : '请进来', 'btn-line', '✓')}
</li>`;

/** 点「＋」：还能请谁进来。 */
export function crewAddPanel(): Safe {
  const list = crewOutside();
  return shell('请谁进来', html`
    ${list.length ? html`<ul class="crew-list">${list.map(outsideRow)}</ul>` : html`<p class="crew-brief" data-crew-empty>能接的都已经在队里了。</p>`}
    <p class="crew-brief">工作台现在认识这 8 种执行者。想接别的工具，要等以后的版本。</p>`, 'add');
}
