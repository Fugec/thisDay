import { normalizeRankingText } from "./event-ranking.js";

const STORY_MATCH_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "against",
  "all",
  "an",
  "and",
  "are",
  "as",
  "at",
  "before",
  "by",
  "did",
  "during",
  "event",
  "first",
  "for",
  "from",
  "had",
  "has",
  "have",
  "history",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "new",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "which",
  "who",
  "why",
  "with",
  "world",
]);

function storyMatchTokens(value) {
  return new Set(
    normalizeRankingText(value)
      .split(" ")
      .map((token) =>
        token.length >= 6 ? token.replace(/(?:ing|ed)$/i, "") : token,
      )
      .filter(
        (token) =>
          token.length >= 3 &&
          !STORY_MATCH_STOPWORDS.has(token) &&
          !/^\d+$/.test(token),
      ),
  );
}

function wikipediaPageIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (
      !/(^|\.)wikipedia\.org$/i.test(url.hostname) ||
      !url.pathname.startsWith("/wiki/")
    ) {
      return "";
    }
    return normalizeRankingText(
      decodeURIComponent(url.pathname.slice("/wiki/".length)),
    );
  } catch {
    return "";
  }
}

function pageTitle(page) {
  return String(page?.normalizedtitle || page?.title || "")
    .replace(/_/g, " ")
    .trim();
}

function primaryEventPage(event) {
  const pages = Array.isArray(event?.pages) ? event.pages : [];
  const eventText = normalizeRankingText(event?.text);
  return (
    pages.find((page) => {
      const title = normalizeRankingText(pageTitle(page));
      return title.length >= 4 && eventText.includes(title);
    }) ||
    pages[0] ||
    {}
  );
}

function primaryEventIdentity(event) {
  const page = primaryEventPage(event);
  return (
    wikipediaPageIdentity(page?.content_urls?.desktop?.page) ||
    normalizeRankingText(pageTitle(page))
  );
}

function primaryStoryIdentity(story) {
  const firstSource = Array.isArray(story?.sourcePages)
    ? story.sourcePages[0]
    : null;
  for (const value of [
    story?.wikiUrl,
    story?.jsonLdUrl,
    firstSource?.pageUrl,
  ]) {
    const identity = wikipediaPageIdentity(value);
    if (identity) return identity;
  }
  return normalizeRankingText(
    story?.sourcePageTitle || firstSource?.pageTitle || "",
  );
}

export function historicalStoryYear(story) {
  const explicit = Number.parseInt(String(story?.historicalYear || ""), 10);
  if (Number.isFinite(explicit)) return explicit;

  const isoMatch = String(
    story?.historicalDateISO || story?.historicalDate || "",
  ).match(/^(-?\d{1,4})-/);
  if (isoMatch) return Number.parseInt(isoMatch[1], 10);

  for (const value of [story?.factualTitle, story?.title]) {
    const matches = [
      ...String(value || "").matchAll(/(?:^|[—–-]\s*|,\s*)(-?\d{3,4})(?=\D*$)/g),
    ];
    if (matches.length) {
      return Number.parseInt(matches[matches.length - 1][1], 10);
    }
  }
  return null;
}

function eventMatchText(event) {
  const page = primaryEventPage(event);
  return `${pageTitle(page)} ${event?.text || ""}`;
}

function storyMatchText(story) {
  const firstSource = Array.isArray(story?.sourcePages)
    ? story.sourcePages[0]
    : null;
  const keyTerms = (Array.isArray(story?.keyTerms) ? story.keyTerms : [])
    .filter((term) => term?.type === "event" || term?.type === "organization")
    .map((term) => term?.term)
    .filter(Boolean)
    .join(" ");
  return [
    story?.eventTitle,
    story?.factualTitle,
    story?.sourcePageTitle,
    firstSource?.pageTitle,
    story?.keywords,
    keyTerms,
    story?.title,
  ]
    .filter(Boolean)
    .join(" ");
}

export function scoreHistoricalEventStoryMatch(event, story) {
  const eventYear = Number.parseInt(String(event?.year || ""), 10);
  const storyYear = historicalStoryYear(story);
  if (
    !Number.isFinite(eventYear) ||
    !Number.isFinite(storyYear) ||
    eventYear !== storyYear
  ) {
    return {
      matched: false,
      score: 0,
      method: "year-mismatch",
      commonTokenCount: 0,
      tokenContainment: 0,
    };
  }

  const eventTokens = storyMatchTokens(eventMatchText(event));
  const storyTokens = storyMatchTokens(storyMatchText(story));
  let commonTokenCount = 0;
  for (const token of eventTokens) {
    if (storyTokens.has(token)) commonTokenCount += 1;
  }
  const tokenContainment =
    commonTokenCount /
    Math.max(1, Math.min(eventTokens.size, storyTokens.size));
  const sameIdentity =
    primaryEventIdentity(event) &&
    primaryEventIdentity(event) === primaryStoryIdentity(story);
  const tokenMatched =
    commonTokenCount >= 4 ||
    (commonTokenCount >= 3 && tokenContainment >= 0.45) ||
    (commonTokenCount >= 2 && tokenContainment >= 0.7);

  if (!sameIdentity && !tokenMatched) {
    return {
      matched: false,
      score: 0,
      method: "insufficient-identity",
      commonTokenCount,
      tokenContainment,
    };
  }

  return {
    matched: true,
    score:
      (sameIdentity ? 100 : 60) +
      commonTokenCount * 4 +
      Math.round(tokenContainment * 20),
    method: sameIdentity ? "source-identity-and-year" : "topic-tokens-and-year",
    commonTokenCount,
    tokenContainment,
  };
}

export function matchHistoricalEventsToBlogStories(events, stories) {
  const matches = new Map();
  const usedEvents = new Set();
  const usedSlugs = new Set();
  const eventList = Array.isArray(events) ? events : [];
  const storyList = Array.isArray(stories) ? stories : [];
  const candidates = eventList
    .flatMap((event, eventRank) =>
      storyList
        .filter((story) => story?.slug)
        .map((story) => ({
          event,
          eventRank,
          story,
          ...scoreHistoricalEventStoryMatch(event, story),
        })),
    )
    .filter((candidate) => candidate.matched)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.eventRank - right.eventRank ||
        String(right.story?.publishedAt || "").localeCompare(
          String(left.story?.publishedAt || ""),
        ),
    );

  for (const candidate of candidates) {
    if (
      usedEvents.has(candidate.event) ||
      usedSlugs.has(candidate.story.slug)
    ) {
      continue;
    }
    matches.set(candidate.event, {
      ...candidate.story,
      storyMatchMethod: candidate.method,
      storyMatchScore: candidate.score,
    });
    usedEvents.add(candidate.event);
    usedSlugs.add(candidate.story.slug);
  }
  return matches;
}

export function safeBlogStoryUrl(story) {
  const slug = String(story?.slug || "").trim();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug || "")
    ? `/blog/${slug}/`
    : "";
}
