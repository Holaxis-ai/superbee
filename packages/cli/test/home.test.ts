/**
 * `superbee` zero-arg home view — the content-first dashboard (AXI §8) + the offline
 * fallback (AXI §7/§10). Mirrors `kinds.test.ts`'s/`status.test.ts`'s in-process, dep-injected
 * pattern for the fast, mockable cases (A1.1-A1.5, A1.7-A1.9) and adds a real-filesystem pair
 * (A1.6) that exercises the DEFAULT `summarizeBundle` end to end, offline, directory-scoped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle, writeDoc, type OkfDocument } from "@superbee/core";

// HERMETIC CWD + HOME: `home()` peeks at project bindings from the cwd and at the user-scoped
// workspace catalog, so a REAL `.agentstate.json` anywhere above the test process's cwd — including
// the repo's own untracked one — leaks into every in-process test in this file and changes the
// dashboard/remote-pointer output; a real ~/.superbee-state/catalog.json would likewise leak catalog
// entries. node --test runs each file in its own process, so module-top temp roots make the file
// hermetic; tests that
// chdir themselves capture and restore their OWN `origCwd`, which composes with this.
process.chdir(await mkdtemp(path.join(tmpdir(), "aslite-hermetic-home-")));
const HERMETIC_HOME = await mkdtemp(path.join(tmpdir(), "aslite-hermetic-user-home-"));
process.env.HOME = HERMETIC_HOME;
process.env.USERPROFILE = HERMETIC_HOME;

import {
  buildHomeView,
  defaultLoadWorkspaces,
  home,
  summarizeDocs,
  type BundleSummary,
  type HomeRow,
  type UnreadableBundle,
} from "../src/commands/home.js";
import { cliVersion } from "../src/build-identity.js";
import { addCatalogEntry } from "../src/catalog.js";
import { canonicalUserStateDir, USER_STATE_MARKER_BYTES } from "../src/user-state.js";

const INVOKE = "npx -y superbee";
const DEFAULT_INVOKE = "npx -y superbee";
const BASE_DEPS = { binPath: () => "/bin/superbee", invocation: () => INVOKE };
const BUILT_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/superbee.mjs");

function row(id: string, timestamp: string): HomeRow {
  return { id, type: "Note", title: id.split("/").pop() ?? id, timestamp };
}

/** A minimal `OkfDocument` for exercising the REAL `summarizeDocs` fold (empty timestamp = missing). */
function docOf(id: string, timestamp: string): OkfDocument {
  return { id, frontmatter: { type: "Note", title: id.split("/").pop() ?? id, timestamp }, body: "" };
}

function summaryWithDocs(rows: HomeRow[], total?: number): BundleSummary {
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;
  return {
    root: "~/bundle",
    docs: total ?? rows.length,
    byType,
    recent: { shown: rows.length, total: total ?? rows.length, rows },
  };
}

const EMPTY_BUNDLE: BundleSummary = {
  root: "~/bundle",
  docs: 0,
  byType: {},
  recent: { shown: 0, total: 0, rows: [] },
};

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "superbee-home-test-"));
}

test("A1.1 dashboard: bundle present, docs>0 — bundle block content", () => {
  const rows = [row("notes/a", "2026-07-02T00:00:00.000Z")];
  const summary = summaryWithDocs(rows);
  const view = buildHomeView(BASE_DEPS, summary);
  const bundle = view.bundle as Record<string, unknown>;
  assert.equal(bundle.root, "~/bundle");
  assert.equal(bundle.docs, 1);
  assert.deepEqual(bundle.by_type, { Note: 1 });
  const recent = bundle.recent as BundleSummary["recent"];
  assert.equal(recent.shown, 1);
  assert.equal(recent.total, 1);
  assert.deepEqual(recent.rows[0], { id: "notes/a", type: "Note", title: "a", timestamp: "2026-07-02T00:00:00.000Z" });
  assert.deepEqual(bundle.next, [`${INVOKE} list`, `${INVOKE} status`]);
  assert.equal(view.getting_started, undefined);
});

