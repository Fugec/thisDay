/**
 * Shared AI text generation helper — Groq → OpenRouter → NVIDIA NIM → Workers AI fallback chain.
 *
 * Provider priority:
 *   1. Groq  (env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4)
 *        — preferred when available, keeps Free-plan Workers under subrequest limits
 *   2. OpenRouter (env.OPENROUTER_API_KEY... / env.OPENRUITER_API_KEY...) — free router support
 *   3. NVIDIA NIM (env.NVIDIA_API_KEY) — openai/gpt-oss-20b, additional fallback
 *   4. Workers AI (env.AI)       — @cf/meta/llama-3.3-70b-instruct-fp8-fast, last fallback
 *
 * Cerebras and Anthropic were removed from the chain on 2026-07-03 (user
 * decision). The Anthropic branch had been silently 404ing since
 * claude-3-5-haiku's 2026-02-19 retirement.
 *
 * Set GROQ_API_KEY as a Worker secret to enable Groq fallback:
 *   npx wrangler secret put GROQ_API_KEY --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY --config wrangler-blog.jsonc
 *
 * Optional rotation keys:
 *   npx wrangler secret put GROQ_API_KEY_2 --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY_2 --config wrangler-blog.jsonc
 *   npx wrangler secret put GROQ_API_KEY_3 --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY_3 --config wrangler-blog.jsonc
 *   npx wrangler secret put GROQ_API_KEY_4 --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY_4 --config wrangler-blog.jsonc
 *   npx wrangler secret put GROQ_API_KEY_5 --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY_5 --config wrangler-blog.jsonc
 *   npx wrangler secret put GROQ_API_KEY_6 --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY_6 --config wrangler-blog.jsonc
 *   npx wrangler secret put GROQ_API_KEY_7 --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY_7 --config wrangler-blog.jsonc
 *
 * @module shared/ai-call
 */

import { resolveAiModel } from "./ai-model.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq-announced shutdowns (https://console.groq.com/docs/deprecations):
//   llama-3.3-70b-versatile                             → decommissions 2026-08-16
//   llama-3.1-8b-instant                                → decommissions 2026-08-16
//   meta-llama/llama-4-scout-17b-16e-instruct (vision)  → decommissions 2026-07-17
//
// llama-3.3-70b-versatile is STILL the primary model, not "already gone".
// It is still active and has NOT been demoted for being on this list — see
// the E2E lesson below. Do not pre-emptively hard-exclude a still-working
// model just because a shutdown date is announced; Groq flips `active:false`
// on its own /v1/models response at/near decommission, and rankTextModels()
// already filters `active === false` — that is the whole self-healing point
// (the runtime falls through to the next-ranked model automatically, no
// deploy needed). A manual blocklist here just fights the score-based
// ranking with no upside once the model IS truly gone.
//
// E2E LESSON (2026-07-03): an earlier version of this file demoted
// llama-3.3-70b-versatile's score and defaulted to openai/gpt-oss-120b
// because a small-payload A/B test scored it higher on writing quality. A
// full local publish E2E immediately hit repeated Groq 413 "Request too
// large" on EVERY gpt-oss/qwen3 request. Root cause: this Groq account's
// per-model TPM (tokens/minute) allocation is NOT equal across models —
// gpt-oss-120b/20b and qwen3.6-27b are capped at 8000 TPM, qwen3-32b and
// llama-3.1-8b-instant at 6000 TPM, while llama-3.3-70b-versatile gets
// 12000 TPM. Real production payloads (source-bound grounding context up to
// 6000 chars + full article JSON for enrichment/grounding passes) routinely
// exceed 8000 total tokens (prompt + max_tokens) in a single request — small
// A/B samples (1-2 paragraphs, max_tokens 1024) never touched that ceiling
// and so never revealed the problem. llama-3.3-70b-versatile is proven
// reliable at real payload scale ("battle-tested for structured JSON at 4096
// tokens" — the original design comment for its score bonus) and is kept as
// primary until Groq's own catalog marks it inactive. gpt-oss-120b and
// qwen3.6-27b remain strong secondary tiers (properly reasoning-gated) for
// when llama-3.3 is genuinely retired or Groq's own rate limits kick in.
const GROQ_MODEL = "llama-3.3-70b-versatile"; // hardcoded fallback if dynamic selection fails
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Same model as the Groq primary so quality/reliability doesn't drop when
// Groq is rate-limited; ":free" variants cost nothing. `models` is
// OpenRouter's server-side fallback chain (verified live 2026-07-03: a busy
// 120b:free request was transparently served by 20b:free), ending in the
// generic free router as last resort.
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const OPENROUTER_FALLBACK_MODELS = ["openai/gpt-oss-120b:free", "openai/gpt-oss-20b:free", "openrouter/free"];
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// Switched from meta/llama-3.3-70b-instruct 2026-07-24 after live-testing this
// account's key directly against NVIDIA NIM during a real production outage
// (the model was the reason NVIDIA "timed out" as a fallback, not a broken key
// or a NIM outage). Measured on the free/shared tier: llama-3.3-70b-instruct
// generates at ~11 tokens/sec (a 4096-token completion needs ~370s, our 90s
// article-generation timeout can't reach it); openai/gpt-oss-20b generated
// 1240 tokens in 9.4s (~130 tokens/sec) with clean, complete, accurate JSON
// output. gpt-oss-20b is already trusted elsewhere in this chain (Groq's and
// OpenRouter's own gpt-oss fallback tiers), so this doesn't introduce a new
// unvetted model family, just makes NVIDIA capable of finishing within budget.
const NVIDIA_MODEL = "openai/gpt-oss-20b";
// NVIDIA's `max_tokens` ceiling is NOT a fixed endpoint-wide limit — it is
// per-model. 4096 was the safe ceiling observed for llama-3.3-70b-instruct;
// live-verified 2026-07-24 that gpt-oss-20b accepts 6144 (HTTP 200). gpt-oss
// spends completion tokens on hidden reasoning before the visible answer
// (reasoningCompletionBudget below adds the same +2048 headroom used for
// Groq/OpenRouter's own gpt-oss tiers), so the base article-generation
// maxTokens:4096 needs that room here too or large JSON output can truncate.
const NVIDIA_TEXT_MAX_TOKENS = 6144;

// ─── Dynamic model resolution ─────────────────────────────────────────────────
// Module-level cache survives across requests within the same Worker instance.
// Cache TTL: 1 hour. On a cold start only one /v1/models fetch per provider.
let _groqModelCache = { model: null, models: null, at: 0 };
let _groqKeyRotationCursor = 0;
const _MODEL_CACHE_TTL_MS = 3_600_000; // 1 hour
const _providerKeysInFlight = new Set();
const _providerPoolsInFlight = new Set();
const _providerCapacitySnapshots = new Map();
let _providerCircuitCache = new WeakMap();
let _providerCircuitWriteQueues = new WeakMap();
const AI_PROVIDER_CIRCUIT_VERSION = 1;
const AI_PROVIDER_CIRCUIT_PREFIX = "ai-provider-circuit-v1:";
const AI_PROVIDER_CIRCUIT_TTL = 2 * 86_400;
const _DEFAULT_PROVIDER_TIMEOUT_COOLDOWN_MS = 5 * 60_000;

