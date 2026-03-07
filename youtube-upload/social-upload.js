/**
 * thisDay. — Manual Social Media Uploader
 *
 * Uploads an existing MP4 to TikTok, Instagram Reels, and/or Facebook Reels
 * using browser automation (Playwright). Post title and description are pulled
 * from Cloudflare KV by slug — same content used on YouTube.
 *
 * Usage:
 *   node social-upload.js --slug <slug> --video <path/to/video.mp4> [--platform <name>]
 *
 * --platform options:
 *   all          TikTok + Instagram + Facebook  (default)
 *   meta         Instagram + Facebook only
 *   tiktok       TikTok only
 *   instagram    Instagram only
 *   facebook     Facebook only
 *
 * Examples:
 *   node social-upload.js --slug 6-march-2026 --video ./assets/video.mp4
 *   node social-upload.js --slug 6-march-2026 --video ./assets/video.mp4 --platform tiktok
 *   node social-upload.js --slug 6-march-2026 --video ./assets/video.mp4 --platform meta
 *
 * Required env vars (.env):
 *   CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
 *
 * Optional env vars (for auto-login):
 *   TIKTOK_USERNAME, TIKTOK_PASSWORD
 *   INSTAGRAM_USERNAME, INSTAGRAM_PASSWORD   (also used for Facebook — same Meta account)
 *   FACEBOOK_PAGE_URL                        (post to a Page instead of personal profile)
 *
 * Session files (saved after first login, reused automatically):
 *   assets/tiktok-session.json
 *   assets/instagram-session.json
 *   assets/facebook-session.json
 */

import 'dotenv/config';
import { unlinkSync } from 'fs';
import { getPostIndex } from './lib/kv.js';
import { downloadFromR2 } from './lib/r2.js';
import { uploadToTikTok } from './lib/tiktok-browser.js';
import { uploadToInstagram } from './lib/instagram-browser.js';
import { uploadToFacebook } from './lib/facebook-browser.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? true;
      i++;
    }
  }
  return args;
}

const args     = parseArgs(process.argv.slice(2));
const slug     = args.slug;
const platform = (args.platform ?? 'all').toLowerCase(); // all | meta | tiktok | instagram | facebook

// ── Validate ─────────────────────────────────────────────────────────────────

if (!slug) {
  console.error('Error: --slug is required.');
  console.error('  Example: node social-upload.js --slug 6-march-2026');
  process.exit(1);
}

const VALID_PLATFORMS = ['all', 'meta', 'tiktok', 'instagram', 'facebook'];
if (!VALID_PLATFORMS.includes(platform)) {
  console.error(`Error: --platform must be one of: ${VALID_PLATFORMS.join(', ')}`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSocial Upload`);
  console.log(`  Slug:     ${slug}`);
  console.log(`  Platform: ${platform}`);
  console.log('');

  // ── Fetch post from KV ──────────────────────────────────────────────────
  console.log('Fetching post data from Cloudflare KV...');
  const posts = await getPostIndex();
  const post  = posts.find(p => p.slug === slug);

  if (!post) {
    console.error(`Error: no post found in KV index for slug "${slug}".`);
    console.error('Available slugs (last 5):');
    posts.slice(0, 5).forEach(p => console.error(`  - ${p.slug}`));
    process.exit(1);
  }

  console.log(`  Found: "${post.title}"`);
  console.log('');

  // ── Download video from R2 ──────────────────────────────────────────────
  console.log('Downloading video from R2...');
  const videoPath = await downloadFromR2(slug);

  const doTikTok    = ['all', 'tiktok'].includes(platform);
  const doInstagram = ['all', 'meta', 'instagram'].includes(platform);
  const doFacebook  = ['all', 'meta', 'facebook'].includes(platform);

  try {
    if (doTikTok) {
      console.log('── TikTok ──────────────────────────────────────────────────────────');
      try {
        await uploadToTikTok(videoPath, post);
        console.log('TikTok: done.\n');
      } catch (err) {
        console.error(`TikTok: FAILED — ${err.message}\n`);
      }
    }

    if (doInstagram) {
      console.log('── Instagram ───────────────────────────────────────────────────────');
      try {
        await uploadToInstagram(videoPath, post);
        console.log('Instagram: done.\n');
      } catch (err) {
        console.error(`Instagram: FAILED — ${err.message}\n`);
      }
    }

    if (doFacebook) {
      console.log('── Facebook ────────────────────────────────────────────────────────');
      try {
        await uploadToFacebook(videoPath, post);
        console.log('Facebook: done.\n');
      } catch (err) {
        console.error(`Facebook: FAILED — ${err.message}\n`);
      }
    }
  } finally {
    try { unlinkSync(videoPath); } catch { /* ignore */ }
  }

  console.log('All done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
