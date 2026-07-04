/**
 * Model auto-resolver for Groq and HuggingFace.
 * Queries each provider's models API once per pipeline run, picks the best
 * available free model, and caches the result for the process lifetime.
 *
 * Groq fallbacks:
 *   text:   llama-3.3-70b-versatile
 *   vision: meta-llama/llama-4-scout-17b-16e-instruct (Groq shutdown 2026-07-17;
 *           NVIDIA NIM meta/llama-4-maverick-17b-128e-instruct is the fallback)
 *
 * HuggingFace fallback:
 *   text:   meta-llama/Llama-3.3-70B-Instruct  (unified router.huggingface.co/v1 — same model as Groq)
 */

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

// E2E lesson (2026-07-03, see js/shared/ai-call.js for the full writeup):
// llama-3.3-70b-versatile stays primary even though Groq announced its
// 2026-08-16 shutdown. It is not excluded here — a full local publish E2E
// with gpt-oss-120b as primary hit repeated Groq 413 "Request too large" on
// EVERY request, because this account's TPM allocation for gpt-oss-120b/20b
// and qwen3.6-27b is only 8000 tokens/minute (6000 for qwen3-32b) vs 12000
// for llama-3.3-70b-versatile. Real payloads (source context, prompt review,
// image-review vision prompts) can exceed 8000 tokens in one request; a
// small-sample A/B test never reveals this because it never uses a large
// enough payload. Do not re-promote gpt-oss/qwen3 above llama-3.3 without
// re-testing against a real, large payload — not just a short A/B sample.
export const GROQ_TEXT_MODEL_DEFAULT   = "llama-3.3-70b-versatile";
export const GROQ_VISION_MODEL_DEFAULT = "meta-llama/llama-4-scout-17b-16e-instruct";

// Confirmed free text models on Groq free tier — checked in priority order.
// Only models on this list are eligible; paid/preview/namespaced models are
// never selected even if they appear in the API response.
// Groq shutdowns (https://console.groq.com/docs/deprecations):
//   llama-3.3-70b-versatile + llama-3.1-8b-instant → decommission 2026-08-16;
//   llama-3.1-70b-versatile / llama-3-70b-8192 are already gone from the catalog.
// Still first-choice until Groq's own catalog marks it inactive — see the
// E2E lesson above. gpt-oss/qwen3.6 are strong fallback tiers (lower TPM
// budget on this account, but fine for smaller per-call payloads).
// Update this list when Groq adds new free models.
const FREE_TEXT_MODEL_PRIORITY = [
  "llama-3.3-70b-versatile", // primary — proven at real payload scale, 12000 TPM
  "openai/gpt-oss-120b",     // fallback — 8000 TPM on this account
  "qwen/qwen3.6-27b",        // fallback — 8000 TPM (needs reasoning_format hidden + reasoning_effort none)
  "openai/gpt-oss-20b",      // lighter fallback, free
  "qwen/qwen3-32b",          // additional fallback, free (6000 TPM)
];

// Confirmed free vision-capable models on Groq — checked in priority order.
// llama-4-scout is Groq's ONLY remaining vision model and decommissions
// 2026-07-17 with no announced Groq vision successor. verifyImageSubject in
// ai-image.js falls back to NVIDIA NIM (resolveNvidiaVisionModel below) and
// only fails open when neither provider can answer.
// Add new free vision-capable Groq models here as they become available.
const FREE_VISION_MODEL_PRIORITY = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
];

// ---------------------------------------------------------------------------
// NVIDIA NIM vision resolver — fallback once Groq loses vision (2026-07-17)
// ---------------------------------------------------------------------------

export const NVIDIA_VISION_MODEL_DEFAULT = "meta/llama-4-maverick-17b-128e-instruct";

// Vision-capable models confirmed on NVIDIA NIM (integrate.api.nvidia.com,
// docs.api.nvidia.com reference pages, checked 2026-07-03), best first.
// Maverick (128-expert MoE) outranks the retiring Groq scout (16 experts)
// and shares the Llama 4 family, so the existing prompt carries over.
const NVIDIA_VISION_MODEL_PRIORITY = [
  "meta/llama-4-maverick-17b-128e-instruct", // Llama 4 MoE 128e — strongest
  "meta/llama-3.2-90b-vision-instruct",      // large dense VLM
  "google/gemma-3-27b-it",                   // multimodal (896x896 normalized)
];

let _nvidiaVisionCache = null;

/**
 * Resolves the best available NVIDIA NIM vision model ID.
 * Queries /v1/models once (needs NVIDIA_API_KEY) and caches for the process
 * lifetime. Falls back to the hardcoded default when the key is missing or
 * the catalog query fails.
 *
 * @returns {Promise<string>}
 */
