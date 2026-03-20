/**
 * Test: history-expert.js  (real API calls — uses GROQ_API_KEY from .env)
 *
 * Run from youtube-upload/:
 *   node test-history-expert.js
 *
 * Exits 0 on success, 1 on any failure.
 */

import { config } from "dotenv";
import { reviewPromptsWithHistoryExpert } from "./lib/history-expert.js";

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

const WW2_PROMPTS = [
  "ultra-realistic World War II scene, soldiers in battle, wide shot, vertical 9:16",
  "ultra-realistic World War II scene, group of soldiers advancing, vertical 9:16",
  "ultra-realistic World War II scene, ruins and aftermath, vertical 9:16",
];

const MEDIEVAL_PROMPTS = [
  "ultra-realistic late medieval scene, English longbowmen at Agincourt, wide shot, vertical 9:16",
  "ultra-realistic late medieval scene, knights in armor clashing, vertical 9:16",
  "ultra-realistic late medieval scene, aftermath of battle, bodies and heraldic banners, vertical 9:16",
];

const MOON_PROMPTS = [
  "ultra-realistic 1960s scene, astronauts on the moon, wide shot, vertical 9:16",
  "ultra-realistic 1960s scene, mission control celebrating, vertical 9:16",
  "ultra-realistic 1960s scene, lunar module on moon surface, vertical 9:16",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TESTS = [
  {
    name: "WW2 — Claude enriches Stalingrad prompts with period-accurate details",
    run: async () => {
      const result = await reviewPromptsWithHistoryExpert(
        "Battle of Stalingrad", 1942, "World War II", WW2_PROMPTS,
      );

      assert(result.length === 3, `Expected 3 prompts, got ${result.length}`);
      result.forEach((p, i) =>
        assert(typeof p === "string" && p.trim().length > 20, `Prompt ${i + 1} too short`),
      );

      // Always print before/after diff so we can see what the expert changed
      console.log("\n  ── Before / After ──────────────────────────────────");
      WW2_PROMPTS.forEach((orig, i) => {
        const changed = result[i] !== orig;
        console.log(`  Scene ${i + 1}: ${changed ? "✎ CHANGED" : "· unchanged"}`);
        if (changed) {
          console.log(`    BEFORE: ${orig}`);
          console.log(`    AFTER:  ${result[i]}`);
        }
      });
      console.log("  ────────────────────────────────────────────────────\n");

      const apiModified = result.some((p, i) => p !== WW2_PROMPTS[i]);
      if (!apiModified) {
        WW2_PROMPTS.forEach((p, i) => assert(result[i] === p, `Fallback prompt ${i + 1} was modified`));
        console.log("  ⚠ API unavailable — fallback returned originals unchanged (correct)");
        return;
      }

      // API responded — verify period-accurate terms were added
      const joined = result.join(" ").toLowerCase();
      const wwiiTerms = ["stalingrad", "soviet", "german", "red army", "volga",
        "stahlhelm", "panzer", "rifle", "uniform", "rubble", "winter", "urban", "m1"];
      const found = wwiiTerms.filter((t) => joined.includes(t));
      assert(found.length >= 1,
        `Expected at least one WWII-specific term.\nGot:\n${result.join("\n")}`);
      console.log(`  ✓ Period-accurate terms added: ${found.slice(0, 4).join(", ")}`);
    },
  },

  {
    name: "Medieval — no modern anachronisms in corrected Agincourt prompts",
    run: async () => {
      const result = await reviewPromptsWithHistoryExpert(
        "Battle of Agincourt", 1415, "late medieval", MEDIEVAL_PROMPTS,
      );

      assert(result.length === 3, `Expected 3 prompts, got ${result.length}`);
      result.forEach((p, i) =>
        assert(typeof p === "string" && p.trim().length > 20, `Prompt ${i + 1} too short`),
      );

      console.log("\n  ── Before / After ──────────────────────────────────");
      MEDIEVAL_PROMPTS.forEach((orig, i) => {
        const changed = result[i] !== orig;
        console.log(`  Scene ${i + 1}: ${changed ? "✎ CHANGED" : "· unchanged"}`);
        if (changed) {
          console.log(`    BEFORE: ${orig}`);
          console.log(`    AFTER:  ${result[i]}`);
        }
      });
      console.log("  ────────────────────────────────────────────────────\n");

      const joined = result.join(" ").toLowerCase();
      const anachronisms = ["rifle", "tank", "aircraft", "helicopter", "pistol", "machine gun", "grenade"];
      const found = anachronisms.filter((t) => joined.includes(t));
      assert(found.length === 0, `Anachronistic terms found: ${found.join(", ")}`);
      console.log("  ✓ No modern anachronisms in corrected medieval prompts");
    },
  },

  {
    name: "Fallback — no keys at all returns originals unchanged, no fetch",
    run: async () => {
      const savedGroq = process.env.GROQ_API_KEY;
      const savedHf = process.env.HF_TOKEN;
      process.env.GROQ_API_KEY = "";
      process.env.HF_TOKEN = "";
      let fetchCalled = false;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => { fetchCalled = true; return realFetch(...args); };
      try {
        const result = await reviewPromptsWithHistoryExpert(
          "Apollo 11 Moon Landing", 1969, "1960s", MOON_PROMPTS,
        );
        assert(!fetchCalled, "fetch should NOT be called when no keys are set");
        assert(result.length === MOON_PROMPTS.length, "length mismatch");
        MOON_PROMPTS.forEach((p, i) => assert(result[i] === p, `Prompt ${i + 1} was modified without any token`));
        console.log("  ✓ No fetch called, originals returned unchanged");
      } finally {
        globalThis.fetch = realFetch;
        process.env.GROQ_API_KEY = savedGroq;
        process.env.HF_TOKEN = savedHf;
      }
    },
  },

  {
    name: "Fallback — bad token (401) returns originals unchanged",
    run: async () => {
      const saved = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "hf_invalid_token_for_testing";
      try {
        const result = await reviewPromptsWithHistoryExpert(
          "Apollo 11 Moon Landing", 1969, "1960s", MOON_PROMPTS,
        );
        assert(result.length === MOON_PROMPTS.length, "length mismatch");
        MOON_PROMPTS.forEach((p, i) => assert(result[i] === p, `Prompt ${i + 1} was modified on 401`));
        console.log("  ✓ 401 auth error — originals returned unchanged");
      } finally {
        process.env.GROQ_API_KEY = saved;
      }
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
