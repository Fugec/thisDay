/**
 * Shared AI text generation helper — Groq → OpenRouter → Cerebras → Anthropic → Workers AI fallback chain.
 *
 * Provider priority:
 *   1. Groq  (env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4)
 *        — preferred when available, keeps Free-plan Workers under subrequest limits
 *   2. OpenRouter (env.OPENROUTER_API_KEY... / env.OPENRUITER_API_KEY...) — free router support
 *   3. Cerebras (env.CEREBRAS_API_KEY... / env.CEREBAS_API_KEY...) — free API-key fallback
 *   4. Anthropic (env.ANTHROPIC_API_KEY) — external fallback when others are unavailable
 *   5. Workers AI (env.AI)       — @cf/meta/llama-3.3-70b-instruct-fp8-fast, last fallback
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
const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openrouter/free";
const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "llama3.1-8b";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-3-5-haiku-latest";

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

  // 1. Groq — preferred when configured, especially on Free-plan Workers where
  // Workers AI can consume the per-invocation subrequest budget too early.
  const groqKeys = [env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4, env.GROQ_API_KEY_5].filter(Boolean);
  if (groqKeys.length === 0) {
    failureReasons.push("No Groq API keys configured");
  }
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
    }
  }

  // 2. OpenRouter — free router with OpenAI-compatible chat completions.
  const openRouterKeys = getOpenRouterKeys(env);
  if (openRouterKeys.length > 0) {
    for (const openRouterKey of openRouterKeys) {
    try {
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
    }
    }
  } else {
    failureReasons.push("OpenRouter API key missing");
  }

  // 3. Cerebras — OpenAI-compatible fallback with free API keys.
  const cerebrasKeys = getCerebrasKeys(env);
  if (cerebrasKeys.length > 0) {
    for (const cerebrasKey of cerebrasKeys) {
    try {
      const res = await fetch(CEREBRAS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cerebrasKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CEREBRAS_MODEL,
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
    }
    }
  } else {
    failureReasons.push("Cerebras API key missing");
  }

  // 4. Anthropic — useful when Groq is rate-limited and Workers AI quota is exhausted.
  if (env.ANTHROPIC_API_KEY) {
    try {
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
    }
  } else {
    failureReasons.push("Anthropic API key missing");
  }

  // 5. Workers AI — built-in fallback when external providers are unavailable
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
      console.warn("Workers AI returned empty response after Groq fallback");
      failureReasons.push("Workers AI returned empty response");
    } catch (err) {
      console.warn(`Workers AI failed (${err.message})`);
      failureReasons.push(`Workers AI failed: ${err.message}`);
    }
  } else {
    failureReasons.push("Workers AI binding missing");
  }

  throw new Error(
    `callAI failed. ${failureReasons.join(" | ") || "No provider failure details captured."}`,
  );
}
