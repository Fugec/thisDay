import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeRankingText,
  rankHistoricalEventCandidates,
} from "../js/shared/event-ranking.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = join(
  ROOT,
  "tools",
  "fixtures",
  "event-ranking-calibration.json",
);
const WIKIMEDIA_ENDPOINT =
  "https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all";
const ON_THIS_DAY_ORIGIN = "https://www.onthisday.com/events";
const USER_AGENT =
  "thisDay.info event-ranking calibration (kapetanovic.armin@gmail.com)";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// Four evenly spaced dates per month cover seasons and the full calendar.
// June 19 and July 19 are retained as incident/review anchors.
export const CALIBRATION_DATES = Object.freeze([
  ...MONTHS.flatMap((month) =>
    [1, 8, 15, 22].map((day) => ({ month, day })),
  ),
  { month: "june", day: 19 },
  { month: "july", day: 19 },
]);

const MATCH_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "again",
  "against",
  "all",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "becomes",
  "been",
  "before",
  "being",
  "between",
  "by",
  "during",
  "event",
  "first",
  "for",
  "from",
  "has",
  "have",
  "history",
  "in",
  "into",
  "is",
  "it",
  "its",
  "later",
  "new",
  "of",
  "on",
  "one",
  "over",
  "s",
  "than",
  "that",
  "the",
  "their",
  "this",
  "to",
  "under",
  "was",
  "were",
  "which",
  "who",
  "with",
  "world",
]);

const GENERIC_EDITORIAL_LABEL =
  /^(?:event|music|sports?) (?:history|of interest)$|^(?:baseball|football|golf|boxing|olympic) (?:history|record)$/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ")
    .trim();
}

function matchToken(value) {
  let token = normalizeRankingText(value);
  if (token.length >= 8) {
    token = token
      .replace(/(?:ations?|ments?|ingly|edly|ing|ers?|ies)$/i, "")
      .replace(/(?:ed|es)$/i, "");
  }
  return token;
}

export function meaningfulTokens(value) {
  return [
    ...new Set(
      normalizeRankingText(value)
        .split(" ")
        .map(matchToken)
        .filter(
          (token) =>
            token.length >= 3 &&
            !MATCH_STOPWORDS.has(token) &&
            !/^\d+$/.test(token),
        ),
    ),
  ].sort();
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function editorialFingerprint(text) {
  return meaningfulTokens(text).map(tokenHash);
}

function parseEditorialHighlights(html) {
  const highlights = [];
  const pattern =
    /<div class="section section--highlight[^"]*"[\s\S]*?<h2 class="poi__heading">([\s\S]*?)<\/h2>[\s\S]*?<p>([\s\S]*?)<\/p>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const heading = decodeHtml(match[1]);
    const paragraph = decodeHtml(match[2]);
    const yearMatch = paragraph.match(/\b(\d{3,4})\b/);
    if (!yearMatch) continue;
    const label = GENERIC_EDITORIAL_LABEL.test(heading) ? "" : heading;
    highlights.push({
      year: Number.parseInt(yearMatch[1], 10),
      ...(label ? { label } : {}),
      tokenHashes: editorialFingerprint(`${heading} ${paragraph}`),
    });
  }
  return highlights;
}

function wikiRichScore(page) {
  if (!page) return 0;
  let score = 0;
  if (page.thumbnail?.source) score += 3;
  if (page.originalimage?.source) score += 2;
  if (page.extract) score += Math.min(page.extract.length / 100, 5);
  if (page.description) score += 1;
  return score;
}

