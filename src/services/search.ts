// 031b：找得到才算记得。
//
// 第一版**不做全文索引**：单人几千个任务、每条结果最多 8000 字，SQL LIKE 扫一遍是毫秒级，
// 而 FTS5 要建虚拟表 + 触发器同步，迁移一做错就是「搜不到但有数据」。数据量真大了再换
// （Node 内置 SQLite 支持 FTS5 和 trigram 分词，不用加依赖）。
//
// 这里只放纯函数：把用户输入拆成词、转义成 LIKE 模式、把命中位置前后剪出来。
// 打 SQL 的是 services/tasks.ts，画页面的是 views/tasks.ts。

/** 一次最多认几个词：再多也没人看，还会让 SQL 变长。 */
const MAX_TERMS = 8;
/** 单个词最长多少字：超过这个长度基本是粘贴了一整段，不是搜词。 */
const MAX_TERM_CHARS = 60;

/** 空格分隔的多个词，全部命中才算；去重（不区分大小写）、丢掉空串、限量限长。 */
export function searchTerms(q: string | null | undefined): string[] {
  if (!q) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of q.split(/\s+/)) {
    const term = piece.slice(0, MAX_TERM_CHARS);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** LIKE 的 `%` `_` `\` 必须先转义，SQL 里配 `ESCAPE '\'`；不然搜 `%` 会命中一切。 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type Piece = { text: string; hit: boolean };
type Range = { start: number; end: number };

/**
 * 命中位置前后各 before / after 个字符。命中处标成 `hit: true` 的片段，由页面包 `<mark>`。
 * 一个词都没命中返回 null —— 调用方据此换下一个字段去找。
 */
export function snippetOf(text: string, terms: string[], before = 40, after = 40): Piece[] | null {
  if (!text || !terms.length) return null;
  const lower = text.toLowerCase();
  let first = -1;
  let firstLen = 0;
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at >= 0 && (first < 0 || at < first)) { first = at; firstLen = term.length; }
  }
  if (first < 0) return null;

  const start = Math.max(0, first - before);
  const end = Math.min(text.length, first + firstLen + after);
  const out = mark(text.slice(start, end), terms);
  if (start > 0) out.unshift({ text: '…', hit: false });
  if (end < text.length) out.push({ text: '…', hit: false });
  return out;
}

/** 把窗口里所有词的命中处切出来；重叠的合并成一段，避免 `<<mark>a</mark>b>` 这种碎标签。 */
function mark(window: string, terms: string[]): Piece[] {
  const lower = window.toLowerCase();
  const ranges: Range[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      ranges.push({ start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const out: Piece[] = [];
  let at = 0;
  for (const r of merged) {
    if (r.start > at) out.push({ text: window.slice(at, r.start), hit: false });
    out.push({ text: window.slice(r.start, r.end), hit: true });
    at = r.end;
  }
  if (at < window.length) out.push({ text: window.slice(at), hit: false });
  return out;
}
