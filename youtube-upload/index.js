/**
 * thisDay. — YouTube Auto-Upload
 *
 * Reads new AI blog posts from Cloudflare KV, generates a Shorts-format
 * MP4 for each one, uploads it to YouTube, and records what was uploaded
 * back to KV so it never uploads the same post twice.
 *
 * Run:        npm start
 * Auth setup: npm run auth   (one-time, to get YOUTUBE_REFRESH_TOKEN)
 *
 * Env vars required (.env or GitHub Secrets):
 *   CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 *   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
 */

import 'dotenv/config';
import { unlinkSync } from 'fs';
import { getPostIndex } from './lib/kv.js';
import { generateVideo } from './lib/video.js';
import { uploadToYoutube } from './lib/youtube.js';
import { getUploaded, markUploaded } from './lib/tracker.js';

async function main() {
  // Fetch index + upload history in parallel
  const [posts, uploaded] = await Promise.all([
    getPostIndex(),
    getUploaded(),
  ]);

  const pending = posts.filter(p => !uploaded[p.slug]);

  console.log(`Posts in KV: ${posts.length} | Already uploaded: ${Object.keys(uploaded).length} | Pending: ${pending.length}`);

  if (!pending.length) {
    console.log('Nothing to do.');
    return;
  }

  for (const post of pending) {
    console.log(`\n→ ${post.title}`);
    let videoPath;
    try {
      // Generate video
      console.log('  Generating video...');
      videoPath = await generateVideo(post);
      console.log(`  Frame rendered: ${videoPath}`);

      // Upload to YouTube
      console.log('  Uploading to YouTube...');
      const youtubeId = await uploadToYoutube(videoPath, post);
      console.log(`  ✓ https://youtube.com/shorts/${youtubeId}`);

      // Record in KV so it's never uploaded again
      await markUploaded(post.slug, youtubeId);

    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    } finally {
      // Always clean up the temp video file
      if (videoPath) {
        try { unlinkSync(videoPath); } catch { /* ignore */ }
      }
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
