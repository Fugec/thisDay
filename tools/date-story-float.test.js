import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __datePageEngagementTestHooks as hooks } from "../js/seo-worker.js";

const root = join(import.meta.dirname, "..");
const seoWorker = readFileSync(join(root, "js/seo-worker.js"), "utf8");
const story = {
  slug: "19-july-2026",
  title: "Brunel’s SS Great Britain Changes Ocean Travel",
  description:
    "How an iron hull and screw propeller helped reshape passenger shipping.",
  imageUrl:
    "https://upload.wikimedia.org/wikipedia/commons/example-ship.jpg",
};
const richPerson = {
  year: 1900,
  text: "Example Person, historian and author",
  pages: [
    {
      type: "standard",
      title: "Example Person",
      extract:
        "Example Person published the first major study of the archive in 1925, drawing on records that had never previously been catalogued. " +
        "The 1934 revised edition became a standard reference used by university historians across several countries. " +
        "In 1950 the author received a national award recognizing five decades of research and public scholarship.",
      thumbnail: {
        source:
          "https://upload.wikimedia.org/wikipedia/commons/example-person.jpg",
      },
      content_urls: {
        desktop: {
          page: "https://en.wikipedia.org/wiki/Example_Person",
        },
      },
    },
  ],
};

test("event, birthday, and death pages keep featured-story floats out of the clean layout", () => {
  const eventPage = hooks.generateEventsDateHTML(
    "july",
    19,
    {
      events: [
        {
          year: 1843,
          text:
            "Brunel's steamship SS Great Britain is launched with an iron hull and screw propeller.",
          pages: [],
        },
      ],
      births: [],
      deaths: [],
    },
    "https://thisday.info",
    [
      "The vessel used an iron hull at a scale that was unusual for ocean travel.",
      "Its screw propeller represented a major change from paddle-wheel propulsion.",
      "The ship later carried passengers across the Atlantic.",
    ],
    "",
    null,
    story,
  );
  const bornPage = hooks.generateBornHTML(
    "https://thisday.info",
    "july",
    19,
    { events: [], births: [richPerson], deaths: [] },
    story,
  );
  const diedPage = hooks.generateDiedHTML(
    "https://thisday.info",
    "july",
    19,
    { events: [], births: [], deaths: [richPerson] },
    story,
  );

  for (const html of [eventPage, bornPage, diedPage]) {
    assert.doesNotMatch(html, /date-story-float|Featured article for July 19/);
  }
});

test("cached date pages lose old featured-story floats without a KV rewrite", () => {
  const cached = `<html><head><style id="date-story-float-style">.date-story-float{display:grid}</style></head><body><main>
    <div class="card-box"><div class="major-events-summary">Summary</div><div class="tl-wrap"><div class="tl-item">Event</div></div></div>
    <div class="my-5 pt-3 border-top">Old navigation</div>
    </main><aside id="date-story-float">Featured article</aside>
    <script id="date-story-float-script">window.legacyFloat=true;</script></body></html>`;
  const cleaned = hooks.normalizeDatePageCleanLayoutHtml(cached, {
    type: "events",
    monthName: "july",
    day: 19,
  });

  assert.doesNotMatch(cleaned, /date-story-float|Featured article|Old navigation/);
  assert.match(cleaned, /class="date-bottom-navigation/);

  assert.match(
    seoWorker,
    /\^\\\/\(events\|born\|died\)\\\/\(\[a-z\]\+\)\\\/\(\\d\+\)\\\/\?\$/,
  );
  assert.doesNotMatch(seoWorker, /function buildFloatingDateStory|function ensureFloatingDateStoryHtml/);
});

test("date-page stories require a stored published post and advance automatically", async () => {
  const futureStory = {
    ...story,
    slug: "19-july-2027",
    publishedAt: "2027-07-19T00:15:00.000Z",
  };
  const routes = hooks.buildPublishedDateRouteMap([
    story,
    futureStory,
    { slug: "20-july-2027", title: "Tomorrow's article" },
  ]);

  assert.equal(routes.get("july-19")?.slug, "19-july-2027");
  assert.equal(routes.get("july-20")?.slug, "20-july-2027");

  const resetCache = () => {
    hooks.findMatchingDateBlogEntry.cachedRoutes = null;
    hooks.findMatchingDateBlogEntry.cacheExpiresAt = 0;
    hooks.findMatchingDateBlogEntry.verifiedSlugs = new Map();
  };
  const index = [{ ...futureStory }];

  resetCache();
  const missingReads = [];
  const missing = await hooks.findMatchingDateBlogEntry(
    {
      BLOG_AI_KV: {
        async get(key, options = {}) {
          missingReads.push(key);
          if (key === "index") {
            return options.type === "json" ? index : JSON.stringify(index);
          }
          return null;
        },
      },
    },
    "july",
    19,
  );
  assert.equal(missing, null);
  assert.deepEqual(missingReads, ["index", "post:19-july-2027"]);

  resetCache();
  const published = await hooks.findMatchingDateBlogEntry(
    {
      BLOG_AI_KV: {
        async get(key, options = {}) {
          if (key === "index") {
            return options.type === "json" ? index : JSON.stringify(index);
          }
          return key === "post:19-july-2027"
            ? "<!doctype html><title>Published</title>"
            : null;
        },
      },
    },
    "july",
    19,
  );
  assert.equal(published?.slug, "19-july-2027");
  resetCache();
});
