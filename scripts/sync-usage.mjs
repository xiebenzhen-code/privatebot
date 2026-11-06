#!/usr/bin/env node
// Report token usage from local Claude Code / Codex session logs to the workbench.
// Only token counts, model, project folder and timestamp leave the machine — never message content.
//
//   node scripts/sync-usage.mjs            # incremental (remembers how far it read each file)
//   node scripts/sync-usage.mjs --full     # re-read everything (server ignores duplicates)
//
// Logs can be hundreds of megabytes, so files are streamed from a byte offset and never
// read into one string. The state file remembers `offset` = bytes consumed up to the last
// complete line, and only advances after a batch has been accepted by the server.
//
// Config: same as claude-hook.mjs (WB_URL / WB_TOKEN env, or ~/.ai-workbench.json).
// Account names: ~/.ai-workbench.json {"accounts": {"claude": "Claude Max · 主号", "codex": "Codex · Plus"}}
// or env WB_ACCOUNT_CLAUDE / WB_ACCOUNT_CODEX. Use the same names as on the 账号与额度 page.
// Requires Node 18+. No dependencies.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';

const HOME = homedir();
const STATE_FILE = join(HOME, '.ai-workbench-usage-state.json');
const MAX_LINE = 10 * 1024 * 1024; // one line this long is written off, not buffered
const BATCH = 2000;
const CHUNK = 256 * 1024;

function config() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(HOME, '.ai-workbench.json'), 'utf8')); } catch { /* optional */ }
  const accounts = file.accounts || {};
  return {
    url: (process.env.WB_URL || file.url || '').replace(/\/+$/, ''),
    token: process.env.WB_TOKEN || file.token || '',
    account: (ex) => process.env[`WB_ACCOUNT_${ex.toUpperCase()}`] || accounts[ex] || `${ex}@${hostname()}`,
  };
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.jsonl')) out.push({ path: p, size: st.size });
  }
  return out;
}

/**
 * Stream a file from `start`, yielding complete lines only.
 * `offset` is the byte position where the line begins, `end` is just past its newline.
 * A line longer than MAX_LINE is yielded as `{ skipped: true, end }` so the caller can still
 * move its bookmark past it — otherwise a file ending with such a line is re-read forever.
 * A trailing line without a newline is still being written: it is never yielded, so the
 * caller's offset stays at the end of the last complete line.
 */
async function* readLines(file, start, stats) {
  let parts = []; // pieces of the line being assembled: joined once, at its newline
  let held = 0; // bytes held in `parts`
  let skipping = false;
  let pos = start; // byte position of the chunk we are about to consume
  let lineStart = start; // byte position where the buffered line begins
  for await (const chunk of createReadStream(file, { start, highWaterMark: CHUNK })) {
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf(0x0a, i);
      if (nl === -1) {
        if (!skipping) {
          const tail = chunk.subarray(i);
          parts.push(tail);
          held += tail.length;
          if (held > MAX_LINE) { skipping = true; parts = []; held = 0; stats.skipped++; }
        }
        break;
      }
      const end = pos + nl + 1;
      if (skipping) {
        // the tail of an over-long line: drop it and resume after the newline
        skipping = false;
        parts = [];
        held = 0;
        yield { skipped: true, end };
      } else {
        const part = chunk.subarray(i, nl);
        parts.push(part);
        held += part.length;
        const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, held);
        parts = [];
        held = 0;
        if (line.length > MAX_LINE) {
          stats.skipped++;
          yield { skipped: true, end };
        } else {
          yield { text: line.toString('utf8'), offset: lineStart, end };
        }
      }
      lineStart = end;
      i = nl + 1;
    }
    pos += chunk.length;
  }
}

