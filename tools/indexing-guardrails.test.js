import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __indexabilityTestHooks as hooks } from "../js/seo-worker.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serviceWorker = readFileSync(join(root, "sw.js"), "utf8");
const homepage = readFileSync(join(root, "index.html"), "utf8");
const seoWorker = readFileSync(join(root, "js/seo-worker.js"), "utf8");

test("homepage CSP permits regional Google Analytics collection", () => {
  assert.match(
    seoWorker,
    /connect-src[\s\S]*?https:\/\/analytics\.google\.com https:\/\/\*\.analytics\.google\.com https:\/\/\*\.google-analytics\.com/,
  );
});

test("homepage CSP permits Google Ads frames", () => {
  assert.match(
    seoWorker,
    /frame-src[^;]*https:\/\/pagead2\.googlesyndication\.com/,
  );
});

test("public CSP permits Open Library covers that redirect to Archive.org", () => {
  assert.match(
    seoWorker,
    /img-src[^;]*https:\/\/covers\.openlibrary\.org[^;]*https:\/\/archive\.org https:\/\/\*\.archive\.org/,
  );
});

test("history pages bypass edge entries cached before the public CSP update", () => {
  const version = Number(
    seoWorker.match(/const HISTORY_EDGE_CACHE_VERSION = (\d+);/)?.[1] || 0,
  );
  assert.ok(version >= 3, `history edge cache version is still ${version}`);
});

test("all public HTML responses receive the shared security contract", async () => {
  const response = hooks.applyPublicHtmlSecurityHeaders(
    new Response("<!doctype html><h1>Person page</h1>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        Link: "</css/custom.css>; rel=preload; as=style",
      },
    }),
  );

  assert.equal(
    response.headers.get("content-security-policy"),
    hooks.PUBLIC_HTML_CSP,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains; preload",
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  assert.match(response.headers.get("permissions-policy"), /unload=\*/);
  assert.equal(response.headers.get("link"), null);
});

test("security wrapper preserves deliberate CSP, versioned preloads, and non-HTML", () => {
  const versioned = hooks.applyPublicHtmlSecurityHeaders(
    new Response("<!doctype html>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'",
        Link: "</css/custom.css?v=54>; rel=preload; as=style",
      },
    }),
  );
  assert.equal(
    versioned.headers.get("content-security-policy"),
    "default-src 'self'",
  );
  assert.equal(
    versioned.headers.get("link"),
    "</css/custom.css?v=54>; rel=preload; as=style",
  );

  const json = new Response("{}", {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(hooks.applyPublicHtmlSecurityHeaders(json), json);
  assert.equal(json.headers.get("content-security-policy"), null);
});

test("maintenance content is served as a temporary non-cacheable response", async () => {
  const request = new Request("https://thisday.info/some-public-page/");
  let upstreamUrl = "";
  const response = await hooks.serveMaintenanceResponse(request, async (upstream) => {
    upstreamUrl = upstream.url;
    return new Response(
      '<!doctype html><meta name="robots" content="noindex, nofollow"><h1>Maintenance</h1>',
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=600",
          Age: "45",
          ETag: '"maintenance"',
        },
      },
    );
  });

  assert.equal(upstreamUrl, "https://thisday.info/maintenance.html");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "3600");
  assert.equal(
    response.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate",
  );
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.headers.get("age"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.match(await response.text(), /Maintenance/);
});

test("maintenance fallback remains a no-store 503 when its asset is unavailable", async () => {
  const response = await hooks.serveMaintenanceResponse(
    new Request("https://thisday.info/"),
    async () => {
      throw new Error("origin unavailable");
    },
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Temporarily unavailable/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("service worker cannot preserve redirected or noindex HTML", () => {
  assert.match(serviceWorker, /const CACHE_NAME = "thisday-v43"/);
  const assets = serviceWorker.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)?.[1] || "";
  assert.doesNotMatch(assets, /^\s*["']\/["']/m);
  assert.doesNotMatch(assets, /["']\/index\.html["']/);
  assert.match(serviceWorker, /response\.redirected/);
  assert.match(serviceWorker, /x-robots-tag/);
  assert.match(serviceWorker, /responseHtmlBlocksIndexing/);
  assert.match(serviceWorker, /noindex/);
});

test("the static homepage remains explicitly index-follow", () => {
  assert.match(
    homepage,
    /<meta\s+name="robots"\s+content="index, follow"\s*\/?>/i,
  );
});
