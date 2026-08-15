/**
 * Recipes Unit B (pluggable recipes) — the CLI recipe verbs (`recipes` list, `recipe add
 * <name-or-path>`), `init`'s default-recipe application, and command-level integration for the
 * `recipe-source.ts` seam. Pure-pipeline / path-safety unit tests for the seam itself live in
 * `recipe-source.test.ts`.
 *
 * Covers (C.2 test matrix):
 *  1. Built-in re-hosted: BYTE-IDENTICAL seed guarantee (init's `conventions/context-note.md`
 *     matches the pre-refactor engine-side seed, modulo the always-dynamic `timestamp`); `recipes`
 *     lists `context-notes` applied:true after init; `recipe add context-notes` on a fresh bundle.
 *  2. External loads+applies through the SAME path (`recipe add <fixture path>`).
 *  3. Idempotency (built-in AND external) + does-not-disturb-a-hand-edited-doc.
 *  4. Conflict surfaced: a DIFFERENT doc id governing the same type -> KIND_DUPLICATE_GOVERNS in
 *     the receipt `warnings`, never silently dropped, CAS never overwrites.
 *  5. Malformed manifest / not-found / empty -> structured CliError("USAGE"), exit 2, no stack.
 *  7. Conventions-free / gate-3 unaffected: `init --recipe none` is bare.
 *
 * Plus the pre-existing `status` kind-horizon coupling and Fork-4 generic-path parity proofs, and
 * `--remote` parity for `recipe add` — updated for the widened `LoadedRecipe` shape, unchanged in
 * spirit. Runs command functions in-process (no subprocess) against a real temp filesystem bundle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  initBundle,
  query,
  readBlob,
  writeBlob,
  writeDoc,
  parseMarkdown,
  loadKinds,
  kindConventionDoc,
  CONVENTION_TYPE,
  type Bundle,
  type KindConvention,
} from "@superbee/core";
import { parseRegistration, PAGE_REGISTRY_PREFIX, VIEW_REGISTRY_PREFIX } from "@superbee/core/page";
import { serve, type ServerHandle } from "@superbee/server";

import { init } from "../src/commands/init.js";
import { recipeInventoryRow, recipes } from "../src/commands/recipes.js";
import { recipe } from "../src/commands/recipe.js";
import { status } from "../src/commands/status.js";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { list } from "../src/commands/list.js";
import { pull } from "../src/commands/pull.js";
import { promote } from "../src/commands/promote.js";
import { link } from "../src/commands/link.js";
import { CliError } from "../src/errors.js";
import {
  CONTEXT_NOTE_SEED_BODY,
  TASK_SEED_BODY,
  ROADMAP_SEED_BODY,
  ROADMAP_ITEM_SEED_BODY,
  ROADMAP_DESC_BODY,
  applyRecipe,
} from "../src/recipes.js";
import {
  CONTEXT_NOTES_RECIPE,
  filesRecipeSource,
  parseRecipeFiles,
  type RecipeFile,
} from "../src/recipe-source.js";
import { cliInvocation, shellArg } from "../src/invocation.js";

const T = "2026-07-01T00:00:00.000Z";
const EXAMPLE_RECIPE_FIXTURE = path.resolve(import.meta.dirname, "fixtures/example-recipe");
const REVIEW_WORKFLOW_RECIPE = path.resolve(import.meta.dirname, "../../../examples/recipes/review-workflow");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-recipes-test-"));
}

/**
 * Run a command function, capturing its `--json` stdout and parsing the envelope. Passes a
 * `readStdin` stub (like `doc.test.ts`'s `runDoc`) so a body-less `doc update`/`doc write` never
 * falls through to `defaultReadStdin`, which reads REAL `process.stdin` and hangs under `node --test`.
 */
async function runJson(
  cmd: (
    argv: string[],
    deps: { stdout: (s: string) => void; readStdin?: () => Promise<string | undefined> },
  ) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let out = "";
  await cmd([...argv, "--json"], { stdout: (s) => (out += s), readStdin: async () => undefined });
  return JSON.parse(out) as Record<string, unknown>;
}

/** The expected `conventions/context-note.md` frontmatter, minus the always-dynamic `timestamp`. */
const EXPECTED_CONTEXT_NOTE_FRONTMATTER = {
  type: CONVENTION_TYPE,
  title: "Context Note",
  governs: "Context Note",
  path: "context-notes/",
  fields: { required: ["title", "timestamp"], optional: ["description", "tags"] },
  sections: ["Summary"],
  freshness_horizon: "24h",
  browse_collapsed: true,
};

// ── Row 1: built-in re-hosted ──────────────────────────────────────────────────────────────────

