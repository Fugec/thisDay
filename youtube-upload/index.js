/**
 * thisDay. — YouTube Auto-Upload
 *
 * Reads new AI blog posts from Cloudflare KV, generates a Shorts-format
 * MP4 for each one, and uploads it to YouTube.
 *
 * Audio:  ElevenLabs TTS narration (from Did You Know / Quick Facts section)
 *         mixed with background music (assets/background.mp3) at 15% volume.
 * Image:  Wikipedia image from the post's imageUrl, or fallback logo.
 * Schedule: 1 video per run, Sun/Mon/Wed/Fri via GitHub Actions cron at 02:00 and 10:00 UTC (2 runs/day, 4 days/week)
 *
 * Run:        npm start
 * Auth setup: npm run auth   (one-time, to get YOUTUBE_REFRESH_TOKEN)
 *
 * Env vars required (.env or GitHub Secrets):
 *   CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 *   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
 *   ELEVENLABS_API_KEY     (TTS voiceover, 10k chars/month free)
 *   REUPLOAD_SLUGS         (optional: force re-upload, comma-separated)
 *   YOUTUBE_PRIVACY        (optional: private or public, default public)
 *   USE_AI_IMAGE           (optional: true = AI-generated background, default false)
 */

import "dotenv/config";
import { unlinkSync } from "fs";
import {
  getPostIndex,
  getDidYouKnow,
  getQuickFacts,
  getArticleText,
  updateIndexEntry,
  deleteIndexEntry,
} from "./lib/kv.js";
import { polishNarrationItems } from "./lib/narration-expert.js";
import { generateVideo, resolvePostImage } from "./lib/video.js";
import { checkVideoQuality } from "./lib/video-quality.js";
import { uploadToYoutube } from "./lib/youtube.js";
import { getUploaded, markUploaded, markSocialPosted } from "./lib/tracker.js";
import { getMusicPath } from "./lib/music.js";
import { notifyUpload } from "./lib/notify.js";
import { postToMeta } from "./lib/meta.js";
import { postToTikTok } from "./lib/tiktok.js";
import {
  generateNarration,
  buildNarrationScript,
  buildNarrationParts,
} from "./lib/elevenlabs.js";

/**
 * Deletes the broken post from KV, then calls POST /blog/publish to generate
 * a fresh article (same date slug, new topic, guaranteed real image).
 * Waits 60 s for the worker to finish, then returns the new post entry.
 * Returns null if BLOG_WORKER_URL / YOUTUBE_REGEN_SECRET are not configured.
 */