/**
 * Test-only: clears the module-level Groq model cache so a test can query a
 * fresh /v1/models response instead of a warm same-process cache from an
 * earlier test. Production code never calls this — the 1h TTL is by design.
 */
export function __resetGroqModelCacheForTests() {
  _groqModelCache = { model: null, models: null, at: 0 };
  _groqKeyRotationCursor = 0;
  _providerKeysInFlight.clear();
  _providerPoolsInFlight.clear();
  _providerKeyCooldowns.clear();
  _providerCapacitySnapshots.clear();
  _providerCircuitCache = new WeakMap();
  _providerCircuitWriteQueues = new WeakMap();
}
const _providerKeyCooldowns = new Map();
const _DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

function utcDateKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcResetMs(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

function parseProviderResetDurationMs(value) {
  const source = String(value || "").trim().toLowerCase();
  if (!source) return 0;
  if (/^\d+(?:\.\d+)?$/.test(source)) {
    return Math.ceil(Number(source) * 1000);
  }
  let totalMs = 0;
  const units = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
    ms: 1,
  };
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)/g)) {
    totalMs += Number(match[1]) * units[match[2]];
  }
  return Math.ceil(totalMs);
}

function providerRetryAtFromResponse(response, body = "", now = Date.now()) {
  const text = String(body || "");
  if (
    /free-models-per-day|daily free allocation|per day|requests? per day|rpd\b/i.test(
      text,
    )
  ) {
    return nextUtcResetMs(now);
  }
  const retryAfter = response?.headers?.get?.("retry-after");
  const retryAfterDate = Date.parse(String(retryAfter || ""));
  if (Number.isFinite(retryAfterDate) && retryAfterDate > now) {
    return retryAfterDate;
  }
  const retryAfterMs = parseProviderResetDurationMs(retryAfter);
  if (retryAfterMs > 0) return now + retryAfterMs;
  const tokenResetMs = parseProviderResetDurationMs(
    response?.headers?.get?.("x-ratelimit-reset-tokens"),
  );
  if (tokenResetMs > 0) return now + tokenResetMs;
  const requestResetMs = parseProviderResetDurationMs(
    response?.headers?.get?.("x-ratelimit-reset-requests"),
  );
  if (requestResetMs > 0) return now + requestResetMs;
  return now + _DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function providerRetryAtFromError(error, now = Date.now()) {
  const message = String(error?.message || error || "");
  if (/daily free allocation|10,?000 neurons|account limited|free-models-per-day/i.test(message)) {
    return nextUtcResetMs(now);
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return now + _DEFAULT_PROVIDER_TIMEOUT_COOLDOWN_MS;
  }
  return 0;
}

function providerCircuitKey(now = Date.now()) {
  return `${AI_PROVIDER_CIRCUIT_PREFIX}${utcDateKey(now)}`;
}

function emptyProviderCircuit(now = Date.now()) {
  return {
    version: AI_PROVIDER_CIRCUIT_VERSION,
    date: utcDateKey(now),
    providers: {},
  };
}

function normalizeProviderCircuit(value, now = Date.now()) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (
    !parsed ||
    parsed.version !== AI_PROVIDER_CIRCUIT_VERSION ||
    parsed.date !== utcDateKey(now) ||
    !parsed.providers ||
    typeof parsed.providers !== "object"
  ) {
    return emptyProviderCircuit(now);
  }
  return parsed;
}

async function loadProviderCircuit(
  env,
  now = Date.now(),
  { refresh = false } = {},
) {
  const kv = env?.BLOG_AI_KV;
  if (!kv?.get) return emptyProviderCircuit(now);
  const date = utcDateKey(now);
  const cached = _providerCircuitCache.get(kv);
  if (!refresh && cached?.date === date) return cached.state;
  const state = normalizeProviderCircuit(
    await kv.get(providerCircuitKey(now), { type: "json" }).catch(() => null),
    now,
  );
  _providerCircuitCache.set(kv, { date, state });
  return state;
}

function providerCircuitUntil(state, provider, now = Date.now()) {
  const until = Date.parse(String(state?.providers?.[provider]?.retryAt || ""));
  return Number.isFinite(until) && until > now ? until : 0;
}

function providerCircuitReason(state, provider) {
  return String(state?.providers?.[provider]?.reason || "");
}

async function markProviderCircuit(env, provider, retryAtMs, reason) {
  if (!provider || !Number.isFinite(retryAtMs) || retryAtMs <= Date.now()) {
    return false;
  }
  const kv = env?.BLOG_AI_KV;
  if (!kv?.put) return false;
  const previous = _providerCircuitWriteQueues.get(kv) || Promise.resolve();
  const write = previous.then(async () => {
    const now = Date.now();
    const state = await loadProviderCircuit(env, now);
    const currentUntil = providerCircuitUntil(state, provider, now);
    if (currentUntil >= retryAtMs) return false;
    state.providers[provider] = {
      retryAt: new Date(retryAtMs).toISOString(),
      reason: String(reason || "provider capacity unavailable").slice(0, 240),
      observedAt: new Date(now).toISOString(),
    };
    await kv.put(providerCircuitKey(now), JSON.stringify(state), {
      expirationTtl: AI_PROVIDER_CIRCUIT_TTL,
    });
    return true;
  });
  _providerCircuitWriteQueues.set(kv, write.catch(() => {}));
  return write.catch((err) => {
    console.warn(`AI capacity circuit write failed for ${provider}: ${err.message}`);
    return false;
  });
}

function providerCapacitySnapshotId(provider, model = "") {
  return `${provider}:${String(model || "")}`;
}

function captureProviderCapacity(provider, model, response, now = Date.now()) {
  const remainingTokensValue = response?.headers?.get?.(
    "x-ratelimit-remaining-tokens",
  );
  const remainingRequestsValue = response?.headers?.get?.(
    "x-ratelimit-remaining-requests",
  );
  const remainingTokens =
    remainingTokensValue == null || remainingTokensValue === ""
      ? null
      : Number(remainingTokensValue);
  const remainingRequests =
    remainingRequestsValue == null || remainingRequestsValue === ""
      ? null
      : Number(remainingRequestsValue);
  const tokenResetMs = parseProviderResetDurationMs(
    response?.headers?.get?.("x-ratelimit-reset-tokens"),
  );
  const requestResetMs = parseProviderResetDurationMs(
    response?.headers?.get?.("x-ratelimit-reset-requests"),
  );
  _providerCapacitySnapshots.set(providerCapacitySnapshotId(provider, model), {
    remainingTokens: Number.isFinite(remainingTokens) ? remainingTokens : null,
    remainingRequests: Number.isFinite(remainingRequests)
      ? remainingRequests
      : null,
    tokenResetAt: tokenResetMs > 0 ? now + tokenResetMs : 0,
    requestResetAt: requestResetMs > 0 ? now + requestResetMs : 0,
  });
}

