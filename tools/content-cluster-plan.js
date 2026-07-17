#!/usr/bin/env node
/**
 * Build a read-only, query-led editorial cluster plan from cached GSC exports.
 *
 * The tool writes local planning files only. It does not call external APIs,
 * change production KV, publish pages, or request indexing.
 *
 * Usage:
 *   node tools/content-cluster-plan.js \
 *     --blog-index /private/tmp/thisday-live-blog-index-20260717.json
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBotQuery } from "./gsc-weekly.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://thisday.info";
const MIN_HUMAN_IMPRESSIONS = 10;
const MAX_SELECTED_CLUSTERS = 5;

const CANDIDATES = [
  {
    id: "reagan-assassination-attempt",
    name: "Attempted assassination of Ronald Reagan",
    anchorPath: "/blog/30-march-2026/",
    hubPath: "/history/attempted-assassination-of-ronald-reagan-1981/",
    hubState: "new",
    matchers: [
      /\breagan\b.*\b(?:assassin\w*|shoot\w*|shot)\b/i,
      /\b(?:assassin\w*|shoot\w*|shot)\b.*\breagan\b/i,
    ],
    sourceOpportunities: [
      "Ronald Reagan Presidential Library archival material",
      "FBI Vault records",
      "Miller Center presidential history",
      "National Archives and U.S. Secret Service records",
    ],
    supportPages: [
      {
        path: "/history/reagan-shooting-timeline-1981/",
        intent: "Minute-by-minute sequence from the Washington Hilton shooting through surgery",
      },
      {
        path: "/history/how-the-reagan-shooting-changed-presidential-security/",
        intent: "Security and constitutional consequences, without retelling the whole event",
      },
    ],
    blockers: [
      "Audit and repair the legacy date article's weak description and sourcing before using it as the cluster's trusted date-intent anchor.",
      "Confirm the canonical Wikipedia identity before finalizing the new history slug.",
    ],
    risk: "medium",
  },
  {
    id: "titanic",
    name: "Sinking of RMS Titanic",
    anchorPath: "/blog/8-april-2026/",
    hubPath: "/history/sinking-of-the-titanic-1912/",
    hubState: "new",
    matchers: [
      /\btitanic\b/i,
      /\b(?:april|apr)\s+1[45](?:th)?\s*,?\s*1912\b/i,
      /\b1[45](?:th)?\s+(?:april|apr)\s+1912\b/i,
    ],
    sourceOpportunities: [
      "British Wreck Commissioner's Inquiry",
      "United States Senate Titanic inquiry",
      "UK and U.S. National Archives",
      "NOAA maritime history and wreck records",
    ],
    supportPages: [
      {
        path: "/history/titanic-collision-and-sinking-timeline/",
        intent: "The collision-to-sinking timeline and the decisions made during those hours",
      },
      {
        path: "/history/titanic-inquiries-and-maritime-safety-reforms/",
        intent: "What the official inquiries found and which safety rules changed",
      },
    ],
    blockers: [
      "Stop before publication: the indexed anchor says April 8, while its own description says the sinking unfolded April 14–15.",
      "Run a factual/source/image audit of the legacy article; do not hide the date conflict with a new competing page.",
      "Confirm the canonical Wikipedia identity before finalizing the new history slug.",
    ],
    risk: "high",
  },
  {
    id: "tiananmen-1989",
    name: "1989 Tiananmen Square protests and crackdown",
    anchorPath: "/blog/4-june-2026/",
    hubPath: "/history/tiananmen-square-suppressed/",
    hubState: "upgrade-existing",
    matchers: [
      /\btian(?:anmen|amen)\b/i,
      /\btitanium\s+square\s+1989\b/i,
      /\bjune\s+4(?:th)?\s*,?\s*1989\b/i,
      /\b4(?:th)?\s+june\s+1989\b/i,
      /\b1989\s+june\s+4(?:th)?\b/i,
      /\b1989[.\s]+6[.\s]+4\b/i,
      /\bjune\s+fourth\s+incident\b/i,
    ],
    sourceOpportunities: [
      "National Security Archive declassified records",
      "Amnesty International and Human Rights Watch reports",
      "Declassified diplomatic records",
      "Contemporaneous reporting and oral histories with explicit attribution",
    ],
    supportPages: [
      {
        path: "/history/tiananmen-june-3-4-1989-timeline/",
        intent: "A sourced June 3–4 chronology that distinguishes confirmed facts from estimates",
      },
      {
        path: "/history/tank-man-what-is-known-and-unknown/",
        intent: "Evidence about Tank Man, clearly separating the record from unresolved claims",
      },
    ],
    blockers: [
      "Upgrade the existing history URL; never launch a parallel hub for the same intent.",
      "The legacy entity is thin and lacks a direct source identity, so it must pass the current evergreen and source gates before becoming indexable.",
      "Use explicit attribution for disputed death estimates, terminology, and unresolved identities.",
    ],
    risk: "high",
  },
  {
    id: "israel-independence-1948",
    name: "Israel's declaration of independence in 1948",
    anchorPath: "/blog/14-may-2026/",
    hubPath: "/history/israeli-independence/",
    hubState: "resolve-and-upgrade-existing",
    matchers: [
      /\bisrael(?:i)?\s+independence\b/i,
      /\b(?:may)\s+14(?:th)?\s*,?\s*1948\b/i,
      /\b14(?:th)?\s+may\s+1948\b/i,
    ],
    sourceOpportunities: [
      "Israeli Declaration of Independence text and state archives",
      "United Nations Resolution 181 and UN archival records",
      "British Mandate records",
      "Palestinian and Arab historical records for necessary multi-perspective context",
    ],
    supportPages: [
      {
        path: "/history/israel-declaration-may-14-1948-explained/",
        intent: "What the declaration said, who signed it, and what took effect that day",
      },
      {
        path: "/history/partition-mandate-and-the-1948-war/",
        intent: "The pre-declaration context and immediate war, without duplicating the declaration page",
      },
    ],
    blockers: [
      "Resolve the existing duplicate history identity before choosing a canonical winner; do not create another hub URL.",
      "The existing history entity is below the current quality threshold and unknown to Google.",
      "Require balanced terminology, primary documents, and Israeli, Palestinian, Arab, British, and UN context.",
    ],
    risk: "high",
  },
  {
    id: "fall-of-saigon",
    name: "Fall of Saigon",
    anchorPath: "/blog/30-april-2026/",
    hubPath: "/history/fall-of-saigon/",
    hubState: "upgrade-existing",
    matchers: [
      /\bfall\s+of\s+saigon\b/i,
      /\bsaigon\b.*\b(?:1975|fall|evacuat\w*|surrender\w*)\b/i,
      /\b(?:april|apr)\s+30(?:th)?\s*,?\s*1975\b/i,
      /\b30(?:th)?\s+(?:april|apr)\s+1975\b/i,
      /\bsaigon\s+30[.]?\s+april\s+1975\b/i,
    ],
    sourceOpportunities: [
      "Gerald R. Ford Presidential Library",
      "U.S. Office of the Historian",
      "U.S. National Archives records",
      "Vietnamese records, testimony, and scholarship for multi-perspective context",
    ],
    supportPages: [
      {
        path: "/history/operation-frequent-wind-evacuation/",
        intent: "The evacuation operation, logistics, and who was left behind",
      },
      {
        path: "/history/saigon-april-30-1975-timeline/",
        intent: "The final day's military and political sequence through surrender",
      },
    ],
    blockers: [
      "Upgrade the existing history URL; do not create a competing hub.",
      "The existing entity is below the current history-page quality threshold.",
      "Use Vietnamese and civilian perspectives alongside U.S. archival sources.",
    ],
    risk: "high",
  },
  {
    id: "alexander-ii-assassination",
    name: "Assassination of Alexander II",
    anchorPath: "/blog/7-march-2026/",
    hubPath: "/history/assassination-of-alexander-ii-1881/",
    hubState: "research",
    matchers: [
      /\balexander\s+ii\b.*\b(?:assassin\w*|kill\w*|death)\b/i,
      /\bassassination\s+of\s+alexander\s+ii\b/i,
    ],
    sourceOpportunities: [
      "Imperial Russian archival collections",
      "Library of Congress collections",
      "Academic histories of Narodnaya Volya",
    ],
    supportPages: [],
    blockers: [
      "Demand is below the initial ten-impression threshold; retain as research backlog only.",
    ],
    risk: "medium",
  },
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    help: false,
    queryPage: join(ROOT, "documentation/gsc/query-page-raw.json"),
    indexing: join(ROOT, "documentation/gsc/indexing-raw.json"),
    blogIndex: "",
    outDir: join(ROOT, "documentation/quality"),
    minImpressions: MIN_HUMAN_IMPRESSIONS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value after ${arg}`);
      return value;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--query-page") options.queryPage = resolve(nextValue());
    else if (arg.startsWith("--query-page=")) options.queryPage = resolve(arg.slice(13));
    else if (arg === "--indexing") options.indexing = resolve(nextValue());
    else if (arg.startsWith("--indexing=")) options.indexing = resolve(arg.slice(11));
    else if (arg === "--blog-index") options.blogIndex = resolve(nextValue());
    else if (arg.startsWith("--blog-index=")) options.blogIndex = resolve(arg.slice(13));
    else if (arg === "--out-dir") options.outDir = resolve(nextValue());
    else if (arg.startsWith("--out-dir=")) options.outDir = resolve(arg.slice(10));
    else if (arg === "--min-impressions") options.minImpressions = Number(nextValue());
    else if (arg.startsWith("--min-impressions=")) {
      options.minImpressions = Number(arg.slice(18));
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.minImpressions) || options.minImpressions < 1) {
    throw new Error("--min-impressions must be a positive integer.");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/content-cluster-plan.js --blog-index PATH [options]

Options:
  --query-page PATH       Cached GSC query-page export.
  --indexing PATH         Cached GSC URL Inspection export.
  --blog-index PATH       Read-only production blog index snapshot (required).
  --out-dir PATH          Local output directory.
  --min-impressions N     Known-human selection threshold (default: 10).
  -h, --help              Show this help.

This tool performs no production writes or external requests.`);
}

function readJson(path, label) {
  if (!path) throw new Error(`${label} path is required.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

function canonicalUrl(path) {
  return new URL(path, SITE).href;
}

function queryMatches(candidate, query) {
  return candidate.matchers.some((pattern) => pattern.test(String(query || "")));
}

function aggregateCandidate(candidate, rows) {
  const matches = rows.filter((row) => {
    const [query] = row.keys || [];
    return query && !isBotQuery(query) && queryMatches(candidate, query);
  });
  const pageMap = new Map();
  const queryMap = new Map();
  let impressions = 0;
  let clicks = 0;
  let positionSum = 0;

  for (const row of matches) {
    const [query, page] = row.keys;
    const rowImpressions = Number(row.impressions) || 0;
    const rowClicks = Number(row.clicks) || 0;
    impressions += rowImpressions;
    clicks += rowClicks;
    positionSum += (Number(row.position) || 0) * rowImpressions;

    const pageEntry = pageMap.get(page) || {
      url: page,
      impressions: 0,
      clicks: 0,
      positionSum: 0,
    };
    pageEntry.impressions += rowImpressions;
    pageEntry.clicks += rowClicks;
    pageEntry.positionSum += (Number(row.position) || 0) * rowImpressions;
    pageMap.set(page, pageEntry);

    const queryEntry = queryMap.get(query) || {
      query,
      impressions: 0,
      clicks: 0,
      positionSum: 0,
    };
    queryEntry.impressions += rowImpressions;
    queryEntry.clicks += rowClicks;
    queryEntry.positionSum += (Number(row.position) || 0) * rowImpressions;
    queryMap.set(query, queryEntry);
  }

  const finalize = (entry) => ({
    ...entry,
    averagePosition: entry.impressions
      ? Number((entry.positionSum / entry.impressions).toFixed(1))
      : null,
    positionSum: undefined,
  });
  const sortByDemand = (left, right) =>
    right.impressions - left.impressions ||
    (left.averagePosition ?? Infinity) - (right.averagePosition ?? Infinity);

  return {
    humanImpressions: impressions,
    humanClicks: clicks,
    averagePosition: impressions
      ? Number((positionSum / impressions).toFixed(1))
      : null,
    matchingRows: matches.length,
    pages: [...pageMap.values()].map(finalize).sort(sortByDemand),
    topQueries: [...queryMap.values()].map(finalize).sort(sortByDemand).slice(0, 12),
  };
}

function indexingFor(url, indexingRows) {
  const result = indexingRows.find((row) => row.url === url);
  const status = result?.inspectionResult?.indexStatusResult;
  if (!status) {
    return {
      inspected: false,
      verdict: "NOT_INSPECTED",
      coverageState: "Not inspected",
      userCanonical: "",
      googleCanonical: "",
    };
  }
  return {
    inspected: true,
    verdict: status.verdict || "VERDICT_UNSPECIFIED",
    coverageState: status.coverageState || "",
    indexingState: status.indexingState || "",
    pageFetchState: status.pageFetchState || "",
    userCanonical: status.userCanonical || "",
    googleCanonical: status.googleCanonical || "",
    lastCrawlTime: status.lastCrawlTime || "",
  };
}

function anchorFor(candidate, blogIndex, indexingRows) {
  const slug = candidate.anchorPath.split("/").filter(Boolean).at(-1);
  const post = blogIndex.find((entry) => entry.slug === slug);
  const url = canonicalUrl(candidate.anchorPath);
  return {
    path: candidate.anchorPath,
    url,
    foundInBlogIndex: Boolean(post),
    title: post?.title || "",
    description: post?.description || "",
    historicalYear: post?.historicalYear ?? null,
    indexing: indexingFor(url, indexingRows),
  };
}

function buildIntentMap(candidate) {
  return [
    {
      path: candidate.anchorPath,
      role: "date article",
      owns: "What happened on this calendar date?",
      rule: "Keep its date intent and self-canonical; link to the hub only when the article is factually ready.",
    },
    {
      path: candidate.hubPath,
      role: "evergreen hub",
      owns: `Complete overview of ${candidate.name}`,
      rule: candidate.hubState.includes("existing")
        ? "Upgrade or consolidate this existing URL; do not create a parallel hub."
        : "Publish only after it passes the current evergreen, source, originality, and indexability gates.",
    },
    ...candidate.supportPages.map((page) => ({
      path: page.path,
      role: "supporting evergreen",
      owns: page.intent,
      rule: "Answer only this narrower question; summarize and link to the hub instead of repeating its full overview.",
    })),
  ];
}

function buildCluster(candidate, metrics, blogIndex, indexingRows, rank) {
  const anchor = anchorFor(candidate, blogIndex, indexingRows);
  return {
    rank,
    id: candidate.id,
    name: candidate.name,
    risk: candidate.risk,
    metrics,
    anchor,
    hub: {
      path: candidate.hubPath,
      state: candidate.hubState,
    },
    intentMap: buildIntentMap(candidate),
    internalLinkContract: [
      "Date article → evergreen hub with descriptive subject anchor text.",
      "Evergreen hub → date article with explicit date-intent anchor text.",
      "Supporting page → hub in its introduction and conclusion.",
      "Hub → each support page once from a relevant section, not a generic link list.",
      "Support pages do not cross-link when their intents do not overlap.",
      "Every page remains self-canonical; no same-intent duplicate is indexable.",
    ],
    sourceOpportunities: candidate.sourceOpportunities,
    blockers: candidate.blockers,
  };
}

function buildNinetyDayCalendar(selected) {
  const byId = new Map(selected.map((cluster) => [cluster.id, cluster]));
  const first = byId.get("reagan-assassination-attempt");
  const second = byId.get("titanic");
  const third = byId.get("tiananmen-1989");
  const fourth = byId.get("israel-independence-1948");
  const fifth = byId.get("fall-of-saigon");
  return [
    {
      weeks: "1–2",
      cluster: first?.name || "",
      outcome: "Build source dossier, repair/approve the date anchor, and write the hub brief with one intent per URL.",
      publish: "No publication until source and anchor checks pass.",
    },
    {
      weeks: "3–4",
      cluster: first?.name || "",
      outcome: "Publish the qualified hub, then one support page; add reciprocal links and validate sitemap/canonicals.",
      publish: "Maximum two evergreen pages.",
    },
    {
      weeks: "5–6",
      cluster: second?.name || "",
      outcome: "Resolve the historical-date conflict and complete a primary-source audit before any new page is drafted.",
      publish: "Hold if the date article remains inaccurate.",
    },
    {
      weeks: "7–8",
      cluster: second?.name || "",
      outcome: "After correction approval, publish the hub and one distinct inquiry/timeline support page.",
      publish: "Maximum two evergreen pages.",
    },
    {
      weeks: "9–10",
      cluster: third?.name || "",
      outcome: "Build a contested-facts dossier, upgrade the existing hub path, and require explicit attribution for uncertain claims.",
      publish: "Hub only if editorial and source gates pass.",
    },
    {
      weeks: "11–12",
      cluster: third?.name || "",
      outcome: "Publish one narrow evidence-led support page; complete internal links and technical QA.",
      publish: "Maximum one support page.",
    },
    {
      weeks: "13",
      cluster: [fourth?.name, fifth?.name].filter(Boolean).join(" / "),
      outcome: "Prepare source dossiers and canonical/duplicate decisions; compare GSC movement for the first three clusters.",
      publish: "Research only; no automatic volume.",
    },
  ];
}

function buildPlan({
  queryPage,
  indexing,
  blogIndex,
  minImpressions = MIN_HUMAN_IMPRESSIONS,
  generatedAt = new Date().toISOString(),
}) {
  const rows = Array.isArray(queryPage?.rows) ? queryPage.rows : [];
  const indexingRows = Array.isArray(indexing?.results) ? indexing.results : [];
  if (!rows.length) throw new Error("The query-page export contains no rows.");
  if (!Array.isArray(blogIndex)) throw new Error("The blog index must be an array.");

  const ranked = CANDIDATES
    .map((candidate) => ({
      candidate,
      metrics: aggregateCandidate(candidate, rows),
    }))
    .sort((left, right) =>
      right.metrics.humanImpressions - left.metrics.humanImpressions ||
      (left.metrics.averagePosition ?? Infinity) -
        (right.metrics.averagePosition ?? Infinity));

  const selectedRaw = ranked
    .filter((entry) => entry.metrics.humanImpressions >= minImpressions)
    .slice(0, MAX_SELECTED_CLUSTERS);
  const selected = selectedRaw.map((entry, index) =>
    buildCluster(entry.candidate, entry.metrics, blogIndex, indexingRows, index + 1));
  const backlog = ranked
    .filter((entry) => !selectedRaw.includes(entry))
    .map((entry) => ({
      id: entry.candidate.id,
      name: entry.candidate.name,
      humanImpressions: entry.metrics.humanImpressions,
      averagePosition: entry.metrics.averagePosition,
      reason: entry.metrics.humanImpressions < minImpressions
        ? `Below the ${minImpressions}-impression threshold.`
        : "Outside the first five clusters.",
    }));

  return {
    generatedAt,
    productionWrites: 0,
    externalRequests: 0,
    sourceWindow: {
      property: queryPage?.export?.property || "",
      availableStartDate: queryPage?.export?.availableStartDate || "",
      availableEndDate: queryPage?.export?.availableEndDate || "",
      dataState: queryPage?.export?.dataState || "",
      queryPageRows: rows.length,
    },
    selectionPolicy: {
      knownHumanOnly: true,
      botClassifier: "tools/gsc-weekly.js:isBotQuery",
      minimumHumanImpressions: minImpressions,
      maximumClusters: MAX_SELECTED_CLUSTERS,
      ranking: "Known-human impressions descending; average position is diagnostic, not a snippet trigger.",
      guardrails: [
        "Existing URLs are preserved unless a separately reviewed redirect/consolidation plan exists.",
        "One search intent belongs to one indexable URL.",
        "Daily date pages support clusters; they do not become duplicate evergreen hubs.",
        "No page is published from this plan automatically.",
      ],
    },
    selectedClusters: selected,
    backlog,
    ninetyDayCalendar: buildNinetyDayCalendar(selected),
  };
}

function markdownTableCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(plan) {
  const lines = [
    "# Query-led content cluster plan",
    "",
    `Generated: ${plan.generatedAt}`,
    "",
    `GSC window: **${plan.sourceWindow.availableStartDate} → ${plan.sourceWindow.availableEndDate}** (${plan.sourceWindow.dataState}).`,
    "",
    "This is a local editorial plan. It made **zero production writes** and **zero external requests**.",
    "",
    "## Selected clusters",
    "",
    "| Rank | Cluster | Human impressions | Avg position | Clicks | Indexed anchor | Hub action |",
    "|---:|---|---:|---:|---:|---|---|",
    ...plan.selectedClusters.map((cluster) =>
      `| ${[
        cluster.rank,
        markdownTableCell(cluster.name),
        cluster.metrics.humanImpressions,
        cluster.metrics.averagePosition ?? "n/a",
        cluster.metrics.humanClicks,
        markdownTableCell(
          `${cluster.anchor.indexing.verdict}: ${cluster.anchor.indexing.coverageState}`,
        ),
        markdownTableCell(`${cluster.hub.state}: ${cluster.hub.path}`),
      ].join(" | ")} |`),
    "",
    "Average positions are roughly 79–89, so title/snippet tweaks are not the main lever. The work is source quality, distinct usefulness, and coherent internal linking.",
    "",
    "## Selection guardrails",
    "",
    ...plan.selectionPolicy.guardrails.map((rule) => `- ${rule}`),
    "",
  ];

  for (const cluster of plan.selectedClusters) {
    lines.push(
      `## ${cluster.rank}. ${cluster.name}`,
      "",
      `Anchor: \`${cluster.anchor.path}\` — **${cluster.anchor.title || "missing from index"}**`,
      "",
      `Hub: \`${cluster.hub.path}\` (${cluster.hub.state})`,
      "",
      `Demand: **${cluster.metrics.humanImpressions}** known-human impressions, **${cluster.metrics.humanClicks}** clicks, average position **${cluster.metrics.averagePosition ?? "n/a"}**.`,
      "",
      "Top observed queries:",
      "",
      ...cluster.metrics.topQueries.slice(0, 6).map((query) =>
        `- \`${query.query}\` — ${query.impressions} impressions, position ${query.averagePosition}`),
      "",
      "One-intent page map:",
      "",
      "| URL | Role | Owns |",
      "|---|---|---|",
      ...cluster.intentMap.map((page) =>
        `| \`${page.path}\` | ${markdownTableCell(page.role)} | ${markdownTableCell(page.owns)} |`),
      "",
      "Source opportunities:",
      "",
      ...cluster.sourceOpportunities.map((source) => `- ${source}`),
      "",
      "Must resolve first:",
      "",
      ...cluster.blockers.map((blocker) => `- ${blocker}`),
      "",
    );
  }

  lines.push(
    "## Internal-link contract",
    "",
    ...plan.selectedClusters[0].internalLinkContract.map((rule) => `- ${rule}`),
    "",
    "## 90-day calendar",
    "",
    "| Weeks | Cluster | Outcome | Publication limit |",
    "|---|---|---|---|",
    ...plan.ninetyDayCalendar.map((row) =>
      `| ${row.weeks} | ${markdownTableCell(row.cluster)} | ${markdownTableCell(row.outcome)} | ${markdownTableCell(row.publish)} |`),
    "",
    "## Research backlog",
    "",
    "| Cluster | Human impressions | Avg position | Decision |",
    "|---|---:|---:|---|",
    ...plan.backlog.map((entry) =>
      `| ${markdownTableCell(entry.name)} | ${entry.humanImpressions} | ${entry.averagePosition ?? "n/a"} | ${markdownTableCell(entry.reason)} |`),
    "",
    "## Definition of done for each public cluster",
    "",
    "- The date article is factually audited and retains its date-specific intent.",
    "- The hub passes the current evergreen, source, originality, article-card, and indexability gates.",
    "- Every support page answers a distinct query and adds evidence not repeated from the hub.",
    "- Reciprocal links use descriptive anchor text; every page is self-canonical.",
    "- Only qualified canonical URLs enter sitemaps and IndexNow.",
    "- GSC is reviewed after 28 and 56 days; pages are improved or consolidated based on evidence, not output volume.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.blogIndex) {
    throw new Error("--blog-index is required so anchor metadata comes from an explicit read-only snapshot.");
  }
  const queryPage = readJson(options.queryPage, "query-page export");
  const indexing = readJson(options.indexing, "indexing export");
  const blogIndex = readJson(options.blogIndex, "blog index");
  const plan = buildPlan({
    queryPage,
    indexing,
    blogIndex,
    minImpressions: options.minImpressions,
  });
  mkdirSync(options.outDir, { recursive: true });
  const jsonPath = join(options.outDir, "query-led-cluster-plan.json");
  const markdownPath = join(options.outDir, "query-led-cluster-plan.md");
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(plan));

  console.log(`Selected clusters: ${plan.selectedClusters.length}`);
  for (const cluster of plan.selectedClusters) {
    console.log(
      `${cluster.rank}. ${cluster.name}: ${cluster.metrics.humanImpressions} human impressions, position ${cluster.metrics.averagePosition}`,
    );
  }
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
  console.log("Production writes: 0");
}

const isCli = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    main();
  } catch (error) {
    console.error("ERROR:", error.message);
    process.exitCode = 1;
  }
}

export {
  CANDIDATES,
  aggregateCandidate,
  buildPlan,
  parseArgs,
  queryMatches,
  renderMarkdown,
};