test("A1.2 ordering: identity -> bundle -> commands (live content before the manual)", () => {
  const summary = summaryWithDocs([row("notes/a", "2026-07-02T00:00:00.000Z")]);
  const view = buildHomeView(BASE_DEPS, summary);
  const keys = Object.keys(view);
  assert.equal(keys[0], "superbee");
  assert.equal(keys[1], "bundle");
  assert.ok(keys.indexOf("commands") > keys.indexOf("bundle"));
});

test("A1.3 no-bundle fallback: no bundle block, getting_started hint, commands present, resolves", async () => {
  const view = buildHomeView(BASE_DEPS, null);
  assert.equal(view.bundle, undefined);
  assert.equal(typeof view.getting_started, "string");
  assert.match(
    view.getting_started as string,
    new RegExp(
      `${INVOKE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} init --create-only --recipe none --dir '\\.superbee'`,
    ),
  );
  assert.match(view.getting_started as string, new RegExp(`${INVOKE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} recipes`));
  assert.ok(view.commands);

  // home() itself must resolve (never reject) with a null summarizer.
  let out = "";
  await home([], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
  });
  assert.ok(out.length > 0);
});

test("A1.3b no-bundle --dir fallback creates in the explicit project's conventional child", async () => {
  let out = "";
  const selected = "/tmp/selected bundle";
  await home(["--dir", selected, "--json"], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: async () => [],
  });

  const gettingStarted = (JSON.parse(out) as Record<string, unknown>).getting_started as string;
  const target = path.join(selected, ".superbee");
  assert.ok(gettingStarted.includes(`${INVOKE} init --create-only --recipe none --dir '${target}'`));
  assert.ok(gettingStarted.includes(`${INVOKE} recipes`));
  assert.ok(gettingStarted.includes(`${INVOKE} init --create-only --recipe <name> --dir '${target}'`));
  assert.ok(!gettingStarted.includes(`recipes --dir`));
});

