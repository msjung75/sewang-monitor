// 진단용 — 여러 Naver endpoint 프로브해서 "신규 오픈" 데이터 출처 찾기
// /api/place_diag?query=서울 신상 맛집

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function probe(name, url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    const txt = await r.text();
    const newOpen = (txt.match(/신규\s*오픈/g) || []).length;
    const isNew = (txt.match(/newOpen|isNew[A-Z]|newBusiness|openDate|businessOpenDate/g) || []).slice(0,10);
    const len = txt.length;
    let snip = '';
    if (newOpen > 0) {
      const idx = txt.search(/신규\s*오픈/);
      snip = txt.substring(Math.max(0,idx-600), Math.min(txt.length, idx+1000));
    } else if (isNew.length > 0) {
      const idx = txt.search(/newOpen|isNew[A-Z]|newBusiness|openDate/);
      snip = txt.substring(Math.max(0,idx-200), Math.min(txt.length, idx+800));
    } else {
      snip = txt.substring(0, 500);
    }
    return { name, url, status: r.status, len, newOpenCount: newOpen, isNewMatches: isNew, snippet: snip };
  } catch(e) { return { name, url, error: e.message }; }
}

export default async function handler(req, res) {
  const { query = '서울 신상 맛집' } = req.query;
  const q = encodeURIComponent(query);
  const probes = [
    ['m_search_mobile', `https://m.search.naver.com/search.naver?where=m&query=${q}`, { headers: { 'User-Agent': UA_MOBILE } }],
    ['search_pc', `https://search.naver.com/search.naver?query=${q}`, { headers: { 'User-Agent': UA_DESKTOP } }],
    ['map_allSearch', `https://map.naver.com/p/api/search/allSearch?query=${q}&type=all&searchCoord=126.978%3B37.566`, { headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://map.naver.com/' } }],
    ['pcmap_restaurant_list', `https://pcmap.place.naver.com/restaurant/list?query=${q}`, { headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://map.naver.com/' } }],
    ['m_place_restaurant_list', `https://m.place.naver.com/restaurant/list?query=${q}`, { headers: { 'User-Agent': UA_MOBILE, 'Referer': 'https://m.search.naver.com/' } }],
    ['search_p_csearch', `https://m.search.naver.com/p/csearch/dcontent/external_api/restaurant.naver?query=${q}`, { headers: { 'User-Agent': UA_MOBILE } }],
    ['map_p_api_search', `https://map.naver.com/p/api/search/instant-search?query=${q}`, { headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://map.naver.com/' } }],
  ];
  const results = await Promise.all(probes.map(([n,u,o]) => probe(n,u,o)));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ query, results });
}
