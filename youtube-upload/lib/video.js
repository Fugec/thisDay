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
 * @param {{
 *   narrationPath?: string|null,  ElevenLabs TTS audio — played once at 100% volume
 *   bgMusicPath?:   string|null,  Background music — looped at 15% volume
 * }} [opts]
 * @returns {Promise<string>} path to the MP4
 */
export async function generateVideo(post, { narrationPath, bgMusicPath } = {}) {
  mkdirSync(TMP, { recursive: true });

  const { slug, title, description } = post;
  const imageUrl   = post.imageUrl || 'https://thisday.info/images/logo.png';
  const framePath  = join(TMP, `${slug}_frame.png`);
  const videoPath  = join(TMP, `${slug}.mp4`);

  // 1. Download + resize Wikipedia image → PNG frame with SVG overlay
  const imgBuffer = await downloadImageBuffer(imageUrl);
  const svgBuffer = Buffer.from(buildSVG(title, description));

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
