/**
 * Shared AI text generation helper — Groq → Cerebras → OpenRouter → NVIDIA NIM → Anthropic → Workers AI fallback chain.
 *
 * Provider priority:
 *   1. Groq  (env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4)
 *        — preferred when available, keeps Free-plan Workers under subrequest limits
 *   2. Cerebras (env.CEREBRAS_API_KEY... / env.CEREBAS_API_KEY...) — responsive free API-key fallback
 *   3. OpenRouter (env.OPENROUTER_API_KEY... / env.OPENRUITER_API_KEY...) — free router support
 *   4. NVIDIA NIM (env.NVIDIA_API_KEY) — llama-4-maverick-17b, additional fallback
 *   5. Anthropic (env.ANTHROPIC_API_KEY) — external fallback when others are unavailable
 *   6. Workers AI (env.AI)       — @cf/meta/llama-3.3-70b-instruct-fp8-fast, last fallback
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
 *
 * @module shared/ai-call
 */

import { resolveAiModel } from "./ai-model.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile"; // hardcoded fallback if dynamic selection fails
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openrouter/free";
const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "gpt-oss-120b"; // hardcoded fallback if dynamic selection fails
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-3-5-haiku-latest";

// ─── Dynamic model resolution ─────────────────────────────────────────────────
// Module-level cache survives across requests within the same Worker instance.
// Cache TTL: 1 hour. On a cold start only one /v1/models fetch per provider.
let _groqModelCache = { model: null, at: 0 };
let _cerebrasModelCache = { model: null, at: 0 };
const _MODEL_CACHE_TTL_MS = 3_600_000; // 1 hour

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
  if (/llama.?4/i.test(id))         score += 200; // Llama 4 — newest Meta arch
  else if (/llama.?3\.3/i.test(id)) score += 560; // Llama 3.3 — battle-tested for structured JSON at 4096 tokens
  else if (/llama.?3\.1/i.test(id)) score += 40;  // Llama 3.1 — solid baseline
  if (/qwen.?3/i.test(id))          score += 60;  // Qwen 3 — competitive at size
  if (/gpt.?oss/i.test(id))         score += 30;  // OpenAI OSS — reliable fallback

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

/**
 * Picks the best text-generation model from a provider's /v1/models response.
 *
 * Accepts the full model objects (not just IDs) so it can use provider-supplied
 * metadata (active flag, context window, max completion tokens) when available.
 * Fields that are absent (e.g. Cerebras returns minimal objects) are treated as
 * passing — the filter only fires when a field is explicitly present and fails.
 *
 * Filter order:
 *   1. active === false  → skip (Groq marks deprecated models this way)
 *   2. context_window < 8192  → skip (prompt alone fills smaller windows)
 *   3. max_completion_tokens < 4096  → skip (can't emit full JSON output)
 *   4. scoreModelForTextGen < 0  → skip (audio, guard, TTS, compound models)
 *   5. Sort survivors by score descending → pick #1
 *
 * @param {Array<{id:string, active?:boolean, context_window?:number, max_completion_tokens?:number}>} models
 * @param {string} providerLabel  Used in log output only
 * @returns {string|null}
 */
function pickBestModel(models, providerLabel) {
  const candidates = models
    .filter((m) => {
      if (m.active === false) return false;
      if (m.context_window != null && m.context_window < _MIN_CONTEXT_WINDOW) return false;
      if (m.max_completion_tokens != null && m.max_completion_tokens < _MIN_MAX_COMPLETION_TOKENS) return false;
      return true;
    })
    .map((m) => ({ id: m.id, score: scoreModelForTextGen(m.id) }))
    .filter((m) => Number.isFinite(m.score) && m.score > -Infinity)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  const best = candidates[0];
  console.log(
    `[${providerLabel}] dynamic model: ${best.id} (score=${best.score}` +
    `, top3=${candidates.slice(0, 3).map((c) => c.id).join(", ")})`,
  );
  return best.id;
}

/**
 * Resolves the best available Groq model at runtime.
 * Cache-first (module-level, 1h TTL). Falls back to GROQ_MODEL constant.
 * @param {string} firstKey - First available Groq API key for the models query
 */
async function resolveGroqModel(firstKey) {
  const now = Date.now();
  if (_groqModelCache.model && now - _groqModelCache.at < _MODEL_CACHE_TTL_MS) {
    return _groqModelCache.model;
  }
  if (firstKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${firstKey}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const picked = pickBestModel(data?.data || [], "groq");
        if (picked) {
          _groqModelCache = { model: picked, at: now };
          return picked;
        }
      }
    } catch {
      // network error or timeout — use hardcoded constant below
    }
  }
  return GROQ_MODEL;
}

