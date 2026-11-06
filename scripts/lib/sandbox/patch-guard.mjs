// 046 §3：沙箱里出来的补丁，在宿主这一侧当**不可信输入**审。
//
// 纯函数：只吃文本，不起进程、不碰文件系统。自己解析文件头和每个 hunk（按行数数完），
// 不信 `git apply` 的宽容——git 会接受没有 `diff --git` 行的朴素补丁，也会照字面写路径。
// 解析不了的行一律拒绝（宁可误拒，人看一眼），不是「忽略」。
//
// 结果：{ ok, reasons, flags, files, bytes }
//   ok=false  → 任务失败，reasons 是中文人话（路径已脱控制字符）
//   flags     → 放行，但合并审批卡片上多一行 ⚠
import { Buffer } from 'node:buffer';

export const LIMITS = { maxBytes: 20 * 1024 * 1024, maxFiles: 2000, maxPathLen: 240 };

/** 路径、文件名放进提示前先脱控制字符、截短——别让补丁里的转义序列污染日志和页面。 */
export function safeLabel(s, max = 80) {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '·');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ───────────── 路径 ─────────────

/** Git 对特殊字符的路径会加双引号并转义（八进制字节）。还原成字符串；还原不了返回 null。 */
function unquote(raw) {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
  const body = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = body[++i];
    if (n === undefined) return null;
    if (/[0-3]/.test(n)) {
      const oct = body.slice(i, i + 3);
      if (!/^[0-3][0-7]{2}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else if (n === 'n') bytes.push(10);
    else if (n === 't') bytes.push(9);
    else if (n === '"') bytes.push(34);
    else if (n === '\\') bytes.push(92);
    else if (n === 'a') bytes.push(7);
    else if (n === 'b') bytes.push(8);
    else if (n === 'f') bytes.push(12);
    else if (n === 'r') bytes.push(13);
    else if (n === 'v') bytes.push(11);
    else return null;
  }
  return Buffer.from(bytes).toString('utf8');
}

// 零宽、方向控制、软连字符、变体选择符：HFS+ 等文件系统比较名字时会忽略它们，`.g‌it` 就是 `.git`。
const IGNORABLE = /[\u00ad\u034f\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;

/** 一段路径在大小写不敏感、会吞末尾点和空格、有 NTFS 流和 8.3 短名的文件系统上，是不是会变成 `name`。 */
function foldSeg(seg) {
  let s = seg.normalize('NFKC').replace(IGNORABLE, '');
  s = s.split(':')[0];            // NTFS 备用数据流：.git::$INDEX_ALLOCATION
  s = s.replace(/[. ]+$/, '');    // Windows 吞掉末尾的点和空格
  return s.toLowerCase();
}
const isGitDir = (seg) => { const f = foldSeg(seg); return f === '.git' || /^git~\d+$/.test(f); };
const isGitmodules = (seg) => { const f = foldSeg(seg); return f === '.gitmodules' || /^gitmod~\d+$/.test(f); };

/** 返回问题描述；没问题返回 ''。 */
function pathProblem(p) {
  if (!p) return '路径是空的';
  if (/[\u0000-\u001f\u007f]/.test(p)) return '路径里有控制字符';
  if (p.includes('\\')) return '路径里有反斜杠';
  if (p.startsWith('/')) return '路径是绝对路径';
  if (/^[A-Za-z]:/.test(p)) return '路径带盘符';
  if (p.length > LIMITS.maxPathLen) return '路径太长';
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' ) return '路径里有空的一段';
    if (s === '.' || s === '..') return '路径里有 . 或 ..';
    if (isGitDir(s)) return '路径落在 .git 里面';
    if (isGitmodules(s)) return '动了 .gitmodules';
  }
  return '';
}

/** 047 锁定表：沙箱里本来就不该碰的路径（密钥、登录目录、执行器配置）。 */
function lockedProblem(p) {
  const segs = p.split('/').map((s) => foldSeg(s));
  const base = segs[segs.length - 1];
  // .env.example 这类样板文件里没有密钥，仓库里本来就有，放行；其余 .env* 都拒绝。
  if (/^\.env/.test(base) && !/^\.env\.(example|sample|template|dist|defaults)$/.test(base)) return '.env 一类的环境文件';
  if (/\.(pem|key|p12|pfx|ppk)$/.test(base)) return '密钥文件';
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base) || base.endsWith('.pub') && /^id_/.test(base)) return 'SSH 密钥';
  if (/^credentials(\.(json|ya?ml|toml|ini|txt|csv))?$/.test(base) || base === '.credentials.json') return '凭据文件';
  if (base === '.ai-workbench-runner.json' || base === 'wb-runner.json') return '执行器配置';
  if (segs.includes('.ssh') || segs.includes('.aws') || segs.includes('.gnupg')) return '登录 / 密钥目录';
  if (base === '.npmrc' || base === '.netrc' || base === '.pypirc') return '带令牌的配置';
  return '';
}

