#!/usr/bin/env node
/**
 * Read-only entity indexability impact audit.
 *
 * Reads entity-index-v1 and entity-v1:{type}:{slug} from production BLOG_AI_KV
 * through Cloudflare's GET-only REST endpoint. It never calls public page
 * routes and never writes KV, sitemaps, robots directives, or page content.
 *
 * Outputs (gitignored):
 *   documentation/quality/entity-indexability-report.md
 *   documentation/quality/entity-indexability-report.json
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://thisday.info";
const BLOG_KV_NAMESPACE = "5173c34a7bd04cde9988c0e89d77bb6e";
const DEFAULT_OUTPUT_DIR = join(ROOT, "documentation/quality");
const INDEXING_CACHE_PATH = join(ROOT, "documentation/gsc/indexing-raw.json");
const PERSON_MIN_WORDS = 150;
const HISTORY_MIN_WORDS = 300;

function parseEnvFile(path) {
  const output = {};
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return output;
  }
  for (const line of raw.split(/\r?\n/)) {
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
    outputDir: DEFAULT_OUTPUT_DIR,
    limit: 0,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") options.outputDir = resolve(argv[++index] || "");
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (
    options.limit &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("--limit must be a positive integer.");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/entity-indexability-audit.js [options]

Options:
  --out-dir PATH   Local report directory.
  --limit N        Audit only the first N entity index entries.
  -h, --help       Show this help.

All production operations are Cloudflare KV GET requests only.`);
}

async function readKvValue(env, key, fetchImpl = fetch) {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  }
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/storage/kv/namespaces/${BLOG_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Cloudflare KV GET failed for ${key}: ${response.status}`);
  }
  return response.text();
}

async function mapLimit(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return output;
}

function entityBodyWordCount(entity) {
  return (Array.isArray(entity?.bodySections) ? entity.bodySections : [])
    .flatMap((section) =>
      Array.isArray(section?.paragraphs) ? section.paragraphs : [],
    )
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function isDirectWikipediaArticleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      ["en.wikipedia.org", "www.en.wikipedia.org"].includes(url.hostname.toLowerCase()) &&
      /^\/wiki\/[^/]+/.test(url.pathname) &&
      !/:/.test(decodeURIComponent(url.pathname.slice("/wiki/".length)))
    );
  } catch {
    return false;
  }
}

function historySlugQualityIssue(slug) {
  const value = String(slug || "").trim();
  if (!value) return "missing slug";
  if (/^article-\d+$/i.test(value)) return "generic article-number slug";
  if (/(?:^|-)(?:launch-?){2,}(?:-|$)/i.test(value)) {
    return "repeated launch token";
  }
  if (value.length > 110) return "overlong slug";
  return "";
}

function evaluateEntityIndexability(entity, indexEntry = {}) {
  const type = entity?.type || indexEntry?.type || "";
  const wordCount = entityBodyWordCount(entity);
  const reasons = [];
  if (!entity) reasons.push("missing stored entity record");
  if (type === "person") {
    if (wordCount < PERSON_MIN_WORDS) {
      reasons.push(`body below ${PERSON_MIN_WORDS} words`);
    }
    if (!isDirectWikipediaArticleUrl(entity?.wikiUrl || indexEntry?.wikiUrl)) {
      reasons.push("missing direct Wikipedia biography");
    }
    if (
      entity?.profileLinkEligible !== true ||
      entity?.profileSubjectVerified !== true
    ) {
      reasons.push("person identity not verified");
    }
  } else if (type === "event") {
    const name = String(entity?.name || indexEntry?.name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (wordCount < HISTORY_MIN_WORDS) {
      reasons.push(`body below ${HISTORY_MIN_WORDS} words`);
    }
    if (!isDirectWikipediaArticleUrl(entity?.wikiUrl || indexEntry?.wikiUrl)) {
      reasons.push("missing direct Wikipedia event/source page");
    }
    if (!name || name.length > 96) reasons.push("missing or overlong event name");
    const slugIssue = historySlugQualityIssue(entity?.slug || indexEntry?.slug);
    if (slugIssue) reasons.push(slugIssue);
    const relatedPosts = Array.isArray(entity?.relatedPosts)
      ? entity.relatedPosts
      : (Array.isArray(indexEntry?.relatedPosts) ? indexEntry.relatedPosts : []);
    if (relatedPosts.length < 1) reasons.push("no related article");
  } else {
    reasons.push("unsupported entity type");
  }
  if (entity?.needsWikiRefresh || indexEntry?.needsWikiRefresh) {
    reasons.push("still marked for source refresh");
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    wordCount,
  };
}

function loadIndexingCache() {
  let document;
  try {
    document = JSON.parse(readFileSync(INDEXING_CACHE_PATH, "utf8"));
  } catch {
    return new Map();
  }
  return new Map((Array.isArray(document.results) ? document.results : []).map((entry) => [
    entry.url,
    entry.inspectionResult?.indexStatusResult?.coverageState || "Unknown",
  ]));
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function buildReport(rows, generatedAt) {
  const byType = countBy(rows, (row) => row.type);
  const eligibleByType = countBy(
    rows.filter((row) => row.recommendedEligible),
    (row) => row.type,
  );
  const legacyTrue = rows.filter((row) => row.currentIndexable === true);
  const wouldExclude = legacyTrue.filter((row) => !row.recommendedEligible);
  const protectedIndexed = wouldExclude.filter(
    (row) => row.googleCoverage === "Submitted and indexed",
  );
  const missingRecords = rows.filter((row) => !row.recordFound);
  const reasonCounts = countBy(
    rows.flatMap((row) => row.reasons),
    (reason) => reason,
  );

  const lines = [];
  lines.push(`# Entity Indexability Impact Report — ${generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push("This is a read-only impact report. It used Cloudflare KV GET requests only and did not call public entity routes or modify KV, sitemaps, robots directives, entity pages, or article HTML.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- ${rows.length} entity index entries audited.`);
  lines.push(`- ${rows.filter((row) => row.recommendedEligible).length} pass the proposed substantive quality gate.`);
  lines.push(`- ${wouldExclude.length} currently indexable entries would fail the proposed gate.`);
  lines.push(`- ${protectedIndexed.length} failing entries are currently reported as indexed by Google and must be protected for manual review.`);
  lines.push(`- ${missingRecords.length} index entries have no readable stored entity record.`);
  lines.push("");
  lines.push("| Type | Audited | Pass proposed gate | Currently indexable |");
  lines.push("|---|--:|--:|--:|");
  for (const type of ["person", "event", "unknown"]) {
    const total = byType.get(type) || 0;
    if (!total) continue;
    lines.push(`| ${type} | ${total} | ${eligibleByType.get(type) || 0} | ${rows.filter((row) => row.type === type && row.currentIndexable).length} |`);
  }
  lines.push("");
  lines.push("## Failure reasons");
  lines.push("");
  lines.push("| Reason | Entities |");
  lines.push("|---|--:|");
  for (const [reason, count] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${markdownCell(reason)} | ${count} |`);
  }
  lines.push("");
  lines.push("## Currently indexed pages that fail the proposed gate");
  lines.push("");
  if (!protectedIndexed.length) {
    lines.push("None in the current URL Inspection cache.");
  } else {
    lines.push("| URL | Type | Words | Failure reason(s) |");
    lines.push("|---|---|--:|---|");
    for (const row of protectedIndexed) {
      lines.push(`| ${markdownCell(row.url.replace(SITE, ""))} | ${row.type} | ${row.wordCount} | ${markdownCell(row.reasons.join("; "))} |`);
    }
  }
  lines.push("");
  lines.push("## Current sitemap entries that would be excluded");
  lines.push("");
  if (!wouldExclude.length) {
    lines.push("None.");
  } else {
    lines.push("| URL | Type | Google coverage | Words | Failure reason(s) |");
    lines.push("|---|---|---|--:|---|");
    for (const row of wouldExclude) {
      lines.push(`| ${markdownCell(row.url.replace(SITE, ""))} | ${row.type} | ${markdownCell(row.googleCoverage)} | ${row.wordCount} | ${markdownCell(row.reasons.join("; "))} |`);
    }
  }
  lines.push("");
  lines.push("## Safety recommendation");
  lines.push("");
  lines.push("- Apply the stronger gate automatically to newly created entities.");
  lines.push("- Keep legacy index entries backward-compatible until their stored record has been audited.");
  lines.push("- Never automatically noindex or remove a URL that Google currently reports as indexed; queue it for manual source and content review.");
  lines.push("- Do not deploy or run a production backfill from this report without separate approval.");
  lines.push("");
  return lines.join("\n");
}

async function runAudit(options = {}) {
  const env = parseEnvFile(join(ROOT, "youtube-upload/.env"));
  const indexRaw = await readKvValue(env, "entity-index-v1");
  if (!indexRaw) throw new Error("Production entity-index-v1 was not found.");
  const fullIndex = JSON.parse(indexRaw);
  const index = (Array.isArray(fullIndex) ? fullIndex : [])
    .filter((entry) => entry?.type && entry?.slug)
    .slice(0, options.limit || undefined);
  const indexing = loadIndexingCache();
  const rows = await mapLimit(index, 8, async (entry, rowIndex) => {
    const key = `entity-v1:${entry.type}:${entry.slug}`;
    const raw = await readKvValue(env, key);
    let entity = null;
    try {
      entity = raw ? JSON.parse(raw) : null;
    } catch {
      entity = null;
    }
    const evaluation = evaluateEntityIndexability(entity, entry);
    const url = `${SITE}${entry.url || (entry.type === "person" ? `/people/${entry.slug}/` : `/history/${entry.slug}/`)}`;
    if ((rowIndex + 1) % 50 === 0) {
      console.log(`Read ${rowIndex + 1}/${index.length} entity records (GET only)…`);
    }
    return {
      type: entry.type,
      slug: entry.slug,
      name: entry.name || entity?.name || "",
      url,
      recordFound: Boolean(entity),
      currentIndexable: entry.indexable === true,
      recommendedEligible: evaluation.eligible,
      wordCount: evaluation.wordCount,
      reasons: evaluation.reasons,
      googleCoverage: indexing.get(url) || "Not inspected",
      relatedPosts: Array.isArray(entity?.relatedPosts)
        ? entity.relatedPosts.length
        : (Array.isArray(entry.relatedPosts) ? entry.relatedPosts.length : 0),
      needsWikiRefresh: Boolean(entity?.needsWikiRefresh || entry.needsWikiRefresh),
    };
  });

  const generatedAt = new Date().toISOString();
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  mkdirSync(outputDir, { recursive: true });
  const markdownPath = join(outputDir, "entity-indexability-report.md");
  const jsonPath = join(outputDir, "entity-indexability-report.json");
  writeFileSync(markdownPath, buildReport(rows, generatedAt));
  writeFileSync(jsonPath, `${JSON.stringify({ generatedAt, productionWrites: 0, publicPageFetches: 0, rows }, null, 2)}\n`);
  return { rows, markdownPath, jsonPath };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const result = await runAudit(options);
  console.log("");
  console.log("Read-only entity indexability audit complete.");
  console.log(`Entities: ${result.rows.length}`);
  console.log(`Pass proposed gate: ${result.rows.filter((row) => row.recommendedEligible).length}`);
  console.log(`Production writes: 0; public page fetches: 0`);
  console.log(`Report: ${result.markdownPath}`);
}

const isCli = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error("ERROR:", error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  buildReport,
  entityBodyWordCount,
  evaluateEntityIndexability,
  historySlugQualityIssue,
  isDirectWikipediaArticleUrl,
  runAudit,
};
