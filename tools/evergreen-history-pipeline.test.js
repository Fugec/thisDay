import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as hooks,
} from "../js/blog-ai-worker.js";

function words(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}

function sourceRichContent() {
  return {
    title: "Apollo 11 Lands on the Moon — July 20, 1969",
    curiosityTitle: "Why Did Apollo 11 Risk a Manual Lunar Landing?",
    eventTitle: "Apollo 11 Lands on the Moon",
    historicalDate: "July 20, 1969",
    historicalDateISO: "1969-07-20",
    historicalYear: 1969,
    location: "Mare Tranquillitatis, Moon",
    description:
      "Apollo 11's final descent combined computer guidance with a manual landing decision as its available fuel narrowed.",
    contentRationale:
      "The landing is useful as a decision story because the crew had to interpret alarms, monitor fuel, and choose a safer landing point.",
    overviewParagraphs: [
      `${words("overview", 190)}.`,
      `${words("descent", 190)}.`,
    ],
    eyewitnessOrChronicle: [
      `${words("sequence", 190)}.`,
    ],
    aftermathParagraphs: [
      `${words("aftermath", 190)}.`,
    ],
    conclusionParagraphs: [
      `${words("legacy", 190)}.`,
    ],
    sourcePages: [
      {
        pageTitle: "Apollo 11",
        pageUrl: "https://en.wikipedia.org/wiki/Apollo_11",
        publisher: "Wikipedia",
        supportedClaims: [
          "Apollo 11 landed on the Moon in July 1969.",
        ],
        extract:
          `${words("wiki", 260)} July 16, 1969. July 17, 1969. ` +
          "July 18, 1969. July 19, 1969. July 20, 1969.",
      },
      {
        pageTitle: "Apollo 11 Mission Overview",
        pageUrl:
          "https://www.nasa.gov/history/apollo-11-mission-overview/",
        publisher: "NASA",
        verifiedIndependent: true,
        verificationMethod: "test-fixture",
        supportedClaims: [
          "The crew completed the first crewed lunar landing in 1969.",
        ],
        extract: `${words("nasa", 260)} 1969.`,
      },
    ],
  };
}

function historySeed() {
  return {
    type: "event",
    slug: "apollo-11-lands-on-the-moon",
    name: "Apollo 11 Lands on the Moon",
    wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
    resolvedPageTitle: "Apollo 11",
    summary:
      "Apollo 11 was the first crewed mission to land on the Moon in July 1969.",
    intro:
      "Apollo 11 carried Neil Armstrong, Buzz Aldrin, and Michael Collins during the first crewed lunar landing.",
  };
}

function parsedEdition() {
  const bodySections = [
    "The constraints before descent",
    "The decisions inside the lunar module",
    "The final landing sequence",
    "What the landing changed",
  ].map((heading, sectionIndex) => ({
    heading,
    paragraphs: [
      `${words(`edition${sectionIndex}a`, 92)}.`,
      `${words(`edition${sectionIndex}b`, 94)}.`,
    ],
  }));
  return {
    pageHeading: "Why Did Apollo 11 Need a Manual Landing Decision?",
    seoTitle: "Why Apollo 11 Needed a Manual Landing Decision",
    seoDescription:
      "Apollo 11's descent shows how computer guidance, fuel pressure, and a manual decision combined during the first crewed Moon landing.",
    description:
      "Follow the alarms, narrowing fuel margin, and landing-site decision that shaped Apollo 11's final descent to the lunar surface.",
    summary:
      "Apollo 11's landing depended on a sequence of crew decisions made while the lunar module continued descending in July 1969.",
    overviewCards: Array.from({ length: 5 }, (_, index) => ({
      label: `Decision ${index + 1}`,
      value: `${words(`card${index}`, 28)}.`,
    })),
    comparisonHeading: "Guidance plan and landing reality",
    comparisonIntro:
      "The descent combined a planned guidance sequence with decisions made in response to the terrain and the spacecraft's remaining margin.",
    comparisonRows: Array.from({ length: 3 }, (_, index) => ({
      expected: `${words(`expected${index}`, 12)}.`,
      happened: `${words(`happened${index}`, 16)}.`,
      mattered: `${words(`mattered${index}`, 16)}.`,
    })),
    bodySections,
    timeline: Array.from({ length: 5 }, (_, index) => ({
      date: `July ${16 + index}, 1969`,
      label: `${words(`timeline${index}`, 18)}.`,
      kind: "milestone",
    })),
  };
}

function readyEntity() {
  const seed = historySeed();
  const content = sourceRichContent();
  const candidate = hooks.evergreenHistoryCandidateEligibility(
    seed,
    content,
    { primaryEvent: true },
  );
  const pending = {
    ...seed,
    slug: candidate.slug,
    url: `/history/${candidate.slug}/`,
    canonicalIdentity: candidate.canonicalIdentity,
    sourceLinks: candidate.sourceLinks,
    evergreenEvidence: candidate.evidence,
    historyQualityGateVersion: 2,
    needsEvergreenRefresh: true,
    relatedPosts: ["20-july-2026"],
    sourcePostUrl: "/blog/20-july-2026/",
    sourcePostTitle: content.curiosityTitle,
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/example-apollo.jpg",
  };
  const ready = hooks.normalizeEvergreenHistoryEdition(
    pending,
    parsedEdition(),
  );
  assert.ok(ready, "fixture must pass the production quality gate");
  ready.historyLinkEligible = true;
  delete ready.needsEvergreenRefresh;
  return ready;
}

