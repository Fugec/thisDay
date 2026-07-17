import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_MIN_INDEXABLE_ARTICLES,
  archiveCollectionIsIndexable,
  archiveEditorialContext,
  archiveRequestIsCanonical,
  archiveRootIsIndexable,
  archiveUsablePosts,
  buildArchiveKeywordEntries,
  buildArchiveYearEntries,
  getArchivePostsForTopicHub,
  qualifiedArchivePaths,
} from "../js/shared/archive-indexability.js";
import {
  __archiveIndexabilityTestHooks as seoHooks,
} from "../js/seo-worker.js";
import {
  __contentGenerationTestHooks as blogHooks,
} from "../js/blog-ai-worker.js";
import {
  __archiveIndexabilityTestHooks as sitemapHooks,
} from "../js/sitemap-worker.js";
import { EVIDENCE_TOPIC_HUBS } from "../js/shared/topic-relevance.js";

function post(index, overrides = {}) {
  return {
    slug: `world-war-ii-operation-${index}`,
    title: `World War II Operation ${index} Changes the Allied Campaign`,
    description:
      `World War II operation ${index} documents a distinct Allied campaign decision, its immediate military setting, and the consequences that followed.`,
    publishedAt: `2026-06-${String(index).padStart(2, "0")}T00:05:00.000Z`,
    historicalYear: 1944,
    eventTitle: `World War II Operation ${index}`,
    sourcePageTitle: "World War II",
    keywords: "World War II, Allied campaign",
    pillars: ["War & Conflict"],
    ...overrides,
  };
}

function posts(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) =>
    post(index + 1, typeof overrides === "function" ? overrides(index) : overrides),
  );
}

function mockEnv(index) {
  return {
    BLOG_AI_KV: {
      async get(key, options = {}) {
        if (key !== "index") return null;
        return options?.type === "json" ? index : JSON.stringify(index);
      },
    },
  };
}

function meta(html, name) {
  return html.match(
    new RegExp(`<meta name="${name}" content="([^"]+)"`, "i"),
  )?.[1];
}

test("five distinct complete articles are required for archive indexability", () => {
  const four = posts(4);
  const five = posts(5);
  assert.equal(ARCHIVE_MIN_INDEXABLE_ARTICLES, 5);
  assert.equal(archiveCollectionIsIndexable(four), false);
  assert.equal(archiveCollectionIsIndexable(five), true);
  assert.equal(
    archiveCollectionIsIndexable([...five, five[0]]),
    true,
    "a duplicate slug must not inflate the count",
  );
  assert.equal(
    archiveCollectionIsIndexable([
      ...four,
      post(5, { description: "Too short." }),
    ]),
    false,
    "a thin index entry must not satisfy the gate",
  );
  assert.equal(archiveUsablePosts(five).length, 5);
});

test("query and pagination variants stay noindex with the clean URL canonical", () => {
  const canonical = new URL("https://thisday.info/years/1944/");
  const variant = new URL("https://thisday.info/years/1944/?page=2");
  assert.equal(archiveRequestIsCanonical(canonical), true);
  assert.equal(archiveRequestIsCanonical(variant), false);
  assert.equal(archiveCollectionIsIndexable(posts(5), variant), false);
});

test("year and keyword entries use exact repeated evidence and ignore duplicates", () => {
  const index = posts(5);
  const years = buildArchiveYearEntries([
    ...index,
    index[0],
    post(8, { slug: "unsupported-bce-year", historicalYear: -44 }),
  ]);
  const keywords = buildArchiveKeywordEntries([...index, index[0]]);
  assert.equal(years.find((entry) => entry.year === 1944)?.posts.length, 5);
  assert.equal(years.some((entry) => entry.year === -44), false);
  assert.equal(
    keywords.find((entry) => entry.slug === "world-war-ii")?.posts.length,
    5,
  );
});

test("narrow topic matching rejects unrelated broad-pillar articles", () => {
  const worldWarTwo = EVIDENCE_TOPIC_HUBS.find(
    (hub) => hub.slug === "world-war-ii",
  );
  const unrelated = posts(8, (index) => ({
    slug: `unrelated-war-${index + 1}`,
    title: `Unrelated Historical Conflict ${index + 1} Changes a Regional Border`,
    description:
      "This separate regional conflict belongs to a broad war category and documents a border dispute between neighboring states.",
    eventTitle: `Regional conflict ${index + 1}`,
    sourcePageTitle: "Regional conflict",
    keywords: "regional conflict, border dispute",
    historicalYear: 1700 + index,
  }));
  const matched = getArchivePostsForTopicHub(
    [...posts(5), ...unrelated],
    worldWarTwo,
    50,
  );
  assert.deepEqual(
    new Set(matched.map((entry) => entry.slug)),
    new Set(posts(5).map((entry) => entry.slug)),
  );
  assert.equal(archiveCollectionIsIndexable(matched), true);
});

test("editorial context provides a page-specific reading path", () => {
  const context = archiveEditorialContext("World War II", posts(5), "topic");
  assert.ok(context);
  assert.match(context.lead, /World War II/);
  assert.match(context.route, /Operation 1/);
  assert.equal(context.examples.length, 3);
  assert.equal(archiveEditorialContext("World War II", posts(4), "topic"), null);
});

test("thin year pages render noindex, follow with a self-canonical", async () => {
  const response = await seoHooks.handleFetchRequest(
    new Request("https://thisday.info/years/1944/"),
    mockEnv(posts(4)),
    { waitUntil() {} },
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(meta(html, "robots"), "noindex, follow");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, follow");
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/thisday\.info\/years\/1944\/"/,
  );
  assert.match(html, /data-archive-indexable="0"/);
});

