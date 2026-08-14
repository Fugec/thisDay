import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as blogHooks,
} from "../js/blog-ai-worker.js";
import {
  __personIdentityTestHooks as seoHooks,
} from "../js/seo-worker.js";
import { extractCalendarDateMentions } from "../js/shared/person-prose.js";

const biographyIntro =
  "Ada Lovelace was an English mathematician and writer best known for her work on Charles Babbage's proposed Analytical Engine. She translated an article about the machine and added extensive notes describing how it might manipulate symbols according to rules. Her published algorithm and wider account of general-purpose computation made her an important figure in computing history.";

function longBody(heading = "Life") {
  return [{
    heading,
    paragraphs: [`${Array(170).fill("documented").join(" ")}.`],
  }];
}

function reviewedPersonBody() {
  return [
    {
      heading: "Early work",
      paragraphs: [
        "Born into a family interested in mathematics, the subject received a demanding private education that combined calculation, languages, and music. Tutors recorded a sustained interest in machines and notation, while correspondence shows how those studies developed into a disciplined approach to difficult technical questions.",
        "During her early adulthood, meetings with engineers introduced plans for mechanical calculating devices. Detailed notes from those exchanges connected abstract mathematical operations with practical machinery, giving later readers a concrete record of how she evaluated both the promise and the limitations of the designs.",
      ],
    },
    {
      heading: "Published contribution",
      paragraphs: [
        "Her best-known publication translated a technical account and added extensive explanatory notes. Those additions described a sequence for calculating Bernoulli numbers and examined how a programmable machine might manipulate symbols under stated rules, extending the discussion beyond ordinary numerical calculation.",
        "Later historians returned to the notes because they documented an unusually broad view of general-purpose computation. The surviving text supports that specific contribution without requiring claims about modern devices that the nineteenth-century source could not have anticipated or directly described.",
      ],
    },
  ];
}

test("blog person profiles require Wikidata human identity", () => {
  const validPerson = {
    type: "person",
    name: "Ada Lovelace",
    wikiUrl: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    resolvedPageTitle: "Ada Lovelace",
    wikidataEntityId: "Q7259",
    wikidataInstanceOfHuman: true,
    profileLinkEligible: true,
    profileSubjectVerified: true,
    intro: biographyIntro,
    bodySections: longBody(),
  };
  assert.equal(blogHooks.hasRichWikipediaPersonProfile(validPerson), true);
  assert.equal(blogHooks.blogEntityQualityEligible(validPerson), true);

  for (const entity of [
    {
      ...validPerson,
      name: "Crimean Tatars",
      wikiUrl: "https://en.wikipedia.org/wiki/Crimean_Tatars",
      resolvedPageTitle: "Crimean Tatars",
      wikidataEntityId: "Q117458",
      wikidataInstanceOfHuman: false,
    },
    {
      ...validPerson,
      name: "Enigma machine",
      wikiUrl: "https://en.wikipedia.org/wiki/Enigma_machine",
      resolvedPageTitle: "Enigma machine",
      wikidataEntityId: "Q150758",
      wikidataInstanceOfHuman: false,
    },
    {
      ...validPerson,
      name: "Dave Ulmer",
      wikiUrl: "https://en.wikipedia.org/wiki/Dave_Ulmer",
      resolvedPageTitle: "Geocaching",
      wikidataEntityId: "Q14930",
      wikidataInstanceOfHuman: false,
    },
  ]) {
    assert.equal(blogHooks.hasRichWikipediaPersonProfile(entity), false);
    assert.equal(blogHooks.blogEntityQualityEligible(entity), false);
  }
});

