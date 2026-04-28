/**
 * thisDay. — YouTube Auto-Upload
 *
 * Reads new AI blog posts from Cloudflare KV, generates a Shorts-format
 * MP4 for each one, and uploads it to YouTube.
 *
 * Audio:  ElevenLabs TTS narration (from Did You Know / Quick Facts section)
 *         mixed with background music (assets/background.mp3) at 15% volume.
 * Image:  Exact Wikipedia-article mode. Pulls scene images only from the
 *         specific Wikipedia article tied to the post topic.
 * Schedule: Mon/Tue/Thu/Fri via GitHub Actions cron at 01:00 UTC
 *
 * Run:        npm start
 * Auth setup: npm run auth   (one-time, to get YOUTUBE_REFRESH_TOKEN)
 *
 * Env vars required (.env or GitHub Secrets):
 *   CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 *   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
 *   ELEVENLABS_API_KEY     (TTS voiceover, 10k chars/month free)
 *   BLOG_WORKER_URL        (needed when this job must trigger /blog/publish)
 *   YOUTUBE_REGEN_SECRET   (auth for POST /blog/publish regeneration)
 *   YOUTUBE_PRIVACY        (optional: private or public, default public)
 *   WIKI_IMAGE_MIN_COUNT   (optional: min usable wiki images for multi-scene video; default 3)
 *
 * Optional expert-model fallbacks used by helper modules:
 *   GROQ_API_KEY...        (narration/history review helpers)
 *   HF_TOKEN...            (narration/history review helpers)
 */

import "dotenv/config";
import { unlinkSync } from "fs";
import { execFileSync } from "child_process";
import {
  getPostIndex,
  getDidYouKnow,
  getQuickFacts,
  getArticleText,
  getPostWikipediaUrl,
  updateIndexEntry,
  deleteIndexEntry,
} from "./lib/kv.js";
import { polishNarrationItems } from "./lib/narration-expert.js";
import { generateVideo, resolvePostImage } from "./lib/video.js";
import { verifyKvReadWriteAccess } from "./lib/kv.js";
import { checkVideoQuality } from "./lib/video-quality.js";
import { uploadToYoutube, verifyYoutubeAuth } from "./lib/youtube.js";
import {
  acquireUploadLock,
  getUploaded,
  markUploaded,
  recordQuotaSignal,
  recordPipelineFailure,
  recordPipelineSuccess,
  markSocialPosted,
  releaseUploadLock,
} from "./lib/tracker.js";
import { getMusicPath } from "./lib/music.js";
import { notifyUpload } from "./lib/notify.js";
import { postToMeta } from "./lib/meta.js";
import { postToTikTok } from "./lib/tiktok.js";
import {
  generateNarration,
  buildNarrationScript,
  buildNarrationParts,
} from "./lib/elevenlabs.js";

