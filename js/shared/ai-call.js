/**
 * Shared AI text generation helper — Workers AI → Groq fallback chain.
 *
 * Provider priority:
 *   1. Workers AI (env.AI)       — @cf/meta/llama-3.3-70b-instruct-fp8-fast, built-in
 *   2. Groq  (env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3)
 *        — llama-3.3-70b-versatile, fallback when Workers AI quota is exhausted
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
 *
 * @module shared/ai-call
 */

import { resolveAiModel } from "./ai-model.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

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
 * @param {object}   [env.BLOG_AI_KV]   KV for resolving the best CF model name
 * @param {Array}    messages            OpenAI-style chat messages array
 * @param {object}   [opts]
 * @param {number}   [opts.maxTokens=1024]
 * @param {number}   [opts.timeoutMs=12000]
 * @param {string}   [opts.cfModel]      Override CF model; if omitted resolves from KV
 * @returns {Promise<string>}  Raw text from the model
 */
export async function callAI(env, messages, { maxTokens = 1024, timeoutMs = 12_000, cfModel, temperature = 0.3 } = {}) {
  // 1. Workers AI — built-in, no external quota dependency
  if (env.AI) {
    try {
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
      console.warn("Workers AI returned empty response — falling back to Groq");
    } catch (err) {
      console.warn(`Workers AI failed (${err.message}) — falling back to Groq`);
    }
  }

  // 2. Groq — fallback when Workers AI quota is exhausted or unavailable
  const groqKeys = [env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3].filter(Boolean);
  for (const key of groqKeys) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        return (data?.choices?.[0]?.message?.content ?? "").trim();
      }
      const errBody = await res.text().catch(() => "");
      console.warn(`Groq error ${res.status}: ${errBody.slice(0, 120)}`);
    } catch (err) {
      console.warn(`Groq request failed (${err.message})`);
    }
  }

  throw new Error("callAI: no AI provider available (bind env.AI or set GROQ_API_KEY)");
}
