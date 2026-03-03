/**
 * AI image generation — free-tier fallback chain:
 *
 *   1. Replicate  google/nano-banana-2
 *      Fast, high-quality. Requires Replicate credits.
 *
 *   2. Cloudflare Workers AI  @cf/stabilityai/stable-diffusion-xl-base-1.0
 *      Free within daily quota (~28 images/day) using existing CF credentials.
 *      Automatic fallback when Replicate returns 402 or token is missing.
 */

import { generateAIImage as generateViaReplicate } from './replicate.js';

/**
 * Generates a historical image via Cloudflare Workers AI (SDXL-base).
 * Uses the same CF_ACCOUNT_ID + CF_API_TOKEN already configured for KV.
 *
 * @param {string} prompt
 * @returns {Promise<Buffer>} PNG image bytes
 */
async function generateViaCFWorkersAI(prompt) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken  = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CF_ACCOUNT_ID or CF_API_TOKEN not set');

  console.log('  → Cloudflare Workers AI (SDXL-base, free tier)...');

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: prompt + ', vertical portrait, dramatic lighting, detailed',
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
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      console.log('  → Replicate (nano-banana-2)...');
      return await generateViaReplicate(prompt);
    } catch (err) {
      const is402 = err.message.includes('402') || err.message.toLowerCase().includes('credit');
      if (is402) {
        console.warn('  ⚠ Replicate: insufficient credits — falling back to Cloudflare Workers AI');
      } else {
        throw err;
      }
    }
  }

  return await generateViaCFWorkersAI(prompt);
}
