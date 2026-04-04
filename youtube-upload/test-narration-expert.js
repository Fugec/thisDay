/**
 * Test: narration-expert.js  (real Groq API calls — uses GROQ_API_KEY from .env)
 *
 * Run from youtube-upload/:
 *   node test-narration-expert.js
 *
 * Exits 0 on success, 1 on any failure.
 */

import { config } from "dotenv";
import { polishNarrationItems } from "./lib/narration-expert.js";

config();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STALINGRAD_TITLE = "Battle of Stalingrad — August 23, 1942";

const STALINGRAD_ITEMS = [
  "The German 6th Army, commanded by Field Marshal Friedrich Paulus, was encircled by Soviet forces.",
  "Operation Uranus was the Soviet counteroffensive that surrounded the Germans in November 1942.",
  "Soviet snipers played a crucial role, with Vasily Zaitsev credited with over 225 kills.",
  "The Soviets used 'hugging tactics' — fighting close to German lines to neutralize air superiority.",
  "The battle lasted over five months and resulted in nearly two million casualties on both sides.",
];

const STALINGRAD_ARTICLE =
  "The Battle of Stalingrad was one of the bloodiest and most pivotal battles of World War II. " +
  "Fought between Nazi Germany and the Soviet Union from August 1942 to February 1943, it marked " +
  "a decisive turning point on the Eastern Front. The city, sitting on the Volga River, became a " +
  "symbol of Soviet resistance. Hitler viewed its capture as essential — both strategically and for " +
  "propaganda purposes, as the city bore Stalin's name. Street-by-street urban combat reduced the " +
  "city to rubble. Snipers like Vasily Zaitsev became legendary figures of resistance. " +
  "When Soviet forces launched Operation Uranus in November 1942, they encircled the entire German " +
  "6th Army in a massive pincer movement. Field Marshal Paulus surrendered in February 1943, " +
  "delivering Germany its first major defeat of the war and shifting the momentum permanently.";

