// api/apify_naver_start.js
// 네이버 플레이스 정밀 스캔 "시작" 엔드포인트 (비동기)
// 네이버 actor는 1~3분 걸려 서버리스 1회 호출 제한을 넘기므로,
// 여기서는 run을 시작만 하고 runId/datasetId를 즉시 돌려준다.
// 그 다음 프론트엔드가 /api/apify_naver_result?runId=... 를 폴링한다.
//
// 호출 예: /api/apify_naver_start?keywords=강남 신규오픈 이자카야,홍대 신규오픈 와인바&max=6

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'APIFY_TOKEN 환경변수가 설정되지 않았습니다.' });
  }

  const keywords = String(req.query.keywords || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const max = Math.min(parseInt(req.query.max || '6', 10) || 6, 20);

  if (!keywords.length) {
    return res.status(400).json({ error: 'keywords 파라미터가 필요합니다.' });
  }

  const input = { searchKeywords: keywords, maxResultsPerKeyword: max, includeReviews: false };

  try {
    // 비동기 실행: 즉시 run 객체 반환 (완료 대기 안 함)
    const r = await fetch(
      `https://api.apify.com/v2/acts/huggable_quote~naver-map-scraper/runs?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    const data = await r.json();
    const run = data.data || data;
    return res.status(200).json({
      runId: run.id,
      datasetId: run.defaultDatasetId,
      status: run.status,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
