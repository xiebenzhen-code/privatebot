// Tiny escaping template tag. Every interpolated value is HTML-escaped unless it is already Safe.
export class Safe {
  value: string;
  constructor(value: string) { this.value = value; }
  toString() { return this.value; }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v: unknown): string {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(esc).join('');
  if (v === null || v === undefined || v === false) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Safe {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += esc(vals[i]) + strings[i + 1];
  return new Safe(out);
}

export const raw = (s: string) => new Safe(s);

/** Build a URL keeping current query params, applying overrides (null/'' removes a key). */
export function href(path: string, current: URLSearchParams, overrides: Record<string, string | number | null | undefined> = {}): string {
  const p = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined || v === '') p.delete(k);
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}
