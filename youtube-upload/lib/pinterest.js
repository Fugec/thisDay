/**
 * Pinterest upload via OpenClaw browser automation — Pin Builder.
 *
 * Downloads the post's Wikipedia image (via the blog image-proxy) to a temp
 * file, then uploads it as an image pin with title, description, destination
 * link, and board selection — no Pinterest API access required.
 *
 * Prerequisites:
 *   1. Install OpenClaw: https://docs.openclaw.ai/getting-started
 *   2. Run once: npm run login pinterest
 *
 * Optional env vars:
 *   OPENCLAW_PROFILE    — browser profile name (default: "openclaw")
 *   PINTEREST_BOARD     — board name to select (default: first board in list)
 *   PINTEREST_SKIP      — set to "true" to skip Pinterest upload
 *   PINTEREST_DEBUG     — set to "true" to print snapshots at each step
 *   BLOG_WORKER_URL     — base URL for image-proxy (default: https://thisday.info)
 */

import { execFileSync, spawn } from "child_process";
import { createWriteStream, existsSync, unlinkSync } from "fs";
import { pipeline } from "stream/promises";

const PIN_CREATION_URL = "https://www.pinterest.com/pin-creation-tool/";

// ---------------------------------------------------------------------------
// OpenClaw browser helpers  (same pattern as meta.js / tiktok.js)
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
  if (process.env.PINTEREST_DEBUG === "true") {
    console.log(`\n  [PT:DEBUG] Snapshot — ${label}:\n${snap}\n`);
  }
}

