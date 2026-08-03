import assert from "node:assert/strict";
import test from "node:test";

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

  assert.equal(payload.version, 4);
  assert.equal(payload.partial, true);
  assert.deepEqual(payload.counts, { events: 1, births: 1, deaths: 1 });
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

test("homepage preload caps the initial preview while preserving full counts", () => {
  const payload = hooks.buildHomepagePreloadPayload({
    events: Array.from({ length: 47 }, (_, index) => rawItem(index)),
    births: Array.from({ length: 211 }, (_, index) => rawItem(index)),
    deaths: Array.from({ length: 135 }, (_, index) => rawItem(index)),
  });
  assert.equal(payload.events.length, 12);
  assert.equal(payload.births.length, 6);
  assert.equal(payload.deaths.length, 6);
  assert.deepEqual(payload.counts, { events: 47, births: 211, deaths: 135 });
  for (const person of [...payload.births, ...payload.deaths]) {
    assert.ok(person.pages[0].thumbnail?.source || person.pages[0].originalimage?.source);
    assert.match(person.pages[0].content_urls.desktop.page, /^https:\/\/en\.wikipedia\.org\/wiki\//);
  }
});

test("homepage preload prioritizes eight illustrated event cards", () => {
  const withoutImages = Array.from({ length: 8 }, (_, index) => {
    const item = rawItem(index);
    delete item.pages[0].thumbnail;
    delete item.pages[0].originalimage;
    return item;
  });
  const illustrated = Array.from({ length: 8 }, (_, index) => rawItem(index + 20));
  const payload = hooks.buildHomepagePreloadPayload({
    events: [...withoutImages, ...illustrated],
  });

  assert.equal(payload.events.length, 12);
  assert.equal(
    payload.events.slice(0, 8).every((event) => event.pages[0]?.thumbnail?.source),
    true,
  );
});

test("featured birth and death cards reuse compact person metadata", () => {
  const person = rawItem(5);
  const content = hooks.homepageFeaturedPersonContent(person);

  assert.deepEqual(content, {
    title: "Example Subject",
    description: "A useful plaintext extract.",
    imageUrl: "https://upload.wikimedia.org/example.jpg",
  });
});

test("featured person names prefer the readable on-this-day label", () => {
  const person = rawItem(5);
  person.text = "James Anderson, English cricketer and record-setting bowler";
  person.pages[0].title = "James_Anderson_(cricketer)";
  delete person.pages[0].normalizedtitle;

  assert.equal(
    hooks.homepageFeaturedPersonContent(person).title,
    "James Anderson",
  );
});

test("preview reduces representative raw preload bytes by at least 85 percent", () => {
  const full = {
    events: Array.from({ length: 47 }, (_, index) => rawItem(index)),
    births: Array.from({ length: 211 }, (_, index) => rawItem(index)),
    deaths: Array.from({ length: 135 }, (_, index) => rawItem(index)),
  };
  const compact = hooks.buildHomepagePreloadPayload(full);
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));

  assert.ok(
    compactBytes < fullBytes * 0.15,
    `expected >85% raw reduction; full=${fullBytes}, compact=${compactBytes}`,
  );
  assert.ok(compactBytes < 30000, `expected preview below 30KB; compact=${compactBytes}`);
});

test("preview bounds long visible text and extracts", () => {
  const longText = Array.from({ length: 200 }, () => "historical record").join(" ");
  const longExtract = Array.from({ length: 200 }, () => "biographical detail").join(" ");
  const item = rawItem();
  item.text = longText;
  item.pages[0].extract = longExtract;
  const payload = hooks.buildHomepagePreloadPayload({
    events: [item],
    births: [item],
    deaths: [item],
  });
  assert.ok(payload.events[0].text.length <= 600);
  assert.ok(payload.events[0].pages[0].extract.length <= 240);
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
