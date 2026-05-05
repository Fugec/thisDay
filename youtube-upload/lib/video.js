/**
 * Generates a YouTube Shorts MP4 (1080x1920) from a blog post.
 *
 * Background visuals:
 *   default path        → multi-scene wiki mode using article images first,
 *                         then Wikipedia/Wikimedia Commons fallbacks
 *   USE_AI_IMAGE=false  → legacy single-image path using post.imageUrl
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
import { readFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getPostImageUrls } from "./kv.js";
// Wiki-only mode: no AI scene generation imports

const TMP = join(dirname(fileURLToPath(import.meta.url)), "../tmp");
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
const W = 1080;
const H = 1920;
const IMAGE_HEADROOM = 1.22;

// Lora Bold — file:// reference in @font-face (librsvg resolves local paths reliably)
const LORA_BOLD_PATH = join(FONTS_DIR, "Lora-Bold.ttf");
const LORA_BOLD_EXISTS = (() => {
  try { readFileSync(LORA_BOLD_PATH, { flag: "r" }); return true; } catch { return false; }
})();
if (!LORA_BOLD_EXISTS) console.warn("  ⚠ Lora-Bold.ttf not found — falling back to DejaVu Sans Bold");

// Custom background image for the title panel (1080×480, dark green textured bg)
const TEXT_BG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../assets/text-bg.png");
/**
 * Single scene per video — one full-bleed image with pulsing zoom.
 */
const N_SCENES = 1;

// Gentle crossfade only — slide/wipe transitions are too jarring for a calm history channel
const XFADE_TRANSITIONS = ["fade"];

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
  const Z_RANGE = 0.18; // more visible motion without feeling frantic
  const Z_START = 1.0;
  const Z_END = (Z_START + Z_RANGE).toFixed(4);
  const Z_MID = (Z_START + Z_RANGE / 2).toFixed(4);
  const INC = (Z_RANGE / d).toFixed(7); // per-frame increment

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
    case 2: // zoom-in + diagonal drift (pan right + up) — cinematic handhold feel
      zoom = `if(eq(on,0),${Z_START},min(${Z_END},pzoom+${INC}))`;
      x = `min(iw*(1-1/zoom),iw/2-(iw/zoom/2)+iw*0.025*on/${d})`;
      y = `max(0,ih/2-(ih/zoom/2)-ih*0.025*on/${d})`;
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
 * Fetches multiple real image buffers from one specific Wikipedia article.
 *
 * Uses actual historical/documentary photos from that exact page as-is — no AI generation.
 *
 * @param {string} articleUrlOrTitle  Exact Wikipedia article URL, or fallback title
 * @param {number} count       Max images to return (default 2)
 * @returns {Promise<Buffer[]>}
 */
