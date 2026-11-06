// 055.1：自媒体数据看板。和 044 v3 一样一层打开一层：
//   第一层：一句话（这周发了几条、多少播放、哪条最好）+ 七个平台各一行；
//   第二层（?p=平台）：账号、这个平台的每条内容（最新的数），点开一条是它每次记录的数和小曲线；
//   录入表单都折着，点「＋」才出现。符号代替文字：▶ 播放 ♥ 点赞 ✉ 评论 ↗ 转发 ★ 收藏 ＋ 涨粉。
import { MEDIA_PLATFORMS, ago, fmtCount, fmtDateTime, mediaLabel } from '../domain.ts';
import { METRICS, METRIC_LABEL, mediaOverview, postsOf, statsOf, type Metric, type MediaStat, type PostView } from '../services/media.ts';
import { miniLine } from './components.ts';
import { html, type Safe } from './html.ts';

const SYM: Record<Metric, string> = { views: '▶', likes: '♥', comments: '✉', shares: '↗', saves: '★', followers: '＋' };

const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

function nums(s: MediaStat | null, keys: Metric[] = ['views', 'likes', 'comments']): Safe {
  if (!s) return html`<span class="sym">还没记数</span>`;
  return html`${keys.filter((k) => s[k] !== null).map((k) => html`<span class="sym" title="${METRIC_LABEL[k]} ${s[k]}" aria-label="${METRIC_LABEL[k]} ${s[k]}">${SYM[k]} ${fmtCount(s[k])}</span>`)}`;
}

function postForm(platform?: string): Safe {
  return html`<form class="form inline-form" data-api="/api/media/posts" data-method="POST">
    ${platform
      ? html`<input type="hidden" name="platform" value="${platform}">`
      : html`<label class="field"><span>平台</span><select name="platform">${MEDIA_PLATFORMS.map((p) => html`<option value="${p.key}">${p.label}</option>`)}</select></label>`}
    <label class="field wide"><span>标题</span><input name="title" required maxlength="200" placeholder="第一条：我用一群 AI 搭了个工作台"></label>
    <label class="field wide"><span>链接</span><input name="url" maxlength="500" placeholder="https://…（可以不填）"></label>
    <label class="field"><span>发布日期</span><input name="published_at" type="date" value="${today()}"></label>
    <label class="field"><span>同一条内容的名字</span><input name="piece" maxlength="60" placeholder="比如 EP01，七个平台填同一个"></label>
    <div class="actions"><button class="btn primary">记下</button></div>
  </form>`;
}

function statsForm(postId: number): Safe {
  return html`<form class="form inline-form stats-form" data-api="/api/media/posts/${postId}/stats" data-method="POST">
    ${METRICS.map((m) => html`<label class="field num"><span>${SYM[m]} ${METRIC_LABEL[m]}</span><input name="${m}" inputmode="numeric" placeholder="—"></label>`)}
    <div class="actions"><button class="btn">记一次</button></div>
  </form>`;
}

function postCard(p: PostView): Safe {
  const history = statsOf(p.id);
  const views = history.map((s) => s.views).filter((v): v is number => v !== null);
  return html`<details class="card media-post" id="post-${p.id}" data-media-post="${p.id}">
    <summary class="media-post-sum">
      <span class="media-post-text"><span class="media-post-title">${p.title}</span>
        <span class="media-post-when">${fmtDateTime(p.published_at).slice(0, 10)}${p.piece ? ` · ${p.piece}` : ''}</span></span>
      <span class="media-post-nums">${nums(p.latest)}</span>
    </summary>
    <div class="media-post-body">
      ${views.length > 1 ? html`<div class="media-spark">${miniLine(views, `播放：${views.join('、')}`)}</div>` : ''}
      ${history.length ? html`<div class="table-wrap"><table class="media-history">
        <thead><tr><th>记录时间</th>${METRICS.map((m) => html`<th title="${METRIC_LABEL[m]}">${SYM[m]}</th>`)}</tr></thead>
        <tbody>${[...history].reverse().map((s) => html`<tr><td class="mono small">${fmtDateTime(s.at)}</td>${METRICS.map((m) => html`<td class="mono small">${fmtCount(s[m])}</td>`)}</tr>`)}</tbody>
      </table></div>` : html`<p class="quiet">还没记过数。发出去 24 小时、7 天各记一次就够看出走势。</p>`}
      <details class="fold" id="fold-stats-${p.id}"><summary>＋ 记一次数据</summary>${statsForm(p.id)}</details>
      <div class="media-post-foot">
        ${p.url ? html`<a href="${p.url}" target="_blank" rel="noopener noreferrer">打开原帖 ↗</a>` : ''}
        <button type="button" class="link-btn danger-text" data-api-click="/api/media/posts/${p.id}" data-method="DELETE" data-confirm="删掉这条和它的全部数据？">删除</button>
      </div>
    </div>
  </details>`;
}

