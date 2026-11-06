// 「拉取 + 重启」一条命令：保证收尾时是 最新代码 / 与环境一致 / 执行器在线。
//
// 用法（仓库根目录）：
//   node scripts/restart.mjs              # 拉取 + 重建容器 + 重启执行器
//   node scripts/restart.mjs --no-pull    # 不拉取，只按当前 HEAD 重启
//   node scripts/restart.mjs --no-runner  # 只处理工作台容器，不动执行器
//
// 为什么不是简单 restart：
//   1) 直改模式（docker-compose.live.yml）把 src/public/scripts 只读挂进容器，
//      但 bind mount 在 Windows 上不传播文件事件，容器里的 node 进程不会自己重载，
//      所以必须 --force-recreate 让进程重起，否则跑的还是旧代码。
//   2) WB_VERSION 是构建期/创建期注入的，容器不重建就一直是老版本号，
//      页面会显示成旧版本，看起来像没更新。
//   3) 依赖变了（package-lock.json）必须重新构建镜像，只重建容器会缺包。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const argv = new Set(process.argv.slice(2));
const DO_PULL = !argv.has('--no-pull');
const DO_RUNNER = !argv.has('--no-runner');

const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.live.yml'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function ok(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败：\n${r.out}`);
  return r.out;
}

function head() {
  return ok('git', ['rev-parse', '--short', 'HEAD']).trim();
}

function log(msg) {
  console.log(msg);
}

function step(msg) {
  console.log(`\n=== ${msg} ===`);
}

// 1. 拉取
let pulled = false;
let before = '';
let after = '';
if (DO_PULL) {
  step('拉取代码');
  const dirty = ok('git', ['status', '--porcelain']).trim();
  if (dirty) {
    log('工作区有未提交改动，先停下（避免 pull 把改动搅在一起）：');
    log(dirty.split('\n').slice(0, 10).join('\n'));
    process.exit(2);
  }
  before = head();
  let last = '';
  for (let i = 1; i <= 6; i++) {
    const r = run('git', ['pull', '--ff-only']);
    last = r.out;
    if (r.code === 0) { pulled = true; break; }
    // 分叉不是网络问题，重试也没用
    if (/diverged|non-fast-forward/i.test(r.out)) {
      log('本地与远端已分叉，不能用快进。先手工合并再重启：');
      log(last.trim().split('\n').slice(-4).join('\n'));
      process.exit(3);
    }
    log(`第 ${i} 次拉取失败（多为代理抖动），3 秒后重试`);
    spawnSync('sleep', ['3'], { cwd: repo });
  }
  if (!pulled) {
    log('连续 6 次拉取都失败，链路有问题。最后一次输出：');
    log(last.trim().split('\n').slice(-6).join('\n'));
    log('若报 TLS / unexpected eof，先在 Clash Verge 里换节点（自动换节点做不到）。');
    process.exit(4);
  }
  const afterPull = head();
  after = afterPull;
  log(before === afterPull ? `已是最新：${afterPull}` : `${before} → ${afterPull}`);
}

const target = head();

// 2. 判断要不要重新构建
step('判断是否需要重新构建');
let rebuild = false;
if (pulled && before !== after) {
  const changed = ok('git', ['diff', '--name-only', before, after, '--',
    'package.json', 'package-lock.json']).trim();
  if (changed) {
    rebuild = true;
    log(`依赖清单变了（${changed.split('\n').join(', ')}），需要重新构建镜像`);
  } else {
    log('依赖没变，容器重建即可（不需要重建镜像）');
  }
} else if (!pulled) {
  log('未拉取，按不重建处理');
} else {
  log('本次没有新提交，容器重建即可');
}

// 3. 拉起容器：让 WB_VERSION 与 HEAD 一致，并让新代码真正生效
step(`拉起容器（${target}）`);
const upArgs = [...COMPOSE, 'up', '-d'];
if (rebuild) upArgs.push('--build');
else upArgs.push('--force-recreate');
const upOut = ok('docker', upArgs, { env: { ...process.env, WB_VERSION: target } });
log(upOut.trim().split('\n').slice(-4).join('\n'));

// 4. 校验：健康 + 版本号 == HEAD + 页面能开
step('校验');
let healthy = false;
for (let i = 0; i < 30; i++) {
  const st = run('docker', [...COMPOSE, 'ps', '--format', '{{.Name}} {{.Status}}']).out;
  if (/healthy/.test(st)) { healthy = true; break; }
  if (/unhealthy|Exit/.test(st)) { log(st.trim()); break; }
  spawnSync('sleep', ['2'], { cwd: repo });
}
if (!healthy) {
  log('容器没有在 60 秒内变成 healthy，看日志：docker compose logs --tail 40 workbench');
  process.exit(5);
}

const inside = run('docker', [...COMPOSE, 'exec', '-T', 'workbench', 'sh', '-lc',
  'echo WB_VERSION=$WB_VERSION']).out.match(/WB_VERSION=(\S+)/);
const shown = inside ? inside[1] : '(未取到)';
if (shown !== target) {
  log(`版本不一致：容器 ${shown} / HEAD ${target}`);
  process.exit(6);
}
log(`容器健康，WB_VERSION=${shown}`);

// 5. 重启执行器：先按 PID 结束，再起计划任务。
//    只 Stop-ScheduledTask 是不够的——任务是隐藏窗口 powershell 包着 node，
//    停任务只停外层，node 子进程还活着，随后 Start 因 IgnoreNew 被跳过。
if (!DO_RUNNER) {
  log('\n（--no-runner：跳过执行器）');
  process.exit(0);
}

step('重启执行器');
const ps = `
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'runner\\.mjs|runner-guard' })
if ($procs.Count -gt 0) { Stop-Process -Id $procs.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'runner\\.mjs|runner-guard' }).Count
if ($left -gt 0) { "旧进程残留 $left 个，未重启"; exit 1 }
Start-ScheduledTask -TaskName "AI Workbench Runner"
Start-Sleep -Seconds 20
$now = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'runner\\.mjs|runner-guard' })
"执行器进程数 = " + $now.Count
$now | ForEach-Object { "  pid " + $_.ProcessId + " " + (Split-Path $_.CommandLine -Leaf) }
`;
const psOut = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  cwd: repo, encoding: 'utf8',
});
log(((psOut.stdout || '') + (psOut.stderr || '')).trim());
if (!/执行器进程数 = 2/.test(psOut.stdout || '')) {
  log('执行器没有恢复成 guard+runner 两个进程，请检查计划任务 "AI Workbench Runner"');
  log('常见原因：计划任务动作被改成直接起 node.exe（没有隐藏窗口，控制台一关整棵树就没了）');
  process.exit(7);
}

// 6. 收尾：心跳
step('完成');
log(`代码 ${target}，容器健康，执行器已起。`);
log('执行器心跳约 30 秒一次，页面上显示「几十秒前」是正常的。');
