// Shared vocabulary: executors, statuses, categories, risks, and time helpers.
import { db } from './db.ts';

// 042：`brief` 是给调度大脑看的一句话简介（也给人看）。写事实：会不会改文件、贵不贵、有什么限制。
// 大脑只读这一行，不读代码、不读历史——所以这句话不准，派单就不准。
export const EXECUTORS: Record<string, { label: string; color: string; brief: string }> = {
  claude: { label: 'Claude', color: '#C2552D', brief: 'Claude Code：会改代码、会跑测试，按 token 计费，偏贵' },
  codex: { label: 'Codex', color: '#71717A', // 044：原来的近黑色在深色模式里看不见
    brief: 'Codex：改代码稳，受 5 小时窗口限制，窗口用完就停' },
  pool: { label: '反代池', color: '#3B82F6', brief: '反代池（DeepSeek / 百炼代金券）：便宜，擅长文档、内容、批量改写与阅读' },
  local: { label: '本机', color: '#7C3AED', brief: '本机命令与脚本：适合运维、构建、批量处理，做不了需要理解语义的活' },
  workbuddy: { label: 'WorkBuddy', color: '#B45309', brief: 'WorkBuddy：能读能写，额度不过期，适合日常杂活' },
  zcode: { label: 'ZCode', color: '#15803D', brief: 'ZCode 每天送的额度：最便宜但当天不用作废，要你手动把任务贴进应用' },
  autoclaw: { label: 'AutoClaw', color: '#BE123C', brief: 'AutoClaw：能读能写，额度不过期' },
  // 036：DeepSeek Harness 只接只读任务（写操作接不上审批，见 docs/specs/036）。
  // 标签上就写「只读」，免得派单时忘了它碰不了文件。
  dsh: { label: 'dsh 只读', color: '#0D9488', brief: 'DeepSeek Harness：只读，能读代码和文档，但不能改文件、不能跑改文件的命令' },
  me: { label: '我', color: '#0F766E', brief: '你自己' },
};
/**
 * 只会读、不会写的执行者。大脑要改文件的活不能派给它们。
 *
 * dsh 是硬限制（036：写操作接不上审批）。
 * workbuddy（codebuddy）默认只有 `-p` 跑只读这条路验过，PreToolUse 审批钩子还没验通（037），
 * 所以**按只读算**——不能因为注册表里写着「能改 dev」就认为它现在能改文件。
 * 037 验通以后把它从这里去掉，那才是真的放宽（042.2）。
 */
export const READ_ONLY_EXECUTORS = new Set(['dsh', 'workbuddy']);
export const AGENT_EXECUTORS = ['claude', 'codex', 'pool', 'local', 'workbuddy', 'zcode', 'autoclaw'];

export const STATUSES: Record<string, { label: string; color: string }> = {
  inbox: { label: '收件 · 待分派', color: '#9CA3AF' },
  queued: { label: '排队', color: '#A8A29E' },
  running: { label: '运行中', color: '#2563EB' },
  review: { label: '等审批', color: '#C2410C' },
  // 055.2：agent 在回答末尾提了问题，停在这里等你选。不占名额、不花 token；不能靠 PATCH 手动设成它。
  asking: { label: '等你选', color: '#C2410C' },
  done: { label: '已完成', color: '#16A34A' },
  failed: { label: '失败', color: '#B91C1C' },
};
/** Board columns. Failed tasks sit in the review column: both need you. 055.2：等你选的也在这一列。 */
export const BOARD_COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'inbox', label: '收件 · 待分派', statuses: ['inbox'] },
  { key: 'queued', label: '排队', statuses: ['queued'] },
  { key: 'running', label: '运行中', statuses: ['running'] },
  { key: 'review', label: '等审批 · 待处理', statuses: ['review', 'asking', 'failed'] },
  { key: 'done', label: '已完成', statuses: ['done'] },
];

export const CATEGORIES: Record<string, string> = {
  dev: '开发',
  content: '内容',
  ops: '运维',
  docs: '文档',
  personal: '个人',
};

