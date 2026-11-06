// 030：在工作台里新建项目——工作台只管记请求，真正建文件夹、跑 git、改配置的只有执行器。
// 这里放「两个地方都要一样」的规则：项目名、远端地址，以及真正动磁盘的几个动作。
// 服务端的 src/services/projects.ts 直接 import 这几个判断，免得两边规则各写一套后走样。
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// Windows 的保留设备名：建了也删不掉，git 也未必能提交，干脆一开始就不让用。
const RESERVED = new Set([
  'con', 'nul', 'aux', 'prn',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 名字不合格就返回一句人话，合格返回 null。工作台和执行器都调这个。 */
export function projectNameProblem(name) {
  const s = String(name ?? '');
  if (!s) return '项目名不能为空';
  if (s.length > 40) return '项目名最多 40 个字符';
  if (s.startsWith('.') || s.startsWith('-')) return '项目名不能以 . 或 - 开头';
  if (!NAME_RE.test(s)) return '项目名只能用小写字母、数字、- 和 _（不能有大写、空格或路径符号）';
  if (RESERVED.has(s)) return `「${s}」是 Windows 的保留设备名，换一个`;
  return null;
}

/** 远端地址：只认干净的 https。凭据、ssh、file、本地路径一律不行。 */
export function remoteUrlProblem(url) {
  const s = String(url ?? '').trim();
  if (!s) return '地址不能为空';
  if (/^ssh:\/\//i.test(s) || /^git@/i.test(s)) return '不支持 ssh，请用 https:// 的地址';
  if (/^file:\/\//i.test(s)) return '不支持 file://，只认网上的 https 地址';
  if (!/^https:\/\//i.test(s)) return '只支持 https:// 开头的地址（http、ssh、本地路径都不行）';
  if (/\/\/[^/]*@/.test(s)) return '地址里不要写账号密码——用你电脑上已有的 git 登录';
  if (/[?&](access_token|token|private_token|key|password)=/i.test(s)) return '地址里不要带令牌，用你电脑上已有的 git 登录';
  if (!/^https:\/\/[^\s/]+\/\S+$/i.test(s)) return '这不像一个仓库地址，形如 https://github.com/用户名/仓库.git';
  return null;
}

const GITIGNORE = ['node_modules', '.env', '*.log', '.DS_Store'].join('\n') + '\n';

export function claudeMd(name, note) {
  return [
    `# ${name}`,
    '',
    String(note ?? '').trim() || '（还没有写说明。）',
    '',
    '## 约定',
    '',
    '- 改之前先读这个文件。',
    '- 改动要有测试。',
    '- 不要提交密钥、令牌、密码。',
    '',
  ].join('\n');
}

/** 执行器自己写的那几个文件：只有这些的文件夹算「上次没收尾」，可以接着做。 */
const OWN_FILES = new Set(['.git', '.gitignore', 'CLAUDE.md']);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); // 043 B
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || '').slice(0, 300)}`);
  return (r.stdout || '').trim();
}

/**
 * `projectsRoot/<name>`，并核对拼出来的路径确实在根目录里面、而且是真目录。
 * 名字本身已经过 NAME_RE，这里再查三层：
 *   1. `resolve` 的**字面**结果在根目录下（挡 `..`、`D:` 之类的意外）；
 *   2. 目标已存在时 `lstat` 不是符号链接 / junction（030.2：链接能把 `git init` 带到根目录外面）；
 *   3. 目标的**真实**路径还在根目录的真实路径里面（根目录自己是链接时也认）。
 */
export function projectPath(projectsRoot, name) {
  const root = resolve(String(projectsRoot ?? ''));
  if (!String(projectsRoot ?? '').trim()) throw new Error('执行器没有配置项目根目录（projectsRoot）');
  const dir = resolve(root, name);
  if (dir === root || !dir.startsWith(root + sep)) throw new Error('这个项目名会跑到项目根目录外面，不能建');

  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error(`「${name}」在项目根目录里是一个链接，不是普通文件夹，没有动它`);
  }
  // 根目录自己可能还不存在（第一次建项目）：那就以它的字面路径为准。
  const realRoot = realOf(root);
  const realDir = existsSync(dir) ? realOf(dir) : join(realRoot, name);
  if (!insideOf(realRoot, realDir)) throw new Error('这个项目名会跑到项目根目录外面，不能建');
  return dir;
}

/** 真实路径；解析不出来（目录还不存在、权限不够）就退回字面路径。 */
function realOf(p) {
  try { return realpathSync.native(p); } catch { return p; }
}

/** Windows 下路径不分大小写。 */
function insideOf(root, target) {
  const low = process.platform === 'win32';
  const a = low ? root.toLowerCase() : root;
  const b = low ? target.toLowerCase() : target;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * 「这个已经登记过的目录能不能动」：链接一律不动；在 `projectsRoot` 下面的还要真在根目录里。
 * 030.2：克隆、关联远端都走这里。
 */
export function projectDirProblem(projectsRoot, dir) {
  const real = String(dir ?? '').trim();
  if (!real) return '这个项目没有登记目录';
  if (existsSync(real) && lstatSync(real).isSymbolicLink()) {
    return `${real} 是一个链接，不是普通文件夹，没有动它`;
  }
  const root = String(projectsRoot ?? '').trim();
  if (!root) return null;
  const literalRoot = resolve(root);
  const literal = resolve(real);
  // 只对「登记在根目录下」的项目比真实路径；用户自己配到别处的项目照旧能用。
  if (!insideOf(literalRoot, literal)) return null;
  if (!insideOf(realOf(literalRoot), realOf(literal))) {
    return `${real} 的真实位置在项目根目录外面，没有动它`;
  }
  return null;
}

const NO_IDENTITY = /user\.name|user\.email|tell me who you are|empty ident|unable to auto-detect email/i;

/** 新建一个空项目：文件夹 + `git init -b main` + .gitignore + CLAUDE.md + 第一次提交。 */
export function createProject(cfg, name, note, run = git) {
  const why = projectNameProblem(name);
  if (why) return { ok: false, message: why };
  let dir;
  try {
    dir = projectPath(cfg.projectsRoot, name);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  if (existsSync(dir)) {
    const foreign = readdirSync(dir).filter((e) => !OWN_FILES.has(e));
    if (foreign.length) {
      // 绝不覆盖、绝不合并进别人的目录。
      return { ok: false, message: `文件夹 ${name} 已经存在，而且已经有东西了（${foreign.slice(0, 3).join('、')}），没有动它` };
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  try {
    if (!existsSync(join(dir, '.git'))) run(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.gitignore'), GITIGNORE);
    writeFileSync(join(dir, 'CLAUDE.md'), claudeMd(name, note));
    run(dir, 'add', '-A');
    // 上一次可能已经提交过了（只是回报没送到）：有东西才提交，没有就当完成。
    if (run(dir, 'status', '--porcelain')) run(dir, 'commit', '-q', '-m', '初始化');
  } catch (err) {
    if (NO_IDENTITY.test(err.message)) {
      return {
        ok: false,
        message: 'git 还不知道你是谁：在终端运行 git config --global user.name "你的名字" 和 git config --global user.email "你的邮箱"，再点重试。文件夹已经建好，重试会接着做。',
      };
    }
    return { ok: false, message: err.message.slice(0, 300) };
  }
  return { ok: true, message: '', path: dir };
}

/** 克隆已有仓库。第一版只支持默认分支是 main 的仓库（执行器到处写死 main）。 */
export function cloneProject(cfg, name, url, opts = {}) {
  const nameWhy = projectNameProblem(name);
  if (nameWhy) return { ok: false, message: nameWhy };
  const allowLocal = opts.allowLocal === true;
  const urlWhy = allowLocal ? null : remoteUrlProblem(url);
  if (urlWhy) return { ok: false, message: urlWhy };

  let dir;
  try {
    dir = projectPath(cfg.projectsRoot, name);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  if (existsSync(dir) && readdirSync(dir).length) {
    return { ok: false, message: `文件夹 ${name} 已经存在而且不是空的，没有动它` };
  }

  const r = spawnSync('git', ['clone', '--quiet', String(url), dir], {
    cwd: resolve(cfg.projectsRoot), encoding: 'utf8', timeout: 5 * 60_000, windowsHide: true,
  });
  if (r.status !== 0) {
    return { ok: false, message: `克隆失败：${(r.stderr || r.error?.message || '').slice(0, 240)}` };
  }
  // 030 C.4：默认分支不是 main 就拒绝说清楚——执行器开 worktree、比较、推送都写死 main。
  const heads = git(dir, 'branch', '--format=%(refname:short)').split('\n').map((s) => s.trim());
  if (!heads.includes('main')) {
    return { ok: false, message: `这个仓库的默认分支是 ${heads[0] || '未知'}，不是 main，第一版只支持 main。仓库已经克隆在 ${name} 里，你可以自己改分支名。` };
  }
  return { ok: true, message: '', path: dir };
}

/** 「关联远端」：不建仓库、不碰令牌，只把 origin 指过去。 */
export function addRemote(cfg, name, url, run = git) {
  const why = remoteUrlProblem(url);
  if (why) return { ok: false, message: why };
  const dir = cfg.projects?.[name];
  if (!dir) return { ok: false, message: `执行器的项目列表里没有「${name}」，先把项目建好再关联远端` };
  const dirWhy = projectDirProblem(cfg.projectsRoot, dir);
  if (dirWhy) return { ok: false, message: dirWhy };
  try {
    run(String(dir), 'remote', 'add', 'origin', String(url).trim());
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      try { run(String(dir), 'remote', 'set-url', 'origin', String(url).trim()); } catch (err2) { return { ok: false, message: err2.message.slice(0, 300) }; }
    } else {
      return { ok: false, message: err.message.slice(0, 300) };
    }
  }
  return { ok: true, message: '' };
}

/** 030 D.1：没有远端的项目，推送要跳过而不是失败。 */
export function hasRemote(dir, run = git) {
  try {
    return Boolean(run(dir, 'remote', 'get-url', 'origin'));
  } catch {
    return false;
  }
}
