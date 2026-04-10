/**
 * ElevenLabs Text-to-Speech helper.
 *
 * Generates a documentary-style voiceover narration for each blog post
 * using text from the post's "Did You Know?" section (newer posts) or
 * "Quick Facts" table (older posts).
 *
 * Uses the /with-timestamps endpoint to get word-level timing data
 * so video.js can render animated synchronized captions.
 *
 * Voice: Max — e-learning + documentary tone.
 * Model: eleven_turbo_v2_5 — lowest character cost on the free plan.
 *
 * Free plan: 10 000 chars/month.
 * Schedule: 1 video every 3 days ≈ 10 videos/month.
 * Avg narration: ~600 chars → ~6 000 chars/month (well within free tier).
 *
 * Env vars required: ELEVENLABS_API_KEY (primary), ELEVENLABS_API_KEY_2 (fallback)
 * Fallback is used automatically when the primary account hits its 10k char/month quota.
 */

import { writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join } from "path";
import { recordQuotaSignal } from "./tracker.js";

const ASSETS_DIR = "./assets";
const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George — warm captivating storyteller
const MODEL_ID = "eleven_turbo_v2_5"; // fastest + lowest character cost

/**
 * Builds the TTS narration script.
 *
 * Uses "Did You Know?" bullet items (newer posts) or "Quick Facts" rows
 * (older posts) as the main content. Falls back to the post description
 * if neither is available.
 *
 * @param {{ title: string, description: string }} post
 * @param {string[]|null} contentItems  — DYK bullets or Quick Facts rows
 * @returns {string}
 */
function buildNarrationIntro(post) {
  const rawTitle = String(post?.title || "").trim();
  const parts = rawTitle.split(/ [—–] /);
  const lead = parts[0]?.trim() || rawTitle;
  const datePart = parts[1]?.trim() || "";
  const yearMatch = datePart.match(/\b(\d{4})\b/);
  const year = yearMatch ? yearMatch[1] : "";
  return year ? `${lead}, ${year}.` : `${lead}.`;
}

function trimRedundantDateLead(text, post) {
  let out = String(text || "").trim();
  if (!out) return out;

  const rawTitle = String(post?.title || "").trim();
  const datePart = rawTitle.split(/ [—–] /)[1]?.trim() || "";
  const yearMatch = datePart.match(/\b(\d{4})\b/);
  const year = yearMatch ? yearMatch[1] : "";
  const escapedDate = datePart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (datePart) {
    out = out.replace(new RegExp(`^on\\s+${escapedDate},?\\s*`, "i"), "");
    out = out.replace(new RegExp(`^${escapedDate},?\\s*`, "i"), "");
  }
  if (year) {
    out = out.replace(new RegExp(`^in\\s+${year},?\\s*`, "i"), "");
    out = out.replace(new RegExp(`^by\\s+${year},?\\s*`, "i"), "");
    out = out.replace(new RegExp(`^${year},?\\s*`, "i"), "");
  }

  return out.trim();
}

function buildNarrationFactBlock(post, contentItems) {
  if (contentItems && contentItems.length > 0) {
    const factA = trimRedundantDateLead(contentItems[0], post);
    const factB = contentItems[1]
      ? trimRedundantDateLead(contentItems[1], post)
      : "";
    const facts = [factA, factB].filter(Boolean);
    if (facts.length === 0) return "";
    return facts.map((item) => (item.endsWith(".") ? item : item + ".")).join(" ");
  }

  const description = trimRedundantDateLead(post.description, post);
  return description ? (description.endsWith(".") ? description : description + ".") : "";
}

export function buildNarrationScript(post, contentItems) {
  const parts = ["On this day in history.", buildNarrationIntro(post)];
  const factBlock = buildNarrationFactBlock(post, contentItems);
  if (factBlock) parts.push(factBlock);

  parts.push("Discover more at thisday.info");
  return parts.join(" ");
}

/**
 * Same logic as buildNarrationScript but returns the raw parts array
 * so video.js can match parts against word timestamps to find scene cuts.
 *
 * @param {{ title: string, description: string }} post
 * @param {string[]|null} contentItems
 * @returns {string[]}
 */
export function buildNarrationParts(post, contentItems) {
  const parts = ["On this day in history.", buildNarrationIntro(post)];
  const factBlock = buildNarrationFactBlock(post, contentItems);
  if (factBlock) parts.push(factBlock);
  parts.push("Discover more at thisday.info");
  return parts;
}

