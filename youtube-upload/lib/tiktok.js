/**
 * TikTok upload via Content Posting API v2 (Direct Post).
 *
 * Uses chunked file upload — no external hosting or browser automation required.
 * Works in GitHub Actions (Ubuntu) and any Node.js environment.
 *
 * Required env vars (GitHub Secrets):
 *   TIKTOK_ACCESS_TOKEN  — OAuth 2.0 access token with scope:
 *                          video.upload, video.publish
 *   TIKTOK_OPEN_ID       — TikTok user open_id (returned with the access token)
 *
 * Optional:
 *   TIKTOK_SKIP          — "true" to skip TikTok upload entirely
 *   TIKTOK_PRIVACY       — privacy level: PUBLIC_TO_EVERYONE (default),
 *                          MUTUAL_FOLLOW_FRIENDS, SELF_ONLY
 *
 * Token setup (one-time):
 *   1. Create a TikTok developer app at developers.tiktok.com
 *   2. Add scopes: video.upload, video.publish
 *   3. Complete OAuth flow to get access_token + open_id
 *   4. Add both as GitHub Secrets: TIKTOK_ACCESS_TOKEN, TIKTOK_OPEN_ID
 */

import { readFileSync, statSync } from "fs";

const API_BASE = "https://open.tiktokapis.com/v2";
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB per chunk

// ---------------------------------------------------------------------------
// Caption builder
// ---------------------------------------------------------------------------

function buildCaption(post, youtubeId) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const tag = shortTitle.replace(/[^a-zA-Z0-9]/g, "");
  return [
    post.title,
    "",
    post.description ? `${post.description.slice(0, 200)}…` : "",
    "",
    `▶️ https://www.youtube.com/shorts/${youtubeId}`,
    "",
    `#OnThisDay #History #${tag} #HistoryShorts #LearnHistory #TodayInHistory`,
  ]
    .filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
    .join("\n")
    .trim()
    .slice(0, 2_200);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function uploadToTikTok(videoPath, post, youtubeId) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const privacyLevel = process.env.TIKTOK_PRIVACY || "PUBLIC_TO_EVERYONE";

  const fileSize = statSync(videoPath).size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  // 1. Initialize upload
  console.log("  [TT] Initializing upload...");
  const initRes = await fetch(`${API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: buildCaption(post, youtubeId),
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: fileSize,
        chunk_size: Math.min(CHUNK_SIZE, fileSize),
        total_chunk_count: totalChunks,
      },
    }),
  });

  const initData = await initRes.json();
  if (initData.error?.code && initData.error.code !== "ok") {
    throw new Error(`[TT] Init failed: ${JSON.stringify(initData.error)}`);
  }

  const { upload_url, publish_id } = initData.data;
  if (!upload_url || !publish_id) {
    throw new Error(`[TT] Missing upload_url/publish_id: ${JSON.stringify(initData)}`);
  }

  // 2. Upload chunks
  const videoBuffer = readFileSync(videoPath);
  console.log(
    `  [TT] Uploading ${(fileSize / 1024 / 1024).toFixed(1)} MB in ${totalChunks} chunk(s)...`,
  );

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunk = videoBuffer.subarray(start, end);

    const chunkRes = await fetch(upload_url, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${start}-${end - 1}/${fileSize}`,
        "Content-Length": chunk.length.toString(),
        "Content-Type": "video/mp4",
      },
      body: chunk,
    });

    if (!chunkRes.ok && chunkRes.status !== 206) {
      const body = await chunkRes.text();
      throw new Error(`[TT] Chunk ${i + 1} upload failed (${chunkRes.status}): ${body.slice(0, 300)}`);
    }
    console.log(`  [TT] Chunk ${i + 1}/${totalChunks} uploaded`);
  }

  // 3. Poll publish status
  console.log("  [TT] Waiting for publish to complete...");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const statusRes = await fetch(`${API_BASE}/post/publish/status/fetch/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id }),
    });
    const statusData = await statusRes.json();
    const status = statusData.data?.status;
    if (status === "PUBLISH_COMPLETE") {
      console.log("  [TT] ✓ Published to TikTok");
      return;
    }
    if (status === "FAILED") {
      throw new Error(`[TT] Publish failed: ${JSON.stringify(statusData)}`);
    }
    // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD — keep polling
  }

  throw new Error("[TT] Timed out waiting for TikTok publish confirmation");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Posts the video to TikTok via Content Posting API v2.
 * Skips silently when TIKTOK_SKIP=true or required env vars are missing.
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

  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const openId = process.env.TIKTOK_OPEN_ID;
  if (!token || !openId) {
    console.warn("  TikTok: TIKTOK_ACCESS_TOKEN / TIKTOK_OPEN_ID not set — skipping");
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
