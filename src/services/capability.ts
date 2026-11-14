// 045 §4：能力档案 = 评测先验 + 自己的战绩。
//
// 键是「执行框架 + 模型 + 分类」，不是执行者名字：同一个模型换个框架，分数能差一大截。
//   · 先验放在仓库里的 JSON（src/data/capability-priors.json），人查证后写，**每条必须有来源链接和日期**；
//   · 战绩取近 90 天、每个任务**第一条算数的运行**（limited / cancelled 不算，不是模型的错），
//     口径和 041 的「一次过」一样——所以窗口和 judge 都直接用 scorecard.ts 的；
//   · 混合：自己的权重 = n / (n + 5)，先验把 strong / medium / weak 当作 0.8 / 0.6 / 0.4 的一次过率。
//     5 单各占一半，20 单先验只剩 20%。
// 先验只是先验，永远标「先验（厂商自报）」，不当成事实。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../db.ts';
import { CATEGORIES } from '../domain.ts';
import { FEW, endedWindow, factsOf, firstScoredRuns, judge } from './scorecard.ts';

export type Level = 'strong' | 'medium' | 'weak';
export const LEVEL_RATE: Record<Level, number> = { strong: 0.8, medium: 0.6, weak: 0.4 };
export const LEVEL_TEXT: Record<Level, string> = { strong: '强', medium: '中', weak: '弱' };
/** 先验相当于多少单的样本。 */
export const PRIOR_WEIGHT = 5;
export const WINDOW_DAYS = 90;
/** 先验占比降到这个数以下，就不再叫「混合」，叫「实战」。20 单 = 5/25 = 20%。 */
const MATURE_SHARE = 0.2;

export type Evidence = {
  benchmark: string;
  score: number;
  source: string;
  as_of: string;
  vendor_reported: boolean;
  note?: string;
};

export type Prior = {
  harness: string;
  model: string;
  category: string;
  level: Level;
  evidence: Evidence[];
};

// ───────────────────────────── 先验文件 ─────────────────────────────

const KEY_RE = /^[\w.:/-]{1,80}$/;
const AS_OF_RE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

function bad(i: number, what: string): never {
  throw new Error(`能力先验第 ${i + 1} 条：${what}`);
}

function checkUrl(i: number, s: unknown): string {
  let u: URL;
  try { u = new URL(String(s)); } catch { return bad(i, `来源不是网址（${String(s).slice(0, 60)}）`); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) return bad(i, `来源不是网址（${String(s).slice(0, 60)}）`);
  return u.toString();
}

/** 校验先验文件。缺来源、缺日期、分数不在 0~1、键重复，一律报错——宁可不加载，也不带着没出处的数。 */
export function parsePriors(raw: unknown): Prior[] {
  if (!Array.isArray(raw)) throw new Error('能力先验文件应该是一个数组');
  const seen = new Set<string>();
  return raw.map((e, i) => {
    if (!e || typeof e !== 'object') return bad(i, '不是对象');
    const o = e as Record<string, unknown>;
    for (const k of ['harness', 'model', 'category'] as const) {
      if (typeof o[k] !== 'string' || !KEY_RE.test(o[k] as string)) bad(i, `${k} 不合法`);
    }
    if (!CATEGORIES[o.category as string]) bad(i, `category「${o.category}」不是已知分类`);
    if (!(o.level === 'strong' || o.level === 'medium' || o.level === 'weak')) bad(i, 'level 只能是 strong / medium / weak');
    if (!Array.isArray(o.evidence) || !o.evidence.length) bad(i, '至少要有一条 evidence（出处）');
    const evidence = (o.evidence as unknown[]).map((x, j) => {
      const v = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const at = `evidence[${j}]`;
      if (typeof v.benchmark !== 'string' || !v.benchmark.trim()) bad(i, `${at} 缺 benchmark`);
      if (typeof v.score !== 'number' || !(v.score >= 0 && v.score <= 1)) bad(i, `${at} 的 score 要在 0~1 之间`);
      if (typeof v.as_of !== 'string' || !AS_OF_RE.test(v.as_of)) bad(i, `${at} 缺日期 as_of（写成 2026-10 或 2026-10-19）`);
      if (typeof v.vendor_reported !== 'boolean') bad(i, `${at} 要写明 vendor_reported（是不是厂商自报）`);
      if (v.note !== undefined && typeof v.note !== 'string') bad(i, `${at} 的 note 应该是文字`);
      const out: Evidence = {
        benchmark: String(v.benchmark).trim(), score: v.score as number, source: checkUrl(i, v.source),
        as_of: v.as_of as string, vendor_reported: v.vendor_reported as boolean,
      };
      if (typeof v.note === 'string' && v.note.trim()) out.note = v.note.trim();
      return out;
    });
    const key = `${o.harness}\u0000${o.model}\u0000${o.category}`;
    if (seen.has(key)) bad(i, `${o.harness} + ${o.model} + ${o.category} 重复了`);
    seen.add(key);
    return { harness: o.harness as string, model: o.model as string, category: o.category as string, level: o.level as Level, evidence };
  });
}

