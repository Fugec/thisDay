import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as hooks,
} from "../js/blog-ai-worker.js";

const hero =
  "https://upload.wikimedia.org/wikipedia/commons/a/a1/Hero_example.jpg";
const first =
  "https://upload.wikimedia.org/wikipedia/commons/b/b2/First_example.jpg";
const second =
  "https://upload.wikimedia.org/wikipedia/commons/c/c3/Second_example.jpg";

function timeline(count = 5) {
  return [
    { year: "1967", date: "1967", label: "Preparatory work begins", kind: "leadup" },
    { year: "1968", date: "1968", label: "The program completes testing", kind: "leadup" },
    { year: "1969", date: "July 20, 1969", label: "The event takes place", kind: "event" },
    { year: "1970", date: "1970", label: "The first results are reviewed", kind: "aftermath" },
    { year: "1972", date: "1972", label: "A successor program begins", kind: "aftermath" },
  ].slice(0, count);
}

function queuedCompanion() {
  return {
    type: "event",
    slug: "example-event-1969",
    name: "Example Event",
    wikiUrl: "https://en.wikipedia.org/wiki/Example",
    url: "/history/example-event-1969/",
    primaryHistoryEntity: true,
    historyQualityGateVersion: 2,
    historyLinkEligible: false,
    needsEvergreenRefresh: true,
    evergreenEvidence: {
      articleParagraphs: [
        Array.from({ length: 705 }, (_, index) => `evidence${index}`).join(" "),
      ],
      sourcePages: [],
    },
  };
}

test("event fallbacks omit unsupported significance prose instead of filling space", () => {
  const entity = {
    type: "event",
    name: "Airblue Flight 202",
    summary:
      "Airblue Flight 202 was a scheduled domestic passenger flight from Karachi to Islamabad. On July 28, 2010, the Airbus A321 crashed in the Margalla Hills, killing all 152 people aboard. The crash remains Pakistan's deadliest aviation accident.",
    intro:
      "Airblue Flight 202 was a scheduled domestic passenger flight from Karachi to Islamabad. On July 28, 2010, the Airbus A321 crashed in the Margalla Hills, killing all 152 people aboard. The crash remains Pakistan's deadliest aviation accident.",
    sourcePostTitle:
      "Why Was Airblue Flight 202 Outside Its Approach Radius?",
  };
  const content = {
    title: "Why Was Airblue Flight 202 Outside Its Approach Radius?",
    historicalDate: "July 28, 2010",
    location: "Islamabad, Pakistan",
    description:
      "Airblue Flight 202 crashed in the Margalla Hills during its approach to Islamabad, killing all 152 people aboard.",
    contentRationale:
      "Wikipedia provides the broad event record, while this article organizes the evidence so readers can see which source supports the chronology.",
    keyTerms: [],
  };

  const sections = hooks.buildFallbackEntityBodySections(entity, content);
  const sectionText = JSON.stringify(sections);
  assert.match(sectionText, /scheduled domestic passenger flight/);
  assert.doesNotMatch(sectionText, /still matters/i);
  assert.doesNotMatch(sectionText, /organizes the evidence/i);
  assert.doesNotMatch(sectionText, /specific historical date/i);

  const cards = hooks.buildEventOverviewCards(entity, content);
  const significance = cards.find((card) => card.label === "Why it matters");
  assert.match(significance?.value || "", /deadliest aviation accident/i);
  assert.doesNotMatch(JSON.stringify(cards), /organizes the evidence/i);

  assert.deepEqual(
    hooks.buildFallbackEntityBodySections(
      { type: "event", name: "Sparse Event" },
      { contentRationale: "This page helps readers understand the event." },
    ),
    [],
  );
  assert.deepEqual(
    hooks.buildEventOverviewCards(
      { type: "event", name: "Sparse Event" },
      { keyTerms: [] },
    ),
    [],
  );
});

