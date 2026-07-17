import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as blogHooks,
} from "../js/blog-ai-worker.js";

const richHistoryBody = [{
  heading: "History",
  paragraphs: [Array.from(
    { length: 320 },
    (_, index) => `documented${index}`,
  ).join(" ")],
}];

test("promotional title hooks are removed from factual event headlines", () => {
  const content = {
    eventTitle: "Join the Fight: Spanish Civil War Begins",
    title: "Join the Fight: Spanish Civil War Begins — July 17, 1936",
    historicalDate: "July 17, 1936",
    description:
      "A military uprising against Spain's Popular Front government begins the Spanish Civil War on July 17, 1936, and divides the country.",
    ogDescription:
      "A military uprising begins the Spanish Civil War and divides Spain between Republicans and Nationalists.",
    twitterDescription:
      "A military uprising begins the Spanish Civil War in Spain on July 17, 1936.",
    quickFacts: [{
      label: "Event",
      value: "Join the Fight: Spanish Civil War Begins",
    }],
  };

  blogHooks.normalizeContentMetadata(content);

  assert.equal(content.eventTitle, "Spanish Civil War Begins");
  assert.equal(content.title, "Spanish Civil War Begins — July 17, 1936");
  assert.equal(content.quickFacts[0].value, "Spanish Civil War Begins");
});

