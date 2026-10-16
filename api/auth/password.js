// v19.1: 아이디·비밀번호 로그인 (카카오 계정에 연결된 보조 로그인)
// - 카카오로 로그인한 사용자가 설정에서 아이디/비밀번호를 만들면, 그 아이디로도 같은 계정(카카오 ID)에 로그인할 수 있다.
// - 자격증명은 비공개 KV(Upstash)에만 저장. 공개 저장소(data/)에는 절대 쓰지 않는다.
// - 세션은 카카오 로그인과 동일한 JWT(id = 카카오 ID) → 권한·승인 상태는 allowlist 기준 그대로 적용.
// actions: status(GET) / set(POST) / remove(POST) / login(POST, 공개)
import { SignJWT } from 'jose';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { sessionKey, privateResponse, requireUser, mutationAllowed,
  allowlist, currentRole, SESSION_OPTIONS, COOKIE_NAME } from '../../lib/security.mjs';

const CRED_KEY = 'sewang:auth:credentials:v1';      // { [username]: { id, n, p, salt, hash, created_at, updated_at } }
const FAIL_PREFIX = 'sewang:auth:pwfail:v1:';        // 아이디별 실패 횟수 (15분 TTL)
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const COOKIE_MAX_AGE = 60 * 60 * 24;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{3,19}$/;   // 4~20자, 영문소문자·숫자·._-
const MIN_PW = 8;

// ---------- KV (access-store.mjs와 동일 연결 규칙) ----------
function kvConn() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) return null; } catch { return null; }
  return url && token ? { url, token } : null;
}
async function kv(args) {
  const c = kvConn();
  if (!c) throw new Error('auth_storage_unavailable');
  let r;
  try {
    r = await fetch(c.url, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), cache: 'no-store', signal: AbortSignal.timeout(5000) });
  } catch { throw new Error('auth_storage_unavailable'); }
  if (!r.ok) throw new Error('auth_storage_unavailable');
  const body = await r.json();
  if (!body || body.error) throw new Error('auth_storage_unavailable');
  return body.result;
}
async function readCreds() {
  const raw = await kv(['GET', CRED_KEY]);
  if (raw == null) return {};
  try { const d = typeof raw === 'string' ? JSON.parse(raw) : raw; return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}
async function writeCreds(obj) {
  const r = await kv(['SET', CRED_KEY, JSON.stringify(obj)]);
  if (String(r).toUpperCase() !== 'OK') throw new Error('auth_storage_unavailable');
}

// ---------- 해시 ----------
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key.toString('base64')));
  });
}
async function verifyPassword(password, salt, hash) {
  const got = Buffer.from(await hashPassword(password, salt), 'base64');
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}
function sessionCookie(value, maxAge) {
  return [COOKIE_NAME + '=' + value, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=' + maxAge].join('; ');
}
async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4096) reject(new Error('body_too_large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function normUser(u) { return String(u || '').trim().toLowerCase(); }
function findByKakaoId(creds, id) {
  return Object.keys(creds).find(u => String(creds[u].id) === String(id)) || null;
}

export default async function handler(req, res) {
  privateResponse(res);
  const action = req.query.action;
  try {
    // ===== 공개: 아이디로 로그인 =====
    if (action === 'login') {
      if (!mutationAllowed(req, res)) return;
      const body = await readBody(req);
      const username = normUser(body.username);
      const password = String(body.password || '');
      if (!USERNAME_RE.test(username) || !password) return res.status(400).json({ error: 'invalid_credentials' });

      const failKey = FAIL_PREFIX + username;
      const fails = parseInt(await kv(['GET', failKey]) || '0', 10) || 0;
      if (fails >= MAX_FAILS) {
        const ttl = parseInt(await kv(['TTL', failKey]) || '0', 10);
        return res.status(429).json({ error: 'locked', retry_after: Math.max(ttl, 60) });
      }

      const creds = await readCreds();
      const rec = creds[username];
      const ok = rec ? await verifyPassword(password, rec.salt, rec.hash) : false;
      if (!ok) {
        await kv(['INCR', failKey]); await kv(['EXPIRE', failKey, String(LOCK_SECONDS)]);
        return res.status(401).json({ error: 'invalid_credentials', remaining: Math.max(0, MAX_FAILS - fails - 1) });
      }
      await kv(['DEL', failKey]);

      const list = await allowlist();
      const role = currentRole(rec.id, list);
      if (role === 'blocked') return res.status(403).json({ error: 'blocked' });
      if (role === 'pending') return res.status(403).json({ error: 'pending' });

      const jwt = await new SignJWT({ id: String(rec.id), n: rec.n || '사용자', p: rec.p || '', r: role })
        .setProtectedHeader({ alg: 'HS256' }).setIssuer(SESSION_OPTIONS.issuer).setAudience(SESSION_OPTIONS.audience)
        .setIssuedAt().setExpirationTime('24h').sign(sessionKey());
      res.setHeader('Set-Cookie', sessionCookie(jwt, COOKIE_MAX_AGE));
      return res.status(200).json({ ok: true, role });
    }

    // ===== 이하: 로그인(승인) 사용자 전용 =====
    const user = await requireUser(req, res);
    if (!user) return;

    if (action === 'status') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'get_required' });
      const creds = await readCreds();
      const username = findByKakaoId(creds, user.id);
      return res.status(200).json({ ok: true, username, updated_at: username ? creds[username].updated_at : null });
    }

    if (!mutationAllowed(req, res)) return;

    if (action === 'set') {
      const body = await readBody(req);
      const username = normUser(body.username);
      const password = String(body.password || '');
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
      if (password.length < MIN_PW || password.length > 128) return res.status(400).json({ error: 'weak_password' });
      if (password.toLowerCase() === username) return res.status(400).json({ error: 'weak_password' });

      const creds = await readCreds();
      if (creds[username] && String(creds[username].id) !== String(user.id)) return res.status(409).json({ error: 'username_taken' });
      const prev = findByKakaoId(creds, user.id);
      if (prev && prev !== username) delete creds[prev];   // 계정당 아이디 1개
      const salt = randomBytes(16).toString('base64');
      const now = new Date().toISOString();
      creds[username] = { id: String(user.id), n: user.n || '', p: user.p || '', salt, hash: await hashPassword(password, salt),
        created_at: (creds[username] && creds[username].created_at) || now, updated_at: now };
      await writeCreds(creds);
      await kv(['DEL', FAIL_PREFIX + username]);
      return res.status(200).json({ ok: true, username });
    }

    if (action === 'remove') {
      const creds = await readCreds();
      const prev = findByKakaoId(creds, user.id);
      if (prev) { delete creds[prev]; await writeCreds(creds); }
      return res.status(200).json({ ok: true, removed: prev });
    }

    return res.status(404).json({ error: 'unknown_action' });
  } catch (e) {
    const msg = String(e && e.message || '');
    if (msg === 'auth_storage_unavailable' || msg === 'auth_configuration_required') return res.status(503).json({ error: msg });
    console.error('[password]', msg);
    return res.status(500).json({ error: 'server_error' });
  }
}
