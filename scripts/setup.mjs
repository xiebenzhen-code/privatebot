#!/usr/bin/env node
// 020: one-time setup. Two ways in, one code path:
//
//   npm run setup                       ask, one question at a time (a person)
//   npm run setup -- --yes --project x=C:/code/x --json
//                                       no questions, JSON events, meaningful exit codes (an agent)
//
// Keys never come from argv. Interactive mode hides them; unattended mode reads them from
// WB_SETUP_KEY_DEEPSEEK / WB_SETUP_KEY_BAILIAN / WB_SETUP_KEY_CUSTOM or --key-file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BACKENDS, EXIT, checkProject, defaultProjectsRoot, ensureStarterProject, parseArgs, probeBackend, redact, resolveProjectsRoot, runUnattended } from './lib/setup-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MIN = [22, 18];

const args = parseArgs(process.argv.slice(2));
const opts = args.opts;
const unattended = opts.yes || !process.stdin.isTTY;

let jsonMode = opts.json;
const say = (line) => { if (!jsonMode) console.log(line); };
const event = (step, status, detail, extra) => {
  if (jsonMode) console.log(JSON.stringify({ step, status, ...(detail ? { detail } : {}), ...(extra ?? {}) }));
  else if (detail) console.log(`  ${status === 'ok' ? '✓' : status === 'bad' || status === 'missing' ? '✗' : '·'} ${detail}`);
};
const finish = (code) => process.exit(code);

const HELP = `用法：
  npm run setup                      一问一答（真人）
  npm run setup -- --yes ...         不提问（agent / 脚本）

参数（不提问时）：
  --project 名字=路径                 可重复。要让 AI 改的仓库
  --projects-root <路径>              新建项目建在这个文件夹下（网页上「＋ 新建项目」用）。
                                      提问时默认 ~/ai-projects；不提问时不给就留空（功能不可用）
  --worktree-root <路径>              执行器放临时分支的目录，默认跟项目同级
  --backend deepseek|bailian|custom   模型接口，默认 deepseek
  --base-url <地址> --model <模型名>   自定义接口时才需要
  --tz Asia/Shanghai                  时区
  --backup-dir <路径>                 自动备份目录（可跳过）
  --lan                               让同一局域网里的手机也能访问（默认只有本机能开）
  --start docker|node|none            工作台怎么启动，默认 none（只提示命令）
  --key-file <路径>                   key 放在文件第一行
  --json                              一行一个 JSON 事件
  --dry-run                           只检查，不写任何文件
  --yes                               不提问（没有 TTY 时自动打开）

key 只能从环境变量 WB_SETUP_KEY_DEEPSEEK / WB_SETUP_KEY_BAILIAN / WB_SETUP_KEY_CUSTOM
或 --key-file 给，不能写在命令行参数里。
退出码：0 成功 / 1 缺必填项 / 2 环境不满足 / 3 验证失败 / 4 其他错误。`;

if (opts.help) { console.log(HELP); finish(EXIT.ok); }
if (args.errors.length) {
  for (const e of args.errors) console.error(`✗ ${e}`);
  finish(EXIT.other);
}

// ---------- environment ----------

function nodeVersionOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > NODE_MIN[0] || (maj === NODE_MIN[0] && min >= NODE_MIN[1]);
}

const has = (cmd) => {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return probe.status === 0;
};

function checkEnvironment() {
  const rows = [
    { name: `Node ${process.versions.node}`, ok: nodeVersionOk(), hint: `工作台要 ${NODE_MIN.join('.')} 或更新，去 nodejs.org 装 LTS` },
    { name: 'git', ok: has('git'), hint: '装 git 后重开这个窗口' },
    { name: 'Docker', ok: has('docker'), optional: true, hint: '没有也能跑：用 npm start' },
    { name: 'claude 命令', ok: has('claude'), optional: true, hint: '想让 AI 自动干活才需要，见 docs/AGENT-INSTALL.md' },
  ];
  for (const r of rows) event('env-check', r.ok ? 'ok' : (r.optional ? 'optional' : 'bad'), `${r.name}${r.ok ? '' : ` — ${r.hint}`}`);
  return rows;
}