const MOON_ITEMS = [
  "Apollo 11 launched from Kennedy Space Center on July 16, 1969.",
  "Neil Armstrong became the first human to walk on the moon on July 20, 1969.",
  "Buzz Aldrin joined Armstrong on the surface while Michael Collins orbited above.",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TESTS = [
  {
    name: "Stalingrad — polishes dry facts into engaging documentary narration",
    run: async () => {
      const result = await polishNarrationItems(
        STALINGRAD_TITLE,
        STALINGRAD_ITEMS,
        STALINGRAD_ARTICLE,
      );

      assert(result.length === STALINGRAD_ITEMS.length, `Expected ${STALINGRAD_ITEMS.length} items, got ${result.length}`);
      result.forEach((p, i) =>
        assert(typeof p === "string" && p.trim().length > 20, `Item ${i + 1} too short`),
      );

      console.log("\n  ── Before / After ──────────────────────────────────");
      STALINGRAD_ITEMS.forEach((orig, i) => {
        const changed = result[i] !== orig;
        console.log(`  Item ${i + 1}: ${changed ? "✎ POLISHED" : "· unchanged"}`);
        if (changed) {
          console.log(`    BEFORE: ${orig}`);
          console.log(`    AFTER:  ${result[i]}`);
        }
      });
      console.log("  ────────────────────────────────────────────────────\n");

      if (!process.env.GROQ_API_KEY && !process.env.HF_TOKEN) {
        STALINGRAD_ITEMS.forEach((p, i) =>
          assert(result[i] === p, `Fallback item ${i + 1} was modified without any token`),
        );
        console.log("  ⚠ No API key — fallback returned originals unchanged (correct)");
        return;
      }

      // Each item should be a non-empty string within the character limit
      result.forEach((p, i) =>
        assert(p.length <= 250, `Item ${i + 1} too long for TTS: ${p.length} chars`),
      );
      console.log(`  ✓ ${result.length} items polished, all within 250-char TTS limit`);
    },
  },

  {
    name: "Moon landing — polishes without article text (null context)",
    run: async () => {
      const result = await polishNarrationItems(
        "Apollo 11 Moon Landing — July 20, 1969",
        MOON_ITEMS,
        null,   // no article text
      );

      assert(result.length === MOON_ITEMS.length, `Expected ${MOON_ITEMS.length} items, got ${result.length}`);

      console.log("\n  ── Before / After ──────────────────────────────────");
      MOON_ITEMS.forEach((orig, i) => {
        const changed = result[i] !== orig;
        console.log(`  Item ${i + 1}: ${changed ? "✎ POLISHED" : "· unchanged"}`);
        if (changed) {
          console.log(`    BEFORE: ${orig}`);
          console.log(`    AFTER:  ${result[i]}`);
        }
      });
      console.log("  ────────────────────────────────────────────────────\n");
      console.log(`  ✓ Polished ${result.length} items without article context`);
    },
  },

  {
    name: "Fallback — no API keys: no fetch called, originals returned",
    run: async () => {
      const saved = {
        GROQ_API_KEY: process.env.GROQ_API_KEY, GROQ_API_KEY_2: process.env.GROQ_API_KEY_2,
        GROQ_API_KEY_3: process.env.GROQ_API_KEY_3, GROQ_API_KEY_4: process.env.GROQ_API_KEY_4,
        HF_TOKEN: process.env.HF_TOKEN, HF_TOKEN_2: process.env.HF_TOKEN_2, HF_TOKEN_3: process.env.HF_TOKEN_3,
      };
      Object.keys(saved).forEach((k) => { process.env[k] = ""; });
      let fetchCalled = false;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => { fetchCalled = true; return realFetch(...args); };
      try {
        const result = await polishNarrationItems(STALINGRAD_TITLE, STALINGRAD_ITEMS, STALINGRAD_ARTICLE);
        assert(!fetchCalled, "fetch should NOT be called when no keys are set");
        assert(result.length === STALINGRAD_ITEMS.length, "length mismatch");
        STALINGRAD_ITEMS.forEach((p, i) =>
          assert(result[i] === p, `Item ${i + 1} was modified without any token`),
        );
        console.log("  ✓ No fetch called, originals returned unchanged");
      } finally {
        globalThis.fetch = realFetch;
        Object.entries(saved).forEach(([k, v]) => { process.env[k] = v; });
      }
    },
  },

  {
    name: "Fallback — bad token (401): originals returned unchanged",
    run: async () => {
      const saved = {
        GROQ_API_KEY: process.env.GROQ_API_KEY, GROQ_API_KEY_2: process.env.GROQ_API_KEY_2,
        GROQ_API_KEY_3: process.env.GROQ_API_KEY_3, GROQ_API_KEY_4: process.env.GROQ_API_KEY_4,
        HF_TOKEN: process.env.HF_TOKEN, HF_TOKEN_2: process.env.HF_TOKEN_2, HF_TOKEN_3: process.env.HF_TOKEN_3,
      };
      Object.keys(saved).forEach((k) => { process.env[k] = "invalid_token_for_testing"; });
      try {
        const result = await polishNarrationItems(STALINGRAD_TITLE, STALINGRAD_ITEMS, null);
        assert(result.length === STALINGRAD_ITEMS.length, "length mismatch");
        STALINGRAD_ITEMS.forEach((p, i) =>
          assert(result[i] === p, `Item ${i + 1} was modified on 401`),
        );
        console.log("  ✓ All 401 errors — originals returned unchanged");
      } finally {
        Object.entries(saved).forEach(([k, v]) => { process.env[k] = v; });
      }
    },
  },

  {
    name: "Edge case — empty items array: returned as-is",
    run: async () => {
      const result = await polishNarrationItems(STALINGRAD_TITLE, [], null);
      assert(Array.isArray(result) && result.length === 0, "expected empty array");
      console.log("  ✓ Empty array returned unchanged");
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

for (const test of TESTS) {
  process.stdout.write(`\n[ ] ${test.name}\n`);
  try {
    await test.run();
    process.stdout.write(`[✓] PASS\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`[✗] FAIL — ${err.message}\n`);
    failed++;
  }
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("Some tests failed.");
  process.exit(1);
}
console.log("All tests passed.");
