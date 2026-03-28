/**
 * Meta upload via OpenClaw browser automation — Meta Business Suite.
 *
 * Single upload flow covers BOTH Facebook and Instagram simultaneously.
 * The "Post to" selector in Business Suite is set to both platforms and
 * preference is saved, so no re-selection is needed on subsequent runs.
 *
 * File upload uses osascript (macOS) to type the path into the native file
 * picker — no OpenClaw gateway required.
 *
 * Prerequisites:
 *   1. Install OpenClaw:  https://docs.openclaw.ai/getting-started
 *   2. Run once: npm run login facebook
 *
 * Optional env vars:
 *   OPENCLAW_PROFILE    — browser profile name (default: "openclaw")
 *   META_SKIP_FACEBOOK  — set to "true" to skip entire Meta upload
 *   META_SKIP_STORY     — set to "true" to skip Story upload (Reel only)
 *   META_DRAFT          — set to "true" to save as draft instead of publishing
 *   META_DEBUG          — set to "true" to print snapshots at each step
 */

import { execFileSync } from "child_process";
import { basename } from "path";

const CONTENT_URL = "https://business.facebook.com/latest/content_management";
const IG_ACCOUNT  = "thisday.info";

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

/** Returns the LAST matching ref — useful when a label appears multiple times (e.g. "Next"). */
function findLastRef(snapshot, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"[^"]*${escaped}[^"]*"\\s*\\[ref=(e\\d+)\\]`, "gi");
  let last = null, m;
  while ((m = re.exec(snapshot)) !== null) last = m[1];
  return last;
}

function debugSnapshot(label, snap) {
  if (process.env.META_DEBUG === "true") {
    console.log(`\n  [Meta:DEBUG] Snapshot — ${label}:\n${snap}\n`);
  }
}

/** Sync sleep — no gateway needed. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sleep with ±25 % random jitter so timing looks organic.
 * e.g. jitter(2000) sleeps between 1500 ms and 2500 ms.
 */
function jitter(base, spread = 0.25) {
  const delta = Math.floor(base * spread * (Math.random() * 2 - 1));
  sleep(Math.max(200, base + delta));
}

/**
 * Short natural pause before interacting with a UI element —
 * simulates a human scanning the page before clicking.
 * Randomly 400–900 ms.
 */
function humanPause() {
  sleep(400 + Math.floor(Math.random() * 500));
}

/**
 * Polls snapshot until the given text appears or timeoutMs elapses.
 * Uses jittered poll interval to avoid fingerprinting by fixed cadence.
 */
function waitForText(text, timeoutMs = 60_000, intervalMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Poll interval: base ± 30 %
    sleep(Math.max(500, intervalMs + Math.floor(intervalMs * 0.3 * (Math.random() * 2 - 1))));
    try {
      const snap = ocb(["snapshot", "--interactive"], 15_000);
      if (snap.toLowerCase().includes(text.toLowerCase())) return snap;
    } catch { /* page still loading */ }
  }
  throw new Error(`Timed out waiting for text: "${text}"`);
}

/**
 * Clicks a button to open the native macOS file picker, then uses osascript
 * to type the file path into the "Go to Folder" dialog (Cmd+Shift+G).
 * Delays inside AppleScript are slightly randomized to avoid fixed patterns.
 */
function uploadFileViaPicker(buttonRef, filePath) {
  humanPause();
  ocb(["click", buttonRef], 10_000);
  jitter(1_800); // wait for native file picker to open

  const escaped = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Randomize individual AppleScript delays slightly
  const d1 = (0.8 + Math.random() * 0.6).toFixed(2);   // 0.8–1.4 s
  const d2 = (0.5 + Math.random() * 0.5).toFixed(2);   // 0.5–1.0 s
  const d3 = (0.25 + Math.random() * 0.2).toFixed(2);  // 0.25–0.45 s
  const d4 = (0.35 + Math.random() * 0.3).toFixed(2);  // 0.35–0.65 s
  const d5 = (0.35 + Math.random() * 0.3).toFixed(2);  // 0.35–0.65 s
  execFileSync("osascript", ["-e", `
    tell application "System Events"
      delay ${d1}
      keystroke "g" using {command down, shift down}
      delay ${d2}
      keystroke "${escaped}"
      delay ${d3}
      key code 36
      delay ${d4}
      key code 36
      delay ${d5}
    end tell
  `], { timeout: 25_000 });
}

// ---------------------------------------------------------------------------
// Caption builder  (matches YouTube title/description from KV)
// ---------------------------------------------------------------------------

function buildCaption(post, youtubeId) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const tag = shortTitle.replace(/[^a-zA-Z0-9]/g, "");
  const lines = [
    `📅 On This Day in History`,
    ``,
    post.title,
    ``,
    post.description ? `${post.description.slice(0, 180)}…` : "",
    ``,
    `▶️ Watch the full Short: https://www.youtube.com/shorts/${youtubeId}`,
    `🌐 Read more: https://thisday.info/blog/${post.slug}/`,
    ``,
    `#OnThisDay #History #${tag} #HistoryShorts #LearnHistory`,
  ];
  return lines
    .filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Upload — Reel (FB + IG via Business Suite)