function normalizeWikimediaEvents(payload) {
  return (Array.isArray(payload?.events) ? payload.events : []).map(
    (event) => {
      const pages = Array.isArray(event?.pages) ? event.pages : [];
      const eventText = String(event?.text || "").toLowerCase();
      const page =
        pages.find((candidate) => {
          const title = String(
            candidate?.normalizedtitle || candidate?.title || "",
          )
            .replace(/_/g, " ")
            .toLowerCase();
          return title.length >= 4 && eventText.includes(title);
        }) ||
        pages[0] ||
        {};
      return {
        year: Number.parseInt(String(event?.year || ""), 10) || 0,
        text: String(event?.text || "").replace(/\s+/g, " ").trim(),
        pageTitle: String(
          page?.normalizedtitle || page?.title || "",
        ).replace(/_/g, " "),
        pageDescription: String(page?.description || ""),
        hasThumbnail: pages.some(
          (candidate) =>
            candidate?.thumbnail?.source || candidate?.originalimage?.source,
        ),
        extractLength: pages.reduce(
          (best, candidate) =>
            Math.max(best, String(candidate?.extract || "").length),
          0,
        ),
        sourceRichnessScore: pages.reduce(
          (best, candidate) => Math.max(best, wikiRichScore(candidate)),
          0,
        ),
      };
    },
  );
}

async function fetchText(url, headers) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.text();
      lastError = new Error(
        `${response.status} ${response.statusText} for ${url}`,
      );
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
    await sleep(attempt * 500);
  }
  throw lastError;
}

async function fetchCalibrationDate({ month, day }) {
  const monthNumber = MONTHS.indexOf(month) + 1;
  assert(monthNumber > 0, `Unknown month: ${month}`);
  const mm = String(monthNumber).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const wikimediaUrl = `${WIKIMEDIA_ENDPOINT}/${mm}/${dd}`;
  const editorialUrl = `${ON_THIS_DAY_ORIGIN}/${month}/${day}`;
  const [wikimediaRaw, editorialHtml] = await Promise.all([
    fetchText(wikimediaUrl, {
      Accept: "application/json",
      "Api-User-Agent": USER_AGENT,
      "User-Agent": USER_AGENT,
    }),
    fetchText(editorialUrl, {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": BROWSER_USER_AGENT,
    }),
  ]);
  return {
    date: `${month}-${day}`,
    candidates: normalizeWikimediaEvents(JSON.parse(wikimediaRaw)),
    editorialHighlights: parseEditorialHighlights(editorialHtml),
  };
}

export async function refreshCalibrationFixture(
  fixturePath = DEFAULT_FIXTURE,
) {
  const checkpointPath = `${fixturePath}.partial`;
  let dates = [];
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (checkpoint?.version === 1 && Array.isArray(checkpoint.dates)) {
      dates = checkpoint.dates;
    }
  } catch {}
  const completed = new Set(dates.map((entry) => entry.date));
  for (const [index, date] of CALIBRATION_DATES.entries()) {
    const dateKey = `${date.month}-${date.day}`;
    if (completed.has(dateKey)) continue;
    process.stderr.write(
      `Fetching calibration ${index + 1}/${CALIBRATION_DATES.length}: ` +
        `${date.month} ${date.day}\n`,
    );
    dates.push(await fetchCalibrationDate(date));
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(
      checkpointPath,
      `${JSON.stringify({ version: 1, dates }, null, 2)}\n`,
    );
    // Be deliberately polite to the editorial reference site.
    await sleep(125);
  }
  dates = CALIBRATION_DATES.map(({ month, day }) =>
    dates.find((entry) => entry.date === `${month}-${day}`),
  ).filter(Boolean);
  const fixture = {
    version: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      calendarSample:
        "Four evenly spaced dates per month plus the June 19 and July 19 incident anchors.",
      editorialReference:
        "OnThisDay highlighted event sections; only short labels and one-way token hashes are retained.",
      eventSource: "Wikimedia On This Day English API",
    },
    dates,
  };
  await mkdir(dirname(fixturePath), { recursive: true });
  // This contains thousands of Wikimedia candidates. Keep the durable
  // baseline compact so the audit remains cheap to review and check out.
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);
  await rm(checkpointPath, { force: true });
  return fixture;
}