test("home preserves a conventional-directory conflict outside Git and never suggests init", async () => {
  const project = await tempDir();
  try {
    await initBundle(path.join(project, ".superbee"));
    await initBundle(path.join(project, ".agentstate-lite"));
    let out = "";
    await home(["--dir", project, "--json"], {
      ...BASE_DEPS,
      stdout: (s) => (out += s),
    });
    const view = JSON.parse(out) as Record<string, unknown>;
    const bundle = view.bundle as Record<string, unknown>;
    assert.equal(bundle.status, "conflict");
    assert.match(String(bundle.help), /refusing to choose between two project bundles/);
    assert.equal(view.getting_started, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("home --json is honored (renders valid JSON, not silently ignored TOON)", async () => {
  let toon = "";
  await home([], { binPath: () => "/bin/superbee", invocation: () => INVOKE, stdout: (s) => (toon += s), summarizeBundle: async () => null });

  let jsonOut = "";
  await home(["--json"], { binPath: () => "/bin/superbee", invocation: () => INVOKE, stdout: (s) => (jsonOut += s), summarizeBundle: async () => null });

  // --json actually changes the format (was previously declared-but-ignored) and parses as JSON.
  assert.notEqual(jsonOut, toon);
  const parsed = JSON.parse(jsonOut) as Record<string, unknown>;
  assert.ok(parsed.superbee, "the identity header survives into the JSON view");
  const identity = parsed.superbee as Record<string, unknown>;
  assert.equal(identity.version, cliVersion());
  assert.equal(identity.channel, "local-dev");
  assert.equal(identity.bin, "/bin/superbee");
});

test("workspace catalog orientation: non-empty only, minimal fields, before command reference", async () => {
  let out = "";
  await home(["--json"], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: async () => [
      { label: "agentstate" },
      { label: "personal" },
    ],
  });
  const view = JSON.parse(out) as Record<string, any>;
  assert.deepEqual(view.workspaces, {
    count: 2,
    shown: 2,
    entries: [
      { label: "agentstate" },
      { label: "personal" },
    ],
    help: `${INVOKE} catalog resolve <label-or-id> --field path`,
  });
  assert.ok(Object.keys(view).indexOf("workspaces") < Object.keys(view).indexOf("commands"));
  assert.doesNotMatch(JSON.stringify(view.workspaces.entries), /(?:locator|path|bnd_)/);

  out = "";
  await home(["--json"], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: async () => [],
  });
  assert.equal((JSON.parse(out) as Record<string, unknown>).workspaces, undefined);
});

test("workspace catalog orientation: caps and sorts labels with full-list guidance", async () => {
  let out = "";
  const labels = Array.from({ length: 18 }, (_, index) => `workspace-${String(17 - index).padStart(2, "0")}`);
  await home(["--json"], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: async () => labels.map((label) => ({ label })),
  });

  const workspaces = (JSON.parse(out) as Record<string, any>).workspaces;
  assert.equal(workspaces.count, 18);
  assert.equal(workspaces.shown, 15);
  assert.deepEqual(
    workspaces.entries.map(({ label }: { label: string }) => label),
    [...labels].sort().slice(0, 15),
  );
  assert.equal(workspaces.help, `${INVOKE} catalog list`);
});

test("workspace catalog orientation: loader failure is visible but never fails home", async () => {
  let out = "";
  await home(["--json"], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: async () => {
      throw new Error("corrupt catalog at /private/path");
    },
  });
  const view = JSON.parse(out) as Record<string, any>;
  assert.deepEqual(view.workspaces, {
    status: "unavailable",
    note: "workspace catalog could not be read",
    help: `${INVOKE} catalog list`,
  });
  assert.doesNotMatch(JSON.stringify(view.workspaces), /private\/path/);
});

test("workspace catalog orientation: a stalled injected loader cannot stall home", async () => {
  let out = "";
  const startedAt = Date.now();
  await home(["--json"], {
    binPath: () => "/bin/superbee",
    invocation: () => INVOKE,
    stdout: (s) => (out += s),
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: () => new Promise(() => {}),
    workspaceBudgetMs: 5,
  });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual((JSON.parse(out) as Record<string, any>).workspaces, {
    status: "unavailable",
    note: "workspace catalog check timed out",
    help: `${INVOKE} catalog list`,
  });
});

test("default workspace loader sorts labels but does not probe or expose ids and paths", async () => {
  const root = await realpath(await tempDir());
  try {
    const homeDir = path.join(root, "home");
    const bundleDir = path.join(root, "bundle");
    await mkdir(homeDir);
    await initBundle(bundleDir);
    await addCatalogEntry("personal", bundleDir, { home: homeDir });
    const entries = await defaultLoadWorkspaces(homeDir);
    assert.deepEqual(entries, [{ label: "personal" }]);
    assert.deepEqual(Object.keys(entries[0]!), ["label"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built home rejects a FIFO catalog and exits after its fail-soft receipt", async () => {
  const root = await realpath(await tempDir());
  const homeDir = path.join(root, "home");
  const stateDir = canonicalUserStateDir(homeDir);
  const fifo = path.join(stateDir, "catalog.json");
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(stateDir, "state.json"), USER_STATE_MARKER_BYTES, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [fifo], (err) => (err ? reject(err) : resolve()));
    });

    const startedAt = Date.now();
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [BUILT_CLI, "--json"], {
        cwd: root,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, AGENTSTATE_LITE_NO_AUTOPULL: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`built home stayed alive on a FIFO catalog; stderr: ${stderr}`));
      }, 3_000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`built home exited ${code}; stderr: ${stderr}`));
      });
    });
    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal(JSON.parse(output).workspaces.note, "workspace catalog could not be read");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A1.4 empty bundle (present, 0 docs): distinct from no-bundle", () => {
  const view = buildHomeView(BASE_DEPS, EMPTY_BUNDLE);
  const bundle = view.bundle as Record<string, unknown>;
  assert.equal(bundle.docs, 0);
  assert.equal(bundle.recent, undefined);
  assert.equal(typeof bundle.help, "string");
  assert.match(bundle.help as string, /create the first doc/);
  assert.equal(view.getting_started, undefined);
});

