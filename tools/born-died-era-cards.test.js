import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { __datePageEngagementTestHooks as hooks } from "../js/seo-worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seoSource = readFileSync(resolve(__dirname, "../js/seo-worker.js"), "utf8");
const years = [
  1200, 1400, 1501, 1600, 1700, 1799, 1801, 1840, 1880, 1899,
  1901, 1920, 1940, 1960, 1980, 1999, 2001, 2010, 2020, 2025,
];
const richExtract =
  "A widely documented public figure whose career influenced institutions, scholarship, and public life across several decades, with substantial biographical context preserved by reliable historical sources.";

function makePerson(year, index) {
  const name = `Major Person ${index + 1}`;
  const canonical = name.replace(/ /g, "_");
  return {
    year,
    text: `${name}, public figure`,
    monthlyPageviews: index === 0 ? 500_000 : 2_000 + index,
    pages: [{
      type: "standard",
      title: name,
      titles: { canonical },
      description: "public figure",
      extract: richExtract,
      thumbnail: { source: `https://upload.wikimedia.org/${canonical}.jpg` },
      originalimage: { source: `https://upload.wikimedia.org/${canonical}_full.jpg` },
      content_urls: {
        desktop: { page: `https://en.wikipedia.org/wiki/${canonical}` },
      },
    }],
  };
}

const people = years.map(makePerson);

