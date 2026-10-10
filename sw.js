// Service Worker：缓存静态资源，API 请求不缓存
const CACHE_NAME = 'like-mubu-v3';
const ASSETS = ['/', '/index.html', '/app.js', '/gitee-client.js', '/style.css', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 请求走网络，不缓存
  if (url.pathname.startsWith('/api/')) return;
  // 静态资源：network-first（确保总是拿到最新 JS/CSS）
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
