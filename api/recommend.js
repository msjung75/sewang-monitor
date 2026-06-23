// 영업 추천 매장 데이터 서빙 프록시.
// data/recommend_metro.json 을 읽어서 view별로 가공해 반환.
// nightly-recommend workflow가 매일 새벽 갱신.

import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const file = path.join(process.cwd(), 'data', 'recommend_metro.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return res.status(500).json({ error: 'recommend data unavailable', detail: e.message });
  }

  const items = raw.items || [];
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const minScore = parseFloat(req.query.minScore || '2.0');
  const typeKey = req.query.type || ''; // ilban, danran, yuheung, hyuge

  let filtered = items.filter(x => (x.score || 0) >= minScore);
  if (typeKey) filtered = filtered.filter(x => x.type_key === typeKey);

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json({
    updated: raw.updated,
    baseline: raw.baseline,
    days: raw.days,
    region: raw.region,
    total_input: raw.total_input,
    recommended_total: filtered.length,
    items: filtered.slice(0, limit),
  });
}
