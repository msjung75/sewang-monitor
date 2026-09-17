import { jwtVerify } from 'jose';
import { privateAccessConfigured, readPrivateAccess } from './access-store.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const APP_ORIGIN = 'https://sewang-monitor.vercel.app';
export const COOKIE_NAME = 'sewang_session';
export const ROLES = ['admin', 'staff', 'sales', 'viewer', 'owner'];
export const SALES_ROLES = ['admin', 'staff', 'sales', 'viewer'];
export const REPO = 'msjung75/sewang-monitor';
export const SESSION_OPTIONS = { algorithms: ['HS256'], issuer: APP_ORIGIN, audience: 'sewang-app' };

export function sessionKey() {
  const value = process.env.JWT_SECRET || '';
  if (Buffer.byteLength(value) < 32 || value === 'dev-secret-change-me-please') throw new Error('auth_configuration_required');
  return new TextEncoder().encode(value);
}
export function cookies(header = '') {
  const out = Object.create(null);
  String(header).split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  });
  return out;
}
export function privateResponse(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
export function sameOrigin(req) {
  const origin = req.headers?.origin;
  // A browser POST carries Origin; do not trust Host or arbitrary preview domains.
  return origin === APP_ORIGIN && req.headers?.['sec-fetch-site'] !== 'cross-site';
}
export function mutationAllowed(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'post_required' }); return false; }
  if (!sameOrigin(req) || !String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) {
    res.status(403).json({ error: 'invalid_request_origin' }); return false;
  }
  return true;
}
export async function repoJson(file, { fetcher = fetch } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('data_service_unavailable');
  const response = await fetcher(`https://api.github.com/repos/${REPO}/contents/${file}?ref=main`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sewang-monitor' },
    cache: 'no-store', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('data_service_unavailable');
  const json = await response.json();
  return JSON.parse(Buffer.from(json.content, 'base64').toString('utf8'));
}
export async function allowlist(options) {
  const legacy = await repoJson('data/allowlist.json', options);
  if (!legacy || (!Array.isArray(legacy) && !Array.isArray(legacy.users))) throw new Error('invalid_access_configuration');
  const base = { users: Array.isArray(legacy) ? legacy : legacy.users, blocked: legacy.blocked || [] };
  if (!privateAccessConfigured(options)) return base;
  const privateState = await readPrivateAccess(options);
  if (!privateState) return base;
  const removed = new Set((privateState.removed || []).map(String));
  const users = new Map(base.users.filter(u => !removed.has(String(u.id))).map(u => [String(u.id), u]));
  for (const user of privateState.users || []) users.set(String(user.id), user);
  const blocked = new Map(base.blocked.map(u => [String(u.id), u]));
  for (const user of privateState.blocked || []) blocked.set(String(user.id), user);
  return { users: [...users.values()], blocked: [...blocked.values()] };
}
export function currentRole(id, list) {
  if (list.blocked.some(u => String(u.id) === String(id))) return 'blocked';
  if (process.env.ADMIN_KAKAO_ID && String(id) === process.env.ADMIN_KAKAO_ID) return 'admin';
  const user = list.users.find(u => String(u.id) === String(id));
  return user && ROLES.includes(user.role) ? user.role : 'pending';
}
export async function readSession(req, options = {}) {
  const token = cookies(req.headers?.cookie)[COOKIE_NAME];
  if (!token) return null;
  let payload;
  try { ({ payload } = await jwtVerify(token, sessionKey(), SESSION_OPTIONS)); } catch { return null; }
  if (!/^\d+$/.test(String(payload.id || ''))) return null;
  // Consult current permissions for every request: approval/removal does not wait for JWT expiry.
  const list = await allowlist(options);
  return { ...payload, r: currentRole(payload.id, list) };
}
export async function requireUser(req, res, roles = ROLES, options) {
  privateResponse(res);
  if (req.headers?.['sec-fetch-site'] === 'cross-site' || (req.headers?.origin && req.headers.origin !== APP_ORIGIN)) {
    res.status(403).json({ error: 'invalid_request_origin' }); return null;
  }
  try {
    const user = await readSession(req, options);
    if (!user) { res.status(401).json({ error: 'login_required' }); return null; }
    if (!roles.includes(user.r)) { res.status(403).json({ error: 'permission_required' }); return null; }
    return user;
  } catch {
    res.status(503).json({ error: 'access_check_unavailable' }); return null;
  }
}
export async function requireReadUser(req, res, roles = ROLES) {
  privateResponse(res);
  if (req.method !== 'GET') { res.status(405).json({ error: 'get_required' }); return null; }
  return requireUser(req, res, roles);
}
export function oauthState() { return randomBytes(32).toString('hex'); }
export function validState(query, cookie) {
  return typeof query === 'string' && typeof cookie === 'string' && /^[a-f0-9]{64}$/.test(query) && /^[a-f0-9]{64}$/.test(cookie)
    && timingSafeEqual(Buffer.from(query), Buffer.from(cookie));
}
export function stateCookie(value, maxAge = 600) {
  return `sewang_oauth_state=${value}; Path=/api/auth/kakao; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// Never expose arbitrary repository paths or Push subscription credentials.
const ADMIN_FILES = new Set(['allowlist.json', 'pending_users.json', 'usage_log.json']);
const SALES_FILES = new Set(['customers_hash.json', 'recommend_metro.json', 'brand_overrides.json']);
const APP_FILES = new Set(['franchise_leads.json', 'naver_nstat_cache.json', 'wholesalers.json', 'closures_recent.json',
  'franchise_master.json', 'sumtrend_buzz.json', 'franchise_brands.json', 'trend30_all.json', 'importer.json',
  'sns_buzz.json', 'brand_beer.json', 'franchise_raw.json']);
export function fileRoles(file) {
  if (typeof file !== 'string') return null;
  if (ADMIN_FILES.has(file)) return ['admin'];
  if (SALES_FILES.has(file)) return SALES_ROLES;
  if (APP_FILES.has(file) || /^(ytd_20\d{2}_summary|upbyeon_20\d{2})\.json$/.test(file) || /^ytd_20\d{2}\/20\d{2}(0[1-9]|1[0-2])\.json$/.test(file)) return ROLES;
  return null;
}
export async function assertPrivateRepository(repo = REPO, token = process.env.GITHUB_TOKEN, fetcher = fetch) {
  if (repo !== REPO || !token) throw new Error('private_repository_required');
  const response = await fetcher(`https://api.github.com/repos/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sewang-monitor' },
    cache: 'no-store', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok || (await response.json()).private !== true) throw new Error('private_repository_required');
}
export function validPushEndpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(u.hostname);
  } catch { return false; }
}
