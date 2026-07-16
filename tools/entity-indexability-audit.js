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
 *   documentation/quality/entity-migration-batch-plan.md
 *   documentation/quality/entity-migration-batch-plan.json
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://thisday.info";
const BLOG_KV_NAMESPACE = "5173c34a7bd04cde9988c0e89d77bb6e";
const DEFAULT_OUTPUT_DIR = join(ROOT, "documentation/quality");
const INDEXING_CACHE_PATH = join(ROOT, "documentation/gsc/indexing-raw.json");
const PERSON_MIN_WORDS = 150;
const HISTORY_MIN_WORDS = 300;
const QUALITY_GATE_VERSION = 1;

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
    planSize: 0,
    verifyPlan: "",
    applyPlan: "",
    confirmProductionWrite: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") options.outputDir = resolve(argv[++index] || "");
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--plan-size") options.planSize = Number(argv[++index]);
    else if (arg === "--verify-plan") {
      options.verifyPlan = resolve(argv[++index] || "");
    }
    else if (arg === "--apply-plan") {
      options.applyPlan = resolve(argv[++index] || "");
    }
    else if (arg === "--confirm-production-write") {
      options.confirmProductionWrite = true;
    }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (
    options.limit &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("--limit must be a positive integer.");
  }
  if (
    options.planSize &&
    (!Number.isInteger(options.planSize) || options.planSize < 1 || options.planSize > 50)
  ) {
    throw new Error("--plan-size must be an integer from 1 to 50.");
  }
  if (options.verifyPlan && options.applyPlan) {
    throw new Error("--verify-plan and --apply-plan cannot be combined.");
  }
  if (
    (options.verifyPlan || options.applyPlan) &&
    (options.limit || options.planSize)
  ) {
    throw new Error("Audit/plan creation flags cannot be combined with plan execution.");
  }
  if (options.applyPlan && !options.confirmProductionWrite) {
    throw new Error("--apply-plan requires --confirm-production-write.");
  }
  if (
    options.confirmProductionWrite &&
    !options.applyPlan
  ) {
    throw new Error(
      "--confirm-production-write requires --apply-plan PATH.",
    );
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/entity-indexability-audit.js [options]

Options:
  --out-dir PATH   Local report directory.
  --limit N        Audit only the first N entity index entries.
  --plan-size N    Build an exact GET-only migration plan for N safe legacy entries.
  --verify-plan PATH
                   Re-read live KV, recheck sources and hashes, and create
                   local backups without writing production.
  --apply-plan PATH
                   Apply a fully verified migration plan to production KV.
  --confirm-production-write
                   Required explicit acknowledgement for --apply-plan.
  -h, --help       Show this help.

Audit, planning, and verification modes use Cloudflare KV GET requests only.
Production writes are available only through separately confirmed apply mode.`);
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

async function writeKvValue(env, key, value, fetchImpl = fetch) {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  }
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/storage/kv/namespaces/${BLOG_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: value,
  });
  if (!response.ok) {
    throw new Error(`Cloudflare KV PUT failed for ${key}: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  if (payload?.success === false) {
    throw new Error(`Cloudflare KV PUT was rejected for ${key}`);
  }
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

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function googleCoverageRiskRank(value) {
  const coverage = String(value || "");
  if (coverage === "Submitted and indexed") return 3;
  if (/crawled|discovered/i.test(coverage)) return 2;
  if (/unknown|not inspected/i.test(coverage)) return 1;
  return 2;
}

function isMigrationCandidate(
  { row, entity, entry },
  { requireSourceVerification = false } = {},
) {
  return Boolean(
    row.recordFound &&
    row.currentIndexable === true &&
    row.recommendedEligible === true &&
    (!requireSourceVerification || row.sourceVerification?.verified === true) &&
    (
      entity?.qualityGateVersion !== QUALITY_GATE_VERSION ||
      entry?.qualityGateVersion !== QUALITY_GATE_VERSION ||
      (row.type === "event" && entry?.historyLinkEligible !== true)
    )
  );
}

function selectMigrationBatch(
  auditedEntries,
  planSize,
  { requireSourceVerification = false } = {},
) {
  if (!planSize) return [];
  const candidates = auditedEntries
    .filter((entry) =>
      isMigrationCandidate(entry, { requireSourceVerification }),
    )
    .sort((left, right) =>
      googleCoverageRiskRank(left.row.googleCoverage) -
        googleCoverageRiskRank(right.row.googleCoverage) ||
      left.row.url.localeCompare(right.row.url),
    );

  const byType = new Map([
    ["person", candidates.filter(({ row }) => row.type === "person")],
    ["event", candidates.filter(({ row }) => row.type === "event")],
  ]);
  const selected = [];
  while (selected.length < planSize) {
    let added = false;
    for (const type of ["person", "event"]) {
      const next = byType.get(type)?.shift();
      if (!next) continue;
      selected.push(next);
      added = true;
      if (selected.length >= planSize) break;
    }
    if (!added) break;
  }
  return selected;
}

function wikipediaTitleFromUrl(value) {
  try {
    const path = new URL(String(value || "")).pathname;
    const encodedTitle = path.split("/wiki/")[1] || "";
    return decodeURIComponent(encodedTitle).replace(/_/g, " ").trim();
  } catch {
    return "";
  }
}

async function verifyWikipediaSourcePages(
  auditedEntries,
  fetchImpl = fetch,
) {
  const sources = new Map();
  for (const { entity, entry } of auditedEntries) {
    const wikiUrl = entity?.wikiUrl || entry?.wikiUrl || "";
    const requestedTitle = wikipediaTitleFromUrl(wikiUrl);
    if (wikiUrl && requestedTitle) {
      sources.set(wikiUrl, requestedTitle);
    }
  }

  const results = new Map();
  let requestCount = 0;
  const sourceEntries = [...sources.entries()];
  // MediaWiki's extracts module returns at most 20 pages per request for
  // non-bot clients. Larger title batches silently omit later extracts and
  // would misclassify substantive pages as thin.
  for (let offset = 0; offset < sourceEntries.length; offset += 20) {
    const chunk = sourceEntries.slice(offset, offset + 20);
    const requestedTitles = chunk.map(([, title]) => title);
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      redirects: "1",
      prop: "pageprops|extracts",
      exintro: "1",
      explaintext: "1",
      exlimit: "max",
      titles: requestedTitles.join("|"),
    });
    requestCount += 1;
    const response = await fetchImpl(
      `https://en.wikipedia.org/w/api.php?${params}`,
      {
        headers: {
          "User-Agent":
            "thisDay.info entity migration audit (kapetanovic.armin@gmail.com)",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Wikipedia source verification failed: HTTP ${response.status}`,
      );
    }
    const payload = await response.json();
    const normalized = new Map(
      (payload.query?.normalized || []).map((item) => [item.from, item.to]),
    );
    const redirects = new Map(
      (payload.query?.redirects || []).map((item) => [item.from, item.to]),
    );
    const pages = new Map(
      (payload.query?.pages || []).map((page) => [page.title, page]),
    );
    const resolveTitle = (title) => {
      let resolved = normalized.get(title) || title;
      resolved = redirects.get(resolved) || resolved;
      return resolved;
    };

    for (const [wikiUrl, requestedTitle] of chunk) {
      const resolvedTitle = resolveTitle(requestedTitle);
      const page = pages.get(resolvedTitle);
      const pageExists = Boolean(page && page.missing !== true);
      const disambiguation = Boolean(
        page?.pageprops &&
        Object.prototype.hasOwnProperty.call(
          page.pageprops,
          "disambiguation",
        ),
      );
      const extractWordCount = String(page?.extract || "")
        .split(/\s+/)
        .filter(Boolean).length;
      const reasons = [];
      if (!pageExists) reasons.push("Wikipedia source page is missing");
      if (disambiguation) {
        reasons.push("Wikipedia source resolves to a disambiguation page");
      }
      if (pageExists && extractWordCount < 25) {
        reasons.push("Wikipedia source summary is too thin");
      }
      results.set(wikiUrl, {
        verified: reasons.length === 0,
        requestedTitle,
        resolvedTitle,
        pageExists,
        disambiguation,
        extractWordCount,
        reasons,
      });
    }
  }

  return { results, requestCount };
}

function buildMigrationPlan(
  auditedEntries,
  fullIndex,
  indexRaw,
  planSize,
  generatedAt,
  { requireSourceVerification = false, sourceVerificationRequests = 0 } = {},
) {
  const selected = selectMigrationBatch(auditedEntries, planSize, {
    requireSourceVerification,
  });
  const selectedById = new Map(
    selected.map(({ row }) => [`${row.type}:${row.slug}`, true]),
  );
  const proposedIndex = fullIndex.map((entry) => {
    const id = `${entry?.type}:${entry?.slug}`;
    if (!selectedById.has(id)) return entry;
    return {
      ...entry,
      indexable: true,
      qualityGateVersion: QUALITY_GATE_VERSION,
      ...(entry.type === "event" ? { historyLinkEligible: true } : {}),
    };
  });
  const proposedIndexRaw = JSON.stringify(proposedIndex);
  const protectedIndexedFailures = auditedEntries
    .filter(({ row }) =>
      row.currentIndexable === true &&
      row.recommendedEligible === false &&
      row.googleCoverage === "Submitted and indexed",
    )
    .map(({ row }) => ({
      type: row.type,
      slug: row.slug,
      url: row.url,
      reasons: row.reasons,
    }));
  const sourceRejectedCandidates = auditedEntries
    .filter(({ row }) =>
      row.currentIndexable === true &&
      row.recommendedEligible === true &&
      row.sourceVerification?.verified === false,
    )
    .map(({ row }) => ({
      type: row.type,
      slug: row.slug,
      url: row.url,
      sourceVerification: row.sourceVerification,
    }));

  const items = selected.map(({ row, entity, entry, entityRaw }) => {
    const entityAfter = {
      ...entity,
      qualityGateVersion: QUALITY_GATE_VERSION,
    };
    const indexAfter = {
      ...entry,
      indexable: true,
      qualityGateVersion: QUALITY_GATE_VERSION,
      ...(row.type === "event" ? { historyLinkEligible: true } : {}),
    };
    const entityAfterRaw = JSON.stringify(entityAfter);
    return {
      type: row.type,
      slug: row.slug,
      name: row.name,
      url: row.url,
      googleCoverage: row.googleCoverage,
      wordCount: row.wordCount,
      reasons: row.reasons,
      sourceVerification: row.sourceVerification || null,
      eligibilityBefore: true,
      eligibilityAfter: true,
      robotsBefore: "index, follow, max-image-preview:large",
      robotsAfter: "index, follow, max-image-preview:large",
      entityKey: `entity-v1:${row.type}:${row.slug}`,
      entityBeforeSha256: sha256(entityRaw),
      entityAfterSha256: sha256(entityAfterRaw),
      entityBefore: entity,
      entityAfter,
      indexBefore: entry,
      indexAfter,
    };
  });

  return {
    generatedAt,
    productionWrites: 0,
    sourceVerificationRequests,
    selectionPolicy: {
      requestedSize: planSize,
      selectedSize: items.length,
      qualityGateVersion: QUALITY_GATE_VERSION,
      requirements: [
        "stored entity record exists",
        "legacy entry is currently indexable",
        "record already passes the stronger quality gate",
        "Wikipedia source resolves to a substantive non-disambiguation page",
        "migration does not change page robots or sitemap eligibility",
        "indexed failures are excluded",
      ],
    },
    protectedIndexedFailures,
    sourceRejectedCandidates,
    sharedIndex: {
      key: "entity-index-v1",
      beforeSha256: sha256(indexRaw),
      afterSha256: sha256(proposedIndexRaw),
      beforeEntryCount: fullIndex.length,
      afterEntryCount: proposedIndex.length,
      changedEntries: items.length,
      proposedValue: proposedIndex,
    },
    items,
  };
}

function buildMigrationPlanMarkdown(plan) {
  const lines = [];
  lines.push(`# Legacy Entity Migration Batch Plan — ${plan.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push("This plan is GET-only. It made no production writes and does not authorize an apply operation.");
  lines.push("");
  lines.push("## Batch safety contract");
  lines.push("");
  lines.push(`- ${plan.items.length} legacy records selected.`);
  lines.push("- Every selected record already passes the stronger entity quality gate.");
  lines.push("- Every selected source resolves to a substantive, non-disambiguation Wikipedia page.");
  lines.push("- Every selected page remains indexable before and after the proposed marker migration.");
  lines.push("- The plan adds only the versioned quality-gate fields required by the current Workers.");
  lines.push(`- ${plan.protectedIndexedFailures.length} indexed failures are excluded and remain protected.`);
  lines.push(`- ${plan.sourceRejectedCandidates.length} deterministic-pass candidates were excluded after live source verification.`);
  lines.push("- Any future apply must re-read each entity and the shared index, verify the recorded SHA-256 values, back up all values, and abort on any mismatch.");
  lines.push("");
  lines.push("## Proposed batch");
  lines.push("");
  lines.push("| URL | Type | Google coverage | Words | Proposed fields | Robots |");
  lines.push("|---|---|---|--:|---|---|");
  for (const item of plan.items) {
    const fields = item.type === "event"
      ? "qualityGateVersion=1; index.historyLinkEligible=true"
      : "qualityGateVersion=1";
    lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${item.type} | ${markdownCell(item.googleCoverage)} | ${item.wordCount} | ${fields} | unchanged: index,follow |`);
  }
  lines.push("");
  lines.push("## Source-verification exclusions");
  lines.push("");
  if (!plan.sourceRejectedCandidates.length) {
    lines.push("None.");
  } else {
    lines.push("| URL | Resolved source | Reason(s) |");
    lines.push("|---|---|---|");
    for (const item of plan.sourceRejectedCandidates) {
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${markdownCell(item.sourceVerification.resolvedTitle)} | ${markdownCell(item.sourceVerification.reasons.join("; "))} |`);
    }
  }
  lines.push("");
  lines.push("## Protected indexed failures");
  lines.push("");
  if (!plan.protectedIndexedFailures.length) {
    lines.push("None.");
  } else {
    lines.push("| URL | Failure reason(s) |");
    lines.push("|---|---|");
    for (const item of plan.protectedIndexedFailures) {
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${markdownCell(item.reasons.join("; "))} |`);
    }
  }
  lines.push("");
  lines.push("## Shared-index precondition");
  lines.push("");
  lines.push(`- Before SHA-256: \`${plan.sharedIndex.beforeSha256}\``);
  lines.push(`- Proposed after SHA-256: \`${plan.sharedIndex.afterSha256}\``);
  lines.push(`- Entry count remains ${plan.sharedIndex.beforeEntryCount}.`);
  lines.push("");
  lines.push("Full entity and index before/after JSON is stored in the timestamped `plan.json` beside this report.");
  lines.push("");
  return lines.join("\n");
}

function assertExactMigrationPlan(plan) {
  if (
    !plan ||
    plan.productionWrites !== 0 ||
    !Array.isArray(plan.items) ||
    plan.items.length < 1 ||
    plan.items.length > 10
  ) {
    throw new Error(
      "Migration plan must be a GET-only batch containing 1 to 10 entities.",
    );
  }
  if (
    plan.sharedIndex?.key !== "entity-index-v1" ||
    !Array.isArray(plan.sharedIndex?.proposedValue) ||
    plan.sharedIndex.beforeEntryCount !== plan.sharedIndex.afterEntryCount ||
    plan.sharedIndex.changedEntries !== plan.items.length
  ) {
    throw new Error("Migration plan has an invalid shared-index contract.");
  }
  const proposedIndexRaw = JSON.stringify(plan.sharedIndex.proposedValue);
  if (sha256(proposedIndexRaw) !== plan.sharedIndex.afterSha256) {
    throw new Error("Migration plan shared-index after-hash is invalid.");
  }

  const ids = new Set();
  for (const item of plan.items) {
    const expectedKey = `entity-v1:${item.type}:${item.slug}`;
    const id = `${item.type}:${item.slug}`;
    if (
      !["person", "event"].includes(item.type) ||
      !/^[a-z0-9-]+$/.test(item.slug || "") ||
      item.entityKey !== expectedKey ||
      ids.has(id)
    ) {
      throw new Error("Migration plan contains an unsafe or duplicate entity key.");
    }
    ids.add(id);
    if (
      item.sourceVerification?.verified !== true ||
      item.sourceVerification?.disambiguation === true ||
      item.eligibilityBefore !== true ||
      item.eligibilityAfter !== true ||
      item.robotsBefore !== item.robotsAfter
    ) {
      throw new Error(`${item.entityKey} does not satisfy the safe migration contract.`);
    }

    const expectedEntityAfter = {
      ...item.entityBefore,
      qualityGateVersion: QUALITY_GATE_VERSION,
    };
    const expectedIndexAfter = {
      ...item.indexBefore,
      indexable: true,
      qualityGateVersion: QUALITY_GATE_VERSION,
      ...(item.type === "event" ? { historyLinkEligible: true } : {}),
    };
    if (JSON.stringify(item.entityAfter) !== JSON.stringify(expectedEntityAfter)) {
      throw new Error(`${item.entityKey} proposes unsupported entity changes.`);
    }
    if (JSON.stringify(item.indexAfter) !== JSON.stringify(expectedIndexAfter)) {
      throw new Error(`${item.entityKey} proposes unsupported index changes.`);
    }
    if (sha256(JSON.stringify(item.entityAfter)) !== item.entityAfterSha256) {
      throw new Error(`${item.entityKey} has an invalid entity after-hash.`);
    }
  }
  return ids;
}

function validateSharedIndexProposal(plan, liveIndexRaw, selectedIds) {
  if (sha256(liveIndexRaw) !== plan.sharedIndex.beforeSha256) {
    throw new Error("entity-index-v1 live hash changed; refusing the batch.");
  }
  const liveIndex = JSON.parse(liveIndexRaw);
  const proposedIndex = plan.sharedIndex.proposedValue;
  if (
    !Array.isArray(liveIndex) ||
    liveIndex.length !== plan.sharedIndex.beforeEntryCount ||
    proposedIndex.length !== liveIndex.length
  ) {
    throw new Error("entity-index-v1 entry count changed; refusing the batch.");
  }
  const planItems = new Map(
    plan.items.map((item) => [`${item.type}:${item.slug}`, item]),
  );
  for (let index = 0; index < liveIndex.length; index += 1) {
    const liveEntry = liveIndex[index];
    const proposedEntry = proposedIndex[index];
    const id = `${liveEntry?.type}:${liveEntry?.slug}`;
    if (`${proposedEntry?.type}:${proposedEntry?.slug}` !== id) {
      throw new Error("entity-index-v1 order or identity changed in the proposal.");
    }
    if (selectedIds.has(id)) {
      const item = planItems.get(id);
      if (
        JSON.stringify(liveEntry) !== JSON.stringify(item.indexBefore) ||
        JSON.stringify(proposedEntry) !== JSON.stringify(item.indexAfter)
      ) {
        throw new Error(`${id} index entry no longer matches the migration plan.`);
      }
    } else if (JSON.stringify(liveEntry) !== JSON.stringify(proposedEntry)) {
      throw new Error(`${id} is an unrelated shared-index change.`);
    }
  }
}

async function verifyStoredHash(readKv, key, expectedSha256) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const stored = await readKv(key);
    if (sha256(stored) === expectedSha256) return true;
    if (attempt < 5) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, 1000),
      );
    }
  }
  return false;
}

