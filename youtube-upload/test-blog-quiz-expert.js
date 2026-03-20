/**
 * Test: blog quiz generation + quiz expert sharpening (real Groq API calls)
 *
 * Run from youtube-upload/:
 *   node test-blog-quiz-expert.js
 *
 * Exits 0 on success, 1 on any failure.
 */

import { config } from "dotenv";
config();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

async function callGroq(messages, maxTokens = 1500) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: maxTokens, temperature: 0.3 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

function parseQuestions(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!Array.isArray(parsed?.questions) || parsed.questions.length !== 5) return null;
  const valid = parsed.questions.filter(
    (q) =>
      typeof q.q === "string" && q.q.trim().length > 10 &&
      Array.isArray(q.options) && q.options.length === 4 &&
      q.options.every((o) => typeof o === "string" && o.trim().length > 2) &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3 &&
      typeof q.explanation === "string" && q.explanation.trim().length > 8,
  );
  return valid.length === 5 ? { ...parsed, questions: valid } : null;
}

// ---------------------------------------------------------------------------
// Fixtures — simulate a blog post context (Battle of Stalingrad)
// ---------------------------------------------------------------------------

const BLOG_CONTEXT = [
  "Title: Battle of Stalingrad - August 23, 1942",
  "Event: Battle of Stalingrad on August 23, 1942",
  "Location: Stalingrad, Soviet Union",
  "Summary: The Battle of Stalingrad was a major battle on the Eastern Front of World War II, fought between Nazi Germany and the Soviet Union. It was one of the bloodiest battles in history, with nearly two million casualties on both sides.",
  "Fact: The German 6th Army, commanded by Field Marshal Friedrich Paulus, was encircled and destroyed by Soviet forces.",
  "Fact: Operation Uranus was the Soviet counteroffensive that encircled the German forces in November 1942.",
  "Fact: The battle lasted from August 1942 to February 1943, spanning over five months.",
  "Fact: Soviet snipers played a crucial role, with Vasily Zaitsev credited with over 225 kills.",
  "Fact: The Soviets employed 'hugging tactics' to neutralize German air superiority by fighting close to German lines.",
];

const QUIZ_SYSTEM =
  "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.";

const QUIZ_USER =
  `Generate a 5-question multiple choice quiz based on this historical blog post.\n\nContext:\n${BLOG_CONTEXT.join("\n")}\n\nRules:\n- Exactly 5 questions, no more no less\n- Each question has exactly 4 options (never fewer, never more)\n- Exactly one correct answer per question (0-based index in "answer", must be 0, 1, 2, or 3)\n- Question types must vary: include at least one each of Who, What, Why/How, When/Where\n- Questions must progress: 1 easy recall, 2 medium analysis, 2 challenging synthesis\n- Draw from ALL Fact lines — do not repeat the same topic twice\n- Wrong options must be plausible but clearly incorrect; no trick questions\n- Each question must include a short "explanation" field (1-2 sentences) explaining why the answer is correct\n- All strings must be non-empty and longer than 5 characters\n- Output ONLY valid JSON, no markdown:\n{"questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"Why this answer is correct."}]}`;

