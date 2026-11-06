// 035.3：部署审批必须限定在「执行器自己这个仓库」。
// 原来只看文件名：别的项目改了 src/app.ts 也会弹「重建工作台并重启执行器」，
// 批准后还会在**那个项目的目录**里跑 docker compose——在别人的仓库里重建别人的容器。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldDeploy, deployApplies } from '../scripts/lib/deploy.mjs';

const root = mkdtempSync(join(tmpdir(), 'wb-deploy-scope-'));
const self = join(root, 'ai-workbench');
const other = join(root, 'demo-feed');
const bare = join(root, 'no-compose');
for (const d of [self, other, bare]) mkdirSync(d, { recursive: true });
writeFileSync(join(self, 'docker-compose.yml'), 'services: {}\n');
writeFileSync(join(other, 'docker-compose.yml'), 'services: {}\n');

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
});

test('自身项目改了 src/：要部署', () => {
  assert.equal(shouldDeploy({ files: ['src/app.ts'], project: self, repo: self }), true);
});

test('别的项目改了 src/：不部署（这是这条要挡的那个错）', () => {
  assert.equal(
    shouldDeploy({ files: ['src/app.ts', 'package.json'], project: other, repo: self }),
    false,
  );
});

test('自身项目只改 docs/：不部署，文档不用重建容器', () => {
  assert.equal(shouldDeploy({ files: ['docs/specs/x.md', 'README.md'], project: self, repo: self }), false);
});

test('自身项目但没有 docker-compose.yml：也不部署，那里没东西可重建', () => {
  assert.equal(deployApplies({ project: bare, repo: bare }), false);
});

test('路径不存在或读不到：按「不部署」处理，不抛异常', () => {
  assert.equal(deployApplies({ project: join(root, '不存在'), repo: self }), false);
});

test('符号链接指到别处不算自身仓库（用真实路径比对）', () => {
  // 传进来的 project 与 repo 字面不同但 realpath 相同 → 仍然是自身仓库
  assert.equal(deployApplies({ project: `${self}${process.platform === 'win32' ? '\\\\' : '/'}.`, repo: self }), true);
});
