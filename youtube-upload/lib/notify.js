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
export async function notifyUpload(post, youtubeId, videoPath = null) {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (!discord && !slack) return;

  const message =
    `✅ **New Short uploaded**\n` +
    `📺 ${post.title}\n` +
    `🎬 https://www.youtube.com/shorts/${youtubeId}\n` +
    `🌐 https://thisday.info/blog/${post.slug}/`;

  const sends = [];

  if (discord) {
    let discordSent = false;

    if (videoPath) {
      try {
        const { size } = statSync(videoPath);
        const MAX_DISCORD_BYTES = 25 * 1024 * 1024; // 25 MB

        if (size <= MAX_DISCORD_BYTES) {
          const videoBuffer = readFileSync(videoPath);
          const form = new FormData();
          form.append("payload_json", JSON.stringify({ content: message }));
          form.append(
            "files[0]",
            new Blob([videoBuffer], { type: "video/mp4" }),
            `${post.slug}.mp4`,
          );
          const r = await fetch(discord, { method: "POST", body: form });
          if (r.ok) {
            console.log("  ✓ Discord notified (with video attachment)");
            discordSent = true;
          } else {
            console.warn(`  ⚠ Discord attach failed: HTTP ${r.status} — falling back to text`);
          }
        } else {
          console.warn(
            `  ⚠ Video too large for Discord (${(size / 1024 / 1024).toFixed(1)} MB > 25 MB) — text only`,
          );
        }
      } catch (e) {
        console.warn(`  ⚠ Discord attach error: ${e.message} — falling back to text`);
      }
    }

    if (!discordSent) {
      sends.push(
        fetch(discord, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
        })
          .then((r) => {
            if (!r.ok) console.warn(`  ⚠ Discord notify failed: ${r.status}`);
            else console.log("  ✓ Discord notified");
          })
          .catch((e) => console.warn(`  ⚠ Discord notify error: ${e.message}`)),
      );
    }
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
