/**
 * View delivery across engines. The shell fetches a View's bytes and the View host mounts them
 * as a sandboxed self-contained child, so the View frame never requests its own HTML. This spec runs on
 * Chromium AND WebKit (`playwright.config.ts`): a policy the child inherits can render in
 * one engine and be refused in the other, and only a real engine proves the containment.
 */
import { test, expect } from "@playwright/test";
import { writeBlob, writeDoc } from "@superbee/core";
import { blockOpaqueOriginFrameRequests, bootUiOverPagesBundle, openRegisteredView, viewContentFrame, viewFrame } from "./harness.js";
import { VIEW_LOAD_DEADLINE_MS } from "../src/views/viewReadiness.js";

const TASKS = [
  { id: "tasks/alpha", frontmatter: { type: "Task", title: "Alpha task", status: "todo" }, body: "" },
  { id: "tasks/beta", frontmatter: { type: "Task", title: "Beta task", status: "blocked" }, body: "" },
];

/** A scriptful access:none View that reports what its sandbox lets it do. */
const CONTAINMENT_PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<h1>Containment probe</h1><pre id="out"></pre>
<script>
var results = {};
function report(key, value) { results[key] = value; document.getElementById("out").textContent = JSON.stringify(results); }
document.addEventListener("securitypolicyviolation", function (event) {
  if (/^(frame|child)-src$/.test(event.effectiveDirective)) report("nestedDenied", (results.nestedDenied || 0) + 1);
});
window.addEventListener("message", function(event) {
  if (event.data === "nested-data-ran" || event.data === "nested-blob-ran") report(event.data, true);
});
report("origin", self.origin);
var dataFrame = document.createElement("iframe");
dataFrame.src = "data:text/html;base64," + btoa("<script>parent.postMessage('nested-data-ran','*')<" + "/script>");
document.body.appendChild(dataFrame);
var blobFrame = document.createElement("iframe");
blobFrame.src = URL.createObjectURL(new Blob(["<script>parent.postMessage('nested-blob-ran','*')<" + "/script>"], { type: "text/html" }));
document.body.appendChild(blobFrame);
fetch("http://127.0.0.1:9/v0/bundles/default/docs").then(function () { report("fetch", "ALLOWED"); }, function () { report("fetch", "blocked"); });
try {
  var worker = new Worker(URL.createObjectURL(new Blob(["postMessage('worker-ran')"], { type: "text/javascript" })));
  worker.onmessage = function () { report("worker", "RAN"); };
  worker.onerror = function () { report("worker", "blocked"); };
} catch (e) { report("worker", "blocked"); }
setTimeout(function () { if (!("worker" in results)) report("worker", "blocked"); report("done", true); }, 1500);
</script></body></html>`;

test("a View renders and gets bridge data in a browser that refuses every request an opaque-origin frame makes", async ({ page }) => {
  const ui = await bootUiOverPagesBundle(TASKS);
  try {
    const refused = await blockOpaqueOriginFrameRequests(page);
    const pageByteRequests: Array<{ url: string; fromShell: boolean }> = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith("/__page/") || pathname === "/__page/mint") return;
      pageByteRequests.push({ url: request.url(), fromShell: request.frame() === page.mainFrame() });
    });
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/roadmap");

    const frame = viewFrame(page);
    await expect(frame.locator(".item .title", { hasText: "Spike work" })).toBeVisible();
    await expect(frame.locator(".roll .count")).toHaveText("0/2 done");

    // The View child is attribute-sandboxed, opaque, and self-contained; the host is opaque
    // by its response policy and carries no sandbox attribute.
    const host = page.locator("iframe.page-frame-iframe");
    expect(await host.getAttribute("sandbox")).toBeNull();
    expect(await page.frameLocator("iframe.page-frame-iframe").locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
    const view = await viewContentFrame(page);
    expect(view.url()).toMatch(/^data:text\/html/);
    expect(await view.evaluate(() => self.origin)).toBe("null");
    expect(await view.parentFrame()!.evaluate(() => self.origin)).toBe("null");

    await page.waitForTimeout(VIEW_LOAD_DEADLINE_MS + 500);
    await expect(page.locator(".view-status-error")).toHaveCount(0);
    expect(pageByteRequests).toHaveLength(1);
    expect(pageByteRequests[0]!.fromShell).toBe(true);
    expect(refused).toEqual([]);
  } finally {
    await ui.cleanup();
  }
});

test("a View cannot fetch, start a worker or run nested data/blob frames", async ({ page }) => {
  const ui = await bootUiOverPagesBundle([]);
  try {
    await writeDoc(
      { root: ui.dir },
      {
        id: "views-registry/containment",
        frontmatter: { type: "View", title: "Containment probe", entry: "views/containment.html", access: "none" },
        body: "",
      },
    );
    await writeBlob({ root: ui.dir }, "views/containment.html", new TextEncoder().encode(CONTAINMENT_PROBE), "text/html; charset=utf-8");
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/containment");

    const out = viewFrame(page).locator("#out");
    await expect(out).toContainText('"done":true', { timeout: 10_000 });
    const results = JSON.parse((await out.textContent()) ?? "{}") as Record<string, unknown>;
    expect(results.origin).toBe("null");
    expect(results.fetch).toBe("blocked");
    expect(results.worker).toBe("blocked");
    expect(results.nestedDenied).toBeGreaterThanOrEqual(2);
    expect(results["nested-data-ran"]).toBeUndefined();
    expect(results["nested-blob-ran"]).toBeUndefined();
  } finally {
    await ui.cleanup();
  }
});

test("trusted child policy is in the parsed head before source scripts, preserving standards and quirks", async ({ page }) => {
  const ui = await bootUiOverPagesBundle([]);
  try {
    for (const [name, prefix, mode] of [
      ["standards", "\ufeff<!-- license café --><!-- second -->\n<!DOCTYPE html>", "CSS1Compat"],
      ["quirks", "<!-- quiet prolog -->\n", "BackCompat"],
    ]) {
      const html = prefix + '<html><head><script>window.policyWasEarly = !!document.head.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')</script></head><body><h1>Parsed policy</h1></body></html>';
      const id = `views-registry/${name}`;
      await writeDoc({ root: ui.dir }, { id, frontmatter: { type: "View", title: name, entry: `views/${name}.html`, access: "none" }, body: "" });
      await writeBlob({ root: ui.dir }, `views/${name}.html`, new TextEncoder().encode(html), "text/html; charset=utf-8");
      await page.goto(ui.url);
      await openRegisteredView(page, id);
      await expect(viewFrame(page).getByRole("heading", { name: "Parsed policy" })).toBeVisible();
      const child = await viewContentFrame(page);
      expect(await child.evaluate(() => document.compatMode)).toBe(mode);
      expect(await child.evaluate(() => (window as unknown as { policyWasEarly: boolean }).policyWasEarly)).toBe(true);
    }
  } finally {
    await ui.cleanup();
  }
});
