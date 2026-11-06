// 静态检查 Bash 命令和参数，不执行 shell，也不展开变量。
type Word = { value: string; dynamic: boolean };

const basename = (word: string) => word.split(/[\\/]/).pop()!.toLowerCase();
const program = (word: string) => basename(word).replace(/\.(?:exe|cmd|bat)$/, '');
const claudeWord = /^(?:claude|claude\.exe|claude\.cmd)$/;
const containsClaude = (word: Word) => /\bclaude\b/i.test(word.value);
// 这些 Git 子命令是内建的，别名不能覆盖。未知子命令可能是别名或外部扩展。
const gitBuiltins = new Set(('add am apply bisect blame branch cat-file check-attr check-ignore cherry-pick clean clone commit '
  + 'describe diff diff-tree fetch for-each-ref grep init log ls-files ls-remote ls-tree merge merge-base mv notes pull push '
  + 'rebase reflog remote reset restore rev-list rev-parse rm show show-ref stash status switch tag update-index worktree').split(' '));

function gitMayRunString(args: Word[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const { value, dynamic } = args[i];
    if (dynamic) return true;
    if (/^-c|^--config-env(?:=|$)/.test(value)) return true;
    if (/^(?:-C|--git-dir|--work-tree|--namespace)$/.test(value)) { i++; continue; }
    if (/^-C.+|^--(?:git-dir|work-tree|namespace)=/.test(value)) continue;
    if (value === '--version' || value === '--help') return false;
    if (!value.startsWith('-')) return !gitBuiltins.has(value); // config 和别名都交人工。
  }
  return false;
}

function mayRunString(name: string, args: Word[]): boolean {
  const flag = (re: RegExp) => args.some((arg) => re.test(arg.value));
  if (/^(?:trap|watch|alias|awk|gawk|mawk)$/.test(name)) return true;
  if (name === 'git') return gitMayRunString(args);
  if (/^(?:node|deno|bun)$/.test(name)) {
    return (name !== 'node' && /^(?:eval|repl)$/.test(args[0]?.value ?? ''))
      || flag(/^(?:--(?:eval|print)(?:=|$)|-[ep]|-[a-z]*[ep]$)/);
  }
  if (/^(?:python[\d.]*|pypy[\d.]*)$/.test(name)) return flag(/^-[bBdEiIOPqRsSuvVx]*c/);
  if (/^(?:perl|ruby)$/.test(name)) return flag(/^-[a-zA-Z]*[eE]/);
  if (name === 'php') return flag(/^-[rR]/);
  if (/^(?:su|script)$/.test(name)) return flag(/^(?:--command(?:=|$)|-[a-z]*c)/);
  return false;
}

