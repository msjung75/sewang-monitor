// PWA Service Worker v17.20 — 인사이트 탭 + 자동 업데이트 강화 (canonical redirect, etag fresh check)
const CACHE = 'sewang-pwa-v17_20-insight';
const SHELL = ['/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({type: 'window', includeUncontrolled: true}))
      .then(clients => {
        clients.forEach(c => {
          c.postMessage({
            type: 'SW_UPDATED_RELOAD',
            forceClear: true,
            version: 'v17_20',
            clearKeys: [
              'sewang_franchise_master',
              'sewang_franchise_stats',
              'sewang_sns_trend',
              'sewang_sns_trend_v17_15',
              'sewang-v12'
            ]
          });
        });
      })
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {
    data = { title: '세왕 모니터', body: e.data ? e.data.text() : '새 알림' };
  }
  const title = data.title || '세왕 모니터';
  const opts = {
    body: data.body || '',
    icon: data.icon || '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || 'sewang-' + Date.now(),
    requireInteraction: false,
    data: { url: data.url || '/', type: data.type || 'generic' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // API: 항상 원래 request 그대로 (쿠키·세션 보존 필수, 카카오 OAuth 등)
  if (u.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }
  // 데이터 파일: cache-busting + 원래 request 그대로 (no credentials 변경)
  if (u.pathname.startsWith('/data/')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }
  // index.html / 루트 / .html: network-first
  if (u.pathname === '/' || u.pathname.endsWith('.html') || u.pathname.endsWith('/index')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(resp => {
          if (resp.ok && e.request.method === 'GET') {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // 정적 자원: cache-first
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
    if (resp.ok && e.request.method === 'GET') {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return resp;
  })));
});
