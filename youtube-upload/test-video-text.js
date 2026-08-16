import assert from "node:assert/strict";

import {
  extractArticleTextFromHtml,
  extractDidYouKnowFromHtml,
  extractOverviewNarrationFromHtml,
  extractQuickFactsFromHtml,
} from "./lib/kv.js";
import {
  assessNarrationCaptionIntegrity,
  auditNarrationTopicConnection,
  buildNarrationTopicContext,
  isInterestingNarrationFact,
  selectInterestingNarrationFacts,
} from "./lib/narration-selection.js";
import {
  assessOverviewNarration,
  buildNarrationParts,
  buildNarrationScript,
  buildOverviewNarrationParts,
} from "./lib/elevenlabs.js";
import { prepareNarrationSource } from "./lib/narration-source.js";
import { buildVideoTitle } from "./lib/titles.js";
import { auditYoutubeVideo } from "./lib/youtube.js";
import {
  BACKGROUND_MUSIC_VOLUME,
  buildSingleImageMotion,
  MIN_MULTI_SCENE_IMAGES,
  normalizeVideoImageIdentity,
  VIDEO_DURATION_LIMIT_S,
  VIDEO_SCENE_COUNT,
} from "./lib/video.js";
import {
  collectReplacedYoutubeIds,
  isUploadLockActive,
} from "./lib/tracker.js";

const TITLE =
  "John F. Kennedy Jr. Dies in Plane Crash — July 16, 1999";

const LIVE_STYLE_FACTS = [
  "John F. Kennedy Jr. was born on November 25, 1960, to President John F. Kennedy and Jacqueline Kennedy, and spent his early childhood in the White House, as documented in various biographies. Kennedy's birth was a significant event, with the Kennedy family's reputation drawing widespread media attention.",
  "The plane crash was investigated by the National Transportation Safety Board, which provided a detailed report about safety measures that could have been taken to prevent it. The investigation was a thorough and meticulous process.",
  "Kennedy's wife, Carolyn Bessette-Kennedy, and her sister, Lauren Bessette, also died in the crash, which was widely reported in the media. The crash was a tragic event that shocked the nation.",
  "John F. Kennedy Jr. was the son of the 35th U.S. president and spent his early childhood in the White House, where he was known for saluting his father's casket during the funeral procession, as photographed by United Press International photographer Stan Stearns. The image symbolized the Kennedy family's legacy.",
  "Kennedy launched the political lifestyle magazine George in 1995, which was featured in several publications and was widely recognized for its unique perspective. The magazine was a significant undertaking.",
];

function testCurrentMarkupExtraction() {
  const html = `
    <div class="dyn-slider-track">
      ${LIVE_STYLE_FACTS.map(
        (fact) =>
          `<article class="dyn-slide"><p class="dyn-fact">${fact}</p></article>`,
      ).join("")}
    </div>
    <section class="ai-answer-card">
      <div class="ai-answer-item"><strong>Event</strong><span>JFK Jr. plane crash</span></div>
      <div class="ai-answer-item"><strong>Date</strong><span>July 16, 1999</span></div>
    </section>`;

  assert.deepEqual(extractDidYouKnowFromHtml(html), LIVE_STYLE_FACTS);
  assert.deepEqual(extractQuickFactsFromHtml(html), [
    "Event: JFK Jr. plane crash",
    "Date: July 16, 1999",
  ]);
}

const OVERVIEW_NARRATION =
  "On August 16, 1930, Ub Iwerks released Fiddlesticks, the first color sound cartoon. " +
  "This 1930 American animated comedy short film was directed and animated by Ub Iwerks, featuring his character Flip the Frog. " +
  "The short film utilized the short-lived Harriscolor process, making it the first complete individual sound cartoon to be photographed in color. " +
  "Fiddlesticks was a significant release, as it marked a new milestone in animation technology. " +
  "The film's plot revolves around Flip, who is seen dancing on lilypads until he reaches land and dries himself off. " +
  "He then walks to a party, where he performs a dance for the audience, accidentally climbing to a spider web. " +
  "The cartoon's use of color and sound added a new dimension to the animation, making it a notable achievement in the field. " +
  "The film's release was a testament to Ub Iwerks' innovative approach to animation.";