function normalizeQueryText(text) {
  return String(text || "")
    .replace(/[^a-z0-9\s'&.-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSearchPhrases(items) {
  const phrases = [];
  for (const item of items || []) {
    const text = normalizeQueryText(item).slice(0, 240);
    if (!text) continue;
    const matches =
      text.match(
        /\b(?:[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,4})\b/g,
      ) || [];
    for (const phrase of matches) {
      const cleaned = phrase.trim();
      if (cleaned.length >= 4) phrases.push(cleaned);
    }
  }
  return [...new Set(phrases)];
}

function buildImageSearchContext(eventTitle, contentItems) {
  const title = normalizeQueryText(eventTitle);
  const joinedItems = (contentItems || []).map(normalizeQueryText).join(" ");
  const allText = `${title} ${joinedItems}`.trim();
  const isMilitary = /\b(battle|war|siege|army|navy|air force|combat|bombing|raid|military|fighter|aircraft)\b/i.test(
    allText,
  );
  const isLabor = /\b(strike|union|workers|factory|plant|labor|company|industrial)\b/i.test(
    allText,
  );

  const phrases = extractSearchPhrases(contentItems);
  const subject =
    phrases.find(
      (p) =>
        p.length >= 6 &&
        !/\b(did you know|quick facts|history|article|today)\b/i.test(p),
    ) || "";

  const queries = [];
  if (subject) queries.push(`${subject} ${title}`.trim());
  queries.push(title);

  if (isLabor) {
    queries.push(`${title} labor dispute`);
    queries.push(`${title} workers`);
    if (subject) queries.push(`${subject} strike`);
  }

  if (isMilitary) {
    queries.push(`${title} battle`);
    queries.push(`${title} military`);
  }

  if (subject) queries.push(subject);

  return {
    title,
    subject,
    isMilitary,
    isLabor,
    queries: [...new Set(queries.filter(Boolean))],
  };
}

function scoreImageTitle(candidateTitle, context) {
  const lower = normalizeQueryText(candidateTitle).toLowerCase();
  const titleTokens = context.title.toLowerCase().split(/\s+/).filter(Boolean);
  const subjectTokens = context.subject
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  let score = 0;
  for (const token of titleTokens) {
    if (lower.includes(token)) score += 8;
  }
  for (const token of subjectTokens) {
    if (lower.includes(token)) score += 12;
  }

  if (context.isLabor) {
    if (/\b(worker|workers|strike|labor|union|factory|plant|company|industrial|manufactur)/i.test(lower)) {
      score += 18;
    }
    if (/\b(aircraft|airplane|plane|fighter|jet|bomb|war|battle|navy|air force)\b/i.test(lower)) {
      score -= 60;
    }
  }

  if (context.isMilitary) {
    if (/\b(aircraft|airplane|plane|fighter|jet|bomb|war|battle|navy|air force|soldier|tank)\b/i.test(lower)) {
      score += 18;
    }
  } else if (/\b(aircraft|airplane|plane|fighter|jet|bomb|war|battle|navy|air force|soldier|tank)\b/i.test(lower)) {
    score -= 45;
  }

  if (/\b(icon|logo|flag|map|seal|stub|arrow|bullet|placeholder)\b/i.test(lower)) {
    score -= 100;
  }

  return score;
}

function getWikipediaTitleFromUrl(articleUrlOrTitle) {
  const raw = String(articleUrlOrTitle || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.endsWith("wikipedia.org") && parsed.pathname.includes("/wiki/")) {
      return decodeURIComponent(parsed.pathname.split("/wiki/")[1].split("#")[0])
        .replace(/_/g, " ")
        .trim();
    }
  } catch {
    // fall back to raw title below
  }
  return raw;
}

async function fetchWikipediaImageBuffers(articleUrlOrTitle, count = 2, context = {}) {
  const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
  const buffers = [];
  const pageTitle = getWikipediaTitleFromUrl(articleUrlOrTitle);
  if (!pageTitle) return buffers;
  const searchContext = buildImageSearchContext(pageTitle, context.contentItems);

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
          title: String(p?.title || ""),
          url: p?.imageinfo?.[0]?.url ?? null,
          px:
            (p?.imageinfo?.[0]?.width ?? 0) * (p?.imageinfo?.[0]?.height ?? 0),
          w: p?.imageinfo?.[0]?.width ?? 0,
          h: p?.imageinfo?.[0]?.height ?? 0,
        }))
        .filter(({ url, w, h }) => url && w >= 800 && h >= 600)
        .sort((a, b) => {
          const scoreA = scoreImageTitle(a.title, searchContext);
          const scoreB = scoreImageTitle(b.title, searchContext);
          if (scoreA !== scoreB) return scoreB - scoreA;
          return b.px - a.px; // largest first → best quality
        })
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

  // Only exact-page Wikipedia images. No Commons search fallback here:
  // the video must stay tied to the specific article selected for the post.
  try {
    const listRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=images&imlimit=50&format=json`,
      { headers: ua, signal: AbortSignal.timeout(15_000) },
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const page = Object.values(listData?.query?.pages ?? {})[0];
      const candidates = (page?.images ?? [])
        .map((i) => i.title)
        .filter((t) => /\.(jpe?g|png|webp)$/i.test(t) && !BAD.test(t));

      const urls = await resolveUrls(
        "https://en.wikipedia.org/w/api.php",
        candidates,
      );
      for (const url of urls) {
        if (buffers.length >= count) break;
        const buf = await downloadSafe(url);
        if (buf) buffers.push(buf);
      }
    }
  } catch {
    /* return what we have */
  }

  return buffers;
}

// ---------------------------------------------------------------------------
// Image quality & cinematic helpers
// ---------------------------------------------------------------------------

/**
 * Returns an SVG vignette (dark radial gradient) that can be composited over
 * any image to add a cinematic edge-darkening effect.
 */
function buildVignetteSVG(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <radialGradient id="vig" cx="50%" cy="50%" r="72%" gradientUnits="objectBoundingBox">
        <stop offset="30%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.62"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#vig)"/>
  </svg>`;
}

function buildDepthOverlaySVG(w, h) {
  const frameInset = Math.round(Math.min(w, h) * 0.03);
  const frameStroke = Math.max(5, Math.round(Math.min(w, h) * 0.006));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="topGlow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="white" stop-opacity="0.12"/>
        <stop offset="28%" stop-color="white" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="bottomShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.28"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#topGlow)"/>
    <rect width="${w}" height="${h}" fill="url(#bottomShade)"/>
    <rect
      x="${frameInset}"
      y="${frameInset}"
      width="${w - frameInset * 2}"
      height="${h - frameInset * 2}"
      rx="${Math.round(Math.min(w, h) * 0.02)}"
      fill="none"
      stroke="rgba(255,255,255,0.22)"
      stroke-width="${frameStroke}"
    />
  </svg>`;
}

function buildRoundedRectMaskSVG(w, h, radius) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" rx="${radius}" fill="white"/>
  </svg>`;
}

