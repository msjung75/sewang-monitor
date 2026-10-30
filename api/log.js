// Activity logging endpoint (v20: public repo + hashed PII + envMissing diag)
import { GITHUB_HEADERS } from './_github.js';
import { requireUser, mutationAllowed, anonymizePII } from '../lib/security.mjs';

const KV_URL   = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_ON    = !!(KV_URL && KV_TOKEN);
const LAST_SEEN_KEY = 'sewang:last_seen';

function envMissingList() {
  const miss = [];
  if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) miss.push('KV_REST_API_URL');
  if (!process.env.KV_REST_API_TOKEN && !process.env.UPSTASH_REDIS_REST_TOKEN) miss.push('KV_REST_API_TOKEN');
  if (!process.env.LOG_SALT) miss.push('LOG_SALT');
  if (!process.env.GITHUB_TOKEN) miss.push('GITHUB_TOKEN');
  return miss;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

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

export default async function handler(req, res) {
  noStore(res);

  if (req.method === 'GET' && (req.url || '').indexOf('diag=1') >= 0) {
    return res.status(200).json({
      ok: true,
      kv_on: KV_ON,
      envMissing: envMissingList(),
      hint: envMissingList().length ? 'Vercel Env Vars missing (Settings > Env Vars, or Storage > KV connect)' : 'all env present',
    });
  }

  const user = await requireUser(req, res, req.method === 'GET' ? ['admin'] : undefined);
  if (!user) return;
  if (req.method !== 'GET' && !mutationAllowed(req, res)) return;

  if (req.method === 'GET') {
    const userId = ((req.query && req.query.userId) || '').toString().trim();
    if (!userId) return res.status(400).json({ error: 'userId required (or "all")' });
    if (!KV_ON) {
      return res.status(200).json({ ok: true, connected: false, last_seen: userId === 'all' ? {} : null, envMissing: envMissingList() });
    }
    if (userId === 'all') {
      const map = await kvHGetAll(LAST_SEEN_KEY);
      return res.status(200).json({ ok: true, connected: true, last_seen: map, envMissing: envMissingList() });
    }
    const v = await kvCmd('HGET', LAST_SEEN_KEY, userId);
    return res.status(200).json({ ok: true, connected: true, last_seen: v || null, envMissing: envMissingList() });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const userId = String(user.id);
  const role = user.r;
  const event  = (body.event  || 'visit'  ).toString().substring(0, 20);
  const tab    = (body.tab    || '').toString().substring(0, 30);
  const nowIso = new Date().toISOString();

  let kvOk = false;
  if (KV_ON && userId !== 'unknown' && event === 'visit') {
    const r = await kvCmd('HSET', LAST_SEEN_KEY, userId, nowIso);
    kvOk = (r !== null);
  }

  if (!process.env.GITHUB_TOKEN) {
    return res.status(200).json({ ok: true, kv: kvOk, gh: false, envMissing: envMissingList() });
  }

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const userKey = anonymizePII(userId);
  const path = 'data/usage_log.json';
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content, sha } = await readJsonFromRepo(path);
    const log = content || { updated: '', days: {} };
    const day = log.days[today] = log.days[today] || { users: {}, total: 0 };
    day.users[userKey] = day.users[userKey] || { role, visits: 0, last_event: '', last_ts: 0, tabs: {} };
    day.users[userKey].visits += 1;
    day.users[userKey].last_event = event;
    day.users[userKey].last_ts = Date.now();
    if (tab) day.users[userKey].tabs[tab] = (day.users[userKey].tabs[tab] || 0) + 1;
    day.total += 1;
    log.updated = new Date().toISOString();
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Object.keys(log.days).forEach(k => { if (k < cutoff) delete log.days[k]; });
    const ok = await writeJsonToRepo(path, log, sha, `[skip ci] update activity aggregate ${today}`);
    if (ok) return res.status(200).json({ ok: true, kv: kvOk, gh: true, today, total: day.total, envMissing: envMissingList() });
    await new Promise(r => setTimeout(r, 500 + attempt * 500));
  }
  return res.status(200).json({ ok: true, kv: kvOk, gh: false, note: 'commit retry exhausted', envMissing: envMissingList() });
}
