/**
 * Cloudflare Worker — RSS Feed Generator
 *
 * Serves a valid RSS 2.0 feed at /rss.xml (and redirects /feed.xml there).
 * Feed items are pulled live from BLOG_AI_KV and cached at the edge for 1 hour.
 *
 * Deploy:  npx wrangler deploy --config wrangler-rss.jsonc
 * Dev:     npx wrangler dev --config wrangler-rss.jsonc
 *
 * Required bindings: BLOG_AI_KV (KV namespace — same as blog worker)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN = "https://thisday.info";
const FEED_URL = `${DOMAIN}/rss.xml`;
const SITE_TITLE = "thisDay. — On This Day in History";
const SITE_DESCRIPTION =
  "A daily journey through history. Articles about significant events, people, and turning points that shaped our world.";
const SITE_LOGO_URL = `${DOMAIN}/images/logo.png`;

const CACHE_MAX_AGE = 3600; // 1 hour
const KV_INDEX_KEY = "index";
const MAX_FEED_ITEMS = 20;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /feed.xml → canonical redirect to /rss.xml
    if (path === "/feed.xml") {
      return Response.redirect(`${DOMAIN}/rss.xml`, 301);
    }

    if (path !== "/rss.xml") {
      return fetch(request);
    }

    // Serve from edge cache if available
    const cache = caches.default;
    const cacheKey = new Request(FEED_URL);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Read the latest posts from KV
    let posts = [];
    try {
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      posts = indexRaw ? JSON.parse(indexRaw) : [];
    } catch (err) {
      // Degrade gracefully — return a valid but empty feed
      console.error("RSS: failed to read KV index:", err);
    }

    const xml = buildFeed(posts.slice(0, MAX_FEED_ITEMS));

    const response = new Response(xml, {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`,
      },
    });

    // Populate edge cache so subsequent requests are instant
    await cache.put(cacheKey, response.clone());

    return response;
  },
};

// ---------------------------------------------------------------------------
// Feed builder
// ---------------------------------------------------------------------------

function buildFeed(posts) {
  const lastBuildDate =
    posts.length > 0
      ? toRFC2822(posts[0].publishedAt)
      : toRFC2822(new Date().toISOString());

  const items = posts.map(buildItem).join("\n\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0"\n` +
    `  xmlns:atom="http://www.w3.org/2005/Atom"\n` +
    `  xmlns:content="http://purl.org/rss/1.0/modules/content/">\n` +
    `  <channel>\n` +
    `    <title>${esc(SITE_TITLE)}</title>\n` +
    `    <link>${DOMAIN}/blog/</link>\n` +
    `    <description>${esc(SITE_DESCRIPTION)}</description>\n` +
    `    <language>en-us</language>\n` +
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>\n` +
    `    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>\n` +
    `    <image>\n` +
    `      <url>${SITE_LOGO_URL}</url>\n` +
    `      <title>${esc(SITE_TITLE)}</title>\n` +
    `      <link>${DOMAIN}/</link>\n` +
    `    </image>\n\n` +
    items +
    `\n` +
    `  </channel>\n` +
    `</rss>`
  );
}

function buildItem(post) {
  const postUrl = `${DOMAIN}/blog/${post.slug}/`;
  const pubDate = post.publishedAt ? toRFC2822(post.publishedAt) : "";

  return (
    `    <item>\n` +
    `      <title>${esc(post.title)}</title>\n` +
    `      <link>${postUrl}</link>\n` +
    `      <guid isPermaLink="true">${postUrl}</guid>\n` +
    `      <pubDate>${pubDate}</pubDate>\n` +
    `      <description>${esc(post.description)}</description>\n` +
    `    </item>`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats an ISO 8601 string to RFC 2822 (required by RSS spec).
 * e.g. "2026-02-20T06:00:00.000Z" → "Fri, 20 Feb 2026 06:00:00 GMT"
 */
function toRFC2822(isoString) {
  return new Date(isoString).toUTCString();
}

/**
 * Escapes the five XML special characters so content is safe to embed in
 * XML text nodes and attribute values.
 */
function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
