/**
 * Cloudflare Worker — Dynamic Sitemap Generator
 *
 * Serves:
 *   /sitemap.xml      → sitemap index for crawler discovery
 *   /sitemap-main.xml → core/static/blog sitemap
 *
 * The blog sitemap is built by merging hard-coded static pages with
 * AI-generated blog posts read live from BLOG_AI_KV. The result is cached at
 * the edge for 1 hour so every new post is reflected quickly after publish.
 *
 * Deploy:  npx wrangler deploy --config wrangler-sitemap.jsonc
 * Dev:     npx wrangler dev --config wrangler-sitemap.jsonc
 *
 * Required bindings: BLOG_AI_KV (KV namespace — same as blog worker)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN = "https://thisday.info";
const CACHE_MAX_AGE = 3600; // 1 hour (purged immediately after each new publish)
const KV_INDEX_KEY = "index";

// ---------------------------------------------------------------------------
// Static pages — core site sections that never change dynamically
// ---------------------------------------------------------------------------

const STATIC_PAGES = [
  {
    loc: "/",
    lastmod: "2026-03-17",
    changefreq: "daily",
    priority: "1.0",
    dynamicLastmod: true,
  },
  {
    loc: "/about/",
    lastmod: "2026-03-17",
    changefreq: "monthly",
    priority: "0.7",
  },
  {
    loc: "/about/editorial/",
    lastmod: "2026-04-05",
    changefreq: "monthly",
    priority: "0.7",
  },
  {
    loc: "/contact/",
    lastmod: "2026-03-17",
    changefreq: "monthly",
    priority: "0.6",
  },
  {
    loc: "/blog/",
    lastmod: "2026-03-17",
    changefreq: "weekly",
    priority: "0.8",
    dynamicLastmod: true,
  },
  {
    loc: "/blog/archive/",
    lastmod: "2026-03-17",
    changefreq: "weekly",
    priority: "0.8",
    dynamicLastmod: true,
  },
  // Pillar hub pages — /blog/topic/:slug/
  { loc: "/blog/topic/war-conflict/",          lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/politics-government/",   lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/science-technology/",    lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/arts-culture/",          lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/disasters-accidents/",   lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/social-human-rights/",   lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/economy-business/",      lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/health-medicine/",       lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/exploration-discovery/", lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/famous-persons/",        lastmod: "2026-04-05", changefreq: "weekly", priority: "0.7", dynamicLastmod: true },
  { loc: "/blog/topic/born-on-this-day/",      lastmod: "2026-04-05", changefreq: "weekly", priority: "0.6", dynamicLastmod: true },
  { loc: "/blog/topic/died-on-this-day/",      lastmod: "2026-04-05", changefreq: "weekly", priority: "0.6", dynamicLastmod: true },
  {
    loc: "/privacy-policy/",
    lastmod: "2026-03-17",
    changefreq: "yearly",
    priority: "0.3",
  },
  {
    loc: "/terms/",
    lastmod: "2026-03-17",
    changefreq: "yearly",
    priority: "0.3",
  },
];

// ---------------------------------------------------------------------------
// Static (legacy) blog posts — actual HTML files on disk, not in KV.
// These were published before the AI blog worker existed.
// ---------------------------------------------------------------------------

const STATIC_BLOG_POSTS = [
  // July 2025
  { loc: "/blog/july/10-2025/", lastmod: "2025-07-10" },
  { loc: "/blog/july/11-2025/", lastmod: "2025-07-11" },
  { loc: "/blog/july/12-2025/", lastmod: "2025-07-12" },
  { loc: "/blog/july/13-2025/", lastmod: "2025-07-13" },
  { loc: "/blog/july/14-2025/", lastmod: "2025-07-14" },
  { loc: "/blog/july/15-2025/", lastmod: "2025-07-15" },
  { loc: "/blog/july/16-2025/", lastmod: "2025-07-16" },
  { loc: "/blog/july/17-2025/", lastmod: "2025-07-17" },
  { loc: "/blog/july/18-2025/", lastmod: "2025-07-18" },
  { loc: "/blog/july/19-2025/", lastmod: "2025-07-19" },
  { loc: "/blog/july/20-2025/", lastmod: "2025-07-20" },
  { loc: "/blog/july/21-2025/", lastmod: "2025-07-21" },
  { loc: "/blog/july/22-2025/", lastmod: "2025-07-22" },
  { loc: "/blog/july/23-2025/", lastmod: "2025-07-23" },
  { loc: "/blog/july/25-2025/", lastmod: "2025-07-25" },
  { loc: "/blog/july/26-2025/", lastmod: "2025-07-26" },
  { loc: "/blog/july/30-2025/", lastmod: "2025-07-30" },
  // August 2025
  { loc: "/blog/august/1-2025/", lastmod: "2025-08-01" },
  { loc: "/blog/august/3-2025/", lastmod: "2025-08-03" },
  { loc: "/blog/august/7-2025/", lastmod: "2025-08-07" },
  { loc: "/blog/august/9-2025/", lastmod: "2025-08-09" },
  { loc: "/blog/august/11-2025/", lastmod: "2025-08-11" },
  { loc: "/blog/august/13-2025/", lastmod: "2025-08-13" },
  { loc: "/blog/august/16-2025/", lastmod: "2025-08-16" },
  { loc: "/blog/august/18-2025/", lastmod: "2025-08-18" },
  { loc: "/blog/august/20-2025/", lastmod: "2025-08-20" },
  { loc: "/blog/august/23-2025/", lastmod: "2025-08-23" },
  { loc: "/blog/august/26-2025/", lastmod: "2025-08-26" },
  { loc: "/blog/august/30-2025/", lastmod: "2025-08-30" },
  // September 2025
  { loc: "/blog/september/2-2025/", lastmod: "2025-09-02" },
  { loc: "/blog/september/5-2025/", lastmod: "2025-09-05" },
  { loc: "/blog/september/8-2025/", lastmod: "2025-09-08" },
  { loc: "/blog/september/11-2025/", lastmod: "2025-09-11" },
  { loc: "/blog/september/15-2025/", lastmod: "2025-09-15" },
  { loc: "/blog/september/18-2025/", lastmod: "2025-09-18" },
  { loc: "/blog/september/22-2025/", lastmod: "2025-09-22" },
  { loc: "/blog/september/26-2025/", lastmod: "2025-09-26" },
  { loc: "/blog/september/29-2025/", lastmod: "2025-09-29" },
  // October 2025
  { loc: "/blog/october/2-2025/", lastmod: "2025-10-02" },
  { loc: "/blog/october/6-2025/", lastmod: "2025-10-06" },
  { loc: "/blog/october/13-2025/", lastmod: "2025-10-13" },
  { loc: "/blog/october/21-2025/", lastmod: "2025-10-21" },
  { loc: "/blog/october/28-2025/", lastmod: "2025-10-28" },
  // November 2025
  { loc: "/blog/november/3-2025/", lastmod: "2025-11-03" },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      url.pathname !== "/sitemap.xml" &&
      url.pathname !== "/sitemap-main.xml"
    ) {
      return fetch(request);
    }

    // Helpful for diagnosing Search Console “couldn’t fetch” issues.
    // Logs show up in `wrangler tail` for this worker.
    try {
      console.log("sitemap request", {
        path: url.pathname,
        ua: request.headers.get("user-agent") || "",
        cf: request.cf || null,
      });
    } catch {
      // ignore logging errors
    }

    // Serve from edge cache if available
    const cache = caches.default;
    const cacheKey = new Request(`${DOMAIN}${url.pathname}`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Read AI blog post index from KV
    let aiPosts = [];
    try {
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      aiPosts = indexRaw ? JSON.parse(indexRaw) : [];
    } catch (err) {
      // If KV is unavailable, degrade gracefully — static pages still get served
      console.error("Sitemap: failed to read KV index:", err);
    }

    // Allow skipping legacy (static) blog posts via an environment flag
    const ignoreLegacy = env && String(env.IGNORE_LEGACY_BLOG) === "true";
    const latestPostLastmod = computeLatestPostLastmod(aiPosts, ignoreLegacy);
    const xml =
      url.pathname === "/sitemap.xml"
        ? buildSitemapIndex(latestPostLastmod)
        : buildMainSitemap(aiPosts, ignoreLegacy, latestPostLastmod);

    const response = new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`,
        "X-Robots-Tag": "noindex",
      },
    });

    // Populate edge cache so subsequent requests are instant
    await cache.put(cacheKey, response.clone());

    return response;
  },
};

// ---------------------------------------------------------------------------
// XML builder
// ---------------------------------------------------------------------------

function buildSitemapIndex(latestPostLastmod) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    sitemapEntry(`${DOMAIN}/sitemap-main.xml`, latestPostLastmod),
    sitemapEntry(`${DOMAIN}/sitemap-generated.xml`, today),
    sitemapEntry(`${DOMAIN}/sitemap-people.xml`, today),
    sitemapEntry(`${DOMAIN}/news-sitemap.xml`, latestPostLastmod),
  ];

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.join("\n") +
    `\n</sitemapindex>`
  );
}

function buildMainSitemap(
  aiPosts,
  ignoreLegacy = false,
  latestPostLastmod = computeLatestPostLastmod(aiPosts, ignoreLegacy),
) {
  const entries = [];

  // 1. Core static pages
  for (const page of STATIC_PAGES) {
    entries.push(
      urlEntry(
        `${DOMAIN}${page.loc}`,
        page.dynamicLastmod ? latestPostLastmod : page.lastmod,
        page.changefreq,
        page.priority,
      ),
    );
  }

  // 2. Legacy static blog posts (HTML files on disk)
  if (!ignoreLegacy) {
    for (const post of STATIC_BLOG_POSTS) {
      entries.push(
        urlEntry(`${DOMAIN}${post.loc}`, post.lastmod, "monthly", "0.8"),
      );
    }
  }

  // 3. AI-generated blog posts from KV (newest first, already sorted by blog worker)
  for (const post of aiPosts) {
    const lastmod = post.publishedAt
      ? post.publishedAt.slice(0, 10) // "YYYY-MM-DD"
      : latestPostLastmod;

    entries.push(
      urlEntry(`${DOMAIN}/blog/${post.slug}/`, lastmod, "monthly", "0.8"),
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.join("\n") +
    `\n</urlset>`
  );
}

function sitemapEntry(loc, lastmod) {
  return (
    `  <sitemap>\n` +
    `    <loc>${loc}</loc>\n` +
    `    <lastmod>${lastmod}</lastmod>\n` +
    `  </sitemap>`
  );
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return (
    `  <url>\n` +
    `    <loc>${loc}</loc>\n` +
    `    <lastmod>${lastmod}</lastmod>\n` +
    `    <changefreq>${changefreq}</changefreq>\n` +
    `    <priority>${priority}</priority>\n` +
    `  </url>`
  );
}

function computeLatestPostLastmod(aiPosts, ignoreLegacy = false) {
  const candidates = [];

  if (!ignoreLegacy) {
    for (const post of STATIC_BLOG_POSTS) {
      if (post?.lastmod) candidates.push(post.lastmod);
    }
  }

  for (const post of aiPosts || []) {
    if (
      typeof post?.publishedAt === "string" &&
      post.publishedAt.length >= 10
    ) {
      candidates.push(post.publishedAt.slice(0, 10));
    }
  }

  // YYYY-MM-DD compares lexicographically.
  return candidates.length
    ? candidates.reduce((max, cur) => (cur > max ? cur : max))
    : new Date().toISOString().slice(0, 10);
}
