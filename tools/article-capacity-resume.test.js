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
import {
  GROQ_TEXT_MODEL_DEFAULT as YOUTUBE_GROQ_TEXT_MODEL_DEFAULT,
  __resetGroqModelResolverForTests as resetYoutubeGroqModelResolverForTests,
  resolveGroqModels as resolveYoutubeGroqModels,
} from "../youtube-upload/lib/model-resolver.js";

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

test("decimal Retry-After durations cannot become multi-year provider circuits", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const kv = makeKvMock();
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
      return new Response("rate limited", {
        status: 429,
        headers: {
          "content-type": "text/plain",
          "retry-after": "33.2699999s",
        },
      });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const startedAt = Date.now();
  try {
    await assert.rejects(
      callAI(
        { BLOG_AI_KV: kv, GROQ_API_KEY: "decimal-retry-key" },
        [{ role: "user", content: "one bounded request" }],
        { providerAttemptLimit: 1, groqOnly: true },
      ),
      isAIProviderCapacityError,
    );
    const today = new Date().toISOString().slice(0, 10);
    const state = JSON.parse(
      await kv.get(`ai-provider-circuit-v1:${today}`),
    );
    const retryAt = Date.parse(state.providers["groq:shared"].retryAt);
    assert.ok(retryAt - startedAt >= 33_000);
    assert.ok(retryAt - startedAt < 35_000);
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
      2,
      "one successful-call token estimate and one preflight deferral share the durable circuit record",
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
    assert.equal(
      kv.puts.length,
      2,
      "the blocked-pool circuit and the successful independent pool's token estimate are both durable",
    );
    const finalCircuit = JSON.parse(kv.puts.at(-1).value);
    assert.ok(finalCircuit.providers["groq:organization-a"]);
    assert.ok(finalCircuit.groqTokenEstimate.pools["organization-b"] > 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("Groq-only timeout storms defer the retained topic instead of consuming a rotation", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  let groqCalls = 0;
  let openRouterCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{ id: "llama-3.3-70b-versatile", active: true }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      groqCalls += 1;
      throw new Error("Groq request timed out");
    }
    if (value.includes("openrouter.ai")) {
      openRouterCalls += 1;
      return new Response("unexpected", { status: 200 });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    let failure;
    try {
      await callAI(
        {
          ARTICLE_AI_PROVIDER_MODE: "groq-only",
          GROQ_API_KEY: `timeout-${Date.now()}`,
          OPENROUTER_API_KEY: "must-not-run",
        },
        [{ role: "user", content: "retain this factual article" }],
        { providerAttemptLimit: 1 },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(isAIProviderCapacityError(failure), true);
    assert.ok(aiProviderRetryAt(failure));
    assert.equal(groqCalls, 1);
    assert.equal(openRouterCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Groq-only request-size failures remain structural errors", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{ id: "openai/gpt-oss-120b", active: true }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      return new Response('{"error":{"message":"request too large for model"}}', {
        status: 413,
      });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    let failure;
    try {
      await callAI(
        {
          ARTICLE_AI_PROVIDER_MODE: "groq-only",
          GROQ_API_KEY: `oversize-${Date.now()}`,
        },
        [{ role: "user", content: "oversized request" }],
        { providerAttemptLimit: 1 },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(isAIProviderCapacityError(failure), false);
    assert.match(failure.message, /request too large/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retired Groq text models cannot be revived by stale active catalog data", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (url, init) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "llama-3.3-70b-versatile", active: true, context_window: 131072, max_completion_tokens: 32768 },
          { id: "llama-3.1-8b-instant", active: true, context_window: 131072, max_completion_tokens: 8192 },
          { id: "openai/gpt-oss-120b", active: true, context_window: 131072, max_completion_tokens: 65536 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "replacement-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    assert.equal(
      await callAI(
        { ARTICLE_AI_PROVIDER_MODE: "groq-only", GROQ_API_KEY: "stale-catalog-key" },
        [{ role: "user", content: "use an active model" }],
        { providerAttemptLimit: 1 },
      ),
      "replacement-ok",
    );
    assert.equal(requestBody.model, "openai/gpt-oss-120b");
    assert.equal(requestBody.reasoning_effort, "low");
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("large Groq requests prefer Qwen 3.6 before the reasoning-heavy GPT OSS model", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (url, init) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "openai/gpt-oss-120b", active: true, context_window: 131072, max_completion_tokens: 65536 },
          { id: "qwen/qwen3.6-27b", active: true, context_window: 131072, max_completion_tokens: 16384 },
          { id: "openai/gpt-oss-20b", active: true, context_window: 131072, max_completion_tokens: 65536 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "large-request-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    assert.equal(
      await callAI(
        { ARTICLE_AI_PROVIDER_MODE: "groq-only", GROQ_API_KEY: "large-request-key" },
        [{ role: "user", content: "produce structured article JSON" }],
        { maxTokens: 4096, providerAttemptLimit: 1 },
      ),
      "large-request-ok",
    );
    assert.equal(requestBody.model, "qwen/qwen3.6-27b");
    assert.equal(requestBody.reasoning_effort, "none");
    assert.equal(requestBody.reasoning_format, "hidden");
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("Groq catalog failure falls back directly to GPT OSS 120B", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (url, init) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) {
      return new Response("catalog unavailable", { status: 503 });
    }
    if (value.includes("api.groq.com/openai/v1/chat/completions")) {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "offline-chain-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    assert.equal(
      await callAI(
        { ARTICLE_AI_PROVIDER_MODE: "groq-only", GROQ_API_KEY: "offline-catalog-key" },
        [{ role: "user", content: "use the emergency model chain" }],
        { providerAttemptLimit: 1 },
      ),
      "offline-chain-ok",
    );
    assert.equal(requestBody.model, "openai/gpt-oss-120b");
    assert.equal(requestBody.reasoning_effort, "low");
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("the YouTube pipeline defaults to GPT OSS 120B without a catalog", async () => {
  const keyNames = ["GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3", "GROQ_API_KEY_4"];
  const originalKeys = Object.fromEntries(keyNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of keyNames) delete process.env[name];
    resetYoutubeGroqModelResolverForTests();
    assert.equal(YOUTUBE_GROQ_TEXT_MODEL_DEFAULT, "openai/gpt-oss-120b");
    assert.equal((await resolveYoutubeGroqModels()).textModel, "openai/gpt-oss-120b");
  } finally {
    for (const name of keyNames) {
      if (originalKeys[name] == null) delete process.env[name];
      else process.env[name] = originalKeys[name];
    }
    resetYoutubeGroqModelResolverForTests();
  }
});

test("the YouTube pipeline rejects retired Llama IDs from stale catalog data", async () => {
  const keyNames = ["GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3", "GROQ_API_KEY_4"];
  const originalKeys = Object.fromEntries(keyNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.GROQ_API_KEY = "youtube-stale-catalog-key";
    for (const name of keyNames.slice(1)) delete process.env[name];
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        { id: "llama-3.3-70b-versatile" },
        { id: "llama-3.1-8b-instant" },
        { id: "openai/gpt-oss-120b" },
        { id: "qwen/qwen3.6-27b" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
    resetYoutubeGroqModelResolverForTests();
    assert.equal((await resolveYoutubeGroqModels()).textModel, "openai/gpt-oss-120b");
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of keyNames) {
      if (originalKeys[name] == null) delete process.env[name];
      else process.env[name] = originalKeys[name];
    }
    resetYoutubeGroqModelResolverForTests();
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

test("article generation request budget enforces per-source and date-wide ceilings and resets on a new UTC day", async () => {
  const kv = makeKvMock();
  const env = {
    BLOG_AI_KV: kv,
    ARTICLE_GENERATION_REQUEST_BUDGET: "2",
    ARTICLE_GENERATION_REPLACEMENT_REQUEST_BUDGET: "3",
    ARTICLE_GENERATION_DAILY_REQUEST_BUDGET: "5",
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
      /5\/5 daily exhausted/.test(error.message),
  );
  assert.equal(kv.puts.length, 5, "an exhausted date cannot reopen the allowance on another topic");

  resumed.requestBudget.date = "2000-01-01";
  await hooks.createArticleGenerationCheckpointer(env, date, resumed)
    .consumeRequest("next-day repair");
  assert.equal(resumed.requestBudget.used, 1);
  assert.equal(resumed.requestBudget.date, new Date().toISOString().slice(0, 10));
  assert.equal(kv.puts.length, 6);

  assert.equal(hooks.articleGenerationRequestBudgetLimit({}), 12);
  assert.equal(hooks.articleGenerationReplacementRequestBudgetLimit({}), 14);
  assert.equal(hooks.articleGenerationDailyRequestBudgetLimit({}), 54);
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
    54,
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

  const longInstitutionalTail = {
    ...mh370Content,
    conclusionParagraphs: [
      "Investigators documented the disappearance, the southern Indian Ocean search area, and debris found on Reunion Island. " +
      "The retained evidence distinguishes confirmed wreckage from hypotheses about the aircraft's final path. " +
      "The cause of the disappearance remains unknown, with the Malaysian government and ICAO working to determine the cause and to improve aviation safety. " +
      "Search records identify the agencies, dates, and locations involved without claiming that a final explanation has been established. " +
      "Those documented limits remain essential when separating the known evidence from later interpretation.",
    ],
  };
  const tailRepaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(
    longInstitutionalTail,
    mh370Source,
  );
  assert.match(
    tailRepaired.content.conclusionParagraphs[0],
    /The cause of the disappearance remains unknown\./,
  );
  assert.doesNotMatch(
    tailRepaired.content.conclusionParagraphs[0],
    /ICAO working|improve aviation safety/i,
  );
});

test("baseball-strike source-process causality is reduced to supported statistics", () => {
  const source = {
    pageTitle: "1994–95 Major League Baseball strike",
    text: "The 1994–95 Major League Baseball strike began on August 12, 1994.",
    sourceExtract:
      "The absence of an official commissioner after Fay Vincent left office arguably stood in the way of a compromise settlement. " +
      "The strike lasted for 232 days. A total of 948 games were canceled due to the strike.",
  };
  const content = {
    analysisBad: [{
      title: "Lack of Commissioner",
      detail:
        "The absence of an official commissioner after Fay Vincent left office arguably stood in the way of a compromise settlement. " +
        "The owners and players remained unable to reach an agreement during the work stoppage. " +
        "The source material highlights the significance of this absence, with the strike lasting for 232 days and resulting in the cancellation of 948 games. " +
        "The retained record documents the duration and canceled games without assigning every consequence to one official's absence.",
    }],
  };

  const reason =
    'unsupported causal claim in analysisBad[0].detail: "The source material highlights the significance of this absence, with the strike lasting for 232 days and resulting in the cancellation of 948 games."';
  assert.equal(hooks.groundingReasonIsCore(reason, content), false);

  const repaired = hooks.mechanicallyRepairGroundingReasons(
    content,
    [reason],
    source,
  );
  assert.deepEqual(repaired.repairedFieldPaths, ["analysisBad[0].detail"]);
  assert.match(
    repaired.content.analysisBad[0].detail,
    /The strike lasted for 232 days, and 948 games were canceled\./,
  );
  assert.doesNotMatch(
    repaired.content.analysisBad[0].detail,
    /significance of this absence/i,
  );
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);
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
  assert.ok(repaired.content.analysisGood[0].detail.split(/\s+/).length >= 50);
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

test("bounded grounding removes Marikana-style causal tails while retaining substantive analysis", () => {
  const source = {
    pageTitle: "Marikana massacre",
    text: "The strike at Marikana began on August 10, 2012.",
    sourceExtract:
      "Thirty-four miners were killed after police opened fire. At least 78 people were injured in the confrontation. Failed attempts were made to negotiate a peaceful resolution.",
  };
  const content = {
    title: "Marikana Massacre Begins — August 10, 2012",
    eventTitle: "Marikana massacre begins",
    analysisBad: [{
      title: "Violent Confrontation",
      detail:
        "The Marikana dispute involved striking mineworkers, the South African Police Service, and the mine operator. " +
        "The situation escalated, resulting in the deaths of 34 miners and the injury of 78 others. " +
        "The supplied record describes failed attempts by the parties to negotiate a peaceful resolution before the shooting. " +
        "It identifies the strike, the police response, the people killed, and the people injured as separate documented facts. " +
        "The violent confrontation highlights the limitations of the approaches taken by the parties, which ultimately led to the loss of life and injury to many mineworkers. " +
        "Those details can be evaluated from the retained evidence without assigning an unsupported motive or broader policy outcome.",
    }],
  };

  const before = hooks.verifyArticleGrounding(content, source);
  assert.equal(before.ok, false);
  assert.match(before.reasons.join(" "), /unsupported causal claim/);

  const repaired = hooks.mechanicallyRemoveOptionalUnsupportedClaims(
    content,
    source,
  );
  assert.deepEqual(repaired.repairedFieldPaths, [
    "analysisBad[0].detail",
    "analysisBad[0].detail",
  ]);
  assert.doesNotMatch(
    repaired.content.analysisBad[0].detail,
    /which ultimately led/i,
  );
  assert.ok(repaired.content.analysisBad[0].detail.split(/\s+/).length >= 50);
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);
});

test("casualty grounding preserves four-digit tolls while ignoring explicit calendar dates", () => {
  assert.deepEqual(
    [...hooks.groundingDirectCasualtyNumbers("In 1910, 1,500 people were killed on 12 May.")],
    ["1500"],
  );
  assert.deepEqual(
    [...hooks.groundingDirectCasualtyNumbers("On 12 May, 34 people were killed.")],
    ["34"],
  );
  const source = {
    pageTitle: "Documented disaster",
    text: "The documented disaster occurred on 12 May 1910.",
    sourceExtract:
      "The initial collapse killed 36 workers. A later official accounting reported that the disaster resulted in the deaths of 2,000 people and injured 34 others.",
  };
  const contradiction = hooks.verifyArticleGrounding({
    title: "Documented Disaster — May 12, 1910",
    eventTitle: "Documented disaster",
    overviewParagraphs: [
      "The initial collapse killed 36 workers. The disaster later resulted in the deaths of 1,500 people and injured 34 others.",
    ],
  }, source);
  assert.equal(contradiction.ok, false);
  assert.match(contradiction.reasons.join(" "), /unsupported causal claim|casualty number contradiction/i);

  const dateAndToll = hooks.verifyArticleGrounding({
    title: "Documented Disaster — May 12, 1910",
    eventTitle: "Documented disaster",
    overviewParagraphs: [
      "On 12 May, the documented disaster resulted in the deaths of 34 people.",
    ],
  }, {
    pageTitle: "Documented disaster",
    text: "The documented disaster occurred in May.",
    sourceExtract: "The disaster killed 34 people.",
  });
  assert.equal(dateAndToll.ok, true, dateAndToll.reasons.join("; "));
});

test("dynamic source claims replace unsupported optional prose without weakening grounding", () => {
  const source = {
    pageTitle: "Russell Hill subway accident",
    text:
      "The Russell Hill subway accident occurred in Toronto on August 11, 1995.",
    sourceExtract:
      "The Russell Hill subway accident involved two trains on Line 1 in Toronto. The collision happened between St. Clair West and Dupont stations on August 11, 1995. Toronto emergency crews entered the tunnel and removed passengers from the damaged cars. The official record lists three passenger deaths and thirty injured people. The inquiry examined signalling, operating procedures, and the actions of the train crews. The Toronto Transit Commission later published the inquiry findings in its retained record.",
  };
  const bank = hooks.buildGroundedClaimBank(source);
  assert.ok(bank.length >= 4, `expected at least four source claims, got ${bank.length}`);
  assert.ok(new Set(bank.map((claim) => claim.category)).size >= 2);

  const unsupported =
    "The inquiry prevented another subway disaster and guaranteed safer service.";
  const content = {
    title: "Russell Hill subway accident — August 11, 1995",
    eventTitle: "Russell Hill subway accident",
    analysisBad: [{
      title: "Documented Limits",
      detail:
        "The retained record identifies the collision site, the date, and the agencies that responded. It also separates confirmed casualties from later inquiry material, giving readers a clear boundary between the immediate event and the investigation that followed. " +
        unsupported,
    }],
  };
  const reason =
    `unsupported preventive outcome in analysisBad[0].detail: "${unsupported}"`;
  const repaired = hooks.mechanicallyRepairGroundingReasons(
    content,
    [reason],
    source,
  );
  assert.deepEqual(repaired.repairedFieldPaths, ["analysisBad[0].detail"]);
  assert.doesNotMatch(repaired.content.analysisBad[0].detail, /prevented another|guaranteed safer/i);
  assert.ok(
    repaired.content.analysisBad[0].detail.split(/\s+/).length >= 50,
    "source claims must refill the analysis word floor",
  );
  const grounding = hooks.verifyArticleGrounding(repaired.content, source);
  assert.equal(grounding.ok, true, grounding.reasons.join("; "));
});

test("source claims accumulate across several simultaneous grounding failures", () => {
  const sourceSentences = [
    "The accident involved two trains travelling on Line 1 in Toronto.",
    "The collision happened between St. Clair West and Dupont stations.",
    "Toronto emergency crews entered the tunnel through both nearby stations.",
    "Rescuers removed passengers from the damaged cars after the collision.",
    "The official record lists three passenger deaths and thirty injured people.",
    "The inquiry examined signalling, operating procedures, and train crew actions.",
    "Investigators reconstructed the movements of both trains before the collision.",
    "The Toronto Transit Commission published the retained inquiry findings.",
    "The record distinguishes the emergency response from the later investigation.",
    "The supplied chronology identifies the date, location, casualties, and responders.",
    "Investigators reviewed the signals displayed before both trains entered the section.",
    "The inquiry record describes the operating instructions available to each crew.",
    "Emergency personnel established access points at the adjacent subway stations.",
    "The damaged cars remained inside the tunnel during the initial response.",
    "The published findings preserve separate accounts of operations and emergency work.",
    "The retained documents name the transit authority responsible for the investigation.",
  ];
  const source = {
    pageTitle: "Russell Hill subway accident",
    text:
      "The Russell Hill subway accident occurred in Toronto on August 11, 1995.",
    sourceExtract: sourceSentences.join(" "),
  };
  const unsupportedPrevention =
    "The inquiry prevented another subway disaster and guaranteed safer service.";
  const unsupportedOutcome =
    "The emergency response resulted in a permanent national safety program.";
  const content = {
    title: "Russell Hill subway accident — August 11, 1995",
    eventTitle: "Russell Hill subway accident",
    eyewitnessOrChronicle: [
      `${sourceSentences.slice(0, 8).join(" ")} ${unsupportedOutcome}`,
    ],
    analysisBad: [{
      title: "Investigation Limits",
      detail:
        `The retained record separates the collision from the investigation that followed. ${unsupportedPrevention}`,
    }],
  };
  const reasons = [
    `unsupported preventive outcome in analysisBad[0].detail: "${unsupportedPrevention}"`,
    `unsupported causal claim in eyewitnessOrChronicle[0]: "${unsupportedOutcome}"`,
  ];

  const before = hooks.verifyArticleGrounding(content, source);
  assert.equal(before.ok, false, "both unsupported claims must be live findings");

  const repaired = hooks.mechanicallyRepairGroundingReasons(
    content,
    reasons,
    source,
  );

  assert.deepEqual(
    repaired.repairedFieldPaths,
    ["analysisBad[0].detail", "eyewitnessOrChronicle[0]"],
  );
  assert.doesNotMatch(
    JSON.stringify(repaired.content),
    /prevented another|guaranteed safer|permanent national safety program/i,
  );
  assert.ok(
    repaired.content.analysisBad[0].detail.split(/\s+/).length >= 50,
    "the repaired analysis item must retain its real word floor",
  );
  assert.ok(
    repaired.content.eyewitnessOrChronicle[0].split(/\s+/).length >=
      hooks.CHUNKED_BODY_PARAGRAPH_MIN_WORDS,
    "the repaired body paragraph must retain its real word floor",
  );
  const after = hooks.verifyArticleGrounding(repaired.content, source);
  assert.equal(after.ok, true, after.reasons.join("; "));
});

test("grounding deletes one unsupported sentence when the approved remainder clears 50 words", () => {
  const source = {
    pageTitle: "Russell Hill subway accident",
    text:
      "The Russell Hill subway accident occurred in Toronto on August 11, 1995.",
    sourceExtract:
      "The Russell Hill subway accident involved two trains on Line 1 in Toronto. The collision happened between St. Clair West and Dupont stations on August 11, 1995. Toronto emergency crews entered the tunnel and removed passengers from the damaged cars. The official record lists three passenger deaths and thirty injured people. The inquiry examined signalling, operating procedures, and the actions of the train crews.",
  };
  const supportedRemainder =
    "The retained record names the Russell Hill subway accident, Toronto, August 11, 1995, and the Line 1 tunnel between St. Clair West and Dupont stations. It lists three passenger deaths and thirty injuries, then separates the emergency response from an inquiry into signalling, operating procedures, and the actions of the train crews. That distinction keeps this account tied to the documented chronology and its stated limits.";
  const unsupported =
    "The inquiry prevented another subway disaster and guaranteed safer service.";
  const content = {
    title: "Russell Hill subway accident — August 11, 1995",
    eventTitle: "Russell Hill subway accident",
    overviewParagraphs: [source.sourceExtract],
    analysisBad: [{
      title: "Documented Limits",
      detail: `${supportedRemainder} ${unsupported}`,
    }],
  };
  const repaired = hooks.mechanicallyRepairGroundingReasons(
    content,
    [
      `unsupported preventive outcome in analysisBad[0].detail: "${unsupported}"`,
    ],
    source,
  );

  assert.deepEqual(repaired.repairedFieldPaths, ["analysisBad[0].detail"]);
  assert.equal(repaired.content.analysisBad.length, 1);
  assert.equal(repaired.content.analysisBad[0].detail, supportedRemainder);
  assert.ok(repaired.content.analysisBad[0].detail.split(/\s+/).length >= 50);
  assert.equal(hooks.verifyArticleGrounding(repaired.content, source).ok, true);
});

test("a Core article omits an unrefillable optional analysis item and continues", async () => {
  const blockedSentence =
    "According to historical records, Boukman's role was significant in the early stages of the revolution, which ultimately led to the founding of a state free from slavery and ruled by former captives.";
  const reason =
    `unsupported causal claim in analysisGood[0].detail: "${blockedSentence}"`;
  const bodyParagraph =
    "The retained record identifies the Bois Caïman ceremony in Saint Domingue and names Dutty Boukman as its leader. ".repeat(38);
  const content = {
    contentTier: "core",
    title: "Haitian Revolution Begins — August 14, 1791",
    eventTitle: "Slaves hold Vodou ceremony",
    historicalDate: "August 14, 1791",
    historicalYear: 1791,
    quickFacts: ["Event", "Date", "Place", "Leader"].map((label) => ({
      label,
      value: `${label} source value`,
    })),
    overviewParagraphs: [bodyParagraph],
    analysisGood: [{
      title: "Effective Leadership",
      detail:
        "Dutty Boukman led the Vodou ceremony at Bois Caïman on August 14, 1791. " +
        blockedSentence,
    }],
    analysisBad: [],
    didYouKnowFacts: [],
  };
  const source = {
    pageTitle: "Haitian Revolution",
    text: "Dutty Boukman led a Vodou ceremony at Bois Caïman on August 14, 1791.",
    sourceExtract:
      "The Haitian Revolution was an insurrection against French colonial rule in Saint Domingue.",
  };

  let repairCalled = false;
  const result = await hooks.verifyFinalGroundingWithRepair(
    {},
    content,
    source,
    "14-august-2026",
    {
      verify: async (_env, candidate) =>
        JSON.stringify(candidate).includes(blockedSentence)
          ? { ok: false, reasons: [reason] }
          : { ok: true, reasons: [] },
      repair: async () => {
        repairCalled = true;
        return content;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(repairCalled, false);
  assert.deepEqual(result.content.analysisGood, []);
  assert.doesNotMatch(JSON.stringify(result.content), /ultimately led to the founding/i);
  assert.doesNotThrow(() => hooks.assertRequiredContentBlocks(result.content));
});

test("Core optional omissions survive while a separate body claim awaits repair", () => {
  const bodyClaim =
    "The ceremony caused the government to abolish the institution.";
  const analysisClaim =
    "The speech prevented all further violence.";
  const supportedBodySentence =
    "The retained record identifies the ceremony, its location, date, and named participants.";
  const content = {
    contentTier: "core",
    title: "Documented ceremony — August 18, 1949",
    eventTitle: "Documented ceremony",
    historicalDate: "August 18, 1949",
    historicalYear: 1949,
    quickFacts: ["Event", "Date", "Place", "Participants"].map((label) => ({
      label,
      value: `${label} source value`,
    })),
    overviewParagraphs: [
      `${`${supportedBodySentence} `.repeat(55)}${bodyClaim}`,
    ],
    analysisGood: [{
      title: "Claimed Effect",
      detail:
        `The supplied account names the leader and records the speech. ${analysisClaim}`,
    }],
    analysisBad: [],
    didYouKnowFacts: [],
  };
  const source = {
    pageTitle: "Documented ceremony",
    text: "The documented ceremony occurred on August 18, 1949.",
    sourceExtract:
      "The retained account names the ceremony, its location, date, participants, leader, and speech.",
  };
  const reasons = [
    `unsupported causal claim in overviewParagraphs[0]: "${bodyClaim}"`,
    `unsupported preventive outcome in analysisGood[0].detail: "${analysisClaim}"`,
  ];

  assert.equal(
    hooks.groundingReasonFieldPath(reasons[1], content),
    "analysisGood[0].detail",
    "an explicit verifier path must outrank fuzzy overlap with Quick Fact labels",
  );
  const before = hooks.verifyArticleGrounding(content, source);
  assert.equal(before.ok, false);
  const omitted = hooks.omitUnsupportedCoreOptionalItems(
    content,
    reasons,
    source,
  );

  assert.deepEqual(omitted.removedFieldPaths, ["analysisGood[0]"]);
  assert.deepEqual(omitted.content.analysisGood, []);
  assert.equal(
    hooks.verifyArticleGrounding(omitted.content, source).ok,
    false,
    "the independent body residual should remain for the next repair stage",
  );
  assert.doesNotThrow(() => hooks.assertRequiredContentBlocks(omitted.content));
});

test("a safe partial AI grounding repair is retained for the next bounded pass", async () => {
  const firstClaim =
    "The ceremony reshaped the city's political culture.";
  const secondClaim =
    "Observers viewed the response as historically significant.";
  const firstReason =
    `unsupported causal claim in description: "${firstClaim}"`;
  const secondReason =
    `unsupported significance claim in description: "${secondClaim}"`;
  const original = {
    description: `${firstClaim} ${secondClaim}`,
  };
  const partiallyRepaired = {
    description: `The retained record identifies the ceremony. ${secondClaim}`,
  };
  const source = {
    pageTitle: "Documented ceremony",
    text: "Record.",
    sourceExtract: "The retained record identifies the ceremony.",
  };

  const result = await hooks.verifyFinalGroundingWithRepair(
    {},
    original,
    source,
    "18-august-2026",
    {
      maxRepairAttempts: 1,
      verify: async (_env, candidate) =>
        candidate === original
          ? { ok: false, reasons: [firstReason, secondReason] }
          : { ok: false, reasons: [secondReason] },
      repair: async () => partiallyRepaired,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.content, partiallyRepaired);
  assert.deepEqual(result.reasons, [secondReason]);
  assert.equal(result.madeProgress, true);
  assert.deepEqual(result.repairedFieldPaths, ["description"]);
});

test("bounded grounding advances repeated optional and core contradictions", () => {
  const optionalReasons = [
    'unsupported causal claim in analysisBad[0].detail: "The dispute led to deaths."',
  ];
  const optionalFirst = hooks.boundedGroundingRetryState({}, optionalReasons);
  assert.equal(optionalFirst.attempts, 1);
  assert.equal(optionalFirst.shouldRotate, false);
  assert.equal(optionalFirst.optionalClaimDeferred, true);
  assert.ok(optionalFirst.signature);

  const optionalSecond = hooks.boundedGroundingRetryState({
    boundedGroundingSignature: optionalFirst.signature,
    boundedGroundingReasons: optionalReasons,
    boundedGroundingAttempts: optionalFirst.attempts,
  }, optionalReasons);
  assert.equal(optionalSecond.attempts, 2);
  assert.equal(optionalSecond.shouldRotate, true);

  const progressReset = hooks.boundedGroundingRetryState(
    {
      boundedGroundingReasons: optionalReasons,
      boundedGroundingSignature: optionalFirst.signature,
      boundedGroundingAttempts: 1,
    },
    optionalReasons,
    null,
    { madeProgress: true },
  );
  assert.equal(progressReset.attempts, 0);
  assert.equal(progressReset.shouldRotate, false);
  assert.equal(progressReset.madeProgress, true);

  const firstNoProgress = hooks.boundedGroundingRetryState(
    {
      boundedGroundingReasons: optionalReasons,
      boundedGroundingSignature: progressReset.signature,
      boundedGroundingAttempts: progressReset.attempts,
    },
    optionalReasons,
  );
  assert.equal(firstNoProgress.attempts, 1);
  assert.equal(firstNoProgress.shouldRotate, false);

  const secondNoProgress = hooks.boundedGroundingRetryState(
    {
      boundedGroundingReasons: optionalReasons,
      boundedGroundingSignature: firstNoProgress.signature,
      boundedGroundingAttempts: firstNoProgress.attempts,
    },
    optionalReasons,
  );
  assert.equal(secondNoProgress.attempts, 2);
  assert.equal(secondNoProgress.shouldRotate, true);

  const coreReasons = [
    "casualty number contradiction: article says 41 but source says 36",
  ];
  const first = hooks.boundedGroundingRetryState({}, coreReasons);
  assert.equal(first.attempts, 1);
  assert.equal(first.shouldRotate, false);
  assert.ok(first.signature);

  const second = hooks.boundedGroundingRetryState({
    boundedGroundingSignature: first.signature,
    boundedGroundingAttempts: first.attempts,
    boundedGroundingReasons: coreReasons,
  }, coreReasons);
  assert.equal(second.attempts, 2);
  assert.equal(second.shouldRotate, true);

  const legacySecond = hooks.boundedGroundingRetryState({
    boundedGroundingReasons: coreReasons,
  }, coreReasons);
  assert.equal(legacySecond.attempts, 2);
  assert.equal(legacySecond.shouldRotate, true);

  const changed = hooks.boundedGroundingRetryState({
    boundedGroundingSignature: first.signature,
    boundedGroundingAttempts: 1,
    boundedGroundingReasons: coreReasons,
  }, ["unsupported preventive outcome in conclusionParagraphs[0]"]);
  assert.equal(changed.attempts, 1);
  assert.equal(changed.shouldRotate, false);

  const transport = hooks.boundedGroundingRetryState({
    boundedGroundingSignature: first.signature,
    boundedGroundingAttempts: 9,
    boundedGroundingReasons: coreReasons,
  }, ["final grounding verifier unavailable: provider timeout"]);
  assert.equal(transport.transportDeferred, true);
  assert.equal(transport.shouldRotate, false);
  assert.equal(transport.signature, first.signature);
  assert.equal(transport.attempts, 9);
  assert.deepEqual(transport.retainedReasons, coreReasons);

  const progressThenTransport = hooks.boundedGroundingRetryState(
    {
      boundedGroundingSignature: first.signature,
      boundedGroundingAttempts: 1,
      boundedGroundingReasons: coreReasons,
    },
    ["final grounding verifier unavailable: provider timeout"],
    null,
    { madeProgress: true },
  );
  assert.equal(progressThenTransport.transportDeferred, true);
  assert.equal(progressThenTransport.shouldRotate, false);
  assert.equal(progressThenTransport.madeProgress, true);
  assert.equal(progressThenTransport.attempts, 0);
  assert.deepEqual(progressThenTransport.retainedReasons, coreReasons);

  const shiftingFirstReasons = [
    'unsupported causal claim in analysisBad[0].detail: "The confrontation caused a national reform."',
    'unsupported attribution in conclusionParagraphs[0]: "Officials ordered the later inquiry."',
    'unsupported relationship in didYouKnowFacts[0]: "The two leaders were relatives."',
    'unsupported causal claim in analysisGood[1].detail: "The strike triggered legislation."',
    'wrong location: article says Pretoria but source says Cape Town.',
    'unsupported document claim in didYouKnowFacts[3]: "A report established responsibility."',
  ];
  const shiftingFirst = hooks.boundedGroundingRetryState({}, shiftingFirstReasons);
  const shiftingSecond = hooks.boundedGroundingRetryState({
    boundedGroundingSignature: shiftingFirst.signature,
    boundedGroundingAttempts: 1,
    // Simulate a legacy retained draft that stored only the first five of six.
    boundedGroundingReasons: shiftingFirstReasons.slice(0, 5),
  }, [
    'The article says national reform resulted from the confrontation in analysisBad[0].detail.',
    'The conclusionParagraphs[0] wrongly assigns the inquiry order to officials.',
    'didYouKnowFacts[0] states an unsupported family relationship.',
    'analysisGood[1].detail claims the strike led to a new law.',
    'wrong location: article gives Pretoria but source gives Cape Town.',
    'didYouKnowFacts[4] introduces a different unsupported quotation.',
  ]);
  assert.equal(shiftingSecond.attempts, 2);
  assert.equal(shiftingSecond.shouldRotate, true);
  assert.equal(shiftingSecond.retainedReasons.length, 6);

  const partlyDifferent = hooks.boundedGroundingRetryState({
    boundedGroundingAttempts: 1,
    boundedGroundingReasons: [shiftingFirstReasons[0]],
  }, shiftingFirstReasons);
  assert.equal(partlyDifferent.attempts, 1);
  assert.equal(partlyDifferent.shouldRotate, false);
});

test("bounded recovery strengthens short core modules from retained sources", () => {
  const source = {
    pageTitle: "2019 El Paso Walmart shooting",
    text:
      "On August 3, 2019, Patrick Crusius attacked a Walmart in El Paso, Texas.",
    sourcePages: [
      {
        pageTitle: "2019 El Paso Walmart shooting",
        pageUrl: "https://en.wikipedia.org/wiki/2019_El_Paso_shooting",
        extract:
          "Patrick Crusius drove about 650 miles from Allen, Texas, to El Paso in a 2012 Honda Civic before the August 3, 2019 shooting. Investigators recorded his stops for fuel and his arrival near Cielo Vista Mall before the attack began at the Walmart.",
      },
      {
        pageTitle: "Federal case record",
        pageUrl: "https://www.justice.gov/example/el-paso-case",
        publisher: "United States Department of Justice",
        verifiedIndependent: true,
        extract:
          "In 2023, Patrick Crusius pleaded guilty to ninety federal murder and hate crime charges. A federal court imposed ninety consecutive life sentences, while later state proceedings ended with another guilty plea and a life sentence without parole on April 21, 2025.",
      },
      {
        pageTitle: "FBI investigation record",
        pageUrl: "https://www.fbi.gov/example/el-paso-investigation",
        publisher: "Federal Bureau of Investigation",
        verifiedIndependent: true,
        extract:
          "The Federal Bureau of Investigation examined the El Paso Walmart shooting as domestic terrorism and a hate crime. The retained record describes the manifesto, the weapon, the law enforcement response, and the investigation without supplying names or firsthand accounts for every person affected.",
      },
    ],
  };
  const content = {
    sourcePageTitle: source.pageTitle,
    eventTitle: "El Paso Walmart shooting occurs",
    keyTerms: [
      {
        term: "Patrick Crusius",
        type: "person",
        wikiUrl: "https://en.wikipedia.org/wiki/2019_El_Paso_shooting",
      },
    ],
    didYouKnowFacts: [
      "Patrick Crusius drove 650 miles to El Paso before the August 3, 2019 attack.",
      "The Federal Bureau of Investigation treated the shooting as domestic terrorism.",
      "A federal court imposed ninety consecutive life sentences in 2023.",
    ],
    analysisBad: [{
      title: "Missing Victim Identities",
      detail:
        "While the source gives aggregate totals it does not list the names of every deceased or injured individual. This absence limits the ability to understand the human impact beyond statistics and leaves the supplied record without a detailed memorialization of each person affected by the shooting and its aftermath.",
    }],
  };

  const strengthened = hooks.strengthenBoundedCoreFromSource(content, source);
  assert.notEqual(strengthened, content);
  assert.ok(strengthened.didYouKnowFacts.length >= 3);
  assert.ok(
    strengthened.didYouKnowFacts.every(
      (fact) => fact.split(/\s+/).length >= 35,
    ),
  );
  assert.match(
    strengthened.analysisBad[0].detail,
    /^In the 2019 El Paso Walmart shooting source record,/,
  );
  const residual = hooks.scanArticleQuality(strengthened).filter(
    (issue) => /^(?:analysisBad|didYouKnowFacts)\[/.test(issue),
  );
  assert.deepEqual(residual, []);
});

test("timeline grounding skips the evidence corpus when no timeline exists", () => {
  const coreDraft = {
    overviewParagraphs: ["A complete core article paragraph."],
    get sourcePages() {
      throw new Error("source pages must not be inspected without a timeline");
    },
  };
  assert.doesNotThrow(() => hooks.groundLearningBlocks(coreDraft));
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

test("bounded enrichment checkpoints one optional style attempt before calling a provider", () => {
  const worker = readFileSync(
    new URL("../js/blog-ai-worker.js", import.meta.url),
    "utf8",
  );
  const enrichStart = worker.indexOf("async function enrichPublishedPost");
  const boundedStart = worker.indexOf("if (boundedRecovery) {", enrichStart);
  const boundedEnd = worker.indexOf(
    'await chk("bounded-preflight-passed")',
    boundedStart,
  );
  const boundedBody = worker.slice(boundedStart, boundedEnd);
  assert.equal((boundedBody.match(/improveArticleQuality\(/g) || []).length, 1);
  assert.doesNotMatch(boundedBody, /repairRepeatedBodySections\(|fixBannedPhrases\(/);
  const markerIndex = boundedBody.indexOf(
    'persistBoundedRepair(repaired, "bounded-style-pass-started")',
  );
  const providerIndex = boundedBody.indexOf("await improveArticleQuality(");
  assert.ok(
    markerIndex >= 0 && providerIndex > markerIndex,
    "the durable marker must be written before the optional provider call can hit a Worker limit",
  );
  assert.match(boundedBody, /draft\.boundedStyleRepairAttempted === true/);
});

test("normal enrichment checkpoints verified grounding progress for the bounded failsafe", () => {
  const worker = readFileSync(
    new URL("../js/blog-ai-worker.js", import.meta.url),
    "utf8",
  );
  const enrichStart = worker.indexOf("async function enrichPublishedPost");
  const finalGroundingStart = worker.indexOf(
    "const finalGrounding = await verifyFinalGroundingWithRepair(",
    enrichStart,
  );
  const finalGroundingEnd = worker.indexOf(
    "enriched = finalGrounding.content",
    finalGroundingStart,
  );
  const finalGroundingBody = worker.slice(
    finalGroundingStart,
    finalGroundingEnd,
  );
  const progressBranch = finalGroundingBody.indexOf(
    "if (finalGrounding.madeProgress === true)",
  );
  const retainedWrite = finalGroundingBody.indexOf(
    'boundedRepairStage: "final-grounding-progress"',
    progressBranch,
  );
  const coreClassification = finalGroundingBody.indexOf(
    "const coreGroundingReasons",
    progressBranch,
  );
  const eventBlock = finalGroundingBody.indexOf(
    "await markGroundingBlockedEvent(",
    coreClassification,
  );

  assert.ok(progressBranch >= 0, "the normal path must inspect verified progress");
  assert.match(
    finalGroundingBody.slice(progressBranch, coreClassification),
    /boundedGroundingRetryState\([\s\S]*\{ madeProgress: true \}/,
  );
  assert.ok(
    retainedWrite > progressBranch &&
      coreClassification > retainedWrite &&
      eventBlock > coreClassification,
    "verified progress must be persisted before a remaining core claim can block the event",
  );
  assert.match(
    finalGroundingBody.slice(progressBranch, coreClassification),
    /boundedGroundingAttempts: retryState\.attempts/,
  );
});

test("failsafe resumes retained enrichment outboxes and retries only transient recovery failures", () => {
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
  assert.match(
    workflow,
    /\/blog\/recover-post-figures\?slug=\$\{SLUG\}/,
    "a failsafe publication must start optional enrichment after its one-minute verification wait",
  );
  assert.match(workflow, /if \[ "\$STATUS" = "200" \]; then[\s\S]*"\$DRAFT_URL"/);
  assert.match(workflow, /for RECOVERY_ATTEMPT in 1 2 3/);
  assert.match(workflow, /is_worker_resource_error\(\)/);
  assert.match(workflow, /error code:\[\[:space:\]\]\*1102/);
  assert.match(workflow, /Worker CPU\/resource limit stopped bounded enrichment/);
  assert.match(
    workflow,
    /topic rotates only after consecutive passes make no grounding progress/,
  );
  assert.match(
    workflow,
    /\.finalized\.complete == true and \.finalized\.outboxCleared == true/,
  );
  assert.match(workflow, /if \[ "\$RECOVERY_HTTP_STATUS" = "429" \]; then/);
  assert.match(
    workflow,
    /"\$RECOVERY_HTTP_STATUS" != "503"[\s\S]*"\$RECOVERY_HTTP_STATUS" != "000"/,
  );
  assert.doesNotMatch(
    workflow,
    /if \[ "\$RECOVERY_HTTP_STATUS" = "200" \]; then\s*break/,
    "HTTP 200 alone must not conceal an incomplete outbox",
  );
});

test("post-publish enrichment starts at 00:16 and retains one hourly retry trigger", () => {
  const worker = readFileSync(
    new URL("../js/blog-ai-worker.js", import.meta.url),
    "utf8",
  );
  const wrangler = readFileSync(
    new URL("../wrangler-blog.jsonc", import.meta.url),
    "utf8",
  );

  assert.match(worker, /const DAILY_PUBLICATION_CRON = "5,10,15,16 0 \* \* \*"/);
  assert.match(worker, /const POST_PUBLISH_RECOVERY_MINUTES = new Set\(\[16\]\)/);
  assert.match(worker, /return "post-publish-recovery"/);
  assert.match(worker, /const RECOVERY_CRON = "50 0 \* \* \*"/);
  assert.match(worker, /const EVERGREEN_HISTORY_RETRY_CRON = "55 \* \* \* \*"/);
  assert.doesNotMatch(worker, /const RECOVERY_CRON = "50,55 0 \* \* \*"/);
  assert.match(
    wrangler,
    /"crons": \["5,10,15,16 0 \* \* \*", "50 0 \* \* \*", "25 1 \* \* \*", "55 \* \* \* \*"\]/,
  );
  assert.doesNotMatch(wrangler, /50,55 0 \* \* \*/);
});
