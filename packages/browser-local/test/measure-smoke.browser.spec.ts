/**
 * The measurement harnesses' smoke rows in the ordinary Chromium proof: one repetition of the
 * smallest cell (100 documents, no simulated latency) in each mode of the main measurement, one
 * round of the listing measurement at the same size, and the assertion that each report carries
 * every summary metric as a finite number where it applies. The full runs
 * (`measure.browser.spec.ts`, `measure-listing.browser.spec.ts`) are not part of `test:browser`;
 * these rows keep their code from rotting without paying for the full plans in CI.
 */

import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { LISTING_SCHEMA, runListingMeasurement, type ListingReport } from "./fixtures/measure-listing.ts";
import { ALWAYS_FINITE_KEYS, BROWSER_LOCAL_ONLY_KEYS, CONDITIONS, MEASURE_SCHEMA, OPTIONAL_KEYS, picksFor, runMeasurement, writeReport, type MeasurementReport } from "./fixtures/measure.ts";

test("the measurement harness reports every metric for the smallest cell in both modes", async ({ browser }) => {
  test.setTimeout(180_000);
  const report = await runMeasurement(browser, { sizes: [100], latencies: [0], repetitions: [1], modes: ["request-driven", "browser-local"] });
  const written = writeReport(report, test.info().outputPath("measure-smoke.json"));
  const parsed = JSON.parse(readFileSync(written, "utf8")) as MeasurementReport;

  expect(parsed.schema).toBe(MEASURE_SCHEMA);
  expect(parsed.environment.conditions).toBe(CONDITIONS);
  expect(parsed.environment.chromium).toBe(browser.version());
  expect(parsed.environment.os.cores).toBeGreaterThan(0);
  expect(typeof parsed.environment.gitDirty).toBe("boolean");
  expect(parsed.cells.map((cell) => cell.mode)).toEqual(["request-driven", "browser-local"]);
  // 50 distinct ids at 100 documents: the read draw is without replacement once the bundle is large enough.
  expect(new Set(picksFor(100).readIds).size).toBe(50);
  for (const cell of parsed.cells) {
    // The measurement page is cross-origin isolated, so performance.now() resolves to 5 us, not 100 us.
    expect(cell.crossOriginIsolated, `${cell.mode}: crossOriginIsolated`).toBe(true);
    expect(cell.repetitions).toHaveLength(1);
    const [rep] = cell.repetitions;
    expect(rep!.page.crossOriginIsolated).toBe(true);
    expect(rep!.coldOpen.documents).toBeGreaterThanOrEqual(100);
    expect(rep!.warmRead.samplesMs).toHaveLength(50);
    expect(rep!.warmQuery.byType.samplesMs).toHaveLength(10);
    expect(rep!.warmQuery.byTag.samplesMs).toHaveLength(10);
    expect(rep!.localCommit.samplesMs).toHaveLength(20);
    for (const key of ALWAYS_FINITE_KEYS) {
      expect(typeof cell.summary[key], `${cell.mode}: ${key}`).toBe("number");
      expect(Number.isFinite(cell.summary[key]), `${cell.mode}: ${key} is finite`).toBe(true);
    }
    for (const key of BROWSER_LOCAL_ONLY_KEYS) {
      if (cell.mode === "browser-local") expect(Number.isFinite(cell.summary[key] as number), `${cell.mode}: ${key} is finite`).toBe(true);
      else expect(cell.summary[key], `${cell.mode}: ${key} is not applicable`).toBeNull();
    }
    for (const key of OPTIONAL_KEYS) {
      const value = cell.summary[key];
      expect(value === null || Number.isFinite(value), `${cell.mode}: ${key} is finite or null`).toBe(true);
    }
    if (cell.mode === "browser-local") {
      expect(rep!.reconciliation.applicable).toBe(true);
      expect(rep!.footprint.applicable).toBe(true);
      if (rep!.footprint.applicable) {
        expect(rep!.footprint.samples.map((sample) => sample.at)).toEqual(["afterBootstrap", "afterMount", "end"]);
        expect(cell.summary.footprintMaxBytes!).toBeGreaterThanOrEqual(cell.summary.footprintMinBytes!);
      }
      expect(rep!.coldOpen.requests).toBeGreaterThan(0);
      expect(rep!.presentationMount.requests).toBe(0);
      expect(rep!.warmRead.requests).toBe(0);
      expect(rep!.localCommit.requests).toBe(0);
      expect(rep!.responsiveness.badge).toBe("pending");
    } else {
      expect(rep!.reconciliation.applicable).toBe(false);
      // Exactly what coldOpenMs times at 103 rows: capabilities, three list pages of 50, and 20 reads.
      expect(rep!.coldOpen.requests).toBe(24);
      // The mount's own list query and selection read are counted apart from the cold open.
      expect(rep!.presentationMount.requests).toBeGreaterThan(0);
      expect(rep!.warmRead.requests).toBe(50);
      expect(rep!.responsiveness.badge).toBe("shared");
    }
  }
});

test("the listing measurement reports the listing, one filtered query and the status for the smallest cell", async ({ browser }) => {
  test.setTimeout(180_000);
  const report = await runListingMeasurement(browser, { size: 100, rounds: 1, repetitions: 1 });
  const written = writeReport(report, test.info().outputPath("measure-listing-smoke.json"));
  const parsed = JSON.parse(readFileSync(written, "utf8")) as ListingReport;

  expect(parsed.schema).toBe(LISTING_SCHEMA);
  expect(parsed.environment.chromium).toBe(browser.version());
  expect(parsed.repetitions).toHaveLength(1);
  const [rep] = parsed.repetitions;
  expect(rep!.page.crossOriginIsolated).toBe(true);
  expect(rep!.coldOpen.documents).toBeGreaterThanOrEqual(100);
  expect(rep!.bodyBytes).toBeGreaterThan(0);
  for (const key of ["listing", "byType", "status"] as const) {
    expect(rep![key].samples, key).toHaveLength(1);
    expect(Number.isFinite(parsed.summary[key].medianMs), `${key}: medianMs is finite`).toBe(true);
    expect(Number.isFinite(parsed.summary[key].transactions), `${key}: transactions are counted over the working copy`).toBe(true);
  }
  // 100 documents plus the three conventions; a third of the documents carry the first kind; nothing is unconfirmed.
  expect(parsed.summary.listing.rows).toBe(103);
  expect(parsed.summary.byType.rows).toBe(34);
  expect(parsed.summary.status.rows).toBe(0);
  // The held rounds ran; their peak is a number only where gc() is exposed, which the proof config does not do.
  for (const key of ["listing", "status"] as const) {
    expect(rep!.held[key].sample.rows, `${key}: held round`).toBe(parsed.summary[key].rows);
    expect(rep!.held[key].heldPeakBytes === null || Number.isFinite(rep!.held[key].heldPeakBytes), `${key}: held peak is finite or null`).toBe(true);
  }
});
