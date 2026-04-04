import { recordQuotaSignal } from "./tracker.js";
import { resolveGroqModels, resolveHFTextModel } from "./model-resolver.js";

/**
 * History Expert — reviews and corrects image generation prompts for historical
 * accuracy before sending to FLUX / HuggingFace image generation.
 *
 * Provider fallback chain (first available key wins):
 *   1. Groq  — best free model auto-resolved via resolveGroqModels() (default: llama-3.3-70b-versatile)
 *              Keys: GROQ_API_KEY → GROQ_API_KEY_2 → GROQ_API_KEY_3 → GROQ_API_KEY_4
 *   2. HuggingFace — best free instruct model auto-resolved via resolveHFTextModel()
 *              (default: meta-llama/Llama-3.1-8B-Instruct via router.huggingface.co)
 *              Tokens: HF_TOKEN → HF_TOKEN_2 → HF_TOKEN_3
 *
 * If both providers fail the originals are returned silently — image generation
 * continues normally without the accuracy review.
 */

// ---------------------------------------------------------------------------
// Provider definitions — Groq model resolved at call time via resolveGroqModels()
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
      temperature: 0.3,
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
      temperature: 0.3,
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
      temperature: 0.3,
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
      temperature: 0.3,
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
      temperature: 0.3,
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
      temperature: 0.3,
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
      temperature: 0.3,
      stream: false,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
]; }

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Shared prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are a historian and visual accuracy consultant for historical image generation.
Review AI image prompts for a given historical event and correct any inaccuracies
so the generated images look authentically period-correct.

Focus on:
- Uniforms: correct nation, branch, year, and theater-specific variants (e.g. winter vs summer)
- Weapons: exact models fielded by that unit at that date (no anachronisms)
- Vehicles and equipment: correct marks/variants for the year
- Geography and environment: correct terrain, vegetation, architecture, weather if documented
- Iconic visual signatures of the specific event that distinguish it from generic scenes

Rules:
- Keep each corrected prompt under 300 characters
- Preserve the scene purpose (wide shot / action / aftermath) — only correct historical details
- Return ONLY a JSON array of exactly N corrected prompt strings, no other text, no markdown
- If a prompt is already accurate, return it unchanged
- Do not add modern elements or anachronisms`;

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
// Parse and validate the raw LLM text into a corrected prompts array
// ---------------------------------------------------------------------------

function parseResponse(raw, expectedLength) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let corrected;
  try {
    corrected = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(corrected) || corrected.length !== expectedLength)
    return null;
  return corrected;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reviews and corrects image prompts for historical accuracy.
 * Tries Groq first, falls back to HuggingFace, then returns originals.
 *
 * @param {string}      event    Human-readable event name (date suffix stripped)
 * @param {number|null} year     Event year, or null if unknown
 * @param {string}      era      Era label from getHistoricalEraContext()
 * @param {string[]}    prompts  Raw prompts from buildScenePrompts()
 * @returns {Promise<string[]>}
 */
export async function reviewPromptsWithHistoryExpert(
  event,
  year,
  era,
  prompts,
) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Event: ${event}`,
        year ? `Year: ${year}` : null,
        `Era: ${era}`,
        "",
        `Review and correct these ${prompts.length} image prompts for historical accuracy.`,
        `Return a JSON array of exactly ${prompts.length} strings.`,
        "",
        ...prompts.map((p, i) => `Prompt ${i + 1}:\n${p}`),
      ]
        .filter((l) => l !== null)
        .join("\n"),
    },
  ];

  const { textModel } = await resolveGroqModels();
  const { modelId: hfModelId, url: hfUrl } = await resolveHFTextModel();
  const providers = buildProviders(textModel, hfModelId, hfUrl);

  for (const provider of providers) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      console.log(
        `  ℹ History expert: ${provider.envKey} not set — skipping ${provider.name}`,
      );
      continue;
    }

    console.log(
      `  → History expert (${provider.name}): reviewing ${prompts.length} prompts for "${event}" (${era})...`,
    );

    let raw;
    try {
      raw = await callProvider(provider, apiKey, messages);
    } catch (err) {
      if (/429|rate limit|quota|too many|403/i.test(err.message)) {
        await recordQuotaSignal(
          "groq-history",
          `${provider.name}: ${err.message}`,
        );
      }
      console.warn(
        `  ⚠ History expert (${provider.name}): ${err.message} — trying next provider`,
      );
      continue;
    }

    const corrected = parseResponse(raw, prompts.length);
    if (!corrected) {
      console.warn(
        `  ⚠ History expert (${provider.name}): invalid response — trying next provider\n    Got: ${raw.slice(0, 200)}`,
      );
      continue;
    }

    corrected.forEach((p, i) => {
      if (p !== prompts[i])
        console.log(`  ✎ Scene ${i + 1} corrected by history expert`);
    });
    console.log(`  ✓ History expert review complete (${provider.name})`);
    return corrected;
  }

  console.warn(
    "  ⚠ History expert: all providers unavailable — using original prompts",
  );
  return prompts;
}
