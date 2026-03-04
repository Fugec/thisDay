/**
 * ElevenLabs Text-to-Speech helper.
 *
 * Generates a documentary-style voiceover narration for each blog post
 * using text from the post's "Did You Know?" section (newer posts) or
 * "Quick Facts" table (older posts).
 *
 * Voice: Brian — deep, resonant, comforting.
 * Model: eleven_turbo_v2_5 — lowest character cost on the free plan.
 *
 * Free plan: 10 000 chars/month.
 * Schedule: 1 video every 3 days ≈ 10 videos/month.
 * Avg narration: ~600 chars → ~6 000 chars/month (well within free tier).
 *
 * Env var required: ELEVENLABS_API_KEY
 */

import { writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { join } from 'path';

const ASSETS_DIR = './assets';
const VOICE_ID   = 'nPczCjzI2devNBz1zQrb'; // Brian — deep, resonant, comforting
const MODEL_ID   = 'eleven_turbo_v2_5';      // fastest + lowest character cost

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
export function buildNarrationScript(post, contentItems) {
  const title = post.title.replace(/ [—–] /g, ', ');
  const parts  = ['On this day in history.', title + '.'];

  if (contentItems && contentItems.length > 0) {
    parts.push('Did you know?');
    contentItems.forEach(item => parts.push(item.endsWith('.') ? item : item + '.'));
  } else {
    parts.push(post.description + '.');
  }

  parts.push('Discover more at thisday dot info.');
  return parts.join(' ');
}

/**
 * Calls ElevenLabs TTS and saves the audio to assets/{slug}_narration.mp3.
 * Returns the local file path, or null on failure (graceful degradation).
 *
 * @param {string} slug
 * @param {string} script
 * @returns {Promise<string|null>}
 */
export async function generateNarration(slug, script) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  mkdirSync(ASSETS_DIR, { recursive: true });
  const outputPath = join(ASSETS_DIR, `${slug}_narration.mp3`);

  console.log(`  TTS: ${script.length} chars — "${script.slice(0, 60)}..."`);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        Accept:         'audio/mpeg',
      },
      body: JSON.stringify({
        text:     script,
        model_id: MODEL_ID,
        voice_settings: {
          stability:         0.55,
          similarity_boost:  0.75,
          style:             0.30,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.warn(`  ⚠ ElevenLabs error ${res.status}: ${body} — video will have no narration`);
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buf);
  console.log(`  Narration saved → ${outputPath}`);
  return outputPath;
}
