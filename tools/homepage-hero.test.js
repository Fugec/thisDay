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

function loadEventAnchor(source) {
  const match = source.match(
    /(function historicalEventAnchorId[\s\S]*?\n})\n\nfunction historicalPersonAnchorId/,
  );
  assert.ok(match, "event anchor helper must be extractable");
  const context = {};
  vm.runInNewContext(
    `${match[1]}\nthis.anchor = historicalEventAnchorId;`,
    context,
  );
  return context.anchor;
}

function loadTimelineFocusHelpers(source) {
  const anchorMatch = source.match(
    /(function historicalEventAnchorId[\s\S]*?\n})\n\nfunction historicalPersonAnchorId/,
  );
  const helperMatch = source.match(
    /(function historicalEventFocusKey[\s\S]*?\n}\n\nfunction resolveModalTimelineAnchor[\s\S]*?\n})\n\n\/\/ Converts/,
  );
  assert.ok(anchorMatch, "event anchor helper must be extractable");
  assert.ok(helperMatch, "modal focus helpers must be extractable");
  const context = {};
  vm.runInNewContext(
    `${anchorMatch[1]}\n${helperMatch[1]}\nthis.anchor = historicalEventAnchorId;\nthis.focusKey = historicalEventFocusKey;\nthis.resolve = resolveModalTimelineAnchor;`,
    context,
  );
  return context;
}

function loadModalTimelineFocus(source, context) {
  const match = source.match(
    /(function focusModalTimelineItem[\s\S]*?\n})\n\nfunction applyFilter/,
  );
  assert.ok(match, "modal timeline focus helper must be extractable");
  vm.runInNewContext(
    `let modalSelectionRequestId=0;\n${match[1]}\nthis.setRequestId=(value)=>{modalSelectionRequestId=value;};\nthis.focus=focusModalTimelineItem;`,
    context,
  );
  return context;
}

