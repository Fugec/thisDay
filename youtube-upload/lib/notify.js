import { statSync, readFileSync } from "fs";

/**
 * Upload notification — posts a Discord (or Slack) webhook message after
 * each successful YouTube upload so you can review videos in real time.
 *
 * Setup (one-time):
 *   Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL
 *   Slack:   https://api.slack.com/messaging/webhooks
 *
 * Env vars (add to .env and GitHub Secrets):
 *   DISCORD_WEBHOOK_URL   e.g. https://discord.com/api/webhooks/{id}/{token}
 *   SLACK_WEBHOOK_URL     e.g. https://hooks.slack.com/services/...
 *
 * If neither is set this function is a silent no-op — safe to call always.
 */

/**
 * Sends an upload notification to Discord and/or Slack.
 * When videoPath is provided and ≤ 25 MB, attaches the MP4 to the Discord message.
 *
 * @param {{ slug: string, title: string }} post
 * @param {string} youtubeId
 * @param {string|null} [videoPath]  Path to the generated MP4 (optional)
 */
// catbox/litterbox sit behind Cloudflare and 403 requests that don't look like a
// browser. These headers are REQUIRED — without them the upload is blocked. (The
// temporary litterbox host stays 403 from CI IPs even with them, so we use the
// permanent catbox.moe endpoint, which works; files can be deleted manually.)
const CATBOX_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://catbox.moe",
  Referer: "https://catbox.moe/",
};

/**
 * Uploads the MP4 to catbox.moe and returns a direct download URL, or null on
 * failure. Discord rejects direct attachments above ~10 MB on non-boosted
 * servers, so we share a link instead. catbox accepts files up to 200 MB.
 *
 * @param {string} videoPath
 * @param {{ slug: string }} post
 * @returns {Promise<string|null>}
 */
async function uploadToCatbox(videoPath, post) {
  const { size } = statSync(videoPath);
  const MAX_BYTES = 200 * 1024 * 1024; // catbox 200 MB cap
  if (size > MAX_BYTES) {
    console.warn(
      `  ⚠ Video too large for catbox (${(size / 1048576).toFixed(1)} MB > 200 MB) — no download link`,
    );
    return null;
  }

  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append(
    "fileToUpload",
    new Blob([readFileSync(videoPath)], { type: "video/mp4" }),
    `${post.slug}.mp4`,
  );

  const r = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    headers: CATBOX_HEADERS,
    body: form,
  });
  if (!r.ok) {
    console.warn(`  ⚠ catbox upload failed: HTTP ${r.status}`);
    return null;
  }
  const url = (await r.text()).trim();
  if (!/^https?:\/\/\S+$/.test(url)) {
    console.warn(`  ⚠ catbox unexpected response: ${url.slice(0, 100)}`);
    return null;
  }
  console.log(`  ✓ MP4 uploaded to catbox: ${url}`);
  return url;
}

export async function notifyUpload(post, youtubeId, videoPath = null) {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (!discord && !slack) return;

  // Upload to litterbox first so the notification can carry a downloadable MP4
  // link (Discord attachments fail for our ~12-18 MB videos on a non-boosted server).
  let downloadUrl = null;
  if (videoPath) {
    downloadUrl = await uploadToCatbox(videoPath, post).catch((e) => {
      console.warn(`  ⚠ catbox upload error: ${e.message}`);
      return null;
    });
  }

  const message =
    `✅ **New Short uploaded**\n` +
    `📺 ${post.title}\n` +
    `🎬 https://www.youtube.com/shorts/${youtubeId}\n` +
    `🌐 https://thisday.info/blog/${post.slug}/` +
    (downloadUrl ? `\n📥 Download MP4: ${downloadUrl}` : ``);

  const sends = [];

  if (discord) {
    sends.push(
      fetch(discord, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      })
        .then((r) => {
          if (!r.ok) console.warn(`  ⚠ Discord notify failed: ${r.status}`);
          else
            console.log(
              `  ✓ Discord notified${downloadUrl ? " (with MP4 link)" : ""}`,
            );
        })
        .catch((e) => console.warn(`  ⚠ Discord notify error: ${e.message}`)),
    );
  }

  if (slack) {
    sends.push(
      fetch(slack, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message.replace(/\*\*/g, "*") }),
      })
        .then((r) => {
          if (!r.ok) console.warn(`  ⚠ Slack notify failed: ${r.status}`);
          else console.log("  ✓ Slack notified");
        })
        .catch((e) => console.warn(`  ⚠ Slack notify error: ${e.message}`)),
    );
  }

  await Promise.all(sends);
}

/**
 * Sends a pipeline issue notification to Discord.
 *
 * @param {{ step: string, slug: string, date: string, message: string, streak?: number }} issue
 */
export async function notifyPipelineIssue(issue) {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (!discord) return;

  const streakLine = issue.streak
    ? `\n📈 Consecutive days: ${issue.streak}`
    : "";
  const message =
    `⚠️ **Pipeline issue detected**\n` +
    `Step: ${issue.step}\n` +
    `Slug: ${issue.slug}\n` +
    `Date: ${issue.date}\n` +
    `Details: ${issue.message}${streakLine}`;

  await fetch(discord, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  }).catch((e) => console.warn(`  ⚠ Discord pipeline alert error: ${e.message}`));
}