export async function resolveNvidiaVisionModel() {
  if (_nvidiaVisionCache) return _nvidiaVisionCache;
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    return (_nvidiaVisionCache = NVIDIA_VISION_MODEL_DEFAULT);
  }
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = new Set((data.data ?? []).map((m) => m.id).filter(Boolean));
    const picked =
      NVIDIA_VISION_MODEL_PRIORITY.find((id) => ids.has(id)) ??
      NVIDIA_VISION_MODEL_DEFAULT;
    console.log(`  ✓ NVIDIA vision model: ${picked}`);
    return (_nvidiaVisionCache = picked);
  } catch (err) {
    console.warn(`  ⚠ NVIDIA vision model check failed (${err.message}) — using default`);
    return (_nvidiaVisionCache = NVIDIA_VISION_MODEL_DEFAULT);
  }
}

/**
 * Reasoning-model request controls for Groq chat completions. gpt-oss and
 * qwen3 models emit chain-of-thought by default; without these params qwen
 * returns a literal <think>…</think> block inside message.content and gpt-oss
 * spends extra completion tokens on reasoning. Gated per model — never sent
 * to non-reasoning models. Mirrors groqReasoningParams in js/shared/ai-call.js
 * (worker runtime); keep the two in sync.
 *
 * CRITICAL (A/B verified 2026-07-03): qwen3 needs reasoning_effort "none" IN
 * ADDITION to reasoning_format "hidden" — hidden alone lets the invisible
 * reasoning consume the whole completion budget and content comes back EMPTY.
 *
 * @param {string} modelId
 * @returns {object} Extra body params ({} for non-reasoning models)
 */
export function groqReasoningParams(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("gpt-oss")) return { reasoning_effort: "low" };
  if (/qwen.?3/.test(id)) return { reasoning_format: "hidden", reasoning_effort: "none" };
  return {};
}

/**
 * gpt-oss (reasoning_effort "low") still spends completion tokens on
 * reasoning before the answer, so a budget sized for llama-3.3 can truncate
 * output on gpt-oss. Mirrors reasoningCompletionBudget in
 * js/shared/ai-call.js (worker runtime); keep the two in sync.
 *
 * @param {string} modelId
 * @param {number} maxTokens
 * @returns {number}
 */
export function reasoningCompletionBudget(modelId, maxTokens) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("gpt-oss")) return maxTokens + 2048;
  return maxTokens;
}

/**
 * Per-model Groq TPM (tokens/minute) ceiling, live-verified on this account
 * 2026-07-03. Groq-specific — do NOT reuse for HuggingFace, which runs its
 * own unrelated rate-limit system. Mirrors groqModelTpmLimit in
 * js/shared/ai-call.js; keep the two in sync. llama-3.3-70b-versatile
 * (12000 TPM, the primary model) normally has enough headroom, but very large
 * prompts still get capped before Groq rejects the request.
 *
 * @param {string} modelId
 * @returns {number|null}
 */
function groqModelTpmLimit(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("llama-3.3-70b-versatile")) return 12000;
  if (id.includes("gpt-oss")) return 8000;
  if (id.includes("qwen3.6")) return 8000;
  if (/qwen.?3/.test(id)) return 6000;
  if (id.includes("llama-3.1-8b")) return 6000;
  return null;
}

const _GROQ_TPM_SAFETY_MARGIN = 2000;
const _GROQ_PROMPT_ESTIMATE_PADDING_TOKENS = 256;

function messageContentCharCount(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    const content = message?.content;
    return total + (typeof content === "string" ? content.length : JSON.stringify(content ?? "").length);
  }, 0);
}

export function estimatePromptTokensFromMessages(messages) {
  const chars = messageContentCharCount(messages);
  const messageOverhead = Array.isArray(messages) ? messages.length * 8 : 0;
  return Math.ceil(chars / 4) + messageOverhead;
}

function groqPromptReserveTokens(messages) {
  if (!messages) return _GROQ_TPM_SAFETY_MARGIN;
  return Math.max(
    _GROQ_TPM_SAFETY_MARGIN,
    estimatePromptTokensFromMessages(messages) + _GROQ_PROMPT_ESTIMATE_PADDING_TOKENS,
  );
}

/**
 * Caps max_tokens sent to Groq so a request never asks for more completion
 * budget than the target model's TPM ceiling realistically allows. Applies
 * AFTER reasoningCompletionBudget's headroom. Mirrors capGroqMaxTokens in
 * js/shared/ai-call.js; keep the two in sync.
 *
 * @param {string} modelId
 * @param {number} requestedMaxTokens
 * @param {Array|null} [messages]
 * @returns {number|null}
 */
