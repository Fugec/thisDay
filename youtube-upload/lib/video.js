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
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { generateAIImageBatch } from "./ai-image.js";

const TMP = "./tmp";
const W = 1080;
const H = 1920;
/** Number of AI-generated scenes per video. HuggingFace free tier: ~1000/day. */
const N_SCENES = 5;

/**
 * Builds an FFmpeg zoompan filter string for a single scene (Ken Burns effect).
 * Alternates between slow zoom-in, zoom-out, and subtle pan per scene index
 * so consecutive scenes feel visually distinct.
 *
 * @param {number} sceneIdx   0-based scene index
 * @param {number} durationS  Scene duration in seconds
 * @param {string} inLabel    e.g. "[0:v]"
 * @param {string} outLabel   e.g. "[zp0]"
 * @returns {string}  filter fragment
 */
function buildKenBurns(sceneIdx, durationS, inLabel, outLabel) {
  const totalFrames = Math.ceil(durationS * FPS);
  const d = totalFrames;
  // Zoom from 1.0→1.0 on a 110%-sized source effectively gives us
  // natural zoom headroom. zoompan output is always W×H.
  const Z_START = 1.0;
  const Z_END = 1.06;
  let zoom, x, y;
  switch (sceneIdx % 4) {
    case 0: // slow zoom-in, anchor centre
      zoom = `${Z_START}+(${Z_END}-${Z_START})*on/${d}`;
      x = `iw/2-(iw/zoom/2)`;
      y = `ih/2-(ih/zoom/2)`;
      break;
    case 1: // slow zoom-out, anchor centre
      zoom = `${Z_END}-(${Z_END}-${Z_START})*on/${d}`;
      x = `iw/2-(iw/zoom/2)`;
      y = `ih/2-(ih/zoom/2)`;
      break;
    case 2: // zoom-in, drift upward
      zoom = `${Z_START}+(${Z_END}-${Z_START})*on/${d}`;
      x = `iw/2-(iw/zoom/2)`;
      y = `max(0,(ih/2-(ih/zoom/2))*(1-on/${d}*0.05))`;
      break;
    case 3: // zoom-in, drift right
      zoom = `${Z_START}+(${Z_END}-${Z_START})*on/${d}`;
      x = `max(0,(iw/2-(iw/zoom/2))*(1+on/${d}*0.04))`;
      y = `ih/2-(ih/zoom/2)`;
      break;
  }
  return (
    `${inLabel}zoompan=z='${zoom}':x='${x}':y='${y}'` +
    `:d=${d}:s=${W}x${H}:fps=${FPS}${outLabel}`
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

const DURATION = 45; // seconds — within YouTube Shorts 60 s limit
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
      fill="#60a5fa" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="4" paint-order="stroke fill"
      letter-spacing="10"
    >ON THIS DAY</text>

    ${titleSVG}

    <!-- Branding -->
    <text x="540" y="1868"
      font-family="DejaVu Sans Bold,DejaVu Sans,Arial Black,sans-serif"
      font-size="42" font-weight="900"
      fill="#60a5fa" text-anchor="middle" dominant-baseline="middle"
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
 * Builds a cinematic Shorts prompt from the post title.
 * Strips the date suffix (e.g. "— March 19, 2003") before sending to the model.
 */
function buildAiImagePrompt(title) {
  const event = title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  return (
    `Cinematic dramatic historical photograph of ${event}. ` +
    `Epic wide shot, golden hour or dramatic overcast lighting, ` +
    `high detail, photorealistic, award-winning documentary photography, ` +
    `vertical 9:16 portrait format, no text, no logos.`
  );
}

// ---------------------------------------------------------------------------
// Multi-scene helpers (AI image mode)
// ---------------------------------------------------------------------------

/**
 * Builds 3 distinct cinematic AI image prompts — one per narration section:
 *   Scene 1 — wide establishing shot of the historical event
 *   Scene 2 — intense key moment drawn from the first DYK fact
 *   Scene 3 — aftermath, legacy, or reflective close-up
 *
 * @param {string} title
 * @param {string[]|null} contentItems  DYK bullets / Quick Facts rows
 * @returns {string[]}  3 prompts
 */
function buildScenePrompts(title, contentItems) {
  const event = title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const base =
    "ultra-realistic historical photograph, photorealistic, shot on 35mm film, " +
    "Kodak Portra 400, f/2.8 lens, award-winning photojournalism, " +
    "vertical 9:16 portrait format, anatomically correct, " +
    "no text, no logos, no watermarks, no illustration, no CGI";
  const facts = (contentItems || []).map((f) => (f || "").slice(0, 100));
  return [
    // Scene 1 — epic wide establishing shot
    `${base}. Wide establishing aerial shot of ${event}. ` +
      `Epic monumental scale, golden hour or dramatic overcast sky, full landscape, sharp detail.`,
    // Scene 2 — crowd / group shot (avoid lone close-up faces)
    `${base}. Wide-angle photojournalism shot of soldiers or civilians during ${event}. ` +
      `Group of people, full figures visible, candid documentary moment, gritty texture, natural light.`,
    // Scene 3 — decisive moment / environment-focused
    `${base}. Decisive moment during ${event}` +
      `${facts[0] ? ". " + facts[0] : ""}. Equipment, vehicles or architecture visible, no isolated close-up faces, high dramatic tension.`,
    // Scene 4 — immediate aftermath
    `${base}. Immediate aftermath of ${event}` +
      `${facts[1] ? ". " + facts[1] : ""}. Wide documentary shot, raw consequence, environment and people in full frame.`,
    // Scene 5 — legacy / memorial
    `${base}. Historical legacy of ${event}` +
      `${facts[2] ? ". " + facts[2] : ""}. Memorial, monument or meaningful landscape, reflective poignant light.`,
  ].slice(0, N_SCENES);
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
        words[i].word.toLowerCase() === "did" &&
        words[i + 1]?.word.toLowerCase() === "you"
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
      fill="#60a5fa" text-anchor="middle" dominant-baseline="middle"
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
  },
) {
  const { slug, title } = post;
  const XF = 0.8; // crossfade duration in seconds

  // 1. Generate N_SCENES AI images in parallel (2 concurrent via pLimit — halves wait time)
  const scenePrompts = buildScenePrompts(title, contentItems);
  console.log(
    `  Generating ${scenePrompts.length} AI scene images (2 concurrent)...`,
  );
  const imageBuffers = await generateAIImageBatch(scenePrompts);

  // Fall back to Wikipedia image for any scene that failed
  const fallbackBuf = post.imageUrl
    ? await downloadImageBuffer(post.imageUrl).catch(() => null)
    : null;
  const resolvedBuffers = imageBuffers.map((buf, i) => {
    if (buf) return buf;
    console.warn(
      `  ⚠ Scene ${i + 1} AI image failed — using Wikipedia fallback`,
    );
    return fallbackBuf;
  });
  if (resolvedBuffers.some((b) => !b)) {
    throw new Error(
      "generateMultiSceneVideo: could not acquire images for all scenes",
    );
  }

  // 2. Find N_SCENES-1 scene boundary timestamps
  const cuts = findSceneBoundaries(words, narrationParts);
  const cutLog = [0, ...cuts, DURATION]
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
  sceneDurations.push(DURATION - cuts[cuts.length - 1] + XF / 2);

  // 3. Build PNG frames — resize to 110% of target so zoompan has headroom,
  //    then composite the SVG title overlay on top.
  const KB_PAD = 1.1; // 10% larger than W×H so zoom never crops to black
  const framePaths = [];
  for (let i = 0; i < scenePrompts.length; i++) {
    const framePath = join(TMP, `${slug}_s${i}.png`);
    await sharp(resolvedBuffers[i])
      .resize(Math.round(W * KB_PAD), Math.round(H * KB_PAD), {
        fit: "cover",
        position: "center",
      })
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
    framePaths.push(framePath);
    console.log(`  ✓ Scene ${i + 1} frame ready`);
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

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    // Add all scene image inputs with their calculated durations
    for (let i = 0; i < framePaths.length; i++) {
      cmd
        .input(framePaths[i])
        .inputOptions(["-loop 1", `-t ${sceneDurations[i]}`]);
    }

    const hasNarr = !!narrationPath;
    const hasMusic = !!bgMusicPath;
    const narrIdx = framePaths.length;
    const musicIdx =
      hasNarr && hasMusic ? framePaths.length + 1 : framePaths.length;
    if (hasNarr) cmd.input(narrationPath);
    if (hasMusic) cmd.input(bgMusicPath).inputOptions(["-stream_loop -1"]);

    // Caption PNGs then end screen PNG (indices must be stable)
    const captionStartIdx =
      framePaths.length + (hasNarr ? 1 : 0) + (hasMusic ? 1 : 0);
    captionPNGPaths.forEach((p) => cmd.input(p));
    const endScreenIdx = captionStartIdx + captionPNGPaths.length;
    cmd.input(endScreenPath);

    // Build Ken Burns (zoompan) per scene, then chain into xfade
    const kbParts = framePaths.map((_, i) =>
      buildKenBurns(i, sceneDurations[i], `[${i}:v]`, `[v${i}]`),
    );
    const kenBurnsFilter = kbParts.join(";");
    let xfadeChain = "";
    cuts.forEach((t, i) => {
      const inLabel = i === 0 ? "[v0]" : `[x${i - 1}]`;
      const outLabel = i === cuts.length - 1 ? "[vscene]" : `[x${i}]`;
      const xfOff = (t - XF / 2).toFixed(3);
      xfadeChain += `;${inLabel}[v${i + 1}]xfade=transition=fade:duration=${XF}:offset=${xfOff}${outLabel}`;
    });
    const sceneFilter = kenBurnsFilter + xfadeChain;

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
    const endStart = DURATION - 3;
    const endScreenPart =
      `;${afterCaptionLabel}[${endScreenIdx}:v]` +
      `overlay=x=0:y=${endY}:format=auto` +
      `:enable='between(t,${endStart},${DURATION})'[vfinal]`;

    const videoFinalLabel = "[vfinal]";

    let audioFilter = "";
    if (hasNarr && hasMusic) {
      audioFilter = `;[${musicIdx}:a]volume=0.15[bg];[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`;
    }

    cmd.complexFilter(sceneFilter + captionPart + endScreenPart + audioFilter);

    const baseOpts = [
      "-c:v libx264",
      `-t ${DURATION}`,
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
    cmd.output(videoPath).on("end", resolve).on("error", reject).run();
  });

  [...framePaths, ...captionPNGPaths, endScreenPath].forEach((p) => {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  });
  return { path: videoPath, cuts };
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
    });
  }

  // Single-scene: Wikipedia image as static background
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
      `-t ${DURATION}`,
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

    cmd.output(videoPath).on("end", resolve).on("error", reject).run();
  });

  [...captionPNGPaths, framePath].forEach((p) => {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  });
  return { path: videoPath, cuts: [] };
}
