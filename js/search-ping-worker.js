/**
 * Cloudflare Worker — Search Console Ping
 *
 * Purpose:
 *   Best-effort submission helper after publishing new content.
 *
 *   Note: Google's legacy sitemap "ping" endpoint has been deprecated, so this
 *   Worker does not attempt to ping Google. Google discovery happens via
 *   normal crawling + sitemaps (with accurate <lastmod> if you provide it).
 *
 *   For Bing, this Worker supports IndexNow (recommended).
 *
 * Endpoints:
 *   GET  /search-ping        → health check
 *   POST /search-ping        → ping Google + Bing for one or more sitemaps
 *
 * Auth (optional):
 *   If SEARCH_PING_SECRET is set, POST requires:
 *     Authorization: Bearer <SEARCH_PING_SECRET>
 *
 * Body (optional):
 *   { "sitemaps": ["https://thisday.info/sitemap.xml", "..."] }
 *   If omitted, defaults to /sitemap.xml, /sitemap-generated.xml, /news-sitemap.xml.
 *
 * Optional IndexNow:
 *   If INDEXNOW_KEY + INDEXNOW_KEY_LOCATION are set, you can also send:
 *     { "urls": ["https://thisday.info/blog/17-march-2026/"] }
 *   which will submit URLs to IndexNow (useful for Bing).
 *
 * Deploy:  npx wrangler deploy --config wrangler-search-ping.jsonc
 */

const DOMAIN = "https://thisday.info";
const DEFAULT_SITEMAPS = [
  `${DOMAIN}/sitemap.xml`,
  `${DOMAIN}/sitemap-generated.xml`,
  `${DOMAIN}/news-sitemap.xml`,
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/search-ping") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      return jsonResponse({ status: "ok" });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = env.SEARCH_PING_SECRET;
    if (secret) {
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${secret}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
    }

    const { sitemaps, urls } = await parseRequestBody(request);
    const results = await submitAll(env, sitemaps, urls);

    return jsonResponse({
      status: "ok",
      sitemaps,
      urls,
      results,
    });
  },
};

async function parseRequestBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { sitemaps: DEFAULT_SITEMAPS, urls: [] };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { sitemaps: DEFAULT_SITEMAPS, urls: [] };
  }

  const sitemaps = Array.isArray(body?.sitemaps) ? body.sitemaps : DEFAULT_SITEMAPS;
  const urls = Array.isArray(body?.urls) ? body.urls : [];

  const cleanedSitemaps = sitemaps
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  // Ensure absolute URLs (Google/Bing ping endpoints require it)
  const normalizedSitemaps = cleanedSitemaps.map((s) => (s.startsWith("http://") || s.startsWith("https://")) ? s : `${DOMAIN}${s}`);
  const normalizedUrls = urls
    .filter((u) => typeof u === "string")
    .map((u) => u.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((u) => (u.startsWith("http://") || u.startsWith("https://")) ? u : `${DOMAIN}${u}`);

  return { sitemaps: normalizedSitemaps, urls: normalizedUrls };
}

async function submitAll(env, sitemaps, urls) {
  const now = new Date().toISOString();
  const out = {
    sitemaps: sitemaps.map((sitemap) => ({
      sitemap,
      at: now,
      google: {
        ok: false,
        skipped: true,
        reason: "Google sitemap ping endpoint deprecated",
      },
    })),
    indexnow: null,
  };

  if (urls.length) {
    out.indexnow = await submitIndexNowIfConfigured(env, urls, now);
  }

  return out;
}

async function submitIndexNowIfConfigured(env, urls, at) {
  if (!env.INDEXNOW_KEY || !env.INDEXNOW_KEY_LOCATION) {
    return {
      at,
      ok: false,
      skipped: true,
      reason: "INDEXNOW_KEY / INDEXNOW_KEY_LOCATION not configured",
    };
  }

  const host = env.INDEXNOW_HOST || "thisday.info";

  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "thisday.info (search-ping worker)",
      },
      body: JSON.stringify({
        host,
        key: env.INDEXNOW_KEY,
        keyLocation: env.INDEXNOW_KEY_LOCATION,
        urlList: urls,
      }),
    });

    const text = await res.text().catch(() => "");
    return {
      at,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      bodyPreview: text.slice(0, 160),
    };
  } catch (e) {
    return { at, ok: false, error: e?.message || String(e) };
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