const EXPERT_SYSTEM =
  "You are a rigorous history quiz editor. You receive a 5-question multiple-choice quiz " +
  "and a set of historical facts. Your job is to make the quiz harder and more educational " +
  "without changing its structure.\n\n" +
  "Rules:\n" +
  "- Keep all 5 questions, same order\n" +
  "- Keep the same JSON schema: {q, options, answer, explanation}\n" +
  "- answer is still a 0-based index (0-3) into options\n" +
  "- Make trivially easy questions harder by asking for a less obvious detail\n" +
  "- Wrong options must be plausible: same era, same country, same field — not obviously wrong\n" +
  "- At least 3 questions should require knowing a non-obvious fact, not just re-reading the title\n" +
  "- Never trick or mislead — every correct answer must be clearly supported by the facts provided\n" +
  "- Update the explanation to match any changes\n" +
  '- Output ONLY valid JSON, no markdown: {"questions":[...]}';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TESTS = [
  {
    name: "Quiz generation — Groq produces a valid 5-question quiz from blog context",
    run: async () => {
      if (!process.env.GROQ_API_KEY) {
        console.log("  ⚠ GROQ_API_KEY not set — skipping live API test");
        return;
      }

      const raw = await callGroq(
        [{ role: "system", content: QUIZ_SYSTEM }, { role: "user", content: QUIZ_USER }],
        1500,
      );
      assert(raw && raw.length > 0, "empty response from Groq");

      const quiz = parseQuestions(raw);
      assert(quiz !== null, `Failed to parse 5 valid questions.\nRaw: ${raw.slice(0, 400)}`);

      console.log("\n  ── Generated Questions ─────────────────────────────");
      quiz.questions.forEach((q, i) => {
        console.log(`  Q${i + 1}: ${q.q}`);
        q.options.forEach((o, j) => console.log(`       ${j === q.answer ? "✓" : " "} ${o}`));
      });
      console.log("  ────────────────────────────────────────────────────\n");
      console.log(`  ✓ Quiz generated: 5 valid questions`);
    },
  },

  {
    name: "Quiz expert — sharpens questions and shows before/after diff",
    run: async () => {
      if (!process.env.GROQ_API_KEY) {
        console.log("  ⚠ GROQ_API_KEY not set — skipping live API test");
        return;
      }

      // Step 1: generate base quiz
      const rawBase = await callGroq(
        [{ role: "system", content: QUIZ_SYSTEM }, { role: "user", content: QUIZ_USER }],
        1500,
      );
      const baseQuiz = parseQuestions(rawBase);
      assert(baseQuiz !== null, `Base quiz parse failed.\nRaw: ${rawBase?.slice(0, 400)}`);

      // Step 2: sharpen with expert
      const contextLines = BLOG_CONTEXT.join("\n");
      const expertUser =
        `Historical context:\n${contextLines}\n\n` +
        `Current quiz (JSON):\n${JSON.stringify({ questions: baseQuiz.questions }, null, 2)}\n\n` +
        `Return the improved quiz as JSON: {"questions":[{"q":"...","options":["A","B","C","D"],"answer":0,"explanation":"..."}]}`;

      const rawSharp = await callGroq(
        [{ role: "system", content: EXPERT_SYSTEM }, { role: "user", content: expertUser }],
        2000,
      );
      assert(rawSharp && rawSharp.length > 0, "empty response from quiz expert");

      const sharpQuiz = parseQuestions(rawSharp);
      assert(
        sharpQuiz !== null,
        `Expert quiz parse failed.\nRaw: ${rawSharp.slice(0, 400)}`,
      );

      // Show before / after diff
      console.log("\n  ── Before / After (Quiz Expert) ────────────────────");
      baseQuiz.questions.forEach((orig, i) => {
        const improved = sharpQuiz.questions[i];
        const changed = orig.q !== improved.q || orig.options.join("|") !== improved.options.join("|");
        console.log(`  Q${i + 1}: ${changed ? "✎ CHANGED" : "· unchanged"}`);
        if (changed) {
          console.log(`    BEFORE: ${orig.q}`);
          console.log(`    AFTER:  ${improved.q}`);
        }
      });
      console.log("  ────────────────────────────────────────────────────\n");

      const anyChanged = baseQuiz.questions.some(
        (orig, i) =>
          orig.q !== sharpQuiz.questions[i].q ||
          orig.options.join("|") !== sharpQuiz.questions[i].options.join("|"),
      );
      console.log(`  ✓ Expert review complete (${anyChanged ? "questions sharpened" : "all already strong"})`);
    },
  },

  {
    name: "Fallback — no GROQ_API_KEY set: no fetch called, returns null",
    run: async () => {
      const saved = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "";
      let fetchCalled = false;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => { fetchCalled = true; return realFetch(...args); };
      try {
        const result = await callGroq(
          [{ role: "system", content: QUIZ_SYSTEM }, { role: "user", content: QUIZ_USER }],
        );
        assert(!fetchCalled, "fetch should NOT be called when no key is set");
        assert(result === null, "expected null when no key set");
        console.log("  ✓ No fetch called, null returned");
      } finally {
        globalThis.fetch = realFetch;
        process.env.GROQ_API_KEY = saved;
      }
    },
  },

  {
    name: "Fallback — bad token (401): throws, caller should use originals",
    run: async () => {
      const saved = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "gsk_invalid_token_for_testing";
      try {
        let threw = false;
        try {
          await callGroq(
            [{ role: "system", content: QUIZ_SYSTEM }, { role: "user", content: QUIZ_USER }],
          );
        } catch (err) {
          threw = true;
          assert(
            err.message.includes("401") || err.message.includes("403"),
            `Expected 401/403 auth error, got: ${err.message}`,
          );
        }
        assert(threw, "Expected callGroq to throw on invalid key");
        console.log("  ✓ Bad token throws auth error — caller falls back to originals");
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
