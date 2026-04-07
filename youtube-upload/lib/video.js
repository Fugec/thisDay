/**
 * Generates a YouTube Shorts MP4 (1080x1920) from a blog post.
 *
 * Background image:
 *   USE_AI_IMAGE=true  → AI-generated via Replicate / CF Workers AI (more cinematic)
 *   USE_AI_IMAGE=false → Wikipedia image from post (default, free)
 *
 * Captions:
 *   When ElevenLabs word timestamps are provided, animated bold captions
 *   (3-word chunks) are burned in with FFmpeg drawtext, synced to the voice.
 *   Caption style: large white bold text + black outline, centred bottom-third.
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

import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateAISceneBatch, enhanceImageWithAI, colorizeImageWithAI } from "./ai-image.js";
import { reviewPromptsWithHistoryExpert } from "./history-expert.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "../tmp");
const W = 1080;
const H = 1920;
/**
 * 2 scenes per video — one cut at ~22s for a 45s total.
 * Images: Pollinations flux-2-dev (free). Animation: WAN 2.2 I2V via HF ZeroGPU
 * (requires HF_TOKEN; falls back to Ken Burns automatically if unavailable).
 */
const N_SCENES = 3;

// Gentle crossfade only — slide/wipe transitions are too jarring for a calm history channel
const XFADE_TRANSITIONS = ["fade", "dissolve", "fade"];

/**
 * Builds an FFmpeg zoompan filter string for a static-image scene (Ken Burns).
 * 6 distinct motion patterns cycled per scene index for maximum visual variety.
 * Input images are pre-scaled to 115% so zoom never reveals black edges.
 *
 * @param {number} sceneIdx   0-based scene index
 * @param {number} durationS  Scene duration in seconds
 * @param {string} inLabel    e.g. "[0:v]"
 * @param {string} outLabel   e.g. "[zp0]"
 * @returns {string}  filter fragment
 */
function buildKenBurns(sceneIdx, durationS, inLabel, outLabel) {
  // Use round (not ceil) so frame count exactly matches the scene duration
  const d = Math.round(durationS * FPS);
  // Per-frame zoom increment for pzoom accumulation — smoother than on/d formula
  const Z_RANGE = 0.10; // 10% total zoom travel (reduced from 12% for less distortion)
  const Z_START = 1.0;
  const Z_END   = (Z_START + Z_RANGE).toFixed(4);   // 1.1000
  const Z_MID   = (Z_START + Z_RANGE / 2).toFixed(4); // 1.0500
  const INC     = (Z_RANGE / d).toFixed(7);          // per-frame increment

  let zoom, x, y;

  switch (sceneIdx % 6) {
    case 0: // zoom-in, anchor centre
      // pzoom accumulates smoothly; clamp at Z_END to avoid overshoot
      zoom = `if(eq(on,0),${Z_START},min(${Z_END},pzoom+${INC}))`;
      x = `iw/2-(iw/zoom/2)`;
      y = `ih/2-(ih/zoom/2)`;
      break;
    case 1: // zoom-out, anchor centre
      zoom = `if(eq(on,0),${Z_END},max(${Z_START},pzoom-${INC}))`;
      x = `iw/2-(iw/zoom/2)`;
      y = `ih/2-(ih/zoom/2)`;
      break;
    case 2: // zoom-in + slow pan up
      zoom = `if(eq(on,0),${Z_START},min(${Z_END},pzoom+${INC}))`;
      x = `iw/2-(iw/zoom/2)`;
      y = `max(0,ih/2-(ih/zoom/2)-ih*0.04*on/${d})`;
      break;
    case 3: // zoom-in + slow pan down
      zoom = `if(eq(on,0),${Z_START},min(${Z_END},pzoom+${INC}))`;
      x = `iw/2-(iw/zoom/2)`;
      y = `min(ih*(1-1/zoom),ih/2-(ih/zoom/2)+ih*0.04*on/${d})`;
      break;
    case 4: // steady mid-zoom, slow pan left
      zoom = `${Z_MID}`;
      x = `max(0,iw*(1-1/zoom)*0.5-iw*0.05*on/${d})`;
      y = `ih/2-(ih/zoom/2)`;
      break;
    case 5: // steady mid-zoom, slow pan right
      zoom = `${Z_MID}`;
      x = `min(iw*(1-1/zoom),iw*(1-1/zoom)*0.5+iw*0.05*on/${d})`;
      y = `ih/2-(ih/zoom/2)`;
      break;
  }
  // setpts resets timestamps so xfade offsets are always relative to stream start.
  // fps=fps=N after zoompan forces a declared constant frame rate so xfade (which
  // requires CFR input) does not reject the stream with "rate of 1/0 is invalid".
  return (
    `${inLabel}zoompan=z='${zoom}':x='${x}':y='${y}'` +
    `:d=${d}:s=${W}x${H}:fps=${FPS},setpts=PTS-STARTPTS,fps=fps=${FPS}${outLabel}`
  );
}

// ---------------------------------------------------------------------------
// Image validation & resolution
// ---------------------------------------------------------------------------

async function isWorkingImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;
    const headers = {
      "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)",
    };
    const timeout = () => AbortSignal.timeout(7000);
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
      signal: timeout(),
    });
    // Some CDNs reject HEAD; fall back to GET
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
        signal: timeout(),
      });
    }
    if (!res.ok) return false;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    return contentType.startsWith("image/");
  } catch {
    return false;
  }
}

