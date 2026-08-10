// thisDay. Service Worker
// Caches static assets for instant repeat visits and basic offline support.

const CACHE_NAME = "thisday-v42";
const CACHE_VERSION_KEY = "thisday-sw-version";

// Static assets to cache on install (shell of the app)
const STATIC_ASSETS = [
  "/manifest.json",
  "/js/script.js?v=31",
  "/js/chatbot.js?v=5",
  "/js/shared/static-layout.js",
  "/js/shared/layout.js",
  "/css/custom.css?v=53",
  "/css/style.css?v=11",
  "/images/favicon.ico",
  "/images/favicon-32x32.png",
  "/images/favicon-16x16.png",
  "/images/apple-touch-icon.png",
  "/images/logo.png",
];

function responseHeadersBlockCaching(request, response) {
  if (!response.ok || response.redirected) return true;

  const cacheControl = response.headers.get("cache-control") || "";
  if (/\b(?:no-store|private)\b/i.test(cacheControl)) return true;

  const robotsHeader = response.headers.get("x-robots-tag") || "";
  if (/\bnoindex\b/i.test(robotsHeader)) return true;

  if (response.url) {
    try {
      const requestUrl = new URL(
        typeof request === "string" ? request : request.url,
        self.location.origin,
      );
      const responseUrl = new URL(response.url);
      if (requestUrl.href !== responseUrl.href) return true;
    } catch (_) {
      return true;
    }
  }

  return false;
}

async function responseHtmlBlocksIndexing(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!/\btext\/html\b/i.test(contentType)) return false;

  const html = await response.text();
  return (html.match(/<meta\b[^>]*>/gi) || []).some(
    (tag) =>
      /\bname\s*=\s*["']?robots["']?/i.test(tag) &&
      /\bcontent\s*=\s*["'][^"']*\bnoindex\b/i.test(tag),
  );
}

async function putInCacheIfIndexSafe(cache, request, response) {
  if (responseHeadersBlockCaching(request, response)) return false;
  if (await responseHtmlBlocksIndexing(response.clone())) return false;
  await cache.put(request, response);
  return true;
}

// Install: pre-cache the app shell — each asset cached independently so one
// failure (e.g. a CDN miss) doesn't abort the entire service worker install.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          fetch(url)
            .then((res) => putInCacheIfIndexSafe(cache, url, res))
            .catch(() => {}),
        ),
      ),
    ),
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
// - Other intercepted GET requests: cache-first, fall back to network or 503
// - Wikipedia API: network-only (always fresh, handled by app-level cache)
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const unavailableResponse = () =>
    new Response("", {
      status: 503,
      statusText: "Service Unavailable",
    });
  const cacheSuccessfulResponse = (response) => {
    if (!responseHeadersBlockCaching(request, response)) {
      const cacheCandidate = response.clone();
      event.waitUntil(
        caches
          .open(CACHE_NAME)
          .then((cache) =>
            putInCacheIfIndexSafe(cache, request, cacheCandidate),
          )
          .catch(() => {}),
      );
    }
    return response;
  };

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

  // The blog index changes after each daily publication. Cache-first left
  // returning yesterday's first slide indefinitely, so refresh it from the
  // network and retain the cached copy only as an offline fallback.
  if (
    url.origin === self.location.origin &&
    (url.pathname === "/blog/index.json" ||
      url.pathname === "/blog/archive.json")
  ) {
    event.respondWith(
      fetch(request)
        .then(cacheSuccessfulResponse)
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || unavailableResponse()),
        ),
    );
    return;
  }

  // HTML navigation requests — network-first for freshness
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(cacheSuccessfulResponse)
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match("/"))
            .then((cached) => cached || unavailableResponse()),
        ),
    );
    return;
  }

  // Other GET requests, including scripted HTML fetches — cache-first for speed
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then(cacheSuccessfulResponse)
        .catch(() => unavailableResponse());
    }),
  );
});