export function inspectShell(text: string) {
  const commands: string[] = [];
  let claude = false;
  let uncertain = false;

  function inspect(words: Word[], depth: number) {
    if (!words.length) return;
    commands.push(words.map((w) => w.value).join(' '));
    let i = 0;
    while (i < words.length) {
      const w = words[i++];
      if (/^[a-z_][a-z_0-9]*=/i.test(w.value) || /^(?:if|then|elif|else|while|until|do|!|\{)$/.test(w.value)) continue;
      const args = words.slice(i);
      // 完整参数词可被任意外层程序用作可执行文件；普通多词文本不算。
      if (args.some((arg) => claudeWord.test(basename(arg.value))
        || /^@anthropic-ai\/claude-code$/i.test(arg.value))) claude = true;
      if (w.dynamic) { uncertain = true; return; }
      const name = program(w.value);
      if (args.some(containsClaude) && mayRunString(name, args)) uncertain = true;
      if (name === 'claude') { claude = true; return; }
      if (/^(?:eval|source|\.|case|for|select|function|cmd|powershell|pwsh|xargs|busybox)$/.test(name)) {
        uncertain = true;
        return;
      }
      if (/^(?:bash|sh|dash|zsh|ksh|ash|fish)$/.test(name)) {
        for (; i < words.length; i++) {
          const flag = words[i];
          if (flag.dynamic || !flag.value.startsWith('-')) break;
          if (/^-[a-z]*c[a-z]*$/i.test(flag.value)) {
            const script = words[i + 1];
            if (!script || script.dynamic) uncertain = true;
            else scan(script.value, depth + 1);
            return;
          }
          if (!/^(?:--(?:noprofile|norc|posix)|-[eluxiv]+)$/.test(flag.value)) break;
        }
        uncertain = true; // 脚本文件、stdin 或无法判定的参数。
        return;
      }
      if (/^(?:npm|pnpm|yarn|bun)$/.test(name) && /^(?:exec|x|dlx)$/.test(words[i]?.value ?? '')) {
        i++;
        if (words[i]?.value === '--') i++;
        else if (words[i]?.value.startsWith('-')) { uncertain = true; return; }
        continue;
      }
      if (name === 'timeout') {
        if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words[i]?.value ?? '')) { uncertain = true; return; }
        i++;
        continue;
      }
      if (/^(?:env|command|exec|sudo|time|nice|nohup|npx)$/.test(name)) {
        for (; i < words.length && words[i].value.startsWith('-'); i++) {
          const flag = words[i].value;
          if (words[i].dynamic) { uncertain = true; return; }
          if (flag === '--') { i++; break; }
          if (name === 'command' && /^-[vV]$/.test(flag)) return; // 只查命令位置
          if (name === 'env' && /^(?:-u|-C|--unset|--chdir)$/.test(flag)) { i++; continue; }
          if (/^(?:-i|--ignore-environment|--unset=.+|--chdir=.+)$/.test(flag) && name === 'env') continue;
          if (/^(?:-y|--yes)$/.test(flag) && name === 'npx') continue;
          uncertain = true; return;
        }
        continue;
      }
      return;
    }
  }

  function scan(script: string, depth: number, start = 0, group = false): number {
    if (depth > 16) { uncertain = true; return script.length; }
    let words: Word[] = [];
    let value = '', quote = '', dynamic = false, started = false, redirect = false;
    const word = () => {
      if (started) {
        if (redirect) commands.push(value);
        else words.push({ value, dynamic });
        redirect = false;
      }
      value = ''; started = false; dynamic = false;
    };
    const end = () => { word(); if (redirect) uncertain = true; inspect(words, depth); words = []; };
    for (let i = start; i < script.length; i++) {
      const c = script[i], next = script[i + 1];
      if (quote === "'") {
        if (c === "'") quote = '';
        else value += c;
        continue;
      }
      if (c === '\\' && (!quote || /[\x60$"\\\n]/.test(next ?? ''))) {
        if (next === undefined) uncertain = true;
        else if (next !== '\n') { started = true; value += next; }
        i++; continue;
      }
      if (c === '"' || (c === "'" && !quote)) {
        quote = quote ? '' : c; started = true; continue;
      }
      if ((c === '$' || (!quote && (c === '<' || c === '>'))) && next === '(') {
        i = scan(script, depth + 1, i + 2, true);
        dynamic = started = true; value += '$()'; continue;
      }
      if (c === '\x60') {
        let close = i + 1;
        for (; close < script.length && script[close] !== '\x60'; close++) if (script[close] === '\\') close++;
        if (close >= script.length) uncertain = true;
        else scan(script.slice(i + 1, close).replace(/\\([\x60$\\])/g, '$1'), depth + 1);
        i = close;
        dynamic = started = true; value += '``'; continue;
      }
      if (!quote && c === '#' && !started) {
        while (i + 1 < script.length && script[i + 1] !== '\n') i++;
        continue;
      }
      if (!quote && (c === '<' || c === '>')) {
        if (c === '<' && next === '<') { uncertain = true; return script.length; }
        if (started && /^\d+$/.test(value)) { started = false; value = ''; }
        word(); redirect = true;
        if (next === c || next === '&' || next === '|') i++;
        continue;
      }
      if (!quote && /[;|&\n()]/.test(c)) {
        end();
        if (c === ')' && group) return i;
        if (c === '(') i = scan(script, depth + 1, i + 1, true);
        continue;
      }
      if (!quote && /\s/.test(c)) { word(); continue; }
      if (c === '$' || (!quote && /[*?\[~{]/.test(c))) dynamic = true;
      if (c === '$' && /['"{]/.test(next ?? '') && (!quote || next === '{')) uncertain = true;
      started = true; value += c;
    }
    if (quote || group) uncertain = true;
    end();
    return script.length;
  }

  if (text.length > 50_000) uncertain = true;
  else scan(text, 0);
  return { claude, uncertain, commands };
}
