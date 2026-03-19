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
 *
 * @param {{ slug: string, title: string }} post
 * @param {string} youtubeId
 */
export async function notifyUpload(post, youtubeId) {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (!discord && !slack) return;

  const message =
    `✅ **New Short uploaded**\n` +
    `📺 ${post.title}\n` +
    `🎬 https://youtube.com/shorts/${youtubeId}\n` +
    `🌐 https://thisday.info/blog/${post.slug}/`;

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
          else console.log("  ✓ Discord notified");
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
