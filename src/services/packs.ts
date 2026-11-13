// 060.1：包 = 一个只有声明的文件夹。这里只做三件事：读、校验、记开关状态。
//
// 硬规矩：工作台进程对包里的任何文件都不 import、不 spawn、不 eval——只用 fs 读字节、JSON.parse 读声明。
// 任何一关不过，这个包整个不生效；别的包和核心照常。校验结果是中文原因，给人看的。
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.ts';
import { nowIso } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 包只从这两个地方来：公开的 packs/，私人的 private/packs/（不进公开版）。 */
export const packRoots = (): string[] => [join(REPO, 'packs'), join(REPO, 'private', 'packs')];

export const LIMITS = { files: 40, bytes: 1024 * 1024, json: 64 * 1024, actions: 8, board: 6, skills: 8, env: 8, prompt: 2000 } as const;
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const SEG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const DOT_OK = new Set(['.gitignore', '.gitkeep']);
const ENV_RE = /^[A-Z][A-Z0-9_]{2,40}$/;
/** 工作台和执行器自己的、以及能改变进程行为的变量——包不许点名要。 */
const ENV_DENY = /^(WB_|GITHUB_|GH_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_BASE|NODE_|NPM_|LD_|DYLD_|GIT_|SSH_|DOCKER_|TAILSCALE_)|^(PATH|PATHEXT|HOME|USER|USERNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SHELL|COMSPEC|SYSTEMROOT|TEMP|TMP|TMPDIR|PWD|IFS|ENV|BASH_ENV|PYTHONPATH|PERL5LIB|RUBYOPT)$/;
/** 控制字符、零宽、双向覆盖、行分隔——这些字人看不见，却能把一句话伪装成另一句。 */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/;
const ROOT_EXT = new Set(['.json', '.md', '.txt']);
const TEMPLATE_EXT = new Set(['.md', '.txt', '.json', '.csv', '.yml', '.yaml', '.gitignore', '.gitkeep']);
const SKILL_EXT = new Set(['.md', '.txt', '.json', '.mjs']);
/**
 * 模板会被拷进新项目。这些文件名 agent 会当成「给我的规矩」自动读，等于绕过你点头时看到的提示词——模板里不许带。
 * 想给 agent 立规矩，写进声明过的插件（skills/<名>/SKILL.md），那是你启用时看得见、哈希锁住的。
 */
const TEMPLATE_DENY = new Set(['claude.md', 'agents.md', 'gemini.md', 'codebuddy.md', 'copilot-instructions.md', 'package.json', 'settings.json', 'mcp.json']);
const BOARD_EXT = new Set(['.md', '.csv', '.png', '.jpg', '.jpeg', '.webp']);

export type PackAction = { label: string; prompt: string; input: 'none' | 'optional' | 'required'; executor: string };
export type Pack = {
  format: 1; name: string; label: string; symbol: string; template: boolean;
  actions: PackAction[]; wording: { merge?: string; push?: string };
  skills: { name: string; env: string[] }[]; card: string; board: string[];
};
export type PackCheck = { ok: boolean; problems: string[]; pack: Pack | null; hash: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const extOf = (file: string): string => (DOT_OK.has(file) ? file : file.includes('.') ? file.slice(file.lastIndexOf('.')).toLowerCase() : '');

type FileEntry = { rel: string; bytes: number };

/** 第 1、2 关：把文件夹走一遍。只用 lstat / readdir，不跟符号链接，不读内容。 */
function walk(dir: string, problems: string[]): FileEntry[] {
  const out: FileEntry[] = [];
  const visit = (abs: string, rel: string): void => {
    if (out.length > LIMITS.files) return;
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { problems.push(`不许有符号链接：${r}`); continue; }
      if (!SEG_RE.test(name) && !DOT_OK.has(name)) { problems.push(`文件名只许字母、数字、下划线、点、短横：${r.slice(0, 80)}`); continue; }
      if (name.startsWith('.') && !DOT_OK.has(name)) { problems.push(`文件名不许以点开头：${r}`); continue; }
      if (name.endsWith('.') || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) { problems.push(`文件名在 Windows 上不能用：${r}`); continue; }
      if (st.isDirectory()) { visit(p, r); continue; }
      if (!st.isFile()) { problems.push(`不是普通文件：${r}`); continue; }
      out.push({ rel: r, bytes: st.size });
      if (out.length > LIMITS.files) { problems.push(`文件太多：最多 ${LIMITS.files} 个`); return; }
    }
  };
  visit(dir, '');
  return out;
}

