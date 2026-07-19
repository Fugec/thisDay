import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __datePageEngagementTestHooks as hooks } from "../js/seo-worker.js";

const root = join(import.meta.dirname, "..");
const seoWorker = readFileSync(join(root, "js/seo-worker.js"), "utf8");
const currentDatePageRenderSource = seoWorker.slice(
  0,
  seoWorker.indexOf("function normalizeCachedDatePageControlsHtml"),
);

test("selected era chips retain the established green text color", () => {
  assert.match(
    seoWorker,
    /\.era-chip-active\{background:var\(--bg-alt\);color:var\(--btn-bg\);border-color:var\(--btn-bg\)\}/,
  );
  assert.doesNotMatch(
    currentDatePageRenderSource,
    /\.era-chip-active\{[^}]*color:var\(--btn-text\)/,
  );
});

test("date navigation reuses the same btn class and chevrons as month navigation", () => {
  assert.match(
    seoWorker,
    /class="btn date-top-link date-top-link-prev"[^>]*><i class="bi bi-chevron-left"/,
  );
  assert.match(
    seoWorker,
    /class="btn date-top-link date-top-link-next"[^>]*>[\s\S]*?<i class="bi bi-chevron-right"/,
  );
  assert.doesNotMatch(
    currentDatePageRenderSource,
    /\.date-top-navigation \.date-top-link\{[^}]*background:/,
  );
  assert.match(
    currentDatePageRenderSource,
    /\.date-top-navigation\{display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/,
  );
  assert.doesNotMatch(
    currentDatePageRenderSource,
    /\.date-top-calendar\{grid-column:1\/-1;grid-row:1\}/,
  );
});

test("cached date pages receive the same control classes without a KV rewrite", () => {
  assert.match(
    seoWorker,
    /function normalizeCachedDatePageControlsHtml\(html\)/,
  );
  assert.match(
    seoWorker,
    /const normalizedControls = ensureEventAnchorNavigationHtml\(\s*normalizeCachedDatePageControlsHtml\(cached\),\s*\)/,
  );
  assert.match(
    seoWorker,
    /const kvKey = `gen-post-v48-[\s\S]*?const normalizedControls = ensureEventAnchorNavigationHtml\(\s*normalizeCachedDatePageControlsHtml\(cached\),\s*\)/,
  );
  assert.match(
    seoWorker,
    /\.replace\(\/class="date-top-link\/g, 'class="btn date-top-link'\)/,
  );
  assert.match(
    seoWorker,
    /\.date-top-navigation \.date-top-link\{display:flex;align-items:center;/,
  );

  const legacyHtml = `<html><head><style>
.era-chip-active{background:var(--btn-bg);color:var(--btn-text);border-color:var(--btn-bg)}
.date-top-navigation .date-top-link{display:flex;align-items:center;gap:.5rem;min-height:44px;padding:.65rem .85rem;border:1.5px solid var(--cbr);border-radius:8px;background:var(--cb);color:var(--tc);text-decoration:none;font-size:14px}
.date-top-navigation .date-top-link:hover{background:var(--bg-alt);border-color:var(--btn-bg);text-decoration:none}
.date-top-navigation .date-top-link-next{justify-content:flex-end;text-align:right}
.date-top-navigation .date-top-calendar{justify-content:center;font-weight:600}
@media(max-width:575px){.date-top-navigation{grid-template-columns:1fr 1fr}.date-top-calendar{grid-column:1/-1;grid-row:1}.date-top-navigation .date-top-link-prev{grid-column:1}.date-top-navigation .date-top-link-next{grid-column:2}}
</style></head><body>
<div class="date-top-navigation"><a class="date-top-link date-top-link-prev"><i class="bi bi-arrow-left"></i></a></div>
</body></html>`;
  const normalized = hooks.ensureEventAnchorNavigationHtml(
    hooks.normalizeCachedDatePageControlsHtml(legacyHtml),
  );
  assert.match(normalized, /color:var\(--btn-bg\)/);
  assert.doesNotMatch(normalized, /color:var\(--btn-text\)/);
  assert.match(normalized, /class="btn date-top-link date-top-link-prev"/);
  assert.match(normalized, /bi-chevron-left/);
  assert.match(normalized, /id="event-anchor-navigation"/);
  assert.doesNotMatch(normalized, /grid-template-columns:1fr 1fr/);
  assert.doesNotMatch(normalized, /grid-column:1\/-1;grid-row:1/);

  const embeddedScript = normalized.match(
    /<script id="event-anchor-navigation">([\s\S]*?)<\/script>/,
  );
  assert.ok(embeddedScript);
  assert.doesNotThrow(() => new vm.Script(embeddedScript[1]));
});

test("event fragments reveal hidden chronology cards before scrolling", () => {
  const event = {
    year: 1843,
    text: "SS Great Britain is launched with an iron hull and screw propeller.",
    pages: [],
  };
  const eventPage = hooks.generateEventsDateHTML(
    "july",
    19,
    {
      events: [event],
      births: [],
      deaths: [],
    },
    "https://thisday.info",
  );

  assert.match(eventPage, /id="event-anchor-navigation"/);
  assert.ok(
    eventPage.includes(`id="${hooks.historicalEventAnchorId(event)}"`),
  );
  const imageEvent = {
    ...event,
    pages: [
      {
        originalimage: {
          source:
            "https://upload.wikimedia.org/wikipedia/commons/example.jpg",
        },
      },
    ],
  };
  const imageEventPage = hooks.generateEventsDateHTML(
    "july",
    19,
    { events: [imageEvent], births: [], deaths: [] },
    "https://thisday.info",
  );
  assert.ok(
    imageEventPage.includes(
      `<div id="${hooks.historicalEventAnchorId(imageEvent)}" class="article-hero-wrap">`,
    ),
  );
  assert.match(
    seoWorker,
    /function buildEventAnchorNavigationScript\(\)/,
  );
  assert.match(
    seoWorker,
    /var moreWrap=target\.closest\('#events-more'\)/,
  );
  assert.match(
    seoWorker,
    /moreWrap\.style\.display='block'/,
  );
  assert.match(
    seoWorker,
    /target\.scrollIntoView\(\{block:'center'\}\)/,
  );
  assert.match(
    seoWorker,
    /schema\['@type'\]==='ItemList'[\s\S]*?featuredTarget\.id=featuredId/,
  );
  assert.match(
    seoWorker,
    /ensureEventAnchorNavigationHtml\(\s*normalizeCachedDatePageControlsHtml\(cached\),\s*\)/,
  );
  assert.match(
    seoWorker,
    /normalizeCachedDatePageControlsHtml\(await cached\.text\(\)\)/,
  );
});
