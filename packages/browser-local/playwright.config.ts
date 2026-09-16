import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.browser.spec.ts",
  // The measurement plans run only through playwright.measure.config.ts (`measure:browser`, `measure:listing`).
  testIgnore: ["**/measure.browser.spec.ts", "**/measure-listing.browser.spec.ts"],
  fullyParallel: false,
  workers: 1,
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