function checkFileTypes(files: FileEntry[], problems: string[]): void {
  for (const f of files) {
    const parts = f.rel.split('/');
    const ext = extOf(parts.at(-1)!);
    if (parts.length === 1) {
      if (!ROOT_EXT.has(ext)) problems.push(`不许的文件：${f.rel}（包的根目录只许 .json .md .txt）`);
    } else if (parts[0] === 'template') {
      if (!TEMPLATE_EXT.has(ext)) problems.push(`不许的文件：${f.rel}（模板里只许文字类文件）`);
      else if (TEMPLATE_DENY.has(parts.at(-1)!.toLowerCase())) problems.push(`不许的文件：${f.rel}（模板里不许带 agent 会自动读的规矩文件或工程配置）`);
    } else if (parts[0] === 'skills') {
      if (parts.length < 3) problems.push(`不许的文件：${f.rel}（插件文件要放在 skills/<插件名>/ 里）`);
      else if (!SKILL_EXT.has(ext)) problems.push(`不许的文件：${f.rel}（插件里只许 .md .txt .json .mjs）`);
    } else {
      problems.push(`不认识的文件夹：${parts[0]}/（只许 template/ 和 skills/）`);
    }
  }
}

/** 一段给人看的字：是字符串、不超长、没有看不见的字符。plain 的还不许有尖括号。 */
function text(v: unknown, where: string, max: number, problems: string[], opts: { plain?: boolean; min?: number } = {}): string {
  if (typeof v !== 'string') { problems.push(`${where} 要是一段文字`); return ''; }
  if (INVISIBLE.test(v)) problems.push(`${where} 里有看不见的字符（控制字符、零宽或双向覆盖）`);
  if ([...v].length > max) problems.push(`${where} 太长：最多 ${max} 个字`);
  if ([...v.trim()].length < (opts.min ?? 1)) problems.push(`${where} 不能是空的`);
  if (opts.plain && /[<>]/.test(v)) problems.push(`${where} 里不许有尖括号`);
  return v;
}

function strictKeys(obj: Record<string, unknown>, allowed: string[], where: string, problems: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) problems.push(`不认识的键：${where}${String(k).replace(INVISIBLE, '?').slice(0, 40)}`);
  }
}

/** 项目里的相对路径：不许绝对、不许 ..、不许反斜杠和盘符、不许点开头的段（.wb 除外）。 */
function projectPath(v: unknown, where: string, exts: Set<string>, problems: string[]): string {
  if (typeof v !== 'string' || !v || v.length > 200) { problems.push(`${where} 要是项目里的一个相对路径`); return ''; }
  const parts = v.split('/');
  const okSeg = (s: string, i: number) => SEG_RE.test(s) || (i === 0 && s === '.wb');
  if (v.includes('\\') || v.includes(':') || v.startsWith('/') || parts.some((s) => s === '..' || s === '.' || s === '') || !parts.every(okSeg)) {
    problems.push(`${where} 只许项目内的相对路径：${v.replace(INVISIBLE, '?').slice(0, 60)}`);
    return '';
  }
  if (!exts.has(extOf(parts.at(-1)!))) { problems.push(`${where} 的文件类型不许：${v.slice(0, 60)}`); return ''; }
  return v;
}