function candidateFingerprint(candidate) {
  return new Set(
    meaningfulTokens(`${candidate?.pageTitle || ""} ${candidate?.text || ""}`)
      .map(tokenHash),
  );
}

function editorialMatch(candidate, highlight) {
  if (
    Number.parseInt(String(candidate?.year || ""), 10) !==
    Number.parseInt(String(highlight?.year || ""), 10)
  ) {
    return { matched: false, common: 0, containment: 0 };
  }
  const candidateHashes = candidateFingerprint(candidate);
  const editorialHashes = new Set(highlight?.tokenHashes || []);
  let common = 0;
  for (const hash of candidateHashes) {
    if (editorialHashes.has(hash)) common += 1;
  }
  const denominator = Math.max(
    1,
    Math.min(candidateHashes.size, editorialHashes.size),
  );
  const containment = common / denominator;
  return {
    matched:
      common >= 4 ||
      (common >= 3 && containment >= 0.42) ||
      (common >= 2 && containment >= 0.68),
    common,
    containment,
  };
}

function bestEditorialMatch(candidate, highlights) {
  return (Array.isArray(highlights) ? highlights : [])
    .map((highlight) => ({
      highlight,
      ...editorialMatch(candidate, highlight),
    }))
    .sort(
      (left, right) =>
        Number(right.matched) - Number(left.matched) ||
        right.containment - left.containment ||
        right.common - left.common,
    )[0] || { matched: false, common: 0, containment: 0 };
}

