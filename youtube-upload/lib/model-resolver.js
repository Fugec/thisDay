/**
 * Model auto-resolver for Groq and HuggingFace.
 * Queries each provider's models API once per pipeline run, picks the best
 * available free model, and caches the result for the process lifetime.
 *
 * Groq fallbacks:
 *   text:   llama-3.3-70b-versatile
 *   vision: meta-llama/llama-4-scout-17b-16e-instruct
 *
 * HuggingFace fallback:
 *   text:   meta-llama/Llama-3.1-8B-Instruct  (via router.huggingface.co)
 */

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

export const GROQ_TEXT_MODEL_DEFAULT   = "llama-3.3-70b-versatile";
export const GROQ_VISION_MODEL_DEFAULT = "meta-llama/llama-4-scout-17b-16e-instruct";

// Confirmed free text models on Groq free tier — checked in priority order.
// Only models on this list are eligible; paid/preview/namespaced models are
// never selected even if they appear in the API response.
// Update this list when Groq adds new free models.
const FREE_TEXT_MODEL_PRIORITY = [
  "llama-3.3-70b-versatile",   // best quality, free
  "llama-3.1-70b-versatile",   // older 70b, free
  "llama-3.1-8b-instant",      // lighter fallback, free
  "llama-3-70b-8192",          // legacy, free
];

// Confirmed free vision-capable models on Groq — checked in priority order.
// Add new free vision-capable Groq models here as they become available.
const FREE_VISION_MODEL_PRIORITY = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct-preview",
];

// ---------------------------------------------------------------------------
// Text model scoring — higher wins
// ---------------------------------------------------------------------------

function scoreTextModel(id) {
  let score = 0;
  // Prefer well-known instruction-following families
  if (/llama/i.test(id)) score += 200;
  // Parameter count
  if (/70b/i.test(id)) score += 70;
  else if (/32b/i.test(id)) score += 32;
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
 * @returns {Promise<{ textModel: string, visionModel: string }>}
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

  // Best vision model: first entry in FREE_VISION_MODEL_PRIORITY that is available
  const visionModel =
    FREE_VISION_MODEL_PRIORITY.find((id) => modelSet.has(id)) ?? GROQ_VISION_MODEL_DEFAULT;

  console.log(`  ✓ Groq models — text: ${textModel} | vision: ${visionModel}`);
  return (_cache = { textModel, visionModel });
}

// ===========================================================================
// HuggingFace model resolver
// ===========================================================================

const HF_MODELS_URL =
  "https://huggingface.co/api/models?inference=warm&filter=text-generation&sort=downloads&limit=50";

export const HF_TEXT_MODEL_DEFAULT = "meta-llama/Llama-3.1-8B-Instruct";

// Confirmed free models on HF Inference API (router.huggingface.co/hf-inference).
// Checked in priority order — best quality first.
// Update when HF adds new free instruct models worth using.
const FREE_HF_TEXT_MODEL_PRIORITY = [
  "meta-llama/Llama-3.1-8B-Instruct",      // solid instruct, free tier
  "meta-llama/Llama-3.2-3B-Instruct",      // lighter, free tier
  "Qwen/Qwen2.5-7B-Instruct",              // good quality, free tier
  "Qwen/Qwen2.5-1.5B-Instruct",            // smallest fallback, free tier
  "meta-llama/Llama-3.2-1B-Instruct",      // last resort, free tier
];

function scoreHFModel(id) {
  let score = 0;
  if (/llama/i.test(id)) score += 100;
  if (/qwen/i.test(id)) score += 80;
  if (/70b|72b/i.test(id)) score += 70;
  else if (/32b/i.test(id)) score += 32;
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
 * Resolves the best available free HuggingFace text model ID.
 * Queries the HF models API once and caches for the process lifetime.
 * Tries all three HF_TOKEN slots in order for the fetch.
 * Falls back to hardcoded default if the API is unreachable.
 *
 * @returns {Promise<{ modelId: string, url: string }>}
 */
export async function resolveHFTextModel() {
  if (_hfCache) return _hfCache;

  const tokens = [
    process.env.HF_TOKEN,
    process.env.HF_TOKEN_2,
    process.env.HF_TOKEN_3,
  ].filter(Boolean);

  const buildResult = (modelId) => ({
    modelId,
    url: `https://router.huggingface.co/hf-inference/models/${modelId}/v1/chat/completions`,
  });

  if (!tokens.length) {
    console.log("  ℹ HF model check: no tokens set — using default");
    return (_hfCache = buildResult(HF_TEXT_MODEL_DEFAULT));
  }

  let modelIds = null;
  for (const token of tokens) {
    try {
      const res = await fetch(HF_MODELS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      modelIds = data.map((m) => m.id).filter(Boolean);
      break;
    } catch (err) {
      console.warn(`  ⚠ HF model check failed (${err.message}) — trying next token`);
    }
  }

  if (!modelIds) {
    console.warn("  ⚠ HF model check: all tokens failed — using default");
    return (_hfCache = buildResult(HF_TEXT_MODEL_DEFAULT));
  }

  const modelSet = new Set(modelIds);

  // Best model: prefer confirmed free models in priority order.
  // If none match, score all available warm models and pick highest.
  const freeModel = FREE_HF_TEXT_MODEL_PRIORITY.find((id) => modelSet.has(id));
  const modelId = freeModel ?? modelIds
    .filter((id) => /instruct|chat/i.test(id) && !/embed|reward|vision/i.test(id))
    .sort((a, b) => scoreHFModel(b) - scoreHFModel(a))[0] ?? HF_TEXT_MODEL_DEFAULT;

  console.log(`  ✓ HF model — text: ${modelId}${freeModel ? " (free tier)" : " (scored fallback)"}`);
  return (_hfCache = buildResult(modelId));
}
