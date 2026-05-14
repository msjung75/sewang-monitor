// 진짜 "신규 오픈" 매장 수집 — m.search.naver.com HTML의 Apollo state에서
// "newOpening":true 플래그 직접 추출 (Naver 고유 신규 오픈 배지와 동일 기준)
// v2: DetailCid.c0 카테고리 코드 매핑, 주류 도매 관점 쿼리 풀 확장, maxAge·cat 필터
// Input: GET ?region=서울&commercial=홍대&cat=이자카야&maxAge=60&display=30

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

// 주류 도매 관점 추가 카테고리 (상권별로 순회)
const LIQUOR_CATEGORIES = ['이자카야','와인바','맥주집','꼬치','한식주점','펍','사케바','위스키바'];

// Naver DetailCid → 한국어 카테고리 매핑 (관찰된 코드)
const CATEGORY_CODE_MAP = {
  '220036':'한식','220037':'중식','220038':'양식','220039':'아시안','220040':'카페',
  '220041':'디저트','220042':'베이커리','220043':'분식','220044':'뷔페',
  '220045':'일식','220046':'치킨','220047':'피자','220048':'햄버거',
  '220049':'고기','220050':'회/해산물','220051':'닭/오리','220052':'족발/보쌈',
  '220053':'곱창','220054':'국밥','220055':'면','220056':'죽','220057':'백반',
  '220141':'주점','220142':'술집','220143':'이자카야','220144':'와인바',
  '220145':'맥주','220146':'바','220147':'호프','220148':'포차'
};

// cat 키워드 → 코드 셋 (필터링용)
const KEYWORD_TO_CODES = {
  '이자카야': new Set(['220143','220045']),
  '와인바': new Set(['220144']),
  '맥주': new Set(['220145','220147']),
  '주점': new Set(['220141','220142','220148']),
  '한식': new Set(['220036']),
  '일식': new Set(['220045','220143']),
  '중식': new Set(['220037']),
  '양식': new Set(['220038']),
  '바': new Set(['220146','220144'])
};

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function codesToKorean(codeStr) {
  if (!codeStr) return null;
  const codes = codeStr.split(/[\/,]/).map(c => c.trim()).filter(Boolean);
  for (const c of codes) {
    if (CATEGORY_CODE_MAP[c]) return CATEGORY_CODE_MAP[c];
  }
  return codes[0] ? `코드:${codes[0]}` : null;
}

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
    const ctx = html.substring(Math.max(0, idx - 3000), Math.min(html.length, idx + 3000));
    const findField = (pattern) => { const m = ctx.match(pattern); return m ? decode(m[1]) : null; };
    const name = findField(/"name":"([^"\\]{1,80}(?:\\.[^"\\]{0,80})*)"/);
    const id = findField(/"id":"(\d{6,})"/);
    const fullAddress = findField(/"fullAddress":"([^"\\]{1,200}(?:\\.[^"\\]{0,200})*)"/);
    // 이전 스키마 — categoryName 필드 (현재는 거의 항상 null)
    let categoryName = findField(/"categoryName":"([^"\\]{1,80})"/);
    // 새 스키마 — DetailCid.c0 코드 문자열 (예: "220036/220045/220141")
    const c0Raw = findField(/"_typename":"DetailCid","c0":"([^"]{1,120})"/) ||
                  findField(/"c0":"([0-9\\u002F\/,]{6,120})"/);
    const categoryCode = c0Raw ? c0Raw.replace(/\\u002F/g, '/') : null;
    if (!categoryName && categoryCode) {
      categoryName = codesToKorean(categoryCode);
    }
    const visitorReviewCount = findField(/"visitorReviewCount":"?([\d]+)/);
    if (!name) continue;
    const key = (id || name) + '|' + (fullAddress || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id, name, fullAddress,
      categoryName,
      categoryCode,
      visitorReviewCount,
      badge: '신규 오픈',
      newOpening: true
    });
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
  const { region = '서울', commercial = '', cat = '', query = '', display = '30', maxAge = '' } = req.query;
  const want = Math.max(1, Math.min(50, Number(display) || 30));
  const maxAgeNum = maxAge ? Math.max(1, Number(maxAge)) : null;

  const queries = [];
  if (query) {
    queries.push(query);
  } else if (commercial) {
    queries.push(`${commercial} 신상 ${cat || '맛집'}`);
    if (!cat) {
      queries.push(`${commercial} 신상 술집`);
      queries.push(`${commercial} 이자카야`);
      queries.push(`${commercial} 와인바`);
    }
  } else if (region && COMMERCIALS[region]) {
    queries.push(`${region} 신상 ${cat || '맛집'}`);
    for (const c of COMMERCIALS[region].slice(0, 6)) {
      queries.push(`${c} 신상 ${cat || '맛집'}`);
    }
    if (!cat) {
      const rotation = LIQUOR_CATEGORIES.slice(0, 5);
      const spots = COMMERCIALS[region];
      for (let i = 0; i < rotation.length; i++) {
        const spot = spots[i % spots.length];
        queries.push(`${spot} ${rotation[i]}`);
      }
    }
  } else {
    queries.push(`${region} 신상 ${cat || '맛집'}`);
  }

  const catCodes = cat && KEYWORD_TO_CODES[cat] ? KEYWORD_TO_CODES[cat] : null;

  try {
    const all = [];
    const seen = new Set();
    const stats = [];
    for (const q of queries.slice(0, 13)) {
      try {
        const r = await searchNaver(q);
        stats.push({ q, found: r.items.length, htmlLen: r.htmlLen, err: r.err });
        for (const it of r.items) {
          const key = (it.id || it.name) + '|' + (it.fullAddress || '');
          if (seen.has(key)) continue;
          if (catCodes && it.categoryCode) {
            const codes = it.categoryCode.split(/[\/,]/).map(c => c.trim());
            if (!codes.some(c => catCodes.has(c))) continue;
          }
          seen.add(key);
          all.push({
            ...it,
            name: it.name,
            address: it.fullAddress,
            category: it.categoryName,
            source_query: q
          });
        }
      } catch(e) { stats.push({ q, error: e.message }); }
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    return res.status(200).json({
      region, commercial, cat,
      maxAge: maxAgeNum,
      queries_run: queries.length,
      candidates: all.length,
      new_count: all.length,
      items: all.slice(0, want),
      stats,
      schema_version: 'v2'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