function buildCardShadowSVG(w, h, radius) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
        <feDropShadow dx="0" dy="28" stdDeviation="22" flood-color="black" flood-opacity="0.55"/>
      </filter>
    </defs>
    <rect
      x="0"
      y="0"
      width="${w}"
      height="${h}"
      rx="${radius}"
      fill="rgba(0,0,0,0.22)"
      filter="url(#shadow)"
    />
  </svg>`;
}

/**
 * Applies era-appropriate color grading to a Sharp pipeline.
 * Uses the event year to pick a cinematic tone:
 *   pre-1900  → warm sepia
 *   1900-1939 → muted warm film look
 *   1940-1959 → cool, gritty tone
 *   1960-1979 → slightly faded warm look
 *   1980+     → punchy, natural
 *
 * @param {object}  sharpInst  A fluent sharp instance
 * @param {number|null} year   Event year, or null for generic boost
 * @returns {object} The same sharp instance with grading applied
 */
function applyEraGrading(sharpInst, year) {
  if (!year) {
    return sharpInst.modulate({ saturation: 1.05, brightness: 0.98 });
  }
  if (year < 1900) {
    return sharpInst
      .modulate({ saturation: 0.45, brightness: 0.92 })
      .tint({ r: 112, g: 73, b: 38 });
  }
  if (year < 1940) {
    return sharpInst
      .modulate({ saturation: 0.6, brightness: 0.9 })
      .tint({ r: 95, g: 85, b: 70 });
  }
  if (year < 1960) {
    return sharpInst.modulate({ saturation: 0.78, brightness: 0.9 });
  }
  if (year < 1980) {
    return sharpInst
      .modulate({ saturation: 0.9, brightness: 0.95 })
      .tint({ r: 100, g: 94, b: 84 });
  }
  return sharpInst.modulate({ saturation: 1.08, brightness: 1.0 });
}

function getQualityTuning(qualityHint = null) {
  const hint = String(qualityHint || "").toLowerCase();
  const tuning = {
    bgBlur: 16,
    bgBrightness: 0.45,
    bgSaturation: 0.92,
    cardBrightness: 1.03,
    cardSaturation: 1.12,
    cardSharpenSigma: 1.6,
    cardLinearA: 1.0,
    cardLinearB: 0,
  };

  if (!hint) return tuning;

  if (/\bsharp|sharper|detail|detailed|crisp|clear\b/.test(hint)) {
    tuning.bgBlur = 12;
    tuning.cardSharpenSigma = 2.2;
    tuning.cardLinearA = 1.07;
  }

  if (/\blighting|contrast|richer|depth|dim|flat\b/.test(hint)) {
    tuning.bgBrightness = 0.4;
    tuning.cardBrightness = 1.08;
    tuning.cardSaturation = 1.18;
    tuning.cardLinearA = Math.max(tuning.cardLinearA, 1.09);
  }

  if (/\bcolor|colour|vibrant|saturation\b/.test(hint)) {
    tuning.cardSaturation = Math.max(tuning.cardSaturation, 1.2);
    tuning.bgSaturation = 0.96;
  }

  return tuning;
}

/**
 * Prepares a Wikipedia image buffer for 9:16 vertical video.
 * Cover-crops to 1080×1920 + 15% Ken Burns headroom, then applies
 * era grading and cinematic vignette overlay.
 *
 * @param {Buffer} buffer  Raw image bytes from Wikipedia/Commons
 * @param {number|null} year  Event year for era grading, or null
 * @returns {Promise<Buffer>}  PNG ready for scene compositing
 */
async function prepareWikipediaSceneBuffer(buffer, year = null, qualityHint = null) {
  const TARGET_W = Math.round(W * IMAGE_HEADROOM);
  const TARGET_H = Math.round(H * IMAGE_HEADROOM);
  const cardW = Math.round(TARGET_W * 0.82);
  const cardH = Math.round(TARGET_H * 0.68);
  const cardX = Math.round((TARGET_W - cardW) / 2);
  const cardY = Math.round((TARGET_H - cardH) / 2 - TARGET_H * 0.035);
  const cardRadius = Math.round(Math.min(cardW, cardH) * 0.045);
  const tuning = getQualityTuning(qualityHint);

  let background = sharp(buffer)
    .resize(TARGET_W, TARGET_H, { fit: "cover", position: "centre" })
    .blur(tuning.bgBlur)
    .modulate({
      brightness: tuning.bgBrightness,
      saturation: tuning.bgSaturation,
    });
  background = applyEraGrading(background, year);

  let card = sharp(buffer)
    .resize(cardW, cardH, { fit: "cover", position: "centre" })
    .sharpen({ sigma: tuning.cardSharpenSigma })
    .modulate({
      brightness: tuning.cardBrightness,
      saturation: tuning.cardSaturation,
    })
    .linear(tuning.cardLinearA, tuning.cardLinearB);
  card = applyEraGrading(card, year);

  const [backgroundBuf, cardBuf, vignetteBuf, depthBuf, shadowBuf, maskBuf] =
    await Promise.all([
      background.png().toBuffer(),
      card.png().toBuffer(),
      sharp(Buffer.from(buildVignetteSVG(TARGET_W, TARGET_H))).png().toBuffer(),
      sharp(Buffer.from(buildDepthOverlaySVG(TARGET_W, TARGET_H))).png().toBuffer(),
      sharp(Buffer.from(buildCardShadowSVG(cardW, cardH, cardRadius))).png().toBuffer(),
      sharp(Buffer.from(buildRoundedRectMaskSVG(cardW, cardH, cardRadius)))
        .png()
        .toBuffer(),
    ]);

  const maskedCardBuf = await sharp(cardBuf)
    .composite([{ input: maskBuf, blend: "dest-in" }])
    .png()
    .toBuffer();

  const borderBuf = await sharp({
    create: {
      width: cardW,
      height: cardH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}">
          <rect
            x="4"
            y="4"
            width="${cardW - 8}"
            height="${cardH - 8}"
            rx="${Math.max(0, cardRadius - 4)}"
            fill="none"
            stroke="rgba(255,255,255,0.28)"
            stroke-width="6"
          />
        </svg>`),
      },
    ])
    .png()
    .toBuffer();

  return sharp(backgroundBuf)
    .composite([
      { input: vignetteBuf, blend: "over" },
      { input: shadowBuf, left: cardX, top: cardY, blend: "over" },
      { input: maskedCardBuf, left: cardX, top: cardY, blend: "over" },
      { input: borderBuf, left: cardX, top: cardY, blend: "over" },
      { input: depthBuf, blend: "soft-light" },
    ])
    .png()
    .toBuffer();
}

