/**
 * The platform contract in real Chromium: one plain presentation (test/fixtures/presentation.ts)
 * mounted over a runtime of each execution mode, both built in the page over the same served
 * synthetic bundle. The presentation programs against `@superbee/core/platform` only; the page
 * driver (test/fixtures/driver.ts) constructs the runtime and hands it over.
 *
 * Per mode the spec asserts the list and its provenance badges, commits an edit and follows the
 * badge sequence the contract prescribes (request-driven: shared at once; browser-local:
 * pending, then shared after sync), takes the authority offline and asserts the badge and the
 * status line differ per mode exactly as the kit's commit rows say, and then runs the kit's
 * model rows (read, query, validate, errors) through the page's runtime with the kit's own
 * expectations and cross-mode parity check, so the page proves the same rows the Node proof does.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import type { ExecutionMode, PlatformCapabilities, PlatformRuntime } from "@superbee/core/platform";

import type { DriverError } from "./fixtures/driver.ts";
import { call, isDriverError, load as loadAt, ok, startDriverServer, type DriverServer } from "./fixtures/harness.ts";
import { createRemoteFixture, type RemoteFixture } from "./fixtures/remote-fixture.ts";
import { serveRemoteFixture, type ServedFixture } from "./fixtures/remote-http.ts";
import {
  MODES,
  platformContractRows,
  runRow,
  seedSyntheticBundle,
  SYNTHETIC_IDS,
  type AuthorityHandle,
  type ContractHarness,
  type ContractSession,
  type WriteKnob,
} from "./platform-contract.ts";

const ALPHA_V1 = "alpha v1, see [beta](../notes/beta.md).\n";
const BETA_V1 = "beta v1\n";

let driver: DriverServer;

test.beforeAll(async () => {
  driver = await startDriverServer();
});

test.afterAll(async () => {
  await driver.close();
});

async function syntheticFixture(): Promise<RemoteFixture> {
  const fixture = await createRemoteFixture();
  await seedSyntheticBundle(fixture.authority);
  return fixture;
}

function authorityOf(fixture: RemoteFixture): AuthorityHandle {
  return {
    read: async (id) => {
      const { doc, version } = await fixture.authority.read(id);
      return { version, body: doc.body };
    },
    write: async (id, body) => {
      const { doc, version } = await fixture.authority.read(id);
      return fixture.authority.write(id, { ...doc, body }, { expectedVersion: version });
    },
    delete: async (id) => {
      await fixture.authority.delete(id);
    },
  };
}

/** Rebuild the page's typed rejection in Node so the kit's rows see the same name, code, and status. */
function rehydrate(error: DriverError["error"]): Error {
  const err = new Error(error.message) as Error & { code?: string; status?: number };
  err.name = error.name;
  if (error.code !== undefined) err.code = error.code;
  if (error.status !== undefined) err.status = error.status;
  return err;
}

/** A {@link PlatformRuntime} whose every verb is one driver call on the page's mounted runtime. */
function pageRuntime(page: Page, capabilities: PlatformCapabilities): PlatformRuntime {
  const invoke = async <T>(verb: "read" | "query" | "validate" | "commit" | "syncStatus" | "sync", id?: string, edit?: unknown): Promise<T> => {
    const reply = await call(page, "platformCall", verb, id, edit as never);
    if (isDriverError(reply)) throw rehydrate(reply.error);
    return reply as T;
  };
  return {
    capabilities: () => ({ ...capabilities }),
    read: (id) => invoke("read", id),
    query: (filter) => invoke("query", undefined, filter ?? {}),
    validate: (id) => invoke("validate", id),
    commit: (id, edit) => invoke("commit", id, edit),
    syncStatus: () => invoke("syncStatus"),
    sync: () => invoke("sync"),
  };
}

/** Cut the page off from the authority: the carrier refuses in-page, and the route aborts anything that slips past. */
async function goOffline(page: Page, origin: string): Promise<void> {
  await page.route(`${origin}/**`, (route) => route.abort("internetdisconnected"));
  ok(await call(page, "setOffline", true), "setOffline");
}