export function buildCalibrationReport(fixture) {
  const signalStats = new Map();
  let matchedCandidateScoreTotal = 0;
  let matchedCandidateCount = 0;
  let unmatchedCandidateScoreTotal = 0;
  let unmatchedCandidateCount = 0;
  const dates = (Array.isArray(fixture?.dates) ? fixture.dates : []).map(
    (entry) => {
      const ranked = rankHistoricalEventCandidates(entry.candidates || []).map(
        (candidate, rankIndex) => {
          const editorial = bestEditorialMatch(
            candidate,
            entry.editorialHighlights,
          );
          return {
            ...candidate,
            rank: rankIndex + 1,
            editorialMatched: editorial.matched,
            editorialLabel: editorial.highlight?.label || "",
          };
        },
      );
      for (const candidate of ranked) {
        if (candidate.editorialMatched) {
          matchedCandidateScoreTotal += candidate.selectionScore;
          matchedCandidateCount += 1;
        } else {
          unmatchedCandidateScoreTotal += candidate.selectionScore;
          unmatchedCandidateCount += 1;
        }
        for (const signal of candidate.signals || []) {
          const current = signalStats.get(signal.signal) || {
            signal: signal.signal,
            points: signal.points,
            candidates: 0,
            editorialMatches: 0,
          };
          current.candidates += 1;
          if (candidate.editorialMatched) current.editorialMatches += 1;
          signalStats.set(signal.signal, current);
        }
      }
      const editorialCandidates = ranked.filter(
        (candidate) => candidate.editorialMatched,
      );
      const topFive = ranked.slice(0, 5).map((candidate) => {
        return {
          year: candidate.year,
          pageTitle: candidate.pageTitle,
          text: candidate.text,
          score: candidate.selectionScore,
          editorialMatched: candidate.editorialMatched,
          editorialLabel: candidate.editorialLabel,
          signals: candidate.signals,
        };
      });
      const matchedCount = topFive.filter(
        (candidate) => candidate.editorialMatched,
      ).length;
      return {
        date: entry.date,
        candidateCount: entry.candidates?.length || 0,
        editorialHighlightCount: entry.editorialHighlights?.length || 0,
        mappableCandidateCount: editorialCandidates.length,
        firstEditorialRank: editorialCandidates[0]?.rank || null,
        topOneMatched: topFive[0]?.editorialMatched === true,
        topFiveDateHit: matchedCount > 0,
        matchedCount,
        topFive,
      };
    },
  );
  const topOneMatches = dates.filter((entry) => entry.topOneMatched).length;
  const topFiveMatches = dates.reduce(
    (sum, entry) => sum + entry.matchedCount,
    0,
  );
  const mappableDates = dates.filter(
    (entry) => entry.mappableCandidateCount > 0,
  );
  const topOneMatchesOnMappableDates = mappableDates.filter(
    (entry) => entry.topOneMatched,
  ).length;
  const topFiveDateHits = mappableDates.filter(
    (entry) => entry.topFiveDateHit,
  ).length;
  const firstEditorialRankTotal = mappableDates.reduce(
    (sum, entry) => sum + entry.firstEditorialRank,
    0,
  );
  return {
    fixtureVersion: fixture?.version,
    dateCount: dates.length,
    topOneMatches,
    topOneRate: dates.length ? topOneMatches / dates.length : 0,
    topFiveMatches,
    topFiveSlots: dates.length * 5,
    topFiveRate: dates.length ? topFiveMatches / (dates.length * 5) : 0,
    mappableDateCount: mappableDates.length,
    topOneMatchesOnMappableDates,
    topOneRateOnMappableDates: mappableDates.length
      ? topOneMatchesOnMappableDates / mappableDates.length
      : 0,
    topFiveDateHits,
    topFiveDateHitRate: mappableDates.length
      ? topFiveDateHits / mappableDates.length
      : 0,
    meanFirstEditorialRank: mappableDates.length
      ? firstEditorialRankTotal / mappableDates.length
      : null,
    matchedCandidateMeanScore: matchedCandidateCount
      ? matchedCandidateScoreTotal / matchedCandidateCount
      : null,
    unmatchedCandidateMeanScore: unmatchedCandidateCount
      ? unmatchedCandidateScoreTotal / unmatchedCandidateCount
      : null,
    signalStats: [...signalStats.values()]
      .map((entry) => ({
        ...entry,
        editorialMatchRate: entry.candidates
          ? entry.editorialMatches / entry.candidates
          : 0,
      }))
      .sort(
        (left, right) =>
          right.editorialMatchRate - left.editorialMatchRate ||
          right.candidates - left.candidates,
      ),
    dates,
  };
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function printReport(report) {
  console.log(`Calibration dates: ${report.dateCount}`);
  console.log(
    `Top event in editorial highlights: ${report.topOneMatches}/` +
      `${report.dateCount} (${formatPercent(report.topOneRate)})`,
  );
  console.log(
    `Top-five editorial matches: ${report.topFiveMatches}/` +
      `${report.topFiveSlots} (${formatPercent(report.topFiveRate)})`,
  );
  console.log(
    `Dates with at least one mappable highlight: ${report.mappableDateCount}/` +
      `${report.dateCount}`,
  );
  console.log(
    `Top event match on mappable dates: ${report.topOneMatchesOnMappableDates}/` +
      `${report.mappableDateCount} ` +
      `(${formatPercent(report.topOneRateOnMappableDates)})`,
  );
  console.log(
    `At least one top-five match on mappable dates: ${report.topFiveDateHits}/` +
      `${report.mappableDateCount} (${formatPercent(report.topFiveDateHitRate)})`,
  );
  console.log(
    `Mean first editorial-match rank: ` +
      `${Number(report.meanFirstEditorialRank || 0).toFixed(2)}`,
  );
  const misses = report.dates.filter((entry) => !entry.topOneMatched);
  console.log(`Top-one misses: ${misses.length}`);
  for (const entry of misses) {
    const top = entry.topFive[0];
    console.log(
      `- ${entry.date}: ${top?.year || "?"} ${top?.pageTitle || top?.text || "unknown"} ` +
        `(score ${top?.score ?? "?"}; top-five matches ${entry.matchedCount}/5)`,
    );
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const fixture = args.has("--refresh")
    ? await refreshCalibrationFixture()
    : JSON.parse(await readFile(DEFAULT_FIXTURE, "utf8"));
  const report = buildCalibrationReport(fixture);
  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
