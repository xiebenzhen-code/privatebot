// 046.1 · 沙箱的纯函数部分：docker run 命令行、补丁检查、供应商接口（假 docker）。
//
// 没有 Docker 也能跑——真容器里的探针是 046.2 的集成测试，那组有 Docker 才跑。
// 这里钉死的是「容器到底给了它什么」和「宿主愿意收什么样的补丁」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore 纯 JS 模块
import { HARD_LIMITS, assertSafeArgs, buildRunArgs, normalizeLimits, taskOfName } from '../scripts/lib/sandbox/docker-args.mjs';
// @ts-ignore
import { inspectPatch, safeLabel } from '../scripts/lib/sandbox/patch-guard.mjs';
// @ts-ignore
import { DockerProvider, NoneProvider, VmProvider, assertBoxPath, getProvider } from '../scripts/lib/sandbox/provider.mjs';

const base = { taskId: 7, runId: 3, image: 'wb-sandbox:latest', network: 'wb-sbx-net-T7-abc123', volume: 'wb-sbx-vol-T7-abc123' };
const ok = (over: any = {}) => buildRunArgs({ ...base, ...over }, { rand: () => 'abc123' });

describe('046.1 · buildRunArgs', () => {
  test('必须有的项一项不少', () => {
    const a = ok();
    const has = (...xs: string[]) => { for (const x of xs) assert.ok(a.includes(x), `缺 ${x}`); };
    has('run', '-d', '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only');
    assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
    has('--memory=2048m', '--memory-swap=2048m', '--cpus=2', '--pids-limit=512');
    assert.equal(a[a.indexOf('--network') + 1], base.network);
    assert.equal(a[a.indexOf('--dns') + 1], '127.0.0.1');
    assert.ok(a.some((x: string, i: number) => x === '--add-host' && a[i + 1] === 'host.docker.internal:127.0.0.1'));
    assert.ok(a.some((x: string, i: number) => x === '--add-host' && a[i + 1] === 'gateway.docker.internal:127.0.0.1'));
    assert.ok(a.includes(`type=volume,source=${base.volume},target=/work`));
    assert.ok(a.some((x: string) => x.startsWith('/run/wb:') && x.includes('noexec')));
    assert.ok(a.includes('wb.sandbox=1') && a.includes('wb.task=7') && a.includes('wb.run=3'));
    assert.equal(a[a.indexOf('--name') + 1], 'wb-sbx-T7-abc123');
    assert.deepEqual(a.slice(-3), ['wb-sandbox:latest', 'sleep', 'infinity']);
  });

  test('命令行里没有任何会开口子的东西', () => {
    const a = ok({ env: { HTTPS_PROXY: 'http://wb-proxy:3128', ANTHROPIC_API_KEY: 'sk-fake' } });
    for (const bad of ['-v', '--volume', '--privileged', '--cap-add', '--network=host', '--pid', '--ipc', '--uts', '--userns', '--device', '--volumes-from', '--env-file']) {
      assert.ok(!a.some((x: string) => x === bad || x.startsWith(`${bad}=`)), `不该有 ${bad}`);
    }
    assert.ok(!/docker\.sock|unconfined|type=bind|\/mnt\/|host_mnt/i.test(a.join(' ')));
    assert.equal(a.filter((x: string) => x === '--mount').length, 1, '只有一个 --mount（命名卷）');
  });

  test('多传一个不认识的键就抛错，不静默忽略', () => {
    for (const k of ['privileged', 'capAdd', 'mounts', 'binds', 'volumes', 'devices', 'networkMode', 'user', 'securityOpt', 'pid', 'hostPath', 'workdir']) {
      assert.throws(() => ok({ [k]: k === 'privileged' ? true : ['x'] }), /不认识的参数/, k);
    }
    assert.throws(() => ok({ limits: { privileged: 1 } }), /limits/);
  });

  test('网络、卷、镜像名：宿主路径、Docker 自带网络、带参数的镜像名全部拒绝', () => {
    for (const n of ['host', 'bridge', 'none', 'container:abc', 'wb-sbx-net x', '../wb-sbx-a', 'wb-sbx-/x', '']) assert.throws(() => ok({ network: n }), /网络/, `network=${n}`);
    for (const v of ['C:\\Users\\me', '/var/run/docker.sock', '/mnt/c', 'wb-sbx-../x', 'wb-sbx-a:/h', 'other-vol', 'wb-sbx-a,target=/', '']) assert.throws(() => ok({ volume: v }), /卷/, `volume=${v}`);
    for (const im of ['--privileged', '-v', 'x --cap-add=ALL', 'a b', 'UPPER:tag', '', 'img;rm -rf', 'img\n--privileged']) assert.throws(() => ok({ image: im }), /镜像/, `image=${im}`);
    assert.doesNotThrow(() => ok({ image: 'registry.example.com:5000/team/wb-sandbox:1.2' }));
    assert.doesNotThrow(() => ok({ image: `wb-sandbox@sha256:${'a'.repeat(64)}` }));
  });

  test('环境变量：只有白名单里的名字，宿主环境不继承', () => {
    for (const k of ['SECRET', 'LD_PRELOAD', 'DOCKER_HOST', 'WB_TOKEN', 'WB_PASSWORD', 'GITHUB_TOKEN', 'HOMEPATH', 'USERPROFILE']) assert.throws(() => ok({ env: { [k]: 'x' } }), /白名单/, k);
    assert.throws(() => ok({ env: { HOME: 'a\nb' } }), /换行/);
    assert.throws(() => ok({ env: { HOME: 1 } }), /字符串/);
    assert.throws(() => ok({ env: { HOME: 'x'.repeat(3000) } }), /太长/);
    const a = ok({ env: { HOME: `/home/agent`, PATH: '/usr/bin' } });
    assert.deepEqual(a.filter((_x: string, i: number) => a[i - 1] === '-e'), [`HOME=/home/agent`, 'PATH=/usr/bin']);
  });

  test('资源上限：配置再大也截到写死的上限，并说清截了什么', () => {
    const r = normalizeLimits({ memoryMb: 65536, cpus: 64, pids: 100000 });
    assert.deepEqual(r.limits, { memoryMb: HARD_LIMITS.memoryMb, cpus: HARD_LIMITS.cpus, pids: HARD_LIMITS.pids });
    assert.equal(r.clamped.length, 3);
    assert.ok(ok({ limits: { memoryMb: 999999 } }).includes(`--memory=${HARD_LIMITS.memoryMb}m`));
    assert.deepEqual(normalizeLimits({}).clamped, []);
    for (const bad of [{ memoryMb: 0 }, { memoryMb: -1 }, { cpus: NaN }, { pids: 'x' }, { cpus: 0.01 }]) assert.throws(() => normalizeLimits(bad), /limits/);
  });

  test('一批恶意字符串喂进每个字段：要么抛错，要么出来的命令行仍然干净', () => {
    const nasty = ['', ' ', '-v', '--privileged', '--network=host', '/', 'C:\\', '\\\\server\\share', '..', '../..', 'a/../b', 'wb-sbx-', 'wb-sbx-a b', 'wb-sbx-a\nb', 'wb-sbx-$(id)', 'wb-sbx-`id`', 'wb-sbx-a;b', 'x:/y', 'a,target=/', 'type=bind,source=/,target=/h', '/var/run/docker.sock', 'docker.sock', 'img --cap-add=ALL', null, undefined, 7, {}, []];
    for (const field of ['image', 'network', 'volume', 'taskId', 'runId', 'nameSuffix', 'env', 'limits']) {
      for (const v of nasty) {
        try {
          const a = buildRunArgs({ ...base, [field]: v } as any, { rand: () => 'abc123' });
          assertSafeArgs(a);
          assert.ok(!a.includes('-v') && !a.some((x: string) => /bind|docker\.sock|privileged|cap-add/i.test(x)), `${field}=${JSON.stringify(v)}`);
        } catch (e) {
          assert.match(String((e as Error).message), /沙箱参数不合规|命令行/);
        }
      }
    }
  });

  test('assertSafeArgs：事后有人往命令行里塞东西也能抓到', () => {
    const a = ok();
    for (const extra of [['-v', 'C:\\:/host'], ['--privileged'], ['--cap-add=SYS_ADMIN'], ['--network=host'], ['--mount', 'type=bind,source=/,target=/h'], ['--mount', 'type=volume,source=other,target=/work'], ['--device', '/dev/sda'], ['-e', 'X=/var/run/docker.sock'], ['--security-opt', 'seccomp=unconfined'], ['--volumes-from', 'x']]) {
      assert.throws(() => assertSafeArgs([...a, ...extra]), /沙箱参数不合规/, extra.join(' '));
    }
    assert.doesNotThrow(() => assertSafeArgs(a));
  });

  test('taskOfName：认得出容器名里的任务号', () => {
    assert.equal(taskOfName('wb-sbx-T123-abc123'), 123);
    assert.equal(taskOfName('wb-sbx-vol-T123-abc123'), null);
    assert.equal(taskOfName('postgres'), null);
  });
});

