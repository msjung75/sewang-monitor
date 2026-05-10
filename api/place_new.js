// '신규 오픈' 매장 수집 — Naver Open API local + 매장별 첫 블로그 후기로 등록일 검증
// Vercel 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
// Input: GET ?region=서울&commercial=홍대&cat=이자카야&maxAge=30
// Output: { items: [{name, address, badge, age_days, first_blog_date, ...}, ...] }

const COMMERCIALS = {
  '서울': ['홍대','강남','연남','성수','이태원','잠실','익선동','압구정','한남','신사','망원','합정','명동','종로','신촌','건대','청담','서촌','북촌','여의도'],
  '경기': ['판교','분당','일산','수원','광교','평촌','안산','하남'],
  '부산': ['해운대','광안리','서면','전포','남포동'],
  '대구': ['동성로','중구','수성'],
  '인천': ['송도','구월동'],
  '대전': ['둔산','유성'],
  '광주': ['상무지구','충장로'],
  '울산': ['삼산','성남동'],
  '강원': ['강릉','속초','춘천'],
  '충북': ['청주'],
  '충남': ['천안','아산'],
  '전북': ['전주'],
  '전남': ['여수','순천'],
  '경북': ['포항','경주'],
  '경남': ['창원','진주','통영','거제'],
  '제주': ['제주시','서귀포']
};

function stripTags(s) { return (s || '').replace(/<\/?[^>]+>/g, ''); }

async function searchLocal(query, headers) {
  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&sort=comment&display=15`;
  const r = await fetch(url, { headers });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.items || []).map(it => ({ ...it, _source: query }));
}

async function getStoreAge(storeName, headers) {
  const blogUrl = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(storeName)}&sort=sim&display=20`;
  try {
    const r = await fetch(blogUrl, { headers });
    if (!r.ok) return { ageDays: null, firstYmd: null, postCount: 0 };
    const data = await r.json();
    const dates = (data.items || []).map(it => it.postdate).filter(d => d && /^\d{8}$/.test(d));
    if (dates.length === 0) return { ageDays: null, firstYmd: null, postCount: 0 };
    const firstYmd = [...dates].sort()[0];
    const firstDate = new Date(Number(firstYmd.slice(0,4)), Number(firstYmd.slice(4,6))-1, Number(firstYmd.slice(6,8)));
    return { ageDays: Math.floor((Date.now() - firstDate) / 86400000), firstYmd, postCount: dates.length };
  } catch(e) { return { ageDays: null, firstYmd: null, postCount: 0 }; }
}

export default async function handler(req, res) {
  const { region = '서울', commercial = '', cat = '', query = '', maxAge = '30', display = '20' } = req.query;
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return res.status(500).json({ error: 'NAVER env 미설정' });
  const headers = { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret };
  const maxAgeDays = Math.max(1, Math.min(365, Number(maxAge) || 30));
  const want = Math.max(1, Math.min(50, Number(display) || 20));

  const queries = [];
  if (query) queries.push(query);
  else if (commercial) {
    queries.push(`${commercial} 신상 ${cat || '맛집'}`);
    if (!cat) queries.push(`${commercial} 신상 술집`);
  } else if (region && COMMERCIALS[region]) {
    const tops = COMMERCIALS[region].slice(0, 5);
    queries.push(`${region} 신상 ${cat || '맛집'}`);
    for (const c of tops) queries.push(`${c} 신상 ${cat || '맛집'}`);
  } else queries.push(`${region} 신상 ${cat || '맛집'}`);

  try {
    const allPlaces = [];
    const seen = new Set();
    const queryStats = [];
    for (const q of queries.slice(0, 8)) {
      try {
        const places = await searchLocal(q, headers);
        queryStats.push({ q, found: places.length });
        for (const p of places) {
          const name = stripTags(p.title);
          const key = name + '|' + (p.roadAddress || p.address || '');
          if (seen.has(key)) continue;
          seen.add(key);
          allPlaces.push({ ...p, _name: name });
        }
      } catch(e) { queryStats.push({ q, error: e.message }); }
    }

    const results = [];
    let idx = 0;
    const concurrency = 5;
    const worker = async () => {
      while (idx < allPlaces.length && results.length < want * 2) {
        const place = allPlaces[idx++];
        const storeName = place._name;
        const ageInfo = await getStoreAge(storeName, headers);
        const isNewOpen = ageInfo.postCount === 0 || (ageInfo.ageDays !== null && ageInfo.ageDays <= maxAgeDays);
        if (!isNewOpen) continue;
        results.push({
          name: storeName, address: place.roadAddress || place.address,
          category: place.category, telephone: place.telephone,
          mapx: place.mapx, mapy: place.mapy, link: place.link,
          first_blog_date: ageInfo.firstYmd ? `${ageInfo.firstYmd.slice(0,4)}-${ageInfo.firstYmd.slice(4,6)}-${ageInfo.firstYmd.slice(6,8)}` : null,
          age_days: ageInfo.ageDays, post_count: ageInfo.postCount,
          badge: ageInfo.postCount === 0 ? '신규 등록' : '신규 오픈',
          source_query: place._source
        });
      }
    };
    const ws = [];
    for (let i = 0; i < concurrency; i++) ws.push(worker());
    await Promise.all(ws);

    results.sort((a, b) => {
      if (a.age_days === null && b.age_days === null) return 0;
      if (a.age_days === null) return -1;
      if (b.age_days === null) return 1;
      return a.age_days - b.age_days;
    });
    const final = results.slice(0, want);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    return res.status(200).json({
      region, commercial, cat, maxAgeDays,
      queries_run: queries.length, candidates: allPlaces.length, new_count: final.length,
      items: final, stats: queryStats
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
