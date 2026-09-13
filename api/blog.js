// 네이버 블로그 검색 프록시
// Vercel 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
// since=YYYYMMDD 파라미터로 인허가일 이후 발행 글만 필터링 가능
export default async function handler(req, res) {
  const { query, sort = 'date', display = 10, start = 1, since } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    return res.status(500).json({ error: 'NAVER_CLIENT_ID/SECRET 환경변수 미설정' });
  }

  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&sort=${sort}&display=${display}&start=${start}`;

  try {
    const r = await fetch(url, {
      headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret }
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: 'naver api error', detail: text });
    }
    const data = await r.json();

    // since=YYYYMMDD 필터: 인허가일 이후 발행된 블로그만 filteredTotal 카운트
    if (since && /^\d{8}$/.test(since) && Array.isArray(data.items)) {
      const filtered = data.items.filter(it => (it.postdate || '') >= since);
      data.filteredTotal = filtered.length;
      data.filteredItems = filtered;
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
