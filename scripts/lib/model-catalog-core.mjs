// 068.1：只有数据校验，不联网，不读配置或环境变量。服务端与执行器共用。
export const MAX_MODELS = 256;
export const MAX_CATALOG_BYTES = 128 * 1024;
export const CATALOG_TTL_MS = 5 * 60_000;
export const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,159}$/;
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
export const CATALOG_REASONS = Object.freeze({
  ok: '', disabled: '未启用模型目录', invalid_config: '模型目录配置不合法',
  missing_key: '没有找到配置的网关凭据', unreachable: '暂时连不上模型网关',
  timeout: '读取模型目录超时', identity: '这个地址没有确认是Magpie',
  unauthorized: '模型网关拒绝了访问', rate_limited: '模型网关暂时限流',
  http_error: '模型网关返回错误', invalid_catalog: '模型目录格式不合法',
  too_large: '模型目录超过大小上限', expired: '模型目录已过期', offline: '执行器离线',
});
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x, max) => typeof x === 'string' && x.length <= max && !CONTROL.test(x);
const unique = a => [...new Set(a)];
function names(value, pattern, max) {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !pattern.test(v))) throw Error('invalid_catalog');
  return unique(value);
}
function metadata(row) {
  if (!plain(row) || typeof row.id !== 'string' || !MODEL_RE.test(row.id)) return null;
  const label = row.label ?? row.display_name ?? row.id;
  const provider = row.provider ?? row.owned_by ?? '';
  if (!text(label, 160) || !text(provider, 80)) return null;
  const rawLevels = row.reasoning_levels ?? (Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(x => x?.effort) : []);
  const levels = Array.isArray(rawLevels) && rawLevels.length <= 16
    ? unique(rawLevels.filter(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(v))) : [];
  const out = { id: row.id, label, provider, reasoning_levels: levels };
  if (Number.isSafeInteger(row.context_window) && row.context_window > 0 && row.context_window <= 100_000_000) out.context_window = row.context_window;
  return out;
}

/** 重复id两份都不信；非法条目丢弃，未知字段不带出进程。 */
export function parseModelDirectory(data) {
  if (!plain(data) || !Array.isArray(data.data)) throw Error('invalid_catalog');
  if (data.data.length > MAX_MODELS) throw Error('too_large');
  const counts = new Map();
  for (const row of data.data) if (typeof row?.id === 'string') counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return data.data.map(metadata).filter(row => row && counts.get(row.id) === 1);
}
export function normalizePolicy(config) {
  const convert = (map, max) => {
    if (!plain(map) || Object.keys(map).length > max) throw Error('invalid_config');
    const result = new Map();
    for (const [name, ids] of Object.entries(map)) {
      if (!NAME_RE.test(name)) throw Error('invalid_config');
      try { result.set(name, new Set(names(ids, MODEL_RE, MAX_MODELS))); } catch { throw Error('invalid_config'); }
    }
    return result;
  };
  return { executors: convert(config?.executors, 32), projects: convert(config?.projects, 128) };
}
export function permittedModels(models, policy) {
  const rows = models.map(m => ({ ...m,
    executors: [...policy.executors].filter(([, ids]) => ids.has(m.id)).map(([name]) => name),
    projects: [...policy.projects].filter(([, ids]) => ids.has(m.id)).map(([name]) => name),
  })).filter(m => m.executors.length && m.projects.length);
  if (Buffer.byteLength(JSON.stringify(rows)) > MAX_CATALOG_BYTES) throw Error('too_large');
  return rows;
}

/** 服务端只接收这个形状；不保存地址、凭据、上游错误或任意扩展字段。 */
export function normalizeCatalog(input) {
  if (!plain(input) || !['ok', 'disabled', 'unavailable'].includes(input.status)) throw Error('invalid_catalog');
  const allowedCodes = input.status === 'ok' ? ['ok'] : input.status === 'disabled' ? ['disabled']
    : ['invalid_config', 'missing_key', 'unreachable', 'timeout', 'identity', 'unauthorized', 'rate_limited', 'http_error', 'invalid_catalog', 'too_large'];
  if (!allowedCodes.includes(input.code)) throw Error('invalid_catalog');
  if (!Array.isArray(input.models) || input.models.length > MAX_MODELS) throw Error('invalid_catalog');
  if (input.status !== 'ok') return { status: input.status, code: input.code, models: [] };
  const seen = new Set();
  const models = input.models.map(row => {
    const m = metadata(row);
    if (!m || seen.has(m.id)) throw Error('invalid_catalog');
    seen.add(m.id);
    const executors = names(row.executors, NAME_RE, 32);
    const projects = names(row.projects, NAME_RE, 128);
    if (!executors.length || !projects.length) throw Error('invalid_catalog');
    return { ...m, executors, projects };
  });
  const result = { status: 'ok', code: 'ok', models };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_BYTES) throw Error('too_large');
  return result;
}