async function goOnline(page: Page, origin: string): Promise<void> {
  ok(await call(page, "setOffline", false), "setOffline");
  await page.unroute(`${origin}/**`);
}

let sessions = 0;

/** One kit session over a page: a fresh context (fresh IndexedDB), a fresh served authority, one mounted runtime. */
async function openPageSession(browser: Browser, mode: ExecutionMode): Promise<ContractSession> {
  const served: ServedFixture = await serveRemoteFixture(await syntheticFixture());
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  await loadAt(page, driver.origin);
  sessions += 1;
  const name = `${mode}-kit-${sessions}`;
  const mounted = ok(await call(page, "platformMount", mode, served.origin, name), "platformMount");
  const runtime = pageRuntime(page, mounted.capabilities);
  return {
    mode,
    runtime,
    authority: authorityOf(served.fixture),
    secondClient: async () => {
      const other = await context.newPage();
      await loadAt(other, driver.origin);
      const second = ok(await call(other, "platformMount", mode, served.origin, `${name}-second`), "platformMount second");
      return pageRuntime(other, second.capabilities);
    },
    setOffline: (flag) => (flag ? goOffline(page, served.origin) : goOnline(page, served.origin)),
    setKnob: async (knob: WriteKnob, flag) => {
      served.fixture.knobs[knob] = flag;
    },
    unsettled: async (id) => ok(await call(page, "platformUnsettled", id), "platformUnsettled"),
    restore: async () => {
      await goOnline(page, served.origin);
      served.fixture.knobs.unauthorized = false;
      served.fixture.knobs.dropAfterApply = false;
      served.fixture.knobs.failBeforeApply = false;
    },
    close: async () => {
      await context.close();
      await served.close();
    },
  };
}

// ── the presentation, per mode ─────────────────────────────────────────────────────────────

