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
});

test("mobile discovery links form a 1.5-card snap slider", () => {
  assert.match(
    customCss,
    /\.homepage-discovery-links\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s,
  );
  assert.match(
    customCss,
    /\.homepage-discovery-links a\s*\{[^}]*flex:\s*0 0 calc\(\(100% - 0\.65rem\) \/ 1\.5\);[^}]*scroll-snap-align:\s*start;/s,
  );
  assert.match(
    customCss,
    /@media \(min-width: 768px\)[\s\S]*?\.homepage-discovery-links\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/,
  );
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
});

test("partial homepage data is upgraded before the complete day modal renders", () => {
  assert.match(clientSource, /async function fetchWikipediaEvents\(month, day, options = \{\}\)/);
  assert.match(clientSource, /const requireFull = options\.requireFull === true/);
  assert.match(clientSource, /structuredEvents\.partial === true/);
  assert.match(clientSource, /requireFull: true/);
  assert.match(clientSource, /if \(raw\.partial !== true\) saveCacheToLocalStorage\(eventCache\)/);
});

test("versioned first-party CSS and JavaScript receive immutable caching", () => {
  assert.match(indexHtml, /custom\.css\?v=40/);
  assert.match(indexHtml, /script\.js\?v=22/);
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
      new Request("https://thisday.info/css/custom.css?v=40"),
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