test("short event leads reuse validated article copy so the evergreen card does not depend on AI capacity", () => {
  const articleParagraph = Array.from(
    { length: 125 },
    (_, index) => `grounded${index}`,
  ).join(" ") + ".";
  const secondArticleParagraph = Array.from(
    { length: 75 },
    (_, index) => `verified${index}`,
  ).join(" ") + ".";
  const entity = {
    type: "event",
    slug: "example-law-1965",
    name: "Example Law",
    url: "/history/example-law-1965/",
    wikiUrl: "https://en.wikipedia.org/wiki/Example_Law",
    historyQualityGateVersion: 2,
    summary:
      "Example Law became law in 1965 and created two documented public programs.",
    intro:
      "Example Law became law in 1965 and created two documented public programs.",
  };
  const sections = hooks.buildFallbackEntityBodySections(entity, {
    overviewParagraphs: [articleParagraph, secondArticleParagraph],
  });
  const words = sections
    .flatMap((section) => section.paragraphs)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;

  assert.ok(words >= 150, `expected at least 150 fallback words, got ${words}`);
  assert.equal(
    hooks.blogEntityQualityEligible({ ...entity, bodySections: sections }),
    true,
  );
});

test("secondary article images exclude the hero and duplicate Wikimedia files", () => {
  const images = hooks.uniqueSecondaryArticleImages(
    hero,
    [
      { name: "hero again", imageUrl: hero, wikiUrl: "https://en.wikipedia.org/wiki/Example" },
      { name: "first", imageUrl: first, wikiUrl: "https://en.wikipedia.org/wiki/Example" },
    ],
    [
      { name: "first duplicate", imageUrl: first, wikiUrl: "https://en.wikipedia.org/wiki/Example" },
      { name: "second", imageUrl: second, wikiUrl: "https://en.wikipedia.org/wiki/Example" },
    ],
  );

  assert.deepEqual(images.map((image) => image.imageUrl), [first, second]);
});

test("event figure injection fills two distinct body sections even when their HTML is close", () => {
  const html = [
    "<article>",
    "<!-- Overview --><p>Overview paragraph.</p>",
    "<!-- Eyewitness / Chronicle Accounts --><p>Chronicle paragraph.</p>",
    "<!-- Aftermath --><p>Aftermath paragraph.</p>",
    "<!-- Conclusion --><p>Conclusion paragraph.</p>",
    "</article>",
  ].join("");
  const result = hooks.injectEventImages(html, [
    { name: "First", imageUrl: first, wikiUrl: "https://en.wikipedia.org/wiki/Example" },
    { name: "Second", imageUrl: second, wikiUrl: "https://en.wikipedia.org/wiki/Example" },
  ]);

  assert.equal(hooks.countRenderedInlineArticleFigures(result), 2);
  assert.match(result, /First_example\.jpg/);
  assert.match(result, /Second_example\.jpg/);
});

test("automatic publication contract requires five timeline rows, two figures, and a queued companion", () => {
  const html =
    '<article><figure style="float:right;margin:0"></figure>' +
    '<figure style="float:left;margin:0"></figure></article>';
  const accepted = hooks.validateAutomaticArticleEnrichmentForPublish({
    content: { timeline: timeline(5) },
    html,
    entityMeta: [queuedCompanion()],
  });
  assert.equal(accepted.ok, true, accepted.reasons.join("; "));

  const thinTimeline = hooks.validateAutomaticArticleEnrichmentForPublish({
    content: { timeline: timeline(4) },
    html,
    entityMeta: [queuedCompanion()],
  });
  assert.equal(thinTimeline.ok, false);
  assert.match(thinTimeline.reasons.join("; "), /needs 5/i);

  const oneFigure = hooks.validateAutomaticArticleEnrichmentForPublish({
    content: { timeline: timeline(5) },
    html: '<article><figure style="float:right;margin:0"></figure></article>',
    entityMeta: [queuedCompanion()],
  });
  assert.equal(oneFigure.ok, false);
  assert.match(oneFigure.reasons.join("; "), /rendered 1; needs 2/i);

  const noCompanion = hooks.validateAutomaticArticleEnrichmentForPublish({
    content: { timeline: timeline(5) },
    html,
    entityMeta: [],
  });
  assert.equal(noCompanion.ok, false);
  assert.match(noCompanion.reasons.join("; "), /exactly one primary/i);
});