for (const mode of MODES) {
  test(`${mode}: the presentation lists the bundle with provenance badges, commits with the mode's badge sequence, and reports offline commits as the contract says`, async ({ page }) => {
    const served = await serveRemoteFixture(await syntheticFixture());
    const authority = authorityOf(served.fixture);
    try {
      await loadAt(page, driver.origin);
      const mounted = ok(await call(page, "platformMount", mode, served.origin, `${mode}-page`), "platformMount");
      const offlineCommits = mode === "browser-local";
      expect(mounted.capabilities).toEqual({ mode, offlineCommits, localPersistence: offlineCommits });

      const root = page.locator('[data-role="presentation"]');
      await expect(root).toHaveAttribute("data-offline-commits", String(offlineCommits));
      await expect(root).toHaveAttribute("data-local-persistence", String(offlineCommits));
      const items = root.locator('[data-role="list"] li');
      await expect(items).toHaveCount(SYNTHETIC_IDS.length);
      expect(await items.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.id))).toEqual([...SYNTHETIC_IDS]);
      await expect(root.locator('[data-role="list"] [data-role="badge"]')).toHaveText(SYNTHETIC_IDS.map(() => "shared"));
      const status = root.locator('[data-role="status"]');
      await expect(status).toContainText(`mode=${mode}`);
      await expect(status).toContainText("pending=0");
      await expect(status).toContainText("complete=true");

      // Select, edit, commit online: the badge sequence is the mode's explicit result difference.
      const document = root.locator('[data-role="document"]');
      const documentBadge = document.locator('[data-role="badge"]');
      const alphaItem = root.locator('li[data-id="notes/alpha"]');
      await alphaItem.locator('[data-role="pick"]').click();
      await expect(document).toHaveAttribute("data-id", "notes/alpha");
      await expect(document.locator('[data-role="body"]')).toHaveText(ALPHA_V1);
      await expect(documentBadge).toHaveText("shared");
      await root.locator('[data-role="editor"]').fill("alpha v2 (page)\n");
      await root.locator('[data-role="commit"]').click();
      if (mode === "request-driven") {
        await expect(document.locator('[data-role="body"]')).toHaveText("alpha v2 (page)\n");
        await expect(documentBadge).toHaveText("shared");
        await expect(alphaItem).toHaveAttribute("data-provenance", "shared");
        await expect(status).toContainText("pending=0");
        expect((await authority.read("notes/alpha")).body).toBe("alpha v2 (page)\n");
      } else {
        await expect(documentBadge).toHaveText("pending");
        await expect(document.locator('[data-role="body"]')).toHaveText("alpha v2 (page)\n");
        await expect(alphaItem).toHaveAttribute("data-provenance", "pending");
        await expect(status).toContainText("pending=1");
        expect((await authority.read("notes/alpha")).body).toBe(ALPHA_V1);
        await root.locator('[data-role="sync"]').click();
        await expect(documentBadge).toHaveText("shared");
        await expect(alphaItem).toHaveAttribute("data-provenance", "shared");
        await expect(status).toContainText("pending=0");
        await expect(status).toContainText("online=true");
        expect((await authority.read("notes/alpha")).body).toBe("alpha v2 (page)\n");
      }
      await expect(root.locator('[data-role="error"]')).toHaveText("");

      // Offline: the same commit, and the two modes report it differently, exactly as the kit's rows say.
      const betaItem = root.locator('li[data-id="notes/beta"]');
      await betaItem.locator('[data-role="pick"]').click();
      await expect(document).toHaveAttribute("data-id", "notes/beta");
      await goOffline(page, served.origin);
      await root.locator('[data-role="editor"]').fill("beta v2 (offline page)\n");
      await root.locator('[data-role="commit"]').click();
      if (mode === "request-driven") {
        await expect(root.locator('[data-role="error"]')).toContainText("TypeError");
        await expect(documentBadge).toHaveText("shared");
        await expect(document.locator('[data-role="body"]')).toHaveText(BETA_V1);
        await expect(betaItem).toHaveAttribute("data-provenance", "shared");
        await expect(status).toContainText("online=false");
        await expect(status).toContainText("pending=0");
        expect((await authority.read("notes/beta")).body).toBe(BETA_V1);
        await goOnline(page, served.origin);
        ok(await call(page, "platformRefresh"), "platformRefresh");
        await expect(status).toContainText("online=true");
        await expect(root.locator('[data-role="error"]')).toHaveText("");
      } else {
        await expect(documentBadge).toHaveText("pending");
        await expect(document.locator('[data-role="body"]')).toHaveText("beta v2 (offline page)\n");
        await expect(betaItem).toHaveAttribute("data-provenance", "pending");
        await expect(status).toContainText("pending=1");
        await expect(root.locator('[data-role="error"]')).toHaveText("");
        expect((await authority.read("notes/beta")).body).toBe(BETA_V1);
        await root.locator('[data-role="sync"]').click();
        await expect(status).toContainText("online=false");
        await expect(status).toContainText("pending=1");
        await expect(documentBadge).toHaveText("pending");
        expect((await authority.read("notes/beta")).body).toBe(BETA_V1);
        await goOnline(page, served.origin);
        await root.locator('[data-role="sync"]').click();
        await expect(documentBadge).toHaveText("shared");
        await expect(betaItem).toHaveAttribute("data-provenance", "shared");
        await expect(status).toContainText("pending=0");
        await expect(status).toContainText("online=true");
        expect((await authority.read("notes/beta")).body).toBe("beta v2 (offline page)\n");
      }
    } finally {
      await served.close();
    }
  });
}

// ── the kit's model rows through the page's runtime ────────────────────────────────────────

const modelRows = platformContractRows().filter((row) => row.scope === "model");

test(`the kit contributes ${modelRows.length} model rows to the page proof`, () => {
  expect(modelRows.length).toBeGreaterThanOrEqual(5);
});

for (const row of modelRows) {
  test(`page runtime, both modes: ${row.verb}: ${row.name}`, async ({ browser }) => {
    const harness: ContractHarness = { open: (mode) => openPageSession(browser, mode) };
    await runRow(harness, row);
  });
}