/** 第 3、4 关：声明本身。返回整理过的声明（只含认识的键）。 */
function checkDeclared(raw: Record<string, unknown>, folder: string, files: FileEntry[], problems: string[]): Pack {
  strictKeys(raw, ['format', 'name', 'label', 'symbol', 'template', 'actions', 'wording', 'skills', 'card', 'board'], '', problems);
  if (raw.format !== 1) problems.push('format 只认 1');

  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!NAME_RE.test(name)) problems.push('名字只许小写字母开头，后面小写字母、数字、短横，2 到 24 个字符');
  else if (name !== folder) problems.push(`文件夹名（${folder.slice(0, 40)}）和包名（${name}）不一致`);

  const label = text(raw.label, 'label', 8, problems, { plain: true });
  const symbol = text(raw.symbol, 'symbol', 2, problems, { plain: true });
  if (typeof raw.symbol === 'string' && /\s/.test(raw.symbol)) problems.push('symbol 里不许有空白');

  let template = false;
  if (raw.template !== undefined) {
    if (raw.template !== 'template') problems.push('template 只许写 "template"（包里的 template/ 文件夹）');
    else if (!files.some((f) => f.rel.startsWith('template/'))) problems.push('声明了 template，但包里没有 template/ 文件夹');
    else template = true;
  }

  const actions: PackAction[] = [];
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) problems.push('actions 要是一个列表');
    else {
      if (raw.actions.length > LIMITS.actions) problems.push(`按钮太多：最多 ${LIMITS.actions} 个`);
      raw.actions.slice(0, LIMITS.actions).forEach((a, i) => {
        const at = `第 ${i + 1} 个按钮的 `;
        if (!isObj(a)) { problems.push(`第 ${i + 1} 个按钮要是一个对象`); return; }
        strictKeys(a, ['label', 'prompt', 'input', 'executor'], `actions[${i}].`, problems);
        const lab = text(a.label, `${at}label`, 12, problems, { plain: true });
        const prompt = text(a.prompt, `${at}prompt`, LIMITS.prompt, problems, { min: 4 });
        const input = a.input === undefined ? 'none' : a.input;
        if (input !== 'none' && input !== 'optional' && input !== 'required') { problems.push(`${at}input 只许 none、optional、required`); return; }
        const executor = a.executor === undefined ? 'any' : a.executor;
        if (typeof executor !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(executor)) { problems.push(`${at}executor 只许 any 或一位执行者的名字`); return; }
        // 提示词是包里唯一会进任务提示词的字。占位符只许 {输入}，由你当场敲的字来填——没有别的口子。
        const holes = prompt.match(/\$?\{+[^{}]*\}+/g) ?? [];
        if (holes.some((h) => h !== '{输入}') || /[{}]/.test(prompt.replaceAll('{输入}', ''))) problems.push(`${at}prompt 里只许 {输入} 这一个占位符`);
        const has = prompt.includes('{输入}');
        if (input === 'none' && has) problems.push(`${at}input 是 none，prompt 里却有 {输入}`);
        if (input !== 'none' && !has) problems.push(`${at}要用户输入，prompt 里却没有 {输入}`);
        actions.push({ label: lab, prompt, input, executor });
      });
    }
  }

  const wording: Pack['wording'] = {};
  if (raw.wording !== undefined) {
    if (!isObj(raw.wording)) problems.push('wording 要是一个对象');
    else {
      strictKeys(raw.wording, ['merge', 'push'], 'wording.', problems);
      for (const k of ['merge', 'push'] as const) {
        if (raw.wording[k] !== undefined) wording[k] = text(raw.wording[k], `wording.${k}`, 40, problems, { plain: true });
      }
    }
  }

  const skills: Pack['skills'] = [];
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) problems.push('skills 要是一个列表');
    else {
      if (raw.skills.length > LIMITS.skills) problems.push(`插件太多：最多 ${LIMITS.skills} 个`);
      raw.skills.slice(0, LIMITS.skills).forEach((s, i) => {
        if (!isObj(s)) { problems.push(`第 ${i + 1} 个插件要是一个对象`); return; }
        strictKeys(s, ['name', 'env'], `skills[${i}].`, problems);
        const sn = typeof s.name === 'string' ? s.name : '';
        if (!NAME_RE.test(sn)) { problems.push(`第 ${i + 1} 个插件名只许小写字母、数字、短横`); return; }
        if (skills.some((x) => x.name === sn)) { problems.push(`插件重复：${sn}`); return; }
        if (!files.some((f) => f.rel === `skills/${sn}/SKILL.md`)) problems.push(`插件 ${sn} 缺 skills/${sn}/SKILL.md`);
        const env: string[] = [];
        const list = s.env === undefined ? [] : s.env;
        if (!Array.isArray(list)) problems.push(`插件 ${sn} 的 env 要是一个列表`);
        else {
          if (list.length > LIMITS.env) problems.push(`插件 ${sn} 要的变量太多：最多 ${LIMITS.env} 个`);
          for (const n of list.slice(0, LIMITS.env)) {
            // 这里只许写变量的名字。长得像密钥的、工作台自己的、能改变进程行为的，一律不许。
            if (typeof n !== 'string' || !ENV_RE.test(n) || ENV_DENY.test(n)) problems.push(`插件 ${sn} 的变量名不许：${String(n).replace(INVISIBLE, '?').slice(0, 12)}…（只写名字，不写值；不许点名工作台和系统自己的变量）`);
            else if (!env.includes(n)) env.push(n);
          }
        }
        skills.push({ name: sn, env });
      });
    }
  }
  const declared = new Set(skills.map((s) => s.name));
  for (const f of files) {
    const parts = f.rel.split('/');
    if (parts[0] === 'skills' && parts.length >= 3 && !declared.has(parts[1])) {
      problems.push(`skills/${parts[1]}/ 在包里，但 pack.json 没有声明它`);
      declared.add(parts[1]);
    }
  }

  const card = raw.card === undefined ? '.wb/card.json' : projectPath(raw.card, 'card', new Set(['.json']), problems);
  const board: string[] = [];
  if (raw.board !== undefined) {
    if (!Array.isArray(raw.board)) problems.push('board 要是一个列表');
    else {
      if (raw.board.length > LIMITS.board) problems.push(`看板太多：最多 ${LIMITS.board} 个文件`);
      raw.board.slice(0, LIMITS.board).forEach((b, i) => {
        const p = projectPath(b, `board 第 ${i + 1} 项`, BOARD_EXT, problems);
        if (p.startsWith('.wb/')) problems.push(`board 第 ${i + 1} 项不许指到 .wb/ 里`);
        else if (p && !board.includes(p)) board.push(p);
      });
    }
  }

  return { format: 1, name, label, symbol, template, actions, wording, skills, card, board };
}

