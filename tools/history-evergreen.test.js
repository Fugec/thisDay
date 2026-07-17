import assert from "node:assert/strict";
import test from "node:test";

import {
  __historyEvergreenTestHooks as hooks,
} from "../js/seo-worker.js";

const canonicalSlug = "spanish-civil-war-1936";
const legacySlug = "spanish-civil-war-erupts";
const canonicalPath = `/history/${canonicalSlug}/`;

function richStoredEntity() {
  return {
    type: "event",
    slug: legacySlug,
    name: "Spanish Civil War Erupts",
    url: `/history/${legacySlug}/`,
    wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/example.jpg",
    intro:
      "A military uprising against the Second Spanish Republic began in July 1936.",
    summary:
      "The uprising divided Spain between Republican and Nationalist zones.",
    description: "1936–1939 civil war in Spain",
    bodySections: [{
      heading: "Stored history",
      paragraphs: [
        Array.from(
          { length: 320 },
          (_, index) => `grounded${index}`,
        ).join(" ") + ".",
      ],
    }],
    relatedPosts: ["17-july-2026"],
    sourcePostUrl: "/blog/17-july-2026/",
    sourcePostTitle:
      "How Did a Partly Failed Coup Become the Spanish Civil War?",
    qualityGateVersion: 1,
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function mockBlogKv() {
  const values = {
    [`entity-v1:event:${legacySlug}`]: JSON.stringify(richStoredEntity()),
    index: JSON.stringify([{
      slug: "17-july-2026",
      title: "How Did a Partly Failed Coup Become the Spanish Civil War?",
      description:
        "A partly failed military coup divided Spain and began the Spanish Civil War.",
      publishedAt: "2026-07-17T00:05:00.000Z",
    }]),
    "entity-index-v1": JSON.stringify([
      {
        type: "event",
        slug: legacySlug,
        name: "Spanish Civil War Erupts",
        url: `/history/${legacySlug}/`,
        indexable: true,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      {
        type: "event",
        slug: canonicalSlug,
        name: "Duplicate canonical test record",
        url: canonicalPath,
        indexable: true,
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
      {
        type: "person",
        slug: "francisco-franco",
        name: "Francisco Franco",
        url: "/people/francisco-franco/",
        indexable: true,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    ]),
  };
  const writes = [];
  return {
    writes,
    async get(key, options) {
      const value = values[key] ?? null;
      if (options?.type === "json" && value) return JSON.parse(value);
      return value;
    },
    async put(key, value) {
      writes.push([key, value]);
      values[key] = value;
    },
  };
}

test("evergreen edition covers the requested reader questions with original depth", () => {
  const page = hooks.getHistoryEvergreenPage(canonicalSlug);

  assert.ok(page);
  assert.equal(page.storageSlug, legacySlug);
  assert.equal(page.url, canonicalPath);
  assert.equal(
    hooks.HISTORY_LEGACY_REDIRECTS.get(legacySlug),
    canonicalSlug,
  );
  assert.ok(
    hooks.entityBodyWordCount(page) >= 700,
    `expected at least 700 body words, got ${hooks.entityBodyWordCount(page)}`,
  );
  assert.deepEqual(
    page.bodySections.map((section) => section.heading),
    [
      "Why the Second Republic was vulnerable",
      "Who fought—and why two labels hide many factions",
      "July 17–20: how a coup became a war",
      "Foreign intervention changed the balance",
      "Outcome, dictatorship, and the longer aftermath",
    ],
  );
  assert.ok(page.timeline.length >= 8);
  assert.ok(page.comparisonRows.length >= 3);
  assert.ok(page.sourceLinks.length >= 5);
  assert.equal(page.relatedPosts[0], "17-july-2026");
});

test("legacy history URL returns a permanent one-hop redirect", async () => {
  const request = new Request(
    `https://thisday.info/history/${legacySlug}/?source=old`,
  );
  const response = await hooks.handleFetchRequest(
    request,
    {},
    {},
  );

  assert.equal(
    hooks.isEdgeCacheable(new URL(request.url), request),
    false,
    "a cached legacy 200 page must not mask the permanent redirect",
  );
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    `https://thisday.info${canonicalPath}`,
  );
});

test("new evergreen URL renders a self-canonical, sources, and date-article backlink", async () => {
  const blogKv = mockBlogKv();
  const pending = [];
  const response = await hooks.handleFetchRequest(
    new Request(`https://thisday.info${canonicalPath}`),
    { BLOG_AI_KV: blogKv },
    { waitUntil(promise) { pending.push(promise); } },
  );
  await Promise.all(pending);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/thisday\.info\/history\/spanish-civil-war-1936\/"/,
  );
  assert.match(
    html,
    /<h1 class="mb-2 fw-bold">Why Did Spain&#39;s July 1936 Coup Fail—and Start a Civil War\?<\/h1>/,
  );
  assert.match(html, /<meta name="robots" content="index, follow, max-image-preview:large"/);
  assert.match(html, /The four-day failure that changed the conflict/);
  assert.match(html, /Foreign intervention changed the balance/);
  assert.match(html, /Sources and further reading/);
  assert.match(html, /href="\/blog\/17-july-2026\/"/);
  assert.match(html, /digitalcommons\.usf\.edu\/span_civil_war/);
  assert.match(html, /www\.loc\.gov\/collections\/spanish-civil-war-posters/);
  assert.doesNotMatch(
    html,
    /rel="canonical" href="[^"]*spanish-civil-war-erupts/,
  );
  assert.equal(
    blogKv.writes.some(([key]) =>
      key === `entity-v1:event:${canonicalSlug}`),
    false,
    "rendering the canonical page must not create a second entity record",
  );
});

test("entity sitemap emits only the canonical history URL and de-duplicates it", async () => {
  const response = await hooks.handleFetchRequest(
    new Request("https://thisday.info/sitemap-entities.xml"),
    { BLOG_AI_KV: mockBlogKv() },
    {},
  );
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal(
    (xml.match(
      /https:\/\/thisday\.info\/history\/spanish-civil-war-1936\//g,
    ) || []).length,
    1,
  );
  assert.doesNotMatch(xml, /spanish-civil-war-erupts/);
  assert.match(xml, /https:\/\/thisday\.info\/people\/francisco-franco\//);
});

test("canonical path mapping leaves people and unrelated history URLs alone", () => {
  assert.equal(
    hooks.canonicalEntityPublicPath({
      type: "event",
      slug: legacySlug,
    }),
    canonicalPath,
  );
  assert.equal(
    hooks.canonicalEntityPublicPath({
      type: "event",
      slug: "moon-landing-1969",
    }),
    "/history/moon-landing-1969/",
  );
  assert.equal(
    hooks.canonicalEntityPublicPath({
      type: "person",
      slug: "francisco-franco",
    }),
    "/people/francisco-franco/",
  );
});
