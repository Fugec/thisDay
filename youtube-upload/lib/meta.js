/**
 * Meta Graph API — Facebook Page Reels + Instagram Reels upload.
 *
 * Both platforms use a single long-lived Page Access Token.
 * No public video URL required — files are uploaded directly via
 * Meta's resumable upload protocol.
 *
 * Required env vars:
 *   META_ACCESS_TOKEN   — long-lived Page access token (never expires if refreshed)
 *   META_PAGE_ID        — Facebook Page numeric ID
 *   META_IG_USER_ID     — Instagram Business/Creator account numeric ID
 *                         (linked to the Facebook Page)
 *
 * Optional:
 *   META_SKIP_FACEBOOK  — set to "true" to skip Facebook upload
 *   META_SKIP_INSTAGRAM — set to "true" to skip Instagram upload
 *
 * How to get credentials — see .env.example for step-by-step guide.
 */

import { readFileSync, statSync } from "fs";

const GRAPH  = "https://graph.facebook.com/v21.0";
const UPLOAD = "https://graph-video.facebook.com/v21.0";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function token() {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN not set");
  return t;
}

/**
 * Builds a short caption for both platforms.
 * Instagram: caption is the only description field.
 * Facebook:  used as both title and description.
 */
function buildCaption(post, youtubeId) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const lines = [
    `📅 On This Day in History`,
    ``,
    `${post.title}`,
    ``,
    post.description ? `${post.description.slice(0, 180)}…` : "",
    ``,
    `▶️ Watch the full Short: https://youtube.com/shorts/${youtubeId}`,
    `🌐 Read more: https://thisday.info/blog/${post.slug}/`,
    ``,
    `#OnThisDay #History #${shortTitle.replace(/[^a-zA-Z0-9]/g, "")} #HistoryShorts #LearnHistory`,
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Facebook Page Reels
// ---------------------------------------------------------------------------

/**
 * Uploads an MP4 as a Facebook Page Reel using the 3-phase resumable protocol:
 *   1. start  → get video_id + upload_url
 *   2. transfer → POST file bytes to upload_url
 *   3. finish → set title/description and publish
 *
 * @param {string} videoPath
 * @param {object} post
 * @param {string} youtubeId
 * @returns {Promise<string>} Facebook video ID
 */
async function uploadToFacebook(videoPath, post, youtubeId) {
  const pageId = process.env.META_PAGE_ID;
  if (!pageId) throw new Error("META_PAGE_ID not set");

  const fileBytes = readFileSync(videoPath);
  const fileSize  = statSync(videoPath).size;
  const caption   = buildCaption(post, youtubeId);

  // Phase 1 — start
  console.log("  [FB] Starting resumable upload...");
  const startRes = await fetch(
    `${UPLOAD}/${pageId}/video_reels?upload_phase=start&access_token=${token()}`,
    { method: "POST", signal: AbortSignal.timeout(30_000) },
  );
  if (!startRes.ok) {
    const b = await startRes.text();
    throw new Error(`FB start failed ${startRes.status}: ${b.slice(0, 200)}`);
  }
  const { video_id, upload_url } = await startRes.json();
  console.log(`  [FB] video_id=${video_id}`);

  // Phase 2 — transfer
  console.log(`  [FB] Uploading ${(fileSize / 1024 / 1024).toFixed(1)} MB...`);
  const transferRes = await fetch(upload_url, {
    method: "POST",
    headers: {
      Authorization:    `OAuth ${token()}`,
      offset:           "0",
      file_size:        String(fileSize),
      "Content-Type":   "application/octet-stream",
    },
    body: fileBytes,
    signal: AbortSignal.timeout(300_000),
  });
  if (!transferRes.ok) {
    const b = await transferRes.text();
    throw new Error(`FB transfer failed ${transferRes.status}: ${b.slice(0, 200)}`);
  }

  // Phase 3 — finish + publish
  console.log("  [FB] Publishing reel...");
  const params = new URLSearchParams({
    upload_phase: "finish",
    video_id,
    title:        post.title.slice(0, 255),
    description:  caption,
    published:    "true",
    access_token: token(),
  });
  const finishRes = await fetch(
    `${UPLOAD}/${pageId}/video_reels?${params}`,
    { method: "POST", signal: AbortSignal.timeout(60_000) },
  );
  if (!finishRes.ok) {
    const b = await finishRes.text();
    throw new Error(`FB finish failed ${finishRes.status}: ${b.slice(0, 200)}`);
  }
  const finishData = await finishRes.json();
  if (!finishData.success) {
    throw new Error(`FB publish not confirmed: ${JSON.stringify(finishData)}`);
  }

  console.log(`  [FB] ✓ Published — https://www.facebook.com/${pageId}/videos/${video_id}`);
  return video_id;
}

// ---------------------------------------------------------------------------
// Instagram Reels
// ---------------------------------------------------------------------------

/**
 * Polls an Instagram media container until it's ready to publish (max 5 min).
 */
async function waitForInstagramContainer(containerId) {
  const INTERVAL_MS = 8_000;
  const MAX_ATTEMPTS = 37; // ~5 minutes
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const res = await fetch(
      `${GRAPH}/${containerId}?fields=status_code,status&access_token=${token()}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const data = await res.json();
    const code = data.status_code;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Instagram container ${code}: ${data.status ?? ""}`);
    }
    if (i % 3 === 0) console.log(`  [IG] Processing... status=${code} (${i * INTERVAL_MS / 1000}s)`);
  }
  throw new Error("Instagram container timed out after 5 minutes");
}

