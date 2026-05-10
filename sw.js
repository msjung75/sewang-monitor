// 정적 파일 캐시 (PWA 오프라인 기본 대응)
const CACHE = 'sewang-pwa-v1';
const FILES = ['./','./index.html','./manifest.json','./icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});
self.addEventListener('fetch', e => {
  // API 요청은 항상 네트워크 (캐시하지 않음 - Vercel CDN이 처리)
  if (e.request.url.includes('/api/')) return;
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
