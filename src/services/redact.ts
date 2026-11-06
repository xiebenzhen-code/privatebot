// 028: one module for "make this text safe to store and show". It has no imports on purpose —
// putting it in sources.ts made tasks → sources → balances → tasks, and three test files hung.
//
// 028.1: 打码要刚好够用，不能把普通英文单词也当密钥。原来的「关键词 + 空格 + 6 个以上字符」
// 会把 "The key features include approvals" 打成 "The key *** include"，用户读的就是这块结果。

/** 值看起来像不像一个令牌：前缀白名单，或者够长且含数字。 */
const TOKEN_PREFIX = /^(?:eyJ|sk-|gh[pousr]_|AIza|xox[abpr]-|glpat-|npm_|AKIA)/i;

export function looksLikeToken(value: string): boolean {
  const v = String(value ?? '');
  if (!v) return false;
  if (TOKEN_PREFIX.test(v)) return true;
  return v.length >= 16 && /\d/.test(v);
}

/** Keys, tokens, passwords, long opaque strings. */
export function redactText(text: string): string {
  const s = String(text ?? '');
  return (
    s
      // 有分隔符的写法（冒号、等号、引号）保持原样打码：password: hunter2、{"token":"abc123"}
      // 值恰好是 Bearer 时不动——后面才是令牌，交给下一条规则打，别把关键词也吃掉。
      .replace(
        /(authorization|token|key|secret|password)(["']?\s*[:=]\s*["']?)([^\s,;"'}]{6,})/gi,
        (m, kw: string, sep: string, val: string) => (/^bearer$/i.test(val) ? m : `${kw}${sep}***`),
      )
      // 028.2：带冒号/等号的请求头不是普通英文——`Authorization: Bearer xxx` 不论长短都打。
      // 028.1 收严「只有空格」的写法时，把这种最典型的写法一起放掉了（`Bearer abc123def` 原样留着）。
      .replace(/\b(authorization["']?\s*[:=]\s*["']?bearer\s+)([^\s,;"'}]{1,})/gi, '$1***')
      // 只有空格的写法容易误伤普通英文：只认 Bearer / Authorization，且值要像令牌
      .replace(/\b(bearer|authorization)(\s+)([^\s,;"']{6,})/gi, (m, kw: string, ws: string, val: string) =>
        looksLikeToken(val) ? `${kw}${ws}***` : m,
      )
      .replace(/\b(token|key|secret|password)[A-Za-z0-9_-]{8,}\b/gi, '$1***') // tokenAbCdEf123, no separator
      .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-***')
      // 028.1: 地址里的凭据。git 推送失败会把 https://user:pwd@github.com/... 原样带进错误信息。
      .replace(/:\/\/[^\s/@]+@/g, '://***@')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
  );
}

/**
 * 028: `C:\Users\某人\proj` / `/home/某人/proj` / `/Users/某人/proj` → `~\proj`.
 * A model's answer quotes paths all the time; the account name is not something to ship around.
 *
 * 028.1: Windows 的 Users 目录不分大小写（模型常写 `c:\users\`）；用户名可以含空格
 * （`C:\Users\Zhang San\Desktop`），所以取「下一个路径分隔符」为止。
 *
 * 028.2: 原来的写法把「用户名之后到行尾」整段吞进捕获组，一行里第二个路径就漏了
 * （`C:\Users\bob\a and C:\Users\bob\b` → 只打第一个）。现在只吃到用户名为止：
 * 下一个分隔符、标点、另一个路径的开头、中文、行尾。没有分隔符时宁可按行尾处理——
 * 留个 `San` 在页面上就是漏。
 */
export function redactPath(text: string): string {
  return String(text ?? '')
    .replace(
      /\b([A-Za-z]:[\\/]users[\\/])(?!~)([^\r\n\\/]*?)(?=[\\/]|[,;:"'()\[\]<>。，；：）】]|\s+[A-Za-z]:[\\/]|(?<![^\x00-\x7F])\s+[^\x00-\x7F]|[\r\n]|$)/gi,
      (_m, head: string, name: string) => (name ? `${head}~` : head),
    )
    .replace(/(?<![A-Za-z]:)(\/home\/)([^/\s'"`]+)/gi, '$1~')
    .replace(/(?<![A-Za-z]:)(\/Users\/)([^/\s'"`]+)/gi, '$1~');
}

/** Everything, in the order that matters: keys first, then account names. */
export const redactAll = (text: string): string => redactPath(redactText(text));

/** 028: the result block is capped at 8000 characters; cut before storing, not at render time. */
export const RESULT_MAX = 8000;

export function cleanResult(text: string, max = RESULT_MAX): string {
  return redactAll(String(text ?? '')).slice(0, max);
}

/** 028: one line of the process trail — no newlines, no long junk, scrubbed. */
export function cleanLogLine(text: string, max = 300): string {
  return redactAll(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
}
