// 진짜 "신규 오픈" 배지 매장 수집 — Naver 검색 HTML 직접 스크레이프
// "서울 신상 맛집", "홍대 신상 이자카야" 같은 키워드 검색 결과에서
// "신규 오픈" 배지 있는 매장만 골라냄
// Input: GET ?region=서울&commercial=홍대&cat=이자카야  (또는 query=...)
// Output: { items: [{name, badge, source_query, ...}, ...] }

const COMMERCIALS = {
  '서울': ['홍대', '강남', '연남', '성수', '이태원', '잠실', '익선동', '압구정', '한남', '신사', '망원', '합정', '명동', '종로', '신촌', '건대', '청담', '서촌', '북촌', '여의도'],
  '경기': ['판교', '분당', '일산', '수원', '광교', '평촌', '안산', '광주'],
  '부산': ['해운대', '광안리', '서면', '전포', '남포동'],
  '대구': ['동성로', '중구', '수성'],
  '인천': ['송도', '구월동'],
  '대전': ['둔산', '유성'],
  '광주': ['상무지구', '충장로'],
  '울산': ['삼산', '성남동'],
  '세종': ['세종'],
  '강원': ['강릉', '속초', '춘천'],
  '충북': ['청주'],
  '충남': ['천안', '아산'],
  '전북': ['전주'],
  '전남': ['여수', '순천'],
  '경북': ['포항', '경주'],
  '경남': ['창원', '진주', '통영', '거제'],
  '제주': ['제주시', '서귀포']
};

// Naver 검색 결과에서 "신규 오픈" 배지를 가진 매장 추출
async function searchNaver(query) {
  const url = `https://m.search.naver.com/search.naver?where=m&sm=mtb_jum&query=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
    }
  });
  if (!r.ok) return { ok: false, status: r.status, items: [] };
  const html = await r.text();

  // "신규 오픈" 배지 찾기 - 여러 패턴 시도
  const items = [];
  const seen = new Set();
  const badgeRegexes = [
    /신규\s*오픈/g,
    /신규\s*open/gi,
    /new\s*open/gi
  ];
  
  // 배지 위치마다 주변에서 매장명 추출
  for (const re of badgeRegexes) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const pos = m.index;
      // 배지 주변 500자 윈도우에서 매장명 찾기
      const window = html.substring(Math.max(0, pos - 800), Math.min(html.length, pos + 200));
      
      // 매장명 후보: data-business-name 또는 class="name" 또는 <a><strong>
      let name = null;
      const namePatterns = [
        /data-business-name=["']([^"']+)["']/,
        /class=["'][^"']*place_name[^"']*["'][^>]*>([^<]+)</,
        /class=["'][^"']*name[^"']*["'][^>]*>([^<]+)</,
        /<strong[^>]*>([^<]{2,40})<\/strong>/,
        /title=["']([^"']{2,40})["']/
      ];
      for (const np of namePatterns) {
        const nm = window.match(np);
        if (nm && nm[1]) {
          const candidate = nm[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
          if (candidate.length >= 2 && candidate.length <= 50 && !seen.has(candidate)) {
            name = candidate;
            break;
          }
        }
      }
      
      if (name) {
        seen.add(name);
        // 추가 메타 추출 (카테고리/주소)
        const catMatch = window.match(/class=["'][^"']*category[^"']*["'][^>]*>([^<]+)</);
        const addrMatch = window.match(/class=["'][^"']*addr[^"']*["'][^>]*>([^<]+)</);
        items.push({
          name,
          badge: '신규 오픈',
          source_query: query,
          category: catMatch ? catMatch[1].trim() : null,
          address: addrMatch ? addrMatch[1].trim() : null
        });
      }
    }
  }
  
  return { ok: true, badgeCount: items.length, items, htmlLen: html.length };
}

export default async function handler(req, res) {
  const { region = '서울', commercial = '', cat = '', query = '', debug = '' } = req.query;
  
  // 검색 키워드 빌드
  const queries = [];
  if (query) {
    queries.push(query);
  } else if (commercial) {
    // 상권 정밀 검색
    queries.push(`${commercial} 신상 ${cat || '맛집'}`);
    if (!cat) queries.push(`${commercial} 신상 이자카야`);
  } else if (region && COMMERCIALS[region]) {
    // 시도 광역 검색 — 상위 6개 상권 자동 순회
    const tops = COMMERCIALS[region].slice(0, 6);
    queries.push(`${region} 신상 ${cat || '맛집'}`);
    for (const c of tops) queries.push(`${c} 신상 ${cat || '맛집'}`);
  } else {
    queries.push(`${region || '서울'} 신상 맛집`);
  }
  
  try {
    // 순차로 호출 (Naver rate limit 보호) - 최대 7개 쿼리
    const allItems = [];
    const seen = new Set();
    const queryStats = [];
    
    for (const q of queries.slice(0, 7)) {
      try {
        const result = await searchNaver(q);
        queryStats.push({ query: q, ok: result.ok, badgeCount: result.badgeCount || 0, htmlLen: result.htmlLen || 0 });
        if (result.items && result.items.length > 0) {
          for (const it of result.items) {
            const key = it.name + '|' + (it.address || '');
            if (seen.has(key)) continue;
            seen.add(key);
            allItems.push(it);
          }
        }
      } catch(e) {
        queryStats.push({ query: q, error: e.message });
      }
    }
    
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    const response = {
      region, commercial, cat,
      query_count: queries.length,
      new_count: allItems.length,
      items: allItems,
      stats: queryStats
    };
    
    // debug 모드: 첫 쿼리의 HTML 일부 반환
    if (debug === '1' && queries[0]) {
      try {
        const debugUrl = `https://m.search.naver.com/search.naver?where=m&sm=mtb_jum&query=${encodeURIComponent(queries[0])}`;
        const r = await fetch(debugUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          }
        });
        const dHtml = await r.text();
        // "신규" 가 있는 부분 주변 추출
        const idx = dHtml.indexOf('신규');
        response.debug_html = {
          length: dHtml.length,
          first_sin_index: idx,
          excerpt: idx >= 0 ? dHtml.substring(Math.max(0, idx - 500), Math.min(dHtml.length, idx + 1500)) : dHtml.substring(0, 2000)
        };
      } catch(e) { response.debug_error = e.message; }
    }
    
    return res.status(200).json(response);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
