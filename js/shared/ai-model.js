/**
 * Shared AI model resolution — auto-updates to the latest available
 * Cloudflare Workers AI text-generation model via a weekly cron check.
 *
 * Import:
 *   import { resolveAiModel, checkAndUpdateAiModel, CF_AI_MODEL } from "./shared/ai-model.js";
 *
 * Usage:
 *   const model = await resolveAiModel(env.BLOG_AI_KV);
 *   await env.AI.run(model, { messages: [...] });
 *
 * Auto-update (in scheduled handler):
 *   await checkAndUpdateAiModel(env, env.BLOG_AI_KV);
 *   Requires CF_API_TOKEN secret set on the worker via:
 *     npx wrangler secret put CF_API_TOKEN
 */

// Hardcoded fallback — used when KV has no override stored yet
export const CF_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const AI_MODEL_KV_KEY = "ai-model-override";
const CF_ACCOUNT_ID = "b1b63aec792a52fb199b8ebfb8eed4b1";

// Module-level cache — avoids a KV read on every AI call within the same worker instance
let _cachedModel = null;

/**
 * Returns the best available AI model name.
 * Reads from KV on first call, then caches in memory for the worker instance lifetime.
 * @param {KVNamespace} kvNamespace
 */
export async function resolveAiModel(kvNamespace) {
  if (_cachedModel) return _cachedModel;
  try {
    const stored = await kvNamespace.get(AI_MODEL_KV_KEY);
    if (stored) { _cachedModel = stored; return stored; }
  } catch (_) { /* KV unavailable — fall through */ }
  _cachedModel = CF_AI_MODEL;
  return CF_AI_MODEL;
}

/**
 * Scores a CF AI model name — higher is better.
 * Prefers: newer llama version > more parameters > fp8-fast.
 */
function scoreModel(name) {
  let score = 0;
  const vMatch = name.match(/llama-(\d+)(?:[._-](\d+))?/i);
  if (vMatch) {
    score += parseInt(vMatch[1], 10) * 100;
    score += parseInt(vMatch[2] || 0, 10) * 10;
  }
  if (/70b/i.test(name)) score += 7;
  else if (/8b/i.test(name)) score += 4;
  else if (/7b/i.test(name)) score += 3;
  if (/fp8-fast/i.test(name)) score += 2;
  else if (/fp8/i.test(name)) score += 1;
  return score;
}

/**
 * Calls the CF AI models API, finds the best @cf/meta/llama instruct model,
 * and updates KV + the in-memory cache if a better model is available.
 *
 * Requires env.CF_API_TOKEN worker secret. Silently skips if not set.
 * @param {object}       env          Worker env (must have CF_API_TOKEN secret)
 * @param {KVNamespace}  kvNamespace  Where to persist the override
 */
export async function checkAndUpdateAiModel(env, kvNamespace) {
  if (!env.CF_API_TOKEN) {
    console.log("AI model check: CF_API_TOKEN secret not set — skipping");
    return;
  }
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/models/search?task=text-generation&per_page=100`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    });
    if (!r.ok) {
      console.warn("AI model check: CF API returned", r.status);
      return;
    }
    const data = await r.json();
    const models = (data.result || [])
      .map((m) => m.name)
      .filter(
        (n) =>
          typeof n === "string" &&
          n.startsWith("@cf/meta/llama") &&
          /instruct/i.test(n),
      );
    if (!models.length) {
      console.warn("AI model check: no matching models found in CF catalog");
      return;
    }
    const best = models.sort((a, b) => scoreModel(b) - scoreModel(a))[0];
    const current =
      (await kvNamespace.get(AI_MODEL_KV_KEY)) || CF_AI_MODEL;
    if (best !== current) {
      await kvNamespace.put(AI_MODEL_KV_KEY, best);
      _cachedModel = best;
      console.log(`AI model updated: ${current} → ${best}`);
    } else {
      console.log(`AI model up to date: ${current}`);
    }
  } catch (e) {
    console.error("checkAndUpdateAiModel failed:", e);
  }
}
