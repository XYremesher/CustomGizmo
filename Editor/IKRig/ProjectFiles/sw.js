// Minimal Service Worker
self.addEventListener('install', (e) => {
  console.log('SW installed');
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  console.log('SW activated');
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Fetch requests pass through normally
});