let cache: Prior[] | undefined;
/** 读仓库里的先验文件。读不动就抛错、不缓存，下次再试。 */
export function loadPriors(): Prior[] {
  if (!cache) {
    const file = fileURLToPath(new URL('../data/capability-priors.json', import.meta.url));
    cache = parsePriors(JSON.parse(readFileSync(file, 'utf8')));
  }
  return cache;
}

// ───────────────────────────── 战绩样本 ─────────────────────────────

/** 一个任务的一条样本：它的第一条算数运行是谁（框架 + 模型）跑的，以及有没有一次过。 */
export type Sample = { harness: string; model: string; category: string; pass: boolean };

/**
 * 近 `days` 天结束的任务，每个取第一条算数的运行（不含 limited / cancelled / 还在跑的）。
 * 那条运行没记框架或模型的（回填来的、配置里没写模型的）不进样本——读不出来不等于没有，不猜。
 */
export function samples(days = WINDOW_DAYS, now: Date = new Date()): Sample[] {
  const { ended } = endedWindow(days, now);
  if (!ended.length) return [];
  const ids = ended.map((t) => t.id);
  const facts = factsOf(ids);
  const { first } = firstScoredRuns(ids);

  const out: Sample[] = [];
  for (const t of ended) {
    const r = first.get(t.id);
    if (!r || !r.harness || !r.model || r.executor === 'me') continue;
    const outcome = judge(t, facts.get(t.id));
    // 041 的底线是「接手优先」：被你接过去的单不算执行者的失败，也就不能当模型的失败样本。
    if (outcome === 'unfinished' || outcome === 'takeover') continue;
    out.push({ harness: r.harness, model: r.model, category: t.category, pass: outcome === 'first_pass' });
  }
  return out;
}

// ───────────────────────────── 混合 ─────────────────────────────

/** 纯算术，单独拿出来好测。没有先验又没样本返回 null。 */
export function blend(n: number, ownRate: number | null, level: Level | null): { value: number | null; prior_share: number } {
  const prior = level ? LEVEL_RATE[level] : null;
  const has = n > 0 && ownRate !== null;
  if (prior === null) return { value: has ? ownRate : null, prior_share: 0 };
  if (!has) return { value: prior, prior_share: 1 };
  const w = n / (n + PRIOR_WEIGHT);
  return { value: w * ownRate + (1 - w) * prior, prior_share: 1 - w };
}

export type CapabilityLabel = '先验' | '混合' | '实战';

export type Capability = {
  harness: string;
  model: string;
  category: string;
  /** 近 90 天的样本数（第一条算数的运行）。 */
  n: number;
  /** 自己的一次过率；没有样本是 null。 */
  own_rate: number | null;
  prior_level: Level | null;
  prior_rate: number | null;
  /** 混合值：0–1，两位小数。没有先验、也没有样本的键不会出现。 */
  blended: number | null;
  /** 先验占多少：0–1。 */
  prior_share: number;
  label: CapabilityLabel;
  /** 没有先验、又不到 5 单：页面别给百分比。有先验时先验顶着，不算样本少。 */
  sample: 'ok' | 'few';
  evidence: Evidence[];
};