/** 第 5 关：所有文件按路径排序，路径和内容一起算 sha256。改一个字、挪一个文件名都会变。 */
function hashOf(dir: string, files: FileEntry[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const data = readFileSync(join(dir, ...f.rel.split('/')));
    h.update(`${f.rel}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest('hex');
}

/** 校验一个包文件夹。永不抛错：读不了、格式坏，都算一条原因。 */
export function validatePack(dir: string): PackCheck {
  const problems: string[] = [];
  const fail = (why: string): PackCheck => ({ ok: false, problems: [why, ...problems], pack: null, hash: '' });
  try {
    const folder = resolve(dir).split(/[\\/]/).at(-1) ?? '';
    if (!existsSync(dir)) return fail('找不到这个包的文件夹');
    const top = lstatSync(dir);
    if (top.isSymbolicLink()) return fail('包的文件夹本身不许是符号链接');
    if (!top.isDirectory()) return fail('这不是一个文件夹');

    const files = walk(dir, problems);
    const total = files.reduce((n, f) => n + f.bytes, 0);
    if (total > LIMITS.bytes) problems.push(`包太大：最多 ${Math.round(LIMITS.bytes / 1024)} KB`);
    checkFileTypes(files, problems);

    const meta = files.find((f) => f.rel === 'pack.json');
    if (!meta) return fail('找不到 pack.json');
    if (meta.bytes > LIMITS.json) return fail(`pack.json 太大：最多 ${Math.round(LIMITS.json / 1024)} KB`);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8').replace(/^\ufeff/, '')); } catch { return fail('pack.json 不是合法的 JSON'); }
    if (!isObj(raw)) return fail('pack.json 最外层要是一个对象');

    const pack = checkDeclared(raw, folder, files, problems);
    // 文件太多或太大时不去读内容算哈希——那正是要拦的东西。
    const hash = files.length <= LIMITS.files && total <= LIMITS.bytes ? hashOf(dir, files) : '';
    const unique = [...new Set(problems)];
    return unique.length ? { ok: false, problems: unique, pack: null, hash } : { ok: true, problems: [], pack, hash };
  } catch (err) {
    return fail(`读这个包的时候出错：${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

// ---------- 状态 ----------

/**
 * found   文件夹在、校验过、你没点过头——不生效
 * on      你启用过，而且内容和你点头时一模一样——生效
 * off     你关掉了——不生效，状态留着
 * changed 启用之后文件变了——不生效，等你再看一眼
 * invalid 校验不过（或两个目录里重名）——不生效
 * missing 你启用或关过，但文件夹不见了——不生效
 */
export type PackStatus = 'found' | 'on' | 'off' | 'changed' | 'invalid' | 'missing';
export type PackInfo = { name: string; dir: string; status: PackStatus; problems: string[]; pack: Pack | null; hash: string; enabled_at: string | null };
type StateRow = { name: string; status: 'on' | 'off'; hash: string; enabled_at: string | null; updated_at: string };

const states = (): StateRow[] => db().prepare('SELECT * FROM pack_state').all() as StateRow[];

/** 扫两个包目录，一包一行。一个包坏了不连累别的。 */
export function listPacks(roots: string[] = packRoots()): PackInfo[] {
  const found = new Map<string, { dir: string; check: PackCheck }[]>();
  for (const root of roots) {
    let names: string[] = [];
    try { names = existsSync(root) && lstatSync(root).isDirectory() ? readdirSync(root).sort() : []; } catch { names = []; }
    for (const name of names.slice(0, 200)) {
      const dir = join(root, name);
      let isDir = false;
      try { const st = lstatSync(dir); isDir = st.isDirectory() || st.isSymbolicLink(); } catch { isDir = false; }
      if (!isDir) continue;
      const list = found.get(name) ?? [];
      list.push({ dir, check: validatePack(dir) });
      found.set(name, list);
    }
  }
  const saved = new Map(states().map((s) => [s.name, s]));
  const out: PackInfo[] = [];
  for (const [name, list] of found) {
    const s = saved.get(name);
    if (list.length > 1) {
      out.push({ name, dir: list[0].dir, status: 'invalid', problems: [`重名：${list.length} 个目录里都有叫 ${name.slice(0, 40)} 的包，留一个`], pack: null, hash: '', enabled_at: s?.enabled_at ?? null });
      continue;
    }
    const { dir, check } = list[0];
    let status: PackStatus;
    if (!check.ok) status = 'invalid';
    else if (!s) status = 'found';
    else if (s.status === 'off') status = 'off';
    else status = s.hash === check.hash ? 'on' : 'changed';
    out.push({ name, dir, status, problems: check.problems, pack: check.pack, hash: check.hash, enabled_at: s?.enabled_at ?? null });
  }
  for (const s of saved.values()) {
    if (!found.has(s.name)) out.push({ name: s.name, dir: '', status: 'missing', problems: ['包的文件夹不见了'], pack: null, hash: '', enabled_at: s.enabled_at });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 现在真正生效的包：你启用过、校验过、内容和你点头时一样。别的地方只该用这个。 */
export function activePacks(roots: string[] = packRoots()): Pack[] {
  return listPacks(roots).filter((p) => p.status === 'on' && p.pack).map((p) => p.pack!);
}

/**
 * 启用是一次点头：只能是你本人，而且要带上你看到的那个哈希——
 * 你看的是 A，点下去时文件已经被换成 B，这次点头不算。
 */
export function enablePack(name: string, seenHash: string, actor: string, roots: string[] = packRoots()): PackInfo {
  if (actor !== 'me') throw new HttpError(400, '启用包只能由你本人在网页上点');
  const info = listPacks(roots).find((p) => p.name === name);
  if (!info || info.status === 'missing') throw new HttpError(400, '找不到这个包');
  if (info.status === 'invalid' || !info.pack) throw new HttpError(400, `这个包没过校验：${info.problems[0] ?? ''}`);
  if (!/^[0-9a-f]{64}$/.test(String(seenHash)) || seenHash !== info.hash) throw new HttpError(400, '包的内容和你刚才看到的不一样（文件变了），重新看一眼再启用');
  const now = nowIso();
  db().prepare(`INSERT INTO pack_state (name, status, hash, enabled_at, updated_at) VALUES (?, 'on', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET status = 'on', hash = excluded.hash, enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`)
    .run(name, info.hash, now, now);
  logEvent({ actor, kind: 'pack.on', text: `启用了包「${info.pack.label}」（${name}，${info.hash.slice(0, 12)}）` });
  return { ...info, status: 'on', enabled_at: now };
}

/** 关掉：只改状态。包的数据在项目文件夹里，这里什么都不删。 */
export function disablePack(name: string, actor: string): void {
  if (actor !== 'me') throw new HttpError(400, '关闭包只能由你本人在网页上点');
  if (!NAME_RE.test(name)) throw new HttpError(400, '找不到这个包');
  const now = nowIso();
  const r = db().prepare("UPDATE pack_state SET status = 'off', updated_at = ? WHERE name = ?").run(now, name);
  if (!r.changes) db().prepare("INSERT INTO pack_state (name, status, hash, enabled_at, updated_at) VALUES (?, 'off', '', NULL, ?)").run(name, now);
  logEvent({ actor, kind: 'pack.off', text: `关闭了包 ${name}` });
}
