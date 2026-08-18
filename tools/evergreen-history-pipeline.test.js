import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as hooks,
  __entityResolutionTestHooks as entityHooks,
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
      `${words(`edition${sectionIndex}a1`, 46)}. ${words(`edition${sectionIndex}a2`, 46)}.`,
      `${words(`edition${sectionIndex}b1`, 47)}. ${words(`edition${sectionIndex}b2`, 47)}.`,
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
  assert.equal(
    Object.hasOwn(eligible.evidence, "articleRationale"),
    false,
    "editorial article-value copy must not become historical evidence",
  );

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

test("independent evidence survives a crowded six-source compact window", () => {
  const content = sourceRichContent();
  const canonical = content.sourcePages[0];
  const independent = content.sourcePages[1];
  content.sourcePages = [
    canonical,
    ...Array.from({ length: 6 }, (_, index) => ({
      pageTitle: `Supporting Wikipedia page ${index + 1}`,
      pageUrl: `https://en.wikipedia.org/wiki/Supporting_page_${index + 1}`,
      publisher: "Wikipedia",
      extract: `${words(`supporting${index}`, 90)}.`,
    })),
    independent,
  ];

  const compact = entityHooks.compactSourcePagesForIndex(content);
  assert.equal(compact.length, 6);
  assert.equal(compact[0].pageUrl, canonical.pageUrl);
  assert.ok(
    compact.some((source) => source.pageUrl === independent.pageUrl),
    "the verified independent source must not be crowded out by Wikipedia support pages",
  );

  const candidate = hooks.evergreenHistoryCandidateEligibility(
    historySeed(),
    content,
    { primaryEvent: true },
  );
  assert.equal(candidate.ok, true, candidate.reasons.join("; "));
  assert.ok(
    candidate.sourceLinks.some((source) =>
      source.url === independent.pageUrl && source.verifiedIndependent === true,
    ),
  );
});

test("evergreen AI evidence leaves completion room without losing independent grounding", () => {
  const seed = historySeed();
  const content = sourceRichContent();
  const candidate = hooks.evergreenHistoryCandidateEligibility(
    seed,
    content,
    { primaryEvent: true },
  );
  assert.equal(candidate.ok, true, candidate.reasons.join("; "));

  const corpus = hooks.evergreenHistoryEvidenceCorpus({
    ...seed,
    evergreenEvidence: candidate.evidence,
  });
  assert.ok(corpus.length <= 14_000, `corpus has ${corpus.length} characters`);
  assert.ok(corpus.split(/\s+/).filter(Boolean).length >= 700);
  assert.match(corpus, /Apollo 11 Mission Overview/);
  assert.match(corpus, /nasa0/);
});

test("evergreen prose repair cannot introduce a new numeric fact", () => {
  const original = hooks.evergreenHistoryVisibleEditionPayload(readyEntity());
  const proseOnly = structuredClone(original);
  proseOnly.description = proseOnly.description.replace(
    "Follow the alarms",
    "Trace the alarms",
  );
  assert.equal(
    hooks.evergreenHistoryRepairAddsNumbers(original, proseOnly),
    false,
  );

  const inventedNumber = structuredClone(proseOnly);
  inventedNumber.description += " The margin was 77 percent.";
  assert.equal(
    hooks.evergreenHistoryRepairAddsNumbers(original, inventedNumber),
    true,
  );
  assert.equal(Object.hasOwn(original, "evergreenEvidence"), false);
  assert.equal(Object.hasOwn(original, "sourceLinks"), false);
});

test("evergreen filler cleanup is deletion-only and keeps substantive paragraphs", () => {
  const entity = readyEntity();
  entity.bodySections[3].paragraphs = entity.bodySections[3].paragraphs.map(
    (paragraph) =>
      `${paragraph} This significant event remains a reminder of its lasting impact.`,
  );
  assert.equal(hooks.evergreenHistoryEditionQuality(entity).ok, false);

  const pruned = hooks.mechanicallyPruneEvergreenEditionFiller(entity);
  assert.equal(pruned.changed, true);
  assert.ok(
    pruned.edition.bodySections[3].paragraphs.every(
      (paragraph) => !/significant event|a reminder of|lasting impact/i.test(paragraph),
    ),
  );
  const accepted = hooks.normalizeEvergreenHistoryEdition(entity, pruned.edition);
  assert.ok(accepted);
  assert.equal(
    hooks.evergreenHistoryRepairAddsNumbers(
      hooks.evergreenHistoryVisibleEditionPayload(entity),
      pruned.edition,
    ),
    false,
  );
});