test("unchanged retry payloads do not consume another KV write", async () => {
  const store = new Map();
  let writes = 0;
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        writes += 1;
        store.set(key, value);
      },
    },
  };

  assert.equal(
    await hooks.blogKvPutIfChanged(env, "retry:test", "same"),
    true,
  );
  assert.equal(
    await hooks.blogKvPutIfChanged(env, "retry:test", "same"),
    false,
  );
  assert.equal(writes, 1);
});

test("post-publish outbox is durable and idempotent", async () => {
  const store = new Map();
  let writes = 0;
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        writes += 1;
        store.set(key, value);
      },
    },
  };
  const payload = {
    slug: "20-july-2026",
    content: { title: "A complete core article" },
    publishedAt: "2026-07-20T00:15:00.000Z",
    pillars: ["Science & Discovery"],
    didYouKnowGroundingVerified: true,
  };

  await hooks.storePostPublishEnrichmentOutbox(env, payload);
  await hooks.storePostPublishEnrichmentOutbox(env, payload);

  const stored = JSON.parse(store.get("draft:20-july-2026"));
  assert.equal(stored.postPublished, true);
  assert.equal(stored.postPublishEnrichment.version, 1);
  assert.equal(
    stored.postPublishEnrichment.createdAt,
    payload.publishedAt,
  );
  assert.equal(writes, 1);
});

test("deferred quiz UI is omitted until a valid quiz is stored", () => {
  const content = {
    title: "Example Event Begins — July 20, 1969",
    eventTitle: "Example Event Begins",
    historicalDate: "July 20, 1969",
    historicalYear: 1969,
    description: "A concise factual description of the example event.",
    imageUrl: hero,
    imageAlt: "Example event",
    quickFacts: [],
    didYouKnowFacts: [],
    analysisGood: [],
    analysisBad: [],
    keyTerms: [],
    sourcePages: [],
  };
  const html = hooks.buildPostHTML(
    content,
    new Date("2026-07-20T00:15:00.000Z"),
    "20-july-2026",
    [],
    [],
    null,
    [],
    false,
  );

  assert.match(html, /<!-- quiz-deferred -->/);
  assert.doesNotMatch(html, /id="tdq-cta-btn"/);
  assert.doesNotMatch(html, /id="tdq-float-bar"/);
});

test("outbox completion waits for every asynchronous target", async () => {
  const quiz = {
    questions: Array.from({ length: 5 }, (_, index) => ({
      q: `Which sourced development belongs to step ${index + 1}?`,
      options: ["First option", "Second option", "Third option", "Fourth option"],
      answer: index % 4,
      explanation: "The article evidence identifies this development.",
    })),
  };
  const html =
    '<article><figure style="float:right;margin:0"></figure>' +
    '<figure style="float:left;margin:0"></figure>' +
    '<a data-history-entity-link="1" href="/history/example/"></a></article>';
  const store = new Map([
    ["post:20-july-2026", html],
    ["quiz-v3:blog:20-july-2026", JSON.stringify(quiz)],
    ["post-entities:20-july-2026", "[]"],
  ]);
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
    },
  };
  const draft = {
    content: { timeline: timeline(5) },
    postPublishEnrichment: {
      entitiesAttemptedAt: "2026-07-20T00:50:00.000Z",
    },
  };

  const ready = await hooks.postPublishEnrichmentStatus(
    env,
    "20-july-2026",
    draft,
  );
  assert.equal(ready.complete, true);

  store.delete("quiz-v3:blog:20-july-2026");
  const pending = await hooks.postPublishEnrichmentStatus(
    env,
    "20-july-2026",
    draft,
  );
  assert.equal(pending.complete, false);
  assert.equal(pending.quizReady, false);
});

