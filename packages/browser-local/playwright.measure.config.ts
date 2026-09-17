import { defineConfig, devices } from "@playwright/test";

/**
 * The measurement runs only: `npm run measure:browser` (the full plan) and `npm run
 * measure:listing` (the listing and status count at one large size). The proof config ignores
 * both specs. Chromium is launched with precise, unquantized `performance.memory` readings and
 * `gc()` exposed, so the listing measurement can sample the heap from a collected baseline.
 */
export default defineConfig({
  testDir: "./test",
  testMatch: ["**/measure.browser.spec.ts", "**/measure-listing.browser.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    launchOptions: { args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
