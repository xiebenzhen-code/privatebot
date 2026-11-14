// 068.1：只GET身份与目录，不发生成请求，不读取/修改Magpie文件。
import { MAX_CATALOG_BYTES, normalizePolicy, parseModelDirectory, permittedModels, normalizeCatalog } from './model-catalog-core.mjs';

const failed = code => ({ status: 'unavailable', code, models: [] });
export function magpieUrl(value = 'http://127.0.0.1:3425') {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('invalid_config');
  return url.origin;
}
export async function discoverMagpie(config, { fetchImpl = fetch, env = process.env, timeoutMs = 5_000 } = {}) {
  if (config === undefined || config?.enabled === false) return { status: 'disabled', code: 'disabled', models: [] };
  let base, policy, secret = '';
  try {
    if (!config || config.enabled !== true) throw Error('invalid_config');
    base = magpieUrl(config.baseUrl);
    policy = normalizePolicy(config);
    if (config.keyEnv !== undefined) {
      if (typeof config.keyEnv !== 'string' || !/^MAGPIE_[A-Z0-9_]{1,56}$/.test(config.keyEnv)) throw Error('invalid_config');
      secret = String(env[config.keyEnv] ?? '').trim();
      if (!secret) return failed('missing_key');
      if (/[\r\n]/.test(secret) || secret.length > 8192) throw Error('invalid_config');
    }
  } catch { return failed('invalid_config'); }
  const controller = new AbortController();
  const ms = Math.max(50, Math.min(15_000, Number(timeoutMs) || 5_000));
  const timer = setTimeout(() => controller.abort(), ms);
  const abort = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }));
  const wait = value => Promise.race([value, abort]);
  const get = async (path, auth = false) => {
    const res = await wait(fetchImpl(base + path, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { Accept: 'application/json', ...(auth ? { Authorization: 'Bearer ' + (secret || 'magpie-privatebot') } : {}) } }));
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw Error([401, 403].includes(res.status) ? 'unauthorized' : res.status === 429 ? 'rate_limited' : 'http_error');
    }
    if (Number(res.headers.get('content-length')) > MAX_CATALOG_BYTES) {
      await res.body?.cancel().catch(() => {}); throw Error('too_large');
    }
    if (!res.body) throw Error('invalid_catalog');
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_CATALOG_BYTES) throw Error('too_large');
        chunks.push(part.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('invalid_catalog'); }
  };
  try {
    const hello = await get('/api/hello');
    if (hello?.name !== 'magpie') return failed('identity');
    let models = parseModelDirectory(await get('/v1/models', true));
    // 即使上游意外回显网关key，也不把它作为目录文字发送到工作台。
    if (secret) models = models.filter(m => !JSON.stringify(m).includes(secret));
    return normalizeCatalog({ status: 'ok', code: 'ok', models: permittedModels(models, policy) });
  } catch (error) {
    const code = controller.signal.aborted ? 'timeout' : error?.message;
    return failed(['timeout', 'identity', 'unauthorized', 'rate_limited', 'http_error', 'invalid_catalog', 'too_large'].includes(code) ? code : 'unreachable');
  } finally { clearTimeout(timer); }
}

/** 同一执行器的刷新合并为一次；没有配置时零探测、零上报，旧路径保持原样。 */
export function createCatalogReporter(cfg, runnerId, call, { discover = discoverMagpie } = {}) {
  let active = null;
  return () => {
    if (cfg.magpie === undefined) return Promise.resolve(false);
    if (active) return active;
    active = (async () => {
      const catalog = normalizeCatalog(await discover(cfg.magpie));
      await call('POST', '/api/runner/models', { runner: runnerId, catalog });
      return true;
    })().finally(() => { active = null; });
    return active;
  };
}
