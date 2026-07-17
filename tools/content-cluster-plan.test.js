import assert from "node:assert/strict";
import test from "node:test";
import {
  CANDIDATES,
  aggregateCandidate,
  buildPlan,
  parseArgs,
  queryMatches,
  renderMarkdown,
} from "./content-cluster-plan.js";

const row = (query, page, impressions, position, clicks = 0) => ({
  keys: [query, `https://thisday.info${page}`],
  impressions,
  position,
  clicks,
});

const blogIndex = CANDIDATES.map((candidate) => ({
  slug: candidate.anchorPath.split("/").filter(Boolean).at(-1),
  title: `${candidate.name} title`,
  description: `${candidate.name} description`,
}));

test("candidate matching recognizes intended variants", () => {
  const reagan = CANDIDATES.find((candidate) => candidate.id === "reagan-assassination-attempt");
  const tiananmen = CANDIDATES.find((candidate) => candidate.id === "tiananmen-1989");
  assert.equal(queryMatches(reagan, "when was ronald reagan shot"), true);
  assert.equal(queryMatches(reagan, "ronald reagan library"), false);
  assert.equal(queryMatches(tiananmen, "tianamen square protests"), true);
  assert.equal(queryMatches(tiananmen, "june fourth incident"), true);
});

test("aggregation excludes bot-style quoted queries and weights position", () => {
  const candidate = CANDIDATES.find((entry) => entry.id === "titanic");
  const result = aggregateCandidate(candidate, [
    row("titanic disaster", "/blog/8-april-2026/", 8, 80),
    row("april 14 1912", "/blog/8-april-2026/", 2, 60),
    row("\"titanic disaster\" exact answer", "/blog/8-april-2026/", 50, 1),
    row("unrelated", "/blog/8-april-2026/", 20, 2),
  ]);
  assert.equal(result.humanImpressions, 10);
  assert.equal(result.averagePosition, 76);
  assert.equal(result.matchingRows, 2);
});

test("plan selects demand-led clusters and preserves one-intent roles", () => {
  const queryPage = {
    export: {
      property: "sc-domain:thisday.info",
      availableStartDate: "2026-04-18",
      availableEndDate: "2026-07-14",
      dataState: "final",
    },
    rows: [
      row("reagan assassination attempt", "/blog/30-march-2026/", 15, 90),
      row("titanic disaster", "/blog/8-april-2026/", 12, 80),
      row("tiananmen square 1989", "/blog/4-june-2026/", 11, 70),
      row("israel independence", "/blog/14-may-2026/", 9, 60),
    ],
  };
  const indexing = {
    results: [{
      url: "https://thisday.info/blog/30-march-2026/",
      inspectionResult: {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          userCanonical: "https://thisday.info/blog/30-march-2026/",
          googleCanonical: "https://thisday.info/blog/30-march-2026/",
        },
      },
    }],
  };
  const plan = buildPlan({
    queryPage,
    indexing,
    blogIndex,
    minImpressions: 10,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });

  assert.deepEqual(
    plan.selectedClusters.map((cluster) => cluster.id),
    ["reagan-assassination-attempt", "titanic", "tiananmen-1989"],
  );
  assert.equal(plan.productionWrites, 0);
  assert.equal(plan.externalRequests, 0);
  assert.equal(plan.selectedClusters[0].anchor.indexing.verdict, "PASS");
  assert.equal(plan.selectedClusters[2].hub.state, "upgrade-existing");
  assert.deepEqual(
    plan.selectedClusters[0].intentMap.map((page) => page.role),
    ["date article", "evergreen hub", "supporting evergreen", "supporting evergreen"],
  );
});

test("markdown records publication limits and production safety", () => {
  const plan = buildPlan({
    queryPage: {
      export: {
        availableStartDate: "2026-04-18",
        availableEndDate: "2026-07-14",
        dataState: "final",
      },
      rows: [row("reagan assassination attempt", "/blog/30-march-2026/", 10, 90)],
    },
    indexing: { results: [] },
    blogIndex,
    minImpressions: 10,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
  const markdown = renderMarkdown(plan);
  assert.match(markdown, /zero production writes/i);
  assert.match(markdown, /one search intent belongs to one indexable URL/i);
  assert.match(markdown, /no automatic volume/i);
});

test("CLI options require positive impression thresholds", () => {
  assert.equal(
    parseArgs(["--blog-index", "/tmp/index.json", "--min-impressions", "12"])
      .minImpressions,
    12,
  );
  assert.throws(
    () => parseArgs(["--min-impressions=0"]),
    /positive integer/,
  );
});
