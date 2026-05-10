// YouTube Data API v3 검색 + 통계 합본 프록시
export default async function handler(req, res) {
  const { query, order = 'date', max_results = 12 } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(503).json({
    error: 'YOUTUBE_API_KEY 미설정',
    items: []
  });

  try {
    const sUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&order=${order}&maxResults=${max_results}&regionCode=KR&key=${key}`;
    const sRes = await fetch(sUrl);
    if (!sRes.ok) {
      const txt = await sRes.text();
      return res.status(sRes.status).json({ error: 'youtube search error', detail: txt, items: [] });
    }
    const sData = await sRes.json();
    const items = (sData.items || []).map(i => ({
      videoId: i.id?.videoId,
      title: i.snippet?.title,
      description: i.snippet?.description,
      publishedAt: i.snippet?.publishedAt,
      channelTitle: i.snippet?.channelTitle,
      thumbnail: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.high?.url,
    })).filter(i => i.videoId);

    if (items.length > 0) {
      const ids = items.map(i => i.videoId).join(',');
      const dUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${key}`;
      try {
        const dRes = await fetch(dUrl);
        if (dRes.ok) {
          const dData = await dRes.json();
          const statMap = {};
          (dData.items || []).forEach(d => { statMap[d.id] = d.statistics; });
          items.forEach(i => {
            const s = statMap[i.videoId];
            if (s) {
              i.viewCount = parseInt(s.viewCount, 10) || 0;
              i.likeCount = parseInt(s.likeCount, 10) || 0;
            }
          });
        }
      } catch (e) {}
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=60');
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message, items: [] });
  }
}
