import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "css/custom.css"), "utf8");
const script = readFileSync(join(root, "js/script.js"), "utf8");
const seoWorker = readFileSync(join(root, "js/seo-worker.js"), "utf8");

function loadClientPicker() {
  const match = script.match(
    /(function pickRandomDailyHighlights[\s\S]*?\n})\n\nasync function populateHeroHighlights/,
  );
  assert.ok(match, "client highlight picker must be extractable");
  const context = {};
  vm.runInNewContext(
    `${match[1]}\nthis.pick = pickRandomDailyHighlights;`,
    context,
  );
  return context.pick;
}

function loadEventAnchor(source) {
  const match = source.match(
    /(function historicalEventAnchorId[\s\S]*?\n})\n\nfunction pickRandom/,
  );
  assert.ok(match, "event anchor helper must be extractable");
  const context = {};
  vm.runInNewContext(
    `${match[1]}\nthis.anchor = historicalEventAnchorId;`,
    context,
  );
  return context.anchor;
}

test("hero uses the supplied desktop/mobile content structure", () => {
  assert.match(indexHtml, /<div class="hero-inner">/);
  assert.match(indexHtml, /Events, birthdays and milestones for any date — sourced from\s+Wikipedia\./);
  assert.match(indexHtml, /id="heroHighlightsTitle">Today's Highlights<\/h2>/);
  assert.match(
    indexHtml,
    /id="heroHighlightsList"[\s\S]*?aria-live="polite"\s*><\/div>/,
  );
  assert.doesNotMatch(indexHtml, /Loading today's history/);
  assert.doesNotMatch(indexHtml, /hero-highlight is-placeholder/);
  assert.match(indexHtml, /id="heroEventsLabel">[^<]+<\/span>/);
  assert.match(indexHtml, /Today's Quiz/);
  assert.match(indexHtml, /<a href="\/blog\/" class="btn" id="heroQuizBtn">/);
  assert.doesNotMatch(indexHtml, /hero-secondary/);
  assert.doesNotMatch(css, /\.hero-secondary/);
  assert.doesNotMatch(indexHtml, /class="hero-scroll-cue"/);
  assert.match(
    indexHtml,
    /todayBtn\.addEventListener\("click"[\s\S]*?preventDefault/,
  );
  assert.match(
    indexHtml,
    /heroQuizBtn\.href = "\/blog\/" \+ latest\.slug \+ "\/#quiz"/,
  );
});

test("hero uses Lora without loading or applying Meddon", () => {
  assert.match(
    css,
    /\.hero h1 \{[\s\S]*?font-family: "Lora", Georgia, serif;/,
  );
  assert.doesNotMatch(css, /font-family:\s*"Meddon"/);
  assert.doesNotMatch(indexHtml, /family=Meddon/);
});

test("desktop and mobile layouts place highlights in the requested order", () => {
  assert.match(css, /\.hero \{[\s\S]*?padding: 0;/);
  assert.doesNotMatch(css, /\.hero \{[^}]*box-shadow:/);
  assert.match(
    css,
    /\.hero-inner \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?margin: 0;/,
  );
  assert.doesNotMatch(css, /\.hero-inner \{[^}]*border-top:/);
  assert.match(
    css,
    /grid-template-areas:\s*"eyebrow highlights"\s*"title highlights"\s*"description highlights"\s*"actions highlights";/,
  );
  assert.doesNotMatch(indexHtml, /class="hero-meta"/);
  assert.doesNotMatch(css, /\.hero-meta/);
  assert.match(
    css,
    /@media \(max-width: 768px\)[\s\S]*?grid-template-areas:\s*"eyebrow"\s*"title"\s*"description"\s*"highlights"\s*"actions"/,
  );
  assert.match(css, /\.hero-actions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(css, /\.hero-highlights h2 \{\s*display: none;/);
});

test("client picker returns three distinct events without mutating input", () => {
  const pick = loadClientPicker();
  const events = [
    { year: 1918, title: "Event A" },
    { year: 1955, title: "Event B" },
    { year: 1975, title: "Event C" },
    { year: 2001, title: "Event D" },
    { year: 1955, title: "Event B" },
  ];
  const original = JSON.stringify(events);
  const randomValues = [0.9, 0.2, 0.7, 0.4];
  const selected = pick(events, 3, () => randomValues.shift() ?? 0);

  assert.equal(selected.length, 3);
  assert.equal(
    new Set(selected.map((event) => `${event.year}|${event.title}`)).size,
    3,
  );
  assert.equal(JSON.stringify(events), original);
});

test("highlights reuse preloaded daily data and receive Worker SSR", () => {
  assert.match(
    script,
    /fetchWikipediaEvents\(\s*today\.getMonth\(\) \+ 1,\s*today\.getDate\(\),\s*\)/,
  );
  assert.match(script, /pickRandomDailyHighlights\(eventsData\?\.events, 3\)/);
  assert.match(
    script,
    /list\.dataset\.heroHighlightsReady === "true"/,
  );
  assert.match(
    seoWorker,
    /pickRandomHomepageHighlights\(\s*eventsData\?\.events,\s*3,\s*\)/,
  );
  assert.match(seoWorker, /\.on\("#heroHighlightsList"/);
  assert.match(
    seoWorker,
    /data-hero-highlights-ready", "true"/,
  );
  assert.match(
    script,
    /document\.createElement\("a"\)[\s\S]*?row\.href = `\$\{todayEventsPath\}#\$\{historicalEventAnchorId\(event\)\}`/,
  );
  assert.match(
    seoWorker,
    /<a href="\$\{homepageEventsPath\}#\$\{historicalEventAnchorId\(event\)\}" class="hero-highlight" role="listitem">/,
  );
  assert.match(
    script,
    /readMore\.className = "major-event-source";[\s\S]*?readMore\.textContent = "Read more";[\s\S]*?copy\.append\(text, readMore\)/,
  );
  assert.match(
    seoWorker,
    /<span class="hero-highlight-copy">[\s\S]*?<span class="major-event-source">Read more<\/span>/,
  );
  assert.match(
    css,
    /\.hero-highlight \{[\s\S]*?color: inherit;[\s\S]*?text-decoration: none;/,
  );
  assert.match(
    css,
    /\.hero-highlight \.major-event-source \{[\s\S]*?color: var\(--btn-bg\);[\s\S]*?font-size: 13px;[\s\S]*?font-weight: 600;/,
  );
});

test("homepage and date pages derive the same stable event fragment", () => {
  const clientAnchor = loadEventAnchor(script);
  const workerAnchor = loadEventAnchor(seoWorker);
  const text =
    "A specific 2019 historical event is recorded with punctuation & accents.";
  const fromHomepage = clientAnchor({
    year: 2019,
    title: "A specific 2019 historical event",
    description: text,
  });
  const fromDatePage = workerAnchor({ year: 2019, text });

  assert.equal(fromHomepage, fromDatePage);
  assert.match(fromHomepage, /^event-2019-/);
  assert.notEqual(
    fromHomepage,
    clientAnchor({ year: 2019, description: `${text} Different event.` }),
  );
  assert.match(
    seoWorker,
    /id="\$\{escapeHtml\(featuredAnchorId\)\}" class="article-hero-wrap"/,
  );
  assert.match(
    seoWorker,
    /id="\$\{escapeHtml\(eventAnchorId\)\}" class="tl-item/,
  );
});
