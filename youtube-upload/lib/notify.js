import { execFileSync } from "child_process";
import {
  mkdtempSync,
  statSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { videoHeadlineTitle } from "./titles.js";

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
 * Discord receives an MP4 attachment directly. Videos above the conservative
 * attachment ceiling are transcoded to a temporary smaller MP4; the original
 * YouTube master is never modified. External download hosts are fallback-only.
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

const DEFAULT_DISCORD_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_ATTACHMENT_AUDIO_KBPS = 96;

export function buildUploadNotificationMessage(
  post,
  youtubeId,
  downloadUrl = null,
) {
  return (
    `✅ **New Short uploaded**\n` +
    `📺 ${videoHeadlineTitle(post)}\n` +
    `🎬 https://www.youtube.com/shorts/${youtubeId}\n` +
    `🌐 https://thisday.info/blog/${post.slug}/` +
    (downloadUrl ? `\n📥 Download MP4: ${downloadUrl}` : ``)
  );
}

function discordAttachmentMaxBytes() {
  const configuredMb = Number.parseFloat(
    process.env.DISCORD_ATTACHMENT_MAX_MB ||
      String(DEFAULT_DISCORD_ATTACHMENT_MAX_BYTES / 1024 / 1024),
  );
  const safeMb = Number.isFinite(configuredMb)
    ? Math.min(25, Math.max(1, configuredMb))
    : 8;
  return Math.floor(safeMb * 1024 * 1024);
}

export function discordAttachmentVideoBitrateKbps(
  durationSeconds,
  targetBytes,
  audioKbps = DISCORD_ATTACHMENT_AUDIO_KBPS,
) {
  const duration = Math.max(1, Number(durationSeconds) || 1);
  const bytes = Math.max(1024 * 1024, Number(targetBytes) || 0);
  const totalKbps = Math.floor((bytes * 8) / duration / 1000);
  return Math.max(320, totalKbps - audioKbps - 32);
}

function videoDurationSeconds(videoPath) {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  const duration = Number.parseFloat(raw);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe did not return a valid video duration");
  }
  return duration;
}

function prepareDiscordAttachment(videoPath, post) {
  const maxBytes = discordAttachmentMaxBytes();
  const originalSize = statSync(videoPath).size;
  if (originalSize <= maxBytes) {
    return {
      path: videoPath,
      filename: `${post.slug}.mp4`,
      cleanup: () => {},
    };
  }

  const workDir = mkdtempSync(join(tmpdir(), "thisday-discord-"));
  const outputPath = join(workDir, `${post.slug}.mp4`);
  try {
    const duration = videoDurationSeconds(videoPath);
    // Leave container/metadata headroom beneath Discord's limit.
    const targetBytes = Math.floor(maxBytes * 0.84);
    const videoKbps = discordAttachmentVideoBitrateKbps(
      duration,
      targetBytes,
    );
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        `${videoKbps}k`,
        "-maxrate",
        `${videoKbps}k`,
        "-bufsize",
        `${videoKbps * 2}k`,
        "-c:a",
        "aac",
        "-b:a",
        `${DISCORD_ATTACHMENT_AUDIO_KBPS}k`,
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { timeout: 180_000 },
    );
    const outputSize = statSync(outputPath).size;
    if (outputSize > maxBytes) {
      throw new Error(
        `compressed attachment is ${(outputSize / 1048576).toFixed(1)} MB`,
      );
    }
    console.log(
      `  ✓ Discord attachment prepared: ${(outputSize / 1048576).toFixed(1)} MB`,
    );
    return {
      path: outputPath,
      filename: `${post.slug}.mp4`,
      cleanup: () => rmSync(workDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function sendDiscordVideoAttachment(
  discord,
  post,
  youtubeId,
  videoPath,
) {
  const attachment = prepareDiscordAttachment(videoPath, post);
  try {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: buildUploadNotificationMessage(post, youtubeId),
      }),
    );
    form.append(
      "files[0]",
      new Blob([readFileSync(attachment.path)], { type: "video/mp4" }),
      attachment.filename,
    );
    const webhook = new URL(discord);
    webhook.searchParams.set("wait", "true");
    const response = await fetch(webhook, { method: "POST", body: form });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 160);
      throw new Error(
        `Discord attachment upload failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`,
      );
    }
    console.log("  ✓ Discord notified (MP4 attachment)");
    return true;
  } finally {
    attachment.cleanup();
  }
}

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

  let discordAttached = false;
  if (discord && videoPath) {
    discordAttached = await sendDiscordVideoAttachment(
      discord,
      post,
      youtubeId,
      videoPath,
    ).catch((error) => {
      console.warn(`  ⚠ Discord attachment error: ${error.message}`);
      return false;
    });
  }

  let downloadUrl = null;
  if (videoPath && ((!discordAttached && discord) || slack)) {
    downloadUrl = await getDownloadUrl(videoPath, post);
    if (!downloadUrl) {
      console.warn("  ⚠ All upload hosts failed — Discord notification will have no video link");
    }
  }

  const message = buildUploadNotificationMessage(
    post,
    youtubeId,
    downloadUrl,
  );

  const sends = [];

  if (discord && !discordAttached) {
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
  return { discordAttached, downloadUrl };
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
