/* OpenMaps v2 web-shell cache. Pack databases are intentionally excluded:
 * verified packs live in OPFS/IndexedDB, avoiding a second multi-megabyte copy
 * in Cache Storage. */
const CACHE_NAME = 'openmaps-shell-v1';
const SHELL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name.startsWith('openmaps-shell-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Pack data is managed by the verified pack installer, not Cache Storage.
  if (url.pathname.endsWith('.mbtiles') || url.pathname.endsWith('.sqlite') || url.pathname.includes('/packs/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(SHELL, copy));
        return response;
      }).catch(() => caches.match(SHELL)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
