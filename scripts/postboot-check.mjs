#!/usr/bin/env node
/**
 * 重启后自检 —— 把 002 的验收清单变成一条命令。
 *
 *   npm run postboot            # 立刻查一遍
 *   npm run postboot -- --wait 120   # 开机后马上跑，最多等 120 秒让引擎和容器起来
 *
 * 只读：不启动、不修改任何东西。有任一项不过就以退出码 1 结束，方便放进计划任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const waitAt = argv.indexOf('--wait');
const waitSec = waitAt >= 0 ? Number(argv[waitAt + 1]) || 0 : 0;
const deadline = Date.now() + waitSec * 1000;

// ---------- 配置 ----------
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const envFile = readEnvFile(path.join(root, '.env'));
const ENV = { ...envFile, ...process.env };

/** CLIProxyAPI 的两个密钥：优先环境变量，其次安装目录的 secrets.txt。 */
function cpaSecrets() {
  const out = { key: ENV.CPA_API_KEY ?? '', manage: ENV.CPA_MANAGEMENT_KEY ?? '' };
  if (out.key && out.manage) return out;
  for (const f of [
    process.env.CLIPROXY_DIR ? path.join(process.env.CLIPROXY_DIR, 'secrets.txt') : '',
    path.join(path.dirname(root), 'cliproxyapi', 'secrets.txt'),
    'C:/Users/you/cliproxyapi/secrets.txt',
  ].filter(Boolean)) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    out.key ||= text.match(/^\s*API_KEY\s*[=:]\s*(\S+)/m)?.[1] ?? '';
    out.manage ||= text.match(/^\s*SECRET_KEY\s*[=:]\s*(\S+)/m)?.[1] ?? '';
    return out;
  }
  return out;
}

const SECRETS = cpaSecrets();
const WB = (ENV.WB_URL ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const CPA_LOCAL = (ENV.CPA_LOCAL_URL ?? 'http://127.0.0.1:8317').replace(/\/$/, '');
const CPA_INNER = (ENV.CPA_URL ?? '').replace(/\/$/, '');
const BACKUP_DIR = ENV.WB_BACKUP_DIR ?? '';

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() || (err ? err.message : '') }),
    );
  });
}

async function getJson(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: e.message };
  }
}