async function triggerArticleRegen(slug) {
  const workerUrl = process.env.BLOG_WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.YOUTUBE_REGEN_SECRET;
  if (!workerUrl || !secret) {
    console.warn(
      "  ⚠ BLOG_WORKER_URL / YOUTUBE_REGEN_SECRET not set — cannot regenerate article.",
    );
    return null;
  }

  console.log(`  Deleting broken post "${slug}" from KV...`);
  await deleteIndexEntry(slug);

  console.log("  Triggering new article via POST /blog/publish ...");
  const res = await fetch(`${workerUrl}/blog/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`  ✗ /blog/publish returned ${res.status}: ${body}`);
    return null;
  }

  console.log("  ✓ New article generated. Waiting 60 s for KV propagation...");
  await new Promise((r) => setTimeout(r, 60_000));

  // Re-fetch the index and look for the new entry with the same slug
  const fresh = await getPostIndex();
  const newPost = fresh.find((p) => p.slug === slug);
  if (!newPost) {
    console.warn(
      `  ⚠ New post for "${slug}" not found in index after regeneration.`,
    );
    return null;
  }
  console.log(
    `  ✓ New post ready: "${newPost.title}" — image: ${newPost.imageUrl}`,
  );
  return newPost;
}

async function main() {
  const privacyMode = process.env.YOUTUBE_PRIVACY || "public";
  const maxUploadsPerRun = Math.max(
    1,
    Number.parseInt(process.env.MAX_UPLOADS_PER_RUN || "1", 10) || 1,
  );

  console.log(`YouTube privacy mode: ${privacyMode}`);
  console.log(`Max uploads this run: ${maxUploadsPerRun}`);
  if (privacyMode === "private") {
    console.warn(
      "Warning: privacy=private. Videos will upload, but blog pages will not embed them.",
    );
  }

  // Posts that should be re-uploaded even if already in the tracker
  const reuploadSlugs = new Set(
    (process.env.REUPLOAD_SLUGS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Fetch post index + upload history in parallel
  const [posts, uploaded] = await Promise.all([getPostIndex(), getUploaded()]);

  // Sort newest-first; forced re-uploads always float to the top
  const pending = posts
    .filter((p) => !uploaded[p.slug] || reuploadSlugs.has(p.slug))
    .sort((a, b) => {
      const af = reuploadSlugs.has(a.slug) ? 1 : 0;
      const bf = reuploadSlugs.has(b.slug) ? 1 : 0;
      if (bf !== af) return bf - af;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    })
    .slice(0, maxUploadsPerRun);

  console.log(
    `Posts in KV: ${posts.length} | ` +
      `Uploaded: ${Object.keys(uploaded).length} | ` +
      `This run: ${pending.length}` +
      (reuploadSlugs.size ? ` (force: ${[...reuploadSlugs].join(", ")})` : ""),
  );

  if (!pending.length) {
    console.log("Nothing to do.");
    return;
  }

  for (let post of pending) {
    console.log(`\n→ ${post.title}`);
    // Per-post music — always uses assets/background.mp3
    const bgMusicPath = getMusicPath();
    let videoPath;
    let videoCuts = [];
    let narrationPath;
    try {
      // ── ElevenLabs TTS narration ───────────────────────────────────────────
      // Source text priority: Did You Know bullets → Quick Facts rows → description
      console.log("  Fetching Did You Know / Quick Facts from KV...");
      const dykItems = await getDidYouKnow(post.slug);
      const quickFacts = dykItems ? null : await getQuickFacts(post.slug);
      const contentItems = dykItems ?? quickFacts ?? null;

      if (contentItems) {
        const source = dykItems ? "Did You Know" : "Quick Facts";
        console.log(
          `  Using ${source} section (${contentItems.length} items).`,
        );
      } else {
        console.log(
          "  No DYK/Quick Facts found — using description as fallback.",
        );
      }

      // ── Narration expert: polish DYK/Quick Facts for engaging TTS ─────────
      // Uses full article text as context. Falls back to originals on any error.
      const articleText = contentItems ? await getArticleText(post.slug).catch(() => null) : null;
      const narrationItems = contentItems
        ? await polishNarrationItems(post.title, contentItems, articleText).catch(() => contentItems)
        : null;

      const script = buildNarrationScript(post, narrationItems ?? contentItems);
      const { path: narrPath, words: narrWords } = await generateNarration(
        post.slug,
        script,
      );
      narrationPath = narrPath;

      // ── Image pre-check ────────────────────────────────────────────────────
      // When USE_AI_IMAGE is set we skip the Wikipedia check (AI generates its own).
      // Otherwise validate stored imageUrl; find a Wikipedia replacement if broken.
      // Throws IMAGE_UNAVAILABLE if no working image exists — post is skipped.
      const useAiImage = process.env.USE_AI_IMAGE === "true";
      if (!useAiImage) {
        console.log("  Checking image...");
        const { imageUrl: resolvedImage, wasReplaced } =
          await resolvePostImage(post);
        if (wasReplaced) {
          post = { ...post, imageUrl: resolvedImage };
          await updateIndexEntry(post.slug, { imageUrl: resolvedImage });
          console.log(`  ✓ KV index updated with replacement image`);
        } else {
          console.log("  ✓ Image OK");
        }
      } else {
        console.log("  AI image mode — skipping Wikipedia image check.");
      }

      // ── Generate video (with quality gate + retry) ─────────────────────────
      const MAX_VIDEO_ATTEMPTS = 2;
      let qualityHint = null;
      let quality = null;

      for (let attempt = 1; attempt <= MAX_VIDEO_ATTEMPTS; attempt++) {
        if (attempt > 1) console.log(`  Retrying video generation (attempt ${attempt}/${MAX_VIDEO_ATTEMPTS})...`);
        else console.log("  Generating video...");

        const videoResult = await generateVideo(post, {
          narrationPath,
          bgMusicPath,
          words: narrWords,
          useAiImage,
          contentItems,
          narrationParts: buildNarrationParts(post, narrationItems ?? contentItems),
          qualityHint,
        });
        videoPath = videoResult.path;
        videoCuts = videoResult.cuts ?? [];

        console.log("  Running quality check...");
        quality = await checkVideoQuality(videoPath);
        console.log(quality.report);

        if (quality.passed) break;

        // Failed — clean up and decide whether to retry
        try { unlinkSync(videoPath); } catch { /* ignore */ }
        videoPath = null;

        if (!quality.retryable || attempt === MAX_VIDEO_ATTEMPTS) {
          throw new Error(
            `Video quality check failed after ${attempt} attempt(s): ${quality.issues.join("; ")}`,
          );
        }
        qualityHint = quality.remediationHint;
        console.log(`  ⚠ Quality fail — retry with hint: "${qualityHint}"`);
      }
      console.log(`  Video ready: ${videoPath}  (quality ${quality.score}/10)`);

      // ── Upload to YouTube ──────────────────────────────────────────────────
      // Re-fetch tracker to guard against double-upload if two cron runs overlap
      const freshUploaded = await getUploaded();
      if (freshUploaded[post.slug] && !reuploadSlugs.has(post.slug)) {
        console.log(`  ⚠ Already uploaded by a concurrent run — skipping.`);
        continue;
      }
      console.log("  Uploading to YouTube...");
      const youtubeId = await uploadToYoutube(videoPath, post, videoCuts);
      console.log(`  ✓ https://youtube.com/shorts/${youtubeId}`);

      // Record in KV tracker (overwrites previous entry for re-uploads)
      const privacy = privacyMode;
      await markUploaded(post.slug, youtubeId, privacy);
      console.log(
        `  Tracker updated: youtube:uploaded[${post.slug}] (privacy=${privacy})`,
      );
      const metaOk   = await postToMeta(videoPath, post, youtubeId);
      const tiktokOk = await postToTikTok(videoPath, post, youtubeId);
      await markSocialPosted(post.slug, { meta: metaOk, tiktok: tiktokOk });
      await notifyUpload(post, youtubeId);
    } catch (err) {
      if (err.message?.startsWith("IMAGE_UNAVAILABLE")) {
        console.error(`  ✗ No working image for "${post.title}"`);
        const newPost = await triggerArticleRegen(post.slug);
        if (newPost) {
          // Re-run this iteration with the freshly generated post
          pending.splice(pending.indexOf(post) + 1, 0, newPost);
          console.log(`  → New article queued for upload in this run.`);
        }
      } else {
        console.error(`  ✗ Failed: ${err.message}`);
      }
    } finally {
      if (videoPath) {
        try {
          unlinkSync(videoPath);
        } catch {
          /* ignore */
        }
      }
      if (narrationPath) {
        try {
          unlinkSync(narrationPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
