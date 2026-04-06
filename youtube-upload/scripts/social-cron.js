/**
 * social-cron.js — Auto-post to Meta + TikTok after YouTube publishes.
 *
 * Every tick it:
 *   1. Reads the KV tracker for all uploaded YouTube videos
 *   2. Calls YouTube Data API to get each video's real publishedAt timestamp
 *   3. If the video has been public for at least POST_DELAY_MIN minutes → posts to socials
 *   4. Marks metaPostedAt / tiktokPostedAt in KV so it never retries
 *
 * Crontab (Mon/Tue/Thu/Fri at 02:35 + 03:35 UTC):
 *   35 2 * * 1,2,4,5 cd /Users/arminkapetanovic/devilbox/data/www/danas/htdocs/youtube-upload && /opt/homebrew/bin/node scripts/social-cron.js >> /tmp/social-cron.log 2>&1
 *   35 3 * * 1,2,4,5 cd /Users/arminkapetanovic/devilbox/data/www/danas/htdocs/youtube-upload && /opt/homebrew/bin/node scripts/social-cron.js >> /tmp/social-cron.log 2>&1
 *
 * Optional env vars (in .env):
 *   POST_DELAY_MIN   — minutes after YouTube publish to wait (default: 5)
 *   STALE_HOURS      — skip videos older than N hours (default: 48)
 *   META_SKIP_FACEBOOK, META_SKIP_STORY, TIKTOK_SKIP — platform skip flags
 */

import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });

import { google } from "googleapis";
import { spawnSync, execFileSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { getPostIndex } from "../lib/kv.js";
import { getUploaded, markSocialPosted } from "../lib/tracker.js";
import { postToMeta } from "../lib/meta.js";
import { postToTikTok } from "../lib/tiktok.js";
import { postToPinterest } from "../lib/pinterest.js";

const POST_DELAY_MS = (Number(process.env.POST_DELAY_MIN) || 5) * 60_000;
const STALE_MS      = (Number(process.env.STALE_HOURS)    || 48) * 3_600_000;

// ---------------------------------------------------------------------------
// YouTube — get real publishedAt for a list of video IDs
// ---------------------------------------------------------------------------

async function getYouTubePublishTimes(videoIds) {
  const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    "http://localhost:3838",
  );
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

  const yt = google.youtube({ version: "v3", auth });
  const res = await yt.videos.list({
    part: ["snippet", "status"],
    id: videoIds,
    maxResults: 50,
  });

  const map = {};
  for (const item of res.data.items ?? []) {
    map[item.id] = {
      publishedAt: item.snippet?.publishedAt ?? null,
      privacyStatus: item.status?.privacyStatus ?? "unknown",
    };
  }
  return map; // { [videoId]: { publishedAt, privacyStatus } }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const now = Date.now();
  const [posts, uploaded] = await Promise.all([getPostIndex(), getUploaded()]);

  // Candidates: have a YouTube ID, not yet fully posted, not stale
  const candidates = Object.entries(uploaded).filter(([, data]) => {
    if (!data.youtubeId) return false;
    if (data.metaPostedAt && data.tiktokPostedAt && data.pinterestPostedAt) return false;
    const age = now - new Date(data.uploadedAt).getTime();
    return age <= STALE_MS;
  });

  if (!candidates.length) {
    console.log(`[social-cron] ${new Date().toISOString()} — nothing to check`);
    return;
  }

  // Try to fetch real publish times from YouTube — fall back to uploadedAt if API fails
  const videoIds = candidates.map(([, d]) => d.youtubeId);
  let ytInfo = {};
  try {
    ytInfo = await getYouTubePublishTimes(videoIds);
  } catch (err) {
    console.warn(`[social-cron] ⚠ YouTube API unavailable (${err.message}) — using uploadedAt as publish time`);
  }

  // Always post the latest upload only — past the delay window
  candidates.sort((a, b) => new Date(b[1].uploadedAt) - new Date(a[1].uploadedAt));
  const latest = candidates.find(([, data]) => {
    const info = ytInfo[data.youtubeId];
    // If YouTube API worked, use real publish time + privacy check
    if (info?.publishedAt) {
      if (info.privacyStatus !== "public") return false;
      return now - new Date(info.publishedAt).getTime() >= POST_DELAY_MS;
    }
    // Fallback: use uploadedAt — assume public if privacy field says public
    if (data.privacy && data.privacy !== "public") return false;
    return now - new Date(data.uploadedAt).getTime() >= POST_DELAY_MS;
  });
  const pending = latest ? [latest] : [];

  if (!pending.length) {
    console.log(`[social-cron] ${new Date().toISOString()} — ${candidates.length} tracked, none ready yet`);
    return;
  }

  for (const [slug, data] of pending) {
    const post = posts.find((p) => p.slug === slug) ?? { slug, title: slug, description: "" };
    console.log(`\n[social-cron] → ${post.title}`);
    const info = ytInfo[data.youtubeId];
    console.log(`[social-cron]   YouTube published: ${info?.publishedAt ?? data.uploadedAt + " (uploadedAt fallback)"}`);

    const videoPath = new URL(`../tmp/${slug}.mp4`, import.meta.url).pathname;
    try {
      console.log("[social-cron]   Downloading from YouTube...");
      const dl = spawnSync(
        "yt-dlp",
        [
          `https://www.youtube.com/shorts/${data.youtubeId}`,
          "-o", videoPath,
          "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
          "--merge-output-format", "mp4",
          "--no-playlist", "--quiet", "--progress",
        ],
        { stdio: "inherit", timeout: 120_000 },
      );
      if (dl.status !== 0) throw new Error("yt-dlp download failed");
      if (!existsSync(videoPath)) throw new Error(`Downloaded file not found: ${videoPath}`);

      const skipMeta      = !!data.metaPostedAt      || process.env.META_SKIP_FACEBOOK === "true";
      const skipTikTok    = !!data.tiktokPostedAt    || process.env.TIKTOK_SKIP        === "true";
      const skipPinterest = !!data.pinterestPostedAt || process.env.PINTEREST_SKIP     === "true";

      const metaOk      = skipMeta      ? null : await postToMeta(videoPath, post, data.youtubeId);
      const tiktokOk    = skipTikTok    ? null : await postToTikTok(videoPath, post, data.youtubeId);
      const pinterestOk = skipPinterest ? null : await postToPinterest(post, data.youtubeId);

      await markSocialPosted(slug, { meta: metaOk === true, tiktok: tiktokOk === true, pinterest: pinterestOk === true });

      const fmt = (v, skip) => skip ? "skip" : v ? "✓" : "✗";
      console.log(`[social-cron]   Meta: ${fmt(metaOk, skipMeta)} | TikTok: ${fmt(tiktokOk, skipTikTok)} | Pinterest: ${fmt(pinterestOk, skipPinterest)}`);
    } catch (err) {
      console.error(`[social-cron]   ✗ ${err.message}`);
    } finally {
      if (existsSync(videoPath)) { try { unlinkSync(videoPath); } catch { /* ignore */ } }
    }
  }
}

