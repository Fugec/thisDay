import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  blogPostPublicationTime,
  blogPostSlugDateTime,
  sortBlogIndexNewestFirst,
} from "../js/shared/blog-index-order.js";

const root = join(import.meta.dirname, "..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const clientScript = readFileSync(join(root, "js/script.js"), "utf8");
const blogWorker = readFileSync(join(root, "js/blog-ai-worker.js"), "utf8");
const seoWorker = readFileSync(join(root, "js/seo-worker.js"), "utf8");
const rssWorker = readFileSync(join(root, "js/rss-worker.js"), "utf8");
const serviceWorker = readFileSync(join(root, "sw.js"), "utf8");
const deployWorkflow = readFileSync(
  join(root, ".github/workflows/deploy-workers.yml"),
  "utf8",
);

test("daily blog index ordering uses the canonical slug date newest first", () => {
  const posts = [
    {
      slug: "26-july-2026",
      publishedAt: "2026-07-28T12:00:00.000Z",
    },
    {
      slug: "27-july-2026",
      publishedAt: "2026-07-27T00:15:00.000Z",
    },
    { slug: "25-july-2026", publishedAt: "2026-07-25T00:15:00.000Z" },
  ];
  assert.deepEqual(
    sortBlogIndexNewestFirst(posts).map((post) => post.slug),
    ["27-july-2026", "26-july-2026", "25-july-2026"],
    "repairing an older post later must not move it ahead of the newest daily article",
  );
  assert.equal(
    blogPostSlugDateTime("27-july-2026"),
    Date.UTC(2026, 6, 27),
  );
  assert.equal(blogPostSlugDateTime("31-february-2026"), null);
});

test("non-daily blog entries fall back to their publication timestamp", () => {
  const posts = [
    { slug: "feature-a", publishedAt: "2026-07-26T10:00:00Z" },
    { slug: "feature-b", publishedAt: "2026-07-27T10:00:00Z" },
  ];
  assert.equal(blogPostPublicationTime(posts[1]), Date.parse(posts[1].publishedAt));
  assert.equal(sortBlogIndexNewestFirst(posts)[0].slug, "feature-b");
});

test("every homepage article surface sorts before choosing its first item", () => {
  assert.match(
    indexHtml,
    /var latest = sortBlogPostsNewestFirst\(d\)\[0\]/,
  );
  assert.match(
    indexHtml,
    /posts = sortBlogPostsNewestFirst\(posts\);[\s\S]{0,120}posts\.slice\(0, 6\)/,
  );
  assert.match(
    clientScript,
    /const latest = sortBlogPostsNewestFirst\(index\)\.slice\(0, 20\)/,
  );
  assert.equal(
    (indexHtml.match(/fetch\(homepageBlogIndexUrl\(\)\)/g) || []).length,
    2,
  );
  assert.match(
    clientScript,
    /fetch\(homepageBlogIndexUrl\(\), \{/,
  );
  assert.match(
    blogWorker,
    /JSON\.stringify\(sortBlogIndexNewestFirst\(index\)\)/,
  );
  assert.match(
    seoWorker,
    /const data = sortBlogIndexNewestFirst\(index\)/,
  );
  assert.match(
    blogWorker,
    /const orderedIndex = sortBlogIndexNewestFirst\(\[entry, \.\.\.deduped\]\)/,
  );
  assert.match(
    blogWorker,
    /async function buildListingHTML\(index\) \{\s*const orderedIndex = sortBlogIndexNewestFirst\(index\)/,
  );
  assert.match(
    rssWorker,
    /sortBlogIndexNewestFirst\(posts\)\.slice\(0, MAX_FEED_ITEMS\)/,
  );
  assert.match(rssWorker, /const RSS_EDGE_CACHE_VERSION = 2;/);
  assert.match(
    rssWorker,
    /new Request\(`\$\{FEED_URL\}\?edge-v=\$\{RSS_EDGE_CACHE_VERSION\}`\)/,
  );
});

test("the service worker refreshes fallback blog data while the homepage renders it server-side", () => {
  const indexRoute = serviceWorker.indexOf(
    'url.pathname === "/blog/index.json"',
  );
  const generalCacheFirst = serviceWorker.indexOf(
    "// Other GET requests, including scripted HTML fetches",
  );
  assert.ok(indexRoute >= 0 && indexRoute < generalCacheFirst);
  const routeBody = serviceWorker.slice(indexRoute, generalCacheFirst);
  assert.match(routeBody, /fetch\(request\)[\s\S]*\.then\(cacheSuccessfulResponse\)/);
  assert.match(routeBody, /caches[\s\S]*\.match\(request\)/);
  assert.match(blogWorker, /max-age=0, s-maxage=60, must-revalidate/);
  assert.match(seoWorker, /max-age=0, s-maxage=60, must-revalidate/);
  assert.match(seoWorker, /async function loadHomepageEditorialContent\(env\)/);
  assert.match(seoWorker, /\.on\("#blogGrid"/);
  assert.match(seoWorker, /element\.setAttribute\("data-ssr-ready", "true"\)/);
  assert.doesNotMatch(seoWorker, /homepageBlogIndexFreshnessScript/);
  assert.match(indexHtml, /serverGrid\.dataset\.ssrReady === "true"/);
  assert.match(indexHtml, /register\("\/sw\.js", \{ updateViaCache: "none" \}\)/);
});

test("the deployment workflow validates and deploys the RSS worker", () => {
  assert.match(deployWorkflow, /node --check js\/rss-worker\.js/);
  assert.match(deployWorkflow, /tools\/homepage-blog-order\.test\.js/);
  assert.match(
    deployWorkflow,
    /deploy --dry-run --config wrangler-rss\.jsonc/,
  );
  assert.match(deployWorkflow, /deploy --config wrangler-rss\.jsonc/);
});