test("publication requires exactly one complete or durably queued companion", () => {
  const candidate = hooks.evergreenHistoryCandidateEligibility(
    historySeed(),
    sourceRichContent(),
    { primaryEvent: true },
  );
  const pending = {
    ...historySeed(),
    slug: candidate.slug,
    url: `/history/${candidate.slug}/`,
    primaryHistoryEntity: true,
    historyQualityGateVersion: 2,
    historyLinkEligible: false,
    needsEvergreenRefresh: true,
    evergreenEvidence: candidate.evidence,
    sourceLinks: candidate.sourceLinks,
  };

  const accepted =
    hooks.validateEvergreenCompanionQueueForPublish([pending]);
  assert.equal(accepted.ok, true, accepted.reasons.join("; "));

  const missing = hooks.validateEvergreenCompanionQueueForPublish([]);
  assert.equal(missing.ok, false);
  assert.match(missing.reasons.join("; "), /exactly one primary/i);

  const evidenceLost =
    hooks.validateEvergreenCompanionQueueForPublish([{
      ...pending,
      evergreenEvidence: {
        ...candidate.evidence,
        articleParagraphs: [],
        sourcePages: [],
      },
    }]);
  assert.equal(evidenceLost.ok, false);
  assert.match(evidenceLost.reasons.join("; "), /evidence package/i);
});

