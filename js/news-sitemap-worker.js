/**
 * Cloudflare Worker — Google News Sitemap
 *
 * Serves a valid Google News Sitemap 0.9 at /news-sitemap.xml.
 * Only includes blog posts published in the last 48 hours — the window
 * Google News requires for indexing new articles.
 *
 * Google uses this feed to discover and rank breaking / timely content.
 * Register it in Google Search Console → Sitemaps after deploying.
 *
 * Deploy:  npx wrangler deploy --config wrangler-news-sitemap.jsonc
 * Dev:     npx wrangler dev --config wrangler-news-sitemap.jsonc
 *
 * Reuses the existing BLOG_AI_KV namespace — no additional setup needed.
 */

const SITE_URL = "https://thisday.info";
const PUBLICATION_NAME = "thisDay.";
const PUBLICATION_LANGUAGE = "en";
const CACHE_MAX_AGE = 3_600; // 1 h — refreshed on every new publish via cache.delete()
const NEWS_WINDOW_MS = 48 * 60 * 60 * 1_000; // 48 hours

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/news-sitemap.xml") {
      return new Response("Not found", { status: 404 });
    }

    // Serve from edge cache when available
    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Read the KV post index
    let index = [];
    try {
      const raw = await env.BLOG_AI_KV.get("index");
      if (raw) index = JSON.parse(raw);
    } catch {
      // Return an empty but valid sitemap on KV errors
    }

    // Google News: only articles published within the last 48 hours
    const cutoff = Date.now() - NEWS_WINDOW_MS;
    const recentPosts = index.filter(
      (p) => p.publishedAt && new Date(p.publishedAt).getTime() >= cutoff,
    );

    const urlEntries = recentPosts
      .map((post) => {
        const loc = `${SITE_URL}/blog/archive/${post.slug}/`;
        const pubDate = new Date(post.publishedAt).toISOString();
        return (
          `  <url>\n` +
          `    <loc>${escXml(loc)}</loc>\n` +
          `    <news:news>\n` +
          `      <news:publication>\n` +
          `        <news:name>${escXml(PUBLICATION_NAME)}</news:name>\n` +
          `        <news:language>${PUBLICATION_LANGUAGE}</news:language>\n` +
          `      </news:publication>\n` +
          `      <news:publication_date>${pubDate}</news:publication_date>\n` +
          `      <news:title>${escXml(post.title ?? "")}</news:title>\n` +
          `    </news:news>\n` +
          `  </url>`
        );
      })
      .join("\n");

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset\n` +
      `  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `  xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n` +
      (urlEntries ? urlEntries + "\n" : "") +
      `</urlset>`;

    const response = new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`,
        "X-Robots-Tag": "noindex", // The sitemap file itself shouldn't be indexed
      },
    });

    await cache.put(cacheKey, response.clone());
    return response;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escapes the five XML special characters for safe embedding in XML text nodes. */
function escXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
