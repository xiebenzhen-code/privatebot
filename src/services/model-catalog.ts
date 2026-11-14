// 068.1：工作台只保存执行器上报的数据，不访问Magpie，不接收网关凭据。
import { db } from '../db.ts';
import { HttpError } from './core.ts';
import { RUNNER_FRESH_MS } from './runner.ts';
import { CATALOG_REASONS, CATALOG_TTL_MS, NAME_RE, normalizeCatalog } from '../../scripts/lib/model-catalog-core.mjs';

export function receiveModelCatalog(runner: unknown, input: unknown): { ok: true } {
  if (typeof runner !== 'string' || !runner || runner.length > 80 || runner.trim() !== runner || /[\u0000-\u001f\u007f]/.test(runner)) throw new HttpError(400, '执行器编号不合法');
  const row = db().prepare('SELECT last_seen FROM runners WHERE id = ?').get(runner) as { last_seen: string } | undefined;
  if (!row) throw new HttpError(404, '先上报执行器心跳');
  const age = Date.now() - Date.parse(row.last_seen);
  if (!Number.isFinite(age) || age < 0 || age >= RUNNER_FRESH_MS) throw new HttpError(409, '执行器心跳已过期');
  let catalog;
  try { catalog = normalizeCatalog(input); } catch { throw new HttpError(400, '模型目录格式不合法或超过大小上限'); }
  // TTL只认服务端收件时间，不信客户端自带的checked_at/expiry。
  db().prepare('UPDATE runners SET model_catalog = ? WHERE id = ?')
    .run(JSON.stringify({ ...catalog, received_at: new Date().toISOString() }), runner);
  return { ok: true };
}

export function modelCatalogs(input: { executor: string; project: string; now?: number }) {
  if (!NAME_RE.test(input.executor) || !NAME_RE.test(input.project)) throw new HttpError(400, '请指定执行者和项目');
  const now = input.now ?? Date.now();
  const rows = db().prepare("SELECT id, last_seen, meta, model_catalog FROM runners WHERE model_catalog <> '' ORDER BY id")
    .all() as { id: string; last_seen: string; meta: string; model_catalog: string }[];
  return rows.flatMap(row => {
    let stored, catalog, offered: unknown;
    try {
      stored = JSON.parse(row.model_catalog);
      catalog = normalizeCatalog(stored);
      offered = JSON.parse(row.meta || '{}')?.executors;
    } catch { return []; }
    const heartbeatAge = now - Date.parse(row.last_seen);
    const catalogAge = now - Date.parse(stored.received_at);
    let code = catalog.code;
    if (!Number.isFinite(heartbeatAge) || heartbeatAge < 0 || heartbeatAge >= RUNNER_FRESH_MS) code = 'offline';
    else if (!Number.isFinite(catalogAge) || catalogAge < 0 || catalogAge >= CATALOG_TTL_MS) code = 'expired';
    else if (!Array.isArray(offered) || !offered.includes(input.executor)) return [];
    const models = code === 'ok'
      ? catalog.models.filter(m => m.executors.includes(input.executor) && m.projects.includes(input.project))
        .map(({ executors: _executors, projects: _projects, ...model }) => model)
      : [];
    return [{ runner: row.id, status: code === 'ok' ? 'ok' : catalog.status === 'disabled' && code === 'disabled' ? 'disabled' : 'unavailable',
      code, reason: CATALOG_REASONS[code], received_at: stored.received_at, models }];
  });
}
