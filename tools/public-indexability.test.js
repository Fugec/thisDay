import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectPublicIndexability,
  robotsMetaDirectives,
  verifyPublicIndexability,
} from "./public-indexability.js";

test("robotsMetaDirectives handles attribute order and quoting", () => {
  const html = `
    <meta content="index, follow" name="robots">
    <meta name='robots' content='max-image-preview:large'>`;
  assert.deepEqual(robotsMetaDirectives(html), [
    "index, follow",
    "max-image-preview:large",
  ]);
});

test("public indexability rejects noindex from meta or response headers", () => {
  const metaBlocked = inspectPublicIndexability({
    requestedUrl: "https://thisday.info/",
    status: 200,
    html: '<meta name="robots" content="noindex,nofollow">',
  });
  assert.equal(metaBlocked.indexable, false);
  assert.deepEqual(metaBlocked.issues, ["declares noindex", "declares nofollow"]);

  const headerBlocked = inspectPublicIndexability({
    requestedUrl: "https://thisday.info/",
    status: 200,
    headers: new Headers({ "X-Robots-Tag": "noindex, follow" }),
  });
  assert.equal(headerBlocked.indexable, false);
  assert.deepEqual(headerBlocked.issues, ["declares noindex"]);
});

test("public indexability accepts a canonical index-follow page", () => {
  const result = inspectPublicIndexability({
    requestedUrl: "https://thisday.info/",
    finalUrl: "https://thisday.info/",
    status: 200,
    html: '<meta name="robots" content="index, follow">',
  });
  assert.equal(result.indexable, true);
  assert.deepEqual(result.issues, []);
});

test("live verifier checks the homepage, blog, and newest safe article slug", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith("/blog/index.json")) {
      return new Response(JSON.stringify([{ slug: "29-july-2026" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response('<meta name="robots" content="index, follow">', {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const results = await verifyPublicIndexability({ fetchImpl });
  assert.deepEqual(requested, [
    "https://thisday.info/blog/index.json",
    "https://thisday.info/",
    "https://thisday.info/blog/",
    "https://thisday.info/blog/29-july-2026/",
  ]);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.indexable));
});