/** 等一个条件成立，最多等到 deadline。 */
async function until(fn, label) {
  let last;
  for (;;) {
    last = await fn();
    if (last.ok || Date.now() > deadline) return last;
    process.stdout.write(`\r  … 等待${label}（还剩 ${Math.ceil((deadline - Date.now()) / 1000)}s）   `);
    await sleep(3000);
  }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- 检查项 ----------
async function checkDocker() {
  const r = await until(async () => {
    const d = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    return { ok: d.ok && !!d.out, detail: d.ok ? d.out : d.err.split('\n')[0] };
  }, 'Docker 引擎');
  record('Docker 引擎', r.ok, r.ok ? `版本 ${r.detail}` : `连不上：${r.detail}`);
  return r.ok;
}

async function checkContainers() {
  const want = [
    { name: 'ai-workbench', key: '工作台容器' },
    { name: 'cliproxyapi', key: '反代容器' },
  ];
  for (const w of want) {
    const r = await until(async () => {
      const d = await run('docker', ['inspect', '--format', '{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}', w.name]);
      if (!d.ok) return { ok: false, detail: '容器不存在' };
      const [status, policy] = d.out.split('|');
      return { ok: status === 'running', detail: `${status} · 重启策略 ${policy}` };
    }, w.key);
    record(`${w.key}（${w.name}）`, r.ok, r.detail);
  }
}

async function checkHealth() {
  const r = await until(async () => {
    const x = await getJson(`${WB}/api/health`);
    return { ok: x.status === 200 && x.body?.ok === true, detail: x.status ? `HTTP ${x.status}` : x.body };
  }, '工作台');
  record('工作台健康检查', r.ok, `${WB} · ${r.detail}`);
}

async function checkAccounts() {
  const token = ENV.WB_TOKEN ?? '';
  if (!token) return record('账号与额度', false, '没配 WB_TOKEN，跳过');
  const x = await getJson(`${WB}/api/accounts`, { authorization: `Bearer ${token}` });
  if (x.status !== 200 || !Array.isArray(x.body)) return record('账号与额度', false, `HTTP ${x.status} ${String(x.body).slice(0, 60)}`);
  const bad = x.body.filter((a) => a.status && a.status !== 'ok');
  const names = x.body.map((a) => a.name).slice(0, 6).join('、');
  record('账号与额度', x.body.length > 0 && bad.length === 0,
    `${x.body.length} 个账号${bad.length ? `，异常 ${bad.map((a) => a.name).join('、')}` : ''}：${names}`);
}

async function checkCpaModels() {
  if (!SECRETS.key) return record('反代模型列表', false, '找不到 API_KEY');
  const x = await until(async () => {
    const r = await getJson(`${CPA_LOCAL}/v1/models`, { authorization: `Bearer ${SECRETS.key}` });
    const ids = Array.isArray(r.body?.data) ? r.body.data.map((m) => m.id) : [];
    return { ok: r.status === 200 && ids.length > 0, detail: `${ids.length} 个模型${ids.some((i) => i.startsWith('bl-')) ? '，含 bl- 别名' : ''}` };
  }, '反代');
  record('反代模型列表', x.ok, x.detail);
}

async function checkCpaAccounts() {
  if (!SECRETS.manage) return record('反代里的登录账号', false, '找不到管理密钥');
  const x = await getJson(`${CPA_LOCAL}/v0/management/auth-files`, { authorization: `Bearer ${SECRETS.manage}` });
  const files = x.body?.files ?? x.body?.data ?? (Array.isArray(x.body) ? x.body : []);
  if (x.status !== 200) return record('反代里的登录账号', false, `HTTP ${x.status}`);
  const list = files.map((f) => `${f.provider ?? f.type ?? '?'}/${f.status ?? f.state ?? '?'}`).join('、');
  record('反代里的登录账号', files.length > 0, `${files.length} 个${list ? `：${list}` : ''}`);
}

async function checkInnerNetwork() {
  if (!CPA_INNER) return record('容器内连反代', true, '没配 CPA_URL，跳过（单机模式）');
  const js = `fetch(process.env.CPA_URL+'/v0/management/auth-files',{headers:{authorization:'Bearer '+process.env.CPA_MANAGEMENT_KEY}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))`;
  const d = await run('docker', ['exec', 'ai-workbench', 'node', '-e', js]);
  record('容器内连反代', d.ok, d.ok ? `${CPA_INNER} 可达` : `不可达（退出码非 0）：${d.err.split('\n')[0]}`);
}

async function checkBackup() {
  if (!BACKUP_DIR) return record('自动备份', true, '没配 WB_BACKUP_DIR，跳过');
  if (!fs.existsSync(BACKUP_DIR)) return record('自动备份', false, `目录不存在：${BACKUP_DIR}`);
  const files = fs.readdirSync(BACKUP_DIR)
    .map((f) => ({ f, p: path.join(BACKUP_DIR, f) }))
    .filter((x) => { try { return fs.statSync(x.p).isFile(); } catch { return false; } })
    .map((x) => ({ ...x, mtime: fs.statSync(x.p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return record('自动备份', false, '目录里没有备份文件');
  const ageH = (Date.now() - files[0].mtime) / 3600000;
  record('自动备份', ageH < 48, `${files.length} 份，最新 ${(ageH).toFixed(1)} 小时前（${path.basename(files[0].f)}）`);
}

// ---------- 主流程 ----------
console.log(`\n重启后自检 · ${WB}${waitSec ? ` · 最多等 ${waitSec}s` : ''}\n`);
if (await checkDocker()) {
  await checkContainers();
  await checkHealth();
  await checkAccounts();
  await checkCpaModels();
  await checkCpaAccounts();
  await checkInnerNetwork();
} else {
  record('后续检查', false, 'Docker 没起来，剩下的先跳过');
}
await checkBackup();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `\x1b[31m${failed.length} 项不过\x1b[0m` : '\x1b[32m全部通过\x1b[0m'}（${results.length - failed.length}/${results.length}）\n`);
if (failed.length) {
  for (const f of failed) console.log(`  · ${f.name}：${f.detail}`);
  console.log('');
}
process.exit(failed.length ? 1 : 0);