async function fetchWikipediaImage(title) {
  if (!title) return null;
  const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
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
      .filter(
        (t) =>
          /\.(jpe?g|png|webp|gif)$/i.test(t) &&
          !/icon|logo|flag|map|seal|coa/i.test(t),
      );

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

/**
 * Fetches multiple real image buffers from Wikipedia/Wikimedia Commons for a topic.
 *
 * Uses actual historical/documentary photos from Wikipedia as-is — no AI generation.
 * Works for person portraits, single objects, events, or any other subject.
 *
 * Strategy:
 *   1. Wikipedia page images — sorted by pixel count (largest first) for best quality
 *   2. Wikimedia Commons search — extra images when the Wikipedia page alone isn't enough
 *
 * @param {string} eventTitle  Event/topic name (date suffix already stripped)
 * @param {number} count       Max images to return (default 2)
 * @returns {Promise<Buffer[]>}
 */
async function fetchWikipediaImageBuffers(eventTitle, count = 2) {
  const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
  const buffers = [];

  // Only skip obvious UI/template images — keep portraits, objects, events
  const BAD =
    /\b(icon|logo|flag|map|seal|stub|arrow|bullet|commons[-_]logo|wikimedia[-_]logo|blank|placeholder)\b/i;

  async function resolveUrls(apiBase, fileTitles) {
    if (!fileTitles.length) return [];
    const piped = fileTitles.slice(0, 12).join("|");
    try {
      const res = await fetch(
        `${apiBase}?action=query&titles=${encodeURIComponent(piped)}&prop=imageinfo&iiprop=url|size&format=json`,
        { headers: ua, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Object.values(data?.query?.pages ?? {})
        .map((p) => ({
          url: p?.imageinfo?.[0]?.url ?? null,
          px: (p?.imageinfo?.[0]?.width ?? 0) * (p?.imageinfo?.[0]?.height ?? 0),
          w: p?.imageinfo?.[0]?.width ?? 0,
          h: p?.imageinfo?.[0]?.height ?? 0,
        }))
        .filter(({ url, w, h }) => url && w >= 800 && h >= 600)
        .sort((a, b) => b.px - a.px) // largest first → best quality
        .map(({ url }) => url);
    } catch {
      return [];
    }
  }

  async function downloadSafe(url) {
    try {
      return await downloadImageBuffer(url);
    } catch {
      return null;
    }
  }

  // 1. Wikipedia page images
  try {
    const listRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(eventTitle)}&prop=images&imlimit=30&format=json`,
      { headers: ua, signal: AbortSignal.timeout(15_000) },
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const page = Object.values(listData?.query?.pages ?? {})[0];
      const candidates = (page?.images ?? [])
        .map((i) => i.title)
        .filter((t) => /\.(jpe?g|png|webp)$/i.test(t) && !BAD.test(t));

      const urls = await resolveUrls("https://en.wikipedia.org/w/api.php", candidates);
      for (const url of urls) {
        if (buffers.length >= count) break;
        const buf = await downloadSafe(url);
        if (buf) buffers.push(buf);
      }
    }
  } catch { /* continue to Commons */ }

  if (buffers.length >= count) return buffers;

  // 2. Wikimedia Commons search — broader pool for less-covered topics
  try {
    const searchRes = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&srsearch=${encodeURIComponent(eventTitle)}&srlimit=20&format=json`,
      { headers: ua, signal: AbortSignal.timeout(15_000) },
    );
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const candidates = (searchData?.query?.search ?? [])
        .map((r) => r.title)
        .filter((t) => /\.(jpe?g|png|webp)$/i.test(t) && !BAD.test(t));

      const urls = await resolveUrls("https://commons.wikimedia.org/w/api.php", candidates);
      for (const url of urls) {
        if (buffers.length >= count) break;
        const buf = await downloadSafe(url);
        if (buf) buffers.push(buf);
      }
    }
  } catch { /* return what we have */ }

  return buffers;
}

// ---------------------------------------------------------------------------
// Image quality & cinematic helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when an image is effectively grayscale (B&W or sepia).
 * Samples a 32×32 thumbnail; if the average per-pixel channel spread is below
 * threshold the image has no meaningful chroma and can benefit from colorization.
 */
async function isGrayscaleBuffer(buffer) {
  try {
    const { data } = await sharp(buffer)
      .resize(32, 32, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let totalDiff = 0;
    const pixels = data.length / 3;
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      totalDiff += Math.abs(r - g) + Math.abs(g - b) + Math.abs(r - b);
    }
    return totalDiff / pixels < 15; // avg channel diff <15 → grayscale
  } catch {
    return false;
  }
}

/**
 * Returns an SVG vignette (dark radial gradient) that can be composited over
 * any image to add a cinematic edge-darkening effect.
 */