/**
 * Calls ElevenLabs /with-timestamps endpoint.
 * Returns the raw Response so the caller can handle status codes.
 */
async function callElevenLabsWithTimestamps(apiKey, script) {
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        text: script,
        model_id: MODEL_ID,
        voice_settings: {
          stability: 0.62, // steadier, documentary cadence
          similarity_boost: 0.78, // keep voice identity consistent
          style: 0.25, // lower style for e-learning clarity
          use_speaker_boost: true,
        },
      }),
    },
  );
}

/**
 * Groups flat character-level alignment into word-level chunks.
 * ElevenLabs returns per-character start/end times; we merge them into
 * words by splitting on space/punctuation boundaries.
 *
 * Returns an array of { word, start, end } objects (times in seconds).
 *
 * @param {{ characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }} alignment
 * @returns {{ word: string, start: number, end: number }[]}
 */
function alignmentToWords(alignment) {
  if (!alignment?.characters?.length) return [];

  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;

  const words = [];
  let wordChars = [];
  let wordStart = null;
  let wordEnd = null;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // Space or punctuation-only characters → flush current word
    if (/\s/.test(ch)) {
      if (wordChars.length) {
        words.push({
          word: wordChars.join(""),
          start: wordStart,
          end: wordEnd,
        });
        wordChars = [];
        wordStart = null;
        wordEnd = null;
      }
    } else {
      if (wordStart === null) wordStart = starts[i];
      wordEnd = ends[i];
      wordChars.push(ch);
    }
  }
  // Flush the last word
  if (wordChars.length) {
    words.push({ word: wordChars.join(""), start: wordStart, end: wordEnd });
  }

  return words;
}

/**
 * Calls ElevenLabs TTS (with-timestamps) and saves the audio to
 * assets/{slug}_narration.mp3.
 *
 * Returns { path, words } where:
 *   path  — local .mp3 file path (or null on failure)
 *   words — array of { word, start, end } for animated captions (or [])
 *
 * @param {string} slug
 * @param {string} script
 * @returns {Promise<{ path: string|null, words: { word: string, start: number, end: number }[] }>}
 */
export async function generateNarration(slug, script) {
  const keys = [
    process.env.ELEVENLABS_API_KEY,
    process.env.ELEVENLABS_API_KEY_2,
    process.env.ELEVENLABS_API_KEY_3,
  ].filter(Boolean);

  if (!keys.length) return { path: null, words: [] };

  mkdirSync(ASSETS_DIR, { recursive: true });
  const outputPath = join(ASSETS_DIR, `${slug}_narration.mp3`);

  console.log(`  TTS: ${script.length} chars — "${script.slice(0, 60)}..."`);

  const isQuotaError = (r) => r && (r.status === 429 || r.status === 401);

  let res = null;
  for (let i = 0; i < keys.length; i++) {
    res = await callElevenLabsWithTimestamps(keys[i], script);
    if (res.ok) break;
    if (isQuotaError(res) && i < keys.length - 1) {
      console.warn(
        `  ⚠ ElevenLabs key ${i + 1} quota reached — trying key ${i + 2}`,
      );
      await recordQuotaSignal(
        "elevenlabs",
        `key ${i + 1} quota reached (${res.status})`,
      );
    }
  }

  if (!res || !res.ok) {
    const body = res ? await res.text() : "no API key available";
    if (res && isQuotaError(res)) {
      await recordQuotaSignal(
        "elevenlabs",
        `${res.status}: ${body.slice(0, 120)}`,
      );
    }
    console.warn(
      `  ⚠ ElevenLabs error ${res?.status ?? "—"}: ${body} — video will have no narration`,
    );
    return { path: null, words: [] };
  }

  const data = await res.json();

  // Save base64-encoded audio
  const audioBase64 = data.audio_base64;
  if (!audioBase64) {
    console.warn("  ⚠ ElevenLabs: no audio_base64 in response");
    return { path: null, words: [] };
  }
  const buf = Buffer.from(audioBase64, "base64");
  await writeFile(outputPath, buf);

  // Parse word timestamps
  const words = alignmentToWords(data.alignment);
  console.log(
    `  Narration saved → ${outputPath} (${words.length} word timestamps)`,
  );

  return { path: outputPath, words };
}