test("source-event fallbacks remain eligible without claiming a human Wikidata item", () => {
  const fallback = {
    type: "person",
    name: "Bill Stewart",
    wikiUrl: "https://en.wikipedia.org/wiki/Murder_of_Bill_Stewart",
    resolvedPageTitle: "Murder of Bill Stewart",
    wikidataEntityId: "Q6934238",
    wikidataInstanceOfHuman: false,
    sourceEventPageFallback: true,
    profileLinkEligible: true,
    profileSubjectVerified: true,
    intro:
      "Bill Stewart was an American journalist working for ABC News who was killed by a Nicaraguan National Guard soldier in June 1979. Footage of the killing was broadcast internationally and intensified criticism of the Somoza government during the final phase of the Nicaraguan Revolution. Stewart had been reporting from Nicaragua when a television crew recorded the confrontation and its immediate aftermath.",
    bodySections: longBody("Reporting and death"),
  };

  assert.equal(blogHooks.hasRichWikipediaPersonProfile(fallback), true);
  assert.equal(blogHooks.hasVerifiedPersonProfileIdentity(fallback), true);
  assert.equal(blogHooks.blogEntityQualityEligible(fallback), true);
});

test("legacy linked article people are revalidated until identity evidence is stored", () => {
  const html =
    '<div class="entity-strip" data-entity-strip="1">' +
    '<div class="entity-person-chips">' +
    '<a href="/people/crimean-tatars/" class="person-pill">Crimean Tatars</a>' +
    "</div></div>";
  const legacyLinkedMeta = JSON.stringify([{
    type: "person",
    slug: "crimean-tatars",
    name: "Crimean Tatars",
    url: "/people/crimean-tatars/",
    profileLinkEligible: true,
    profileSubjectVerified: true,
  }]);
  const verifiedHumanMeta = JSON.stringify([{
    type: "person",
    slug: "ada-lovelace",
    name: "Ada Lovelace",
    url: "/people/ada-lovelace/",
    profileLinkEligible: true,
    profileSubjectVerified: true,
    wikidataEntityId: "Q7259",
    wikidataInstanceOfHuman: true,
  }]);
  const rejectedNonHumanMeta = JSON.stringify([{
    type: "person",
    slug: "crimean-tatars",
    name: "Crimean Tatars",
    profileLinkEligible: false,
    profileSubjectVerified: false,
    wikidataEntityId: "Q117458",
    wikidataInstanceOfHuman: false,
  }]);

  assert.equal(
    blogHooks.articleEntityStripNeedsProfileValidation(html, legacyLinkedMeta),
    true,
  );
  assert.equal(
    blogHooks.articleEntityStripNeedsProfileValidation(html, verifiedHumanMeta),
    false,
  );
  assert.equal(
    blogHooks.articleEntityStripNeedsProfileValidation(html, rejectedNonHumanMeta),
    false,
  );
});

test("article entity cache preserves terminal Wikidata identity evidence", () => {
  const compact = blogHooks.compactArticleEntityMeta([{
    type: "person",
    slug: "crimean-tatars",
    name: "Crimean Tatars",
    imageUrl: "",
    url: "",
    wikiUrl: "",
    profileLinkEligible: false,
    profileSubjectVerified: false,
    wikidataEntityId: "Q117458",
    wikidataInstanceOfHuman: false,
    skipImageRepair: true,
  }]);
  assert.equal(compact[0].wikidataEntityId, "Q117458");
  assert.equal(compact[0].wikidataInstanceOfHuman, false);

  const unlinked = blogHooks.unlinkedArticlePerson({
    type: "person",
    name: "Crimean Tatars",
    wikidataEntityId: "Q117458",
    wikidataInstanceOfHuman: false,
  });
  assert.equal(unlinked.url, "");
  assert.equal(unlinked.wikiUrl, "");
  assert.equal(unlinked.profileLinkEligible, false);
  assert.equal(unlinked.profileSubjectVerified, false);
  assert.equal(unlinked.wikidataEntityId, "Q117458");
  assert.equal(unlinked.wikidataInstanceOfHuman, false);
});