test("publication rejects analysis that reviews the article instead of history", () => {
  const result = blogHooks.validateContentSemanticsForPublish({
    title: "Spanish Civil War Begins — July 17, 1936",
    eventTitle: "Spanish Civil War Begins",
    historicalDate: "July 17, 1936",
    historicalDateISO: "1936-07-17",
    historicalYear: 1936,
    analysisGood: [{
      title: "Clear chronology",
      detail:
        "The article accurately records the opening of the conflict and correctly identifies the factions involved.",
    }],
    analysisBad: [{
      title: "Missing context",
      detail:
        "The article omits casualty data and does not explain the political transition after 1939.",
    }],
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((reason) =>
      /reviews the article instead of analyzing/i.test(reason)),
    JSON.stringify(result.reasons),
  );
});

test("history discovery is separated from the people row", () => {
  const html = blogHooks.buildArticleEntityStrip([
    {
      type: "person",
      slug: "francisco-franco",
      name: "Francisco Franco",
      url: "/people/francisco-franco/",
      wikiUrl: "https://en.wikipedia.org/wiki/Francisco_Franco",
      imageUrl:
        "https://upload.wikimedia.org/wikipedia/commons/4/4a/GENERAL_FRANCO.jpg",
      wikidataEntityId: "Q29179",
      wikidataInstanceOfHuman: true,
      profileLinkEligible: true,
      profileSubjectVerified: true,
    },
    {
      type: "event",
      slug: "spanish-civil-war",
      name: "Spanish Civil War",
      url: "/history/spanish-civil-war/",
      wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      bodySections: richHistoryBody,
    },
  ]);

  const peopleRow = html.match(
    /<h2 class="h3">People in this story<\/h2><div class="[^"]*\bentity-person-chips\b[^"]*">([\s\S]*?)<\/div>/,
  )?.[1] || "";

  assert.match(
    html,
    /<div class="entity-strip people-strip" data-entity-strip="1">/,
  );
  assert.match(
    html,
    /<div class="entity-strip-content people-track-wrap">/,
  );
  assert.match(
    html,
    /<div class="entity-person-chips people-track">/,
  );
  assert.match(html, /w=160&h=160&fit=cover&q=80/);
  assert.match(html, /width="80" height="80"/);
  assert.doesNotMatch(html, /\.person-pill\{/);
  assert.match(peopleRow, /Francisco Franco/);
  assert.doesNotMatch(peopleRow, /Spanish Civil War|\/history\//);
  assert.match(
    html,
    /<section class="story-topic-section"[^>]*><h2 class="h4">Explore this event<\/h2>/,
  );
  assert.match(html, /href="\/history\/spanish-civil-war\/"/);
  assert.equal(
    blogHooks.articleEntityStripNeedsProfileValidation(
      html,
      JSON.stringify([{
        type: "person",
        slug: "francisco-franco",
        name: "Francisco Franco",
        profileLinkEligible: true,
        profileSubjectVerified: true,
        wikidataEntityId: "Q29179",
        wikidataInstanceOfHuman: true,
      }]),
    ),
    false,
  );
});

test("legacy article people strips adopt the homepage presentation at serve time", () => {
  const legacy = `<html><head><link rel="stylesheet" href="/css/custom.css?v=31"></head><body>
<style>.entity-strip{margin:0 0 2rem}.entity-person-chips{display:flex}.person-pill{display:inline-flex;white-space:nowrap}.person-circle{width:42px;height:42px}.person-pill-name{width:96px;overflow:hidden;white-space:nowrap}</style><div class="entity-strip" data-entity-strip="1"><div class="entity-strip-content"><h2 class="h3">People in this story</h2><div class="entity-person-chips"><a href="/people/francisco-franco/" class="person-pill"><span class="person-circle"><img src="/image-proxy?src=portrait.jpg&w=120&h=120&fit=cover&q=80" alt="Francisco Franco" loading="lazy"></span><span class="person-pill-name">Francisco Franco</span></a></div></div></div>
<p id="after-strip">After strip</p></body></html>`;

  const normalized =
    blogHooks.normalizeArticleEntityStripPresentationHtml(legacy);

  assert.match(
    normalized,
    /<div class="entity-strip people-strip" data-entity-strip="1">/,
  );
  assert.match(
    normalized,
    /class="entity-strip-content people-track-wrap"/,
  );
  assert.match(
    normalized,
    /class="entity-person-chips people-track"/,
  );
  assert.match(normalized, /w=160&h=160&fit=cover&q=80/);
  assert.match(normalized, /width="80" height="80"/);
  assert.match(normalized, /<span class="person-pill-name">Francisco Franco<\/span>/);
  assert.doesNotMatch(normalized, /\.person-pill\{/);
  assert.doesNotMatch(normalized, /width:42px|white-space:nowrap\}\.person-circle/);
  assert.match(normalized, /<p id="after-strip">After strip<\/p>/);
  assert.equal(
    blogHooks.normalizeArticleEntityStripPresentationHtml(normalized),
    normalized,
  );
});

test("analysis is event-labelled and collapsed behind a native disclosure", () => {
  const analysisItems = (prefix) => Array.from({ length: 3 }, (_, index) => ({
    title: `${prefix} ${index + 1}`,
    detail:
      `The Spanish record for 1936 documents a concrete historical action, its limits, and a source-supported consequence for analysis point ${index + 1}.`,
  }));
  const html = blogHooks.buildPostHTML(
    {
      title: "Spanish Civil War Begins — July 17, 1936",
      curiosityTitle:
        "How Did a Partly Failed Coup Become the Spanish Civil War?",
      eventTitle: "Spanish Civil War Begins",
      sourcePageTitle: "Spanish Civil War",
      wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      historicalDate: "July 17, 1936",
      historicalDateISO: "1936-07-17",
      historicalYear: 1936,
      description:
        "A military uprising against Spain's Popular Front government begins the Spanish Civil War on July 17, 1936, and divides the country.",
      overviewParagraphs: [
        "The July 1936 uprising divided Spain between Republican and Nationalist forces.",
      ],
      analysisGood: analysisItems("Evidence"),
      analysisBad: analysisItems("Limit"),
      keyTerms: [{ term: "Francisco Franco", type: "person" }],
    },
    new Date("2026-07-17T00:05:00.000Z"),
    "17-july-2026",
    [],
    ["War & Conflict"],
  );

  assert.match(
    html,
    /<title>How Did a Partly Failed Coup Become the Spanish Civil War\?<\/title>/,
  );
  assert.match(
    html,
    /<h1 class="mb-2 fw-bold">How Did a Partly Failed Coup Become the Spanish Civil War\?<\/h1>/,
  );
  assert.match(
    html,
    /<li class="breadcrumb-item active" aria-current="page">Spanish Civil War Begins<\/li>/,
  );
  assert.match(html, /<h2 class="h3">Analysis: Spanish Civil War<\/h2>/);
  assert.match(html, /<details class="analysis-disclosure mt-2">/);
  assert.match(
    html,
    /<summary class="analysis-disclosure-summary">What the evidence supports and leaves unresolved<\/summary>/,
  );
  assert.doesNotMatch(html, /<h2 class="h3">Our Take:/);
});

test("future articles show the verified evidence comparison near the overview", () => {
  const sourcePages = [
    {
      pageTitle: "Spanish Civil War",
      pageUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      publisher: "Wikipedia",
      accessedAt: "2026-07-17",
      supportedClaims: [
        "A military uprising in July 1936 began the Spanish Civil War.",
      ],
    },
    {
      pageTitle: "The Spanish Civil War",
      pageUrl: "https://www.iwm.org.uk/history/what-you-need-to-know-about-the-spanish-civil-war",
      publisher: "Imperial War Museums",
      accessedAt: "2026-07-17",
      supportedClaims: [
        "A military uprising in July 1936 began the Spanish Civil War.",
      ],
      verifiedIndependent: true,
    },
  ];

  const validation = blogHooks.validateEvidenceMapForPublish({ sourcePages });
  const html = blogHooks.buildEvidenceMapBlock({ sourcePages });
  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  assert.equal(validation.ok, true, JSON.stringify(validation.reasons));
  assert.match(html, /Evidence Map: How We Checked the Central Claim/);
  assert.match(html, /Spanish Civil War · Wikipedia/);
  assert.match(html, /The Spanish Civil War · Imperial War Museums/);
  assert.match(html, /Independent corroboration/);
  assert.doesNotMatch(visibleText, /https?:\/\//);
});

test("public question titles use a source-supported niche while factual metadata stays locked", () => {
  const content = {
    title: "Spanish Civil War Begins — July 17, 1936",
    curiosityTitle:
      "How Did a Partly Failed Coup Become the Spanish Civil War?",
    eventTitle: "Spanish Civil War Begins",
    sourceEventHeadline: "Spanish Civil War Begins",
    sourcePageTitle: "Spanish Civil War",
    sourceText:
      "An army coup against the Spanish Republic was only partly successful and the country was divided, beginning the Spanish Civil War.",
    sourceExtract:
      "The coup failed to take control of the whole country. Spain split between Republican and Nationalist zones and the conflict developed into civil war.",
    sourcePages: [{
      pageTitle: "Spanish Civil War",
      pageUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      supportedClaims: [
        "The military coup was only partly successful and developed into the Spanish Civil War.",
      ],
    }],
  };

  const validation = blogHooks.validateCuriosityTitleForPublish(content);

  assert.equal(validation.ok, true, JSON.stringify(validation.reasons));
  assert.equal(
    blogHooks.publicArticleTitle(content),
    "How Did a Partly Failed Coup Become the Spanish Civil War?",
  );
  assert.equal(content.eventTitle, "Spanish Civil War Begins");
  assert.equal(content.title, "Spanish Civil War Begins — July 17, 1936");
});

test("question-title contract rejects generic or unsupported clickbait", () => {
  const content = {
    title: "Spanish Civil War Begins — July 17, 1936",
    eventTitle: "Spanish Civil War Begins",
    sourcePageTitle: "Spanish Civil War",
    sourceText:
      "A military uprising divided Spain and began the Spanish Civil War.",
    sourcePages: [{
      pageTitle: "Spanish Civil War",
      pageUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      supportedClaims: [
        "A military uprising divided Spain and began the Spanish Civil War.",
      ],
    }],
  };

  const generic = blogHooks.validateCuriosityTitleForPublish({
    ...content,
    curiosityTitle: "What Happened in the Spanish Civil War?",
  });
  const unsupported = blogHooks.validateCuriosityTitleForPublish({
    ...content,
    curiosityTitle: "Why Did a Secret Treaty Start the Spanish Civil War?",
  });

  assert.equal(generic.ok, false);
  assert.ok(generic.reasons.some((reason) => /generic/i.test(reason)));
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.reasons.some((reason) => /niche angle supported/i.test(reason)));
});

test("question-title normalization removes a redundant full date without rewriting the premise", () => {
  assert.equal(
    blogHooks.normalizeCuriosityTitleText(
      "Why did a non-employee set fire to Kyoto Animation's Studio 1 on July 18, 2019?",
    ),
    "Why did a non-employee set fire to Kyoto Animation's Studio 1?",
  );
});
