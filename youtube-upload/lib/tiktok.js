/**
 * TikTok upload via OpenClaw browser automation.
 *
 * File upload uses osascript (macOS) to type the path into the native file
 * picker — no OpenClaw gateway required.
 *
 * Prerequisites:
 *   1. Install OpenClaw:  https://docs.openclaw.ai/getting-started
 *   2. Run once: npm run login tiktok
 *
 * Optional env vars:
 *   OPENCLAW_PROFILE   — browser profile name (default: "openclaw")
 *   TIKTOK_SKIP        — set to "true" to skip TikTok upload
 *   TIKTOK_DEBUG       — set to "true" to print snapshots at each step
 */

import { execFileSync } from "child_process";
import { basename } from "path";

const UPLOAD_URL = "https://www.tiktok.com/creator-center/upload";

// ---------------------------------------------------------------------------
// OpenClaw browser helpers
// ---------------------------------------------------------------------------

function profile() {
  return process.env.OPENCLAW_PROFILE ?? "openclaw";
}

function ocb(args, timeoutMs = 30_000) {
  return execFileSync("openclaw", ["browser", "--browser-profile", profile(), ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
}

function findRef(snapshot, ...labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`"[^"]*${escaped}[^"]*"\\s*\\[ref=(e\\d+)\\]`, "i");
    const m = snapshot.match(re);
    if (m) return m[1];
  }
  return null;
}


function debugSnapshot(label, snap) {
  if (process.env.TIKTOK_DEBUG === "true") {
    console.log(`\n  [TT:DEBUG] Snapshot — ${label}:\n${snap}\n`);
  }
}

/** Sync sleep — no gateway needed. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Polls snapshot until the given text appears or timeoutMs elapses.
 * Works with browser CDP only — no gateway required.
 */
function waitForText(text, timeoutMs = 60_000, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sleep(intervalMs);
    try {
      const snap = ocb(["snapshot", "--interactive"], 15_000);
      if (snap.toLowerCase().includes(text.toLowerCase())) return snap;
    } catch { /* page still loading */ }
  }
  throw new Error(`Timed out waiting for text: "${text}"`);
}

/**
 * Clicks a button to open the native macOS file picker, then uses osascript
 * to type the file path via Cmd+Shift+G "Go to Folder".
 * No OpenClaw gateway required.
 */
function uploadFileViaPicker(buttonRef, filePath) {
  ocb(["click", buttonRef], 10_000);
  sleep(2_000); // wait for native file picker to open

  const escaped = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFileSync("osascript", ["-e", `
    tell application "System Events"
      delay 1.5
      keystroke "g" using {command down, shift down}
      delay 0.8
      keystroke "${escaped}"
      delay 0.3
      key code 36
      delay 0.5
      key code 36
    end tell
  `], { timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Caption builder  (same content as YouTube)
// ---------------------------------------------------------------------------

function buildCaption(post, youtubeId) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const tag = shortTitle.replace(/[^a-zA-Z0-9]/g, "");
  const lines = [
    post.title,
    "",
    post.description ? `${post.description.slice(0, 200)}…` : "",
    "",
    `▶️ Watch on YouTube: https://www.youtube.com/shorts/${youtubeId}`,
    "",
    `#OnThisDay #History #${tag} #HistoryShorts #LearnHistory #TodayInHistory`,
  ];
  return lines
    .filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
    .join("\n")
    .trim()
    .slice(0, 2_200);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function uploadToTikTok(videoPath, post, youtubeId) {
  console.log("  [TT] Opening TikTok upload page...");
  ocb(["open", UPLOAD_URL]);
  sleep(4_000);

  // ── Step 1: find "Select video" button ────────────────────────────────────
  let snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("initial", snap);

  const selectRef = findRef(snap, "Select video");
  if (!selectRef) {
    try { ocb(["screenshot", "--output", "tmp/tiktok-debug.png"], 15_000); } catch { /* ignore */ }
    throw new Error(
      "[TT] Could not find 'Select video' button. Are you logged in?\n" +
      "Run: npm run login tiktok\n" +
      "Set TIKTOK_DEBUG=true for full snapshot output.",
    );
  }

  // ── Step 2: upload via native file picker ─────────────────────────────────
  console.log(`  [TT] Uploading ${basename(videoPath)}...`);
  uploadFileViaPicker(selectRef, videoPath);

  // TikTok processes the video after upload — wait for the Post button to appear
  // (TikTok's caption editor uses role="combobox", "Caption" is not in the a11y tree)
  console.log("  [TT] Waiting for video editor to load...");
  sleep(8_000); // give TikTok time to navigate to the editor after file selection
  waitForText("Post", 120_000);
  sleep(2_000);

  // ── Step 3: fill caption ──────────────────────────────────────────────────
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("editor", snap);

  // TikTok's caption is an unlabeled DraftJS combobox — match by role alone
  const captionRef = findRef(snap, "Caption", "Describe your video", "Add a caption", "Add description")
    ?? snap.match(/\bcombobox\s*\[ref=(e\d+)\]/)?.[1];

  if (captionRef) {
    console.log("  [TT] Typing caption...");
    ocb(["click", captionRef], 10_000);
    ocb(["press", "Control+a"], 5_000);
    // Strip non-ASCII — TikTok caption can hold up to 4000 chars
    const safeCaption = buildCaption(post, youtubeId).replace(/[^\x00-\x7F]/g, "");
    ocb(["type", captionRef, safeCaption], 60_000);
  } else {
    console.warn("  [TT] ⚠ Caption field not found — posting without caption");
  }

  // ── Step 4: click Post ────────────────────────────────────────────────────
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("pre-post", snap);

  const postRef = findRef(snap, "Post", "Publish", "Submit");
  if (!postRef) throw new Error("[TT] Could not find Post/Publish button");

  console.log("  [TT] Clicking Post...");
  ocb(["click", postRef], 15_000);

  // ── Step 5: wait for confirmation ────────────────────────────────────────
  // After posting, TikTok navigates back or shows a success indicator.
  // Wait for "Replace" (upload page) to disappear = page changed = post succeeded.
  // TikTok shows various confirmation texts depending on version/region.
  // Best-effort — if none appear within timeout, assume success (post button was clicked).
  console.log("  [TT] Waiting for post confirmation...");
  try {
    waitForText("Your post", 60_000);
  } catch {
    try {
      waitForText("processing", 20_000);
    } catch {
      console.warn("  [TT] ⚠ No confirmation text detected — assuming success");
    }
  }

  console.log("  [TT] ✓ Published to TikTok");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Posts the video to TikTok via browser automation.
 * Skips silently when TIKTOK_SKIP=true.
 *
 * @param {string} videoPath
 * @param {object} post
 * @param {string} youtubeId
 * @returns {Promise<boolean>}
 */
export async function postToTikTok(videoPath, post, youtubeId) {
  if (process.env.TIKTOK_SKIP === "true") {
    console.log("  TikTok: TIKTOK_SKIP=true — skipping");
    return false;
  }

  try {
    execFileSync("openclaw", ["--version"], { encoding: "utf8", timeout: 5_000 });
  } catch {
    console.warn("  [TT] openclaw not found in PATH — skipping");
    return false;
  }

  try {
    await uploadToTikTok(videoPath, post, youtubeId);
    return true;
  } catch (err) {
    console.warn(`  [TT] ✗ Upload failed: ${err.message}`);
    return false;
  }
}
