import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as blogHooks,
} from "../js/blog-ai-worker.js";
import {
  __personIdentityTestHooks as seoHooks,
} from "../js/seo-worker.js";

const biographyIntro =
  "Ada Lovelace was an English mathematician and writer best known for her work on Charles Babbage's proposed Analytical Engine. She translated an article about the machine and added extensive notes describing how it might manipulate symbols according to rules. Her published algorithm and wider account of general-purpose computation made her an important figure in computing history.";

function longBody(heading = "Life") {
  return [{
    heading,
    paragraphs: [`${Array(170).fill("documented").join(" ")}.`],
  }];
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
