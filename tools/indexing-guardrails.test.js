import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __indexabilityTestHooks as hooks } from "../js/seo-worker.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serviceWorker = readFileSync(join(root, "sw.js"), "utf8");
const homepage = readFileSync(join(root, "index.html"), "utf8");

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
  assert.match(serviceWorker, /const CACHE_NAME = "thisday-v32"/);
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
