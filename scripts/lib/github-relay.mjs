// 048：GitHub 凭据和 HTTP 只在宿主机执行器。工作台负责解析、作者白名单和回写队列。
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INBOX = '/api/runner/github/inbox';
const OUTBOX = '/api/runner/github/outbox';
const NUMBER = (n) => Number.isSafeInteger(n) && n > 0;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const WORKER = fileURLToPath(import.meta.url);

export const githubToken = (cfg) => String(cfg.githubToken || process.env.GITHUB_TOKEN || '').trim();

async function githubFetch(url, token, method, body, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method, redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null };
}

// 显式代理只影响这次 GitHub 请求，工作台的 HTTP 和编码进程不继承它。令牌经 stdin 传递。
function viaProxy(proxy, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--use-env-proxy', WORKER, '--github-fetch'], {
      windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, https_proxy: proxy, http_proxy: proxy, no_proxy: '' },
    }, (err, stdout) => {
      if (err) return reject(new Error('GitHub 代理连接失败'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('GitHub 代理返回的数据不完整')); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(args));
  });
}

export function githubClient(cfg, { fetchImpl = fetch, base = 'https://api.github.com' } = {}) {
  const token = githubToken(cfg);
  const proxy = String(cfg.githubProxy ?? '').trim();
  return async (method, path, body) => {
    if (!token) throw new Error('执行器没有配置 GitHub 令牌');
    if (proxy && !process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
      throw new Error('GitHub 代理需要支持 --use-env-proxy 的 Node（如 22.21 或更新的 LTS）');
    }
    let res;
    try {
      const url = base + path;
      res = proxy ? await viaProxy(proxy, { url, token, method, body }) : await githubFetch(url, token, method, body, fetchImpl);
    } catch {
      // 原始网络错误可能带代理 URL 或凭据；只转发固定的说明。
      throw new Error('连接 GitHub 失败，请检查执行器网络和代理');
    }
    if (!res.ok) throw new Error(`GitHub ${method} 请求失败（HTTP ${res.status}）`);
    return res.data;
  };
}

