import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMigrationPlan,
  evaluateEntityIndexability,
  executeMigrationPlan,
  selectMigrationBatch,
  verifyWikipediaSourcePages,
} from "./entity-indexability-audit.js";

function auditEntry(
  type,
  slug,
  {
    recommendedEligible = true,
    googleCoverage = "URL is unknown to Google",
    sourceVerified = true,
  } = {},
) {
  const wikiUrl = `https://en.wikipedia.org/wiki/${slug}`;
  return {
    row: {
      type,
      slug,
      name: slug,
      url:
        `https://thisday.info/${type === "person" ? "people" : "history"}` +
        `/${slug}/`,
      recordFound: true,
      currentIndexable: true,
      recommendedEligible,
      googleCoverage,
      wordCount: type === "person" ? 180 : 320,
      reasons: recommendedEligible ? [] : ["quality gate failure"],
      sourceVerification: {
        verified: sourceVerified,
        requestedTitle: slug,
        resolvedTitle: slug,
        pageExists: true,
        disambiguation: !sourceVerified,
        extractWordCount: sourceVerified ? 100 : 10,
        personIsHuman: type === "person" ? sourceVerified : null,
        reasons: sourceVerified ? [] : ["disambiguation"],
      },
    },
    entity: {
      type,
      slug,
      wikiUrl,
      bodySections: [],
    },
    entry: {
      type,
      slug,
      indexable: true,
    },
    entityRaw: JSON.stringify({
      type,
      slug,
      wikiUrl,
      bodySections: [],
    }),
  };
}

function migrationFixture() {
  const auditedEntries = [
    auditEntry("person", "safe-person"),
    auditEntry("event", "safe-event"),
  ];
  const index = auditedEntries.map(({ entry }) => entry);
  const indexRaw = JSON.stringify(index);
  const plan = buildMigrationPlan(
    auditedEntries,
    index,
    indexRaw,
    2,
    "2026-07-16T00:00:00.000Z",
    {
      requireSourceVerification: true,
      sourceVerificationRequests: 1,
    },
  );
  const directory = mkdtempSync(
    join(tmpdir(), "entity-migration-test-"),
  );
  const planPath = join(directory, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  const kv = new Map([["entity-index-v1", indexRaw]]);
  for (const entry of auditedEntries) {
    kv.set(
      `entity-v1:${entry.row.type}:${entry.row.slug}`,
      entry.entityRaw,
    );
  }
  const sourceVerifier = async (entries) => ({
    requestCount: 1,
    results: new Map(
      entries.map(({ entity, entry }) => [
        entity?.wikiUrl || entry?.wikiUrl,
        {
          verified: true,
          disambiguation: false,
          personIsHuman: entity?.type === "person" ? true : null,
          reasons: [],
        },
      ]),
    ),
  });
  return {
    directory,
    kv,
    plan,
    planPath,
    sourceVerifier,
  };
}

test("safe migration selection balances people and events", () => {
  const entries = [
    auditEntry("person", "person-a"),
    auditEntry("person", "person-b"),
    auditEntry("event", "event-a"),
    auditEntry("event", "event-b"),
  ];

  const selected = selectMigrationBatch(entries, 4, {
    requireSourceVerification: true,
  });

  assert.deepEqual(
    selected.map(({ row }) => `${row.type}:${row.slug}`),
    [
      "person:person-a",
      "event:event-a",
      "person:person-b",
      "event:event-b",
    ],
  );
});

test("safe migration selection excludes source failures and indexed gate failures", () => {
  const entries = [
    auditEntry("person", "safe"),
    auditEntry("event", "disambiguation", { sourceVerified: false }),
    auditEntry("person", "protected", {
      recommendedEligible: false,
      googleCoverage: "Submitted and indexed",
    }),
  ];

  const selected = selectMigrationBatch(entries, 10, {
    requireSourceVerification: true,
  });
  assert.deepEqual(selected.map(({ row }) => row.slug), ["safe"]);

  const index = entries.map(({ entry }) => entry);
  const plan = buildMigrationPlan(
    entries,
    index,
    JSON.stringify(index),
    10,
    "2026-07-16T00:00:00.000Z",
    {
      requireSourceVerification: true,
      sourceVerificationRequests: 1,
    },
  );

  assert.equal(plan.productionWrites, 0);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.sourceRejectedCandidates.length, 1);
  assert.equal(plan.protectedIndexedFailures.length, 1);
  assert.equal(plan.sharedIndex.beforeEntryCount, plan.sharedIndex.afterEntryCount);
  assert.ok(
    plan.items.every(
      (item) =>
        item.eligibilityBefore === item.eligibilityAfter &&
        item.robotsBefore === item.robotsAfter,
    ),
  );
});