test("v0.1 init materializes the context-notes guide and frontmatter consistently", async () => {
  const dir = await tempDir();
  try {
    await init(["--dir", dir], { stdout: () => {} });
    const raw = await readFile(path.join(dir, "conventions", "context-note.md"), "utf8");
    const { frontmatter, body } = parseMarkdown(raw);
    assert.equal(body, CONTEXT_NOTE_SEED_BODY);
    const { timestamp, ...rest } = frontmatter;
    assert.deepEqual(rest, EXPECTED_CONTEXT_NOTE_FRONTMATTER);
    assert.equal(typeof timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(timestamp as string)), `expected a valid ISO timestamp, got ${timestamp}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit v0.2 init teaches an edition-correct workflow field in the default in-bundle authoring guide", async () => {
  const dir = await tempDir();
  try {
    await init(["--dir", dir, "--okf-version", "0.2"], { stdout: () => {} });
    const raw = await readFile(path.join(dir, "conventions", "context-note.md"), "utf8");
    const { body } = parseMarkdown(raw);

    assert.match(body, /required: \[title, superbee_progress_status\]/);
    assert.match(body, /superbee_progress_status: \[planned, active, done\]/);
    assert.doesNotMatch(body, /\bstatus: \[planned, active, done\]/);
    assert.match(body, /timestamp.*explicit compatibility field/);
    assert.match(body, /freshness_horizon.*Superbee Kind extension/);
    assert.doesNotMatch(body, /\{\{superbee:progress_status\}\}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add context-notes: idempotent — second add is changed:false, on-disk bytes unchanged", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const first = await runJson(recipe, ["add", "context-notes", "--dir", dir]);
    assert.equal(first.recipe, "added");
    assert.equal(first.id, "context-notes");
    assert.equal(first.version, "1");
    assert.equal(first.source, "builtin:context-notes");
    assert.equal(first.changed, true);
    const docsFirst = first.docs as Array<Record<string, unknown>>;
    assert.equal(docsFirst.length, 1);
    assert.equal(docsFirst[0]!.changed, true);
    assert.equal(docsFirst[0]!.id, "conventions/context-note");

    const bytesAfterFirst = await readFile(path.join(dir, "conventions", "context-note.md"), "utf8");

    const second = await runJson(recipe, ["add", "context-notes", "--dir", dir]);
    assert.equal(second.changed, false);
    const docsSecond = second.docs as Array<Record<string, unknown>>;
    assert.equal(docsSecond[0]!.changed, false);

    const bytesAfterSecond = await readFile(path.join(dir, "conventions", "context-note.md"), "utf8");
    assert.equal(bytesAfterSecond, bytesAfterFirst, "a no-op re-add must not touch the on-disk bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add context-notes: does not disturb a bundle author's own hand-edited conventions/context-note.md", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "conventions/context-note",
      frontmatter: { type: CONVENTION_TYPE, title: "Context Note", governs: "Context Note", timestamp: T },
      body: "Custom prose the author wrote.",
    });

    const result = await runJson(recipe, ["add", "context-notes", "--dir", dir]);
    assert.equal(result.changed, false);
    const docs = result.docs as Array<Record<string, unknown>>;
    assert.equal(docs[0]!.changed, false);

    const registry = await loadKinds(bundle);
    const kind = registry.kinds.get("Context Note");
    assert.ok(kind);
    // The recipe's write lost the CAS race (file already existed) — the author's declaration (no
    // horizon, no path) survives untouched rather than being overwritten by the built-in recipe.
    assert.equal(kind!.freshnessHorizon, undefined);
    assert.equal(kind!.path, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipes: lists context-notes with applied:false on a bare bundle, applied:true after recipe add", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const before = await runJson(recipes, ["--dir", dir]);
    assert.equal(before.count, 3);
    const rowsBefore = before.recipes as Array<Record<string, unknown>>;
    assert.equal(rowsBefore.length, 3);
    assert.equal(rowsBefore[0]!.name, "context-notes");
    assert.equal(rowsBefore[0]!.version, "1");
    assert.equal(rowsBefore[0]!.applied, false);
    assert.deepEqual(rowsBefore[0]!.commands, {
      add_to_bundle: `${cliInvocation()} recipe add context-notes --dir '${dir}'`,
    });

    await recipe(["add", "context-notes", "--dir", dir], { stdout: () => {} });

    const after = await runJson(recipes, ["--dir", dir]);
    const rowsAfter = after.recipes as Array<Record<string, unknown>>;
    assert.equal(rowsAfter[0]!.applied, true);
    assert.deepEqual(rowsAfter[0]!.commands, {
      add_to_bundle: `${cliInvocation()} recipe add context-notes --dir '${dir}'`,
    });
    assert.deepEqual(after.help, [
      `${cliInvocation()} recipe add <name-or-path> --dir '${dir}'`,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipes: no-bundle inventory succeeds without opening or creating a bundle and emits actionable commands", async () => {
  let out = "";
  let opened = false;
  await recipes(["--json"], {
    stdout: (s) => (out += s),
    cwd: "/definitely/empty",
    resolveRemoteFlag: async () => undefined,
    resolveProjectBinding: async () => null,
    findBundleRoot: async () => null,
    openBundle: async () => {
      opened = true;
      throw new Error("bundle-free discovery must not open a bundle");
    },
  });

  assert.equal(opened, false);
  const result = JSON.parse(out) as Record<string, unknown>;
  assert.equal(result.count, 3);
  const rows = result.recipes as Array<Record<string, unknown>>;
  const contextNotes = rows.find((row) => row.name === "context-notes");
  assert.ok(contextNotes);
  assert.equal(contextNotes.applied, null);
  assert.equal(contextNotes.version, "1");
  assert.equal(typeof contextNotes.summary, "string");
  assert.deepEqual(contextNotes.assets, {
    kinds: ["Context Note"],
    references: [],
    views: [],
  });
  assert.deepEqual(contextNotes.commands, {
    create_bundle: `${cliInvocation()} init --create-only --recipe context-notes --dir '.agentstate-lite'`,
    add_to_bundle: `${cliInvocation()} recipe add context-notes`,
  });
  assert.deepEqual(result.help, [
    `${cliInvocation()} init --create-only --recipe <name> --dir '.agentstate-lite'`,
    `${cliInvocation()} recipe add <name-or-path>`,
  ]);
});

test("recipes: explicit targets remain fail-loud instead of falling back to bundle-free inventory", async () => {
  let discoveryAttempted = false;
  await assert.rejects(
    recipes(["--dir", "/missing", "--json"], {
      stdout: () => {},
      cwd: "/empty",
      resolveRemoteFlag: async () => undefined,
      resolveProjectBinding: async () => null,
      findBundleRoot: async () => {
        discoveryAttempted = true;
        return null;
      },
      openBundle: async () => {
        throw new CliError("NOT_FOUND", "explicit target does not exist");
      },
    }),
    (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND",
  );
  assert.equal(discoveryAttempted, false);
});

test("recipes: valid project bindings remain committed targets whose open failures are surfaced", async () => {
  await assert.rejects(
    recipes(["--json"], {
      stdout: () => {},
      cwd: "/project",
      resolveRemoteFlag: async () => undefined,
      resolveProjectBinding: async () => ({
        file: "/project/.agentstate.json",
        target: "/missing-bundle",
      }),
      findBundleRoot: async () => {
        throw new Error("binding selection must precede discovery");
      },
      openBundle: async () => {
        throw new CliError("NOT_FOUND", "bound bundle disappeared");
      },
    }),
    (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND",
  );
});

test("recipe inventory derives Reference and View identities from any loaded manifest", async () => {
  const loaded = await filesRecipeSource().resolve(REVIEW_WORKFLOW_RECIPE);
  assert.ok(loaded?.ok);
  if (!loaded?.ok) return;

  const row = recipeInventoryRow(loaded.recipe, null, "aslite");
  assert.deepEqual(row.assets, {
    kinds: ["Review Request", "View"],
    references: ["references/view-authoring-v0"],
    views: ["views-registry/review-workflow-reviews"],
  });
});

// ── work-tracking: the second built-in recipe (first DOMAIN recipe) ───────────────────────────

test("recipes: lists ALL THREE built-ins — context-notes, work-tracking, roadmap", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const result = await runJson(recipes, ["--dir", dir]);
    assert.equal(result.count, 3);
    const rows = result.recipes as Array<Record<string, unknown>>;
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(names, ["context-notes", "roadmap", "work-tracking"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add work-tracking: applies the current built-in Task convention with descriptions", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const result = await runJson(recipe, ["add", "work-tracking", "--dir", dir]);
    assert.equal(result.recipe, "added");
    assert.equal(result.id, "work-tracking");
    assert.equal(result.version, "1");
    assert.equal(result.source, "builtin:work-tracking");
    assert.equal(result.changed, true);
    const docs = result.docs as Array<Record<string, unknown>>;
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.id, "conventions/task");
    assert.equal(docs[0]!.changed, true);

    const raw = await readFile(path.join(dir, "conventions", "task.md"), "utf8");
    const { frontmatter, body } = parseMarkdown(raw);
    const { timestamp, ...rest } = frontmatter;
    assert.deepEqual(rest, {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      description: "A concrete unit of work that can be claimed, prioritized, assigned, and completed.",
      path: "tasks/",
      links: { "depends on": "Task" },
      fields: {
        required: ["title", "status"],
        optional: ["priority", "assignee", "description"],
        values: { status: ["todo", "in_progress", "blocked", "done", "canceled"] },
        terminal: { status: ["done", "canceled"] },
        descriptions: {
          title: "A concise human-readable summary of the work.",
          status: "The task's current workflow state.",
          priority: "Relative urgency used to order the work; follow the bundle's adopted priority scale.",
          assignee: "The person or agent currently responsible for the task.",
          description: "The task's scope, context, acceptance criteria, and other working details.",
        },
      },
      freshness_horizon: "30d",
    });
    assert.equal(typeof timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(timestamp as string)), `expected a valid ISO timestamp, got ${timestamp}`);
    assert.equal(body, TASK_SEED_BODY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kinds: reports Task with required/optional/values/horizon after recipe add work-tracking", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await recipe(["add", "work-tracking", "--dir", dir], { stdout: () => {} });
    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    const kind = registry.kinds.get("Task");
    assert.ok(kind);
    assert.deepEqual(kind!.fields.required, ["title", "status"]);
    assert.deepEqual(kind!.fields.optional, ["priority", "assignee", "description"]);
    assert.deepEqual(kind!.fields.values.status, ["todo", "in_progress", "blocked", "done", "canceled"]);
    assert.deepEqual(kind!.fields.terminal.status, ["done", "canceled"]);
    assert.equal(
      kind!.description,
      "A concrete unit of work that can be claimed, prioritized, assigned, and completed.",
    );
    assert.deepEqual(Object.keys(kind!.fields.descriptions).sort(), [
      "assignee",
      "description",
      "priority",
      "status",
      "title",
    ]);
    assert.equal(kind!.path, "tasks/");
    assert.equal(kind!.freshnessHorizon, "30d");
    assert.deepEqual(kind!.links, { "depends on": "Task" }, "the seeded Task kind declares its typed-edge vocabulary");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new Task <id> --title --status: creates under tasks/ and validates; an out-of-enum --status is rejected, no write", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await recipe(["add", "work-tracking", "--dir", dir], { stdout: () => {} });

    const created = await runJson(newCommand, ["Task", "demo", "--title", "Demo", "--status", "todo", "--dir", dir]);
    assert.equal(created.id, "tasks/demo");
    assert.equal(created.type, "Task");

    const updated = await runJson(doc, ["update", "tasks/demo", "--status", "in_progress", "--dir", dir]);
    assert.equal(updated.changed, true);
    const readAfter = await runJson(doc, ["read", "tasks/demo", "--dir", dir]);
    assert.equal(readAfter.status, "in_progress");

    await assert.rejects(
      () =>
        doc(["update", "tasks/demo", "--status", "nope", "--dir", dir, "--json"], {
          stdout: () => {},
          readStdin: async () => undefined,
        }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /status/);
        return true;
      },
    );
    // the rejected update must not have written — status stays 'in_progress'.
    const readAfterReject = await runJson(doc, ["read", "tasks/demo", "--dir", dir]);
    assert.equal(readAfterReject.status, "in_progress");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kind-lint neutrality: a work-tracking Task written with --actor persists the actor and produces ZERO kind warnings in `status`", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await recipe(["add", "work-tracking", "--dir", dir], { stdout: () => {} });

    // `new` is STRICT — this create SUCCEEDING already proves the undeclared 'actor' frontmatter key
    // trips no kind warning (validateAgainstKind is not a top-level-key linter; OKF §9 permits
    // undeclared frontmatter). The `status` assertion below pins the same neutrality on the bundle lint.
    const created = await runJson(newCommand, [
      "Task", "attributed", "--title", "Attributed", "--status", "todo", "--actor", "alice", "--dir", dir,
    ]);
    assert.equal(created.id, "tasks/attributed");
    assert.equal("warnings" in created, false, "no kind warnings on the create receipt");

    // A kind-field patch (strict path) with --actor: still green, and the actor is OVERWRITTEN.
    const updated = await runJson(doc, ["update", "tasks/attributed", "--status", "in_progress", "--actor", "bob", "--dir", dir]);
    assert.equal(updated.changed, true);
    assert.equal("warnings" in updated, false, "no kind warnings on the update receipt");
    const read = await runJson(doc, ["read", "tasks/attributed", "--dir", dir]);
    assert.equal(read.actor, "bob", "the update's --actor superseded the create's");

    const health = await runJson(status, ["--dir", dir]);
    assert.equal(health.kind_warnings, 0, "the undeclared 'actor' frontmatter key must trip NO kind lint");
    assert.equal("kind_lint" in health, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add work-tracking: idempotent — second add is changed:false, on-disk bytes unchanged", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const first = await runJson(recipe, ["add", "work-tracking", "--dir", dir]);
    assert.equal(first.changed, true);
    const bytesAfterFirst = await readFile(path.join(dir, "conventions", "task.md"), "utf8");

    const second = await runJson(recipe, ["add", "work-tracking", "--dir", dir]);
    assert.equal(second.changed, false);
    const docsSecond = second.docs as Array<Record<string, unknown>>;
    assert.equal(docsSecond[0]!.changed, false);

    const bytesAfterSecond = await readFile(path.join(dir, "conventions", "task.md"), "utf8");
    assert.equal(bytesAfterSecond, bytesAfterFirst, "a no-op re-add must not touch the on-disk bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── roadmap: the third built-in recipe (work-tracking's companion; first MULTI-DOC built-in) ───

test("recipe add roadmap: applies conventions/roadmap.md AND conventions/roadmap-item.md, frontmatter faithful to the board's hand-authored conventions modulo timestamp", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const result = await runJson(recipe, ["add", "roadmap", "--dir", dir]);
    assert.equal(result.recipe, "added");
    assert.equal(result.id, "roadmap");
    assert.equal(result.version, "1");
    assert.equal(result.source, "builtin:roadmap");
    assert.equal(result.changed, true);
    const docs = result.docs as Array<Record<string, unknown>>;
    assert.equal(docs.length, 2);
    assert.deepEqual(
      docs.map((d) => d.id).sort(),
      ["conventions/roadmap", "conventions/roadmap-item"],
    );
    assert.ok(docs.every((d) => d.changed === true));

    const roadmapRaw = await readFile(path.join(dir, "conventions", "roadmap.md"), "utf8");
    const roadmapParsed = parseMarkdown(roadmapRaw);
    const { timestamp: ts1, ...roadmapRest } = roadmapParsed.frontmatter;
    assert.deepEqual(roadmapRest, {
      type: CONVENTION_TYPE,
      title: "Roadmap",
      governs: "Roadmap",
      links: { contains: "Roadmap Item" },
      fields: { required: ["title"], optional: [] },
    });
    assert.ok(!Number.isNaN(Date.parse(ts1 as string)), `expected a valid ISO timestamp, got ${ts1}`);
    assert.equal(roadmapParsed.body, ROADMAP_SEED_BODY);

    const itemRaw = await readFile(path.join(dir, "conventions", "roadmap-item.md"), "utf8");
    const itemParsed = parseMarkdown(itemRaw);
    const { timestamp: ts2, ...itemRest } = itemParsed.frontmatter;
    assert.deepEqual(itemRest, {
      type: CONVENTION_TYPE,
      title: "Roadmap Item",
      governs: "Roadmap Item",
      path: "roadmap-items/",
      links: { contains: "Task" },
      link_descriptions: { contains: "Tasks whose delivery is governed by this roadmap commitment." },
      fields: {
        required: ["title", "status"],
        optional: ["description", "sequence"],
        values: { status: ["queued", "active", "done"] },
        terminal: { status: ["done"] },
      },
    });
    assert.ok(!Number.isNaN(Date.parse(ts2 as string)), `expected a valid ISO timestamp, got ${ts2}`);
    assert.equal(itemParsed.body, ROADMAP_ITEM_SEED_BODY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kinds: reports Roadmap + Roadmap Item with contains guidance and the item status enum after recipe add roadmap", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await recipe(["add", "roadmap", "--dir", dir], { stdout: () => {} });
    const registry = await loadKinds({ root: dir });

    const roadmapKind = registry.kinds.get("Roadmap");
    assert.ok(roadmapKind);
    assert.deepEqual(roadmapKind!.fields.required, ["title"]);
    assert.deepEqual(roadmapKind!.links, { contains: "Roadmap Item" });
    assert.equal(roadmapKind!.path, undefined, "the spine is one doc, not a scaffolded family");

    const itemKind = registry.kinds.get("Roadmap Item");
    assert.ok(itemKind);
    assert.equal(itemKind!.path, "roadmap-items/");
    assert.deepEqual(itemKind!.links, { contains: "Task" });
    assert.deepEqual(itemKind!.linkDescriptions, {
      contains: "Tasks whose delivery is governed by this roadmap commitment.",
    });
    assert.deepEqual(itemKind!.fields.required, ["title", "status"]);
    assert.deepEqual(itemKind!.fields.optional, ["description", "sequence"]);
    assert.deepEqual(itemKind!.fields.values.status, ["queued", "active", "done"]);
    assert.deepEqual(itemKind!.fields.terminal, { status: ["done"] }, "Roadmap Item declares done as terminal (Brian's ruling)");
    assert.deepEqual(roadmapKind!.fields.terminal, {}, "the spine has no status field, so nothing is terminal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("roadmap terminal consumer: a done Roadmap Item hides from list --open; queued/active stay (Brian's ruling on tasks/status-terminal-declaration)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await recipe(["add", "roadmap", "--dir", dir], { stdout: () => {} });
    const T = "2026-07-01T00:00:00.000Z";
    await writeDoc({ root: dir }, { id: "roadmap-items/queued", frontmatter: { type: "Roadmap Item", title: "Queued", status: "queued", timestamp: T }, body: "" });
    await writeDoc({ root: dir }, { id: "roadmap-items/active", frontmatter: { type: "Roadmap Item", title: "Active", status: "active", timestamp: T }, body: "" });
    await writeDoc({ root: dir }, { id: "roadmap-items/shipped", frontmatter: { type: "Roadmap Item", title: "Shipped", status: "done", timestamp: T }, body: "" });

    let out = "";
    await list(["--type", "Roadmap Item", "--open", "--dir", dir, "--json"], { stdout: (s) => (out += s) });
    const parsed = JSON.parse(out) as { count: number; docs: Array<{ id: string }> };
    assert.equal(parsed.count, 2);
    assert.deepEqual(
      parsed.docs.map((d) => d.id).sort(),
      ["roadmap-items/active", "roadmap-items/queued"],
      "the done item is excluded; queued/active remain open",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add roadmap: idempotent — second add is changed:false, on-disk bytes of BOTH docs unchanged", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const first = await runJson(recipe, ["add", "roadmap", "--dir", dir]);
    assert.equal(first.changed, true);
    const roadmapAfterFirst = await readFile(path.join(dir, "conventions", "roadmap.md"), "utf8");
    const itemAfterFirst = await readFile(path.join(dir, "conventions", "roadmap-item.md"), "utf8");

    const second = await runJson(recipe, ["add", "roadmap", "--dir", dir]);
    assert.equal(second.changed, false);
    const docsSecond = second.docs as Array<Record<string, unknown>>;
    assert.ok(docsSecond.every((d) => d.changed === false));

    assert.equal(await readFile(path.join(dir, "conventions", "roadmap.md"), "utf8"), roadmapAfterFirst);
    assert.equal(await readFile(path.join(dir, "conventions", "roadmap-item.md"), "utf8"), itemAfterFirst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add roadmap: does not disturb a hand-edited conventions/roadmap-item.md — the untouched sibling doc still applies", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "conventions/roadmap-item",
      frontmatter: { type: CONVENTION_TYPE, title: "Roadmap Item", governs: "Roadmap Item", timestamp: T },
      body: "Custom prose the author wrote.",
    });

    const result = await runJson(recipe, ["add", "roadmap", "--dir", dir]);
    // PARTIAL apply: the hand-edited doc loses nothing; the absent sibling is still created.
    assert.equal(result.changed, true);
    const docs = result.docs as Array<Record<string, unknown>>;
    const byId = new Map(docs.map((d) => [d.id, d.changed]));
    assert.equal(byId.get("conventions/roadmap-item"), false, "hand-edited doc must not be clobbered");
    assert.equal(byId.get("conventions/roadmap"), true, "absent sibling must still be created");

    const registry = await loadKinds(bundle);
    const itemKind = registry.kinds.get("Roadmap Item");
    assert.ok(itemKind);
    // The author's declaration (no path, no enum) survives untouched.
    assert.equal(itemKind!.path, undefined);
    assert.equal(itemKind!.fields.values.status, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipes: roadmap applied:false when only ONE of its two docs exists — applied means ALL docs present", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "conventions/roadmap",
      frontmatter: { type: CONVENTION_TYPE, title: "Roadmap", governs: "Roadmap", timestamp: T },
      body: "Hand-authored spine convention only.",
    });

    const before = await runJson(recipes, ["--dir", dir]);
    const rowBefore = (before.recipes as Array<Record<string, unknown>>).find((r) => r.name === "roadmap");
    assert.ok(rowBefore);
    assert.equal(rowBefore!.applied, false, "one-of-two docs present must NOT count as applied");

    await recipe(["add", "roadmap", "--dir", dir], { stdout: () => {} });
    const after = await runJson(recipes, ["--dir", dir]);
    const rowAfter = (after.recipes as Array<Record<string, unknown>>).find((r) => r.name === "roadmap");
    assert.equal(rowAfter!.applied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Roadmap recipe schema fixture ───────────────────────────────────────────────────────────────
//
// This asserts the shipped `roadmap` recipe's loaded kind schema against a committed golden fixture.
// The built-in recipe is authoritative; this repo's board is an applied instance and may intentionally
// diverge, so no live-board parity check is implied or required here. The fixture keeps the test
// hermetic: the old `../../../.agentstate-lite/conventions` read failed in clean checkouts because the
// board branch is mounted only after `aslite sync`. When the recipe schema changes intentionally,
// update this expected fixture with it.

const ROADMAP_SCHEMA_FIXTURE = path.resolve(import.meta.dirname, "fixtures/board-conventions");

test("roadmap recipe schema: loaded kinds match the committed golden fixture", async () => {
  const recipeDir = await tempDir();
  const expectedDir = await tempDir();
  try {
    await initBundle(recipeDir);
    await recipe(["add", "roadmap", "--dir", recipeDir], { stdout: () => {} });

    await initBundle(expectedDir);
    await mkdir(path.join(expectedDir, "conventions"), { recursive: true });
    for (const f of ["roadmap.md", "roadmap-item.md"]) {
      await writeFile(path.join(expectedDir, "conventions", f), await readFile(path.join(ROADMAP_SCHEMA_FIXTURE, f), "utf8"));
    }

    const fromRecipe = await loadKinds({ root: recipeDir });
    const expected = await loadKinds({ root: expectedDir });
    for (const governs of ["Roadmap", "Roadmap Item"]) {
      assert.deepEqual(
        fromRecipe.kinds.get(governs),
        expected.kinds.get(governs),
        `the '${governs}' kind loaded from the built-in recipe must match its committed schema fixture`,
      );
    }
  } finally {
    await rm(recipeDir, { recursive: true, force: true });
    await rm(expectedDir, { recursive: true, force: true });
  }
});

// ── The DOCUMENTED expects_inbound pairing chain — executed literally from the manifest body ───
//
// The roadmap recipe's manifest documents the one-step Task-kind pairing (pull → edit → promote)
// because a recipe's expect-absent CAS can never patch an EXISTING conventions/task doc and
// `kind field` edits only fields.{required,optional,values}. Per the repo's review conventions, a
// documented command chain is pinned by a test that literally runs the emitted strings: this test
// EXTRACTS the two command lines from ROADMAP_DESC_BODY's fenced block, binds the placeholders
// (the out-file path and the `<version from the pull receipt>` token), executes them, and asserts
// the lint the pairing exists to enable actually fires and then clears.

/** Extract the fenced pairing chain from the manifest body: [pullArgv, promoteArgv] templates. */
function pairingChainLines(body: string): string[] {
  const fence = body.match(/```\n([\s\S]*?)```/);
  assert.ok(fence, "the roadmap manifest body must carry the fenced pairing chain");
  return fence![1]!
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

test("pairing chain: the documented pull → edit → promote steps in the roadmap manifest, executed literally, arm Task's expects_inbound and the missing_expected_links lint fires then clears", async () => {
  const dir = await tempDir();
  const work = await tempDir(); // the adopter's scratch dir, OUTSIDE the bundle
  try {
    await initBundle(dir);
    await recipe(["add", "work-tracking", "--dir", dir], { stdout: () => {} });
    await recipe(["add", "roadmap", "--dir", dir], { stdout: () => {} });

    const chain = pairingChainLines(ROADMAP_DESC_BODY);
    assert.equal(chain.length, 2, "the documented chain is exactly two commands (pull, promote)");
    assert.match(chain[0]!, /^superbee pull /);
    assert.match(chain[1]!, /^superbee promote /);
    // The placeholder bindings below assume these exact tokens — assert them BEFORE executing
    // anything, so manifest wording drift fails HERE as a clear assertion rather than silently
    // no-op'ing a .replace() (which would, e.g., pull task.md into the test process cwd).
    assert.match(chain[0]!, /--out task\.md/, "the documented pull must name its out-file 'task.md'");
    assert.match(chain[1]!, /^superbee promote task\.md /, "the documented promote must take 'task.md' as its file");
    assert.match(chain[1]!, /<version from the pull receipt>/, "the documented promote must carry the version placeholder");

    // Step 1 — the documented pull, out-path bound to the scratch dir.
    const outFile = path.join(work, "task.md");
    const pullArgv = chain[0]!
      .replace(/^superbee pull /, "")
      .replace("--out task.md", `--out ${outFile}`)
      .split(/\s+/);
    const pullReceipt = await runJson(pull, [...pullArgv, "--dir", dir]);
    const version = pullReceipt.version as string;
    assert.ok(version, "the pull receipt must carry the CAS version token the chain relies on");

    // Step 2 — the documented edit: add the two expects_inbound lines to the frontmatter.
    const pulled = await readFile(outFile, "utf8");
    assert.ok(!pulled.includes("expects_inbound"), "work-tracking's Task must NOT pre-declare the pairing");
    await writeFile(outFile, pulled.replace("\nfields:", "\nexpects_inbound:\n  contains: Roadmap Item\nfields:"));

    // Step 3 — the documented promote, placeholders bound (file path + version token).
    const promoteArgv = chain[1]!
      .replace(/^superbee promote task\.md /, `${outFile} `)
      .replace("<version from the pull receipt>", version)
      .split(/\s+/);
    const promoted = await runJson(promote, [...promoteArgv, "--dir", dir]);
    assert.equal(promoted.id, "conventions/task");

    // The pairing is armed: Task now expects an inbound `contains` from a Roadmap Item.
    const registry = await loadKinds({ root: dir });
    assert.deepEqual(registry.kinds.get("Task")!.expectsInbound, { contains: "Roadmap Item" });

    // An unowned task trips the lint …
    await runJson(newCommand, ["Task", "demo", "--title", "Demo", "--status", "todo", "--dir", dir]);
    const unowned = await runJson(status, ["--dir", dir]);
    assert.equal(unowned.missing_expected_links, 1);
    const rows = (unowned.missing_expected_links_rows as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows[0]!.id, "tasks/demo");
    assert.deepEqual(rows[0]!.missing, ["contains"]);

    // … and an owning Roadmap Item's typed `contains` link clears it.
    await runJson(newCommand, ["Roadmap Item", "item-1", "--title", "Item 1", "--status", "active", "--dir", dir]);
    await runJson(link, ["add", "roadmap-items/item-1", "tasks/demo", "--text", "contains", "--dir", dir]);
    const owned = await runJson(status, ["--dir", dir]);
    assert.equal(owned.missing_expected_links, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("gate 3 / conventions-free: init's default does NOT install roadmap — a bundle stays roadmap-free until it opts in", async () => {
  const dir = await tempDir();
  try {
    await init(["--dir", dir], { stdout: () => {} });
    const registry = await loadKinds({ root: dir });
    assert.equal(registry.kinds.has("Roadmap"), false);
    assert.equal(registry.kinds.has("Roadmap Item"), false);
    await assert.rejects(() => readFile(path.join(dir, "conventions", "roadmap.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Row 2: external loads+applies through the SAME path ───────────────────────────────────────

test("recipe add <path>: an EXTERNAL recipe folder loads via filesRecipeSource -> parseRecipeFiles -> applyRecipe, the SAME functions as the built-in", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const result = await runJson(recipe, ["add", EXAMPLE_RECIPE_FIXTURE, "--dir", dir]);
    assert.equal(result.recipe, "added");
    assert.equal(result.id, "example");
    assert.equal(result.version, "1");
    assert.equal(result.source, EXAMPLE_RECIPE_FIXTURE);
    assert.equal(result.changed, true);
    const docs = result.docs as Array<Record<string, unknown>>;
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.id, "conventions/example-term");

    const raw = await readFile(path.join(dir, "conventions", "example-term.md"), "utf8");
    const { frontmatter } = parseMarkdown(raw);
    assert.equal(frontmatter.type, CONVENTION_TYPE);
    assert.equal(frontmatter.governs, "Term");

    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    assert.ok(registry.kinds.has("Term"), "kinds must report the new governs after an external recipe apply");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyRecipe carries serialized Claim lifecycle descriptions through the ordinary recipe path", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const claim: KindConvention = {
      id: "conventions/claim",
      title: "Claim",
      governs: "Claim",
      fields: {
        required: ["title", "status", "reason"],
        optional: [],
        values: { status: ["active", "challenged", "locked", "deprecated"] },
        valueDescriptions: {
          status: {
            active: "Supported, but still open to revision.",
            challenged: "Contrary evidence or reasoning requires resolution.",
            locked: "Verified at the required standard for downstream reliance.",
            deprecated: "Retained for history but not for new reliance.",
          },
        },
        terminal: {},
        descriptions: {},
      },
    };
    const result = await applyRecipe(
      { root: dir },
      {
        id: "described-claims",
        title: "Described Claims",
        version: "1",
        summary: "Test-only Claim lifecycle semantics.",
        source: "test",
        docs: [kindConventionDoc(claim, "", T)],
        pages: [],
        references: [],
        governs: ["Claim"],
        warnings: [],
      },
      T,
    );
    assert.equal(result.changed, true);
    const registry = await loadKinds({ root: dir });
    assert.deepEqual(registry.kinds.get("Claim")?.fields.valueDescriptions, claim.fields.valueDescriptions);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recipe carrying a type View pair under views-registry//views/ parses and APPLIES — doc + blob land intact", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const files: RecipeFile[] = [
      {
        path: "recipe.md",
        bytes:
          '---\ntype: Recipe\nid: view-recipe\ntitle: View recipe\nversion: "1"\nsummary: A View-kind package.\n' +
          "content_policy: definitions-only\npages:\n  - registry: views-registry/board.md\n    entry: views/board.html\n---\n",
      },
      { path: "conventions/term.md", bytes: "---\ntype: Convention\ngoverns: Term\n---\n# Term\n" },
      { path: "views-registry/board.md", bytes: "---\ntype: View\ntitle: Board\nentry: views/board.html\naccess: bundle-read\n---\nA board view.\n" },
      { path: "views/board.html", bytes: "<!doctype html><title>Board</title>" },
    ];
    const loaded = parseRecipeFiles(files, "test:view-recipe");
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error.message);
    if (!loaded.ok) return;

    const result = await applyRecipe({ root: dir }, loaded.recipe, T);
    assert.equal(result.changed, true);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]!.registry_id, "views-registry/board");
    assert.equal(result.pages[0]!.entry, "views/board.html");

    const raw = await readFile(path.join(dir, "views-registry", "board.md"), "utf8");
    const { frontmatter } = parseMarkdown(raw);
    assert.equal(frontmatter.type, "View");
    assert.equal(frontmatter.entry, "views/board.html");
    const blob = await readBlob({ root: dir }, "views/board.html");
    assert.equal(Buffer.from(blob!.bytes).toString("utf8"), "<!doctype html><title>Board</title>");

    // Idempotent + preflight-parity: a second apply is changed:false (the views-registry/ prefix
    // is covered by the existing-registry preflight, so an identical re-apply never conflicts).
    const second = await applyRecipe({ root: dir }, loaded.recipe, T);
    assert.equal(second.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("View registry access field: 'access:' is read under its own name; a bridge-only registry doc REJECTS (the legacy spelling is no longer read), and a present-but-invalid access rejects even beside a valid bridge", () => {
  const recipeFiles = (registryFrontmatter: string): RecipeFile[] => [
    {
      path: "recipe.md",
      bytes:
        '---\ntype: Recipe\nid: view-recipe\ntitle: View recipe\nversion: "1"\nsummary: A View-kind package.\n' +
        "content_policy: definitions-only\npages:\n  - registry: views-registry/board.md\n    entry: views/board.html\n---\n",
    },
    { path: "conventions/term.md", bytes: "---\ntype: Convention\ngoverns: Term\n---\n# Term\n" },
    { path: "views-registry/board.md", bytes: `---\ntype: View\ntitle: Board\nentry: views/board.html\n${registryFrontmatter}---\nA board view.\n` },
    { path: "views/board.html", bytes: "<!doctype html><title>Board</title>" },
  ];

  const current = parseRecipeFiles(recipeFiles("access: bundle-read\n"), "test:view-access");
  assert.equal(current.ok, true, current.ok ? "" : current.error.message);

  // REJECTION PIN (tasks/remove-legacy-page-bridge-support): a bridge-only registry doc no
  // longer parses — the legacy spelling is invisible to declaredAccessValue, so the recipe is
  // told to declare `access`, never silently installed as a capability-less View.
  const bridgeOnly = parseRecipeFiles(recipeFiles("bridge: bundle-read\n"), "test:view-bridge-only");
  assert.equal(bridgeOnly.ok, false, "a bridge-only registry doc must be RECIPE_MALFORMED now");
  if (!bridgeOnly.ok) {
    assert.equal(bridgeOnly.error.code, "RECIPE_MALFORMED");
    assert.match(bridgeOnly.error.message, /needs access:/);
    assert.match(bridgeOnly.error.message, /no longer read/);
  }

  const invalidAccess = parseRecipeFiles(recipeFiles("access: bundle-write\nbridge: bundle-read\n"), "test:view-access-invalid");
  assert.equal(invalidAccess.ok, false);
  if (!invalidAccess.ok) {
    assert.equal(invalidAccess.error.code, "RECIPE_MALFORMED");
    assert.match(invalidAccess.error.message, /needs access:/);
  }
});

// ── Row 3: idempotency (external arm) ──────────────────────────────────────────────────────────

test("recipe add <path>: idempotent — second add of the SAME external recipe is changed:false, bytes unchanged", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const first = await runJson(recipe, ["add", EXAMPLE_RECIPE_FIXTURE, "--dir", dir]);
    assert.equal(first.changed, true);
    const bytesAfterFirst = await readFile(path.join(dir, "conventions", "example-term.md"), "utf8");

    const second = await runJson(recipe, ["add", EXAMPLE_RECIPE_FIXTURE, "--dir", dir]);
    assert.equal(second.changed, false);
    const docsSecond = second.docs as Array<Record<string, unknown>>;
    assert.equal(docsSecond[0]!.changed, false);

    const bytesAfterSecond = await readFile(path.join(dir, "conventions", "example-term.md"), "utf8");
    assert.equal(bytesAfterSecond, bytesAfterFirst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable Review Workflow: clean-room install carries Kinds, a View, and its authoring Reference but zero Review Request instances", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const first = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal(first.id, "review-workflow");
    assert.equal(first.changed, true);
    const pages = first.pages as Array<Record<string, unknown>>;
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.registry_id, "views-registry/review-workflow-reviews");
    assert.equal(pages[0]!.entry, "views/review-workflow/reviews.html");
    assert.equal(pages[0]!.registry_changed, true);
    assert.equal(pages[0]!.entry_changed, true);
    const references = first.references as Array<Record<string, unknown>>;
    assert.deepEqual(references, [{ id: "references/view-authoring-v0", changed: true }]);

    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    const reviewKind = registry.kinds.get("Review Request");
    assert.ok(reviewKind);
    assert.match(reviewKind!.description ?? "", /durable request/);
    assert.match(reviewKind!.fields.valueDescriptions.status?.approved ?? "", /terminal/);

    const pageKind = registry.kinds.get("View");
    assert.ok(pageKind);
    assert.equal(pageKind!.path, "views-registry/");
    assert.deepEqual(pageKind!.fields.required, ["title", "entry", "access"]);
    assert.deepEqual(pageKind!.fields.optional, ["description", "entry_version", "presentation"], "the shipped convention no longer declares legacy `bridge`");
    assert.deepEqual(pageKind!.fields.values.access, ["none", "bundle-read", "bundle-propose"]);
    assert.deepEqual(pageKind!.fields.values.presentation, ["workspace", "inline", "adaptive"]);
    assert.equal(pageKind!.fields.values.bridge, undefined);

    const pageDefinitions = await runJson(list, ["--type", "View", "--dir", dir]);
    assert.equal(pageDefinitions.count, 1, "the package carries exactly its declared View definition");
    assert.equal((pageDefinitions.docs as Array<Record<string, unknown>>)[0]!.id, "views-registry/review-workflow-reviews");

    const installedReference = await readFile(path.join(dir, "references", "view-authoring-v0.md"), "utf8");
    const parsedReference = parseMarkdown(installedReference);
    assert.equal(parsedReference.frontmatter.type, "Reference");
    assert.equal(parsedReference.frontmatter.protocol, "v0+v1");
    assert.match(parsedReference.body, /does not depend on an agent-harness skill/);
    const installedPageConvention = await readFile(path.join(dir, "conventions", "view.md"), "utf8");
    assert.match(installedPageConvention, /\.\.\/references\/view-authoring-v0\.md/);

    const before = await runJson(list, ["--type", "Review Request", "--dir", dir]);
    assert.equal(before.count, 0, "the package must not carry source Review Request instances");

    const created = await runJson(newCommand, [
      "Review Request",
      "portable-check",
      "--title",
      "Portable check",
      "--status",
      "requested",
      "--reviewer",
      "Brian",
      "--requested_by",
      "Mike",
      "--question",
      "Does this operating model transfer without data?",
      "--dir",
      dir,
    ]);
    assert.equal(created.id, "review-requests/portable-check");
    await assert.rejects(
      () =>
        runJson(newCommand, [
          "Review Request",
          "invalid-state",
          "--title",
          "Invalid",
          "--status",
          "invented",
          "--reviewer",
          "Brian",
          "--requested_by",
          "Mike",
          "--question",
          "Should fail",
          "--dir",
          dir,
        ]),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );

    const htmlBefore = await readFile(path.join(dir, "views", "review-workflow", "reviews.html"), "utf8");
    const registryBefore = await readFile(
      path.join(dir, "views-registry", "review-workflow-reviews.md"),
      "utf8",
    );
    const second = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal(second.changed, false);
    const secondPages = second.pages as Array<Record<string, unknown>>;
    assert.equal(secondPages[0]!.registry_changed, false);
    assert.equal(secondPages[0]!.entry_changed, false);
    assert.deepEqual(second.references, [{ id: "references/view-authoring-v0", changed: false }]);
    assert.equal(await readFile(path.join(dir, "views", "review-workflow", "reviews.html"), "utf8"), htmlBefore);
    assert.equal(
      await readFile(path.join(dir, "views-registry", "review-workflow-reviews.md"), "utf8"),
      registryBefore,
    );
    assert.equal(await readFile(path.join(dir, "references", "view-authoring-v0.md"), "utf8"), installedReference);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Phase 2a consequence pin (tasks/migrate-legacy-page-bridge-stock): the shipped View convention
// no longer declares legacy `bridge`, so on a FRESH bundle `new "View" --access …` authors
// cleanly while `--bridge` is an unknown-field USAGE error — the authoring surface teaches only
// the current name.
test("fresh bundle with the shipped View convention: new --access works, legacy --bridge is an unknown field", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);

    const created = await runJson(newCommand, [
      "View",
      "fresh-dash",
      "--title",
      "Fresh dash",
      "--entry",
      "views/fresh-dash.html",
      "--access",
      "none",
      "--dir",
      dir,
    ]);
    assert.equal(created.id, "views-registry/fresh-dash");
    assert.equal(created.hint, undefined, "authoring the CURRENT kind name must not trip the legacy hint");

    await assert.rejects(
      () =>
        runJson(newCommand, [
          "View",
          "legacy-dash",
          "--title",
          "Legacy dash",
          "--entry",
          "views/legacy-dash.html",
          "--bridge",
          "none",
          "--dir",
          dir,
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /unknown field\(s\) for kind 'View'.*bridge/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable recipe preflights a different operating Reference before writing any package artifact", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "references/view-authoring-v0",
      frontmatter: { type: "Reference", title: "Local guide", timestamp: T },
      body: "Bundle-owned guidance that differs from the portable package.\n",
    });
    await assert.rejects(
      () => runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "ALREADY_EXISTS");
        assert.match(err.message, /references\/view-authoring-v0\.md/);
        return true;
      },
    );
    assert.equal(await readBlob(bundle, "views/review-workflow/reviews.html"), null);
    await assert.rejects(() => readFile(path.join(dir, "conventions", "review-request.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable recipe refuses a different existing View blob without overwriting it", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    const existing = Buffer.from("<p>bundle author's page</p>");
    await writeBlob(bundle, "views/review-workflow/reviews.html", existing, "text/html; charset=utf-8");
    await assert.rejects(
      () => runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "ALREADY_EXISTS");
        assert.match(err.message, /existing bundle content was left untouched/);
        return true;
      },
    );
    const after = await readBlob(bundle, "views/review-workflow/reviews.html");
    assert.ok(after);
    assert.equal(Buffer.from(after!.bytes).toString("utf8"), existing.toString("utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable recipe preflights a different View registry before writing any package artifact", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "views-registry/review-workflow-reviews",
      frontmatter: {
        type: "View",
        title: "Bundle author's reviews",
        entry: "views/review-workflow/reviews.html",
        bridge: "none",
        timestamp: T,
      },
      body: "Different local definition.\n",
    });
    await assert.rejects(
      () => runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]),
      (err: unknown) => err instanceof CliError && err.code === "ALREADY_EXISTS",
    );
    assert.equal(await readBlob(bundle, "views/review-workflow/reviews.html"), null);
    await assert.rejects(() => readFile(path.join(dir, "conventions", "review-request.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Row 4: conflict surfaced ────────────────────────────────────────────────────────────────────

test("recipe add: a DIFFERENT doc already governing the same type -> CAS never overwrites; KIND_DUPLICATE_GOVERNS surfaced in the receipt warnings", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    // A hand-authored doc that ALSO governs 'Term', at a DIFFERENT id than the recipe's own.
    await writeDoc(bundle, {
      id: "conventions/my-term",
      frontmatter: { type: CONVENTION_TYPE, governs: "Term", timestamp: T },
      body: "Hand-authored, pre-existing.",
    });

    const result = await runJson(recipe, ["add", EXAMPLE_RECIPE_FIXTURE, "--dir", dir]);
    // The recipe's own doc (conventions/example-term) did not exist yet, so its own CAS write wins.
    assert.equal(result.changed, true);
    const docs = result.docs as Array<Record<string, unknown>>;
    assert.equal(docs[0]!.changed, true);

    // Both docs now exist on disk (CAS never overwrites — it only guards create-vs-exists at the
    // SAME id), but the registry keeps the first-declared 'Term' and warns about the shadowed one.
    const warnings = result.warnings as Array<Record<string, unknown>>;
    assert.ok(warnings, "expected a warnings array on the receipt");
    const dup = warnings.find((w) => w.code === "KIND_DUPLICATE_GOVERNS");
    assert.ok(dup, `expected a KIND_DUPLICATE_GOVERNS warning, got ${JSON.stringify(warnings)}`);

    // loadKinds' query results are id-sorted; 'conventions/example-term' sorts before
    // 'conventions/my-term', so the FIRST-BY-ID declaration that wins is the recipe's own doc,
    // not the hand-authored one — exactly what the existing loadKinds machinery already does,
    // with no new conflict-resolution logic added by this unit.
    const registry = await loadKinds(bundle);
    assert.equal(registry.kinds.get("Term")!.id, "conventions/example-term", "first-by-id declaration wins");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Row 5: malformed manifest / not-found / empty -> structured CliError, no stack ─────────────

test("recipe add: an unknown recipe name is a USAGE error naming known recipes", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await assert.rejects(
      () => recipe(["add", "bogus-recipe", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /unknown recipe 'bogus-recipe'/);
        assert.match(err.message, /context-notes/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add <path>: a nonexistent folder -> RECIPE_NOT_FOUND, mapped to CliError USAGE exit 2", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await assert.rejects(
      () => recipe(["add", "./nope-does-not-exist", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe add <path>: a folder missing recipe.md -> RECIPE_MALFORMED, mapped to CliError USAGE exit 2, message names recipe.md", async () => {
  const dir = await tempDir();
  const badFolder = await tempDir();
  try {
    await initBundle(dir);
    // badFolder exists but has no recipe.md — a deliberately malformed external recipe.
    await assert.rejects(
      () => recipe(["add", badFolder, "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /recipe\.md/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(badFolder, { recursive: true, force: true });
  }
});

test("init --recipe <path>: works with no extra code — same resolveRecipe seam as recipe add", async () => {
  const dir = await tempDir();
  try {
    const result = await runJson(init, ["--dir", dir, "--recipe", EXAMPLE_RECIPE_FIXTURE]);
    assert.equal(result.recipe, "example");
    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    assert.ok(registry.kinds.has("Term"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Row 7: conventions-free / gate-3 unaffected ────────────────────────────────────────────────

test("init --recipe none: a conventions-free bundle, unaffected — kinds registry empty, byte-for-byte as an external bundle", async () => {
  const dir = await tempDir();
  try {
    const result = await runJson(init, ["--dir", dir, "--recipe", "none"]);
    assert.equal(result.recipe, "none");
    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    assert.equal(registry.kinds.size, 0);
    await assert.rejects(() => readFile(path.join(dir, "conventions", "context-note.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init: default (no --recipe) applies context-notes, reports recipe:context-notes", async () => {
  const dir = await tempDir();
  try {
    const result = await runJson(init, ["--dir", dir]);
    assert.equal(result.recipe, "context-notes");
    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    assert.equal(registry.kinds.size, 1);
    assert.ok(registry.kinds.has("Context Note"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init receipt recommends Context Note creation only when the selected recipe declares it", async () => {
  const rows: Array<{
    recipe?: string;
    recommendsContextNote: boolean;
    recommendsKinds: boolean;
  }> = [
    { recommendsContextNote: true, recommendsKinds: false },
    { recipe: "context-notes", recommendsContextNote: true, recommendsKinds: false },
    { recipe: "work-tracking", recommendsContextNote: false, recommendsKinds: true },
    { recipe: "roadmap", recommendsContextNote: false, recommendsKinds: true },
    { recipe: EXAMPLE_RECIPE_FIXTURE, recommendsContextNote: false, recommendsKinds: true },
    { recipe: "none", recommendsContextNote: false, recommendsKinds: false },
  ];

  for (const row of rows) {
    const dir = await tempDir();
    try {
      const args = ["--dir", dir];
      if (row.recipe !== undefined) args.push("--recipe", row.recipe);
      const result = await runJson(init, args);
      const help = result.help as string[];
      const target = ` --dir ${shellArg(path.resolve(dir))}`;

      assert.equal(
        help.some((entry) => entry.includes('new "Context Note"')),
        row.recommendsContextNote,
        `Context Note help for recipe ${row.recipe ?? "<default>"}`,
      );
      assert.equal(
        help.some((entry) => entry.startsWith(`${cliInvocation()} kinds`)),
        row.recommendsKinds,
        `kinds help for recipe ${row.recipe ?? "<default>"}`,
      );
      assert.ok(help.some((entry) => entry.startsWith(`${cliInvocation()} recipes`)));
      assert.ok(
        help.every((entry) => entry.endsWith(target)),
        `every follow-up must retain the explicit target for recipe ${row.recipe ?? "<default>"}: ${help.join(" | ")}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("init: an unknown --recipe name is a USAGE error", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => init(["--dir", dir, "--recipe", "bogus", "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /unknown recipe 'bogus'/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status coupling WITH the recipe: an old Context Note is reported stale under the applied 24h horizon (there is no bespoke note command anymore — status is the surviving generic freshness surface)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await applyRecipe({ root: dir }, CONTEXT_NOTES_RECIPE);
    const bundle: Bundle = { root: dir };
    const oldTs = new Date(Date.now() - 25 * 3_600_000).toISOString(); // 25h old > 24h horizon
    await writeDoc(bundle, {
      id: "context-notes/old",
      frontmatter: { type: "Context Note", title: "old", timestamp: oldTs },
      body: "# Summary\n\nStale by the applied recipe's horizon.\n",
    });
    const result = await runJson(status, ["--dir", dir]);
    assert.equal(result.stale, 1);
    const staleDocs = result.stale_docs as { rows: Array<Record<string, unknown>> };
    assert.equal(staleDocs.rows[0]!.id, "context-notes/old");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status coupling WITHOUT the recipe: the same old Context Note is NOT reported stale — no horizon declared, no kind to feed one", async () => {
  const dir = await tempDir();
  try {
    await init(["--dir", dir, "--recipe", "none"], { stdout: () => {} });
    const bundle: Bundle = { root: dir };
    const oldTs = new Date(Date.now() - 25 * 3_600_000).toISOString(); // 25h old, but no kind horizon here
    await writeDoc(bundle, {
      id: "context-notes/old",
      frontmatter: { type: "Context Note", title: "old", timestamp: oldTs },
      body: "# Summary\n\nNo horizon in a conventions-free bundle.\n",
    });
    const result = await runJson(status, ["--dir", dir]);
    assert.equal(result.stale, 0);
    assert.equal(result.kinds, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Fork-4 generic-path parity proof: deleting the note command must not make an existing
// Context Note unreadable/uneditable, and the generic `new` verb must still create a governed one.

test("Fork-4: an EXISTING type:Context Note doc (written before the note command existed, or by any external producer) still reads via 'doc read' and patches via 'doc update' after the note command's deletion", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await applyRecipe({ root: dir }, CONTEXT_NOTES_RECIPE);
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "context-notes/legacy",
      frontmatter: { type: "Context Note", title: "legacy", timestamp: T },
      body: "# Summary\n\nOld note.\n",
    });

    const read = await runJson(doc, ["read", "context-notes/legacy", "--dir", dir]);
    assert.equal(read.title, "legacy");
    assert.equal(read.body, "# Summary\n\nOld note.\n");

    const updated = await runJson(doc, ["update", "context-notes/legacy", "--title", "legacy-2", "--dir", dir]);
    assert.equal(updated.changed, true);

    const readAfter = await runJson(doc, ["read", "context-notes/legacy", "--dir", dir]);
    assert.equal(readAfter.title, "legacy-2");
    assert.equal(readAfter.body, "# Summary\n\nOld note.\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fork-4: 'new \"Context Note\" <id>' creates a governed instance under the recipe's declared path, satisfying the kind (no --timestamp needed — the mutation pipeline auto-stamps it before strict validation)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await applyRecipe({ root: dir }, CONTEXT_NOTES_RECIPE);

    const created = await runJson(newCommand, ["Context Note", "cycle-x", "--title", "cycle-x", "--dir", dir]);
    assert.equal(created.id, "context-notes/cycle-x");
    assert.equal(created.type, "Context Note");
    assert.ok(created.timestamp, "timestamp must be auto-stamped, not require --timestamp");

    const read = await runJson(doc, ["read", "context-notes/cycle-x", "--dir", dir]);
    assert.equal(read.body, "# Summary\n");

    const listed = await runJson(list, ["--type", "Context Note", "--dir", dir]);
    assert.equal(listed.count, 1);
    const rows = listed.docs as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.id, "context-notes/cycle-x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--remote: recipe add against a served bundle, idempotent parity with the same operation run locally", async () => {
  const localDir = await tempDir();
  const remoteDir = await tempDir();
  try {
    await initBundle(localDir);
    await initBundle(remoteDir);
    const handle: ServerHandle = await serve({ bundle: { root: remoteDir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const localAdd = await runJson(recipe, ["add", "context-notes", "--dir", localDir]);
      const remoteAdd = await runJson(recipe, ["add", "context-notes", "--remote", url]);
      assert.equal(remoteAdd.changed, true);
      assert.equal(localAdd.id, remoteAdd.id);

      // Second add over --remote is a changed:false no-op, same as local.
      const remoteAddAgain = await runJson(recipe, ["add", "context-notes", "--remote", url]);
      assert.equal(remoteAddAgain.changed, false);

      const localRecipes = await runJson(recipes, ["--dir", localDir]);
      const remoteRecipes = await runJson(recipes, ["--remote", url]);
      assert.equal(remoteRecipes.count, localRecipes.count);
      const remoteRows = remoteRecipes.recipes as Array<Record<string, unknown>>;
      const localRows = localRecipes.recipes as Array<Record<string, unknown>>;
      assert.deepEqual(
        remoteRows.map(({ commands: _, ...row }) => row),
        localRows.map(({ commands: _, ...row }) => row),
      );
      assert.deepEqual(remoteRows[0]!.commands, {
        add_to_bundle: `${cliInvocation()} recipe add context-notes --remote '${url}'`,
      });
      assert.deepEqual(remoteRecipes.help, [
        `${cliInvocation()} recipe add <name-or-path> --remote '${url}'`,
      ]);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});

test("--remote: portable recipe installs and rechecks its Page pair through the storage seam", async () => {
  const remoteDir = await tempDir();
  try {
    await initBundle(remoteDir);
    const handle: ServerHandle = await serve({ bundle: { root: remoteDir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const first = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--remote", url]);
      assert.equal(first.changed, true);
      const pages = first.pages as Array<Record<string, unknown>>;
      assert.equal(pages[0]!.entry_changed, true);
      assert.equal(pages[0]!.registry_changed, true);

      const second = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--remote", url]);
      assert.equal(second.changed, false);
      const secondPages = second.pages as Array<Record<string, unknown>>;
      assert.equal(secondPages[0]!.entry_changed, false);
      assert.equal(secondPages[0]!.registry_changed, false);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(remoteDir, { recursive: true, force: true });
  }
});

// ── The SHIPPED example recipe (examples/recipes/claims) — a drift gate for the public example ──

const SHIPPED_CLAIMS_RECIPE = path.resolve(import.meta.dirname, "../../../examples/recipes/claims");

test("SHIPPED example recipe (examples/recipes/claims): applies cleanly, declares the Claim kind with the full lifecycle enum, and is idempotent — the repo's public example cannot rot", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const result = await runJson(recipe, ["add", SHIPPED_CLAIMS_RECIPE, "--dir", dir]);
    assert.equal(result.recipe, "added");
    assert.equal(result.id, "claims");
    assert.equal(result.version, "1.0.0");
    assert.equal(result.changed, true);
    const docs = result.docs as Array<Record<string, unknown>>;
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.id, "conventions/claim");

    const bundle: Bundle = { root: dir };
    const registry = await loadKinds(bundle);
    const claim = registry.kinds.get("Claim");
    assert.ok(claim, "the Claim kind must be declared after applying the shipped example recipe");
    assert.deepEqual(claim!.fields.required, ["title", "status", "reason"]);
    assert.deepEqual(claim!.fields.values?.status, ["active", "challenged", "locked", "deprecated"]);
    assert.deepEqual(claim!.links, { supersedes: "Claim" }, "the example recipe declares the supersession edge type");

    const again = await runJson(recipe, ["add", SHIPPED_CLAIMS_RECIPE, "--dir", dir]);
    assert.equal(again.changed, false, "re-applying the shipped recipe must be an idempotent no-op");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── North star: one vocabulary in fresh bundles (decisions/single-vocabulary-north-star) ───────

/**
 * THE north-star teaching scan (decisions/single-vocabulary-north-star): no doc in `docs` may
 * carry the transitional acceptance story, an unlabeled `Page` kind word, or the bare `bridge`
 * FIELD taught as current. Mechanism names are non-competing and pass (the postMessage bridge
 * channel, `bridge: "v0"` wire frames, open-page/pageId, prefix grammars). Shared by the fresh-
 * bundle pin below and the migrated-historical-install pin (review F2).
 */
function assertTeachesNoLegacyVocabulary(docs: Array<{ id: string; frontmatter: Record<string, unknown>; body: string }>): void {
  const transitional = [/migration window/i, /still resolve/i, /keep working/i, /planned later phase/i, /still honored/i];
  for (const doc of docs) {
    const text = `${JSON.stringify(doc.frontmatter)}\n${doc.body}`;
    for (const phrase of transitional) {
      assert.doesNotMatch(text, phrase, `${doc.id} carries transitional legacy-acceptance wording`);
    }
    doc.body.split("\n").forEach((line, i) => {
      if (/\bPages?\b/.test(line) && !/legacy/i.test(line)) {
        assert.fail(`${doc.id}:${i + 1} teaches 'Page' as current (no "legacy" on the line): ${line.trim()}`);
      }
      if (/`bridge`/.test(line) && !/legacy/i.test(line)) {
        assert.fail(`${doc.id}:${i + 1} teaches the 'bridge' field as current: ${line.trim()}`);
      }
    });
  }
}

test("NORTH STAR: a FRESH bundle built from the shipped recipes (review-workflow included) teaches no legacy vocabulary as current", async () => {
  // Acceptance pin for decisions/single-vocabulary-north-star (Brian, 2026-07-24): a newly
  // installed bundle never introduces Page/bridge as current vocabulary. This pin is red on the
  // pre-phase-3 reference text ("type: Page docs still resolve during the migration window…")
  // and green on the post-removal wording.
  const dir = await tempDir();
  try {
    await runJson(init, ["--dir", dir]); // the default context-notes recipe
    await runJson(recipe, ["add", "work-tracking", "--dir", dir]);
    await runJson(recipe, ["add", "roadmap", "--dir", dir]);
    await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);

    const docs = await query({ root: dir }, {});
    // The surfaces this pin exists for really installed (a silent skip must not fake a pass).
    assert.ok(docs.some((d) => d.id === "conventions/view"), "the View convention installed");
    assert.ok(docs.some((d) => d.id === "references/view-authoring-v0"), "the authoring reference installed");
    assertTeachesNoLegacyVocabulary(docs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Legacy-alias awareness (plans/rename-page-kind-to-view, Option C+ — fix round 2; removal
// phase tasks/remove-legacy-page-bridge-support) ───────────────────────────────────────────────
// The renamed recipe keeps id/version but renames every artifact id; per-artifact expect-absent
// idempotency alone would give a bundle carrying the LEGACY v1 install a complete second set —
// two identical launcher cards once that bundle is migrated in place (migration keeps legacy
// LOCATIONS). The legacy install SATISFIES the requirement: applyRecipe probes each artifact's
// legacy-alias counterpart and skips creation when it exists. Post-removal the legacy fixture can
// no longer install through `recipe add` (its Page-typed registry doc is RECIPE_MALFORMED —
// pinned below), so the legacy install state is seeded directly.

const LEGACY_REVIEW_WORKFLOW_V1 = path.resolve(import.meta.dirname, "fixtures/review-workflow-legacy-v1");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const MIGRATION_SCRIPT = path.join(REPO_ROOT, "scripts", "migrate-legacy-view-names.mjs");
const execFileAsync = promisify(execFile);

/** Emulate the launcher's listing with THE one registration predicate (core `parseRegistration`)
 * over both accepted registry prefixes — the same authority `listPages`/the nonce mint consume. */
async function usableRegistrations(bundle: Bundle) {
  const docs = [
    ...(await query(bundle, { prefix: PAGE_REGISTRY_PREFIX })),
    ...(await query(bundle, { prefix: VIEW_REGISTRY_PREFIX })),
  ];
  return docs.map((doc) => parseRegistration(doc.id, doc.frontmatter)).filter((r) => r !== null);
}

/** Seed the exact artifact state the legacy v1 `recipe add` used to leave behind (vendored
 * fixture content: Page-typed registration under the legacy locations + conventions/page +
 * conventions/review-request + the historical Page-authoring reference — the COMPLETE install,
 * review F2). */
async function seedLegacyV1Install(bundle: Bundle): Promise<void> {
  const T = "2026-07-01T00:00:00.000Z";
  const seedDoc = async (relative: string, id: string): Promise<void> => {
    const bytes = await readFile(path.join(LEGACY_REVIEW_WORKFLOW_V1, relative), "utf8");
    const { frontmatter, body } = parseMarkdown(bytes);
    await writeDoc(bundle, { id, frontmatter: { ...frontmatter, timestamp: T }, body });
  };
  await seedDoc("conventions/page.md", "conventions/page");
  await seedDoc("conventions/review-request.md", "conventions/review-request");
  await seedDoc("pages-registry/review-workflow-reviews.md", "pages-registry/review-workflow-reviews");
  await seedDoc("references/page-authoring-v0.md", "references/page-authoring-v0");
  const html = await readFile(path.join(LEGACY_REVIEW_WORKFLOW_V1, "pages/review-workflow/reviews.html"), "utf8");
  await writeBlob(bundle, "pages/review-workflow/reviews.html", new TextEncoder().encode(html), "text/html; charset=utf-8");
}

test("MID-VINTAGE (round-2 P1): a bundle carrying the known transitional view-authoring reference at its renamed id migrates CLEAN — the real script refreshes it, and no remaining doc teaches legacy names as current", async () => {
  // The reviewer's exact fixture: the known shipped TRANSITIONAL references/view-authoring-v0
  // (extracted from 8192269^, frozen with provenance under
  // scripts/prior-shipped-view-authoring-references/) installed at its already-renamed id.
  // Pre-fix the script exited 0 with NO warnings and left it teaching "still resolve during the
  // migration window" — an official migration's known-input postcondition is not optional.
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    const frozen = await readFile(
      path.join(REPO_ROOT, "scripts/prior-shipped-view-authoring-references/7-2901497-phase2a-transitional.md"),
      "utf8",
    );
    const { frontmatter, body } = parseMarkdown(frozen);
    assert.match(body, /migration window/, "the frozen form really is the transitional teaching");
    await writeDoc(bundle, { id: "references/view-authoring-v0", frontmatter, body });

    const { stdout } = await execFileAsync(process.execPath, [MIGRATION_SCRIPT, "--dir", dir], {
      cwd: REPO_ROOT,
      maxBuffer: 10 * 1024 * 1024,
    });
    const receipt = (JSON.parse(stdout) as { bundles: Array<Record<string, unknown>> }).bundles[0]!;
    assert.equal(receipt.reference_refreshed, "swapped", "the known transitional form must refresh to the canonical");

    const remaining = await query(bundle, {});
    assert.ok(remaining.some((d) => d.id === "references/view-authoring-v0"), "the reference is still present");
    assertTeachesNoLegacyVocabulary(remaining);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REJECTION PIN: the legacy v1 recipe folder no longer installs — its Page-typed registry doc is RECIPE_MALFORMED with the actionable message", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await assert.rejects(
      () => runJson(recipe, ["add", LEGACY_REVIEW_WORKFLOW_V1, "--dir", dir]),
      /must declare 'type: View'/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy-alias awareness: reapplying the renamed Review Workflow onto a legacy v1 install creates NO duplicate set — and reports MIGRATION_REQUIRED, not success", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };

    // 1. The COMPLETE legacy v1 install state (what the OLD edition's `recipe add` left behind):
    //    type Page under pages-registry//pages/, conventions/page, conventions/review-request,
    //    references/page-authoring-v0.
    await seedLegacyV1Install(bundle);

    // 2. The NEW renamed edition applies: the legacy install still holds the artifact slots so
    //    nothing is duplicated — but the RETIRED-name occupants no longer work, so the receipt
    //    reports an explicit non-success `migration_required` naming the remedy (review F3c),
    //    never a satisfied-looking skip.
    const reapply = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    const counts = reapply.counts as Record<string, number>;
    assert.equal(counts.migration_required, 2, "the View convention + the page pair await migration");
    assert.equal(counts.legacy_present, 0, "an unmigrated occupant is never reported as satisfying");

    const pages = reapply.pages as Array<Record<string, unknown>>;
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.registry_id, "views-registry/review-workflow-reviews");
    assert.equal(pages[0]!.changed, false);
    assert.equal(pages[0]!.legacy_present, undefined);
    assert.deepEqual(pages[0]!.migration_required, {
      registry: "pages-registry/review-workflow-reviews",
      entry: "pages/review-workflow/reviews.html",
    });

    const docs = reapply.docs as Array<Record<string, unknown>>;
    const viewConvention = docs.find((d) => d.id === "conventions/view");
    assert.ok(viewConvention);
    assert.equal(viewConvention!.changed, false);
    assert.equal(viewConvention!.migration_required, "conventions/page");
    const reviewRequest = docs.find((d) => d.id === "conventions/review-request");
    assert.equal(reviewRequest!.changed, false, "same-id convention is the ordinary existing no-op");

    // The receipt-level warnings carry the remedy by name.
    const warnings = reapply.warnings as Array<Record<string, unknown>>;
    const migrationWarnings = warnings.filter((w) => w.code === "MIGRATION_REQUIRED");
    assert.equal(migrationWarnings.length, 2);
    for (const w of migrationWarnings) assert.match(String(w.message), /migrate-legacy-view-names/);

    // The re-taught authoring reference is genuinely NEW content at a NEW id — it installs (there
    // is no principled alias for reference docs, and updated teaching should reach legacy bundles).
    assert.deepEqual(reapply.references, [{ id: "references/view-authoring-v0", changed: true }]);
    assert.equal(reapply.changed, true, "the reference install is the only change");

    // 3. NOTHING landed under the new prefixes — no second set on disk.
    assert.equal((await query(bundle, { prefix: VIEW_REGISTRY_PREFIX })).length, 0);
    assert.equal(await readBlob(bundle, "views/review-workflow/reviews.html"), null);
    const conventionIds = (await query(bundle, { prefix: "conventions/" })).map((d) => d.id);
    assert.ok(!conventionIds.includes("conventions/view"), "no duplicate View convention");

    // 4. Launcher-level: the UNMIGRATED Page-typed doc no longer registers — zero usable cards
    //    here BY DESIGN; the receipt above and status's legacy_naming finding carry the remedy.
    assert.equal((await usableRegistrations(bundle)).length, 0);

    // 5. A SECOND renamed apply is stable and still non-success in the same way.
    const third = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal(third.changed, false);
    assert.equal((third.counts as Record<string, number>).migration_required, 2);
    assert.deepEqual(third.references, [{ id: "references/view-authoring-v0", changed: false }]);

    // 6. Run the REAL migration script on the full historical install (review F2): types flip in
    //    place, the Page convention and the superseded Page-authoring reference are retired with
    //    their replacements present, the historical review-request wording refreshes — and the
    //    remaining bundle is north-star clean: NO doc teaches legacy names as current.
    await execFileAsync(process.execPath, [MIGRATION_SCRIPT, "--dir", dir], {
      cwd: REPO_ROOT,
      maxBuffer: 10 * 1024 * 1024,
    });
    const remaining = await query(bundle, {});
    assert.ok(remaining.some((d) => d.id === "conventions/view"), "the script installed the View convention replacement");
    assert.ok(!remaining.some((d) => d.id === "conventions/page"), "the Page convention was retired");
    assert.ok(remaining.some((d) => d.id === "references/view-authoring-v0"), "the replacement reference is present");
    assert.ok(!remaining.some((d) => d.id === "references/page-authoring-v0"), "the superseded legacy reference was retired");
    assertTeachesNoLegacyVocabulary(remaining);

    //    Post-migration, the alias probe reports the pair as GENUINELY satisfied again, and the
    //    launcher sees exactly ONE usable card at the legacy location.
    const postMigration = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal((postMigration.counts as Record<string, number>).migration_required, 0);
    const pmPages = postMigration.pages as Array<Record<string, unknown>>;
    assert.equal(pmPages[0]!.changed, false);
    assert.deepEqual(pmPages[0]!.legacy_present, {
      registry: "pages-registry/review-workflow-reviews",
      entry: "pages/review-workflow/reviews.html",
    });
    const registrations = await usableRegistrations(bundle);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]!.id, "pages-registry/review-workflow-reviews");
    assert.equal(registrations[0]!.type, "View");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy-alias awareness: the fresh-bundle path is unchanged — the renamed recipe installs the View set normally", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    const first = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal(first.changed, true);
    const counts = first.counts as Record<string, number>;
    assert.equal(counts.legacy_present, 0, "no legacy content, no legacy skips");
    assert.ok(counts.created >= 4, "conventions + page pair + reference all created");

    const viewIds = (await query(bundle, { prefix: VIEW_REGISTRY_PREFIX })).map((d) => d.id);
    assert.deepEqual(viewIds, ["views-registry/review-workflow-reviews"]);
    assert.ok(await readBlob(bundle, "views/review-workflow/reviews.html"));
    const registrations = await usableRegistrations(bundle);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]!.id, "views-registry/review-workflow-reviews");
    assert.equal(registrations[0]!.type, "View");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy-alias awareness: an INCOMPLETE legacy pair (registry doc without its blob) does NOT suppress the fresh View install", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await seedLegacyV1Install(bundle);
    // Sever the pair: the legacy registry doc stays, its blob is gone (crash leftover / hand-rm).
    await rm(path.join(dir, "pages", "review-workflow", "reviews.html"));

    const reapply = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    const pages = reapply.pages as Array<Record<string, unknown>>;
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.legacy_present, undefined, "a partial legacy pair must not read as satisfying");
    assert.equal(pages[0]!.registry_changed, true);
    assert.equal(pages[0]!.entry_changed, true);
    assert.equal(pages[0]!.changed, true);

    // The View pair really landed: registry doc queryable, blob readable.
    const viewIds = (await query(bundle, { prefix: VIEW_REGISTRY_PREFIX })).map((d) => d.id);
    assert.deepEqual(viewIds, ["views-registry/review-workflow-reviews"]);
    assert.ok(await readBlob(bundle, "views/review-workflow/reviews.html"));

    // Tally: page pair + reference created; review-request convention existing; view convention
    // still blocked by the unmigrated conventions/page (the convention probe is independent of
    // the pair, and an unmigrated occupant reports migration_required, never legacy_present).
    assert.deepEqual(reapply.counts, { created: 2, existing: 1, legacy_present: 0, migration_required: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy-alias awareness: the mirror partial pair (blob without its registry doc) also gets the fresh View install", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await seedLegacyV1Install(bundle);
    // Sever the pair the other way: the blob stays, the legacy registry doc is gone.
    await rm(path.join(dir, "pages-registry", "review-workflow-reviews.md"));

    const reapply = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    const pages = reapply.pages as Array<Record<string, unknown>>;
    assert.equal(pages[0]!.legacy_present, undefined);
    assert.equal(pages[0]!.changed, true);
    const viewIds = (await query(bundle, { prefix: VIEW_REGISTRY_PREFIX })).map((d) => d.id);
    assert.deepEqual(viewIds, ["views-registry/review-workflow-reviews"]);
    assert.ok(await readBlob(bundle, "views/review-workflow/reviews.html"));
    assert.deepEqual(reapply.counts, { created: 2, existing: 1, legacy_present: 0, migration_required: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
