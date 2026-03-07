/**
 * thisDay. — YouTube Auto-Upload
 *
 * Reads new AI blog posts from Cloudflare KV, generates a Shorts-format
 * MP4 for each one, and uploads it to YouTube.
 *
 * Audio:  ElevenLabs TTS narration (from Did You Know / Quick Facts section)
 *         mixed with background music (assets/background.mp3) at 15% volume.
 * Image:  Wikipedia image from the post's imageUrl, or fallback logo.
 * Schedule: 1 video every 3 days via GitHub Actions cron "0 2 * /3 * *"
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
 */

import 'dotenv/config';
import { unlinkSync } from 'fs';
import { getPostIndex, getDidYouKnow, getQuickFacts } from './lib/kv.js';
import { generateVideo } from './lib/video.js';
import { uploadToYoutube } from './lib/youtube.js';
import { getUploaded, markUploaded } from './lib/tracker.js';
import { getMusicPath } from './lib/music.js';
import { generateNarration, buildNarrationScript } from './lib/elevenlabs.js';
import { uploadToR2 } from './lib/r2.js';

async function main() {
  // Posts that should be re-uploaded even if already in the tracker
  const reuploadSlugs = new Set(
    (process.env.REUPLOAD_SLUGS || '').split(',').map(s => s.trim()).filter(Boolean),
  );

  // Fetch post index + upload history in parallel
  const [posts, uploaded] = await Promise.all([
    getPostIndex(),
    getUploaded(),
  ]);

  // Sort newest-first; forced re-uploads always float to the top
  const pending = posts
    .filter(p => !uploaded[p.slug] || reuploadSlugs.has(p.slug))
    .sort((a, b) => {
      const af = reuploadSlugs.has(a.slug) ? 1 : 0;
      const bf = reuploadSlugs.has(b.slug) ? 1 : 0;
      if (bf !== af) return bf - af;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    })
    .slice(0, 1); // 1 post per run — with every-3-day cron = ~10/month

  console.log(
    `Posts in KV: ${posts.length} | ` +
    `Uploaded: ${Object.keys(uploaded).length} | ` +
    `This run: ${pending.length}` +
    (reuploadSlugs.size ? ` (force: ${[...reuploadSlugs].join(', ')})` : ''),
  );

  if (!pending.length) {
    console.log('Nothing to do.');
    return;
  }

  // Background music — user places assets/background.mp3 once (YouTube Audio Library)
  const bgMusicPath = getMusicPath();

  for (const post of pending) {
    console.log(`\n→ ${post.title}`);
    let videoPath;
    let narrationPath;
    try {
      // ── ElevenLabs TTS narration ───────────────────────────────────────────
      // Source text priority: Did You Know bullets → Quick Facts rows → description
      console.log('  Fetching Did You Know / Quick Facts from KV...');
      const dykItems   = await getDidYouKnow(post.slug);
      const quickFacts = dykItems ? null : await getQuickFacts(post.slug);
      const contentItems = dykItems ?? quickFacts ?? null;

      if (contentItems) {
        const source = dykItems ? 'Did You Know' : 'Quick Facts';
        console.log(`  Using ${source} section (${contentItems.length} items).`);
      } else {
        console.log('  No DYK/Quick Facts found — using description as fallback.');
      }

      const script = buildNarrationScript(post, contentItems);
      narrationPath = await generateNarration(post.slug, script);

      // ── Generate video ─────────────────────────────────────────────────────
      // Image: Wikipedia URL from KV index (or fallback logo)
      // Audio: narration (full vol) + background music (15% vol)
      console.log('  Generating video...');
      videoPath = await generateVideo(post, { narrationPath, bgMusicPath });
      console.log(`  Video ready: ${videoPath}`);

      // ── Upload to YouTube ──────────────────────────────────────────────────
      console.log('  Uploading to YouTube...');
      const youtubeId = await uploadToYoutube(videoPath, post);
      console.log(`  ✓ https://youtube.com/shorts/${youtubeId}`);

      // Record in KV tracker (overwrites previous entry for re-uploads)
      const privacy = process.env.YOUTUBE_PRIVACY || 'public';
      await markUploaded(post.slug, youtubeId, privacy);

      // Upload video to R2 so social-upload.js can fetch it later
      if (process.env.R2_ACCESS_KEY_ID) {
        console.log('  Uploading to R2...');
        await uploadToR2(post.slug, videoPath);
      }

    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    } finally {
      if (videoPath)    { try { unlinkSync(videoPath);    } catch { /* ignore */ } }
      if (narrationPath){ try { unlinkSync(narrationPath);} catch { /* ignore */ } }
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
