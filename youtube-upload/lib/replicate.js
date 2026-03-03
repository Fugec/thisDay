/**
 * Replicate API — AI image generation via google/nano-banana-2.
 *
 * Free-tier friendly: uses low guidance_scale (CFG) and fewer inference steps
 * to stay within daily free limits while still producing usable images.
 *
 * @param {string} prompt  - Text prompt (will be truncated to 500 chars)
 * @returns {Promise<Buffer>}  Raw image bytes (JPEG or PNG)
 */
export async function generateAIImage(prompt) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN not set');

  // Keep prompt short — nano models work well with concise prompts
  const truncatedPrompt = prompt.slice(0, 500);

  console.log(`  Replicate prompt: "${truncatedPrompt.slice(0, 80)}..."`);

  // Submit prediction — Prefer: wait makes it synchronous (up to 60 s)
  const res = await fetch(
    'https://api.replicate.com/v1/models/google/nano-banana-2/predictions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({
        input: {
          prompt: truncatedPrompt,
          aspect_ratio: '9:16',      // vertical for YouTube Shorts
          guidance_scale: 3.5,       // low CFG = faster + stays within free quota
          num_inference_steps: 20,   // fewer steps = cheaper
        },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Replicate API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  // Handle still-processing predictions (if the 60 s wait timed out)
  if (data.status && data.status !== 'succeeded') {
    throw new Error(
      `Replicate prediction not ready (status: ${data.status}). ` +
      `ID: ${data.id}. Try again or increase timeout.`,
    );
  }

  const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!outputUrl) {
    throw new Error(`No output URL from Replicate: ${JSON.stringify(data)}`);
  }

  // Download the generated image
  const imgRes = await fetch(outputUrl);
  if (!imgRes.ok) throw new Error(`Failed to download AI image: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}
