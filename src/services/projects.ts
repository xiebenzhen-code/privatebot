// 030: 在工作台里新建项目。工作台在 Docker 里，碰不到用户电脑上的文件夹——所以这里只**记一条请求**，
// 真正建目录、跑 git、改执行器配置的是执行器（它在本机）。
//
// 名字和地址的规则放在 scripts/lib/projects.mjs，执行器那边的实现也 import 同一份，
// 不然「网页说行、执行器说不行」这种分歧会一直存在。
import { db } from '../db.ts';
import { nowIso } from '../domain.ts';
import { HttpError, logEvent } from './core.ts';
import { redactAll } from './redact.ts';
import { latestRunnerMeta } from './setup.ts';
import { projectNameProblem as nameRule, remoteUrlProblem as urlRule } from '../../scripts/lib/projects.mjs';

export type ProjectKind = 'create' | 'clone' | 'remote';
export type ProjectRequest = {
  id: number;
  kind: ProjectKind;
  name: string;
  note: string;
  url: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  message: string;
  created_at: string;
  updated_at: string;
};

const KINDS: ProjectKind[] = ['create', 'clone', 'remote'];
/** 同一个名字 60 秒内重复点，不重复排队。 */
const DEDUPE_MS = 60_000;

/** 名字不合格返回人话；合格返回 null。工作台这一侧先挡一次，执行器还会再挡一次。 */
export function projectNameProblem(name: string): string | null {
  const base = nameRule(name);
  if (base) return base;
  const known = latestRunnerMeta().projects ?? [];
  if (known.includes(name)) return '已经有同名项目了（执行器的项目列表里已经有它）';
  return null;
}

export function remoteUrlProblem(url: string): string | null {
  return urlRule(url);
}

function row(id: number): ProjectRequest | undefined {
  return db().prepare('SELECT * FROM project_requests WHERE id = ?').get(id) as ProjectRequest | undefined;
}

export function createRequest(input: Record<string, unknown>, actor = 'me'): ProjectRequest {
  const kind = (KINDS as string[]).includes(String(input.kind ?? 'create'))
    ? String(input.kind ?? 'create') as ProjectKind
    : 'create';
  const name = String(input.name ?? '').trim();
  const note = String(input.note ?? '').trim().slice(0, 200);
  const url = String(input.url ?? '').trim();

  if (kind === 'remote') {
    // 关联远端不新建目录，所以不查重名；但要求这个项目在执行器那边已经存在。
    const known = latestRunnerMeta().projects ?? [];
    if (!known.includes(name)) throw new HttpError(400, `执行器还不知道「${name}」这个项目，先把项目建好再关联远端`);
  } else {
    const why = projectNameProblem(name);
    if (why) throw new HttpError(400, why);
  }
  if (kind !== 'create') {
    const why = remoteUrlProblem(url);
    if (why) throw new HttpError(400, why);
  }

  const since = new Date(Date.now() - DEDUPE_MS).toISOString();
  // 只对「还在排队/正在做」的请求去重：失败之后一分钟内点重试是正常操作，不能当成重复请求吞掉。
  const recent = db().prepare(`SELECT * FROM project_requests
    WHERE name = ? AND kind = ? AND status IN ('pending', 'running') AND created_at > ?
    ORDER BY id DESC LIMIT 1`).get(name, kind, since) as ProjectRequest | undefined;
  if (recent) return recent;

  const now = nowIso();
  const res = db().prepare(`INSERT INTO project_requests (kind, name, note, url, status, message, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', '', ?, ?)`).run(kind, name, note, url, now, now);
  const id = Number(res.lastInsertRowid);
  const verb = kind === 'create' ? '新建项目' : kind === 'clone' ? '克隆项目' : '给项目关联远端';
  // 审计只写项目名：不写路径，也不写地址里的任何东西。
  logEvent({ actor, kind: `project.${kind}`, text: `${verb} ${name}` });
  return row(id)!;
}

/** 执行器来领：一次只给一条，领走就标 running（同一条不会被两个执行器拿去做）。 */
export function nextRequest(): ProjectRequest | null {
  const pending = db().prepare(`SELECT * FROM project_requests WHERE status = 'pending' ORDER BY id LIMIT 1`)
    .get() as ProjectRequest | undefined;
  if (!pending) return null;
  db().prepare(`UPDATE project_requests SET status = 'running', updated_at = ? WHERE id = ?`).run(nowIso(), pending.id);
  return { ...pending, status: 'running' };
}

export function finishRequest(id: number, ok: boolean, message = ''): ProjectRequest {
  const before = row(id);
  if (!before) throw new HttpError(404, '没有这条请求');
  // 失败原因会进页面，先打码（里面有本机路径和 git 的错误输出）。
  const text = redactAll(String(message ?? '')).slice(0, 500);
  db().prepare('UPDATE project_requests SET status = ?, message = ?, updated_at = ? WHERE id = ?')
    .run(ok ? 'done' : 'failed', text, nowIso(), id);
  return row(id)!;
}

export function listRequests(limit = 8): ProjectRequest[] {
  return db().prepare('SELECT * FROM project_requests ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 50)) as ProjectRequest[];
}

/** 页面用：这个名字最近有没有卡住/刚做完的请求。 */
export function latestFor(name: string): ProjectRequest | undefined {
  return db().prepare('SELECT * FROM project_requests WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as ProjectRequest | undefined;
}