test("A1.5 bundle-read-error -> offline fallback, home() still resolves (never rejects)", async () => {
  let out = "";
  let threw = false;
  try {
    await home([], {
      binPath: () => "/bin/superbee",
      invocation: () => INVOKE,
      stdout: (s) => (out += s),
      summarizeBundle: async () => {
        throw new Error("boom: permissions/malformed bundle");
      },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.ok(out.includes("getting_started"));
});

test("A1.6 offline/directory-scoped: default deps, real bundle dir -> dashboard; non-bundle dir -> fallback", async () => {
  const bundleDir = await tempDir();
  const plainDir = await tempDir();
  try {
    const bundle = await initBundle(bundleDir);
    await writeDoc(bundle, {
      id: "notes/hello",
      frontmatter: { type: "Note", title: "Hello", timestamp: "2026-07-02T00:00:00.000Z" },
      body: "hi",
    });

    const origCwd = process.cwd();
    try {
      process.chdir(bundleDir);
      let out1 = "";
      await home([], { stdout: (s) => (out1 += s) });
      assert.ok(out1.includes("bundle"), "expected a dashboard inside a real bundle dir");
      assert.ok(out1.includes("notes/hello") || out1.includes("hello"));

      process.chdir(plainDir);
      let out2 = "";
      await home([], { stdout: (s) => (out2 += s) });
      assert.ok(out2.includes("getting_started"), "expected the offline fallback outside any bundle");
      assert.ok(!out2.includes("notes/hello"));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
    await rm(plainDir, { recursive: true, force: true });
  }
});

test("A1.6b bundle display name (tasks/bundle-display-name): a conventional bundle's block carries the PROJECT name plus the rename hint; a MARKER-typed docs/bundle doc overrides both; an ordinary docs/bundle doc appropriates nothing; injected name-less fakes stay name-free", async () => {
  const projectDir = await tempDir();
  try {
    const bundleRoot = path.join(projectDir, "my-project", ".agentstate-lite");
    await mkdir(bundleRoot, { recursive: true });
    const bundle = await initBundle(bundleRoot);

    const origCwd = process.cwd();
    try {
      // Chain rung (b): the block's name is the conventional dir's PARENT (the project), not
      // ".agentstate-lite" — the field report's exact illegibility. A parent-DERIVED name also
      // carries the one-line progressive-disclosure hint naming the exact override command.
      process.chdir(path.join(projectDir, "my-project"));
      let out1 = "";
      await home(["--json"], { stdout: (s) => (out1 += s) });
      const view1 = JSON.parse(out1) as { bundle: { name?: string; name_help?: string } };
      assert.equal(view1.bundle.name, "my-project");
      assert.match(view1.bundle.name_help ?? "", /doc write docs\/bundle --type "Bundle Name" --title/);

      // SILENT-APPROPRIATION guard (PR #67 review): an ordinary doc at the well-known id — any
      // type other than the marker — must NOT rename the project.
      await writeDoc(bundle, { id: "docs/bundle", frontmatter: { type: "Doc", title: "Bundle Storage Reference" }, body: "" });
      let outOrdinary = "";
      await home(["--json"], { stdout: (s) => (outOrdinary += s) });
      const viewOrdinary = JSON.parse(outOrdinary) as { bundle: { name?: string } };
      assert.equal(viewOrdinary.bundle.name, "my-project");

      // Chain rung (a): the MARKER-typed doc's title wins — the plain
      // `doc write --type "Bundle Name" --title` set path — and the hint disappears (an
      // explicitly named bundle is never nagged).
      await writeDoc(bundle, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "Renamed Project" }, body: "" });
      let out2 = "";
      await home(["--json"], { stdout: (s) => (out2 += s) });
      const view2 = JSON.parse(out2) as { bundle: { name?: string; name_help?: string } };
      assert.equal(view2.bundle.name, "Renamed Project");
      assert.equal(view2.bundle.name_help, undefined);
    } finally {
      process.chdir(origCwd);
    }

    // Byte-stability for the pure renderer: a summary WITHOUT a name (every pre-existing injected
    // fake) renders no `name` (and no hint) field at all.
    const view = buildHomeView(BASE_DEPS, EMPTY_BUNDLE);
    assert.ok(!("name" in (view.bundle as Record<string, unknown>)));
    assert.ok(!("name_help" in (view.bundle as Record<string, unknown>)));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("A1.7 recent ordering + cap (REAL summarizeDocs): timestamp desc, missing last, capped at 5, shown/total", () => {
  // Exercises the production sort directly (not an inline re-implementation) — a regression in the
  // real fold with many docs / missing timestamps is now caught here.
  const docs: OkfDocument[] = [
    docOf("notes/old", "2026-01-01T00:00:00.000Z"),
    docOf("notes/new", "2026-07-01T00:00:00.000Z"),
    docOf("notes/mid", "2026-04-01T00:00:00.000Z"),
    docOf("notes/no-ts-b", ""),
    docOf("notes/no-ts-a", ""),
    docOf("notes/newest", "2026-07-02T00:00:00.000Z"),
    docOf("notes/extra", "2026-02-01T00:00:00.000Z"),
  ];
  const summary = summarizeDocs(docs, "~/bundle");
  assert.equal(summary.docs, 7);
  assert.deepEqual(summary.byType, { Note: 7 });
  assert.equal(summary.recent.shown, 5);
  assert.equal(summary.recent.total, 7);
  assert.deepEqual(
    summary.recent.rows.map((r) => r.id),
    ["notes/newest", "notes/new", "notes/mid", "notes/extra", "notes/old"],
  );
  // …and buildHomeView renders that real summary faithfully.
  const recent = (buildHomeView(BASE_DEPS, summary).bundle as Record<string, unknown>)
    .recent as BundleSummary["recent"];
  assert.equal(recent.total, 7);
});

test("A1.7a v0.1 meaningful-time agreement: malformed remains sortable, ties are id-ordered, blank and missing stay last", () => {
  const timestamp = "2026-07-01T00:00:00.000Z";
  const docs: OkfDocument[] = [
    docOf("notes/tie-b", timestamp),
    { id: "notes/missing", frontmatter: { type: "Note", title: "missing" }, body: "" },
    docOf("notes/blank", ""),
    docOf("notes/malformed", "not-a-date"),
    docOf("notes/tie-a", timestamp),
  ];
  assert.deepEqual(
    summarizeDocs(docs, "~/bundle").recent.rows.map(({ id, timestamp: value }) => [id, value]),
    [
      ["notes/malformed", "not-a-date"],
      ["notes/tie-a", timestamp],
      ["notes/tie-b", timestamp],
      ["notes/blank", ""],
      ["notes/missing", ""],
    ],
  );
});

test("A1.7b byType ordering (REAL summarizeDocs): count desc, then type asc", () => {
  const docs: OkfDocument[] = [
    { id: "a", frontmatter: { type: "Concept" }, body: "" },
    { id: "b", frontmatter: { type: "Concept" }, body: "" },
    { id: "c", frontmatter: { type: "Note" }, body: "" },
    { id: "d", frontmatter: { type: "Design" }, body: "" },
  ];
  const summary = summarizeDocs(docs, "~/bundle");
  // Concept (2) first; Design and Note (1 each) follow in type-asc order.
  assert.deepEqual(Object.keys(summary.byType), ["Concept", "Design", "Note"]);
});

test("A1.8 home omits hosted credential identity while an explicit remote still orients bundle reads", () => {
  const local = buildHomeView(BASE_DEPS, null);
  assert.equal(local.auth, undefined);
  assert.equal(local.remotes, undefined);

  const scoped = buildHomeView(BASE_DEPS, null, "https://ex.workers.dev");
  assert.equal(scoped.auth, undefined);
  assert.deepEqual((scoped.remote as Record<string, unknown>).help, [
    `${INVOKE} list --remote https://ex.workers.dev`,
    `${INVOKE} status --remote https://ex.workers.dev`,
  ]);
});

test("A1.10 unreadable bundle (present but a doc failed to read): status:unreadable, NOT the init hint", () => {
  const unreadable: UnreadableBundle = { root: "~/bundle", unreadable: true };
  const view = buildHomeView(BASE_DEPS, unreadable);
  const bundle = view.bundle as Record<string, unknown>;
  assert.equal(bundle.root, "~/bundle");
  assert.equal(bundle.status, "unreadable");
  assert.match(bundle.help as string, /could not be read/);
  assert.equal(bundle.recent, undefined);
  // The whole point: a present-but-unreadable bundle must NOT be misreported as "no bundle — run init".
  assert.equal(view.getting_started, undefined);
});

test("A1.11 default summarizer distinguishes unreadable from no-bundle: a malformed doc -> unreadable, home() exit 0", async () => {
  const bundleDir = await tempDir();
  try {
    await initBundle(bundleDir);
    // Write a raw concept file with UNPARSEABLE YAML frontmatter (unclosed flow sequence), bypassing
    // writeDoc's validation, so the bundle walk's frontmatter parse throws on it.
    await mkdir(path.join(bundleDir, "notes"), { recursive: true });
    await writeFile(path.join(bundleDir, "notes", "bad.md"), "---\ntype: [unclosed\n---\nbody\n");

    const origCwd = process.cwd();
    try {
      process.chdir(bundleDir);
      let out = "";
      let threw = false;
      try {
        await home([], { stdout: (s) => (out += s) });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, "home() must never throw, even on an unreadable bundle");
      assert.ok(out.includes("unreadable"), "a present-but-unreadable bundle must report unreadable");
      assert.ok(!out.includes("getting_started"), "must NOT tell the agent to init over an existing bundle");
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
});

test("A1.12 project binding (directory-type, item 43 follow-on): home's dashboard resolves via the committed .agentstate.json and annotates the bundle block with `via`", async () => {
  const root = await tempDir();
  try {
    const sharedBundle = path.join(root, "shared");
    await initBundle(sharedBundle);
    await writeDoc(
      { root: sharedBundle },
      { id: "notes/hello", frontmatter: { type: "Note", title: "Hello", timestamp: "2026-07-02T00:00:00.000Z" }, body: "hi" },
    );
    const projectDir = path.join(root, "project"); // no bundle of its own here — only a binding
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, ".agentstate.json"), JSON.stringify({ bundle: "../shared" }));

    const origCwd = process.cwd();
    try {
      process.chdir(projectDir);
      let out = "";
      await home([], { stdout: (s) => (out += s) });
      assert.ok(out.includes("notes/hello"), "the dashboard should reflect the BOUND directory, not the (bundle-less) project dir");
      assert.ok(out.includes(".agentstate.json"), "the bundle block should note which file drove resolution");
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preferred .superbee.json binding scopes home and is named in the via receipt", async () => {
  const root = await tempDir();
  try {
    const sharedBundle = path.join(root, "shared");
    await initBundle(sharedBundle);
    await writeDoc(
      { root: sharedBundle },
      {
        id: "notes/preferred",
        frontmatter: { type: "Note", title: "Preferred", timestamp: "2026-08-12T00:00:00.000Z" },
        body: "hi",
      },
    );
    const projectDir = path.join(root, "project");
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, ".superbee.json"), JSON.stringify({ bundle: "../shared" }));

    const origCwd = process.cwd();
    try {
      process.chdir(projectDir);
      let out = "";
      await home(["--json"], { stdout: (s) => (out += s) });
      const view = JSON.parse(out) as {
        bundle?: { recent?: { rows?: Array<{ id: string }> }; via?: string };
      };
      assert.equal(view.bundle?.recent?.rows?.[0]?.id, "notes/preferred");
      assert.equal(view.bundle?.via, path.join(await realpath(projectDir), ".superbee.json"));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-level old/new binding conflict remains non-fatal in home and withholds initialization guidance", async () => {
  const projectDir = await tempDir();
  try {
    await writeFile(path.join(projectDir, ".superbee.json"), JSON.stringify({ bundle: "one" }));
    await writeFile(path.join(projectDir, ".agentstate.json"), JSON.stringify({ bundle: "two" }));

    const origCwd = process.cwd();
    try {
      process.chdir(projectDir);
      let out = "";
      await home(["--json"], { stdout: (s) => (out += s) });
      const view = JSON.parse(out) as Record<string, unknown>;
      assert.match(String(view.project_binding_error), /conflicting project bindings/);
      assert.equal(view.getting_started, undefined);
      assert.equal(view.bundle, undefined);
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("A1.12b disappeared project-binding target: recovery init preserves the bound target and recipe browsing is withheld", async () => {
  const root = await tempDir();
  try {
    const projectDir = path.join(root, "project");
    const missingBundle = path.join(await realpath(root), "missing bundle");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, ".agentstate.json"), JSON.stringify({ bundle: "../missing bundle" }));

    const origCwd = process.cwd();
    try {
      process.chdir(projectDir);
      let out = "";
      await home(["--json"], { stdout: (s) => (out += s) });
      const view = JSON.parse(out) as Record<string, unknown>;
      const gettingStarted = view.getting_started as string;
      assert.ok(
        gettingStarted.includes(
          `${DEFAULT_INVOKE} init --recipe none --dir '${missingBundle}'`,
        ),
      );
      assert.ok(gettingStarted.includes("fix/remove the binding before browsing recipes"));
      assert.ok(!gettingStarted.includes(`${DEFAULT_INVOKE} recipes`));
      assert.ok(!gettingStarted.includes("init --recipe none`"), "must not emit an unscoped init");
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A1.13 project binding URL: home surfaces explicit --remote migration guidance and never fetches", async () => {
  const projectDir = await tempDir();
  try {
    // Nothing listens on this port — home must only render the local-safe migration error.
    await writeFile(path.join(projectDir, ".agentstate.json"), JSON.stringify({ bundle: "http://127.0.0.1:1" }));

    const origCwd = process.cwd();
    try {
      process.chdir(projectDir);
      let out = "";
      await home([], { stdout: (s) => (out += s) });
      assert.ok(out.includes("http://127.0.0.1:1"));
      assert.ok(out.includes(".agentstate.json"));
      assert.ok(out.includes("project_binding_error"));
      assert.ok(out.includes("pass --remote"));
      assert.ok(out.includes("fix or remove the binding before initializing or browsing recipes"));
      assert.ok(!out.includes("getting_started"));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("A1.14 malformed project binding: home NEVER throws and withholds unsafe getting-started commands", async () => {
  const projectDir = await tempDir();
  try {
    await writeFile(path.join(projectDir, ".agentstate.json"), "not json at all");

    const origCwd = process.cwd();
    try {
      process.chdir(projectDir);
      let out = "";
      let threw = false;
      try {
        await home([], { stdout: (s) => (out += s) });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, "a malformed .agentstate.json must never crash the SessionStart hook");
      assert.ok(out.includes("project_binding_error"));
      assert.ok(out.includes("fix or remove the binding before initializing or browsing recipes"));
      assert.ok(!out.includes("getting_started"));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
