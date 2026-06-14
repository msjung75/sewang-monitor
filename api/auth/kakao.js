// 카카오 OAuth + 사용자 관리 (callback / me / logout / login / list_users / approve / reject / update_role / remove)
// v13: GitHub Contents API로 pending/allowlist 자동 commit
import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET_RAW = process.env.JWT_SECRET || 'dev-secret-change-me-please';
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY;
const ADMIN_KAKAO_ID = process.env.ADMIN_KAKAO_ID || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'msjung75@gmail.com';
const APP_BASE = 'https://sewang-monitor.vercel.app';
const REDIRECT_URI = APP_BASE + '/api/auth/kakao';
const COOKIE_NAME = 'sewang_session';
const COOKIE_MAX_AGE = 60 * 60 * 24;
const REPO = 'msjung75/sewang-monitor';
const GH_BASE = 'https://api.github.com/repos/' + REPO;

// ============================================================
// 유틸
// ============================================================
function parseCookie(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(value, maxAge) {
  return [COOKIE_NAME + '=' + value, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=' + maxAge].join('; ');
}
async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ============================================================
// GitHub Contents API (PAT 사용)
// ============================================================
async function ghGetFile(path) {
  const r = await fetch(GH_BASE + '/contents/' + path + '?ref=main', {
    headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'sewang-monitor', 'Accept': 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (r.status === 404) return { sha: null, content: null };
  if (!r.ok) throw new Error('gh get fail ' + r.status);
  const d = await r.json();
  const text = Buffer.from(d.content, 'base64').toString('utf8');
  return { sha: d.sha, content: JSON.parse(text) };
}
async function ghPutFile(path, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    branch: 'main',
  };
  if (sha) body.sha = sha;
  const r = await fetch(GH_BASE + '/contents/' + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'sewang-monitor', 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('gh put fail ' + r.status + ': ' + (d.message || ''));
  return d;
}

// ============================================================
// allowlist / pending 로드
// ============================================================
async function getAllowlist() {
  try {
    const r = await fetch(APP_BASE + '/data/allowlist.json', { cache: 'no-store' });
    if (!r.ok) return { users: [], blocked: [], updated_at: '' };
    const d = await r.json();
    return {
      users: Array.isArray(d) ? d : (d.users || []),
      blocked: d.blocked || [],
      updated_at: d.updated_at || '',
    };
  } catch (e) { return { users: [], blocked: [], updated_at: '' }; }
}
async function getPending() {
  try {
    const r = await fetch(APP_BASE + '/data/pending_users.json', { cache: 'no-store' });
    if (!r.ok) return { pending: [], updated_at: '' };
    const d = await r.json();
    return { pending: d.pending || [], updated_at: d.updated_at || '' };
  } catch (e) { return { pending: [], updated_at: '' }; }
}
function pickRole(kakaoId, users) {
  if (ADMIN_KAKAO_ID && String(kakaoId) === String(ADMIN_KAKAO_ID)) return 'admin';
  const u = (users || []).find(x => String(x.id) === String(kakaoId));
  if (u) return u.role || 'sales';
  if (!ADMIN_KAKAO_ID && (!users || users.length === 0)) return 'bootstrap-admin';
  return 'pending';
}
async function isBlocked(kakaoId) {
  const list = await getAllowlist();
  return (list.blocked || []).some(b => String(b.id) === String(kakaoId));
}

// ============================================================
// Resend 이메일 알림
// ============================================================
async function sendPendingNotice(kakaoId, nickname, profile) {
  if (!RESEND_API_KEY) return { skipped: true };
  try {
    const html = `<div style="font-family:-apple-system,'Noto Sans KR',sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#111">
      <h2 style="color:#0b3a8a;margin:0 0 16px">[세왕 모니터] 신규 가입 신청</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#666;width:100px">닉네임</td><td><strong>${nickname || '(미상)'}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666">카카오 ID</td><td><code>${kakaoId}</code></td></tr>
        <tr><td style="padding:6px 0;color:#666">신청 시각</td><td>${new Date().toLocaleString('ko-KR')}</td></tr>
      </table>
      <p style="margin-top:24px"><a href="${APP_BASE}/?tab=admin" style="display:inline-block;background:#0b3a8a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:8px;font-weight:700">「관리」 탭에서 승인/거부</a></p>
    </div>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'sewang-monitor <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject: `[세왕 모니터] 신규 가입 신청 — ${nickname || kakaoId}`,
        html,
      }),
    });
    const d = await r.json();
    return { ok: r.ok, id: d.id };
  } catch (e) { return { error: e.message }; }
}

// ============================================================
// pending 자동 저장 (GitHub commit)
// ============================================================
async function savePending(kakaoId, nickname, profileImg) {
  if (!GITHUB_TOKEN) { console.warn('[pending] GITHUB_TOKEN 미설정 — 저장 skip'); return { skipped: true }; }
  try {
    let { sha, content } = await ghGetFile('data/pending_users.json');
    if (!content) content = { pending: [], updated_at: '' };
    const exists = content.pending.some(p => String(p.id) === String(kakaoId));
    if (exists) return { skipped: 'already_pending' };
    content.pending.push({
      id: kakaoId,
      nickname,
      profile: profileImg,
      applied_at: new Date().toISOString(),
    });
    content.updated_at = new Date().toISOString();
    await ghPutFile('data/pending_users.json', content, sha, `pending: ${nickname} (${kakaoId})`);
    return { ok: true };
  } catch (e) { console.error('[pending] save fail:', e); return { error: e.message }; }
}

// ============================================================
// admin 액션: approve / reject / update_role / remove
// ============================================================
async function actApprove(kakaoId, role, memo, nickname, profileImg) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  // 1) pending에서 제거
  const pf = await ghGetFile('data/pending_users.json');
  let pcontent = pf.content || { pending: [], updated_at: '' };
  const pIdx = pcontent.pending.findIndex(p => String(p.id) === String(kakaoId));
  let snap = null;
  if (pIdx >= 0) { snap = pcontent.pending[pIdx]; pcontent.pending.splice(pIdx, 1); pcontent.updated_at = new Date().toISOString(); }
  // 2) allowlist에 추가
  const af = await ghGetFile('data/allowlist.json');
  let acontent = af.content;
  if (!acontent) acontent = { users: [], blocked: [], updated_at: '' };
  if (Array.isArray(acontent)) acontent = { users: acontent, blocked: [], updated_at: '' };
  if (!acontent.blocked) acontent.blocked = [];
  const exists = acontent.users.some(u => String(u.id) === String(kakaoId));
  if (!exists) {
    acontent.users.push({
      id: kakaoId,
      nickname: nickname || (snap && snap.nickname) || '',
      profile: profileImg || (snap && snap.profile) || '',
      role: role || 'viewer',
      memo: memo || '',
      approved_at: new Date().toISOString(),
    });
    acontent.updated_at = new Date().toISOString();
  }
  // 3) commit 두 번
  if (pIdx >= 0) await ghPutFile('data/pending_users.json', pcontent, pf.sha, `approve(pending del): ${kakaoId}`);
  await ghPutFile('data/allowlist.json', acontent, af.sha, `approve(add): ${kakaoId} as ${role}`);
  return { ok: true, kakaoId, role };
}
async function actReject(kakaoId, reason) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const pf = await ghGetFile('data/pending_users.json');
  let pcontent = pf.content || { pending: [], updated_at: '' };
  const pIdx = pcontent.pending.findIndex(p => String(p.id) === String(kakaoId));
  let snap = null;
  if (pIdx >= 0) { snap = pcontent.pending[pIdx]; pcontent.pending.splice(pIdx, 1); pcontent.updated_at = new Date().toISOString(); }
  const af = await ghGetFile('data/allowlist.json');
  let acontent = af.content;
  if (!acontent) acontent = { users: [], blocked: [], updated_at: '' };
  if (Array.isArray(acontent)) acontent = { users: acontent, blocked: [], updated_at: '' };
  if (!acontent.blocked) acontent.blocked = [];
  const exists = acontent.blocked.some(b => String(b.id) === String(kakaoId));
  if (!exists) {
    acontent.blocked.push({
      id: kakaoId,
      nickname: snap && snap.nickname || '',
      reason: reason || '관리자 거부',
      blocked_at: new Date().toISOString(),
    });
    acontent.updated_at = new Date().toISOString();
  }
  if (pIdx >= 0) await ghPutFile('data/pending_users.json', pcontent, pf.sha, `reject(pending del): ${kakaoId}`);
  await ghPutFile('data/allowlist.json', acontent, af.sha, `reject(block): ${kakaoId}`);
  return { ok: true, kakaoId };
}
async function actUpdateRole(kakaoId, role, memo) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const af = await ghGetFile('data/allowlist.json');
  let acontent = af.content;
  if (!acontent || Array.isArray(acontent)) throw new Error('allowlist 형식 오류');
  const u = acontent.users.find(x => String(x.id) === String(kakaoId));
  if (!u) throw new Error('user not found');
  u.role = role || u.role;
  if (memo !== undefined) u.memo = memo;
  u.updated_at = new Date().toISOString();
  acontent.updated_at = new Date().toISOString();
  await ghPutFile('data/allowlist.json', acontent, af.sha, `update_role: ${kakaoId} -> ${role}`);
  return { ok: true };
}
async function actUpdateUser(kakaoId, nickname, memo) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const af = await ghGetFile('data/allowlist.json');
  let acontent = af.content;
  if (!acontent || Array.isArray(acontent)) throw new Error('allowlist 형식 오류');
  const u = acontent.users.find(x => String(x.id) === String(kakaoId));
  if (!u) throw new Error('user not found');
  if (nickname !== undefined) u.nickname = nickname;
  if (memo !== undefined) u.memo = memo;
  u.updated_at = new Date().toISOString();
  acontent.updated_at = new Date().toISOString();
  await ghPutFile('data/allowlist.json', acontent, af.sha, `update_user: ${kakaoId} -> ${nickname || '(no name change)'}`);
  return { ok: true };
}
async function actAddUser(kakaoId, role, nickname, memo) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const af = await ghGetFile('data/allowlist.json');
  let acontent = af.content;
  if (!acontent) acontent = { users: [], blocked: [], updated_at: '' };
  if (Array.isArray(acontent)) acontent = { users: acontent, blocked: [], updated_at: '' };
  if (!acontent.blocked) acontent.blocked = [];
  const exists = acontent.users.some(u => String(u.id) === String(kakaoId));
  if (exists) throw new Error('이미 등록된 사용자');
  acontent.users.push({
    id: kakaoId,
    nickname: nickname || '',
    role: role || 'viewer',
    memo: memo || '',
    approved_at: new Date().toISOString(),
  });
  acontent.updated_at = new Date().toISOString();
  // pending에서 같은 ID 있으면 같이 정리
  try {
    const pf = await ghGetFile('data/pending_users.json');
    if (pf.content) {
      const before = pf.content.pending.length;
      pf.content.pending = pf.content.pending.filter(p => String(p.id) !== String(kakaoId));
      if (pf.content.pending.length !== before) {
        pf.content.updated_at = new Date().toISOString();
        await ghPutFile('data/pending_users.json', pf.content, pf.sha, `add_user(pending cleanup): ${kakaoId}`);
      }
    }
  } catch (e) { /* ignore */ }
  await ghPutFile('data/allowlist.json', acontent, af.sha, `add_user: ${nickname || kakaoId} as ${role}`);
  return { ok: true, kakaoId, role };
}
// ============================================================
// 브랜드 분류 관리 (admin only) — v13.6
// ============================================================
async function actListBrandOverrides() {
  const af = await ghGetFile('data/brand_overrides.json');
  return af.content || { excluded: [], category_overrides: {}, updated_at: '' };
}
async function actExcludeBrand(brandName, by) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, updated_at: '' };
  if (!c.excluded.some(x => x.name === brandName)) {
    c.excluded.push({ name: brandName, by: by || '', at: new Date().toISOString() });
  }
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `exclude_brand: ${brandName}`);
  return { ok: true, brandName };
}
async function actRestoreBrand(brandName) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, updated_at: '' };
  const before = c.excluded.length;
  c.excluded = c.excluded.filter(x => x.name !== brandName);
  if (c.excluded.length === before) throw new Error('not excluded');
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `restore_brand: ${brandName}`);
  return { ok: true, brandName };
}
async function actAddAlias(matchName, canonicalBrand, by) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, brand_aliases: {}, store_excluded: [], updated_at: '' };
  if (!c.brand_aliases) c.brand_aliases = {};
  c.brand_aliases[matchName] = canonicalBrand;
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `add_alias: ${matchName} -> ${canonicalBrand}`);
  return { ok: true, matchName, canonicalBrand };
}
async function actRemoveAlias(matchName) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, brand_aliases: {}, store_excluded: [], updated_at: '' };
  if (!c.brand_aliases) c.brand_aliases = {};
  delete c.brand_aliases[matchName];
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `remove_alias: ${matchName}`);
  return { ok: true, matchName };
}
async function actExcludeStore(storeId, storeName, by) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, brand_aliases: {}, store_excluded: [], updated_at: '' };
  if (!c.store_excluded) c.store_excluded = [];
  if (!c.store_excluded.some(x => x.id === storeId)) {
    c.store_excluded.push({ id: storeId, name: storeName || '', by: by || '', at: new Date().toISOString() });
  }
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `exclude_store: ${storeId}`);
  return { ok: true, storeId };
}
async function actRestoreStore(storeId) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, brand_aliases: {}, store_excluded: [], updated_at: '' };
  if (!c.store_excluded) c.store_excluded = [];
  c.store_excluded = c.store_excluded.filter(x => x.id !== storeId);
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `restore_store: ${storeId}`);
  return { ok: true, storeId };
}
async function actSetBrandCategory(brandName, category) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  if (!['sool','food','cafe',''].includes(category)) throw new Error('invalid category');
  const f = await ghGetFile('data/brand_overrides.json');
  let c = f.content || { excluded: [], category_overrides: {}, updated_at: '' };
  if (category === '') delete c.category_overrides[brandName];
  else c.category_overrides[brandName] = category;
  c.updated_at = new Date().toISOString();
  await ghPutFile('data/brand_overrides.json', c, f.sha, `set_category: ${brandName} -> ${category}`);
  return { ok: true, brandName, category };
}

async function actRemove(kakaoId) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  const af = await ghGetFile('data/allowlist.json');
  let acontent = af.content;
  if (!acontent || Array.isArray(acontent)) throw new Error('allowlist 형식 오류');
  const before = acontent.users.length;
  acontent.users = acontent.users.filter(u => String(u.id) !== String(kakaoId));
  if (acontent.users.length === before) throw new Error('user not found');
  acontent.updated_at = new Date().toISOString();
  await ghPutFile('data/allowlist.json', acontent, af.sha, `remove: ${kakaoId}`);
  return { ok: true };
}

// ============================================================
// 메인 핸들러
// ============================================================
export default async function handler(req, res) {
  try {
    const { action, code } = req.query;

    // ===== OAuth 콜백 =====
    if (code) {
      if (!KAKAO_REST_KEY) return res.status(500).send('KAKAO_REST_KEY 미설정');
      const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: KAKAO_REST_KEY, redirect_uri: REDIRECT_URI, code }).toString(),
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

      // blocked 우선 체크
      if (await isBlocked(kakaoId)) {
        const jwt = await new SignJWT({ id: kakaoId, n: nickname, p: profileImg, r: 'blocked' })
          .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(JWT_SECRET);
        res.setHeader('Set-Cookie', sessionCookie(jwt, COOKIE_MAX_AGE));
        return res.redirect(302, '/?login=blocked');
      }

      const list = await getAllowlist();
      const rawRole = pickRole(kakaoId, list.users);
      const role = rawRole === 'bootstrap-admin' ? 'admin' : rawRole;
      const firstAdmin = rawRole === 'bootstrap-admin';

      console.log('[KAKAO_LOGIN]', JSON.stringify({ at: new Date().toISOString(), kakaoId, nickname, role, firstAdmin }));

      if (role === 'pending') {
        const saved = await savePending(kakaoId, nickname, profileImg);
        const mail = await sendPendingNotice(kakaoId, nickname, profileImg);
        console.log('[PENDING_SAVE]', JSON.stringify({ kakaoId, saved, mail }));
      }

      const jwt = await new SignJWT({ id: kakaoId, n: nickname, p: profileImg, r: role })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(JWT_SECRET);
      res.setHeader('Set-Cookie', sessionCookie(jwt, COOKIE_MAX_AGE));

      let target = '/?login=ok&role=' + encodeURIComponent(role);
      if (firstAdmin) target += '&first_admin=1&my_id=' + encodeURIComponent(kakaoId);
      if (role === 'pending') target = '/?login=pending';
      return res.redirect(302, target);
    }

    // ===== 클라이언트 안전 설정 (Kakao JS SDK 키 등) =====
    if (action === 'config') {
      res.setHeader('Cache-Control', 'no-store');  // 등록 직후 캐시 방지
      const k = process.env.KAKAO_JS_KEY || process.env.KAKAO_JS_APP_KEY || '';
      return res.status(200).json({
        kakaoJsKey: k,
        keyLen: k.length,  // 디버그: 값 길이만 (값 노출 X)
      });
    }

    // ===== 로그인 redirect =====
    if (action === 'login') {
      if (!KAKAO_REST_KEY) return res.status(500).send('KAKAO_REST_KEY 미설정');
      const url = 'https://kauth.kakao.com/oauth/authorize?' + new URLSearchParams({
        response_type: 'code', client_id: KAKAO_REST_KEY, redirect_uri: REDIRECT_URI,
      }).toString();
      return res.redirect(302, url);
    }

    // ===== 세션 확인 =====
    if (action === 'me') {
      const cookies = parseCookie(req.headers.cookie || '');
      const token = cookies[COOKIE_NAME];
      if (!token) return res.status(200).json({ authenticated: false });
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return res.status(200).json({ authenticated: true, user: { id: payload.id, nickname: payload.n, profile: payload.p, role: payload.r } });
      } catch (e) { return res.status(200).json({ authenticated: false, expired: true }); }
    }

    // ===== 로그아웃 =====
    if (action === 'logout') {
      res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return res.redirect(302, '/');
    }

    // ===== admin actions =====
    const cookies = parseCookie(req.headers.cookie || '');
    const token = cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ ok: false, error: 'no_session' });
    let payload;
    try { ({ payload } = await jwtVerify(token, JWT_SECRET)); }
    catch (e) { return res.status(401).json({ ok: false, error: 'invalid_session' }); }
    if (payload.r !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' });

    if (action === 'list_users') {
      const list = await getAllowlist();
      const pl = await getPending();
      return res.status(200).json({
        ok: true,
        users: list.users || [],
        blocked: list.blocked || [],
        pending: pl.pending || [],
        admin_env: !!ADMIN_KAKAO_ID,
        github_env: !!GITHUB_TOKEN,
        resend_env: !!RESEND_API_KEY,
      });
    }

    if (action === 'pending_count') {
      const pl = await getPending();
      return res.status(200).json({ ok: true, count: (pl.pending || []).length, updated_at: pl.updated_at || '' });
    }
    if (action === 'add_user') {
      const body = await readBody(req);
      const { kakao_id, role, nickname, memo } = body;
      if (!kakao_id) return res.status(400).json({ ok: false, error: 'kakao_id 필요' });
      if (!/^\d+$/.test(String(kakao_id))) return res.status(400).json({ ok: false, error: '카카오 ID는 숫자만' });
      try {
        const r = await actAddUser(String(kakao_id), role || 'viewer', nickname || '', memo || '');
        return res.status(200).json(r);
      } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'approve') {
      const body = await readBody(req);
      const { kakao_id, role, memo, nickname, profile } = body;
      if (!kakao_id) return res.status(400).json({ ok: false, error: 'kakao_id 필요' });
      const r = await actApprove(String(kakao_id), role, memo, nickname, profile);
      return res.status(200).json(r);
    }
    if (action === 'reject') {
      const body = await readBody(req);
      const { kakao_id, reason } = body;
      if (!kakao_id) return res.status(400).json({ ok: false, error: 'kakao_id 필요' });
      const r = await actReject(String(kakao_id), reason);
      return res.status(200).json(r);
    }
    if (action === 'update_role') {
      const body = await readBody(req);
      const { kakao_id, role, memo } = body;
      if (!kakao_id || !role) return res.status(400).json({ ok: false, error: 'kakao_id, role 필요' });
      const r = await actUpdateRole(String(kakao_id), role, memo);
      return res.status(200).json(r);
    }
    if (action === 'update_user') {
      const body = await readBody(req);
      const { kakao_id, nickname, memo } = body;
      if (!kakao_id) return res.status(400).json({ ok: false, error: 'kakao_id 필요' });
      try {
        const r = await actUpdateUser(String(kakao_id), nickname, memo);
        return res.status(200).json(r);
      } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'remove') {
      const body = await readBody(req);
      const { kakao_id } = body;
      if (!kakao_id) return res.status(400).json({ ok: false, error: 'kakao_id 필요' });
      const r = await actRemove(String(kakao_id));
      return res.status(200).json(r);
    }
    // ===== 브랜드 분류 관리 (admin) =====
    if (action === 'list_brand_overrides') {
      const r = await actListBrandOverrides();
      return res.status(200).json({ ok: true, ...r });
    }
    if (action === 'exclude_brand') {
      const body = await readBody(req);
      const { brand } = body;
      if (!brand) return res.status(400).json({ ok: false, error: 'brand 필요' });
      try {
        const r = await actExcludeBrand(brand, payload.n || '');
        return res.status(200).json(r);
      } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'restore_brand') {
      const body = await readBody(req);
      const { brand } = body;
      if (!brand) return res.status(400).json({ ok: false, error: 'brand 필요' });
      try {
        const r = await actRestoreBrand(brand);
        return res.status(200).json(r);
      } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'set_brand_category') {
      const body = await readBody(req);
      const { brand, category } = body;
      if (!brand) return res.status(400).json({ ok: false, error: 'brand 필요' });
      try {
        const r = await actSetBrandCategory(brand, category || '');
        return res.status(200).json(r);
      } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'add_alias') {
      const body = await readBody(req);
      const { match, brand } = body;
      if (!match || !brand) return res.status(400).json({ ok: false, error: 'match, brand 필요' });
      try { return res.status(200).json(await actAddAlias(match, brand, payload.n || '')); }
      catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'remove_alias') {
      const body = await readBody(req);
      const { match } = body;
      if (!match) return res.status(400).json({ ok: false, error: 'match 필요' });
      try { return res.status(200).json(await actRemoveAlias(match)); }
      catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'exclude_store') {
      const body = await readBody(req);
      const { store_id, store_name } = body;
      if (!store_id) return res.status(400).json({ ok: false, error: 'store_id 필요' });
      try { return res.status(200).json(await actExcludeStore(store_id, store_name || '', payload.n || '')); }
      catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }
    if (action === 'restore_store') {
      const body = await readBody(req);
      const { store_id } = body;
      if (!store_id) return res.status(400).json({ ok: false, error: 'store_id 필요' });
      try { return res.status(200).json(await actRestoreStore(store_id)); }
      catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }

    return res.status(400).json({ error: 'unknown_action', hint: 'action=login|me|logout|list_users|pending_count|add_user|approve|reject|update_role|update_user|remove' });
  } catch (err) {
    console.error('[auth_handler_failed]', err);
    return res.status(500).json({ error: 'auth_handler_failed', message: err.message });
  }
}
