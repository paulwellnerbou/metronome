// Offline support. Network first, cache as the fallback: there is no build step
// to stamp a version into this file, so a cache-first worker would keep serving
// a release until someone remembered to bump a constant by hand. This way a
// deploy is live on the next online load, and the cache only ever answers when
// the network can't.

const CACHE = 'metronome-v1';

// The shell, fetched at install so the very first visit already works offline.
// Anything missing here is still cached the first time it is requested.
const SHELL = [
  './',
  'styles.css',
  'src/app.js',
  'src/engine.js',
  'src/meter.js',
  'src/sounds.js',
  'src/tick-worker.js',
  'manifest.webmanifest',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// On a connection that is up but going nowhere, stop waiting once there is a
// cached copy to show instead.
const PATIENCE_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  // ignoreSearch: a shared or start_url link with a query is still the app
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  try {
    // no-cache: revalidate with the server instead of trusting the HTTP cache's
    // guess at freshness, or a release could mix new markup with old modules
    const fetching = fetch(request, { cache: 'no-cache' });
    const response = await (cached ? Promise.race([
      fetching,
      new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), PATIENCE_MS); }),
    ]) : fetching);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

// Font files never change under their URL and the stylesheet hardly does:
// answer from the cache at once and refresh it behind the scenes.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fetching = fetch(request)
    // a no-cors stylesheet request comes back opaque: status 0, but usable
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    });
  if (!cached) return fetching;
  fetching.catch(() => {});
  return cached;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
  else if (FONT_HOSTS.includes(url.hostname)) event.respondWith(staleWhileRevalidate(request));
});
