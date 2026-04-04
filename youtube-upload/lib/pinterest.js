/**
 * Pinterest API v5 — auto-pin after YouTube upload.
 *
 * Uses Pinterest's REST API (no browser automation needed).
 * Each pin links back to the blog article with the Wikipedia image
 * resized via image-proxy to Pinterest's optimal width (1000px).
 *
 * Setup (one-time):
 *   1. Create a Pinterest app at https://developers.pinterest.com/apps/
 *   2. Generate an access token with scope: pins:write, boards:read
 *   3. Add PINTEREST_ACCESS_TOKEN and PINTEREST_BOARD_ID to .env
 *
 * Optional env vars:
 *   PINTEREST_SKIP        — set to "true" to skip Pinterest posting
 *   PINTEREST_ACCESS_TOKEN — OAuth2 access token (long-lived user token)
 *   PINTEREST_BOARD_ID    — target board ID (from board URL or boards API)
 */

const PINTEREST_API = "https://api.pinterest.com/v5";

/**
 * Builds the pin description — title, teaser, hashtags.
 * Max 500 chars for Pinterest.
 *
 * @param {object} post
 * @returns {string}
 */
function buildDescription(post) {
  const shortTitle = post.title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const tag = shortTitle.replace(/[^a-zA-Z0-9]/g, "");
  const teaser = post.description
    ? post.description.slice(0, 200).trimEnd()
    : "";
  const lines = [
    `📅 On This Day in History`,
    post.title,
    teaser ? teaser + "…" : "",
    `#OnThisDay #History #${tag} #HistoryFacts #TodayInHistory #LearnHistory`,
  ].filter(Boolean).join("\n\n");
  return lines.slice(0, 500);
}

/**
 * Builds the proxied image URL at Pinterest-optimal width (1000px).
 * Falls back to the raw imageUrl if BLOG_WORKER_URL is not set.
 *
 * @param {string} imageUrl  Raw Wikipedia image URL
 * @returns {string}
 */
function buildImageUrl(imageUrl) {
  const base = (process.env.BLOG_WORKER_URL || "https://thisday.info").replace(/\/$/, "");
  return `${base}/image-proxy?src=${encodeURIComponent(imageUrl)}&w=1000&q=85`;
}

/**
 * Posts a pin to Pinterest.
 * Returns true on success, false on any failure.
 *
 * @param {object} post         Post entry from KV index { slug, title, description, imageUrl }
 * @param {string} youtubeId    YouTube video ID (used in pin link)
 * @returns {Promise<boolean>}
 */
export async function postToPinterest(post, youtubeId) {
  if (process.env.PINTEREST_SKIP === "true") {
    console.log("  Pinterest: PINTEREST_SKIP=true — skipping");
    return false;
  }

  const token = process.env.PINTEREST_ACCESS_TOKEN;
  const boardId = process.env.PINTEREST_BOARD_ID;

  if (!token || !boardId) {
    console.log("  Pinterest: PINTEREST_ACCESS_TOKEN or PINTEREST_BOARD_ID not set — skipping");
    return false;
  }

  if (!post.imageUrl) {
    console.warn("  Pinterest: no imageUrl on post — skipping");
    return false;
  }

  const articleUrl = `https://thisday.info/blog/${post.slug}/`;
  const imageUrl = buildImageUrl(post.imageUrl);
  const description = buildDescription(post);
  const title = post.title.slice(0, 100);

  try {
    console.log("  [Pinterest] Creating pin...");
    const res = await fetch(`${PINTEREST_API}/pins`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        board_id: boardId,
        title,
        description,
        link: articleUrl,
        media_source: {
          source_type: "image_url",
          url: imageUrl,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`  [Pinterest] ✗ HTTP ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }

    const data = await res.json();
    console.log(`  [Pinterest] ✓ Pin created: https://pinterest.com/pin/${data.id}/`);
    return true;
  } catch (err) {
    console.warn(`  [Pinterest] ✗ ${err.message}`);
    return false;
  }
}