function platformLayer(key: string): Safe {
  const o = mediaOverview();
  const s = o.platforms.find((x) => x.key === key)!;
  const posts = postsOf(key);
  const line = s.followers !== null
    ? `${fmtCount(s.followers)} 粉${s.followersDelta ? `，这周 ${s.followersDelta > 0 ? '涨' : '掉'}了 ${fmtCount(Math.abs(s.followersDelta))}` : ''} · 共 ${s.total} 条`
    : s.total ? `共 ${s.total} 条` : '还没记过';
  return html`<div class="layer" data-layer="media-platform" data-platform="${key}">
    <nav class="crumbs" aria-label="位置"><a href="/media">自媒体</a><span aria-hidden="true">›</span><strong>${s.label}</strong>${s.handle ? html`<span class="crumb-n">${s.handle}</span>` : ''}</nav>
    <header class="lede-block"><h1 class="lede-line">${line}</h1></header>
    <details class="fold" id="fold-addpost-${key}"><summary>＋ 记一条</summary>${postForm(key)}</details>
    <details class="fold" id="fold-account-${key}"><summary>⚙ 账号</summary>
      <form class="form inline-form" data-api="/api/media/accounts" data-method="POST">
        <input type="hidden" name="platform" value="${key}">
        <label class="field"><span>账号名</span><input name="handle" maxlength="60" value="${s.handle}" placeholder="@你的名字"></label>
        <label class="field"><span>现在多少粉</span><input name="followers" inputmode="numeric" placeholder="${s.followers ?? '—'}"></label>
        <div class="actions"><button class="btn">更新</button></div>
      </form>
      <p class="hint">每次更新都留一条记录，「这周涨了多少」从这里算。只填你自己号上看得到的数。</p>
    </details>
    ${posts.length ? html`<div class="media-posts" data-media-posts>${posts.map(postCard)}</div>` : html`<p class="quiet">${s.label} 上还没记过内容。</p>`}
  </div>`;
}

/** 平台的小头像：墨色圆底一两个字，和剧组页的头像一个样。 */
const mark = (m: string, lit: boolean) => html`<span class="media-mark ${lit ? 'lit' : ''}" aria-hidden="true">${m}</span>`;

export function mediaPage(q: URLSearchParams): Safe {
  const p = q.get('p');
  if (p && MEDIA_PLATFORMS.some((x) => x.key === p)) return platformLayer(p);
  const o = mediaOverview();
  const best = o.best as (PostView & { label: string }) | null;
  const sentence = !o.any
    ? '还没记过数据。先在下面记一条你发出去的内容。'
    : o.posts7
      ? `这周发了 ${o.posts7} 条，${fmtCount(o.views7)} 次播放${best ? `，${best.label}那条最好（${fmtCount(best.latest?.views ?? 0)}）` : ''}。`
      : '这周还没发。';
  return html`<div class="layer" data-layer="media">
    <header class="lede-block"><span class="lede-date">自媒体 · 近 7 天</span><h1 class="lede-line">${sentence}</h1></header>
    <section class="groups" aria-label="平台">
      ${o.platforms.map((s) => html`<a class="group-row ${s.posts7 ? 'hot' : ''}" href="/media?p=${s.key}" data-media-row="${s.key}">
        ${mark(s.mark, s.posts7 > 0)}
        <span class="group-text"><span class="group-label">${s.label}</span>
          <span class="group-peek">${s.followers !== null ? `${fmtCount(s.followers)} 粉` : '粉丝 —'}${s.followersDelta ? ` ${s.followersDelta > 0 ? '↑' : '↓'}${fmtCount(Math.abs(s.followersDelta))}` : ''}${s.posts7 ? ` · 本周 ${s.posts7} 条 ▶ ${fmtCount(s.views7)}` : s.lastAt ? ` · 上次 ${ago(s.lastAt)}` : ''}</span></span>
        <span class="group-go" aria-hidden="true">›</span></a>`)}
    </section>
    <details class="fold" id="fold-addpost"><summary>＋ 记一条</summary>${postForm()}</details>
  </div>`;
}

export { mediaLabel };
