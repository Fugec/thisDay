/**
 * Two-pass bulk SEO patch for all existing posts.
 *
 * Pass 1 (Tier 1 — deterministic, free):
 *   Fetches post:{slug} HTML via CF KV REST API, strips " | thisDay." from
 *   the <title> element, writes back. No AI, no cost.
 *
 * Pass 2 (Tier 2 — AI meta rewrite):
 *   Calls POST /blog/regen-seo?slug=X on the live worker per-slug (sequential,
 *   one slug per request to stay under the 30s worker timeout).
 *   The worker runs patchSEOMeta → reviewSEOMetaOnly: rewrites description,
 *   ogDescription, twitterDescription, keywords, imageAlt with the new
 *   hook-led, clean-truncation prompts, then syncs the KV index entry.
 *
 * Usage:
 *   node scripts/patch-seo-all-posts.mjs
 *   node scripts/patch-seo-all-posts.mjs --dry-run   # tier 1 only, no writes
 *   node scripts/patch-seo-all-posts.mjs --tier1-only
 *   node scripts/patch-seo-all-posts.mjs --slug 2-june-2026  # single post
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../youtube-upload/.env");

// --- Config from .env ---
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const eq = l.indexOf("=");
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim()];
    })
);

const CF_API_TOKEN = env.CF_API_TOKEN;
const CF_ACCOUNT_ID = env.CF_ACCOUNT_ID || "b1b63aec792a52fb199b8ebfb8eed4b1";
const KV_NS_ID = "5173c34a7bd04cde9988c0e89d77bb6e"; // BLOG_AI_KV
const PUBLISH_SECRET = env.PUBLISH_SECRET;
const WORKER_BASE = "https://thisday.info";

if (!CF_API_TOKEN) throw new Error("CF_API_TOKEN missing from youtube-upload/.env");
if (!PUBLISH_SECRET) throw new Error("PUBLISH_SECRET missing from youtube-upload/.env");

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const TIER1_ONLY = args.includes("--tier1-only");
const slugIdx = args.indexOf("--slug");
const SINGLE_SLUG = slugIdx !== -1 ? args[slugIdx + 1] || null : null;
const DELAY_MS = 1200; // between AI calls — stay under provider rate limits

// --- KV helpers ---
const kvUrl = (key) =>
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NS_ID}/values/${encodeURIComponent(key)}`;

const kvHeaders = { Authorization: `Bearer ${CF_API_TOKEN}` };

async function kvGet(key) {
  const res = await fetch(kvUrl(key), { headers: kvHeaders });
  if (!res.ok) throw new Error(`KV GET ${key} → ${res.status}`);
  return res.text();
}

async function kvPut(key, value, contentType = "text/html") {
  const res = await fetch(kvUrl(key), {
    method: "PUT",
    headers: { ...kvHeaders, "Content-Type": contentType },
    body: value,
  });
  if (!res.ok) throw new Error(`KV PUT ${key} → ${res.status}: ${await res.text()}`);
}

// --- Tier 1: strip " | thisDay." from <title> ---
const TITLE_SUFFIX_RE = /(<title>[^<]+?) \| thisDay\.<\/title>/;

function stripTitleSuffix(html) {
  if (!TITLE_SUFFIX_RE.test(html)) return { html, changed: false };
  return { html: html.replace(TITLE_SUFFIX_RE, "$1</title>"), changed: true };
}

// --- Tier 2: AI meta rewrite via live worker ---
async function regenSEO(slug) {
  const url = `${WORKER_BASE}/blog/regen-seo?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${PUBLISH_SECRET}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`regen-seo ${slug} → ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---
async function main() {
  // Fetch index
  const indexRaw = await kvGet("index");
  const index = JSON.parse(indexRaw);
  const slugs = SINGLE_SLUG
    ? [SINGLE_SLUG]
    : index.map((e) => e.slug);

  console.log(`\nMode: ${DRY_RUN ? "DRY RUN" : "LIVE"} | Tier1-only: ${TIER1_ONLY} | Posts: ${slugs.length}\n`);

  const t1Results = { changed: 0, unchanged: 0, errors: 0 };
  const t2Results = { ok: 0, skipped: 0, errors: 0 };

  // ── Pass 1: deterministic title-tag patch ─────────────────────────────────
  console.log("── PASS 1: strip | thisDay. from <title> ──────────────────────");
  for (const slug of slugs) {
    try {
      const html = await kvGet(`post:${slug}`);
      const { html: patched, changed } = stripTitleSuffix(html);
      if (!changed) {
        console.log(`  SKIP (already clean) ${slug}`);
        t1Results.unchanged++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`  DRY  ${slug}`);
        t1Results.changed++;
        continue;
      }
      await kvPut(`post:${slug}`, patched);
      console.log(`  DONE ${slug}`);
      t1Results.changed++;
    } catch (err) {
      console.error(`  ERR  ${slug}: ${err.message}`);
      t1Results.errors++;
    }
  }

  console.log(`\nPass 1 done. Changed: ${t1Results.changed} | Unchanged: ${t1Results.unchanged} | Errors: ${t1Results.errors}\n`);

  if (TIER1_ONLY || DRY_RUN) {
    console.log("Stopping after Pass 1 (--tier1-only or --dry-run).");
    return;
  }

  // ── Pass 2: AI meta rewrite per slug ──────────────────────────────────────
  console.log("── PASS 2: AI meta rewrite (regen-seo per slug) ───────────────");
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    try {
      const result = await regenSEO(slug);
      const changed = result?.results?.[0]?.changed ?? result?.changed ?? "?";
      console.log(`  [${i + 1}/${slugs.length}] ${slug} → changed: ${JSON.stringify(changed)}`);
      t2Results.ok++;
    } catch (err) {
      console.error(`  [${i + 1}/${slugs.length}] ERR ${slug}: ${err.message}`);
      t2Results.errors++;
    }
    if (i < slugs.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nPass 2 done. OK: ${t2Results.ok} | Errors: ${t2Results.errors}\n`);
  console.log("All done.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