/**
 * Resolves the best available Cerebras model at runtime.
 * Cache-first (module-level, 1h TTL). Falls back to CEREBRAS_MODEL constant.
 * @param {string} firstKey - First available Cerebras API key for the models query
 */
async function resolveCerebrasModel(firstKey) {
  const now = Date.now();
  if (_cerebrasModelCache.model && now - _cerebrasModelCache.at < _MODEL_CACHE_TTL_MS) {
    return _cerebrasModelCache.model;
  }
  if (firstKey) {
    try {
      const res = await fetch("https://api.cerebras.ai/v1/models", {
        headers: { Authorization: `Bearer ${firstKey}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        const picked = pickBestModel(data?.data || [], "cerebras");
        if (picked) {
          _cerebrasModelCache = { model: picked, at: now };
          return picked;
        }
      }
    } catch {
      // network error or timeout — use hardcoded constant below
    }
  }
  return CEREBRAS_MODEL;
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

function getCerebrasKeys(env) {
  return [
    env.CEREBRAS_API_KEY,
    env.CEREBRAS_API_KEY_2,
    env.CEREBRAS_API_KEY_3,
    env.CEREBAS_API_KEY,
    env.CEREBAS_API_KEY_2,
    env.CEREBAS_API_KEY_3,
  ].filter(Boolean);
}

export function hasAnyTextAIProvider(env) {
  return Boolean(
    env?.AI ||
    env?.GROQ_API_KEY ||
    env?.GROQ_API_KEY_2 ||
    env?.GROQ_API_KEY_3 ||
    env?.GROQ_API_KEY_4 ||
    env?.GROQ_API_KEY_5 ||
    getOpenRouterKeys(env).length > 0 ||
    getCerebrasKeys(env).length > 0 ||
    env?.ANTHROPIC_API_KEY,
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
 * @param {object}   [env.BLOG_AI_KV]   KV for resolving the best CF model name
 * @param {Array}    messages            OpenAI-style chat messages array
 * @param {object}   [opts]
 * @param {number}   [opts.maxTokens=1024]
 * @param {number}   [opts.timeoutMs=12000]
 * @param {string}   [opts.cfModel]      Override CF model; if omitted resolves from KV
 * @returns {Promise<string>}  Raw text from the model
 */
export async function callAI(env, messages, { maxTokens = 1024, timeoutMs = 12_000, cfModel, temperature = 0.3 } = {}) {
  const failureReasons = [];
  const providerAttemptLimit = getProviderAttemptLimit(env);
  let providerAttempts = 0;

  // Resolve key arrays up front so model resolution can use the first available key.
  const groqKeys = [env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4, env.GROQ_API_KEY_5].filter(Boolean);
  const cerebrasKeys = getCerebrasKeys(env);

  // Dynamically resolve the best available model for each provider (cached 1h).
  // On a warm Worker instance this is synchronous (cache hit, 0 subrequests).
  // On a cold start it adds at most 2 lightweight /v1/models fetches.
  const [resolvedGroqModel, resolvedCerebrasModel] = await Promise.all([
    groqKeys.length > 0 ? resolveGroqModel(groqKeys[0]).catch(() => GROQ_MODEL) : Promise.resolve(GROQ_MODEL),
    cerebrasKeys.length > 0 ? resolveCerebrasModel(cerebrasKeys[0]).catch(() => CEREBRAS_MODEL) : Promise.resolve(CEREBRAS_MODEL),
  ]);

  // 1. Groq — preferred when configured, especially on Free-plan Workers where
  // Workers AI can consume the per-invocation subrequest budget too early.
  if (groqKeys.length === 0) {
    failureReasons.push("No Groq API keys configured");
  }
  for (const key of groqKeys) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: resolvedGroqModel,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data?.choices?.[0]?.message?.content ?? "").trim();
        if (text) return text;
        console.warn("Groq returned empty response");
        failureReasons.push("Groq returned empty response");
      }
      const errBody = await res.text().catch(() => "");
      console.warn(`Groq error ${res.status}: ${errBody.slice(0, 120)}`);
      failureReasons.push(`Groq error ${res.status}: ${errBody.slice(0, 120)}`);
    } catch (err) {
      console.warn(`Groq request failed (${err.message})`);
      failureReasons.push(`Groq request failed: ${err.message}`);
      if (isSubrequestLimitError(err)) break;
    }
  }
  if (hasSubrequestLimitFailure(failureReasons)) {
    throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
  }

  // 2. Cerebras — responsive OpenAI-compatible fallback with free API keys.
  if (cerebrasKeys.length > 0) {
    for (const cerebrasKey of cerebrasKeys) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      const res = await fetch(CEREBRAS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cerebrasKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: resolvedCerebrasModel,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data?.choices?.[0]?.message?.content ?? "").trim();
        if (text) return text;
        console.warn("Cerebras returned empty response");
        failureReasons.push("Cerebras returned empty response");
      } else {
        const errBody = await res.text().catch(() => "");
        console.warn(`Cerebras error ${res.status}: ${errBody.slice(0, 120)}`);
        failureReasons.push(`Cerebras error ${res.status}: ${errBody.slice(0, 120)}`);
      }
    } catch (err) {
      console.warn(`Cerebras request failed (${err.message})`);
      failureReasons.push(`Cerebras request failed: ${err.message}`);
      if (isSubrequestLimitError(err)) break;
    }
    }
    if (hasSubrequestLimitFailure(failureReasons)) {
      throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
    }
  } else {
    failureReasons.push("Cerebras API key missing");
  }

  // 3. OpenRouter — free router with OpenAI-compatible chat completions.
  const openRouterKeys = getOpenRouterKeys(env);
  if (openRouterKeys.length > 0) {
    for (const openRouterKey of openRouterKeys) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature,
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

  // 4. NVIDIA NIM — llama-4-maverick via integrate.api.nvidia.com (OpenAI-compatible).
  if (env.NVIDIA_API_KEY) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      const res = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages,
          max_tokens: Math.max(maxTokens, 8192),
          temperature,
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
      }
    } catch (err) {
      console.warn(`NVIDIA NIM request failed (${err.message})`);
      failureReasons.push(`NVIDIA NIM request failed: ${err.message}`);
      if (isSubrequestLimitError(err)) {
        throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
      }
    }
  } else {
    failureReasons.push("NVIDIA API key missing");
  }

  // 5. Anthropic — useful when Groq is rate-limited and Workers AI quota is exhausted.
  if (env.ANTHROPIC_API_KEY) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      const systemMessages = messages
        .filter((message) => message?.role === "system" && typeof message?.content === "string")
        .map((message) => message.content.trim())
        .filter(Boolean);
      const chatMessages = messages
        .filter((message) => message?.role !== "system")
        .map((message) => ({
          role: message?.role === "assistant" ? "assistant" : "user",
          content: typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? ""),
        }));

      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          temperature,
          ...(systemMessages.length > 0
            ? { system: systemMessages.join("\n\n") }
            : {}),
          messages: chatMessages.length > 0
            ? chatMessages
            : [{ role: "user", content: "Hello" }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const text = Array.isArray(data?.content)
          ? data.content
              .filter((item) => item?.type === "text" && typeof item?.text === "string")
              .map((item) => item.text)
              .join("")
              .trim()
          : "";
        if (text) return text;
        console.warn("Anthropic returned empty response");
        failureReasons.push("Anthropic returned empty response");
      } else {
        const errBody = await res.text().catch(() => "");
        console.warn(`Anthropic error ${res.status}: ${errBody.slice(0, 120)}`);
        failureReasons.push(`Anthropic error ${res.status}: ${errBody.slice(0, 120)}`);
      }
    } catch (err) {
      console.warn(`Anthropic request failed (${err.message})`);
      failureReasons.push(`Anthropic request failed: ${err.message}`);
      if (isSubrequestLimitError(err)) {
        throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
      }
    }
  } else {
    failureReasons.push("Anthropic API key missing");
  }

  // 6. Workers AI — built-in fallback when external providers are unavailable
  if (env.AI) {
    try {
      guardProviderAttempt(providerAttempts, providerAttemptLimit, failureReasons);
      providerAttempts += 1;
      const model = cfModel ?? (await resolveAiModel(env.BLOG_AI_KV).catch(() => null));
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Workers AI timeout")), timeoutMs),
      );
      const result = await Promise.race([
        env.AI.run(model, { messages, max_tokens: maxTokens }),
        timeout,
      ]);
      const rawValue = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
      const text = (typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)).trim();
      if (text) return text;
      console.warn("Workers AI returned empty response after Groq fallback");
      failureReasons.push("Workers AI returned empty response");
    } catch (err) {
      console.warn(`Workers AI failed (${err.message})`);
      failureReasons.push(`Workers AI failed: ${err.message}`);
      if (isSubrequestLimitError(err)) {
        throw new Error(`callAI failed. ${failureReasons.join(" | ")}`);
      }
    }
  } else {
    failureReasons.push("Workers AI binding missing");
  }

  throw new Error(
    `callAI failed. ${failureReasons.join(" | ") || "No provider failure details captured."}`,
  );
}