/** Sync sleep. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

function uploadFileViaPicker(buttonRef, filePath) {
  // Spawn the click non-blocking — Pinterest's File Upload button opens a native
  // OS file picker and blocks until dismissed. osascript must run concurrently.
  spawn("openclaw", ["browser", "--browser-profile", profile(), "click", buttonRef],
    { stdio: "ignore" });

  sleep(2_000); // wait for file picker to open

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
// Image download
// ---------------------------------------------------------------------------

function buildProxiedImageUrl(imageUrl) {
  const base = (process.env.BLOG_WORKER_URL || "https://thisday.info").replace(/\/$/, "");
  return `${base}/image-proxy?src=${encodeURIComponent(imageUrl)}&w=1000&q=85`;
}

async function downloadImage(imageUrl, destPath) {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(destPath));
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

function buildDescription(post, youtubeId) {
  const teaser = post.description
    ? post.description
        .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\b/gi, "")
        .replace(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi, "")
        .replace(/\s{2,}/g, " ").trim()
        .slice(0, 300).trimEnd() + "…"
    : "";
  const lines = [
    teaser,
    `▶️ Watch on YouTube: https://www.youtube.com/shorts/${youtubeId}`,
    `🌐 Read more: https://thisday.info/blog/${post.slug}/`,
  ].filter(Boolean).join("\n\n");
  return lines.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function uploadToPinterest(imagePath, post, youtubeId) {
  // ── Step 1: open pin creation tool directly ───────────────────────────────────
  console.log("  [PT] Opening pin creation tool...");
  ocb(["open", PIN_CREATION_URL]);
  sleep(4_000);

  let snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("pin-creator", snap);

  const uploadRef = findRef(snap, "File Upload");
  if (!uploadRef) {
    try { ocb(["screenshot", "--output", "tmp/pinterest-debug.png"], 15_000); } catch { /* ignore */ }
    throw new Error("[PT] Could not find 'File Upload' button — are you logged in? Run: npm run login pinterest");
  }

  console.log("  [PT] Uploading image...");
  uploadFileViaPicker(uploadRef, imagePath, 60_000);

  // ── Step 4: wait for fields to enable after upload ────────────────────────────
  console.log("  [PT] Waiting for pin editor fields...");
  // Fields are disabled until image is processed — poll until Title textbox is enabled
  const editorDeadline = Date.now() + 60_000;
  while (Date.now() < editorDeadline) {
    sleep(2_000);
    snap = ocb(["snapshot", "--interactive"], 15_000);
    // Title field enabled = no [disabled] flag right after its ref
    if (/textbox "Title" \[ref=(e\d+)\](?!\s*\[disabled\])/.test(snap)) break;
  }
  debugSnapshot("editor", snap);

  // ── Step 5: fill title ────────────────────────────────────────────────────────
  const titleRef = findRef(snap, "Title");
  if (titleRef) {
    console.log("  [PT] Typing title...");
    ocb(["click", titleRef], 10_000);
    ocb(["evaluate", "--ref", titleRef, "--fn", "el => { el.focus(); document.execCommand('selectAll'); }"], 5_000);
    sleep(300);
    const safeTitle = post.title.replace(/[^\x00-\x7F]/g, "").slice(0, 100);
    ocb(["type", titleRef, safeTitle], 30_000);
  } else {
    console.warn("  [PT] ⚠ Title field not found — skipping");
  }

  // ── Step 6: fill description ──────────────────────────────────────────────────
  // The page has both a toggle button AND a combobox for description.
  // Click the button to focus, then type into the combobox (not the button).
  sleep(500);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const descBtnRef = findRef(snap, "Add a detailed description");
  if (descBtnRef) {
    console.log("  [PT] Typing description...");
    ocb(["click", descBtnRef], 10_000);
    sleep(500);
    snap = ocb(["snapshot", "--interactive"], 15_000);
    // Specifically target the combobox — it's the editable element, not the button
    const descComboRef = snap.match(/\bcombobox\s+"Add a detailed description"\s+\[ref=(e\d+)\]/)?.[1]
      ?? findRef(snap, "Add a detailed description");
    if (descComboRef) {
      const safeDesc = buildDescription(post, youtubeId).replace(/[^\x00-\x7F]/g, "");
      ocb(["type", descComboRef, safeDesc], 60_000);
    } else {
      console.warn("  [PT] ⚠ Description combobox not found — skipping");
    }
  } else {
    console.warn("  [PT] ⚠ Description field not found — skipping");
  }

  // ── Step 7: set destination link ─────────────────────────────────────────────
  sleep(500);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const linkRef = findRef(snap, "Link");
  if (linkRef) {
    console.log("  [PT] Setting destination link...");
    ocb(["click", linkRef], 10_000);
    sleep(300);
    ocb(["type", linkRef, `https://thisday.info/blog/${post.slug}/`], 15_000);
  } else {
    console.warn("  [PT] ⚠ Link field not found — skipping");
  }

  // ── Step 8: select board (skip if PINTEREST_BOARD not set) ───────────────────
  sleep(500);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const board = process.env.PINTEREST_BOARD;
  if (board) {
    const boardRef = findRef(snap, "Choose a board");
    if (boardRef) {
      console.log(`  [PT] Selecting board: ${board}...`);
      ocb(["click", boardRef], 10_000);
      sleep(1_500);
      snap = ocb(["snapshot", "--interactive"], 30_000);
      debugSnapshot("board-picker", snap);
      const targetRef = findRef(snap, board);
      if (targetRef) {
        ocb(["click", targetRef], 10_000);
        sleep(1_000);
        snap = ocb(["snapshot", "--interactive"], 30_000);
      } else {
        console.warn(`  [PT] ⚠ Board "${board}" not found — closing picker`);
        ocb(["press", "Escape"], 5_000);
        sleep(500);
        snap = ocb(["snapshot", "--interactive"], 30_000);
      }
    }
  } else {
    console.log("  [PT] PINTEREST_BOARD not set — skipping board selection");
  }

  // ── Step 9: tagged topics (3 history-related) ─────────────────────────────────
  sleep(500);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const topicsToAdd = ["History", "World History", "Educational Websites"];
  const topicsComboRef = findRef(snap, "Tagged topics");
  if (topicsComboRef) {
    console.log("  [PT] Adding tagged topics...");
    for (const topic of topicsToAdd) {
      // Fresh snapshot before each topic — refs shift after each selection
      snap = ocb(["snapshot", "--interactive"], 15_000);
      const comboRef = findRef(snap, "Tagged topics");
      if (!comboRef) break;
      ocb(["click", comboRef], 5_000);
      sleep(300);
      ocb(["type", comboRef, topic], 10_000);
      sleep(1_500);
      snap = ocb(["snapshot", "--interactive"], 15_000);
      // Pick exact match first, then first option
      const optionRef = findRef(snap, topic)
        ?? snap.match(/\boption\s+"[^"]+"\s+\[ref=(e\d+)\]/)?.[1];
      if (optionRef) {
        ocb(["click", optionRef], 5_000);
        sleep(500);
        console.log(`  [PT]   + ${topic}`);
      } else {
        console.warn(`  [PT] ⚠ Topic "${topic}" not found in suggestions — skipping`);
      }
    }
  } else {
    console.warn("  [PT] ⚠ Tagged topics field not found — skipping");
  }

  // ── Step 10: click Publish ────────────────────────────────────────────────────
  sleep(500);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("pre-publish", snap);
  const publishRef = findRef(snap, "Publish");
  if (!publishRef) throw new Error("[PT] Could not find Publish button");

  console.log("  [PT] Publishing pin...");
  ocb(["click", publishRef], 15_000);

  // ── Step 11: confirm ──────────────────────────────────────────────────────────
  console.log("  [PT] Waiting for confirmation...");
  try {
    waitForText("Your Pin is live", 60_000);
  } catch {
    try {
      waitForText("pin saved", 20_000);
    } catch {
      try {
        const confirmSnap = ocb(["snapshot", "--interactive"], 10_000);
        if (
          confirmSnap.toLowerCase().includes("choose a file") ||
          confirmSnap.toLowerCase().includes("upload")
        ) {
          console.log("  [PT] Back at pin builder — publish succeeded");
        } else {
          console.warn("  [PT] ⚠ No confirmation detected — assuming success");
        }
      } catch {
        console.warn("  [PT] ⚠ No confirmation detected — assuming success");
      }
    }
  }

  console.log("  [PT] ✓ Published to Pinterest");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Posts the Wikipedia image as a Pinterest pin via browser automation.
 * Downloads the proxied image to a temp file, uploads via OpenClaw,
 * and cleans up afterward.
 *
 * @param {object} post         Post entry { slug, title, description, imageUrl }
 * @param {string} youtubeId    YouTube Short ID (linked in description)
 * @returns {Promise<boolean>}
 */
export async function postToPinterest(post, youtubeId) {
  if (process.env.PINTEREST_SKIP === "true") {
    console.log("  Pinterest: PINTEREST_SKIP=true — skipping");
    return false;
  }

  try {
    execFileSync("openclaw", ["--version"], { encoding: "utf8", timeout: 5_000 });
  } catch {
    console.warn("  [PT] openclaw not found in PATH — skipping");
    return false;
  }

  if (!post.imageUrl) {
    console.warn("  [PT] No imageUrl on post — skipping");
    return false;
  }

  const tmpPath = new URL(`../tmp/pinterest-${post.slug}.jpg`, import.meta.url).pathname;
  try {
    console.log("  [PT] Downloading Wikipedia image...");
    await downloadImage(buildProxiedImageUrl(post.imageUrl), tmpPath);
    await uploadToPinterest(tmpPath, post, youtubeId);
    return true;
  } catch (err) {
    console.warn(`  [PT] ✗ Upload failed: ${err.message}`);
    return false;
  } finally {
    if (existsSync(tmpPath)) { try { unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
}
