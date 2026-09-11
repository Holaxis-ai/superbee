import { defineConfig, devices } from "@playwright/test";

/** The measurement run only: `npm run measure:browser`. The proof config ignores this spec. */
export default defineConfig({
  testDir: "./test",
  testMatch: "**/measure.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
