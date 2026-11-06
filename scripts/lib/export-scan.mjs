// 022 · 扫描规则，给 export-trial.mjs 和 diagnose.mjs 共用。
// 纯 JS、零依赖，Node 18+。
//
// 设计要点：
//  • 命中只上报「文件、行号、规则」，预览最多露出前 2 个字符和长度——终端日志本身不能变成泄露源。
//  • 显然无害的占位（`sk-REDACTED`、`Bearer <你的令牌>`、`example.com` 邮箱、`127.0.0.1`）
//    在规则里直接放行；剩下确属无害的命中用 export-allow.json 按「文件+规则+行哈希」登记。
//  • 个人黑名单词绝不出现在输出里，只显示规则名。

import { createHash } from 'node:crypto';

/** 一条扫描规则。`fake` 为真时命中值里含明显占位词就放行（test/example/redacted…）。 */
export const RULES = [
  { name: 'key-sk', re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, fake: true },
  { name: 'key-ghp', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'key-github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g },
  { name: 'key-aws', re: /\bAKIA[0-9A-Z]{12,}\b/g },
  { name: 'secret-assignment', re: /['"]?(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|webhook[_-]?url)['"]?\s*[:=]\s*['"]([^'"\n]{10,})['"]/gi, fake: true },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: 'webhook-url', re: /https:\/\/(?:open\.feishu\.cn|qyapi\.weixin\.qq\.com|hooks\.slack\.com|discord\.com)\/[^\s"'<>)\]]+/g },
  { name: 'private-ip', re: /\b(?:(?:192\.168|10)(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g },
  { name: 'personal-path', re: /(?:[A-Za-z]:[\\/](?:Users|home)[\\/][^\s"'<>|:]+|\/home\/[^\s"'<>|:]+)/g },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
];

const FAKE = /(?:test|example|dummy|redacted|placeholder|sample|fake|xxx+|你的|<[^>]*>|\$\{[^}]*\})/i;

/** 单个命中是否属于「文档占位 / 打码样本」这类显然无害的情况。 */
function harmless(rule, hit) {
  const h = hit.toLowerCase();
  if (rule.name === 'email') {
    if (/@example\.(?:com|org|net)\b/.test(h)) return true;
    if (h.startsWith('noreply@') || h.includes('@users.noreply.github.com')) return true;
    return false;
  }
  if (rule.name === 'webhook-url') {
    // 教程里的 webhook 示例地址，key 是占位符：key=xxx / key=… / key=<…> / key=${…} / key=your…
    return /key=(?:xxx+|\.{3}|…|<|\$\{|your)/i.test(hit);
  }
  if (rule.name === 'personal-path') {
    // 文档和测试里的「你的路径」占位：C:/Users/you/…、C:/Users/你/…、/home/me/…、C:/Users/**、C:/Users/<你的路径>
    const segs = hit.split(/[\\/]/);
    const i = segs.findIndex((s) => /^(?:Users|home)$/i.test(s));
    const name = i >= 0 ? segs[i + 1] ?? '' : segs[segs.length - 1];
    return /^(?:you|me|你|用户名|username|user|your.*|\*+|<.*>|\$\{[^}]*\})$/i.test(name) || FAKE.test(name);
  }
  if (rule.fake) return FAKE.test(hit) || /[^\x00-\x7F]/.test(hit); // 真 key 是 ASCII；带中文的是说明文字
  return false;
}

/**
 * 扫一段文本（一个文件的内容）。
 * @returns {{line:number, rule:string, preview:string, hash:string}[]}
 */
export function scanText(text, { blocklist = [] } = {}) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hash = lineHash(line);
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const hit = m[1] ?? m[0]; // secret-assignment 的命中值是捕获组（带引号的赋值不算内容本身）
        if (harmless(rule, hit)) continue;
        out.push({ line: i + 1, rule: rule.name, preview: previewOf(hit), hash });
      }
    }
    for (const word of blocklist) {
      if (word && line.toLowerCase().includes(word.toLowerCase())) {
        out.push({ line: i + 1, rule: '个人黑名单', preview: previewOf(word), hash });
      }
    }
  }
  return out;
}

/** 命中内容的预览：只露前 2 个字符，其余用长度代替——不把原文打印到终端。 */
const previewOf = (s) => `${s.slice(0, 2)}…(长度 ${s.length})`;

/** 放行登记用的行哈希。只存哈希，登记文件里永远没有原文。 */
export const lineHash = (line) =>
  createHash('sha256').update('ai-workbench/export-allow/v1').update('\0').update(line.replace(/\r$/, '')).digest('hex').slice(0, 16);

/**
 * 对一段要展示的文本做兜底脱敏（diagnose 输出用）：所有规则命中的片段替换成 [已隐藏]。
 */
export function redactForOutput(text, { blocklist = [] } = {}) {
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...cb) => {
      // 有捕获组时 cb[1] 是组内容；没有时 cb[1] 是 offset（数字）——统一取整个匹配。
      const value = typeof cb[1] === 'string' ? cb[1] : cb[0];
      const whole = cb[0];
      if (harmless(rule, value)) return whole;
      return String(whole).replace(value, '[已隐藏]');
    });
  }
  for (const word of blocklist) {
    if (!word) continue;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'gi'), '[已隐藏]');
  }
  return out;
}

/** 二进制判断：这些后缀不扫内容；其余看前 4KB 有没有 \0。 */
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|db|sqlite|woff2?|zip|gz)$/i;
export const isBinaryFile = (name, buf) =>
  BINARY_EXT.test(name) || buf.subarray(0, 4096).includes(0);