function buildVignetteSVG(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <radialGradient id="vig" cx="50%" cy="50%" r="72%" gradientUnits="objectBoundingBox">
        <stop offset="30%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.50"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#vig)"/>
  </svg>`;
}

/**
 * Applies era-appropriate color grading to a Sharp pipeline.
 * Uses the event year extracted from the title to pick a cinematic tone:
 *   pre-1900  → warm sepia (or gentle saturation boost if just colorized)
 *   1900-1939 → muted warm film look
 *   1940-1959 → cool, gritty (WWII / post-war)
 *   1960-1979 → slightly faded Kodachrome warmth
 *   1980+     → punchy, natural
 *
 * @param {object}  sharpInst    A fluent sharp instance
 * @param {number|null} year     Event year, or null for generic boost
 * @param {boolean} wasColorized True if a B&W image was just colorized
 * @returns {object}  The same sharp instance with grading applied
 */
function applyEraGrading(sharpInst, year, wasColorized) {
  if (!year) {
    return sharpInst.modulate({ saturation: 1.05, brightness: 0.98 });
  }
  if (year < 1900) {
    // Likely B&W photography — sepia warmth unless freshly colorized
    return wasColorized
      ? sharpInst.modulate({ saturation: 0.85, brightness: 0.95 })
      : sharpInst.modulate({ saturation: 0.45, brightness: 0.92 }).tint({ r: 112, g: 73, b: 38 });
  }
  if (year < 1940) {
    // Early film era — warm but more neutral than full sepia
    return wasColorized
      ? sharpInst.modulate({ saturation: 0.80, brightness: 0.93 })
      : sharpInst.modulate({ saturation: 0.60, brightness: 0.90 }).tint({ r: 95, g: 85, b: 70 });
  }
  if (year < 1960) {
    // WWII / post-war — cooler, slightly desaturated, gritty
    return sharpInst.modulate({ saturation: 0.78, brightness: 0.90 });
  }
  if (year < 1980) {
    // 1960s-70s Kodachrome — slight warm fade
    return sharpInst.modulate({ saturation: 0.90, brightness: 0.95 }).tint({ r: 100, g: 94, b: 84 });
  }
  // 1980+ — natural with a small saturation/contrast push
  return sharpInst.modulate({ saturation: 1.08, brightness: 1.0 });
}

/**
 * Prepares a Wikipedia image buffer for 9:16 vertical video:
 *   1. AI super-resolution (Real-ESRGAN / Swin2SR — best free model auto-selected)
 *   2. B&W detection → colorization via HF if a colorization model is warm
 *   3. Cover-crop to 1080×1920 + 15% Ken Burns headroom
 *   4. Era-appropriate color grading (warm sepia, cool WWII, punchy modern)
 *   5. Cinematic vignette overlay
 *
 * @param {Buffer}      buffer       Raw image bytes from Wikipedia/Commons
 * @param {number|null} year         Event year for era grading, or null
 * @param {boolean}     aiEnhance    Run AI upscale + colorize (default true). Set false
 *                                   for scene 3+ to cap HF API usage at 2 calls/video.
 * @returns {Promise<Buffer>}   PNG ready for scene compositing
 */
async function prepareWikipediaSceneBuffer(buffer, year = null, aiEnhance = true) {
  const TARGET_W = Math.round(W * 1.15); // 15% larger — Ken Burns headroom
  const TARGET_H = Math.round(H * 1.15);

  // 1. AI super-resolution + colorization (capped at 2 images/video to stay within free tier)
  let wasColorized = false;
  if (aiEnhance) {
    buffer = await enhanceImageWithAI(buffer);

    // 2. B&W detection → colorization
    const bw = await isGrayscaleBuffer(buffer);
    if (bw) {
      console.log("  → B&W image detected — attempting colorization...");
      const colorized = await colorizeImageWithAI(buffer);
      if (colorized) {
        buffer = colorized;
        wasColorized = true;
        console.log("  ✓ Colorized");
      } else {
        console.log("  ℹ Colorization unavailable — keeping original");
      }
    }
  } else {
    console.log("  ℹ Scene 3: skipping AI enhance to stay within free-tier quota");
  }

  // 3. Cover-crop to full 9:16 frame with Ken Burns headroom
  let proc = sharp(buffer)
    .resize(TARGET_W, TARGET_H, { fit: "cover", position: "centre" })
    .sharpen({ sigma: 1.2 });

  // 4. Era color grading
  proc = applyEraGrading(proc, year, wasColorized);

  // 5. Cinematic vignette
  const vignetteBuf = await sharp(Buffer.from(buildVignetteSVG(TARGET_W, TARGET_H)))
    .png()
    .toBuffer();

  return proc
    .composite([{ input: vignetteBuf, blend: "over" }])
    .png()
    .toBuffer();
}

/** URLs that must never be used as a video background image. */
function isPlaceholderImage(url) {
  if (!url) return true;
  const n = url.trim().toLowerCase();
  return (
    n.includes("/images/logo.png") ||
    n.includes("placehold.co") ||
    n.includes("placeholder")
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
  if (
    original &&
    !isPlaceholderImage(original) &&
    (await isWorkingImageUrl(original))
  ) {
    return { imageUrl: original, wasReplaced: false };
  }

  if (original && isPlaceholderImage(original)) {
    console.warn(
      `  ⚠ Image is a placeholder/logo — searching for real image: ${original}`,
    );
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
  const verbPrefixRe =
    /^(The\s+)?(Founding|Birth|Death|Discovery|Invention|Signing|Formation|Establishment|Battle|Siege|Launch|Liberation|Revolution|Treaty|Election|Inauguration|Coronation|Assassination)\s+(of\s+)?(the\s+)?/i;
  const beforeDate = post.title
    .split(/\s*[-–—]\s+(?=[A-Z][a-z]+ \d)/)[0]
    .trim();
  const coreSubject = beforeDate.replace(verbPrefixRe, "").trim();

  const wikiQueries = [
    post.title, // 1. full title (date + year intact)
    beforeDate, // 2. event name, date stripped
    coreSubject, // 3. core subject, prefix + date stripped  (e.g. "Kappa Alpha Society")
  ].filter((q, i, arr) => q && arr.indexOf(q) === i); // deduplicate

  for (const query of wikiQueries) {
    const wikiImage = await fetchWikipediaImage(query);
    if (wikiImage && (await isWorkingImageUrl(wikiImage))) {
      console.log(
        `  ↺ Wikipedia replacement found (query: "${query}"): ${wikiImage}`,
      );
      return { imageUrl: wikiImage, wasReplaced: true };
    }
  }

  // 3. No working image — throw so the caller skips this post rather than
  //    uploading a video with no meaningful background.
  throw new Error(
    `IMAGE_UNAVAILABLE: no working image found for "${post.title}" (original: ${original ?? "none"})`,
  );
}

const DURATION = 45; // seconds — max 45 s
const FPS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapLines(text, maxChars) {
  const words = String(text).split(" ");
  const lines = [];
  let line = "";
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
// SVG overlay builder (static title + branding)
// ---------------------------------------------------------------------------

function buildSVG(title) {
  const titleLines = wrapLines(title, 18).slice(0, 5);

  const titleLineH = 62;
  const titleStartY = 1020;

  const titleSVG = titleLines
    .map(
      (line, i) => `
    <text x="540" y="${titleStartY + i * titleLineH}"
      font-family="DejaVu Sans Bold,DejaVu Sans,Arial Black,sans-serif"
      font-size="46" font-weight="900"
      fill="white" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="4" paint-order="stroke fill"
    >${escapeXml(line)}</text>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#000" stop-opacity="0.08"/>
        <stop offset="48%"  stop-color="#000" stop-opacity="0.68"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.92"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>

    <!-- "ON THIS DAY" label -->
    <text x="540" y="960"
      font-family="DejaVu Sans Bold,DejaVu Sans,Arial Black,sans-serif"
      font-size="48" font-weight="900"
      fill="#9dc43a" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="4" paint-order="stroke fill"
      letter-spacing="10"
    >ON THIS DAY</text>

    ${titleSVG}

    <!-- Branding -->
    <text x="540" y="1868"
      font-family="DejaVu Sans Bold,DejaVu Sans,Arial Black,sans-serif"
      font-size="42" font-weight="900"
      fill="#9dc43a" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="3" paint-order="stroke fill"
    >thisday.info</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Animated caption builder
// ---------------------------------------------------------------------------

/**
 * Groups word timestamps into caption chunks, breaking on sentence boundaries
 * (words ending in . ! ?) first, then falling back to WORDS_PER_CHUNK words.
 * This ensures captions never run a sentence across a chunk boundary.
 *
 * @param {{ word: string, start: number, end: number }[]} words
 * @returns {{ text: string, start: number, end: number }[]}
 */
function buildCaptionChunks(words) {
  if (!words?.length) return [];
  const WORDS_PER_CHUNK = 3;
  const chunks = [];
  let group = [];

  const flush = () => {
    if (!group.length) return;
    chunks.push({
      text: group.map((w) => w.word).join(" "),
      start: group[0].start,
      end: group[group.length - 1].end,
    });
    group = [];
  };

  for (let i = 0; i < words.length; i++) {
    group.push(words[i]);
    const isSentenceEnd = /[.!?]$/.test(words[i].word);
    const isChunkFull = group.length >= WORDS_PER_CHUNK;
    // Break after sentence-ending word, or when chunk is full
    if (isSentenceEnd || isChunkFull) flush();
  }
  flush(); // remaining words
  return chunks;
}

/**
 * Renders one 1080×200 PNG per caption chunk using sharp + SVG.
 * Caption style: uppercase bold white text on a semi-transparent dark pill.
 * Uses FFmpeg's `overlay` filter — no libfreetype required on any platform.
 *
 * @param {{ text: string, start: number, end: number }[]} chunks
 * @param {string} slug  Used to name temp files
 * @returns {Promise<string[]>}  Paths to generated PNG files (same order as chunks)
 */
async function renderCaptionPNGs(chunks, slug) {
  const CAP_H = 140;
  const FONT_SIZE = 42;
  const PAD = 16;
  const paths = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = escapeXml(chunks[i].text.toUpperCase());
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CAP_H}">`,
      // Semi-transparent black pill for readability on any background
      `<rect x="${PAD}" y="${PAD}" width="${W - PAD * 2}" height="${CAP_H - PAD * 2}"`,
      `  rx="18" fill="black" fill-opacity="0.55"/>`,
      // White text with black stroke — centred
      `<text x="${W / 2}" y="${Math.round(CAP_H / 2 + FONT_SIZE * 0.36)}"`,
      `  font-family="DejaVu Sans Bold,Arial Black,sans-serif"`,
      `  font-size="${FONT_SIZE}" font-weight="900"`,
      `  fill="white" text-anchor="middle"`,
      `  stroke="black" stroke-width="4" paint-order="stroke fill"`,
      `>${text}</text>`,
      `</svg>`,
    ].join("\n");
    const p = join(TMP, `${slug}_cap${i}.png`);
    await sharp(Buffer.from(svg)).png().toFile(p);
    paths.push(p);
  }
  return paths;
}