/** 放行但要人看一眼的路径。 */
function flagFor(p, hasExec) {
  const segs = p.split('/').map((s) => foldSeg(s));
  const base = segs[segs.length - 1];
  if (base === 'package.json') return ['package-json', '改了 package.json（看是不是动了 scripts / 依赖）'];
  if (base === 'package-lock.json') return ['lockfile', '改了 package-lock.json'];
  if (base === '.gitattributes') return ['gitattributes', '改了 .gitattributes'];
  if (segs[0] === '.github') return ['github', '改了 .github/ 下的东西（工作流）'];
  if (segs[0] === '.husky' || segs[0] === '.githooks') return ['hooks', '改了 Git 钩子目录'];
  if (/^dockerfile/.test(base) || /^docker-compose/.test(base)) return ['docker', '改了 Docker 相关文件'];
  if (hasExec) return ['new-exec', '新建了可执行文件'];
  return null;
}

// ───────────── 解析 ─────────────

const MODE_OK = new Set(['100644', '100755']);
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const B85_LINE = /^[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]*$/;

function stripTab(s) { return s.replace(/\t.*$/, ''); }     // `--- a/foo bar\t` 路径含空格时 git 在后面补一个制表符

/**
 * @param {string} text
 * @param {{maxBytes?:number,maxFiles?:number}} [opts]
 */