test("hero uses Today Through Time in the former highlights position", () => {
  assert.match(indexHtml, /<div class="hero-inner">/);
  assert.match(indexHtml, /Events, birthdays and milestones for any date — sourced from\s+Wikipedia\./);
  assert.match(indexHtml, /class="hero-highlights today-through-time"/);
  assert.match(indexHtml, /id="todayThroughTimeTitle">Today Through Time<\/h2>/);
  assert.match(
    indexHtml,
    /id="todayThroughTimeViewport"[\s\S]*?id="todaysEventsGrid"/,
  );
  assert.doesNotMatch(indexHtml, /id="heroHighlightsList"/);
  assert.equal((indexHtml.match(/id="todaysEventsSection"/g) || []).length, 1);
  assert.doesNotMatch(indexHtml, /Loading today's history/);
  assert.doesNotMatch(indexHtml, /hero-highlight is-placeholder/);
  assert.match(indexHtml, /id="heroEventsLabel">Today's Events<\/span>/);
  assert.match(
    indexHtml,
    /eventsLabel\.textContent = "Today's Events"/,
  );
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

test("desktop and mobile layouts place the timeline in the hero's right column", () => {
  assert.match(css, /\.hero \{[\s\S]*?padding: 0;/);
  assert.doesNotMatch(css, /\.hero \{[^}]*box-shadow:/);
  assert.match(
    css,
    /\.hero-inner \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?margin: 0;/,
  );
  assert.doesNotMatch(css, /\.hero-inner \{[^}]*border-top:/);
  assert.match(
    css,
    /\.hero-inner \{[^}]*grid-template-columns: minmax\(0, 0\.7fr\) minmax\(360px, 0\.7fr\);/,
  );
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
  assert.doesNotMatch(css, /\.hero-highlights h2 \{\s*display: none;/);
  assert.match(
    css,
    /\.today-through-time-item\s*\{[^}]*flex:\s*0 0 calc\(66\.6667% - 0\.5rem\);/s,
  );
});

test("hero timeline reuses preloaded daily data and receives Worker SSR", () => {
  assert.match(script, /const month = today\.getMonth\(\) \+ 1;/);
  assert.match(script, /const day = today\.getDate\(\);/);
  assert.match(script, /fetchWikipediaEvents\(month, day\)/);
  assert.match(script, /selectTodayThroughTimeEvents\(events, 8\)/);
  assert.match(script, /card\.setAttribute\("data-bs-toggle", "modal"\)/);
  assert.match(script, /card\.setAttribute\("data-bs-target", "#eventDetailModal"\)/);
  assert.match(script, /clickEvent\.stopPropagation\(\);/);
  assert.match(
    seoWorker,
    /selectHomepagePreloadEvents\(\s*eventsData\?\.events,\s*HOMEPAGE_PRELOAD_EVENT_LIMIT,\s*\)/,
  );
  assert.match(seoWorker, /\.on\("#todaysEventsGrid"/);
  assert.match(
    seoWorker,
    /data-today-through-time-ssr", "true"/,
  );
  assert.match(
    script,
    /showEventDetails\(\s*day,\s*month,\s*today\.getFullYear\(\),\s*data,\s*anchorId,\s*focusedEventKey/,
  );
  assert.match(
    seoWorker,
    /class="hero-highlight tl-card\$\{timelineImageUrl \? "" : " tl-card-noimg"\} today-through-time-card"/,
  );
  assert.match(
    script,
    /body\.className = "tl-card-body";[\s\S]*?action\.className = "major-event-source";[\s\S]*?Open details/,
  );
  assert.match(
    seoWorker,
    /<span class="tl-card-body">[\s\S]*?<span class="tl-card-actions"><span class="major-event-source">Open details/,
  );
  assert.match(
    script,
    /media\.className = "tl-card-img";[\s\S]*?body\.append\(heading, actions\);[\s\S]*?card\.append\(year, media, body\)/,
  );
  assert.match(
    seoWorker,
    /timelineMediaHtml[\s\S]*?class="tl-card-img" width="640" height="640" loading="lazy" decoding="async"/,
  );
  assert.match(
    css,
    /\.hero-highlight \{[\s\S]*?color: inherit;[\s\S]*?text-decoration: none;/,
  );
  assert.match(
    css,
    /\.hero-highlight \.major-event-source \{[\s\S]*?color: var\(--btn-bg\);[\s\S]*?font-size: 13px;[\s\S]*?font-weight: 600;/,
  );
  assert.match(
    css,
    /\.hero-highlight:hover \.major-event-source,[\s\S]*?text-decoration: none;/,
  );
  assert.match(
    seoWorker,
    /\.major-event-source:hover,\.major-event-source:focus-visible\{text-decoration:none\}/,
  );
});

test("Today Through Time resolves compact records and owns the modal scroll", () => {
  const { anchor, focusKey, resolve } = loadTimelineFocusHelpers(script);
  const sourceUrl = "https://en.wikipedia.org/wiki/Continuation_War";
  const compact = {
    type: "event",
    year: 1944,
    description: "World War II: Continuation War: The Vyborg operation begins…",
    sourceUrl,
  };
  const complete = {
    ...compact,
    description:
      "World War II: Continuation War: The Vyborg operation begins with a longer complete historical description.",
  };
  assert.notEqual(anchor(compact), anchor(complete));
  assert.equal(
    resolve([complete], anchor(compact), focusKey(compact)),
    anchor(complete),
  );
  assert.match(
    script,
    /applyFilter\(\{ scrollToFirst: !resolvedFocusedItemAnchorId \}\)/,
  );
  assert.match(script, /if \(!scrollToFirst\) return;[\s\S]*?setTimeout/);
  assert.match(script, /modalBodyContent\.scrollTo\(\{[\s\S]*?top,/);
});

test("Today Through Time refocuses every modal selection independently", () => {
  const targeted = new Set();
  const scrollTops = [];
  const makeTarget = (anchor, top) => ({
    dataset: { itemAnchor: anchor },
    classList: {
      add(name) {
        if (name === "modal-tl-item-targeted") targeted.add(anchor);
      },
      remove(name) {
        if (name === "modal-tl-item-targeted") targeted.delete(anchor);
      },
    },
    getBoundingClientRect() {
      return { top, height: 100 };
    },
  });
  const first = makeTarget("event-first", 120);
  const second = makeTarget("event-second", 620);
  const modalBodyContent = {
    clientHeight: 400,
    scrollTop: 0,
    querySelectorAll(selector) {
      if (selector === "[data-item-anchor]") return [first, second];
      if (selector === ".modal-tl-item-targeted") {
        return [first, second].filter((item) =>
          targeted.has(item.dataset.itemAnchor),
        );
      }
      return [];
    },
    getBoundingClientRect() {
      return { top: 20 };
    },
    scrollTo({ top }) {
      this.scrollTop = top;
      scrollTops.push(top);
    },
  };
  const modalElement = {
    classList: { contains: (name) => name === "show" },
    addEventListener() {},
  };
  const context = loadModalTimelineFocus(script, {
    modalBodyContent,
    document: {
      getElementById: () => modalElement,
    },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    window: {
      matchMedia: () => ({ matches: false }),
    },
  });

  context.setRequestId(1);
  context.focus("event-first", 1);
  context.setRequestId(2);
  context.focus("event-second", 2);

  assert.ok(scrollTops.length >= 4);
  assert.deepEqual([...targeted], ["event-second"]);
  assert.ok(scrollTops.at(-1) > scrollTops[0]);
  assert.match(
    script,
    /const selectionRequestId = \+\+modalSelectionRequestId;/,
  );
  assert.match(
    script,
    /if \(selectionRequestId !== modalSelectionRequestId\) return;/,
  );
  assert.match(
    script,
    /addEventListener\("hide\.bs\.modal"[\s\S]*?modalSelectionRequestId \+= 1/,
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
