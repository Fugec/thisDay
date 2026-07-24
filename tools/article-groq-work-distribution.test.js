import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as articleHooks,
} from "../js/blog-ai-worker.js";
import {
  __resetGroqModelCacheForTests,
  callAI,
} from "../js/shared/ai-call.js";

test("independent article work requires two declared quota pools, not merely two keys", () => {
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
      GROQ_API_KEY_2: "key-2",
      GROQ_QUOTA_POOL_IDS: "organization-a,organization-b",
    }),
    true,
  );
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
      GROQ_API_KEY_2: "key-2",
    }),
    false,
  );
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
      GROQ_API_KEY_2: "key-2",
      GROQ_QUOTA_POOL_IDS: "shared-organization,shared-organization",
    }),
    false,
  );
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
      GROQ_API_KEY_2: "key-2",
      GROQ_API_KEY_3: "key-3",
      GROQ_QUOTA_POOL_IDS: "organization-a,,organization-b",
    }),
    false,
  );
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
      GROQ_API_KEY_2: "key-2",
      GROQ_QUOTA_POOL_IDS: "Organization A,organization-a",
    }),
    false,
  );
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
    }),
    false,
  );
  assert.equal(
    articleHooks.canDistributeIndependentArticleWork({
      GROQ_API_KEY: "key-1",
      GROQ_API_KEY_2: "key-2",
      ARTICLE_GENERATION_PREFER_WORKERS_AI: "1",
      GROQ_QUOTA_POOL_IDS: "organization-a,organization-b",
    }),
    false,
  );
});

test("body and facts overlap only when distribution is enabled", async () => {
  let releaseFactsStarted;
  const factsStarted = new Promise((resolve) => {
    releaseFactsStarted = resolve;
  });
  let bodyInFlight = false;
  let factsObservedBodyInFlight = false;
  const bodyPromise = (async () => {
    bodyInFlight = true;
    await factsStarted;
    bodyInFlight = false;
    return { bodyA: "a", bodyB: "b" };
  })();

  const distributed = await articleHooks.runIndependentArticleWork(
    bodyPromise,
    async () => {
      factsObservedBodyInFlight = bodyInFlight;
      releaseFactsStarted();
      return { quickFacts: [] };
    },
    true,
  );

  assert.equal(factsObservedBodyInFlight, true);
  assert.deepEqual(distributed.bodyResult, { bodyA: "a", bodyB: "b" });

  let sequentialBodyComplete = false;
  let factsObservedSequentialCompletion = false;
  const sequential = await articleHooks.runIndependentArticleWork(
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sequentialBodyComplete = true;
      return { bodyA: "a", bodyB: "b" };
    })(),
    async () => {
      factsObservedSequentialCompletion = sequentialBodyComplete;
      return { quickFacts: [] };
    },
    false,
  );

  assert.equal(factsObservedSequentialCompletion, true);
  assert.deepEqual(sequential.facts, { quickFacts: [] });
});

test("concurrent independent calls lease distinct Groq keys", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  const usedKeys = [];
  const activeKeys = new Set();
  let duplicateInFlightKey = false;
  let maxConcurrentCompletions = 0;
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
      if (activeKeys.has(key)) duplicateInFlightKey = true;
      activeKeys.add(key);
      maxConcurrentCompletions = Math.max(
        maxConcurrentCompletions,
        activeKeys.size,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeKeys.delete(key);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const env = {
    GROQ_API_KEY: "parallel-key-1",
    GROQ_API_KEY_2: "parallel-key-2",
    GROQ_API_KEY_3: "parallel-key-3",
    GROQ_QUOTA_POOL_IDS: "organization-a,organization-b,organization-c",
  };
  try {
    assert.deepEqual(
      await Promise.all([
        callAI(env, [{ role: "user", content: "independent body chunk" }]),
        callAI(env, [{ role: "user", content: "independent facts chunk" }]),
      ]),
      ["ok", "ok"],
    );
    assert.equal(maxConcurrentCompletions, 2);
    assert.equal(duplicateInFlightKey, false);
    assert.deepEqual(usedKeys.sort(), [
      "parallel-key-1",
      "parallel-key-2",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});

test("busy Groq keys are not reused by concurrent work", async () => {
  __resetGroqModelCacheForTests();
  const originalFetch = globalThis.fetch;
  let groqCompletions = 0;
  let openRouterCompletions = 0;
  let releaseGroq;
  const groqCanFinish = new Promise((resolve) => {
    releaseGroq = resolve;
  });
  let notifyGroqStarted;
  const groqStarted = new Promise((resolve) => {
    notifyGroqStarted = resolve;
  });
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
      groqCompletions += 1;
      notifyGroqStarted();
      await groqCanFinish;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "groq-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("openrouter.ai/api/v1/chat/completions")) {
      openRouterCompletions += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "fallback-ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  const env = {
    GROQ_API_KEY: "single-busy-key",
    OPENROUTER_API_KEY: "single-openrouter-key",
  };
  try {
    const first = callAI(env, [{ role: "user", content: "body" }]);
    await groqStarted;
    const second = callAI(env, [{ role: "user", content: "facts" }]);
    assert.equal(await second, "fallback-ok");
    releaseGroq();
    assert.equal(await first, "groq-ok");
    assert.equal(groqCompletions, 1);
    assert.equal(openRouterCompletions, 1);
  } finally {
    releaseGroq?.();
    globalThis.fetch = originalFetch;
    __resetGroqModelCacheForTests();
  }
});
