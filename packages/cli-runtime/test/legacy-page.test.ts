/**
 * The legacy-naming primitive (src/legacy-page.ts; removal phase
 * tasks/remove-legacy-page-bridge-support): ONE predicate family feeding two read-only surfaces —
 *
 *   1. the write-time hint: `new`/`doc write`/`doc update`/`promote` (.md route) SUCCESS receipts
 *      carry the ONE hint line when (and only when) the produced doc is typed 'Page'; never on
 *      reads, never a block;
 *   2. `status`'s `legacy_naming` FINDING: counts + ids of Page-typed docs and of View-kind docs
 *      carrying an own legacy `bridge` field (stock the runtime no longer accepts), plus an
 *      informational, STORE-AWARE count of items under the legacy pages-registry//pages/
 *      prefixes (locations — still recognized), omitted entirely on a legacy-free bundle.
 *
 * Runs the command functions in-process against real temp filesystem bundles (the
 * `doc.test.ts`/`status.test.ts` pattern, including the explicit `readStdin` override — see
 * doc.test.ts's test-authoring note).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeBlob, writeDoc } from "@superbee/core";

import { readFile } from "node:fs/promises";
import { parseMarkdown } from "@superbee/core";

import {
  hasLegacyBridgeField,
  isLegacyPageConvention,
  isLegacyPageDoc,
  isLegacyEntryBlobKey,
  isLegacyRegistryDocId,
  isKnownShippedLegacyPageConvention,
  KNOWN_SHIPPED_LEGACY_PAGE_CONVENTION_FORMS,
  LEGACY_PAGE_TYPE_HINT,
} from "../src/legacy-page.js";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { promote } from "../src/commands/promote.js";
import { status } from "../src/commands/status.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-legacy-page-test-"));
}

/** Run `doc` in-process, capturing + parsing its `--json` stdout (stdin explicitly "not a pipe"). */
async function runDocJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await doc([...argv, "--json"], { stdout: (s) => (out += s), readStdin: async () => undefined });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Run `new` in-process, capturing + parsing its `--json` stdout. */
async function runNewJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await newCommand([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Run `status` in-process, capturing + parsing its `--json` stdout. */
async function runStatusJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await status([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Run `promote` in-process, capturing + parsing its `--json` stdout. */
async function runPromoteJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await promote([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

// ── 1. The predicate itself ──────────────────────────────────────────────────────────────────────

test("isLegacyPageDoc: EXACT 'Page' only, matching core's exact grammar; 'View'/whitespace/case-variants/non-strings never do", () => {
  assert.equal(isLegacyPageDoc({ type: "Page" }), true);
  // EXACT, no trimming — the same strictness core's grammar always applied. A whitespace-padded
  // value can only reach consumers via a deliberately QUOTED YAML scalar (`type: " Page "`):
  // plain scalars are whitespace-trimmed by the YAML parser itself, and the one frontmatter
  // parse layer (core/src/frontmatter.ts) does no further `type` normalization. That spelling
  // was never a registration under any phase, so counting it legacy would flag a doc the
  // pre-removal reader did not accept either.
  assert.equal(isLegacyPageDoc({ type: " Page " }), false, "quoted whitespace-padded type is not legacy (core's grammar is exact)");
  assert.equal(isLegacyPageDoc({ type: "\tPage\n" }), false);
  assert.equal(isLegacyPageDoc({ type: "View" }), false);
  assert.equal(isLegacyPageDoc({ type: "page" }), false, "type values are case-sensitive — 'page' is another type, not a near-miss");
  assert.equal(isLegacyPageDoc({ type: "PAGE" }), false);
  assert.equal(isLegacyPageDoc({ type: "Pages" }), false);
  assert.equal(isLegacyPageDoc({ type: "Page " + "x" }), false);
  assert.equal(isLegacyPageDoc({}), false, "a missing type is not legacy");
  assert.equal(isLegacyPageDoc({ type: 5 }), false, "a non-string type is not legacy");
  assert.equal(isLegacyPageDoc({ type: ["Page"] }), false);
});

test("hasLegacyBridgeField: own `bridge` on a View-kind doc (View or legacy Page spelling) only — other types and inherited fields never count", () => {
  assert.equal(hasLegacyBridgeField({ type: "View", bridge: "bundle-read" }), true);
  assert.equal(hasLegacyBridgeField({ type: "Page", bridge: "none" }), true);
  // Both fields present still counts — the stale bridge is exactly what migration removes.
  assert.equal(hasLegacyBridgeField({ type: "View", access: "bundle-read", bridge: "bundle-propose" }), true);
  // `bridge` is only the View kind's legacy spelling — ordinary user data elsewhere.
  assert.equal(hasLegacyBridgeField({ type: "Note", bridge: "bundle-read" }), false);
  assert.equal(hasLegacyBridgeField({ bridge: "bundle-read" }), false, "a doc with no type is not a View-kind doc");
  assert.equal(hasLegacyBridgeField({ type: "View" }), false, "no own bridge field, nothing to flag");
  assert.equal(hasLegacyBridgeField({ type: "View", access: "bundle-read" }), false);
  // Own-property-gated, like core's declaredAccessValue.
  assert.equal(hasLegacyBridgeField(Object.assign(Object.create({ bridge: "bundle-read" }), { type: "View" }) as Record<string, unknown>), false);
});

test("isLegacyPageConvention: exactly type Convention governing 'Page' — other kinds, other governs, and instances never match", () => {
  assert.equal(isLegacyPageConvention({ type: "Convention", governs: "Page" }), true);
  assert.equal(isLegacyPageConvention({ type: "Convention", governs: "View" }), false);
  assert.equal(isLegacyPageConvention({ type: "Convention", governs: "page" }), false, "exact match, like the migration script");
  assert.equal(isLegacyPageConvention({ type: "Convention" }), false);
  assert.equal(isLegacyPageConvention({ type: "Page" }), false, "an instance is not a convention");
  assert.equal(isLegacyPageConvention({ governs: "Page" }), false);
});

test("TRIPWIRE: the frozen KNOWN shipped legacy Page-convention form equals the vendored pre-rename fixture's declared shape", async () => {
  // The frozen literals in legacy-page.ts and the vendored fixture are deliberately UNCOUPLED
  // (a legacy constant imports nothing); this equality assertion is what stops silent drift —
  // the legacy-constants-tripwire pattern, applied to the convention form.
  const fixture = await readFile(
    path.join(import.meta.dirname, "fixtures/review-workflow-legacy-v1/conventions/page.md"),
    "utf8",
  );
  const { frontmatter } = parseMarkdown(fixture);
  const fields = frontmatter.fields as { required: string[]; optional: string[]; values: Record<string, string[]> };
  const [form] = KNOWN_SHIPPED_LEGACY_PAGE_CONVENTION_FORMS;
  assert.equal(frontmatter.governs, "Page");
  assert.equal(frontmatter.path, form.path);
  assert.deepEqual(fields.required, [...form.required]);
  assert.deepEqual(fields.optional, [...form.optional]);
  assert.deepEqual(fields.values.bridge, [...form.bridgeValues]);

  // The matcher accepts exactly this shape — and any single perturbation stops matching (the
  // do-not-break-custom-kinds boundary).
  const shipped = { governs: "Page", path: form.path, fields };
  assert.equal(isKnownShippedLegacyPageConvention(shipped), true);
  assert.equal(isKnownShippedLegacyPageConvention({ ...shipped, governs: "View" }), false);
  assert.equal(isKnownShippedLegacyPageConvention({ ...shipped, path: "book-pages/" }), false);
  assert.equal(
    isKnownShippedLegacyPageConvention({ ...shipped, fields: { ...fields, required: ["title", "chapter"] } }),
    false,
  );
  assert.equal(
    isKnownShippedLegacyPageConvention({ ...shipped, fields: { ...fields, values: {} } }),
    false,
  );
});

test("store-aware classifiers: doc ids classify only against pages-registry/, blob keys only against pages/", () => {
  assert.equal(isLegacyRegistryDocId("pages-registry/dash"), true);
  assert.equal(isLegacyRegistryDocId("pages/manual"), false, "a doc under pages/ is NOT a legacy item — that prefix belongs to the BLOB store");
  assert.equal(isLegacyRegistryDocId("views-registry/dash"), false);
  assert.equal(isLegacyRegistryDocId("pages-registry2/dash"), false, "prefix match is segment-exact, not substring");
  assert.equal(isLegacyRegistryDocId("notes/pages-registry/dash"), false, "only a LEADING legacy prefix classifies");
  assert.equal(isLegacyRegistryDocId(""), false);

  assert.equal(isLegacyEntryBlobKey("pages/dash.html"), true);
  assert.equal(isLegacyEntryBlobKey("pages-registry/dash"), false, "a registry-prefixed key is not a legacy BLOB item");
  assert.equal(isLegacyEntryBlobKey("views/dash.html"), false);
  assert.equal(isLegacyEntryBlobKey("notes/pages/dash.html"), false);
  assert.equal(isLegacyEntryBlobKey(""), false);
});

// ── 2. The write-time nudge (authoring moments only) ─────────────────────────────────────────────

test("nudge: 'doc write --type Page' succeeds and carries the exact hint line; View/other types never do", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);

    const page = await runDocJson(["write", "pages-registry/dash", "--type", "Page", "--title", "Dash", "--dir", dir]);
    assert.equal(page.doc, "written", "the nudge never blocks — the write succeeded");
    assert.equal(page.hint, LEGACY_PAGE_TYPE_HINT);

    const view = await runDocJson(["write", "views-registry/dash", "--type", "View", "--title", "Dash", "--dir", dir]);
    assert.equal("hint" in view, false, "a View-typed doc gets no hint");

    const task = await runDocJson(["write", "tasks/t1", "--type", "Task", "--title", "T", "--dir", dir]);
    assert.equal("hint" in task, false, "an unrelated type gets no hint");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nudge: 'doc update' hints when the RESULT doc is Page-typed — including a --type Page retype — and not otherwise", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await runDocJson(["write", "pages-registry/dash", "--type", "Page", "--title", "Dash", "--dir", dir]);
    await runDocJson(["write", "views-registry/fresh", "--type", "View", "--title", "Fresh", "--dir", dir]);
    await runDocJson(["write", "notes/plain", "--type", "Concept", "--title", "Plain", "--dir", dir]);

    const patched = await runDocJson(["update", "pages-registry/dash", "--title", "Dash v2", "--dir", dir]);
    assert.equal(patched.doc, "updated");
    assert.equal(patched.hint, LEGACY_PAGE_TYPE_HINT);

    const viewPatched = await runDocJson(["update", "views-registry/fresh", "--title", "Fresh v2", "--dir", dir]);
    assert.equal("hint" in viewPatched, false);

    // Retyping TO Page is an authoring moment producing a Page-typed doc — it hints.
    const retyped = await runDocJson(["update", "notes/plain", "--type", "Page", "--dir", dir]);
    assert.equal(retyped.hint, LEGACY_PAGE_TYPE_HINT);

    // Retyping AWAY from Page produces a View-typed doc — no hint.
    const migratedByHand = await runDocJson(["update", "pages-registry/dash", "--type", "View", "--dir", dir]);
    assert.equal("hint" in migratedByHand, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nudge: 'new' of a bundle-declared Page kind hints; another kind does not", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: { type: "Convention", governs: "Page", fields: { required: ["title"], optional: [] }, timestamp: now },
      body: "The legacy Page kind.",
    });
    await writeDoc(bundle, {
      id: "conventions/widget",
      frontmatter: { type: "Convention", governs: "Widget", fields: { required: ["title"], optional: [] }, timestamp: now },
      body: "An unrelated kind.",
    });

    const page = await runNewJson(["Page", "pages-registry/dash", "--title", "Dash", "--dir", dir]);
    assert.equal(page.new, "written", "the nudge never blocks — the create succeeded");
    assert.equal(page.hint, LEGACY_PAGE_TYPE_HINT);

    const widget = await runNewJson(["Widget", "widgets/w1", "--title", "W", "--dir", dir]);
    assert.equal("hint" in widget, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nudge: 'promote' of a Page-typed .md registry doc hints (the documented View-authoring route); View docs and blob promotions never do", async () => {
  const dir = await tempDir();
  const files = await tempDir();
  try {
    await initBundle(dir);
    await writeFile(
      path.join(files, "legacy.md"),
      "---\ntype: Page\ntitle: Legacy Dash\nentry: pages/legacy.html\n---\nA legacy-typed registry doc.\n",
    );
    await writeFile(
      path.join(files, "fresh.md"),
      "---\ntype: View\ntitle: Fresh Dash\nentry: views/fresh.html\n---\nA current registry doc.\n",
    );
    await writeFile(path.join(files, "dash.html"), "<html></html>");

    const legacy = await runPromoteJson([path.join(files, "legacy.md"), "--doc-key", "pages-registry/legacy.md", "--dir", dir]);
    assert.equal(legacy.promote, "written", "the nudge never blocks — the promotion succeeded");
    assert.equal(legacy.route, "doc");
    assert.equal(legacy.hint, LEGACY_PAGE_TYPE_HINT);

    const fresh = await runPromoteJson([path.join(files, "fresh.md"), "--doc-key", "views-registry/fresh.md", "--dir", dir]);
    assert.equal("hint" in fresh, false, "a View-typed promotion gets no hint");

    // Blob promotions have no frontmatter to inspect — even under the legacy blob prefix.
    const blob = await runPromoteJson([path.join(files, "dash.html"), "--doc-key", "pages/dash.html", "--dir", dir]);
    assert.equal(blob.route, "blob");
    assert.equal("hint" in blob, false, "blob promotions are untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(files, { recursive: true, force: true });
  }
});

test("nudge: NEVER fires on reads — 'doc read' of a Page-typed doc carries no hint", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await runDocJson(["write", "pages-registry/dash", "--type", "Page", "--title", "Dash", "--body", "A dashboard.", "--dir", dir]);

    let out = "";
    await doc(["read", "pages-registry/dash", "--dir", dir, "--json"], {
      stdout: (s) => (out += s),
      readStdin: async () => undefined,
    });
    const read = JSON.parse(out) as Record<string, unknown>;
    assert.equal("hint" in read, false, "reads are not authoring moments");
    assert.ok(!out.includes("legacy name"), "no legacy prose anywhere in a read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. The `status` legacy_naming audit section ──────────────────────────────────────────────────

/**
 * A mixed bundle: two Page-typed docs (one under the legacy registry prefix, one elsewhere), a
 * bridge-only View doc, a View doc carrying BOTH access and a stale bridge, one clean View doc,
 * a NON-View doc with an own `bridge` field (never flagged), one unrelated doc, and one blob
 * under the legacy `pages/` prefix. Expected: page_typed_docs = 2; bridge_field_docs = 2;
 * legacy_prefix_items = 2 (the pages-registry doc + the pages/ blob — a Page-typed doc under
 * the old prefix legitimately counts in BOTH labels).
 */
async function makeMixedLegacyBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle = await initBundle(dir);
  const now = new Date().toISOString();
  await writeDoc(bundle, {
    id: "pages-registry/dash",
    frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "notes/legacy-typed",
    frontmatter: { type: "Page", title: "Stray legacy-typed doc", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/bridge-only",
    frontmatter: { type: "View", title: "Bridge only", entry: "views/bridge-only.html", bridge: "bundle-read", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/both-fields",
    frontmatter: { type: "View", title: "Both", entry: "views/both.html", access: "bundle-read", bridge: "bundle-propose", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/fresh",
    frontmatter: { type: "View", title: "Fresh", entry: "views/fresh.html", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "notes/bridge-note",
    frontmatter: { type: "Note", title: "A note about a bridge", bridge: "bundle-read", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "notes/plain",
    frontmatter: { type: "Concept", title: "Plain", timestamp: now },
    body: "",
  });
  await writeBlob(bundle, "pages/dash.html", new TextEncoder().encode("<html></html>"), "text/html");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("status: legacy_naming counts a seeded mixed bundle correctly — Page-typed docs, own-bridge View docs, and old-prefix items, separately labeled", async () => {
  const { dir, cleanup } = await makeMixedLegacyBundle();
  try {
    const result = await runStatusJson(["--dir", dir]);
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.ok(legacy, "expected a legacy_naming section on a bundle carrying legacy items");

    assert.equal(legacy.page_typed_docs, 2);
    const typedRows = legacy.page_typed_rows as { shown: number; total: number; rows: { id: string }[] };
    assert.equal(typedRows.total, 2);
    assert.deepEqual(
      typedRows.rows.map((r) => r.id).sort(),
      ["notes/legacy-typed", "pages-registry/dash"],
    );

    // The bridge FIELD finding: the bridge-only View AND the both-fields View (the stale bridge
    // is exactly what migration removes); the Note with an own bridge field is out of scope.
    assert.equal(legacy.bridge_field_docs, 2);
    const bridgeRows = legacy.bridge_field_rows as { shown: number; total: number; rows: { id: string }[] };
    assert.deepEqual(
      bridgeRows.rows.map((r) => r.id).sort(),
      ["views-registry/both-fields", "views-registry/bridge-only"],
    );
    assert.ok(!bridgeRows.rows.some((r) => r.id === "notes/bridge-note"), "a non-View doc's bridge field is user data");

    assert.equal(legacy.legacy_prefix_items, 2);
    const prefixRows = legacy.legacy_prefix_rows as { shown: number; total: number; rows: { id: string; store: string }[] };
    assert.equal(prefixRows.total, 2);
    assert.ok(prefixRows.rows.some((r) => r.id === "pages-registry/dash" && r.store === "doc"));
    assert.ok(prefixRows.rows.some((r) => r.id === "pages/dash.html" && r.store === "blob"));
    // Forward-prefix (views-registry//views/) and unrelated items never appear.
    assert.ok(!prefixRows.rows.some((r) => r.id.startsWith("views")));
    assert.ok(!typedRows.rows.some((r) => r.id === "views-registry/fresh" || r.id === "notes/plain"));

    // The FINDING is loud and actionable: it says the names are no longer accepted and its help
    // names the migration script.
    assert.equal(typeof legacy.note, "string");
    assert.match(legacy.note as string, /no longer accepted/);
    assert.match(String(legacy.help), /migrate-legacy-view-names/);
  } finally {
    await cleanup();
  }
});

test("status: legacy_naming is STORE-AWARE — a concept doc under pages/ is never counted; the registry doc and pages/ blob still are", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    // The cross-store decoy: an unrelated concept doc whose id merely lives under pages/ —
    // that prefix is legacy only in the BLOB store, so this doc must NOT count.
    await writeDoc(bundle, {
      id: "pages/manual",
      frontmatter: { type: "Note", title: "A doc that just lives under pages/", timestamp: now },
      body: "",
    });
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", timestamp: now },
      body: "",
    });
    await writeBlob(bundle, "pages/dash.html", new TextEncoder().encode("<html></html>"), "text/html");

    const result = await runStatusJson(["--dir", dir]);
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.equal(legacy.legacy_prefix_items, 2, "registry doc + pages/ blob only — never the pages/ concept doc");
    const prefixRows = legacy.legacy_prefix_rows as { rows: { id: string; store: string }[] };
    assert.ok(prefixRows.rows.some((r) => r.id === "pages-registry/dash" && r.store === "doc"));
    assert.ok(prefixRows.rows.some((r) => r.id === "pages/dash.html" && r.store === "blob"));
    assert.ok(!prefixRows.rows.some((r) => r.id === "pages/manual"), "the cross-store decoy doc must not appear");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: legacy_naming is read-only and re-runnable — two invocations return identical sections, and nothing was mutated", async () => {
  const { dir, cleanup } = await makeMixedLegacyBundle();
  try {
    const first = await runStatusJson(["--dir", dir]);
    const second = await runStatusJson(["--dir", dir]);
    assert.deepEqual(second.legacy_naming, first.legacy_naming);
    assert.equal(second.docs, first.docs);
  } finally {
    await cleanup();
  }
});

test("status: legacy_naming is OMITTED entirely on a legacy-free bundle (clean empty-state, matching the omit-if-empty idiom)", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    await writeDoc(bundle, {
      id: "views-registry/fresh",
      frontmatter: { type: "View", title: "Fresh", entry: "views/fresh.html", timestamp: now },
      body: "",
    });
    await writeBlob(bundle, "views/fresh.html", new TextEncoder().encode("<html></html>"), "text/html");
    const result = await runStatusJson(["--dir", dir]);
    assert.equal("legacy_naming" in result, false, "a legacy-free bundle's report gains nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: legacy_naming appears when the ONLY legacy signal is an own-bridge field — the silent-downgrade case cannot go unreported", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    await writeDoc(bundle, {
      id: "views-registry/quiet",
      frontmatter: { type: "View", title: "Quiet", entry: "views/quiet.html", bridge: "bundle-read", timestamp: now },
      body: "",
    });
    await writeBlob(bundle, "views/quiet.html", new TextEncoder().encode("<html></html>"), "text/html");
    const result = await runStatusJson(["--dir", dir]);
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.ok(legacy, "a bridge-only doc registers with access none — status must say why");
    assert.equal(legacy.page_typed_docs, 0);
    assert.equal(legacy.bridge_field_docs, 1);
    const bridgeRows = legacy.bridge_field_rows as { rows: { id: string }[] };
    assert.deepEqual(bridgeRows.rows, [{ id: "views-registry/quiet" }]);
    assert.equal("page_typed_rows" in legacy, false, "empty row blocks stay omitted");
    // The LOUD branch must fire on the bridge signal ALONE (review F4: a `namesPresent` that
    // consults only page_typed would downgrade this to the informational note and drop the
    // call-to-action — this pin makes that exact mutation fail).
    assert.match(String(legacy.note), /FINDING/);
    assert.match(String(legacy.note), /no longer accepted/);
    assert.match(String(legacy.help), /migrate-legacy-view-names/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: a migrated bundle keeping only legacy LOCATIONS gets the informational note — no FINDING, no migration help (nothing left to act on)", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    // The exact post-migration shape: type View + access at the legacy locations.
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "View", title: "Dash", entry: "pages/dash.html", access: "bundle-read", timestamp: now },
      body: "",
    });
    await writeBlob(bundle, "pages/dash.html", new TextEncoder().encode("<html></html>"), "text/html");
    const result = await runStatusJson(["--dir", dir]);
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.ok(legacy, "the location report remains");
    assert.equal(legacy.page_typed_docs, 0);
    assert.equal(legacy.bridge_field_docs, 0);
    assert.equal(legacy.legacy_prefix_items, 2);
    assert.match(String(legacy.note), /informational/);
    assert.doesNotMatch(String(legacy.note), /FINDING/);
    assert.equal("help" in legacy, false, "no migration call-to-action when only supported locations remain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: a stale governs:Page CONVENTION alone triggers the FINDING — silent scaffolding cannot go undiagnosed (review F3a)", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    // ONLY a convention declaring the dead kind name — zero Page-typed instances, zero bridge
    // fields, zero legacy-prefix items. Pre-fix this bundle's status was completely silent.
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: {
        type: "Convention",
        title: "Page",
        governs: "Page",
        path: "pages-registry/",
        fields: { required: ["title", "entry", "bridge"], optional: ["description"], values: { bridge: ["none", "bundle-read"] }, terminal: {} },
        timestamp: now,
      },
      body: "# Page\n\nThe dead legacy kind, still advertised by kinds.",
    });
    const result = await runStatusJson(["--dir", dir]);
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.ok(legacy, "a governs:Page convention must surface the section");
    assert.equal(legacy.page_typed_docs, 0);
    assert.equal(legacy.bridge_field_docs, 0);
    assert.equal(legacy.page_convention_docs, 1);
    const rows = legacy.page_convention_rows as { rows: { id: string }[] };
    assert.deepEqual(rows.rows, [{ id: "conventions/page" }]);
    assert.match(String(legacy.note), /FINDING/);
    assert.match(String(legacy.note), /governing the legacy 'Page' name/);
    assert.match(String(legacy.help), /migrate-legacy-view-names/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. `new` refuses scaffolding from the KNOWN SHIPPED legacy Page convention (review F3b) ─────

test("new: REFUSES scaffolding from the KNOWN SHIPPED legacy Page convention — error names the migration script; nothing is written", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    // The exact shipped legacy form (the tripwire above pins it equal to the vendored fixture).
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: {
        type: "Convention",
        title: "Page",
        governs: "Page",
        path: "pages-registry/",
        fields: { required: ["title", "entry", "bridge"], optional: ["description"], values: { bridge: ["none", "bundle-read"] }, terminal: {} },
        timestamp: now,
      },
      body: "# Page\n\nThe shipped legacy form.",
    });
    await assert.rejects(
      () => runNewJson(["Page", "pages-registry/dash", "--title", "Dash", "--entry", "pages/dash.html", "--bridge", "none", "--dir", dir]),
      (err: Error) => /migrate-legacy-view-names/.test(String((err as { help?: string }).help ?? "")) && /retired legacy form/.test(err.message),
    );
    // Nothing was scaffolded — the refusal is BEFORE any write.
    let out = "";
    await status(["--dir", dir, "--json"], { stdout: (s) => (out += s) });
    const report = JSON.parse(out) as Record<string, unknown>;
    assert.equal((report.legacy_naming as Record<string, unknown>).page_typed_docs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new: a genuinely-CUSTOM kind named Page (different declared shape) still scaffolds, with the write-time hint — the refusal never overreaches", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: {
        type: "Convention",
        title: "Page",
        governs: "Page",
        path: "book-pages/",
        fields: { required: ["title", "chapter"], optional: [] },
        timestamp: now,
      },
      body: "Someone's own 'Page' kind — book pages, nothing to do with Views.",
    });
    const created = await runNewJson(["Page", "book-pages/one", "--title", "One", "--chapter", "1", "--dir", dir]);
    assert.equal(created.new, "written", "a custom kind named Page keeps working");
    assert.equal(created.hint, LEGACY_PAGE_TYPE_HINT, "the write-time hint still fires on the produced doc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: legacy_naming row lists honor --limit with explicit shown/total (never a silent truncation)", async () => {
  const { dir, cleanup } = await makeMixedLegacyBundle();
  try {
    const result = await runStatusJson(["--dir", dir, "--limit", "1"]);
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.equal(legacy.page_typed_docs, 2, "the COUNT is always the full total");
    const typedRows = legacy.page_typed_rows as { shown: number; total: number; rows: unknown[] };
    assert.equal(typedRows.shown, 1);
    assert.equal(typedRows.total, 2);
    assert.equal(typedRows.rows.length, 1);
    const prefixRows = legacy.legacy_prefix_rows as { shown: number; total: number; rows: unknown[] };
    assert.equal(prefixRows.shown, 1);
    assert.equal(prefixRows.total, 2);
  } finally {
    await cleanup();
  }
});
