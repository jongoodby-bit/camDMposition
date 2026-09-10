const CACHE_NAME = 'camdatam-pwa-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './vision.js',
  './manifest.json',
  './icon-192.png',
  'https://unpkg.com/@zxing/library@latest/umd/index.min.js',
  'https://docs.opencv.org/4.8.0/opencv.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
