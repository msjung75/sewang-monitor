// 업변(상호변경) 매장 데이터 서빙 프록시.
// data/upbyeon_2026.json 을 읽어서 클라이언트가 쓰기 좋게 가공해서 반환.
// nightly-upbyeon workflow가 매일 새벽 갱신.

import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const file = path.join(process.cwd(), 'data', 'upbyeon_2026.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return res.status(500).json({ error: 'upbyeon data unavailable', detail: e.message });
  }

  const brands = raw.brands || {};
  const view = req.query.view || 'summary';

  // brand 별 요약 array
  const rows = [];
  for (const [name, b] of Object.entries(brands)) {
    if (b.error) continue;
    const newP = b.new_permits_count || 0;
    const upReal = (typeof b.upbyeon_count_real === 'number') ? b.upbyeon_count_real : (b.upbyeon_count || 0);
    const totalGrowth = newP + upReal;
    rows.push({
      name,
      service: b.service,
      current_count: b.current_count || 0,
      new_permits: newP,
      upbyeon: upReal,
      total_growth: totalGrowth,
      upbyeon_ratio: totalGrowth > 0 ? Math.round((upReal / totalGrowth) * 100) / 100 : 0,
      is_specialist: !!b.is_upbyeon_specialist,
    });
  }

  // view=growth: 절대 확장량 정렬 (신규+업변)
  if (view === 'growth') {
    rows.sort((a, b) => b.total_growth - a.total_growth);
    return res.status(200).json({
      updated: raw.updated, baseline_date: raw.baseline_date, current_date: raw.current_date,
      count: rows.length, items: rows.slice(0, 30),
    });
  }

  // view=upbyeon: 업변 절대량 정렬
  if (view === 'upbyeon') {
    rows.sort((a, b) => b.upbyeon - a.upbyeon);
    return res.status(200).json({
      updated: raw.updated, baseline_date: raw.baseline_date, current_date: raw.current_date,
      count: rows.length, items: rows.slice(0, 30),
    });
  }

  // view=specialist: 업변 전문 (비중 ≥ 50% AND 매장 ≥ 20 AND real ≥ 3)
  if (view === 'specialist') {
    const spec = rows.filter(r => r.is_specialist);
    spec.sort((a, b) => b.upbyeon_ratio - a.upbyeon_ratio);
    return res.status(200).json({
      updated: raw.updated, baseline_date: raw.baseline_date, current_date: raw.current_date,
      count: spec.length, items: spec,
    });
  }

  // view=cases&brand=...: brand의 업변 매장 list
  if (view === 'cases' && req.query.brand) {
    const b = brands[req.query.brand];
    if (!b) return res.status(404).json({ error: 'brand not found' });
    const real = (b.upbyeon || []).filter(u => !u.trivial);
    return res.status(200).json({
      brand: req.query.brand,
      baseline_date: raw.baseline_date,
      current_date: raw.current_date,
      count: real.length,
      items: real,
    });
  }

  // default: summary (모든 view 한 번에)
  const byGrowth = [...rows].sort((a, b) => b.total_growth - a.total_growth).slice(0, 20);
  const byUpbyeon = [...rows].sort((a, b) => b.upbyeon - a.upbyeon).slice(0, 20);
  const specialists = rows.filter(r => r.is_specialist).sort((a, b) => b.upbyeon_ratio - a.upbyeon_ratio);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json({
    updated: raw.updated,
    baseline_date: raw.baseline_date,
    current_date: raw.current_date,
    brand_total: rows.length,
    top_growth: byGrowth,
    top_upbyeon: byUpbyeon,
    specialists,
  });
}