async function executeMigrationPlan(
  planPath,
  {
    apply = false,
    confirmed = false,
    env = null,
    readKv = null,
    writeKv = null,
    sourceVerifier = verifyWikipediaSourcePages,
    generatedAt = new Date(),
  } = {},
) {
  if (apply && !confirmed) {
    throw new Error("Production entity migration requires explicit confirmation.");
  }
  const resolvedPlanPath = resolve(planPath || "");
  let planRaw;
  let plan;
  try {
    planRaw = readFileSync(resolvedPlanPath, "utf8");
    plan = JSON.parse(planRaw);
  } catch {
    throw new Error(`Entity migration plan could not be read: ${resolvedPlanPath}`);
  }
  const selectedIds = assertExactMigrationPlan(plan);
  const credentials =
    env || parseEnvFile(join(ROOT, "youtube-upload/.env"));
  const kvRead =
    readKv || ((key) => readKvValue(credentials, key));
  const kvWrite =
    writeKv || ((key, value) => writeKvValue(credentials, key, value));

  const sourceCheck = await sourceVerifier(
    plan.items.map((item) => ({
      entity: item.entityBefore,
      entry: item.indexBefore,
    })),
  );
  for (const item of plan.items) {
    const wikiUrl =
      item.entityBefore?.wikiUrl ||
      item.indexBefore?.wikiUrl ||
      "";
    const verification = sourceCheck.results.get(wikiUrl);
    if (!verification?.verified) {
      throw new Error(
        `${item.entityKey} source no longer passes verification.`,
      );
    }
  }

  // Complete preflight before creating backups or permitting the first write.
  const liveIndexRaw = await kvRead("entity-index-v1");
  if (liveIndexRaw == null) {
    throw new Error("entity-index-v1 is missing from live KV.");
  }
  validateSharedIndexProposal(plan, liveIndexRaw, selectedIds);
  const preflight = [];
  for (const item of plan.items) {
    const liveRaw = await kvRead(item.entityKey);
    if (liveRaw == null) {
      throw new Error(`${item.entityKey} is missing from live KV.`);
    }
    if (sha256(liveRaw) !== item.entityBeforeSha256) {
      throw new Error(`${item.entityKey} live hash changed; refusing the batch.`);
    }
    preflight.push({
      item,
      liveRaw,
      proposedRaw: JSON.stringify(item.entityAfter),
    });
  }

  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const operationDir = join(
    dirname(resolvedPlanPath),
    `entity-migration-${apply ? "apply" : "verify"}-${stamp}`,
  );
  const backupDir = join(operationDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const resultPath = join(operationDir, "result.json");
  const planSnapshotPath = join(operationDir, "plan.json");
  writeFileSync(planSnapshotPath, planRaw);
  const indexBackupPath = join(backupDir, "entity-index-v1.json");
  writeFileSync(indexBackupPath, liveIndexRaw);
  if (sha256(readFileSync(indexBackupPath, "utf8")) !== plan.sharedIndex.beforeSha256) {
    throw new Error("entity-index-v1 local backup verification failed.");
  }
  for (const { item, liveRaw } of preflight) {
    const backupPath = join(
      backupDir,
      `${item.type}-${item.slug}.json`,
    );
    writeFileSync(backupPath, liveRaw);
    if (sha256(readFileSync(backupPath, "utf8")) !== item.entityBeforeSha256) {
      throw new Error(`${item.entityKey} local backup verification failed.`);
    }
  }

  const result = {
    startedAt: generatedAt.toISOString(),
    planPath: resolvedPlanPath,
    planSnapshotPath,
    mode: apply
      ? "confirmed production entity migration"
      : "verification-only dry run",
    selectedEntities: plan.items.length,
    sourceVerificationRequests: sourceCheck.requestCount || 0,
    backupsCreated: plan.items.length + 1,
    productionWrites: 0,
    publicEntityPageFetches: 0,
    completed: [],
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  if (!apply) {
    result.verifiedAt = new Date().toISOString();
    result.readyForConfirmedApply = true;
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    return { operationDir, resultPath, ...result };
  }

  try {
    for (const { item, proposedRaw } of preflight) {
      const liveRaw = await kvRead(item.entityKey);
      if (sha256(liveRaw) !== item.entityBeforeSha256) {
        throw new Error(
          `${item.entityKey} changed after preflight; refusing this and later writes.`,
        );
      }
      const backupPath = join(
        backupDir,
        `${item.type}-${item.slug}.json`,
      );
      writeFileSync(backupPath, liveRaw);
      if (sha256(readFileSync(backupPath, "utf8")) !== item.entityBeforeSha256) {
        throw new Error(`${item.entityKey} immediate backup verification failed.`);
      }

      await kvWrite(item.entityKey, proposedRaw);
      result.productionWrites += 1;
      if (
        !(await verifyStoredHash(
          kvRead,
          item.entityKey,
          item.entityAfterSha256,
        ))
      ) {
        throw new Error(`${item.entityKey} after-hash could not be verified.`);
      }
      result.completed.push({
        key: item.entityKey,
        beforeSha256: item.entityBeforeSha256,
        afterSha256: item.entityAfterSha256,
        verified: true,
      });
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    }

    const latestIndexRaw = await kvRead("entity-index-v1");
    if (sha256(latestIndexRaw) !== plan.sharedIndex.beforeSha256) {
      throw new Error(
        "entity-index-v1 changed after preflight; refusing the final index write.",
      );
    }
    writeFileSync(indexBackupPath, latestIndexRaw);
    if (
      sha256(readFileSync(indexBackupPath, "utf8")) !==
      plan.sharedIndex.beforeSha256
    ) {
      throw new Error("entity-index-v1 immediate backup verification failed.");
    }
    const proposedIndexRaw = JSON.stringify(plan.sharedIndex.proposedValue);
    await kvWrite("entity-index-v1", proposedIndexRaw);
    result.productionWrites += 1;
    if (
      !(await verifyStoredHash(
        kvRead,
        "entity-index-v1",
        plan.sharedIndex.afterSha256,
      ))
    ) {
      throw new Error("entity-index-v1 after-hash could not be verified.");
    }
    result.completed.push({
      key: "entity-index-v1",
      beforeSha256: plan.sharedIndex.beforeSha256,
      afterSha256: plan.sharedIndex.afterSha256,
      verified: true,
    });
  } catch (error) {
    result.failedAt = new Date().toISOString();
    result.failure = error.message;
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    error.applyResultPath = resultPath;
    throw error;
  }

  result.completedAt = new Date().toISOString();
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { operationDir, resultPath, ...result };
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
  const auditedEntries = await mapLimit(index, 8, async (entry, rowIndex) => {
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
      entry,
      entity,
      entityRaw: raw,
      row: {
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
        entityQualityGateVersion: entity?.qualityGateVersion || null,
        indexQualityGateVersion: entry?.qualityGateVersion || null,
      },
    };
  });
  const rows = auditedEntries.map(({ row }) => row);
  let sourceVerificationRequests = 0;
  if (options.planSize) {
    const sourceCandidates = auditedEntries.filter((entry) =>
      isMigrationCandidate(entry),
    );
    const verification = await verifyWikipediaSourcePages(sourceCandidates);
    sourceVerificationRequests = verification.requestCount;
    for (const candidate of sourceCandidates) {
      const wikiUrl =
        candidate.entity?.wikiUrl ||
        candidate.entry?.wikiUrl ||
        "";
      candidate.row.sourceVerification =
        verification.results.get(wikiUrl) || {
          verified: false,
          requestedTitle: wikipediaTitleFromUrl(wikiUrl),
          resolvedTitle: "",
          pageExists: false,
          disambiguation: false,
          extractWordCount: 0,
          reasons: ["Wikipedia source could not be verified"],
        };
    }
  }

  const generatedAt = new Date().toISOString();
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  mkdirSync(outputDir, { recursive: true });
  const markdownPath = join(outputDir, "entity-indexability-report.md");
  const jsonPath = join(outputDir, "entity-indexability-report.json");
  writeFileSync(markdownPath, buildReport(rows, generatedAt));
  writeFileSync(
    jsonPath,
    `${JSON.stringify({
      generatedAt,
      productionWrites: 0,
      publicEntityPageFetches: 0,
      wikipediaSourceVerificationRequests: sourceVerificationRequests,
      rows,
    }, null, 2)}\n`,
  );
  let migrationPlan = null;
  let migrationPlanDir = "";
  let migrationPlanMarkdownPath = "";
  let migrationPlanJsonPath = "";
  if (options.planSize) {
    migrationPlan = buildMigrationPlan(
      auditedEntries,
      fullIndex,
      indexRaw,
      options.planSize,
      generatedAt,
      {
        requireSourceVerification: true,
        sourceVerificationRequests,
      },
    );
    const planStamp = generatedAt.replace(/[:.]/g, "-");
    migrationPlanDir = join(
      outputDir,
      `entity-migration-plan-${planStamp}`,
    );
    mkdirSync(migrationPlanDir, { recursive: true });
    migrationPlanMarkdownPath = join(migrationPlanDir, "plan.md");
    migrationPlanJsonPath = join(migrationPlanDir, "plan.json");
    writeFileSync(
      migrationPlanMarkdownPath,
      buildMigrationPlanMarkdown(migrationPlan),
    );
    writeFileSync(
      migrationPlanJsonPath,
      `${JSON.stringify(migrationPlan, null, 2)}\n`,
    );
  }
  return {
    rows,
    markdownPath,
    jsonPath,
    migrationPlan,
    migrationPlanDir,
    migrationPlanMarkdownPath,
    migrationPlanJsonPath,
    sourceVerificationRequests,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.verifyPlan || options.applyPlan) {
    const apply = Boolean(options.applyPlan);
    const result = await executeMigrationPlan(
      options.applyPlan || options.verifyPlan,
      {
        apply,
        confirmed: options.confirmProductionWrite,
      },
    );
    console.log("");
    console.log(
      apply
        ? "Confirmed entity migration complete."
        : "Entity migration verification complete.",
    );
    console.log(`Selected entities: ${result.selectedEntities}`);
    console.log(`Local backups: ${result.backupsCreated}`);
    console.log(`Production writes: ${result.productionWrites}`);
    console.log(`Result: ${result.resultPath}`);
    return;
  }
  const result = await runAudit(options);
  console.log("");
  console.log("Read-only entity indexability audit complete.");
  console.log(`Entities: ${result.rows.length}`);
  console.log(`Pass proposed gate: ${result.rows.filter((row) => row.recommendedEligible).length}`);
  console.log(`Production writes: 0; public page fetches: 0`);
  if (result.sourceVerificationRequests) {
    console.log(
      `Wikipedia source-verification requests: ${result.sourceVerificationRequests}`,
    );
  }
  console.log(`Report: ${result.markdownPath}`);
  if (result.migrationPlan) {
    console.log(`Safe migration batch: ${result.migrationPlan.items.length}`);
    console.log(`Plan: ${result.migrationPlanMarkdownPath}`);
  }
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
  buildMigrationPlan,
  buildMigrationPlanMarkdown,
  entityBodyWordCount,
  evaluateEntityIndexability,
  executeMigrationPlan,
  historySlugQualityIssue,
  isDirectWikipediaArticleUrl,
  runAudit,
  selectMigrationBatch,
  verifyWikipediaSourcePages,
};
