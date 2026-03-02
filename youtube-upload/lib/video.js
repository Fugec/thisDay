/**
 * Generates a YouTube Shorts MP4 (1080x1920) from a blog post.
 *
 * Pipeline:
 *   1. Download the post's Wikipedia image
 *   2. Resize + crop to fill 1080x1920
 *   3. Composite an SVG text overlay (title, description, branding)
 *   4. Encode the static frame into a 45-second MP4 via FFmpeg
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
const DURATION = 45; // seconds — within YouTube Shorts 60s limit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function buildSVG(title, description) {
  const titleLines = wrapLines(title, 28).slice(0, 3);
  const descLines  = wrapLines(description, 42).slice(0, 5);

  const titleLineH  = 82;
  const titleStartY = 1080;
  const descLineH   = 56;
  const descStartY  = titleStartY + titleLines.length * titleLineH + 56;

  const titleSVG = titleLines.map((line, i) => `
    <text x="540" y="${titleStartY + i * titleLineH}"
      font-family="DejaVu Sans,Arial,sans-serif" font-size="68" font-weight="bold"
      fill="white" text-anchor="middle" dominant-baseline="middle"
    >${escapeXml(line)}</text>`).join('');

  const descSVG = descLines.map((line, i) => `
    <text x="540" y="${descStartY + i * descLineH}"
      font-family="DejaVu Sans,Arial,sans-serif" font-size="42"
      fill="#e2e8f0" text-anchor="middle" dominant-baseline="middle"
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
    ${descSVG}

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
 * @returns {Promise<string>} absolute path to the MP4
 */
export async function generateVideo(post) {
  mkdirSync(TMP, { recursive: true });

  const { slug, title, description, imageUrl } = post;
  const framePath = join(TMP, `${slug}_frame.png`);
  const videoPath = join(TMP, `${slug}.mp4`);

  // 1. Download image
  const imgBuffer = await downloadImageBuffer(imageUrl);

  // 2. Resize + composite SVG overlay
  const svgBuffer = Buffer.from(buildSVG(title, description));

  await sharp(imgBuffer)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .composite([{ input: svgBuffer, blend: 'over' }])
    .png()
    .toFile(framePath);

  // 3. Encode static frame → 45-second MP4
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions(['-loop 1'])
      .outputOptions([
        '-c:v libx264',
        `-t ${DURATION}`,
        '-pix_fmt yuv420p',
        '-r 30',
        '-movflags +faststart',
      ])
      .output(videoPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // Clean up the intermediate frame PNG
  try { unlinkSync(framePath); } catch { /* ignore */ }

  return videoPath;
}
