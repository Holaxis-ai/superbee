/**
 * E2E harness: boot the REAL, BUILT `superbee ui` command as a child process (never a
 * dev server — plans/ui-v1.md rev 3.2 "E2E: Playwright against the REAL `ui` command server").
 * Readiness/teardown ride the port-0 TOON/JSON receipt, exactly as the CLI's own `serve`
 * command's tests do (`packages/cli/test/serve.test.ts`).
 */
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { Frontmatter } from "@superbee/core";
import type { Page } from "@playwright/test";
import {
  bootUiServer,
  createEmbeddedAssetHandler,
  SessionViewAuthorizationStore,
  type EmbeddedUiAssets,
} from "@superbee/ui-server";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/ui/e2e -> repo root -> packages/cli/dist/superbee.mjs
export const CLI_DIST = path.resolve(here, "../../cli/dist/superbee.mjs");
const UI_DIST = path.resolve(here, "../dist");
// The production CLI persists exact-byte approvals outside the bundle. The in-process restart
// harness cannot import that CLI-owned adapter without reversing the package graph, so retain one
// process-local test store per isolated bundle root to model the same restart behavior.
const inProcessViewAuthorizations = new Map<string, SessionViewAuthorizationStore>();

/** The exact stdio shape `bootUi` spawns with (`stdio: ["ignore", "pipe", "pipe"]`) — stdin is `null` since it's ignored. */
type UiChild = ChildProcessByStdio<null, Readable, Readable>;

/** Cross-suite helper for the product's exact-byte active-View consent gate. */
export async function approveViewIfPrompted(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: "Allow this View to read bundle data?",
  });
  if (!await dialog.isVisible().catch(() => false)) {
    await dialog.waitFor({ state: "visible", timeout: 1_000 }).catch(() => {});
  }
  if (!await dialog.isVisible().catch(() => false)) return;
  await dialog.getByRole("button", { name: "Allow this View" }).click();
}

export async function openRegisteredView(page: Page, registryId: string): Promise<void> {
  await page.locator(`[data-page-id="${registryId}"]`).click();
  await approveViewIfPrompted(page);
}

/** A Task doc to seed a temp bundle with before booting `ui` over it. */
export interface SeedTask {
  id: string;
  frontmatter: Frontmatter;
  body: string;
}

/** Store test workflow state at the current bundle coordinate while keeping call-site fixtures readable. */
function currentProgressFrontmatter(frontmatter: Frontmatter): Frontmatter {
  if (!("status" in frontmatter)) return frontmatter;
  const { status, ...rest } = frontmatter;
  return { ...rest, superbee_progress_status: status };
}

export interface UiReceipt {
  ui: string;
  url: string;
  mode: string;
  root: string;
  auth: string;
  help: string[];
}

export interface RunningUi {
  receipt: UiReceipt;
  /** The tokenized URL fresh from the receipt — the FIRST navigation must use this to exchange the token for a session cookie. */
  url: string;
  stop: () => Promise<void>;
}

/** Cap on how much captured stderr a boot-failure rejection message carries — enough to diagnose a flake without dumping unbounded child output into a test failure. */
const BOOT_FAILURE_STDERR_TAIL_CHARS = 4_000;

/** The last {@link BOOT_FAILURE_STDERR_TAIL_CHARS} of `stderr`, prefixed to mark a truncation. Empty input renders as a plain "(no stderr captured)" note, never a blank/misleading suffix. */
function stderrTailForError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return " (no stderr captured)";
  const tail = trimmed.length > BOOT_FAILURE_STDERR_TAIL_CHARS ? `…(truncated)…${trimmed.slice(-BOOT_FAILURE_STDERR_TAIL_CHARS)}` : trimmed;
  return `\n--- captured stderr ---\n${tail}`;
}

/** `getStderr` returns whatever the child's stderr has accumulated SO FAR — read live at rejection time (tasks/ui-e2e-harness-boot-flake: an early-exit boot failure is otherwise undiagnosable — "ui command exited early" with no clue why). */
function waitForReceipt(child: UiChild, getStderr: () => string): Promise<UiReceipt> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => settle(() => reject(new Error("timed out waiting for the ui command's receipt"))), 15_000);
    function settle(fn: () => void) {
      if (settled) return; // an exit AFTER a successful resolve is an ordinary later shutdown, not a failure
      settled = true;
      clearTimeout(timeout);
      fn();
    }
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      child.stdout.off("data", onData);
      settle(() => {
        try {
          resolve(JSON.parse(line) as UiReceipt);
        } catch (err) {
          reject(new Error(`ui command's first stdout line was not valid JSON: ${line} (${String(err)})`));
        }
      });
    };
    child.stdout.on("data", onData);
    child.once("error", (err) => settle(() => reject(err)));
    child.once("exit", (code) =>
      settle(() =>
        reject(new Error(`ui command exited early (code ${code}) before printing a receipt${stderrTailForError(getStderr())}`)),
      ),
    );
  });
}

