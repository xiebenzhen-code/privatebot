// 046：打沙箱镜像。用户电脑上跑，纯 JS，Node 18+。
//
//   npm run sandbox:build
//   npm run sandbox:build -- --image wb-sandbox:latest --base docker.m.daocloud.io/library/node:22-bookworm-slim --npm-registry https://registry.npmmirror.com
//
// 只调 docker build，不推送、不登录任何镜像仓库。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const image = opt('image', 'wb-sandbox:latest');
const base = opt('base', '');
const registry = opt('npm-registry', '');
const claude = opt('claude-version', '');
const aptMirror = opt('apt-mirror', '');
if (aptMirror && !/^[A-Za-z0-9.-]+$/.test(aptMirror)) { console.error(`--apt-mirror 只写主机名，比如 mirrors.tuna.tsinghua.edu.cn：${aptMirror}`); process.exit(2); }

if (!/^[a-z0-9][a-z0-9._\/:@-]*$/.test(image)) { console.error(`镜像名不对：${image}`); process.exit(2); }
const v = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (v.status !== 0) { console.error('连不上 Docker：先打开 Docker Desktop，再跑一次。'); process.exit(1); }

const build = ['build', '-f', join('docker', 'sandbox', 'Dockerfile'), '-t', image];
if (base) build.push('--build-arg', `BASE_IMAGE=${base}`);
if (registry) build.push('--build-arg', `NPM_REGISTRY=${registry}`);
if (claude) build.push('--build-arg', `CLAUDE_CODE_VERSION=${claude}`);
if (aptMirror) build.push('--build-arg', `APT_MIRROR=${aptMirror}`);
build.push('.');
console.log(`打沙箱镜像 ${image}（第一次要下载基础镜像和 Claude Code，几分钟）…`);
const r = spawnSync('docker', build, { cwd: root, stdio: 'inherit' });
if (r.status !== 0) {
  console.error('\n没打成。Docker Hub 拉不动就加 --base 换镜像源；Debian 源报错加 --apt-mirror；npm 慢就加 --npm-registry。');
  process.exit(r.status ?? 1);
}
console.log(`\n好了：${image}。执行器配置里写 "sandbox": "docker"、"sandboxImage": "${image}"，重启执行器生效。`);
