/**
 * Playwright E2E config for the `ui` command. The SECURITY-relevant specs (pages + security) now
 * run IN the merge gate via `e2e:gate` (tasks/ui-pages-spike B4), not only `npm run e2e`. The
 * View delivery spec runs there on both Chromium and WebKit.
 *
 * Every spec drives the REAL BUILT CLI (`packages/superbee/dist/superbee.mjs ui ...`), not a
 * dev server — `webServer` isn't used here because each spec needs its OWN process per mode
 * (`--dir` over a fresh temp bundle, `--remote` proxying a fresh local `serve` instance) with a
 * dynamically OS-assigned port; see `e2e/harness.ts`.
 *
 * `retries: 2` — the specs are deterministic, so a security assertion that genuinely fails, fails
 * on EVERY attempt (a retry can never mask it). Retries only absorb browser-launch/first-render
 * cold-start stalls when the gate runs at the tail of a heavy `npm run check` on a loaded machine
 * (observed once: the first test's render exceeded the 30s timeout while the child booted fine).
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // View delivery depends on how each engine applies an inherited policy to a blob frame, so
    // its spec also runs on WebKit. The rest of the suite stays Chromium-only to bound CI cost.
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: /view-delivery\.spec\.ts$/ },
  ],
});
