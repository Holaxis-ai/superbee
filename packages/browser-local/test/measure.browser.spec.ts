/**
 * The measurement run for acceptance item 6 of `designs/local-first-hosts-and-working-state`:
 * cold open, warm read and query, local commit, reconciliation, storage footprint, and
 * presentation responsiveness on IndexedDB against the request-driven baseline, at the plan's
 * bundle sizes and simulated latencies, in a fresh Chromium context per cell. Runs only under
 * `npm run measure:browser` (its own Playwright config); `test:browser` ignores it. The report
 * goes to `SUPERBEE_MEASURE_OUT` or `packages/browser-local/measurements/latest.json`.
 */

import { test } from "@playwright/test";

import { outPathFromEnv, planFromEnv, runMeasurement, writeReport } from "./fixtures/measure.ts";

test("measure the browser-local prototype on IndexedDB against the request-driven baseline", async ({ browser }) => {
  test.setTimeout(0);
  const plan = planFromEnv();
  console.log(`[measure] plan: sizes=${plan.sizes.join(",")} latencies=${plan.latencies.join(",")} repetitions=${plan.repetitions.join(",")} modes=${plan.modes.join(",")}`);
  const report = await runMeasurement(browser, plan, { log: (line) => console.log(line) });
  const written = writeReport(report, outPathFromEnv());
  console.log(`[measure] wrote ${written}`);
});
