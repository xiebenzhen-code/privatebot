// 022 · 导出干净试用包的测试：用临时 git 仓库做夹具，不碰真实仓库。
// 覆盖：未跟踪文件不进包、私有 specs/reports 被替换、六类敏感内容各自拦下且不泄露原文、
// 黑名单缺失要教怎么建、放行登记、--git 恰好一条通用作者的提交、输出目录校验、
// 源仓库不变、diagnose 不泄露假 key 与审计正文。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL = join(import.meta.dirname, '..');
const BLOCK_WORD = 'wangwu-q7x9'; // 故意选不会出现在脚本示例文字里的词

// 022.1：这些是「扫描能不能抓到」用的假数据，全部拆成拼接、运行时才成形。
// 文件里没有可被扫到的原文，所以导出这份仓库本身也能 0 命中，不用放行登记去掩盖。
const FAKE_KEY = 'sk-' + 'live' + '-abcdefghijklmnop';
const FAKE_ALLOW_KEY = 'sk-' + 'live' + '-allowme0000000000';
const FAKE_IP = '192' + '.168.31.44';
const FAKE_USER_DIR = 'C:/Users/' + '某' + '人';
const FAKE_EMAIL = 'someone' + '@' + 'realcorp.cn';
const FAKE_HOOK = 'https://' + 'qyapi.weixin.qq.com' + '/cgi-bin/webhook/send?key=1a2b3c4d5e';

type Fixture = { root: string; repo: string; blocklist: string };

/**
 * 造一个临时 git 仓库夹具。路径故意带空格和中文（020.1：Windows 和 Linux 都要过）。
 * `extra` 写进夹具并提交；`opts.handoffTemplate` 可替换模板内容以测悬空链接检查。
 */
function fixture(extra: Record<string, string> = {}, opts: { handoffTemplate?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-export-'));
  const repo = join(root, '我的 项目');
  mkdirSync(repo, { recursive: true });

  const base: Record<string, string> = {
    '.gitignore': '.env\ndata/\n',
    'package.json': JSON.stringify({ name: 'demo', version: '0.0.0', private: true, author: '谢本桢', license: 'PolyForm-Noncommercial-1.0.0' }, null, 2) + '\n',
    'LICENSE': 'PolyForm Noncommercial License 1.0.0\n\nRequired Notice: Copyright (c) 2026 谢本桢\n',
    'README.md': '# demo\n\n遇到问题先运行 `npm run diagnose`。\n',
    'CLAUDE.md': '# CLAUDE\n\n需求单在 `docs/specs/`，流程见 `docs/specs/README.md`。\n',
    'src/app.ts': 'export const answer = 42;\n',
    'test/app.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('ok', () => assert.equal(1, 1));\n",
    'docs/USAGE.md': '# 使用手册\n',
    // 这个项目自己的东西：导出后不该出现
    'docs/reports/2026-01-01.md': '余额还剩 1234.56 CNY，账号 zhangsan 的情况。\n',
    'docs/specs/README.md': '# 本项目的需求单\n\n| 001 | 私人项目 |\n',
    'docs/specs/001-private.md': '# 私人需求单\n\n余额 1234.56，机器名 DESKTOP-X。\n',
    'private/packs/ecommerce.md': '# 电商行业包\n',
    'media/intro/scene.js': 'export const scene = 1;\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(base)) {
    const p = join(repo, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }

  // 脚本本身和模板要在夹具里（导出脚本按自己的位置找仓库根和模板）。
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'templates', 'new-project'), { recursive: true });
  cpSync(join(REAL, 'scripts', 'export-trial.mjs'), join(repo, 'scripts', 'export-trial.mjs'));
  cpSync(join(REAL, 'scripts', 'diagnose.mjs'), join(repo, 'scripts', 'diagnose.mjs'));
  cpSync(join(REAL, 'scripts', 'lib', 'export-scan.mjs'), join(repo, 'scripts', 'lib', 'export-scan.mjs'));
  cpSync(join(REAL, 'docs', 'templates', 'new-project', 'specs-README.md'), join(repo, 'docs', 'templates', 'new-project', 'specs-README.md'));
  writeFileSync(
    join(repo, 'docs', 'templates', 'new-project', 'DECISION-HANDOFF.md'),
    opts.handoffTemplate ?? '# 决策端交接\n\n需求单见 `docs/specs/README.md`。\n',
  );

  // 刻意不提交的文件：导出绝不能带上
  writeFileSync(join(repo, '.env'), 'WB_TOKEN=secret-token-0123456789\n');
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(join(repo, 'data', 'x.db'), 'not-a-real-db');

  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']); // 夹具整体提交，这里没有用户文件
  git(repo, ['-c', 'user.name=Personal Name', '-c', 'user.email=me@example.com', 'commit', '-q', '-m', 'fixture']);

  const blocklist = join(root, 'blocklist.txt');
  writeFileSync(blocklist, `# 不要放进仓库\n${BLOCK_WORD}\n`);
  return { root, repo, blocklist };
}