// ---------------------------------------------------------------------------

async function uploadReel(videoPath, post, youtubeId) {
  const draft = process.env.META_DRAFT === "true";

  // ── Step 1: Open Business Suite and click Create Reel ─────────────────────
  console.log("  [Meta] Opening Meta Business Suite...");
  ocb(["open", CONTENT_URL]);
  jitter(2_500); // variable page-load wait

  let snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("content-home", snap);

  const createReelRef = findRef(snap, "Create Reel");
  if (!createReelRef) throw new Error("[Meta] Could not find 'Create Reel' button");

  humanPause();
  ocb(["click", createReelRef], 10_000);

  // ── Step 2: Reel composer — wait until it loads, then snapshot ─────────────
  console.log("  [Meta] Waiting for reel composer...");
  waitForText("Reel title", 60_000);
  jitter(800);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("reel-composer", snap);

  // ── Step 3: Fill title + caption while refs are still fresh ────────────────
  // Strip non-ASCII to avoid slow special-char handling in the type command
  const safeTitle   = post.title.replace(/[^\x00-\x7F]/g, "-").slice(0, 255);
  const safeCaption = buildCaption(post, youtubeId).replace(/[^\x00-\x7F]/g, "");

  const titleRef = findRef(snap, "Reel title", "Title");
  const titleDisabled = titleRef && snap.includes(`[ref=${titleRef}] [disabled]`);
  if (titleRef && !titleDisabled) {
    console.log("  [Meta] Typing title...");
    humanPause();
    ocb(["click", titleRef], 10_000);
    jitter(400);
    ocb(["press", "Control+a"], 5_000);
    ocb(["type", titleRef, safeTitle], 60_000);
  } else if (titleDisabled) {
    console.log("  [Meta] Title field disabled (stale reel) — skipping title");
  }

  jitter(700);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const captionRef = findRef(snap, "Write in the dialogue box", "description", "Caption", "What's on your mind");
  if (captionRef) {
    console.log("  [Meta] Typing caption...");
    humanPause();
    ocb(["click", captionRef], 10_000);
    jitter(400);
    ocb(["press", "Control+a"], 5_000);
    ocb(["type", captionRef, safeCaption], 60_000);
  } else {
    console.warn("  [Meta] ⚠ Caption field not found — posting without caption");
  }

  // ── Step 4: Ensure both FB and IG are selected in "Post to" ────────────────
  jitter(800);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const igAlreadySelected = snap.toLowerCase().includes(IG_ACCOUNT.toLowerCase());

  if (!igAlreadySelected) {
    console.log("  [Meta] Selecting Instagram in 'Post to' combobox...");
    try {
      const comboRef = findRef(snap, "Post to");
      if (comboRef) {
        humanPause();
        ocb(["click", comboRef], 10_000);
        jitter(1_500);
        snap = ocb(["snapshot", "--interactive"], 30_000);

        const igRef = findRef(snap, IG_ACCOUNT, "Instagram");
        if (igRef) {
          const igSelected = snap.match(new RegExp(`"[^"]*${IG_ACCOUNT}[^"]*"[^\\n]*\\[selected\\]`));
          if (!igSelected) {
            humanPause();
            ocb(["click", igRef], 5_000);
            jitter(600);
            snap = ocb(["snapshot", "--interactive"], 30_000);
          }
          const saveRef = findRef(snap, "Save preference");
          if (saveRef) {
            humanPause();
            ocb(["click", saveRef], 5_000);
            jitter(600);
          }
        }
        ocb(["press", "Escape"], 5_000);
        jitter(1_200);
        snap = ocb(["snapshot", "--interactive"], 30_000);
        console.log("  [Meta] ✓ Both Facebook + Instagram selected");
      }
    } catch (err) {
      console.warn(`  [Meta] ⚠ Could not select Instagram in 'Post to': ${err.message} — continuing`);
      snap = ocb(["snapshot", "--interactive"], 30_000);
    }
  } else {
    console.log("  [Meta] Both Facebook + Instagram already selected");
  }

  // ── Step 5: Upload video via native file picker ───────────────────────────
  jitter(600);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  const addVideoRef = findRef(snap, "Add video");
  if (!addVideoRef) throw new Error("[Meta] Could not find 'Add video' button");

  console.log(`  [Meta] Uploading ${basename(videoPath)}...`);
  uploadFileViaPicker(addVideoRef, videoPath);

  // Wait for video to process — thumbnails appear once done
  console.log("  [Meta] Waiting for video to process...");
  waitForText("Auto-generated thumbnail", 180_000);
  jitter(1_200);

  // ── Step 6: Click Next ─────────────────────────────────────────────────────
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("after-upload", snap);

  // Use the LAST "Next" ref — the first one belongs to the thumbnail carousel
  const nextRef = findLastRef(snap, "Next");
  if (!nextRef) throw new Error("[Meta] Could not find 'Next' button");
  console.log("  [Meta] Clicking Next...");
  humanPause();
  ocb(["click", nextRef], 15_000);
  jitter(1_800);

  // ── Step 7: Advance through editing steps (Audio/Text/Crop) to Share ────────
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("edit-screen", snap);

  for (let i = 0; i < 5; i++) {
    const hasRealShare = /"(?:Share|Publish|Post reel)"\s*\[ref=(e\d+)\]/i.test(snap);
    const hasDraftBtn  = /button\s+"Save draft"\s*\[ref=(e\d+)\]/i.test(snap);
    if (hasRealShare || hasDraftBtn || draft) break;

    const stepNext = findRef(snap, "Next");
    if (!stepNext) break;
    console.log(`  [Meta] Advancing wizard (step ${i + 1})...`);
    humanPause();
    ocb(["click", stepNext], 10_000);
    jitter(1_200);
    snap = ocb(["snapshot", "--interactive"], 30_000);
    debugSnapshot(`edit-step-${i + 1}`, snap);
  }

  // ── Step 8: Publish or Save draft ─────────────────────────────────────────
  debugSnapshot("publish-screen", snap);

  if (draft) {
    const draftRef = findRef(snap, "Save draft", "Save as draft", "Draft");
    if (!draftRef) throw new Error("[Meta] Could not find 'Save draft' button");
    console.log("  [Meta] Saving as draft...");
    humanPause();
    ocb(["click", draftRef], 15_000);
    waitForText("draft", 60_000);
    console.log("  [Meta] ✓ Saved as draft (FB + IG)");
  } else {
    // Match exactly "Share" or "Publish" — NOT "Share now" (radio) or "Share pending status" (indicator)
    const re = /"(Share|Publish|Post reel)"\s*\[ref=(e\d+)\]/i;
    const m = snap.match(re);
    const publishRef = m?.[2];
    if (!publishRef) throw new Error("[Meta] Could not find 'Share' button on publish screen");
    console.log("  [Meta] Clicking Share...");
    humanPause();
    ocb(["click", publishRef], 15_000);
    const confirmSnap = waitForText("reel", 90_000);
    jitter(700);
    // Click "Done" if it appears after publishing
    const doneRef = findRef(confirmSnap, "Done", "Close", "OK");
    if (doneRef) {
      humanPause();
      ocb(["click", doneRef], 10_000);
    } else {
      // Fallback: take fresh snapshot and try
      jitter(1_500);
      const snap2 = ocb(["snapshot", "--interactive"], 15_000);
      const doneRef2 = findRef(snap2, "Done", "Close", "OK");
      if (doneRef2) { humanPause(); ocb(["click", doneRef2], 10_000); }
    }
    console.log("  [Meta] ✓ Published to Facebook + Instagram");
  }
}