const io = {
  exists: existsSync,
  readFile: (p, enc) => readFileSync(p, enc),
  writeFile: (p, data, o) => writeFileSync(p, data, o),
  mkdirp: (p) => { if (p) mkdirSync(p, { recursive: true }); },
  dirname,
  homedir: homedir(),
  env: process.env,
  envPath: join(ROOT, '.env'),
  gitignorePath: join(ROOT, '.gitignore'),
  configPath: join(homedir(), '.ai-workbench-runner.json'),
  port: Number(process.env.WB_PORT ?? 3200),
  generateToken: () => randomBytes(24).toString('hex'),
  // 058：第一个项目。只在一个新建的空文件夹里跑 git，作者写死成通用名字，不读也不改用户的 git 配置。
  gitInit: (dir) => {
    const git = (...a) => {
      const r = spawnSync('git', ['-c', 'user.name=PrivateBot', '-c', 'user.email=privatebot@localhost', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `git ${a[0]} 失败`).trim().slice(0, 200));
    };
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), '# 第一个项目\n\n工作台装好时自动建的。在工作台里派活时，「项目」选 first，AI 就在这个文件夹里干活。\n\n想用自己的文件夹，重新跑一次 `npm run setup` 加上它。\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', '第一个项目');
  },
  generatePassword: () => `${randomBytes(9).toString('base64url')}${randomBytes(4).toString('hex')}`.slice(0, 20),
};

// ---------- interactive ----------

function hiddenQuestion(question) {
  // No dependency: mute the echo while the key is typed, restore it in every exit path.
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = () => { process.stdout.write('\r\x1b[2K'); };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolveAnswer(answer.trim());
    });
  });
}

