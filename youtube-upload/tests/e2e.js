/**
 * End-to-end integration test — full pipeline from KV → YouTube publish.
 *
 * Runs every stage of the production pipeline in sequence, reports PASS/FAIL
 * for each step, and publishes the video to YouTube if all critical steps pass.
 *
 * Usage:
 *   node tests/e2e.js
 *   TEST_SLUG=battle-of-stalingrad-august-23-1942 node tests/e2e.js
 *   USE_AI_IMAGE=true node tests/e2e.js
 *
 * Env vars (from .env):
 *   TEST_SLUG          — specific post slug to test; default: most recent post in KV
 *   USE_AI_IMAGE       — true = AI-generated images (history expert + FLUX); default false
 *   YOUTUBE_PRIVACY    — private | public | unlisted; default: private (safe for testing)
 *   All production vars: CF_*, ELEVENLABS_API_KEY*, YOUTUBE_*, GROQ_API_KEY, HF_TOKEN
 *
 * Exits 0 if all critical steps pass (even if optional steps degrade gracefully).
 * Exits 1 if any critical step fails.
 */

import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });

import { unlinkSync, existsSync } from "fs";
import { getPostIndex, getDidYouKnow, getQuickFacts, getArticleText } from "../lib/kv.js";
import { polishNarrationItems } from "../lib/narration-expert.js";
import {
  generateNarration,
  buildNarrationScript,
  buildNarrationParts,
} from "../lib/elevenlabs.js";
import { generateVideo, resolvePostImage } from "../lib/video.js";
import { uploadToYoutube } from "../lib/youtube.js";
import { getUploaded, markUploaded } from "../lib/tracker.js";
import { getMusicPath } from "../lib/music.js";
import { notifyUpload } from "../lib/notify.js";

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

let criticalFailed = false;
let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * Runs a step and reports PASS / FAIL / SKIP.
 * @param {string}   label     Human-readable step name
 * @param {Function} fn        Async function returning a result value
 * @param {object}   [opts]
 * @param {boolean}  [opts.critical=true]  Abort remaining critical steps on failure
 * @param {*}        [opts.fallback]       Value to return on failure (makes step optional)
 */
