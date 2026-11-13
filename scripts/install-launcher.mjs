#!/usr/bin/env node
// 054：把隐藏启动器装到仓库外，并把两个计划任务的动作换成它。
//
//   node scripts/install-launcher.mjs                装到 %LOCALAPPDATA%\ai-workbench\，默认仓库 = 本仓库
//   node scripts/install-launcher.mjs --repo <路径>  任务里的脚本路径用别的仓库（多工作树时用）
//   node scripts/install-launcher.mjs --node <路径>  指定 node（否则用当前 node）
//
// 重复跑安全：vbs 内容相同就不重写，任务动作已经是目标样子就不动任务。
// 任务不存在（这台机器没装过执行器）就只装 vbs 文件并跳过任务——注册见 docs/INSTALL-WINDOWS.md。
// 任务正在跑时不改动作（改动要求先停），会提示，退出码仍为 0。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const LOCAL = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
if (!LOCAL || LOCAL === join('', 'AppData', 'Local')) {
  console.error('✗ 找不到 LOCALAPPDATA，无法确定安装目录');
  process.exit(1);
}
const STATE_DIR = join(LOCAL, 'ai-workbench');
const VBS_DST = join(STATE_DIR, 'launch-hidden.vbs');
const VBS_SRC = join(ROOT, 'scripts', 'launch-hidden.vbs');
const REPO = resolve(argOf('--repo') ?? ROOT);
const WSCRIPT = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

function pickNode() {
  const explicit = argOf('--node');
  if (explicit) return resolve(explicit);
  return process.execPath;
}

function ps(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
}

function installVbs() {
  mkdirSync(STATE_DIR, { recursive: true });
  const same = existsSync(VBS_DST) && readFileSync(VBS_DST, 'utf8') === readFileSync(VBS_SRC, 'utf8');
  if (same) return 'vbs 已是最新';
  copyFileSync(VBS_SRC, VBS_DST);
  return 'vbs 已复制';
}

function updateTask(name, script) {
  const want = `${WSCRIPT} //nologo "${VBS_DST}" "${nodeExe}" "${join(REPO, 'scripts', script)}"`;
  const q = (s) => s.replace(/'/g, "''");
  const r = ps(`
$task = Get-ScheduledTask -TaskName '${q(name)}' -ErrorAction SilentlyContinue
if (-not $task) { 'missing'; exit }
$a = @($task.Actions)[0]
$cur = "$($a.Execute) $($a.Arguments)"
if ($cur -eq '${q(want)}') { 'same' }
elseif ($task.State -eq 'Running') { 'running' }
else {
  $a.Execute = '${q(WSCRIPT)}'
  $a.Arguments = '${q(`//nologo "${VBS_DST}" "${nodeExe}" "${join(REPO, 'scripts', script)}"`)}'
  Set-ScheduledTask -TaskName '${q(name)}' -Action $a | Out-Null
  if ($?) { 'updated' } else { 'failed' }
}
`);
  const out = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (out === 'missing') return '任务不存在，跳过（注册见 INSTALL-WINDOWS）';
  if (out === 'same') return '动作已是目标样子';
  if (out === 'running') return '任务正在跑，先停再跑一次安装（文件已装好）';
  if (out === 'updated') return '动作已更新';
  return `失败：${(r.stderr ?? r.error?.message ?? out ?? '无输出').trim().split(/\r?\n/)[0]}`;
}

const nodeExe = pickNode();
const results = { vbs: installVbs() };
if (!existsSync(VBS_DST)) {
  console.error('✗ vbs 复制失败');
  process.exit(1);
}
for (const [name, script] of [['AI Workbench Runner', 'runner-guard.mjs'], ['AI Workbench Watchdog', 'watch-runner.mjs']]) {
  results[name] = existsSync(WSCRIPT) ? updateTask(name, script) : '找不到 wscript.exe，跳过';
}
for (const line of [`隐藏启动器：${results.vbs} → ${VBS_DST}`, ...Object.entries(results).filter(([k]) => k !== 'vbs').map(([k, v]) => `${k}：${v}`)]) {
  console.log(`  · ${line}`);
}
const bad = Object.entries(results).some(([k, v]) => k !== 'vbs' && /失败/.test(v));
process.exit(bad ? 1 : 0);
