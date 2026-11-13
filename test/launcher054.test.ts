// 054：隐藏启动器（选型 A）。计划任务的动作换成 wscript + launch-hidden.vbs，
// 进程创建时不分配可见控制台，Windows Terminal 的「黑框」交接无从发生。
//
// 安装器是 PowerShell 拼装（改计划任务必须走它），这里测静态契约：
// 模板在仓库里、关键行为在、两个任务都被覆盖、setup 会在成功后装一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vbs = readFileSync(join(ROOT, 'scripts', 'launch-hidden.vbs'), 'utf8');
const installer = readFileSync(join(ROOT, 'scripts', 'install-launcher.mjs'), 'utf8');
const setup = readFileSync(join(ROOT, 'scripts', 'setup.mjs'), 'utf8');

test('054 启动器：窗口样式 0 且等待目标退出', () => {
  // 第三参 True：计划任务「停止」只杀 wscript，守卫靠 parentVanished 收整棵树。
  assert.match(vbs, /sh\.Run\(cmd, 0, True\)/);
  assert.match(vbs, /WScript\.Quit sh\.Run\(cmd, 0, True\)/);
  assert.match(vbs, /WScript\.Arguments\.Count < 2/);
});

test('054 安装器：覆盖两个任务，动作走 wscript //nologo，装在仓库外', () => {
  assert.match(installer, /'AI Workbench Runner'/);
  assert.match(installer, /'AI Workbench Watchdog'/);
  assert.match(installer, /runner-guard\.mjs/);
  assert.match(installer, /watch-runner\.mjs/);
  assert.match(installer, /'wscript\.exe'|wscript\.exe/);
  assert.match(installer, /\/\/nologo/);
  // 仓库外落点：用户的 LOCALAPPDATA\ai-workbench，不是仓库目录。
  assert.match(installer, /LOCALAPPDATA/);
  assert.match(installer, /ai-workbench/, '安装目录名');
});

test('054 安装器：重复跑安全（内容相同不重写、动作相同不动任务）', () => {
  assert.match(installer, /vbs 已是最新/);
  assert.match(installer, /动作已是目标样子/);
  assert.match(installer, /任务不存在，跳过/);
});

test('054 setup：成功且非 dry-run 时安装启动器', () => {
  assert.match(setup, /installLauncherStep\(\)/);
  assert.match(setup, /!opts\.dryRun/);
});

test('054 安装器：PATH 里有另一个 node 时仍使用当前 Node，显式参数可覆盖', async () => {
  const { runInNewContext } = await import('node:vm');
  const path = await import('node:path');
  const pathNodeDir = dirname(process.execPath);
  let explicit: string | undefined;
  const pickNode = runInNewContext(
    installer.match(/^function pickNode\(\) \{[\s\S]*?^\}/m)![0] + '\npickNode',
    {
      ...path, existsSync: () => true, argOf: () => explicit,
      process: { execPath: join(ROOT, 'active-node.exe'), env: { PATH: pathNodeDir } },
    },
  );
  assert.equal(pickNode(), join(ROOT, 'active-node.exe'));
  explicit = 'explicit-node.exe';
  assert.equal(pickNode(), resolve(explicit));
});
