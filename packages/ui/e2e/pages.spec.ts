/**
 * Pages-spike browser E2E (tasks/ui-pages-spike): the FULL experience the HTTP-level tests can't
 * prove — the launcher listing, the sandboxed opaque-origin iframe, the postMessage bridge
 * round-trip delivering data INTO the page, the structural network lock (a page's own fetch is
 * CSP-blocked), and a live update moving a card without a reload. Drives the REAL built CLI over a
 * fresh bundle seeded with the actual `examples/views` seed views (`harness.ts`) — Pulse/Roadmap
 * canonical `type: View`, About deliberately at the LEGACY LOCATIONS with the current name
 * (location-survival pinned end-to-end), plus one RETIRED `type: Page` doc the launcher must
 * never list (the removal pin, tasks/remove-legacy-page-bridge-support).
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { writeBlob, writeDoc } from "@superbee/core";
import { approveViewIfPrompted, bootUiOverPagesBundle, bootUiServerInProcess, openRegisteredView, seedPagesBundle, CLI_DIST } from "./harness.js";
import { VIEW_LOAD_DEADLINE_MS } from "../src/views/viewReadiness.js";

const VIEW_LOAD_FAILURE_ASSERTION_TIMEOUT_MS = VIEW_LOAD_DEADLINE_MS + 4_000;
const VIEW_LOAD_SURVIVAL_WAIT_MS = VIEW_LOAD_DEADLINE_MS + 500;

const TASKS = [
  { id: "tasks/alpha", frontmatter: { type: "Task", title: "Alpha task", status: "todo" }, body: "" },
  { id: "tasks/beta", frontmatter: { type: "Task", title: "Beta task", status: "blocked" }, body: "" },
];

test("REMOVAL PIN: the launcher lists View docs from BOTH folder generations, and a retired legacy Page doc never appears — with the loud diagnostic asserted", async ({ page }) => {
  const ui = await bootUiOverPagesBundle([]);
  try {
    await page.goto(ui.url); // token -> cookie + SPA boot
    await expect(page.locator('[data-page-id="views-registry/pulse"]')).toBeVisible();
    await expect(page.locator('[data-page-id="views-registry/roadmap"]')).toBeVisible();
    // Legacy LOCATIONS survive: the View-typed About doc under pages-registry//pages/ lists.
    await expect(page.locator('[data-page-id="pages-registry/about"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pulse — activity feed" })).toBeVisible();
    // The retired legacy NAME does not: the seeded type: Page doc (real entry bytes and all)
    // never reaches the launcher grid (tasks/remove-legacy-page-bridge-support). It remains an
    // ordinary DOC — visible in the activity feed like any content — so the never-appears check
    // is scoped to the Views grid, not the whole page.
    await expect(page.locator('[data-page-id="pages-registry/retired"]')).toHaveCount(0);
    await expect(page.locator(".launcher-grid").getByText("Retired legacy page")).toHaveCount(0);

    // Removal must not equal silence: the designated loud surface names the doc and the remedy.
    // (This fixture bundle SHOWS views, so the launcher's empty-state pointer never renders —
    // status's legacy_naming FINDING is the diagnostic for this shape.)
    const status = JSON.parse(
      execFileSync(process.execPath, [CLI_DIST, "status", "--dir", ui.dir, "--json"], { encoding: "utf8" }),
    ) as { legacy_naming?: { note?: string; help?: string; page_typed_docs?: number; page_typed_rows?: { rows: Array<{ id: string }> } } };
    expect(status.legacy_naming?.page_typed_docs).toBe(1);
    expect(status.legacy_naming?.page_typed_rows?.rows).toEqual([{ id: "pages-registry/retired" }]);
    expect(status.legacy_naming?.note).toContain("FINDING");
    expect(status.legacy_naming?.help).toContain("migrate-legacy-view-names");
  } finally {
    await ui.cleanup();
  }
});

test("a directly opened data Page completes its startup bridge queries before iframe load", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/roadmap");

    const iframe = page.locator("iframe.page-frame-iframe");
    await expect(iframe).toBeVisible();
    // Opaque origin: allow-scripts and NOTHING else (no allow-same-origin).
    expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");

    // These requests are posted by Roadmap's inline startup script, before the parent sees the
    // iframe load event. The bridge round-tripped BOTH the Roadmap Item query and `edges` request:
    // item renders, and its rollup counts the two seeded (non-terminal) tasks it `contains`.
    const frame = page.frameLocator("iframe.page-frame-iframe");
    await expect(frame.locator(".item .title", { hasText: "Spike work" })).toBeVisible();
    await expect(frame.locator(".roll .count")).toHaveText("0/2 done");
  } finally {
    await ui.cleanup();
  }
});

test("a browser-blocked View request becomes an actionable shell error instead of a blank frame", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.route("**/__page/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/__page/mint") await route.continue();
      else await route.abort("blockedbyclient");
    });
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/roadmap");

    const failure = page.locator(".view-status-error");
    await expect(failure).toContainText("could not confirm that this View finished loading", {
      timeout: VIEW_LOAD_FAILURE_ASSERTION_TIMEOUT_MS,
    });
    await expect(failure).toContainText("local HTML request may have been blocked");
    await expect(failure).toContainText("launch may have changed or expired");
    await expect(failure).toContainText("content-blocking or privacy settings");
    await expect(page.locator("iframe.page-frame-iframe")).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("a browser-blocked access:none View request also becomes an actionable shell error", async ({ page }) => {
  const ui = await bootUiOverPagesBundle([]);
  try {
    await page.route("**/__page/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/__page/mint") await route.continue();
      else await route.abort("blockedbyclient");
    });
    await page.goto(ui.url);
    await openRegisteredView(page, "pages-registry/about");

    const failure = page.locator(".view-status-error");
    await expect(failure).toContainText("could not confirm that this View finished loading", {
      timeout: VIEW_LOAD_FAILURE_ASSERTION_TIMEOUT_MS,
    });
    await expect(failure).toContainText("local HTML request may have been blocked");
    await expect(failure).toContainText("launch may have changed or expired");
    await expect(page.locator("iframe.page-frame-iframe")).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("a static access:none View with script-src none remains rendered after the readiness deadline", async ({ page }) => {
  const ui = await bootUiOverPagesBundle([]);
  try {
    const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><h1>CSP-static View</h1>`;
    await writeBlob({ root: ui.dir }, "pages/about.html", new TextEncoder().encode(html), "text/html; charset=utf-8");
    await page.goto(ui.url);
    await openRegisteredView(page, "pages-registry/about");

    const frame = page.frameLocator("iframe.page-frame-iframe");
    await expect(frame.getByRole("heading", { name: "CSP-static View" })).toBeVisible();
    await page.waitForTimeout(VIEW_LOAD_SURVIVAL_WAIT_MS);
    await expect(frame.getByRole("heading", { name: "CSP-static View" })).toBeVisible();
    await expect(page.locator(".view-status-error")).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("a quiet data-bearing View remains rendered after the readiness deadline", async ({ page }) => {
  const ui = await bootUiOverPagesBundle([]);
  try {
    const html = "<!doctype html><h1>Quiet data View</h1>";
    await writeDoc(
      { root: ui.dir },
      {
        id: "views-registry/quiet-data",
        frontmatter: {
          type: "View",
          title: "Quiet data View",
          entry: "views/quiet-data.html",
          access: "bundle-read",
        },
        body: "",
      },
    );
    await writeBlob(
      { root: ui.dir },
      "views/quiet-data.html",
      new TextEncoder().encode(html),
      "text/html; charset=utf-8",
    );
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/quiet-data");

    const frame = page.frameLocator("iframe.page-frame-iframe");
    await expect(frame.getByRole("heading", { name: "Quiet data View" })).toBeVisible();
    await page.waitForTimeout(VIEW_LOAD_SURVIVAL_WAIT_MS);
    await expect(frame.getByRole("heading", { name: "Quiet data View" })).toBeVisible();
    await expect(page.locator(".view-status-error")).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("an access:none View is denied every data-bearing v0 bridge request through the real frame broker", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "pages-registry/about");
    const about = page.frameLocator("iframe.page-frame-iframe");
    await expect(about.getByRole("heading", { name: "About this bundle" })).toBeVisible();

    const replies = await about.locator("body").evaluate(async () => {
      const requests = [
        { bridge: "v0", type: "hello", id: "denied-hello" },
        { bridge: "v0", type: "query", id: "denied-query", params: {} },
        { bridge: "v0", type: "read", id: "denied-read", docId: "tasks/alpha" },
        { bridge: "v0", type: "render-document", id: "denied-render", docId: "tasks/alpha" },
        { bridge: "v0", type: "edges", id: "denied-edges", params: {} },
        { bridge: "v0", type: "subscribe", id: "denied-subscribe" },
      ];
      return await new Promise<Array<{ id: string; code?: string; leaked?: boolean }>>((resolve, reject) => {
        const received = new Map<string, { id: string; code?: string; leaked?: boolean }>();
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error(`timed out waiting for denied bridge replies: ${[...received.keys()].join(",")}`));
        }, 5_000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window.parent || event.data?.bridge !== "v0") return;
          const id = typeof event.data?.id === "string" ? event.data.id : "";
          if (!id.startsWith("denied-")) return;
          received.set(id, {
            id,
            code: event.data?.error?.code,
            leaked: JSON.stringify(event.data).includes("Alpha task"),
          });
          if (received.size !== requests.length) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          resolve(requests.map((request) => received.get(request.id)!));
        };
        window.addEventListener("message", onMessage);
        for (const request of requests) window.parent.postMessage(request, "*");
      });
    });

    expect(replies).toEqual([
      { id: "denied-hello", code: "FORBIDDEN", leaked: false },
      { id: "denied-query", code: "FORBIDDEN", leaked: false },
      { id: "denied-read", code: "FORBIDDEN", leaked: false },
      { id: "denied-render", code: "FORBIDDEN", leaked: false },
      { id: "denied-edges", code: "FORBIDDEN", leaked: false },
      { id: "denied-subscribe", code: "FORBIDDEN", leaked: false },
    ]);
  } finally {
    await ui.cleanup();
  }
});

test("a bundle-propose View can change one governed scalar only after trusted-shell confirmation", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/trusted-action");
    const frame = page.frameLocator("iframe.page-frame-iframe");
    await expect(frame.locator("#status")).toHaveText("todo");

    // Simulate a hostile View timing the proposal so the user's next click lands on the shell's
    // predictable Apply target. Observe the trusted shell before proposing and click the button
    // in the same turn in which it is inserted; a real browser must leave the write untouched.
    await page.evaluate(() => {
      const state = window as Window & { __immediateApplyWasDisabled?: boolean };
      const observer = new MutationObserver(() => {
        const apply = Array.from(document.querySelectorAll<HTMLButtonElement>(".action-confirmation-buttons button"))
          .find((button) => button.textContent === "Apply change");
        if (!apply) return;
        state.__immediateApplyWasDisabled = apply.disabled;
        apply.click();
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await frame.getByRole("button", { name: "Mark Alpha done" }).click();
    const dialog = page.getByRole("dialog", { name: "Apply this bundle change?" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as Window & { __immediateApplyWasDisabled?: boolean }).__immediateApplyWasDisabled)).toBe(true);
    await expect(frame.locator("#status")).toHaveText("todo");
    await expect(dialog).toContainText("tasks/alpha");
    await expect(dialog).toContainText("todo");
    await expect(dialog).toContainText("done");
    await expect(dialog).toContainText("e2e/human");
    const apply = dialog.getByRole("button", { name: "Apply change" });
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(frame.locator("#result")).toHaveText("committed");
    await expect(frame.locator("#status")).toHaveText("done");
    const persisted = JSON.parse(execFileSync(process.execPath, [CLI_DIST, "doc", "read", "tasks/alpha", "--dir", ui.dir, "--json"], { encoding: "utf8" }));
    expect(persisted.superbee_progress_status).toBe("done");
    expect(persisted.superbee_updated_by).toBe("e2e/human");
  } finally {
    await ui.cleanup();
  }
});

test("About navigation opens Roadmap and its startup bridge queries under the target capability, with browser history", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "pages-registry/about");
    const about = page.frameLocator("iframe.page-frame-iframe");
    await expect(about.getByRole("heading", { name: "About this bundle" })).toBeVisible();

    // Malformed/nonexistent targets stay put; the shell never constructs a route from them.
    const before = page.url();
    await about.locator("body").evaluate(() => {
      (window as unknown as { openPage: (id: string) => void }).openPage("views-registry/missing");
    });
    await page.waitForTimeout(100);
    expect(page.url()).toBe(before);

    await about.getByRole("button", { name: "Open the Roadmap view" }).click();
    await approveViewIfPrompted(page);
    await expect(page).toHaveURL(/view=page&id=views-registry%2Froadmap/);
    const roadmap = page.frameLocator("iframe.page-frame-iframe");
    // Target capability is resolved independently: Roadmap receives bundle data although About
    // was access: none.
    await expect(roadmap.locator(".item .title", { hasText: "Spike work" })).toBeVisible();

    await page.goBack();
    await expect(page.frameLocator("iframe.page-frame-iframe").getByRole("heading", { name: "About this bundle" })).toBeVisible();
    await page.goForward();
    await expect(page.frameLocator("iframe.page-frame-iframe").locator(".item .title", { hasText: "Spike work" })).toBeVisible();
  } finally {
    await ui.cleanup();
  }
});

test("the sandboxed page is structurally blocked from reaching the data API (connect-src 'none')", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/roadmap");
    const handle = await page.waitForSelector("iframe.page-frame-iframe");
    const frame = await handle.contentFrame();
    if (!frame) throw new Error("iframe had no content frame");
    // From inside the page's own context, any network call is CSP-blocked -> fetch rejects.
    const outcome = await frame.evaluate(async () => {
      try {
        await fetch("/v0/bundles/default/docs?fields=frontmatter&type=Task");
        return "REACHED_API";
      } catch (e) {
        return "blocked:" + (e instanceof Error ? e.name : String(e));
      }
    });
    expect(outcome).toMatch(/^blocked:/);
  } finally {
    await ui.cleanup();
  }
});

test("the sandboxed page cannot navigate its frame (or the top) to an external origin (frame-src 'self' + sandbox)", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    // frame-src 'self' reports a CSP violation to the shell's console when the framed page tries to
    // navigate anywhere off-origin — capture it as the definitive proof the escape was BLOCKED (the
    // request never leaves; the frame lands on a chrome-error page, NOT example.com).
    const frameSrcViolations: string[] = [];
    page.on("console", (m) => {
      if (/frame-src/i.test(m.text())) frameSrcViolations.push(m.text());
    });

    await page.goto(ui.url);
    const topOriginBefore = new URL(page.url()).origin;
    await openRegisteredView(page, "views-registry/roadmap");
    const handle = await page.waitForSelector("iframe.page-frame-iframe");
    const frame = await handle.contentFrame();
    if (!frame) throw new Error("iframe had no content frame");
    await expect(page.frameLocator("iframe.page-frame-iframe").locator(".item").first()).toBeVisible();

    // From inside the page, attempt to escape to an external origin — self-nav (blocked by the
    // shell's frame-src 'self') and top-nav (blocked by the sandbox: no allow-top-navigation).
    await frame.evaluate(() => {
      try {
        (window.top as Window).location.href = "https://example.com/";
      } catch {
        /* top-nav blocked by sandbox */
      }
      try {
        window.location.href = "https://example.com/";
      } catch {
        /* self-nav blocked */
      }
    });
    await page.waitForTimeout(800);

    // The frame's off-origin navigation was blocked by frame-src 'self' (request never sent)...
    expect(frameSrcViolations.join("\n")).toMatch(/frame-src 'self'/);
    // ...the frame never reached example.com...
    const frameHandleNow = await page.$("iframe.page-frame-iframe");
    const frameNow = frameHandleNow ? await frameHandleNow.contentFrame() : null;
    expect(frameNow?.url() ?? "").not.toContain("example.com");
    // ...and the top page never left the ui origin (sandbox blocked top-nav).
    expect(new URL(page.url()).origin).toBe(topOriginBefore);
  } finally {
    await ui.cleanup();
  }
});

test("P1: an SSE outage self-heals — a change made while the stream was down appears after it returns (no permanent staleness)", async ({ page }) => {
  // The REAL outage this guards: the ui server restarts (the stable-port design invites exactly
  // this), the open tab's SSE stream dies, and a change lands while it is down — no frame will
  // ever replay it. The in-process boot seam lets the restarted server keep the same port AND
  // session secret, so the browser's cookie stays valid and recovery (reconnect -> resync ->
  // full reload/re-query) can be observed end-to-end.
  const dir = await seedPagesBundle(TASKS);
  const secret = "e2e-sse-resilience-fixed-secret";
  const first = await bootUiServerInProcess({ dir, sessionSecret: secret });
  let second: Awaited<ReturnType<typeof bootUiServerInProcess>> | undefined;
  try {
    await page.goto(`http://127.0.0.1:${first.port}/?token=${secret}`);
    await openRegisteredView(page, "views-registry/roadmap");
    const frame = page.frameLocator("iframe.page-frame-iframe");
    const spike = frame.locator(".item", { hasText: "Spike work" });
    // Neither seeded task is done/canceled yet.
    await expect(spike.locator(".roll .count")).toHaveText("0/2 done");

    // The server goes away mid-session: the stream drops FOR REAL (socket severed).
    await first.close();
    await page.waitForTimeout(500); // let the client notice the drop

    // The change happens DURING the outage — its SSE frame is lost for good.
    execFileSync(process.execPath, [CLI_DIST, "doc", "update", "tasks/alpha", "--progress_status", "done", "--dir", dir], {
      stdio: "ignore",
    });

    // Same bundle, same port, same secret: the stream reconnects and the resync must recover the
    // missed change even though its delta frame never arrived — the rollup counter moves.
    second = await bootUiServerInProcess({ dir, port: first.port, sessionSecret: secret });
    await expect(spike.locator(".roll .count")).toHaveText("1/2 done", {
      timeout: 20_000,
    });
  } finally {
    await first.close().catch(() => {}); // already closed on the happy path
    await second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1: a session-rotating restart surfaces 'Connection lost' instead of staying silently stale (adversarial-review fold-in)", async ({ page }) => {
  // Unlike the SSE-resilience test above (which pins the SAME
  // secret across the restart to prove reconnect recovery), THIS restart mints a genuinely
  // DIFFERENT secret — the real "stable port, rotated session" case. The open tab's cookie is
  // now dead everywhere; the interceptor's 403 handling (queryClient.ts / interceptor.ts) must
  // surface a clear recovery screen the moment ANY request the shell makes needs the session,
  // not a per-view "could not load" banner.
  const dir = await seedPagesBundle(TASKS);
  const first = await bootUiServerInProcess({ dir, sessionSecret: "restart-403-first-secret" });
  let second: Awaited<ReturnType<typeof bootUiServerInProcess>> | undefined;
  try {
    await page.goto(`http://127.0.0.1:${first.port}/?token=restart-403-first-secret`);
    await openRegisteredView(page, "views-registry/roadmap");
    await expect(page.locator("iframe.page-frame-iframe")).toBeVisible();

    // The server goes away and comes back on the SAME port with a DIFFERENT secret — the open
    // tab's cookie no longer authenticates anything.
    await first.close();
    second = await bootUiServerInProcess({ dir, port: first.port, sessionSecret: "restart-403-second-secret" });

    // The first request the dead cookie can no longer carry: navigating back to the launcher
    // (mounting `pagesQuery`, which polls the new server directly regardless of SSE state).
    await page.locator(".page-back").click();
    await expect(page.getByRole("heading", { name: "Connection lost" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".relogin-screen")).toContainText(/reopen the url/i);
  } finally {
    await second?.close();
    await first.close().catch(() => {}); // already closed on the happy path
    await rm(dir, { recursive: true, force: true });
  }
});

test("F2 regression: a malformed View deep link shows a per-view error, NOT the terminal session-expired screen", async ({ page }) => {
  // The bug the 403 fix above introduced: mintPageNonce also 403s (code FORBIDDEN) for a
  // malformed View doc — an `entry` outside an accepted prefix, or one no registry doc has registered — and
  // such a doc IS clickable today (the launcher doesn't filter entries by prefix). Session-death
  // and this confinement-refusal share nothing but the status code; only getDoc's 403 may trip
  // the terminal recovery screen (PageFrame.tsx's loadPage).
  const ui = await bootUiOverPagesBundle([]);
  try {
    await writeDoc(
      { root: ui.dir },
      { id: "views-registry/bad", frontmatter: { type: "View", title: "Bad view", entry: "not-a-view-prefix/oops.html" }, body: "" },
    );

    await page.goto(ui.url); // establish the session cookie; malformed entries are filtered from the launcher
    const origin = new URL(ui.url).origin;
    await page.goto(`${origin}/?view=page&id=views-registry%2Fbad`);

    await expect(page.locator(".view-status-error")).toContainText(/could not open page/i);
    await expect(page.getByRole("heading", { name: "Connection lost" })).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("P1: deleting an open page's registry doc revokes the frame — the iframe closes and the bridge goes with it", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/roadmap");
    const frame = page.frameLocator("iframe.page-frame-iframe");
    await expect(frame.locator(".item .title", { hasText: "Spike work" })).toBeVisible();

    // Delete the registry doc on disk via the CLI — the watcher pushes the removal over SSE.
    execFileSync(process.execPath, [CLI_DIST, "doc", "delete", "views-registry/roadmap", "--dir", ui.dir], { stdio: "ignore" });

    // The open frame is torn down (not merely stale) and an explicit revoked state shows.
    await expect(page.locator("iframe.page-frame-iframe")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".view-status-error")).toContainText("registry doc was removed");
  } finally {
    await ui.cleanup();
  }
});

test("a status change streams live into the open page (roadmap rollup updates, no reload)", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/roadmap");

    const frame = page.frameLocator("iframe.page-frame-iframe");
    const spike = frame.locator(".item", { hasText: "Spike work" });
    // Neither seeded task (alpha: todo, beta: blocked) is done/canceled yet.
    await expect(spike.locator(".roll .count")).toHaveText("0/2 done");

    // Flip alpha to done on disk via the CLI — the ui server's fs.watch picks it up and pushes over SSE.
    execFileSync(process.execPath, [CLI_DIST, "doc", "update", "tasks/alpha", "--progress_status", "done", "--dir", ui.dir], {
      stdio: "ignore",
    });

    // Within a moment the item's rollup counts it, without a page reload.
    await expect(spike.locator(".roll .count")).toHaveText("1/2 done", {
      timeout: 10_000,
    });
  } finally {
    await ui.cleanup();
  }
});

test("home surface: flat badged grid, live activity feed, first-run orientation that dismisses", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    await page.goto(ui.url);

    // First run: the walkthrough opens on panel 1; Next/Back navigate; "Got it" appears only on
    // the last panel (with the privacy promise), and dismissing there persists.
    const orientation = page.locator(".orientation");
    await expect(orientation).toBeVisible();
    await expect(orientation).toContainText(/what is superbee\?/i);
    await expect(orientation.getByRole("button", { name: "Got it" })).toHaveCount(0);
    await orientation.getByRole("button", { name: "Next" }).click();
    await expect(orientation).toContainText(/how do i use superbee\?/i);
    await orientation.getByRole("button", { name: "Back" }).click();
    await expect(orientation).toContainText(/what is superbee\?/i);
    await orientation.getByRole("button", { name: "Next" }).click();
    await orientation.getByRole("button", { name: "Next" }).click();
    await expect(orientation).toContainText(/recipes/i);
    await orientation.getByRole("button", { name: "Next" }).dblclick();
    await expect(orientation).toContainText(/collaborating with others/i);
    await expect(orientation, "a double-click on the last Next must not fall through to Got it").toBeVisible();
    await expect(orientation).toContainText(/stays local until you share it/i);
    // The public-repo visibility warning is visible WITHOUT expanding "learn more".
    await expect(orientation).toContainText(/as visible as the repository that carries it/i);
    await orientation.getByRole("button", { name: "Got it" }).click();
    await expect(orientation).not.toBeVisible();
    await page.reload();
    await expect(page.locator('[data-page-id="views-registry/pulse"]')).toBeVisible();
    await expect(page.locator(".orientation")).not.toBeVisible();

    // …but the walkthrough stays reachable: "what is this?" reopens it at panel 1, and walking to
    // the end closes it again.
    await page.locator(".about-btn").click();
    await expect(page.locator(".orientation")).toContainText(/shared, versioned memory/i);
    await page.locator(".orientation").getByRole("button", { name: "Next" }).click();
    await page.locator(".orientation").getByRole("button", { name: "Next" }).click();
    await page.locator(".orientation").getByRole("button", { name: "Next" }).click();
    await page.locator(".orientation").getByRole("button", { name: "Got it" }).click();
    await expect(page.locator(".orientation")).not.toBeVisible();

    // Identity truth (PR-B): a git-less temp bundle is PRIVATE — chip up front, path only behind
    // the disclosure, sharing detail inside the panel. The isolated HOME has no catalog, so no
    // workspaces block renders.
    const chip = page.locator(".chip");
    await expect(chip).toHaveText("private — this computer only");
    await expect(page.locator(".launcher-meta")).not.toContainText(ui.dir);
    await page.getByRole("button", { name: "where is this?" }).click();
    const panel = page.locator(".where-panel");
    await expect(panel).toContainText(ui.dir);
    await expect(panel).toContainText("not shared");
    await page.getByRole("button", { name: "hide details" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".workspaces-toggle")).toHaveCount(0);

    // ONE flat grid with capability badges — the capability-grouped sections are retired.
    await expect(page.locator(".launcher-grid")).toHaveCount(1);
    for (const retired of ["Dashboards", "Interactive", "Documents"]) {
      await expect(page.getByRole("heading", { name: retired, exact: true })).toHaveCount(0);
    }
    await expect(page.locator('[data-page-id="views-registry/roadmap"] .badge')).toHaveText("live data");
    await expect(page.locator('[data-page-id="pages-registry/about"] .badge')).toHaveText("artifact");

    // The activity feed lists the seeded Task docs (filtered: no registry docs, no conventions).
    const feed = page.locator(".feed-list");
    await expect(feed).toBeVisible();
    await expect(feed).toContainText("Alpha task");
    await expect(feed.locator(".feed-row", { hasText: "Pulse — activity feed" })).toHaveCount(0);

    // Live: a NEW doc written behind the server lands in the feed without a reload.
    execFileSync(process.execPath, [
      CLI_DIST, "doc", "write", "notes/live-probe",
      "--type", "Context Note", "--title", "Live probe note", "--actor", "e2e",
      "--dir", ui.dir,
    ]);
    await expect(feed).toContainText("Live probe note", { timeout: 15_000 });
    await expect(feed).toContainText("e2e");
  } finally {
    await ui.cleanup();
  }
});