/** Claude Code: ~/.claude/projects/<project>/<session>.jsonl, assistant lines carry message.usage. */
function claudeRecord(o, file, offset, cfg) {
  const u = o?.message?.usage;
  if (o?.type !== 'assistant' || !u || !o.timestamp) return null;
  return {
    source_key: `claude:${o.message.id || `${basename(file)}:${offset}`}`,
    ts: o.timestamp,
    executor: 'claude',
    account: cfg.account('claude'),
    model: o.message.model || '',
    project: o.cwd ? basename(o.cwd) : '',
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_tokens: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
  };
}

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, token_count events (best effort; format may change). */
function codexRecord(o, file, offset, cfg, seen) {
  const p = o?.payload;
  if (o?.type === 'session_meta' && p?.cwd) seen.cwd = p.cwd;
  if (o?.type === 'turn_context' && p?.model) seen.model = p.model;
  const u = p?.type === 'token_count' ? p?.info?.last_token_usage : null;
  if (!u || !o.timestamp) return null;
  const cached = u.cached_input_tokens || 0;
  return {
    source_key: `codex:${basename(file)}:${offset}`,
    ts: o.timestamp,
    executor: 'codex',
    account: cfg.account('codex'),
    model: seen.model || '',
    project: seen.cwd ? basename(seen.cwd) : '',
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    output_tokens: u.output_tokens || 0,
    cache_tokens: cached,
  };
}

async function post(cfg, records) {
  const res = await fetch(`${cfg.url}/api/usage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`POST /api/usage → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const cfg = config();
  if (!cfg.url || !cfg.token) {
    console.error('缺少工作台地址或令牌：设置 WB_URL / WB_TOKEN，或写 ~/.ai-workbench.json');
    process.exit(1);
  }
  const full = process.argv.includes('--full');
  let state = {};
  if (!full) { try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ } }
  const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state));

  const sources = [
    { dir: join(HOME, '.claude', 'projects'), kind: 'claude' },
    { dir: join(process.env.CODEX_HOME || join(HOME, '.codex'), 'sessions'), kind: 'codex' },
  ];
  const stats = { skipped: 0 };
  let sent = 0, inserted = 0, files = 0;

  for (const src of sources) {
    for (const f of walk(src.dir)) {
      const prev = state[f.path];
      // A record without `offset` predates streaming: re-read from the start, the server dedupes.
      const known = prev && Number.isInteger(prev.offset) ? prev.offset : 0;
      const start = full || !prev || f.size < known ? 0 : known;
      if (f.size === start) continue;

      // Codex needs the session's cwd/model, which live in the first lines: carry them in the state.
      const seen = { cwd: full ? '' : prev?.cwd || '', model: full ? '' : prev?.model || '' };
      const entry = { size: f.size, offset: start };
      if (src.kind === 'codex') { entry.cwd = seen.cwd; entry.model = seen.model; }

      let batch = [];
      let offset = start;
      for await (const line of readLines(f.path, start, stats)) {
        offset = line.end;
        if (line.skipped) continue; // already counted; the bookmark still moves past it
        let o = null;
        try { o = JSON.parse(line.text); } catch { /* not JSON, skip */ }
        if (o) {
          const rec = src.kind === 'claude'
            ? claudeRecord(o, f.path, line.offset, cfg)
            : codexRecord(o, f.path, line.offset, cfg, seen);
          if (rec) batch.push(rec);
        }
        if (batch.length >= BATCH) {
          const r = await post(cfg, batch);
          sent += r.received; inserted += r.inserted;
          batch = [];
          // Only move the bookmark once the server has the data.
          entry.offset = offset;
          if (src.kind === 'codex') { entry.cwd = seen.cwd; entry.model = seen.model; }
          state[f.path] = { ...entry };
          saveState();
        }
      }
      if (batch.length) {
        const r = await post(cfg, batch);
        sent += r.received; inserted += r.inserted;
      }
      entry.offset = offset;
      if (src.kind === 'codex') { entry.cwd = seen.cwd; entry.model = seen.model; }
      state[f.path] = entry;
      files++;
    }
  }
  saveState();
  const extra = stats.skipped ? `，跳过 ${stats.skipped} 行（单行超过 10MB）` : '';
  console.log(`${new Date().toISOString()} 扫描 ${files} 个有变化的会话文件，上报 ${sent} 条，新增 ${inserted} 条${extra}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