test("article hydration removes a stale person link after stored Q5 rejection", async () => {
  const writes = [];
  const env = {
    BLOG_AI_KV: {
      get: async () => ({
        type: "person",
        slug: "crimean-tatars",
        name: "Crimean Tatars",
        wikiUrl: "https://en.wikipedia.org/wiki/Crimean_Tatars",
        wikidataEntityId: "Q117458",
        wikidataInstanceOfHuman: false,
        profileLinkEligible: false,
        profileSubjectVerified: false,
      }),
      put: async (...args) => writes.push(args),
    },
  };
  const hydrated = await blogHooks.hydrateArticleEntityImages(env, [{
    type: "person",
    slug: "crimean-tatars",
    name: "Crimean Tatars",
    imageUrl: "https://upload.wikimedia.org/crimean-tatars.png",
    url: "/people/crimean-tatars/",
    wikiUrl: "https://en.wikipedia.org/wiki/Crimean_Tatars",
    profileLinkEligible: true,
    profileSubjectVerified: true,
  }]);

  assert.equal(hydrated[0].url, "");
  assert.equal(hydrated[0].wikiUrl, "");
  assert.equal(hydrated[0].imageUrl, "");
  assert.equal(hydrated[0].profileLinkEligible, false);
  assert.equal(hydrated[0].profileSubjectVerified, false);
  assert.equal(hydrated[0].wikidataEntityId, "Q117458");
  assert.equal(hydrated[0].wikidataInstanceOfHuman, false);
  assert.equal(writes.length, 0);
});

test("SEO person creation and quality gates require Wikidata Q5", () => {
  const validPerson = {
    type: "person",
    name: "Ada Lovelace",
    wikiUrl: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    description: "English mathematician and writer",
    summary: biographyIntro,
    intro: biographyIntro,
    summaryTitle: "Ada Lovelace",
    birthDate: "December 10, 1815",
    summaryType: "standard",
    wikidataEntityId: "Q7259",
    wikidataInstanceOfHuman: true,
    profileLinkEligible: true,
    profileSubjectVerified: true,
    bodySections: longBody(),
  };
  assert.equal(seoHooks.isLikelyWikipediaPersonEntity(validPerson), true);
  assert.equal(seoHooks.seoEntityQualityEligible(validPerson), true);

  const nonHuman = {
    ...validPerson,
    name: "Crimean Tatars",
    wikiUrl: "https://en.wikipedia.org/wiki/Crimean_Tatars",
    wikidataEntityId: "Q117458",
    wikidataInstanceOfHuman: false,
  };
  assert.equal(seoHooks.isLikelyWikipediaPersonEntity(nonHuman), false);
  assert.equal(seoHooks.seoEntityQualityEligible(nonHuman), false);
  assert.equal(
    seoHooks.isLikelyWikipediaPersonEntity({
      ...validPerson,
      summaryTitle: "Grace Hopper",
    }),
    false,
  );
});

test("generated people prose follows the shared writing audit", () => {
  const clean = {
    type: "person",
    name: "Ada Lovelace",
    bodySections: reviewedPersonBody(),
    overviewCards: [],
  };
  assert.deepEqual(blogHooks.generatedPageWritingQualityIssues(clean), []);
  assert.equal(blogHooks.personEntityWritingQualityReady(clean), true);

  const repetitive = {
    ...clean,
    overviewCards: [
      {
        label: "Known for",
        value: "Ada Lovelace wrote detailed notes about Charles Babbage's proposed Analytical Engine and described a method for calculating Bernoulli numbers.",
      },
      {
        label: "Main role",
        value: "Ada Lovelace worked as a mathematical writer whose published commentary examined how the proposed machine could manipulate symbols according to rules.",
      },
    ],
    bodySections: [{
      heading: "Drafting",
      paragraphs: [
        "According to the source material, her work formed a rich tapestry of ideas that was significant in many ways and remains important to remember.",
      ],
    }],
    timeline: [{
      date: "1843",
      label: "This pivotal moment was a testament to an enduring legacy.",
    }],
  };
  const issues = blogHooks.generatedPageWritingQualityIssues(repetitive);
  assert.ok(issues.some((issue) => /repeats the subject-led opening/.test(issue)));
  assert.ok(issues.some((issue) => /source-process|banned phrase|generic/i.test(issue)));
  assert.ok(issues.some((issue) => issue.startsWith("timeline[0].label")));
});

