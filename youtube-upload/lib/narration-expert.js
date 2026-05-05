import { recordQuotaSignal } from "./tracker.js";
import { resolveGroqModels, resolveHFTextModel } from "./model-resolver.js";

/**
 * Narration Expert — rewrites DYK / Quick Facts content items into engaging
 * documentary-style voiceover sentences before sending to ElevenLabs TTS.
 *
 * Uses the full article text as context so the AI can draw on additional
 * historical detail beyond the bullet points alone.
 *
 * Provider fallback chain (first available key wins):
 *   1. Groq  — best free model auto-resolved via resolveGroqModels() (default: llama-3.3-70b-versatile)
 *              Keys: GROQ_API_KEY → GROQ_API_KEY_2 → GROQ_API_KEY_3 → GROQ_API_KEY_4
 *   2. HuggingFace — best free instruct model auto-resolved via resolveHFTextModel()
 *              Tokens: HF_TOKEN → HF_TOKEN_2 → HF_TOKEN_3 → HF_TOKEN_4
 *
 * If all providers fail the originals are returned silently — TTS continues
 * normally with the unpolished facts.
 */

// ---------------------------------------------------------------------------
// Provider definitions (same chain as history-expert.js)
// ---------------------------------------------------------------------------

function buildProviders(textModel, hfModelId, hfUrl) { return [
  {
    name: "Groq",
    envKey: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: textModel,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "Groq (key 2)",
    envKey: "GROQ_API_KEY_2",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: textModel,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "Groq (key 3)",
    envKey: "GROQ_API_KEY_3",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: textModel,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "Groq (key 4)",
    envKey: "GROQ_API_KEY_4",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: textModel,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "HuggingFace",
    envKey: "HF_TOKEN",
    url: hfUrl,
    model: hfModelId,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-use-cache": "0",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
      stream: false,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "HuggingFace (token 2)",
    envKey: "HF_TOKEN_2",
    url: hfUrl,
    model: hfModelId,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-use-cache": "0",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
      stream: false,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "HuggingFace (token 3)",
    envKey: "HF_TOKEN_3",
    url: hfUrl,
    model: hfModelId,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-use-cache": "0",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
      stream: false,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "HuggingFace (token 4)",
    envKey: "HF_TOKEN_4",
    url: hfUrl,
    model: hfModelId,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-use-cache": "0",
    }),
    body: (model, messages) => ({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.5,
      stream: false,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
]; }

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are a professional documentary scriptwriter specialising in history.
Your task is to rewrite dry factual bullet points into vivid, engaging
narration sentences for a 45-second YouTube Short voiceover, optimised for ElevenLabs TTS.

You are provided with the full article text as background context — use it
to add compelling details, but only rephrase what is supported by the sources.

Style guide:
- Write in a warm, authoritative documentary tone (think BBC/Netflix history docs)
- Open with strong hooks: specific numbers, dramatic contrasts, or vivid imagery
- Use active voice and present-tense verbs where they add urgency ("Soviet forces surround…")
- Keep each item as ONE sentence or two short connected sentences — no lists
- Avoid starting consecutive items with the same word
- Do not begin items with the calendar date or repeat the title date; the video card already shows it
- If a fact starts with "On [Month] [day]" or "[Month] [day], [year]", remove that lead-in and start with the actor, number, or action
- Do NOT invent facts not present in the original items or the article text
- Use contractions naturally ("didn't", "wasn't", "he'd") — stiff formal language kills TTS pacing
- Grammar must be perfect — check plurals and verb agreement before returning
- Each rewritten item must be under 350 characters (for TTS pacing)
- Return ONLY a JSON array of exactly N rewritten strings, no other text, no markdown`;

// ---------------------------------------------------------------------------
// Per-provider call
// ---------------------------------------------------------------------------

async function callProvider(provider, apiKey, messages) {
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.headers(apiKey),
    body: JSON.stringify(provider.body(provider.model, messages)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return provider.extractText(data).trim();
}

// ---------------------------------------------------------------------------
// Parse and validate the raw LLM response
// ---------------------------------------------------------------------------

function parseResponse(raw, expectedLength) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let items;
  try {
    items = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(items) || items.length !== expectedLength) return null;
  if (!items.every((s) => typeof s === "string" && s.trim().length > 10))
    return null;
  return items.map((s) => s.trim());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rewrites content items (DYK bullets / Quick Facts) into engaging
 * documentary-style voiceover sentences, using the full article text
 * as additional context.
 *
 * @param {string}      title        Post title (event name + date)
 * @param {string[]}    items        Raw content items from KV
 * @param {string|null} articleText  Full article prose from getArticleText()
 * @returns {Promise<string[]>}  Rewritten items, or originals on failure
 */
export async function polishNarrationItems(title, items, articleText = null) {
  if (!items || items.length === 0) return items;

  const userContent = [
    `Event: ${title}`,
    "",
    articleText ? `Full article context:\n${articleText}` : null,
    "",
    `Rewrite these ${items.length} facts into engaging documentary voiceover sentences.`,
    `Return a JSON array of exactly ${items.length} strings.`,
    "",
    ...items.map((item, i) => `Item ${i + 1}:\n${item}`),
  ]
    .filter((l) => l !== null)
    .join("\n");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const { textModel } = await resolveGroqModels();
  const { modelId: hfModelId, url: hfUrl } = await resolveHFTextModel();
  const providers = buildProviders(textModel, hfModelId, hfUrl);

  for (const provider of providers) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      console.log(
        `  ℹ Narration expert: ${provider.envKey} not set — skipping ${provider.name}`,
      );
      continue;
    }

    console.log(
      `  → Narration expert (${provider.name}): polishing ${items.length} items for "${title.slice(0, 50)}..."`,
    );

    let raw;
    try {
      raw = await callProvider(provider, apiKey, messages);
    } catch (err) {
      if (/429|rate limit|quota|too many|403/i.test(err.message)) {
        await recordQuotaSignal(
          "groq-narration",
          `${provider.name}: ${err.message}`,
        );
      }
      console.warn(
        `  ⚠ Narration expert (${provider.name}): ${err.message} — trying next provider`,
      );
      continue;
    }

    const polished = parseResponse(raw, items.length);
    if (!polished) {
      console.warn(
        `  ⚠ Narration expert (${provider.name}): invalid response — trying next provider\n    Got: ${raw.slice(0, 200)}`,
      );
      continue;
    }

    polished.forEach((p, i) => {
      if (p !== items[i]) console.log(`  ✎ Item ${i + 1} polished`);
    });
    console.log(`  ✓ Narration expert complete (${provider.name})`);
    return polished;
  }

  console.warn(
    "  ⚠ Narration expert: all providers unavailable — using original items",
  );
  return items;
}