test("an already-complete retained outbox is cleared without rerunning enrichment", async () => {
  const slug = "20-july-2026";
  const quiz = {
    questions: Array.from({ length: 5 }, (_, index) => ({
      q: `Which sourced development belongs to step ${index + 1}?`,
      options: ["First", "Second", "Third", "Fourth"],
      answer: index % 4,
      explanation: "The supplied evidence identifies this development.",
    })),
  };
  const draft = {
    content: { timeline: timeline(5) },
    publishedAt: "2026-07-20T00:15:00.000Z",
    postPublished: true,
    postPublishEnrichment: {
      createdAt: "2026-07-20T00:15:00.000Z",
      entitiesAttemptedAt: "2026-07-20T00:50:00.000Z",
      notifiedAt: "2026-07-20T00:55:00.000Z",
    },
  };
  const store = new Map([
    [`draft:${slug}`, JSON.stringify(draft)],
    [
      `post:${slug}`,
      '<article><figure style="float:right;margin:0"></figure>' +
        '<figure style="float:left;margin:0"></figure>' +
        '<a data-history-entity-link="1" href="/history/example/"></a></article>',
    ],
    [`quiz-v3:blog:${slug}`, JSON.stringify(quiz)],
    [`post-entities:${slug}`, "[]"],
    ["index", JSON.stringify([{ slug }])],
  ]);
  let deletes = 0;
  let puts = 0;
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async delete(key) {
        deletes += 1;
        store.delete(key);
      },
      async put() {
        puts += 1;
      },
    },
  };

  const result = await hooks.recoverPublishedPostEnrichment(env, slug);
  assert.equal(result.complete, true);
  assert.equal(result.outboxCleared, true);
  assert.equal(deletes, 1);
  assert.equal(puts, 0, "complete recovery must not rewrite images, quizzes, entities, or posts");
  assert.equal(store.has(`draft:${slug}`), false);
});

test("completed outbox cleanup failures remain observable and retryable", async () => {
  const slug = "20-july-2026";
  const quiz = {
    questions: Array.from({ length: 5 }, (_, index) => ({
      q: `Which sourced development belongs to step ${index + 1}?`,
      options: ["First", "Second", "Third", "Fourth"],
      answer: index % 4,
      explanation: "The supplied evidence identifies this development.",
    })),
  };
  const draft = {
    content: { timeline: timeline(5) },
    publishedAt: "2026-07-20T00:15:00.000Z",
    postPublished: true,
    postPublishEnrichment: {
      createdAt: "2026-07-20T00:15:00.000Z",
      entitiesAttemptedAt: "2026-07-20T00:50:00.000Z",
      notifiedAt: "2026-07-20T00:55:00.000Z",
    },
  };
  const store = new Map([
    [`draft:${slug}`, JSON.stringify(draft)],
    [
      `post:${slug}`,
      '<article><figure style="float:right;margin:0"></figure>' +
        '<figure style="float:left;margin:0"></figure>' +
        '<a data-history-entity-link="1" href="/history/example/"></a></article>',
    ],
    [`quiz-v3:blog:${slug}`, JSON.stringify(quiz)],
    [`post-entities:${slug}`, "[]"],
  ]);
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async delete() {
        throw new Error("temporary KV delete failure");
      },
    },
  };

  const result = await hooks.maybeFinalizePostPublishEnrichment(env, slug);
  assert.equal(result.complete, true);
  assert.equal(result.notified, true);
  assert.equal(result.outboxCleared, false);
  assert.equal(store.has(`draft:${slug}`), true);
});

test("Did You Know safeguards remove source boilerplate and off-topic context", () => {
  const content = {
    eventTitle: "The Webster-Ashburton Treaty Is Signed",
    sourcePageTitle: "Webster-Ashburton Treaty",
    historicalDate: "August 9, 1842",
  };
  const facts = hooks.sourceDerivedDidYouKnowFacts(
    [
      "Webster-Ashburton Treaty: On August 9, 1842, Secretary of State Daniel Webster and British diplomat Alexander Baring signed the Webster-Ashburton Treaty. The agreement settled several disputed boundary sections between the United States and British North America after formal negotiations.",
      "Webster-Ashburton Treaty notice: For more information, please see the full notice. The notice records Daniel Webster and Alexander Baring as the diplomats involved in the 1842 negotiations, while the surrounding page includes navigation and archival access instructions for readers.",
      "Rocky Mountains: The Rocky Mountains extend more than 3,000 miles across western North America and include many distinct ranges in the United States and Canada. Their geography, elevation, wildlife, and continental drainage patterns developed across a vast region over millions of years.",
    ].join("\n\n"),
    content,
  );

  assert.equal(facts.length, 1);
  assert.match(facts[0], /Daniel Webster/);
  assert.doesNotMatch(facts.join(" "), /full notice|Rocky Mountains/i);
});

