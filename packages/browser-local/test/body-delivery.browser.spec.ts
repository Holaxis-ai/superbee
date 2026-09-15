import { test, expect } from "@playwright/test";
import { call, ok, startDriverServer } from "./fixtures/harness.ts";
import { serveBodyFixture } from "./fixtures/body-remote.ts";

test("normal Sync reclaims a page-terminated in-flight delivery under the existing role", async ({ context }) => {
  const driver = await startDriverServer(), authority = await serveBodyFixture();
  const url = `${driver.origin}/?bodyFixture=${encodeURIComponent(authority.origin)}&bodyStore=body-crash`;
  let release: (() => void) | undefined;
  try {
    let page = await context.newPage();
    await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("Original body\n");
    await page.locator("textarea").fill("Recover a terminated page");
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    await expect(page.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "pending");
    authority.body.knobs.delay = () => new Promise<void>(resolve => { release = resolve; });
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => authority.body.counts.submitted).toBe(1);
    await expect.poll(() => release !== undefined).toBe(true);
    const prepared = structuredClone([...authority.body.records.values()][0]!.prepared);
    await page.close();
    release!(); release = undefined;
    await expect.poll(() => authority.body.counts.applied).toBe(1);
    page = await context.newPage(); await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    // Read-only evidence through the existing driver: no fabricated journal state.
    expect(ok(await call(page, "syncStatus"), "reopened status").counts.in_flight).toBe(1);
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "shared");
    expect(authority.body.counts.submitted).toBe(1);
    expect(authority.body.counts.applied).toBe(1);
    expect(authority.body.counts.lookedUp).toBeGreaterThan(0);
    expect([...authority.body.records.values()][0]!.prepared).toEqual(prepared);
  } finally { release?.(); await authority.close(); await driver.close(); }
});

test("body presentation persists offline edits and recovers a lost response across page closure", async ({ context }) => {
  const driver = await startDriverServer(), authority = await serveBodyFixture();
  const url = `${driver.origin}/?bodyFixture=${encodeURIComponent(authority.origin)}&bodyStore=body-browser`;
  try {
    let page = await context.newPage();
    await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("Original body\n");
    await page.getByRole("button", { name: "Disconnect authority", exact: true }).click();
    await expect(page.locator('[data-role="delivery-counts"]')).toContainText("offline=true");
    await page.locator("textarea").fill("Offline body from the presentation");
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    await expect(page.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "pending");
    await page.close();
    page = await context.newPage(); await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("Offline body from the presentation\n");
    await page.getByRole("button", { name: "Reconnect authority", exact: true }).click();
    await expect(page.locator('[data-role="delivery-counts"]')).toContainText("offline=false");
    await page.getByRole("button", { name: "Drop next response", exact: true }).click();
    await expect(page.locator('[data-role="delivery-counts"]')).toContainText("unresolvedResponse=true");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => authority.body.counts.applied).toBe(1);
    await expect(page.locator('[data-role="status"]')).toContainText("pending=1");
    await page.close();
    page = await context.newPage(); await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect authority", exact: true }).click();
    await expect(page.locator('[data-role="delivery-counts"]')).toContainText("unresolvedResponse=false");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "shared");
    expect(authority.body.counts.submitted).toBe(1);
    expect(authority.body.counts.applied).toBe(1);
    expect(authority.body.counts.lookedUp).toBeGreaterThan(0);
    const second = await context.newPage();
    await second.goto(`${driver.origin}/?bodyFixture=${encodeURIComponent(authority.origin)}&bodyStore=second-client`);
    await expect(second.locator("body")).toHaveAttribute("data-body-ready", "true");
    await second.getByRole("button", { name: "notes/example", exact: true }).click();
    await expect(second.locator('pre[data-role="body"]')).toContainText("Offline body from the presentation");
    await expect(second.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "shared");
  } finally { await authority.close(); await driver.close(); }
});

test("an armed real IndexedDB settlement abort retains lookup recovery across reopen", async ({ context }) => {
  const driver = await startDriverServer(), authority = await serveBodyFixture();
  const url = `${driver.origin}/?bodyFixture=${encodeURIComponent(authority.origin)}&bodyStore=body-abort`;
  let release: (() => void) | undefined;
  try {
    let page = await context.newPage(); await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("Original body\n");
    await page.locator("textarea").fill("Recover aborted settlement");
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    await expect(page.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "pending");
    authority.body.knobs.delay = () => new Promise<void>(resolve => { release = resolve; });
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => release !== undefined).toBe(true);
    // Existing fault wrapper throws on the next actual transaction put, not by seeding state.
    await call(page, "armQuota");
    release!(); release = undefined;
    await expect(page.locator('[data-role="status"]')).toContainText("lastSync=failed");
    expect(ok(await call(page, "syncStatus"), "aborted status").counts.in_flight).toBe(1);
    await page.close();
    page = await context.newPage(); await page.goto(url);
    await expect(page.locator("body")).toHaveAttribute("data-body-ready", "true");
    await page.getByRole("button", { name: "notes/example", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("Recover aborted settlement\n");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator('article[data-role="document"]')).toHaveAttribute("data-provenance", "shared");
    expect(authority.body.counts.submitted).toBe(1);
    expect(authority.body.counts.applied).toBe(1);
    expect(authority.body.counts.lookedUp).toBeGreaterThan(0);
  } finally { release?.(); await authority.close(); await driver.close(); }
});