function git(cwd: string, argv: string[]): string {
  return execFileSync('git', argv, { cwd, encoding: 'utf8' });
}

/** 跑导出脚本。返回退出码和全部输出。 */
function runExport(fx: Fixture, out: string, extraArgs: string[] = []) {
  const r = spawnSync(process.execPath, [
    join(fx.repo, 'scripts', 'export-trial.mjs'), '--out', out, '--blocklist', fx.blocklist, ...extraArgs,
  ], { cwd: fx.repo, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, out };
}

const exists = (p: string) => existsSync(p);

describe('022 · 导出干净试用包', () => {
  test('只导出 git 跟踪的文件；私有需求单和 reports 换成通用文档', () => {
    const fx = fixture();
    const out = join(fx.root, 'trial');
    const r = runExport(fx, out);
    assert.equal(r.code, 0, r.output);

    assert.ok(!exists(join(out, '.env')), '.env 没进去');
    assert.ok(!exists(join(out, 'data', 'x.db')), 'data/ 没进去');
    assert.ok(!exists(join(out, 'docs', 'reports')), 'reports 拿掉了');
    assert.ok(!exists(join(out, 'docs', 'specs', '001-private.md')), '本项目的需求单拿掉了');
    assert.ok(!exists(join(out, 'private')), 'private/ 留在手里');
    assert.ok(!exists(join(out, 'media')), 'media/ 留在手里');

    const specsReadme = readFileSync(join(out, 'docs', 'specs', 'README.md'), 'utf8');
    assert.match(specsReadme, /需求单（specs）/, '换成模板内容');
    assert.ok(!specsReadme.includes('私人项目'), '没有本项目特有内容');
    assert.ok(!specsReadme.includes('> 模板。'), '模板提示行去掉了');
    assert.ok(exists(join(out, 'docs', 'specs', 'DECISION-HANDOFF.md')));
    assert.ok(exists(join(out, 'VERSION')));
    assert.match(readFileSync(join(out, 'VERSION'), 'utf8'), /^[0-9a-f]{7,}\n导出日期：\d{4}-\d{2}-\d{2}/);
  });

  test('模板里引用被拿掉的需求单时，导出失败并说明是悬空链接', () => {
    const fx = fixture({}, { handoffTemplate: '# 交接\n\n见 `docs/specs/042-gone.md`。\n' });
    const r = runExport(fx, join(fx.root, 'trial'));
    assert.equal(r.code, 1);
    assert.match(r.output, /悬空链接/);
    assert.ok(!exists(join(fx.root, 'trial')), '什么都没留');
  });

  // 六类各来一次：每个都要拦下，且输出里不能出现原文。
  const SECRETS: [string, string, string][] = [
    ['假 key', 'leak.ts', `const k = "${FAKE_KEY}";\n`],
    ['私有 IP', 'leak.ts', `const host = "${FAKE_IP}";\n`],
    ['个人路径', 'leak.md', `备份在 ${FAKE_USER_DIR}/backups。\n`],
    ['邮箱', 'leak.md', `联系 ${FAKE_EMAIL}。\n`],
    ['webhook', 'leak.json', `{"url":"${FAKE_HOOK}"}\n`],
    ['黑名单词', 'leak.md', `作者是 ${BLOCK_WORD}。\n`],
  ];
  for (const [name, file, text] of SECRETS) {
    test(`扫描拦下${name}，输出里找不到原文`, () => {
      const fx = fixture({ [file]: text });
      const out = join(fx.root, 'trial');
      const r = runExport(fx, out);
      assert.equal(r.code, 1, `${name} 应使导出失败`);
      assert.ok(!exists(out), '什么都没导出');
      // 原文里的敏感片段不能出现在输出里（只允许文件、行号、规则、行哈希）。
      const needle = text.match(/[A-Za-z0-9_.:@/-]{8,}/)?.[0];
      if (needle && needle !== BLOCK_WORD) assert.ok(!r.output.includes(needle), `输出泄露了 ${needle}`);
      if (name === '黑名单词') assert.ok(!r.output.includes(BLOCK_WORD), '黑名单词不能打印');
    });
  }

  test('黑名单文件不存在：失败并告诉你怎么建，不是默默跳过', () => {
    const fx = fixture();
    const r = spawnSync(process.execPath, [
      join(fx.repo, 'scripts', 'export-trial.mjs'), '--out', join(fx.root, 'trial'), '--blocklist', join(fx.root, 'nope.txt'),
    ], { cwd: fx.repo, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /先建一个/);
    assert.ok(!exists(join(fx.root, 'trial')));
  });

  test('127.0.0.1、localhost、example.com 邮箱不报', () => {
    const fx = fixture({
      'docs/LOCAL.md': '本机接口 http://127.0.0.1:3200 和 http://localhost:3200，邮箱 user@example.com。\n',
    });
    const r = runExport(fx, join(fx.root, 'trial'));
    assert.equal(r.code, 0, r.output);
  });

  test('放行登记按「文件+规则+行哈希」生效，登记项里没有原文', () => {
    const line = `const demoKey = "${FAKE_ALLOW_KEY}";`;
    const fx = fixture({ 'src/leak.ts': line + '\n' });
    // 先跑一次拿到行哈希
    const first = runExport(fx, join(fx.root, 'trial1'));
    assert.equal(first.code, 1);
    const hash = first.output.match(/行哈希 ([0-9a-f]{16})/)?.[1];
    assert.ok(hash, '失败信息里带行哈希，方便登记');

    writeFileSync(join(fx.repo, 'scripts', 'export-allow.json'), JSON.stringify({
      allow: [{ file: 'src/leak.ts', rule: 'key-sk', hash }],
    }) + '\n');
    git(fx.repo, ['add', 'scripts/export-allow.json']);
    git(fx.repo, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'allow']);

    const allowText = readFileSync(join(fx.repo, 'scripts', 'export-allow.json'), 'utf8');
    assert.ok(!allowText.includes(FAKE_ALLOW_KEY.slice(0, 14)), '登记项只有哈希，没有原文');

    const second = runExport(fx, join(fx.root, 'trial2'));
    assert.equal(second.code, 0, second.output);
  });

  test('--git 恰好一条提交，作者是通用名字（不用本机配置的个人名字）', () => {
    const fx = fixture();
    const out = join(fx.root, 'trial');
    const r = runExport(fx, out, ['--git', '--skip-selftest']);
    assert.equal(r.code, 0, r.output);
    const count = git(out, ['rev-list', '--count', 'HEAD']).trim();
    assert.equal(count, '1', '唯一一条提交');
    const author = git(out, ['log', '-1', '--format=%an <%ae>']).trim();
    assert.equal(author, 'ai-workbench <noreply@example.com>');
    assert.ok(!author.includes('Personal Name'), '没用本机 git 配置');
    const msg = git(out, ['log', '-1', '--format=%s']).trim();
    assert.match(msg, /^ai-workbench trial snapshot [0-9a-f]{7,}$/);
    const config = readFileSync(join(out, '.git', 'config'), 'utf8');
    assert.ok(!/\[remote/.test(config), '没有远端，脚本也不 push');
  });

  test('输出目录在仓库里、或已存在且非空，直接拒绝；源仓库不受影响', () => {
    const fx = fixture();
    const before = git(fx.repo, ['rev-parse', 'HEAD']).trim();

    const inside = runExport(fx, join(fx.repo, 'trial-out'));
    assert.equal(inside.code, 1);
    assert.match(inside.output, /仓库外面/);
    assert.ok(!exists(join(fx.repo, 'trial-out')), '没在仓库里留下东西');

    const taken = join(fx.root, 'taken');
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'keep.txt'), 'keep');
    const nonEmpty = runExport(fx, taken);
    assert.equal(nonEmpty.code, 1);
    assert.match(nonEmpty.output, /已存在且非空/);
    assert.equal(readFileSync(join(taken, 'keep.txt'), 'utf8'), 'keep', '不覆盖已有内容');

    assert.equal(git(fx.repo, ['rev-parse', 'HEAD']).trim(), before, '源仓库 HEAD 不变');
    assert.equal(git(fx.repo, ['status', '--porcelain']).trim(), '', '源仓库仍然干净');
  });

  test('导出包自检：node --test 与 setup --dry-run 都会跑', () => {
    const fx = fixture();
    const out = join(fx.root, 'trial');
    const r = runExport(fx, out); // 不跳过自检
    assert.equal(r.code, 0, r.output);
    const report = readFileSync(`${out}.report.txt`, 'utf8');
    assert.match(report, /自检 node --test：通过/);
    assert.match(report, /许可证：PolyForm-Noncommercial-1\.0\.0/, '报告里要能看出许可证');
  });

  test('diagnose：假 key 和审计正文都不出现在输出里', async () => {
    const fx = fixture();
    // 造一个只有 events 表的最小数据库（审计正文是敏感内容）
    const dataDir = join(fx.repo, 'data');
    mkdirSync(dataDir, { recursive: true });
    const dbFile = join(dataDir, 'workbench.db');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, text TEXT)');
    db.prepare('INSERT INTO events (kind, text) VALUES (?, ?)').run('task.failed', `正文里有 ${FAKE_KEY} 和 ${FAKE_USER_DIR}/secret`);
    db.close();
    // .env 里放一个假 key（只列变量名，不列值）
    writeFileSync(join(fx.repo, '.env'), `WB_TOKEN=secret-token-0123456789\nPORT=9\nWB_SETUP_KEY_DEEPSEEK=${FAKE_KEY}\n`);

    const r = spawnSync(process.execPath, [join(fx.repo, 'scripts', 'diagnose.mjs')], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, PORT: '9', WB_SETUP_KEY_DEEPSEEK: FAKE_KEY },
    });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 0, output);
    assert.ok(!output.includes(FAKE_KEY), 'key 不出现');
    assert.ok(!output.includes(FAKE_USER_DIR), '路径不出现');
    assert.ok(!output.includes('正文里有'), '审计正文不出现');
    assert.match(output, /task\.failed ×1/, '只给类型和条数');
  });

  // 022.1 发现的真 bug：脚本按 utf8 读再写，会把截图这类二进制毁掉。
  test('截图这类二进制按字节原样复制', () => {
    const fx = fixture();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe, 0x42]);
    mkdirSync(join(fx.repo, 'docs', 'screenshots'), { recursive: true });
    writeFileSync(join(fx.repo, 'docs', 'screenshots', 'overview.png'), png);
    git(fx.repo, ['add', 'docs/screenshots/overview.png']);
    git(fx.repo, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'png']);

    const out = join(fx.root, 'trial');
    const r = runExport(fx, out);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(readFileSync(join(out, 'docs', 'screenshots', 'overview.png')), png, 'PNG 字节不能被改');
  });
});