describe("Born and died major-person era cards", () => {
  it("renders every ranked birth immediately with the shared action wrapper", () => {
    const html = hooks.generateBornHTML(
      "https://thisday.info",
      "july",
      28,
      { events: [], births: people, deaths: [] },
    );

    assert.match(
      html,
      /class="card-box"[\s\S]*id="major-births-heading"[\s\S]*class="era-chip-row"/,
    );
    assert.match(html, /More major people born on July 28/);
    assert.match(html, /aria-label="Filter people born on this day by era"/);
    assert.match(html, /class="era-chip era-chip-active" aria-pressed="true"/);
    assert.match(html, /data-era-item="births"/);
    assert.doesNotMatch(html, /id="births-more"|Show \d+ more/);
    assert.match(html, /Major Person 20/);
    assert.equal((html.match(/class="tl-card-actions"/g) || []).length, 19);
    assert.match(html, /class="dyn-slider-shell"/);
    assert.equal((html.match(/data-date-timeline-ad/g) || []).length, 1);
    assert.ok(html.indexOf('class="dyn-slider-shell"') < html.indexOf("data-date-timeline-ad"));
    assert.ok(html.indexOf("data-date-timeline-ad") < html.indexOf('id="major-births-heading"'));
    assert.match(html, /class="date-bottom-navigation/);
    assert.doesNotMatch(html, /bootstrap\.bundle\.min\.js|"@type":"Quiz"|ai-card-patch-v2/);
    assert.doesNotMatch(html, /person-filmography|Open the Calendar|All Blog Posts/);
  });

  it("renders every ranked death immediately with the same clean layout", () => {
    const html = hooks.generateDiedHTML(
      "https://thisday.info",
      "july",
      28,
      { events: [], births: [], deaths: people },
    );

    assert.match(html, /id="major-deaths-heading"/);
    assert.match(html, /More major people who died on July 28/);
    assert.match(html, /aria-label="Filter people who died on this day by era"/);
    assert.match(html, /class="era-chip era-chip-active" aria-pressed="true"/);
    assert.match(html, /data-era-item="deaths"/);
    assert.doesNotMatch(html, /id="deaths-more"|Show \d+ more/);
    assert.match(html, /Major Person 20/);
    assert.equal((html.match(/class="tl-card-actions"/g) || []).length, 19);
    assert.match(html, /class="dyn-slider-shell"/);
    assert.equal((html.match(/data-date-timeline-ad/g) || []).length, 1);
    assert.ok(html.indexOf("data-date-timeline-ad") < html.indexOf('id="major-deaths-heading"'));
    assert.match(html, /class="date-bottom-navigation/);
  });

  it("keeps the shared Did You Know section when the featured person has fewer than three facts", () => {
    const featured = makePerson(1993, 0);
    featured.text = "Harry Kane, English footballer";
    featured.pages[0].extract =
      "Harry Edward Kane is an English professional footballer who plays as a striker for Bayern Munich and captains the England national team. He is also the Premier League's second-highest all-time goalscorer with 213 goals.";
    const supporting = makePerson(1977, 1);
    supporting.pages[0].extract =
      "Manu Ginobili is an Argentine former professional basketball player whose career included four National Basketball Association championships with the San Antonio Spurs.";

    const facts = hooks.personDidYouKnowFacts(featured, [featured, supporting]);
    const bornHtml = hooks.generateBornHTML(
      "https://thisday.info",
      "july",
      28,
      { events: [], births: [supporting, featured], deaths: [] },
    );
    const diedHtml = hooks.generateDiedHTML(
      "https://thisday.info",
      "july",
      28,
      { events: [], births: [], deaths: [supporting, featured] },
    );

    assert.equal(facts.length, 3);
    assert.match(facts[0], /^Harry Kane is also/);
    assert.match(facts[1], /^Manu Ginobili/);
    assert.match(facts[2], /^Harry Edward Kane/);
    assert.equal((bornHtml.match(/class="dyn-slider-shell"/g) || []).length, 1);
    assert.equal((diedHtml.match(/class="dyn-slider-shell"/g) || []).length, 1);
    assert.doesNotMatch(seoSource, /didYouKnowFacts\.length\s*>=\s*3/);
  });

  it("adds the shared Did You Know section to cached Born HTML without a KV rewrite", () => {
    const oldHtml = `<!doctype html><html><body><main>
      <h2 class="article-hero-title">1993 — Harry Kane</h2>
      <div class="card-box"><hr style="border:none"/>
      <section aria-labelledby="major-births-heading">
      <h2 class="h5 mb-1" id="major-births-heading">More major people born on July 28</h2>
      </section></div></main></body></html>`;
    const repaired = hooks.ensureCachedPersonDateDidYouKnowHtml(oldHtml, {
      type: "births",
      people: people.slice(0, 3),
    });

    assert.match(repaired, /class="dyn-slider-shell"/);
    assert.ok(
      repaired.indexOf('class="dyn-slider-shell"') <
        repaired.indexOf('id="major-births-heading"'),
    );
    assert.equal(
      hooks.ensureCachedPersonDateDidYouKnowHtml(repaired, {
        type: "births",
        people: people.slice(0, 3),
      }),
      repaired,
    );
  });

  it("upgrades old cached HTML read-only and keeps the existing KV versions", () => {
    const oldHtml = `<!doctype html><html><body><main><div class="card-box"><div class="tl-wrap">${years
      .slice(0, 13)
      .map(
        (year) =>
          `<div class="tl-item"><span class="tl-node-badge event-years-ago">${year}</span></div>`,
      )
      .join("")}</div></div></main></body></html>`;
    const html = hooks.normalizeCachedPersonDateMajorCardHtml(oldHtml, {
      type: "births",
      mDisplay: "July",
      day: 28,
    });

    assert.match(html, /data-major-persons-timeline="births"/);
    assert.match(html, /data-cached-major-persons="births"/);
    assert.match(html, /class="era-chip era-chip-active" aria-pressed="true"/);
    assert.match(seoSource, /born-v37-/);
    assert.match(seoSource, /died-v36-/);
    assert.match(seoSource, /DATE_PERSON_MEDIA_EDGE_CACHE_VERSION = 6/);
    assert.doesNotMatch(seoSource, /born-v38-/);
    assert.doesNotMatch(seoSource, /died-v37-/);
  });

  it("expands and cleans a cached date page without changing its KV key", () => {
    const oldHtml = `<!doctype html><html><head>
      <style id="date-person-filmography-style">.person-filmography{display:block}</style>
      <style>.date-story-float{display:grid}@media(max-width:700px){.date-story-float{display:block}}.tl-item{display:flex}</style>
      <style>/*ai-card-patch-v2*/.ai-answer-card{display:none}</style>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Quiz"}</script>
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
      </head><body><main>
      <div class="card-box"><section><h2 id="major-births-heading">People</h2>
      <div class="tl-wrap"><div class="tl-card-body"><img class="tl-card-img" loading="lazy" src="one.jpg"><a class="site-btn site-btn-primary tl-btn">One</a></div></div>
      <div id="births-more" style="display:none"><div class="tl-wrap"><div class="tl-card-body"><img class="tl-card-img" loading="lazy" src="two.jpg"><a class="site-btn site-btn-primary tl-btn">Two</a></div></div></div>
      <button id="births-more-btn">Show all</button></section></div>
      <section class="amazon-related person-filmography">IMDb</section>
      <div class="ad-unit">Advertisement</div>
      <div class="card-box"><div class="major-events-summary">Major events</div></div>
      <div class="my-5 pt-3 border-top"><a href="/">Open the Calendar</a></div>
      </main><aside id="date-story-float">Featured article</aside>
      <script data-cached-major-persons="births">button.innerHTML='Show all 19 people';</script>
      </body></html>`;
    const cleaned = hooks.normalizeDatePageCleanLayoutHtml(oldHtml, {
      type: "born",
      monthName: "july",
      day: 28,
    });
    const cleanedTwice = hooks.normalizeDatePageCleanLayoutHtml(cleaned, {
      type: "born",
      monthName: "july",
      day: 28,
    });

    assert.equal(cleanedTwice, cleaned);
    assert.match(cleaned, />One</);
    assert.match(cleaned, />Two</);
    assert.equal((cleaned.match(/class="tl-wrap"/g) || []).length, 1);
    assert.equal((cleaned.match(/class="tl-card-actions"/g) || []).length, 2);
    assert.equal((cleaned.match(/decoding="async"/g) || []).length, 2);
    assert.match(cleaned, /content-visibility:auto;contain-intrinsic-size:auto 420px/);
    assert.equal((cleaned.match(/data-date-timeline-ad/g) || []).length, 1);
    assert.doesNotMatch(cleaned, /<div class="ad-unit">Advertisement<\/div>/);
    assert.doesNotMatch(cleaned, /bootstrap\.bundle\.min\.js|"@type":"Quiz"|ai-card-patch-v2/);
    assert.match(cleaned, /class="date-bottom-navigation/);
    assert.match(cleaned, /data-cached-major-persons="births"/);
    assert.doesNotMatch(cleaned, /births-more|Show all|IMDb|Major events|Featured article|Open the Calendar|date-story-float/);
  });
});