test("source verification follows redirects and rejects disambiguation and non-human person pages", async () => {
  const entries = [
    {
      entity: {
        type: "person",
        wikiUrl: "https://en.wikipedia.org/wiki/Safe_Source",
      },
      entry: {},
    },
    {
      entity: {
        type: "person",
        wikiUrl: "https://en.wikipedia.org/wiki/Ambiguous_Source",
      },
      entry: {},
    },
    {
      entity: {
        type: "person",
        wikiUrl: "https://en.wikipedia.org/wiki/Group_Source",
      },
      entry: {},
    },
  ];
  let requestedUrl = "";
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    if (requestedUrl.startsWith("https://www.wikidata.org/")) {
      return {
        ok: true,
        async json() {
          return {
            entities: {
              Q1: {
                claims: {
                  P31: [
                    {
                      mainsnak: {
                        datavalue: { value: { id: "Q5" } },
                      },
                    },
                  ],
                },
              },
              Q2: {
                claims: {
                  P31: [
                    {
                      mainsnak: {
                        datavalue: { value: { id: "Q4167410" } },
                      },
                    },
                  ],
                },
              },
              Q3: {
                claims: {
                  P31: [
                    {
                      mainsnak: {
                        datavalue: { value: { id: "Q41710" } },
                      },
                    },
                  ],
                },
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          query: {
            redirects: [
              {
                from: "Safe Source",
                to: "Resolved Safe Source",
              },
            ],
            pages: [
              {
                title: "Resolved Safe Source",
                pageprops: { wikibase_item: "Q1" },
                extract:
                  "This verified source contains enough substantive introductory words to pass the minimum source evidence threshold without relying on a missing page, an ambiguous title, or a disambiguation marker in its MediaWiki metadata response.",
              },
              {
                title: "Ambiguous Source",
                pageprops: {
                  disambiguation: "",
                  wikibase_item: "Q2",
                },
                extract:
                  "Ambiguous Source may refer to several unrelated historical topics and people.",
              },
              {
                title: "Group Source",
                pageprops: { wikibase_item: "Q3" },
                extract:
                  "Group Source describes a large ethnic community with a shared history, language, culture, geographic origin, and modern diaspora rather than the life of one individual human subject.",
              },
            ],
          },
        };
      },
    };
  };

  const verification = await verifyWikipediaSourcePages(entries, fetchImpl);

  assert.equal(verification.requestCount, 2);
  assert.equal(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Safe_Source",
    ).verified,
    true,
  );
  assert.equal(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Safe_Source",
    ).personIsHuman,
    true,
  );
  assert.equal(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Ambiguous_Source",
    ).verified,
    false,
  );
  assert.equal(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Group_Source",
    ).verified,
    false,
  );
  assert.deepEqual(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Group_Source",
    ).reasons,
    ["Wikipedia person source is not a human biography"],
  );
});

test("person eligibility measures the body rendered from source facts, not discarded legacy prose", () => {
  const legacyParagraph =
    "This legacy paragraph contains many words about historical context, career achievements, institutional influence, public service, international cooperation, professional recognition, later life, and broad legacy claims that the current person renderer does not use when it reconstructs the visible biography from source facts. ".repeat(
      5,
    );
  const entity = {
    type: "person",
    slug: "thin-rendered-person",
    name: "Thin Rendered Person",
    wikiUrl: "https://en.wikipedia.org/wiki/Thin_Rendered_Person",
    profileLinkEligible: true,
    profileSubjectVerified: true,
    intro:
      "Thin Rendered Person was a Canadian medical practitioner and administrator who served in public health. He became the first leader of an international organization and received several professional honors.",
    summary:
      "Thin Rendered Person worked as a psychiatrist, military medical officer, and international civil servant.",
    bodySections: [
      {
        heading: "Early Life and Background",
        paragraphs: [legacyParagraph],
      },
    ],
  };

  const evaluation = evaluateEntityIndexability(entity);

  assert.ok(evaluation.storedWordCount > 150);
  assert.ok(evaluation.wordCount < 150);
  assert.equal(evaluation.eligible, false);
  assert.ok(
    evaluation.reasons.includes("rendered body below 150 words"),
  );
});

test("verification mode creates backups without writing KV", async () => {
  const fixture = migrationFixture();
  const writes = [];
  const result = await executeMigrationPlan(fixture.planPath, {
    apply: false,
    readKv: async (key) => fixture.kv.get(key) ?? null,
    writeKv: async (key) => writes.push(key),
    sourceVerifier: fixture.sourceVerifier,
    generatedAt: new Date("2026-07-16T01:00:00.000Z"),
  });

  assert.deepEqual(writes, []);
  assert.equal(result.productionWrites, 0);
  assert.equal(result.backupsCreated, 3);
  assert.equal(result.readyForConfirmedApply, true);
  assert.deepEqual(
    JSON.parse(readFileSync(result.planSnapshotPath, "utf8")),
    fixture.plan,
  );
  const report = JSON.parse(readFileSync(result.resultPath, "utf8"));
  assert.equal(report.mode, "verification-only dry run");
  assert.equal(report.productionWrites, 0);
});

test("stale entity hash rejects the complete batch before any write", async () => {
  const fixture = migrationFixture();
  fixture.kv.set(
    "entity-v1:person:safe-person",
    JSON.stringify({ changed: true }),
  );
  const writes = [];

  await assert.rejects(
    executeMigrationPlan(fixture.planPath, {
      apply: true,
      confirmed: true,
      readKv: async (key) => fixture.kv.get(key) ?? null,
      writeKv: async (key) => writes.push(key),
      sourceVerifier: fixture.sourceVerifier,
      generatedAt: new Date("2026-07-16T02:00:00.000Z"),
    }),
    /live hash changed/,
  );
  assert.deepEqual(writes, []);
});

test("confirmed apply writes verified entities before the shared index", async () => {
  const fixture = migrationFixture();
  const writes = [];
  const result = await executeMigrationPlan(fixture.planPath, {
    apply: true,
    confirmed: true,
    readKv: async (key) => fixture.kv.get(key) ?? null,
    writeKv: async (key, value) => {
      writes.push(key);
      fixture.kv.set(key, value);
    },
    sourceVerifier: fixture.sourceVerifier,
    generatedAt: new Date("2026-07-16T03:00:00.000Z"),
  });

  assert.deepEqual(writes, [
    "entity-v1:person:safe-person",
    "entity-v1:event:safe-event",
    "entity-index-v1",
  ]);
  assert.equal(result.productionWrites, 3);
  assert.equal(result.completed.length, 3);
  assert.equal(
    fixture.kv.get("entity-index-v1"),
    JSON.stringify(fixture.plan.sharedIndex.proposedValue),
  );
});
