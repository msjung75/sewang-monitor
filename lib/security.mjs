import { jwtVerify } from 'jose';
import { privateAccessConfigured, readPrivateAccess } from './access-store.mjs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { managedSessionValid } from './credential-store.mjs';

export const APP_ORIGIN = 'https://sewang-monitor.vercel.app';
export const COOKIE_NAME = 'sewang_session';
export const ROLES = ['admin', 'staff', 'sales', 'viewer', 'owner'];
export const SALES_ROLES = ['admin', 'staff', 'sales', 'viewer'];
export const REPO = 'msjung75/sewang-monitor';
export const SESSION_OPTIONS = { algorithms: ['HS256'], issuer: APP_ORIGIN, audience: 'sewang-app' };

// 2026-10-30: public 레포 호환. 로그에 쓰기 전 사용자 식별자를 결정론적 해시로 치환.
// LOG_SALT 환경변수가 설정돼 있으면 같은 ID → 같은 해시(통계 유지), 유출 시 역산 불가.
const LOG_SALT_FALLBACK = 'sewang-fallback-salt-2026-10-30';
function logSalt() {
  const s = process.env.LOG_SALT;
  if (!s || s.length < 8) return LOG_SALT_FALLBACK;
  return s;
}
export function anonymizePII(value) {
  if (value == null || value === '') return value;
  const str = String(value);
  if (str === 'unknown') return 'unknown';
  const hash = createHash('sha256').update(logSalt() + ':' + str).digest('hex');
  return 'u_' + hash.slice(0, 16);
}
export function anonymizeIP(ip) {
  if (!ip) return ip;
  const s = String(ip);
  const m4 = s.match(/^(\d+\.\d+\.\d+)\.\d+/);
  if (m4) return m4[1] + '.0/24';
  const m6 = s.match(/^([0-9a-fA-F]+:[0-9a-fA-F]+:[0-9a-fA-F]+)/);
  if (m6) return m6[1] + '::/48';
  return 'anon';
}

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
  if (privateAccessConfigured(options) && !await managedSessionValid(payload, options)) return null;
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
export function stateCookieName(state) {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) return 'sewang_oauth_state';
  return 'sewang_oauth_state_' + state;
}
export function validOAuthState(state, header) {
  const saved = cookies(header);
  return validState(state, saved[stateCookieName(state)]) || validState(state, saved.sewang_oauth_state);
}
export function stateCookie(value, maxAge = 600, state = value) {
  return `${stateCookieName(state)}=${value}; Path=/api/auth/kakao; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

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
  // 2026-10-30: 호출부에서는 더 이상 쓰지 않지만 외부 import 가능성 대비해 유지. public 레포는 PII 익명화로 대응.
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
