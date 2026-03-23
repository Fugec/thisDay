/**
 * Video Quality Expert — gates upload with technical + AI visual checks.
 *
 * Technical checks (ffprobe — always runs):
 *   - Resolution:  exactly 1080×1920 (YouTube Shorts portrait)
 *   - Duration:    10–60 s (Shorts window)
 *   - Video codec: H.264
 *   - Audio track present
 *   - File size:   > 300 KB (encoding sanity), < 256 MB (YT limit)
 *   - Bitrate:     reasonable range
 *
 * AI visual check (Claude Haiku — runs when ANTHROPIC_API_KEY is set):
 *   - Extracts a frame at 25% of duration
 *   - Claude judges: clarity, composition, production value, engagement (1–10)
 *   - Returns a remediationHint so retries actually produce different output
 *
 * Result shape:
 *   passed          — false if any critical issue; caller should handle
 *   score           — 0–10 composite
 *   issues          — critical problems with retryable flag
 *   warnings        — non-critical (log only, never block)
 *   retryable       — true if regenerating the video is likely to fix issues
 *   remediationHint — string to prepend to scene prompts on next attempt
 *   report          — human-readable summary
 */

import ffmpeg from "fluent-ffmpeg";
import { readFileSync, statSync, unlinkSync } from "fs";

const REQ = {
  width: 1080,
  height: 1920,
  minDurationS: 10,
  maxDurationS: 60,
  targetFps: 30,
  minFileSizeKB: 300,
  maxFileSizeMB: 256,
};

const AI_FAIL_THRESHOLD = 5; // score < 5 → critical + retryable

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ffprobeAsync(path) {
  return new Promise((resolve, reject) =>
    ffmpeg.ffprobe(path, (err, data) => (err ? reject(err) : resolve(data))),
  );
}

function parseFps(rFrameRate = "") {
  const [num, den] = rFrameRate.split("/").map(Number);
  return den ? num / den : 0;
}

async function extractFrame(videoPath, atSeconds) {
  const tmp = videoPath.replace(/\.mp4$/, `_qcheck_${Date.now()}.jpg`);
  await new Promise((resolve, reject) =>
    ffmpeg(videoPath)
      .seekInput(atSeconds)
      .frames(1)
      .output(tmp)
      .outputOptions(["-q:v 2"])
      .on("end", resolve)
      .on("error", reject)
      .run(),
  );
  const buf = readFileSync(tmp);
  try { unlinkSync(tmp); } catch { /* ignore */ }
  return buf;
}

