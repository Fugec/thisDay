/**
 * thisDay. — Automatic Social Media Uploader
 *
 * Polls Cloudflare R2 for new videos and posts any that haven't been
 * published to social media yet (TikTok, Instagram, Facebook).
 *
 * Tracks posted slugs in assets/social-posted.json (local file, git-ignored).
 *
 * Usage:
 *   npm run auto
 *
 * Typically run on a schedule via launchd (see thisday-social.plist).
 * Picks up any videos uploaded to R2 by the GitHub Actions YouTube workflow.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { listR2Slugs } from './lib/r2-list.js';
import { downloadFromR2 } from './lib/r2.js';
import { getPostIndex } from './lib/kv.js';
import { uploadToTikTok } from './lib/tiktok-browser.js';
import { uploadToInstagram } from './lib/instagram-browser.js';
import { uploadToFacebook } from './lib/facebook-browser.js';

const TRACKER_PATH = join('./assets', 'social-posted.json');

function loadPosted() {
  if (!existsSync(TRACKER_PATH)) return {};
  try { return JSON.parse(readFileSync(TRACKER_PATH, 'utf8')); } catch { return {}; }
}

function savePosted(tracker) {
  writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2));
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Auto Social Upload`);

  // ── Check R2 for videos ──────────────────────────────────────────────────
  console.log('Listing R2 bucket...');
  const r2Slugs = await listR2Slugs();
  console.log(`  Found ${r2Slugs.length} video(s) in R2.`);

  const posted = loadPosted();
  const pending = r2Slugs.filter(slug => !posted[slug]);

  if (!pending.length) {
    console.log('  Nothing new to post. Exiting.');
    return;
  }

  console.log(`  New: ${pending.join(', ')}`);

  // ── Fetch post index from KV ─────────────────────────────────────────────
  const posts = await getPostIndex();

  for (const slug of pending) {
    const post = posts.find(p => p.slug === slug);
    if (!post) {
      console.warn(`  [${slug}] No KV entry found — skipping.`);
      continue;
    }

    console.log(`\n→ ${post.title} (${slug})`);
    let videoPath;

    try {
      console.log('  Downloading from R2...');
      videoPath = await downloadFromR2(slug);

      let allOk = true;

      try {
        console.log('  Uploading to TikTok...');
        await uploadToTikTok(videoPath, post);
        console.log('  TikTok: done.');
      } catch (err) {
        console.error(`  TikTok: FAILED — ${err.message}`);
        allOk = false;
      }

      try {
        console.log('  Uploading to Instagram...');
        await uploadToInstagram(videoPath, post);
        console.log('  Instagram: done.');
      } catch (err) {
        console.error(`  Instagram: FAILED — ${err.message}`);
        allOk = false;
      }

      try {
        console.log('  Uploading to Facebook...');
        await uploadToFacebook(videoPath, post);
        console.log('  Facebook: done.');
      } catch (err) {
        console.error(`  Facebook: FAILED — ${err.message}`);
        allOk = false;
      }

      // Mark as posted even if some platforms failed — prevents infinite retries.
      // Failed platforms can be retried manually with: npm run social -- --slug <slug>
      posted[slug] = {
        postedAt:  new Date().toISOString(),
        allOk,
      };
      savePosted(posted);
      console.log(`  Tracker updated → ${TRACKER_PATH}`);

    } catch (err) {
      console.error(`  ✗ Fatal error for ${slug}: ${err.message}`);
    } finally {
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