test("future history URLs use the Wikipedia subject identity plus historical year", () => {
  assert.equal(
    hooks.normalizedWikipediaEntityIdentity(
      "https://en.wikipedia.org/wiki/Apollo_11#Landing",
    ),
    "enwiki:apollo 11",
  );
  assert.equal(
    hooks.buildEvergreenHistorySlug(historySeed(), sourceRichContent()),
    "apollo-11-1969",
  );
});

test("only a primary event with independent evidence becomes an evergreen candidate", () => {
  const eligible = hooks.evergreenHistoryCandidateEligibility(
    historySeed(),
    sourceRichContent(),
    { primaryEvent: true },
  );
  assert.equal(eligible.ok, true, eligible.reasons.join("; "));
  assert.equal(eligible.slug, "apollo-11-1969");
  assert.equal(eligible.sourceLinks.length, 2);
  assert.equal(eligible.canonicalIdentity, "enwiki:apollo 11");

  const withoutIndependent = sourceRichContent();
  withoutIndependent.sourcePages =
    withoutIndependent.sourcePages.slice(0, 1);
  const rejected = hooks.evergreenHistoryCandidateEligibility(
    historySeed(),
    withoutIndependent,
    { primaryEvent: true },
  );
  assert.equal(rejected.ok, false);
  assert.ok(
    rejected.reasons.some((reason) => /independent/i.test(reason)),
    rejected.reasons.join("; "),
  );
});

test("the edition gate requires deep, distinct, source-backed content", () => {
  const ready = readyEntity();
  const quality = hooks.evergreenHistoryEditionQuality(ready);
  assert.equal(quality.ok, true, quality.reasons.join("; "));
  assert.ok(quality.bodyWords >= 650);

  const thin = {
    ...ready,
    bodySections: ready.bodySections.slice(0, 2),
    timeline: ready.timeline.slice(0, 2),
  };
  const rejected = hooks.evergreenHistoryEditionQuality(thin);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reasons.some((reason) => /four substantive/i.test(reason)));
  assert.ok(rejected.reasons.some((reason) => /five grounded timeline/i.test(reason)));
});

test("a qualified edition upgrades the related article metadata and visible card", async () => {
  const entity = readyEntity();
  const person = {
    type: "person",
    slug: "neil-armstrong",
    name: "Neil Armstrong",
    url: "/people/neil-armstrong/",
    wikiUrl: "https://en.wikipedia.org/wiki/Neil_Armstrong",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/example-armstrong.jpg",
    profileLinkEligible: true,
    profileSubjectVerified: true,
    wikidataEntityId: "Q1615",
    wikidataInstanceOfHuman: true,
  };
  const pendingEvent = {
    type: "event",
    slug: "apollo-11-1969",
    name: "Apollo 11",
    url: "/history/apollo-11-1969/",
    wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
    canonicalIdentity: "enwiki:apollo 11",
    historyQualityGateVersion: 2,
    historyLinkEligible: false,
  };
  const initialMetadata = hooks.compactArticleEntityMeta([
    person,
    pendingEvent,
  ]);
  const initialHtml =
    `<html><head><link rel="canonical" href="https://thisday.info/blog/20-july-2026/"></head><body>` +
    hooks.buildArticleEntityStrip(initialMetadata) +
    `</body></html>`;
  assert.doesNotMatch(initialHtml, /<a[^>]+class="story-topic-card/);

  const values = new Map([
    ["post-entities:20-july-2026", JSON.stringify(initialMetadata)],
    ["post:20-july-2026", initialHtml],
  ]);
  const writes = [];
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return values.get(key) ?? null;
      },
      async put(key, value) {
        writes.push(key);
        values.set(key, value);
      },
    },
  };

  const updated = await hooks.syncEvergreenHistoryDiscoveryForEntity(
    env,
    entity,
  );
  assert.equal(updated, 1);
  assert.ok(writes.includes("post-entities:20-july-2026"));
  assert.ok(writes.includes("post:20-july-2026"));

  const metadata = JSON.parse(values.get("post-entities:20-july-2026"));
  const history = metadata.find((item) => item.type === "event");
  assert.equal(history.historyLinkEligible, true);
  assert.equal(history.historyCardQualified, true);
  assert.equal(history.url, "/history/apollo-11-1969/");

  const html = values.get("post:20-july-2026");
  assert.match(html, /class="story-topic-card"/);
  assert.match(html, /Why Did Apollo 11 Need a Manual Landing Decision\?/);
  assert.match(html, /Read the full history/);
});