// ───────────── patch-guard ─────────────

const body = '@@ -1 +1 @@\n-a\n+b\n';
const modify = (p: string, extra = '') => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- a/${p}\n+++ b/${p}\n${extra}${body}`;
const add = (p: string, mode = '100644') => `diff --git a/${p} b/${p}\nnew file mode ${mode}\nindex 0000000..2222222\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+x\n`;
const del = (p: string) => `diff --git a/${p} b/${p}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
const rejected = (patch: string, re?: RegExp) => { const r = inspectPatch(patch); assert.equal(r.ok, false, `应该被拒：\n${patch.slice(0, 200)}`); if (re) assert.match(r.reasons.join('|'), re); return r; };
const accepted = (patch: string) => { const r = inspectPatch(patch); assert.equal(r.ok, true, `应该放行：${r.reasons.join('|')}\n${patch.slice(0, 200)}`); return r; };

describe('046.1 · patch-guard · 正常的活不能挡', () => {
  test('改、加、删、重命名、带空格的路径、中文路径、二进制、No newline', () => {
    accepted(modify('src/app.ts'));
    accepted(add('test/new.test.ts'));
    accepted(del('old/file.txt'));
    accepted(modify('docs/a b/c d.md'));
    accepted(`diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n`);
    accepted(`diff --git "a/\\346\\265\\213\\350\\257\\225.txt" "b/\\346\\265\\213\\350\\257\\225.txt"\nindex 1111111..2222222 100644\n--- "a/\\346\\265\\213\\350\\257\\225.txt"\n+++ "b/\\346\\265\\213\\350\\257\\225.txt"\n${body}`);
    accepted(`diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 5\nKcmZQ%00000\n\nliteral 0\nHcmV?d00001\n\n`);
    accepted(`diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n c\n`);
    const multi = accepted(modify('a.ts') + modify('b.ts') + add('c.ts'));
    assert.deepEqual(multi.files.map((f: any) => f.path), ['a.ts', 'b.ts', 'c.ts']);
  });

  test('名字里带 credentials 的源码、普通点文件不被误杀', () => {
    for (const p of ['src/services/credentials.ts', 'src/credentials-store.ts', 'docs/keys.md', '.gitignore', '.gitkeep', 'docs/.github-notes.md', '.env.example', 'sub/.env.sample']) accepted(modify(p));
  });

  test('命中「要人看一眼」的放行，但带标记', () => {
    const codes = (p: string) => accepted(p).flags.map((f: any) => f.code);
    assert.deepEqual(codes(modify('package.json')), ['package-json']);
    assert.deepEqual(codes(modify('sub/package.json')), ['package-json']);
    assert.deepEqual(codes(modify('package-lock.json')), ['lockfile']);
    assert.deepEqual(codes(modify('.github/workflows/ci.yml')), ['github']);
    assert.deepEqual(codes(modify('.husky/pre-commit')), ['hooks']);
    assert.deepEqual(codes(modify('Dockerfile')), ['docker']);
    assert.deepEqual(codes(modify('docker-compose.live.yml')), ['docker']);
    assert.deepEqual(codes(add('scripts/run.sh', '100755')), ['new-exec']);
    assert.deepEqual(codes(`diff --git a/tool.sh b/tool.sh\nold mode 100644\nnew mode 100755\n`), ['new-exec']);
    assert.deepEqual(codes(modify('src/app.ts')), []);
  });
});

