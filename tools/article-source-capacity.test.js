import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as hooks,
} from "../js/blog-ai-worker.js";

function evidence(prefix, year, count = 20) {
  return Array.from(
    { length: count },
    (_, index) =>
      `${prefix} ${index + 1} documents a distinct stage of the ${year} event, naming its participants, location, institution, procedure, chronology, and separately recorded result.`,
  ).join(" ");
}

function richSource({
  pageTitle = "Rich Event",
  year = 1910,
  primary = evidence("Primary event record", year),
  independent = evidence("Independent event account", year),
} = {}) {
  const slug = pageTitle.replace(/\s+/g, "_");
  return {
    eventTitle: `${pageTitle} reaches a recorded decision`,
    pageTitle,
    text: `Officials record the ${pageTitle} decision in ${year}.`,
    sourceExtract: primary,
    wikiUrl: `https://en.wikipedia.org/wiki/${slug}`,
    sourcePages: [
      {
        pageTitle,
        pageUrl: `https://en.wikipedia.org/wiki/${slug}`,
        extract: primary,
      },
      {
        pageTitle: `${pageTitle} independent account`,
        pageUrl: `https://archive.example.org/${slug.toLowerCase()}`,
        verifiedIndependent: true,
        extract: independent,
      },
    ],
  };
}

test("article evidence pack prioritizes the canonical event and verified independent source", () => {
  const source = richSource({
    pageTitle: "2019 Conservative Party leadership election",
    year: 2019,
    primary: evidence("Election record", 2019),
    independent: evidence("Contemporary election report", 2019),
  });
  source.sourcePages.unshift({
    pageTitle: "Boris Johnson",
    pageUrl: "https://en.wikipedia.org/wiki/Boris_Johnson",
    extract:
      "Generic biography material about childhood, education, journalism, books, family life, and unrelated offices. ".repeat(100),
  });

  const pack = hooks.buildArticleEvidencePack(source, { maxChars: 5_500 });

  assert.ok(pack.text.length <= 5_500);
  assert.match(pack.text, /Election record 1/);
  assert.match(pack.text, /Contemporary election report 1/);
  assert.ok(
    pack.text.indexOf("Contemporary election report 1") <
      pack.text.indexOf("Generic biography material") ||
      !pack.text.includes("Generic biography material"),
  );
  assert.equal(
    hooks.articleEvidenceCapacity(source).ok,
    true,
  );
});

test("article evidence capacity rejects volume supplied only by an irrelevant biography", () => {
  const source = {
    eventTitle: "Example summit reaches a decision",
    pageTitle: "Example summit decision",
    text: "Officials announce an example summit decision in 1999.",
    sourceExtract:
      "The summit met in 1999 and issued one recorded decision.",
    wikiUrl: "https://en.wikipedia.org/wiki/Example_summit_decision",
    sourcePages: [
      {
        pageTitle: "Example summit decision",
        pageUrl: "https://en.wikipedia.org/wiki/Example_summit_decision",
        extract:
          "The summit met in 1999 and issued one recorded decision.",
      },
      {
        pageTitle: "Independent summit account",
        pageUrl: "https://archive.example.org/example-summit",
        verifiedIndependent: true,
        extract:
          "An independent archive confirms the summit date and named officials in 1999.",
      },
      {
        pageTitle: "Unrelated official",
        pageUrl: "https://en.wikipedia.org/wiki/Unrelated_official",
        extract:
          "This long biography discusses childhood, schooling, family, hobbies, publications, travel, and unrelated appointments. ".repeat(120),
      },
    ],
  };

  const capacity = hooks.articleEvidenceCapacity(source);

  assert.equal(capacity.ok, false);
  assert.ok(
    capacity.reasons.some((reason) => /packed evidence has .* words/.test(reason)),
    capacity.reasons.join("; "),
  );
});

