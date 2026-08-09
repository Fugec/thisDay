import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  historicalStoryYear,
  matchHistoricalEventsToBlogStories,
  safeBlogStoryUrl,
  scoreHistoricalEventStoryMatch,
} from "../js/shared/event-story-matching.js";
import { __datePageEngagementTestHooks as datePageHooks } from "../js/seo-worker.js";

function wikiPage(title) {
  return {
    title,
    normalizedtitle: title,
    content_urls: {
      desktop: {
        page: `https://en.wikipedia.org/wiki/${title.replace(/\s+/g, "_")}`,
      },
    },
  };
}

const greatBritainEvent = {
  year: 1843,
  text:
    "Brunel's steamship SS Great Britain is launched with an iron hull and screw propeller.",
  pages: [wikiPage("SS Great Britain")],
};

const greatBritainStory = {
  slug: "19-july-2027",
  title: "Why Was SS Great Britain a Turning Point?",
  factualTitle: "SS Great Britain Is Launched — July 19, 1843",
  eventTitle: "SS Great Britain Is Launched",
  historicalYear: 1843,
  wikiUrl: "https://en.wikipedia.org/wiki/SS_Great_Britain",
  sourcePageTitle: "SS Great Britain",
};

const websterTreatyEvent = {
  year: 1842,
  text:
    "The Webster–Ashburton Treaty is signed, establishing the United States–Canada border east of the Rocky Mountains.",
  pages: [
    {
      ...wikiPage("Webster–Ashburton Treaty"),
      description: "1842 border treaty between British Canada and the US",
      extract:
        "The Webster–Ashburton Treaty resolved several border issues between the United States and British North America.",
      thumbnail: {
        source:
          "https://upload.wikimedia.org/wikipedia/commons/webster-treaty.jpg",
      },
    },
  ],
};

const websterTreatyStory = {
  slug: "9-august-2026",
  title: "How Did the Webster–Ashburton Treaty Unfold?",
  factualTitle: "The Webster–Ashburton Treaty Is Signed — August 9, 1842",
  eventTitle: "The Webster–Ashburton Treaty Is Signed",
  historicalYear: 1842,
  wikiUrl:
    "https://en.wikipedia.org/wiki/Webster%E2%80%93Ashburton_Treaty",
  sourcePageTitle: "Webster–Ashburton Treaty",
};

const dominantFeaturedEvent = {
  year: 1964,
  text:
    "A landmark civil rights law abolishes legal discrimination and establishes equal rights nationwide.",
  pages: [
    {
      ...wikiPage("Civil Rights Act of 1964"),
      description: "Landmark United States civil rights legislation",
      extract:
        "The Civil Rights Act of 1964 was landmark legislation that prohibited discrimination and strengthened equal protection under federal law. Its provisions addressed public accommodations, employment, education, and voting rights enforcement across the United States.",
      thumbnail: {
        source: "https://upload.wikimedia.org/wikipedia/commons/civil-rights.jpg",
      },
      originalimage: {
        source:
          "https://upload.wikimedia.org/wikipedia/commons/civil-rights-full.jpg",
      },
    },
  ],
};

