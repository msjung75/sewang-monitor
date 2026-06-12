// 정적 파일 캐시 (PWA 오프라인 기본 대응)
// CACHE 버전 bump — v9f: chunk 부분 저장 + silent catch 제거 + 쿨다운
const CACHE = 'sewang-pwa-v9f-chunk-incremental';
const FILES = ['./','./index.html','./manifest.json','./icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  // API 요청은 항상 네트워크
  if (e.request.url.includes('/api/')) return;
  // index.html 은 항상 네트워크 우선 (신규배포 즉시 반영), 실패 시 캐시 fallback
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
