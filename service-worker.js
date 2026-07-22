const CACHE = "botgarden-shell-v61";
const SHELL = [
  "./", "./index.html", "./manifest.json", "./app.js?v=20260722-61", "./core.js", "./pwa.css?v=20260722-49", "./operations.css?v=20260722-50", "./confidence.css?v=20260722-52", "./assistant.css?v=20260722-59",
  "./styles.css?v=20260721-16", "./conditions.css?v=20260722-47", "./crypto.css?v=20260721-27",
  "./activity-tabs.css?v=20260721-31", "./positions.css?v=20260721-37", "./position-actions.css?v=20260721-39",
  "./overview.css?v=20260721-40", "./analytics.css?v=20260722-44", "./securities-tabs.css?v=20260722-45",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./paper.html"
];

self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  const request = event.request, url = new URL(request.url); if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") { event.respondWith(fetch(request).then((response) => { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put("./index.html", copy)); return response; }).catch(() => caches.match("./index.html"))); return; }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)); } return response; })));
});
