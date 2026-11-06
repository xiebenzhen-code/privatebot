// 028.1: 结果区按 Markdown 显示，但只认很少几种写法。
// 铁律：先转义再加格式——每一段文本都走 html``，不用 raw() 包原文，
// 所以 <script>、<img onerror>、[x](javascript:…) 在页面上就是普通文字。
import { html, type Safe } from './html.ts';

/** 行内：`代码` 和 **加粗**。别的符号原样留着。 */
function inline(text: string): Safe {
  const parts: Safe[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(html`${text.slice(last, m.index)}`);
    const tok = m[0];
    parts.push(
      tok.startsWith('`') ? html`<code>${tok.slice(1, -1)}</code>` : html`<strong>${tok.slice(2, -2)}</strong>`,
    );
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(html`${text.slice(last)}`);
  return html`${parts}`;
}

/**
 * 认这几种：# ~ ### 标题、**加粗**、`行内代码`、``` 代码块、> 引用、- / 1. 列表、空行分段。
 * 链接、图片、HTML 标签一律当文字（不做链接化，也不过滤——转义之后它们本来就只是字符）。
 */
export function renderMarkdown(text: string): Safe {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: Safe[] = [];
  let para: string[] = [];

  const flush = () => {
    if (!para.length) return;
    out.push(html`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flush();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(html`<pre class="code-block"><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      const body = inline(h[2].trim());
      const n = h[1].length;
      // 抽屉里已经有 h2（标题）和 h3（「结果」），这里的标题从 h4 起，别把文档大纲打乱。
      out.push(n === 1 ? html`<h4>${body}</h4>` : n === 2 ? html`<h5>${body}</h5>` : html`<h6>${body}</h6>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      i -= 1;
      out.push(html`<ul>${items.map((t) => html`<li>${inline(t)}</li>`)}</ul>`);
      continue;
    }

    // 引用块：模型很爱用 > 引一句原话。不认它就会把 > 当正文留在页面上。
    if (/^\s*>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      i -= 1;
      out.push(html`<blockquote>${inline(quoted.filter(Boolean).join(' '))}</blockquote>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      i -= 1;
      out.push(html`<ol>${items.map((t) => html`<li>${inline(t)}</li>`)}</ol>`);
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return html`<div class="md">${out}</div>`;
}
