#!/usr/bin/env node
/**
 * Wikipedia External Links Bot
 * Adds thisday.info to the External links section of Wikipedia date pages.
 *
 * Usage:
 *   node scripts/wikipedia-links.js             # dry run (no edits)
 *   node scripts/wikipedia-links.js --live      # real edits
 *   node scripts/wikipedia-links.js --live --month=3          # only March
 *   node scripts/wikipedia-links.js --live --month=3 --day=10 # single date
 *
 * Credentials from .secrets: WIKIPEDIA_BOT_USERNAME, WIKIPEDIA_BOT_PASSWORD
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const API = "https://en.wikipedia.org/w/api.php";
const SITE_URL = "https://thisday.info";
const LINK_LABEL = "This Day in History";
const EDIT_SUMMARY =
  "Adding thisday.info as historical events reference resource";
const RATE_LIMIT_MS = 5000; // 5 seconds between edits (Wikipedia guideline)
const DRY_RUN = !process.argv.includes("--live");

// Parse --month and --day flags
const monthArg = process.argv.find((a) => a.startsWith("--month="));
const dayArg = process.argv.find((a) => a.startsWith("--day="));
const onlyMonth = monthArg ? parseInt(monthArg.split("=")[1]) : null;
const onlyDay = dayArg ? parseInt(dayArg.split("=")[1]) : null;

// ── Load credentials ──────────────────────────────────────────────────────────

function loadSecrets() {
  const secretsPath = join(__dirname, "../.secrets");
  const lines = readFileSync(secretsPath, "utf8").split("\n");
  const secrets = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    secrets[key.trim()] = rest.join("=").replace(/^["']|["']$/g, "").trim();
  }
  return secrets;
}

const secrets = loadSecrets();
const BOT_USER = secrets.WIKIPEDIA_BOT_USERNAME;
const BOT_PASS = secrets.WIKIPEDIA_BOT_PASSWORD;

if (!BOT_USER || !BOT_PASS) {
  console.error("Missing WIKIPEDIA_BOT_USERNAME or WIKIPEDIA_BOT_PASSWORD in .secrets");
  process.exit(1);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_SLUGS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function buildDates() {
  const dates = [];
  for (let m = 0; m < 12; m++) {
    if (onlyMonth && m + 1 !== onlyMonth) continue;
    for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
      if (onlyDay && d !== onlyDay) continue;
      dates.push({
        title: `${MONTHS[m]} ${d}`,
        month: MONTH_SLUGS[m],
        day: d,
      });
    }
  }
  return dates;
}

// ── MediaWiki API helpers ─────────────────────────────────────────────────────

let cookieJar = "";

async function apiPost(params) {
  const body = new URLSearchParams({ ...params, format: "json" });
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ThisDayBot/1.0 (https://thisday.info; bot account: Fugec@TD)",
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    body,
  });

  // Persist session cookies (getSetCookie returns all Set-Cookie headers as array)
  const setCookies = res.headers.getSetCookie?.() ?? res.headers.get("set-cookie")?.split(/,(?=[^ ])/) ?? [];
  if (setCookies.length) {
    const incoming = Object.fromEntries(
      setCookies.map((c) => {
        const [pair] = c.split(";");
        const [k, ...v] = pair.split("=");
        return [k.trim(), v.join("=").trim()];
      })
    );
    const existing = Object.fromEntries(
      cookieJar ? cookieJar.split("; ").map((c) => { const [k, ...v] = c.split("="); return [k, v.join("=")]; }) : []
    );
    const merged = { ...existing, ...incoming };
    cookieJar = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  return res.json();
}

async function login() {
  // Step 1: get login token
  const tokenRes = await apiPost({ action: "query", meta: "tokens", type: "login" });
  const loginToken = tokenRes.query.tokens.logintoken;

  // Step 2: log in
  const loginRes = await apiPost({
    action: "login",
    lgname: BOT_USER,
    lgpassword: BOT_PASS,
    lgtoken: loginToken,
  });

  if (loginRes.login.result !== "Success") {
    console.error("Login failed:", loginRes.login.result, loginRes.login.reason || "");
    process.exit(1);
  }

  console.log(`Logged in as ${loginRes.login.lgusername}`);
}

async function getEditToken() {
  const res = await apiPost({ action: "query", meta: "tokens" });
  return res.query.tokens.csrftoken;
}

async function getPageContent(title) {
  const res = await apiPost({
    action: "query",
    prop: "revisions",
    titles: title,
    rvprop: "content",
    rvslots: "main",
  });

  const pages = res.query.pages;
  const page = Object.values(pages)[0];

  if (page.missing !== undefined) return null;
  return page.revisions?.[0]?.slots?.main?.["*"] ?? null;
}

async function editPage(title, newContent, editToken) {
  const res = await apiPost({
    action: "edit",
    title,
    text: newContent,
    summary: EDIT_SUMMARY,
    bot: "true",
    token: editToken,
  });

  if (res.edit?.result === "Success") return { ok: true };
  console.error("  API response:", JSON.stringify(res, null, 2));
  return { ok: false, reason: res.error?.code || res.edit?.result || JSON.stringify(res) };
}

// ── Link injection ────────────────────────────────────────────────────────────

function buildLinkLine(url, label) {
  return `* [${url} ${label}]`;
}

function alreadyLinked(content, url) {
  return content.includes("thisday.info");
}

function injectLink(content, linkLine) {
  // Try to insert before {{months}} or [[Category: (common end markers)
  const markers = ["{{months}}", "[[Category:"];

  for (const marker of markers) {
    const idx = content.indexOf(marker);
    if (idx !== -1) {
      // Check if ==External links== section exists before this marker
      const externalLinksIdx = content.lastIndexOf("==External links==", idx);
      if (externalLinksIdx !== -1) {
        // Insert the link right before the marker
        return content.slice(0, idx) + linkLine + "\n" + content.slice(idx);
      }
    }
  }

  // Fallback: append before [[Category: line if no External links section found
  const categoryIdx = content.indexOf("[[Category:");
  if (categoryIdx !== -1) {
    return (
      content.slice(0, categoryIdx) +
      "\n==External links==\n" +
      linkLine +
      "\n\n" +
      content.slice(categoryIdx)
    );
  }

  // Last resort: append at end
  return content + "\n" + linkLine + "\n";
}

// ── Sleep ─────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (pass --live to make real edits)" : "LIVE"}`);
  console.log("─".repeat(60));

  if (!DRY_RUN) await login();

  const editToken = DRY_RUN ? null : await getEditToken();
  const dates = buildDates();

  let edited = 0, skipped = 0, failed = 0;

  for (const { title, month, day } of dates) {
    const url = `${SITE_URL}/generated/${month}/${day}/`;
    const content = await getPageContent(title);

    if (content === null) {
      console.log(`[SKIP]  "${title}" — page not found`);
      skipped++;
      continue;
    }

    if (alreadyLinked(content, url)) {
      console.log(`[SKIP]  "${title}" — already linked`);
      skipped++;
      continue;
    }

    const linkLine = buildLinkLine(url, LINK_LABEL);
    const newContent = injectLink(content, linkLine);

    if (DRY_RUN) {
      console.log(`[DRY]   "${title}" — would add: ${linkLine}`);
      edited++;
    } else {
      const { ok, reason } = await editPage(title, newContent, editToken);
      if (ok) {
        console.log(`[EDIT]  "${title}" — link added`);
        edited++;
      } else {
        console.log(`[FAIL]  "${title}" — ${reason}`);
        failed++;
      }
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log("─".repeat(60));
  console.log(`Done. Edited: ${edited}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
