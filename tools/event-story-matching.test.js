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
