/**
 * The retired-kind hint (src/legacy-page.ts): `new`/`doc write`/`doc update`/`promote` (.md route)
 * SUCCESS receipts carry the ONE hint line when (and only when) the produced doc is typed 'Page';
 * never on reads, never a block. The hint names the migration script at its tag.
 *
 * Runs the command functions in-process against real temp filesystem bundles (the
 * `doc.test.ts`/`status.test.ts` pattern, including the explicit `readStdin` override).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc } from "@superbee/core";

import { isLegacyPageDoc, LEGACY_PAGE_TYPE_HINT } from "../src/legacy-page.js";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { promote } from "../src/commands/promote.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "superbee-legacy-page-test-"));
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

/** Run `promote` in-process, capturing + parsing its `--json` stdout. */
async function runPromoteJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await promote([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

// ── 1. The predicate ──────────────────────────────────────────────────────────────────────────

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

test("hint: names the migration script at tag v0.4.3 by its full GitHub URL", () => {
  assert.ok(
    LEGACY_PAGE_TYPE_HINT.includes(
      "https://github.com/Holaxis-ai/superbee/blob/v0.4.3/scripts/migrate-legacy-view-names.mjs",
    ),
  );
  assert.ok(LEGACY_PAGE_TYPE_HINT.includes("--dir <bundle-root>"));
  assert.ok(!LEGACY_PAGE_TYPE_HINT.includes("the repo's scripts/"), "no pointer to a script that is no longer in the tree");
});

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

test("new: a kind named Page scaffolds and carries the write-time hint", async () => {
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
