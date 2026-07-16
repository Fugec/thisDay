#!/usr/bin/env node
/**
 * Content inventory quality audit. Read-only by default.
 *
 * Production safety:
 *   - Reads BLOG_AI_KV through Cloudflare's GET-only REST value endpoint.
 *   - Never calls public Worker page routes, because some GET handlers can
 *     hydrate entities or repair stored HTML as a side effect.
 *   - Never writes KV, redirects, sitemaps, robots directives, or page HTML
 *     unless the explicit repair-plan apply command and confirmation flag are
 *     both supplied.
 *   - Writes generated reports only under the local documentation directory.
 *
 * Inputs:
 *   - BLOG_AI_KV `index`, `entity-index-v1`, and stored `post:{slug}` values.
 *   - Local legacy/static HTML and Worker route templates.
 *   - Cached GSC exports in documentation/gsc (staleness is reported).
 *   - Optional backlink CSV/JSON supplied with --backlinks PATH.
 *
 * Outputs:
 *   documentation/quality/inventory-quality-report.md
 *   documentation/quality/inventory-quality-report.csv
 *   documentation/quality/inventory-quality-report.json
 *
 * Run:
 *   node tools/content-inventory-audit.js
 *   node tools/content-inventory-audit.js --backlinks path/to/export.csv
 *   node tools/content-inventory-audit.js --repair-plan-limit 10
 *   node tools/content-inventory-audit.js \
 *     --apply-repair-plan documentation/quality/legacy-safe-repair-plan-.../manifest.json \
 *     --apply-limit 3 --confirm-production-write
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://thisday.info";
const BLOG_KV_NAMESPACE = "5173c34a7bd04cde9988c0e89d77bb6e";
const DEFAULT_GSC_DIR = join(ROOT, "documentation/gsc");
const DEFAULT_OUTPUT_DIR = join(ROOT, "documentation/quality");
const REQUIRED_HUB_ARTICLES = 5;
const MIN_ARTICLE_WORDS = 850;
const WINNABLE_MIN_IMPRESSIONS = 10;
const WINNABLE_POSITION = [5, 20];

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
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const HUBS = [
  ["war-conflict", "War & Conflict"],
  ["politics-government", "Politics & Government"],
  ["science-technology", "Science & Technology"],
  ["arts-culture", "Arts & Culture"],
  ["sports", "Sports"],
  ["disasters-accidents", "Disasters & Accidents"],
  ["social-human-rights", "Social & Human Rights"],
  ["economy-business", "Economy & Business"],
  ["health-medicine", "Health & Medicine"],
  ["exploration-discovery", "Exploration & Discovery"],
  ["famous-persons", "Famous Persons"],
  ["born-on-this-day", "Born on This Day"],
  ["died-on-this-day", "Died on This Day"],
];

const CORE_PAGES = [
  { path: "/", type: "home", localFile: "index.html" },
  { path: "/about/", type: "core", localFile: "about/index.html" },
  { path: "/about/editorial/", type: "core", localFile: "about/editorial/index.html" },
  { path: "/contact/", type: "core", localFile: "contact/index.html" },
  { path: "/blog/", type: "blog_index", localFile: "blog/index.html" },
  { path: "/privacy-policy/", type: "core", localFile: "privacy-policy/index.html" },
  { path: "/terms/", type: "core", localFile: "terms/index.html" },
];

const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at",
  "by", "for", "with", "from", "as", "into", "that", "while", "after",
  "before", "between", "against", "over", "under", "during", "per", "via",
  "near", "than", "then", "when", "which", "who", "whom",
]);

const SUBJECTLESS_HEADLINE_OPENING =
  /^(?:execute|kill|shoot|bomb|invade|launch|open|found|elect|appoint|arrest|capture|assassinate|declare|sign|seal|attack|destroy|overthrow|resign|discover|present|establish|begin|end|order|ban|recognize|liberate|surrender|sink|crash)\b/i;

const SEARCH_OR_PLACEHOLDER_URL =
  /(?:google\.[^/]+\/search|bing\.com\/search|duckduckgo\.com\/?\?|search\?|\/search\/|example\.com|placeholder)/i;

const NON_SOURCE_HOSTS = new Set([
  "amazon.com",
  "www.amazon.com",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "facebook.com",
  "www.facebook.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "www.instagram.com",
  "creativecommons.org",
  "www.buymeacoffee.com",
  "buymeacoffee.com",
  "openlibrary.org",
  "covers.openlibrary.org",
]);

const LEGACY_IMAGE_TOKENS_TO_IGNORE = new Set([
  "file", "image", "photo", "picture", "portrait", "painting", "illustration",
  "commons", "wikimedia", "wikipedia", "original", "thumbnail", "upload",
  "jpg", "jpeg", "png", "webp", "gif", "svg", "the", "and", "for", "from",
  "with", "that", "this", "into", "during", "traditional", "attire",
]);

const SAFE_LEGACY_REPAIR_ACTIONS = new Map([
  ["duplicate_breadcrumb_schema", "Keep one canonical BreadcrumbList JSON-LD object."],
  ["obsolete_faq_schema", "Remove ineligible FAQPage JSON-LD without deleting visible article content."],
  ["obsolete_news_schema", "Normalize the single historical-article schema object from NewsArticle to BlogPosting."],
  ["missing_canonical", "Add the known self-referencing canonical URL for the stored article slug."],
]);

const CURRENT_PUBLICATION_BLOCKER_CODES = new Set([
  "missing_title",
  "headline_fragment",
  "headline_truncation",
  "subjectless_imperative_headline",
  "url_title_day_mismatch",
  "historical_year_conflict",
  "headline_event_mismatch",
  "missing_canonical",
  "canonical_mismatch",
  "invalid_json_ld",
  "duplicate_breadcrumb_schema",
  "article_schema_count",
  "obsolete_news_schema",
  "obsolete_faq_schema",
  "insufficient_direct_sources",
  "no_independent_source",
  "legacy_quick_facts_count",
  "legacy_did_you_know_count",
  "legacy_did_you_know_duplicates",
  "legacy_people_labels_missing",
  "legacy_analysis_count",
  "legacy_hero_missing",
  "legacy_hero_unsupported",
  "legacy_hero_alt_missing",
  "legacy_hero_alt_file_mismatch",
]);

function parseArgs(argv) {
  const options = {
    backlinks: "",
    gscDir: DEFAULT_GSC_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    noKv: false,
    repairPlanLimit: 0,
    applyRepairPlan: "",
    applyLimit: 0,
    confirmProductionWrite: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--backlinks") options.backlinks = resolve(argv[++i] || "");
    else if (arg === "--gsc-dir") options.gscDir = resolve(argv[++i] || "");
    else if (arg === "--out-dir") options.outputDir = resolve(argv[++i] || "");
    else if (arg === "--no-kv") options.noKv = true;
    else if (arg === "--repair-plan-limit") {
      const limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("--repair-plan-limit must be an integer from 1 to 50");
      }
      options.repairPlanLimit = limit;
    }
    else if (arg === "--apply-repair-plan") options.applyRepairPlan = resolve(argv[++i] || "");
    else if (arg === "--apply-limit") {
      const limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new Error("--apply-limit must be an integer from 1 to 10");
      }
      options.applyLimit = limit;
    }
    else if (arg === "--confirm-production-write") options.confirmProductionWrite = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.applyRepairPlan) {
    if (!options.applyLimit) throw new Error("--apply-repair-plan requires --apply-limit N");
    if (!options.confirmProductionWrite) {
      throw new Error("--apply-repair-plan requires --confirm-production-write");
    }
    if (options.repairPlanLimit || options.noKv) {
      throw new Error("Repair-plan creation/read-only flags cannot be combined with apply mode");
    }
  } else if (options.applyLimit || options.confirmProductionWrite) {
    throw new Error("--apply-limit and --confirm-production-write require --apply-repair-plan PATH");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/content-inventory-audit.js [options]

Options:
  --backlinks PATH  Optional backlink CSV or JSON export.
  --gsc-dir PATH    Cached GSC export directory (default documentation/gsc).
  --out-dir PATH    Local output directory (default documentation/quality).
  --no-kv           Do not make read-only Cloudflare KV GET requests.
  --repair-plan-limit N
                    Generate before/after snapshots and exact unified diffs
                    for up to N metadata-only legacy repairs (1-50). GET-only;
                    never applies the plans to production KV.
  --apply-repair-plan PATH
                    Apply a previously generated manifest after re-reading and
                    hash-checking each live KV value. Production write mode.
  --apply-limit N   Apply only the first N manifest entries (1-10).
  --confirm-production-write
                    Required explicit acknowledgement for apply mode.
  -h, --help        Show this help.

The script never calls public page routes. The audit and planning modes are GET-only;
production writes are available only through the separately confirmed apply mode.`);
}

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""), SITE);
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "thisday.info") {
      return "";
    }
    url.protocol = "https:";
    url.hostname = "thisday.info";
    url.port = "";
    url.search = "";
    url.hash = "";
    if (!url.pathname.includes(".") && !url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function urlForPath(path) {
  return normalizeUrl(`${SITE}${path}`);
}

function pageType(value) {
  const url = new URL(normalizeUrl(value) || SITE);
  const path = url.pathname;
  if (path === "/") return "home";
  if (path === "/blog/") return "blog_index";
  if (/^\/blog\/topic\/[^/]+\/$/.test(path)) return "blog_hub";
  if (/^\/blog\/(?:[a-z]+\/)?\d{1,2}-[a-z]+-\d{4}\/$/.test(path)) return "blog_article";
  if (/^\/events\/[a-z]+\/\d{1,2}\/$/.test(path)) return "events_date";
  if (/^\/quiz\/[a-z]+\/\d{1,2}\/$/.test(path)) return "quiz_date";
  if (/^\/born\/[a-z]+\/\d{1,2}\/$/.test(path)) return "born_date";
  if (/^\/died\/[a-z]+\/\d{1,2}\/$/.test(path)) return "died_date";
  if (/^\/people\/[^/]+\/$/.test(path)) return "person_entity";
  if (/^\/history\/[^/]+\/$/.test(path)) return "history_entity";
  return "core";
}

function isBotQuery(query) {
  const text = String(query || "");
  if (text.includes('"')) return true;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 8) return true;
  if (/\b(?:19|20)\d{2}\b/.test(text) && words.length >= 5) return true;
  return false;
}

function loadGscCache(gscDir) {
  const pagesDoc = readJson(join(gscDir, "pages-raw.json"), {});
  const queryPageDoc = readJson(join(gscDir, "query-page-raw.json"), {});
  const indexingDoc = readJson(join(gscDir, "indexing-raw.json"), {});
  const weeklyPath = join(gscDir, "weekly-report.md");
  const weekly = existsSync(weeklyPath) ? readFileSync(weeklyPath, "utf8") : "";
  const reportDate = weekly.match(/^# .*?(\d{4}-\d{2}-\d{2})/m)?.[1] || "unknown";
  const windowMatch = weekly.match(/Window:\s+\*\*(\d{4}-\d{2}-\d{2})\s+→\s+(\d{4}-\d{2}-\d{2})\*\*/);
  const byUrl = new Map();
  const indexingByUrl = new Map();

  for (const row of Array.isArray(pagesDoc.rows) ? pagesDoc.rows : []) {
    const url = normalizeUrl(row?.keys?.[0]);
    if (!url) continue;
    byUrl.set(url, {
      observed: true,
      clicks: Number(row.clicks || 0),
      impressions: Number(row.impressions || 0),
      position: Number.isFinite(Number(row.position)) ? Number(row.position) : null,
      knownHumanClicks: 0,
      knownHumanImpressions: 0,
      knownHumanPositionSum: 0,
      knownBotImpressions: 0,
      humanQueries: [],
      botQueries: [],
    });
  }

  for (const row of Array.isArray(queryPageDoc.rows) ? queryPageDoc.rows : []) {
    const query = String(row?.keys?.[0] || "").trim();
    const url = normalizeUrl(row?.keys?.[1]);
    if (!url) continue;
    const stats = byUrl.get(url) || {
      observed: true,
      clicks: 0,
      impressions: 0,
      position: null,
      knownHumanClicks: 0,
      knownHumanImpressions: 0,
      knownHumanPositionSum: 0,
      knownBotImpressions: 0,
      humanQueries: [],
      botQueries: [],
    };
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);
    const position = Number(row.position || 0);
    if (isBotQuery(query)) {
      stats.knownBotImpressions += impressions;
      stats.botQueries.push({ query, impressions, position });
    } else {
      stats.knownHumanImpressions += impressions;
      stats.knownHumanClicks += clicks;
      stats.knownHumanPositionSum += impressions * position;
      stats.humanQueries.push({ query, impressions, clicks, position });
    }
    byUrl.set(url, stats);
  }

  for (const stats of byUrl.values()) {
    stats.knownHumanPosition = stats.knownHumanImpressions
      ? stats.knownHumanPositionSum / stats.knownHumanImpressions
      : null;
    stats.humanQueries.sort((a, b) => b.impressions - a.impressions);
    stats.botQueries.sort((a, b) => b.impressions - a.impressions);
  }

  for (const entry of Array.isArray(indexingDoc.results) ? indexingDoc.results : []) {
    const url = normalizeUrl(entry?.url || entry?.inspectionUrl);
    if (!url) continue;
    const status = entry?.inspectionResult?.indexStatusResult || {};
    indexingByUrl.set(url, {
      observed: true,
      verdict: String(status.verdict || "UNKNOWN"),
      coverageState: String(status.coverageState || ""),
      robotsTxtState: String(status.robotsTxtState || ""),
      indexingState: String(status.indexingState || ""),
      pageFetchState: String(status.pageFetchState || ""),
      lastCrawlTime: String(status.lastCrawlTime || ""),
      googleCanonical: normalizeUrl(status.googleCanonical) || String(status.googleCanonical || ""),
      userCanonical: normalizeUrl(status.userCanonical) || String(status.userCanonical || ""),
      crawledAs: String(status.crawledAs || ""),
    });
  }

  return {
    available: byUrl.size > 0,
    reportDate,
    windowStart: windowMatch?.[1] || "unknown",
    windowEnd: windowMatch?.[2] || reportDate,
    byUrl,
    indexingAvailable: indexingByUrl.size > 0,
    indexingGeneratedAt: String(indexingDoc?.export?.generatedAt || ""),
    indexingRequestedUrls: Number(indexingDoc?.export?.requestedUrls || 0),
    indexingFailedUrls: Number(indexingDoc?.export?.failedUrls || 0),
    indexingByUrl,
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function loadBacklinks(path) {
  const byUrl = new Map();
  if (!path || !existsSync(path)) return { available: false, byUrl, source: "not supplied" };
  const raw = readFileSync(path, "utf8");
  let records = [];
  if (/\.json$/i.test(path)) {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed : parsed.rows || [];
  } else {
    const rows = parseCsv(raw);
    const headers = (rows.shift() || []).map((value) => value.trim().toLowerCase());
    records = rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
  }

  for (const record of records) {
    const url = normalizeUrl(
      record.url ||
      record.page ||
      record.target ||
      record["target page"] ||
      record["top linked pages"] ||
      record.keys?.[0],
    );
    if (!url) continue;
    const count = Number(
      record.backlinks ||
      record.links ||
      record["external links"] ||
      record["linking pages"] ||
      record.count ||
      0,
    );
    const domains = Number(record.domains || record["linking sites"] || record["referring domains"] || 0);
    byUrl.set(url, {
      backlinks: Number.isFinite(count) ? count : 0,
      referringDomains: Number.isFinite(domains) ? domains : 0,
    });
  }
  return { available: true, byUrl, source: path };
}

async function readKvValue(env, key, { json = false } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  }
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/storage/kv/namespaces/${BLOG_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare KV GET ${key} failed: HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

async function writeKvValue(env, key, value) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  }
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/storage/kv/namespaces/${BLOG_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "text/html; charset=utf-8",
    },
    body: value,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Cloudflare KV PUT ${key} failed: HTTP ${response.status}`);
  try {
    const payload = JSON.parse(responseText);
    if (payload?.success === false) throw new Error(`Cloudflare KV PUT ${key} was rejected`);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

function walkHtmlFiles(root) {
  if (!existsSync(root)) return [];
  const output = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (entry === "index.html") output.push(path);
    }
  };
  visit(root);
  return output;
}

function inventoryItem(url, input = {}) {
  return {
    url,
    type: input.type || pageType(url),
    discovery: new Set(input.discovery || []),
    sitemapIntended: input.sitemapIntended !== false,
    localFile: input.localFile || "",
    metadata: input.metadata || null,
    contentMode: input.contentMode || "template-only",
    html: input.html || "",
    audit: null,
    traffic: null,
    backlinks: null,
    classification: "keep",
    confidence: "low",
    classificationReasons: [],
    duplicateGroup: "",
    duplicateLeader: false,
  };
}

function buildInventory({ blogIndex, entityIndex, gsc }) {
  const byUrl = new Map();
  const add = (urlValue, input = {}) => {
    const url = normalizeUrl(urlValue);
    if (!url) return;
    const existing = byUrl.get(url);
    if (existing) {
      for (const source of input.discovery || []) existing.discovery.add(source);
      if (input.metadata) existing.metadata = { ...(existing.metadata || {}), ...input.metadata };
      if (input.localFile) existing.localFile = input.localFile;
      if (input.contentMode && existing.contentMode === "template-only") existing.contentMode = input.contentMode;
      existing.sitemapIntended = existing.sitemapIntended || input.sitemapIntended !== false;
      return existing;
    }
    const item = inventoryItem(url, input);
    byUrl.set(url, item);
    return item;
  };

  for (const page of CORE_PAGES) {
    add(urlForPath(page.path), {
      type: page.type,
      discovery: ["sitemap-main"],
      localFile: join(ROOT, page.localFile),
      contentMode: "local-html",
    });
  }

  for (const [slug, pillar] of HUBS) {
    add(urlForPath(`/blog/topic/${slug}/`), {
      type: "blog_hub",
      discovery: ["sitemap-main"],
      metadata: { pillar, hubSlug: slug },
      contentMode: "worker-template",
    });
  }

  for (const path of walkHtmlFiles(join(ROOT, "blog"))) {
    if (path === join(ROOT, "blog/index.html")) continue;
    const rel = relative(join(ROOT, "blog"), dirname(path)).split("\\").join("/");
    add(urlForPath(`/blog/${rel}/`), {
      type: "blog_article",
      discovery: ["legacy-static-blog"],
      localFile: path,
      contentMode: "local-html",
    });
  }

  for (const post of Array.isArray(blogIndex) ? blogIndex : []) {
    if (!post?.slug) continue;
    add(urlForPath(`/blog/${post.slug}/`), {
      type: "blog_article",
      discovery: ["blog-kv-index", "sitemap-main"],
      metadata: post,
      contentMode: "kv-stored-html",
    });
  }

  for (let monthIndex = 0; monthIndex < MONTHS.length; monthIndex += 1) {
    const month = MONTHS[monthIndex];
    for (let day = 1; day <= DAYS_IN_MONTH[monthIndex]; day += 1) {
      for (const type of ["events", "quiz", "born", "died"]) {
        add(urlForPath(`/${type}/${month}/${day}/`), {
          type: `${type}_date`,
          discovery: [type === "events" || type === "quiz" ? "generated-date-template" : "people-date-template"],
          contentMode: "worker-template",
        });
      }
    }
  }

  for (const entity of Array.isArray(entityIndex) ? entityIndex : []) {
    if (!entity?.slug || !entity?.type || entity.indexable !== true) continue;
    const path = entity.url || (entity.type === "person" ? `/people/${entity.slug}/` : `/history/${entity.slug}/`);
    add(urlForPath(path), {
      type: entity.type === "person" ? "person_entity" : "history_entity",
      discovery: ["entity-kv-index", "sitemap-entities"],
      metadata: entity,
      contentMode: "kv-entity-metadata",
    });
  }

  for (const [url] of gsc.byUrl) {
    add(url, {
      type: pageType(url),
      discovery: ["gsc-observed"],
      sitemapIntended: false,
      contentMode: "gsc-only",
    });
  }

  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function plainText(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function wordCount(value) {
  return plainText(value).split(/\s+/).filter(Boolean).length;
}

function normalizedText(value) {
  return plainText(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractTagText(html, tag) {
  const match = String(html || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return plainText(match?.[1] || "");
}

function extractMeta(html, name) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = tag.match(/\b(?:name|property)\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase();
    if (key !== name.toLowerCase()) continue;
    return decodeHtml(tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2] || "").trim();
  }
  return "";
}

function extractCanonical(html) {
  const tags = String(html || "").match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || "";
    if (!rel.split(/\s+/).includes("canonical")) continue;
    return normalizeUrl(tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] || "");
  }
  return "";
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  output.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLd(value["@graph"], output);
  return output;
}

function parseJsonLd(html) {
  const objects = [];
  const errors = [];
  const regex = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(String(html || ""))) !== null) {
    try {
      flattenJsonLd(JSON.parse(match[2]), objects);
    } catch (error) {
      errors.push(error.message);
    }
  }
  const counts = {};
  for (const object of objects) {
    const types = Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]];
    for (const type of types.filter(Boolean)) counts[type] = (counts[type] || 0) + 1;
  }
  return { objects, errors, counts };
}

function finding(category, code, severity, detail) {
  return { category, code, severity, detail };
}

function classifyHeadline(title, { url = "", eventTitle = "", historicalYear = null } = {}) {
  const findings = [];
  const text = plainText(title);
  if (!text) {
    findings.push(finding("technical", "missing_title", "high", "The page has no usable title."));
    return findings;
  }
  const titleCore = text.replace(/\s+\|\s+thisDay\.?\s*$/i, "").trim();
  const dateMatch = titleCore.match(/\s[-—]\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{3,4})\s*$/);
  const headline = dateMatch ? titleCore.slice(0, dateMatch.index).trim() : titleCore;
  const words = headline.split(/\s+/).filter(Boolean);
  const lastWord = (words.at(-1) || "").toLowerCase().replace(/[^a-z]/g, "");

  if (text.length > 70) {
    findings.push(finding("cosmetic", "long_title", "low", `Title is ${text.length} characters and likely to truncate.`));
  }
  if (words.length >= 2 && FUNCTION_WORDS.has(lastWord)) {
    findings.push(finding("factual", "headline_fragment", "high", `Headline ends with a dangling function word: “${words.at(-1)}”.`));
  }
  if (/[,;:]\s*$/.test(headline) || /(?:…|\.\.\.)/.test(headline)) {
    findings.push(finding("factual", "headline_truncation", "high", "Headline appears truncated or unfinished."));
  }
  if (SUBJECTLESS_HEADLINE_OPENING.test(headline)) {
    findings.push(finding("factual", "subjectless_imperative_headline", "high", "Headline opens as a command or subjectless verb and may misstate the historical actor."));
  }

  if (pageType(url) === "blog_article") {
    if (!dateMatch) {
      findings.push(finding("cosmetic", "missing_historical_date_suffix", "medium", "Article title has no “Month Day, Year” historical-date suffix."));
    } else {
      const pathMatch = new URL(normalizeUrl(url)).pathname.match(/\/(\d{1,2})-([a-z]+)-\d{4}\/$/);
      if (
        pathMatch &&
        (Number(pathMatch[1]) !== Number(dateMatch[2]) || pathMatch[2] !== dateMatch[1].toLowerCase())
      ) {
        findings.push(finding("factual", "url_title_day_mismatch", "high", `URL date ${pathMatch[2]} ${pathMatch[1]} conflicts with title date ${dateMatch[1]} ${dateMatch[2]}.`));
      }
      if (historicalYear && Number(historicalYear) !== Number(dateMatch[3])) {
        findings.push(finding("factual", "historical_year_conflict", "high", `Metadata year ${historicalYear} conflicts with title year ${dateMatch[3]}.`));
      }
    }
  }

  if (eventTitle) {
    const titleTokens = new Set(normalizedText(headline).split(" ").filter((token) => token.length > 3));
    const eventTokens = normalizedText(eventTitle).split(" ").filter((token) => token.length > 3);
    const overlap = eventTokens.filter((token) => titleTokens.has(token)).length;
    if (eventTokens.length >= 2 && overlap === 0) {
      findings.push(finding("factual", "headline_event_mismatch", "high", "Headline and stored event title have no substantive token overlap."));
    }
  }
  return findings;
}

function sourceAudit(metadata, html, type) {
  if (type !== "blog_article") return { sourceCount: null, independentSourceCount: null, urls: [], findings: [] };
  const pages = Array.isArray(metadata?.sourcePages) ? metadata.sourcePages : [];
  const urls = pages.map((page) => String(page?.pageUrl || "").trim()).filter(Boolean);
  if (!urls.length && html) {
    const linkRegex = /<a\b[^>]*href\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      try {
        const host = new URL(decodeHtml(match[2])).hostname.toLowerCase();
        if (host !== "thisday.info" && !NON_SOURCE_HOSTS.has(host)) urls.push(decodeHtml(match[2]));
      } catch {
        // Ignore malformed legacy links here; the invalid-link rule below handles stored metadata.
      }
    }
  }
  const uniqueUrls = [...new Set(urls)];
  const independent = uniqueUrls.filter((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return !host.endsWith("wikipedia.org") && !NON_SOURCE_HOSTS.has(host);
    } catch {
      return false;
    }
  });
  const findings = [];
  const invalid = uniqueUrls.filter((url) => SEARCH_OR_PLACEHOLDER_URL.test(url));
  if (invalid.length) {
    findings.push(finding("source", "invalid_source_url", "high", `${invalid.length} source URL(s) are search or placeholder URLs.`));
  }
  if (uniqueUrls.length < 2) {
    findings.push(finding("source", "insufficient_direct_sources", "high", `Only ${uniqueUrls.length} direct source page(s) are stored.`));
  }
  if (independent.length < 1) {
    findings.push(finding("source", "no_independent_source", "high", "No non-Wikipedia source publisher is stored for the article."));
  }
  return {
    sourceCount: uniqueUrls.length,
    independentSourceCount: independent.length,
    urls: uniqueUrls,
    findings,
  };
}

function extractHtmlAttribute(tag, name) {
  const match = String(tag || "").match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return decodeHtml(match?.[2] || "").trim();
}

function decodeArticleImageSource(value) {
  const source = decodeHtml(value);
  try {
    const url = new URL(source, SITE);
    if (url.hostname.toLowerCase().replace(/^www\./, "") === "thisday.info" && url.pathname === "/image-proxy") {
      return url.searchParams.get("src") || "";
    }
    return url.toString();
  } catch {
    return source;
  }
}

function isSupportedLegacyArticleImage(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "wikimedia.org" || host.endsWith(".wikimedia.org"));
  } catch {
    return false;
  }
}

function legacyImageSubjectTokens(value) {
  let text = String(value || "");
  try {
    const url = new URL(text, SITE);
    text = url.pathname.split("/").at(-1) || "";
  } catch {
    // Use the supplied label as-is when it is not a URL.
  }
  try {
    text = decodeURIComponent(text);
  } catch {
    // A partially encoded Commons filename can still provide useful tokens.
  }
  return new Set(
    text
      .replace(/^\d+px-/i, "")
      .replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !LEGACY_IMAGE_TOKENS_TO_IGNORE.has(token)),
  );
}

function tokenOverlap(left, right) {
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function legacyNearDuplicateFacts(left, right, ignoredTokens = new Set()) {
  const tokensFor = (value) => new Set(
    normalizedText(value)
      .split(" ")
      .filter((token) => token.length >= 4 && !FUNCTION_WORDS.has(token) && !ignoredTokens.has(token)),
  );
  const leftTokens = tokensFor(left);
  const rightTokens = tokensFor(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared >= 6 && shared / Math.min(leftTokens.size, rightTokens.size) >= 0.55;
}

function auditLegacyArticleContract(html, { title = "", h1 = "", description = "", metadata = null } = {}) {
  const source = String(html || "");
  const findings = [];
  const quickFactCount = (source.match(/class\s*=\s*(["'])[^"']*\bai-answer-item\b[^"']*\1/gi) || []).length;
  if (quickFactCount < 6) {
    findings.push(finding("content", "legacy_quick_facts_count", "high", `Current publication requires at least six populated Quick Facts; stored HTML has ${quickFactCount}.`));
  }

  const didYouKnowFacts = [...source.matchAll(/<p\b[^>]*class\s*=\s*(["'])[^"']*\bdyn-fact\b[^"']*\1[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => plainText(match[2]))
    .filter(Boolean);
  if (didYouKnowFacts.length !== 5) {
    findings.push(finding("content", "legacy_did_you_know_count", "high", `Current publication requires exactly five populated Did You Know facts; stored HTML has ${didYouKnowFacts.length}.`));
  }
  const ignoredFactTokens = new Set(normalizedText(`${title} ${h1} ${metadata?.eventTitle || ""}`).split(" ").filter((token) => token.length >= 4));
  const duplicatePairs = [];
  for (let left = 0; left < didYouKnowFacts.length; left += 1) {
    for (let right = left + 1; right < didYouKnowFacts.length; right += 1) {
      if (
        normalizedText(didYouKnowFacts[left]) === normalizedText(didYouKnowFacts[right]) ||
        legacyNearDuplicateFacts(didYouKnowFacts[left], didYouKnowFacts[right], ignoredFactTokens)
      ) {
        duplicatePairs.push([left + 1, right + 1]);
      }
    }
  }
  if (duplicatePairs.length) {
    findings.push(finding("content", "legacy_did_you_know_duplicates", "high", `${duplicatePairs.length} exact or near-duplicate Did You Know fact pair(s) require source-based rewriting.`));
  }

  const peopleLabelCount = (source.match(/class\s*=\s*(["'])[^"']*\bperson-pill-name\b[^"']*\1/gi) || []).length;
  if (peopleLabelCount < 1) {
    findings.push(finding("content", "legacy_people_labels_missing", "high", "Current publication requires at least one visible People in this story label."));
  }

  const positiveBlock = source.match(/<div\b[^>]*class\s*=\s*(["'])[^"']*\banalysis-good\b[^"']*\1[^>]*>[\s\S]*?<ul\b[^>]*>([\s\S]*?)<\/ul>/i)?.[2] || "";
  const criticalBlock = source.match(/<div\b[^>]*class\s*=\s*(["'])[^"']*\banalysis-bad\b[^"']*\1[^>]*>[\s\S]*?<ul\b[^>]*>([\s\S]*?)<\/ul>/i)?.[2] || "";
  const positiveAnalysisCount = (positiveBlock.match(/<li\b/gi) || []).length;
  const criticalAnalysisCount = (criticalBlock.match(/<li\b/gi) || []).length;
  if (positiveAnalysisCount < 3 || criticalAnalysisCount < 3) {
    findings.push(finding("content", "legacy_analysis_count", "high", `Current publication requires at least three positive and three critical analysis items; stored HTML has ${positiveAnalysisCount} and ${criticalAnalysisCount}.`));
  }

  const heroFigure = [...source.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi)]
    .map((match) => match[0])
    .find((figure) => /class\s*=\s*(["'])[^"']*\barticle-hero-fig\b[^"']*\1/i.test(figure)) || "";
  const heroTag = heroFigure.match(/<img\b[^>]*>/i)?.[0] || "";
  const heroImageUrl = decodeArticleImageSource(extractHtmlAttribute(heroTag, "src"));
  const heroImageAlt = extractHtmlAttribute(heroTag, "alt");
  const heroImageSupported = isSupportedLegacyArticleImage(heroImageUrl);
  if (!heroTag || !heroImageUrl) {
    findings.push(finding("technical", "legacy_hero_missing", "high", "Current publication requires a rendered featured hero image."));
  } else if (!heroImageSupported) {
    findings.push(finding("technical", "legacy_hero_unsupported", "high", `Hero image is not a supported HTTPS Wikimedia asset: ${heroImageUrl}`));
  }
  if (heroTag && !heroImageAlt) {
    findings.push(finding("content", "legacy_hero_alt_missing", "high", "Featured hero image has no usable alt text."));
  }

  const fileTokens = legacyImageSubjectTokens(heroImageUrl);
  const altTokens = legacyImageSubjectTokens(heroImageAlt);
  const articleTokens = legacyImageSubjectTokens(
    `${title} ${h1} ${description} ${metadata?.eventTitle || ""} ${metadata?.keywords || ""}`,
  );
  if (fileTokens.size >= 2 && altTokens.size >= 2 && !tokenOverlap(fileTokens, altTokens)) {
    findings.push(finding("factual", "legacy_hero_alt_file_mismatch", "high", "Hero alt text has no substantive overlap with the Wikimedia filename; verify what the image actually depicts before rewriting it."));
  }
  if (fileTokens.size >= 2 && articleTokens.size >= 2 && !tokenOverlap(fileTokens, articleTokens)) {
    findings.push(finding("factual", "legacy_hero_subject_page_mismatch", "medium", "Wikimedia filename has no substantive overlap with the article title, event, description, or keywords; image relevance needs human review."));
  }

  return {
    quickFactCount,
    didYouKnowCount: didYouKnowFacts.length,
    didYouKnowDuplicatePairs: duplicatePairs,
    peopleLabelCount,
    positiveAnalysisCount,
    criticalAnalysisCount,
    heroImageUrl,
    heroImageAlt,
    heroImageSupported,
    groundingEvidence: "unavailable-from-rendered-html",
    findings,
  };
}

function buildLegacyCompatibility(audit, type) {
  if (type !== "blog_article") {
    return {
      applicable: false,
      status: "not_applicable",
      safeRepairs: [],
      editorialReview: [],
      currentContractBlockers: [],
    };
  }

  const safeRepairs = [];
  const editorialReview = [];
  const currentContractBlockers = [];
  const newsSchemaOnly =
    (audit.schemaCounts?.NewsArticle || 0) === 1 &&
    (audit.schemaCounts?.Article || 0) === 0 &&
    (audit.schemaCounts?.BlogPosting || 0) === 0;

  for (const entry of audit.findings || []) {
    const safeAction = SAFE_LEGACY_REPAIR_ACTIONS.get(entry.code);
    if (safeAction) safeRepairs.push({ code: entry.code, detail: safeAction });
    if (CURRENT_PUBLICATION_BLOCKER_CODES.has(entry.code)) {
      currentContractBlockers.push({ code: entry.code, detail: entry.detail });
    }
    const safelyCoveredSchemaCount = entry.code === "article_schema_count" && newsSchemaOnly;
    const needsEditorialReview =
      !safeAction &&
      !safelyCoveredSchemaCount &&
      (
        ["factual", "source", "content", "repetition", "duplication"].includes(entry.category) ||
        (entry.category === "technical" && ["medium", "high"].includes(entry.severity)) ||
        (entry.category === "cosmetic" && entry.severity === "medium")
      );
    if (needsEditorialReview) editorialReview.push({ code: entry.code, detail: entry.detail });
  }

  const unique = (entries) => [...new Map(entries.map((entry) => [entry.code, entry])).values()];
  const dedupedSafe = unique(safeRepairs);
  const dedupedEditorial = unique(editorialReview);
  const dedupedBlockers = unique(currentContractBlockers);
  const status = dedupedEditorial.length
    ? "editorial_review_required"
    : dedupedSafe.length
      ? "deterministic_safe_repair"
      : "compatible";
  return {
    applicable: true,
    status,
    safeRepairs: dedupedSafe,
    editorialReview: dedupedEditorial,
    currentContractBlockers: dedupedBlockers,
  };
}

function jsonLdScriptBlocks(html) {
  const blocks = [];
  const regex = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(String(html || ""))) !== null) {
    try {
      const parsed = JSON.parse(match[2]);
      blocks.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        parsed,
        nodes: flattenJsonLd(parsed, []),
      });
    } catch {
      // Invalid JSON-LD is never a deterministic-safe repair candidate.
    }
  }
  return blocks;
}

function nodeHasSchemaType(node, expected) {
  const types = Array.isArray(node?.["@type"]) ? node["@type"] : [node?.["@type"]];
  return types.includes(expected);
}

function blockHasSchemaType(block, expected) {
  return block.nodes.some((node) => nodeHasSchemaType(node, expected));
}

function standaloneSchemaBlock(block, expected) {
  const roots = Array.isArray(block.parsed) ? block.parsed : [block.parsed];
  return roots.length === 1 && nodeHasSchemaType(roots[0], expected) && !Array.isArray(roots[0]?.["@graph"]);
}

function replaceHtmlRanges(html, ranges) {
  let output = String(html || "");
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, range.start) + (range.replacement || "") + output.slice(range.end);
  }
  return output;
}

function transformLegacyNewsSchema(html) {
  const blocks = jsonLdScriptBlocks(html);
  const newsNodes = blocks.flatMap((block) => block.nodes.filter((node) => nodeHasSchemaType(node, "NewsArticle")));
  const currentArticleNodes = blocks.flatMap((block) => block.nodes.filter((node) =>
    nodeHasSchemaType(node, "Article") || nodeHasSchemaType(node, "BlogPosting"),
  ));
  if (newsNodes.length !== 1 || currentArticleNodes.length !== 0) {
    return { html, reason: `Expected one NewsArticle and no current Article/BlogPosting; found ${newsNodes.length} and ${currentArticleNodes.length}.` };
  }
  const block = blocks.find((entry) => blockHasSchemaType(entry, "NewsArticle"));
  const typeMatches = [...block.raw.matchAll(/("@type"\s*:\s*)"NewsArticle"/g)];
  if (typeMatches.length !== 1) {
    return { html, reason: `Expected one exact NewsArticle type token; found ${typeMatches.length}.` };
  }
  const replacement = block.raw.replace(/("@type"\s*:\s*)"NewsArticle"/, '$1"BlogPosting"');
  return {
    html: replaceHtmlRanges(html, [{ start: block.start, end: block.end, replacement }]),
    reason: "",
  };
}

function transformLegacyFaqSchema(html) {
  const blocks = jsonLdScriptBlocks(html);
  const faqNodes = blocks.flatMap((block) => block.nodes.filter((node) => nodeHasSchemaType(node, "FAQPage")));
  const removable = blocks.filter((block) => standaloneSchemaBlock(block, "FAQPage"));
  if (!faqNodes.length) return { html, reason: "No FAQPage JSON-LD exists." };
  if (faqNodes.length !== removable.length) {
    return { html, reason: "FAQPage is embedded in mixed JSON-LD and cannot be removed without restructuring other schema." };
  }
  return { html: replaceHtmlRanges(html, removable), reason: "" };
}

function transformDuplicateBreadcrumbSchema(html) {
  const blocks = jsonLdScriptBlocks(html);
  const breadcrumbNodes = blocks.flatMap((block) => block.nodes.filter((node) => nodeHasSchemaType(node, "BreadcrumbList")));
  if (breadcrumbNodes.length <= 1) return { html, reason: "No duplicate BreadcrumbList exists." };

  const preferred = blocks.find((block) =>
    blockHasSchemaType(block, "BreadcrumbList") &&
    ["NewsArticle", "Article", "BlogPosting"].some((type) => blockHasSchemaType(block, type)),
  ) || blocks.find((block) => blockHasSchemaType(block, "BreadcrumbList"));
  const removable = blocks.filter((block) =>
    block !== preferred && standaloneSchemaBlock(block, "BreadcrumbList"),
  );
  if (breadcrumbNodes.length - removable.length !== 1) {
    return { html, reason: "Duplicate breadcrumbs are embedded in mixed JSON-LD; removing them would require restructuring another schema block." };
  }
  return { html: replaceHtmlRanges(html, removable), reason: "" };
}

function transformMissingCanonical(html, url) {
  if (extractCanonical(html)) return { html, reason: "A canonical URL already exists." };
  const headClose = String(html || "").search(/<\/head\s*>/i);
  if (headClose < 0) return { html, reason: "Document has no closing head tag." };
  const canonical = `    <link rel="canonical" href="${normalizeUrl(url)}" />\n`;
  return {
    html: String(html).slice(0, headClose) + canonical + String(html).slice(headClose),
    reason: "",
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function applyDeterministicLegacyRepairs(
  html,
  { url, metadata = null, requestedCodes = [] } = {},
) {
  const transforms = new Map([
    ["obsolete_news_schema", (value) => transformLegacyNewsSchema(value)],
    ["obsolete_faq_schema", (value) => transformLegacyFaqSchema(value)],
    ["duplicate_breadcrumb_schema", (value) => transformDuplicateBreadcrumbSchema(value)],
    ["missing_canonical", (value) => transformMissingCanonical(value, url)],
  ]);
  let output = String(html || "");
  const applied = [];
  const skipped = [];
  for (const code of requestedCodes) {
    const transform = transforms.get(code);
    if (!transform) {
      skipped.push({ code, reason: "No deterministic transformer is implemented for this action." });
      continue;
    }
    const result = transform(output);
    if (!result.html || result.html === output) {
      skipped.push({ code, reason: result.reason || "Transformation made no change." });
      continue;
    }
    const verification = auditHtml(result.html, {
      url,
      type: "blog_article",
      metadata,
      evidenceMode: "dry-run-after",
    });
    const codeRemains = verification.findings.some((entry) => entry.code === code);
    const articleSchemaStillBroken =
      code === "obsolete_news_schema" &&
      verification.findings.some((entry) => entry.code === "article_schema_count");
    if (codeRemains || articleSchemaStillBroken) {
      skipped.push({ code, reason: "Post-transform audit did not clear the targeted contract finding." });
      continue;
    }
    output = result.html;
    applied.push({ code, detail: SAFE_LEGACY_REPAIR_ACTIONS.get(code) || code });
  }
  return {
    html: output,
    changed: output !== String(html || ""),
    applied,
    skipped,
    beforeSha256: sha256(html),
    afterSha256: sha256(output),
  };
}

function auditHtml(html, { url, type, metadata = null, evidenceMode = "html" } = {}) {
  const title = extractTagText(html, "title") || metadata?.title || "";
  const h1Matches = [...String(html || "").matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => plainText(match[1])).filter(Boolean);
  const description = extractMeta(html, "description") || metadata?.description || "";
  const canonical = extractCanonical(html);
  const robots = extractMeta(html, "robots").toLowerCase();
  const schema = parseJsonLd(html);
  const findings = [
    ...classifyHeadline(title, {
      url,
      eventTitle: metadata?.eventTitle,
      historicalYear: metadata?.historicalYear,
    }),
  ];

  if (!description) findings.push(finding("technical", "missing_description", "medium", "Meta description is missing."));
  else if (description.length < 70) findings.push(finding("cosmetic", "short_description", "medium", `Meta description is only ${description.length} characters.`));
  else if (description.length > 160) findings.push(finding("cosmetic", "long_description", "low", `Meta description is ${description.length} characters.`));
  if (h1Matches.length !== 1) findings.push(finding("technical", "h1_count", "medium", `Expected one H1 but found ${h1Matches.length}.`));
  if (!canonical) findings.push(finding("technical", "missing_canonical", "medium", "Canonical URL is missing."));
  else if (canonical !== normalizeUrl(url)) findings.push(finding("technical", "canonical_mismatch", "high", `Canonical points to ${canonical}.`));
  if (/\bnoindex\b/.test(robots)) findings.push(finding("technical", "noindex_in_inventory", "medium", "Page declares noindex while present in the intended index inventory."));
  if (schema.errors.length) findings.push(finding("technical", "invalid_json_ld", "high", `${schema.errors.length} JSON-LD block(s) do not parse.`));
  if ((schema.counts.BreadcrumbList || 0) > 1) findings.push(finding("technical", "duplicate_breadcrumb_schema", "high", `${schema.counts.BreadcrumbList} BreadcrumbList objects are stored.`));
  if (type === "blog_article") {
    const articleSchemaCount = (schema.counts.BlogPosting || 0) + (schema.counts.Article || 0);
    if (articleSchemaCount !== 1) findings.push(finding("technical", "article_schema_count", "high", `Expected one Article/BlogPosting object but found ${articleSchemaCount}.`));
    if (schema.counts.NewsArticle) findings.push(finding("technical", "obsolete_news_schema", "medium", "Stored markup still contains NewsArticle schema."));
    if (schema.counts.FAQPage) findings.push(finding("technical", "obsolete_faq_schema", "medium", "Stored markup still contains FAQPage schema."));
  }

  const paragraphs = [...String(html || "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => plainText(match[1]))
    .filter((text) => text.length >= 80);
  const paragraphGroups = new Map();
  paragraphs.forEach((text, index) => {
    const key = normalizedText(text);
    if (!key) return;
    const group = paragraphGroups.get(key) || [];
    group.push(index + 1);
    paragraphGroups.set(key, group);
  });
  const repeatedParagraphs = [...paragraphGroups.entries()]
    .filter(([, positions]) => positions.length > 1)
    .map(([text, positions]) => ({ text: text.slice(0, 140), positions }));
  if (repeatedParagraphs.length) findings.push(finding("repetition", "repeated_paragraphs", "medium", `${repeatedParagraphs.length} paragraph text(s) repeat exactly.`));

  const headings = [...String(html || "").matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi)]
    .map((match) => normalizedText(match[1]))
    .filter(Boolean);
  const headingCounts = new Map();
  for (const heading of headings) headingCounts.set(heading, (headingCounts.get(heading) || 0) + 1);
  const repeatedHeadings = [...headingCounts.entries()].filter(([, count]) => count > 1);
  if (repeatedHeadings.length) findings.push(finding("repetition", "repeated_headings", "medium", `${repeatedHeadings.length} section heading(s) repeat.`));

  const contentWords = wordCount(html);
  if (type === "blog_article" && contentWords < MIN_ARTICLE_WORDS) {
    findings.push(finding("content", "thin_article", "high", `Stored HTML exposes approximately ${contentWords} words, below the ${MIN_ARTICLE_WORDS}-word article floor.`));
  }

  const sources = sourceAudit(metadata, html, type);
  findings.push(...sources.findings);

  const currentContract = type === "blog_article"
    ? auditLegacyArticleContract(html, { title, h1: h1Matches[0] || "", description, metadata })
    : null;
  if (currentContract) findings.push(...currentContract.findings);

  const audit = {
    evidenceMode,
    title,
    h1: h1Matches[0] || "",
    description,
    canonical,
    robots,
    wordCount: contentWords,
    schemaCounts: schema.counts,
    schemaParseErrors: schema.errors,
    repeatedParagraphs,
    repeatedHeadings: repeatedHeadings.map(([heading, count]) => ({ heading, count })),
    sourceCount: sources.sourceCount,
    independentSourceCount: sources.independentSourceCount,
    sourceUrls: sources.urls,
    currentContract,
    findings,
  };
  audit.legacyCompatibility = buildLegacyCompatibility(audit, type);
  return audit;
}

function auditMetadata(item, hubCounts, hubCountsAvailable = true) {
  const metadata = item.metadata || {};
  const findings = [];
  let title = metadata.title || metadata.name || "";
  let words = null;
  let sourceCount = null;
  let independentSourceCount = null;

  if (item.type === "blog_article") {
    findings.push(...classifyHeadline(title, {
      url: item.url,
      eventTitle: metadata.eventTitle,
      historicalYear: metadata.historicalYear,
    }));
    const sources = sourceAudit(metadata, "", item.type);
    findings.push(...sources.findings);
    sourceCount = sources.sourceCount;
    independentSourceCount = sources.independentSourceCount;
    if (!metadata.description || String(metadata.description).trim().length < 70) {
      findings.push(finding("cosmetic", "weak_index_description", "medium", "Stored index description is missing or shorter than 70 characters."));
    }
    if (/example\.com|placeholder/i.test(metadata.imageUrl || "")) {
      findings.push(finding("technical", "placeholder_image", "high", "Article index points to a placeholder image."));
    }
  } else if (item.type === "person_entity" || item.type === "history_entity") {
    words = wordCount(`${metadata.summary || ""} ${metadata.intro || ""}`);
    if (!metadata.wikiUrl) findings.push(finding("source", "entity_missing_source", "high", "Entity has no Wikipedia identity/source URL."));
    if (!metadata.imageUrl) findings.push(finding("content", "entity_missing_image", "medium", "Entity has no image."));
    if (words < 45) findings.push(finding("content", "thin_entity_summary", "high", `Entity index summary contains approximately ${words} words.`));
    if (!Array.isArray(metadata.relatedPosts) || metadata.relatedPosts.length < 1) {
      findings.push(finding("hub", "orphan_entity", "high", "Entity has no related article in its index metadata."));
    }
    if (metadata.needsWikiRefresh === true) {
      findings.push(finding("content", "entity_refresh_pending", "medium", "Entity is marked as needing Wikipedia enrichment."));
    }
  } else if (item.type === "blog_hub") {
    const count = hubCounts.get(metadata.pillar) || 0;
    title = `${metadata.pillar || "Unknown"} hub`;
    if (!hubCountsAvailable) {
      findings.push(finding("hub", "hub_count_unavailable", "low", "Article-pillar inventory is unavailable; no indexability recommendation was inferred."));
    } else if (count < REQUIRED_HUB_ARTICLES) {
      findings.push(finding("hub", "thin_hub", "high", `Hub has ${count} related articles; indexability threshold is ${REQUIRED_HUB_ARTICLES}.`));
    }
  }

  const audit = {
    evidenceMode: item.contentMode,
    title,
    h1: "",
    description: metadata.description || metadata.summary || "",
    canonical: item.url,
    robots: "",
    wordCount: words,
    schemaCounts: {},
    schemaParseErrors: [],
    repeatedParagraphs: [],
    repeatedHeadings: [],
    sourceCount,
    independentSourceCount,
    sourceUrls: Array.isArray(metadata.sourcePages) ? metadata.sourcePages.map((source) => source.pageUrl).filter(Boolean) : [],
    currentContract: null,
    findings,
  };
  audit.legacyCompatibility = item.type === "blog_article"
    ? {
        applicable: true,
        status: "evidence_unavailable",
        safeRepairs: [],
        editorialReview: [{ code: "stored_html_unavailable", detail: "Stored HTML was unavailable, so compatibility with current rendering and publication gates could not be assessed." }],
        currentContractBlockers: [],
      }
    : buildLegacyCompatibility(audit, item.type);
  return audit;
}

function auditTemplateItem(item) {
  const traffic = item.traffic || {};
  const findings = [];
  if (
    item.type === "quiz_date" &&
    traffic.botQueries?.some((entry) => /(?:flight|pilot|born|died|answer|quiz)/i.test(entry.query))
  ) {
    findings.push(finding("factual", "quiz_distractor_query_risk", "medium", "A synthetic query exposed quiz-like entity combinations; distractor truthfulness needs manual review."));
  }
  const audit = {
    evidenceMode: item.contentMode,
    title: "",
    h1: "",
    description: "",
    canonical: item.url,
    robots: "",
    wordCount: null,
    schemaCounts: {},
    schemaParseErrors: [],
    repeatedParagraphs: [],
    repeatedHeadings: [],
    sourceCount: null,
    independentSourceCount: null,
    sourceUrls: [],
    currentContract: null,
    findings,
  };
  audit.legacyCompatibility = buildLegacyCompatibility(audit, item.type);
  return audit;
}

function positionBand(position) {
  if (!Number.isFinite(position)) return "unavailable";
  if (position <= 4) return "1-4";
  if (position <= 10) return "5-10";
  if (position <= 20) return "11-20";
  if (position <= 50) return "21-50";
  return "51+";
}

function attachMeasurement(items, gsc, backlinks) {
  for (const item of items) {
    item.traffic = gsc.byUrl.get(item.url) || {
      observed: false,
      clicks: null,
      impressions: null,
      position: null,
      knownHumanClicks: null,
      knownHumanImpressions: null,
      knownHumanPosition: null,
      knownBotImpressions: null,
      humanQueries: [],
      botQueries: [],
    };
    item.indexing = gsc.indexingByUrl?.get(item.url) || {
      observed: false,
      verdict: null,
      coverageState: null,
      lastCrawlTime: null,
      googleCanonical: null,
      userCanonical: null,
    };
    item.backlinks = backlinks.available
      ? backlinks.byUrl.get(item.url) || { backlinks: 0, referringDomains: 0 }
      : null;
  }
}

function duplicateKey(item) {
  const metadata = item.metadata || {};
  if (item.type === "blog_article") {
    const event = normalizedText(metadata.eventTitle || "");
    const year = Number(metadata.historicalYear || 0);
    return event && year ? `article:${year}:${event}` : "";
  }
  if (item.type === "person_entity" || item.type === "history_entity") {
    const wiki = String(metadata.wikiUrl || "").replace(/[#?].*$/, "").toLowerCase();
    if (wiki) return `entity-wiki:${item.type}:${wiki}`;
    const name = normalizedText(metadata.name || "");
    return name ? `entity-name:${item.type}:${name}` : "";
  }
  return "";
}

function scoreDuplicateLeader(item) {
  const traffic = item.traffic || {};
  const links = item.backlinks || {};
  const findings = item.audit?.findings || [];
  return (
    Number(traffic.clicks || 0) * 1000 +
    Number(traffic.impressions || 0) * 2 +
    Number(links.backlinks || 0) * 50 +
    Number(item.audit?.wordCount || 0) -
    findings.filter((entry) => entry.severity === "high").length * 500
  );
}

function markDuplicates(items) {
  const groups = new Map();
  for (const item of items) {
    const key = duplicateKey(item);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  let sequence = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    sequence += 1;
    const id = `duplicate-${String(sequence).padStart(3, "0")}`;
    group.sort((a, b) => scoreDuplicateLeader(b) - scoreDuplicateLeader(a));
    group.forEach((item, index) => {
      item.duplicateGroup = id;
      item.duplicateLeader = index === 0;
      if (index > 0) {
        item.audit.findings.push(finding("duplication", "duplicate_intent_candidate", "high", `Shares a strong event/entity identity with ${group[0].url}.`));
      }
    });
  }
}

function classifyItem(item, { gscCurrent = false, backlinksAvailable = false } = {}) {
  const findings = item.audit?.findings || [];
  const reasons = [];
  const has = (category, minimum = "low") => {
    const order = { low: 1, medium: 2, high: 3 };
    return findings.some((entry) => entry.category === category && order[entry.severity] >= order[minimum]);
  };
  const highFindings = findings.filter((entry) => entry.severity === "high");
  const humanImpressions = Number(item.traffic?.knownHumanImpressions || 0);
  const humanPosition = item.traffic?.knownHumanPosition;
  const winnable =
    humanImpressions >= WINNABLE_MIN_IMPRESSIONS &&
    Number.isFinite(humanPosition) &&
    humanPosition >= WINNABLE_POSITION[0] &&
    humanPosition <= WINNABLE_POSITION[1];

  if (item.duplicateGroup) {
    item.classification = "merge";
    reasons.push(
      item.duplicateLeader
        ? "Member of a strong duplicate group; this is only a provisional retain candidate, and the canonical winner requires manual traffic, backlink, URL-quality, and source review."
        : "Member of a strong duplicate group; consolidate only after a canonical winner is selected through manual traffic, backlink, URL-quality, and source review.",
    );
  } else if (has("hub", "high") && item.type === "blog_hub") {
    item.classification = "noindex";
    reasons.push("Hub is below the five-related-article indexability threshold.");
  } else if (
    has("factual", "medium") ||
    has("technical", "high") ||
    has("source", "high") ||
    has("content", "high") ||
    has("repetition", "medium") ||
    winnable
  ) {
    item.classification = "improve";
    if (has("factual", "medium")) reasons.push("Possible factual/headline risk requires human verification.");
    if (has("technical", "high")) reasons.push("High-severity technical or schema defect.");
    if (has("source", "high")) reasons.push("Direct-source coverage is below the publication standard.");
    if (has("content", "high")) reasons.push("Content completeness/original-value signal is weak.");
    if (has("repetition", "medium")) reasons.push("Repeated visible sections reduce page value.");
    if (winnable) reasons.push("Historical human-query opportunity sits in positions 5-20.");
  } else {
    item.classification = "keep";
    reasons.push(highFindings.length ? "No automated action beyond the listed manual checks." : "No high-confidence defect found in the available evidence.");
  }

  if (item.classification === "keep" && /\bnoindex\b/.test(item.audit?.robots || "")) {
    item.classification = "noindex";
    reasons.splice(0, reasons.length, "Page already declares noindex; remove it from index-oriented inventories if that directive is intentional.");
  }

  // A removal recommendation is intentionally impossible without both current
  // indexing/traffic evidence and backlink evidence. A missing dataset must
  // never be treated as a zero-value page.
  item.confidence = item.contentMode === "kv-stored-html" || item.contentMode === "local-html"
    ? "medium"
    : "low";
  if (gscCurrent && backlinksAvailable && item.confidence === "medium") item.confidence = "high";
  if (!gscCurrent || !backlinksAvailable) {
    reasons.push("Provisional: current GSC indexing/traffic and/or backlink evidence is unavailable.");
  }
  item.classificationReasons = [...new Set(reasons)];
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function reportMarkdown(items, context) {
  const lines = [];
  const now = new Date().toISOString().slice(0, 10);
  const classifications = countBy(items, (item) => item.classification);
  const types = countBy(items, (item) => item.type);
  const severityOrder = { high: 3, medium: 2, low: 1 };
  const factual = items
    .flatMap((item) => item.audit.findings.filter((entry) => entry.category === "factual").map((entry) => ({ item, entry })))
    .sort((a, b) => severityOrder[b.entry.severity] - severityOrder[a.entry.severity] || a.item.url.localeCompare(b.item.url));
  const repeated = items.filter((item) => item.audit.findings.some((entry) => entry.category === "repetition"));
  const sourceProblems = items.filter((item) => item.audit.findings.some((entry) => entry.category === "source" && entry.severity === "high"));
  const thinHubs = items.filter((item) => item.audit.findings.some((entry) => entry.code === "thin_hub"));
  const legacyArticles = items.filter((item) => item.type === "blog_article");
  const compatibilityCounts = countBy(
    legacyArticles,
    (item) => item.audit.legacyCompatibility?.status || "evidence_unavailable",
  );
  const deterministicRepairQueue = legacyArticles.filter(
    (item) => item.audit.legacyCompatibility?.status === "deterministic_safe_repair",
  );
  const safeRepairArticles = legacyArticles.filter(
    (item) => (item.audit.legacyCompatibility?.safeRepairs || []).length > 0,
  );
  const editorialRepairQueue = legacyArticles.filter(
    (item) => item.audit.legacyCompatibility?.status === "editorial_review_required",
  );
  const winnable = items
    .filter((item) => {
      const stats = item.traffic;
      return Number(stats?.knownHumanImpressions || 0) >= WINNABLE_MIN_IMPRESSIONS &&
        Number.isFinite(stats?.knownHumanPosition) &&
        stats.knownHumanPosition >= WINNABLE_POSITION[0] &&
        stats.knownHumanPosition <= WINNABLE_POSITION[1];
    })
    .sort((a, b) => Number(b.traffic.knownHumanImpressions || 0) - Number(a.traffic.knownHumanImpressions || 0));

  lines.push(`# Existing Content Inventory Quality Report — ${now}`);
  lines.push("");
  lines.push("This is a read-only decision report. It did not call public page routes and did not modify production KV, HTML, redirects, sitemaps, robots directives, canonicals, or indexability.");
  lines.push("");
  lines.push("## Executive summary");
  lines.push("");
  lines.push(`- **${items.length} unique URLs classified** across sitemap-intended templates, stored blog posts, entity records, local legacy pages, and GSC-observed URLs.`);
  lines.push(`- **${factual.length} possible factual/headline risks** are separated from cosmetic and technical issues. They are leads for human verification, not confirmed corrections.`);
  lines.push(`- **${sourceProblems.length} pages** have high-severity stored source-coverage findings.`);
  lines.push(`- **${repeated.length} pages** contain exact repeated paragraph/heading signals in the safely available stored/local HTML.`);
  lines.push(`- **${safeRepairArticles.length} legacy articles** have at least one metadata-only repair candidate (${deterministicRepairQueue.length} have no concurrent editorial finding); **${editorialRepairQueue.length}** require source or editorial review for their remaining content issues.`);
  lines.push(`- **Remove is deliberately zero unless current traffic/indexing and backlink evidence both support it.** Missing datasets are never interpreted as zero value.`);
  lines.push("");
  lines.push("## Evidence coverage and limitations");
  lines.push("");
  lines.push("| Signal | Coverage | Limitation |");
  lines.push("|---|---:|---|");
  lines.push(`| Production blog index | ${context.blogIndexCount} posts | Read through GET-only Cloudflare KV REST. |`);
  lines.push(`| Stored/local HTML | ${items.filter((item) => ["kv-stored-html", "local-html"].includes(item.contentMode)).length} pages | Stored HTML can differ from serve-time normalization; public routes were not invoked because some GET handlers can write repairs/entities. |`);
  lines.push(`| Entity metadata | ${items.filter((item) => item.contentMode === "kv-entity-metadata").length} pages | Metadata audit, not rendered-page crawl. |`);
  lines.push(`| Generated date templates | ${items.filter((item) => item.type.endsWith("_date")).length} pages | Classified per URL using route/template and GSC evidence; no production page fetches. |`);
  lines.push(`| Dynamic hub templates | ${items.filter((item) => item.type === "blog_hub").length} pages | Hub article counts come from the read-only blog index; rendered routes were not fetched. |`);
  lines.push(`| GSC traffic | ${context.gsc.available ? `${context.gsc.byUrl.size} observed URLs, ${context.gsc.windowStart} → ${context.gsc.windowEnd}` : "Unavailable"} | ${context.gscCurrent ? "Current." : `Cached export is stale (report ${context.gsc.reportDate}); anonymous-query totals exceed query-page rows.`} |`);
  lines.push(`| GSC indexing status | ${context.gsc.indexingAvailable ? `${context.gsc.indexingByUrl.size} URL Inspection results` : "Unavailable"} | ${context.gsc.indexingAvailable ? `${context.gscIndexingCurrent ? "Current" : "Stale"} export generated ${context.gsc.indexingGeneratedAt || "at an unknown time"}; URL Inspection reports Google's indexed version, not a live-page test.` : "Search Analytics observation is not the same as current URL Inspection/Pages indexing state."} |`);
  lines.push(`| Backlinks | ${context.backlinks.available ? `${context.backlinks.byUrl.size} URLs from supplied export` : "Unavailable"} | ${context.backlinks.available ? "Counts depend on the supplied export." : "No Search Console Links or third-party backlink export was supplied."} |`);
  lines.push("");
  if (!context.gscIndexingCurrent || !context.backlinks.available) {
    lines.push("Because current GSC indexing and/or backlinks are incomplete, every classification is a recommendation for review, not authorization to change production.");
  } else {
    lines.push("Current measurement inputs are available, but classifications remain review recommendations and do not authorize production changes.");
  }
  lines.push("");
  lines.push("## Classification summary");
  lines.push("");
  lines.push("| Classification | Pages | Meaning |");
  lines.push("|---|--:|---|");
  const meanings = {
    keep: "No high-confidence defect in available evidence; continue monitoring.",
    improve: "Retain URL and repair factual, source, content, repetition, schema, or winnable-snippet issues.",
    merge: "Strong duplicate candidate; choose a canonical winner only after manual traffic/backlink review.",
    noindex: "Page/hub is below the indexability threshold or already declares noindex.",
    remove: "Reserved for confirmed gone/valueless URLs with current traffic and backlink proof.",
  };
  for (const classification of ["keep", "improve", "merge", "noindex", "remove"]) {
    lines.push(`| ${classification} | ${classifications.get(classification) || 0} | ${meanings[classification]} |`);
  }
  lines.push("");
  lines.push("### By page type");
  lines.push("");
  lines.push("| Type | Pages | Keep | Improve | Merge | Noindex | Remove |");
  lines.push("|---|--:|--:|--:|--:|--:|--:|");
  for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
    const typed = items.filter((item) => item.type === type);
    const typedCounts = countBy(typed, (item) => item.classification);
    lines.push(`| ${type} | ${count} | ${typedCounts.get("keep") || 0} | ${typedCounts.get("improve") || 0} | ${typedCounts.get("merge") || 0} | ${typedCounts.get("noindex") || 0} | ${typedCounts.get("remove") || 0} |`);
  }
  lines.push("");

  lines.push("## Legacy compatibility and safe repair queue");
  lines.push("");
  lines.push("This compares stored article HTML with the current publication contract. It proposes actions only; it does not rewrite KV. Deterministic-safe means the action changes machine metadata or canonical markup without inventing historical prose. Any source, factual, image-subject, or content change remains editorial-review work.");
  lines.push("");
  lines.push("| Compatibility status | Articles | Next step |");
  lines.push("|---|--:|---|");
  const compatibilityMeaning = {
    compatible: "No contract gap detected in the safely available evidence.",
    deterministic_safe_repair: "Preview a metadata-only patch, validate its exact diff, then approve a small production batch.",
    editorial_review_required: "Verify sources and facts before changing stored content.",
    evidence_unavailable: "Recover/read stored HTML before deciding.",
  };
  for (const status of ["compatible", "deterministic_safe_repair", "editorial_review_required", "evidence_unavailable"]) {
    lines.push(`| ${status} | ${compatibilityCounts.get(status) || 0} | ${compatibilityMeaning[status]} |`);
  }
  lines.push("");

  lines.push("### Metadata-only candidates");
  lines.push("");
  lines.push("These actions can be previewed independently even when the same article has separate editorial findings. Applying a metadata-only action does not mark the article fully compatible.");
  lines.push("");
  if (!safeRepairArticles.length) {
    lines.push("No metadata-only candidates were found.");
  } else {
    lines.push("| URL | Proposed metadata-only actions | Editorial review still required? | Current-contract blockers cleared by those actions |");
    lines.push("|---|---|---|---|");
    for (const item of safeRepairArticles.slice(0, 80)) {
      const compatibility = item.audit.legacyCompatibility;
      const safeCodes = new Set(compatibility.safeRepairs.map((entry) => entry.code));
      if (safeCodes.has("obsolete_news_schema")) safeCodes.add("article_schema_count");
      const clearedBlockers = compatibility.currentContractBlockers
        .filter((entry) => safeCodes.has(entry.code))
        .map((entry) => entry.code);
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${markdownCell(compatibility.safeRepairs.map((entry) => `${entry.code}: ${entry.detail}`).join("; "))} | ${compatibility.editorialReview.length ? "yes" : "no"} | ${markdownCell(clearedBlockers.join(", ")) || "—"} |`);
    }
    if (safeRepairArticles.length > 80) lines.push(`\n_${safeRepairArticles.length - 80} additional metadata-only candidates are in the CSV/JSON inventory._`);
  }
  lines.push("");

  lines.push("### Editorial/source review queue");
  lines.push("");
  if (!editorialRepairQueue.length) {
    lines.push("No stored article requires editorial review under the current deterministic checks.");
  } else {
    lines.push("| URL | Current-contract blockers | Review-required findings | Safe actions that can be bundled after review |");
    lines.push("|---|---|---|---|");
    for (const item of editorialRepairQueue.slice(0, 80)) {
      const compatibility = item.audit.legacyCompatibility;
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${markdownCell(compatibility.currentContractBlockers.map((entry) => entry.code).join(", ")) || "—"} | ${markdownCell(compatibility.editorialReview.map((entry) => entry.code).join(", ")) || "—"} | ${markdownCell(compatibility.safeRepairs.map((entry) => entry.code).join(", ")) || "—"} |`);
    }
    if (editorialRepairQueue.length > 80) lines.push(`\n_${editorialRepairQueue.length - 80} additional review candidates are in the CSV/JSON inventory._`);
  }
  lines.push("");

  lines.push(`## Possible factual or headline risks — ${factual.length}`);
  lines.push("");
  lines.push("These are separated from cosmetic findings. Verify each against authoritative sources before changing a title or article.");
  lines.push("");
  if (!factual.length) {
    lines.push("None detected by the deterministic checks.");
  } else {
    lines.push("| Severity | URL | Code | Evidence |");
    lines.push("|---|---|---|---|");
    for (const { item, entry } of factual.slice(0, 80)) {
      lines.push(`| ${entry.severity} | ${markdownCell(item.url.replace(SITE, ""))} | ${entry.code} | ${markdownCell(entry.detail)} |`);
    }
    if (factual.length > 80) lines.push(`\n_${factual.length - 80} additional factual-risk rows are in the CSV/JSON inventory._`);
  }
  lines.push("");

  lines.push(`## Direct-source coverage — ${sourceProblems.length} high-severity pages`);
  lines.push("");
  if (!sourceProblems.length) {
    lines.push("No high-severity source gap was detected in available stored metadata/HTML.");
  } else {
    lines.push("| URL | Sources | Independent | Finding(s) |");
    lines.push("|---|--:|--:|---|");
    for (const item of sourceProblems.slice(0, 60)) {
      const details = item.audit.findings.filter((entry) => entry.category === "source").map((entry) => entry.detail).join("; ");
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${item.audit.sourceCount ?? "—"} | ${item.audit.independentSourceCount ?? "—"} | ${markdownCell(details)} |`);
    }
    if (sourceProblems.length > 60) lines.push(`\n_${sourceProblems.length - 60} additional source rows are in the CSV/JSON inventory._`);
  }
  lines.push("");

  lines.push(`## Repeated sections — ${repeated.length} pages`);
  lines.push("");
  if (!repeated.length) lines.push("No exact repeated paragraph or heading signals were found in safely audited HTML.");
  else {
    lines.push("| URL | Signal |");
    lines.push("|---|---|");
    for (const item of repeated.slice(0, 50)) {
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${markdownCell(item.audit.findings.filter((entry) => entry.category === "repetition").map((entry) => entry.detail).join("; "))} |`);
    }
  }
  lines.push("");

  lines.push(`## Hub relevance — ${thinHubs.length} below threshold`);
  lines.push("");
  lines.push(`A narrow hub needs at least ${REQUIRED_HUB_ARTICLES} genuinely related indexed articles before “keep” is recommended.`);
  lines.push("");
  if (!thinHubs.length) lines.push("All configured blog hubs meet the mechanical article-count threshold. Evidence-based membership still requires editorial review.");
  else {
    lines.push("| Hub | Recommendation | Evidence |");
    lines.push("|---|---|---|");
    for (const item of thinHubs) {
      const evidence = item.audit.findings.find((entry) => entry.code === "thin_hub")?.detail || "";
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | noindex | ${markdownCell(evidence)} |`);
    }
  }
  lines.push("");

  lines.push("## Historical GSC opportunities");
  lines.push("");
  lines.push(`Position bands use known human query-page rows from the cached export; anonymous queries are not silently classified as human or bot.`);
  lines.push("");
  const observed = items.filter((item) => item.traffic?.observed);
  const allBands = countBy(observed, (item) => positionBand(item.traffic?.position));
  const knownHuman = items.filter((item) => Number(item.traffic?.knownHumanImpressions || 0) > 0);
  const humanBands = countBy(knownHuman, (item) => positionBand(item.traffic?.knownHumanPosition));
  lines.push("### Known human query-page position bands");
  lines.push("");
  lines.push("| Average-position band | Pages with known human queries |");
  lines.push("|---|--:|");
  for (const band of ["1-4", "5-10", "11-20", "21-50", "51+", "unavailable"]) {
    lines.push(`| ${band} | ${humanBands.get(band) || 0} |`);
  }
  lines.push("");
  lines.push("### All page-level Search Analytics position bands");
  lines.push("");
  lines.push("This second view includes anonymous and bot/agent impressions and must not be interpreted as human-query ranking.");
  lines.push("");
  lines.push("| Average-position band | GSC-observed pages (mixed query segments) |");
  lines.push("|---|--:|");
  for (const band of ["1-4", "5-10", "11-20", "21-50", "51+", "unavailable"]) {
    lines.push(`| ${band} | ${allBands.get(band) || 0} |`);
  }
  lines.push("");
  lines.push(`### Human-query pages with ≥${WINNABLE_MIN_IMPRESSIONS} impressions in positions ${WINNABLE_POSITION[0]}–${WINNABLE_POSITION[1]}`);
  lines.push("");
  if (!winnable.length) lines.push("None in the cached query-page export.");
  else {
    lines.push("| URL | Human impr | Pos | Clicks | Top human queries |");
    lines.push("|---|--:|--:|--:|---|");
    for (const item of winnable) {
      const queries = (item.traffic.humanQueries || []).slice(0, 3).map((entry) => entry.query).join("; ");
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${item.traffic.knownHumanImpressions} | ${item.traffic.knownHumanPosition.toFixed(1)} | ${item.traffic.knownHumanClicks} | ${markdownCell(queries)} |`);
    }
  }
  lines.push("");

  lines.push("## Backlinks");
  lines.push("");
  if (!context.backlinks.available) {
    lines.push("No backlink export was supplied. Backlinks are recorded as **unavailable**, never zero. Merge, noindex, and remove decisions must be rechecked after importing Search Console Links or another trusted backlink export.");
  } else {
    const linked = items.filter((item) => Number(item.backlinks?.backlinks || 0) > 0).sort((a, b) => b.backlinks.backlinks - a.backlinks.backlinks);
    lines.push(`Backlink data covers ${context.backlinks.byUrl.size} URLs; ${linked.length} inventory URLs have at least one reported external link.`);
    lines.push("");
    lines.push("| URL | Backlinks | Referring domains | Classification |");
    lines.push("|---|--:|--:|---|");
    for (const item of linked.slice(0, 50)) {
      lines.push(`| ${markdownCell(item.url.replace(SITE, ""))} | ${item.backlinks.backlinks} | ${item.backlinks.referringDomains} | ${item.classification} |`);
    }
  }
  lines.push("");

  lines.push("## Full per-URL inventory");
  lines.push("");
  lines.push("Every URL and its classification, evidence mode, measurements, findings, and reasons are in:");
  lines.push("");
  lines.push("- `inventory-quality-report.csv` — sortable decision sheet.");
  lines.push("- `inventory-quality-report.json` — complete machine-readable evidence.");
  lines.push("");
  lines.push("## Classification safeguards");
  lines.push("");
  lines.push("- `keep` does not certify factual accuracy; it means no high-confidence defect was found in available evidence.");
  lines.push("- `improve` preserves the URL and separates possible factual corrections from cosmetic work.");
  lines.push("- `merge` is a candidate only; choose the winner after current traffic, backlinks, canonical intent, and source coverage are reviewed.");
  lines.push("- `noindex` is recommended only for a mechanical thin-hub/directive case in this preliminary run.");
  lines.push("- `remove` requires confirmed current indexing/traffic plus backlink evidence and is intentionally unavailable when either dataset is missing.");
  lines.push("- No recommendation in this report authorizes a production change.");
  lines.push("");
  return lines.join("\n");
}

function reportCsv(items) {
  const headers = [
    "url", "type", "classification", "confidence", "discovery", "evidence_mode",
    "title", "word_count", "legacy_compatibility", "safe_repairs", "editorial_review",
    "current_contract_blockers", "quick_fact_count", "did_you_know_count",
    "did_you_know_duplicate_pairs", "people_label_count", "positive_analysis_count",
    "critical_analysis_count", "hero_image_url", "hero_image_alt", "hero_image_supported",
    "factual_risks", "technical_issues", "cosmetic_issues", "content_issues",
    "source_issues", "repetition_issues", "source_count", "independent_source_count",
    "duplicate_group", "gsc_observed", "impressions", "clicks", "all_query_position", "all_query_position_band",
    "known_human_impressions", "known_human_clicks", "known_human_position",
    "known_bot_impressions", "backlinks", "referring_domains", "classification_reasons",
  ];
  const rows = [headers];
  for (const item of items) {
    const findings = item.audit.findings;
    const compatibility = item.audit.legacyCompatibility || {};
    const contract = item.audit.currentContract || {};
    const details = (category) => findings.filter((entry) => entry.category === category).map((entry) => `${entry.code}: ${entry.detail}`).join(" | ");
    rows.push([
      item.url,
      item.type,
      item.classification,
      item.confidence,
      [...item.discovery].join(" | "),
      item.contentMode,
      item.audit.title,
      item.audit.wordCount ?? "",
      compatibility.status || "not_applicable",
      (compatibility.safeRepairs || []).map((entry) => `${entry.code}: ${entry.detail}`).join(" | "),
      (compatibility.editorialReview || []).map((entry) => `${entry.code}: ${entry.detail}`).join(" | "),
      (compatibility.currentContractBlockers || []).map((entry) => entry.code).join(" | "),
      contract.quickFactCount ?? "",
      contract.didYouKnowCount ?? "",
      (contract.didYouKnowDuplicatePairs || []).map((pair) => pair.join("-" )).join(" | "),
      contract.peopleLabelCount ?? "",
      contract.positiveAnalysisCount ?? "",
      contract.criticalAnalysisCount ?? "",
      contract.heroImageUrl || "",
      contract.heroImageAlt || "",
      contract.heroImageSupported == null ? "" : contract.heroImageSupported ? "yes" : "no",
      details("factual"),
      details("technical"),
      details("cosmetic"),
      details("content"),
      details("source"),
      details("repetition"),
      item.audit.sourceCount ?? "",
      item.audit.independentSourceCount ?? "",
      item.duplicateGroup,
      item.traffic?.observed ? "yes" : "no",
      item.traffic?.impressions ?? "",
      item.traffic?.clicks ?? "",
      item.traffic?.position ?? "",
      positionBand(item.traffic?.position),
      item.traffic?.knownHumanImpressions ?? "",
      item.traffic?.knownHumanClicks ?? "",
      item.traffic?.knownHumanPosition ?? "",
      item.traffic?.knownBotImpressions ?? "",
      item.backlinks?.backlinks ?? "unavailable",
      item.backlinks?.referringDomains ?? "unavailable",
      item.classificationReasons.join(" | "),
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function writeUnifiedDiff(beforePath, afterPath, diffPath) {
  const result = spawnSync("diff", ["-u", beforePath, afterPath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) {
    throw new Error(`diff failed for ${beforePath}: ${String(result.stderr || "unknown error").trim()}`);
  }
  writeFileSync(diffPath, result.stdout || "");
}

function writeLegacySafeRepairPlan(
  items,
  { outputDir, limit, generatedAt = new Date() } = {},
) {
  if (!Number.isInteger(limit) || limit < 1) return null;
  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const planDir = join(outputDir, `legacy-safe-repair-plan-${stamp}`);
  const backupDir = join(planDir, "backups");
  const proposedDir = join(planDir, "proposed");
  const diffDir = join(planDir, "diffs");
  for (const path of [planDir, backupDir, proposedDir, diffDir]) mkdirSync(path, { recursive: true });

  const supportedCodes = new Set([
    "obsolete_news_schema",
    "obsolete_faq_schema",
    "duplicate_breadcrumb_schema",
    "missing_canonical",
  ]);
  const candidates = items
    .filter((item) =>
      item.type === "blog_article" &&
      item.contentMode === "kv-stored-html" &&
      item.html &&
      /^[a-z0-9-]+$/.test(item.metadata?.slug || "") &&
      (item.audit.legacyCompatibility?.safeRepairs || []).some((entry) => supportedCodes.has(entry.code)),
    )
    .sort((left, right) =>
      new Date(right.metadata?.publishedAt || 0) - new Date(left.metadata?.publishedAt || 0) ||
      left.url.localeCompare(right.url),
    );

  const plans = [];
  const skippedCandidates = [];
  for (const item of candidates) {
    if (plans.length >= limit) break;
    const requestedCodes = item.audit.legacyCompatibility.safeRepairs
      .map((entry) => entry.code)
      .filter((code) => supportedCodes.has(code));
    const result = applyDeterministicLegacyRepairs(item.html, {
      url: item.url,
      metadata: item.metadata,
      requestedCodes,
    });
    if (!result.changed || !result.applied.length) {
      skippedCandidates.push({
        slug: item.metadata.slug,
        requestedCodes,
        skipped: result.skipped,
      });
      continue;
    }

    const slug = item.metadata.slug;
    const beforePath = join(backupDir, `post-${slug}.html`);
    const afterPath = join(proposedDir, `post-${slug}.html`);
    const diffPath = join(diffDir, `post-${slug}.diff`);
    writeFileSync(beforePath, item.html);
    writeFileSync(afterPath, result.html);
    writeUnifiedDiff(beforePath, afterPath, diffPath);

    const afterAudit = auditHtml(result.html, {
      url: item.url,
      type: "blog_article",
      metadata: item.metadata,
      evidenceMode: "dry-run-after",
    });
    plans.push({
      slug,
      kvKey: `post:${slug}`,
      url: item.url,
      publishedAt: item.metadata?.publishedAt || "",
      beforeBytes: Buffer.byteLength(item.html),
      afterBytes: Buffer.byteLength(result.html),
      beforeSha256: result.beforeSha256,
      afterSha256: result.afterSha256,
      applied: result.applied,
      skipped: result.skipped,
      remainingEditorialReview: afterAudit.legacyCompatibility.editorialReview,
      remainingContractBlockers: afterAudit.legacyCompatibility.currentContractBlockers,
      paths: {
        backup: relative(ROOT, beforePath),
        proposed: relative(ROOT, afterPath),
        diff: relative(ROOT, diffPath),
      },
    });
  }

  const manifest = {
    generatedAt: generatedAt.toISOString(),
    mode: "GET-only dry run",
    productionWrites: 0,
    publicPageFetches: 0,
    requestedLimit: limit,
    plannedValues: plans.length,
    instructions: "Re-read and back up each live KV value immediately before any separately approved write. Refuse to apply if its SHA-256 no longer matches beforeSha256.",
    plans,
    skippedCandidates,
  };
  const manifestPath = join(planDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const lines = [
    `# Legacy metadata safe-repair plan — ${generatedAt.toISOString()}`,
    "",
    "**Dry run only. Production writes: 0.**",
    "",
    "Every proposed KV value has a byte-for-byte backup, proposed replacement, unified diff, and SHA-256 precondition. A later apply step must re-read production and refuse the write if the live hash changed.",
    "",
    `Planned values: ${plans.length} of requested ${limit}.`,
    "",
    "| KV key | Metadata-only actions | Before SHA-256 | After SHA-256 | Diff | Editorial review remains? |",
    "|---|---|---|---|---|---|",
  ];
  for (const plan of plans) {
    lines.push(`| ${plan.kvKey} | ${plan.applied.map((entry) => entry.code).join(", ")} | ${plan.beforeSha256} | ${plan.afterSha256} | ${plan.paths.diff} | ${plan.remainingEditorialReview.length ? "yes" : "no"} |`);
  }
  if (!plans.length) lines.push("| — | No conservative transformation could be verified. | — | — | — | — |");
  lines.push("");
  lines.push("This plan does not authorize publication, regeneration, title changes, source changes, or factual rewrites.");
  const summaryPath = join(planDir, "README.md");
  writeFileSync(summaryPath, lines.join("\n"));

  return {
    planDir,
    manifestPath,
    summaryPath,
    plannedValues: plans.length,
    skippedCandidates: skippedCandidates.length,
    plans,
  };
}

function assertPathInside(root, path, label) {
  const fullPath = resolve(root, path || "");
  if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the allowed artifact root`);
  }
  return fullPath;
}

function exactHtmlSurface(html, pattern) {
  return String(html || "").match(pattern)?.[0] || "";
}

function assertMetadataOnlyProposal(beforeHtml, proposedHtml, plan) {
  const requestedCodes = (plan.applied || []).map((entry) => entry.code).filter(Boolean);
  if (!requestedCodes.length) throw new Error(`${plan.kvKey} has no declared repair actions`);
  const regenerated = applyDeterministicLegacyRepairs(beforeHtml, {
    url: plan.url,
    requestedCodes,
  });
  if (regenerated.html !== proposedHtml) {
    throw new Error(`${plan.kvKey} proposal does not match the deterministic transformers`);
  }

  const beforeBody = exactHtmlSurface(beforeHtml, /<body\b[^>]*>[\s\S]*<\/body\s*>/i);
  const proposedBody = exactHtmlSurface(proposedHtml, /<body\b[^>]*>[\s\S]*<\/body\s*>/i);
  if (!beforeBody || beforeBody !== proposedBody) {
    throw new Error(`${plan.kvKey} proposal changes the visible document body`);
  }

  const beforeTitle = exactHtmlSurface(beforeHtml, /<title\b[^>]*>[\s\S]*?<\/title\s*>/i);
  const proposedTitle = exactHtmlSurface(proposedHtml, /<title\b[^>]*>[\s\S]*?<\/title\s*>/i);
  if (beforeTitle !== proposedTitle) throw new Error(`${plan.kvKey} proposal changes the title element`);

  if (!requestedCodes.includes("missing_canonical")) {
    const beforeCanonical = extractCanonical(beforeHtml);
    const proposedCanonical = extractCanonical(proposedHtml);
    if (beforeCanonical !== proposedCanonical) {
      throw new Error(`${plan.kvKey} proposal changes the canonical URL`);
    }
  }
}

async function applyLegacySafeRepairPlan(
  manifestPath,
  {
    limit,
    confirmed = false,
    env = null,
    artifactRoot = ROOT,
    generatedAt = new Date(),
    readKv = null,
    writeKv = null,
  } = {},
) {
  if (!confirmed) throw new Error("Production repair apply requires explicit confirmation");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Repair apply limit must be an integer from 1 to 10");
  }
  const resolvedManifestPath = resolve(manifestPath || "");
  if (!existsSync(resolvedManifestPath)) throw new Error(`Repair manifest not found: ${resolvedManifestPath}`);
  const manifest = readJson(resolvedManifestPath, null);
  if (!manifest || manifest.mode !== "GET-only dry run" || manifest.productionWrites !== 0) {
    throw new Error("Refusing an invalid or non-dry-run repair manifest");
  }
  if (!Array.isArray(manifest.plans) || manifest.plans.length < limit) {
    throw new Error(`Repair manifest contains fewer than ${limit} plans`);
  }

  const credentials = env || parseEnvFile(join(ROOT, "youtube-upload/.env"));
  const kvRead = readKv || ((key) => readKvValue(credentials, key));
  const kvWrite = writeKv || ((key, value) => writeKvValue(credentials, key, value));
  const selectedPlans = manifest.plans.slice(0, limit);
  const preflight = [];

  // Validate the complete batch before the first write so a stale later entry
  // cannot leave an avoidable partially applied batch.
  for (const plan of selectedPlans) {
    if (!/^post:[a-z0-9-]+$/.test(plan.kvKey || "") || !/^[a-z0-9-]+$/.test(plan.slug || "")) {
      throw new Error("Repair manifest contains an unsafe KV key or slug");
    }
    if (plan.kvKey !== `post:${plan.slug}`) throw new Error(`${plan.kvKey} does not match its slug`);
    const backupPath = assertPathInside(artifactRoot, plan.paths?.backup, `${plan.kvKey} backup path`);
    const proposedPath = assertPathInside(artifactRoot, plan.paths?.proposed, `${plan.kvKey} proposed path`);
    const plannedBackup = readFileSync(backupPath, "utf8");
    const proposed = readFileSync(proposedPath, "utf8");
    if (sha256(plannedBackup) !== plan.beforeSha256) {
      throw new Error(`${plan.kvKey} planned backup hash does not match the manifest`);
    }
    if (sha256(proposed) !== plan.afterSha256) {
      throw new Error(`${plan.kvKey} proposed hash does not match the manifest`);
    }
    assertMetadataOnlyProposal(plannedBackup, proposed, plan);
    const live = await kvRead(plan.kvKey);
    if (live == null) throw new Error(`${plan.kvKey} is missing from live KV`);
    const liveSha256 = sha256(live);
    if (liveSha256 !== plan.beforeSha256) {
      throw new Error(`${plan.kvKey} live hash changed; refusing the complete batch`);
    }
    preflight.push({ plan, proposed });
  }

  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const applyDir = join(dirname(resolvedManifestPath), `live-apply-${stamp}`);
  const backupDir = join(applyDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const reportPath = join(applyDir, "result.json");
  const report = {
    startedAt: generatedAt.toISOString(),
    manifestPath: relative(ROOT, resolvedManifestPath),
    mode: "confirmed production KV metadata repair",
    requestedValues: limit,
    productionWrites: 0,
    publicPageFetches: 0,
    completed: [],
  };

  try {
    for (const { plan, proposed } of preflight) {
      // Re-read immediately before this write. The just-read value is also the
      // byte-for-byte recovery backup for this specific operation.
      const live = await kvRead(plan.kvKey);
      const liveSha256 = sha256(live);
      if (liveSha256 !== plan.beforeSha256) {
        throw new Error(`${plan.kvKey} changed after preflight; refusing this and later writes`);
      }
      const liveBackupPath = join(backupDir, `${plan.kvKey.replace(":", "-")}.html`);
      writeFileSync(liveBackupPath, live);
      if (sha256(readFileSync(liveBackupPath, "utf8")) !== liveSha256) {
        throw new Error(`${plan.kvKey} live backup verification failed`);
      }

      await kvWrite(plan.kvKey, proposed);
      report.productionWrites += 1;

      let verified = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const stored = await kvRead(plan.kvKey);
        if (sha256(stored) === plan.afterSha256) {
          verified = true;
          break;
        }
        if (attempt < 5) await new Promise((done) => setTimeout(done, 1000));
      }
      if (!verified) throw new Error(`${plan.kvKey} write completed but its after-hash could not be verified`);
      report.completed.push({
        slug: plan.slug,
        kvKey: plan.kvKey,
        beforeSha256: plan.beforeSha256,
        afterSha256: plan.afterSha256,
        backup: relative(ROOT, liveBackupPath),
        actions: plan.applied.map((entry) => entry.code),
        verified: true,
      });
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
  } catch (error) {
    report.failedAt = new Date().toISOString();
    report.failure = error.message;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    error.applyReportPath = reportPath;
    throw error;
  }

  report.completedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { applyDir, reportPath, ...report };
}

function serializableItem(item) {
  return {
    ...item,
    discovery: [...item.discovery],
    html: undefined,
  };
}

async function runAudit(options = {}) {
  const gsc = loadGscCache(options.gscDir || DEFAULT_GSC_DIR);
  const backlinks = loadBacklinks(options.backlinks || "");
  const cfEnv = parseEnvFile(join(ROOT, "youtube-upload/.env"));
  let blogIndex = [];
  let entityIndex = [];
  let kvAvailable = false;
  const warnings = [];

  if (!options.noKv) {
    try {
      [blogIndex, entityIndex] = await Promise.all([
        readKvValue(cfEnv, "index", { json: true }),
        readKvValue(cfEnv, "entity-index-v1", { json: true }),
      ]);
      blogIndex = Array.isArray(blogIndex) ? blogIndex : [];
      entityIndex = Array.isArray(entityIndex) ? entityIndex : [];
      kvAvailable = true;
    } catch (error) {
      warnings.push(error.message);
    }
  }

  if (!blogIndex.length) {
    blogIndex = readJson(join(ROOT, "blog/archive.json"), []);
    warnings.push("Using local blog/archive.json because the production blog index was unavailable.");
  }

  const items = buildInventory({ blogIndex, entityIndex, gsc });
  attachMeasurement(items, gsc, backlinks);
  const hubCounts = new Map();
  for (const post of blogIndex) {
    for (const pillar of Array.isArray(post?.pillars) ? post.pillars : []) {
      hubCounts.set(pillar, (hubCounts.get(pillar) || 0) + 1);
    }
  }
  const hubCountsAvailable = blogIndex.some((post) => Array.isArray(post?.pillars) && post.pillars.length > 0);

  if (kvAvailable) {
    const storedPosts = items.filter((item) => item.contentMode === "kv-stored-html" && item.metadata?.slug);
    await mapLimit(storedPosts, 6, async (item, index) => {
      try {
        item.html = await readKvValue(cfEnv, `post:${item.metadata.slug}`) || "";
        if (!item.html) item.contentMode = "kv-index-only";
      } catch (error) {
        item.contentMode = "kv-index-only";
        warnings.push(`${item.metadata.slug}: ${error.message}`);
      }
      if ((index + 1) % 25 === 0) console.log(`Read ${index + 1}/${storedPosts.length} stored posts (GET only)…`);
    });
  }

  for (const item of items) {
    if (item.contentMode === "local-html" && item.localFile && existsSync(item.localFile)) {
      item.html = readFileSync(item.localFile, "utf8");
    }
    if (item.html) {
      item.audit = auditHtml(item.html, {
        url: item.url,
        type: item.type,
        metadata: item.metadata,
        evidenceMode: item.contentMode,
      });
    } else if (item.metadata || item.type === "blog_hub") {
      item.audit = auditMetadata(item, hubCounts, hubCountsAvailable);
    } else {
      item.audit = auditTemplateItem(item);
    }
  }

  markDuplicates(items);

  const now = new Date();
  const gscDate = /^\d{4}-\d{2}-\d{2}$/.test(gsc.reportDate) ? new Date(`${gsc.reportDate}T00:00:00Z`) : null;
  const gscAgeDays = gscDate ? Math.floor((now - gscDate) / 86_400_000) : Infinity;
  const gscCurrent = gscAgeDays <= 14;
  const indexingDate = gsc.indexingGeneratedAt ? new Date(gsc.indexingGeneratedAt) : null;
  const gscIndexingAgeDays = indexingDate && Number.isFinite(indexingDate.getTime())
    ? Math.floor((now - indexingDate) / 86_400_000)
    : Infinity;
  const gscIndexingCurrent = gsc.indexingAvailable && gscIndexingAgeDays <= 14;
  for (const item of items) {
    classifyItem(item, {
      gscCurrent: gscCurrent && gscIndexingCurrent,
      backlinksAvailable: backlinks.available,
    });
  }

  const context = {
    generatedAt: now.toISOString(),
    productionWrites: 0,
    publicPageFetches: 0,
    kvReadOnly: kvAvailable,
    blogIndexCount: blogIndex.length,
    entityIndexCount: entityIndex.length,
    gsc,
    gscCurrent,
    gscAgeDays: Number.isFinite(gscAgeDays) ? gscAgeDays : null,
    gscIndexingCurrent,
    gscIndexingAgeDays: Number.isFinite(gscIndexingAgeDays) ? gscIndexingAgeDays : null,
    backlinks,
    warnings,
  };

  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  mkdirSync(outputDir, { recursive: true });
  let repairPlan = null;
  if (Number(options.repairPlanLimit || 0) > 0) {
    if (!kvAvailable) {
      throw new Error("Safe repair planning requires read-only production KV access; refusing to plan from fallback/local data.");
    }
    repairPlan = writeLegacySafeRepairPlan(items, {
      outputDir,
      limit: options.repairPlanLimit,
      generatedAt: now,
    });
    context.safeRepairPlan = {
      mode: "GET-only dry run",
      productionWrites: 0,
      plannedValues: repairPlan?.plannedValues || 0,
      skippedCandidates: repairPlan?.skippedCandidates || 0,
      planDir: repairPlan?.planDir || "",
      manifestPath: repairPlan?.manifestPath || "",
      summaryPath: repairPlan?.summaryPath || "",
    };
  }
  const markdownPath = join(outputDir, "inventory-quality-report.md");
  const csvPath = join(outputDir, "inventory-quality-report.csv");
  const jsonPath = join(outputDir, "inventory-quality-report.json");
  writeFileSync(markdownPath, reportMarkdown(items, context));
  writeFileSync(csvPath, reportCsv(items));
  writeFileSync(jsonPath, JSON.stringify({
    context: {
      ...context,
      gsc: { ...gsc, byUrl: undefined, indexingByUrl: undefined },
      backlinks: { ...backlinks, byUrl: undefined },
    },
    items: items.map(serializableItem),
  }, null, 2));

  return { items, context, paths: { markdownPath, csvPath, jsonPath }, repairPlan };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.applyRepairPlan) {
    const result = await applyLegacySafeRepairPlan(options.applyRepairPlan, {
      limit: options.applyLimit,
      confirmed: options.confirmProductionWrite,
    });
    console.log("\nConfirmed legacy metadata repair batch complete.");
    console.log(`KV values written and verified: ${result.completed.length}`);
    console.log(`Production writes: ${result.productionWrites}; public page fetches: ${result.publicPageFetches}`);
    console.log(`Result: ${result.reportPath}`);
    return;
  }
  const result = await runAudit(options);
  const counts = countBy(result.items, (item) => item.classification);
  console.log("\nRead-only inventory quality audit complete.");
  console.log(`URLs: ${result.items.length}`);
  console.log(`Classifications: keep ${counts.get("keep") || 0}, improve ${counts.get("improve") || 0}, merge ${counts.get("merge") || 0}, noindex ${counts.get("noindex") || 0}, remove ${counts.get("remove") || 0}`);
  console.log(`Production writes: ${result.context.productionWrites}; public page fetches: ${result.context.publicPageFetches}`);
  console.log(`GSC cache: ${result.context.gsc.reportDate} (${result.context.gscCurrent ? "current" : "stale"}); backlinks: ${result.context.backlinks.available ? "supplied" : "unavailable"}`);
  if (result.context.warnings.length) console.log(`Warnings: ${result.context.warnings.length}`);
  console.log(`Report: ${result.paths.markdownPath}`);
  console.log(`CSV: ${result.paths.csvPath}`);
  console.log(`JSON: ${result.paths.jsonPath}`);
  if (result.repairPlan) {
    console.log(`Safe repair plan: ${result.repairPlan.summaryPath}`);
    console.log(`Planned KV values: ${result.repairPlan.plannedValues}; production writes: 0`);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error("ERROR:", error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  applyLegacySafeRepairPlan,
  auditHtml,
  applyDeterministicLegacyRepairs,
  buildInventory,
  classifyHeadline,
  classifyItem,
  isBotQuery,
  loadBacklinks,
  loadGscCache,
  markDuplicates,
  normalizeUrl,
  pageType,
  positionBand,
  reportCsv,
  runAudit,
  writeLegacySafeRepairPlan,
};
