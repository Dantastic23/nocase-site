/* NoCase service worker.
 *
 * Two jobs: make the app installable, and make it survive a dead connection —
 * people work on cases on phones, in courthouses, on bad signal.
 *
 * Bump CACHE on every deploy. Deploy here is a manual upload (see CLAUDE.md), so
 * nothing bumps this for you; a stale CACHE means users keep the old shell forever.
 */
const CACHE = 'nocase-shell-v1';

const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/intake.js',
  '/nocase-v2.3-patch.js',   // loaded by the shell as /nocase-v2.3-patch.js?v=N
  '/app/manifest.json',
  '/app/icon-192.png',
  '/app/icon-512.png',
];

self.addEventListener('install', (e) => {
  // addAll is atomic: one 404 rejects the whole install and we keep the old SW.
  // That's the behaviour we want — a half-cached shell is worse than none.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only GET. The Bedrock analyze calls are POSTs and must never be cached or
  // replayed — a cached verdict on someone else's facts would be catastrophic.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin (AWS, fonts)

  // Navigations: network first, so a fresh upload is picked up immediately.
  // Fall back to the cached shell only when the network actually fails.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          // Only cache good responses. A transient 404/500 cached here would
          // exact-match on later offline opens and shadow the good shell fallback.
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('/app/index.html')))
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  // Exact match first (runtime-cached versioned URLs), then ignore the query
  // string: the shell scripts are requested as intake.js?v=N but precached
  // unversioned, and caches.match defaults to ignoreSearch:false — without the
  // fallback the precache never matches and offline boots a dead shell.
  // ?v= is only ever a cache-buster here; nothing serves different content by query.
  e.respondWith(
    caches.match(req)
      .then(hit => hit || caches.match(req, { ignoreSearch: true }))
      .then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
  );
});