/**
 * Builds an FFmpeg filter_complex fragment that overlays caption PNGs
 * over the input video stream using time-gated `overlay` filters.
 * Works on all platforms — no libfreetype required.
 *
 * @param {{ text: string, start: number, end: number }[]} chunks
 * @param {number} captionStartIdx  FFmpeg input index of the first caption PNG
 * @param {string} inputLabel   e.g. "[0:v]" or "[vscene]"
 * @param {string} outputLabel  e.g. "[vcap]"
 * @returns {string}  filter_complex fragment
 */
function buildOverlayCaptionFilter(
  chunks,
  captionStartIdx,
  inputLabel = "[0:v]",
  outputLabel = "[vcap]",
) {
  if (!chunks.length) return "";
  // Top edge of the 220px caption PNG sits so text visually lands at ~80% height
  const Y_POS = Math.round(H * 0.8) - Math.round(220 * 0.5);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    const inLabel = i === 0 ? inputLabel : `[ov${i - 1}]`;
    const outLabel = i === chunks.length - 1 ? outputLabel : `[ov${i}]`;
    parts.push(
      `${inLabel}[${captionStartIdx + i}:v]` +
        `overlay=x=0:y=${Y_POS}:format=auto` +
        `:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'${outLabel}`,
    );
  }
  return parts.join(";");
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
// AI image prompt builder
// ---------------------------------------------------------------------------

/**
 * Returns period-accurate visual context (clothing, weapons, architecture,
 * technology) for a given year so the AI model renders the correct era.
 * Extracted from the title's date suffix before it is stripped.
 *
 * @param {string} rawTitle  Full title including "— Month DD, YYYY" suffix
 * @returns {{ era: string, style: string }}
 *   era   — human-readable period name used inside the prompt sentence
 *   style — comma-separated descriptor list appended to every scene prompt
 */
function getHistoricalEraContext(rawTitle) {
  const m = rawTitle.match(/\b(\d{4})$/);
  const year = m ? parseInt(m[1], 10) : null;

  if (year === null)
    return {
      era: "historical",
      style:
        "period-accurate clothing, weapons, architecture and technology matching the depicted event",
    };

  if (year < 500)
    return {
      era: "ancient",
      style:
        "Roman or Greek soldiers in lorica segmentata or bronze hoplite armor, " +
        "linen tunics, sandals, gladius swords, spears and round shields, " +
        "marble columns, aqueducts, stone forums, torches for lighting",
    };
  if (year < 1000)
    return {
      era: "early medieval",
      style:
        "chainmail hauberks, conical nasal helmets, kite shields, " +
        "Viking longships, Byzantine mosaics, crude iron weapons, " +
        "thatched-roof timber longhouses, wool tunics and cloaks",
    };
  if (year < 1300)
    return {
      era: "medieval",
      style:
        "knights in chainmail and surcoats, great helms, heater shields, " +
        "arming swords and lances, stone castle battlements, " +
        "peasants in rough woolen tunics, catapults and siege towers, " +
        "Gothic lancet-arched windows, candlelight interiors",
    };
  if (year < 1500)
    return {
      era: "late medieval",
      style:
        "full plate armor, heraldic surcoats, longbowmen with war arrows, " +
        "plate-armored knights on barded warhorses, Gothic cathedrals, " +
        "velvet and fur noble garments, cobblestone market squares, " +
        "hand-illuminated manuscripts, tallow candles",
    };
  if (year < 1700)
    return {
      era: "Renaissance / early modern",
      style:
        "pikemen in morion helmets and breastplates, musketeers with matchlock arquebuses, " +
        "doublets with ruffled collars, galleons with square-rigged sails, " +
        "stone star forts, ornate baroque interiors, flintlock pistols",
    };
  if (year < 1800)
    return {
      era: "18th century",
      style:
        "tricorn hats, powdered wigs, redcoat or blue-coat uniforms with brass buttons, " +
        "flintlock muskets with socket bayonets, horse-drawn field artillery, " +
        "tall-masted sailing warships with cannon gun ports, " +
        "Georgian architecture, oil lanterns",
    };
  if (year < 1860)
    return {
      era: "early 19th century",
      style:
        "Napoleonic shakos or kepi caps, wool frock-coat uniforms, " +
        "percussion-cap rifles, horse-drawn artillery caissons, " +
        "civilian top hats and waistcoats, hoop skirts and bonnets, " +
        "steam locomotives with iron wheels, gas street lamps",
    };
  if (year < 1900)
    return {
      era: "late 19th century",
      style:
        "Victorian frock coats, bustled skirts and corsets, pith helmets, " +
        "bolt-action magazine rifles, Gatling guns, ironclad warships, " +
        "horse-drawn carriages, telegraph poles, cast-iron bridges, " +
        "early incandescent lighting, sepia-toned photographic look",
    };
  if (year < 1920)
    return {
      era: "World War I",
      style:
        "khaki or feldgrau uniforms, flat-topped Brodie or Stahlhelm helmets, " +
        "puttees wrapped around lower legs, bolt-action Lee-Enfield or Gewehr 98 rifles, " +
        "muddy trenches with duckboards and sandbags, barbed-wire entanglements, " +
        "horse cavalry, biplanes, early tank prototypes, artillery craters",
    };
  if (year < 1940)
    return {
      era: "interwar 1920s–30s",
      style:
        "fedoras and double-breasted suits, cloche hats and flapper dresses, " +
        "Model T and early motor cars, art deco architecture, " +
        "early radio broadcasting equipment, propeller aircraft, " +
        "Depression-era breadlines, newsprint typography on storefronts",
    };
  if (year < 1946)
    return {
      era: "World War II",
      style:
        "olive-drab M1 helmet or German Stahlhelm, WWII wool uniforms, " +
        "M1 Garand rifle or Kar98k, Sherman tank or Panzer IV, " +
        "bombed-out rubble buildings, barbed wire and sandbag fortifications, " +
        "period-correct 1940s aircraft — P-51 Mustang or Bf 109, " +
        "Navy vessels with Measure 21 camouflage paint",
    };
  if (year < 1960)
    return {
      era: "1950s Cold War",
      style:
        "conservative 1950s suits with narrow lapels, pencil skirts and cat-eye glasses, " +
        "crew cuts, chrome-bumper American automobiles, early Bakelite television sets, " +
        "Korean War M1 helmets and M1 Garands if military, suburban ranch-style homes, " +
        "drive-in theaters, soda fountain counters",
    };
  if (year < 1970)
    return {
      era: "1960s",
      style:
        "slim-lapel mod suits, miniskirts and go-go boots, beehive hairstyles, " +
        "NASA Apollo-era spacesuits if applicable, M16 rifles and tiger-stripe jungle fatigues for Vietnam, " +
        "muscle cars and Volkswagen Beetles, CRT television sets, rotary telephones, " +
        "early IBM mainframe computers",
    };
  if (year < 1980)
    return {
      era: "1970s",
      style:
        "wide-lapel leisure suits, bell-bottom trousers, earth-tone polyester, " +
        "afros and long feathered hair, 8-track tape players, " +
        "Vietnam-era or Cold War military gear, early home video cameras, " +
        "disco-era neon signage, wood-paneled station wagons",
    };
  if (year < 1990)
    return {
      era: "1980s",
      style:
        "power shoulders and neon colors, parachute pants and leg warmers, " +
        "Sony Walkman cassette players, Cold War-era M16A2 rifles and MILES gear, " +
        "early Apple Macintosh computers, VHS video cassettes, " +
        "MTV-era aesthetics, boxy sedans and hatchbacks",
    };
  if (year < 2000)
    return {
      era: "1990s",
      style:
        "grunge flannel shirts and Doc Martens, baggy jeans and pagers, " +
        "early brick mobile phones, CD players and cassette Walkmans, " +
        "post-Cold War ACU or woodland camouflage military uniforms, " +
        "CRT monitors and early World Wide Web browsers",
    };
  if (year < 2010)
    return {
      era: "early 2000s",
      style:
        "low-rise jeans and Von Dutch trucker hats, flip phones and early iPods, " +
        "post-9/11 ACU camouflage with MOLLE vests and Interceptor body armor, " +
        "early flat-screen televisions, SUVs with chrome rims",
    };
  return {
    era: "contemporary",
    style:
      "modern urban clothing, smartphones and tablets, contemporary architecture, " +
      "modern military MultiCam or Crye Precision gear if applicable, " +
      "electric vehicles, LED lighting, high-rise glass buildings",
  };
}

