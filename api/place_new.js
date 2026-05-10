// 진짜 "신규 오픈" 매장 수집 — m.search.naver.com HTML의 Apollo state에서
// "newOpening":true 플래그 직접 추출 (Naver 고유 신규 오픈 배지와 동일 기준)
// Input: GET ?region=서울&commercial=홍대&cat=이자카야

const COMMERCIALS = {
  '서울': ['홍대','강남','연남','성수','이태원','잠실','익선동','압구정','한남','신사','망원','합정','명동','종로','신촌','건대','청담','서촌','북촌','여의도'],
  '경기': ['판교','분당','일산','수원','광교','평촌','안산','하남'],
  '부산': ['해운대','광안리','서면','전포','남포동'],
  '대구': ['동성로','중구','수성'],
  '인천': ['송도','구월동'],
  '대전': ['둘산','유성'],
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

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// HTML에서 "newOpening":true 인 Place 객체 추출
function extractNewOpens(html) {
  const out = [];
  const seen = new Set();
  const decode = (s) => s.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  let pos = 0;
  while (true) {
    const idx = html.indexOf('"newOpening":true', pos);
    if (idx === -1) break;
    pos = idx + 17;
    // 이 idx 기준으로 뒤로 3000자, 앞으로 3000자 윈도우 추출
    const ctx = html.substring(Math.max(0, idx - 3000), Math.min(html.length, idx + 3000));
    // 윈도우 내에서 name, fullAddress, id, categoryName 등 추출
    const findField = (pattern) => { const m = ctx.match(pattern); return m ? decode(m[1]) : null; };
    const name = findField(/"name":"([^"\\]{1,80}(?:\\.[^"\\]{0,80})*)"/);
    const id = findField(/"id":"(\d{6,})"/);
    const fullAddress = findField(/"fullAddress":"([^"\\]{1,200}(?:\\.[^"\\]{0,200})*)"/);
    const categoryName = findField(/"categoryName":"([^"\\]{1,80})"/);
    const visitorReviewCount = findField(/"visitorReviewCount":"?([\d]+)/);
    if (!name) continue;
    const key = (id || name) + '|' + (fullAddress || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name, fullAddress, categoryName, visitorReviewCount, badge: '신규 오픈', newOpening: true });
  }
  return out;
}

async function searchNaver(query) {
  const url = `https://m.search.naver.com/search.naver?where=m&query=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' } });
  if (!r.ok) return { items: [], err: 'fetch ' + r.status };
  const html = await r.text();
  return { items: extractNewOpens(html), htmlLen: html.length };
}

export default async function handler(req, res) {
  const { region = '서울', commercial = '', cat = '', query = '', display = '30' } = req.query;
  const want = Math.max(1, Math.min(50, Number(display) || 30));

  const queries = [];
  if (query) queries.push(query);
  else if (commercial) {
    queries.push(`${commercial} 신상 ${cat || '맛집'}`);
    if (!cat) queries.push(`${commercial} 신상 술집`);
  } else if (region && COMMERCIALS[region]) {
    queries.push(`${region} 신상 ${cat || '맛집'}`);
    for (const c of COMMERCIALS[region].slice(0, 6)) queries.push(`${c} 신상 ${cat || '맛집'}`);
  } else {
    queries.push(`${region} 신상 ${cat || '맛집'}`);
  }

  try {
    const all = [];
    const seen = new Set();
    const stats = [];
    for (const q of queries.slice(0, 7)) {
      try {
        const r = await searchNaver(q);
        stats.push({ q, found: r.items.length, htmlLen: r.htmlLen, err: r.err });
        for (const it of r.items) {
          const key = (it.id || it.name) + '|' + (it.fullAddress || '');
          if (seen.has(key)) continue;
          seen.add(key);
          all.push({ ...it, name: it.name, address: it.fullAddress, category: it.categoryName, source_query: q });
        }
      } catch(e) { stats.push({ q, error: e.message }); }
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    return res.status(200).json({
      region, commercial, cat,
      queries_run: queries.length,
      new_count: all.length,
      items: all.slice(0, want),
      stats
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
