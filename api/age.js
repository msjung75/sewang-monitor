// 매장 등록일(첫 블로그 후기) + SNS 가속 배수 계산 프록시
// Vercel 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
// Input: GET ?store=매장명
// Output: { store, first_blog_date, age_days, count_4w, count_12w, avg_4w, avg_12w, acceleration, category }
//   category: A(등록≤30일) / B(1년+ 운영 + 4주평균÷12주평균≥1.5x) / C(안정)
export default async function handler(req, res) {
  const { store } = req.query;
  if (!store) return res.status(400).json({ error: 'store required' });

  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    return res.status(500).json({ error: 'NAVER_CLIENT_ID/SECRET 환경변수 미설정' });
  }

  const headers = { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret };
  const fetchBlog = async (sort, display) => {
    const u = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(store)}&sort=${sort}&display=${display}`;
    const r = await fetch(u, { headers });
    if (!r.ok) throw new Error('naver ' + r.status);
    return r.json();
  };

  try {
    const [byDate, bySim] = await Promise.all([
      fetchBlog('date', 100),
      fetchBlog('sim', 20)
    ]);

    const items = [...(byDate.items || []), ...(bySim.items || [])];
    const dates = items.map(it => it.postdate).filter(d => d && /^\d{8}$/.test(d));

    if (dates.length === 0) {
      return res.status(200).json({
        store, first_blog_date: null, age_days: null,
        count_4w: 0, count_12w: 0, avg_4w: 0, avg_12w: 0,
        acceleration: 0, category: 'C', reason: 'no blog posts'
      });
    }

    const sorted = [...dates].sort();
    const firstYmd = sorted[0];
    const ymd2date = (s) => new Date(
      Number(s.slice(0, 4)),
      Number(s.slice(4, 6)) - 1,
      Number(s.slice(6, 8))
    );
    const firstDate = ymd2date(firstYmd);
    const now = new Date();
    const ageDays = Math.floor((now - firstDate) / 86400000);

    const cutoff4w = new Date(now); cutoff4w.setDate(cutoff4w.getDate() - 28);
    const cutoff12w = new Date(now); cutoff12w.setDate(cutoff12w.getDate() - 84);
    const recentDates = (byDate.items || [])
      .map(it => it.postdate)
      .filter(d => d && /^\d{8}$/.test(d))
      .map(ymd2date);
    const count4w = recentDates.filter(d => d >= cutoff4w).length;
    const count12w = recentDates.filter(d => d >= cutoff12w).length;
    const avg4w = count4w / 4;
    const avg12w = count12w / 12;
    const acceleration = avg12w > 0 ? avg4w / avg12w : 0;

    let category = 'C';
    if (ageDays <= 30) category = 'A';
    else if (ageDays >= 365 && acceleration >= 1.5 && count4w >= 4) category = 'B';

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({
      store,
      first_blog_date: `${firstYmd.slice(0,4)}-${firstYmd.slice(4,6)}-${firstYmd.slice(6,8)}`,
      age_days: ageDays,
      count_4w: count4w,
      count_12w: count12w,
      avg_4w: Number(avg4w.toFixed(2)),
      avg_12w: Number(avg12w.toFixed(2)),
      acceleration: Number(acceleration.toFixed(2)),
      category
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