// ---------------------------------------------------------------------------
// Multi-scene helpers (AI image mode)
// ---------------------------------------------------------------------------

/**
 * Extracts a person's name from the title if the article is about a person.
 * Looks for patterns like "Nikola Tesla — January 9, 1943" or "Ada Lovelace — November 27, 1852"
 * Returns null if no person detected.
 */
function extractPersonName(title) {
  // Pattern: "Name — Date" or "Name - Date" or "Name, Date"
  const match = title.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+?)\s*[—–-]\s*[,]?\s*\w+ \d{1,2},?\s*\d{4}$/);
  if (match) return match[1];
  // Also handle titles like "Nikola Tesla — 1943"
  const simpleMatch = title.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+?)\s*[—–-]\s*\d{4}$/);
  if (simpleMatch) return simpleMatch[1];
  return null;
}

/**
 * Builds 3 distinct cinematic AI image prompts — one per narration section,
 * each anchored to the correct historical period (clothing, weapons, architecture).
 *
 *   Scene 1 — epic wide establishing shot of the event location / forces
 *   Scene 2 — human-focused action or crowd moment at the peak of the event
 *   Scene 3 — decisive aftermath or legacy: ruins, monuments, environment
 *
 * Reducing from 5 → 3 keeps HuggingFace FLUX usage well within the free tier
 * and leaves Zero GPU headroom for future WAN 2.2 I2V animation (3 clips ≈ 2.5 min/day).
 *
 * @param {string} title
 * @param {string[]|null} contentItems  DYK bullets / Quick Facts rows
 * @param {string|null}   qualityHint   Remediation directive from a failed quality check
 * @returns {string[]}  3 prompts
 */
function buildScenePrompts(title, contentItems, qualityHint = null) {
  const { era, style } = getHistoricalEraContext(title);
  const event = title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const facts = (contentItems || []).map((f) => (f || "").slice(0, 120));

  // Detect if this is an article about a specific person
  const person = extractPersonName(title);

  // Append remediation hint from a previous failed quality check so the retry
  // produces visually different output (e.g. "sharper lighting, richer detail")
  const hint = qualityHint ? `, ${qualityHint}` : "";

  // If article is about a person, ensure they appear in the images
  const personGuidance = person
    ? `IMPORTANT: This image MUST feature ${person} as the main subject, dressed in ${era}-appropriate clothing. The historical figure must be clearly recognizable.`
    : "";

  const base =
    `ultra-realistic ${era} scene, photorealistic painting or photograph, ` +
    `${style}` + hint + `, ` +
    `vertical 9:16 portrait format, anatomically correct, no text, no logos, no watermarks` +
    (personGuidance ? ` ${personGuidance}` : "");

  const allPrompts = [
    // Scene 1 — wide establishing shot: location, scale, atmosphere
    `${base}. ` +
      `Wide establishing shot of ${event}. ` +
      `Epic monumental scale, panoramic landscape or cityscape, ` +
      `dramatic golden hour or storm-lit overcast sky, full environment visible, sharp detail.`,

    // Scene 2 — human moment: people, action, authentic period gear
    `${base}. ` +
      `Wide-angle group shot of soldiers, civilians or key participants during ${event}. ` +
      `${facts[0] ? facts[0] + ". " : ""}` +
      `Full figures visible showing ${era}-accurate clothing and equipment, ` +
      `candid documentary tension, natural dramatic lighting, gritty authentic texture.`,

    // Scene 3 — aftermath / legacy / decisive environment
    `${base}. ` +
      `Immediate aftermath or lasting legacy of ${event}. ` +
      `${facts[1] ? facts[1] + ". " : ""}` +
      `Wide documentary shot: ruins, monuments or transformed landscape, ` +
      `raw consequence visible, reflective poignant light, no isolated close-up faces.`,
  ];
  return allPrompts.slice(0, N_SCENES);
}

/**
 * Finds N_SCENES-1 scene boundary timestamps from ElevenLabs word data.
 * Tries to anchor one cut at the "Did you know?" boundary (narration structure),
 * then distributes the remaining cuts evenly before and after it.
 * Falls back to equal spacing when no timestamps are available.
 *
 * @param {{ word: string, start: number, end: number }[]} words
 * @param {string[]|null} narrationParts  from buildNarrationParts()
 * @returns {number[]}  N_SCENES-1 cut timestamps in seconds
 */
function findSceneBoundaries(words, narrationParts) {
  const numCuts = N_SCENES - 1;
  if (!words?.length) {
    return Array.from(
      { length: numCuts },
      (_, i) => (DURATION / N_SCENES) * (i + 1),
    );
  }
  const totalDur = words[words.length - 1]?.end ?? DURATION;
  const clamp = (t) => Math.min(Math.max(t, 2), totalDur - 2);

  // Try to anchor one cut at the "Did you know?" phrase
  let dykTime = null;
  if (narrationParts?.some((p) => p.toLowerCase().startsWith("did you know"))) {
    const minIdx = Math.floor(words.length * 0.15);
    const maxIdx = Math.floor(words.length * 0.7);
    for (let i = minIdx; i < maxIdx; i++) {
      if (
        words[i].word?.toLowerCase() === "did" &&
        words[i + 1]?.word?.toLowerCase() === "you"
      ) {
        dykTime = Math.max(3, words[i].start);
        break;
      }
    }
  }

  if (dykTime !== null) {
    // Distribute cuts: some before DYK, DYK itself, rest after
    const preDyk = Math.max(
      0,
      Math.round((numCuts - 1) * (dykTime / totalDur)),
    );
    const postDyk = numCuts - 1 - preDyk;
    const result = [];
    for (let i = 1; i <= preDyk; i++)
      result.push(clamp((dykTime / (preDyk + 1)) * i));
    result.push(clamp(dykTime));
    for (let i = 1; i <= postDyk; i++)
      result.push(clamp(dykTime + ((totalDur - dykTime) / (postDyk + 1)) * i));
    return result;
  }

  // Default: evenly spaced
  return Array.from({ length: numCuts }, (_, i) =>
    clamp((totalDur / N_SCENES) * (i + 1)),
  );
}

