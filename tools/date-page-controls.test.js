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

test("date navigation uses the existing month-nav with arrows and a plain centered date", () => {
  assert.match(
    seoWorker,
    /<div class="month-nav date-top-navigation">/,
  );
  assert.match(
    seoWorker,
    /class="btn date-top-link date-top-link-prev"[^>]*><i class="bi bi-chevron-left" aria-hidden="true"><\/i><\/a>/,
  );
  assert.match(
    seoWorker,
    /<h2 class="date-top-current">\$\{escapeHtml\(mDisplay\)\} \$\{day\}<\/h2>/,
  );
  assert.match(
    seoWorker,
    /class="btn date-top-link date-top-link-next"[^>]*><i class="bi bi-chevron-right" aria-hidden="true"><\/i><\/a>/,
  );
  assert.doesNotMatch(
    currentDatePageRenderSource,
    /\.date-top-navigation\{/,
  );
  assert.doesNotMatch(
    seoWorker.slice(
      seoWorker.indexOf("function buildDateTopNavigation"),
      seoWorker.indexOf("function buildEventAnchorNavigationScript"),
    ),
    /date-top-calendar|bi-calendar3|<span>\$\{escapeHtml\(prevMonthDisplay\)|<span>\$\{escapeHtml\(nextMonthDisplay\)/,
  );
});

test("cached date pages receive the same control classes without a KV rewrite", () => {
  assert.match(
    seoWorker,
    /function normalizeCachedDatePageControlsHtml\(\s*html,\s*\{ monthName = "", day = 0 \} = \{\},\s*\)/,
  );
  assert.match(
    seoWorker,
    /const normalizedControls = ensureEventAnchorNavigationHtml\(\s*normalizeCachedDatePageControlsHtml\(cached, \{ monthName, day \}\),\s*\)/,
  );
  assert.match(
    seoWorker,
    /const kvKey = `gen-post-v48-[\s\S]*?const normalizedControls = ensureEventAnchorNavigationHtml\(\s*normalizeCachedDatePageControlsHtml\(cached, \{ monthName, day \}\),\s*\)/,
  );
  assert.match(seoWorker, /navigationBlock\.match\(\/<a\\b/);
  assert.match(seoWorker, /link\.includes\(className\)/);

  const legacyHtml = `<html><head><style>
.major-event-source:hover{text-decoration:underline}
.era-chip-active{background:var(--btn-bg);color:var(--btn-text);border-color:var(--btn-bg)}
.date-top-navigation .date-top-link{display:flex;align-items:center;gap:.5rem;min-height:44px;padding:.65rem .85rem;border:1.5px solid var(--cbr);border-radius:8px;background:var(--cb);color:var(--tc);text-decoration:none;font-size:14px}
.date-top-navigation .date-top-link:hover{background:var(--bg-alt);border-color:var(--btn-bg);text-decoration:none}
.date-top-navigation .date-top-link-next{justify-content:flex-end;text-align:right}
.date-top-navigation .date-top-calendar{justify-content:center;font-weight:600}
@media(max-width:575px){.date-top-navigation{grid-template-columns:1fr 1fr}.date-top-calendar{grid-column:1/-1;grid-row:1}.date-top-navigation .date-top-link-prev{grid-column:1}.date-top-navigation .date-top-link-next{grid-column:2}}
</style></head><body>
<div class="date-top-navigation">
  <a href="/events/july/18/" class="date-top-link date-top-link-prev"><i class="bi bi-arrow-left"></i><span>July 18</span></a>
  <a href="/" class="date-top-link date-top-calendar"><i class="bi bi-calendar3"></i><span>July 19</span></a>
  <a href="/events/july/20/" class="date-top-link date-top-link-next"><span>July 20</span><i class="bi bi-arrow-right"></i></a>
</div>
</body></html>`;
  const normalized = hooks.ensureEventAnchorNavigationHtml(
    hooks.normalizeCachedDatePageControlsHtml(legacyHtml),
  );
  assert.match(normalized, /color:var\(--btn-bg\)/);
  assert.doesNotMatch(normalized, /color:var\(--btn-text\)/);
  assert.match(
    normalized,
    /\.major-event-source:hover,\.major-event-source:focus-visible\{text-decoration:none\}/,
  );
  assert.doesNotMatch(
    normalized,
    /\.major-event-source:hover\{text-decoration:underline\}/,
  );
  assert.match(
    normalized,
    /<div class="month-nav date-top-navigation">[\s\S]*?<h2 class="date-top-current">July 19<\/h2>/,
  );
  assert.match(
    normalized,
    /class="btn date-top-link date-top-link-prev"[^>]*><i class="bi bi-chevron-left" aria-hidden="true"><\/i><\/a>/,
  );
  assert.match(
    normalized,
    /class="btn date-top-link date-top-link-next"[^>]*><i class="bi bi-chevron-right" aria-hidden="true"><\/i><\/a>/,
  );
  assert.doesNotMatch(normalized, /date-top-calendar|bi-calendar3/);
  assert.doesNotMatch(normalized, />July 18<\/span>|>July 20<\/span>/);
  assert.match(normalized, /id="event-anchor-navigation"/);
  assert.doesNotMatch(normalized, /grid-template-columns:1fr 1fr/);
  assert.doesNotMatch(normalized, /grid-column:1\/-1;grid-row:1/);

  const embeddedScript = normalized.match(
    /<script id="event-anchor-navigation">([\s\S]*?)<\/script>/,
  );
  assert.ok(embeddedScript);
  assert.doesNotThrow(() => new vm.Script(embeddedScript[1]));

  const refreshed = hooks.ensureEventAnchorNavigationHtml(
    normalized.replace(
      embeddedScript[0],
      '<script id="event-anchor-navigation">window.oldAnchorLogic=true;</script>',
    ),
  );
  assert.doesNotMatch(refreshed, /oldAnchorLogic/);
  assert.match(refreshed, /var candidatePrefix=historicalEventAnchorId/);

  const normalizedAgain = hooks.normalizeCachedDatePageControlsHtml(
    normalized,
    { monthName: "july", day: 19 },
  );
  assert.equal(
    (
      normalizedAgain.match(
        /class="[^"]*\bdate-top-navigation\b[^"]*"/g,
      ) || []
    ).length,
    1,
  );
});

test("cached date pages from before the feature receive the complete navigation", () => {
  const legacyHtml = `<html><body>
<main class="container my-4">
  <nav aria-label="breadcrumb" class="mb-3"></nav>
  <h1 class="mb-2">July 18 in History</h1>
  <div class="article-hero-wrap"></div>
</main>
</body></html>`;
  const normalized = hooks.normalizeCachedDatePageControlsHtml(legacyHtml, {
    monthName: "july",
    day: 18,
  });

  assert.match(
    normalized,
    /<h1 class="mb-2">July 18 in History<\/h1>\s*<nav aria-label="July 18 date navigation">/,
  );
  assert.match(normalized, /class="month-nav date-top-navigation"/);
  assert.match(normalized, /<h2 class="date-top-current">July 18<\/h2>/);
  assert.match(
    normalized,
    /href="\/events\/july\/17\/"[^>]*aria-label="Previous day: July 17"/,
  );
  assert.match(
    normalized,
    /href="\/events\/july\/19\/"[^>]*aria-label="Next day: July 19"/,
  );
  assert.match(normalized, /class="date-view-tabs"/);
  assert.equal(
    (normalized.match(/class="month-nav date-top-navigation"/g) || []).length,
    1,
  );
  assert.ok(
    normalized.indexOf('class="date-top-navigation"') <
      normalized.indexOf('class="article-hero-wrap"'),
  );
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
    /var candidatePrefix=historicalEventAnchorId\(\{year:year,description:candidateText\}\)\.replace\(\/-\[a-z0-9\]\+\$\/,'-'\)/,
  );
  assert.match(
    seoWorker,
    /if\(id\.indexOf\(candidatePrefix\)===0\)\{item\.id=id;target=item;break;\}/,
  );
  assert.match(
    seoWorker,
    /schema\['@type'\]==='ItemList'[\s\S]*?featuredTarget\.id=featuredId/,
  );
  assert.match(
    seoWorker,
    /ensureEventAnchorNavigationHtml\(\s*normalizeCachedDatePageControlsHtml\(cached, \{ monthName, day \}\),\s*\)/,
  );
  assert.match(
    seoWorker,
    /normalizeCachedDatePageControlsHtml\(await cached\.text\(\), \{\s*monthName: cachedDateRoute\[1\],\s*day: Number\(cachedDateRoute\[2\]\),\s*\}\)/,
  );
});

test("legacy cards with an added page description still resolve the homepage fragment", () => {
  const event = {
    year: 1544,
    text: "Italian War of 1542–46: The first Siege of Boulogne begins.",
  };
  const requestedId = hooks.historicalEventAnchorId(event);
  const title = { textContent: event.text };
  const description = { textContent: "Ninth phase of the Italian Wars" };
  const badge = { textContent: String(event.year) };
  const moreWrap = { style: { display: "none" } };
  const moreButton = { style: { display: "" } };
  let scrollOptions = null;
  const item = {
    id: "",
    style: { display: "none" },
    getAttribute(name) {
      return name === "data-year" ? String(event.year) : "";
    },
    querySelector(selector) {
      if (selector === ".tl-card-title") return title;
      if (selector === ".tl-card-desc") return description;
      if (selector === ".event-years-ago") return badge;
      return null;
    },
    closest(selector) {
      return selector === "#events-more" ? moreWrap : null;
    },
    scrollIntoView(options) {
      scrollOptions = options;
    },
  };
  const document = {
    readyState: "complete",
    querySelectorAll(selector) {
      if (selector === ".tl-item") return [item];
      return [];
    },
    getElementById(id) {
      if (id === requestedId && item.id === requestedId) return item;
      if (id === "events-more-btn") return moreButton;
      return null;
    },
    addEventListener() {},
  };
  const eventPage = hooks.ensureEventAnchorNavigationHtml(
    "<html><body></body></html>",
  );
  const embeddedScript = eventPage.match(
    /<script id="event-anchor-navigation">([\s\S]*?)<\/script>/,
  );
  assert.ok(embeddedScript);

  vm.runInNewContext(embeddedScript[1], {
    document,
    location: { hash: `#${requestedId}` },
    requestAnimationFrame(callback) {
      callback();
    },
    window: { addEventListener() {} },
  });

  assert.equal(item.id, requestedId);
  assert.equal(item.style.display, "");
  assert.equal(moreWrap.style.display, "block");
  assert.equal(moreButton.style.display, "none");
  assert.equal(scrollOptions?.block, "center");
});