test("people rendering preserves reviewed prose and rebuilds unreviewed prose", () => {
  const reviewed = reviewedPersonBody();
  const entity = {
    type: "person",
    name: "Ada Lovelace",
    intro: biographyIntro,
    summary: biographyIntro,
    bodySections: reviewed,
    personProseQualityVersion: 2,
  };
  assert.deepEqual(seoHooks.personBodySectionsForRender(entity), reviewed);

  const unreviewed = seoHooks.personBodySectionsForRender({
    ...entity,
    personProseQualityVersion: undefined,
  });
  assert.notDeepEqual(unreviewed, reviewed);
  assert.match(unreviewed[0].heading, /^Who is Ada Lovelace\?$/);

  const deceased = seoHooks.personBodySectionsForRender({
    ...entity,
    deathDate: "November 27, 1852",
    personProseQualityVersion: undefined,
  });
  assert.match(deceased[0].heading, /^Who was Ada Lovelace\?$/);

  assert.equal(
    blogHooks.buildFallbackEntityBodySections(entity, {})[0].heading,
    "Who is Ada Lovelace?",
  );
  assert.equal(
    blogHooks.buildFallbackEntityBodySections(
      { ...entity, deathDate: "November 27, 1852" },
      {},
    )[0].heading,
    "Who was Ada Lovelace?",
  );
});

test("born, died, and article profiles share one bounded prose queue", () => {
  const selected = blogHooks.selectPendingPersonProseCandidates([
    {
      type: "person",
      slug: "article-person",
      wikiUrl: "https://en.wikipedia.org/wiki/Article_Person",
      needsProseEnrichment: true,
      updatedAt: "2026-08-12T02:00:00Z",
    },
    {
      type: "person",
      slug: "born-person",
      wikiUrl: "https://en.wikipedia.org/wiki/Born_Person",
      needsProseEnrichment: true,
      updatedAt: "2026-08-12T01:00:00Z",
    },
    {
      type: "person",
      slug: "already-reviewed",
      wikiUrl: "https://en.wikipedia.org/wiki/Reviewed_Person",
      needsProseEnrichment: true,
      personProseQualityVersion: 2,
    },
  ], { limit: 5 });

  assert.deepEqual(selected.map((entry) => entry.slug), ["born-person"]);
});

test("the SEO entity index retains pending and reviewed prose state", async () => {
  let storedIndex = [];
  const env = {
    BLOG_AI_KV: {
      get: async () => JSON.stringify(storedIndex),
      put: async (_key, value) => {
        storedIndex = JSON.parse(value);
      },
    },
  };
  const base = {
    type: "person",
    slug: "ada-lovelace",
    name: "Ada Lovelace",
    wikiUrl: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    summary: biographyIntro,
    intro: biographyIntro,
    bodySections: reviewedPersonBody(),
  };

  await seoHooks.updateEntityIndexEntry(env, {
    ...base,
    needsProseEnrichment: true,
  });
  assert.equal(storedIndex[0].needsProseEnrichment, true);
  assert.equal(storedIndex[0].personProseQualityVersion, undefined);

  await seoHooks.updateEntityIndexEntry(env, {
    ...base,
    personProseQualityVersion: 2,
  });
  assert.equal(storedIndex[0].personProseQualityVersion, 2);
  assert.equal(storedIndex[0].needsProseEnrichment, undefined);
});

test("person writing audit detects equivalent date formats across cards and body", () => {
  const entity = {
    type: "person",
    name: "Magic Johnson",
    overviewCards: [{
      label: "Background",
      value: "Magic Johnson was born in Lansing on August 14, 1959, before becoming a professional basketball player.",
    }],
    bodySections: [{
      heading: "Early life",
      paragraphs: [
        "On 14 August 1959, Magic Johnson was born in Lansing, Michigan, where his early experience with basketball preceded his later professional career.",
      ],
    }],
  };
  assert.ok(
    blogHooks.generatedPageWritingQualityIssues(entity).some((issue) =>
      /repeats the biographical date/i.test(issue),
    ),
  );
});

