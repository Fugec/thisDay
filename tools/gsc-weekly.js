#!/usr/bin/env node
/**
 * GSC Weekly Report — read-only detection, human-approved writes.
 *
 * Runs weekly (cron/launchd). It does TWO things and writes NOTHING to prod:
 *
 *   A. Malformed-title scan  — reads the BLOG_AI_KV `index` (CF KV REST, read
 *      token) and flags published titles with objective defects (dangling
 *      function word, trailing punctuation, missing/odd date suffix, generic
 *      "… event" placeholder, truncation marker). This catches the incident
 *      class (e.g. "… assassinated in Belgrade by", "Eastern Mediterranean
 *      event") that has historically been caught by humans.
 *
 *   B. GSC opportunity report — pulls Search Console (query × page, 90-day
 *      window), classifies each query human vs. AI-bot (the quoted
 *      attribute-stack boolean queries that dominate this site's impressions),
 *      and reports: (B1) where the real human head terms rank, and (B2) any
 *      page with enough HUMAN impressions sitting in a winnable position band.
 *
 * Output: documentation/gsc/weekly-report.md  (gitignored). No KV writes.
 * Applying a fix stays MANUAL via the CF KV REST patch path (see report footer
 * and reference_kv_rest_api / CLAUDE.md "May 27 KV Patch Approach").
 *
 * Creds (all gitignored):
 *   .secrets               GSC_OAUTH_CLIENT_ID, GSC_OAUTH_CLIENT_SECRET (for
 *                          unattended refresh), GSC_REFRESH_TOKEN, GSC_ACCESS_TOKEN
 *   youtube-upload/.env    CF_API_TOKEN, CF_ACCOUNT_ID
 *
 * Without GSC_OAUTH_CLIENT_SECRET the script falls back to the static
 * GSC_ACCESS_TOKEN in .secrets (works for a manual run within ~1h of minting).
 *
 * Run:  node tools/gsc-weekly.js
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- config ---------------------------------------------------------------
const PROPERTY = "sc-domain:thisday.info";
const SITE = "https://thisday.info";
const BLOG_KV_NS = "5173c34a7bd04cde9988c0e89d77bb6e"; // BLOG_AI_KV
const WINDOW_DAYS = 90;        // GSC sample window (weekly cadence, longer window for signal)
const MIN_HUMAN_IMPR = 10;     // a page needs at least this many HUMAN impressions to be a candidate
const WINNABLE = [5, 20];      // position band worth a title/snippet push

// Trailing tokens that should never end a headline (CLAUDE.md sourceEventHeadline rule).
const FUNCTION_WORDS = new Set([
  "a","an","the","and","or","but","of","to","in","on","at","by","for","with",
  "from","as","into","that","while","after","before","between","against","over",
  "under","during","per","via","near","than","then","when","which","who","whom",
]);

// --- tiny dotenv-style parser --------------------------------------------
function parseEnvFile(path) {
  const out = {};
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// --- GSC auth -------------------------------------------------------------
async function getAccessToken(secrets) {
  const { GSC_OAUTH_CLIENT_ID, GSC_OAUTH_CLIENT_SECRET, GSC_REFRESH_TOKEN, GSC_ACCESS_TOKEN } = secrets;
  if (GSC_OAUTH_CLIENT_SECRET && GSC_REFRESH_TOKEN && GSC_OAUTH_CLIENT_ID) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: GSC_REFRESH_TOKEN,
        client_id: GSC_OAUTH_CLIENT_ID,
        client_secret: GSC_OAUTH_CLIENT_SECRET,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.access_token) return { token: d.access_token, mode: "refreshed" };
    console.warn(`! token refresh failed (${d.error || r.status}: ${d.error_description || ""}) — falling back to static GSC_ACCESS_TOKEN`);
  }
  if (GSC_ACCESS_TOKEN) return { token: GSC_ACCESS_TOKEN, mode: "static (add GSC_OAUTH_CLIENT_SECRET for unattended refresh)" };
  throw new Error("No usable GSC token. Add GSC_OAUTH_CLIENT_SECRET (+ refresh token) for automation, or a fresh GSC_ACCESS_TOKEN for a manual run.");
}

async function gscQuery(token, body) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(PROPERTY)}/searchAnalytics/query`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GSC ${r.status}: ${d.error?.message || JSON.stringify(d)}`);
  return d.rows || [];
}

// --- KV read (CF REST) ----------------------------------------------------
async function readKvIndex(env) {
  const acct = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!acct || !token) throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${BLOG_KV_NS}/values/index`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`CF KV read failed: ${r.status}`);
  return r.json();
}

// --- A. malformed title detection ----------------------------------------
function classifyTitle(title) {
  const issues = [];
  const t = String(title || "").trim();
  if (!t) return ["empty title"];

  // Date suffix may use an em-dash " — " (current) or a hyphen " - " (legacy
  // posts). Detect a trailing "Month Day, Year" regardless of separator; the
  // headline is everything before it. A title that ends with neither is a real
  // defect (e.g. "The Great Fire of London: A Devastating Conflagration").
  const dateRe = /\s[-—]\s+[A-Z][a-z]+ \d{1,2},\s*\d{3,4}\s*$/;
  const hasDate = dateRe.test(t);
  const headline = hasDate ? t.replace(dateRe, "").trim() : t;

  if (!hasDate) issues.push("no 'Month Day, Year' date in title");

  // NOTE: word-count and a generic-"event" check were removed after a live run
  // false-flagged valid 2-word titles ("Titanic Sinking") and real event names
  // ("Nuremberg Celestial Event"). Wrong-event/semantic errors are NOT
  // regex-detectable — only the objective malformations below are.
  const words = headline.split(/\s+/).filter(Boolean);
  const lastWord = (words[words.length - 1] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (words.length >= 2 && FUNCTION_WORDS.has(lastWord)) {
    issues.push(`dangling function word: "…${words[words.length - 1]}"`);
  }
  if (/[,;:]\s*$/.test(headline)) issues.push("trailing punctuation");
  if (/(…|\.\.\.)/.test(headline)) issues.push("truncation marker (…)");

  return issues;
}

// --- B. bot vs human query classifier ------------------------------------
// The dominant non-human pattern on this site is the quoted attribute-stack
// boolean query an LLM/agent issues for entity resolution, e.g.
//   "greek father" "died 2017" teacher    /   "schoolteacher" "olympic champion" "born 1918"
function isBotQuery(q) {
  const s = String(q || "");
  if (s.includes('"')) return true;                                  // quoted phrase(s) — agent boolean
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 8) return true;                                // long clue-stacks
  if (/\b(?:19|20)\d{2}\b/.test(s) && words.length >= 5) return true; // year + attributes
  return false;
}

function pct(n, d) { return d ? (100 * n / d) : 0; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }

// --- main -----------------------------------------------------------------
async function main() {
  const secrets = parseEnvFile(join(ROOT, ".secrets"));
  const cfEnv = parseEnvFile(join(ROOT, "youtube-upload/.env"));

  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const { token, mode } = await getAccessToken(secrets);
  console.log(`GSC token: ${mode}`);

  // pull query × page
  const rows = await gscQuery(token, {
    startDate: iso(start),
    endDate: iso(end),
    dimensions: ["query", "page"],
    rowLimit: 5000,
  });

  // aggregate
  const perPage = new Map();   // page -> stats
  const perQuery = new Map();  // human query -> {impr,clicks,posSum}
  let totImpr = 0, totClk = 0, humImpr = 0, humClk = 0, botImpr = 0;
  for (const r of rows) {
    const [q, page] = r.keys;
    const bot = isBotQuery(q);
    totImpr += r.impressions; totClk += r.clicks;
    if (bot) { botImpr += r.impressions; }
    else {
      humImpr += r.impressions; humClk += r.clicks;
      const pq = perQuery.get(q) || { impr: 0, clicks: 0, posSum: 0 };
      pq.impr += r.impressions; pq.clicks += r.clicks; pq.posSum += r.impressions * r.position;
      perQuery.set(q, pq);
    }
    const ps = perPage.get(page) || { humImpr: 0, humClk: 0, botImpr: 0, posSum: 0, queries: [] };
    if (bot) ps.botImpr += r.impressions;
    else {
      ps.humImpr += r.impressions; ps.humClk += r.clicks; ps.posSum += r.impressions * r.position;
      ps.queries.push({ q, impr: r.impressions, pos: r.position });
    }
    perPage.set(page, ps);
  }

  // A. malformed titles
  const index = await readKvIndex(cfEnv);
  const flagged = [];
  for (const e of index) {
    const issues = classifyTitle(e.title);
    if (issues.length) flagged.push({ slug: e.slug, title: e.title, issues });
  }

  // B1. top human queries
  const humanQueries = [...perQuery.entries()]
    .map(([q, s]) => ({ q, impr: s.impr, clicks: s.clicks, pos: s.posSum / s.impr }))
    .sort((a, b) => b.impr - a.impr);

  // B2. winnable human pages
  const winnable = [...perPage.entries()]
    .map(([page, s]) => ({ page, ...s, pos: s.humImpr ? s.posSum / s.humImpr : 999 }))
    .filter((p) => p.humImpr >= MIN_HUMAN_IMPR && p.pos >= WINNABLE[0] && p.pos <= WINNABLE[1])
    .sort((a, b) => b.humImpr - a.humImpr);

  // --- build report ---
  const L = [];
  L.push(`# GSC Weekly Report — ${iso(end)}`);
  L.push("");
  L.push(`Window: **${iso(start)} → ${iso(end)}** (${WINDOW_DAYS} days) · property \`${PROPERTY}\` · token: ${mode}`);
  L.push("");
  L.push("## Site summary — human vs. AI-bot traffic");
  L.push("");
  L.push("| Segment | Impressions | Clicks | CTR |");
  L.push("|---|--:|--:|--:|");
  L.push(`| Total | ${totImpr.toFixed(0)} | ${totClk.toFixed(0)} | ${pct(totClk, totImpr).toFixed(3)}% |`);
  L.push(`| **Human** | ${humImpr.toFixed(0)} (${pct(humImpr, totImpr).toFixed(0)}%) | ${humClk.toFixed(0)} | ${pct(humClk, humImpr).toFixed(3)}% |`);
  L.push(`| AI-bot | ${botImpr.toFixed(0)} (${pct(botImpr, totImpr).toFixed(0)}%) | — | — |`);
  L.push("");
  L.push("_Human CTR is the number that matters; bot impressions can't convert. Track the human row week-over-week._");
  L.push("");

  L.push(`## A. Malformed titles — ${flagged.length} flagged`);
  L.push("");
  if (!flagged.length) {
    L.push("None. All published titles pass the objective checks.");
  } else {
    L.push("| Slug | Issue(s) | Title |");
    L.push("|---|---|---|");
    for (const f of flagged) {
      L.push(`| \`${f.slug}\` | ${f.issues.join("; ")} | ${f.title.replace(/\|/g, "\\|")} |`);
    }
    L.push("");
    L.push("_Fix via the manual KV patch path (footer). Regex can't catch wrong-event/semantic errors — only malformations._");
  }
  L.push("");

  L.push("## B1. Human head-term tracking");
  L.push("");
  L.push("Where your real human queries rank (authority gauge — watch these climb over months).");
  L.push("");
  L.push("| Query | Pos | Impr | Clicks |");
  L.push("|---|--:|--:|--:|");
  for (const r of humanQueries.slice(0, 20)) {
    L.push(`| ${r.q.replace(/\|/g, "\\|")} | ${r.pos.toFixed(0)} | ${r.impr.toFixed(0)} | ${r.clicks.toFixed(0)} |`);
  }
  L.push("");

  L.push(`## B2. Winnable human pages — pos ${WINNABLE[0]}–${WINNABLE[1]}, ≥${MIN_HUMAN_IMPR} human impr`);
  L.push("");
  if (!winnable.length) {
    L.push(`**None this window.** No page has ≥${MIN_HUMAN_IMPR} human impressions in the winnable band — your human queries (B1) rank deeper than that. That's an **authority/competition gap, not a title problem**: title edits won't help pages no human sees. Title work only pays off once a page reaches this band.`);
  } else {
    L.push("| Page | Pos | Human impr | Top human queries |");
    L.push("|---|--:|--:|---|");
    for (const p of winnable) {
      const top = p.queries.sort((a, b) => b.impr - a.impr).slice(0, 3).map((x) => x.q).join("; ");
      L.push(`| ${p.page.replace(SITE, "")} | ${p.pos.toFixed(0)} | ${p.humImpr.toFixed(0)} | ${top.replace(/\|/g, "\\|")} |`);
    }
    L.push("");
    L.push("_For each, craft a title that targets the listed queries, then apply via the KV patch path._");
  }
  L.push("");

  L.push("## How to apply a fix (manual, approved)");
  L.push("");
  L.push("Title edits are **not** auto-written. To patch one, replace in BOTH `post:{slug}` and the `index` key (see CLAUDE.md \"May 27 KV Patch Approach\" / reference_kv_rest_api):");
  L.push("");
  L.push("```bash");
  L.push("# CF_API_TOKEN from youtube-upload/.env; NS_ID 5173c34a7bd04cde9988c0e89d77bb6e (BLOG_AI_KV)");
  L.push("# READ:  GET  .../values/post%3A{slug}   then Python str.replace across all occurrences");
  L.push("# WRITE: PUT  .../values/post%3A{slug}   and re-fetch + patch the shared `index` blob");
  L.push("```");
  L.push("");

  // write outputs
  const outDir = join(ROOT, "documentation/gsc");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, "weekly-report.md");
  writeFileSync(reportPath, L.join("\n"));
  // dated copy for history/trend
  writeFileSync(join(outDir, `weekly-${iso(end)}.md`), L.join("\n"));

  // stdout summary
  console.log(`\n=== GSC weekly (${iso(start)} → ${iso(end)}) ===`);
  console.log(`Impressions: total ${totImpr.toFixed(0)} | human ${humImpr.toFixed(0)} (${pct(humImpr, totImpr).toFixed(0)}%) | bot ${botImpr.toFixed(0)} (${pct(botImpr, totImpr).toFixed(0)}%)`);
  console.log(`Human clicks: ${humClk.toFixed(0)} | human CTR: ${pct(humClk, humImpr).toFixed(3)}%`);
  console.log(`Malformed titles flagged: ${flagged.length}`);
  console.log(`Winnable human pages (pos ${WINNABLE[0]}-${WINNABLE[1]}): ${winnable.length}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