function providerCapacityDeferral(provider, model, requiredTokens, now = Date.now()) {
  const snapshot = _providerCapacitySnapshots.get(
    providerCapacitySnapshotId(provider, model),
  );
  if (!snapshot) return null;
  if (
    snapshot.remainingRequests != null &&
    snapshot.remainingRequests < 1 &&
    snapshot.requestResetAt > now
  ) {
    return {
      retryAt: snapshot.requestResetAt,
      reason: `${provider} has no requests remaining in the current window`,
    };
  }
  if (
    snapshot.remainingTokens != null &&
    snapshot.remainingTokens < requiredTokens &&
    snapshot.tokenResetAt > now
  ) {
    return {
      retryAt: snapshot.tokenResetAt,
      reason: `${provider} has ${snapshot.remainingTokens} tokens remaining but the next request needs approximately ${requiredTokens}`,
    };
  }
  return null;
}

function capacityError(message, retryAtMs = 0) {
  const error = new Error(message);
  error.code = "AI_CAPACITY_UNAVAILABLE";
  if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
    error.retryAt = new Date(retryAtMs).toISOString();
  }
  return error;
}

export function isAIProviderCapacityError(error) {
  return (
    error?.code === "AI_CAPACITY_UNAVAILABLE" ||
    /AI provider capacity unavailable/i.test(String(error?.message || error || ""))
  );
}

export function aiProviderRetryAt(error) {
  const parsed = Date.parse(String(error?.retryAt || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function providerKeyCooldownId(provider, key) {
  return `${provider}:${key}`;
}

function isProviderKeyCoolingDown(provider, key) {
  const id = providerKeyCooldownId(provider, key);
  const until = _providerKeyCooldowns.get(id) || 0;
  if (until <= Date.now()) {
    _providerKeyCooldowns.delete(id);
    return false;
  }
  return true;
}

function isProviderKeyInFlight(provider, key) {
  return _providerKeysInFlight.has(providerKeyCooldownId(provider, key));
}

function isProviderPoolInFlight(provider, pool) {
  return _providerPoolsInFlight.has(`${provider}:${pool}`);
}

function markProviderKeyInFlight(provider, key, pool = "shared") {
  const id = providerKeyCooldownId(provider, key);
  const poolId = `${provider}:${pool}`;
  _providerKeysInFlight.add(id);
  _providerPoolsInFlight.add(poolId);
  return () => {
    _providerKeysInFlight.delete(id);
    _providerPoolsInFlight.delete(poolId);
  };
}

function markProviderKeyRateLimited(provider, key, response) {
  const retryAfterSeconds = Number(response?.headers?.get?.("retry-after"));
  const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, _MODEL_CACHE_TTL_MS)
    : _DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  _providerKeyCooldowns.set(
    providerKeyCooldownId(provider, key),
    Date.now() + cooldownMs,
  );
}

/**
 * Scores a model ID for suitability as a text-generation model for article creation.
 *
 * Selection strategy — no hardcoded names, works as models are added or removed:
 *   1. Hard-exclude non-text-generation models (audio, guard, TTS, embeddings).
 *   2. Score by parameter count (larger → better JSON fidelity at 4096 tokens).
 *   3. Bonus for newer architecture generations (Llama 4 > Qwen 3 > Llama 3.3 …).
 *   4. Bonus for instruction-tuned variants over base models.
 *
 * Returns -Infinity for excluded models (filtered out before sorting).
 *
 * @param {string} modelId
 * @returns {number}
 */
function scoreModelForTextGen(modelId) {
  const id = String(modelId).toLowerCase();

  // Hard exclusions — models that cannot do text chat/completion for our task.
  if (/whisper|prompt[._-]?guard|safeguard|orpheus|canopylabs|tts|embed|speech/i.test(id)) {
    return -Infinity;
  }
  // Routing / compound models: unknown reliability for structured JSON output.
  if (/\bcompound\b/i.test(id)) return -Infinity;

  let score = 0;

  // ── Parameter count (primary signal) ──────────────────────────────────────
  // Matches "120b", "70b", "17b-16e", "3.5b", "235b-a22b" — takes the first
  // number before "b" (total params for dense models; MoE total is also fine).
  const paramMatch = id.match(/(\d+(?:\.\d+)?)\s*b/);
  if (paramMatch) {
    score += parseFloat(paramMatch[1]) * 10;
  }

  // ── Architecture generation (recency / instruction-following quality) ──────
  // Llama 3.3's +560 is deliberately larger than raw param count would give
  // it (a 70b model otherwise loses to a 120b one on param score alone) —
  // it is "battle-tested for structured JSON at 4096 tokens" AND, per the
  // E2E lesson above this file's constants, has 12000 TPM on Groq's free
  // tier vs 8000 for gpt-oss/qwen3.6-27b — real production payloads
  // (source context + article JSON) need that headroom. Do not shrink this
  // bonus again without re-running a full local publish E2E, not just a
  // small-sample A/B test — small samples never hit the TPM ceiling that
  // broke production here.
  if (/llama.?4/i.test(id))         score += 200; // Llama 4 — newest Meta arch
  else if (/llama.?3\.3/i.test(id)) score += 560; // Llama 3.3 — proven at real payload scale, 12000 TPM
  else if (/llama.?3\.1/i.test(id)) score += 40;  // Llama 3.1 — solid baseline
  if (/qwen.?3/i.test(id))          score += 60;  // Qwen 3 — competitive at size
  if (/gpt.?oss/i.test(id))         score += 30;  // OpenAI OSS — reliable fallback, but only 8000 TPM here

  // ── Task-fit: instruction-tuned preferred over base/preview models ─────────
  if (/instruct|versatile|chat/i.test(id)) score += 20;

  return score;
}

/**
 * Minimum thresholds for article generation suitability.
 * Our system prompt + JSON output combined can easily exceed 8k tokens, so models
 * with tiny context windows or very low completion caps are rejected outright.
 */
const _MIN_CONTEXT_WINDOW = 8_192;
const _MIN_MAX_COMPLETION_TOKENS = 4_096;
// Verified live against /v1/models on all 7 configured Groq keys (2026-07-22,
// identical catalog across keys — same account). "qwen/qwen3-32b" (formerly
// listed here) is no longer in the active catalog at all; "openai/gpt-oss-120b"
// (score 1230, the actual #2 behind GROQ_MODEL's 1280) was missing. Ordered by
// scoreModelForTextGen ranking so an emergency fallback (live query itself
// failed) still tries models in the same order dynamic resolution would.
const _GROQ_FALLBACK_MODEL_CANDIDATES = [
  GROQ_MODEL,
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];

function uniqueModelIds(models) {
  return [...new Set(models.filter(Boolean).map((model) => String(model)))];
}

/**
 * Ranks a provider's /v1/models response for text-generation suitability.
 *
 * Accepts the full model objects (not just IDs) so it can use provider-supplied
 * metadata (active flag, context window, max completion tokens) when available.
 * Fields that are absent are treated as passing — the filter only fires when a
 * field is explicitly present and fails.
 *
 * Deliberately does NOT hard-exclude models by ID/deprecation announcement —
 * see the E2E lesson at GROQ_MODEL above. A model with an announced shutdown
 * date is still ranked normally by score until the provider's own `active`
 * flag flips false; that is what makes the fallback self-healing without a
 * deploy, per the original design intent.
 *
 * Filter order:
 *   1. active === false  → skip (Groq marks decommissioned models this way)
 *   2. context_window < 8192  → skip (prompt alone fills smaller windows)
 *   3. max_completion_tokens < 4096  → skip (can't emit full JSON output)
 *   4. scoreModelForTextGen < 0  → skip (audio, guard, TTS, compound models)
 *   5. Sort survivors by score descending
 *
 * @param {Array<{id:string, active?:boolean, context_window?:number, max_completion_tokens?:number}>} models
 * @returns {Array<{id:string, score:number}>}
 */
function rankTextModels(models) {
  return models
    .filter((m) => {
      if (m.active === false) return false;
      if (m.context_window != null && m.context_window < _MIN_CONTEXT_WINDOW) return false;
      if (m.max_completion_tokens != null && m.max_completion_tokens < _MIN_MAX_COMPLETION_TOKENS) return false;
      return true;
    })
    .map((m) => ({ id: m.id, score: scoreModelForTextGen(m.id) }))
    .filter((m) => Number.isFinite(m.score) && m.score > -Infinity)
    .sort((a, b) => b.score - a.score);
}

/**
 * Resolves Groq text model candidates at runtime.
 * Cache-first (module-level, 1h TTL). Falls back to GROQ_MODEL constant.
 * @param {string} firstKey - First available Groq API key for the models query
 */
async function resolveGroqModelCandidates(firstKey) {
  const now = Date.now();
  if (_groqModelCache.models?.length && now - _groqModelCache.at < _MODEL_CACHE_TTL_MS) {
    return _groqModelCache.models;
  }
  if (firstKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${firstKey}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const candidates = rankTextModels(data?.data || []);
        if (candidates.length > 0) {
          const models = uniqueModelIds(candidates.map((candidate) => candidate.id));
          _groqModelCache = { model: models[0], models, at: now };
          console.log(
            `[groq] dynamic model: ${models[0]} (score=${candidates[0].score}` +
            `, top3=${models.slice(0, 3).join(", ")})`,
          );
          return models;
        }
      }
    } catch {
      // network error or timeout — use hardcoded constant below
    }
  }
  return uniqueModelIds(_GROQ_FALLBACK_MODEL_CANDIDATES);
}

