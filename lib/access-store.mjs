const ACCESS_KEY = 'sewang:auth:access:v1';
const PENDING_KEY = 'sewang:auth:pending:v1';

function connection(options = {}) {
  const env = options.env || process.env;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch { return null; }
  return url && token ? { url, token, fetcher: options.fetcher || fetch } : null;
}

export function privateAccessConfigured(options = {}) {
  return !!connection(options);
}

async function command(args, options = {}) {
  const conn = connection(options);
  if (!conn) throw new Error('auth_storage_unavailable');
  let response;
  try {
    response = await conn.fetcher(conn.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch { throw new Error('auth_storage_unavailable'); }
  if (!response.ok) throw new Error('auth_storage_unavailable');
  const body = await response.json();
  if (!body || body.error) throw new Error('auth_storage_unavailable');
  return body.result;
}

async function read(key, options) {
  const result = await command(['GET', key], options);
  if (result == null) return null;
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    return data && typeof data === 'object' ? data : null;
  } catch { throw new Error('invalid_access_configuration'); }
}

async function write(key, value, options) {
  const result = await command(['SET', key, JSON.stringify(value)], options);
  if (String(result).toUpperCase() !== 'OK') throw new Error('auth_storage_unavailable');
  return value;
}

export const readPrivateAccess = options => read(ACCESS_KEY, options);
export const writePrivateAccess = (value, options) => write(ACCESS_KEY, value, options);
export const readPrivatePending = options => read(PENDING_KEY, options);
export const writePrivatePending = (value, options) => write(PENDING_KEY, value, options);

export async function privateAccessHealth(options = {}) {
  if (!privateAccessConfigured(options)) return { configured: false, connected: false };
  try {
    return { configured: true, connected: String(await command(['PING'], options)).toUpperCase() === 'PONG' };
  } catch { return { configured: true, connected: false }; }
}
