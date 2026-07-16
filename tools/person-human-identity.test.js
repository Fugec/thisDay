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