export function capGroqMaxTokens(modelId, requestedMaxTokens, messages = null) {
  const limit = groqModelTpmLimit(modelId);
  if (limit == null) return requestedMaxTokens;
  const reserve = groqPromptReserveTokens(messages);
  const safeCeiling = Math.floor(limit - reserve);
  const minUsefulCompletion = requestedMaxTokens >= 1024 ? 1024 : requestedMaxTokens;
  if (safeCeiling < minUsefulCompletion) {
    console.warn(
      `  ⚠ [groq] skipping ${modelId}: prompt reserve ${reserve} leaves only ${Math.max(safeCeiling, 0)} ` +
      `tokens from TPM ceiling ${limit}`,
    );
    return null;
  }
  if (requestedMaxTokens <= safeCeiling) return requestedMaxTokens;
  console.warn(
    `  ⚠ [groq] capping max_tokens for ${modelId}: ${requestedMaxTokens} → ${safeCeiling} ` +
    `(TPM ceiling ${limit}, ${reserve} reserved for prompt tokens)`,
  );
  return safeCeiling;
}

// ---------------------------------------------------------------------------
// Text model scoring — higher wins
// ---------------------------------------------------------------------------

function scoreTextModel(id) {
  let score = 0;
  // Prefer well-known instruction-following families
  if (/llama/i.test(id)) score += 200;
  if (/gpt-oss/i.test(id)) score += 180;
  if (/qwen/i.test(id)) score += 160;
  // Parameter count
  if (/120b/i.test(id)) score += 120;
  else if (/70b/i.test(id)) score += 70;
  else if (/32b/i.test(id)) score += 32;
  else if (/27b/i.test(id)) score += 27;
  else if (/20b/i.test(id)) score += 20;
  else if (/8b/i.test(id)) score += 8;
  else if (/7b/i.test(id)) score += 7;
  // Version — match "3.3", "3.1", "4", etc.
  const vMatch = id.match(/(\d+)[._-](\d+)/);
  if (vMatch) score += parseInt(vMatch[1], 10) * 10 + parseInt(vMatch[2], 10);
  // versatile > instruct for open-ended generation
  if (/versatile/i.test(id)) score += 5;
  return score;
}

// ---------------------------------------------------------------------------
// Internal fetch
// ---------------------------------------------------------------------------

async function fetchModelIds(apiKey) {
  const res = await fetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m) => m.id).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _cache = null;

/**
 * Resolves the best available Groq text and vision model IDs.
 * Queries the Groq models API once and caches for the process lifetime.
 * Falls back to hardcoded defaults if all API keys fail.
 *
 * @returns {Promise<{ textModel: string, visionModel: string|null }>}
 */
export async function resolveGroqModels() {
  if (_cache) return _cache;

  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter(Boolean);

  if (!keys.length) {
    console.log("  ℹ Groq model check: no API keys set — using defaults");
    return (_cache = { textModel: GROQ_TEXT_MODEL_DEFAULT, visionModel: GROQ_VISION_MODEL_DEFAULT });
  }

  let modelIds = null;
  for (const key of keys) {
    try {
      modelIds = await fetchModelIds(key);
      break;
    } catch (err) {
      console.warn(`  ⚠ Groq model check failed (${err.message}) — trying next key`);
    }
  }

  if (!modelIds) {
    console.warn("  ⚠ Groq model check: all keys failed — using defaults");
    return (_cache = { textModel: GROQ_TEXT_MODEL_DEFAULT, visionModel: GROQ_VISION_MODEL_DEFAULT });
  }

  const modelSet = new Set(modelIds);

  // Best text model: prefer confirmed free models in priority order.
  // If none are available (e.g. Groq changes lineup), fall back to scoring
  // whatever is in the catalog so the pipeline keeps working.
  const freeText = FREE_TEXT_MODEL_PRIORITY.find((id) => modelSet.has(id));
  const textModel = freeText ?? modelIds
    .filter((id) => !/whisper|guard|speech|tts|embedding/i.test(id))
    .sort((a, b) => scoreTextModel(b) - scoreTextModel(a))[0] ?? GROQ_TEXT_MODEL_DEFAULT;

  // Best vision model: first entry in FREE_VISION_MODEL_PRIORITY that is available.
  // If the catalog is reachable and no known vision model is listed, return
  // null so callers skip Groq vision and go straight to NVIDIA instead of
  // repeatedly calling a decommissioned hardcoded model ID.
  const visionModel =
    FREE_VISION_MODEL_PRIORITY.find((id) => modelSet.has(id)) ?? null;

  console.log(`  ✓ Groq models — text: ${textModel} | vision: ${visionModel ?? "unavailable"}`);
  return (_cache = { textModel, visionModel });
}