test("person rendering removes repeated dates and card/body duplication", () => {
  const repeatedFact =
    "Johnson won five NBA championships with the Los Angeles Lakers during the Showtime era.";
  const entity = {
    type: "person",
    name: "Magic Johnson",
    description: "American basketball player and entrepreneur (born 1959)",
    birthDate: "August 14, 1959",
    intro:
      `Earvin Magic Johnson Jr. (born August 14, 1959) is an American businessman and former professional basketball player. ${repeatedFact}`,
    summary:
      `On 14 August 1959, Johnson was born in Lansing, Michigan. ${repeatedFact}`,
    overviewCards: [{ label: "Achievement", value: repeatedFact }],
    bodySections: [{
      heading: "Who is Magic Johnson?",
      paragraphs: [
        `Earvin Magic Johnson Jr. (born August 14, 1959) is an American businessman and former professional basketball player. ${repeatedFact}`,
        "On 14 August 1959, Johnson was born in Lansing, Michigan, before his basketball career developed through school and college competition.",
      ],
    }],
  };
  const rendered = seoHooks.personEntityForRender(entity);
  assert.equal(rendered.description, "American basketball player and entrepreneur");
  assert.equal(rendered.birthDate, "August 14, 1959");
  const bodyText = rendered.bodySections
    .flatMap((section) => section.paragraphs)
    .join(" ");
  assert.equal(extractCalendarDateMentions(bodyText).length, 1);
  const slider = seoHooks.buildEntityOverviewSlider(rendered);
  assert.doesNotMatch(slider, /Born \/ Died|August 14, 1959|14 August 1959/);
  assert.doesNotMatch(slider, /Johnson won five NBA championships/);
});

test("person rendering suppresses a stored date that conflicts with source biography", () => {
  const rendered = seoHooks.personEntityForRender({
    type: "person",
    name: "A. K. Chesterton",
    description: "British journalist and fascist (1899–1973)",
    birthDate: "November 30, 1895",
    deathDate: "August 16, 1973",
    intro:
      "Arthur Kenneth Chesterton (1 May 1899 – 16 August 1973) was a British journalist and political activist.",
    bodySections: [],
  });
  assert.equal(rendered.birthDate, "");
  assert.equal(rendered.deathDate, "August 16, 1973");
  assert.equal(rendered.description, "British journalist and fascist");
  assert.equal(rendered._personDateConflictSuppressed, true);
});

test("protected legacy person URLs cannot be changed by SEO hydration", async () => {
  const index = [
    {
      type: "person",
      slug: "african-american",
      name: "African American",
      url: "/people/african-american/",
      indexable: true,
    },
    {
      type: "person",
      slug: "warren-anderson",
      name: "Warren Anderson",
      url: "/people/warren-anderson/",
      indexable: true,
    },
  ];
  const writes = [];
  const env = {
    BLOG_AI_KV: {
      get: async (key) => {
        if (key === "entity-index-v1") return JSON.stringify(index);
        return JSON.stringify({
          type: "person",
          slug: key.endsWith("warren-anderson")
            ? "warren-anderson"
            : "african-american",
          name: "Protected legacy person",
          wikiUrl: "https://en.wikipedia.org/wiki/Protected",
          wikidataInstanceOfHuman: false,
          profileLinkEligible: false,
          profileSubjectVerified: false,
          bodySections: [],
        });
      },
      put: async (...args) => writes.push(args),
    },
  };

  await seoHooks.updateEntityIndexEntry(env, {
    type: "person",
    slug: "warren-anderson",
    name: "Warren Anderson",
    bodySections: [],
    wikidataInstanceOfHuman: false,
  });
  const refreshed = await seoHooks.refreshEntityIndexFromStoredEntities(
    env,
    index,
    "person",
  );

  assert.deepEqual(refreshed, index);
  assert.deepEqual(writes, []);
});
