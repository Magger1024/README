/* Blockwalk shell. On GitHub Pages the script lives at /README/blockwalk/sw.js,
   so the default scope is /README/blockwalk/ and it does not take the CRM worker's pages.
   Bump VERSION when shipping so installed phones pick up the new files. */
const VERSION = 'blockwalk-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/api.js',
  './js/app.js',
  './js/cluster.js',
  './js/costs.js',
  './js/db.js',
  './js/geocode.js',
  './js/geo.js',
  './js/geotiff.js',
  './js/gmaps.js',
  './js/import.js',
  './js/map.js',
  './js/nav.js',
  './js/optimize.js',
  './js/optimize-request.js',
  './js/route.js',
  './js/sample.js',
  './js/solar.js',
  './js/split.js',
  './js/synthetic.js',
  './js/time.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.open(VERSION).then((cache) => cache.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) return hit;
    return net.then((res) => res || (req.mode === 'navigate' ? cache.match('./index.html') : Promise.resolve(new Response('Offline', { status: 503 }))));
  })));
});