// ===========================================================================
// HuggingFace model resolver
// ===========================================================================

// Unified HF router (OpenAI-compatible): the model travels in the request
// body and HF picks a serving provider. This serves the SAME
// llama-3.3-70b-versatile as the Groq primary, so quality/reliability holds
// when Groq rate-limits. HF's TPM policy is unrelated to Groq's — the
// gpt-oss/qwen TPM ceiling that demoted them to fallback tier on Groq (see
// GROQ_TEXT_MODEL_DEFAULT above) does not necessarily apply here, but
// leading with the model already proven at real payload scale keeps this
// path consistent and low-risk regardless.
const HF_ROUTER_MODELS_URL = "https://router.huggingface.co/v1/models";
const HF_ROUTER_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

export const HF_TEXT_MODEL_DEFAULT = "meta-llama/Llama-3.3-70B-Instruct";

// Models confirmed served by the HF router (GET /v1/models, verified
// 2026-07-03) — best quality first, mirroring the Groq primary.
// Update when HF adds new free instruct models worth using.
const FREE_HF_TEXT_MODEL_PRIORITY = [
  "meta-llama/Llama-3.3-70B-Instruct",     // same as Groq primary
  "openai/gpt-oss-120b",                   // fallback — same tier as Groq's fallback
  "openai/gpt-oss-20b",                    // lighter sibling
  "meta-llama/Llama-3.1-8B-Instruct",      // previous default
  "Qwen/Qwen2.5-7B-Instruct",              // last resort
];

function scoreHFModel(id) {
  let score = 0;
  if (/llama/i.test(id)) score += 100;
  if (/gpt-oss/i.test(id)) score += 110;
  if (/qwen/i.test(id)) score += 80;
  if (/120b/i.test(id)) score += 120;
  else if (/70b|72b/i.test(id)) score += 70;
  else if (/32b/i.test(id)) score += 32;
  else if (/20b/i.test(id)) score += 20;
  else if (/8b|7b/i.test(id)) score += 8;
  else if (/3b/i.test(id)) score += 3;
  else if (/1b|1\.5b/i.test(id)) score += 1;
  const vMatch = id.match(/(\d+)[._-](\d+)/);
  if (vMatch) score += parseInt(vMatch[1], 10) * 5 + parseInt(vMatch[2], 10);
  if (/instruct/i.test(id)) score += 10;
  return score;
}

let _hfCache = null;

/**
 * Resolves the best available HuggingFace router text model ID.
 * Queries the unified router's /v1/models once and caches for the process
 * lifetime. Tries all four HF_TOKEN slots in order for the fetch.
 * Falls back to the hardcoded default if the API is unreachable.
 *
 * The returned url is the unified router chat endpoint — the model ID
 * travels in the request body and HF picks a serving provider.
 *
 * @returns {Promise<{ modelId: string, url: string }>}
 */