test("doc reader: feed rows open rendered docs, links navigate, hostile content is inert, deep links work", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  try {
    await page.goto(ui.url);
    // Walk the orientation to its last panel — Got it lives only there.
    await page.locator(".orientation").getByRole("button", { name: "Next" }).click();
    await page.locator(".orientation").getByRole("button", { name: "Next" }).click();
    await page.locator(".orientation").getByRole("button", { name: "Next" }).click();
    await page.locator(".orientation .orientation-dismiss").click();

    // A doc written behind the server, carrying a resolvable link + hostile vectors.
    execFileSync(process.execPath, [
      CLI_DIST, "doc", "write", "notes/reader-probe",
      "--type", "Context Note", "--title", "Reader probe", "--actor", "e2e",
      "--body", 'See [alpha](../tasks/alpha.md). <script>window.__pwned=1</script> <img src=x onerror="window.__pwned=2"> [evil](javascript:alert(1))',
      "--dir", ui.dir,
    ]);

    // It lands in the feed; clicking the row opens the READER (blue shell bar, not a framed View).
    const row = page.locator(".feed-row", { hasText: "Reader probe" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator(".doc-head h1")).toHaveText("Reader probe");
    await expect(page.locator(".doc-bar")).toBeVisible();

    // Hostile content is INERT: literal text, no elements, no handler side effects, no dialogs.
    const body = page.locator(".doc-body");
    await expect(body).toContainText("<script>window.__pwned=1</script>");
    await expect(body.locator("script, img, iframe")).toHaveCount(0);
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
    expect(pwned).toBeUndefined();

    // The resolvable link navigates through the shell to the target doc; the javascript: link is inert.
    await expect(body.locator("a")).toHaveCount(1);
    await body.locator("a", { hasText: "alpha" }).click();
    await expect(page.locator(".doc-head h1")).toHaveText("Alpha task");
    await expect(page).toHaveURL(/view=doc&id=tasks%2Falpha/);

    // Deep link: a fresh navigation straight to a doc URL renders the reader.
    await page.goto(`${ui.url}&view=doc&id=notes/reader-probe`);
    await expect(page.locator(".doc-head h1")).toHaveText("Reader probe");

    expect(dialogs, "no dialog was ever triggered by the hostile doc").toEqual([]);
  } finally {
    await ui.cleanup();
  }
});
