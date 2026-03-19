/**
 * AI image generation — free-tier fallback chain:
 *
 *   1. Replicate  google/nano-banana-2
 *      Fast, high-quality. Requires Replicate credits.
 *
 *   2. Hugging Face Inference API  black-forest-labs/FLUX.1-schnell
 *      Free with a free HF account token (HF_TOKEN env var).
 *      ~1000 req/day free tier — 3–4 images per video is nowhere near the limit.
 *      Fast (~10–20s per image), 1080×1920 supported natively.
 *
 *   3. Pollinations.AI  (flux model, no key)
 *      Last resort — completely keyless, but queue-limited (1 per IP).
 *
 *   4. Cloudflare Workers AI  @cf/stabilityai/stable-diffusion-xl-base-1.0
 *      Requires CF_API_TOKEN with Workers AI permission.
 */

import pLimit from "p-limit";
import { generateAIImage as generateViaReplicate } from "./replicate.js";

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

  const NEGATIVE =
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
 * Generates a historical image via Pollinations.AI (Flux model, no key).
 * Last resort — queue-limited to 1 concurrent per IP on free tier.
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} JPEG image bytes
 */
async function generateViaPollinations(prompt) {
  console.log("  → Pollinations.AI (flux, no key, last resort)...");

  const NEGATIVE =
    "deformed,ugly,bad anatomy,extra fingers,extra limbs,missing limbs," +
    "mutated hands,fused fingers,extra faces,multiple faces,two noses," +
    "cloned face,disfigured,blurry,low quality,cartoon,anime,watermark,text";

  const enriched =
    prompt +
    ", vertical portrait 9:16, dramatic cinematic lighting, highly detailed, photorealistic, anatomically correct";
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(enriched)}` +
    `?width=1080&height=1920&model=flux&nologo=true` +
    `&negative=${encodeURIComponent(NEGATIVE)}` +
    `&seed=${Math.floor(Math.random() * 99999)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Pollinations.AI error ${res.status}: ${body.slice(0, 200)}`,
    );
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
 * Generates an AI image, trying Replicate (nano-banana-2) first and
 * automatically falling back to Cloudflare Workers AI on 402 / missing token.
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} image bytes (JPEG or PNG)
 */
export async function generateAIImage(prompt) {
  // 1. Replicate (best quality, needs credits)
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      console.log("  → Replicate (nano-banana-2)...");
      return await generateViaReplicate(prompt);
    } catch (err) {
      const is402 =
        err.message.includes("402") ||
        err.message.toLowerCase().includes("credit");
      const is429 = err.message.includes("429");
      if (is402 || is429) {
        console.warn(
          `  ⚠ Replicate: ${is429 ? "rate-limited" : "insufficient credits"} — trying HuggingFace`,
        );
      } else {
        throw err;
      }
    }
  }

  // 2. Hugging Face (free tier, needs free HF_TOKEN)
  if (process.env.HF_TOKEN) {
    try {
      return await generateViaHuggingFace(prompt);
    } catch (err) {
      console.warn(
        `  ⚠ HuggingFace failed: ${err.message} — trying Pollinations.AI`,
      );
    }
  }

  // 3. Pollinations.AI (no key, but queue-limited)
  try {
    return await generateViaPollinations(prompt);
  } catch (err) {
    console.warn(
      `  ⚠ Pollinations.AI failed: ${err.message} — trying Cloudflare Workers AI`,
    );
  }

  // 4. Cloudflare Workers AI (needs CF_API_TOKEN with AI permission)
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
  // Run 2 scenes concurrently — halves wait time without tripping HuggingFace rate limits
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