/**
 * Like prepareWikipediaSceneBuffer but returns TWO layers instead of one composite:
 *   bgBuf       — blurred background at TARGET_W×TARGET_H (Ken Burns headroom for zoom-out).
 *   cardLayerBuf — card + vignette + depth at W×H on a transparent canvas, static overlay.
 *
 * Background slowly zooms out (Ken Burns); the framed card stays fixed on top.
 */
async function prepareWikipediaSceneLayers(buffer, year = null, qualityHint = null) {
  // Full-bleed layout: sharp image fills W × (H - HEADER_H) below the header panel.
  // bgBuf is oversized by IMAGE_HEADROOM so zoompan can animate without black edges.
  // cardLayerBuf is a transparent canvas — no card, just branding composited by caller.
  const HEADER_H = 480;
  const IMG_H = H - HEADER_H - 1; // 1px gap below header
  const TARGET_W = Math.round(W * IMAGE_HEADROOM);
  const TARGET_H = Math.round(IMG_H * IMAGE_HEADROOM);
  const tuning = getQualityTuning(qualityHint);

  let img = sharp(buffer)
    .resize(TARGET_W, TARGET_H, { fit: "cover", position: "centre" })
    .sharpen({ sigma: tuning.cardSharpenSigma })
    .modulate({ brightness: tuning.cardBrightness, saturation: tuning.cardSaturation })
    .linear(tuning.cardLinearA, tuning.cardLinearB);
  img = applyEraGrading(img, year);

  const bgBuf = await img.png().toBuffer();

  // Transparent static overlay — branding composited on top by the caller
  const cardLayerBuf = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

  return { bgBuf, cardLayerBuf };
}

/**
 * Full-bleed single-image layout for the new single-scene mode.
 *
 * Returns two buffers:
 *   bgBuf       — enhanced image at TARGET_W×TARGET_H (with Ken Burns headroom
 *                 so the pulsing zoom never reveals black edges).
 *   cardLayerBuf — transparent W×H canvas (title overlay is composited on top
 *                 of this by the caller via buildSVG).
 *
 * Unlike prepareWikipediaSceneLayers, this version shows the image full-bleed:
 * no blurred background, no card, no rounded corners — the raw photograph fills
 * the entire 9:16 frame so the subject is always clearly visible.
 */
async function prepareSingleSceneFullBleed(buffer, year = null, qualityHint = null) {
  const TARGET_W = Math.round(W * IMAGE_HEADROOM);
  const TARGET_H = Math.round(H * IMAGE_HEADROOM);
  const tuning = getQualityTuning(qualityHint);

  // Slightly enhance the image but keep it natural — no blur, no card crop.
  let img = sharp(buffer)
    .resize(TARGET_W, TARGET_H, { fit: "cover", position: "centre" })
    .sharpen({ sigma: tuning.cardSharpenSigma })
    .modulate({ brightness: tuning.cardBrightness, saturation: tuning.cardSaturation })
    .linear(tuning.cardLinearA, tuning.cardLinearB);
  img = applyEraGrading(img, year);
  const bgBuf = await img.png().toBuffer();

  // Transparent overlay canvas — the caller composites buildSVG() text on top.
  const cardLayerBuf = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

  return { bgBuf, cardLayerBuf };
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

function fitTitleLines(title) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const attempts = [
    { fontSize: 60, maxChars: 24, maxLines: 2, lineH: 66 },
    { fontSize: 52, maxChars: 28, maxLines: 3, lineH: 58 },
    { fontSize: 46, maxChars: 32, maxLines: 3, lineH: 52 },
    { fontSize: 40, maxChars: 36, maxLines: 4, lineH: 46 },
    { fontSize: 36, maxChars: 40, maxLines: 4, lineH: 42 },
  ];

  for (const attempt of attempts) {
    const lines = wrapLines(cleanTitle, attempt.maxChars);
    if (lines.length <= attempt.maxLines) return { ...attempt, lines };
  }

  const fallback = attempts[attempts.length - 1];
  return {
    ...fallback,
    lines: wrapLines(cleanTitle, fallback.maxChars).slice(0, fallback.maxLines),
  };
}

// ---------------------------------------------------------------------------
// Overlay builders
// ---------------------------------------------------------------------------

// Lora is installed system-wide (~/Library/Fonts on macOS, ~/.fonts on Linux via CI step).
// No @font-face embedding needed — just reference by family name.
const FONT = "Lora,DejaVu Sans Bold,Arial Black,serif";
const FONT_FACE = "";

/**
 * Returns the text-bg.png scaled to 1080×480 as a PNG Buffer.
 * Used as a permanent top-of-frame panel overlay (always visible).
 */
async function buildBgPanelBuffer() {
  return sharp(TEXT_BG_PATH)
    .resize(1080, 480, { fit: "fill" })
    .png()
    .toBuffer();
}

/**
 * Returns a transparent 1080×480 PNG with "ON THIS DAY" + Lora title text.
 * Composited on top of the bg panel; disappears after TEXT_SHOW_S seconds.
 */