describe("event-to-story matching", () => {
  it("matches a story only when historical year and source identity align", () => {
    const result = scoreHistoricalEventStoryMatch(
      greatBritainEvent,
      greatBritainStory,
    );
    assert.equal(result.matched, true);
    assert.equal(result.method, "source-identity-and-year");
  });

  it("rejects an exact source identity carrying a different historical year", () => {
    const result = scoreHistoricalEventStoryMatch(greatBritainEvent, {
      ...greatBritainStory,
      historicalYear: 1845,
    });
    assert.equal(result.matched, false);
    assert.equal(result.method, "year-mismatch");
  });

  it("rejects a same-year article that only shares a broad category", () => {
    const result = scoreHistoricalEventStoryMatch(greatBritainEvent, {
      slug: "19-july-2028",
      title: "A Battle During a European War",
      eventTitle: "Army Wins a Battle",
      historicalYear: 1843,
      sourcePageTitle: "European history",
      keywords: "war, battle, military history",
    });
    assert.equal(result.matched, false);
    assert.equal(result.method, "insufficient-identity");
  });

  it("supports grounded legacy entries whose year exists only in the title", () => {
    const legacy = {
      slug: "19-july-2026",
      title: "SS Great Britain Launch — July 19, 1843",
      eventTitle: "SS Great Britain Launch",
    };
    assert.equal(historicalStoryYear(legacy), 1843);
    assert.equal(
      scoreHistoricalEventStoryMatch(greatBritainEvent, legacy).matched,
      true,
    );
  });

  it("links the July 17 Spanish Civil War event to its daily story", () => {
    const event = {
      year: 1936,
      text:
        "Spanish Civil War: An armed forces rebellion against the elected Popular Front government begins.",
      pages: [wikiPage("Spanish Civil War")],
    };
    const story = {
      slug: "17-july-2026",
      factualTitle: "Spanish Civil War Begins — July 17, 1936",
      eventTitle: "Spanish Civil War Begins",
      historicalYear: 1936,
      wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      sourcePageTitle: "Spanish Civil War",
    };
    const matches = matchHistoricalEventsToBlogStories([event], [story]);

    assert.equal(matches.get(event)?.slug, "17-july-2026");
    assert.equal(safeBlogStoryUrl(matches.get(event)), "/blog/17-july-2026/");

    const html = datePageHooks.generateEventsDateHTML(
      "july",
      17,
      { events: [event], births: [], deaths: [] },
      "https://thisday.info",
      [],
      "",
      null,
      null,
      null,
      [story],
    );
    assert.match(
      html,
      /href="\/blog\/17-july-2026\/" class="site-btn site-btn-primary tl-btn"/,
    );
    assert.match(html, />Read our story<\/a>/);
  });

  it("assigns one story to at most one event", () => {
    const similarEvent = {
      ...greatBritainEvent,
      text: "SS Great Britain begins its historic service.",
    };
    const matches = matchHistoricalEventsToBlogStories(
      [greatBritainEvent, similarEvent],
      [greatBritainStory],
    );
    assert.equal(matches.size, 1);
    assert.equal(matches.get(greatBritainEvent)?.slug, "19-july-2027");
  });

  it("links a matching non-featured chronology card to the internal article first", () => {
    const html = datePageHooks.generateEventsDateHTML(
      "august",
      9,
      {
        events: [websterTreatyEvent, dominantFeaturedEvent],
        births: [],
        deaths: [],
      },
      "https://thisday.info",
      [],
      "",
      null,
      websterTreatyStory,
      null,
      [websterTreatyStory],
    );
    const treatyAnchor = datePageHooks.historicalEventAnchorId(
      websterTreatyEvent,
    );
    const treatyStart = html.indexOf(`id="${treatyAnchor}"`);
    const nextEvent = html.indexOf('<div id="event-', treatyStart + 1);
    const treatyCard = html.slice(
      treatyStart,
      nextEvent >= 0 ? nextEvent : treatyStart + 12_000,
    );

    assert.ok(treatyStart >= 0);
    assert.match(
      treatyCard,
      /href="\/blog\/9-august-2026\/" class="site-btn site-btn-primary tl-btn">Read our story<\/a>/,
    );
    assert.match(
      treatyCard,
      /href="https:\/\/en\.wikipedia\.org\/wiki\/Webster/,
    );
    assert.match(
      treatyCard,
      /<a href="\/blog\/9-august-2026\/" tabindex="-1"><img/,
    );
  });

  it("adds verified story links to matching cards in cached event-page HTML", () => {
    const cached = datePageHooks.generateEventsDateHTML(
      "august",
      9,
      {
        events: [websterTreatyEvent, dominantFeaturedEvent],
        births: [],
        deaths: [],
      },
      "https://thisday.info",
    );
    const upgraded = datePageHooks.ensureCachedEventStoryLinksHtml(cached, {
      events: [websterTreatyEvent, dominantFeaturedEvent],
      stories: [websterTreatyStory],
    });
    const treatyAnchor = datePageHooks.historicalEventAnchorId(
      websterTreatyEvent,
    );
    const treatyStart = upgraded.indexOf(`id="${treatyAnchor}"`);
    const nextEvent = upgraded.indexOf('<div id="event-', treatyStart + 1);
    const treatyCard = upgraded.slice(
      treatyStart,
      nextEvent >= 0 ? nextEvent : treatyStart + 12_000,
    );

    assert.match(treatyCard, /href="\/blog\/9-august-2026\/"/);
    assert.match(treatyCard, />Read our story<\/a>/);
    assert.equal(
      (treatyCard.match(/href="\/blog\/9-august-2026\/"/g) || []).length,
      2,
    );
    assert.match(treatyCard, />Wikipedia source<\/a>/);
  });

  it("loads and links every verified article published for the date", async () => {
    const civilRightsStory = {
      slug: "9-august-2027",
      title: "How Did a Landmark Civil Rights Law Change the Nation?",
      eventTitle: "A Landmark Civil Rights Law Is Enacted",
      historicalYear: 1964,
      wikiUrl:
        "https://en.wikipedia.org/wiki/Civil_Rights_Act_of_1964",
      sourcePageTitle: "Civil Rights Act of 1964",
      publishedAt: "2027-08-09T00:15:00.000Z",
    };
    const entries = [websterTreatyStory, civilRightsStory];
    datePageHooks.getPublishedDateBlogEntries.cachedIndex = null;
    datePageHooks.getPublishedDateBlogEntries.cachedBinding = null;
    datePageHooks.getPublishedDateBlogEntries.cacheExpiresAt = 0;
    datePageHooks.findMatchingDateBlogEntry.verifiedSlugs = new Map();
    const loaded = await datePageHooks.getPublishedDateBlogEntries(
      {
        BLOG_AI_KV: {
          async get(key, options = {}) {
            if (key === "index") {
              return options.type === "json"
                ? entries
                : JSON.stringify(entries);
            }
            return key.startsWith("post:") ? "<!doctype html>" : null;
          },
        },
      },
      "august",
      9,
    );
    const html = datePageHooks.generateEventsDateHTML(
      "august",
      9,
      {
        events: [websterTreatyEvent, dominantFeaturedEvent],
        births: [],
        deaths: [],
      },
      "https://thisday.info",
      [],
      "",
      null,
      civilRightsStory,
      null,
      loaded,
    );

    assert.deepEqual(
      loaded.map((entry) => entry.slug),
      ["9-august-2026", "9-august-2027"],
    );
    assert.match(html, /href="\/blog\/9-august-2026\/"/);
    assert.match(html, /href="\/blog\/9-august-2027\/"/);
  });

  it("assigns globally by strongest identity instead of event order", () => {
    const weakEarlierEvent = {
      year: 1843,
      text: "Great Britain opens a new maritime exhibition.",
      pages: [wikiPage("Maritime history")],
    };
    const matches = matchHistoricalEventsToBlogStories(
      [weakEarlierEvent, greatBritainEvent],
      [greatBritainStory],
    );
    assert.equal(matches.has(weakEarlierEvent), false);
    assert.equal(matches.get(greatBritainEvent)?.slug, "19-july-2027");
    assert.equal(
      matches.get(greatBritainEvent)?.storyMatchMethod,
      "source-identity-and-year",
    );
  });

  it("emits only safe internal blog URLs", () => {
    assert.equal(safeBlogStoryUrl(greatBritainStory), "/blog/19-july-2027/");
    assert.equal(safeBlogStoryUrl({ slug: "../../admin" }), "");
    assert.equal(safeBlogStoryUrl({ slug: "story?next=evil" }), "");
  });
});

describe("major-event internal-link presentation", () => {
  it("renders an internal story action alongside the external source action", async () => {
    const source = await readFile(
      new URL("../js/seo-worker.js", import.meta.url),
      "utf8",
    );
    assert.match(source, /class="major-event-story">Read story/);
    assert.match(source, /class="major-event-source" target="_blank"/);
    assert.match(source, />Read our story<\/a>/);
    assert.match(source, />Wikipedia source<\/a>/);
    assert.match(
      source,
      /blogEntryDateRouteKey\(entry\) === dateRouteKey\(monthName, day\)/,
    );
  });
});