const r2 = (x: number) => Math.round(x * 100) / 100;

export function capabilities(opts: { days?: number; now?: Date; priors?: Prior[] } = {}): { days: number; items: Capability[] } {
  const days = opts.days ?? WINDOW_DAYS;
  const priors = opts.priors ?? loadPriors();
  const keyOf = (h: string, m: string, c: string) => `${h}\u0000${m}\u0000${c}`;
  const cells = new Map<string, { harness: string; model: string; category: string; n: number; pass: number }>();
  for (const s of samples(days, opts.now)) {
    const k = keyOf(s.harness, s.model, s.category);
    const c = cells.get(k) ?? { harness: s.harness, model: s.model, category: s.category, n: 0, pass: 0 };
    c.n++;
    if (s.pass) c.pass++;
    cells.set(k, c);
  }
  const priorOf = new Map(priors.map((p) => [keyOf(p.harness, p.model, p.category), p]));
  const keys = new Set([...cells.keys(), ...priorOf.keys()]);
  const items: Capability[] = [];
  for (const k of keys) {
    const c = cells.get(k);
    const p = priorOf.get(k);
    const base = c ?? p!;
    const n = c?.n ?? 0;
    const own = c && c.n ? c.pass / c.n : null;
    const b = blend(n, own, p?.level ?? null);
    items.push({
      harness: base.harness, model: base.model, category: base.category,
      n,
      own_rate: own === null ? null : r2(own),
      prior_level: p?.level ?? null,
      prior_rate: p ? LEVEL_RATE[p.level] : null,
      blended: b.value === null ? null : r2(b.value),
      prior_share: r2(b.prior_share),
      label: !p ? '实战' : b.prior_share >= 1 ? '先验' : b.prior_share <= MATURE_SHARE ? '实战' : '混合',
      sample: !p && n < FEW ? 'few' : 'ok',
      evidence: p?.evidence ?? [],
    });
  }
  items.sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model) || a.category.localeCompare(b.category));
  return { days, items };
}

// ───────────────────────────── 给大脑看的一句话 ─────────────────────────────

/** 每个执行者最近一次算数的运行用的是什么框架 + 模型——大脑只会派「执行者」，要靠这个找到它背后的模型。 */
export function executorModels(): Map<string, { harness: string; model: string }> {
  const rows = db().prepare(`SELECT executor, harness, model FROM runs
    WHERE harness <> '' AND model <> '' AND outcome NOT IN ('limited', 'cancelled', 'running', 'asked')
    ORDER BY started_at DESC, id DESC`).all() as { executor: string; harness: string; model: string }[];
  const out = new Map<string, { harness: string; model: string }>();
  for (const r of rows) if (!out.has(r.executor)) out.set(r.executor, { harness: r.harness, model: r.model });
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * 附在候选后面的一句话。`full` 带先验，`lean` 只留实战——提示词超预算时先裁先验（042 的 4000 字符）。
 * 先验不够具体、也没有实战的，返回 null，不占字数。
 */
export function capabilityNote(cap: Capability | undefined): { full: string; lean: string } | null {
  if (!cap) return null;
  const who = cap.model;
  const real = cap.n >= FEW
    ? `${who} 近 ${WINDOW_DAYS} 天 ${cap.n} 单 · 一次过 ${pct(cap.own_rate ?? 0)}`
    : cap.n > 0 ? `${who} 近 ${WINDOW_DAYS} 天 ${cap.n} 单（样本太少）` : '';
  if (cap.label === '先验') return { full: `${who} 评测先验约 ${pct(cap.blended ?? 0)}（厂商自报，还没跑过）`, lean: '' };
  if (cap.label === '混合') return { full: `${real}；混合约 ${pct(cap.blended ?? 0)}（先验占 ${pct(cap.prior_share)}）`, lean: real };
  return real ? { full: real, lean: real } : null;
}
