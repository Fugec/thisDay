/**
 * WAN 2.2 Image-to-Video via HuggingFace ZeroGPU Space.
 * Space: https://huggingface.co/spaces/r3gm/wan2-2-fp8da-aoti-preview
 *
 * Animates a still image into a short cinematic MP4 clip (~3.5s at 16fps).
 * Uses Gradio REST API — no extra npm package needed, just native fetch.
 *
 * Requirements:
 *   HF_TOKEN — needed to access ZeroGPU (free HF account)
 *
 * Throws on any failure so callers can fall back to Ken Burns gracefully.
 */

const SPACE = "https://r3gm-wan2-2-fp8da-aoti-preview.hf.space";

// Defaults matching the Space UI
const CLIP_DURATION = 3.5; // seconds
const CLIP_FPS = 16;
const INFERENCE_STEPS = 6; // fast — default from Space
const NEGATIVE =
  "静止, blur, watermark, text, logo, distortion, flickering, low quality";

// 3 min — ZeroGPU queue can be slow at peak times
const POLL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a cinematic motion prompt from the original scene description.
 * Strips long detail after the first clause to keep the motion prompt focused.
 */
function buildMotionPrompt(scenePrompt) {
  const subject = scenePrompt
    .split(/[.,]/)[0]
    .replace(/ultra-realistic\s+/i, "")
    .trim()
    .slice(0, 120);
  return (
    `${subject}, cinematic camera movement, dramatic atmospheric motion, ` +
    `smooth natural animation, photorealistic, documentary film style`
  );
}

/**
 * Uploads image bytes to the Gradio Space and returns the remote file path.
 */
async function uploadImage(imageBuffer, token) {
  const form = new FormData();
  form.append(
    "files",
    new Blob([imageBuffer], { type: "image/jpeg" }),
    "scene.jpg",
  );

  const res = await fetch(`${SPACE}/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed HTTP ${res.status}: ${body.slice(0, 150)}`);
  }

  const paths = await res.json();
  if (!Array.isArray(paths) || !paths[0])
    throw new Error("Upload response missing file path");
  return paths[0];
}

/**
 * Submits a generate_video job and returns the event_id.
 */
async function submitJob(imagePath, motionPrompt, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Input order matches the Gradio component IDs:
  // id=7 image | id=12 last-image | id=8 prompt | id=17 steps | id=13 neg |
  // id=9 dur | id=18 gs1 | id=19 gs2 | id=15 seed | id=16 rand-seed |
  // id=14 quality | id=20 scheduler | id=21 flow-shift | id=10 fps | id=22 display
  const res = await fetch(`${SPACE}/call/generate_video`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: [
        { path: imagePath, orig_name: "scene.jpg", mime_type: "image/jpeg" },
        null, // last image (optional)
        motionPrompt,
        INFERENCE_STEPS,
        NEGATIVE,
        CLIP_DURATION,
        1, // guidance scale high-noise
        1, // guidance scale low-noise
        Math.floor(Math.random() * 99999), // seed
        false, // randomize seed (we set our own)
        6, // video quality (1–10)
        "UniPCMultistep",
        3.0, // flow shift
        CLIP_FPS,
        false, // display result in UI
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Submit failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json.event_id) throw new Error("No event_id in submit response");
  return json.event_id;
}

/**
 * Polls the SSE stream for the completed event and downloads the MP4.
 */
async function pollAndDownload(eventId, token) {
  const res = await fetch(`${SPACE}/call/generate_video/${eventId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });

  if (!res.ok)
    throw new Error(`Poll failed HTTP ${res.status}`);

  const text = await res.text();

  // Parse SSE: look for "event: complete" followed by "data: [...]"
  const completeMatch = text.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*?\])\s*\n/);
  if (!completeMatch) {
    const errMatch = text.match(/event:\s*error\s*\ndata:\s*(.*)/);
    throw new Error(
      `WAN I2V incomplete: ${errMatch ? errMatch[1].slice(0, 200) : "no complete event"}`,
    );
  }

  const outputs = JSON.parse(completeMatch[1]);
  const videoOutput = Array.isArray(outputs) ? outputs[0] : outputs;
  const rawUrl = videoOutput?.url ?? videoOutput?.path ?? null;
  if (!rawUrl) throw new Error("No video URL in complete event");

  const videoUrl = rawUrl.startsWith("http")
    ? rawUrl
    : `${SPACE}/file=${rawUrl}`;

  const dlRes = await fetch(videoUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(60_000),
  });
  if (!dlRes.ok)
    throw new Error(`MP4 download failed HTTP ${dlRes.status}`);

  return Buffer.from(await dlRes.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Animates a still image using WAN 2.2 I2V (ZeroGPU HF Space).
 * Returns an MP4 Buffer (~3.5s at 16fps).
 *
 * Requires HF_TOKEN in the environment (free HuggingFace account).
 * Throws on failure — callers should catch and fall back to Ken Burns.
 *
 * @param {Buffer} imageBuffer  JPEG/PNG scene image to animate
 * @param {string} scenePrompt  Original scene description (used for motion prompt)
 * @returns {Promise<Buffer>}   MP4 video bytes
 */
export async function animateImage(imageBuffer, scenePrompt) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN not set — WAN I2V skipped");

  const motionPrompt = buildMotionPrompt(scenePrompt);
  console.log(`    → WAN 2.2 I2V: animating scene...`);

  const imagePath = await uploadImage(imageBuffer, token);
  const eventId = await submitJob(imagePath, motionPrompt, token);
  const videoBuffer = await pollAndDownload(eventId, token);

  console.log(
    `    ✓ WAN 2.2 I2V: ${(videoBuffer.length / 1024).toFixed(0)}kb MP4`,
  );
  return videoBuffer;
}

// Constants exported for use in video.js (FFmpeg pipeline)
export const WAN_CLIP_DURATION = CLIP_DURATION;
export const WAN_CLIP_FPS = CLIP_FPS;
