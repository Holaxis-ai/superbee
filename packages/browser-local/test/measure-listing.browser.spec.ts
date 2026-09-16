/**
 * The listing measurement: what the unfiltered listing, one filtered query and the status cost
 * at the working-copy bound with documents of realistic size, in wall time, IndexedDB
 * transactions and heap held. Runs only under `npm run measure:listing` (the measurement
 * Playwright config); `test:browser` ignores it and runs the smallest cell through the smoke
 * spec instead. The report goes to `SUPERBEE_MEASURE_LISTING_OUT` or
 * `packages/browser-local/measurements/listing.json`.
 */

import { test } from "@playwright/test";

import { listingOutPathFromEnv, listingPlanFromEnv, runListingMeasurement } from "./fixtures/measure-listing.ts";
import { writeReport } from "./fixtures/measure.ts";

test("measure the listing and the status count at the working-copy bound with large documents", async ({ browser }) => {
  test.setTimeout(0);
  const plan = listingPlanFromEnv();
  console.log(`[measure-listing] plan: size=${plan.size} bodyBytes=${plan.bodyRange ? `${plan.bodyRange.minBytes}..${plan.bodyRange.maxBytes}` : "mixed"} rounds=${plan.rounds} repetitions=${plan.repetitions}`);
  const report = await runListingMeasurement(browser, plan, { log: (line) => console.log(line) });
  const written = writeReport(report, listingOutPathFromEnv());
  console.log(`[measure-listing] wrote ${written}`);
});
