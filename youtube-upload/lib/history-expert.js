/**
 * History Expert — reviews and corrects image generation prompts for historical
 * accuracy before sending to FLUX / HuggingFace image generation.
 *
 * Provider fallback chain (first available key wins):
 *   1. Groq  — llama-3.3-70b-versatile, free tier 6,000 req/day, no monthly cap
 *              Get key: https://console.groq.com/keys  →  GROQ_API_KEY
 *   2. HuggingFace — meta-llama/Meta-Llama-3.1-8B-Instruct via Inference API
 *              Same HF_TOKEN already used for FLUX image generation.
 *              Falls back only if Groq key is absent or Groq returns an error.
 *
 * If both providers fail the originals are returned silently — image generation
 * continues normally without the accuracy review.
 */

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    name: "Groq",
    envKey: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
    body: (model, messages) => ({ model, messages, max_tokens: 1024, temperature: 0.3 }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
  {
    name: "HuggingFace",
    envKey: "HF_TOKEN",
    url: "https://router.huggingface.co/hf-inference/models/meta-llama/Meta-Llama-3.1-8B-Instruct/v1/chat/completions",
    model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-use-cache": "0",
    }),
    body: (model, messages) => ({ model, messages, max_tokens: 1024, temperature: 0.3, stream: false }),
    extractText: (data) => data?.choices?.[0]?.message?.content ?? "",
  },
];

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
  try { corrected = JSON.parse(match[0]); } catch { return null; }
  if (!Array.isArray(corrected) || corrected.length !== expectedLength) return null;
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
export async function reviewPromptsWithHistoryExpert(event, year, era, prompts) {
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

  for (const provider of PROVIDERS) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      console.log(`  ℹ History expert: ${provider.envKey} not set — skipping ${provider.name}`);
      continue;
    }

    console.log(`  → History expert (${provider.name}): reviewing ${prompts.length} prompts for "${event}" (${era})...`);

    let raw;
    try {
      raw = await callProvider(provider, apiKey, messages);
    } catch (err) {
      console.warn(`  ⚠ History expert (${provider.name}): ${err.message} — trying next provider`);
      continue;
    }

    const corrected = parseResponse(raw, prompts.length);
    if (!corrected) {
      console.warn(`  ⚠ History expert (${provider.name}): invalid response — trying next provider\n    Got: ${raw.slice(0, 200)}`);
      continue;
    }

    corrected.forEach((p, i) => {
      if (p !== prompts[i]) console.log(`  ✎ Scene ${i + 1} corrected by history expert`);
    });
    console.log(`  ✓ History expert review complete (${provider.name})`);
    return corrected;
  }

  console.warn("  ⚠ History expert: all providers unavailable — using original prompts");
  return prompts;
}