async function aiVisualCheck(videoPath, duration) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const base64 = (await extractFrame(videoPath, Math.min(duration * 0.25, 8)))
    .toString("base64");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: base64 },
          },
          {
            type: "text",
            text: `You are a YouTube Shorts production quality reviewer for a history channel.

Rate this video frame 1–10 for upload readiness. Then give a concrete improvement directive if score < 8.

Score criteria:
- 9–10: cinematic, sharp, great composition, highly engaging
- 7–8:  good quality, minor issues, upload-ready
- 5–6:  acceptable but needs improvement (warn, still upload)
- 1–4:  blurry, artifacts, black frame, wrong composition, encoding error (block + retry)

AUTOMATIC score 1 (block + retry) if ANY of these are present:
- Deformed or bad anatomy (extra fingers, extra limbs, missing limbs, fused fingers, mutated hands)
- Extra or duplicate faces, two noses, three eyes, cloned face
- Watermark, visible text, logo, signature, or caption overlaid on the image
- Cartoon, anime, illustration, painting, or drawing style (must be photorealistic)
- Severely blurry, low quality, or oversaturated
- Duplicate subjects or mirrored figures

If score < 8, write a "fix" directive that a text-to-image model can use to generate a better replacement frame. Be specific: lighting, style, composition, subject clarity.

Respond ONLY with valid JSON (no markdown):
{
  "score": <1-10>,
  "reason": "<max 15 words describing the issue>",
  "fix": "<max 30 words — specific prompt addition to improve the next attempt, or null if score >= 8>"
}`,
          },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API HTTP ${res.status}: ${body.slice(0, 100)}`);
  }

  const data = await res.json();
  const text = (data.content?.[0]?.text ?? "").trim();
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error(`Unparseable AI response: ${text.slice(0, 100)}`);
  const parsed = JSON.parse(match[0]);
  return {
    score: Number(parsed.score),
    reason: parsed.reason ?? "",
    fix: parsed.fix ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs full quality check on a generated video.
 *
 * @param {string} videoPath
 * @returns {Promise<{
 *   passed:          boolean,   false = do not upload
 *   score:           number,    0–10 composite
 *   issues:          string[],  critical failures
 *   warnings:        string[],  non-critical observations
 *   retryable:       boolean,   true = regenerating video may fix the issue
 *   remediationHint: string|null, prepend to scene prompts on next attempt
 *   aiScore:         number|null,
 *   aiReason:        string|null,
 *   report:          string,    human-readable summary
 * }>}
 */
export async function checkVideoQuality(videoPath) {
  const issues = [];
  const warnings = [];
  let score = 10;
  let retryable = false;
  const remediationParts = [];

  // ── File size ─────────────────────────────────────────────────────────────
  let fileStat;
  try {
    fileStat = statSync(videoPath);
  } catch (err) {
    return build(false, 0, [`File not found: ${err.message}`], [],
      false, null, null, null, 0);
  }

  const fileSizeKB = fileStat.size / 1024;
  const fileSizeMB = fileStat.size / (1024 * 1024);

  if (fileSizeKB < REQ.minFileSizeKB) {
    issues.push(`File too small: ${fileSizeKB.toFixed(0)} KB — encoding likely failed`);
    score -= 6;
    retryable = true;
    remediationParts.push("high resolution, richly detailed scene, sharp focus");
  }
  if (fileSizeMB > REQ.maxFileSizeMB) {
    issues.push(`File too large: ${fileSizeMB.toFixed(0)} MB — exceeds YouTube 256 MB limit`);
    score -= 4;
    // Not retryable — encoding settings issue, not image quality
  }

  // ── FFprobe ───────────────────────────────────────────────────────────────
  let metadata;
  try {
    metadata = await ffprobeAsync(videoPath);
  } catch (err) {
    issues.push(`FFprobe analysis failed: ${err.message}`);
    return build(false, 0, issues, warnings, true, null, null, null, 0);
  }

  const videoStream = metadata.streams.find((s) => s.codec_type === "video");
  const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
  const duration = parseFloat(metadata.format.duration ?? 0);
  const bitrate = parseInt(metadata.format.bit_rate ?? 0);

  // Duration — not retryable (set by narration length, not image quality)
  if (duration < REQ.minDurationS) {
    issues.push(`Too short: ${duration.toFixed(1)}s (Shorts min ${REQ.minDurationS}s) — check narration`);
    score -= 6;
  } else if (duration > REQ.maxDurationS) {
    issues.push(`Too long: ${duration.toFixed(1)}s (Shorts max ${REQ.maxDurationS}s) — check narration`);
    score -= 6;
  }

  // Resolution — not retryable (code bug if wrong)
  if (!videoStream) {
    issues.push("No video stream found");
    score -= 8;
  } else {
    if (videoStream.width !== REQ.width || videoStream.height !== REQ.height) {
      issues.push(
        `Wrong resolution: ${videoStream.width}×${videoStream.height} — must be ${REQ.width}×${REQ.height} (code issue, not retryable)`,
      );
      score -= 5;
      // retryable stays false — this is a code bug
    }
    if (!(videoStream.codec_name ?? "").includes("h264")) {
      warnings.push(`Non-H264 codec: ${videoStream.codec_name}`);
      score -= 1;
    }
    const fps = parseFps(videoStream.r_frame_rate);
    if (Math.round(fps) !== REQ.targetFps) {
      warnings.push(`FPS: ${fps.toFixed(1)} (expected ${REQ.targetFps})`);
      score -= 0.5;
    }
  }

  if (bitrate > 0 && bitrate < 400_000) {
    warnings.push(`Low bitrate: ${(bitrate / 1000).toFixed(0)} kbps — may look compressed`);
    score -= 1;
    retryable = true;
    remediationParts.push("photorealistic highly detailed, avoid flat or uniform backgrounds");
  }

  if (!audioStream) {
    warnings.push("No audio track — silent video");
    score -= 1;
  }

  // ── AI visual check ───────────────────────────────────────────────────────
  let aiScore = null;
  let aiReason = null;
  let aiFix = null;

  if (videoStream && duration > 0) {
    try {
      console.log("  → AI visual quality check (Claude Haiku)...");
      ({ score: aiScore, reason: aiReason, fix: aiFix } =
        await aiVisualCheck(videoPath, duration));
      console.log(`  AI frame score: ${aiScore}/10 — ${aiReason}`);
      if (aiFix) console.log(`  Remediation:    ${aiFix}`);

      if (aiScore < AI_FAIL_THRESHOLD) {
        issues.push(`AI quality: ${aiScore}/10 — "${aiReason}" (min ${AI_FAIL_THRESHOLD}/10 to publish)`);
        score -= Math.min(4, (AI_FAIL_THRESHOLD - aiScore) * 1.5);
        retryable = true;
        if (aiFix) remediationParts.push(aiFix);
      } else if (aiScore < 7) {
        warnings.push(`AI quality: ${aiScore}/10 — "${aiReason}" (acceptable, consider improving)`);
        score -= 0.5;
        if (aiFix) remediationParts.push(aiFix);
      }
    } catch (err) {
      warnings.push(`AI visual check skipped: ${err.message}`);
    }
  }

  // ── Build result ──────────────────────────────────────────────────────────
  score = Math.max(0, Math.round(Math.min(10, score) * 10) / 10);
  const passed = issues.length === 0;
  const remediationHint = remediationParts.length
    ? remediationParts.join(", ")
    : null;

  return build(
    passed, score, issues, warnings,
    retryable && !passed, // only flag retryable if there's actually a failure
    remediationHint,
    aiScore, aiReason, duration, fileSizeMB, videoStream, audioStream,
  );
}

function build(passed, score, issues, warnings, retryable, remediationHint,
  aiScore, aiReason, duration, fileSizeMB = 0, videoStream = null, audioStream = null) {

  const statusLine = passed
    ? `PASS  score=${score}/10`
    : `FAIL  score=${score}/10  (${issues.length} critical, retryable=${retryable})`;

  const fps = videoStream ? parseFps(videoStream.r_frame_rate) : 0;
  const lines = [
    statusLine,
    `  File:     ${typeof fileSizeMB === "number" ? fileSizeMB.toFixed(1) : "?"} MB`,
    `  Duration: ${typeof duration === "number" ? duration.toFixed(1) : "?"}s`,
    videoStream
      ? `  Video:    ${videoStream.width}×${videoStream.height}  ${fps.toFixed(0)} fps  ${videoStream.codec_name}`
      : "  Video:    MISSING",
    audioStream ? `  Audio:    ${audioStream.codec_name}` : "  Audio:    NONE",
    aiScore !== null
      ? `  AI judge: ${aiScore}/10 — ${aiReason}`
      : "  AI judge: skipped (no ANTHROPIC_API_KEY)",
  ];
  if (remediationHint) lines.push(`  Fix hint: ${remediationHint}`);
  if (issues.length) { lines.push("  Issues:"); issues.forEach((i) => lines.push(`    ✗ ${i}`)); }
  if (warnings.length) { lines.push("  Warnings:"); warnings.forEach((w) => lines.push(`    ⚠ ${w}`)); }

  return { passed, score, issues, warnings, retryable, remediationHint, aiScore, aiReason, report: lines.join("\n") };
}