// ---------------------------------------------------------------------------
// Wake detection — was the Mac woken by pmset schedule (RTC alarm)?
// ---------------------------------------------------------------------------

/**
 * Returns true if the Mac was woken by a scheduled RTC/pmset alarm
 * within the last 10 minutes — meaning the user wasn't already awake.
 */
function wasWokenBySchedule() {
  try {
    const log = execFileSync("pmset", ["-g", "log"], { encoding: "utf8", timeout: 10_000 });
    const wakeLines = log.split("\n").filter(l => /\bWake\b/.test(l));
    if (!wakeLines.length) return false;
    const last = wakeLines[wakeLines.length - 1];
    // Only treat as scheduled if reason is RTC/Alarm (not user input)
    if (!/RTC|Alarm/i.test(last)) return false;
    const m = last.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!m) return false;
    const wakeTime = new Date(m[1] + " UTC").getTime();
    return Date.now() - wakeTime < 10 * 60_000; // woken within last 10 min
  } catch { return false; }
}

async function rescheduleWake() {
  const script = new URL("schedule-wake.sh", import.meta.url).pathname;
  const r = spawnSync("sudo", ["bash", script], { stdio: "inherit" });
  if (r.status !== 0) console.warn("[social-cron] ⚠ Could not reschedule wake events (needs sudo)");
}

function sleepNow() {
  console.log("[social-cron] Woken by schedule — going back to sleep");
  // osascript sleep doesn't need sudo
  spawnSync("osascript", ["-e", 'tell application "System Events" to sleep'], { stdio: "inherit" });
}

main()
  .then(rescheduleWake)
  .then(() => { if (wasWokenBySchedule()) sleepNow(); })
  .catch((err) => {
    console.error("[social-cron] Fatal:", err.message);
    process.exit(1);
  });
