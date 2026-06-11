// 행안부 지방행정 인허가 데이터(data.go.kr) 신규 업장 조회 프록시
// 일반음식점 / 휴게음식점 / 단란주점 / 유흥주점 신규 인허가 조회
// 데이터는 매일 갱신, 2일 전 기준 현행화

const SERVICES = {
  ilban:   { base: 'general_restaurants', label: '일반음식점' },
  hyuge:   { base: 'rest_cafes',          label: '휴게음식점' },
  danran:  { base: 'singing_bars',        label: '단란주점' },
  yuheung: { base: 'entertainment_bars',  label: '유흥주점' },
};

const REGION_PREFIX = {
  seoul:    ['서울특별시'],
  gyeonggi: ['경기도'],
  metro:    ['서울특별시', '경기도'],
  all:      [''],
};

export default async function handler(req, res) {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) return res.status(500).json({ error: 'DATA_GO_KR_KEY 미설정' });

  const { days = '7', region = 'metro', type = 'all' } = req.query;
  const maxPages = Math.min(parseInt(req.query.maxPages || '3', 10), 5);

  // KST 기준 N일 전 날짜 (YYYYMMDD)
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - Math.min(parseInt(days, 10) || 7, 90));
  const since = d.toISOString().slice(0, 10).replace(/-/g, '');

  const types = type === 'all'
    ? Object.keys(SERVICES)
    : String(type).split(',').filter(t => SERVICES[t]);
  if (!types.length) return res.status(400).json({ error: 'type 파라미터 오류' });
  const prefixes = REGION_PREFIX[region] || REGION_PREFIX.metro;

  const jobs = [];
  for (const t of types) for (const p of prefixes) jobs.push(fetchService(t, p, since, key, maxPages));

  try {
    const results = await Promise.all(jobs);
    const seen = new Set();
    const items = results.flat()
      .filter(it => {
        if (!it.id || seen.has(it.id)) return false;
        seen.add(it.id);
        return true;
      })
      .filter(it => !/폐업|취소|말소|중지|휴업/.test(it.status || ''))
      .sort((a, b) => (b.permitDate || '').localeCompare(a.permitDate || ''));
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
    return res.status(200).json({ since, count: items.length, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function fetchService(typeKey, addrPrefix, since, key, maxPages) {
  const svc = SERVICES[typeKey];
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      serviceKey: key,
      pageNo: String(page),
      numOfRows: '100',
      returnType: 'json',
    });
    qs.append('cond[LCPMT_YMD::GTE]', since);
    if (addrPrefix) qs.append('cond[ROAD_NM_ADDR::LIKE]', addrPrefix);
    const url = `https://apis.data.go.kr/1741000/${svc.base}/info?${qs.toString()}`;

    let data;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await r.text();
      data = JSON.parse(text);
    } catch (e) { break; }

    const body = data && data.response && data.response.body;
    if (!body) break;
    let arr = (body.items && body.items.item) || body.items || [];
    if (!Array.isArray(arr)) arr = arr ? [arr] : [];

    for (const it of arr) {
      const pd = String(it.LCPMT_YMD || '').replace(/[^0-9]/g, '').slice(0, 8);
      all.push({
        id: it.MNG_NO || ((it.BPLC_NM || '') + pd),
        name: it.BPLC_NM || '',
        type: typeKey,
        typeLabel: svc.label,
        upte: it.SNTTN_BZSTAT_NM || '',
        permitDate: pd,
        status: it.DTL_SALS_STTS_NM || it.SALS_STTS_NM || '',
        addr: it.ROAD_NM_ADDR || it.LOTNO_ADDR || '',
        tel: it.TELNO || '',
        area: it.FCLT_TOTAL_SCL || '',
      });
    }

    const total = Number(body.totalCount || 0);
    if (page * 100 >= total || arr.length < 100) break;
  }
  return all;
}
