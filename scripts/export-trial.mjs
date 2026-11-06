#!/usr/bin/env node
// 022 · 导出干净试用包：`npm run export:trial` 或 `node scripts/export-trial.mjs --out <目录>`。
//
// 只导出 git 跟踪的文件；docs/reports/、private/（行业包、搭建方法）、media/（视频工程）与本项目需求单（docs/specs/）拿掉，
// 用 docs/templates/new-project/ 的模板补上通用版本；导出前后各扫一遍敏感信息，
// 命中就整体失败、什么都不留。--git 时在输出目录做唯一一条提交，作者默认是通用名字。
// 不 push、不用令牌、不改源仓库。
//
// 纯 JS、零依赖，Node 18+，Windows / macOS / Linux 都能跑。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBinaryFile, lineHash, RULES, scanText } from './lib/export-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AUTHOR = 'ai-workbench <noreply@example.com>';
const BLOCKLIST_DEFAULT = join(homedir(), '.ai-workbench-export-blocklist.txt');
const ALLOW_FILE = join(ROOT, 'scripts', 'export-allow.json');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const opt = { author: DEFAULT_AUTHOR, blocklist: BLOCKLIST_DEFAULT, selftest: true };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--git') opt.git = true;
  else if (args[i] === '--author') opt.author = args[++i];
  else if (args[i] === '--blocklist') opt.blocklist = args[++i];
  else if (args[i] === '--skip-selftest') opt.selftest = false;
  else if (args[i] === '--help') { usage(); process.exit(0); }
  else { console.error(`不认识的参数：${args[i]}`); usage(); process.exit(4); }
}
if (!opt.out) { console.error('缺少 --out <目录>'); usage(); process.exit(4); }
if (opt.git && !/^[^<>]+<[^<>]+>$/.test(opt.author)) {
  console.error('--author 要写成 "名字 <邮箱>" 的形状'); process.exit(4);
}

function usage() {
  console.log(`用法：node scripts/export-trial.mjs --out <目录> [--git] [--author "名字 <邮箱>"] [--blocklist <文件>] [--skip-selftest]`);
}

// ---------- 前置检查 ----------
const repo = repoRoot();
const out = resolve(opt.out);
if (inside(out, repo)) fail(`输出目录必须在仓库外面，${out} 在 ${repo} 里。`, null);
if (existsSync(out)) {
  if (statSync(out).isDirectory() && readdirSync(out).length === 0) rmSync(out, { recursive: true, force: true });
  else fail(`输出目录已存在且非空：${out}（不覆盖）。换一个目录，或删掉它再跑。`, null);
}

const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const tracked = trackedFiles();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
if (dirty.trim()) fail('源仓库工作区不干净（有未提交改动），先提交或 stash 再导出。', null);

// 黑名单：没有就教用户建一个，然后失败——没有黑名单的导出是不安全的。
if (!existsSync(opt.blocklist)) {
  const example = [
    '# 每行一个，大小写不敏感。放要保密的东西：用户名、机器名、邮箱、公司名、已知 key 前缀。',
    '# 这个文件不能放进任何仓库——它自己就是一张「关于我」的清单。',
    '# 例：',
    '# zhangsan',
    '# DESKTOP-AB12CD3',
    '# zhangsan@example.com',
    '# sk-a1b2',
  ].join('\n');
  console.error(`个人黑名单不存在：${opt.blocklist}`);
  console.error('先建一个，一行一个要保密的词，然后重跑。示例内容：');
  console.error(example);
  process.exit(1);
}
const blocklist = readFileSync(opt.blocklist, 'utf8').split(/\r?\n/)
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const allow = loadAllow();

// ---------- 挑文件 ----------
const removed = [];
const files = [];
for (const rel of tracked) {
  const norm = rel.split(/[\\/]+/).join('/');
  if (norm === 'docs/PENDING.md' || norm.startsWith('docs/reports/')) { removed.push(norm); continue; }
  if (norm.startsWith('private/') || norm.startsWith('media/')) { removed.push(norm); continue; } // 留在手里的：行业包、搭建方法和提示词、片头工程
  if (norm.startsWith('docs/specs/')) { removed.push(norm); continue; } // 用模板重新生成，不带走本项目需求单
  files.push(norm);
}
files.push('docs/specs/README.md', 'docs/specs/DECISION-HANDOFF.md', 'VERSION'); // 生成物

// ---------- 读内容（写盘之前先扫一遍） ----------
const contents = new Map();
for (const rel of files) contents.set(rel, contentOf(rel));
const pkgSource = JSON.parse(contents.get('package.json')); // 报告里引用，写盘阶段可能去掉字段

