#!/usr/bin/env node
/**
 * GSC weekly export and opportunity report.
 *
 * Read-only external operations:
 *   - Search Console Search Analytics API
 *   - optional Search Console URL Inspection API
 *   - Cloudflare KV GET for malformed-title reporting
 *
 * Local outputs (gitignored):
 *   documentation/gsc/dates-raw.json
 *   documentation/gsc/totals-raw.json
 *   documentation/gsc/queries-raw.json
 *   documentation/gsc/pages-raw.json
 *   documentation/gsc/query-page-raw.json
 *   documentation/gsc/device-raw.json
 *   documentation/gsc/country-raw.json
 *   documentation/gsc/indexing-raw.json          (with --inspect-indexing)
 *   documentation/gsc/weekly-report.md
 *   documentation/gsc/weekly-YYYY-MM-DD.md
 *
 * Credentials (gitignored):
 *   .secrets
 *     GSC_OAUTH_CLIENT_ID
 *     GSC_OAUTH_CLIENT_SECRET
 *     GSC_REFRESH_TOKEN
 *     GSC_ACCESS_TOKEN
 *   youtube-upload/.env
 *     CF_API_TOKEN
 *     CF_ACCOUNT_ID
 *
 * Usage:
 *   node tools/gsc-weekly.js
 *   node tools/gsc-weekly.js --inspect-indexing
 *   node tools/gsc-weekly.js --inspect-indexing \
 *     --inspection-urls documentation/quality/inventory-quality-report.json
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROPERTY = "sc-domain:thisday.info";
const SITE = "https://thisday.info";
const BLOG_KV_NS = "5173c34a7bd04cde9988c0e89d77bb6e";
const WINDOW_DAYS = 90;
const SEARCH_ANALYTICS_PAGE_SIZE = 25_000;
const INSPECTION_DAILY_LIMIT = 2_000;
const INSPECTION_INTERVAL_MS = 125;
const MIN_HUMAN_IMPR = 10;
const WINNABLE = [5, 20];

const DATASETS = [
  { name: "dates", dimensions: ["date"] },
  { name: "totals", dimensions: [] },
  { name: "queries", dimensions: ["query"] },
  { name: "pages", dimensions: ["page"] },
  { name: "query-page", dimensions: ["query", "page"] },
  { name: "device", dimensions: ["device"] },
  { name: "country", dimensions: ["country"] },
];

const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "into", "that", "while", "after", "before",
  "between", "against", "over", "under", "during", "per", "via", "near", "than",
  "then", "when", "which", "who", "whom",
]);

function parseEnvFile(path) {
  const output = {};
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return output;
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[match[1]] = value;
  }
  return output;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    help: false,
    skipKv: false,
    inspectIndexing: false,
    inspectionLimit: INSPECTION_DAILY_LIMIT,
    inspectionUrls: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--skip-kv") options.skipKv = true;
    else if (arg === "--inspect-indexing") options.inspectIndexing = true;
    else if (arg === "--inspection-limit") {
      options.inspectionLimit = Number(argv[++index]);
    } else if (arg.startsWith("--inspection-limit=")) {
      options.inspectionLimit = Number(arg.split("=", 2)[1]);
    } else if (arg === "--inspection-urls") {
      options.inspectionUrls = argv[++index] || "";
    } else if (arg.startsWith("--inspection-urls=")) {
      options.inspectionUrls = arg.slice("--inspection-urls=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (
    !Number.isInteger(options.inspectionLimit) ||
    options.inspectionLimit < 1 ||
    options.inspectionLimit > INSPECTION_DAILY_LIMIT
  ) {
    throw new Error(`--inspection-limit must be an integer from 1 to ${INSPECTION_DAILY_LIMIT}.`);
  }
  if (options.inspectionUrls) options.inspectIndexing = true;
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/gsc-weekly.js [options]

Options:
  --skip-kv                 Skip the read-only malformed-title KV scan.
  --inspect-indexing        Inspect GSC-observed page URLs with URL Inspection.
  --inspection-urls PATH    Also inspect URLs from JSON or a newline text file.
                            Inventory report JSON with items[].url is supported.
  --inspection-limit N      Maximum inspected URLs, 1-${INSPECTION_DAILY_LIMIT}.
  -h, --help                Show this help.

This tool never writes production KV or website content.`);
}

async function getAccessToken(secrets, fetchImpl = fetch) {
  const {
    GSC_OAUTH_CLIENT_ID,
    GSC_OAUTH_CLIENT_SECRET,
    GSC_REFRESH_TOKEN,
    GSC_ACCESS_TOKEN,
  } = secrets;
  if (GSC_OAUTH_CLIENT_SECRET && GSC_REFRESH_TOKEN && GSC_OAUTH_CLIENT_ID) {
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: GSC_REFRESH_TOKEN,
        client_id: GSC_OAUTH_CLIENT_ID,
        client_secret: GSC_OAUTH_CLIENT_SECRET,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.access_token) return { token: data.access_token, mode: "refreshed" };
    console.warn(
      `! token refresh failed (${data.error || response.status}: ${data.error_description || ""}) — falling back to static GSC_ACCESS_TOKEN`,
    );
  }
  if (GSC_ACCESS_TOKEN) {
    return {
      token: GSC_ACCESS_TOKEN,
      mode: "static (add the matching GSC_OAUTH_CLIENT_SECRET for unattended refresh)",
    };
  }
  throw new Error(
    "No usable GSC token. Add the matching OAuth client secret and refresh token, or a fresh read-only access token.",
  );
}

async function gscRequest(token, body, fetchImpl = fetch) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(PROPERTY)}/searchAnalytics/query`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || JSON.stringify(data);
    throw new Error(`GSC Search Analytics ${response.status}: ${detail}`);
  }
  return data;
}

async function queryAllSearchAnalyticsRows(token, body, fetchImpl = fetch) {
  const rows = [];
  let responseAggregationType = "";
  let metadata;
  for (let startRow = 0; ; startRow += SEARCH_ANALYTICS_PAGE_SIZE) {
    const page = await gscRequest(token, {
      ...body,
      rowLimit: SEARCH_ANALYTICS_PAGE_SIZE,
      startRow,
    }, fetchImpl);
    const pageRows = Array.isArray(page.rows) ? page.rows : [];
    rows.push(...pageRows);
    responseAggregationType ||= page.responseAggregationType || "";
    metadata ||= page.metadata;
    if (pageRows.length < SEARCH_ANALYTICS_PAGE_SIZE) break;
  }
  return {
    rows,
    ...(responseAggregationType ? { responseAggregationType } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function exportDocument(document, details) {
  return {
    export: {
      property: PROPERTY,
      generatedAt: details.generatedAt,
      requestedStartDate: details.requestedStartDate,
      requestedEndDate: details.requestedEndDate,
      availableStartDate: details.availableStartDate,
      availableEndDate: details.availableEndDate,
      dimensions: details.dimensions,
      rowCount: document.rows.length,
      dataState: "final",
      searchType: "web",
    },
    ...document,
  };
}

async function exportSearchAnalytics(token, {
  startDate,
  endDate,
  generatedAt = new Date().toISOString(),
  fetchImpl = fetch,
} = {}) {
  const documents = {};
  for (const dataset of DATASETS) {
    console.log(`GSC export: ${dataset.name}`);
    documents[dataset.name] = await queryAllSearchAnalyticsRows(token, {
      startDate,
      endDate,
      ...(dataset.dimensions.length ? { dimensions: dataset.dimensions } : {}),
      dataState: "final",
      type: "web",
    }, fetchImpl);
  }
  const dateKeys = documents.dates.rows
    .map((row) => row?.keys?.[0])
    .filter(Boolean)
    .sort();
  const availableStartDate = dateKeys[0] || startDate;
  const availableEndDate = dateKeys.at(-1) || endDate;
  return Object.fromEntries(DATASETS.map((dataset) => [
    dataset.name,
    exportDocument(documents[dataset.name], {
      generatedAt,
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      availableStartDate,
      availableEndDate,
      dimensions: dataset.dimensions,
    }),
  ]));
}

async function readKvIndex(env, fetchImpl = fetch) {
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!account || !token) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${BLOG_KV_NS}/values/index`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`CF KV read failed: ${response.status}`);
  return response.json();
}

function classifyTitle(title) {
  const issues = [];
  const value = String(title || "").trim();
  if (!value) return ["empty title"];
  const datePattern = /\s[-—]\s+[A-Z][a-z]+ \d{1,2},\s*\d{3,4}\s*$/;
  const hasDate = datePattern.test(value);
  const headline = hasDate ? value.replace(datePattern, "").trim() : value;
  if (!hasDate) issues.push("no 'Month Day, Year' date in title");
  const words = headline.split(/\s+/).filter(Boolean);
  const lastWord = (words.at(-1) || "").toLowerCase().replace(/[^a-z]/g, "");
  if (words.length >= 2 && FUNCTION_WORDS.has(lastWord)) {
    issues.push(`dangling function word: "…${words.at(-1)}"`);
  }
  if (/[,;:]\s*$/.test(headline)) issues.push("trailing punctuation");
  if (/(…|\.\.\.)/.test(headline)) issues.push("truncation marker (…)");
  return issues;
}

function isBotQuery(query) {
  const value = String(query || "");
  if (value.includes('"')) return true;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 8) return true;
  if (/\b(?:19|20)\d{2}\b/.test(value) && words.length >= 5) return true;
  return false;
}

function normalizeInspectionUrl(value) {
  try {
    const url = new URL(String(value || ""), SITE);
    if (!["thisday.info", "www.thisday.info"].includes(url.hostname.toLowerCase())) return "";
    url.protocol = "https:";
    url.hostname = "thisday.info";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function urlsFromDocument(document) {
  const candidates = [];
  if (Array.isArray(document)) candidates.push(...document);
  if (Array.isArray(document?.urls)) candidates.push(...document.urls);
  if (Array.isArray(document?.items)) candidates.push(...document.items);
  if (Array.isArray(document?.rows)) {
    candidates.push(...document.rows.map((row) => row?.keys?.[0]));
  }
  if (Array.isArray(document?.results)) candidates.push(...document.results);
  return candidates.map((entry) => {
    if (typeof entry === "string") return entry;
    return entry?.url || entry?.inspectionUrl || entry?.page || "";
  });
}

function loadInspectionUrls(pathValue) {
  if (!pathValue) return [];
  const path = isAbsolute(pathValue) ? pathValue : resolve(ROOT, pathValue);
  const raw = readFileSync(path, "utf8");
  try {
    return urlsFromDocument(JSON.parse(raw));
  } catch {
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
}

async function inspectUrl(token, inspectionUrl, fetchImpl = fetch) {
  const response = await fetchImpl(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inspectionUrl,
        siteUrl: PROPERTY,
        languageCode: "en-US",
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error?.message || `URL Inspection request failed with ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function collectUrlInspection(token, urls, {
  limit = INSPECTION_DAILY_LIMIT,
  generatedAt = new Date().toISOString(),
  fetchImpl = fetch,
  intervalMs = INSPECTION_INTERVAL_MS,
} = {}) {
  const uniqueUrls = [...new Set(urls.map(normalizeInspectionUrl).filter(Boolean))]
    .slice(0, limit);
  const results = [];
  const errors = [];
  for (let index = 0; index < uniqueUrls.length; index += 1) {
    const url = uniqueUrls[index];
    console.log(`GSC inspection: ${index + 1}/${uniqueUrls.length} ${url}`);
    try {
      const response = await inspectUrl(token, url, fetchImpl);
      results.push({ url, ...response });
    } catch (error) {
      errors.push({
        url,
        status: Number(error.status || 0),
        message: error.message,
      });
      if (Number(error.status) === 401 || Number(error.status) === 403) throw error;
    }
    if (intervalMs > 0 && index < uniqueUrls.length - 1) await delay(intervalMs);
  }
  return {
    export: {
      property: PROPERTY,
      generatedAt,
      requestedUrls: urls.length,
      uniqueUrls: uniqueUrls.length,
      inspectedUrls: results.length,
      failedUrls: errors.length,
      inspectionLimit: limit,
    },
    results,
    errors,
  };
}

function pct(numerator, denominator) {
  return denominator ? (100 * numerator / denominator) : 0;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function positionBand(position) {
  if (!Number.isFinite(position)) return "unavailable";
  if (position <= 4) return "1-4";
  if (position <= 10) return "5-10";
  if (position <= 20) return "11-20";
  if (position <= 50) return "21-50";
  return "51+";
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function aggregateQueryPage(rows) {
  const perPage = new Map();
  const perQuery = new Map();
  let humanImpressions = 0;
  let humanClicks = 0;
  let botImpressions = 0;
  let botClicks = 0;
  for (const row of rows) {
    const [query, page] = row.keys || [];
    if (!query || !page) continue;
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);
    const position = Number(row.position || 0);
    const bot = isBotQuery(query);
    if (bot) {
      botImpressions += impressions;
      botClicks += clicks;
    } else {
      humanImpressions += impressions;
      humanClicks += clicks;
      const queryStats = perQuery.get(query) || {
        impressions: 0,
        clicks: 0,
        positionSum: 0,
      };
      queryStats.impressions += impressions;
      queryStats.clicks += clicks;
      queryStats.positionSum += impressions * position;
      perQuery.set(query, queryStats);
    }
    const pageStats = perPage.get(page) || {
      humanImpressions: 0,
      humanClicks: 0,
      botImpressions: 0,
      positionSum: 0,
      queries: [],
    };
    if (bot) {
      pageStats.botImpressions += impressions;
    } else {
      pageStats.humanImpressions += impressions;
      pageStats.humanClicks += clicks;
      pageStats.positionSum += impressions * position;
      pageStats.queries.push({ query, impressions, clicks, position });
    }
    perPage.set(page, pageStats);
  }
  return {
    perPage,
    perQuery,
    humanImpressions,
    humanClicks,
    botImpressions,
    botClicks,
  };
}

function topDimensionRows(rows, limit = 15) {
  return [...rows]
    .sort((a, b) => Number(b.impressions || 0) - Number(a.impressions || 0))
    .slice(0, limit);
}

function buildReport({
  analytics,
  flagged = [],
  kvWarning = "",
  tokenMode,
  indexing,
}) {
  const dates = analytics.dates.export;
  const queryPageRows = analytics["query-page"].rows;
  const aggregate = aggregateQueryPage(queryPageRows);
  const totalRow = analytics.totals.rows[0] || {};
  const totalImpressions = Number(totalRow.impressions || 0);
  const totalClicks = Number(totalRow.clicks || 0);
  const knownImpressions = aggregate.humanImpressions + aggregate.botImpressions;
  const knownClicks = aggregate.humanClicks + aggregate.botClicks;
  const anonymousImpressions = Math.max(0, totalImpressions - knownImpressions);
  const anonymousClicks = Math.max(0, totalClicks - knownClicks);

  const humanQueries = [...aggregate.perQuery.entries()]
    .map(([query, stats]) => ({
      query,
      impressions: stats.impressions,
      clicks: stats.clicks,
      position: stats.impressions ? stats.positionSum / stats.impressions : null,
    }))
    .sort((a, b) => b.impressions - a.impressions);

  const humanPages = [...aggregate.perPage.entries()]
    .map(([page, stats]) => ({
      page,
      ...stats,
      position: stats.humanImpressions
        ? stats.positionSum / stats.humanImpressions
        : null,
    }));
  const winnable = humanPages
    .filter((page) => (
      page.humanImpressions >= MIN_HUMAN_IMPR &&
      page.position >= WINNABLE[0] &&
      page.position <= WINNABLE[1]
    ))
    .sort((a, b) => b.humanImpressions - a.humanImpressions);
  const bands = countBy(humanPages, (page) => positionBand(page.position));

  const lines = [];
  lines.push(`# GSC Weekly Report — ${dates.availableEndDate}`);
  lines.push("");
  lines.push(`Window: **${dates.availableStartDate} → ${dates.availableEndDate}**`);
  lines.push("");
  lines.push(`Requested window: ${dates.requestedStartDate} → ${dates.requestedEndDate} (${WINDOW_DAYS} days) · property \`${PROPERTY}\` · finalized data · token: ${tokenMode}`);
  lines.push("");
  lines.push("## Site summary — known human vs. bot/agent vs. anonymous queries");
  lines.push("");
  lines.push("| Segment | Impressions | Clicks | CTR |");
  lines.push("|---|--:|--:|--:|");
  lines.push(`| Total | ${totalImpressions.toFixed(0)} | ${totalClicks.toFixed(0)} | ${pct(totalClicks, totalImpressions).toFixed(3)}% |`);
  lines.push(`| **Known human queries** | ${aggregate.humanImpressions.toFixed(0)} | ${aggregate.humanClicks.toFixed(0)} | ${pct(aggregate.humanClicks, aggregate.humanImpressions).toFixed(3)}% |`);
  lines.push(`| Known bot/agent-style queries | ${aggregate.botImpressions.toFixed(0)} | ${aggregate.botClicks.toFixed(0)} | ${pct(aggregate.botClicks, aggregate.botImpressions).toFixed(3)}% |`);
  lines.push(`| Anonymous/not exposed by query dimension | ${anonymousImpressions.toFixed(0)} | ${anonymousClicks.toFixed(0)} | ${pct(anonymousClicks, anonymousImpressions).toFixed(3)}% |`);
  lines.push("");
  lines.push("_Anonymous impressions are not silently labeled as human or bot. Human-query metrics are lower bounds based only on exposed query rows._");
  lines.push("");

  lines.push("## Known human page position bands");
  lines.push("");
  lines.push("| Average-position band | Pages |");
  lines.push("|---|--:|");
  for (const band of ["1-4", "5-10", "11-20", "21-50", "51+", "unavailable"]) {
    lines.push(`| ${band} | ${bands.get(band) || 0} |`);
  }
  lines.push("");

  lines.push(`## Human-query pages — positions ${WINNABLE[0]}–${WINNABLE[1]}, ≥${MIN_HUMAN_IMPR} impressions`);
  lines.push("");
  if (!winnable.length) {
    lines.push("None in the current query-page export.");
  } else {
    lines.push("| Page | Pos | Human impr | Clicks | Top human queries |");
    lines.push("|---|--:|--:|--:|---|");
    for (const page of winnable) {
      const queries = page.queries
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 3)
        .map((entry) => entry.query)
        .join("; ");
      lines.push(`| ${markdownCell(page.page.replace(SITE, ""))} | ${page.position.toFixed(1)} | ${page.humanImpressions.toFixed(0)} | ${page.humanClicks.toFixed(0)} | ${markdownCell(queries)} |`);
    }
  }
  lines.push("");

  lines.push("## Human head-term tracking");
  lines.push("");
  lines.push("| Query | Pos | Impr | Clicks |");
  lines.push("|---|--:|--:|--:|");
  for (const row of humanQueries.slice(0, 20)) {
    lines.push(`| ${markdownCell(row.query)} | ${row.position.toFixed(1)} | ${row.impressions.toFixed(0)} | ${row.clicks.toFixed(0)} |`);
  }
  lines.push("");

  for (const [heading, name] of [["Device", "device"], ["Country", "country"]]) {
    lines.push(`## ${heading} performance`);
    lines.push("");
    lines.push(`| ${heading} | Impressions | Clicks | CTR | Pos |`);
    lines.push("|---|--:|--:|--:|--:|");
    for (const row of topDimensionRows(analytics[name].rows)) {
      lines.push(`| ${markdownCell(row.keys?.[0] || "unknown")} | ${Number(row.impressions || 0).toFixed(0)} | ${Number(row.clicks || 0).toFixed(0)} | ${(100 * Number(row.ctr || 0)).toFixed(2)}% | ${Number(row.position || 0).toFixed(1)} |`);
    }
    lines.push("");
  }

  lines.push("## URL Inspection indexing status");
  lines.push("");
  if (!indexing) {
    lines.push("Not collected in this run. Use `--inspect-indexing` for GSC-observed URLs, optionally with `--inspection-urls documentation/quality/inventory-quality-report.json`.");
  } else {
    const verdicts = countBy(indexing.results, (entry) => (
      entry.inspectionResult?.indexStatusResult?.verdict || "UNKNOWN"
    ));
    lines.push(`Inspected ${indexing.results.length} URLs; ${indexing.errors.length} failed.`);
    lines.push("");
    lines.push("| Verdict | URLs |");
    lines.push("|---|--:|");
    for (const verdict of ["PASS", "NEUTRAL", "FAIL", "VERDICT_UNSPECIFIED", "UNKNOWN"]) {
      if (verdicts.get(verdict)) lines.push(`| ${verdict} | ${verdicts.get(verdict)} |`);
    }
  }
  lines.push("");

  lines.push(`## Malformed titles — ${flagged.length} flagged`);
  lines.push("");
  if (kvWarning) {
    lines.push(`Title scan unavailable: ${markdownCell(kvWarning)}`);
  } else if (!flagged.length) {
    lines.push("None. All published titles pass the objective checks.");
  } else {
    lines.push("| Slug | Issue(s) | Title |");
    lines.push("|---|---|---|");
    for (const item of flagged) {
      lines.push(`| \`${item.slug}\` | ${markdownCell(item.issues.join("; "))} | ${markdownCell(item.title)} |`);
    }
  }
  lines.push("");
  lines.push("This report is read-only. It does not authorize production title, content, URL, canonical, indexability, or KV changes.");
  lines.push("");
  return lines.join("\n");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const secrets = parseEnvFile(join(ROOT, ".secrets"));
  const cfEnv = parseEnvFile(join(ROOT, "youtube-upload/.env"));
  const generatedAt = new Date().toISOString();
  const requestedEnd = new Date();
  const requestedStart = new Date(
    requestedEnd.getTime() - (WINDOW_DAYS - 1) * 86_400_000,
  );
  const iso = (date) => date.toISOString().slice(0, 10);

  const { token, mode } = await getAccessToken(secrets);
  console.log(`GSC token: ${mode}`);
  const analytics = await exportSearchAnalytics(token, {
    startDate: iso(requestedStart),
    endDate: iso(requestedEnd),
    generatedAt,
  });

  let indexing = null;
  if (options.inspectIndexing) {
    const pageUrls = analytics.pages.rows.map((row) => row?.keys?.[0]);
    const suppliedUrls = loadInspectionUrls(options.inspectionUrls);
    indexing = await collectUrlInspection(token, [...pageUrls, ...suppliedUrls], {
      limit: options.inspectionLimit,
      generatedAt,
    });
  }

  let flagged = [];
  let kvWarning = "";
  if (!options.skipKv) {
    try {
      const index = await readKvIndex(cfEnv);
      flagged = (Array.isArray(index) ? index : [])
        .map((entry) => ({
          slug: entry.slug,
          title: entry.title,
          issues: classifyTitle(entry.title),
        }))
        .filter((entry) => entry.issues.length);
    } catch (error) {
      kvWarning = error.message;
      console.warn(`! title scan skipped: ${kvWarning}`);
    }
  } else {
    kvWarning = "skipped by --skip-kv";
  }

  const outDir = join(ROOT, "documentation/gsc");
  mkdirSync(outDir, { recursive: true });
  for (const dataset of DATASETS) {
    writeJson(join(outDir, `${dataset.name}-raw.json`), analytics[dataset.name]);
  }
  if (indexing) writeJson(join(outDir, "indexing-raw.json"), indexing);

  const report = buildReport({
    analytics,
    flagged,
    kvWarning,
    tokenMode: mode,
    indexing,
  });
  const reportDate = analytics.dates.export.availableEndDate;
  writeFileSync(join(outDir, "weekly-report.md"), report);
  writeFileSync(join(outDir, `weekly-${reportDate}.md`), report);

  const aggregate = aggregateQueryPage(analytics["query-page"].rows);
  const winnable = [...aggregate.perPage.values()].filter((page) => {
    const position = page.humanImpressions
      ? page.positionSum / page.humanImpressions
      : null;
    return page.humanImpressions >= MIN_HUMAN_IMPR &&
      position >= WINNABLE[0] &&
      position <= WINNABLE[1];
  });
  console.log("");
  console.log(`GSC finalized window: ${analytics.dates.export.availableStartDate} → ${analytics.dates.export.availableEndDate}`);
  console.log(`Query-page rows: ${analytics["query-page"].rows.length}`);
  console.log(`Known human impressions: ${aggregate.humanImpressions.toFixed(0)}`);
  console.log(`Known bot/agent impressions: ${aggregate.botImpressions.toFixed(0)}`);
  console.log(`Winnable human pages: ${winnable.length}`);
  console.log(`URL inspections: ${indexing ? indexing.results.length : "not requested"}`);
  console.log(`Malformed titles: ${kvWarning ? "unavailable" : flagged.length}`);
  console.log(`Report: ${join(outDir, "weekly-report.md")}`);
}

const isCli = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error("ERROR:", error.message);
    if (/\b401\b/.test(error.message)) {
      console.error(
        "Google OAuth access has expired. Reauthorize read-only Search Console access or add the matching OAuth client secret for the stored refresh token.",
      );
    }
    process.exitCode = 1;
  });
}

export {
  aggregateQueryPage,
  buildReport,
  classifyTitle,
  collectUrlInspection,
  exportSearchAnalytics,
  getAccessToken,
  isBotQuery,
  loadInspectionUrls,
  normalizeInspectionUrl,
  parseArgs,
  positionBand,
  queryAllSearchAnalyticsRows,
};
