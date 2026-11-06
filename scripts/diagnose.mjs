#!/usr/bin/env node
// 022 · 试用反馈诊断：`npm run diagnose`。
// 一条命令生成一段可以安全贴给发包人的文字：版本信息、自检摘要、审计类型、.env 变量名。
// 只列名字和摘要，不列值；输出前再对整段文字过一遍通用规则和黑名单，命中换成 [已隐藏]。
// 纯 JS、零依赖，Node 18+（读数据库那步要 Node 22+，没有就跳过并说明）。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactForOutput, scanText } from './lib/export-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sections = [];
const section = (title, lines) => sections.push([title, ...lines.filter((l) => l !== undefined)]);

section('版本', [
  `node: ${process.version}`,
  cmd('git', ['--version']),
  cmd('docker', ['--version'], { firstLine: true }),
  cmd('claude', ['--version'], { firstLine: true }),
  `os: ${process.platform} ${process.arch}`,
  `VERSION: ${existsSync(join(ROOT, 'VERSION')) ? readFileSync(join(ROOT, 'VERSION'), 'utf8').trim().split(/\r?\n/).join(' / ') : '(没有 VERSION 文件——这不是导出包？)'}`,
]);

section('安装清单（/api/setup/status）', [setupStatus()]);

section('执行器自检（runner --check）', [runnerCheck()]);

section('最近 20 条审计的类型（只有类型和条数，没有正文）', [auditKinds()]);

section('.env 里已设置的变量名（只有名字）', [envNames()]);

// setupStatus() 和 auditKinds() 的行可能是 Promise：等全部段完成再打码、输出。
const header = '诊断信息（敏感内容已自动打码，可以直接转发）：';
void Promise.all(sections.map(async ([t, ...ls]) => [t, ...(await Promise.all(ls))])).then((done) => {
  const body = done.map(([t, ...ls]) => `## ${t}\n${ls.join('\n')}`).join('\n\n');
  const output = redactForOutput(`${header}\n${body}`, { blocklist: localBlocklist() });
  const rest = scanText(output);
  if (rest.length) {
    console.error('注意：打码后仍有规则命中，转发前请人工确认：');
    for (const h of rest.slice(0, 10)) console.error(`  行 ${h.line} 规则 ${h.rule}`);
  }
  console.log(output);
  process.exit(0);
});
function cmd(name, argv, { firstLine = false } = {}) {
  try {
    const r = execFileSync(name, argv, { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32', windowsHide: true });
    return `${name}: ${(firstLine ? r.trim().split(/\r?\n/)[0] : r.trim())}`;
  } catch {
    return `${name}: (没找到或没装)`;
  }
}

/** .env 里的值读进来只用（比如 WB_TOKEN 调本机接口），永远不打印。 */
function env() {
  const out = {};
  const file = join(ROOT, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('WB_')) out[k] = v;
  return out;
}

async function setupStatus() {
  const e = env();
  const port = e.PORT || '3200';
  const headers = e.WB_TOKEN ? { Authorization: `Bearer ${e.WB_TOKEN}` } : {};
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { headers, signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    return JSON.stringify(json);
  } catch {
    return '(工作台没在运行，读不到 /api/setup/status)';
  }
}

function runnerCheck() {
  const r = spawnSync(process.execPath, ['scripts/runner.mjs', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || `(退出码 ${r.status})`;
  return text.split(/\r?\n/).slice(0, 30).join('\n');
}

function auditKinds() {
  const e = env();
  const dbFile = e.WB_DB && e.WB_DB !== ':memory:' ? resolve(ROOT, e.WB_DB) : join(ROOT, 'data', 'workbench.db');
  if (!existsSync(dbFile)) return '(没找到数据库——工作台跑过才有)';
  return dynamicSql(dbFile);
}

async function dynamicSql(dbFile) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('SELECT kind, COUNT(*) n FROM (SELECT kind FROM events ORDER BY id DESC LIMIT 20) GROUP BY kind ORDER BY n DESC').all();
    db.close();
    return rows.map((r) => `${r.kind} ×${r.n}`).join('\n') || '(还没有审计记录)';
  } catch (err) {
    return `(读数据库跳过：${err.message.split('\n')[0]})`;
  }
}

function envNames() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return '(没有 .env——还没配置)';
  const names = readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean);
  return names.length ? names.join('\n') : '(空的)';
}

/** 黑名单文件存在就一起用来打码；不存在也不拦（诊断没有导出那么敏感）。 */
function localBlocklist() {
  try {
    return readFileSync(join(homedir(), '.ai-workbench-export-blocklist.txt'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}
