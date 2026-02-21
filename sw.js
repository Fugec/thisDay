// thisDay. Service Worker
// Caches static assets for instant repeat visits and basic offline support.

const CACHE_NAME = "thisday-v2";
const CACHE_VERSION_KEY = "thisday-sw-version";

// Static assets to cache on install (shell of the app)
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/js/script.js",
  "/js/chatbot.js",
  "/css/style.css",
  "/images/favicon.ico",
  "/images/favicon-32x32.png",
  "/images/favicon-16x16.png",
  "/images/apple-touch-icon.png",
  "/images/logo.png",
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }),
  );
  self.skipWaiting();
});

// Activate: delete old cache versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

// Fetch strategy:
// - HTML (navigation): network-first, fall back to cache
// - Static assets (JS/CSS/images): cache-first, fall back to network
// - Wikipedia API: network-only (always fresh, handled by app-level cache)
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and cross-origin requests except allowed CDNs
  if (request.method !== "GET") return;
  if (
    url.origin !== self.location.origin &&
    !url.hostname.includes("cdn.jsdelivr.net") &&
    !url.hostname.includes("fonts.googleapis.com") &&
    !url.hostname.includes("fonts.gstatic.com")
  ) {
    return;
  }

  // Wikipedia API — always network, never cache in SW (app has its own cache)
  if (url.hostname === "api.wikimedia.org") return;

  // HTML navigation requests — network-first for freshness
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("/"))),
    );
    return;
  }

  // Static assets — cache-first for speed
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }),
  );
});
