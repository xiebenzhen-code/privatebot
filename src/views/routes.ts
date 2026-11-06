// 016: the shape of the navigation lives here and nowhere else.
// Five top-level items, each with its own segment tabs; the path is the state, so every tab
// can be refreshed, bookmarked and pasted into a push message.
import { sectionLabel } from '../domain.ts';

export type SectionKey = 'today' | 'tasks' | 'team' | 'media' | 'data' | 'settings';

export const SECTIONS: Record<Exclude<SectionKey, 'today'>, string[]> = {
  tasks: ['board', 'review', 'mine', 'done'],
  team: ['executors', 'accounts'],
  media: ['media'],
  data: ['usage', 'audit', 'machines'],
  settings: ['integrations', 'security', 'notify', 'appearance', 'backup'],
};

/** Labels: the default wording, then the crew preset from 011, then whatever the user renamed. */
const TAB_LABEL: Record<string, [string, string]> = {
  board: ['看板', '拍摄进度'],
  review: ['审批', '审片'],
  mine: ['我的待办', '制片待办'],
  done: ['已完成', '杀青'],
  executors: ['执行者', '花名册'],
  media: ['自媒体', '自媒体'],
  accounts: ['账号与额度', '预算表'],
  usage: ['用量', '用量'],
  audit: ['审计日志', '审计日志'],
  machines: ['机器', '机器'],
  integrations: ['接入', '接入'],
  security: ['安全', '安全'],
  notify: ['通知', '通知'],
  appearance: ['外观', '外观'],
  backup: ['备份', '备份'],
};

export const sectionPath = (section: Exclude<SectionKey, 'today'>, tab: string): string => {
  const tabs = SECTIONS[section];
  const key = tabs.includes(tab) ? tab : tabs[0];
  // 044 v3：设置的根是总览，每一类都有自己的地址。
  if (section === 'settings') return `/settings/${key}`;
  return key === tabs[0] ? `/${section}` : `/${section}/${key}`;
};

const SECTION_ALIAS: Record<string, string> = {
  board: 'board', review: 'inbox', mine: 'mine', done: 'done', executors: 'executors', accounts: 'accounts',
};

export const tabLabel = (key: string): string => {
  const def = (TAB_LABEL[key] ?? [key, key])[0];
  // board / inbox / mine / accounts are the 011 names the user may have renamed.
  const alias = SECTION_ALIAS[key];
  return alias ? sectionLabel(alias, def) : def;
};

export type Tab = { key: string; label: string; href: string; on: boolean; count: number; hot: boolean };

export function tabsFor(
  section: Exclude<SectionKey, 'today'>,
  active: string,
  counts: { pending?: number; mine?: number } = {},
): Tab[] {
  return SECTIONS[section].map((key) => ({
    key,
    label: tabLabel(key),
    href: sectionPath(section, key),
    on: key === active,
    count: key === 'review' ? counts.pending ?? 0 : key === 'mine' ? counts.mine ?? 0 : 0,
    hot: key === 'review' && (counts.pending ?? 0) > 0,
  }));
}

export type NavItem = {
  key: SectionKey; label: string; icon: string; href: string;
  pending?: number; mine?: number; attention?: number; offlineDot?: boolean;
};

/**
 * One row per top-level item — never one per executor, however many executors get added.
 * 044：四项「工作台 / 剧组 / 记录 / 设置」。任务的那几页（看板、审批、我的待办、已完成）不在导航里，
 * 地址照旧有效，工作台的格子和「还有 N 个」都点去那里。以前 040 E 的说明：「数据」从导航拿掉，
 * 但 /data、/data/audit、/data/machines 照旧能打开——今天页的数据条就点去那里。
 */
export function navItems(
  c: { pending: number; mine: number; attention: number; runnerOnline: boolean; paused?: boolean },
): NavItem[] {
  return [
    { key: 'today', label: '工作台', icon: 'grid', href: '/', pending: c.pending, mine: c.mine },
    { key: 'team', label: sectionLabel('team', '剧组'), icon: 'spark', href: '/team', offlineDot: !c.runnerOnline },
    // 055：自媒体数据看板。
    { key: 'media', label: '自媒体', icon: 'play', href: '/media' },
    { key: 'data', label: '记录', icon: 'chart', href: '/data' },
    { key: 'settings', label: '设置', icon: 'plug', href: '/settings', attention: c.attention },
  ];
}

const keep = (from: URL, drop: string[]): string => {
  const p = new URLSearchParams(from.searchParams);
  for (const k of drop) p.delete(k);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * Addresses that were already sent out (push messages, Issue comments, bookmarks) land on the
 * page they meant, not on a 404. Fragments never reach the server — public/app.js does those,
 * driven by HASH_ROUTES below.
 */
export function oldPath(url: URL): string | null {
  const p = url.pathname;
  const q = url.searchParams;
  if (p === '/tasks' && q.get('view') === 'review' && !q.get('task') && !q.get('new')) {
    return `/tasks/review${keep(url, ['view'])}`;
  }
  if (p === '/tasks' && q.get('executor') === 'me' && !q.get('task') && !q.get('new')) {
    return `/tasks/mine${keep(url, ['executor'])}`;
  }
  const tab = q.get('tab');
  if (tab) {
    if (p === '/tasks' && SECTIONS.tasks.includes(tab)) return `/tasks${tab === 'board' ? '' : `/${tab}`}${keep(url, ['tab'])}`;
    if (p === '/team' && SECTIONS.team.includes(tab)) return `/team${tab === 'executors' ? '' : `/${tab}`}${keep(url, ['tab'])}`;
    if (p === '/data' && SECTIONS.data.includes(tab)) return `/data${tab === 'usage' ? '' : `/${tab}`}${keep(url, ['tab'])}`;
    if (p === '/settings' && SECTIONS.settings.includes(tab)) return `/settings/${tab}${keep(url, ['tab'])}`;
  }
  return null;
}

/** Old fragment → new path. Rendered into the page so app.js can redirect without a round trip. */
export const HASH_ROUTES: [string, string][] = [
  ['/#machines', '/data/machines'],
  ['/data#usage', '/data'],
  ['/data#accounts', '/team/accounts'],
  ['/data#audit', '/data/audit'],
  ['/settings#sources', '/settings/integrations'],
  ['/settings#integrations', '/settings/integrations'],
  ['/settings#deepseek', '/settings/integrations'],
  ['/settings#cliproxyapi', '/settings/integrations'],
  ['/settings#api', '/settings/integrations'],
  ['/settings#rules', '/settings/security'],
  ['/settings#dispatch', '/settings/security'],
  ['/settings#notify', '/settings/notify'],
  ['/settings#labels', '/settings/appearance'],
  ['/settings#desktop-app', '/settings/appearance'],
  ['/settings#backup', '/settings/backup'],
];
