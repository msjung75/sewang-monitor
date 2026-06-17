// PWA Service Worker v17.14.3 — Push + 화제성 cache bump + 공정위 마스터
const CACHE = 'sewang-pwa-v17_14_3-franchise';
const SHELL = ['/manifest.json', '/icon.svg'];  // index.html 제거 — 항상 network-first

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())  // 새 sw 즉시 활성화
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())  // 즉시 모든 탭 제어
      .then(() => self.clients.matchAll({type: 'window'}))
      .then(clients => {
        // 모든 열린 탭에 RELOAD 메시지 → index.html 자동 새로고침
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED_RELOAD' }));
      })
  );
});

self.addEventListener('message', e => {
  // 클라이언트가 SKIP_WAITING 요청 시 즉시 활성화
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// v17.12: Push 알림 수신 (서버 → 사용자 device)
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

// v17.12: 알림 클릭 — 앱 열거나 포커스
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
  // API·데이터: 항상 network (no-store)
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/data/')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }
  // index.html / 루트 / .html: network-first (캐시는 offline fallback만)
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
        .catch(() => caches.match(e.request))  // 네트워크 실패 시 캐시 fallback
    );
    return;
  }
  // 정적 자원 (icon, manifest 등): cache-first
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
    if (resp.ok && e.request.method === 'GET') {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return resp;
  })));
});
