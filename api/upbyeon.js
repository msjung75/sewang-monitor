// 업변(상호변경) 매장 데이터 서빙 프록시.
// data/upbyeon_2026.json 을 읽어서 클라이언트가 쓰기 좋게 가공해서 반환.
// nightly-upbyeon workflow가 매일 새벽 갱신.
//
// v2 (2026-08-08): brand_overrides.upbyeon_overrides 적용.
//   실제로는 재간판이 아니라 "공실 후 재오픈"·"인수 신규"인 케이스를
//   사장님이 검증해서 override로 태깅 → 클라이언트에게 override_type 전달.

import fs from 'fs';
import path from 'path';

function loadOverrides() {
  try {
    const p = path.join(process.cwd(), 'data', 'brand_overrides.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return raw.upbyeon_overrides || {};
  } catch {
    return {};
  }
}

// 오버라이드 타입별 라벨
const OVERRIDE_LABEL = {
  reopened: '폐업 후 재개장',
  reopened_new_owner: '공실 후 새 오너',
  new_owner: '인수 신규',
  not_upbyeon: '업변 아님',
};

function applyOverrides(items, overrides) {
  return items.map(u => {
    const ov = overrides[u.mng_no];
    if (ov) {
      return {
        ...u,
        override_type: ov.type,
        override_label: OVERRIDE_LABEL[ov.type] || ov.type,
        override_note: ov.note,
        override_by: ov.verified_by,
        override_at: ov.at,
        excluded_from_upbyeon: ov.type !== 'pure_rename',
      };
    }
    return { ...u, override_type: null };
  });
}

export default function handler(req, res) {
  const file = path.join(process.cwd(), 'data', 'upbyeon_2026.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return res.status(500).json({ error: 'upbyeon data unavailable', detail: e.message });
  }

  const overrides = loadOverrides();
  const brands = raw.brands || {};
  const view = req.query.view || 'summary';

  // brand 별 요약 array — override 적용해서 real count 조정
  const rows = [];
  for (const [name, b] of Object.entries(brands)) {
    if (b.error) continue;
    const newP = b.new_permits_count || 0;
    const upbyeonList = (b.upbyeon || []).filter(u => !u.trivial);
    // Override로 excluded된 것 제외
    const overriddenExcluded = upbyeonList.filter(u => {
      const ov = overrides[u.mng_no];
      return ov && ov.type !== 'pure_rename';
    }).length;
    const upReal = Math.max(0, upbyeonList.length - overriddenExcluded);
    const totalGrowth = newP + upReal;
    rows.push({
      name,
      service: b.service,
      current_count: b.current_count || 0,
      new_permits: newP,
      upbyeon: upReal,
      upbyeon_override_excluded: overriddenExcluded,
      total_growth: totalGrowth,
      upbyeon_ratio: totalGrowth > 0 ? Math.round((upReal / totalGrowth) * 100) / 100 : 0,
      is_specialist: !!b.is_upbyeon_specialist && upReal >= 3,
    });
  }

  if (view === 'growth') {
    rows.sort((a, b) => b.total_growth - a.total_growth);
    return res.status(200).json({
      updated: raw.updated, baseline_date: raw.baseline_date, current_date: raw.current_date,
      count: rows.length, items: rows.slice(0, 30),
    });
  }
  if (view === 'upbyeon') {
    rows.sort((a, b) => b.upbyeon - a.upbyeon);
    return res.status(200).json({
      updated: raw.updated, baseline_date: raw.baseline_date, current_date: raw.current_date,
      count: rows.length, items: rows.slice(0, 30),
    });
  }
  if (view === 'specialist') {
    const spec = rows.filter(r => r.is_specialist);
    spec.sort((a, b) => b.upbyeon_ratio - a.upbyeon_ratio);
    return res.status(200).json({
      updated: raw.updated, baseline_date: raw.baseline_date, current_date: raw.current_date,
      count: spec.length, items: spec,
    });
  }

  if (view === 'cases' && req.query.brand) {
    const b = brands[req.query.brand];
    if (!b) return res.status(404).json({ error: 'brand not found' });
    const real = (b.upbyeon || []).filter(u => !u.trivial);
    const enriched = applyOverrides(real, overrides);
    return res.status(200).json({
      brand: req.query.brand,
      baseline_date: raw.baseline_date,
      current_date: raw.current_date,
      count: enriched.length,
      count_pure_rename: enriched.filter(u => !u.excluded_from_upbyeon).length,
      count_overridden: enriched.filter(u => u.excluded_from_upbyeon).length,
      items: enriched,
    });
  }

  const byGrowth = [...rows].sort((a, b) => b.total_growth - a.total_growth).slice(0, 20);
  const byUpbyeon = [...rows].sort((a, b) => b.upbyeon - a.upbyeon).slice(0, 20);
  const specialists = rows.filter(r => r.is_specialist).sort((a, b) => b.upbyeon_ratio - a.upbyeon_ratio);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json({
    updated: raw.updated,
    baseline_date: raw.baseline_date,
    current_date: raw.current_date,
    brand_total: rows.length,
    overrides_applied: Object.keys(overrides).length,
    top_growth: byGrowth,
    top_upbyeon: byUpbyeon,
    specialists,
  });
}
