/**
 * Meta upload via Graph API — Facebook Reels + Instagram Reels.
 *
 * Facebook:   Resumable Video Upload API → video_reels publish
 * Instagram:  Resumable Reels container → media_publish
 *
 * Required env vars (GitHub Secrets):
 *   META_PAGE_ID        — Facebook Page numeric ID
 *   META_PAGE_TOKEN     — Long-lived Page Access Token with permissions:
 *                         pages_manage_posts, pages_read_engagement,
 *                         instagram_basic, instagram_content_publish
 *   META_IG_USER_ID     — Instagram Business/Creator account numeric ID
 *
 * Optional:
 *   META_SKIP_FACEBOOK  — "true" to skip entire Meta upload
 *   META_SKIP_IG        — "true" to skip Instagram Reel only
 */

import { readFileSync, statSync } from "fs";

const API_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

// ---------------------------------------------------------------------------
// Caption builders
// ---------------------------------------------------------------------------

function buildFBCaption(post, youtubeId) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const tag = shortTitle.replace(/[^a-zA-Z0-9]/g, "");
  return [
    "📅 On This Day in History",
    "",
    post.title,
    "",
    post.description ? `${post.description.slice(0, 180)}…` : "",
    "",
    `▶️ Watch the Short: https://www.youtube.com/shorts/${youtubeId}`,
    `🌐 Read more: https://thisday.info/blog/${post.slug}/`,
    "",
    `#OnThisDay #History #${tag} #HistoryShorts #LearnHistory`,
  ]
    .filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
    .join("\n")
    .trim();
}

function buildIGCaption(post, youtubeId) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const tag = shortTitle.replace(/[^a-zA-Z0-9]/g, "");
  return [
    post.title,
    "",
    post.description ? `${post.description.slice(0, 200)}…` : "",
    "",
    `▶️ https://www.youtube.com/shorts/${youtubeId}`,
    `🌐 https://thisday.info/blog/${post.slug}/`,
    "",
    `#OnThisDay #History #${tag} #HistoryShorts #LearnHistory #TodayInHistory`,
  ]
    .filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
    .join("\n")
    .trim()
    .slice(0, 2_200);
}

// ---------------------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------------------

async function graphPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Meta Graph API error: ${JSON.stringify(data.error)}`);
  return data;
}

async function graphGet(path) {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json();
  if (data.error) throw new Error(`Meta Graph API error: ${JSON.stringify(data.error)}`);
  return data;
}

// ---------------------------------------------------------------------------
// Facebook Reel
// ---------------------------------------------------------------------------

async function uploadFacebookReel(videoPath, post, youtubeId) {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_TOKEN;
  const videoBuffer = readFileSync(videoPath);
  const fileSize = statSync(videoPath).size;

  // 1. Start upload session
  console.log("  [Meta/FB] Starting resumable upload...");
  const start = await graphPost(`/${pageId}/video_reels`, {
    upload_phase: "start",
    access_token: token,
  });
  const { video_id, upload_url } = start;
  if (!video_id || !upload_url)
    throw new Error(`[Meta/FB] Missing video_id/upload_url: ${JSON.stringify(start)}`);

  // 2. Upload binary
  console.log(`  [Meta/FB] Uploading ${(fileSize / 1024 / 1024).toFixed(1)} MB...`);
  const uploadRes = await fetch(upload_url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: fileSize.toString(),
      "Content-Type": "video/mp4",
    },
    body: videoBuffer,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`[Meta/FB] Upload failed (${uploadRes.status}): ${body.slice(0, 300)}`);
  }

  // 3. Finish + publish
  console.log("  [Meta/FB] Publishing Reel...");
  await graphPost(`/${pageId}/video_reels`, {
    upload_phase: "finish",
    video_id,
    access_token: token,
    video_state: "PUBLISHED",
    description: buildFBCaption(post, youtubeId),
    title: post.title.replace(/[^\x00-\x7F]/g, "").slice(0, 255),
  });

  console.log("  [Meta/FB] ✓ Facebook Reel published");
}

// ---------------------------------------------------------------------------
// Instagram Reel
// ---------------------------------------------------------------------------

async function uploadInstagramReel(videoPath, post, youtubeId) {
  const igUserId = process.env.META_IG_USER_ID;
  const token = process.env.META_PAGE_TOKEN;
  const videoBuffer = readFileSync(videoPath);
  const fileSize = statSync(videoPath).size;

  // 1. Create media container with resumable upload
  console.log("  [Meta/IG] Creating media container...");
  const init = await graphPost(`/${igUserId}/media`, {
    media_type: "REELS",
    upload_type: "resumable",
    caption: buildIGCaption(post, youtubeId),
    access_token: token,
    share_to_feed: true,
  });
  const containerId = init.id;
  const uploadUrl = init.uri;
  if (!containerId || !uploadUrl)
    throw new Error(`[Meta/IG] Missing container id/uri: ${JSON.stringify(init)}`);

  // 2. Upload binary
  console.log(`  [Meta/IG] Uploading ${(fileSize / 1024 / 1024).toFixed(1)} MB...`);
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: fileSize.toString(),
    },
    body: videoBuffer,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`[Meta/IG] Upload failed (${uploadRes.status}): ${body.slice(0, 300)}`);
  }

  // 3. Poll container status until FINISHED
  console.log("  [Meta/IG] Waiting for video to process...");
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const status = await graphGet(
      `/${containerId}?fields=status_code,status&access_token=${token}`,
    );
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR")
      throw new Error(`[Meta/IG] Container processing error: ${JSON.stringify(status)}`);
  }

  // 4. Publish
  console.log("  [Meta/IG] Publishing Reel...");
  await graphPost(`/${igUserId}/media_publish`, {
    creation_id: containerId,
    access_token: token,
  });

  console.log("  [Meta/IG] ✓ Instagram Reel published");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Uploads a Reel to Facebook and Instagram via Meta Graph API.
 * Skips silently when META_SKIP_FACEBOOK=true or required env vars are missing.
 *
 * @param {string} videoPath
 * @param {object} post
 * @param {string} youtubeId
 * @returns {Promise<boolean>}  true if at least FB Reel published successfully
 */
export async function postToMeta(videoPath, post, youtubeId) {
  if (process.env.META_SKIP_FACEBOOK === "true") {
    console.log("  Meta: META_SKIP_FACEBOOK=true — skipping");
    return false;
  }

  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_TOKEN;
  if (!pageId || !token) {
    console.warn("  Meta: META_PAGE_ID / META_PAGE_TOKEN not set — skipping");
    return false;
  }

  let fbOk = false;

  try {
    await uploadFacebookReel(videoPath, post, youtubeId);
    fbOk = true;
  } catch (err) {
    console.warn(`  [Meta/FB] ✗ Facebook Reel failed: ${err.message}`);
  }

  if (process.env.META_SKIP_IG !== "true") {
    const igUserId = process.env.META_IG_USER_ID;
    if (!igUserId) {
      console.warn("  Meta: META_IG_USER_ID not set — skipping Instagram");
    } else {
      try {
        await uploadInstagramReel(videoPath, post, youtubeId);
      } catch (err) {
        console.warn(`  [Meta/IG] ✗ Instagram Reel failed: ${err.message}`);
      }
    }
  }

  return fbOk;
}
