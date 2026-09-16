import { requireReadUser, SALES_ROLES } from '../lib/security.mjs';
// 네이버 뉴스 검색 프록시
export default async function handler(req, res) {
  if (!await requireReadUser(req, res)) return;
  const { query, sort = 'date', display = 10, start = 1 } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return res.status(500).json({ error: 'NAVER_CLIENT_ID/SECRET 미설정' });

  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&sort=${sort}&display=${display}&start=${start}`;
  try {
    const r = await fetch(url, {
      headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'upstream_request_failed' });
    const data = await r.json();
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'upstream_request_failed' });
  }
}
