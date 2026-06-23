// 사용자 활동 로깅 endpoint.
// POST body: { event: 'visit' | 'tab' | 'card', tab?: string, ts: number }
// data/usage_log.json에 daily aggregated 누적.
// 사용자 식별: 카카오 쿠키 또는 ME 정보로 가져옴 (auth/kakao 시스템 활용).

import { GITHUB_HEADERS } from './_github.js';

// GitHub Contents API helper (race condition retry)
async function readJsonFromRepo(path) {
  try {
    const r = await fetch(`https://api.github.com/repos/${process.env.REPO || 'msjung75/sewang-monitor'}/contents/${path}`, {
      headers: GITHUB_HEADERS,
    });
    if (!r.ok) return { content: null, sha: null };
    const j = await r.json();
    const decoded = Buffer.from(j.content, 'base64').toString('utf-8');
    return { content: JSON.parse(decoded), sha: j.sha };
  } catch (e) {
    return { content: null, sha: null };
  }
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

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.GITHUB_TOKEN) {
    console.log('[log] no GITHUB_TOKEN, skip');
    return res.status(200).json({ ok: true, skipped: 'no token' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const userId = (body.user_id || 'unknown').toString().substring(0, 30);
  const role = (body.role || 'unknown').toString().substring(0, 20);
  const event = (body.event || 'visit').toString().substring(0, 20);
  const tab = (body.tab || '').toString().substring(0, 30);

  const path = 'data/usage_log.json';
  // Retry up to 3 times on 409 conflict
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

    // Trim to last 30 days
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Object.keys(log.days).forEach(k => { if (k < cutoff) delete log.days[k]; });

    const ok = await writeJsonToRepo(path, log, sha, `[skip ci] usage log ${today} ${userId}/${role}/${event}`);
    if (ok) return res.status(200).json({ ok: true, today, total: day.total });
    await new Promise(r => setTimeout(r, 500 + attempt * 500));
  }
  return res.status(500).json({ error: 'commit retry exhausted' });
}