/**
 * Multi-scene video: N_SCENES AI images crossfaded at narration section
 * boundaries, with animated captions burned in synced to the ElevenLabs voice.
 *
 * @param {object} post
 * @param {{ narrationPath, bgMusicPath, words, contentItems, narrationParts, videoPath }} opts
// ---------------------------------------------------------------------------
// End screen PNG builder (last 3 seconds of video)
// ---------------------------------------------------------------------------

/**
 * Renders a 1080×300 semi-transparent end-screen overlay PNG using sharp.
 * Shown for the last 3 seconds of the video — encourages follows/visits.
 *
 * @returns {Promise<Buffer>}
 */
async function buildEndScreenPNG() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="300">
    <rect width="${W}" height="300" fill="black" fill-opacity="0.72" rx="0"/>
    <text x="${W / 2}" y="110"
      font-family="DejaVu Sans Bold,Arial Black,sans-serif"
      font-size="52" font-weight="900"
      fill="white" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="3" paint-order="stroke fill"
    >Follow for daily history</text>
    <text x="${W / 2}" y="195"
      font-family="DejaVu Sans Bold,Arial Black,sans-serif"
      font-size="44" font-weight="900"
      fill="#9dc43a" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="3" paint-order="stroke fill"
    >thisday.info</text>
    <text x="${W / 2}" y="263"
      font-family="DejaVu Sans,Arial,sans-serif"
      font-size="30" font-weight="400"
      fill="#cbd5e1" text-anchor="middle" dominant-baseline="middle"
    >New history every day.</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function generateMultiSceneVideo(
  post,
  {
    narrationPath,
    bgMusicPath,
    words,
    contentItems,
    narrationParts,
    videoPath,
    qualityHint = null,
  },
) {
  const { slug, title } = post;
  const XF = 1.2; // crossfade duration in seconds — longer = gentler on the eyes

  // Compute actual video duration from narration end + 3 s tail,
  // capped at the 45 s max. Falls back to DURATION when no timestamps.
  const narrEnd = words?.length > 0 ? words[words.length - 1].end : null;
  const videoDuration = narrEnd
    ? Math.max(Math.min(Math.ceil(narrEnd) + 3, DURATION), 10)
    : DURATION;
  console.log(
    narrEnd
      ? `  Video duration: ${videoDuration} s (narration ${narrEnd.toFixed(1)} s + 3 s tail)`
      : `  Video duration: ${videoDuration} s (default — no word timestamps)`,
  );

  // 1. Fetch real Wikipedia/Commons images — no AI generation unless necessary
  const event = title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const yearMatch = title.match(/\b(\d{4})$/);
  const eventYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
  console.log(`  Fetching ${N_SCENES} real Wikipedia images for "${event}"...`);
  const wikiBuffers = await fetchWikipediaImageBuffers(event, N_SCENES);

  let rawScenes;
  if (wikiBuffers.length >= N_SCENES) {
    console.log(`  ✓ Using ${N_SCENES} real Wikipedia/Commons images — skipping AI generation`);
    const MAX_AI_ENHANCE = 2; // cap HF API calls per video — free tier stays healthy
    const prepared = await Promise.all(
      wikiBuffers.slice(0, N_SCENES).map((buf, i) => prepareWikipediaSceneBuffer(buf, eventYear, i < MAX_AI_ENHANCE)),
    );
    rawScenes = prepared.map((buf) => ({ buffer: buf, isVideo: false }));
  } else {
    const aiCount = N_SCENES - wikiBuffers.length;
    if (wikiBuffers.length > 0) {
      console.log(`  Got ${wikiBuffers.length}/${N_SCENES} Wikipedia images — AI generating ${aiCount} more`);
    } else {
      console.log(`  No Wikipedia images found — generating ${N_SCENES} AI scenes`);
    }

    const { era } = getHistoricalEraContext(title);

    const rawPrompts = buildScenePrompts(title, contentItems, qualityHint);
    const scenePrompts = await reviewPromptsWithHistoryExpert(event, eventYear, era, rawPrompts);
    const aiScenes = await generateAISceneBatch(scenePrompts.slice(0, aiCount), event);

    const MAX_AI_ENHANCE = 2;
    const preparedWiki = await Promise.all(
      wikiBuffers.map((buf, i) => prepareWikipediaSceneBuffer(buf, eventYear, i < MAX_AI_ENHANCE)),
    );
    rawScenes = [
      ...preparedWiki.map((buf) => ({ buffer: buf, isVideo: false })),
      ...aiScenes,
    ];
  }

  // Fallback for any null slots
  const fallbackBuf = post.imageUrl
    ? await downloadImageBuffer(post.imageUrl).catch(() => null)
    : null;
  const scenes = rawScenes.map((scene, i) => {
    if (scene) return scene;
    console.warn(`  ⚠ Scene ${i + 1} failed — using fallback image`);
    return fallbackBuf ? { buffer: fallbackBuf, isVideo: false } : null;
  });
  if (scenes.some((s) => !s)) {
    throw new Error(
      "generateMultiSceneVideo: could not acquire images for all scenes",
    );
  }

  const videoScenes = scenes.filter((s) => s.isVideo).length;
  const imageScenes = scenes.filter((s) => !s.isVideo).length;
  console.log(
    `  Scenes ready: ${videoScenes} animated (WAN I2V), ${imageScenes} static (Ken Burns)`,
  );

  // 2. Find N_SCENES-1 scene boundary timestamps
  const cuts = findSceneBoundaries(words, narrationParts);
  const cutLog = [0, ...cuts, videoDuration]
    .map((t, i, arr) =>
      i < arr.length - 1 ? `${t.toFixed(1)}–${arr[i + 1].toFixed(1)}s` : null,
    )
    .filter(Boolean)
    .join(" · ");
  console.log(`  Scene cuts: ${cutLog}`);

  // Per-scene input durations so each scene covers its segment + half-XF overlap
  const sceneDurations = cuts.map((t, i) =>
    i === 0 ? t + XF / 2 : t - cuts[i - 1] + XF,
  );
  sceneDurations.push(videoDuration - cuts[cuts.length - 1] + XF / 2);

  // 3. Write scene files — video clips saved as .mp4, static images resized to
  //    115% of target (zoompan headroom) and composited with the SVG title overlay.
  const KB_PAD = 1.15; // 15% larger than W×H so 12% zoom never crops to black
  const sceneFiles = []; // { path, isVideo }
  let thumbnailPath = null;
  for (let i = 0; i < scenes.length; i++) {
    const { buffer, isVideo } = scenes[i];
    if (isVideo) {
      const clipPath = join(TMP, `${slug}_s${i}.mp4`);
      writeFileSync(clipPath, buffer);
      sceneFiles.push({ path: clipPath, isVideo: true });
      console.log(`  ✓ Scene ${i + 1} animated clip ready`);
    } else {
      const framePath = join(TMP, `${slug}_s${i}.png`);
      const resized = sharp(buffer).resize(Math.round(W * KB_PAD), Math.round(H * KB_PAD), {
        fit: "cover",
        position: "center",
      });
      // Title overlay only on scene 1 — after "Did you know?" the image takes centre stage
      if (i === 0) {
        await resized
          .composite([
            {
              input: await sharp(Buffer.from(buildSVG(title)))
                .resize(Math.round(W * KB_PAD), Math.round(H * KB_PAD))
                .png()
                .toBuffer(),
              blend: "over",
            },
          ])
          .png()
          .toFile(framePath);
      } else {
        await resized.png().toFile(framePath);
      }
      sceneFiles.push({ path: framePath, isVideo: false });
      console.log(`  ✓ Scene ${i + 1} frame ready${i === 0 ? " (with title overlay)" : " (clean)"}`);

      // Save scene 0 as the custom thumbnail at exact 1080×1920
      if (i === 0) {
        thumbnailPath = join(TMP, `${slug}_thumb.jpg`);
        await sharp(framePath)
          .resize(W, H, { fit: "cover", position: "centre" })
          .jpeg({ quality: 92 })
          .toFile(thumbnailPath);
      }
    }
  }

  // 4. FFmpeg: dynamic xfade chain + animated captions + end screen + audio
  const captionChunks = buildCaptionChunks(words);
  const captionPNGPaths = captionChunks.length
    ? await renderCaptionPNGs(captionChunks, slug)
    : [];
  const hasCaptions = captionPNGPaths.length > 0;
  console.log(
    hasCaptions
      ? `  Captions: ${captionChunks.length} chunks from ${words.length} words`
      : "  Captions: none (no word timestamps)",
  );

  // Render end screen PNG (always shown in last 3 seconds)
  const endScreenPath = join(TMP, `${slug}_end.png`);
  await sharp(await buildEndScreenPNG()).toFile(endScreenPath);

  try {
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();

      // Add scene inputs — video clips loop, static images freeze
    for (let i = 0; i < sceneFiles.length; i++) {
      const { path, isVideo } = sceneFiles[i];
      if (isVideo) {
        // stream_loop repeats the clip; -t trims to exact scene duration
        cmd.input(path).inputOptions(["-stream_loop -1", `-t ${sceneDurations[i]}`]);
      } else {
        // -r must match FPS so zoompan reads at the same rate it outputs —
        // without this the input defaults to 25 fps, causing frame duplication stuttering.
        // Note: -framerate was removed as a general input option in ffmpeg 7.x; use -r instead.
        cmd.input(path).inputOptions(["-loop 1", `-r ${FPS}`, `-t ${sceneDurations[i]}`]);
      }
    }

    const hasNarr = !!narrationPath;
    const hasMusic = !!bgMusicPath;
    const narrIdx = sceneFiles.length;
    const musicIdx =
      hasNarr && hasMusic ? sceneFiles.length + 1 : sceneFiles.length;
    if (hasNarr) cmd.input(narrationPath);
    if (hasMusic) cmd.input(bgMusicPath).inputOptions(["-stream_loop -1"]);

    // Caption PNGs then end screen PNG (indices must be stable)
    const captionStartIdx =
      sceneFiles.length + (hasNarr ? 1 : 0) + (hasMusic ? 1 : 0);
    captionPNGPaths.forEach((p) => cmd.input(p));
    const endScreenIdx = captionStartIdx + captionPNGPaths.length;
    cmd.input(endScreenPath);

    // Per-scene filter: Ken Burns for static images, fps+loop for video clips
    const sceneParts = sceneFiles.map(({ isVideo }, i) => {
      if (isVideo) {
        // Normalise to target FPS; stream_loop handles duration via -t above
        return `[${i}:v]fps=fps=${FPS},setpts=PTS-STARTPTS[v${i}]`;
      }
      return buildKenBurns(i, sceneDurations[i], `[${i}:v]`, `[v${i}]`);
    });
    const scenePartFilter = sceneParts.join(";");

    // Xfade chain with varied transitions
    let xfadeChain = "";
    cuts.forEach((t, i) => {
      const inLabel = i === 0 ? "[v0]" : `[x${i - 1}]`;
      const outLabel = i === cuts.length - 1 ? "[vscene]" : `[x${i}]`;
      const xfOff = (t - XF / 2).toFixed(3);
      const transition = XFADE_TRANSITIONS[i % XFADE_TRANSITIONS.length];
      xfadeChain += `;${inLabel}[v${i + 1}]xfade=transition=${transition}:duration=${XF}:offset=${xfOff}${outLabel}`;
    });
    const sceneFilter = scenePartFilter + xfadeChain;

    // Caption overlay chain
    const afterCaptionLabel = hasCaptions ? "[vcap]" : "[vscene]";
    const captionPart = hasCaptions
      ? ";" +
        buildOverlayCaptionFilter(
          captionChunks,
          captionStartIdx,
          "[vscene]",
          "[vcap]",
        )
      : "";

    // End screen overlay — centred vertically in the bottom 300px, last 3s
    const endY = H - 300;
    const endStart = videoDuration - 3;
    const endScreenPart =
      `;${afterCaptionLabel}[${endScreenIdx}:v]` +
      `overlay=x=0:y=${endY}:format=auto` +
      `:enable='between(t,${endStart},${videoDuration})'[vfinal]`;

    const videoFinalLabel = "[vfinal]";

    let audioFilter = "";
    if (hasNarr && hasMusic) {
      audioFilter = `;[${musicIdx}:a]volume=0.15[bg];[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`;
    }

    cmd.complexFilter(sceneFilter + captionPart + endScreenPart + audioFilter);

    const baseOpts = [
      "-c:v libx264",
      `-t ${videoDuration}`,
      "-pix_fmt yuv420p",
      `-r ${FPS}`,
      "-movflags +faststart",
      `-map ${videoFinalLabel}`,
    ];
    if (hasNarr && hasMusic) {
      cmd.outputOptions([...baseOpts, "-map [a]", "-c:a aac", "-b:a 128k"]);
    } else if (hasNarr) {
      cmd.outputOptions([
        ...baseOpts,
        `-map ${narrIdx}:a`,
        "-c:a aac",
        "-b:a 128k",
      ]);
    } else if (hasMusic) {
      cmd.outputOptions([
        ...baseOpts,
        `-map ${musicIdx}:a`,
        "-c:a aac",
        "-b:a 128k",
        "-shortest",
      ]);
    } else {
      cmd.outputOptions(baseOpts);
    }
    const stderrLines = [];
    cmd
      .output(videoPath)
      .on("stderr", (line) => stderrLines.push(line))
      .on("end", resolve)
      .on("error", (err) =>
        reject(
          new Error(
            `${err.message}\nFFmpeg stderr (last 40 lines):\n${stderrLines.slice(-40).join("\n")}`,
          ),
        ),
      )
      .run();
  });
  } finally {
    [...sceneFiles.map((s) => s.path), ...captionPNGPaths, endScreenPath].forEach((p) => {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    });
  }
  return { path: videoPath, cuts, thumbnailPath };
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
 *   words?:         { word: string, start: number, end: number }[],  Caption timestamps
 *   useAiImage?:    boolean,      Use AI-generated background instead of Wikipedia image
 * }} [opts]
 * @returns {Promise<{ path: string, cuts: number[] }>} path to the MP4 and scene cut timestamps
 */