/**
 * Uploads an MP4 as an Instagram Reel using the resumable container protocol:
 *   1. Create media container (upload_type=resumable) → get container ID + upload URI
 *   2. POST file bytes to the upload URI
 *   3. Poll container status until FINISHED
 *   4. Publish via media_publish
 *
 * @param {string} videoPath
 * @param {object} post
 * @param {string} youtubeId
 * @returns {Promise<string>} Instagram media ID
 */
async function uploadToInstagram(videoPath, post, youtubeId) {
  const igUserId = process.env.META_IG_USER_ID;
  if (!igUserId) throw new Error("META_IG_USER_ID not set");

  const fileBytes = readFileSync(videoPath);
  const fileSize  = statSync(videoPath).size;
  const caption   = buildCaption(post, youtubeId);

  // Step 1 — create resumable container
  console.log("  [IG] Creating media container...");
  const containerParams = new URLSearchParams({
    media_type:    "REELS",
    upload_type:   "resumable",
    caption,
    share_to_feed: "true",
    access_token:  token(),
  });
  const containerRes = await fetch(
    `${GRAPH}/${igUserId}/media?${containerParams}`,
    { method: "POST", signal: AbortSignal.timeout(30_000) },
  );
  if (!containerRes.ok) {
    const b = await containerRes.text();
    throw new Error(`IG container failed ${containerRes.status}: ${b.slice(0, 200)}`);
  }
  const { id: containerId, uri: uploadUri } = await containerRes.json();
  if (!containerId) throw new Error("IG container response missing id");
  console.log(`  [IG] container_id=${containerId}`);

  // Step 2 — upload file bytes
  console.log(`  [IG] Uploading ${(fileSize / 1024 / 1024).toFixed(1)} MB...`);
  const uploadRes = await fetch(uploadUri, {
    method: "POST",
    headers: {
      Authorization:  `OAuth ${token()}`,
      offset:         "0",
      file_size:      String(fileSize),
      "Content-Type": "application/octet-stream",
    },
    body: fileBytes,
    signal: AbortSignal.timeout(300_000),
  });
  if (!uploadRes.ok) {
    const b = await uploadRes.text();
    throw new Error(`IG upload failed ${uploadRes.status}: ${b.slice(0, 200)}`);
  }

  // Step 3 — wait for processing
  console.log("  [IG] Waiting for video processing...");
  await waitForInstagramContainer(containerId);

  // Step 4 — publish
  console.log("  [IG] Publishing reel...");
  const publishRes = await fetch(
    `${GRAPH}/${igUserId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId, access_token: token() }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!publishRes.ok) {
    const b = await publishRes.text();
    throw new Error(`IG publish failed ${publishRes.status}: ${b.slice(0, 200)}`);
  }
  const { id: mediaId } = await publishRes.json();
  console.log(`  [IG] ✓ Published — https://www.instagram.com/p/${mediaId}/`);
  return mediaId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Posts the video to Facebook Page and/or Instagram as Reels.
 * Skips silently when the required env vars are absent.
 * Each platform is attempted independently — one failure doesn't block the other.
 *
 * @param {string} videoPath   Path to the MP4 file
 * @param {object} post        Post metadata ({ slug, title, description, ... })
 * @param {string} youtubeId   YouTube video ID (included in captions)
 * @returns {Promise<{ facebookId: string|null, instagramId: string|null }>}
 */
export async function postToMeta(videoPath, post, youtubeId) {
  const result = { facebookId: null, instagramId: null };

  if (!process.env.META_ACCESS_TOKEN) {
    console.log("  Meta: META_ACCESS_TOKEN not set — skipping Facebook + Instagram");
    return result;
  }

  // Facebook
  if (process.env.META_SKIP_FACEBOOK !== "true" && process.env.META_PAGE_ID) {
    try {
      result.facebookId = await uploadToFacebook(videoPath, post, youtubeId);
    } catch (err) {
      console.warn(`  [FB] ✗ Upload failed: ${err.message}`);
    }
  } else if (!process.env.META_PAGE_ID) {
    console.log("  [FB] META_PAGE_ID not set — skipping");
  }

  // Instagram
  if (process.env.META_SKIP_INSTAGRAM !== "true" && process.env.META_IG_USER_ID) {
    try {
      result.instagramId = await uploadToInstagram(videoPath, post, youtubeId);
    } catch (err) {
      console.warn(`  [IG] ✗ Upload failed: ${err.message}`);
    }
  } else if (!process.env.META_IG_USER_ID) {
    console.log("  [IG] META_IG_USER_ID not set — skipping");
  }

  return result;
}