/**
 * Resolves the best available Groq model at runtime.
 * @param {string} firstKey - First available Groq API key for the models query
 */
async function resolveGroqModel(firstKey) {
  const candidates = await resolveGroqModelCandidates(firstKey);
  return candidates[0] || GROQ_MODEL;
}

function isRequestTooLargeResponse(status, body) {
  return status === 413 || /request too large|too large for model|context length|context window/i.test(String(body || ""));
}

function messageContentCharCount(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    const content = message?.content;
    return total + (typeof content === "string" ? content.length : JSON.stringify(content ?? "").length);
  }, 0);
}

function orderGroqModelsForRequest(models, messages, maxTokens) {
  const promptChars = messageContentCharCount(messages);
  const isLargeStructuredRequest = promptChars >= 6000 || maxTokens >= 3000;
  if (!isLargeStructuredRequest) return models;
  const primary = [];
  const deferred = [];
  for (const model of models) {
    if (String(model).toLowerCase() === "openai/gpt-oss-120b") deferred.push(model);
    else primary.push(model);
  }
  return [...primary, ...deferred];
}

/**
 * Reasoning-model request controls for Groq. gpt-oss and qwen3 models emit
 * chain-of-thought by default; without these parameters qwen returns a literal
 * <think>…</think> block inside message.content (verified live 2026-07-03),
 * and gpt-oss spends extra completion tokens on reasoning. Gated per model —
 * never sent to non-reasoning models.
 *
 * CRITICAL (A/B verified 2026-07-03): qwen3 needs reasoning_effort "none" IN
 * ADDITION to reasoning_format "hidden". Hidden alone only hides the
 * reasoning, which then silently consumes the entire completion budget and
 * returns EMPTY content (finish_reason "length") on article-size prompts.
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
 * Completion budget with reasoning headroom. gpt-oss (reasoning_effort "low")
 * still spends completion tokens on reasoning BEFORE the answer, so a budget
 * tuned for llama-3.3 truncates large JSON outputs mid-structure (observed
 * live 2026-07-03: article generation JSON cut at ~13k chars under the
 * original 4096 cap on gpt-oss-120b). The extra 2048 is a cap, not a spend.
 *
 * qwen3 gets NO headroom: we disable its reasoning entirely
 * (reasoning_effort "none"), and inflating max_tokens only raises the odds
 * of Groq free-tier "request too large" 413s (the TPM estimate counts
 * prompt + max_tokens).
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
 * 2026-07-03 via the x-ratelimit-limit-tokens response header. Groq-specific
 * — do NOT reuse for OpenRouter or the HF router, which run their own
 * unrelated rate-limit systems (see the E2E lesson at GROQ_MODEL above).
 * These numbers are observed capacity, not a documented Groq guarantee, and
 * can drift; capGroqMaxTokens() below reserves a safety margin to absorb
 * some drift and re-verifying via a live request's response headers is the
 * source of truth if 413s reappear.
 *
 * llama-3.3-70b-versatile (12000 TPM, the primary model) normally has enough
 * headroom for our configured jobs. It is included so very large prompts can
 * still be capped before Groq rejects the request.
 *
 * @param {string} modelId
 * @returns {number|null}  TPM ceiling, or null if unknown/uncapped
 */
function groqModelTpmLimit(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("llama-3.3-70b-versatile")) return 12000;
  if (id.includes("gpt-oss")) return 8000;        // gpt-oss-120b, gpt-oss-20b
  if (id.includes("qwen3.6")) return 8000;         // qwen3.6-27b
  if (/qwen.?3/.test(id)) return 6000;             // qwen3-32b and other qwen3 variants
  if (id.includes("llama-3.1-8b")) return 6000;    // llama-3.1-8b-instant
  return null;
}

// Reserve this many tokens of a model's TPM ceiling for prompt tokens we
// don't measure exactly when no prompt is supplied. TPM counts prompt +
// completion together, so request-time capping estimates prompt tokens too.
const _GROQ_TPM_SAFETY_MARGIN = 2000;
const _GROQ_PROMPT_ESTIMATE_PADDING_TOKENS = 256;

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
 * Caps the max_tokens sent to Groq so a request never asks for more
 * completion budget than the target model's TPM ceiling realistically
 * allows. Applied AFTER reasoningCompletionBudget's headroom, so gpt-oss's
 * +2048 gets capped too if it would overflow.
 *
 * @param {string} modelId
 * @param {number} requestedMaxTokens  Already includes any reasoning headroom
 * @param {Array|null} [messages]      Optional prompt messages for prompt-aware capping
 * @returns {number|null}              Null when the prompt is too large for a useful completion
 */
