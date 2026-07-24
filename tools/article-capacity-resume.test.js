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
    (workflow.match(/-X POST "\$WORKER_URL\/blog\/generate-draft"/g) || [])
      .length,
    1,
  );
});
