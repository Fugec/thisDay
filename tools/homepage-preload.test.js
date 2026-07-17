import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  __homepagePerformanceTestHooks as hooks,
} from "../js/seo-worker.js";

function rawPage(overrides = {}) {
  return {
    type: "standard",
    title: "Example_Subject",
    displaytitle: "<b>Example Subject</b>",
    namespace: { id: 0, text: "" },
    wikibase_item: "Q123",
    titles: {
      canonical: "Example_Subject",
      normalized: "Example Subject",
      display: "<b>Example Subject</b>",
    },
    pageid: 123,
    lang: "en",
    dir: "ltr",
    revision: "999999",
    tid: "unused-render-id",
    timestamp: "2026-07-17T00:00:00Z",
    description: "A useful page description",
    description_source: "local",
    coordinates: { lat: 1, lon: 2 },
    content_urls: {
      desktop: {
        page: "https://en.wikipedia.org/wiki/Example_Subject",
        revisions: "https://en.wikipedia.org/wiki/Example_Subject?action=history",
        edit: "https://en.wikipedia.org/wiki/Example_Subject?action=edit",
        talk: "https://en.wikipedia.org/wiki/Talk:Example_Subject",
      },
      mobile: {
        page: "https://en.m.wikipedia.org/wiki/Example_Subject",
        revisions: "https://en.m.wikipedia.org/wiki/Special:History/Example_Subject",
        edit: "https://en.m.wikipedia.org/wiki/Example_Subject?action=edit",
        talk: "https://en.m.wikipedia.org/wiki/Talk:Example_Subject",
      },
    },
    extract: "A useful plaintext extract.",
    extract_html: "<p>A useful <b>HTML</b> extract.</p>",
    normalizedtitle: "Example Subject",
    thumbnail: {
      source: "https://upload.wikimedia.org/example-330.jpg",
      width: 330,
      height: 220,
    },
    originalimage: {
      source: "https://upload.wikimedia.org/example.jpg",
      width: 1920,
      height: 1280,
    },
    ...overrides,
  };
}

function rawItem(index = 0) {
  return {
    text: `Example historical record ${index}`,
    year: 1900 + index,
    pages: [
      rawPage(),
      rawPage({
        title: "Unused_Second_Page",
        content_urls: {
          desktop: {
            page: "https://en.wikipedia.org/wiki/Unused_Second_Page",
          },
        },
      }),
    ],
  };
}

test("homepage preload keeps only fields consumed by the browser", () => {
  const payload = hooks.buildHomepagePreloadPayload({
    events: [rawItem()],
    births: [rawItem(1)],
    deaths: [rawItem(2)],
  });
  const item = payload.events[0];
  const page = item.pages[0];

  assert.equal(payload.version, 2);
  assert.deepEqual(Object.keys(item), ["text", "year", "pages"]);
  assert.equal(item.pages.length, 1);
  assert.deepEqual(Object.keys(page), [
    "title",
    "description",
    "extract",
    "content_urls",
    "thumbnail",
    "originalimage",
  ]);
  assert.equal(page.content_urls.desktop.page, "https://en.wikipedia.org/wiki/Example_Subject");
  assert.equal(page.thumbnail.source, "https://upload.wikimedia.org/example-330.jpg");
  assert.equal(page.originalimage.source, "https://upload.wikimedia.org/example.jpg");
  assert.equal("revision" in page, false);
  assert.equal("extract_html" in page, false);
  assert.equal("mobile" in page.content_urls, false);
});

test("homepage preload preserves every valid event, birth, and death", () => {
  const payload = hooks.buildHomepagePreloadPayload({
    events: Array.from({ length: 47 }, (_, index) => rawItem(index)),
    births: Array.from({ length: 211 }, (_, index) => rawItem(index)),
    deaths: Array.from({ length: 135 }, (_, index) => rawItem(index)),
  });
  assert.equal(payload.events.length, 47);
  assert.equal(payload.births.length, 211);
  assert.equal(payload.deaths.length, 135);
});

test("compaction reduces a representative compressed preload by more than half", () => {
  const full = {
    events: Array.from({ length: 47 }, (_, index) => rawItem(index)),
    births: Array.from({ length: 211 }, (_, index) => rawItem(index)),
    deaths: Array.from({ length: 135 }, (_, index) => rawItem(index)),
  };
  const compact = hooks.buildHomepagePreloadPayload(full);
  const fullBytes = gzipSync(JSON.stringify(full), { level: 9 }).length;
  const compactBytes = gzipSync(JSON.stringify(compact), { level: 9 }).length;

  assert.ok(
    compactBytes < fullBytes * 0.5,
    `expected >50% gzip reduction; full=${fullBytes}, compact=${compactBytes}`,
  );
});

test("inline serialization cannot terminate its application/json script", () => {
  const serialized = hooks.serializeInlineJson({
    events: [{
      text: "</script><script>alert('x')</script>",
      year: 2026,
      pages: [],
    }],
  });
  assert.equal(serialized.includes("</script>"), false);
  assert.deepEqual(JSON.parse(serialized), {
    events: [{
      text: "</script><script>alert('x')</script>",
      year: 2026,
      pages: [],
    }],
  });
});
