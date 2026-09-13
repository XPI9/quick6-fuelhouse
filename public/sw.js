/* Quick6 FuelHouse — service worker (installable + opens offline)
   Navigations: network-first with a cached shell fallback.
   Static assets: cache-first. /api/* : always network, never cached. */
const VERSION = 'q6-v1';
const SHELL = 'shell-' + VERSION;
const ASSETS = 'assets-' + VERSION;
const SHELL_URL = '/index.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', SHELL_URL])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) return; // plans must always be live

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(SHELL).then((c) => c.put(SHELL_URL, res.clone())); return res; })
        .catch(() => caches.match(SHELL_URL).then((r) => r || caches.match('/')))
    );
    return;
  }

  if (url.origin === location.origin || url.origin.includes('fonts.gstatic.com') || url.origin.includes('fonts.googleapis.com') || url.origin.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => hit)
      )
    );
  }
});
