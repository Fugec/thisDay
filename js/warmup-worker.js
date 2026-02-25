/**
 * Cloudflare Worker — Wikipedia Cache Warm-Up
 *
 * Runs on a cron trigger at 00:01 UTC every day. Pre-fetches the Wikipedia
 * "On This Day" API for today and tomorrow and stores the responses in
 * Cloudflare's shared zone cache (caches.default).
 *
 * Because seo-worker.js reads from the same caches.default, the first real
 * visitor of the day gets a cache HIT instead of waiting for an external
 * API call — directly improving Largest Contentful Paint (LCP).
 *
 * Deploy:  npx wrangler deploy --config wrangler-warmup.jsonc
 * Dev:     npx wrangler dev --config wrangler-warmup.jsonc
 *
 * Manual trigger: POST https://thisday.info/warmup
 * No bindings required.
 */

// Must match the User-Agent used in seo-worker.js so Wikipedia accepts the request.
const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";
const WIKIPEDIA_BASE =
  "https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events";
const WIKIPEDIA_ALL_BASE =
  "https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  // Cron trigger — fires at 00:01 UTC daily.
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(warmUpCache());
  },

  // HTTP handler — allows a manual warm-up via POST /warmup for testing.
  // Requires:  Authorization: Bearer <WARMUP_SECRET>
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/warmup" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.WARMUP_SECRET || auth !== `Bearer ${env.WARMUP_SECRET}`) {
        return new Response(JSON.stringify({ status: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const report = await warmUpCache();
        return new Response(JSON.stringify({ status: "ok", report }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Warm-up logic
// ---------------------------------------------------------------------------

async function warmUpCache() {
  const today = new Date();
  // Pre-fetch today and tomorrow so the cache is hot for both midnight-to-midnight
  // windows regardless of which UTC day the first visitor arrives.
  const tomorrow = new Date(today.getTime() + 86_400_000);

  const results = await Promise.allSettled([
    prefetchDate(today, WIKIPEDIA_BASE),
    prefetchDate(tomorrow, WIKIPEDIA_BASE),
    prefetchDate(today, WIKIPEDIA_ALL_BASE),
    prefetchDate(tomorrow, WIKIPEDIA_ALL_BASE),
  ]);

  const labels = ["today/events", "tomorrow/events", "today/all", "tomorrow/all"];
  const report = results.map((r, i) => ({
    date: labels[i],
    status: r.status,
    ...(r.status === "rejected" ? { error: String(r.reason) } : {}),
  }));

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("Warm-up error:", r.reason);
    }
  }

  console.log("Cache warm-up complete:", JSON.stringify(report));
  return report;
}

/**
 * Fetches a single date's Wikipedia data and stores it in caches.default
 * using the exact same URL key that seo-worker.js uses for its cache lookups.
 */
async function prefetchDate(date, base = WIKIPEDIA_BASE) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const apiUrl = `${base}/${month}/${day}`;

  const cache = caches.default;

  // Skip if a valid cached response already exists.
  const existing = await cache.match(apiUrl);
  if (existing) {
    console.log(`Warm-up: cache HIT for ${month}/${day} — skipping fetch`);
    return;
  }

  const response = await fetch(apiUrl, {
    headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Wikipedia API returned ${response.status} for ${month}/${day}`,
    );
  }

  // Store with the same URL key seo-worker uses so its cache.match() hits.
  await cache.put(apiUrl, response.clone());
  console.log(`Warm-up: cached Wikipedia data for ${month}/${day}`);
}
