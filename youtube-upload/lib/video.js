/**
 * Generates a YouTube Shorts MP4 (1080x1920) from a blog post.
 *
 * Audio mixing:
 *   narrationPath  — ElevenLabs TTS voiceover, played once at full volume.
 *   bgMusicPath    — Background music looped for the full 45 s at 15% volume.
 *   When both are present they are mixed with FFmpeg's amix filter so the
 *   voice is always clear over the music.
 *
 * Requires: sharp, fluent-ffmpeg, and FFmpeg installed on the system.
 * On Ubuntu (GitHub Actions): sudo apt-get install -y ffmpeg fonts-dejavu-core
 * On macOS: brew install ffmpeg
 */

import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const TMP = './tmp';
const W = 1080;
const H = 1920;

// ---------------------------------------------------------------------------
// Image validation & resolution
// ---------------------------------------------------------------------------

async function isWorkingImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const headers = { 'User-Agent': 'thisday.info-blog/1.0 (https://thisday.info)' };
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers });
    // Some CDNs reject HEAD; fall back to GET
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', headers });
    }
    if (!res.ok) return false;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    return contentType.startsWith('image/');
  } catch {
    return false;
  }
}

async function fetchWikipediaImage(title) {
  if (!title) return null;
  const ua = { 'User-Agent': 'thisday.info-blog/1.0 (https://thisday.info)' };
  try {
    // 1. REST summary — fastest, returns lead/thumbnail image
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: ua },
    );
    if (summaryRes.ok) {
      const d = await summaryRes.json();
      const img = d.thumbnail?.source ?? d.originalimage?.source ?? null;
      if (img) return img;
    }

    // 2. MediaWiki images list + imageinfo — catches infobox images not exposed
    //    by the REST summary (e.g. non-free images under /wikipedia/en/)
    const listRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=images&imlimit=10&format=json`,
      { headers: ua },
    );
    if (!listRes.ok) return null;
    const listData = await listRes.json();
    const page = Object.values(listData?.query?.pages ?? {})[0];
    const imageFiles = (page?.images ?? [])
      .map((i) => i.title)
      .filter((t) => /\.(jpe?g|png|webp|gif)$/i.test(t) && !/icon|logo|flag|map|seal|coa/i.test(t));

    if (!imageFiles.length) return null;

    // Resolve the first usable file to its direct URL
    const infoRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(imageFiles[0])}&prop=imageinfo&iiprop=url&format=json`,
      { headers: ua },
    );
    if (!infoRes.ok) return null;
    const infoData = await infoRes.json();
    const infoPage = Object.values(infoData?.query?.pages ?? {})[0];
    return infoPage?.imageinfo?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

/** URLs that must never be used as a video background image. */
function isPlaceholderImage(url) {
  if (!url) return true;
  const n = url.trim().toLowerCase();
  return (
    n.includes('/images/logo.png') ||
    n.includes('placehold.co') ||
    n.includes('placeholder')
  );
}

/**
 * Pre-checks post.imageUrl. If missing, broken, or a placeholder/logo,
 * searches Wikipedia for a real replacement image.
 * Returns { imageUrl, wasReplaced } on success; throws IMAGE_UNAVAILABLE if
 * no working image is found (caller should skip the post).
 *
 * @param {{ slug: string, title: string, imageUrl?: string }} post
 * @returns {Promise<{ imageUrl: string, wasReplaced: boolean }>}
 */
export async function resolvePostImage(post) {
  const original = post.imageUrl || null;

  // 1. Stored imageUrl is a real, reachable image (not a placeholder/logo)
  if (original && !isPlaceholderImage(original) && await isWorkingImageUrl(original)) {
    return { imageUrl: original, wasReplaced: false };
  }

  if (original && isPlaceholderImage(original)) {
    console.warn(`  ⚠ Image is a placeholder/logo — searching for real image: ${original}`);
  } else if (original) {
    console.warn(`  ⚠ Image broken or unreachable: ${original}`);
  } else {
    console.warn(`  ⚠ No imageUrl stored for "${post.title}"`);
  }

  // 2. Try Wikipedia thumbnail with two queries:
  //    a) full title (date intact)
  //    b) event name only — everything before the " - " date separator
  //       e.g. "The Founding of Kappa Alpha Society - March 13, 1825" → "The Founding of Kappa Alpha Society"
  // Strip "The [Verb] of [The]" prefix for the core-subject query
  const verbPrefixRe = /^(The\s+)?(Founding|Birth|Death|Discovery|Invention|Signing|Formation|Establishment|Battle|Siege|Launch|Liberation|Revolution|Treaty|Election|Inauguration|Coronation|Assassination)\s+(of\s+)?(the\s+)?/i;
  const beforeDate = post.title.split(/\s*[-–—]\s+(?=[A-Z][a-z]+ \d)/)[0].trim();
  const coreSubject = beforeDate.replace(verbPrefixRe, '').trim();

  const wikiQueries = [
    post.title,           // 1. full title (date + year intact)
    beforeDate,           // 2. event name, date stripped
    coreSubject,          // 3. core subject, prefix + date stripped  (e.g. "Kappa Alpha Society")
  ].filter((q, i, arr) => q && arr.indexOf(q) === i); // deduplicate

  for (const query of wikiQueries) {
    const wikiImage = await fetchWikipediaImage(query);
    if (wikiImage && await isWorkingImageUrl(wikiImage)) {
      console.log(`  ↺ Wikipedia replacement found (query: "${query}"): ${wikiImage}`);
      return { imageUrl: wikiImage, wasReplaced: true };
    }
  }

  // 3. No working image — throw so the caller skips this post rather than
  //    uploading a video with no meaningful background.
  throw new Error(`IMAGE_UNAVAILABLE: no working image found for "${post.title}" (original: ${original ?? 'none'})`);
}
const DURATION = 45; // seconds — within YouTube Shorts 60 s limit
const FPS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapLines(text, maxChars) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// SVG overlay builder
// ---------------------------------------------------------------------------