function buildTitleTextSVG(title) {
  const PW = 1080, PH = 480;
  const { lines, fontSize, lineH } = fitTitleLines(title);
  const blockH = (lines.length - 1) * lineH;
  const titleStartY = Math.max(242, 320 - blockH / 2);

  const titleSVG = lines.map((line, i) => `
    <text x="${PW / 2}" y="${titleStartY + i * lineH}"
      font-family="${FONT}" font-size="${fontSize}" font-weight="700"
      fill="white" text-anchor="middle" dominant-baseline="middle"
      stroke="rgba(0,0,0,0.45)" stroke-width="3" paint-order="stroke fill"
    >${escapeXml(line)}</text>`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}">
    <defs><style>${FONT_FACE}</style></defs>
    <text x="${PW / 2}" y="148"
      font-family="${FONT}" font-size="30" font-weight="700"
      fill="#c9a84c" text-anchor="middle" dominant-baseline="middle"
      stroke="rgba(0,0,0,0.4)" stroke-width="2" paint-order="stroke fill"
      letter-spacing="12"
    >ON THIS DAY</text>
    ${titleSVG}
  </svg>`;
}

/**
 * Builds the permanent branding overlay (1080×1920 transparent canvas):
 * just "thisday.info" at the very bottom with a subtle dark fade.
 */
function buildBrandingSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <style>${FONT_FACE}</style>
      <linearGradient id="bBot" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.85"/>
      </linearGradient>
    </defs>
    <!-- Subtle full-frame dark overlay so captions pop against any image -->
    <rect width="${W}" height="${H}" fill="black" fill-opacity="0.22"/>
    <rect y="${H - 220}" width="${W}" height="220" fill="url(#bBot)"/>
    <text x="540" y="${H - 52}"
      font-family="${FONT}" font-size="42" font-weight="700"
      fill="white" text-anchor="middle" dominant-baseline="middle"
      stroke="rgba(0,0,0,0.7)" stroke-width="3" paint-order="stroke fill"
    >thisday.info</text>
  </svg>`;
}

/**
 * Legacy single-image path: combined overlay (title panel composited at top
 * + branding at bottom) as a single 1080×1920 SVG.  Used when useAiImage=false.
 */
async function buildLegacyOverlayBuffer(title) {
  const bgPanel  = await buildBgPanelBuffer();
  const textBuf  = await sharp(Buffer.from(buildTitleTextSVG(title))).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: bgPanel, left: 0, top: 0, blend: "over" },
      { input: textBuf, left: 0, top: 0, blend: "over" },
      { input: Buffer.from(buildBrandingSVG()), blend: "over" },
    ])
    .png()
    .toBuffer();
}