test("automatic publication preflight requires a source-ready primary companion", () => {
  const accepted = hooks.validatePrimaryEvergreenCandidateForContent({
    ...sourceRichContent(),
    wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
    sourcePageTitle: "Apollo 11",
  });
  assert.equal(accepted.ok, true, accepted.reasons.join("; "));

  const rejected = hooks.validatePrimaryEvergreenCandidateForContent({
    ...sourceRichContent(),
    wikiUrl: "",
    sourcePageTitle: "",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reasons.join("; "), /Wikipedia identity/i);
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

  const editorialMeta = {
    ...ready,
    bodySections: ready.bodySections.map((section, index) =>
      index === 0
        ? {
            ...section,
            paragraphs: [
              "Wikipedia provides the broad event record, while this article organizes the evidence so readers can see which source supports the chronology. " + section.paragraphs[0],
              section.paragraphs[1],
            ],
          }
        : section,
    ),
  };
  const editorialMetaRejected =
    hooks.evergreenHistoryEditionQuality(editorialMeta);
  assert.equal(editorialMetaRejected.ok, false);
  assert.match(
    editorialMetaRejected.reasons.join("; "),
    /article or page-production commentary/i,
  );

  const weakWriting = {
    ...ready,
    bodySections: ready.bodySections.map((section, index) =>
      index === 0
        ? {
            ...section,
            paragraphs: [
              `This rich tapestry was a significant event with a profound impact. ${section.paragraphs[0]}`,
              section.paragraphs[1],
            ],
          }
        : section,
    ),
  };
  const weakWritingRejected =
    hooks.evergreenHistoryEditionQuality(weakWriting);
  assert.equal(weakWritingRejected.ok, false);
  assert.match(
    weakWritingRejected.reasons.join("; "),
    /established writing rules/i,
  );
});

test("evergreen prose audit recognizes singular and plural event-family openings", () => {
  const issues = hooks.generatedPageWritingQualityIssues({
    type: "event",
    name: "2023 Hawaii wildfires",
    overviewCards: [{
      label: "Spread",
      value: "The wildfire crossed dry areas of Maui while winds accelerated its movement.",
    }],
    bodySections: [{
      heading: "Conditions on Maui",
      paragraphs: [
        "The fires spread through dry vegetation while emergency crews responded across several communities.",
      ],
    }],
  });
  assert.ok(
    issues.some((issue) => /generic event-family opening “fire”/.test(issue)),
    JSON.stringify(issues),
  );
});

test("a manual exact-post refresh can select an already published evergreen", () => {
  const ready = readyEntity();
  const normal = hooks.selectPendingEvergreenHistoryCandidates(
    [ready],
    {
      preferPostSlug: "20-july-2026",
      requirePostSlug: true,
    },
  );
  assert.deepEqual(normal, []);

  const forced = hooks.selectPendingEvergreenHistoryCandidates(
    [ready],
    {
      preferPostSlug: "20-july-2026",
      requirePostSlug: true,
      forceRefresh: true,
    },
  );
  assert.deepEqual(forced.map((entry) => entry.slug), [ready.slug]);
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

test("entity-strip recovery cannot erase a pending companion's richer evidence", async () => {
  const content = sourceRichContent();
  const candidate = hooks.evergreenHistoryCandidateEligibility(
    historySeed(),
    content,
    { primaryEvent: true },
  );
  assert.equal(candidate.ok, true, candidate.reasons.join("; "));
  const existing = {
    ...historySeed(),
    slug: candidate.slug,
    url: `/history/${candidate.slug}/`,
    canonicalIdentity: candidate.canonicalIdentity,
    sourceLinks: candidate.sourceLinks,
    evergreenEvidence: candidate.evidence,
    historyQualityGateVersion: 2,
    historyLinkEligible: false,
    needsEvergreenRefresh: true,
    relatedPosts: ["20-july-2026"],
  };
  const compactRecoveryDraft = {
    ...existing,
    sourceLinks: candidate.sourceLinks.slice(0, 1),
    evergreenEvidence: {
      ...candidate.evidence,
      articleParagraphs: [],
      sourcePages: candidate.evidence.sourcePages.map((page) => ({
        pageTitle: page.pageTitle,
        pageUrl: page.pageUrl,
      })),
    },
  };
  const values = new Map([
    ["entity-v1:event:apollo-11-1969", JSON.stringify(existing)],
  ]);
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return values.get(key) ?? null;
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };

  const saved = await hooks.upsertEntityRecord(env, compactRecoveryDraft);

  assert.equal(saved.needsEvergreenRefresh, true);
  assert.equal(
    hooks.evergreenHistoryEvidenceWordCount(saved.evergreenEvidence),
    hooks.evergreenHistoryEvidenceWordCount(existing.evergreenEvidence),
  );
  assert.equal(saved.sourceLinks.length, candidate.sourceLinks.length);
});

test("a pending companion self-heals evidence from its stored daily article", async () => {
  const articleParagraphs = Array.from({ length: 8 }, (_, index) =>
    `<p>${words(`published${index}`, 95)}.</p>`,
  ).join("");
  const postHtml =
    `<html><body><main><p>Published metadata is too short.</p>` +
    `${articleParagraphs}<p>Open the quiz.</p></main></body></html>`;
  const entity = {
    ...historySeed(),
    slug: "apollo-11-1969",
    url: "/history/apollo-11-1969/",
    historyQualityGateVersion: 2,
    needsEvergreenRefresh: true,
    sourcePostSlug: "20-july-2026",
    relatedPosts: ["20-july-2026"],
    evergreenEvidence: {
      articleTitle: "Apollo 11 Lands on the Moon — July 20, 1969",
      articleParagraphs: [],
      sourcePages: [],
    },
  };
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return key === "post:20-july-2026" ? postHtml : null;
      },
    },
  };

  const restored =
    await hooks.restorePendingEvergreenHistoryEvidenceFromPost(env, entity);

  assert.equal(
    hooks.extractEvergreenHistoryArticleParagraphsFromHtml(postHtml).length,
    8,
  );
  assert.ok(
    hooks.evergreenHistoryEvidenceWordCount(restored.evergreenEvidence) >= 700,
  );
});