test("qualified year pages render editorial navigation and indexable robots", async () => {
  const response = await seoHooks.handleFetchRequest(
    new Request("https://thisday.info/years/1944/"),
    mockEnv(posts(5)),
    { waitUntil() {} },
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(
    meta(html, "robots"),
    "index, follow, max-image-preview:large",
  );
  assert.equal(response.headers.get("x-robots-tag"), null);
  assert.match(html, /data-archive-indexable="1"/);
  assert.match(html, /How to explore 1944/);
  assert.match(html, /href="\/blog\/world-war-ii-operation-1\/"/);
});

test("a paginated archive variant remains noindex and canonicalizes cleanly", async () => {
  const response = await seoHooks.handleFetchRequest(
    new Request("https://thisday.info/years/1944/?page=2"),
    mockEnv(posts(5)),
    { waitUntil() {} },
  );
  const html = await response.text();
  assert.equal(meta(html, "robots"), "noindex, follow");
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/thisday\.info\/years\/1944\/"/,
  );
});

test("topic routes require five evidence-matched complete articles", async () => {
  const thinResponse = await seoHooks.handleFetchRequest(
    new Request("https://thisday.info/topics/world-war-ii/"),
    mockEnv(posts(4)),
    { waitUntil() {} },
  );
  const thinHtml = await thinResponse.text();
  assert.equal(meta(thinHtml, "robots"), "noindex, follow");

  const richResponse = await seoHooks.handleFetchRequest(
    new Request("https://thisday.info/topics/world-war-ii/"),
    mockEnv(posts(5)),
    { waitUntil() {} },
  );
  const richHtml = await richResponse.text();
  assert.equal(
    meta(richHtml, "robots"),
    "index, follow, max-image-preview:large",
  );
  assert.match(richHtml, /How to explore World War II/);
});

test("archive root pages require three qualified child collections", async () => {
  const index = [
    ...posts(5, (index) => ({
      slug: `year-1944-${index + 1}`,
      historicalYear: 1944,
    })),
    ...posts(5, (index) => ({
      slug: `year-1945-${index + 1}`,
      historicalYear: 1945,
    })),
    ...posts(5, (index) => ({
      slug: `year-1946-${index + 1}`,
      historicalYear: 1946,
    })),
  ];
  const entries = buildArchiveYearEntries(index);
  assert.equal(archiveRootIsIndexable(entries), true);

  const response = await seoHooks.handleFetchRequest(
    new Request("https://thisday.info/years/"),
    mockEnv(index),
    { waitUntil() {} },
  );
  const html = await response.text();
  assert.equal(
    meta(html, "robots"),
    "index, follow, max-image-preview:large",
  );
  assert.match(html, /href="\/years\/1944\/"/);
});

test("pillar hubs follow the same threshold and render unique navigation", () => {
  const thinHtml = blogHooks.buildPillarHubHTML(
    "War & Conflict",
    "war-conflict",
    posts(4),
    false,
    [],
  );
  assert.equal(meta(thinHtml, "robots"), "noindex, follow");
  assert.match(thinHtml, /data-archive-indexable="0"/);

  const richHtml = blogHooks.buildPillarHubHTML(
    "War & Conflict",
    "war-conflict",
    posts(5),
    true,
    ["War & Conflict"],
  );
  assert.equal(
    meta(richHtml, "robots"),
    "index, follow, max-image-preview:large",
  );
  assert.match(richHtml, /How to explore War &amp; Conflict/);
  assert.match(richHtml, /data-archive-indexable="1"/);
});

test("pillar route query variants are noindex with a clean self-canonical", async () => {
  const response = await blogHooks.servePillarHub(
    mockEnv(posts(5)),
    "war-conflict",
    new URL("https://thisday.info/blog/topic/war-conflict/?page=2"),
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, follow");
  assert.equal(meta(html, "robots"), "noindex, follow");
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/thisday\.info\/blog\/topic\/war-conflict\/"/,
  );
});

test("sitemap output contains qualified archives and excludes thin ones", () => {
  const qualified = posts(5);
  const thin = posts(4, (index) => ({
    slug: `thin-science-${index + 1}`,
    title: `Thin Science Collection Entry ${index + 1} Records a Discovery`,
    description:
      "A separate science article describes a documented discovery but this collection has not reached the five-article threshold.",
    historicalYear: 1900 + index,
    eventTitle: `Science discovery ${index + 1}`,
    sourcePageTitle: `Science discovery ${index + 1}`,
    keywords: "Thin Science",
    pillars: ["Science & Technology"],
  }));
  const index = [...qualified, ...thin];
  const paths = qualifiedArchivePaths(index, [
    "War & Conflict",
    "Science & Technology",
  ]);
  assert.ok(paths.includes("/topics/world-war-ii/"));
  assert.ok(paths.includes("/years/1944/"));
  assert.ok(paths.includes("/keywords/world-war-ii/"));
  assert.ok(paths.includes("/blog/topic/war-conflict/"));
  assert.equal(paths.includes("/keywords/thin-science/"), false);
  assert.equal(paths.includes("/blog/topic/science-technology/"), false);

  const xml = sitemapHooks.buildMainSitemap(index, true, "2026-07-17");
  assert.match(xml, /https:\/\/thisday\.info\/topics\/world-war-ii\//);
  assert.match(xml, /https:\/\/thisday\.info\/years\/1944\//);
  assert.match(xml, /https:\/\/thisday\.info\/keywords\/world-war-ii\//);
  assert.doesNotMatch(xml, /keywords\/thin-science/);
  assert.doesNotMatch(xml, /blog\/topic\/science-technology/);
});
