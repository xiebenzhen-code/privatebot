// Shared test helper: a browser-like session for endpoints that only a person may call (008.2).
//
// 043：全套用例并行跑时，这里偶尔直接抛 `fetch failed`（连接还没建起来就被重置），
// 一条 beforeEach 挂掉会连坐同文件里后面的用例。重试两次就够，真的连不上再报清楚原因。
export async function loginCookie(base: string, password: string): Promise<string> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(password)}`,
        redirect: 'manual',
      });
      return (res.headers.get('set-cookie') ?? '').split(';')[0];
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  const cause = (last as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  throw new Error(`登录 ${base} 失败：${cause?.code ?? ''} ${cause?.message ?? String(last)}`.trim());
}