test("a pending companion restores a lost independent source from the stored Evidence Map", async () => {
  const wikipediaSources = Array.from({ length: 6 }, (_, index) => ({
    pageTitle: index === 0 ? "Apollo 11" : `Apollo support ${index}`,
    pageUrl: index === 0
      ? "https://en.wikipedia.org/wiki/Apollo_11"
      : `https://en.wikipedia.org/wiki/Apollo_support_${index}`,
    publisher: "Wikipedia",
    extract: `${words(`storedwiki${index}`, 120)}.`,
  }));
  const postHtml = `<html><body><main>
    <p class="evidence-map-claim"><strong>Central claim checked:</strong> Apollo 11 completed the first crewed lunar landing in July 1969.</p>
    <table><tbody>
      <tr class="evidence-map-row" data-evidence-role="event-record"><td><a href="https://en.wikipedia.org/wiki/Apollo_11">Apollo 11 · Event record</a></td></tr>
      <tr class="evidence-map-row" data-evidence-role="independent"><td><a href="https://www.nasa.gov/history/apollo-11-mission-overview/">Apollo 11 Mission Overview · Independent reporting</a></td></tr>
    </tbody></table>
  </main></body></html>`;
  const entity = {
    ...historySeed(),
    slug: "apollo-11-1969",
    url: "/history/apollo-11-1969/",
    historyQualityGateVersion: 2,
    historyLinkEligible: false,
    needsEvergreenRefresh: true,
    sourcePostSlug: "20-july-2026",
    relatedPosts: ["20-july-2026"],
    sourceLinks: wikipediaSources.map((source) => ({
      label: source.pageTitle,
      url: source.pageUrl,
      publisher: source.publisher,
    })),
    evergreenEvidence: {
      articleTitle: "Apollo 11 Lands on the Moon — July 20, 1969",
      articleParagraphs: [words("published", 710)],
      sourcePages: wikipediaSources,
    },
  };
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return key === "post:20-july-2026" ? postHtml : null;
      },
    },
  };

  const restored =
    await hooks.restorePendingEvergreenHistoryEvidenceFromPost(env, entity);
  const independentUrl =
    "https://www.nasa.gov/history/apollo-11-mission-overview/";

  assert.equal(restored.sourceLinks.length, 6);
  assert.ok(
    restored.sourceLinks.some((source) =>
      source.url === independentUrl && source.verifiedIndependent === true,
    ),
  );
  assert.ok(
    restored.evergreenEvidence.sourcePages.some((source) =>
      source.pageUrl === independentUrl && source.verifiedIndependent === true,
    ),
  );
});

test("a stranded current-gate companion is selected even if its retry flag was lost", () => {
  const stranded = {
    type: "event",
    slug: "haitian-revolution-1791",
    wikiUrl: "https://en.wikipedia.org/wiki/Haitian_Revolution",
    historyQualityGateVersion: 2,
    historyLinkEligible: false,
    relatedPosts: ["14-august-2026"],
    updatedAt: "2026-08-14T00:15:00.000Z",
  };

  assert.deepEqual(
    hooks.selectPendingEvergreenHistoryCandidates([stranded]).map(
      (entry) => entry.slug,
    ),
    ["haitian-revolution-1791"],
  );
});

test("the current companion is selected before an older retry backlog", () => {
  const pending = (slug, postSlug, updatedAt) => ({
    type: "event",
    slug,
    wikiUrl: `https://en.wikipedia.org/wiki/${slug}`,
    historyQualityGateVersion: 2,
    needsEvergreenRefresh: true,
    relatedPosts: [postSlug],
    updatedAt,
  });
  const older = pending(
    "older-event-1944",
    "18-july-2026",
    "2026-07-18T00:55:00.000Z",
  );
  const current = pending(
    "current-event-1969",
    "20-july-2026",
    "2026-07-20T00:15:00.000Z",
  );

  assert.equal(
    hooks.selectPendingEvergreenHistoryCandidates(
      [older, current],
      { preferPostSlug: "20-july-2026" },
    )[0].slug,
    current.slug,
  );
  assert.equal(
    hooks.selectPendingEvergreenHistoryCandidates([current, older])[0].slug,
    older.slug,
  );
  assert.deepEqual(
    hooks.selectPendingEvergreenHistoryCandidates(
      [older],
      {
        preferPostSlug: "20-july-2026",
        requirePostSlug: true,
      },
    ),
    [],
  );
});