function testOverviewNarrationExtractionAndSelection() {
  const html = `
    <p class="article-meta">Published August 16, 2026.</p>
    <!-- Overview -->
    <section class="mt-4">
      <h2>The Ceremony and the Signal</h2>
      <figure><figcaption>Ub Iwerks</figcaption></figure>
      <p>On August 16, 1930, <a href="https://en.wikipedia.org/wiki/Ub_Iwerks">Ub Iwerks</a> released Fiddlesticks, the first color sound cartoon. ${OVERVIEW_NARRATION.replace(/^On August 16, 1930, Ub Iwerks released Fiddlesticks, the first color sound cartoon\.\s*/, "")}</p>
      <p>This second Overview paragraph must not be narrated.</p>
    </section>
    <!-- Personal Analysis -->`;
  const extracted = extractOverviewNarrationFromHtml(html);
  assert.equal(extracted, OVERVIEW_NARRATION);

  const assessment = assessOverviewNarration(extracted);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.words, 143);
  assert.equal(assessment.sentences, 8);

  const parts = buildOverviewNarrationParts(extracted);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(" "), OVERVIEW_NARRATION);
  assert.match(parts[0], /^On August 16, 1930/);

  const post = {
    title: "How did Ub Iwerks create the first color sound cartoon?",
    eventTitle: "The first color sound cartoon, Fiddlesticks, is released by Ub Iwerks",
    sourcePageTitle: "Fiddlesticks (1930 film)",
    description: "Ub Iwerks released Fiddlesticks using Harriscolor.",
  };
  const prepared = prepareNarrationSource(post, {
    overviewText: extracted,
    quickFacts: [
      "Event: The first color sound cartoon, Fiddlesticks, is released by Ub Iwerks",
      "Key Figure: Ub Iwerks",
    ],
    didYouKnow: ["A fallback fact from 1930 that must not replace the Overview."],
  });
  assert.equal(prepared.source, "overview");
  assert.equal(prepared.topicAudit.ok, true);
  assert.equal(prepared.narrationParts.join(" "), OVERVIEW_NARRATION);
}

function testWeakOverviewFallsBackToCuratedFacts() {
  const post = {
    title: TITLE,
    eventTitle: "John F. Kennedy Jr. dies in a plane crash",
    sourcePageTitle: "John F. Kennedy Jr. plane crash",
  };
  const weak = "John F. Kennedy Jr. died in 1999.";
  const prepared = prepareNarrationSource(post, {
    overviewText: weak,
    didYouKnow: LIVE_STYLE_FACTS,
    quickFacts: [
      "Event: John F. Kennedy Jr. dies in a plane crash",
      "Date: July 16, 1999",
    ],
  });
  assert.equal(prepared.source, "curated-facts");
  assert.ok(prepared.overviewAssessment.reasons.some((reason) => /shorter|fewer/.test(reason)));
  assert.ok(prepared.narrationParts.length >= 2);
}

function testOverviewSourceResidueFailsClosed() {
  const contaminated = `${OVERVIEW_NARRATION} Plot synopsis: read more at https://example.com.`;
  const assessment = assessOverviewNarration(contaminated);
  assert.equal(assessment.ok, false);
  assert.ok(assessment.reasons.some((reason) => /source or navigation residue/.test(reason)));
}

function testOverviewAuditPreservesNarrativeContext() {
  const title = "Hawaii wildfires burn seventeen thousand acres";
  const topicContext = {
    text: "2023 Hawaii wildfires on Maui burned 17,000 acres",
    coreText: "2023 Hawaii wildfires Maui",
    personTerms: [],
    locationText: "Maui, Hawaii",
  };
  const parts = [
    "The 2023 Hawaii wildfires erupted on Maui in early August, scorching 17,000 acres and claiming at least 101 lives.",
    "Emergency responders faced unprecedented challenges as the fires spread rapidly through densely populated areas.",
  ];
  assert.equal(
    auditNarrationTopicConnection(title, parts, topicContext).ok,
    false,
  );
  assert.equal(
    auditNarrationTopicConnection(title, parts, topicContext, {
      continuousNarrative: true,
    }).ok,
    true,
  );
}

