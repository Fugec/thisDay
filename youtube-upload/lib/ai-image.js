/**
 * AI image generation — provider chain:
 *
 *   1. Hugging Face Inference API  black-forest-labs/FLUX.1-schnell  (HF_TOKEN)
 *      Free tier with a free HF account token.
 *      Fast (~10–20s per image), 1080×1920 supported natively.
 *
 *   1b. Hugging Face Inference API  (HF_TOKEN_2) — fallback account
 *      Same model, second free-tier account for when HF_TOKEN hits monthly quota (402).
 *      Rotate accounts when one is depleted.
 *
 *   2. Cloudflare Workers AI  @cf/stabilityai/stable-diffusion-xl-base-1.0
 *      Last resort. Requires CF_API_TOKEN with Workers AI permission.
 *      Note: negative_prompt is not supported by SDXL-base on CF (silently ignored).
 */

import pLimit from "p-limit";
// import { animateImage } from "./wan-i2v.js"; // I2V disabled — re-enable to use WAN animation

const NEGATIVE =
  "deformed, ugly, bad anatomy, extra fingers, extra limbs, missing limbs, " +
  "mutated hands, fused fingers, too many fingers, extra faces, multiple faces, " +
  "two noses, three eyes, cloned face, disfigured, malformed, blurry, " +
  "low quality, worst quality, cartoon, anime, illustration, painting, drawing, " +
  "watermark, text, logo, signature, oversaturated, duplicate";

/**
 * Generates a historical image via Hugging Face Inference API (FLUX.1-schnell).
 * Requires a free HF account: https://huggingface.co/join
 * Generate a token at: https://huggingface.co/settings/tokens (read access only)
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} image bytes
 */
async function generateViaHuggingFace(prompt, token) {
  if (!token) throw new Error("HF token not set");

  console.log("  → Hugging Face (FLUX.1-schnell, free tier)...");

  const res = await fetch(
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-use-cache": "0",
      },
      body: JSON.stringify({
        inputs:
          prompt +
          ", vertical 9:16 portrait, shot on 35mm film, Kodak Portra 400, photojournalism, highly detailed, anatomically correct",
        parameters: { width: 1080, height: 1920, negative_prompt: NEGATIVE },
      }),
      signal: AbortSignal.timeout(90_000),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HuggingFace error ${res.status}: ${body.slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Generates a historical image via Cloudflare Workers AI (SDXL-base).
 * Uses the same CF_ACCOUNT_ID + CF_API_TOKEN already configured for KV.
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} PNG image bytes
 */
async function generateViaCFWorkersAI(prompt) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken)
    throw new Error("CF_ACCOUNT_ID or CF_API_TOKEN not set");

  console.log("  → Cloudflare Workers AI (SDXL-base, free tier)...");

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: prompt + ", vertical portrait, dramatic lighting, detailed",
      negative_prompt: NEGATIVE,
      num_steps: 20,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare Workers AI error ${res.status}: ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Generates an AI image, trying providers in order:
 *   1. Hugging Face (FLUX.1-schnell) — HF_TOKEN then HF_TOKEN_2
 *   2. Cloudflare Workers AI (SDXL-base) — needs CF_API_TOKEN with AI permission
 *
 * If all providers fail, the caller falls back to Wikipedia images.
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} image bytes (JPEG or PNG)
 */
export async function generateAIImage(prompt) {
  // 1. Hugging Face — try HF_TOKEN, then HF_TOKEN_2 as fallback
  for (const [label, token] of [["HF_TOKEN", process.env.HF_TOKEN], ["HF_TOKEN_2", process.env.HF_TOKEN_2]]) {
    if (!token) continue;
    try {
      return await generateViaHuggingFace(prompt, token);
    } catch (err) {
      console.warn(`  ⚠ HuggingFace [${label}] failed: ${err.message}`);
    }
  }

  // 2. Cloudflare Workers AI (needs CF_API_TOKEN with Workers AI permission)
  return await generateViaCFWorkersAI(prompt);
}

/**
 * Generates multiple AI images in parallel — one prompt per scene.
 * Returns null for any slot that fails so the caller can fall back gracefully.
 *
 * @param {string[]} prompts
 * @returns {Promise<(Buffer|null)[]>}
 */
export async function generateAIImageBatch(prompts) {
  // Run 2 scenes concurrently — halves wait time without tripping rate limits
  const limit = pLimit(2);
  const results = await Promise.all(
    prompts.map((prompt, i) =>
      limit(async () => {
        console.log(
          `  → Scene ${i + 1}/${prompts.length}: "${prompt.slice(0, 70)}..."`,
        );
        try {
          return await generateAIImage(prompt);
        } catch (err) {
          console.warn(`  ⚠ Scene ${i + 1} AI image failed: ${err.message}`);
          return null;
        }
      }),
    ),
  );
  return results;
}

/**
 * Generates AI scenes — still images with Ken Burns applied in FFmpeg.
 * I2V animation (WAN 2.2) is disabled; re-enable by uncommenting the
 * animateImage import and restoring Phase 2 below.
 *
 * @param {string[]} prompts
 * @returns {Promise<({ buffer: Buffer, isVideo: boolean } | null)[]>}
 */
export async function generateAISceneBatch(prompts) {
  const limit = pLimit(2);
  const scenes = await Promise.all(
    prompts.map((prompt, i) =>
      limit(async () => {
        console.log(
          `  → Scene ${i + 1}/${prompts.length}: "${prompt.slice(0, 70)}..."`,
        );
        try {
          const buffer = await generateAIImage(prompt);
          return { buffer, isVideo: false };
        } catch (err) {
          console.warn(`  ⚠ Scene ${i + 1} image failed: ${err.message}`);
          return null;
        }
      }),
    ),
  );
  return scenes;

  /* I2V Phase 2 — uncomment to re-enable WAN 2.2 animation:
  const imageBuffers = scenes.map(s => s?.buffer ?? null);
  const animated = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    if (!buf) { animated.push(null); continue; }
    try {
      const videoBuffer = await animateImage(buf, prompts[i]);
      animated.push({ buffer: videoBuffer, isVideo: true });
    } catch (err) {
      console.warn(`  ⚠ Scene ${i + 1} WAN I2V skipped (${err.message}) — Ken Burns fallback`);
      animated.push({ buffer: buf, isVideo: false });
    }
  }
  return animated;
  */
}
