// PWA Service Worker v13 (사용자 관리 풀 UI)
const CACHE = 'sewang-pwa-v13_6-brand-ov';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // 인증·데이터·API는 항상 network (cache 우회)
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/data/')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // 정적 셸은 cache-first
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
    if (resp.ok && e.request.method === 'GET') {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return resp;
  })));
});
