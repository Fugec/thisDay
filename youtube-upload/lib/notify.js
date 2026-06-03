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
 *
 * Video delivery chain (all full-resolution, link only — no file attachment):
 *   1. catbox.moe  — permanent, 200 MB cap; 403s from CI IPs intermittently
 *   2. 0x0.st      — permanent (~1 yr for ~15 MB), works from CI IPs
 *   3. transfer.sh — auto-deletes after 24 h (Max-Days: 1), designed for CI
 */

// catbox/litterbox sit behind Cloudflare and 403 requests that don't look like a
// browser. These headers are REQUIRED — without them the upload is blocked.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CATBOX_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://catbox.moe",
  Referer: "https://catbox.moe/",
};

async function uploadToCatbox(videoPath, post) {
  const { size } = statSync(videoPath);
  if (size > 200 * 1024 * 1024) {
    console.warn(`  ⚠ catbox: file too large (${(size / 1048576).toFixed(1)} MB > 200 MB)`);
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
  if (!r.ok) { console.warn(`  ⚠ catbox failed: HTTP ${r.status}`); return null; }
  const url = (await r.text()).trim();
  if (!/^https?:\/\/\S+$/.test(url)) { console.warn(`  ⚠ catbox bad response: ${url.slice(0, 80)}`); return null; }
  console.log(`  ✓ catbox: ${url}`);
  return url;
}

/**
 * Fallback host: uguu.se — anonymous upload, no auth, direct MP4 link (no
 * login page), works from CI IPs. Files auto-delete after 24 hours.
 */
async function uploadToUguu(videoPath, post) {
  const form = new FormData();
  form.append(
    "files[]",
    new Blob([readFileSync(videoPath)], { type: "video/mp4" }),
    `${post.slug}.mp4`,
  );
  const r = await fetch("https://uguu.se/upload", {
    method: "POST",
    headers: { "User-Agent": BROWSER_UA },
    body: form,
  });
  if (!r.ok) { console.warn(`  ⚠ uguu.se upload failed: HTTP ${r.status}`); return null; }
  const result = await r.json();
  const url = result?.files?.[0]?.url;
  if (!url) { console.warn("  ⚠ uguu.se: no url in response"); return null; }
  console.log(`  ✓ uguu.se (24 h): ${url}`);
  return url;
}

async function getDownloadUrl(videoPath, post) {
  return (
    (await uploadToCatbox(videoPath, post).catch((e) => { console.warn(`  ⚠ catbox error: ${e.message}`); return null; })) ??
    (await uploadToUguu(videoPath, post).catch((e) => { console.warn(`  ⚠ uguu.se error: ${e.message}`); return null; }))
  );
}

/**
 * Sends an upload notification to Discord and/or Slack.
 *
 * @param {{ slug: string, title: string }} post
 * @param {string} youtubeId
 * @param {string|null} [videoPath]  Path to the generated MP4 (optional)
 */
export async function notifyUpload(post, youtubeId, videoPath = null) {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (!discord && !slack) return;

  let downloadUrl = null;
  if (videoPath) {
    downloadUrl = await getDownloadUrl(videoPath, post);
    if (!downloadUrl) {
      console.warn("  ⚠ All upload hosts failed — Discord notification will have no video link");
    }
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
          else console.log(`  ✓ Discord notified${downloadUrl ? " (with MP4 link)" : " (text-only)"}`);
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

  const streakLine = issue.streak ? `\n📈 Consecutive days: ${issue.streak}` : "";
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
