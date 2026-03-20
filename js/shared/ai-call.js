/**
 * Shared AI text generation helper — Groq → Workers AI fallback chain.
 *
 * Provider priority:
 *   1. Groq  (env.GROQ_API_KEY)  — llama-3.3-70b-versatile, free 6,000 req/day
 *   2. Workers AI (env.AI)       — @cf/meta/llama-3.3-70b-instruct-fp8-fast, always available
 *
 * Set GROQ_API_KEY as a Worker secret to enable Groq:
 *   npx wrangler secret put GROQ_API_KEY --config wrangler.jsonc
 *   npx wrangler secret put GROQ_API_KEY --config wrangler-blog.jsonc
 *
 * @module shared/ai-call
 */

import { resolveAiModel } from "./ai-model.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

/**
 * Calls AI with a Groq → Workers AI fallback chain.
 * Always resolves to the raw text string from the model.
 * Throws only if both providers are unavailable.
 *
 * @param {object}   env
 * @param {string}   [env.GROQ_API_KEY]  Groq API key secret (optional)
 * @param {object}   [env.AI]            Workers AI binding
 * @param {object}   [env.BLOG_AI_KV]   KV for resolving the best CF model name
 * @param {Array}    messages            OpenAI-style chat messages array
 * @param {object}   [opts]
 * @param {number}   [opts.maxTokens=1024]
 * @param {number}   [opts.timeoutMs=12000]
 * @param {string}   [opts.cfModel]      Override CF model; if omitted resolves from KV
 * @returns {Promise<string>}  Raw text from the model
 */
export async function callAI(env, messages, { maxTokens = 1024, timeoutMs = 12_000, cfModel } = {}) {
  // 1. Groq — higher quality, faster, free tier 6,000 req/day
  if (env.GROQ_API_KEY) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        return (data?.choices?.[0]?.message?.content ?? "").trim();
      }
      const errBody = await res.text().catch(() => "");
      console.warn(`Groq error ${res.status}: ${errBody.slice(0, 120)} — falling back to Workers AI`);
    } catch (err) {
      console.warn(`Groq request failed (${err.message}) — falling back to Workers AI`);
    }
  }

  // 2. Workers AI — always available, no external quota
  if (!env.AI) throw new Error("callAI: no AI provider available (set GROQ_API_KEY or bind env.AI)");

  const model = cfModel ?? (await resolveAiModel(env.BLOG_AI_KV).catch(() => null));
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Workers AI timeout")), timeoutMs),
  );
  const result = await Promise.race([
    env.AI.run(model, { messages, max_tokens: maxTokens }),
    timeout,
  ]);
  const rawValue = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
  return (typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)).trim();
}