// Parse REUPLOAD_SLUGS from env into a Set.
// Accepts: "a,b,c" or "a b c" or newline-separated.
// Empty/undefined => empty set.
const reuploadSlugs = new Set(
  (process.env.REUPLOAD_SLUGS || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

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

/**
 * Returns today's expected KV slug in the same format the blog worker uses:
 * day (no leading zero) + "-" + lowercase month name + "-" + year
 * e.g. "30-march-2026"
 */
function getTodaySlug() {
  const now = new Date();
  const day = now.getUTCDate();
  const month = now
    .toLocaleString("en-US", { month: "long", timeZone: "UTC" })
    .toLowerCase();
  const year = now.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

async function waitForPublishedPost(slug, {
  timeoutMs = 5 * 60_000,
  intervalMs = 15_000,
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const posts = await getPostIndex();
    const post = posts.find((p) => p.slug === slug);
    if (post) return { posts, post };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { posts: await getPostIndex(), post: null };
}

/**
 * Ensures today's post exists in KV. If not found, calls POST /blog/publish
 * to generate it, waits 60 s for propagation, then returns the refreshed index.
 * Always returns the latest post list (never a stale in-memory copy).
 */
async function ensureTodaysPost(posts) {
  const todaySlug = getTodaySlug();
  console.log(`Today's expected slug: ${todaySlug}`);

  if (posts.find((p) => p.slug === todaySlug)) {
    console.log(`✓ Today's post is in KV.`);
    return posts;
  }

  console.log(
    `⚠ Today's post "${todaySlug}" not found in KV — triggering blog worker...`,
  );
  const workerUrl = process.env.BLOG_WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.YOUTUBE_REGEN_SECRET;

  if (!workerUrl || !secret) {
    console.warn(
      "  BLOG_WORKER_URL / YOUTUBE_REGEN_SECRET not set — cannot generate today's post.",
    );
    return posts;
  }

  const res = await fetch(`${workerUrl}/blog/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`  ✗ /blog/publish returned ${res.status}: ${body}`);
    return posts;
  }

  console.log(
    "  ✓ Blog worker triggered. Waiting for the final published article to appear in the public KV index...",
  );
  const { posts: fresh, post } = await waitForPublishedPost(todaySlug);
  if (post) {
    console.log(`  ✓ Today's post "${todaySlug}" is now in KV.`);
  } else {
    console.warn(
      `  ⚠ Today's final post still not found after waiting — will upload next available.`,
    );
  }
  return fresh;
}

function ensureSocialPrereqs() {
  const wantsMeta =
    process.env.META_PAGE_ID ||
    process.env.META_PAGE_TOKEN ||
    process.env.META_IG_USER_ID;
  const wantsTikTok =
    process.env.TIKTOK_ACCESS_TOKEN || process.env.TIKTOK_OPEN_ID;

  if (!wantsMeta && !wantsTikTok) return;

  try {
    execFileSync("openclaw", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    if (wantsMeta && process.env.META_SKIP_FACEBOOK !== "true") {
      console.warn(
        "  Meta: openclaw not found — forcing META_SKIP_FACEBOOK=true",
      );
      process.env.META_SKIP_FACEBOOK = "true";
    }
    if (wantsTikTok && process.env.TIKTOK_SKIP !== "true") {
      console.warn("  TikTok: openclaw not found — forcing TIKTOK_SKIP=true");
      process.env.TIKTOK_SKIP = "true";
    }
  }
}

async function main() {
  const privacyMode = process.env.YOUTUBE_PRIVACY || "public";
  const maxUploadsPerRun = 1; // FORCE: Only upload 1 video per run

  const todaySlug = getTodaySlug();
  console.log(`YouTube privacy mode: ${privacyMode}`);
  console.log(`Today's slug: ${todaySlug}`);
  console.log(
    `Max uploads this run: ${maxUploadsPerRun} (LIMITED TO TODAY ONLY)`,
  );
  ensureSocialPrereqs();
  if (privacyMode === "private") {
    console.warn(
      "Warning: privacy=private. Videos will upload, but blog pages will not embed them.",
    );
  }

  // Always fetch a fresh post index — never rely on a cached copy
  let posts = await getPostIndex();
  const uploaded = await getUploaded();

  // Ensure today's post is in KV; generate it if missing
  posts = await ensureTodaysPost(posts);

  const todayPost = posts.find((post) => post.slug === todaySlug);
  if (!todayPost) {
    await recordPipelineFailure({
      step: "blog",
      slug: todaySlug,
      message: "today's post missing after regeneration",
    });
    console.warn(
      `Today's post "${todaySlug}" is still missing after regeneration — skipping upload.`,
    );
    return;
  }

  try {
    await verifyKvReadWriteAccess();
    await verifyYoutubeAuth();
  } catch (err) {
    await recordPipelineFailure({
      step: "youtube",
      slug: todaySlug,
      message: `preflight failed: ${err.message}`,
    });
    throw err;
  }

  // Today's post exists and KV/YouTube auth are healthy — clear any blog failure streak.
  await recordPipelineSuccess("blog");

  const pending =
    uploaded[todaySlug] && !reuploadSlugs.has(todaySlug) ? [] : [todayPost];

  console.log(
    `Posts in KV: ${posts.length} | ` +
      `Uploaded: ${Object.keys(uploaded).length} | ` +
      `This run: ${pending.length}`,
  );

  if (!pending.length) {
    console.log("Today's post is already uploaded. Nothing to do.");
    return;
  }

  const uploadLockOwner = `${process.env.GITHUB_RUN_ID || "local"}:${process.pid}`;
  const uploadLockToken = await acquireUploadLock(uploadLockOwner);
  if (!uploadLockToken) {
    console.warn("Upload already in progress — skipping this run.");
    return;
  }

  try {
    for (let post of pending) {
      console.log(`\n→ ${post.title}`);
      // Per-post music — always uses assets/background.mp3
      const bgMusicPath = getMusicPath();
      let videoPath;
      let videoCuts = [];
      let narrationPath;
      let videoResult = null;
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
        const articleText = await getArticleText(post.slug).catch(() => null);
        const wikiArticleUrl = await getPostWikipediaUrl(post.slug).catch(
          () => null,
        );
        const narrationItems = contentItems
          ? await polishNarrationItems(
              post.title,
              contentItems,
              articleText,
            ).catch(() => contentItems)
          : null;

        const script = buildNarrationScript(
          post,
          narrationItems ?? contentItems,
          articleText,
        );
        const { path: narrPath, words: narrWords } = await generateNarration(
          post.slug,
          script,
        );
        narrationPath = narrPath;

        // ── Image pre-check ────────────────────────────────────────────────────
        // Multi-scene mode builds from article/Wikipedia images instead of a
        // single stored post.imageUrl, so the legacy resolvePostImage check is
        // only needed for the single-scene fallback path.
        const useAiImage = process.env.USE_AI_IMAGE !== "false";
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
          console.log("  Multi-scene wiki mode — skipping single-image pre-check.");
        }

        // ── Generate video (with quality gate + retry) ─────────────────────────
        const MAX_VIDEO_ATTEMPTS = 2;
        let qualityHint = null;
        let quality = null;

        for (let attempt = 1; attempt <= MAX_VIDEO_ATTEMPTS; attempt++) {
          if (attempt > 1)
            console.log(
              `  Retrying video generation (attempt ${attempt}/${MAX_VIDEO_ATTEMPTS})...`,
            );
          else console.log("  Generating video...");

          videoResult = await generateVideo(post, {
            narrationPath,
            bgMusicPath,
            words: narrWords,
            useAiImage,
            contentItems,
            wikiArticleUrl,
            narrationParts: buildNarrationParts(
              post,
              narrationItems ?? contentItems,
              articleText,
            ),
            qualityHint,
          });
          videoPath = videoResult.path;
          videoCuts = videoResult.cuts ?? [];

          console.log("  Running quality check...");
          quality = await checkVideoQuality(videoPath);
          console.log(quality.report);

          if (quality.passed) break;

          // Failed — clean up and decide whether to retry
          try {
            unlinkSync(videoPath);
          } catch {
            /* ignore */
          }
          videoPath = null;

          if (!quality.retryable || attempt === MAX_VIDEO_ATTEMPTS) {
            throw new Error(
              `Video quality check failed after ${attempt} attempt(s): ${quality.issues.join("; ")}`,
            );
          }
          qualityHint = quality.remediationHint;
          console.log(`  ⚠ Quality fail — retry with hint: "${qualityHint}"`);
        }
        console.log(
          `  Video ready: ${videoPath}  (quality ${quality.score}/10)`,
        );

        // ── Upload to YouTube ──────────────────────────────────────────────────
        // Re-fetch tracker to guard against double-upload if two cron runs overlap
        const freshUploaded = await getUploaded();
        if (freshUploaded[post.slug] && !reuploadSlugs.has(post.slug)) {
          console.log(`  ⚠ Already uploaded by a concurrent run — skipping.`);
          continue;
        }
        console.log("  Uploading to YouTube...");
        const youtubeId = await uploadToYoutube(videoPath, post, videoCuts);
        console.log(`  ✓ https://www.youtube.com/shorts/${youtubeId}`);

        // Record in KV tracker (overwrites previous entry for re-uploads)
        const privacy = privacyMode;
        await markUploaded(post.slug, youtubeId, privacy);
        console.log(
          `  Tracker updated: youtube:uploaded[${post.slug}] (privacy=${privacy})`,
        );
        const metaOk = await postToMeta(videoPath, post, youtubeId);
        const tiktokOk = await postToTikTok(videoPath, post, youtubeId);
        await markSocialPosted(post.slug, { meta: metaOk, tiktok: tiktokOk });
        await notifyUpload(post, youtubeId);
        await recordPipelineSuccess("youtube");
      } catch (err) {
        if (err.message?.startsWith("IMAGE_UNAVAILABLE")) {
          console.error(`  ✗ No working image for "${post.title}"`);
          // Guard: only regenerate once per slug to prevent infinite loop
          if (reuploadSlugs.has(`__regen_${post.slug}`)) {
            console.error(
              `  ✗ Already regenerated "${post.slug}" once — skipping.`,
            );
          } else {
            reuploadSlugs.add(`__regen_${post.slug}`);
            const newPost = await triggerArticleRegen(post.slug);
            if (newPost) {
              // Re-run this iteration with the freshly generated post
              pending.splice(pending.indexOf(post) + 1, 0, newPost);
              console.log(`  → New article queued for upload in this run.`);
            }
          }
        } else {
          console.error(`  ✗ Failed: ${err.message}`);
          if (/429|rate limit|quota|too many|403/i.test(err.message)) {
            await recordQuotaSignal("youtube-upload", err.message);
          }
          await recordPipelineFailure({
            step: "youtube",
            slug: post.slug,
            message: err.message,
          });
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
  } finally {
    await releaseUploadLock(uploadLockToken);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