export function inspectPatch(text, opts = {}) {
  const maxBytes = opts.maxBytes ?? LIMITS.maxBytes;
  const maxFiles = opts.maxFiles ?? LIMITS.maxFiles;
  const reasons = [];
  const flags = [];
  const files = [];
  const bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  const bad = (msg) => { reasons.push(msg); };
  const result = () => ({ ok: reasons.length === 0, reasons, flags, files, bytes });

  if (typeof text !== 'string') { bad('补丁不是文本'); return result(); }
  if (bytes > maxBytes) { bad(`补丁太大（${(bytes / 1048576).toFixed(1)} MB，上限 ${(maxBytes / 1048576).toFixed(0)} MB）`); return result(); }
  if (text.includes('\0')) { bad('补丁里有空字符'); return result(); }
  if (text.trim() === '') { bad('补丁是空的'); return result(); }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let i = 0;
  if (!lines[0].startsWith('diff --git ')) { bad('补丁不是以 diff --git 开头的（只收 git diff 的输出）'); return result(); }

  // 每个文件块：收集「旧侧」「新侧」两组路径声明，最后要求同侧一致。
  while (i < lines.length) {
    const head = lines[i];
    if (!head.startsWith('diff --git ')) { bad(`第 ${i + 1} 行：认不出的内容（${safeLabel(head, 40)}）`); return result(); }
    if (files.length >= maxFiles) { bad(`文件数超过上限 ${maxFiles}`); return result(); }
    const rest = head.slice('diff --git '.length);
    const f = { oldClaims: [], newClaims: [], mode: '', oldMode: '', newMode: '', deleted: false, added: false, renamed: false, copied: false, binary: false };
    i++;

    // —— 扩展头 ——
    let sawMinus = false;
    let sawPlus = false;
    for (; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if (l.startsWith('diff --git ') || l.startsWith('@@') || l === 'GIT binary patch') break;
      if ((m = /^old mode (\d+)$/.exec(l))) { f.oldMode = m[1]; continue; }
      if ((m = /^new mode (\d+)$/.exec(l))) { f.newMode = m[1]; f.mode = m[1]; continue; }
      if ((m = /^deleted file mode (\d+)$/.exec(l))) { f.deleted = true; f.oldMode = m[1]; continue; }
      if ((m = /^new file mode (\d+)$/.exec(l))) { f.added = true; f.newMode = m[1]; f.mode = m[1]; continue; }
      if ((m = /^(copy|rename) from (.+)$/.exec(l))) { f.oldClaims.push(['rename/copy from', unquote(m[2])]); if (m[1] === 'copy') f.copied = true; else f.renamed = true; f.fromLine = unquote(m[2]); continue; }
      if ((m = /^(copy|rename) to (.+)$/.exec(l))) { f.newClaims.push(['rename/copy to', unquote(m[2])]); f.toLine = unquote(m[2]); continue; }
      if (/^(dis)?similarity index \d+%$/.test(l)) continue;
      if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/.exec(l))) { if (m[1]) { f.mode = m[1]; f.indexMode = m[1]; } continue; }
      if (l.startsWith('--- ')) {
        const v = stripTab(l.slice(4));
        if (v !== '/dev/null') { const u = unquote(v); f.oldClaims.push(['---', u === null ? null : u.replace(/^a\//, '')]); if (u !== null && !u.startsWith('a/')) f.oldClaims.push(['--- 前缀', '\u0000']); }
        sawMinus = true; continue;
      }
      if (l.startsWith('+++ ')) {
        const v = stripTab(l.slice(4));
        if (v !== '/dev/null') { const u = unquote(v); f.newClaims.push(['+++', u === null ? null : u.replace(/^b\//, '')]); if (u !== null && !u.startsWith('b/')) f.newClaims.push(['+++ 前缀', '\u0000']); }
        sawPlus = true; continue;
      }
      if (/^Binary files .+ differ$/.test(l)) { f.binary = true; continue; }
      bad(`第 ${i + 1} 行：文件头里有认不出的行（${safeLabel(l, 40)}）`);
      return result();
    }

    // —— 从 diff --git 行里还原路径，并和其余声明对账 ——
    let aPath = null;
    let bPath = null;
    if (f.renamed || f.copied) {
      if (typeof f.fromLine === 'string' && typeof f.toLine === 'string') {
        const want = [`a/${f.fromLine}`, `b/${f.toLine}`];
        const q = (s) => (/[\u0000-\u001f"\\\u007f-￿]/.test(s) ? null : s);
        // 带引号或带空格的路径格式多样，这里只接受「原样拼回去正好等于」这一种。
        if (rest === `${want[0]} ${want[1]}` || (q(want[0]) === null && rest.includes(' b/'))) { aPath = f.fromLine; bPath = f.toLine; }
      }
      if (aPath === null) { bad(`第 ${i} 行附近：重命名 / 复制的路径和 diff --git 行对不上`); return result(); }
    } else {
      // 非重命名：两边应该是同一个路径。
      const q = rest.startsWith('"') ? null : rest;
      if (q && q.startsWith('a/')) {
        const body = q.slice(2);
        const n = (body.length - 3) / 2;
        if (Number.isInteger(n) && n > 0 && body.slice(n, n + 3) === ' b/' && body.slice(0, n) === body.slice(n + 3)) { aPath = body.slice(0, n); bPath = aPath; }
      } else if (rest.startsWith('"')) {
        const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
        if (m) { const a = unquote(m[1]); const b = unquote(m[2]); if (a !== null && b !== null && a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) { aPath = a.slice(2); bPath = b.slice(2); } }
      }
      if (aPath === null) { bad(`第 ${i} 行附近：diff --git 行拆不出一个确定的路径（${safeLabel(rest, 50)}）`); return result(); }
    }

    const oldSide = new Set([aPath, ...f.oldClaims.map((c) => c[1])]);
    const newSide = new Set([bPath, ...f.newClaims.map((c) => c[1])]);
    if (oldSide.size !== 1 || newSide.size !== 1 || oldSide.has(null) || newSide.has(null) || oldSide.has('\u0000') || newSide.has('\u0000')) {
      bad(`路径对不上：diff --git、---、+++、rename 写的不是同一个文件（${safeLabel(aPath, 40)} / ${safeLabel(bPath, 40)}）`);
      return result();
    }

    // —— 路径和模式 ——
    for (const p of new Set([aPath, bPath])) {
      const prob = pathProblem(p);
      if (prob) { bad(`${prob}：${safeLabel(p)}`); return result(); }
      const lock = lockedProblem(p);
      if (lock) { bad(`碰了不该碰的东西（${lock}）：${safeLabel(p)}`); return result(); }
    }
    for (const mode of [f.newMode, f.indexMode].filter(Boolean)) {
      if (mode === '120000') { bad(`符号链接：${safeLabel(bPath)}`); return result(); }
      if (mode === '160000') { bad(`子模块 / gitlink：${safeLabel(bPath)}`); return result(); }
      if (!MODE_OK.has(mode)) { bad(`不认识的文件模式 ${safeLabel(mode, 10)}：${safeLabel(bPath)}`); return result(); }
    }
    if (f.oldMode && !f.deleted && !MODE_OK.has(f.oldMode)) { bad(`不认识的文件模式 ${safeLabel(f.oldMode, 10)}：${safeLabel(aPath)}`); return result(); }
    if (f.deleted && f.oldMode === '160000') { bad(`子模块 / gitlink：${safeLabel(aPath)}`); return result(); }

    const newExec = f.mode === '100755' && (f.added || (f.newMode === '100755' && f.oldMode === '100644'));
    const flag = flagFor(bPath, false) ?? flagFor(aPath, false) ?? (newExec ? flagFor(bPath, true) : null);
    if (flag) flags.push({ code: flag[0], label: flag[1], path: bPath });
    if (newExec && !flag) flags.push({ code: 'new-exec', label: '新建了可执行文件', path: bPath });

    files.push({
      path: bPath, oldPath: aPath,
      status: f.deleted ? 'deleted' : f.added ? 'added' : f.renamed ? 'renamed' : f.copied ? 'copied' : 'modified',
      mode: f.mode || f.oldMode || '',
    });

    // —— 正文：文本 hunk 按行数数完；二进制按块 ——
    if (i < lines.length && lines[i] === 'GIT binary patch') {
      f.binary = true;
      i++;
      let sections = 0;
      while (i < lines.length && /^(literal|delta) \d+$/.test(lines[i])) {
        sections++;
        i++;
        while (i < lines.length && lines[i] !== '') {
          if (!B85_LINE.test(lines[i])) { bad(`第 ${i + 1} 行：二进制补丁里有认不出的行`); return result(); }
          i++;
        }
        if (i < lines.length && lines[i] === '') i++;     // 块与块之间的空行
      }
      if (sections === 0) { bad(`第 ${i + 1} 行：二进制补丁没有内容`); return result(); }
    } else {
      if ((sawMinus || sawPlus) && !(i < lines.length && lines[i].startsWith('@@')) && !f.binary) {
        // 只有 ---/+++ 没有 hunk：git 也不会应用任何东西，不算错。
      }
      while (i < lines.length && lines[i].startsWith('@@')) {
        const hm = HUNK_RE.exec(lines[i]);
        if (!hm) { bad(`第 ${i + 1} 行：认不出的 hunk 头（${safeLabel(lines[i], 40)}）`); return result(); }
        let oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
        let newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
        i++;
        while ((oldLeft > 0 || newLeft > 0) && i < lines.length) {
          const l = lines[i];
          const c = l === '' ? ' ' : l[0];            // 被剪掉行尾空白的空上下文行
          if (c === '\\') { i++; continue; }            // \ No newline at end of file：可以夹在 hunk 中间，不占行数
          if (c === ' ') { oldLeft--; newLeft--; }
          else if (c === '-') oldLeft--;
          else if (c === '+') newLeft--;
          else { bad(`第 ${i + 1} 行：hunk 里有认不出的行（${safeLabel(l, 40)}）`); return result(); }
          if (oldLeft < 0 || newLeft < 0) { bad(`第 ${i + 1} 行：hunk 的行数对不上`); return result(); }
          i++;
        }
        if (oldLeft !== 0 || newLeft !== 0) { bad('补丁在 hunk 中间断了（行数不够）'); return result(); }
        while (i < lines.length && lines[i].startsWith('\\')) i++;   // \ No newline at end of file
      }
    }
    // 块结束后只能是下一个文件头或结尾——别的任何内容都是「藏起来的东西」。
    if (i < lines.length && !lines[i].startsWith('diff --git ')) { bad(`第 ${i + 1} 行：认不出的内容（${safeLabel(lines[i], 40)}）`); return result(); }
  }
  return result();
}
