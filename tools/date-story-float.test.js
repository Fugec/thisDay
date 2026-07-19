import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
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

test("event, birthday, and death pages render the same floating date story", () => {
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
    assert.match(
      html,
      /id="date-story-float" class="major-event-item date-story-float"/,
    );
    assert.match(html, /class="date-story-float-image"/);
    assert.match(
      html,
      /<strong class="date-story-float-title">Brunel’s SS Great Britain Changes Ocean Travel<\/strong>/,
    );
    assert.match(
      html,
      /<span class="date-story-float-description">How an iron hull and screw propeller helped reshape passenger shipping\.<\/span>/,
    );
    assert.match(
      html,
      /href="\/blog\/19-july-2026\/" class="major-event-source date-story-float-link">Read More<i class="bi bi-arrow-right"/,
    );
    assert.match(html, /id="date-story-float-script"/);
    assert.equal((html.match(/id="date-story-float"/g) || []).length, 1);
  }
});

test("cached date pages receive or refresh one floating story without a KV rewrite", () => {
  const cached = `<html><head></head><body><main><section class="dyn-slider-shell"></section></main></body></html>`;
  const inserted = hooks.ensureFloatingDateStoryHtml(
    cached,
    story,
    "July",
    19,
  );
  const refreshed = hooks.ensureFloatingDateStoryHtml(
    inserted,
    {
      ...story,
      slug: "19-july-2027",
      title: "A Newer July 19 Story",
    },
    "July",
    19,
  );

  assert.match(inserted, /aria-label="Featured article for July 19"/);
  assert.match(inserted, /id="date-story-float-style"/);
  assert.ok(
    inserted.indexOf('id="date-story-float-style"') <
      inserted.indexOf("</head>"),
  );
  assert.match(
    inserted,
    /\.date-story-float\{[^}]*display:grid;[^}]*border:1px solid var\(--cbr\);[^}]*background:var\(--bg-alt\)/,
  );
  assert.match(
    inserted,
    /\.date-story-float-link\{display:inline-flex;[^}]*text-decoration:none/,
  );
  assert.match(refreshed, /href="\/blog\/19-july-2027\/"/);
  assert.match(refreshed, />A Newer July 19 Story<\/strong>/);
  assert.doesNotMatch(refreshed, /href="\/blog\/19-july-2026\/"/);
  assert.equal((refreshed.match(/id="date-story-float"/g) || []).length, 1);
  assert.equal(
    (refreshed.match(/id="date-story-float-script"/g) || []).length,
    1,
  );
  assert.equal(
    (refreshed.match(/id="date-story-float-style"/g) || []).length,
    1,
  );
  assert.equal(
    hooks.ensureFloatingDateStoryHtml(
      cached,
      { ...story, slug: "../../admin" },
      "July",
      19,
    ),
    cached,
  );

  assert.match(
    seoWorker,
    /\^\\\/\(events\|born\|died\)\\\/\(\[a-z\]\+\)\\\/\(\\d\+\)\\\/\?\$/,
  );
  assert.ok(
    (
      seoWorker.match(
        /ensureFloatingDateStoryHtml\(\s*cached,\s*relatedBlogEntry,/g,
      ) || []
    ).length >= 2,
  );
});

test("the floating story appears at the DYK threshold and hides above it", () => {
  const markup = hooks.buildFloatingDateStory(story, "July", 19);
  const script = markup.match(
    /<script id="date-story-float-script">([\s\S]*?)<\/script>/,
  );
  assert.ok(script);

  let triggerTop = 900;
  const listeners = {};
  const classes = new Set();
  const attributes = new Map();
  attributes.set("inert", "");
  const card = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    remove() {
      throw new Error("The card must not be removed when a DYK trigger exists");
    },
  };
  const context = {
    document: {
      getElementById(id) {
        return id === "date-story-float" ? card : null;
      },
      querySelector(selector) {
        return selector === ".dyn-slider-shell"
          ? { getBoundingClientRect: () => ({ top: triggerTop }) }
          : null;
      },
    },
    window: {
      innerHeight: 1000,
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
      requestAnimationFrame(callback) {
        callback();
      },
    },
  };

  vm.runInNewContext(script[1], context);
  assert.equal(classes.has("date-story-float-visible"), false);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(attributes.has("inert"), true);

  triggerTop = 700;
  listeners.scroll();
  assert.equal(classes.has("date-story-float-visible"), true);
  assert.equal(attributes.get("aria-hidden"), "false");
  assert.equal(attributes.has("inert"), false);

  triggerTop = 800;
  listeners.scroll();
  assert.equal(classes.has("date-story-float-visible"), false);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(attributes.has("inert"), true);
});
