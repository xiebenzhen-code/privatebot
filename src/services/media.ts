// 055.1：自媒体数据看板。
//
// 三张表：media_posts（一条内容在一个平台上的一次发布）、media_stats（某个时间点的数，只追加）、
// media_accounts（账号名和粉丝数的快照，只追加）。数据第一版全靠手动录入——国内平台没有给个人的数据接口，
// 爬虫和第三方数据服务一律不用（055 单「数据从哪来」）。
import { db, tx } from '../db.ts';
import { MEDIA_PLATFORMS, mediaLabel, nowIso, stampOf } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';

export const METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'followers'] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<Metric, string> = { views: '播放', likes: '点赞', comments: '评论', shares: '转发', saves: '收藏', followers: '涨粉' };

export type MediaPost = {
  id: number; platform: string; piece: string; title: string; url: string; task_id: number | null;
  published_at: string; created_at: string; updated_at: string;
};
export type MediaStat = { id: number; post_id: number; at: string; source: string } & Record<Metric, number | null>;
export type PostView = MediaPost & { latest: MediaStat | null; snapshots: number };

const KEYS = MEDIA_PLATFORMS.map((p) => p.key);

function platformOf(v: unknown): string {
  const s = String(v ?? '');
  if (!KEYS.includes(s)) throw new HttpError(400, `平台只能是 ${MEDIA_PLATFORMS.map((p) => p.label).join(' / ')}`);
  return s;
}
function text(v: unknown, max: number, field: string, required = false): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${field}不能空`);
  if (s.length > max) throw new HttpError(400, `${field}最多 ${max} 个字`);
  return s;
}
function urlOf(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length > 500 || !/^https?:\/\/[^\s<>"']+$/i.test(s)) throw new HttpError(400, '链接要以 http:// 或 https:// 开头');
  return s;
}
function localNoon(day: string): number {
  const target = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== day) return NaN;
  let instant = target;
  // 用工作台时钟反推时差，再验证确实落在所选日期的中午。
  for (let attempt = 0; attempt < 4; attempt++) {
    const { date, time } = stampOf(new Date(instant));
    if (date === day && time === '1200') return instant;
    const wallClock = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
    if (!Number.isFinite(wallClock)) return NaN;
    instant += target - wallClock;
  }
  return NaN;
}

/** 日期：YYYY-MM-DD 或完整时间；不填就是现在。不收未来超过一天的时间。 */
function whenOf(v: unknown, field: string): string {
  const s = String(v ?? '').trim();
  if (!s) return nowIso();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? localNoon(s) : Date.parse(s);
  if (!Number.isFinite(t)) throw new HttpError(400, `${field}看不懂：${s.slice(0, 30)}`);
  if (t > Date.now() + 86400000) throw new HttpError(400, `${field}不能是未来`);
  return new Date(t).toISOString();
}
function count(v: unknown, field: string): number | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,，\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new HttpError(400, `${field}要是 0 或正数`);
  return Math.round(n);
}

export function getPost(id: number): MediaPost | undefined {
  return db().prepare('SELECT * FROM media_posts WHERE id = ?').get(id) as MediaPost | undefined;
}

export function createPost(input: Record<string, unknown>, actor = 'me'): MediaPost {
  const platform = platformOf(input.platform);
  const title = text(input.title, 200, '标题', true);
  const url = urlOf(input.url);
  const piece = text(input.piece, 60, '分组');
  const published = whenOf(input.published_at, '发布时间');
  const taskId = input.task_id === undefined || input.task_id === '' || input.task_id === null ? null : Number(input.task_id);
  if (taskId !== null && !(Number.isInteger(taskId) && taskId > 0)) throw new HttpError(400, '任务号不对');
  const now = nowIso();
  const r = db().prepare(`INSERT INTO media_posts (platform, piece, title, url, task_id, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(platform, piece, title, url, taskId, published, now, now);
  const post = getPost(Number(r.lastInsertRowid))!;
  logEvent({ actor, kind: 'media.post', text: `${mediaLabel(platform)} 记了一条：${title.slice(0, 40)}` });
  return post;
}