function testMultiImageVideoConfiguration() {
  assert.equal(VIDEO_SCENE_COUNT, 3);
  assert.equal(MIN_MULTI_SCENE_IMAGES, 2);
  assert.equal(VIDEO_DURATION_LIMIT_S, 60);
  assert.equal(BACKGROUND_MUSIC_VOLUME, 0.33);

  const original =
    "https://upload.wikimedia.org/wikipedia/commons/0/0c/Flip_the_Frog_-_Fiddlesticks_poster.jpg?utm_source=en.wikipedia.org";
  const thumbnail =
    "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Flip_the_Frog_-_Fiddlesticks_poster.jpg/640px-Flip_the_Frog_-_Fiddlesticks_poster.jpg";
  const proxiedThumbnail =
    `https://thisday.info/image-proxy?src=${encodeURIComponent(thumbnail)}`;
  assert.equal(
    normalizeVideoImageIdentity(original),
    normalizeVideoImageIdentity(proxiedThumbnail),
  );
}

function testInterestingFactSelection() {
  const selected = selectInterestingNarrationFacts(
    TITLE,
    [
      ...LIVE_STYLE_FACTS,
      "Remembered as a prominent social figure and son of President John F. Kennedy.",
    ],
    null,
    { limit: 3 },
  );

  assert.equal(selected.length, 3);
  assert.match(selected[0], /saluting his father's casket/i);
  assert.ok(selected.some((fact) => /magazine George in 1995/i.test(fact)));
  assert.ok(selected.some((fact) => /Carolyn Bessette-Kennedy/i.test(fact)));
  assert.ok(selected.every((fact) => !/prominent social figure/i.test(fact)));
  assert.ok(selected.every((fact) => isInterestingNarrationFact(fact, TITLE)));
  assert.ok(
    selected.every(
      (fact) =>
        !/significant event|widely reported|thorough and meticulous|unique perspective|symbolized|as documented/i.test(
          fact,
        ),
    ),
  );
}

function testNarrationContainsFactsOnly() {
  const facts = [
    "John F. Kennedy Jr. was known for saluting his father's casket during the funeral procession.",
    "Kennedy launched the political lifestyle magazine George in 1995.",
    "Carolyn Bessette-Kennedy and Lauren Bessette also died in the crash.",
    "This fourth fact must not be narrated.",
  ];
  const post = {
    title: TITLE,
    description:
      "This generic description must never become narration when facts are unavailable.",
  };

  const script = buildNarrationScript(post, facts);
  const parts = buildNarrationParts(post, facts);

  assert.doesNotMatch(script, /On this day in history|Discover more|generic description/i);
  assert.doesNotMatch(script, /fourth fact/i);
  assert.match(script, /saluting his father's casket/i);
  assert.match(script, /magazine George in 1995/i);
  assert.match(script, /Lauren Bessette also died/i);
  assert.doesNotMatch(script, /John F\. Kennedy Jr\. Dies in Plane Crash\./i);
  assert.equal(parts.length, 3, "exactly three selected facts");
  assert.equal(
    buildNarrationScript(post, null),
    "John F. Kennedy Jr. Dies in Plane Crash.",
    "missing facts must not fall back to arbitrary article or description filler",
  );
}

function testAllFillerFailsClosed() {
  const selected = selectInterestingNarrationFacts(
    TITLE,
    [
      "The investigation was a thorough and meticulous process.",
      "The event was significant and drew widespread media attention.",
      "This serves as a reminder of the importance of history.",
    ],
    null,
  );
  assert.deepEqual(selected, []);
}

function testArticleTextOnlyFillsMissingStrongFacts() {
  const selected = selectInterestingNarrationFacts(
    TITLE,
    [
      "Kennedy launched the political lifestyle magazine George in 1995.",
      "The event was significant and drew widespread media attention.",
    ],
    "John F. Kennedy Jr. was known for saluting his father's casket during the funeral procession. This serves as a reminder of the importance of history.",
    { limit: 3 },
  );

  assert.deepEqual(selected, [
    "Kennedy launched the political lifestyle magazine George in 1995.",
    "John F. Kennedy Jr. was known for saluting his father's casket during the funeral procession.",
  ]);
}

function testElPasoCityProfileCannotBecomeNarration() {
  const post = {
    title: "How Did the 2019 El Paso Walmart Shooting Unfold?",
    factualTitle: "El Paso Walmart shooting occurs — August 3, 2019",
    eventTitle: "El Paso Walmart shooting occurs",
    sourcePageTitle: "2019 El Paso Walmart shooting",
    description:
      "Patrick Crusius drove to El Paso before the attack at the Walmart near Cielo Vista Mall.",
    keywords:
      "El Paso, Walmart shooting, domestic terrorism, white nationalism, 8chan, 2019",
    keyTerms: [{ term: "Patrick Crusius", type: "person" }],
  };
  const didYouKnow = [
    "Video ‘We changed lives’: TLC Foundation shuts down after decades of helping terminal and sick children Video 14 WestJet flights cancelled at London International Airport Video Investigation continues into a boating crash.",
    "El Paso is a city in and the county seat of El Paso County, Texas. It is the 23rd-most populous city in the U.S. with a population of 678,815 at the 2020 census.",
    "Crusius surrendered and was arrested and charged with capital murder in connection with the shooting. He posted a manifesto with white nationalist and anti-immigrant themes on 8chan shortly before the attack.",
    "The El Paso metropolitan area has an estimated 879,000 residents. El Paso stands on the Rio Grande across the Mexico–United States border from Ciudad Juárez.",
  ];
  const quickFacts = [
    "Event: El Paso Walmart shooting occurs",
    "Date: August 3, 2019",
    "Location: El Paso, Texas, United States",
    "Key Figure: Patrick Crusius, a 21-year-old gunman",
    "Investigation: The Federal Bureau of Investigation investigated the shooting as an act of domestic terrorism and a hate crime.",
    "Source Subject: 2019 El Paso Walmart shooting",
  ];
  const topicContext = buildNarrationTopicContext(post, quickFacts);
  const selected = selectInterestingNarrationFacts(
    post.eventTitle,
    [...didYouKnow, ...quickFacts],
    null,
    {
      limit: 3,
      dateHint: post.factualTitle,
      topicContext,
    },
  );
  const audit = auditNarrationTopicConnection(
    post.eventTitle,
    selected,
    topicContext,
  );

  assert.equal(selected.length, 3);
  assert.equal(audit.ok, true);
  assert.ok(
    selected.every((fact) =>
      /shooting|attack|gunman|Crusius|terrorism|hate crime|manifesto/i.test(fact),
    ),
  );
  assert.ok(
    selected.every(
      (fact) =>
        !/population|populous|census|residents|Rio Grande|Ciudad Juárez|WestJet|TLC Foundation/i.test(
          fact,
        ),
    ),
  );
}

function testArticleFallbackUsesBodyOnly() {
  const html = `
    <p class="article-meta">Published August 3, 2026 by thisDay Editorial Team.</p>
    <p class="dyn-fact">El Paso has a population of 678,815 residents.</p>
    <!-- Overview -->
    <section><p>Patrick Crusius opened fire at the El Paso Walmart, killing shoppers and beginning the documented law-enforcement response to the shooting.</p></section>
    <section><p>The Federal Bureau of Investigation investigated the attack as domestic terrorism and a hate crime while prosecutors pursued federal and state charges.</p></section>
    <!-- Personal Analysis -->
    <p>Unrelated recommendation copy after the article body.</p>`;
  const articleText = extractArticleTextFromHtml(html);
  assert.match(articleText, /Patrick Crusius opened fire/);
  assert.match(articleText, /Federal Bureau of Investigation/);
  assert.doesNotMatch(articleText, /population of 678,815|recommendation copy/);
}

function testCaptionIntegrityMustMatchApprovedScript() {
  const script =
    "Patrick Crusius surrendered after the El Paso Walmart shooting.";
  const matchingWords = script
    .split(/\s+/)
    .map((word, index) => ({ word, start: index, end: index + 0.5 }));
  assert.equal(assessNarrationCaptionIntegrity(script, matchingWords).ok, true);
  assert.equal(
    assessNarrationCaptionIntegrity(script, [
      { word: "El", start: 0, end: 0.2 },
      { word: "Paso", start: 0.2, end: 0.4 },
      { word: "population", start: 0.4, end: 0.8 },
    ]).ok,
    false,
  );
}

function testTopicAuditNeedsTwoConnectedFacts() {
  const context = {
    text: "Apollo 11 moon landing Neil Armstrong Buzz Aldrin",
    coreText: "Apollo 11 moon landing",
    personTerms: ["Neil Armstrong", "Buzz Aldrin"],
    locationText: "Moon",
  };
  assert.equal(
    auditNarrationTopicConnection(
      "Apollo 11 moon landing",
      [
        "Apollo 11 landed on the Moon with Neil Armstrong in command.",
        "Buzz Aldrin landed with Armstrong and joined him on the lunar surface.",
      ],
      context,
    ).ok,
    true,
  );
  assert.equal(
    auditNarrationTopicConnection(
      "Apollo 11 moon landing",
      ["Apollo 11 landed on the Moon with Neil Armstrong in command."],
      context,
    ).ok,
    false,
  );
}

function testYoutubeReviewMetadataMustMatchArticle() {
  const post = {
    slug: "3-august-2026",
    title: "How Did the 2019 El Paso Walmart Shooting Unfold?",
    eventTitle: "El Paso Walmart shooting occurs",
    description: "The documented events and aftermath of the Walmart shooting.",
    publishedAt: "2026-08-03T00:00:00.000Z",
  };
  const video = {
    id: "review-video",
    snippet: {
      title: buildVideoTitle(post),
      description:
        "Private review\nhttps://thisday.info/blog/3-august-2026/",
    },
    status: { privacyStatus: "private" },
  };
  assert.equal(
    auditYoutubeVideo(post, video, { expectedPrivacy: "private" }).ok,
    true,
  );
  assert.equal(
    auditYoutubeVideo(post, {
      ...video,
      snippet: { ...video.snippet, title: "A video about El Paso city" },
    }, { expectedPrivacy: "private" }).ok,
    false,
  );
  assert.equal(
    auditYoutubeVideo(post, {
      ...video,
      status: { privacyStatus: "public" },
    }, { expectedPrivacy: "private" }).ok,
    false,
  );
}

function testSingleImageMotionIsVisibleAndRepeated() {
  const motion = buildSingleImageMotion(20);
  assert.equal(motion.d, 600);
  assert.equal(motion.cycleFrames, 210);
  assert.match(motion.zoom, /mod\(on,210\)/);
  assert.match(motion.zoom, /1\.02\+0\.14/);
  assert.match(motion.x, /sin\(2\*PI\*on\/210\)/);
  assert.match(motion.y, /cos\(2\*PI\*on\/210\)/);
}

function testCancelledUploadLockCanBeIdentified() {
  const now = new Date("2026-08-03T18:10:00.000Z");
  assert.equal(
    isUploadLockActive({ claimedAt: "2026-08-03T18:09:00.000Z" }, now),
    true,
  );
  assert.equal(
    isUploadLockActive({ claimedAt: "2026-08-03T11:00:00.000Z" }, now),
    false,
  );
}

function testReplacementChainSurvivesConcurrentRetries() {
  assert.deepEqual(
    collectReplacedYoutubeIds(
      {
        youtubeId: "l4gt2Z3kpck",
        replacesYoutubeId: "2ALMrrP9NGQ",
        replacesYoutubeIds: ["2ALMrrP9NGQ"],
        retiredYoutubeIds: ["olderVideo1"],
      },
      "o5M2vK4Przs",
    ),
    ["l4gt2Z3kpck", "2ALMrrP9NGQ", "olderVideo1"],
  );
}

testCurrentMarkupExtraction();
testOverviewNarrationExtractionAndSelection();
testWeakOverviewFallsBackToCuratedFacts();
testOverviewSourceResidueFailsClosed();
testOverviewAuditPreservesNarrativeContext();
testMultiImageVideoConfiguration();
testInterestingFactSelection();
testNarrationContainsFactsOnly();
testAllFillerFailsClosed();
testArticleTextOnlyFillsMissingStrongFacts();
testElPasoCityProfileCannotBecomeNarration();
testArticleFallbackUsesBodyOnly();
testCaptionIntegrityMustMatchApprovedScript();
testTopicAuditNeedsTwoConnectedFacts();
testYoutubeReviewMetadataMustMatchArticle();
testSingleImageMotionIsVisibleAndRepeated();
testCancelledUploadLockCanBeIdentified();
testReplacementChainSurvivesConcurrentRetries();

console.log("Video text tests passed.");
