// 031c：从模型的最终回答里读「## 备忘建议」一节。
//
// 为什么放在这里：执行器和服务端都要能读这一节（执行器解析、服务端测试），但执行器是单独
// 跑的 .mjs，不能 import 服务端的 .ts。所以纯函数放这一份，两边共用。
//
// 只认「一节标题 + 列表项」，最多 3 条、单条 300 字。宁可少收，也不要把回答正文里的列表
// 误当成备忘——那些多半是「改了哪几处」。

export const MAX_SUGGESTIONS = 3;
export const MAX_NOTE_CHARS = 300;

/** 标题的写法放宽一点：`## 备忘建议`、`### 备忘建议(3 条)`、`**备忘建议**` 都认。 */
const HEADING = /^\s*(?:#{1,6}\s*)?\*{0,2}\s*备忘建议\s*[:：]?\s*\*{0,2}\s*(?:[（(].*?[）)])?\s*$/;
/** 下一个同级或更高级标题：这一节到这里结束。 */
const NEXT_HEADING = /^\s*#{1,6}\s+\S/;
/** `- xxx`、`* xxx`、`1. xxx`、`1) xxx`。 */
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** 单条清洗：去掉行内多余空白、去掉包裹的引号、截到 300 字。 */
export function cleanSuggestion(raw) {
  let s = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '').trim();
  s = s.replace(/^备忘建议\s*[:：]\s*/, '');
  if (!s) return '';
  return s.length > MAX_NOTE_CHARS ? `${s.slice(0, MAX_NOTE_CHARS - 1)}…` : s;
}

/**
 * 解析回答末尾的建议。没有这一节 → `[]`。有这一节但没有列表项 → `[]`
 * （不把紧跟的一段话当建议：格式不对就当没写，宁可少收）。
 */
export function parseSuggestions(text, max = MAX_SUGGESTIONS) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start < 0) return [];

  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (NEXT_HEADING.test(line)) break;
    const m = BULLET.exec(line);
    if (!m) continue;
    const one = cleanSuggestion(m[1]);
    if (!one) continue;
    out.push(one);
    if (out.length >= Math.max(1, Number(max) || MAX_SUGGESTIONS)) break;
  }
  return out;
}