// ---------------------------------------------------------------------------
// Upload — Story (FB + IG)
// ---------------------------------------------------------------------------

async function uploadStory(videoPath) {
  // ── Step 1: Open Business Suite and click Create Story ────────────────────
  console.log("  [Meta:Story] Opening Meta Business Suite...");
  ocb(["open", CONTENT_URL]);
  jitter(2_500);

  let snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("story-home", snap);

  const createStoryRef = findRef(snap, "Create Story");
  if (!createStoryRef) throw new Error("[Meta:Story] Could not find 'Create Story' button");

  humanPause();
  ocb(["click", createStoryRef], 10_000);

  // ── Step 2: Wait for story composer ───────────────────────────────────────
  console.log("  [Meta:Story] Waiting for story composer...");
  waitForText("story", 60_000);
  jitter(800);
  snap = ocb(["snapshot", "--interactive"], 30_000);
  debugSnapshot("story-composer", snap);

  // ── Step 3: Ensure both FB story + IG story are selected ─────────────────
  // Buttons: "Facebook Facebook story" and "Instagram Instagram story"
  // They toggle on/off — click whichever is not [pressed]
  const fbStoryRef = findRef(snap, "Facebook Facebook story", "Facebook story");
  const igStoryRef = findRef(snap, "Instagram Instagram story", "Instagram story");

  if (fbStoryRef && !snap.match(new RegExp(`\\[ref=${fbStoryRef}\\]\\s*\\[pressed\\]`))) {
    humanPause();
    ocb(["click", fbStoryRef], 5_000);
    jitter(500);
  }
  if (igStoryRef && !snap.match(new RegExp(`\\[ref=${igStoryRef}\\]\\s*\\[pressed\\]`))) {
    humanPause();
    ocb(["click", igStoryRef], 5_000);
    jitter(500);
  }

  // ── Step 4: Upload video via native file picker ───────────────────────────
  const uploadRef = findRef(snap, "Add photo/video", "Add video", "Add photo or video", "Select video", "Upload video", "Choose", "Browse", "Upload", "Add media");
  if (!uploadRef) throw new Error("[Meta:Story] Could not find upload button");

  console.log(`  [Meta:Story] Uploading ${basename(videoPath)}...`);
  uploadFileViaPicker(uploadRef, videoPath);

  // ── Step 5: Wait for Share button to become enabled (video processed) ───────
  console.log("  [Meta:Story] Waiting for upload to process...");
  const deadline = Date.now() + 180_000;
  let publishRef = null;
  while (Date.now() < deadline) {
    sleep(Math.max(1_500, 2_000 + Math.floor(1_000 * (Math.random() * 2 - 1))));
    try {
      snap = ocb(["snapshot", "--interactive"], 15_000);
      // Share button enabled = appears without [disabled] immediately after
      const m = snap.match(/"Share"\s*\[ref=(e\d+)\](?!\s*\[disabled\])/i);
      if (m) { publishRef = m[1]; break; }
    } catch { /* still loading */ }
  }
  debugSnapshot("story-share", snap);
  if (!publishRef) throw new Error("[Meta:Story] Timed out waiting for Share button to enable");

  console.log("  [Meta:Story] Publishing story...");
  humanPause();
  ocb(["click", publishRef], 15_000);
  waitForText("story", 90_000);
  jitter(700);

  // Click Done if it appears
  const doneSnap = ocb(["snapshot", "--interactive"], 15_000);
  const doneRef = findRef(doneSnap, "Done", "Close", "OK");
  if (doneRef) { humanPause(); ocb(["click", doneRef], 10_000); }

  console.log("  [Meta:Story] ✓ Story published to Facebook + Instagram");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Uploads a Reel + Story to Facebook + Instagram via Meta Business Suite.
 * Set META_DRAFT=true to save reel as draft instead of publishing.
 * Set META_SKIP_STORY=true to skip the Story upload.
 *
 * @param {string} videoPath
 * @param {object} post
 * @param {string} youtubeId
 * @returns {Promise<boolean>}  true if Reel was published successfully
 */
export async function postToMeta(videoPath, post, youtubeId) {
  if (process.env.META_SKIP_FACEBOOK === "true") {
    console.log("  Meta: META_SKIP_FACEBOOK=true — skipping");
    return false;
  }

  try {
    execFileSync("openclaw", ["--version"], { encoding: "utf8", timeout: 5_000 });
  } catch {
    console.warn("  Meta: openclaw not found in PATH — skipping");
    return false;
  }

  if (process.env.META_DRAFT === "true") console.log("  Meta: META_DRAFT=true — will save as draft");

  let reelOk = false;
  if (process.env.META_STORY_ONLY !== "true") {
    try {
      await uploadReel(videoPath, post, youtubeId);
      reelOk = true;
    } catch (err) {
      console.warn(`  [Meta] ✗ Reel upload failed: ${err.message}`);
    }
  }

  if (process.env.META_SKIP_STORY !== "true") {
    // Brief pause between reel and story — looks more natural
    jitter(3_000);
    try {
      await uploadStory(videoPath);
    } catch (err) {
      console.warn(`  [Meta:Story] ✗ Story upload failed: ${err.message}`);
    }
  }

  return reelOk;
}