function buildSVG(title) {
  const titleLines = wrapLines(title, 28).slice(0, 3);

  const titleLineH  = 82;
  const titleStartY = 1100;

  const titleSVG = titleLines.map((line, i) => `
    <text x="540" y="${titleStartY + i * titleLineH}"
      font-family="DejaVu Sans,Arial,sans-serif" font-size="68" font-weight="bold"
      fill="white" text-anchor="middle" dominant-baseline="middle"
    >${escapeXml(line)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#000" stop-opacity="0.10"/>
        <stop offset="52%"  stop-color="#000" stop-opacity="0.72"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.90"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>

    <!-- "ON THIS DAY" label -->
    <text x="540" y="1020"
      font-family="DejaVu Sans,Arial,sans-serif" font-size="44" font-weight="bold"
      fill="#60a5fa" text-anchor="middle" dominant-baseline="middle"
      letter-spacing="8"
    >ON THIS DAY</text>

    ${titleSVG}

    <!-- Branding -->
    <text x="540" y="1868"
      font-family="DejaVu Sans,Arial,sans-serif" font-size="40" font-weight="bold"
      fill="#60a5fa" text-anchor="middle" dominant-baseline="middle"
    >thisday.info</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Image download
// ---------------------------------------------------------------------------

async function downloadImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a Shorts-format MP4 for the given post.
 * Returns the path to the generated video file.
 * The caller is responsible for deleting the file after upload.
 *
 * @param {{ slug: string, title: string, description: string, imageUrl: string }} post
 * @param {{
 *   narrationPath?: string|null,  ElevenLabs TTS audio — played once at 100% volume
 *   bgMusicPath?:   string|null,  Background music — looped at 15% volume
 * }} [opts]
 * @returns {Promise<string>} path to the MP4
 */
export async function generateVideo(post, { narrationPath, bgMusicPath } = {}) {
  mkdirSync(TMP, { recursive: true });

  const { slug, title } = post;
  const imageUrl   = post.imageUrl; // must be pre-validated by resolvePostImage()
  if (!imageUrl) throw new Error(`generateVideo called without a validated imageUrl for "${slug}"`);
  const framePath  = join(TMP, `${slug}_frame.png`);
  const videoPath  = join(TMP, `${slug}.mp4`);

  // 1. Download + resize Wikipedia image → PNG frame with SVG overlay
  const imgBuffer = await downloadImageBuffer(imageUrl);
  const svgBuffer = Buffer.from(buildSVG(title));

  await sharp(imgBuffer)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .composite([{ input: svgBuffer, blend: 'over' }])
    .png()
    .toFile(framePath);

  // 2. Encode PNG frame → 45-second MP4
  //    Audio strategy:
  //      narration + music  → amix (narration 100%, music 15%)
  //      narration only     → narration track, video pads to 45 s silently
  //      music only         → music looped at full volume for 45 s
  //      no audio           → silent video
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(framePath)
      .inputOptions(['-loop 1']); // input 0 — image

    const hasNarr  = !!narrationPath;
    const hasMusic = !!bgMusicPath;

    // Add audio inputs in fixed order: narration=1, music=2 (when both present)
    if (hasNarr)  cmd.input(narrationPath);                               // input 1
    if (hasMusic) cmd.input(bgMusicPath).inputOptions(['-stream_loop -1']); // input 1 or 2

    const musicIdx = hasNarr && hasMusic ? 2 : 1; // music input index
    const narrIdx  = 1;                            // narration always input 1

    const baseOpts = [
      '-c:v libx264',
      `-t ${DURATION}`,
      '-pix_fmt yuv420p',
      `-r ${FPS}`,
      '-movflags +faststart',
    ];

    if (hasNarr && hasMusic) {
      // Mix: narration at full volume + music at 15% in background
      // normalize=0 prevents amix from attenuating the narration
      cmd
        .complexFilter(
          `[${musicIdx}:a]volume=0.15[bg];` +
          `[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`,
        )
        .outputOptions([
          ...baseOpts,
          '-map 0:v', '-map [a]',
          '-c:a aac', '-b:a 128k',
        ]);
    } else if (hasNarr) {
      // Narration only — video is 45 s, audio ends when narration ends (rest is silent)
      cmd.outputOptions([
        ...baseOpts,
        '-map 0:v', '-map 1:a',
        '-c:a aac', '-b:a 128k',
      ]);
    } else if (hasMusic) {
      // Background music only — loop fills the full 45 s
      cmd.outputOptions([
        ...baseOpts,
        '-map 0:v', '-map 1:a',
        '-c:a aac', '-b:a 128k',
        '-shortest',
      ]);
    } else {
      // Silent
      cmd.outputOptions(baseOpts);
    }

    cmd
      .output(videoPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  try { unlinkSync(framePath); } catch { /* ignore */ }
  return videoPath;
}