export function addStats(postId: number, input: Record<string, unknown>, actor = 'me'): MediaStat {
  const post = getPost(postId);
  if (!post) throw new HttpError(404, '没有这条内容');
  const vals = METRICS.map((m) => count(input[m], METRIC_LABEL[m]));
  if (vals.every((v) => v === null)) throw new HttpError(400, '至少填一个数');
  const at = whenOf(input.at, '记录时间');
  const source = input.source === 'api' || input.source === 'reader' ? String(input.source) : 'manual';
  const id = tx(() => {
    const r = db().prepare(`INSERT INTO media_stats (post_id, at, ${METRICS.join(', ')}, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(postId, at, ...vals, source);
    db().prepare('UPDATE media_posts SET updated_at = ? WHERE id = ?').run(nowIso(), postId);
    return Number(r.lastInsertRowid);
  });
  logEvent({ actor, kind: 'media.stats', text: `${mediaLabel(post.platform)}「${post.title.slice(0, 30)}」记了一次数据` });
  return db().prepare('SELECT * FROM media_stats WHERE id = ?').get(id) as MediaStat;
}

export function deletePost(id: number, actor = 'me'): void {
  const post = getPost(id);
  if (!post) throw new HttpError(404, '没有这条内容');
  tx(() => {
    db().prepare('DELETE FROM media_stats WHERE post_id = ?').run(id);
    db().prepare('DELETE FROM media_posts WHERE id = ?').run(id);
  });
  logEvent({ actor, kind: 'media.delete', text: `删了 ${mediaLabel(post.platform)} 的「${post.title.slice(0, 30)}」` });
}

export function setAccount(input: Record<string, unknown>, actor = 'me'): void {
  const platform = platformOf(input.platform);
  const handle = text(input.handle, 60, '账号名');
  const followers = count(input.followers, '粉丝数');
  if (!handle && followers === null) throw new HttpError(400, '账号名和粉丝数至少填一个');
  const prev = latestAccount(platform);
  db().prepare('INSERT INTO media_accounts (platform, handle, followers, at) VALUES (?, ?, ?, ?)')
    .run(platform, handle || prev?.handle || '', followers ?? prev?.followers ?? null, nowIso());
  logEvent({ actor, kind: 'media.account', text: `${mediaLabel(platform)} 账号更新${followers !== null ? `：${followers} 粉` : ''}` });
}

type AccountRow = { platform: string; handle: string; followers: number | null; at: string };
function latestAccount(platform: string): AccountRow | undefined {
  return db().prepare('SELECT platform, handle, followers, at FROM media_accounts WHERE platform = ? ORDER BY at DESC, id DESC LIMIT 1').get(platform) as AccountRow | undefined;
}
/** 粉丝数 days 天前（或更早里最近的一次）：用来算「这周涨了多少」。没有更早的就拿第一次。 */
function accountBefore(platform: string, iso: string): AccountRow | undefined {
  return (db().prepare('SELECT platform, handle, followers, at FROM media_accounts WHERE platform = ? AND at <= ? AND followers IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1').get(platform, iso)
    ?? db().prepare('SELECT platform, handle, followers, at FROM media_accounts WHERE platform = ? AND followers IS NOT NULL ORDER BY at, id LIMIT 1').get(platform)) as AccountRow | undefined;
}

function latestStat(postId: number): MediaStat | null {
  return (db().prepare('SELECT * FROM media_stats WHERE post_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(postId) as MediaStat | undefined) ?? null;
}

export function postsOf(platform: string): PostView[] {
  platformOf(platform);
  const posts = db().prepare('SELECT * FROM media_posts WHERE platform = ? ORDER BY published_at DESC, id DESC').all(platform) as MediaPost[];
  return posts.map((p) => ({
    ...p,
    latest: latestStat(p.id),
    snapshots: (db().prepare('SELECT COUNT(*) n FROM media_stats WHERE post_id = ?').get(p.id) as { n: number }).n,
  }));
}

export function statsOf(postId: number): MediaStat[] {
  return db().prepare('SELECT * FROM media_stats WHERE post_id = ? ORDER BY at, id').all(postId) as MediaStat[];
}

export type PlatformSummary = {
  key: string; label: string; mark: string; handle: string; followers: number | null; followersDelta: number | null;
  posts7: number; views7: number; total: number; lastAt: string | null;
};

/** 第一层：每个平台一行，外加这一周的总数和最好的一条。 */
export function mediaOverview(days = 7, now: Date = new Date()): { platforms: PlatformSummary[]; posts7: number; views7: number; best: (PostView & { label: string }) | null; any: boolean } {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  let best: (PostView & { label: string }) | null = null;
  const platforms = MEDIA_PLATFORMS.map((p) => {
    const acc = latestAccount(p.key);
    const before = accountBefore(p.key, since);
    const recent = db().prepare('SELECT * FROM media_posts WHERE platform = ? AND published_at >= ? ORDER BY published_at DESC').all(p.key, since) as MediaPost[];
    let views7 = 0;
    for (const post of recent) {
      const l = latestStat(post.id);
      views7 += l?.views ?? 0;
      if (l?.views && (!best || (best.latest?.views ?? 0) < l.views)) best = { ...post, latest: l, snapshots: 0, label: p.label };
    }
    const agg = db().prepare('SELECT COUNT(*) n, MAX(published_at) last FROM media_posts WHERE platform = ?').get(p.key) as { n: number; last: string | null };
    const followers = acc?.followers ?? null;
    return {
      key: p.key, label: p.label, mark: p.mark, handle: acc?.handle ?? '', followers,
      followersDelta: followers !== null && before?.followers !== null && before?.followers !== undefined && before.at < (acc?.at ?? '') ? followers - before.followers : null,
      posts7: recent.length, views7, total: agg.n, lastAt: agg.last,
    };
  });
  return {
    platforms,
    posts7: platforms.reduce((s, x) => s + x.posts7, 0),
    views7: platforms.reduce((s, x) => s + x.views7, 0),
    best,
    any: platforms.some((x) => x.total > 0 || x.followers !== null),
  };
}

/** 给 pulse()：这三张表任何一张变了，页面就该刷新。 */
export function mediaPulse(): string {
  const r = db().prepare(`SELECT (SELECT IFNULL(MAX(updated_at), '') FROM media_posts) p, (SELECT COUNT(*) FROM media_posts) n,
    (SELECT IFNULL(MAX(id), 0) FROM media_stats) s, (SELECT IFNULL(MAX(id), 0) FROM media_accounts) a`).get() as Record<string, string | number>;
  return `${r.p}/${r.n}/${r.s}/${r.a}`;
}
