/**
 * AI image generation — provider chain:
 *
 *   1. Pollinations.AI  gen.pollinations.ai  (flux → turbo → nanobanana)
 *      Free tier keyless, or authenticated via POLLINATIONS_API_KEY for higher limits.
 *      New API: https://gen.pollinations.ai/image/{prompt}
 *      Available models: flux, turbo, gptimage, kontext, seedream, nanobanana, nanobanana-pro
 *
 *   2. Hugging Face Inference API  black-forest-labs/FLUX.1-schnell
 *      Free with a free HF account token (HF_TOKEN env var).
 *      ~1000 req/day free tier — 3–4 images per video is nowhere near the limit.
 *      Fast (~10–20s per image), 1080×1920 supported natively.
 *
 *   3. Cloudflare Workers AI  @cf/stabilityai/stable-diffusion-xl-base-1.0
 *      Requires CF_API_TOKEN with Workers AI permission.
 */

import pLimit from "p-limit";
// import { animateImage } from "./wan-i2v.js"; // I2V disabled — re-enable to use WAN animation

// Free-tier Pollinations models only — tested 2026-03-21 (DO NOT add zimage/klein/flux-klein/nanobanana — cost credits)
const POLLINATIONS_MODELS = ["flux-2-dev", "flux", "z-image-turbo"];

const NEGATIVE =
  "deformed,ugly,bad anatomy,extra fingers,extra limbs,missing limbs," +
  "mutated hands,fused fingers,extra faces,multiple faces,two noses," +
  "cloned face,disfigured,blurry,low quality,cartoon,anime,watermark,text";

/**
 * Generates an image via Pollinations.AI using the specified model.
 * Uses the new gen.pollinations.ai endpoint with optional API key auth.
 *
 * @param {string} prompt
 * @param {string} model  e.g. "flux", "turbo", "nanobanana"
 * @returns {Promise<Buffer>} image bytes
 */
async function generateViaPollinationsModel(prompt, model) {
  const apiKey = process.env.POLLINATIONS_API_KEY;

  const enriched =
    prompt +
    ", vertical portrait 9:16, dramatic cinematic lighting, highly detailed, photorealistic, anatomically correct";

  const params = new URLSearchParams({
    width: "1080",
    height: "1920",
    model,
    nologo: "true",
    negative: NEGATIVE,
    seed: String(Math.floor(Math.random() * 99999)),
  });

  if (apiKey) params.set("key", apiKey);

  const url =
    `https://gen.pollinations.ai/image/${encodeURIComponent(enriched)}?${params}`;

  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Pollinations.AI [${model}] error ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Tries Pollinations models in order: flux → turbo → nanobanana.
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} image bytes
 */
async function generateViaPollinations(prompt) {
  let lastErr;
  for (const model of POLLINATIONS_MODELS) {
    try {
      console.log(`  → Pollinations.AI (${model})...`);
      return await generateViaPollinationsModel(prompt, model);
    } catch (err) {
      console.warn(`  ⚠ Pollinations [${model}] failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Generates a historical image via Hugging Face Inference API (FLUX.1-schnell).
 * Requires a free HF account: https://huggingface.co/join
 * Generate a token at: https://huggingface.co/settings/tokens (read access only)
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} image bytes
 */
async function generateViaHuggingFace(prompt) {
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) throw new Error("HF_TOKEN not set");

  console.log("  → Hugging Face (FLUX.1-schnell, free tier)...");

  const NEGATIVE_HF =
    "deformed, ugly, bad anatomy, extra fingers, extra limbs, missing limbs, " +
    "mutated hands, fused fingers, too many fingers, extra faces, multiple faces, " +
    "two noses, three eyes, cloned face, disfigured, malformed, blurry, " +
    "low quality, worst quality, cartoon, anime, illustration, painting, drawing, " +
    "watermark, text, logo, signature, oversaturated, duplicate";

  const res = await fetch(
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfToken}`,
        "Content-Type": "application/json",
        "x-use-cache": "0",
      },
      body: JSON.stringify({
        inputs:
          prompt +
          ", vertical 9:16 portrait, shot on 35mm film, Kodak Portra 400, photojournalism, highly detailed, anatomically correct",
        parameters: { width: 1080, height: 1920, negative_prompt: NEGATIVE_HF },
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
 *   1. Pollinations.AI (flux → turbo → nanobanana)
 *   2. Hugging Face (FLUX.1-schnell)
 *   3. Cloudflare Workers AI (SDXL-base)
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} image bytes (JPEG or PNG)
 */
export async function generateAIImage(prompt) {
  // 1. Pollinations.AI (primary — keyless or authenticated)
  try {
    return await generateViaPollinations(prompt);
  } catch (err) {
    console.warn(
      `  ⚠ Pollinations.AI exhausted all models: ${err.message} — trying HuggingFace`,
    );
  }

  // 2. Hugging Face (free tier fallback, needs HF_TOKEN)
  if (process.env.HF_TOKEN) {
    try {
      return await generateViaHuggingFace(prompt);
    } catch (err) {
      console.warn(
        `  ⚠ HuggingFace failed: ${err.message} — trying Cloudflare Workers AI`,
      );
    }
  }

  // 3. Cloudflare Workers AI (last resort, needs CF_API_TOKEN with AI permission)
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