/** 055：自媒体平台。顺序就是页面上的顺序；mark 是头像里那一两个字。 */
export const MEDIA_PLATFORMS: { key: string; label: string; mark: string; abroad: boolean }[] = [
  { key: 'bilibili', label: 'B站', mark: 'B', abroad: false },
  { key: 'xiaohongshu', label: '小红书', mark: '红', abroad: false },
  { key: 'douyin', label: '抖音', mark: '抖', abroad: false },
  { key: 'channels', label: '视频号', mark: '视', abroad: false },
  { key: 'x', label: 'X', mark: 'X', abroad: true },
  { key: 'instagram', label: 'Instagram', mark: 'IG', abroad: true },
  { key: 'facebook', label: 'Facebook', mark: 'FB', abroad: true },
];
export const mediaLabel = (k: string) => MEDIA_PLATFORMS.find((p) => p.key === k)?.label ?? k;
/** 1.2万 / 3,456：中文习惯，过万用「万」。 */
export const fmtCount = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}万`;
  return n.toLocaleString('en-US');
};

export const RISKS: Record<string, { label: string; rank: number }> = {
  low: { label: '低风险', rank: 1 },
  medium: { label: '中风险', rank: 2 },
  high: { label: '高风险', rank: 3 },
};

export const DECISIONS: Record<string, string> = {
  approved: '批准',
  rejected: '驳回',
  changes: '打回修改',
  takeover: '我来接管',
};

// ---------- 011: display labels ----------
// Only the words on screen change. Keys stay keys everywhere: database, API, hooks, audit.
export type LabelSet = { preset: 'default' | 'crew'; executors: Record<string, string>; sections: Record<string, string> };

const CREW_EXECUTORS: Record<string, string> = {
  me: '制片人',
  claude: '导演',
  local: '执行导演',
  codex: 'B 组导演',
  zcode: '场务组',
  pool: '后期组',
  workbuddy: '外援 · WorkBuddy',
  autoclaw: '外援 · AutoClaw',
};

const CREW_SECTIONS: Record<string, string> = {
  inbox: '审片',
  board: '拍摄进度',
  mine: '制片待办',
  done: '杀青',
  accounts: '预算表',
  executors: '花名册',
  team: '剧组',
};

const EMPTY_LABELS: LabelSet = { preset: 'default', executors: {}, sections: {} };
let labelCache: LabelSet | null = null;
let labelRaw = '';

const cleanName = (v: unknown): string => String(v ?? '').trim().slice(0, 12);

/** Reads the override once per stored value; the settings page clears it after saving. */
export function labels(): LabelSet {
  const row = db().prepare("SELECT value FROM settings WHERE key = 'labels'").get() as { value: string } | undefined;
  const raw = row?.value ?? '';
  if (labelCache && raw === labelRaw) return labelCache;
  labelRaw = raw;
  try {
    const p = JSON.parse(raw || '{}');
    labelCache = {
      preset: p.preset === 'crew' ? 'crew' : 'default',
      executors: p.executors && typeof p.executors === 'object' ? p.executors : {},
      sections: p.sections && typeof p.sections === 'object' ? p.sections : {},
    };
  } catch {
    labelCache = EMPTY_LABELS;
  }
  return labelCache!;
}

export const clearLabelCache = () => { labelCache = null; labelRaw = ''; };

export function saveLabels(input: { preset?: string; executors?: Record<string, unknown>; sections?: Record<string, unknown> }): LabelSet {
  const preset = input.preset === 'crew' ? 'crew' : 'default';
  const executors: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.executors ?? {})) {
    if (!EXECUTORS[k]) continue;
    const name = cleanName(v);
    if (name) executors[k] = name;
  }
  const sections: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.sections ?? {})) {
    const name = cleanName(v);
    if (name) sections[k] = name;
  }
  const value = JSON.stringify({ preset, executors, sections });
  db().prepare("INSERT INTO settings (key, value) VALUES ('labels', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  clearLabelCache();
  return labels();
}

export function execLabel(k: string): string {
  const l = labels();
  return l.executors[k] || (l.preset === 'crew' ? CREW_EXECUTORS[k] : '') || EXECUTORS[k]?.label || k;
}

export function sectionLabel(k: string, fallback: string): string {
  const l = labels();
  return l.sections[k] || (l.preset === 'crew' ? CREW_SECTIONS[k] : '') || fallback;
}

export const crewPreset = () => ({ executors: CREW_EXECUTORS, sections: CREW_SECTIONS });

export const execColor = (k: string) => EXECUTORS[k]?.color ?? '#9CA3AF';
export const catLabel = (k: string) => CATEGORIES[k] ?? k;
export const statusLabel = (k: string) => STATUSES[k]?.label ?? k;

export const nowIso = () => new Date().toISOString();

const TZ = process.env.WB_TZ ?? 'Asia/Shanghai';
function parts(iso: string | Date) {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), wd: get('weekday') };
}
/** Calendar day (YYYY-MM-DD) in the display time zone. */
export function dayOf(iso: string | Date): string {
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d}`;
}
/** Date and HHmm in the display time zone — backup file names sort by it. */
export function stampOf(d: Date = new Date()): { date: string; time: string } {
  const p = parts(d);
  return { date: `${p.y}-${p.m}-${p.d}`, time: `${p.h}${p.mi}` };
}
/** Minutes since midnight in the display time zone. */
export function minutesOfDay(d: Date = new Date()): number {
  const p = parts(d);
  return Number(p.h) * 60 + Number(p.mi);
}
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const p = parts(iso);
  return `${p.h}:${p.mi}`;
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const p = parts(iso);
  return `${p.m}/${p.d} ${p.h}:${p.mi}`;
}
export function headerStamp(d = new Date()): string {
  const p = parts(d);
  return `${p.wd.toUpperCase()} · ${p.m}/${p.d} · ${p.h}:${p.mi}`;
}
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}
/** Last n calendar days (oldest first), ending today, in display TZ. */
export function lastDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayOf(new Date(Date.now() - i * 86400000)));
  return out;
}
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