describe('046.1 · patch-guard · 逃逸清单 C 组', () => {
  test('C17 复核 · 改名或复制走属性文件仍拒收', () => {
    for (const op of ['rename', 'copy']) {
      rejected(`diff --git a/.gitattributes b/rules.txt\nsimilarity index 100%\n${op} from .gitattributes\n${op} to rules.txt\n`, /改 \.gitattributes 可能让宿主执行外部程序/);
    }
  });

  test('C17 复核 · Windows 属性文件短名与退化短名拒收', () => {
    for (const name of ['GITATT~1', 'GITATT~4', 'GITATT~5', 'gi7d29~1', 'GI7D29~12']) {
      rejected(add('docs/' + name), /改 \.gitattributes 可能让宿主执行外部程序/);
    }
  });

  test('C17 复核 · gitmodules 退化短名拒收', () => {
    rejected(add('docs/gi7eba~1'), /动了 \.gitmodules/);
  });

  test('C17 · 拒绝任意目录下新增、修改、改名或写二进制 .gitattributes', () => {
    const reason = /改 \.gitattributes 可能让宿主执行外部程序（filter\/diff\/merge）/;
    rejected(modify('.gitattributes'), reason);
    rejected(add('docs/.gitattributes'), reason);
    rejected(modify('docs/.GITATTRIBUTES'), reason);
    rejected('diff --git a/docs/rules.txt b/docs/.gitattributes\nsimilarity index 100%\nrename from docs/rules.txt\nrename to docs/.gitattributes\n', reason);
    rejected('diff --git a/docs/.gitattributes b/docs/.gitattributes\nnew file mode 100644\nindex 0000000..2222222\nGIT binary patch\nliteral 5\nKcmZQ%00000\n\nliteral 0\nHcmV?d00001\n\n', reason);
  });

  test('13 · 写进 .git：大小写、短名、末尾点和空格、NTFS 流、全角点、零宽字符、..', () => {
    const zw = String.fromCodePoint(0x200c);
    const fullDot = String.fromCodePoint(0xff0e);
    for (const p of ['.git/hooks/pre-commit', '.GIT/config', '.Git/hooks/x', 'GIT~1/hooks/x', 'git~2/config', '.git./hooks/x', '.git /hooks/x', '.git::$INDEX_ALLOCATION/hooks/x', `.g${zw}it/hooks/x`, `${fullDot}git/hooks/x`, 'sub/.git/config', 'a/../.git/config', '.git']) {
      const r = rejected(add(p));
      assert.match(r.reasons.join('|'), /\.git|\.\.|路径/, p);
    }
  });

  test('路径本身不合规：绝对路径、盘符、反斜杠、空段、.、..、控制字符、过长', () => {
    for (const p of ['/etc/passwd', 'C:/Windows/x', 'src\\a.ts', 'a//b', './a', 'a/./b', '../x', 'a/..']) rejected(add(p));
    const esc = String.fromCharCode(27);
    rejected(`diff --git "a/x\\033[2Jy" "b/x\\033[2Jy"\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ "b/x\\033[2Jy"\n@@ -0,0 +1 @@\n+x\n`, /控制字符/);
    rejected(add(`${'d/'.repeat(130)}x`), /太长/);
    assert.ok(!safeLabel(`a${esc}[31mb`).includes(esc), 'safeLabel 要把转义序列脱掉');
  });

  test('14 · 符号链接和子模块（新建、改模式、改成链接）', () => {
    rejected(add('link', '120000'), /符号链接/);
    rejected(add('mod', '160000'), /子模块/);
    rejected(modify('x', 'old mode 100644\nnew mode 120000\n'), /符号链接/);
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 120000\n--- a/x\n+++ b/x\n${body}`, /符号链接/);
    rejected(modify('.gitmodules'), /gitmodules/);
    rejected(add('GITMOD~1'), /gitmodules/);
    rejected(add('sub/.GitModules'), /gitmodules/);
  });

  test('15 · 不认识的文件模式', () => {
    rejected(add('x', '100664'), /模式/);
    rejected(add('x', '040000'), /模式/);
    rejected(`diff --git a/x b/x\nold mode 100644\nnew mode 100777\n`, /模式/);
  });

  test('16 · 路径混淆：diff --git 行、---、+++、rename 说的不是同一个文件', () => {
    rejected(`diff --git a/ok.txt b/ok.txt\nindex 1111111..2222222 100644\n--- a/ok.txt\n+++ b/.git/hooks/pre-commit\n${body}`, /对不上|\.git/);
    rejected(`diff --git a/ok.txt b/ok.txt\nindex 1111111..2222222 100644\n--- a/.git/hooks/x\n+++ b/ok.txt\n${body}`, /对不上|\.git/);
    rejected(`diff --git a/ok.txt b/other.txt\nindex 1111111..2222222 100644\n--- a/ok.txt\n+++ b/other.txt\n${body}`, /拆不出|对不上/);
    rejected(`diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to .git/hooks/post-merge\n`, /对不上|\.git/);
    rejected(`diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to c.ts\n`, /对不上/);
    rejected(`diff --git a/a.ts b/b.ts\nsimilarity index 100%\ncopy from a.ts\ncopy to .git/config\n`, /对不上|\.git/);
    rejected(`diff --git a/ok b/ok\nindex 1111111..2222222 100644\n--- x/ok\n+++ b/ok\n${body}`, /对不上/);
    rejected(`diff --git "a/ok" "b/ok"\nindex 1111111..2222222 100644\n--- "a/\\056git/x"\n+++ "b/ok"\n${body}`, /对不上|\.git/);
  });

  test('16b · 藏在正常补丁后面的朴素补丁（git apply 会认，我们不认）', () => {
    rejected(`${modify('ok.txt')}--- a/.git/hooks/pre-commit\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+evil\n`, /认不出/);
    rejected(`--- a/.git/hooks/pre-commit\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+evil\n`, /diff --git/);
    rejected(`${modify('ok.txt')}garbage line\n`, /认不出/);
    rejected(`From abc Mon Sep 17 00:00:00 2001\nSubject: x\n\n${modify('ok.txt')}`, /diff --git/);
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 100644\nweird header\n--- a/x\n+++ b/x\n${body}`, /文件头里有认不出/);
  });

  test('hunk 的行数要数得上：多了、少了、夹带都拒绝', () => {
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n`, /认不出|行数/);
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n+b\n`, /断了/);
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@@ -1 +1 @@@\n`, /认不出|hunk 头/);
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ nonsense @@\n`, /hunk 头/);
    rejected(`diff --git a/x b/x\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 5\nthis line is not base85!!\n`, /二进制/);
  });

  test('锁定表：密钥、环境文件、登录目录、执行器配置、带令牌的配置一律拒绝', () => {
    for (const p of ['.env', '.env.local', '.env.example.bak', '.envrc', 'sub/.env.production', 'id_rsa', 'home/.ssh/config', 'keys/server.pem', 'a/b.key', 'credentials.json', '.credentials.json', 'credentials', '.ai-workbench-runner.json', '.npmrc', '.netrc', '.aws/credentials', 'id_ed25519.pub']) {
      rejected(modify(p), /不该碰|\.git|路径/);
    }
  });

  test('19 · 炸弹：太大、文件太多、空字符、空补丁、不是文本', () => {
    assert.equal(inspectPatch(modify('a.ts'), { maxBytes: 50 }).ok, false);
    assert.equal(inspectPatch(modify('a.ts') + modify('b.ts') + modify('c.ts'), { maxFiles: 2 }).ok, false);
    rejected(`${modify('a.ts')}\0`, /空字符/);
    rejected('', /空/);
    rejected('   \n', /空/);
    assert.equal(inspectPatch(null as any).ok, false);
    assert.equal(inspectPatch(Buffer.from('x') as any).ok, false);
    const big = `diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+${'z'.repeat(2 * 1024 * 1024)}\n`;
    assert.equal(inspectPatch(big, { maxBytes: 1024 * 1024 }).ok, false);
    assert.equal(inspectPatch(big).ok, true, '默认上限里放得下 2MB 的一行');
  });

  test('20 · 提示里的路径脱了控制字符，不会把终端转义带进日志和页面', () => {
    const esc = String.fromCharCode(27);
    const r = inspectPatch(add(`dir/x${esc}[31m`));
    assert.equal(r.ok, false);
    assert.ok(!r.reasons.join('').includes(esc));
  });
});

