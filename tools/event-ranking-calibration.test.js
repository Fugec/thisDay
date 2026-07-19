import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  rankHistoricalEventCandidates,
  scoreHistoricalEventSignificance,
} from "../js/shared/event-ranking.js";
import {
  buildCalibrationReport,
  CALIBRATION_DATES,
} from "./event-ranking-calibration.js";

const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/event-ranking-calibration.json", import.meta.url),
    "utf8",
  ),
);

function event(overrides = {}) {
  return {
    year: 1960,
    pageTitle: "Historical event",
    text: "A historical event takes place.",
    hasThumbnail: true,
    extractLength: 600,
    ...overrides,
  };
}

describe("historical-event ranking calibration", () => {
  it("covers the full calendar plus the two incident anchors", () => {
    assert.equal(CALIBRATION_DATES.length, 50);
    assert.equal(fixture.dates.length, 50);
    assert.deepEqual(
      new Set(fixture.dates.map(({ date }) => date.split("-")[0])).size,
      12,
    );
    assert.ok(fixture.dates.some(({ date }) => date === "june-19"));
    assert.ok(fixture.dates.some(({ date }) => date === "july-19"));
  });

  it("stores fingerprints rather than copied editorial prose", () => {
    for (const date of fixture.dates) {
      for (const highlight of date.editorialHighlights) {
        assert.equal("text" in highlight, false);
        assert.ok(Number.isInteger(highlight.year));
        assert.ok(highlight.tokenHashes.length >= 2);
        assert.ok(
          highlight.tokenHashes.every((hash) => /^[a-f0-9]{16}$/.test(hash)),
        );
      }
    }
  });

  it("keeps the calibrated top-five coverage above the recorded baseline", () => {
    const report = buildCalibrationReport(fixture);
    assert.equal(report.mappableDateCount, 50);
    assert.ok(
      report.topFiveDateHitRate >= 0.6,
      `top-five date coverage fell to ${report.topFiveDateHitRate}`,
    );
    assert.ok(
      report.meanFirstEditorialRank <= 7.1,
      `mean first editorial rank rose to ${report.meanFirstEditorialRank}`,
    );
  });
});

describe("historical-event ranking topic neutrality", () => {
  it("never removes candidates from any topic", () => {
    const candidates = [
      event({
        pageTitle: "Olympic Games",
        text: "An athlete sets a world record at the Olympic Games.",
      }),
      event({
        pageTitle: "Near-Earth asteroid",
        text: "A near-Earth asteroid is discovered by an observatory.",
      }),
      event({
        pageTitle: "Regional history",
        text: "A local municipal institution is established.",
      }),
      event({
        pageTitle: "Military history",
        text: "A battle takes place during a war.",
      }),
    ];

    const ranked = rankHistoricalEventCandidates(candidates);
    assert.equal(ranked.length, candidates.length);
    assert.deepEqual(
      new Set(ranked.map(({ pageTitle }) => pageTitle)),
      new Set(candidates.map(({ pageTitle }) => pageTitle)),
    );
  });

  it("does not penalize sports, astronomy, or local history as categories", () => {
    for (const candidate of [
      event({
        pageTitle: "Olympic Games",
        text: "A cyclist wins the Olympic championship in a world-record time.",
      }),
      event({
        pageTitle: "Asteroid discovery",
        text: "Astronomers discover a near-Earth asteroid.",
      }),
      event({
        pageTitle: "Local history",
        text: "A regional municipal institution is established.",
      }),
    ]) {
      assert.equal(
        scoreHistoricalEventSignificance(candidate).signals.some(
          ({ points }) => points < 0,
        ),
        false,
      );
    }
  });

  it("uses only modest, behavior-specific routine tie-breakers", () => {
    const routineMatch = scoreHistoricalEventSignificance(
      event({
        pageTitle: "League match",
        text: "A team wins a regular season league match.",
      }),
    );
    const routineFlyby = scoreHistoricalEventSignificance(
      event({
        pageTitle: "Near-Earth object",
        text: "An asteroid makes its closest approach to Earth.",
      }),
    );

    assert.ok(
      routineMatch.signals.some(
        ({ signal, points }) =>
          signal === "routine result or transaction" && points === -8,
      ),
    );
    assert.ok(
      routineFlyby.signals.some(
        ({ signal, points }) =>
          signal === "routine astronomical occurrence" && points === -8,
      ),
    );
  });

  it("does not mistake military launches or place names for positive signals", () => {
    const airStrike = scoreHistoricalEventSignificance(
      event({
        pageTitle: "1986 bombing",
        text: "Forces launch air strikes during the bombing campaign.",
      }),
    );
    const airport = scoreHistoricalEventSignificance(
      event({
        pageTitle: "Boeing 747",
        text: "The airliner begins service from John F. Kennedy Airport.",
      }),
    );

    assert.equal(
      airStrike.signals.some(
        ({ signal }) => signal === "constructive or world-shaping milestone",
      ),
      false,
    );
    assert.equal(
      airport.signals.some(
        ({ signal }) => signal === "globally significant public figure",
      ),
      false,
    );
  });
});