// Keep buildSVG as a thin wrapper used by the legacy single-image path.
// (Returns a flat SVG for the branding only; title panel is handled separately.)
function buildSVG() { return buildBrandingSVG(); }

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
  const WORDS_PER_CHUNK = 6;
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
  // Caption bar: up to 2 lines, no background — text stands out via dark green
  // stroke + drop shadow. Height adjusts to 1 or 2 lines automatically.
  const FONT_SIZE = 54;
  const LINE_H = 64;
  const MAX_CHARS_PER_LINE = 28;
  const paths = [];
  for (let i = 0; i < chunks.length; i++) {
    const lines = wrapLines(chunks[i].text, MAX_CHARS_PER_LINE).slice(0, 2);
    const CAP_H = lines.length === 1 ? LINE_H + 20 : LINE_H * 2 + 20;
    const startY = lines.length === 1
      ? CAP_H / 2
      : CAP_H / 2 - (LINE_H * (lines.length - 1)) / 2;
    const textEls = lines.map((line, li) =>
      `<text x="${W / 2}" y="${startY + li * LINE_H}"
        font-family="${FONT}" font-size="${FONT_SIZE}" font-weight="700"
        fill="white" text-anchor="middle" dominant-baseline="middle"
        stroke="#1b3a2d" stroke-width="5" paint-order="stroke fill"
        filter="url(#sh)"
      >${escapeXml(line)}</text>`
    ).join("\n");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CAP_H}">
      <defs>
        <filter id="sh" x="-5%" y="-20%" width="110%" height="140%">
          <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000000" flood-opacity="0.9"/>
        </filter>
      </defs>
      ${textEls}
    </svg>`;
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
  minStart = 0,
) {
  if (!chunks.length) return "";
  // Captions centred vertically. Max height = 2 lines × 64 + 20 = 148px.
  // Well clear of the title panel (top 480px) and branding (bottom 220px).
  const CAP_H = 148;
  const Y_POS = Math.round(H / 2 - CAP_H / 2);
  const eligible = chunks
    .map((c, i) => ({ ...c, origIdx: i }))
    .filter((c) => c.end > minStart);
  if (!eligible.length) return "";
  const parts = eligible.map((chunk, pos) => {
    const S = Math.max(chunk.start, minStart).toFixed(3);
    const inLabel  = pos === 0 ? inputLabel : `[ov${eligible[pos - 1].origIdx}]`;
    const outLabel = pos === eligible.length - 1 ? outputLabel : `[ov${chunk.origIdx}]`;
    return (
      `${inLabel}[${captionStartIdx + chunk.origIdx}:v]` +
      `overlay=x=0:y=${Y_POS}:format=auto` +
      `:enable='between(t,${S},${chunk.end.toFixed(3)})'${outLabel}`
    );
  });
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

async function fetchArticleImageBuffers(slug, limit = 3) {
  const urls = await getPostImageUrls(slug, Math.max(limit * 4, 12));
  const buffers = [];
  for (const url of urls) {
    try {
      const buf = await downloadImageBuffer(url);
      buffers.push(buf);
      if (buffers.length >= limit) break;
    } catch {
      // skip broken article images and keep going
    }
  }
  return buffers;
}

async function fetchPreferredVideoImageBuffers(post, articleSource, limit, context = {}) {
  const buffers = [];
  const featuredUrl = post?.imageUrl || null;

  if (featuredUrl) {
    try {
      const featuredBuffer = await downloadImageBuffer(featuredUrl);
      buffers.push(featuredBuffer);
      console.log("  ✓ Using blog featured image as primary video image");
    } catch (err) {
      console.warn(`  ⚠ Featured image unavailable for video (${err.message}) — falling back to Wikipedia article images`);
    }
  }

  if (buffers.length >= limit) return buffers.slice(0, limit);

  const fallbackBuffers = await fetchWikipediaImageBuffers(
    articleSource,
    limit - buffers.length,
    context,
  );
  buffers.push(...fallbackBuffers);
  return buffers.slice(0, limit);
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
  const match = title.match(
    /^([A-Z][a-z]+(?: [A-Z][a-z]+)+?)\s*[—–-]\s*[,]?\s*\w+ \d{1,2},?\s*\d{4}$/,
  );
  if (match) return match[1];
  // Also handle titles like "Nikola Tesla — 1943"
  const simpleMatch = title.match(
    /^([A-Z][a-z]+(?: [A-Z][a-z]+)+?)\s*[—–-]\s*\d{4}$/,
  );
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
    `${style}` +
    hint +
    `, ` +
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
 * Finds sceneCount-1 scene boundary timestamps from ElevenLabs word data.
 * Tries to anchor one cut at the "Did you know?" boundary (narration structure),
 * then distributes the remaining cuts evenly before and after it.
 * Falls back to equal spacing when no timestamps are available.
 *
 * @param {{ word: string, start: number, end: number }[]} words
 * @param {string[]|null} narrationParts  from buildNarrationParts()
 * @param {number} sceneCount
 * @returns {number[]}  sceneCount-1 cut timestamps in seconds
 */
function findSceneBoundaries(words, narrationParts, sceneCount = N_SCENES) {
  const safeSceneCount = Math.max(1, Number(sceneCount) || N_SCENES);
  const numCuts = safeSceneCount - 1;
  if (numCuts <= 0) return [];

  if (!words?.length) {
    return Array.from(
      { length: numCuts },
      (_, i) => (DURATION / safeSceneCount) * (i + 1),
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
    clamp((totalDur / safeSceneCount) * (i + 1)),
  );
}

/**
 * Multi-scene video: Wikipedia/Commons images with Ken Burns crossfaded at narration sections
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
      font-family="${FONT}"
      font-size="52" font-weight="700"
      fill="white" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="3" paint-order="stroke fill"
    >Follow for daily history</text>
    <text x="${W / 2}" y="195"
      font-family="${FONT}"
      font-size="44" font-weight="700"
      fill="#9dc43a" text-anchor="middle" dominant-baseline="middle"
      stroke="black" stroke-width="3" paint-order="stroke fill"
    >thisday.info</text>
    <text x="${W / 2}" y="263"
      font-family="${FONT}"
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
    wikiArticleUrl,
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

  // 1. Use the article's featured image first. This keeps the video aligned with
  // the published blog post; Wikipedia article images are only fallback material.
  const fallbackTitle = title.replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}$/, "").trim();
  const articleSource = wikiArticleUrl || fallbackTitle;
  console.log(`  Fetching featured/article image for "${slug}"...`);
  const imageBuffers = await fetchPreferredVideoImageBuffers(post, articleSource, N_SCENES, {
    contentItems,
  });

  if (imageBuffers.length === 0) {
    throw new Error(
      "IMAGE_UNAVAILABLE: no usable featured image or exact Wikipedia article image",
    );
  }

  const minWikiImages = Math.max(
    1,
    Number.parseInt(process.env.WIKI_IMAGE_MIN_COUNT || `${N_SCENES}`, 10) ||
      N_SCENES,
  );

  if (imageBuffers.length < minWikiImages) {
    throw new Error(
      `IMAGE_UNAVAILABLE: exact Wikipedia article mode requires ${minWikiImages} usable article images, got ${imageBuffers.length}`,
    );
  }

  const sceneCount = Math.min(N_SCENES, imageBuffers.length);
  console.log(
    `  ✓ Using ${sceneCount} real image(s) for video (featured first, min=${minWikiImages})`,
  );

  const sceneLayers = await Promise.all(
    imageBuffers
      .slice(0, sceneCount)
      .map((buf) => prepareSingleSceneFullBleed(buf, null, qualityHint)),
  );
  console.log(
    `  Scenes ready: ${sceneCount} (zoom-out background, fixed card)`,
  );

  // 2. Find scene boundary timestamps for the number of available scenes
  const cuts = findSceneBoundaries(words, narrationParts, sceneLayers.length);
  const cutLog = [0, ...cuts, videoDuration]
    .map((t, i, arr) =>
      i < arr.length - 1 ? `${t.toFixed(1)}–${arr[i + 1].toFixed(1)}s` : null,
    )
    .filter(Boolean)
    .join(" · ");
  console.log(`  Scene cuts: ${cutLog}`);

  // Per-scene input durations so each scene covers its segment + half-XF overlap
  const sceneDurations =
    cuts.length > 0
      ? cuts.map((t, i) => (i === 0 ? t + XF / 2 : t - cuts[i - 1] + XF))
      : [];
  if (cuts.length > 0) {
    sceneDurations.push(videoDuration - cuts[cuts.length - 1] + XF / 2);
  } else {
    sceneDurations.push(videoDuration);
  }

  // 3. Write scene files.
  //    bgPath        = full-bleed image at Ken Burns headroom size (pulsing zoom in FFmpeg)
  //    cardPath      = permanent branding overlay (thisday.info, always visible)
  //    titleCardPath = text-bg.png panel with "ON THIS DAY" + title (disappears after TEXT_SHOW_S)
  const TEXT_SHOW_S = 8;
  const bgFiles   = [];
  const cardFiles = [];

  for (let i = 0; i < sceneLayers.length; i++) {
    const { bgBuf, cardLayerBuf } = sceneLayers[i];
    const bgPath   = join(TMP, `${slug}_s${i}_bg.png`);
    const cardPath = join(TMP, `${slug}_s${i}_card.png`);
    await sharp(bgBuf).png().toFile(bgPath);
    await sharp(cardLayerBuf)
      .composite([{ input: Buffer.from(buildBrandingSVG()), blend: "over" }])
      .png()
      .toFile(cardPath);
    bgFiles.push(bgPath);
    cardFiles.push(cardPath);
    console.log(`  ✓ Scene ${i + 1} background ready`);
  }

  // bg panel: text-bg.png at top, always visible — no text, just the decorative background
  const bgPanelCardPath = join(TMP, `${slug}_bgpanel.png`);
  const bgPanelBuf = await buildBgPanelBuffer();
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: bgPanelBuf, left: 0, top: 0, blend: "over" }])
    .png()
    .toFile(bgPanelCardPath);

  // Title text: "ON THIS DAY" + Lora title — transparent canvas, disappears after TEXT_SHOW_S
  const titleCardPath = join(TMP, `${slug}_title.png`);
  const titleTextBuf = await sharp(Buffer.from(buildTitleTextSVG(title))).png().toBuffer();
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: titleTextBuf, left: 0, top: 0, blend: "over" }])
    .png()
    .toFile(titleCardPath);
  console.log(`  ✓ Title panel ready (bg always on, text fades at ${TEXT_SHOW_S}s)`);

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

      // Background inputs: looped stills for Ken Burns animation
      // -r must match FPS so zoompan reads at the same rate it outputs.
      for (let i = 0; i < bgFiles.length; i++) {
        cmd.input(bgFiles[i]).inputOptions(["-loop 1", `-r ${FPS}`, `-t ${sceneDurations[i]}`]);
      }
      // Card inputs: permanent branding overlays
      for (let i = 0; i < cardFiles.length; i++) {
        cmd.input(cardFiles[i]).inputOptions(["-loop 1", `-r ${FPS}`, `-t ${sceneDurations[i]}`]);
      }
      // bg panel (text-bg.png): always visible at top — permanent
      const bgPanelIdx = bgFiles.length + cardFiles.length;
      cmd.input(bgPanelCardPath).inputOptions(["-loop 1", `-r ${FPS}`, `-t ${videoDuration}`]);
      // Title text: ON THIS DAY + title — disappears after TEXT_SHOW_S seconds
      const titleCardIdx = bgPanelIdx + 1;
      cmd.input(titleCardPath).inputOptions(["-loop 1", `-r ${FPS}`, `-t ${TEXT_SHOW_S}`]);

      const hasNarr = !!narrationPath;
      const hasMusic = !!bgMusicPath;
      const audioBase = bgFiles.length + cardFiles.length + 2; // +2 for bgPanel + titleCard
      const narrIdx  = audioBase;
      const musicIdx = hasNarr && hasMusic ? audioBase + 1 : audioBase;
      if (hasNarr) cmd.input(narrationPath);
      if (hasMusic) cmd.input(bgMusicPath).inputOptions(["-stream_loop -1"]);

      // Caption PNGs then end screen PNG (indices must be stable)
      const captionStartIdx = audioBase + (hasNarr ? 1 : 0) + (hasMusic ? 1 : 0);
      captionPNGPaths.forEach((p) => cmd.input(p));
      const endScreenIdx = captionStartIdx + captionPNGPaths.length;
      cmd.input(endScreenPath);

      // Per-scene filter: pulsing zoom — image breathes in then out over full scene.
      // Z_MIN=1.0 → Z_MAX=1.18 → Z_MIN creates a gentle heartbeat feel.
      // Image occupies W × IMG_H below the header; pad adds HEADER_H+1 px black at top.
      const HEADER_H = 480;
      const IMG_H = H - HEADER_H - 1;
      const Z_MIN = 1.0;
      const Z_MAX = 1.18;
      const Z_RANGE_STR = (Z_MAX - Z_MIN).toFixed(4);
      const sceneParts = bgFiles.map((_, i) => {
        const d    = Math.round(sceneDurations[i] * FPS);
        const half = Math.floor(d / 2);
        // First half: zoom in Z_MIN → Z_MAX; second half: zoom out Z_MAX → Z_MIN
        const zoom =
          `if(lte(on,${half}),` +
            `${Z_MIN.toFixed(4)}+${Z_RANGE_STR}*(on/${half}),` +
            `${Z_MAX.toFixed(4)}-${Z_RANGE_STR}*((on-${half})/${d - half}))`;
        const x = `iw/2-(iw/zoom/2)`;
        const y = `ih/2-(ih/zoom/2)`;
        // Cinematic grade: slight warmth (lift reds, drop blues) + desaturation + film grain
        const grade = `eq=saturation=0.82:contrast=1.06:gamma_r=1.04:gamma_b=0.94,noise=alls=9:allf=t`;
        // Zoompan outputs W×IMG_H; pad pushes it down below the header panel
        const zp =
          `[${i}:v]zoompan=z='${zoom}':x='${x}':y='${y}'` +
          `:d=${d}:s=${W}x${IMG_H}:fps=${FPS},setpts=PTS-STARTPTS,fps=fps=${FPS},${grade}` +
          `,pad=${W}:${H}:0:${HEADER_H + 1}:color=black[kb${i}]`;
        const brandPart   = `[kb${i}][${bgFiles.length + i}:v]overlay=x=0:y=0:format=auto[vbrand${i}]`;
        const bgPanelPart = `[vbrand${i}][${bgPanelIdx}:v]overlay=x=0:y=0:format=auto[vbgp${i}]`;
        const titlePart   = `[vbgp${i}][${titleCardIdx}:v]overlay=x=0:y=0:format=auto[v${i}]`;
        return `${zp};${brandPart};${bgPanelPart};${titlePart}`;
      });
      const scenePartFilter = sceneParts.join(";");

      // Xfade chain with varied transitions
      let xfadeChain = "";
      if (cuts.length === 0) {
        // Single-scene mode: forward v0 to vscene so downstream overlays/mapping stay unchanged.
        xfadeChain = ";[v0]null[vscene]";
      } else {
        cuts.forEach((t, i) => {
          const inLabel = i === 0 ? "[v0]" : `[x${i - 1}]`;
          const outLabel = i === cuts.length - 1 ? "[vscene]" : `[x${i}]`;
          const xfOff = (t - XF / 2).toFixed(3);
          const transition = XFADE_TRANSITIONS[i % XFADE_TRANSITIONS.length];
          xfadeChain += `;${inLabel}[v${i + 1}]xfade=transition=${transition}:duration=${XF}:offset=${xfOff}${outLabel}`;
        });
      }
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
        audioFilter =
          `;[${musicIdx}:a]volume=0.11[bg]` +
          `;[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`;
      }

      cmd.complexFilter(
        sceneFilter + captionPart + endScreenPart + audioFilter,
      );

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
    [...bgFiles, ...cardFiles, bgPanelCardPath, titleCardPath, ...captionPNGPaths, endScreenPath].forEach((p) => {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    });
  }
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
 *   useAiImage?:    boolean,      When true, use the multi-scene wiki-image path
 *                                 (legacy name kept for compatibility)
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
    wikiArticleUrl = null,
    narrationParts = null,
    qualityHint = null, // remediation directive from a failed quality check
  } = {},
) {
  mkdirSync(TMP, { recursive: true });

  const { slug, title } = post;
  const framePath = join(TMP, `${slug}_frame.png`);
  const videoPath = join(TMP, `${slug}.mp4`);

  // Multi-scene: article/Wikipedia images crossfaded at narration-timed boundaries
  if (useAiImage) {
    return generateMultiSceneVideo(post, {
      narrationPath,
      bgMusicPath,
      words,
      contentItems,
      wikiArticleUrl,
      narrationParts,
      videoPath,
      qualityHint,
    });
  }

  // Single-scene: validated post.imageUrl as static background
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
  const preparedBuffer = await prepareWikipediaSceneBuffer(
    imgBuffer,
    null,
    qualityHint,
  );

  // 2. Resize + SVG overlay → PNG frame
  const svgBuffer = Buffer.from(buildSVG(title));
  await sharp(preparedBuffer)
    .resize(Math.round(W * IMAGE_HEADROOM), Math.round(H * IMAGE_HEADROOM), {
      fit: "cover",
      position: "center",
    })
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

  // 4. Encode PNG frame → 45-second MP4 with slow Ken Burns motion
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
        // Apply Ken Burns to the single image, then overlay caption PNGs with
        // time-gated enable — no libfreetype needed.
        const sceneFilter = buildKenBurns(0, videoDuration, "[0:v]", "[v0]");
        const captionFilter = buildOverlayCaptionFilter(
          captionChunks,
          captionStartIdx,
          "[v0]",
          "[vcap]",
        );
        const videoMapLabel = "[vcap]";

        if (hasNarr && hasMusic) {
          cmd
            .complexFilter(
              `${sceneFilter};${captionFilter};` +
                `[${musicIdx}:a]volume=0.11[bg];` +
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
            .complexFilter(`${sceneFilter};${captionFilter}`)
            .outputOptions([
              ...baseOpts,
              `-map ${videoMapLabel}`,
              `-map ${narrIdx}:a`,
              "-c:a aac",
              "-b:a 128k",
            ]);
        } else if (hasMusic) {
          cmd
            .complexFilter(`${sceneFilter};${captionFilter}`)
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
            .complexFilter(`${sceneFilter};${captionFilter}`)
            .outputOptions([...baseOpts, `-map ${videoMapLabel}`]);
        }
      } else {
        // No captions — original simple path with Ken Burns motion.
        if (hasNarr && hasMusic) {
          cmd
            .complexFilter(
              `${buildKenBurns(0, videoDuration, "[0:v]", "[v0]")};` +
              `[${musicIdx}:a]volume=0.11[bg];` +
              `[${narrIdx}:a][bg]amix=inputs=2:duration=longest:normalize=0[a]`,
            )
            .outputOptions([
              ...baseOpts,
              "-map [v0]",
              "-map [a]",
              "-c:a aac",
              "-b:a 128k",
            ]);
        } else if (hasNarr) {
          cmd.outputOptions([
            ...baseOpts,
            "-map [v0]",
            "-map 1:a",
            "-c:a aac",
            "-b:a 128k",
          ]);
        } else if (hasMusic) {
          cmd.outputOptions([
            ...baseOpts,
            "-map [v0]",
            "-map 1:a",
            "-c:a aac",
            "-b:a 128k",
            "-shortest",
          ]);
        } else {
          cmd
            .complexFilter(buildKenBurns(0, videoDuration, "[0:v]", "[v0]"))
            .outputOptions([...baseOpts, "-map [v0]"]);
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
