// api/apify_naver_result.js
// 네이버 정밀 스캔 "결과 조회" 엔드포인트 (폴링용)
// /api/apify_naver_start 가 돌려준 runId, datasetId 로 호출한다.
//
// 호출 예: /api/apify_naver_result?runId=xxxx&datasetId=yyyy
// 응답: { status: 'RUNNING' | 'SUCCEEDED' | ..., items: [...] }
//   status가 SUCCEEDED 가 될 때까지 프론트가 5초 간격으로 재호출.

export const config = { maxDuration: 30 };

const ALCOHOL = ['사케','니혼슈','와인','샴페인','위스키','버번','싱글몰트','맥주','생맥주','수제맥주','크래프트','하이볼','진토닉','보드카','데킬라','럼','칵테일','막걸리','청주','소주','전통주','우메슈','매실주'];

export default async function handler(req, res) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(500).json({ error: 'APIFY_TOKEN 미설정' });

  const runId = String(req.query.runId || '');
  const datasetId = String(req.query.datasetId || '');
  if (!runId) return res.status(400).json({ error: 'runId 필요' });

  try {
    // 1) run 상태 확인
    const runR = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    const runData = (await runR.json()).data;
    const status = runData.status;

    if (status !== 'SUCCEEDED') {
      return res.status(200).json({ status, items: [] });
    }

    // 2) 완료됐으면 데이터셋에서 필요한 필드만 가져옴
    const dsId = datasetId || runData.defaultDatasetId;
    const fields = 'name,category,roadAddress,visitorReviewsTotal,blogReviewTotal,reviewMenus';
    const dsR = await fetch(
      `https://api.apify.com/v2/datasets/${dsId}/items?token=${token}&clean=true&limit=200&fields=${fields}`
    );
    const rows = await dsR.json();

    const items = rows.map((p) => {
      const menus = p.reviewMenus || [];
      const alc = menus.filter((m) => ALCOHOL.some((k) => (m.label || '').includes(k)));
      const alcTotal = alc.reduce((s, m) => s + (m.count || 0), 0);
      return {
        name: p.name,
        category: p.category || '미분류',
        address: p.roadAddress || '',
        reviews: p.visitorReviewsTotal || 0,
        blogReviews: p.blogReviewTotal || 0,
        isNew: (p.visitorReviewsTotal || 0) > 0 && (p.visitorReviewsTotal || 0) <= 100,
        isHot: (p.visitorReviewsTotal || 0) >= 500,
        alcoholSignal: alcTotal,
        topAlcoholMenus: alc.slice(0, 5).map((m) => `${m.label} ${m.count}`),
      };
    }).sort((a, b) => b.alcoholSignal - a.alcoholSignal);

    return res.status(200).json({ status: 'SUCCEEDED', count: items.length, items });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