test("fallback editorial notes prefer substantive facts and preserve sentence boundaries", () => {
  const note = hooks.buildFallbackEditorialNote({
    eventTitle: "The Webster-Ashburton Treaty Is Signed",
    historicalDate: "August 9, 1842",
    quickFacts: [
      { label: "Event", value: "The Webster-Ashburton Treaty Is Signed" },
      { label: "Outcome", value: "The agreement settled several disputed sections of the international boundary" },
    ],
  });

  assert.match(note, /settled several disputed sections/);
  assert.match(note, /international boundary\. That is where/);
  assert.doesNotMatch(note, /Treaty Is Signed That is where/);
});

test("an attempted timestamp cannot suppress recovery before the primary event entity is persisted", async () => {
  const paragraph = Array.from(
    { length: 710 },
    (_, index) => `grounded${index}`,
  ).join(" ");
  const content = {
    title: "Example Event Begins — July 20, 1969",
    eventTitle: "Example Event Begins",
    historicalDate: "July 20, 1969",
    historicalYear: 1969,
    wikiUrl: "https://en.wikipedia.org/wiki/Example",
    sourcePageTitle: "Example",
    overviewParagraphs: [paragraph],
    timeline: timeline(5),
    sourcePages: [
      {
        pageTitle: "Example",
        pageUrl: "https://en.wikipedia.org/wiki/Example",
        supportedClaims: ["The example event occurred in 1969."],
      },
      {
        pageTitle: "Independent example record",
        pageUrl: "https://example.org/history/example-event",
        supportedClaims: ["An independent record confirms the 1969 event."],
        verifiedIndependent: true,
      },
    ],
  };
  const quiz = {
    questions: Array.from({ length: 5 }, (_, index) => ({
      q: `Which sourced development belongs to step ${index + 1}?`,
      options: ["First", "Second", "Third", "Fourth"],
      answer: index % 4,
      explanation: "The supplied evidence identifies this development.",
    })),
  };
  const post =
    '<article><figure style="float:right;margin:0"></figure>' +
    '<figure style="float:left;margin:0"></figure></article>';
  const store = new Map([
    ["post:20-july-2026", post],
    ["quiz-v3:blog:20-july-2026", JSON.stringify(quiz)],
    [
      "post-entities:20-july-2026",
      JSON.stringify([
        {
          type: "person",
          slug: "fallback-person",
          name: "Fallback Person",
          profileLinkEligible: false,
        },
      ]),
    ],
  ]);
  const env = {
    BLOG_AI_KV: {
      async get(key) {
        return store.get(key) ?? null;
      },
    },
  };
  const draft = {
    content,
    postPublishEnrichment: {
      entitiesAttemptedAt: "2026-07-20T00:50:00.000Z",
    },
  };

  const falseAttempt = await hooks.postPublishEnrichmentStatus(
    env,
    "20-july-2026",
    draft,
  );
  assert.equal(falseAttempt.entitiesAttempted, false);
  assert.equal(falseAttempt.complete, false);

  const candidate = hooks.validatePrimaryEvergreenCandidateForContent(content);
  assert.equal(candidate.ok, true, candidate.reasons.join("; "));
  store.set(
    "post-entities:20-july-2026",
    JSON.stringify([
      {
        type: "event",
        slug: candidate.slug,
        name: content.eventTitle,
        wikiUrl: content.wikiUrl,
        canonicalIdentity: candidate.canonicalIdentity,
        historyQualityGateVersion: 2,
        historyLinkEligible: false,
      },
    ]),
  );

  const durableAttempt = await hooks.postPublishEnrichmentStatus(
    env,
    "20-july-2026",
    draft,
  );
  assert.equal(durableAttempt.entitiesAttempted, true);
});
