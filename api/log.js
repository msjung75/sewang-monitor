// 사용자 활동 로깅 endpoint (v18: last_seen via Vercel KV + GitHub daily aggregate)
//
// POST body: { event, user_id, role, tab, ts }
//   - Vercel KV(HSET last_seen)에 사용자별 최근 방문 timestamp 저장
//   - GITHUB_TOKEN 있으면 data/usage_log.json에 일별 aggregate 누적 (기존 동작)
//
// GET ?userId=all              → { ok, connected, last_seen:{userId:ISO,...} }
// GET ?userId=<kakao_id>       → { ok, connected, last_seen:ISO|null }
//
// KV 미연결(env 없음) 시 graceful: connected:false + 빈 응답

import { GITHUB_HEADERS } from './_github.js';

// ── Vercel KV (Upstash REST) ──────────────────────────────────────
const KV_URL   = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_ON    = !!(KV_URL && KV_TOKEN);
const LAST_SEEN_KEY = 'sewang:last_seen';

async function kvCmd() {
  if (!KV_ON) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([...arguments]),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result;
  } catch (_) { return null; }
}

async function kvHGetAll(hash) {
  const r = await kvCmd('HGETALL', hash);
  if (!r) return {};
  if (Array.isArray(r)) {
    const out = {};
    for (let i = 0; i < r.length; i += 2) out[r[i]] = r[i + 1];
    return out;
  }
  if (typeof r === 'object') return r;
  return {};
}

// ── GitHub Contents API (기존 aggregate 로그) ────────────────────────
async function readJsonFromRepo(path) {
  try {
    const r = await fetch(`https://api.github.com/repos/${process.env.REPO || 'msjung75/sewang-monitor'}/contents/${path}`, {
      headers: GITHUB_HEADERS,
    });
    if (!r.ok) return { content: null, sha: null };
    const j = await r.json();
    const decoded = Buffer.from(j.content, 'base64').toString('utf-8');
    return { content: JSON.parse(decoded), sha: j.sha };
  } catch (e) { return { content: null, sha: null }; }
}

async function writeJsonToRepo(path, content, sha, message) {
  const body = {
    message: message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${process.env.REPO || 'msjung75/sewang-monitor'}/contents/${path}`, {
    method: 'PUT',
    headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// ── Handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ─── GET: last_seen 조회 ─────────────────────────────────────────
  if (req.method === 'GET') {
    const userId = ((req.query && req.query.userId) || '').toString().trim();
    if (!userId) return res.status(400).json({ error: 'userId required (or "all")' });
    if (!KV_ON) {
      return res.status(200).json({ ok: true, connected: false, last_seen: userId === 'all' ? {} : null });
    }
    if (userId === 'all') {
      const map = await kvHGetAll(LAST_SEEN_KEY);
      return res.status(200).json({ ok: true, connected: true, last_seen: map });
    }
    const v = await kvCmd('HGET', LAST_SEEN_KEY, userId);
    return res.status(200).json({ ok: true, connected: true, last_seen: v || null });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const userId = (body.user_id || 'unknown').toString().substring(0, 30);
  const role   = (body.role   || 'unknown').toString().substring(0, 20);
  const event  = (body.event  || 'visit'  ).toString().substring(0, 20);
  const tab    = (body.tab    || '').toString().substring(0, 30);
  const nowIso = new Date().toISOString();

  // ── 1) KV 최근 방문 기록 (visit 이벤트만) ──
  let kvOk = false;
  if (KV_ON && userId !== 'unknown' && event === 'visit') {
    const r = await kvCmd('HSET', LAST_SEEN_KEY, userId, nowIso);
    kvOk = (r !== null);
  }

  // ── 2) GitHub aggregate 로그 (선택) ──
  if (!process.env.GITHUB_TOKEN) {
    return res.status(200).json({ ok: true, kv: kvOk, gh: false });
  }

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const path = 'data/usage_log.json';
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content, sha } = await readJsonFromRepo(path);
    const log = content || { updated: '', days: {} };
    const day = log.days[today] = log.days[today] || { users: {}, total: 0 };
    day.users[userId] = day.users[userId] || { role, visits: 0, last_event: '', last_ts: 0, tabs: {} };
    day.users[userId].visits += 1;
    day.users[userId].last_event = event;
    day.users[userId].last_ts = Date.now();
    if (tab) day.users[userId].tabs[tab] = (day.users[userId].tabs[tab] || 0) + 1;
    day.total += 1;
    log.updated = new Date().toISOString();
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Object.keys(log.days).forEach(k => { if (k < cutoff) delete log.days[k]; });
    const ok = await writeJsonToRepo(path, log, sha, `[skip ci] usage log ${today} ${userId}/${role}/${event}`);
    if (ok) return res.status(200).json({ ok: true, kv: kvOk, gh: true, today, total: day.total });
    await new Promise(r => setTimeout(r, 500 + attempt * 500));
  }
  return res.status(200).json({ ok: true, kv: kvOk, gh: false, note: 'commit retry exhausted' });
}