export async function resolveHFTextModel() {
  if (_hfCache) return _hfCache;

  const tokens = [
    process.env.HF_TOKEN,
    process.env.HF_TOKEN_2,
    process.env.HF_TOKEN_3,
    process.env.HF_TOKEN_4,
  ].filter(Boolean);

  const buildResult = (modelId) => ({
    modelId,
    url: HF_ROUTER_CHAT_URL,
  });

  if (!tokens.length) {
    console.log("  ℹ HF model check: no tokens set — using default");
    return (_hfCache = buildResult(HF_TEXT_MODEL_DEFAULT));
  }

  let modelIds = null;
  for (const token of tokens) {
    try {
      const res = await fetch(HF_ROUTER_MODELS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      modelIds = (data?.data ?? []).map((m) => m.id).filter(Boolean);
      break;
    } catch (err) {
      console.warn(`  ⚠ HF model check failed (${err.message}) — trying next token`);
    }
  }

  if (!modelIds || !modelIds.length) {
    console.warn("  ⚠ HF model check: all tokens failed — using default");
    return (_hfCache = buildResult(HF_TEXT_MODEL_DEFAULT));
  }

  const modelSet = new Set(modelIds);

  // Best model: prefer confirmed models in priority order. If none match,
  // score everything the router serves and pick the highest (exclude-only
  // filter — gpt-oss IDs carry no "instruct"/"chat" marker).
  const freeModel = FREE_HF_TEXT_MODEL_PRIORITY.find((id) => modelSet.has(id));
  const modelId = freeModel ?? modelIds
    .filter((id) => !/embed|reward|vision|guard|whisper|tts|ocr/i.test(id))
    .sort((a, b) => scoreHFModel(b) - scoreHFModel(a))[0] ?? HF_TEXT_MODEL_DEFAULT;

  console.log(`  ✓ HF model — text: ${modelId}${freeModel ? " (priority)" : " (scored fallback)"}`);
  return (_hfCache = buildResult(modelId));
}

// ===========================================================================
// HuggingFace image model resolver (super-resolution + colorization)
// ===========================================================================

const HF_IMAGE_MODELS_URL =
  "https://huggingface.co/api/models?inference=warm&pipeline_tag=image-to-image&sort=downloads&limit=100";

export const HF_UPSCALE_MODEL_DEFAULT = "caidas/swin2SR-realworld-sr-x4-64";

// Best free super-resolution models in priority order.
// Real-ESRGAN handles real-world photo degradation (grain, JPEG compression, blur)
// better than Swin2SR on historical photos. Update this list as better free models appear.
const FREE_HF_UPSCALE_MODEL_PRIORITY = [
  "ai-forever/Real-ESRGAN",                 // best for photos: handles real-world artifacts
  "caidas/swin2SR-realworld-sr-x4-64",      // current default — solid x4 upscaler
  "caidas/swin2SR-compressed-sr-x4-48",     // compressed variant, slightly smaller
  "caidas/swin2SR-classical-sr-x2-64",      // x2 fallback when x4 is unavailable
];

// Free colorization models in priority order.
// All are image-to-image pipeline_tag. colorizeUrl will be null if none are warm.
const FREE_HF_COLORIZE_MODEL_PRIORITY = [
  "Ander/DeoldifyColorizerArtistic",        // artistic colorizer — vivid tones
  "Adolfo/DeoldifyColorizerStable",         // stable variant — more neutral tones
  "jantic/DeOldify",                        // original DeOldify
];

let _hfImageCache = null;

/**
 * Resolves the best available free HuggingFace image enhancement models:
 *   - upscaleModel: best warm super-resolution model (Real-ESRGAN preferred)
 *   - colorizeModel: best warm colorization model (null if none available)
 *
 * Queries the HF models API once and caches for the process lifetime.
 * Falls back to hardcoded defaults if the API is unreachable.
 *
 * @returns {Promise<{
 *   upscaleModel: string,
 *   upscaleUrl: string,
 *   colorizeModel: string|null,
 *   colorizeUrl: string|null
 * }>}
 */
export async function resolveHFImageModels() {
  if (_hfImageCache) return _hfImageCache;

  const tokens = [
    process.env.HF_TOKEN,
    process.env.HF_TOKEN_2,
    process.env.HF_TOKEN_3,
    process.env.HF_TOKEN_4,
  ].filter(Boolean);

  const buildResult = (upscaleModel, colorizeModel) => ({
    upscaleModel,
    upscaleUrl: `https://router.huggingface.co/hf-inference/models/${upscaleModel}`,
    colorizeModel,
    colorizeUrl: colorizeModel
      ? `https://router.huggingface.co/hf-inference/models/${colorizeModel}`
      : null,
  });

  if (!tokens.length) {
    console.log("  ℹ HF image model check: no tokens — using defaults");
    return (_hfImageCache = buildResult(HF_UPSCALE_MODEL_DEFAULT, null));
  }

  let modelIds = null;
  for (const token of tokens) {
    try {
      const res = await fetch(HF_IMAGE_MODELS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      modelIds = data.map((m) => m.id).filter(Boolean);
      break;
    } catch (err) {
      console.warn(`  ⚠ HF image model check failed (${err.message}) — trying next token`);
    }
  }

  if (!modelIds) {
    console.warn("  ⚠ HF image model check: all tokens failed — using defaults");
    return (_hfImageCache = buildResult(HF_UPSCALE_MODEL_DEFAULT, null));
  }

  const modelSet = new Set(modelIds);

  const upscaleModel =
    FREE_HF_UPSCALE_MODEL_PRIORITY.find((id) => modelSet.has(id)) ??
    HF_UPSCALE_MODEL_DEFAULT;

  const colorizeModel =
    FREE_HF_COLORIZE_MODEL_PRIORITY.find((id) => modelSet.has(id)) ?? null;

  const colorizeNote = colorizeModel ? `| colorize: ${colorizeModel}` : "| colorize: unavailable (none warm)";
  console.log(`  ✓ HF image models — upscale: ${upscaleModel} ${colorizeNote}`);
  return (_hfImageCache = buildResult(upscaleModel, colorizeModel));
}