const hitReport = [];
const pass = (label, map) => {
  for (const [rel, value] of map) {
    if (typeof value !== 'string') continue; // 二进制（截图）不扫，原样复制
    for (const h of scanText(value, { blocklist })) {
      const ok = h.rule !== '个人黑名单' && allow.has(`${rel}|${h.rule}|${h.hash}`);
      if (ok) continue;
      hitReport.push(`${label} ${rel}:${h.line} 规则 ${h.rule} 命中 ${h.preview} 行哈希 ${h.hash}`);
    }
  }
};
pass('[导出前扫描]', contents);
if (hitReport.length) fail([
  `扫描发现 ${hitReport.length} 处疑似敏感内容，什么都不导出。`,
  '看一眼每一处：确属无害的占位/样本，把下面这行登记进 scripts/export-allow.json 的 allow 数组',
  '（登记项只有文件、规则、行哈希，没有原文）；确属真实信息就改掉源文件再导。',
  ...hitReport.map((l) => '  ' + l),
].join('\n'), null);

// ---------- 写盘 ----------
mkdirSync(out, { recursive: true });
const pkgNotes = []; // 报告里用，写在 try 外面
try {
  for (const rel of files) {
    const target = join(out, rel.split('/').join(sep));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents.get(rel));
  }
  // package.json：导出包不带私有仓库地址（repository/homepage），署名按公开决定保留。
  const pkg = JSON.parse(contents.get('package.json'));
  for (const f of ['repository', 'homepage']) {
    if (pkg[f] !== undefined) { delete pkg[f]; pkgNotes.push(`package.json.${f}：原私有仓库地址已去掉，新仓库建好后自己补`); }
  }
  writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  contents.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  // 导出后再扫一遍（扫磁盘上的最终内容）。二进制不参与扫描。
  const after = new Map();
  for (const rel of files) {
    if (typeof contents.get(rel) !== 'string') continue;
    after.set(rel, readFileSync(join(out, rel.split('/').join(sep)), 'utf8'));
  }
  pass('[导出后扫描]', after);
  if (hitReport.length) fail(`导出后扫描发现 ${hitReport.length} 处问题，已删除输出目录。`, out);
} catch (e) {
  fail(`导出失败：${e.message}`, out);
}

// ---------- 自检：node --test + setup --dry-run ----------
const checks = [];
if (opt.selftest) {
  // 显式列文件：`node --test test`（目录）在 Node 22 上会被当成模块解析，直接报错。
  const testDir = join(out, 'test');
  const testFiles = existsSync(testDir)
    ? readdirSync(testDir).filter((f) => /\.test\.(?:ts|mjs|js)$/.test(f)).map((f) => `test/${f}`)
    : [];
  if (testFiles.length) {
    const t = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', ...testFiles], { cwd: out, encoding: 'utf8', timeout: 300000 });
    const ok = t.status === 0;
    const tail = `${t.stdout ?? ''}${t.stderr ?? ''}`.split(/\r?\n/).filter((l) => /^(# (tests|pass|fail)|not ok)/.test(l)).join(' | ');
    checks.push({ name: 'node --test', ok, detail: ok ? `通过（${tail}）` : `失败（退出码 ${t.status}）${tail ? '：' + tail : ''}` });
  } else checks.push({ name: 'node --test', ok: true, detail: '跳过（包里没有 test/*.test.*）' });

  if (existsSync(join(out, 'scripts', 'setup.mjs'))) {
    const s = spawnSync(process.execPath, ['scripts/setup.mjs', '--yes', '--json', '--dry-run'], { cwd: out, encoding: 'utf8', timeout: 120000 });
    const text = `${s.stdout ?? ''}${s.stderr ?? ''}`;
    // 0=就绪；2=缺凭据、3=后端没配、1 且原因是「没有项目」——都是试用者自己填的事。
    // 真正说明包有问题的是「缺文件」或其他异常退出。
    const projectMissing = s.status === 1 && /没有项目/.test(text);
    const ok = s.status === 0 || s.status === 2 || s.status === 3 || projectMissing;
    const why = {
      0: '就绪',
      2: '缺凭据，等试用者填',
      3: '后端未配置，等试用者填',
    }[s.status] ?? '还没有项目，等试用者用 --project 配';
    checks.push({ name: 'setup --dry-run', ok, detail: ok ? `退出码 ${s.status}（${why}）` : `退出码 ${s.status}：${text.slice(0, 500)}` });
  } else checks.push({ name: 'setup --dry-run', ok: true, detail: '跳过（包里没有 scripts/setup.mjs）' });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length) {
    fail(['导出包自检没过：', ...bad.map((c) => `  ${c.name}：${c.detail}`), '输出目录已删除。'], out);
  }
}

// ---------- --git：唯一一条提交 ----------
if (opt.git) {
  const [name, email] = opt.author.split(/<|\>/).map((s) => s.trim());
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  const run = (a) => execFileSync('git', a, { cwd: out, env, encoding: 'utf8' });
  run(['init', '-q']);
  run(['add', '-A']);
  run(['commit', '-q', '--no-verify', '-m', `ai-workbench trial snapshot ${short}`]);
}

// ---------- 报告（写在包外面） ----------
const license = (contents.get('LICENSE') ?? '').split(/\r?\n/).find((l) => /^(?:Required Notice:\s*)?Copyright/i.test(l)) ?? '(LICENSE 里没有版权行)';
const reportLines = [
  `导出报告`,
  `来源提交：${short}`,
  `导出日期：${new Date().toISOString().slice(0, 10)}`,
  `导出文件：${files.length} 个；拿掉 ${removed.length} 个（docs/reports/、private/、media/ 与本项目需求单 docs/specs/，另生成通用的 docs/specs/README.md、DECISION-HANDOFF.md、VERSION）`,
  `扫描规则：${RULES.length} 条通用规则 + ${blocklist.length} 个个人黑名单词 + ${allow.size} 条放行登记；命中 ${0} 处`,
  '',
  `— 请你确认的署名与字段 —`,
  `许可证：${pkgSource.license ?? '(package.json 没写 license)'}${/^PolyForm-Noncommercial/i.test(pkgSource.license ?? '') ? '（源码公开、限制商用）' : ''}`,
  `版权人：${license}（2026-10-30 决定：署名可以公开；这不是要扫掉的个人信息）`,
  `package.json author：${pkgSource.author ?? '(没写)'}`,
  // 只在这次没传 --author（用的是通用默认名）时才提示，否则等于对已经做过的事再说一遍。
  ...(pkgSource.author && opt.author === DEFAULT_AUTHOR ? [`想让包里的那条提交也用这个署名：导出时加 --author "${pkgSource.author} <邮箱>"（默认是通用名字 ai-workbench）`] : []),
  ...pkgNotes,
  '',
  ...checks.map((c) => `自检 ${c.name}：${c.detail}`),
  '',
  `— 请你亲自看一眼 —`,
  `· docs/screenshots/ 下每张截图（有没有拍到真实的余额、用户名、窗口标题）`,
  `· README.md、docs/USAGE.md、docs/AGENT-INSTALL.md（通读一遍，站在陌生人角度）`,
  `· LICENSE 和 package.json 的署名`,
  `· 全文搜索你自己的名字、常用 IP 段、机器名——应该搜不到`,
];
const reportFile = `${out.replace(/[\\/]$/, '')}.report.txt`;
writeFileSync(reportFile, reportLines.join('\n') + '\n');

console.log(`导出完成：${out}`);
console.log(`文件 ${files.length} 个，扫描命中 0 处，自检 ${checks.filter((c) => c.ok).length}/${checks.length} 通过。`);
console.log(`报告：${reportFile}`);
if (!opt.git) console.log('（没加 --git，输出目录还没有 git 历史）');

// ---------- 工具 ----------
function fail(msg, cleanup) {
  console.error(msg);
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  process.exit(1);
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    console.error('这里不是 git 仓库，无法确定要导出什么。'); process.exit(4);
  }
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean);
}