async function* pages(request, path, count, limit = Infinity) {
  for (let page = 1; page <= limit; page++) {
    const data = await request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${count}&page=${page}`);
    if (!Array.isArray(data)) throw new Error('GitHub 返回的数据格式不对');
    yield data;
    if (data.length < count) return;
  }
}

export async function relayIssues(repos, { request, call }) {
  const totals = { created: 0, commands: 0, skipped: 0 };
  const forward = async (repo, issue, comments) => {
    const result = await call('POST', INBOX, { kind: 'issues', repo, items: [{ issue, comments }] });
    for (const key of Object.keys(totals)) totals[key] += Number(result?.[key]) || 0;
  };
  let error = '';
  for (const repo of repos.filter((r) => REPO.test(r))) {
    try {
      for await (const issues of pages(request, `/repos/${repo}/issues?labels=wb-task&state=open`, 50)) {
        for (const issue of issues) {
          if (issue?.pull_request || !NUMBER(issue?.number)) continue;
          const skipped = totals.skipped;
          await forward(repo, issue, []);
          if (totals.skipped > skipped) continue;
          for await (const comments of pages(request, `/repos/${repo}/issues/${issue.number}/comments`, 100)) {
            // 一页评论可能大于工作台请求体上限。按小批转发，不截断命令正文。
            for (let i = 0; i < comments.length; i += 10) await forward(repo, issue, comments.slice(i, i + 10));
          }
        }
      }
    } catch (err) {
      error ||= `${repo}：${err.message}`;
    }
  }
  if (repos.length) await call('POST', INBOX, { kind: 'status', error });
  return totals;
}

export async function relayQueue(repo, { request, call }) {
  if (!REPO.test(repo ?? '')) return null;
  let text;
  try {
    const file = await request('GET', `/repos/${repo}/contents/docs/specs/queue.json?ref=main`);
    if (file?.encoding !== 'base64' || typeof file?.content !== 'string') throw new Error('没有收到 queue.json 的文件内容');
    text = Buffer.from(file.content, 'base64').toString('utf8');
  } catch (err) {
    return call('POST', INBOX, { kind: 'queue', repo, error: err.message });
  }
  return call('POST', INBOX, { kind: 'queue', repo, text });
}

const FIXED_ISSUES = {
  selfdev: ['wb-selfdev', '工作台自己开发自己：执行结果', '执行器做完的 selfdev 任务结果会作为评论回到这里。'],
  digest: ['wb-digest', '工作台日报', '工作台每天往这里写一条概况。这里只出不进。'],
};

async function sendJob(job, request) {
  if (!REPO.test(job.repo) || !/^[a-f0-9-]{36}$/i.test(job.message_key)) throw new Error('回写任务格式不对');
  let number = job.issue_number;
  if (!NUMBER(number)) {
    const fixed = FIXED_ISSUES[job.kind];
    if (!Array.isArray(fixed)) throw new Error('没有有效的 Issue 编号');
    const [label, title, body] = fixed;
    const issues = await request('GET', `/repos/${job.repo}/issues?labels=${label}&state=open&per_page=10`);
    const issue = (Array.isArray(issues) ? issues : []).find((i) => !i.pull_request && NUMBER(i.number) &&
      (!Array.isArray(i.labels) || i.labels.some((l) => l.name === label || l === label)));
    number = issue?.number ?? (await request('POST', `/repos/${job.repo}/issues`, { labels: [label], title, body }))?.number;
  }
  if (!NUMBER(number)) throw new Error('GitHub 没有返回有效的 Issue 编号');
  const path = `/repos/${job.repo}/issues/${number}/comments`;
  const marker = `<!-- wb-relay:${job.message_key} -->`;
  if (job.attempts > 1) {
    // POST 成功但回报丢失时，靠持久标记恢复，不发第二条。
    for await (const comments of pages(request, path, 100)) {
      const prior = comments.find((c) => NUMBER(c?.id) && String(c.body ?? '').endsWith(marker));
      if (prior) return { ok: true, issue_number: number, comment_id: prior.id };
    }
  }
  const comment = await request('POST', path, { body: `${job.body}\n\n${marker}` });
  if (!NUMBER(comment?.id)) throw new Error('GitHub 没有返回有效的评论编号');
  return { ok: true, issue_number: number, comment_id: comment.id };
}

export async function relayOutbox({ call, request }, first = undefined) {
  let settings = first ?? await call('GET', OUTBOX);
  let job = settings?.job;
  for (let i = 0; job && i < 20; i++) {
    let result;
    try { result = await sendJob(job, request); }
    catch (err) { result = { ok: false, error: err.message }; }
    await call('POST', `${OUTBOX}/${job.id}`, { lease: job.lease, ...result });
    if (i < 19) job = (await call('GET', OUTBOX))?.job;
  }
  return settings;
}

export async function githubRelayRound(cfg, { api, request = githubClient(cfg) }) {
  const call = (method, path, body) => api(cfg, method, path, body);
  const io = { call, request };
  const settings = await call('GET', OUTBOX + (githubToken(cfg) ? '' : '?peek=1'));
  if (!githubToken(cfg)) {
    if (settings?.repos?.length) await call('POST', INBOX, { kind: 'status', error: '执行器没有配置 GitHub 令牌' });
    if (settings?.self_repo) await call('POST', INBOX, { kind: 'queue', repo: settings.self_repo, error: '执行器没有配置 GitHub 令牌' });
    return;
  }
  await relayOutbox(io, settings);
  await relayIssues(settings?.repos ?? [], io);
  await relayQueue(settings?.self_repo, io);
  await relayOutbox(io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--github-fetch') {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const { url, token, method, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(await githubFetch(url, token, method, body)));
  } catch { process.exitCode = 1; }
}
