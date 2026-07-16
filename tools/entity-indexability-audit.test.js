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

test("Wikipedia verification follows redirects and rejects disambiguation pages", async () => {
  const entries = [
    {
      entity: {
        wikiUrl: "https://en.wikipedia.org/wiki/Safe_Source",
      },
      entry: {},
    },
    {
      entity: {
        wikiUrl: "https://en.wikipedia.org/wiki/Ambiguous_Source",
      },
      entry: {},
    },
  ];
  let requestedUrl = "";
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
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
                extract:
                  "This verified source contains enough substantive introductory words to pass the minimum source evidence threshold without relying on a missing page, an ambiguous title, or a disambiguation marker in its MediaWiki metadata response.",
              },
              {
                title: "Ambiguous Source",
                pageprops: { disambiguation: "" },
                extract:
                  "Ambiguous Source may refer to several unrelated historical topics and people.",
              },
            ],
          },
        };
      },
    };
  };

  const verification = await verifyWikipediaSourcePages(entries, fetchImpl);

  assert.match(requestedUrl, /exlimit=max/);
  assert.equal(verification.requestCount, 1);
  assert.equal(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Safe_Source",
    ).verified,
    true,
  );
  assert.equal(
    verification.results.get(
      "https://en.wikipedia.org/wiki/Ambiguous_Source",
    ).verified,
    false,
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