export async function generateVideo(
  post,
  {
    narrationPath,
    bgMusicPath,
    words = [],
    useAiImage = false,
    contentItems = null,
    narrationParts = null,
    qualityHint = null, // remediation directive from a failed quality check
  } = {},
) {
  mkdirSync(TMP, { recursive: true });

  const { slug, title } = post;
  const framePath = join(TMP, `${slug}_frame.png`);
  const videoPath = join(TMP, `${slug}.mp4`);

  // Multi-scene: 3 AI images crossfaded at narration-timed boundaries
  if (useAiImage) {
    return generateMultiSceneVideo(post, {
      narrationPath,
      bgMusicPath,
      words,
      contentItems,
      narrationParts,
      videoPath,
      qualityHint,
    });
  }

  // Single-scene: Wikipedia image as static background
  // Compute duration from narration end + 3 s tail (same logic as multi-scene)
  const narrEnd = words?.length > 0 ? words[words.length - 1].end : null;
  const videoDuration = narrEnd
    ? Math.max(Math.min(Math.ceil(narrEnd) + 3, DURATION), 10)
    : DURATION;
  console.log(
    narrEnd
      ? `  Video duration: ${videoDuration} s (narration ${narrEnd.toFixed(1)} s + 3 s tail)`
      : `  Video duration: ${videoDuration} s (default — no word timestamps)`,
  );

  const imageUrl = post.imageUrl;
  if (!imageUrl)
    throw new Error(
      `generateVideo called without a validated imageUrl for "${slug}"`,
    );
  const imgBuffer = await downloadImageBuffer(imageUrl);

  // 2. Resize + SVG overlay → PNG frame
  const svgBuffer = Buffer.from(buildSVG(title));
  await sharp(imgBuffer)
    .resize(W, H, { fit: "cover", position: "center" })
    .composite([{ input: svgBuffer, blend: "over" }])
    .png()
    .toFile(framePath);

  // 3. Build animated captions using sharp PNG overlay (no libfreetype needed)
  const captionChunks = buildCaptionChunks(words);
  const captionPNGPaths = captionChunks.length
    ? await renderCaptionPNGs(captionChunks, slug)
    : [];
  const hasCaptions = captionPNGPaths.length > 0;
  console.log(
    hasCaptions
      ? `  Captions: ${captionChunks.length} chunks from ${words.length} word timestamps`
      : "  Captions: none (no word timestamps)",
  );

  // 4. Encode PNG frame → 45-second MP4
  //    Audio strategy:
  //      narration + music  → amix (narration 100%, music 15%)
  //      narration only     → narration track, video pads to 45 s silently
  //      music only         → music looped at full volume for 45 s
  //      no audio           → silent video
  try {
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg().input(framePath).inputOptions(["-loop 1"]); // input 0 — image

    const hasNarr = !!narrationPath;
    const hasMusic = !!bgMusicPath;

    // Add audio inputs in fixed order: narration=1, music=2 (when both present)
    if (hasNarr) cmd.input(narrationPath);
    if (hasMusic) cmd.input(bgMusicPath).inputOptions(["-stream_loop -1"]);

    const musicIdx = hasNarr && hasMusic ? 2 : 1;
    const narrIdx = 1;
    const captionStartIdx = 1 + (hasNarr ? 1 : 0) + (hasMusic ? 1 : 0);
    captionPNGPaths.forEach((p) => cmd.input(p));

    const baseOpts = [
      "-c:v libx264",
      `-t ${videoDuration}`,
      "-pix_fmt yuv420p",
      `-r ${FPS}`,
      "-movflags +faststart",
    ];

    if (hasCaptions) {
      // Overlay caption PNGs with time-gated enable — no libfreetype needed
      const captionFilter = buildOverlayCaptionFilter(
        captionChunks,
        captionStartIdx,
        "[0:v]",
        "[vcap]",
      );
      const videoMapLabel = "[vcap]";

      if (hasNarr && hasMusic) {
        cmd
          .complexFilter(
            `${captionFilter};` +
              `[${musicIdx}:a]volume=0.15[bg];` +
              `[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`,
          )
          .outputOptions([
            ...baseOpts,
            `-map ${videoMapLabel}`,
            "-map [a]",
            "-c:a aac",
            "-b:a 128k",
          ]);
      } else if (hasNarr) {
        cmd
          .complexFilter(captionFilter)
          .outputOptions([
            ...baseOpts,
            `-map ${videoMapLabel}`,
            `-map ${narrIdx}:a`,
            "-c:a aac",
            "-b:a 128k",
          ]);
      } else if (hasMusic) {
        cmd
          .complexFilter(captionFilter)
          .outputOptions([
            ...baseOpts,
            `-map ${videoMapLabel}`,
            `-map ${narrIdx}:a`,
            "-c:a aac",
            "-b:a 128k",
            "-shortest",
          ]);
      } else {
        cmd
          .complexFilter(captionFilter)
          .outputOptions([...baseOpts, `-map ${videoMapLabel}`]);
      }
    } else {
      // No captions — original simple path
      if (hasNarr && hasMusic) {
        cmd
          .complexFilter(
            `[${musicIdx}:a]volume=0.15[bg];` +
              `[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`,
          )
          .outputOptions([
            ...baseOpts,
            "-map 0:v",
            "-map [a]",
            "-c:a aac",
            "-b:a 128k",
          ]);
      } else if (hasNarr) {
        cmd.outputOptions([
          ...baseOpts,
          "-map 0:v",
          "-map 1:a",
          "-c:a aac",
          "-b:a 128k",
        ]);
      } else if (hasMusic) {
        cmd.outputOptions([
          ...baseOpts,
          "-map 0:v",
          "-map 1:a",
          "-c:a aac",
          "-b:a 128k",
          "-shortest",
        ]);
      } else {
        cmd.outputOptions(baseOpts);
      }
    }

    const stderrLines2 = [];
    cmd
      .output(videoPath)
      .on("stderr", (line) => stderrLines2.push(line))
      .on("end", resolve)
      .on("error", (err) =>
        reject(
          new Error(
            `${err.message}\nFFmpeg stderr (last 40 lines):\n${stderrLines2.slice(-40).join("\n")}`,
          ),
        ),
      )
      .run();
  });
  } finally {
    [...captionPNGPaths, framePath].forEach((p) => {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    });
  }
  return { path: videoPath, cuts: [] };
}