test("source-ready selection rotates past a topic that cannot support 750 grounded body words", async () => {
  const thin = {
    year: 1900,
    pageTitle: "Thin Event",
    pageUrl: "https://en.wikipedia.org/wiki/Thin_Event",
    text: "Officials record the Thin Event in 1900.",
    extract: "The Thin Event occurred in 1900.",
    sourcePages: [
      {
        pageTitle: "Thin Event",
        pageUrl: "https://en.wikipedia.org/wiki/Thin_Event",
        extract: "The Thin Event occurred in 1900.",
      },
      {
        pageTitle: "Thin independent account",
        pageUrl: "https://archive.example.org/thin-event",
        verifiedIndependent: true,
        extract: "An archive confirms the Thin Event occurred in 1900.",
      },
    ],
  };
  const rich = {
    year: 1910,
    pageTitle: "Rich Event",
    pageUrl: "https://en.wikipedia.org/wiki/Rich_Event",
    text: "Officials record the Rich Event decision in 1910.",
    extract: evidence("Rich primary record", 1910),
    sourcePages: richSource().sourcePages,
  };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const title = url.searchParams.get("titles") || "Thin Event";
    return new Response(
      JSON.stringify({
        query: {
          pages: {
            1: {
              title,
              extract: `${title} occurred in 1900.`,
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const selected = await hooks.selectSourceReadyCandidate(
    [thin, rich],
    fetchImpl,
    { requireArticleCapacity: true },
  );

  assert.equal(selected?.pageTitle, "Rich Event");
  assert.equal(selected?.articleEvidenceCapacity?.ok, true);
  assert.ok(selected.articleEvidenceCapacity.wordCount >= 600);
});

test("selection falls back to the least-thin independently sourced candidate instead of hard-failing when every candidate is evidence-thin", async () => {
  const thinCandidate = (label, year) => ({
    year,
    pageTitle: `${label} Event`,
    pageUrl: `https://en.wikipedia.org/wiki/${label}_Event`,
    text: `Officials record the ${label} Event in ${year}.`,
    extract: `The ${label} Event occurred in ${year}.`,
    sourcePages: [
      {
        pageTitle: `${label} Event`,
        pageUrl: `https://en.wikipedia.org/wiki/${label}_Event`,
        extract: `The ${label} Event occurred in ${year}.`,
      },
      {
        pageTitle: `${label} independent account`,
        pageUrl: `https://archive.example.org/${label.toLowerCase()}-event`,
        verifiedIndependent: true,
        extract: `An archive confirms the ${label} Event occurred in ${year}.`,
      },
    ],
  });
  const thin = thinCandidate("Thin", 1900);
  // Slightly less thin than `thin` — closer to (but still below) the bar —
  // so the fallback ranking must prefer this one over `thin`.
  const lessThin = {
    ...thinCandidate("LessThin", 1905),
    text: Array.from(
      { length: 20 },
      (_, index) =>
        `LessThin record ${index + 1} names a participant of the 1905 event.`,
    ).join(" "),
  };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const title = url.searchParams.get("titles") || "Thin Event";
    return new Response(
      JSON.stringify({
        query: { pages: { 1: { title, extract: `${title} occurred.` } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const selected = await hooks.selectSourceReadyCandidate(
    [thin, lessThin],
    fetchImpl,
    { requireArticleCapacity: true },
  );

  assert.ok(selected, "expected a fallback candidate instead of null");
  assert.equal(selected.pageTitle, "LessThin Event");
  assert.equal(selected.articleEvidenceCapacityFallback, true);
  assert.equal(selected.articleEvidenceCapacity.ok, false);
});

test("preparedDraftSourceEvent trusts a selector-approved evidence-thin fallback but still rejects an unflagged thin payload", () => {
  // Derive slug/date fields from the same `date` object with the same
  // accessors the production code uses (buildSlug reads local getDate/
  // getMonth/getFullYear; validateContentDateForPublish reads UTC
  // getUTCMonth/getUTCDate) so the test is correct in any runner timezone.
  const date = new Date();
  const monthSlugs = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const slug = `${date.getDate()}-${monthSlugs[date.getMonth()]}-${date.getFullYear()}`;
  const isoMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  const isoDay = String(date.getUTCDate()).padStart(2, "0");

  const thinSelectedEvent = {
    eventTitle: "Thin Event Occurs",
    sourcePageTitle: "Thin Event",
    sourceText: "The Thin Event occurred in 1900.",
    sourceExtract: "The Thin Event occurred in 1900.",
    wikiUrl: "https://en.wikipedia.org/wiki/Thin_Event",
    historicalDateISO: `1900-${isoMonth}-${isoDay}`,
    historicalDate: "A historical date, 1900",
    historicalYear: 1900,
    sourcePages: [
      {
        pageTitle: "Thin Event",
        pageUrl: "https://en.wikipedia.org/wiki/Thin_Event",
        extract: "The Thin Event occurred in 1900.",
      },
      {
        pageTitle: "Thin independent account",
        pageUrl: "https://archive.example.org/thin-event",
        verifiedIndependent: true,
        extract: "An archive confirms the Thin Event occurred in 1900.",
      },
    ],
  };

  const unflagged = hooks.preparedDraftSourceEvent(
    { version: 1, slug, selectedEvent: thinSelectedEvent },
    date,
  );
  assert.equal(unflagged, null);

  const flagged = hooks.preparedDraftSourceEvent(
    {
      version: 1,
      slug,
      selectedEvent: {
        ...thinSelectedEvent,
        articleEvidenceCapacityFallback: true,
      },
    },
    date,
  );
  assert.ok(flagged, "expected the selector-approved fallback to be trusted");
  assert.equal(flagged.articleEvidenceCapacityFallback, true);
  assert.equal(flagged.articleEvidenceCapacity.ok, false);
});

test("Wikipedia expansion preserves the selected canonical event page", async () => {
  const source = {
    eventTitle: "Boris Johnson Becomes Prime Minister",
    sourcePageTitle: "2019 Conservative Party leadership election",
    sourceText:
      "Boris Johnson is elected leader of the Conservative Party and becomes Prime Minister in 2019.",
    sourceExtract: "The leadership election took place in 2019.",
    wikiUrl:
      "https://en.wikipedia.org/wiki/2019_Conservative_Party_leadership_election",
    sourcePages: [
      {
        pageTitle: "2019 Conservative Party leadership election",
        pageUrl:
          "https://en.wikipedia.org/wiki/2019_Conservative_Party_leadership_election",
        extract: "The leadership election took place in 2019.",
      },
      {
        pageTitle: "Boris Johnson",
        pageUrl: "https://en.wikipedia.org/wiki/Boris_Johnson",
        extract: "Boris Johnson is a British politician.",
      },
      {
        pageTitle: "Independent report",
        pageUrl: "https://archive.example.org/leadership-election",
        verifiedIndependent: true,
        extract:
          "An independent report confirms the Conservative Party result in 2019.",
      },
    ],
  };
  const fetchImpl = async (input) => {
    const title = new URL(String(input)).searchParams.get("titles");
    const extract =
      title === "Boris Johnson"
        ? "Boris Johnson was elected leader of the Conservative Party in 2019 and became Prime Minister. His leadership followed the election result."
        : "The Conservative Party held its 2019 leadership election under its recorded party procedure.";
    return new Response(
      JSON.stringify({ query: { pages: { 1: { title, extract } } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const expanded = await hooks.expandSelectedEventSourcePages(source, fetchImpl);

  assert.equal(
    expanded.sourcePageTitle,
    "2019 Conservative Party leadership election",
  );
  assert.equal(
    expanded.wikiUrl,
    "https://en.wikipedia.org/wiki/2019_Conservative_Party_leadership_election",
  );
  assert.equal(expanded.articleSourcePagesExpanded, true);
});

test("capacity expansion is not fetched again by the normal preparation call", async () => {
  const sentence = (prefix, count) =>
    Array.from(
      { length: count },
      (_, index) =>
        `${prefix} ${index + 1} records a distinct stage of the 1910 event with named participants, institution, location, procedure, chronology, and result.`,
    ).join(" ");
  const candidate = {
    year: 1910,
    pageTitle: "Canonical Event",
    pageUrl: "https://en.wikipedia.org/wiki/Canonical_Event",
    text: "Officials record the Canonical Event decision in 1910.",
    extract: "A short feed extract.",
    sourcePages: [
      {
        pageTitle: "Canonical Event",
        pageUrl: "https://en.wikipedia.org/wiki/Canonical_Event",
        extract: "A short feed extract.",
      },
      {
        pageTitle: "Context Page",
        pageUrl: "https://en.wikipedia.org/wiki/Context_Page",
        extract: "Short context.",
      },
      {
        pageTitle: "Independent report",
        pageUrl: "https://archive.example.org/canonical-event",
        extract: sentence("Independent report", 22),
        verifiedIndependent: true,
      },
    ],
  };
  let fetchCount = 0;
  const fetchImpl = async (input) => {
    fetchCount++;
    const title = new URL(String(input)).searchParams.get("titles");
    return new Response(
      JSON.stringify({
        query: {
          pages: {
            1: {
              title,
              extract: sentence(title, 25),
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const selected = await hooks.selectSourceReadyCandidate(
    [candidate],
    fetchImpl,
    { requireArticleCapacity: true },
  );
  assert.equal(selected.articleSourcePagesExpanded, true);
  assert.equal(fetchCount, 2);

  await hooks.expandSelectedEventSourcePages(selected, fetchImpl);

  assert.equal(fetchCount, 2);
});

test("continuity audit identifies only the later field that repeats an opening", () => {
  const paragraph = (opening) =>
    `${opening} King John and the barons met at Runnymede in 1215. The charter record, royal authority, baronial leverage, London politics, and the documented settlement remain concrete details throughout this section.`;
  const repeated = paragraph("The archival record confirms details.");
  const audit = hooks.auditChunkedArticleContinuity({
    title: "King John Accepts Charter Limits — July 3, 1215",
    eventTitle: "King John Accepts Charter Limits",
    historicalDate: "July 3, 1215",
    historicalYear: 1215,
    location: "Runnymede, England",
    country: "England",
    organizerName: "King John",
    keyTerms: [{ term: "Magna Carta" }],
    sourceFacts: ["King John met the barons at Runnymede in 1215."],
    overviewParagraphs: [
      paragraph("Opening context establishes the dispute."),
      paragraph("Overview evidence names the settlement."),
    ],
    eyewitnessOrChronicle: [
      repeated,
      paragraph("Chronicle detail follows the negotiations."),
    ],
    aftermathParagraphs: [
      paragraph("Later proceedings document the response."),
      paragraph("Aftermath evidence records the limits."),
    ],
    conclusionParagraphs: [
      repeated,
      paragraph("Final detail returns to the charter record."),
    ],
  });

  assert.equal(audit.ok, false);
  assert.ok(
    audit.issues.some((issue) =>
      /conclusionParagraphs repeats the opening pattern/.test(issue),
    ),
  );
  assert.deepEqual(audit.repairFields, ["conclusionParagraphs"]);
});

test("continuity repair rewrites only the rejected field and remains fail closed", async () => {
  const longParagraph = (opening, detail) =>
    `${opening} ${Array.from(
      { length: 8 },
      (_, index) =>
        `King John and the barons met at Runnymede in 1215 while the charter record documented royal authority, baronial leverage, London politics, negotiated procedure, written clauses, and ${detail} ${index + 1}.`,
    ).join(" ")}`;
  const repeatedOpening = longParagraph(
    "The archival record confirms details.",
    "settlement evidence",
  );
  const content = {
    title: "King John Accepts Charter Limits — July 3, 1215",
    eventTitle: "King John Accepts Charter Limits",
    historicalDate: "July 3, 1215",
    historicalYear: 1215,
    location: "Runnymede, England",
    country: "England",
    organizerName: "King John",
    keyTerms: [{ term: "Magna Carta" }],
    sourceFacts: ["King John met the barons at Runnymede in 1215."],
    overviewParagraphs: [
      longParagraph("Opening context establishes the dispute.", "royal seal"),
      longParagraph("Overview evidence names the settlement.", "written clause"),
    ],
    eyewitnessOrChronicle: [
      repeatedOpening,
      longParagraph("Chronicle detail follows the negotiations.", "witness record"),
    ],
    aftermathParagraphs: [
      longParagraph("Later proceedings document the response.", "later proceeding"),
      longParagraph("Aftermath evidence records the limits.", "recorded limit"),
    ],
    conclusionParagraphs: [
      repeatedOpening,
      longParagraph("Final detail returns to the charter record.", "closing record"),
    ],
  };
  const continuity = hooks.auditChunkedArticleContinuity(content);
  assert.deepEqual(continuity.repairFields, ["conclusionParagraphs"]);

  let prompt = "";
  const repaired = await hooks.repairChunkedArticleContinuity(
    {},
    "test-model",
    content,
    "Authoritative source material.",
    {
      eventTitle: content.eventTitle,
      historicalDate: content.historicalDate,
      sourceFacts: content.sourceFacts,
    },
    continuity,
    async (_env, _model, _label, userPrompt, _maxTokens, validate) => {
      prompt = userPrompt;
      const result = {
        conclusionParagraphs: [
          longParagraph(
            "Closing evidence revisits the negotiated charter.",
            "royal seal written clause",
          ),
          longParagraph(
            "Final assessment connects the documented proceedings.",
            "witness record recorded limit",
          ),
        ],
      };
      validate(result);
      return result;
    },
  );

  assert.deepEqual(Object.keys(repaired), ["conclusionParagraphs"]);
  assert.match(prompt, /Return exactly these top-level fields: conclusionParagraphs/);
  assert.doesNotMatch(prompt, /Return exactly these top-level fields: overviewParagraphs/);
  const merged = { ...content, ...repaired };
  assert.equal(merged.overviewParagraphs, content.overviewParagraphs);
  assert.equal(hooks.auditChunkedArticleContinuity(merged).ok, true);

  await assert.rejects(
    hooks.repairChunkedArticleContinuity(
      {},
      "test-model",
      content,
      "Authoritative source material.",
      {
        eventTitle: content.eventTitle,
        historicalDate: content.historicalDate,
        sourceFacts: content.sourceFacts,
      },
      continuity,
      async (_env, _model, _label, _prompt, _maxTokens, validate) => {
        const invalid = {
          conclusionParagraphs: [
            "Too short.",
            "Still too short.",
          ],
        };
        validate(invalid);
        return invalid;
      },
    ),
    /thin paragraph/,
  );
});
