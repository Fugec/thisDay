import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  __homepagePerformanceTestHooks as hooks,
  __historyEvergreenTestHooks as historyHooks,
} from "../js/seo-worker.js";

const root = new URL("..", import.meta.url).pathname;
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const customCss = readFileSync(join(root, "css/custom.css"), "utf8");
const clientSource = readFileSync(join(root, "js/script.js"), "utf8");
const workerSource = readFileSync(join(root, "js/seo-worker.js"), "utf8");

test("homepage fallback metadata is stable, complete, and indexable", () => {
  assert.match(
    indexHtml,
    /<title>On This Day in History: Events, Births &amp; Deaths<\/title>/,
  );
  assert.match(
    indexHtml,
    /content="Explore historical events, famous birthdays and notable deaths for every day of the year, with sourced timelines, quizzes and daily articles\."/,
  );
  assert.equal(hooks.HOMEPAGE_TITLE.length, 47);
  assert.ok(hooks.HOMEPAGE_DESCRIPTION.length >= 120);
  assert.ok(hooks.HOMEPAGE_DESCRIPTION.length <= 155);
  assert.match(indexHtml, /name="robots" content="index, follow"/);
});

test("crawler-visible headings never use loading or empty placeholders", () => {
  const headings = [...indexHtml.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  assert.equal(headings.some((heading) => /^loading(?:\.\.\.)?$/i.test(heading)), false);
  assert.equal(headings.some((heading) => heading === ""), false);
  assert.match(indexHtml, /id="currentMonthYear"[\s\S]*?>\s*Current month\s*<\/h2>/);
  assert.match(indexHtml, /id="modalDate"[\s\S]*?>\s*Historical events for selected date\s*<\/h2>/);
});

test("server discovery links cover the daily cluster, adjacent dates, and topic hubs", () => {
  const html = hooks.buildHomepageDiscoveryLinks(
    new Date("2026-07-29T12:00:00Z"),
  );
  for (const href of [
    "/events/july/29/",
    "/born/july/29/",
    "/died/july/29/",
    "/quiz/july/29/",
    "/events/july/28/",
    "/events/july/30/",
    "/people/",
    "/topics/",
    "/topics/space-exploration/",
    "/topics/civil-rights/",
  ]) {
    assert.match(html, new RegExp(`href="${href.replaceAll("/", "\\/")}"`));
  }
  assert.equal((html.match(/class="date-view-tab"/g) || []).length, 12);
  assert.match(html, /class="bi bi-calendar-event" aria-hidden="true"/);
});

test("homepage discovery reuses date-view tabs with every link visible", () => {
  assert.match(indexHtml, /class="date-view-tabs homepage-discovery-links"/);
  assert.match(
    customCss,
    /\.homepage-discovery\s*\{[^}]*padding:\s*1\.5rem var\(--gutter-x\) 0;/s,
  );
  assert.match(
    customCss,
    /\.date-view-tabs\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s,
  );
  assert.match(
    customCss,
    /\.date-view-tab\s*\{[^}]*display:\s*inline-flex;[^}]*border-radius:\s*999px;/s,
  );
  assert.match(
    customCss,
    /\.homepage-discovery-links\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;[^}]*scroll-snap-type:\s*none;/s,
  );
  assert.match(
    customCss,
    /\.homepage-discovery-links \.date-view-tab\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s,
  );
  assert.doesNotMatch(
    customCss,
    /\.homepage-discovery-links \.date-view-tab\s*\{[^}]*calc\(\(100% - 0\.5rem\) \/ 1\.5\)/s,
  );
  assert.doesNotMatch(workerSource, /\.date-view-tabs\{display:flex/);
});

