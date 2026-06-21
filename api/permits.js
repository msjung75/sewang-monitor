// 행안부 지방행정 인허가 데이터(data.go.kr) 신규/폐업/변경 조회 프록시
// 일반음식점 / 휴게음식점 / 단란주점 / 유흥주점 인허가 조회
// 데이터는 매일 갱신, 2일 전 기준 현행화
// 파라미터:
//   - days(기본7) 또는 from/to(YYYYMMDD, to는 미만조건)
//   - region: seoul / gyeonggi / metro / all 등
//   - type: ilban / hyuge / danran / yuheung / all
//   - dateField: permit(default, 인허가일) | closed(폐업일) | modified(데이터 갱신일 - 상호변경 등)
//   - maxPages: 페이지 수 (default 5, max 50)
//   - status: open(default) | closed | all

const SERVICES = {
  ilban:   { base: 'general_restaurants', label: '일반음식점' },
  hyuge:   { base: 'rest_cafes',          label: '휴게음식점' },
  danran:  { base: 'singing_bars',        label: '단란주점' },
  yuheung: { base: 'entertainment_bars',  label: '유흥주점' },
};

const REGION_PREFIX = {
  seoul:    ['서울특별시'],
  busan:    ['부산광역시'],
  daegu:    ['대구광역시'],
  incheon:  ['인천광역시'],
  gwangju:  ['광주광역시'],
  daejeon:  ['대전광역시'],
  ulsan:    ['울산광역시'],
  sejong:   ['세종특별자치시'],
  gyeonggi: ['경기도'],
  gangwon:  ['강원특별자치도'],
  chungbuk: ['충청북도'],
  chungnam: ['충청남도'],
  jeonbuk:  ['전북특별자치도'],
  jeonnam:  ['전라남도'],
  gyeongbuk:['경상북도'],
  gyeongnam:['경상남도'],
  jeju:     ['제주특별자치도'],
  metro:    ['서울특별시', '경기도', '인천광역시'],
  all: [
    '서울특별시','경기도','부산광역시','대구광역시','인천광역시','광주광역시',
    '대전광역시','울산광역시','세종특별자치시','강원특별자치도','충청북도',
    '충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도',
  ],
};

// v17.16: dateField=modified 시 사용할 컬럼명 (행안부 데이터 갱신일자)
const DATE_COLS = {
  permit:   'LCPMT_YMD',
  closed:   'CLSBIZ_YMD',
  modified: 'LASTMODTS',
};

export default async function handler(req, res) {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) return res.status(500).json({ error: 'DATA_GO_KR_KEY 미설정' });

  const { days = '7', region = 'metro', type = 'all', from = '', to = '', status: statusFilter = 'open', dateField = 'permit' } = req.query;
  const maxPages = Math.min(parseInt(req.query.maxPages || '5', 10), 50);

  if (!DATE_COLS[dateField]) {
    return res.status(400).json({ error: `dateField 파라미터 오류 (permit|closed|modified)` });
  }

  let since, until = '';
  if (/^\d{8}$/.test(from)) {
    since = from;
    if (/^\d{8}$/.test(to)) until = to;
  } else {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    d.setUTCDate(d.getUTCDate() - Math.min(parseInt(days, 10) || 7, 365));
    since = d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  const types = type === 'all'
    ? Object.keys(SERVICES)
    : String(type).split(',').filter(t => SERVICES[t]);
  if (!types.length) return res.status(400).json({ error: 'type 파라미터 오류' });
  const prefixes = REGION_PREFIX[region] || REGION_PREFIX.metro;

  const jobs = [];
  for (const t of types) for (const p of prefixes) jobs.push(fetchService(t, p, since, until, key, maxPages, dateField));

  try {
    const results = await Promise.all(jobs);
    const seen = new Set();
    let capped = false;
    results.forEach(r => { if (r.capped) capped = true; });
    const items = results.map(r => r.items).flat()
      .filter(it => {
        if (!it.id || seen.has(it.id)) return false;
        seen.add(it.id);
        return true;
      })
      .filter(it => {
        const st = it.status || '';
        const isClosed = /폐업|취소|말소|중지|휴업/.test(st);
        if (statusFilter === 'all') return true;
        if (statusFilter === 'closed') return isClosed;
        return !isClosed;
      });

    // v17.16: dateField에 따라 다른 컬럼으로 정렬
    const sortKey = dateField === 'modified' ? 'modifiedDate' : (dateField === 'closed' ? 'closedDate' : 'permitDate');
    items.sort((a, b) => (b[sortKey] || '').localeCompare(a[sortKey] || ''));

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
    return res.status(200).json({ since, until, dateField, count: items.length, capped, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function fetchService(typeKey, addrPrefix, since, until, key, maxPages, dateField) {
  const svc = SERVICES[typeKey];
  const all = [];
  let capped = false;
  const dateCol = DATE_COLS[dateField];

  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      serviceKey: key,
      pageNo: String(page),
      numOfRows: '100',
      returnType: 'json',
    });
    qs.append(`cond[${dateCol}::GTE]`, since);
    if (until) qs.append(`cond[${dateCol}::LT]`, until);
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
      const cd = String(it.CLSBIZ_YMD || '').replace(/[^0-9]/g, '').slice(0, 8);
      // v17.16: LASTMODTS는 보통 YYYYMMDDHHMMSS 또는 YYYY-MM-DD 형태
      const md = String(it.LASTMODTS || it.LCMODY_DT || '').replace(/[^0-9]/g, '').slice(0, 8);
      all.push({
        id: it.MNG_NO || ((it.BPLC_NM || '') + pd),
        name: it.BPLC_NM || '',
        type: typeKey,
        typeLabel: svc.label,
        upte: it.SNTTN_BZSTAT_NM || '',
        permitDate: pd,
        closedDate: cd,
        modifiedDate: md, // v17.16: 데이터 갱신일자
        status: it.DTL_SALS_STTS_NM || it.SALS_STTS_NM || '',
        addr: it.ROAD_NM_ADDR || it.LOTNO_ADDR || '',
        tel: it.TELNO || '',
        area: it.FCLT_TOTAL_SCL || '',
      });
    }

    const total = Number(body.totalCount || 0);
    if (page * 100 >= total || arr.length < 100) break;
    if (page === maxPages && total > maxPages * 100) capped = true;
  }
  return { items: all, capped };
}