export function capGroqMaxTokens(modelId, requestedMaxTokens, messages = null) {
  const limit = groqModelTpmLimit(modelId);
  if (limit == null) return requestedMaxTokens;
  const reserve = groqPromptReserveTokens(messages);
  const safeCeiling = Math.floor(limit - reserve);
  const minUsefulCompletion = requestedMaxTokens >= 1024 ? 1024 : requestedMaxTokens;
  if (safeCeiling < minUsefulCompletion) {
    console.warn(
      `[groq] skipping ${modelId}: prompt reserve ${reserve} leaves only ${Math.max(safeCeiling, 0)} ` +
      `tokens from TPM ceiling ${limit}`,
    );
    return null;
  }
  if (requestedMaxTokens <= safeCeiling) return requestedMaxTokens;
  console.warn(
    `[groq] capping max_tokens for ${modelId}: ${requestedMaxTokens} → ${safeCeiling} ` +
    `(TPM ceiling ${limit}, ${reserve} reserved for prompt tokens)`,
  );
  return safeCeiling;
}

// ─── AI usage accounting + local-test cassette ────────────────────────────────

// Cumulative per-isolate counters — cheap observability so a test session (or
// a production incident) can see exactly how many external AI calls a run
// makes before quotas drain silently. Motivation: on 2026-07-03 one intensive
// local E2E session exhausted Groq burst limits, the OpenRouter free tier AND
// the account-wide Workers AI 10k-neurons/day pool shared with production.
const _aiUsage = { groq: 0, openrouter: 0, nvidia: 0, workersAI: 0, cassetteHits: 0, estPromptTokens: 0 };

function recordAiAttempt(provider, messages) {
  _aiUsage[provider] += 1;
  _aiUsage.estPromptTokens += estimatePromptTokensFromMessages(messages);
}

export function aiUsageSummary() {
  const calls = _aiUsage.groq + _aiUsage.openrouter + _aiUsage.nvidia + _aiUsage.workersAI;
  return (
    `AI usage (isolate lifetime): ${calls} provider calls ` +
    `(groq ${_aiUsage.groq}, openrouter ${_aiUsage.openrouter}, nvidia ${_aiUsage.nvidia}, ` +
    `workersAI ${_aiUsage.workersAI}), ~${_aiUsage.estPromptTokens} prompt tokens sent, ` +
    `cassette hits ${_aiUsage.cassetteHits}`
  );
}

export function aiUsageSnapshot() {
  const providerCalls = _aiUsage.groq + _aiUsage.openrouter + _aiUsage.nvidia + _aiUsage.workersAI;
  return { ..._aiUsage, providerCalls };
}

export function __resetAiUsageForTests() {
  _aiUsage.groq = 0;
  _aiUsage.openrouter = 0;
  _aiUsage.nvidia = 0;
  _aiUsage.workersAI = 0;
  _aiUsage.cassetteHits = 0;
  _aiUsage.estPromptTokens = 0;
}

// Cassette mode — token-free local E2E replays. Set AI_CASSETTE=1 for local
// wrangler dev runs (NEVER on the deployed worker — without the var this
// whole path is one truthy check). Every successful AI response is stored in
// BLOG_AI_KV keyed by a SHA-256 of the request shape; an identical later
// request replays from KV with zero external calls. Within one isolate
// lifetime a key that was just recorded is treated as a MISS, so retry loops
// that deliberately resample the same prompt (the malformed-JSON generation
// retry) keep their real behavior — replay only kicks in on the next run.
const AI_CASSETTE_PREFIX = "ai-cassette:";
const _cassetteStoredThisRun = new Set();

export function __resetCassetteRunStateForTests() {
  _cassetteStoredThisRun.clear();
}

function cassetteEnabled(env) {
  return Boolean(env?.AI_CASSETTE && env?.BLOG_AI_KV);
}

