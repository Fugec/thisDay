import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  __contentGenerationTestHooks as hooks,
} from "../js/blog-ai-worker.js";
import {
  __resetGroqModelCacheForTests,
  aiProviderRetryAt,
  callAI,
  callWorkersAIDirect,
  isAIProviderCapacityError,
} from "../js/shared/ai-call.js";

function makeKvMock() {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async get(key, options = {}) {
      const value = store.has(key) ? store.get(key) : null;
      if (options?.type === "json" && typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    },
    async put(key, value, options = {}) {
      store.set(key, String(value));
      puts.push({ key, value: String(value), options });
    },
  };
}

test("protected topic families cannot reopen while a fresh family exists", () => {
  const repeatedAviation = {
    pageTitle: "Boeing 707",
    eventTitle: "A Boeing 707 crashes near Agadir",
    text: "A Boeing 707 aircraft crashes near Agadir.",
  };
  const freshComputing = {
    pageTitle: "TRS-80",
    eventTitle: "Tandy announces the TRS-80 personal computer",
    text: "Tandy announces one of the first mass-produced personal computers.",
  };
  const guarded = hooks.filterRecentEventFamilyRepeats(
    [repeatedAviation, freshComputing],
    ["aviation"],
  );
  assert.deepEqual(
    guarded.candidates.map((candidate) => candidate.pageTitle),
    ["TRS-80"],
  );
  assert.equal(guarded.candidates[0].eventFamilyFallbackUsed, undefined);
  assert.deepEqual(
    guarded.suppressed.map((candidate) => candidate.pageTitle),
    ["Boeing 707"],
  );

  const noFresh = hooks.filterRecentEventFamilyRepeats(
    [repeatedAviation],
    ["aviation"],
  );
  assert.equal(noFresh.candidates[0].eventFamilyFallbackUsed, true);
  assert.equal(
    noFresh.candidates[0].eventFamilyFallbackReason,
    "no-eligible-fresh-family",
  );

  const recentIndex = [{
    publishedAt: "2026-07-29T09:31:07.614Z",
    eventTitle: "Debris from MH370 discovered on Reunion Island",
    sourcePageTitle: "Malaysia Airlines Flight 370",
  }];
  const legacyFallback = hooks.preparedDraftSourceFamilyPolicy(
    { ...repeatedAviation, eventFamilyFallbackUsed: true },
    recentIndex,
    new Date("2026-08-03T12:00:00.000Z"),
  );
  assert.equal(legacyFallback.ok, false);

  const provenNoFreshFallback = hooks.preparedDraftSourceFamilyPolicy(
    {
      ...repeatedAviation,
      eventFamilyFallbackUsed: true,
      eventFamilyFallbackReason: "no-eligible-fresh-family",
    },
    recentIndex,
    new Date("2026-08-03T12:00:00.000Z"),
  );
  assert.equal(provenNoFreshFallback.ok, true);
});

test("date-specific event sources are checked before broad subject pages", () => {
  const ranked = hooks.prioritizeDedicatedEventSourceCandidates([
    { pageTitle: "Niger" },
    { pageTitle: "Firestone (company)" },
    { pageTitle: "2023 Slovenia floods" },
    { pageTitle: "2019 El Paso shooting" },
    { pageTitle: "La Scala" },
  ]);
  assert.deepEqual(
    ranked.map((candidate) => candidate.pageTitle),
    [
      "2023 Slovenia floods",
      "2019 El Paso shooting",
      "Niger",
      "Firestone (company)",
      "La Scala",
    ],
  );
});