test("homepage blog cards are real internal links before JavaScript runs", () => {
  const html = hooks.buildHomepageBlogCards([
    {
      slug: "29-july-2026",
      title: "A sourced history story",
      description: "A concise article description.",
      date: "2026-07-29",
      imageUrl: "https://upload.wikimedia.org/example.jpg",
    },
  ]);
  assert.match(html, /href="\/blog\/29-july-2026\/"/);
  assert.match(html, /<h3[^>]*>A sourced history story<\/h3>/);
  assert.match(html, /loading="lazy"/);
  assert.match(workerSource, /\.on\("#blogGrid"/);
  assert.match(indexHtml, /dataset\.ssrReady === "true"/);
});

test("homepage article and event grids use four columns and eight cards", () => {
  const posts = Array.from({ length: 10 }, (_, index) => ({
    slug: `${30 - index}-july-2026`,
    title: `Sourced history story ${index + 1}`,
    description: `Concise article description ${index + 1}.`,
    date: `2026-07-${String(30 - index).padStart(2, "0")}`,
    imageUrl: "https://upload.wikimedia.org/example.jpg",
  }));
  const html = hooks.buildHomepageBlogCards(posts);

  assert.equal((html.match(/class="blog-card"/g) || []).length, 8);
  assert.match(
    customCss,
    /\.blog-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s,
  );
  assert.match(
    customCss,
    /#todaysEventsSection \.blog-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s,
  );
  assert.match(indexHtml, /posts\.slice\(0, 8\)/);
  assert.match(indexHtml, /withImages\.slice\(0, 8\)/);
});

test("Featured Today includes four desktop cards and becomes one mobile slider", () => {
  const section = indexHtml.match(
    /<section class="event-section">([\s\S]*?)<\/section>/,
  )?.[1] || "";

  assert.equal((section.match(/class="quiz-card"/g) || []).length, 4);
  assert.match(section, /id="todayEventCard"/);
  assert.match(section, /id="latest-article-title"/);
  assert.match(section, /id="bornTodayCard"/);
  assert.match(section, /href="\/born\/today\/"/);
  assert.match(section, /id="diedTodayCard"/);
  assert.match(section, /href="\/died\/today\/"/);
  assert.match(
    customCss,
    /\.event-wrap\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s,
  );
  assert.match(
    customCss,
    /@media \(max-width: 900px\)[\s\S]*?\.event-section\s*\{[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/,
  );
  assert.match(
    customCss,
    /\.event-wrap \.quiz-card\s*\{[^}]*flex:\s*0 0 70vw;[^}]*scroll-snap-align:\s*start;/s,
  );
  assert.match(clientSource, /selectHomepagePeople\(eventsData\.births \|\| \[\], 1\)/);
  assert.match(clientSource, /selectHomepagePeople\(eventsData\.deaths \|\| \[\], 1\)/);
  assert.match(workerSource, /\.on\("#bornTodayTitle"/);
  assert.match(workerSource, /\.on\("#diedTodayTitle"/);
});

test("homepage editorial SSR loads the blog and video indexes once each", async () => {
  const reads = [];
  const content = await hooks.loadHomepageEditorialContent({
    BLOG_AI_KV: {
      async get(key) {
        reads.push(key);
        if (key === "index") {
          return JSON.stringify([
            {
              slug: "28-july-2026",
              title: "Older story",
              date: "2026-07-28",
            },
            {
              slug: "29-july-2026",
              title: "Newest story",
              date: "2026-07-29",
            },
          ]);
        }
        if (key === "youtube:uploaded") {
          return JSON.stringify({
            "29-july-2026": {
              youtubeId: "abcdefghijk",
              uploadedAt: "2026-07-29T09:00:00Z",
              privacy: "public",
            },
          });
        }
        return null;
      },
    },
  });
  assert.deepEqual(reads.sort(), ["index", "youtube:uploaded"]);
  assert.equal(content.latestPost.slug, "29-july-2026");
  assert.match(content.blogCards, /Newest story/);
  assert.match(content.videoCards, /youtube\.com\/shorts\/abcdefghijk/);
  assert.match(
    content.videoCards,
    /<h3 class="homepage-section-title homepage-section-title-box">/,
  );
});

test("partial homepage data is upgraded before the complete day modal renders", () => {
  assert.match(clientSource, /async function fetchWikipediaEvents\(month, day, options = \{\}\)/);
  assert.match(clientSource, /const requireFull = options\.requireFull === true/);
  assert.match(clientSource, /structuredEvents\.partial === true/);
  assert.match(clientSource, /requireFull: true/);
  assert.match(clientSource, /if \(raw\.partial !== true\) saveCacheToLocalStorage\(eventCache\)/);
});

test("versioned first-party CSS and JavaScript receive immutable caching", () => {
  assert.match(indexHtml, /custom\.css\?v=46/);
  assert.match(indexHtml, /script\.js\?v=23/);
  assert.match(
    workerSource,
    /public, max-age=31536000, s-maxage=31536000, immutable/,
  );
});

test("versioned asset responses use the immutable production header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("body{}", {
      status: 200,
      headers: { "Content-Type": "text/css; charset=utf-8" },
    });
  try {
    const response = await historyHooks.handleFetchRequest(
      new Request("https://thisday.info/css/custom.css?v=46"),
      {},
      { waitUntil() {} },
    );
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