async function interactive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, dflt = '') => new Promise((res) => rl.question(dflt ? `${q}（回车用 ${dflt}）` : q, (a) => res(a.trim() || dflt)));

  say('这一步干什么：把工作台配到能跑起来。需要写 key 的都在这个窗口里，网页上不收任何密钥。');
  const rows = checkEnvironment();
  if (!rows[0].ok) { rl.close(); say('✗ Node 版本不够，先升级再回来。'); return EXIT.env; }
  if (opts.dryRun) say('（--dry-run：只检查，不写文件）');

  // projects
  const projects = [];
  for (;;) {
    const path = await ask(projects.length ? '再加一个项目？输入路径，回车跳过：' : '要让 AI 改哪个仓库？输入本机路径；没有就回车，给你建一个空的：');
    if (!path) break;
    const check = checkProject(path, io);
    if (!check.ok) { say(`  ✗ ${check.problems.join('；')}，再试一次`); continue; }
    const name = await ask('  给它起个短名字：', path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project');
    projects.push({ name, path });
    say(`  ✓ 记下 ${name}`);
  }
  // 030 A.3：网页上点「新建项目」就往这个文件夹里建。不问的话，功能一直是「先配一个根目录」。
  const projectsRoot = resolveProjectsRoot(await ask('\n新项目放在哪个文件夹？', defaultProjectsRoot()));
  say(`  新项目会建在 ${projectsRoot} 下面（只能是它的直接子文件夹）`);
  // 058：一个项目都没给，就建一个空的当第一个项目，不让人卡在「先去学 git」。
  if (!projects.length) {
    const r = ensureStarterProject({ projectsRoot, dryRun: opts.dryRun }, io);
    say(r.ok ? `  ✓ ${r.detail}` : `  ✗ ${r.detail}`);
    if (r.ok) projects.push(r.project);
  }

  // backend
  let backend = 'deepseek';
  let baseUrl = '';
  let model = '';
  let keyFile = '';
  if (projects.length) {
    say('\n用哪家模型接口？1 DeepSeek 官方 / 2 阿里云百炼 / 3 自定义');
    const pick = await ask('选一个：', '1');
    backend = pick === '2' ? 'bailian' : pick === '3' ? 'custom' : 'deepseek';
    const spec = BACKENDS[backend];
    if (backend === 'custom') {
      baseUrl = await ask('接口地址（Anthropic 兼容，到 /v1 之前）：');
      model = await ask('模型名：');
    } else {
      baseUrl = spec.baseUrl;
      model = await ask(`模型名：`, spec.model);
    }
    say('把 key 粘进来（输入时不显示）。');
    const key = await hiddenQuestion('  key：');
    if (key) {
      const tmp = join(homedir(), '.ai-workbench-key.tmp');
      writeFileSync(tmp, key, { mode: 0o600 });
      keyFile = tmp;
      say('  已收下，只用来写进执行器配置，不会打印。');
    }
  }

  const tz = await ask('\n时区：', 'Asia/Shanghai');
  const backupDir = await ask('自动备份写到哪个文件夹？（可回车跳过）：');
  // 024: 默认只有本机能开。局域网是明文，共用网络里不该这样用，所以默认答否。
  const lanAnswer = await ask('\n要让同一 Wi-Fi 下的手机访问吗？局域网里是明文，公司/咖啡店的网络别这样用 (y/N)：', 'n');
  const lan = /^y/i.test(lanAnswer);
  rl.close();

  const res = await runUnattended(
    {
      project: projects, backend, baseUrl, model, tz, backupDir, keyFile, lan, projectsRoot,
      workbench: `http://localhost:${io.port}`, start: 'none',
      dryRun: opts.dryRun,
    },
    { ...io, env: { ...process.env, [`${BACKENDS[backend].envKey}`]: keyFile ? io.readFile(keyFile, 'utf8').trim() : '' } },
  );
  for (const e of res.events) event(e.step, e.status, e.detail);
  if (keyFile) { try { writeFileSync(keyFile, ''); } catch { /* best effort */ } }

  if (res.code === EXIT.ok) {
    say('\n接下来：');
    for (const line of res.summary.next) say(`  · ${line}`);
    const go = await (async () => {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const a = await new Promise((r2) => rl2.question('要现在启动工作台吗？(y/N)：', r2));
      rl2.close();
      return a.trim().toLowerCase() === 'y';
    })();
    if (go) {
      const cmd = has('docker') ? ['docker', ['compose', 'up', '-d']] : [process.execPath, ['src/server.ts']];
      say(`运行 ${cmd[0]} ${cmd[1].join(' ')}`);
      spawnSync(cmd[0], cmd[1], { cwd: ROOT, stdio: 'inherit' });
    }
  }
  return res.code;
}

// ---------- main ----------

async function main() {
  if (!unattended) return interactive();

  jsonMode = opts.json;
  const rows = checkEnvironment();
  if (!rows[0].ok) {
    event('node', 'bad', `Node ${process.versions.node} 太旧，工作台要 ${NODE_MIN.join('.')}+`);
    return EXIT.env;
  }
  const res = await runUnattended(opts, {
    ...io,
    env: process.env,
    fetchImpl: fetch,
  });
  for (const e of res.events) {
    if (e.step === 'password') {
      // The single allowed appearance of a secret: shown once, for the agent to hand to the user.
      console.log(JSON.stringify(e));
    } else {
      event(e.step, e.status, e.detail);
    }
  }
  if (res.code !== EXIT.ok && !res.events.some((e) => e.step === 'backend' && e.status === 'missing')) {
    // nothing extra: the failing step already said what is wrong
  }
  const keyEnv = BACKENDS[opts.backend ?? 'deepseek'].envKey;
  if (jsonMode) console.log(JSON.stringify(res.summary));
  else if (res.code === EXIT.ok) for (const line of res.summary.next ?? []) console.log(`  · ${line}`);
  if (res.code !== EXIT.ok && !jsonMode) console.log(`\n没装完。key 在环境变量 ${keyEnv} 里给了吗？`);
  return res.code;
}

main().then(finish).catch((err) => { console.error(`✗ ${redact(err?.stack ?? err)}`); finish(EXIT.other); });
