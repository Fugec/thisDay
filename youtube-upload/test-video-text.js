import assert from "node:assert/strict";

import {
  extractDidYouKnowFromHtml,
  extractQuickFactsFromHtml,
} from "./lib/kv.js";
import {
  isInterestingNarrationFact,
  selectInterestingNarrationFacts,
} from "./lib/narration-selection.js";
import {
  buildNarrationParts,
  buildNarrationScript,
} from "./lib/elevenlabs.js";

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

testCurrentMarkupExtraction();
testInterestingFactSelection();
testNarrationContainsFactsOnly();
testAllFillerFailsClosed();
testArticleTextOnlyFillsMissingStrongFacts();

console.log("Video text tests passed.");