async function step(label, fn, { critical = true, fallback = undefined } = {}) {
  const isCritical = critical && fallback === undefined;

  if (criticalFailed && isCritical) {
    console.log(`\n[SKIP] ${label}`);
    skipped++;
    return undefined;
  }

  process.stdout.write(`\n[....] ${label}\n`);
  try {
    const result = await fn();
    console.log(`[PASS] ${label}`);
    passed++;
    return result;
  } catch (err) {
    if (isCritical) {
      console.error(`[FAIL] ${label} — ${err.message}`);
      criticalFailed = true;
    } else {
      console.warn(`[WARN] ${label} — ${err.message} (using fallback)`);
    }
    failed++;
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

const tempFiles = [];
function registerTemp(p) { if (p) tempFiles.push(p); }
function cleanupTemp() {
  for (const p of tempFiles) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("═".repeat(60));
console.log("  thisDay. — Full Pipeline E2E Test");
console.log("═".repeat(60));

// ── Step 1: Environment check ──────────────────────────────────────────────
const env = await step("Environment — required vars present", async () => {
  const required = [
    "CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID",
    "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);

  const optional = {
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY || !!process.env.ELEVENLABS_API_KEY_2,
    GROQ_API_KEY: !!process.env.GROQ_API_KEY,
    HF_TOKEN: !!process.env.HF_TOKEN,
    USE_AI_IMAGE: process.env.USE_AI_IMAGE === "true",
    DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
  };
  console.log("  Optional capabilities:");
  for (const [k, v] of Object.entries(optional)) {
    console.log(`    ${v ? "✓" : "✗"} ${k}`);
  }
  return optional;
});

// ── Step 2: KV connectivity ────────────────────────────────────────────────
const posts = await step("KV — fetch post index", async () => {
  const index = await getPostIndex();
  if (!index.length) throw new Error("Post index is empty");
  console.log(`  ${index.length} posts in KV`);
  return index;
});

// ── Step 3: Select test post ───────────────────────────────────────────────
let post = await step("Post selection", async () => {
  const testSlug = process.env.TEST_SLUG;
  let selected;
  if (testSlug) {
    selected = posts.find((p) => p.slug === testSlug);
    if (!selected) throw new Error(`TEST_SLUG "${testSlug}" not found in KV index`);
    console.log(`  Using TEST_SLUG: ${selected.slug}`);
  } else {
    // Pick most recent post
    selected = [...posts].sort(
      (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
    )[0];
    console.log(`  Auto-selected most recent post`);
  }
  console.log(`  → "${selected.title}"`);
  console.log(`  Slug: ${selected.slug}`);
  console.log(`  Published: ${selected.publishedAt}`);
  return selected;
});

// ── Step 4: Content extraction (DYK / QuickFacts / article text) ───────────
let contentItems = null;
let articleText = null;

await step("Content extraction — DYK / QuickFacts from KV", async () => {
  const dykItems = await getDidYouKnow(post.slug);
  const quickFacts = dykItems ? null : await getQuickFacts(post.slug);
  contentItems = dykItems ?? quickFacts ?? null;

  const source = dykItems ? "Did You Know" : quickFacts ? "Quick Facts" : "description fallback";
  console.log(`  Source: ${source}`);
  if (contentItems) {
    console.log(`  ${contentItems.length} items:`);
    contentItems.forEach((item, i) => console.log(`    [${i + 1}] ${item.slice(0, 90)}${item.length > 90 ? "…" : ""}`));
  } else {
    console.log(`  No DYK/QuickFacts — will use post description`);
  }
}, { critical: false, fallback: null });

await step("Content extraction — full article text from KV", async () => {
  articleText = await getArticleText(post.slug);
  if (articleText) {
    console.log(`  ${articleText.length} chars extracted`);
    console.log(`  Preview: "${articleText.slice(0, 120)}…"`);
  } else {
    console.log(`  No article text available`);
  }
}, { critical: false, fallback: null });

// ── Step 5: Narration expert (Groq) ────────────────────────────────────────
let narrationItems = contentItems;

await step("Narration expert — polish items for engaging TTS", async () => {
  if (!contentItems) { console.log("  Skipping — no content items"); return; }
  if (!process.env.GROQ_API_KEY && !process.env.HF_TOKEN) {
    throw new Error("No GROQ_API_KEY or HF_TOKEN configured");
  }

  narrationItems = await polishNarrationItems(post.title, contentItems, articleText);

  console.log(`  Before / After:`);
  contentItems.forEach((orig, i) => {
    const changed = narrationItems[i] !== orig;
    console.log(`    Item ${i + 1}: ${changed ? "✎ polished" : "· unchanged"}`);
    if (changed) {
      console.log(`      BEFORE: ${orig.slice(0, 80)}${orig.length > 80 ? "…" : ""}`);
      console.log(`      AFTER:  ${narrationItems[i].slice(0, 80)}${narrationItems[i].length > 80 ? "…" : ""}`);
    }
  });
}, { critical: false, fallback: undefined });

// ── Step 6: Narration script ───────────────────────────────────────────────
const narrationScript = await step("Narration script — build TTS text", async () => {
  const script = buildNarrationScript(post, narrationItems);
  console.log(`  ${script.length} chars`);
  console.log(`  "${script.slice(0, 120)}…"`);
  return script;
});

// ── Step 7: ElevenLabs TTS ─────────────────────────────────────────────────
let narrationPath = null;
let narrWords = [];

await step("ElevenLabs TTS — generate narration audio", async () => {
  if (!process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY_2) {
    throw new Error("No ELEVENLABS_API_KEY configured");
  }
  const { path, words } = await generateNarration(post.slug, narrationScript);
  if (!path) throw new Error("ElevenLabs returned no audio");
  narrationPath = path;
  narrWords = words;
  registerTemp(narrationPath);
  console.log(`  Audio: ${narrationPath}`);
  console.log(`  Word timestamps: ${words.length}`);
}, { critical: false, fallback: undefined });

// ── Step 8: Image resolve ──────────────────────────────────────────────────
const useAiImage = process.env.USE_AI_IMAGE === "true";

if (!useAiImage) {
  await step("Image — validate Wikipedia image URL", async () => {
    const { imageUrl: resolved, wasReplaced } = await resolvePostImage(post);
    if (wasReplaced) {
      post = { ...post, imageUrl: resolved };
      console.log(`  ✓ Replaced broken image → ${resolved}`);
    } else {
      console.log(`  ✓ Image OK: ${resolved}`);
    }
  });
} else {
  console.log(`\n[INFO] AI image mode — Wikipedia check skipped, FLUX will generate scenes`);
}

// ── Step 9: Video generation ───────────────────────────────────────────────
// Note: history expert runs inside generateMultiSceneVideo (USE_AI_IMAGE=true)
const bgMusicPath = getMusicPath();
const narrationParts = buildNarrationParts(post, narrationItems);

const videoResult = await step("Video — FFmpeg encode (history expert + FLUX if AI mode)", async () => {
  if (useAiImage) {
    console.log(`  AI image mode: history expert → FLUX scene generation → FFmpeg`);
  } else {
    console.log(`  Wikipedia image mode: static background + captions + audio`);
  }

  const result = await generateVideo(post, {
    narrationPath,
    bgMusicPath,
    words: narrWords,
    useAiImage,
    contentItems,
    narrationParts,
  });

  registerTemp(result.path);
  console.log(`  Video: ${result.path}`);
  console.log(`  Scene cuts: ${result.cuts?.length ?? 0}`);
  return result;
});

// ── Step 10: YouTube upload ────────────────────────────────────────────────
const privacyMode = process.env.YOUTUBE_PRIVACY || "private"; // safe default for tests

const youtubeId = await step(`YouTube — upload as "${privacyMode}"`, async () => {
  if (!videoResult?.path) throw new Error("No video file to upload");

  const videoCuts = videoResult.cuts ?? [];
  const id = await uploadToYoutube(videoResult.path, post, videoCuts);
  console.log(`  ✓ https://youtube.com/shorts/${id}`);
  console.log(`  Privacy: ${privacyMode}`);
  return id;
});

// ── Step 11: KV tracker ────────────────────────────────────────────────────
await step("KV tracker — mark as uploaded", async () => {
  if (!youtubeId) throw new Error("No YouTube ID to record");
  await markUploaded(post.slug, youtubeId, privacyMode);
  console.log(`  Stored: youtube:uploaded[${post.slug}] = ${youtubeId}`);
});

// ── Step 12: Discord notification ─────────────────────────────────────────
await step("Discord — send upload notification", async () => {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL not set");
  }
  await notifyUpload(post, youtubeId);
  console.log(`  Notification sent`);
}, { critical: false, fallback: undefined });

// ── Cleanup ────────────────────────────────────────────────────────────────
cleanupTemp();

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed  ${failed} failed  ${skipped} skipped`);
if (youtubeId) {
  console.log(`\n  Published: https://youtube.com/shorts/${youtubeId}`);
  console.log(`  Privacy:   ${privacyMode}`);
}
if (criticalFailed) {
  console.error("\n  ✗ Pipeline aborted — see FAIL steps above.");
  process.exit(1);
}
console.log("\n  ✓ All critical steps passed.");