async function bootUi(args: string[]): Promise<RunningUi> {
  // Point the child's HOME at a throwaway dir so its `~/.superbee-state/ui-url` write (0600 re-entry
  // pointer) lands in an isolated home, never the real one.
  const fakeHome = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-home-"));
  const child = spawn(process.execPath, [CLI_DIST, "ui", ...args, "--port", "0", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });
  const receipt = await waitForReceipt(child, () => stderr);
  return {
    receipt,
    url: receipt.url,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        // Belt-and-braces: force-kill if it doesn't exit promptly (a real hang here would
        // otherwise stall the whole spec file rather than just this one test).
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 3_000).unref();
      })
        .finally(() => {
          if (stderr.trim()) console.error(`[ui stderr]\n${stderr}`);
        })
        .finally(() => rm(fakeHome, { recursive: true, force: true })),
  };
}

/** Boot `ui --dir <fresh temp bundle>`, seeded with the given Task docs' frontmatter/body. Returns the running instance plus a cleanup that stops the process AND removes the temp dir. */
export async function bootUiOverDirBundle(seedTasks: SeedTask[]): Promise<RunningUi & { dir: string; cleanup: () => Promise<void> }> {
  const { initBundle, writeDoc } = await import("@superbee/core");
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-e2e-"));
  await initBundle(dir);
  for (const task of seedTasks) {
    await writeDoc({ root: dir }, { id: task.id, frontmatter: task.frontmatter, body: task.body });
  }
  const running = await bootUi(["--dir", dir]);
  return {
    ...running,
    dir,
    cleanup: async () => {
      await running.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a fresh temp bundle with the given Tasks AND the three seed views
 * (`examples/views/{pulse,roadmap,about}.html` blobs + their registry docs) — the fixture for the
 * pages-spike e2e (tasks/ui-pages-spike). Pulse and Roadmap are seeded CANONICALLY
 * (`type: View`, `views-registry/`/`views/`); About is DELIBERATELY seeded at the LEGACY
 * LOCATIONS (`pages-registry/`/`pages/`) with the CURRENT `type: View` — locations survive the
 * name removal, and this pins that end-to-end. One RETIRED doc (`pages-registry/retired`,
 * `type: Page` + `bridge:`) is seeded too: the removal pin asserts it never reaches the
 * launcher (tasks/remove-legacy-page-bridge-support). The tasks are wired into a single
 * `roadmap-items/spike` doc via `contains` links, so the Roadmap view's `edges` request and
 * rollup bar have real data to render. Returns the bundle dir.
 */
export async function seedPagesBundle(seedTasks: SeedTask[]): Promise<string> {
  const { initBundle, writeDoc, writeBlob } = await import("@superbee/core");
  const { readFile } = await import("node:fs/promises");
  const examples = path.resolve(here, "../../../examples/views");
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-pages-e2e-"));
  await initBundle(dir);
  // The Task convention makes logical `progress_status` patchable (the live-update driver) and gives
  // the Pulse/Roadmap pages their status badges — mirrors this repo's own board.
  await writeDoc(
    { root: dir },
    {
      id: "conventions/task",
      frontmatter: {
        type: "Convention",
        title: "Task",
        governs: "Task",
        path: "tasks/",
        fields: {
          required: ["title", "superbee_progress_status"],
          optional: ["priority", "assignee", "description"],
          values: { superbee_progress_status: ["todo", "in_progress", "blocked", "done", "canceled"] },
          terminal: { superbee_progress_status: ["done", "canceled"] },
        },
      },
      body: "# Task",
    },
  );
  for (const task of seedTasks) {
    await writeDoc({ root: dir }, { id: task.id, frontmatter: currentProgressFrontmatter(task.frontmatter), body: task.body });
  }
  // One Roadmap Item `contains`-linking every seeded task (relative link, sibling directory) — the
  // fixture the Roadmap page's `edges({ text: "contains" })` request and rollup bar render against.
  const containsLinks = seedTasks.map((t) => `[contains](../${t.id}.md)`).join("\n\n");
  await writeDoc(
    { root: dir },
    { id: "roadmap-items/spike", frontmatter: { type: "Roadmap Item", title: "Spike work", superbee_progress_status: "active" }, body: containsLinks },
  );
  await writeDoc(
    { root: dir },
    {
      id: "views-registry/pulse",
      frontmatter: { type: "View", title: "Pulse — activity feed", entry: "views/pulse.html", description: "Live document feed.", access: "bundle-read" },
      body: "",
    },
  );
  await writeDoc(
    { root: dir },
    {
      id: "views-registry/trusted-action",
      frontmatter: { type: "View", title: "Trusted action", entry: "views/trusted-action.html", description: "Confirmed scalar update proof.", access: "bundle-propose" },
      body: "",
    },
  );
  await writeDoc(
    { root: dir },
    {
      id: "views-registry/roadmap",
      frontmatter: { type: "View", title: "Roadmap", entry: "views/roadmap.html", description: "Roadmap items and their contained tasks.", access: "bundle-read" },
      body: "",
    },
  );
  // LEGACY LOCATIONS on purpose (see the doc comment above): a current `type: View` doc under
  // the legacy prefixes — locations survive the name removal.
  await writeDoc(
    { root: dir },
    {
      id: "pages-registry/about",
      frontmatter: { type: "View", title: "About this bundle", entry: "pages/about.html", description: "Content-view navigation example.", access: "none" },
      body: "",
    },
  );
  // RETIRED legacy NAMES on purpose: a `type: Page` + `bridge:` doc with real entry bytes. The
  // launcher must never list it (the e2e removal pin in pages.spec.ts).
  await writeDoc(
    { root: dir },
    {
      id: "pages-registry/retired",
      frontmatter: { type: "Page", title: "Retired legacy page", entry: "pages/retired.html", description: "Must never render.", bridge: "bundle-read" },
      body: "",
    },
  );
  await writeBlob({ root: dir }, "views/pulse.html", await readFile(path.join(examples, "pulse.html")), "text/html; charset=utf-8");
  await writeBlob({ root: dir }, "views/roadmap.html", await readFile(path.join(examples, "roadmap.html")), "text/html; charset=utf-8");
  await writeBlob(
    { root: dir },
    "views/trusted-action.html",
    new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><title>Trusted action</title>
      <strong id="status">reading</strong><button id="propose" disabled>Mark Alpha done</button><p id="result"></p>
      <script>
        let version;
        const read = () => parent.postMessage({bridge:'v1',type:'read-versioned',id:'read',docId:'tasks/alpha'},'*');
        addEventListener('message', (event) => {
          if (event.source !== parent || event.data?.bridge !== 'v1') return;
          if (event.data.type === 'read-versioned:result') {
            version = event.data.result.version;
            document.querySelector('#status').textContent = event.data.result.doc.frontmatter.progress_status;
            document.querySelector('#propose').disabled = false;
          }
          if (event.data.type === 'action.result') {
            document.querySelector('#result').textContent = event.data.result.status;
            if (event.data.result.status === 'committed') read();
          }
        });
        document.querySelector('#propose').onclick = () => parent.postMessage({bridge:'v1',type:'action.propose',requestId:'finish',action:{kind:'document.set-field',docId:'tasks/alpha',field:'progress_status',value:'done',expectedVersion:version}},'*');
        read();
      </script>`),
    "text/html; charset=utf-8",
  );
  await writeBlob({ root: dir }, "pages/about.html", await readFile(path.join(examples, "about.html")), "text/html; charset=utf-8");
  await writeBlob(
    { root: dir },
    "pages/retired.html",
    new TextEncoder().encode("<!doctype html><title>retired</title><p>must never render</p>"),
    "text/html; charset=utf-8",
  );
  return dir;
}

/** Boot the real CLI's `ui --dir` over a freshly seeded pages bundle (see {@link seedPagesBundle}). */
export async function bootUiOverPagesBundle(seedTasks: SeedTask[]): Promise<RunningUi & { dir: string; cleanup: () => Promise<void> }> {
  const dir = await seedPagesBundle(seedTasks);
  const running = await bootUi(["--dir", dir, "--actor", "e2e/human"]);
  return {
    ...running,
    dir,
    cleanup: async () => {
      await running.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Install the shipped Personal Task System recipe, seed representative work, and boot its real board View. */
export async function bootUiOverPersonalTaskSystemBundle(): Promise<RunningUi & { dir: string; cleanup: () => Promise<void> }> {
  const { initBundle, writeDoc } = await import("@superbee/core");
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-personal-task-system-e2e-"));
  const recipeDir = path.resolve(here, "../../../examples/recipes/personal-task-system");
  await initBundle(dir);
  execFileSync(process.execPath, [CLI_DIST, "recipe", "add", recipeDir, "--dir", dir, "--json"], { encoding: "utf8" });
  await writeDoc(
    { root: dir },
    { id: "projects/launch", frontmatter: { type: "Project", title: "Product launch", superbee_progress_status: "active" }, body: "" },
  );
  await writeDoc(
    { root: dir },
    {
      id: "tasks/shape-message",
      frontmatter: { type: "Task", title: "Shape launch message", superbee_progress_status: "todo", priority: "high", assignee: "mike", due: "2026-08-01T00:00:00.000Z" },
      body: "[part of](../projects/launch.md)",
    },
  );
  await writeDoc(
    { root: dir },
    {
      id: "tasks/build-demo",
      frontmatter: { type: "Task", title: "Build product demo", superbee_progress_status: "in_progress", priority: "medium", assignee: "brian" },
      body: "[part of](../projects/launch.md)\n\n[depends on](shape-message.md)",
    },
  );
  await writeDoc(
    { root: dir },
    { id: "tasks/review-copy", frontmatter: { type: "Task", title: "Review landing copy", superbee_progress_status: "blocked", priority: "low" }, body: "" },
  );
  await writeDoc(
    { root: dir },
    { id: "tasks/archive-notes", frontmatter: { type: "Task", title: "Archive launch notes", superbee_progress_status: "done" }, body: "" },
  );
  await writeDoc(
    { root: dir },
    { id: "tasks/canceled-idea", frontmatter: { type: "Task", title: "Canceled launch idea", superbee_progress_status: "canceled" }, body: "" },
  );
  await writeDoc(
    { root: dir },
    {
      id: "constructor",
      frontmatter: { type: "Task", title: "Constructor-safe task", superbee_progress_status: "todo" },
      body: "[depends on](tasks/shape-message.md)",
    },
  );
  const running = await bootUi(["--dir", dir, "--actor", "e2e/human"]);
  return {
    ...running,
    dir,
    cleanup: async () => {
      await running.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The slice of the shared runtime handle the resilience spec drives. */
export interface InProcessUiServer {
  host: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function assetContentType(file: string): string {
  switch (path.extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

let embeddedAssetsPromise: Promise<EmbeddedUiAssets> | undefined;
function loadEmbeddedUiAssets(): Promise<EmbeddedUiAssets> {
  embeddedAssetsPromise ??= (async () => {
    const assets: Record<string, { contentType: string; gzipBase64: string }> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const relative = path.relative(UI_DIST, full).split(path.sep).join("/");
          const bytes = await readFile(full);
          assets[`/${relative}`] = {
            contentType: assetContentType(full),
            gzipBase64: gzipSync(bytes).toString("base64"),
          };
        }
      }
    };
    await walk(UI_DIST);
    return assets;
  })();
  return embeddedAssetsPromise;
}

/**
 * Boot the ui server IN-PROCESS (the same `bootUiServer` the CLI command wraps) with an INJECTED
 * session secret and port — the test seam the server exports for exactly this. Only the
 * SSE-resilience spec uses it: proving recovery across a server restart requires the restarted
 * instance to honor the browser's existing cookie (same secret, same port), which the real CLI —
 * correctly — makes impossible from the outside (the secret rotates every boot).
 */
export async function bootUiServerInProcess(opts: { dir: string; port?: number; sessionSecret: string }): Promise<InProcessUiServer> {
  const { createRouter } = await import("@superbee/server");
  const bundle = { root: opts.dir };
  const assets = await loadEmbeddedUiAssets();
  let viewAuthorization = inProcessViewAuthorizations.get(opts.dir);
  if (!viewAuthorization) {
    viewAuthorization = new SessionViewAuthorizationStore();
    inProcessViewAuthorizations.set(opts.dir, viewAuthorization);
  }
  return bootUiServer({
    mode: "dir",
    port: opts.port ?? 0,
    router: createRouter(bundle),
    bundle,
    sessionSecret: opts.sessionSecret,
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    viewAuthorization,
    serveAsset: createEmbeddedAssetHandler(assets),
    resolveBundleDisplayName: async () => path.basename(opts.dir),
  });
}

/** Boot a local, keyless reference `serve()` instance, then `ui --remote <that url>` proxying it — proves conditional (absent) Bearer injection with zero cloud, per rev 3.2. */
export async function bootUiOverRemote(seedTasks: SeedTask[]) {
  const { initBundle, writeDoc } = await import("@superbee/core");
  const { serve } = await import("@superbee/server");
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-e2e-remote-"));
  await initBundle(dir);
  for (const task of seedTasks) {
    await writeDoc({ root: dir }, { id: task.id, frontmatter: task.frontmatter, body: task.body });
  }
  const referenceServer = await serve({ bundle: { root: dir }, port: 0 });
  const remoteUrl = `http://${referenceServer.host}:${referenceServer.port}`;
  const running = await bootUi(["--remote", remoteUrl]);
  return {
    ...running,
    dir,
    remoteUrl,
    cleanup: async () => {
      await running.stop();
      await referenceServer.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
