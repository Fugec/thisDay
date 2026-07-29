import assert from "node:assert/strict";
import test from "node:test";

import {
  failingPublicIndexabilityResults,
  inspectPublicIndexability,
  isCloudflareManagedChallenge,
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

test("only a confirmed Cloudflare challenge can be skipped explicitly", () => {
  const challengeHtml = `<!doctype html><title>Just a moment...</title>
    <meta name="robots" content="noindex,nofollow">
    <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
  const challengeHeaders = new Headers({
    Server: "cloudflare",
    "CF-Ray": "example-SJJ",
  });
  assert.equal(
    isCloudflareManagedChallenge({
      status: 403,
      headers: challengeHeaders,
      html: challengeHtml,
    }),
    true,
  );

  const challenge = inspectPublicIndexability({
    requestedUrl: "https://thisday.info/",
    status: 403,
    headers: challengeHeaders,
    html: challengeHtml,
  });
  const ordinaryNoindex = inspectPublicIndexability({
    requestedUrl: "https://thisday.info/blocked",
    status: 200,
    html: '<meta name="robots" content="noindex,nofollow">',
  });

  assert.deepEqual(failingPublicIndexabilityResults([challenge]), [challenge]);
  assert.deepEqual(
    failingPublicIndexabilityResults([challenge], {
      allowCloudflareChallenge: true,
    }),
    [],
  );
  assert.deepEqual(
    failingPublicIndexabilityResults([ordinaryNoindex], {
      allowCloudflareChallenge: true,
    }),
    [ordinaryNoindex],
  );
});

test("live verifier checks the homepage, blog, and newest safe article slug", async () => {
  const requested = [];
  const userAgents = [];
  const fetchImpl = async (url, options = {}) => {
    requested.push(url);
    userAgents.push(new Headers(options.headers).get("user-agent") || "");
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
  assert.ok(userAgents.every((value) => value.includes("Mozilla/5.0")));
  assert.ok(userAgents.every((value) => !/googlebot/i.test(value)));
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.indexable));
});
