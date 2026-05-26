// Peakr service worker — offline app shell.
// App assets are cached cache-first so the optimizer works without a
// connection; the cross-origin weather API is left to the network.
const CACHE = "peakr-v1";
const ASSETS = [
  "./", "./index.html", "./styles.css",
  "./data.js", "./vehicles.js", "./community.js", "./app.js",
  "./manifest.webmanifest", "./icon.svg",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