test("a Groq 429 opens one durable shared circuit instead of probing all seven keys", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  let modelRequests = 0;
  let completionRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      modelRequests += 1;
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      completionRequests += 1;
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Rate limit reached: requests per day for this organization",
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "3600",
          },
        },
      );
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const env = {
    BLOG_AI_KV: kv,
    GROQ_API_KEY: "quota-key-1",
    GROQ_API_KEY_2: "quota-key-2",
    GROQ_API_KEY_3: "quota-key-3",
    GROQ_API_KEY_4: "quota-key-4",
    GROQ_API_KEY_5: "quota-key-5",
    GROQ_API_KEY_6: "quota-key-6",
    GROQ_API_KEY_7: "quota-key-7",
  };
  try {
    let firstError;
    await assert.rejects(
      callAI(env, [{ role: "user", content: "write article" }]),
      (error) => {
        firstError = error;
        return isAIProviderCapacityError(error);
      },
    );
    assert.equal(completionRequests, 1);
    assert.equal(modelRequests, 1);
    assert.ok(aiProviderRetryAt(firstError));
    assert.equal(
      kv.puts.filter((entry) =>
        entry.key.startsWith("ai-provider-circuit-v1:")
      ).length,
      1,
    );

    // A fresh module/isolate cache still reads the circuit from durable KV.
    __resetGroqModelCacheForTests();
    await assert.rejects(
      callAI(env, [{ role: "user", content: "write article again" }]),
      isAIProviderCapacityError,
    );
    assert.equal(completionRequests, 1);
    assert.equal(modelRequests, 1);
    assert.equal(kv.puts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("a rate-limited Groq pool does not block a declared independent pool", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  const completionKeys = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      const key = String(init.headers.Authorization).replace("Bearer ", "");
      completionKeys.push(key);
      if (key === "pool-a-key") {
        return new Response(
          JSON.stringify({ error: { message: "Rate limit reached" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "60",
            },
          },
        );
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "independent-pool-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const result = await callAI(
      {
        BLOG_AI_KV: kv,
        GROQ_API_KEY: "pool-a-key",
        GROQ_API_KEY_2: "pool-b-key",
        GROQ_QUOTA_POOL_IDS: "organization-a,organization-b",
      },
      [{ role: "user", content: "write one safe chunk" }],
    );
    assert.equal(result, "independent-pool-ok");
    assert.deepEqual(completionKeys, ["pool-a-key", "pool-b-key"]);
    const circuit = JSON.parse(kv.puts[0].value);
    assert.ok(circuit.providers["groq:organization-a"]);
    assert.equal(circuit.providers["groq:organization-b"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("missing Groq capacity headers never create a false zero-capacity deferral", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  let completionRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      completionRequests += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: `ok-${completionRequests}` } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const env = { GROQ_API_KEY: "no-header-key" };
    assert.equal(
      await callAI(env, [{ role: "user", content: "first request" }]),
      "ok-1",
    );
    assert.equal(
      await callAI(env, [{ role: "user", content: "second request" }]),
      "ok-2",
    );
    assert.equal(completionRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("a warm Worker refreshes a circuit written by another invocation", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  let completionRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      completionRequests += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "first-call-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const env = { BLOG_AI_KV: kv, GROQ_API_KEY: "warm-worker-key" };
  try {
    assert.equal(
      await callAI(env, [{ role: "user", content: "first request" }]),
      "first-call-ok",
    );
    const now = Date.now();
    const date = new Date(now).toISOString().slice(0, 10);
    kv.store.set(
      `ai-provider-circuit-v1:${date}`,
      JSON.stringify({
        version: 1,
        date,
        providers: {
          "groq:shared": {
            retryAt: new Date(now + 3_600_000).toISOString(),
            reason: "written by another Worker isolate",
            observedAt: new Date(now).toISOString(),
          },
        },
      }),
    );

    await assert.rejects(
      callAI(env, [{ role: "user", content: "second request" }]),
      isAIProviderCapacityError,
    );
    assert.equal(completionRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("a partial Groq pool map is treated as one shared quota", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  let completionRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      completionRequests += 1;
      return new Response(
        JSON.stringify({ error: { message: "Rate limit reached" } }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "3600",
          },
        },
      );
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    await assert.rejects(
      callAI(
        {
          BLOG_AI_KV: kv,
          GROQ_API_KEY: "partial-key-1",
          GROQ_API_KEY_2: "partial-key-2",
          GROQ_API_KEY_3: "partial-key-3",
          GROQ_QUOTA_POOL_IDS: "organization-a,organization-b",
        },
        [{ role: "user", content: "one bounded request" }],
      ),
      isAIProviderCapacityError,
    );
    assert.equal(completionRequests, 1);
    const circuit = JSON.parse(kv.puts[0].value);
    assert.ok(circuit.providers["groq:shared"]);
    assert.equal(circuit.providers["groq:organization-a"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("Groq token headroom defers the next oversized request before it is sent", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  let completionRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      completionRequests += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "first-chunk-ok" } }],
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining-tokens": "100",
          "x-ratelimit-reset-tokens": "30s",
          "x-ratelimit-remaining-requests": "99",
          "x-ratelimit-reset-requests": "1s",
        },
      });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const env = {
    BLOG_AI_KV: kv,
    GROQ_API_KEY: "headroom-key",
  };
  try {
    assert.equal(
      await callAI(
        env,
        [{ role: "user", content: "generate the first article chunk" }],
        { maxTokens: 1024 },
      ),
      "first-chunk-ok",
    );
    await assert.rejects(
      callAI(
        env,
        [{ role: "user", content: "generate the next article chunk" }],
        { maxTokens: 1024 },
      ),
      isAIProviderCapacityError,
    );
    assert.equal(completionRequests, 1);
    assert.equal(
      kv.puts.filter((entry) =>
        entry.key.startsWith("ai-provider-circuit-v1:")
      ).length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("Workers AI daily exhaustion is remembered across invocations", async () => {
  __resetGroqModelCacheForTests();
  const kv = makeKvMock();
  let workerCalls = 0;
  const env = {
    BLOG_AI_KV: kv,
    AI: {
      async run() {
        workerCalls += 1;
        throw new Error(
          "Account limited: you have used up your daily free allocation of 10,000 neurons",
        );
      },
    },
  };

  await assert.rejects(
    callWorkersAIDirect(
      env,
      [{ role: "user", content: "capacity test" }],
      { cfModel: "@cf/test/model" },
    ),
    isAIProviderCapacityError,
  );
  assert.equal(workerCalls, 1);
  assert.equal(kv.puts.length, 1);

  __resetGroqModelCacheForTests();
  await assert.rejects(
    callWorkersAIDirect(
      env,
      [{ role: "user", content: "capacity test again" }],
      { cfModel: "@cf/test/model" },
    ),
    isAIProviderCapacityError,
  );
  assert.equal(workerCalls, 1);
  assert.equal(kv.puts.length, 1);
});

test("NVIDIA rate limits are remembered instead of retried by a fresh invocation", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  let nvidiaCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("integrate.api.nvidia.com/v1/chat/completions")) {
      nvidiaCalls += 1;
      return new Response(
        JSON.stringify({
          detail: "Rate limit reached: requests per day",
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "3600",
          },
        },
      );
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const env = {
    BLOG_AI_KV: kv,
    NVIDIA_API_KEY: "nvidia-capacity-key",
  };
  try {
    await assert.rejects(
      callAI(env, [{ role: "user", content: "NVIDIA capacity test" }]),
      isAIProviderCapacityError,
    );
    assert.equal(nvidiaCalls, 1);

    __resetGroqModelCacheForTests();
    await assert.rejects(
      callAI(env, [{ role: "user", content: "NVIDIA capacity test again" }]),
      isAIProviderCapacityError,
    );
    assert.equal(nvidiaCalls, 1);
    assert.equal(kv.puts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("a blocked Groq pool does not hide a separately declared pool", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
  const usedKeys = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "llama-3.3-70b-versatile",
          active: true,
          context_window: 131072,
          max_completion_tokens: 32768,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      const key = String(init.headers.Authorization).replace("Bearer ", "");
      usedKeys.push(key);
      if (key === "pool-a-key") {
        return new Response(
          '{"error":{"message":"tokens per minute limit reached"}}',
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
            },
          },
        );
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "pool-b-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    assert.equal(
      await callAI(
        {
          BLOG_AI_KV: kv,
          GROQ_API_KEY: "pool-a-key",
          GROQ_API_KEY_2: "pool-b-key",
          GROQ_QUOTA_POOL_IDS: "organization-a,organization-b",
        },
        [{ role: "user", content: "independent quota pools" }],
      ),
      "pool-b-ok",
    );
    assert.deepEqual(usedKeys, ["pool-a-key", "pool-b-key"]);
    assert.equal(kv.puts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("validated article chunks survive a later provider failure and source changes invalidate them", async () => {
  const kv = makeKvMock();
  const env = { BLOG_AI_KV: kv };
  const date = new Date("2026-07-24T12:00:00Z");
  const fingerprint = hooks.articleGenerationSourceFingerprint(
    "Treaty of Lausanne",
    "grounded source material",
  );
  const journal = await hooks.loadArticleGenerationJournal(
    env,
    date,
    fingerprint,
  );
  const checkpoint = hooks.createArticleGenerationCheckpointer(
    env,
    date,
    journal,
  );
  await checkpoint.save("brief", { title: "Treaty brief" });
  await checkpoint.save("bodyA", {
    overviewParagraphs: ["one", "two"],
    eyewitnessOrChronicle: ["three", "four"],
  });

  const resumed = await hooks.loadArticleGenerationJournal(
    env,
    date,
    fingerprint,
  );
  assert.equal(resumed.chunks.brief.title, "Treaty brief");
  assert.equal(resumed.chunks.bodyA.overviewParagraphs.length, 2);
  assert.equal(kv.puts.length, 2);

  const changed = await hooks.loadArticleGenerationJournal(
    env,
    date,
    hooks.articleGenerationSourceFingerprint(
      "Different event",
      "different grounded material",
    ),
  );
  assert.deepEqual(changed.chunks, {});
  const stricter = await hooks.loadArticleGenerationJournal(
    env,
    date,
    hooks.articleGenerationSourceFingerprint(
      "Treaty of Lausanne",
      "grounded source material",
      JSON.stringify({
        stricterGrounding: true,
        groundingFeedback: ["unsupported causal claim"],
      }),
    ),
  );
  assert.deepEqual(stricter.chunks, {});
});

test("capacity failures are never retried as malformed chunk output", () => {
  const capacity = new Error("AI provider capacity unavailable until reset");
  capacity.code = "AI_CAPACITY_UNAVAILABLE";
  assert.equal(hooks.shouldRetryChunkOutputFailure(capacity), false);
  assert.equal(
    hooks.shouldRetryChunkOutputFailure(
      new Error("chunked article facts: didYouKnowFacts must contain 4 items"),
    ),
    true,
  );
  assert.equal(
    hooks.shouldRetryChunkOutputFailure(
      new Error("callAI failed. NVIDIA NIM request failed: timeout"),
    ),
    false,
  );
});

test("invalid checkpoint chunks are discarded before reuse", () => {
  const journal = {
    chunks: {
      facts: { quickFacts: [] },
    },
  };
  const reused = hooks.reusableArticleGenerationChunk(
    journal,
    "facts",
    () => {
      throw new Error("facts checkpoint is incomplete");
    },
  );
  assert.equal(reused, null);
  assert.equal(journal.chunks.facts, undefined);
});

test("a split conclusion uses a compact one-paragraph output contract", async () => {
  let invocation = null;
  const paragraph = Array(150).fill("grounded").join(" ") + ".";
  const result = await hooks.generateChunkedArticleBodyField(
    {},
    "model",
    "conclusionParagraphs",
    "Authoritative source material.",
    { eventTitle: "Treaty of Greenville" },
    { aftermathParagraphs: [paragraph] },
    async (_env, _model, label, prompt, maxTokens) => {
      invocation = { label, prompt, maxTokens };
      return { conclusionParagraphs: [paragraph] };
    },
  );

  assert.equal(invocation.label, "chunked article conclusionParagraphs");
  assert.equal(invocation.maxTokens, 700);
  assert.match(invocation.prompt, /array must contain exactly 1 paragraph\./);
  assert.match(invocation.prompt, /Do not exceed 220 words total\./);
  assert.doesNotMatch(invocation.prompt, /"paragraph 2"/);
  assert.equal(result.conclusionParagraphs.length, 1);
});

test("article generation request budget reserves one bounded replacement topic and resets on a new UTC day", async () => {
  const kv = makeKvMock();
  const env = {
    BLOG_AI_KV: kv,
    ARTICLE_GENERATION_REQUEST_BUDGET: "2",
    ARTICLE_GENERATION_REPLACEMENT_REQUEST_BUDGET: "3",
  };
  const date = new Date();
  const fingerprint = hooks.articleGenerationSourceFingerprint(
    "Budget test event",
    "grounded source material",
  );
  const journal = await hooks.loadArticleGenerationJournal(
    env,
    date,
    fingerprint,
  );
  const checkpoint = hooks.createArticleGenerationCheckpointer(
    env,
    date,
    journal,
  );
  await checkpoint.consumeRequest("brief");
  await checkpoint.consumeRequest("body A");
  await assert.rejects(
    checkpoint.consumeRequest("body B"),
    (error) => error?.code === "AI_CAPACITY_UNAVAILABLE" && /2\/2 exhausted/.test(error.message),
  );
  assert.equal(kv.puts.length, 2, "each actual model request reserves one durable budget unit");

  const resumed = await hooks.loadArticleGenerationJournal(
    env,
    date,
    fingerprint,
  );
  assert.equal(resumed.requestBudget.used, 2);
  await assert.rejects(
    hooks.createArticleGenerationCheckpointer(env, date, resumed)
      .consumeRequest("facts"),
    (error) => error?.code === "AI_CAPACITY_UNAVAILABLE",
  );
  assert.equal(kv.puts.length, 2, "a fresh invocation must not reopen the same day's allowance");

  const stricterVariant = await hooks.loadArticleGenerationJournal(
    env,
    date,
    hooks.articleGenerationSourceFingerprint(
      "Budget test event",
      "grounded source material",
      "stricter retry",
    ),
    fingerprint,
  );
  assert.deepEqual(stricterVariant.chunks, {}, "a prompt variant cannot reuse incompatible chunks");
  assert.equal(stricterVariant.requestBudget.used, 2, "a prompt variant of the same source gets no rotation reserve");
  await assert.rejects(
    hooks.createArticleGenerationCheckpointer(env, date, stricterVariant)
      .consumeRequest("stricter brief"),
    (error) => error?.code === "AI_CAPACITY_UNAVAILABLE",
  );
  assert.equal(kv.puts.length, 2);

  const rotatedTopic = await hooks.loadArticleGenerationJournal(
    env,
    date,
    hooks.articleGenerationSourceFingerprint(
      "Different topic on the same date",
      "different grounded source material",
    ),
  );
  assert.deepEqual(rotatedTopic.chunks, {}, "chunks belong only to their source fingerprint");
  assert.equal(rotatedTopic.requestBudget.used, 0, "a replacement source gets a fresh active-source counter");
  assert.equal(rotatedTopic.requestBudget.dailyUsed, 2, "topic rotation must retain the date-wide spend");
  await hooks.createArticleGenerationCheckpointer(env, date, rotatedTopic)
    .consumeRequest("rotated brief");
  await hooks.createArticleGenerationCheckpointer(env, date, rotatedTopic)
    .consumeRequest("rotated body");
  await hooks.createArticleGenerationCheckpointer(env, date, rotatedTopic)
    .consumeRequest("rotated facts");
  await assert.rejects(
    hooks.createArticleGenerationCheckpointer(env, date, rotatedTopic)
      .consumeRequest("rotated analysis"),
    (error) =>
      error?.code === "AI_CAPACITY_UNAVAILABLE" &&
      /5\/5 daily exhausted/.test(error.message),
  );
  assert.equal(kv.puts.length, 5);

  const thirdTopic = await hooks.loadArticleGenerationJournal(
    env,
    date,
    hooks.articleGenerationSourceFingerprint(
      "Third topic on the same date",
      "third grounded source material",
    ),
  );
  assert.equal(thirdTopic.requestBudget.used, 0);
  assert.equal(thirdTopic.requestBudget.dailyUsed, 5);
  await assert.rejects(
    hooks.createArticleGenerationCheckpointer(env, date, thirdTopic)
      .consumeRequest("third brief"),
    (error) =>
      error?.code === "AI_CAPACITY_UNAVAILABLE" &&
      /too little daily budget remains for another topic rotation/.test(error.message),
  );
  assert.equal(kv.puts.length, 5, "a third topic cannot reopen the date-wide allowance");

  resumed.requestBudget.date = "2000-01-01";
  await hooks.createArticleGenerationCheckpointer(env, date, resumed)
    .consumeRequest("next-day repair");
  assert.equal(resumed.requestBudget.used, 1);
  assert.equal(resumed.requestBudget.date, new Date().toISOString().slice(0, 10));
  assert.equal(kv.puts.length, 6);

  assert.equal(hooks.articleGenerationRequestBudgetLimit({}), 12);
  assert.equal(hooks.articleGenerationReplacementRequestBudgetLimit({}), 14);
  assert.equal(hooks.articleGenerationDailyRequestBudgetLimit({}), 26);
  assert.equal(
    hooks.articleGenerationDailyRequestBudgetLimit({
      ARTICLE_GENERATION_DAILY_REQUEST_BUDGET: "34",
    }),
    34,
  );
  assert.equal(hooks.articleGenerationRequestBudgetLimit({ ARTICLE_GENERATION_REQUEST_BUDGET: "4" }), 4);
  assert.equal(
    hooks.articleGenerationReplacementRequestBudgetLimit({
      ARTICLE_GENERATION_REPLACEMENT_REQUEST_BUDGET: "6",
    }),
    6,
  );
  assert.equal(
    hooks.articleGenerationDailyRequestBudgetLimit({
      ARTICLE_GENERATION_REQUEST_BUDGET: "4",
      ARTICLE_GENERATION_REPLACEMENT_REQUEST_BUDGET: "6",
    }),
    10,
  );
  assert.equal(
    hooks.articleGenerationDailyRequestBudgetLimit({
      ARTICLE_GENERATION_DAILY_REQUEST_BUDGET: "100",
    }),
    34,
  );
  assert.equal(
    hooks.articleGenerationDailyRequestBudgetLimit({
      ARTICLE_GENERATION_DAILY_REQUEST_BUDGET: "5",
    }),
    26,
  );
  assert.equal(hooks.articleGenerationRequestBudgetLimit({ ARTICLE_GENERATION_REQUEST_BUDGET: "100" }), 12);
});

test("the minimum viable rotation gate cannot stop an article already in progress", async () => {
  const kv = makeKvMock();
  const env = {
    BLOG_AI_KV: kv,
    ARTICLE_GENERATION_DAILY_REQUEST_BUDGET: "34",
  };
  const date = new Date();
  const fingerprint = hooks.articleGenerationSourceFingerprint(
    "2019 El Paso Walmart shooting",
    "grounded source material",
  );
  kv.store.set(
    hooks.articleGenerationJournalKey(date),
    JSON.stringify({
      version: 1,
      slug: hooks.articleGenerationJournalKey(date).replace(
        "article-generation-v1:",
        "",
      ),
      sourceFingerprint: fingerprint,
      budgetSourceFingerprint: fingerprint,
      chunks: { brief: { eventTitle: "2019 El Paso Walmart shooting" } },
      requestBudget: {
        date: new Date().toISOString().slice(0, 10),
        sourceFingerprint: fingerprint,
        used: 6,
        sourceUsed: 6,
        dailyUsed: 27,
        calls: { brief: 1 },
        sourceCalls: { brief: 1 },
        rotations: 3,
      },
    }),
  );
  const journal = await hooks.loadArticleGenerationJournal(
    env,
    date,
    fingerprint,
  );
  const result = await hooks
    .createArticleGenerationCheckpointer(env, date, journal)
    .consumeRequest("resume analysis");
  assert.equal(result.used, 7);
  assert.equal(result.dailyUsed, 28);
  assert.equal(result.dailyLimit, 34);
});

test("only repeated-opening continuity failures may degrade gracefully", () => {
  const repeatedOpening = {
    ok: false,
    issues: [
      "conclusionParagraphs repeats the opening pattern used by eyewitnessOrChronicle",
    ],
    repairFields: ["conclusionParagraphs"],
  };
  assert.equal(
    hooks.isLowRiskChunkedContinuityFailure(repeatedOpening),
    true,
  );
  assert.equal(
    hooks.isLowRiskChunkedContinuityFailure({
      ...repeatedOpening,
      issues: [
        ...repeatedOpening.issues,
        "conclusion does not clearly pick up enough earlier body detail",
      ],
    }),
    false,
  );

  const worker = readFileSync(
    new URL("../js/blog-ai-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /!lastResortRecovery &&\s*!isLowRiskChunkedContinuityFailure\(continuity\)/,
  );
  assert.match(
    worker,
    /if \(!lastResortRecovery && !lowRiskContinuity\) \{\s*throw new Error\(`chunked article fallback continuity failed/,
  );
});

test("optional unsupported claims are removed locally without weakening grounding gates", () => {
  const source = {
    pageTitle: "1948 Summer Olympics",
    text: "The 1948 Summer Olympics opened in London on July 29, 1948.",
    sourceExtract:
      "The games were known as the Austerity Games during a difficult economic climate after World War II. " +
      "Organizers used existing venues and accommodation instead of building new ones. " +
      "Fanny Blankers-Koen won four gold medals in athletics.",
  };
  const content = {
    title: "1948 Summer Olympics — July 29, 1948",
    eventTitle: "1948 Summer Olympics Open",
    didYouKnowFacts: [
      "The games opened in London on July 29, 1948.",
      "Fanny Blankers-Koen, a 30-year-old mother of two, won four gold medals in athletics.",
      "The games were known as the Austerity Games.",
      "Organizers used existing venues instead of building new ones.",
      "Fanny Blankers-Koen won four gold medals in athletics.",
    ],
    analysisBad: [
      {
        title: "Economic challenges",
        detail:
          "The 1948 Summer Olympics were held during a difficult economic climate and were known as the Austerity Games, which forced the organizers to use existing venues and accommodation instead of building new ones.",
      },
      { title: "Limited participation", detail: "Germany and Japan did not participate in the London games." },
      { title: "Existing venues", detail: "Organizers used existing venues and accommodation in London." },
    ],
  };

  const before = hooks.verifyArticleGrounding(content, source);
  assert.equal(before.ok, false);
  // The verifier is intentionally fail-fast, so field traversal may surface
  // the coercive analysis claim before the optional relationship claim. The
  // mechanical pass below must still find and remove both unsupported items.
  assert.match(before.reasons.join(" "), /unsupported coercive outcome/);

  const repaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(
    content,
    source,
  );
  assert.deepEqual(repaired.repairedFieldPaths, [
    "didYouKnowFacts[1]",
    "analysisBad[0].detail",
  ]);
  assert.equal(repaired.content.didYouKnowFacts.length, 4);
  assert.doesNotMatch(JSON.stringify(repaired.content), /mother of two|forced the organizers/i);
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);

  const minimumFactSet = {
    ...content,
    didYouKnowFacts: content.didYouKnowFacts.slice(0, 4),
    analysisBad: content.analysisBad.slice(1),
  };
  const preserved = hooks.mechanicallyRemoveOptionalUnsupportedClaims(
    minimumFactSet,
    source,
  );
  assert.equal(preserved.content.didYouKnowFacts.length, 3);
  assert.doesNotMatch(JSON.stringify(preserved.content), /mother of two/);

  const mh370Source = {
    pageTitle: "Malaysia Airlines Flight 370",
    text: "Debris from Malaysia Airlines Flight 370 was found on Reunion Island on July 29, 2015.",
    sourceExtract:
      "Malaysia Airlines Flight 370 disappeared on March 8, 2014. The Australian Transport Safety Bureau led a search in the southern Indian Ocean. The cause of the disappearance remains unknown.",
  };
  const mh370Content = {
    title: "Debris from MH370 discovered on Reunion Island",
    eventTitle: "Debris from MH370 discovered on Reunion Island",
    conclusionParagraphs: [
      "The cause of the disappearance remains unknown, with the Malaysian government and ICAO working to determine the cause and to improve aviation safety.",
    ],
  };
  const mh370Before = hooks.verifyArticleGrounding(mh370Content, mh370Source);
  assert.equal(mh370Before.ok, false);
  assert.match(mh370Before.reasons.join(" "), /unsupported causal claim/);
  const mh370Repaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(
    mh370Content,
    mh370Source,
  );
  assert.deepEqual(mh370Repaired.repairedFieldPaths, ["conclusionParagraphs[0]"]);
  assert.equal(
    mh370Repaired.content.conclusionParagraphs[0],
    "The cause of the disappearance remains unknown.",
  );
  assert.equal(hooks.verifyArticleGrounding(mh370Repaired.content, mh370Source).ok, true);
});

test("a source-attribution tail cannot strand the Treaty of Greenville article", () => {
  const supportedAftermath =
    "The agreement described a boundary between United States territory and the lands retained by the participating nations. " +
    "Its terms listed named rivers, forts, and settlements and recorded the land cession in the treaty text. " +
    "The document also specified annuity payments and identified the parties responsible for carrying out those provisions. " +
    "These clauses appear in the supplied record alongside the treaty date, the named representatives, and the location of the negotiations. " +
    "The surviving text therefore provides concrete terms that can be described without adding a later policy effect or broader historical claim. " +
    "Each provision remains tied to the language preserved in the agreement and to the institutions explicitly named there.";
  const supportedAnalysis =
    "The treaty text supplies specific boundary language, named parties, and payment terms that make the documented agreement unusually concrete. " +
    "Those provisions can be evaluated directly from the supplied record without assuming a broader effect. " +
    "The named rivers, forts, representatives, and annual sums give readers verifiable details while keeping the analysis within the source. " +
    "This precision is the strongest feature of the surviving document and does not require an inferred legacy.";
  const source = {
    pageTitle: "Treaty of Greenville",
    text: "The Treaty of Greenville was signed on August 3, 1795.",
    sourceExtract:
      "The treaty text defined a boundary using named rivers, forts, and settlements. " +
      "It also specified annuity payments and identified the parties to the agreement.",
  };
  const content = {
    aftermathParagraphs: [supportedAftermath],
    analysisGood: [{
      title: "Documented Payment Terms",
      detail:
        `${supportedAnalysis} The source notes that these payments were a direct outcome of the treaty, creating a structured form of compensation that became a recurring feature in subsequent U.S. Indigenous relations.`,
    }],
  };

  const before = hooks.verifyArticleGrounding(content, source);
  assert.equal(before.ok, false);
  assert.match(before.reasons.join(" "), /unsupported order attribution/);

  const repaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(content, source);
  assert.deepEqual(repaired.repairedFieldPaths, [
    "analysisGood[0].detail",
  ]);
  assert.doesNotMatch(
    JSON.stringify(repaired.content),
    /direct outcome|explicitly noted|recurring feature/i,
  );
  assert.ok(repaired.content.aftermathParagraphs[0].split(/\s+/).length >= 95);
  assert.ok(repaired.content.analysisGood[0].detail.split(/\s+/).length >= 60);
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);
});

test("legislative idiom, causal denials, and optional labels do not strand a complete article", () => {
  const source = {
    pageTitle: "Social Security Amendments of 1965",
    text:
      "President Lyndon B. Johnson signed the Social Security Amendments of 1965 into law on July 30, 1965. " +
      "The legislation established Medicare and Medicaid.",
    sourceExtract:
      "The American Medical Association opposed earlier health insurance legislation. " +
      "A committee feared that adding health insurance would kill the entire bill.",
  };
  const content = {
    title: "Social Security Amendments of 1965 — July 30, 1965",
    eventTitle: "Social Security Amendments of 1965",
    historicalYear: 1965,
    quickFacts: [
      { label: "Event", value: "Social Security Amendments of 1965" },
      { label: "Date", value: "July 30, 1965" },
      { label: "Location", value: "Washington, D.C." },
      { label: "Key Figure", value: "Lyndon B. Johnson" },
      { label: "Source Detail", value: "The legislation established Medicare and Medicaid" },
      { label: "Confirmed Outcome", value: "First federal public health insurance programs created" },
    ],
    analysisBad: [
      {
        title: "AMA Opposition Blocked Earlier Bills",
        detail:
          "A committee feared that adding health insurance would kill the entire bill. " +
          "The source does not quantify the association's influence or claim its opposition was the sole cause of failure.",
      },
    ],
  };

  const before = hooks.verifyArticleGrounding(content, source);
  assert.equal(before.ok, false);
  // Analysis fields are traversed before Quick Facts in the current
  // fail-fast verifier. Repair must still normalize both unsupported fields.
  assert.match(before.reasons.join(" "), /analysisBad\[0\]\.title/);
  assert.doesNotMatch(before.reasons.join(" "), /perpetrator attribution|sole cause/);

  const repaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(content, source);
  assert.deepEqual(repaired.repairedFieldPaths, [
    "quickFacts[5].value",
    "analysisBad[0].title",
  ]);
  assert.deepEqual(repaired.content.quickFacts[5], {
    label: "Source Subject",
    value: "Social Security Amendments of 1965",
  });
  assert.equal(
    repaired.content.analysisBad[0].title,
    "Source Documented Limitation",
  );
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);
});

test("source limitations and direct quotations are not historical outcome or order claims", () => {
  const source = {
    pageTitle: "2019 El Paso shooting",
    text:
      "On August 3, 2019, Patrick Crusius attacked a Walmart in El Paso, Texas. Twenty three people were killed and twenty two were injured.",
    sourceExtract:
      "Federal prosecutors charged Patrick Crusius with hate crimes and firearms offenses. The source describes the gunman, the weapon, and the law enforcement response.",
  };
  const content = {
    eventTitle: "2019 El Paso Walmart shooting",
    analysisBad: [
      {
        title: "Unnamed individual victims",
        detail:
          "While the source gives the aggregate numbers of twenty three killed and twenty two injured it does not list the names of any of the deceased or injured individuals This absence of personal identifiers limits the ability to understand the human impact of the event beyond statistical totals and prevents a more detailed memorialization of those affected",
      },
      {
        title: "No firsthand accounts",
        detail:
          "The source focuses on Patrick Crusius, the manifesto, the weapon, and the law enforcement response, but it does not include any direct quotes or statements from witnesses, survivors, or first responders in El Paso.",
      },
    ],
  };
  const sourceLimitationGrounding = hooks.verifyArticleGrounding(
    content,
    source,
  );
  assert.equal(
    sourceLimitationGrounding.ok,
    true,
    sourceLimitationGrounding.reasons.join("; "),
  );

  const realPreventiveClaim = hooks.verifyArticleGrounding({
    ...content,
    analysisBad: [{
      title: "Unsupported outcome",
      detail:
        "The police response prevented another attack by Patrick Crusius in El Paso after the 2019 Walmart shooting.",
    }],
  }, source);
  assert.match(realPreventiveClaim.reasons.join(" "), /unsupported preventive outcome/);

  const realOrderClaim = hooks.verifyArticleGrounding({
    ...content,
    analysisBad: [{
      title: "Unsupported direction",
      detail:
        "Patrick Crusius directed the law enforcement response in El Paso after the 2019 Walmart shooting.",
    }],
  }, source);
  assert.match(realOrderClaim.reasons.join(" "), /unsupported order attribution/);
});

test("an unsupported trailing causal clause is removed without thinning the body", () => {
  const source = {
    pageTitle: "2019 El Paso Walmart shooting",
    text:
      "On August 3, 2019, Patrick Crusius attacked a Walmart in El Paso, Texas.",
    sourceExtract:
      "The Federal Bureau of Investigation investigated the manifesto as domestic terrorism and a hate crime. Patrick Crusius received multiple life sentences without parole.",
  };
  const content = {
    aftermathParagraphs: [
      "Following the arrest and sentencing of Patrick Crusius, the community of El Paso and the broader United States reflected on the tragedy. The shooting was described as the deadliest attack on Latinos in modern American history, underscoring the targeted nature of the violence. The Federal Bureau of Investigation's investigation highlighted the extremist content of the manifesto and the gunman's intent to emulate a high profile hate crime. The case reinforced the FBI's role in addressing domestic terrorism and hate crimes, and it prompted discussions about the monitoring of extremist forums. The legal proceedings, culminating in multiple life sentences without parole, demonstrated the judicial system's response to the crime. The event remains a stark reminder of the impact of white nationalist ideology and the importance of vigilance against hate based violence.",
    ],
  };

  const before = hooks.verifyArticleGrounding(content, source);
  assert.match(before.reasons.join(" "), /unsupported causal claim/);

  const repaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(
    content,
    source,
  );
  assert.deepEqual(repaired.repairedFieldPaths, ["aftermathParagraphs[0]"]);
  assert.doesNotMatch(
    repaired.content.aftermathParagraphs[0],
    /prompted discussions/i,
  );
  assert.ok(
    repaired.content.aftermathParagraphs[0].split(/\s+/).length >= 110,
  );
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);
});

test("chunk continuity catches copied body sentences before enrichment", () => {
  const repeated =
    "The committee record lists the same dated vote and the same participating institutions in full.";
  const paragraph = (opening, extra) =>
    `${opening} ${repeated} ${extra} ` +
    "The archival account supplies names, dates, locations, and procedural details that keep this section tied to the canonical event. ".repeat(8);
  const content = {
    title: "Congress Passes a Documented Act — July 30, 1965",
    eventTitle: "Congress Passes a Documented Act",
    historicalDate: "July 30, 1965",
    historicalYear: 1965,
    location: "Washington, D.C.",
    organizerName: "Lyndon B. Johnson",
    sourceFacts: [
      "Congress recorded the vote in 1965.",
      "Lyndon B. Johnson signed the act.",
    ],
    overviewParagraphs: [
      paragraph("The overview establishes the documented act.", "It introduces the measure."),
      paragraph("The overview then follows committee work.", "It distinguishes the earlier proposal."),
    ],
    eyewitnessOrChronicle: [
      paragraph("The chronology follows the roll call.", "It names the chamber."),
      paragraph("The record then reaches the signing.", "It names the ceremony."),
    ],
    aftermathParagraphs: [
      paragraph("Implementation required administrative work.", "Agencies updated their procedures."),
      paragraph("Later records describe program operation.", "The statute remained the reference."),
    ],
    conclusionParagraphs: [
      paragraph("The conclusion returns to the enacted text.", "The documented vote remains central."),
      paragraph("The final record separates proposal from law.", "The dated sequence closes the account."),
    ],
  };

  const audit = hooks.auditChunkedArticleContinuity(content);
  assert.equal(audit.ok, false);
  assert.match(audit.issues.join(" "), /body cross-section duplicate/);
  assert.ok(audit.repairFields.includes("conclusionParagraphs"));
  assert.equal(hooks.isLowRiskChunkedContinuityFailure(audit), false);
});

test("exact later-section copies are removed locally when a substantive conclusion remains", async () => {
  const repeated =
    "In 2025, Patrick Crusius pleaded guilty to state charges and received a life sentence without parole in El Paso.";
  const paragraph = (section) =>
    Array.from(
      { length: 9 },
      (_, index) =>
        `${section} record ${index + 1} identifies Patrick Crusius, El Paso, the 2019 Walmart attack, and a documented stage of the federal or state proceedings.`,
    ).join(" ");
  const conclusion = (section) =>
    `The ${section.toLowerCase()} begins with a distinct review of the documented El Paso record. ${repeated} ${paragraph(section)}`;
  const content = {
    title: "2019 El Paso Walmart Shooting — August 3, 2019",
    eventTitle: "2019 El Paso Walmart shooting",
    historicalDate: "August 3, 2019",
    historicalYear: 2019,
    location: "El Paso, Texas",
    organizerName: "Patrick Crusius",
    sourceFacts: [
      "The Walmart attack occurred in El Paso in 2019.",
      "Patrick Crusius later faced federal and state proceedings.",
    ],
    overviewParagraphs: [
      paragraph("Overview first"),
      paragraph("Overview second"),
    ],
    eyewitnessOrChronicle: [
      paragraph("Chronicle first"),
      paragraph("Chronicle second"),
    ],
    aftermathParagraphs: [
      `The first aftermath passage follows the separate state proceedings in El Paso. ${repeated} ${paragraph("Aftermath first")}`,
      paragraph("Aftermath second"),
    ],
    conclusionParagraphs: [
      conclusion("Conclusion first"),
      conclusion("Conclusion second"),
    ],
  };

  const before = hooks.auditChunkedArticleContinuity(content);
  assert.equal(before.ok, false);
  assert.match(before.issues.join(" "), /body cross-section duplicate/);

  const repaired = hooks.mechanicallyPruneRepeatedBodySentences(
    content,
    before,
  );
  assert.ok(repaired, "a grounded 110+ word remainder should be repairable without AI");
  assert.equal(repaired.droppedSentenceCount, 2);
  assert.equal(
    hooks.auditChunkedArticleContinuity({
      ...content,
      ...repaired.repairedFields,
    }).ok,
    true,
  );
  assert.ok(
    repaired.repairedFields.conclusionParagraphs.every(
      (value) => !value.includes(repeated),
    ),
  );

  let repairCalls = 0;
  const acceptedRepair = await hooks.repairChunkedArticleContinuity(
    {},
    "test-model",
    content,
    "source-grounded context",
    {
      title: content.title,
      eventTitle: content.eventTitle,
      historicalDate: content.historicalDate,
      historicalYear: content.historicalYear,
      location: content.location,
      organizerName: content.organizerName,
      sourceFacts: content.sourceFacts,
    },
    before,
    async (_env, _model, _label, _prompt, _maxTokens, validate) => {
      repairCalls += 1;
      const parsed = {
        conclusionParagraphs: [...content.conclusionParagraphs],
      };
      validate(parsed);
      return parsed;
    },
  );
  assert.equal(repairCalls, 1);
  assert.equal(
    hooks.auditChunkedArticleContinuity({
      ...content,
      ...acceptedRepair,
    }).ok,
    true,
    "duplicate output from the repair provider must be cleaned before validation rejects it",
  );
});

test("source attribution and beyond-Wikipedia rationale are article-level quality signals", () => {
  const body = {
    eventTitle: "A Documented Event",
    title: "A Documented Event — July 30, 1965",
    sourcePages: [
      {
        title: "Independent legislative archive",
        publisher: "University Archive",
        verifiedIndependent: true,
      },
    ],
    overviewParagraphs: [
      "The archival record identifies the 1965 event, date, place, institutions, and formal action. ".repeat(14),
    ],
    eyewitnessOrChronicle: [
      "Lyndon Johnson and named participants followed the dated procedure through committee review and a recorded vote. ".repeat(13),
    ],
    aftermathParagraphs: [
      "Federal administrators implemented the enacted 1965 provisions through documented institutional procedures. ".repeat(14),
    ],
    conclusionParagraphs: [
      "The final 1965 account separates the proposal, vote, enactment, and later administration into distinct stages. ".repeat(12),
    ],
    didYouKnowFacts: [
      "The 1965 record identifies a named institution and a dated vote with enough detail for independent review.",
      "A second 1965 source records the same event from a separate institutional archive for comparison.",
      "The enacted text distinguishes two documented program components administered under separate titles in 1965.",
      "The archive preserves named participants, locations, and procedural steps from the 1965 legislative sequence.",
    ],
    editorialNote:
      "The archival record from 1965 identifies the event, the institutions, and the dated procedure. This measured note keeps those concrete details together and distinguishes proposal, vote, enactment, and administration without adding a modern comparison or unsupported lesson for readers.",
  };
  const issues = hooks.scanArticleQuality(body);
  assert.doesNotMatch(
    issues.join(" "),
    /eyewitnessOrChronicle needs|aftermathParagraphs needs|conclusionParagraphs needs/,
  );

  const repaired = hooks.ensureSourceComparisonContentRationale(body);
  assert.match(repaired.contentRationale, /Wikipedia/);
  assert.match(repaired.contentRationale, /University Archive/);
  assert.ok(repaired.contentRationale.split(/\s+/).length >= 35);
});

test("secondary Wikimedia figures receive filename-grounded alt text", () => {
  const alt = hooks.groundedSecondaryImageAlt(
    "https://upload.wikimedia.org/wikipedia/commons/f/f5/Lyndon_B._Johnson_photo_portrait-Black%27n_white.jpg",
    "Social Security Amendments of 1965",
  );
  assert.match(alt, /Lyndon B\. Johnson photo portrait/i);
  assert.doesNotMatch(alt, /^via Wikimedia$/i);
});

test("undersized chunked body selects only the shortest field for targeted repair", () => {
  const words = (count) => `${"grounded ".repeat(count - 1)}fact.`;
  const body = {
    overviewParagraphs: [words(200)],
    eyewitnessOrChronicle: [words(180)],
    aftermathParagraphs: [words(170)],
    conclusionParagraphs: [words(150)],
  };
  assert.equal(hooks.articleBodyWordCount(body), 700);
  assert.deepEqual(
    hooks.chunkedArticleBodyCapacityRepairFields(body),
    ["conclusionParagraphs"],
  );
  body.conclusionParagraphs = [words(200)];
  assert.equal(hooks.chunkedArticleBodyCapacityRepairFields(body).length, 0);
});

test("failsafe permits one recovery attempt and has a non-overlapping concurrency lock", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/blog-failsafe.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /group:\s*blog-post-failsafe/);
  assert.match(workflow, /timeout-minutes:\s*90/);
  assert.doesNotMatch(workflow, /MAX_COOLDOWN_RETRIES|COOLDOWN_SECONDS/);
  assert.doesNotMatch(workflow, /for DRAFT_ATTEMPT|prefer-workers-ai=true/);
  assert.equal(
    (workflow.match(/-X POST "\$DRAFT_ENDPOINT"/g) || [])
      .length,
    1,
  );
});

test("Evergreen maintenance has one 00:55 trigger instead of a duplicate midnight race", () => {
  const worker = readFileSync(
    new URL("../js/blog-ai-worker.js", import.meta.url),
    "utf8",
  );
  const wrangler = readFileSync(
    new URL("../wrangler-blog.jsonc", import.meta.url),
    "utf8",
  );

  assert.match(worker, /const RECOVERY_CRON = "50 0 \* \* \*"/);
  assert.match(worker, /const EVERGREEN_HISTORY_RETRY_CRON = "55 \* \* \* \*"/);
  assert.doesNotMatch(worker, /const RECOVERY_CRON = "50,55 0 \* \* \*"/);
  assert.match(
    wrangler,
    /"crons": \["5,10,15 0 \* \* \*", "50 0 \* \* \*", "25 1 \* \* \*", "55 \* \* \* \*"\]/,
  );
  assert.doesNotMatch(wrangler, /50,55 0 \* \* \*/);
});