// ───────────── 供应商（假 docker） ─────────────

type Call = { args: string[]; input?: any };
function fakeDocker(handler: (args: string[], opts: any) => Partial<{ code: number; stdout: string; stderr: string }> | void = () => ({})) {
  const calls: Call[] = [];
  const fn = (args: string[], opts: any = {}) => {
    calls.push({ args, input: opts.input });
    const r = handler(args, opts) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { fn, calls, verbs: () => calls.map((c) => c.args.slice(0, 2).join(' ')) };
}
const mk = (docker: any, spawn?: any) => new DockerProvider({ image: 'wb-sandbox:latest', docker: docker.fn, spawn, rand: () => 'abc123', now: () => new Date('2026-11-04T00:00:00Z') });
const fakeSpawn = (onSpawn?: (ee: any) => void) => () => {
  const ee: any = new EventEmitter();
  ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter();
  ee.kill = () => { setImmediate(() => ee.emit('close', null, 'SIGKILL')); };
  if (onSpawn) onSpawn(ee);
  return ee;
};

describe('046.1 · DockerProvider（假 docker）', () => {
  test('创建顺序：先建 --internal 内网，再建卷，最后起容器', async () => {
    const d = fakeDocker();
    const box = await mk(d).create({ taskId: 7, runId: 3 });
    assert.deepEqual(d.verbs(), ['network create', 'volume create', 'run -d']);
    assert.ok(d.calls[0].args.includes('--internal'));
    assert.equal(d.calls[0].args.at(-1), 'wb-sbx-net-T7-abc123');
    assert.equal(box.info().provider, 'docker');
    assert.equal(box.info().tier, 1);
    assert.equal(box.info().id, 'wb-sbx-T7-abc123');
  });

  test('起容器失败：已经建好的卷和内网要拆掉，并且抛错', async () => {
    const d = fakeDocker((a) => (a[0] === 'run' ? { code: 1, stderr: 'no space left' } : {}));
    await assert.rejects(() => mk(d).create({ taskId: 7 }), /起容器失败.*no space/);
    assert.deepEqual(d.verbs().slice(3), ['volume rm', 'network rm']);
  });

  test('参数不合规：还没动 Docker 就抛错', async () => {
    const d = fakeDocker();
    await assert.rejects(() => mk(d).create({ taskId: 7, env: { WB_TOKEN: 'x' } }), /白名单/);
    assert.equal(d.calls.length, 0);
  });

  test('destroy 幂等；销毁后再用直接抛错', async () => {
    const d = fakeDocker();
    const box = await mk(d).create({ taskId: 7 });
    const before = d.calls.length;
    await box.destroy();
    assert.deepEqual(d.verbs().slice(before), ['rm -f', 'volume rm', 'network rm']);
    await box.destroy();
    assert.equal(d.calls.length, before + 3, '第二次不再调 docker');
    await assert.rejects(() => box.exec(['ls']), /已经销毁/);
    await assert.rejects(() => box.copyIn('x', '/work/x'), /已经销毁/);
  });

  test('容器里的路径：copyIn 只许 /work，..、别的根都拒绝', async () => {
    const d = fakeDocker();
    const box = await mk(d).create({ taskId: 7 });
    for (const p of ['/etc/passwd', '/work/../etc/passwd', 'work/x', '/workx/a', '/work//x', '/work/./x', '/work\\x', `/home/agent/x`, '/run/wb/x', '/proc/1/root', '']) await assert.rejects(() => box.copyIn('h', p), /容器里|路径/, p);
    await box.copyIn('h/repo.bundle', '/work/repo.bundle');
    assert.deepEqual(d.calls.at(-1)!.args, ['cp', 'h/repo.bundle', 'wb-sbx-T7-abc123:/work/repo.bundle']);
    assert.equal(assertBoxPath('/work/a', ['/work']), '/work/a');
  });

  test('writeFile：数据走 stdin，路径当位置参数，不拼进 sh -c 的字符串', async () => {
    const d = fakeDocker();
    const box = await mk(d).create({ taskId: 7 });
    await box.writeFile(`/home/agent/.claude/x.json`, '{"a":1}');
    const c = d.calls.at(-1)!;
    assert.equal(c.input, '{"a":1}');
    assert.deepEqual(c.args.slice(-4), ['-c', 'umask 077; cat > "$1"', 'sh', `/home/agent/.claude/x.json`]);
    await assert.rejects(() => box.writeFile('/etc/passwd', 'x'), /只许碰/);
  });

  test('exec：环境变量要在白名单里；超时会 docker kill', async () => {
    const d = fakeDocker();
    const spawned: any[] = [];
    const spawnFn = (cmd: string, args: string[]) => { spawned.push({ cmd, args }); return fakeSpawn()(); };
    const box = await mk(d, spawnFn).create({ taskId: 7 });
    await assert.rejects(() => box.exec(['ls'], { env: { SECRET: 'x' } }), /白名单/);
    await assert.rejects(() => box.exec(['ls'], { cwd: '/etc' }), /只许碰/);
    await assert.rejects(() => box.exec([], {}), /非空/);
    const r = await box.exec(['sleep', '999'], { timeoutMs: 20, env: { HOME: `/home/agent` } });
    assert.equal(r.timedOut, true);
    assert.deepEqual(spawned[0].args.slice(0, 5), ['exec', '-w', '/work', '-e', `HOME=/home/agent`]);
    assert.ok(d.calls.some((c) => c.args[0] === 'kill' && c.args[1] === 'wb-sbx-T7-abc123'), '到点要 docker kill 容器');
  });

  test('exec：按行回调 stdout / stderr', async () => {
    const d = fakeDocker();
    const spawnFn = fakeSpawn((ee) => setImmediate(() => { ee.stdout.emit('data', Buffer.from('one\ntw')); ee.stdout.emit('data', Buffer.from('o\r\n')); ee.stderr.emit('data', Buffer.from('err')); ee.emit('close', 0, null); }));
    const box = await mk(d, spawnFn).create({ taskId: 7 });
    const lines: string[] = [];
    const r = await box.exec(['echo'], { onLine: (l: string) => lines.push(l) });
    assert.deepEqual(lines, ['one', 'two', 'err']);
    assert.equal(r.code, 0);
  });

  test('copyOut：只出 /work 下的普通文件；大小、类型、目标目录都要查', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sbx-out-'));
    try {
      let stat = 'regular file|100';
      const d = fakeDocker((a) => {
        if (a[0] === 'exec' && a.includes('stat')) return { stdout: stat };
        if (a[0] === 'cp' && a[1].includes(':')) { writeFileSync(a[2], 'patch'); return {}; }
        return {};
      });
      const box = await mk(d).create({ taskId: 7 });
      await assert.rejects(() => box.copyOut('/etc/passwd', dir), /只许碰/);
      stat = 'symbolic link|10';
      await assert.rejects(() => box.copyOut('/work/out.patch', dir), /不是普通文件/);
      stat = 'regular file|999999999';
      await assert.rejects(() => box.copyOut('/work/out.patch', dir), /太大/);
      stat = 'regular file|100';
      const got = await box.copyOut('/work/out.patch', dir);
      assert.equal(got, join(dir, 'out.patch'));
      assert.ok(existsSync(got));
      await assert.rejects(() => box.copyOut('/work/out.patch', dir), /不是空的/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('copyOut：复制完发现是符号链接，也拒绝', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sbx-out-'));
    const target = join(tmpdir(), `wb-sbx-target-${process.pid}.txt`);
    try {
      writeFileSync(target, 'x');
      const d = fakeDocker((a) => {
        if (a[0] === 'exec' && a.includes('stat')) return { stdout: 'regular file|1' };
        if (a[0] === 'cp' && a[1].includes(':')) { symlinkSync(target, a[2]); return {}; }
        return {};
      });
      const box = await mk(d).create({ taskId: 7 });
      try { symlinkSync(target, join(dir, '.probe')); rmSync(join(dir, '.probe')); } catch { t.skip('这台机器不能建符号链接'); return; }
      await assert.rejects(() => box.copyOut('/work/out.patch', dir), /不是普通文件/);
      assert.ok(lstatSync(join(dir, 'out.patch')).isSymbolicLink());
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(target, { force: true }); }
  });

  test('available：没装 Docker / 镜像没建 / 都好', async () => {
    let fail = 'version';
    const d = fakeDocker((a) => (a[0] === fail ? { code: 1 } : {}));
    const p = mk(d);
    assert.deepEqual(await p.available(), { ok: false, why: '没装 Docker，或者 Docker Desktop 没启动' });
    fail = 'image';
    const r = await p.available();
    assert.equal(r.ok, false);
    assert.match(r.why, /镜像 wb-sandbox:latest 还没建/);
    fail = 'none';
    assert.deepEqual(await p.available(), { ok: true, why: '' });
  });

  test('孤儿扫描：任务还在跑的留着，其余容器、卷、网络全删', async () => {
    const d = fakeDocker((a) => {
      if (a[0] === 'ps') return { stdout: 'wb-sbx-T5-aaaaaa\nwb-sbx-T6-bbbbbb\nwb-sbx-weird\n' };
      if (a[0] === 'volume' && a[1] === 'ls') return { stdout: 'wb-sbx-vol-T5-aaaaaa\nwb-sbx-vol-T6-bbbbbb\n' };
      if (a[0] === 'network' && a[1] === 'ls') return { stdout: 'wb-sbx-net-T5-aaaaaa\nwb-sbx-net-T9-cccccc\n' };
      return {};
    });
    const removed = await mk(d).sweepOrphans([5]);
    assert.deepEqual(removed, ['容器 wb-sbx-T6-bbbbbb', '容器 wb-sbx-weird', '卷 wb-sbx-vol-T6-bbbbbb', '网络 wb-sbx-net-T9-cccccc']);
    assert.ok(!d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('wb-sbx-T5-aaaaaa')));
  });

  test('getProvider：不认识的名字抛错（不退回宿主）；docker 要镜像；vm 不可用；none 是第 0 档', async () => {
    assert.throws(() => getProvider('dokcer'), /不认识的沙箱类型/);
    assert.throws(() => getProvider('docker', {}), /sandboxImage/);
    assert.throws(() => getProvider('docker', { image: 'x', limits: { memoryMb: -1 } }), /limits/);
    assert.equal(getProvider('docker', { image: 'wb-sandbox:latest' }).tier, 1);
    const vm = getProvider('vm');
    assert.ok(vm instanceof VmProvider);
    assert.equal((await vm.available()).ok, false);
    await assert.rejects(() => vm.create(), /还没实现/);
    const none = getProvider('none');
    assert.ok(none instanceof NoneProvider);
    assert.equal(none.tier, 0);
    assert.equal(getProvider(undefined).name, 'none');
    assert.equal((await none.create({ taskId: 9 })).info().tier, 0);
  });
});