async function cassetteKeyFor(parts) {
  const raw = JSON.stringify(parts);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${AI_CASSETTE_PREFIX}${hex}`;
}

async function cassetteLookup(env, parts) {
  if (!cassetteEnabled(env)) return { key: null, text: null };
  try {
    const key = await cassetteKeyFor(parts);
    if (_cassetteStoredThisRun.has(key)) return { key, text: null };
    const text = await env.BLOG_AI_KV.get(key);
    if (text) {
      _aiUsage.cassetteHits += 1;
      console.log(`[cassette] hit ${key.slice(AI_CASSETTE_PREFIX.length, AI_CASSETTE_PREFIX.length + 12)}…`);
      return { key, text };
    }
    return { key, text: null };
  } catch {
    return { key: null, text: null };
  }
}

async function cassetteStore(env, key, text) {
  if (!cassetteEnabled(env) || !key || !text) return;
  try {
    await env.BLOG_AI_KV.put(key, text);
    _cassetteStoredThisRun.add(key);
  } catch {
    // A KV write failure must never break a successful AI response.
  }
}

function getOpenRouterKeys(env) {
  return [
    env.OPENROUTER_API_KEY,
    env.OPENROUTER_API_KEY_2,
    env.OPENROUTER_API_KEY_3,
    env.OPENRUITER_API_KEY,
    env.OPENRUITER_API_KEY_2,
    env.OPENRUITER_API_KEY_3,
    env.OPENNRUITER_API_KEY,
    env.OPENNRUITER_API_KEY_2,
    env.OPENNRUITER_API_KEY_3,
  ].filter(Boolean);
}

function groqQuotaPoolIds(env) {
  return String(env?.GROQ_QUOTA_POOL_IDS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .map((value) => value.replace(/[^a-z0-9._-]+/g, "-").slice(0, 48));
}

export function hasAnyTextAIProvider(env) {
  return Boolean(
    env?.AI ||
    env?.GROQ_API_KEY ||
    env?.GROQ_API_KEY_2 ||
    env?.GROQ_API_KEY_3 ||
    env?.GROQ_API_KEY_4 ||
    env?.GROQ_API_KEY_5 ||
    env?.GROQ_API_KEY_6 ||
    env?.GROQ_API_KEY_7 ||
    getOpenRouterKeys(env).length > 0 ||
    env?.NVIDIA_API_KEY,
  );
}

function isSubrequestLimitError(err) {
  return /too many subrequests/i.test(err?.message || String(err || ""));
}

function hasSubrequestLimitFailure(failureReasons) {
  return failureReasons.some((reason) => /too many subrequests/i.test(reason));
}

function getProviderAttemptLimit(env) {
  const parsed = Number(env?.AI_PROVIDER_ATTEMPT_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
}

function guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons) {
  if (providerAttempts < providerAttemptLimit) return;
  throw new Error(
    `callAI failed. AI provider attempt limit ${providerAttemptLimit} reached. ${failureReasons.join(" | ")}`,
  );
}

// The hard attempt limit above THROWS when reached — it is a runaway-chain
// stop, not a fallthrough. Without a per-section share, a Groq timeout or
// empty-response storm across model×key combinations (up to 5 models × 5
// keys = 25) exhausts the whole 20-attempt budget and aborts the chain
// before OpenRouter/NVIDIA/Workers AI ever run. 429s and 413s never get that
// far (429 cooldowns skip the key, 413 skips the model after one attempt),
// so ten attempts is already a deep search of failing combinations.
const GROQ_SECTION_MAX_ATTEMPTS = 10;

/**
 * Calls the bound Cloudflare Workers AI service directly.
 *
 * Use this for late publication gates after external provider calls have used
 * most of the Free-plan 50-fetch allowance. Workers AI is an internal service
 * binding and has a separate internal-subrequest budget.
 */
async function callWorkersAIDirectUncached(
  env,
  messages,
  { maxTokens = 1024, timeoutMs = 12_000, cfModel, temperature = 0.3 } = {},
) {
  if (!env?.AI) throw new Error("Workers AI binding missing");
  recordAiAttempt("workersAI", messages);
  const model = cfModel ?? (await resolveAiModel(env.BLOG_AI_KV).catch(() => null));
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Workers AI timeout")), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([
      env.AI.run(model, {
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  const rawValue = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
  const text = (typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)).trim();
  if (!text) throw new Error("Workers AI returned empty response");
  return text;
}

/**
 * Public entry — cassette-aware wrapper around the direct Workers AI call.
 * With AI_CASSETTE unset (production) this is a passthrough.
 */
export async function callWorkersAIDirect(env, messages, options = {}) {
  const now = Date.now();
  // A warm isolate may have observed an empty circuit before another isolate
  // recorded an account-wide limit, so refresh at every public entry point.
  const circuit = await loadProviderCircuit(env, now, { refresh: true });
  const blockedUntil = providerCircuitUntil(circuit, "workersAI", now);
  if (blockedUntil) {
    throw capacityError(
      `AI provider capacity unavailable: Workers AI is paused until ${new Date(blockedUntil).toISOString()} (${providerCircuitReason(circuit, "workersAI") || "daily allocation exhausted"})`,
      blockedUntil,
    );
  }
  const { maxTokens = 1024, temperature = 0.3, cfModel = null } = options;
  const resolvedCfModel = cfModel ?? (cassetteEnabled(env)
    ? await resolveAiModel(env.BLOG_AI_KV).catch(() => null)
    : null);
  const cassette = await cassetteLookup(env, ["workersAI", messages, maxTokens, temperature, resolvedCfModel]);
  if (cassette.text) return cassette.text;
  let text;
  try {
    text = await callWorkersAIDirectUncached(env, messages, {
      ...options,
      ...(resolvedCfModel ? { cfModel: resolvedCfModel } : {}),
    });
  } catch (err) {
    const retryAt = providerRetryAtFromError(err);
    if (retryAt) {
      await markProviderCircuit(env, "workersAI", retryAt, err.message);
      err.code = "AI_CAPACITY_UNAVAILABLE";
      err.retryAt = new Date(retryAt).toISOString();
    }
    throw err;
  }
  await cassetteStore(env, cassette.key, text);
  return text;
}

/**
 * Calls AI with a Workers AI → Groq fallback chain.
 * Always resolves to the raw text string from the model.
 * Throws only if both providers are unavailable.
 *
 * @param {object}   env
 * @param {object}   [env.AI]            Workers AI binding
 * @param {string}   [env.GROQ_API_KEY]   Groq API key secret (optional fallback)
 * @param {string}   [env.GROQ_API_KEY_2] Groq API key secret (optional rotation)
 * @param {string}   [env.GROQ_API_KEY_3] Groq API key secret (optional rotation)
 * @param {string}   [env.GROQ_API_KEY_4] Groq API key secret (optional rotation)
 * @param {string}   [env.GROQ_API_KEY_5] Groq API key secret (optional rotation)
 * @param {string}   [env.GROQ_API_KEY_6] Groq API key secret (optional rotation)
 * @param {string}   [env.GROQ_API_KEY_7] Groq API key secret (optional rotation)
 * @param {object}   [env.BLOG_AI_KV]   KV for resolving the best CF model name
 * @param {Array}    messages            OpenAI-style chat messages array
 * @param {object}   [opts]
 * @param {number}   [opts.maxTokens=1024]
 * @param {number}   [opts.timeoutMs=12000]
 * @param {string}   [opts.cfModel]      Override CF model; if omitted resolves from KV
 * @returns {Promise<string>}  Raw text from the model
 */
export async function callAI(env, messages, options = {}) {
  const {
    maxTokens = 1024,
    temperature = 0.3,
    cfModel = null,
    skipWorkersAI = false,
    providerAttemptLimit = null,
    groqSectionAttemptLimit = null,
  } = options;
  const cassette = await cassetteLookup(env, [
    "callAI",
    messages,
    {
      maxTokens,
      temperature,
      cfModel,
      skipWorkersAI: Boolean(skipWorkersAI),
      providerAttemptLimit: providerAttemptLimit == null ? null : Number(providerAttemptLimit),
      groqSectionAttemptLimit:
        groqSectionAttemptLimit == null ? null : Number(groqSectionAttemptLimit),
    },
  ]);
  if (cassette.text) return cassette.text;
  const text = await callAIProviders(env, messages, options);
  await cassetteStore(env, cassette.key, text);
  return text;
}

async function callAIProviders(
  env,
  messages,
  {
    maxTokens = 1024,
    timeoutMs = 12_000,
    cfModel,
    temperature = 0.3,
    skipWorkersAI = false,
    providerAttemptLimit: providerAttemptLimitOverride,
    groqSectionAttemptLimit: groqSectionAttemptLimitOverride,
  } = {},
) {
  const failureReasons = [];
  const invocationStartedAt = Date.now();
  // Refresh once per AI call so a warm Worker cannot retain a pre-limit view
  // after another invocation opens a durable provider circuit.
  const providerCircuit = await loadProviderCircuit(
    env,
    invocationStartedAt,
    { refresh: true },
  );
  const capacityRetryTimes = [];
  const circuitBlockedUntil = (provider) => {
    const until = providerCircuitUntil(
      providerCircuit,
      provider,
      invocationStartedAt,
    );
    if (until) capacityRetryTimes.push(until);
    return until;
  };
  const parsedProviderAttemptLimit = Number(providerAttemptLimitOverride);
  const providerAttemptLimit =
    Number.isFinite(parsedProviderAttemptLimit) && parsedProviderAttemptLimit > 0
      ? Math.floor(parsedProviderAttemptLimit)
      : getProviderAttemptLimit(env);
  const parsedGroqSectionAttemptLimit = Number(groqSectionAttemptLimitOverride);
  const groqSectionAttemptLimit =
    Number.isFinite(parsedGroqSectionAttemptLimit) &&
    parsedGroqSectionAttemptLimit > 0
      ? Math.min(
          Math.floor(parsedGroqSectionAttemptLimit),
          GROQ_SECTION_MAX_ATTEMPTS,
        )
      : GROQ_SECTION_MAX_ATTEMPTS;
  let providerAttempts = 0;

  // Resolve key arrays up front so model resolution can use the first available key.
  const configuredGroqPools = groqQuotaPoolIds(env);
  const rawConfiguredGroqKeys = [
    { key: env.GROQ_API_KEY, slot: 1 },
    { key: env.GROQ_API_KEY_2, slot: 2 },
    { key: env.GROQ_API_KEY_3, slot: 3 },
    { key: env.GROQ_API_KEY_4, slot: 4 },
    { key: env.GROQ_API_KEY_5, slot: 5 },
    { key: env.GROQ_API_KEY_6, slot: 6 },
    { key: env.GROQ_API_KEY_7, slot: 7 },
  ].filter((entry) => Boolean(entry.key));
  // Pool independence is fail-closed. If any configured key lacks an explicit
  // label, treat every key as sharing one quota instead of guessing that a
  // partially labelled key is independent.
  const hasCompleteGroqPoolMap =
    rawConfiguredGroqKeys.length > 0 &&
    rawConfiguredGroqKeys.every(
      ({ slot }) => Boolean(configuredGroqPools[slot - 1]),
    );
  const configuredGroqKeys = rawConfiguredGroqKeys
    .map((entry) => ({
      ...entry,
      pool: hasCompleteGroqPoolMap
        ? configuredGroqPools[entry.slot - 1]
        : "shared",
    }));
  // Chunked article generation makes several large calls in one Worker
  // invocation. Starting each call at key 1 repeatedly drains that key's TPM
  // allowance while later rotation keys remain idle. Rotate the starting key
  // per call, preserving the same bounded attempt count and fallback budget.
  const rotationStart = configuredGroqKeys.length > 0
    ? _groqKeyRotationCursor % configuredGroqKeys.length
    : 0;
  const groqKeys = configuredGroqKeys.length > 0
    ? [
        ...configuredGroqKeys.slice(rotationStart),
        ...configuredGroqKeys.slice(0, rotationStart),
      ]
    : [];
  if (configuredGroqKeys.length > 1) {
    _groqKeyRotationCursor =
      (_groqKeyRotationCursor + 1) % configuredGroqKeys.length;
  }

  // Dynamically resolve Groq text models (cached 1h).
  // On a warm Worker instance this is synchronous (cache hit, 0 subrequests).
  // On a cold start it adds at most one lightweight /v1/models fetch.
  const groqModelResolutionKey = groqKeys.find(
    ({ pool }) =>
      !providerCircuitUntil(
        providerCircuit,
        `groq:${pool}`,
        invocationStartedAt,
      ),
  );
  const resolvedGroqModels = groqModelResolutionKey
    ? await resolveGroqModelCandidates(groqModelResolutionKey.key).catch(() => uniqueModelIds(_GROQ_FALLBACK_MODEL_CANDIDATES))
    : uniqueModelIds(_GROQ_FALLBACK_MODEL_CANDIDATES);
  const groqModelsForRequest = orderGroqModelsForRequest(resolvedGroqModels, messages, maxTokens);

  // 1. Groq — preferred when configured, especially on Free-plan Workers where
  // Workers AI can consume the per-invocation subrequest budget too early.
  if (groqKeys.length === 0) {
    failureReasons.push("No Groq API keys configured");
  }
  let stopGroqAfterSubrequestLimit = false;
  let stopGroqAfterAttemptShare = false;
  let groqSectionAttempts = 0;
  for (const groqModel of groqModelsForRequest) {
    for (const { key, slot, pool } of groqKeys) {
      const groqProviderPool = `groq:${pool}`;
      const groqPoolBlockedUntil = circuitBlockedUntil(groqProviderPool);
      if (groqPoolBlockedUntil) {
        failureReasons.push(
          `Groq pool ${pool} capacity circuit open until ${new Date(groqPoolBlockedUntil).toISOString()} (${providerCircuitReason(providerCircuit, groqProviderPool) || "rate limited"})`,
        );
        continue;
      }
      if (groqSectionAttempts >= groqSectionAttemptLimit) {
        failureReasons.push(
          `Groq section stopped after ${groqSectionAttemptLimit} attempts to preserve fallback budget`,
        );
        stopGroqAfterAttemptShare = true;
        break;
      }
      if (isProviderKeyCoolingDown("groq", key)) {
        failureReasons.push(`Groq key-${slot} temporarily skipped after rate limit for ${groqModel}`);
        continue;
      }
      if (isProviderKeyInFlight("groq", key)) {
        failureReasons.push(
          `Groq key-${slot} is already serving another independent article chunk`,
        );
        continue;
      }
      if (isProviderPoolInFlight("groq", pool)) {
        failureReasons.push(
          `Groq pool ${pool} is already serving another independent article chunk`,
        );
        continue;
      }
      let releaseProviderKey = null;
      try {
        guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
        const groqMaxTokens = capGroqMaxTokens(
          groqModel,
          reasoningCompletionBudget(groqModel, maxTokens),
          messages,
        );
        if (groqMaxTokens == null) {
          failureReasons.push(`Groq ${groqModel} skipped: prompt too large for configured token budget`);
          break;
        }
        const estimatedRequestTokens =
          estimatePromptTokensFromMessages(messages) + groqMaxTokens;
        const capacityDeferral = providerCapacityDeferral(
          groqProviderPool,
          groqModel,
          estimatedRequestTokens,
        );
        if (capacityDeferral) {
          capacityRetryTimes.push(capacityDeferral.retryAt);
          await markProviderCircuit(
            env,
            groqProviderPool,
            capacityDeferral.retryAt,
            capacityDeferral.reason,
          );
          providerCircuit.providers[groqProviderPool] = {
            retryAt: new Date(capacityDeferral.retryAt).toISOString(),
            reason: capacityDeferral.reason,
            observedAt: new Date().toISOString(),
          };
          failureReasons.push(capacityDeferral.reason);
          continue;
        }
        providerAttempts += 1;
        groqSectionAttempts += 1;
        recordAiAttempt("groq", messages);
        releaseProviderKey = markProviderKeyInFlight("groq", key, pool);
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: groqModel,
            messages,
            max_tokens: groqMaxTokens,
            temperature,
            ...groqReasoningParams(groqModel),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          captureProviderCapacity(groqProviderPool, groqModel, res);
          const data = await res.json();
          const text = (data?.choices?.[0]?.message?.content ?? "").trim();
          if (text) return text;
          console.warn(`Groq key-${slot} returned empty response for ${groqModel}`);
          failureReasons.push(`Groq key-${slot} returned empty response for ${groqModel}`);
        }
        const errBody = await res.text().catch(() => "");
        if (res.status === 429) {
          markProviderKeyRateLimited("groq", key, res);
          const retryAt = providerRetryAtFromResponse(res, errBody);
          capacityRetryTimes.push(retryAt);
          await markProviderCircuit(env, groqProviderPool, retryAt, errBody);
          providerCircuit.providers[groqProviderPool] = {
            retryAt: new Date(retryAt).toISOString(),
            reason: String(errBody || "Groq rate limited").slice(0, 240),
            observedAt: new Date().toISOString(),
          };
        }
        console.warn(`Groq key-${slot} ${groqModel} error ${res.status}: ${errBody.slice(0, 120)}`);
        failureReasons.push(`Groq key-${slot} ${groqModel} error ${res.status}: ${errBody.slice(0, 120)}`);
        if (isRequestTooLargeResponse(res.status, errBody)) break;
      } catch (err) {
        console.warn(`Groq key-${slot} ${groqModel} request failed (${err.message})`);
        failureReasons.push(`Groq key-${slot} ${groqModel} request failed: ${err.message}`);
        if (isSubrequestLimitError(err)) {
          stopGroqAfterSubrequestLimit = true;
          break;
        }
      } finally {
        releaseProviderKey?.();
      }
    }
    if (stopGroqAfterSubrequestLimit || stopGroqAfterAttemptShare) break;
  }
  if (hasSubrequestLimitFailure(failureReasons)) {
    throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
  }

  // 2. OpenRouter — free router with OpenAI-compatible chat completions.
  // Budget for the worst-case model in the server-side fallback chain: the
  // primary llama-3.3:free needs no reasoning headroom, but when OpenRouter
  // transparently falls back to a gpt-oss:free entry, its (effort "low")
  // reasoning spends from the same max_tokens — without the headroom the
  // fallback path could truncate exactly when it is needed. max_tokens is a
  // cap, not a spend, so the extra headroom costs nothing on the llama path.
  const openRouterMaxTokens = Math.max(
    ...[OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS].map(
      (model) => reasoningCompletionBudget(model, maxTokens),
    ),
  );
  const openRouterBlockedUntil = circuitBlockedUntil("openrouter");
  const openRouterKeys = openRouterBlockedUntil ? [] : getOpenRouterKeys(env);
  if (openRouterBlockedUntil) {
    failureReasons.push(
      `OpenRouter capacity circuit open until ${new Date(openRouterBlockedUntil).toISOString()} (${providerCircuitReason(providerCircuit, "openrouter") || "rate limited"})`,
    );
  } else if (openRouterKeys.length > 0) {
    for (const openRouterKey of openRouterKeys) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      recordAiAttempt("openrouter", messages);
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          models: OPENROUTER_FALLBACK_MODELS,
          messages,
          max_tokens: openRouterMaxTokens,
          temperature,
          // OpenRouter-normalized reasoning control: keeps gpt-oss thinking
          // out of the completion budget; ignored for non-reasoning models.
          reasoning: { effort: "low" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data?.choices?.[0]?.message?.content ?? "").trim();
        if (text) return text;
        console.warn("OpenRouter returned empty response");
        failureReasons.push("OpenRouter returned empty response");
      } else {
        const errBody = await res.text().catch(() => "");
        console.warn(`OpenRouter error ${res.status}: ${errBody.slice(0, 120)}`);
        failureReasons.push(`OpenRouter error ${res.status}: ${errBody.slice(0, 120)}`);
        if (res.status === 429) {
          const retryAt = providerRetryAtFromResponse(res, errBody);
          capacityRetryTimes.push(retryAt);
          await markProviderCircuit(env, "openrouter", retryAt, errBody);
          break;
        }
      }
    } catch (err) {
      console.warn(`OpenRouter request failed (${err.message})`);
      failureReasons.push(`OpenRouter request failed: ${err.message}`);
      if (isSubrequestLimitError(err)) break;
    }
    }
    if (hasSubrequestLimitFailure(failureReasons)) {
      throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
    }
  } else {
    failureReasons.push("OpenRouter API key missing");
  }

  // 3. NVIDIA NIM — openai/gpt-oss-20b via integrate.api.nvidia.com (OpenAI-compatible).
  // NVIDIA_TEXT_MAX_TOKENS is this model's live-verified ceiling; do not
  // inflate further without re-verifying, since exceeding a model's real
  // ceiling fails with 422 exactly when Groq/OpenRouter are already down.
  const nvidiaBlockedUntil = circuitBlockedUntil("nvidia");
  if (nvidiaBlockedUntil) {
    failureReasons.push(
      `NVIDIA capacity circuit open until ${new Date(nvidiaBlockedUntil).toISOString()} (${providerCircuitReason(providerCircuit, "nvidia") || "temporarily unavailable"})`,
    );
  } else if (env.NVIDIA_API_KEY) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      recordAiAttempt("nvidia", messages);
      const res = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages,
          max_tokens: Math.min(
            Math.max(reasoningCompletionBudget(NVIDIA_MODEL, maxTokens), 1),
            NVIDIA_TEXT_MAX_TOKENS,
          ),
          temperature,
          ...groqReasoningParams(NVIDIA_MODEL),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data?.choices?.[0]?.message?.content ?? "").trim();
        if (text) return text;
        console.warn("NVIDIA NIM returned empty response");
        failureReasons.push("NVIDIA NIM returned empty response");
      } else {
        const errBody = await res.text().catch(() => "");
        console.warn(`NVIDIA NIM error ${res.status}: ${errBody.slice(0, 120)}`);
        failureReasons.push(`NVIDIA NIM error ${res.status}: ${errBody.slice(0, 120)}`);
        if (res.status === 429) {
          const retryAt = providerRetryAtFromResponse(res, errBody);
          capacityRetryTimes.push(retryAt);
          await markProviderCircuit(env, "nvidia", retryAt, errBody);
        }
      }
    } catch (err) {
      console.warn(`NVIDIA NIM request failed (${err.message})`);
      failureReasons.push(`NVIDIA NIM request failed: ${err.message}`);
      const retryAt = providerRetryAtFromError(err);
      if (retryAt) {
        capacityRetryTimes.push(retryAt);
        await markProviderCircuit(env, "nvidia", retryAt, err.message);
      }
      if (isSubrequestLimitError(err)) {
        throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
      }
    }
  } else {
    failureReasons.push("NVIDIA API key missing");
  }

  // 4. Workers AI — built-in fallback when external providers are unavailable
  const workersAIBlockedUntil = circuitBlockedUntil("workersAI");
  if (workersAIBlockedUntil && !skipWorkersAI) {
    failureReasons.push(
      `Workers AI capacity circuit open until ${new Date(workersAIBlockedUntil).toISOString()} (${providerCircuitReason(providerCircuit, "workersAI") || "daily allocation exhausted"})`,
    );
  } else if (env.AI && !skipWorkersAI) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      // Uncached variant: the outer callAI wrapper already owns the cassette
      // for this request; a second lookup here would double-count.
      return await callWorkersAIDirectUncached(env, messages, {
        maxTokens,
        timeoutMs,
        cfModel,
        temperature,
      });
    } catch (err) {
      console.warn(`Workers AI failed (${err.message})`);
      failureReasons.push(`Workers AI failed: ${err.message}`);
      const retryAt = providerRetryAtFromError(err);
      if (retryAt) {
        capacityRetryTimes.push(retryAt);
        await markProviderCircuit(env, "workersAI", retryAt, err.message);
      }
      if (isSubrequestLimitError(err)) {
        throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
      }
    }
  } else if (skipWorkersAI) {
    failureReasons.push("Workers AI intentionally skipped");
  } else {
    failureReasons.push("Workers AI binding missing");
  }

  const retryAt = capacityRetryTimes
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((a, b) => a - b)[0] || 0;
  const message =
    `callAI failed. ${failureReasons.join(" | ") || "No provider failure details captured."}`;
  if (retryAt) {
    throw capacityError(
      `AI provider capacity unavailable until ${new Date(retryAt).toISOString()}. ${message}`,
      retryAt,
    );
  }
  throw new Error(message);
}