function inside(p, dir) {
  const a = resolve(p).toLowerCase() + sep;
  const b = resolve(dir).toLowerCase() + sep;
  return a.startsWith(b);
}

function loadAllow() {
  if (!existsSync(ALLOW_FILE)) return new Set();
  const list = JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).allow ?? [];
  return new Set(list.map((e) => `${e.file}|${e.rule}|${e.hash}`));
}

function contentOf(rel) {
  // 生成物优先：本项目的 docs/specs/README.md 在仓库里也真实存在，绝不能被原样带出去。
  if (rel === 'docs/specs/README.md') return genericDoc('specs-README.md', rel);
  if (rel === 'docs/specs/DECISION-HANDOFF.md') return genericDoc('DECISION-HANDOFF.md', rel);
  if (rel === 'VERSION') return `${short}\n导出日期：${new Date().toISOString().slice(0, 10)}\n`;
  const real = join(repo, ...rel.split('/'));
  if (existsSync(real)) {
    // 截图、字体这类二进制必须按字节复制：按 utf8 读再写会把 PNG 弄坏（022.1 发现的真 bug）。
    const buf = readFileSync(real);
    return isBinaryFile(rel, buf) ? buf : buf.toString('utf8');
  }
  throw new Error(`缺少文件：${rel}`);
}

/** 用模板生成通用文档：去掉「> 模板。」提示行，并确认没有指向被拿掉文档的悬空链接。 */
function genericDoc(templateName, target) {
  const src = readFileSync(join(ROOT, 'docs', 'templates', 'new-project', templateName), 'utf8');
  const text = src.split(/\r?\n/).filter((l) => !l.startsWith('> 模板。')).join('\n');
  const exported = new Set(files);
  for (const m of text.matchAll(/docs\/(?:specs|reports)\/[A-Za-z0-9._-]+/g)) {
    if (!exported.has(m[0])) throw new Error(`模板 ${templateName} 里引用了导出包里不存在的 ${m[0]}（悬空链接）`);
  }
  return text;
}
