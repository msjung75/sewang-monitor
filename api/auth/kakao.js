// 카카오 OAuth + 세션 관리 (callback / me / logout / login) 단일 엔드포인트
// Vercel 함수 슬롯 절약 — action 쿼리로 분기
import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET_RAW = process.env.JWT_SECRET || 'dev-secret-change-me-please';
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY;
const ADMIN_KAKAO_ID = process.env.ADMIN_KAKAO_ID || '';
const APP_BASE = 'https://sewang-monitor.vercel.app';
const REDIRECT_URI = APP_BASE + '/api/auth/kakao';
const COOKIE_NAME = 'sewang_session';
const COOKIE_MAX_AGE = 60 * 60 * 24;

function parseCookie(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(value, maxAge) {
  return [
    COOKIE_NAME + '=' + value,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + maxAge,
  ].join('; ');
}

async function getAllowlist() {
  try {
    const r = await fetch(APP_BASE + '/data/allowlist.json', { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.users)) return d.users;
    return [];
  } catch (e) { return []; }
}

function pickRole(kakaoId, allowlist) {
  if (ADMIN_KAKAO_ID && String(kakaoId) === String(ADMIN_KAKAO_ID)) return 'admin';
  const u = (allowlist || []).find(x => String(x.id) === String(kakaoId));
  if (u) return u.role || 'sales';
  if (!ADMIN_KAKAO_ID && (!allowlist || allowlist.length === 0)) return 'bootstrap-admin';
  return 'pending';
}

export default async function handler(req, res) {
  try {
    const { action, code } = req.query;
    if (code) {
      if (!KAKAO_REST_KEY) return res.status(500).send('KAKAO_REST_KEY 미설정');
      const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: KAKAO_REST_KEY,
          redirect_uri: REDIRECT_URI,
          code,
        }).toString(),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return res.status(401).json({ error: 'token_exchange_failed', detail: tokenData });
      const meRes = await fetch('https://kapi.kakao.com/v2/user/me', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
      const me = await meRes.json();
      const kakaoId = String(me.id);
      const acct = me.kakao_account || {};
      const prof = acct.profile || {};
      const nickname = prof.nickname || (me.properties && me.properties.nickname) || '익명';
      const profileImg = prof.profile_image_url || (me.properties && me.properties.profile_image) || '';
      const allowlist = await getAllowlist();
      const rawRole = pickRole(kakaoId, allowlist);
      const role = rawRole === 'bootstrap-admin' ? 'admin' : rawRole;
      const firstAdmin = rawRole === 'bootstrap-admin';
      const jwt = await new SignJWT({ id: kakaoId, n: nickname, p: profileImg, r: role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(JWT_SECRET);
      res.setHeader('Set-Cookie', sessionCookie(jwt, COOKIE_MAX_AGE));
      let target = '/?login=ok&role=' + encodeURIComponent(role);
      if (firstAdmin) target += '&first_admin=1&my_id=' + encodeURIComponent(kakaoId);
      if (role === 'pending') target = '/?login=pending&my_id=' + encodeURIComponent(kakaoId);
      return res.redirect(302, target);
    }
    if (action === 'login') {
      if (!KAKAO_REST_KEY) return res.status(500).send('KAKAO_REST_KEY 미설정');
      const url = 'https://kauth.kakao.com/oauth/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: KAKAO_REST_KEY,
        redirect_uri: REDIRECT_URI,
      }).toString();
      return res.redirect(302, url);
    }
    if (action === 'me') {
      const cookies = parseCookie(req.headers.cookie || '');
      const token = cookies[COOKIE_NAME];
      if (!token) return res.status(200).json({ authenticated: false });
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return res.status(200).json({ authenticated: true, user: { id: payload.id, nickname: payload.n, profile: payload.p, role: payload.r } });
      } catch (e) {
        return res.status(200).json({ authenticated: false, expired: true });
      }
    }
    if (action === 'logout') {
      res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return res.redirect(302, '/');
    }
    return res.status(400).json({ error: 'unknown_action', hint: 'GET /api/auth/kakao?action=login (or me/logout)' });
  } catch (err) {
    return res.status(500).json({ error: 'auth_handler_failed', message: err.message });
  }
}
