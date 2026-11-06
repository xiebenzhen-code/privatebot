// Service worker: keeps one offline page around. Pages and API never cached, so you never see stale data.
const OFFLINE_URL = '/static/offline.html';
const CACHE = 'wb-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only navigations get the offline fallback; everything else goes straight to the network.
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req).catch(() => caches.match(OFFLINE_URL).then((hit) => hit ?? Response.error())),
  );
});
