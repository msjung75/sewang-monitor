// api/instagram.js
// 인스타그램 해시태그 → 게시물 수집 + 매장(위치태그) 단위 집계
// ⚠️ Apify 토큰은 절대 이 파일에 넣지 마세요. Vercel 환경변수(APIFY_TOKEN)에만 저장합니다.
//
// 호출 예: /api/instagram?tags=강남이자카야,홍대와인바,와인바&limit=20
//   tags  : 해시태그 콤마 구분 (# 없이)
//   limit : 해시태그당 게시물 수 (기본 20, 최대 50)

export const config = { maxDuration: 60 }; // 인스타 actor는 보통 20~40초

export default async function handler(req, res) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'APIFY_TOKEN 환경변수가 설정되지 않았습니다. Vercel 프로젝트 설정에서 추가하세요.' });
  }

  const tags = String(req.query.tags || '')
    .split(',')
    .map((s) => s.trim().replace(/^#/, ''))
    .filter(Boolean);
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);

  if (!tags.length) {
    return res.status(400).json({ error: 'tags 파라미터가 필요합니다 (예: ?tags=강남이자카야,와인바)' });
  }

  const directUrls = tags.map(
    (t) => `https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/`
  );
  const input = { resultsType: 'posts', directUrls, resultsLimit: limit, addParentData: true };

  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${token}&clean=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    if (!r.ok) {
      return res.status(502).json({ error: 'Apify 호출 실패', status: r.status });
    }
    const posts = await r.json();

    // 매장(locationName) 단위 집계
    const groups = {};
    for (const p of posts) {
      const loc = p.locationName;
      if (!loc) continue;
      if (!groups[loc]) {
        groups[loc] = { name: loc, locationId: p.locationId || '', posts: 0, likes: 0, comments: 0 };
      }
      groups[loc].posts += 1;
      groups[loc].likes += Math.max(0, p.likesCount || 0);
      groups[loc].comments += Math.max(0, p.commentsCount || 0);
    }
    const ranking = Object.values(groups).sort(
      (a, b) => b.posts + b.likes / 100 - (a.posts + a.likes / 100)
    );

    // CDN 캐시 30분 (같은 키워드 반복 호출 시 Apify 비용 절약)
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
    return res.status(200).json({
      count: posts.length,
      ranking,
      feed: posts.map((p) => ({
        user: p.ownerUsername || '',
        caption: (p.caption || '').slice(0, 200),
        likes: Math.max(0, p.likesCount || 0),
        comments: p.commentsCount || 0,
        location: p.locationName || '',
        url: p.url || '',
        timestamp: p.timestamp || '',
        hashtags: (p.hashtags || []).slice(0, 6),
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
