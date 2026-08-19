/**
 * Tier-1 kind capabilities (plans/tier1-kind-capabilities.md), Forks A + B: `list`/`query`'s
 * kind-aware columns and generic `--field key=value` filter.
 *
 * Fork A (columns): a `--type <X>`-scoped query, with NO `--fields` override, where a loaded kind
 * convention governs `X`, projects `{id, title, ...kind's required+optional fields (minus
 * id/title/description)}` instead of the minimal `{id,type,title,timestamp}` schema. GENERIC — no
 * per-kind code; proven against TWO distinct kinds (Task, Ticket) below.
 *
 * Fork B (filter): `--field key=value`, repeatable, ANDed, implemented as a core `QueryFilter`
 * facet (`fields`) so it rides `readMany` over `--remote` for free, same as the pre-existing
 * `type`/`tags` facets.
 *
 * Runs command functions in-process (no subprocess) against a real temp filesystem bundle,
 * mirroring `kinds.test.ts`'s/`doc.test.ts`'s pattern; the `--remote` parity test additionally
 * boots a real `@superbee/server` `serve()` instance, mirroring `remote.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, CONVENTION_TYPE, type Bundle } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { list } from "../src/commands/list.js";
import { CliError } from "../src/errors.js";

const T = "2026-07-01T00:00:00.000Z";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-list-test-"));
}

/** Run `list`, capturing + parsing its `--json` stdout. */
async function runJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await list([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * A bundle with TWO distinct governed kinds (proving genericity — no hardcoded kind name in the
 * implementation) plus a handful of Task instances for filter/column assertions:
 *   - `Task`: required [title, status], optional [priority, description] — `description` is the
 *     one standard long-text field, EXCLUDED from kind columns by name (not by kind).
 *   - `Ticket`: required [severity] — a second, differently-shaped kind, to prove the same
 *     column/filter code path is not Task-specific.
 */
async function makeTwoKindBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle: Bundle = { root: dir };
  await initBundle(dir, { okfVersion: "0.1" });
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: {
        required: ["title", "status"],
        optional: ["priority", "description"],
        values: { status: ["todo", "doing", "done"] },
      },
      timestamp: T,
    },
    body: "A unit of work.",
  });
  await writeDoc(bundle, {
    id: "conventions/ticket",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Ticket",
      governs: "Ticket",
      path: "tickets/",
      fields: { required: ["severity"], optional: [] },
      timestamp: T,
    },
    body: "A support ticket.",
  });

  await writeDoc(bundle, {
    id: "tasks/a",
    frontmatter: { type: "Task", title: "Task A", status: "todo", priority: "high", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/b",
    frontmatter: {
      type: "Task",
      title: "Task B",
      status: "doing",
      priority: "low",
      description: "x".repeat(120), // exercises the column-cell truncation cap
      timestamp: T,
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/c",
    frontmatter: { type: "Task", title: "Task C", status: "done", timestamp: T }, // no priority (optional, absent)
    body: "",
  });
  await writeDoc(bundle, {
    id: "tickets/x",
    frontmatter: { type: "Ticket", title: "Ticket X", severity: "sev1", timestamp: T },
    body: "",
  });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ── Fork A: kind-aware columns ──────────────────────────────────────────────────────────────────

test("list --type Task: projects logical progress_status columns — description EXCLUDED, count present", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--dir", dir]);
    assert.equal(result.count, 3);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["id", "priority", "progress_status", "title"]);
    }
    const a = rows.find((r) => r.id === "tasks/a")!;
    assert.equal(a.progress_status, "todo");
    assert.equal(a.priority, "high");
    // Missing optional field on a row is "" (keeps every row's key set uniform, TOON-required).
    const c = rows.find((r) => r.id === "tasks/c")!;
    assert.equal(c.priority, "");
  } finally {
    await cleanup();
  }
});

test("list (unscoped): stays the minimal {id,type,title,timestamp} schema across mixed kinds — no per-row kind columns", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["id", "timestamp", "title", "type"]);
    }
  } finally {
    await cleanup();
  }
});

test("list orders meaningful change time newest-first after filters and before limit, with deterministic invalid-clock and ID ties over local and live remote", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.2" });
    for (const [id, frontmatter] of [
      ["notes/z-oldest", { type: "Context Note", timestamp: "2026-01-01T00:00:00.000Z" }],
      ["notes/a-newer", { type: "Context Note", timestamp: "2026-02-01T00:00:00.000Z" }],
      ["notes/z-tie", { type: "Context Note", timestamp: "2026-03-01T00:00:00.000Z" }],
      ["notes/a-tie", { type: "Context Note", timestamp: "2026-03-01T00:00:00.000Z" }],
      [
        "notes/y-generated-wins",
        {
          type: "Context Note",
          timestamp: "2026-01-01T00:00:00.000Z",
          generated: { at: "2026-04-01T00:00:00.000Z", by: "producer/1" },
        },
      ],
      [
        "notes/b-invalid-generated",
        {
          type: "Context Note",
          timestamp: "2099-01-01T00:00:00.000Z",
          generated: { at: "not-a-date", by: "producer/1" },
        },
      ],
      ["notes/a-missing", { type: "Context Note" }],
    ] as const) {
      await writeDoc(bundle, { id, frontmatter, body: "" });
    }

    const expected = [
      "notes/y-generated-wins",
      "notes/a-tie",
      "notes/z-tie",
      "notes/a-newer",
      "notes/z-oldest",
      "notes/a-missing",
      "notes/b-invalid-generated",
    ];
    const local = await runJson(["--type", "Context Note", "--limit", "0", "--dir", dir]);
    assert.equal(local.count, expected.length);
    assert.deepEqual((local.docs as Array<{ id: string }>).map((row) => row.id), expected);
    assert.deepEqual(
      (local.docs as Array<{ id: string; timestamp: string }>).map(({ id, timestamp }) => [id, timestamp]),
      [
        ["notes/y-generated-wins", "2026-04-01T00:00:00.000Z"],
        ["notes/a-tie", "2026-03-01T00:00:00.000Z"],
        ["notes/z-tie", "2026-03-01T00:00:00.000Z"],
        ["notes/a-newer", "2026-02-01T00:00:00.000Z"],
        ["notes/z-oldest", "2026-01-01T00:00:00.000Z"],
        ["notes/a-missing", ""],
        ["notes/b-invalid-generated", "not-a-date"],
      ],
    );

    const limited = await runJson(["--type", "Context Note", "--limit", "3", "--dir", dir]);
    assert.equal(limited.count, expected.length);
    assert.deepEqual((limited.docs as Array<{ id: string }>).map((row) => row.id), expected.slice(0, 3));

    const handle: ServerHandle = await serve({ bundle, port: 0 });
    try {
      const remote = await runJson(["--type", "Context Note", "--limit", "0", "--remote", `http://${handle.host}:${handle.port}`]);
      assert.deepEqual(remote, local);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --type Task --fields foo: --fields ALWAYS overrides kind columns (minimal schema + foo, kind columns suppressed)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--fields", "foo", "--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["foo", "id", "timestamp", "title", "type"]);
    }
  } finally {
    await cleanup();
  }
});

test("list --type Task --fields id,title: --fields override still applies even when EVERY requested name collides with a default key (regression — activation must key off the FLAG being given, not off extraFields ending up empty)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--fields", "id,title", "--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["id", "timestamp", "title", "type"]);
    }
  } finally {
    await cleanup();
  }
});

test("list --type <ungoverned>: minimal schema, no crash (no kind governs the type)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, { id: "concepts/free", frontmatter: { type: "Concept", timestamp: T }, body: "" });
    const result = await runJson(["--type", "Concept", "--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "timestamp", "title", "type"]);
  } finally {
    await cleanup();
  }
});

test("list --type <kind with zero declared fields>: minimal schema (activation guard: nothing kind-specific to show)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/empty",
      frontmatter: { type: CONVENTION_TYPE, title: "Empty", governs: "Empty", fields: { required: [], optional: [] }, timestamp: T },
      body: "",
    });
    await writeDoc(bundle, { id: "empties/a", frontmatter: { type: "Empty", timestamp: T }, body: "" });
    const result = await runJson(["--type", "Empty", "--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "timestamp", "title", "type"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --type Ticket: GENERIC across kinds — projects {id,title,severity}, proving no hardcoded kind name", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Ticket", "--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "severity", "title"]);
    assert.equal(rows[0]!.severity, "sev1");
  } finally {
    await cleanup();
  }
});

test("list --type Task: a long declared-field value is truncated to the cell cap (row-width safety)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    // description is EXCLUDED from Task's columns by name, so add priority-as-long-value instead
    // to exercise the cap on a column that DOES render. Re-seed a task with a long priority.
    const bundle: Bundle = { root: dir };
    await writeDoc(bundle, {
      id: "tasks/long",
      frontmatter: { type: "Task", title: "Long", status: "todo", priority: "p".repeat(120), timestamp: T },
      body: "",
    });
    const result = await runJson(["--type", "Task", "--dir", dir]);
    const rows = result.docs as Array<Record<string, unknown>>;
    const long = rows.find((r) => r.id === "tasks/long")!;
    const cell = long.priority as string;
    assert.ok(cell.length <= 81, `expected truncated cell, got length ${cell.length}`); // 80 + ellipsis
    assert.ok(cell.endsWith("…"));
  } finally {
    await cleanup();
  }
});

// ── Fork B: --field filter ──────────────────────────────────────────────────────────────────────

test("list --field status=done: filters to matching docs only, count matches", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--field", "status=done", "--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.id, "tasks/c");
  } finally {
    await cleanup();
  }
});

test("list exposes declared v0.1 workflow status through logical progress_status filters and projections", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson([
      "--type", "Task",
      "--field", "progress_status=todo,doing",
      "--fields", "progress_status,priority",
      "--dir", dir,
    ]);
    assert.equal(result.count, 2);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => row.id), ["tasks/a", "tasks/b"]);
    assert.deepEqual(rows.map((row) => row.progress_status), ["todo", "doing"]);
    assert.deepEqual(rows.map((row) => row.priority), ["high", "low"]);
  } finally {
    await cleanup();
  }
});

test("list --field (repeatable): ANDed — intersection of both conditions", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--field", "status=todo", "--field", "priority=high", "--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.id, "tasks/a");
  } finally {
    await cleanup();
  }
});

test("list --field status=nope: definitive empty state — {count:0, docs:[]}, exit 0 (not an error)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--field", "status=nope", "--dir", dir]);
    assert.equal(result.count, 0);
    assert.deepEqual(result.docs, []);
  } finally {
    await cleanup();
  }
});

test("list --field priority=1: unquoted numeric YAML coercion matches (String(1) === '1')", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "concepts/n", frontmatter: { type: "Concept", priority: 1, timestamp: T }, body: "" });
    const result = await runJson(["--field", "priority=1", "--dir", dir]);
    assert.equal(result.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --field tags=a: array membership match (tags: [a,b])", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "concepts/tagged", frontmatter: { type: "Concept", tags: ["a", "b"], timestamp: T }, body: "" });
    await writeDoc(bundle, { id: "concepts/untagged", frontmatter: { type: "Concept", tags: ["c"], timestamp: T }, body: "" });
    const result = await runJson(["--field", "tags=a", "--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.id, "concepts/tagged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --field foo (no '='): USAGE (exit 2)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    await assert.rejects(
      () => list(["--field", "foo", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("list --field =v (empty key): USAGE (exit 2)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    await assert.rejects(
      () => list(["--field", "=v", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("list --type Task --field status=done: filter AND kind-aware columns compose", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--field", "status=done", "--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "priority", "progress_status", "title"]);
    assert.equal(rows[0]!.progress_status, "done");
  } finally {
    await cleanup();
  }
});

test("--field over --remote: same result set as --dir against a live serve()", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const local = await runJson(["--type", "Task", "--field", "status=todo", "--dir", dir]);
      const remote = await runJson(["--type", "Task", "--field", "status=todo", "--remote", url]);
      assert.deepEqual(remote, local);
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup();
  }
});

// ── tasks/list-field-sets.md: comma = set membership (OR) within one --field ──────────────────

test("list --field status=todo,doing (comma = OR within one field): matches EITHER value", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson(["--type", "Task", "--field", "status=todo,doing", "--dir", dir]);
    assert.equal(result.count, 2);
    const ids = (result.docs as Array<{ id: string }>).map((d) => d.id).sort();
    assert.deepEqual(ids, ["tasks/a", "tasks/b"]);
  } finally {
    await cleanup();
  }
});

test("list --field status=todo,doing --field priority=high: AND across different --field flags is UNCHANGED — OR applies only WITHIN one field", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const result = await runJson([
      "--type", "Task", "--field", "status=todo,doing", "--field", "priority=high", "--dir", dir,
    ]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.id, "tasks/a"); // tasks/b is status=doing but priority=low, so it's excluded
  } finally {
    await cleanup();
  }
});

test("list --field status=todo,,done (empty member): USAGE (exit 2)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    await assert.rejects(
      () => list(["--field", "status=todo,,done", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("list --field status=,done (leading empty member from a stray comma): USAGE (exit 2)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    await assert.rejects(
      () => list(["--field", "status=,done", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("list --field status= (bare, no comma at all): USAGE (exit 2) with the TAILORED empty-value message, not the comma-membership wording", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    await assert.rejects(
      () => list(["--field", "status=", "--dir", dir, "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        assert.match((err as CliError).message, /has an empty value/);
        assert.doesNotMatch((err as CliError).message, /comma is the set-membership separator/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("--field comma-OR over --remote: same result set as --dir (reader-side post-filter is transparent over the wire)", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const local = await runJson(["--type", "Task", "--field", "status=todo,doing", "--dir", dir]);
      const remote = await runJson(["--type", "Task", "--field", "status=todo,doing", "--remote", url]);
      assert.deepEqual(remote, local);
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup();
  }
});

// ── tasks/status-terminal-declaration.md: `--open` ──────────────────────────────────────────────

/**
 * A bundle with a `Task` kind declaring a terminal set (done/canceled), a second GOVERNED kind
 * with NO terminal declared (`Ticket`), and an UNGOVERNED type doc — the three "must stay
 * included" shapes `--open` promises, alongside the terminal Task instances it must exclude.
 */
async function makeTerminalBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle: Bundle = { root: dir };
  await initBundle(dir);
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: {
        required: ["title", "status"],
        optional: [],
        values: { status: ["todo", "doing", "done", "canceled"] },
        terminal: { status: ["done", "canceled"] },
      },
      timestamp: T,
    },
    body: "A unit of work.",
  });
  await writeDoc(bundle, {
    id: "conventions/ticket",
    frontmatter: {
      type: CONVENTION_TYPE,
      title: "Ticket",
      governs: "Ticket",
      path: "tickets/",
      fields: { required: ["severity"], optional: [] }, // GOVERNED, but declares no terminal set
      timestamp: T,
    },
    body: "A support ticket, no terminal declared.",
  });

  await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "Task", title: "Task A", status: "todo", timestamp: T }, body: "" });
  await writeDoc(bundle, { id: "tasks/b", frontmatter: { type: "Task", title: "Task B", status: "done", timestamp: T }, body: "" });
  await writeDoc(bundle, { id: "tasks/c", frontmatter: { type: "Task", title: "Task C", status: "canceled", timestamp: T }, body: "" });
  await writeDoc(bundle, { id: "tickets/x", frontmatter: { type: "Ticket", title: "Ticket X", severity: "sev1", timestamp: T }, body: "" });
  await writeDoc(bundle, { id: "notes/free", frontmatter: { type: "Note", title: "Free note", timestamp: T }, body: "" });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("list --open: excludes terminal Task instances (done/canceled), keeps non-terminal Tasks, a governed-no-terminal kind, and an ungoverned type", async () => {
  const { dir, cleanup } = await makeTerminalBundle();
  try {
    // 7 total: the two Convention docs themselves (ungoverned as a type) + 5 concept docs.
    const all = await runJson(["--dir", dir]);
    assert.equal(all.count, 7);

    const open = await runJson(["--open", "--dir", dir]);
    assert.equal(open.count, 5); // the 2 done/canceled Tasks are the only exclusions
    const ids = (open.docs as Array<{ id: string }>).map((d) => d.id).sort();
    assert.deepEqual(ids, ["conventions/task", "conventions/ticket", "notes/free", "tasks/a", "tickets/x"]);
  } finally {
    await cleanup();
  }
});

test("list --type Task --open: composes with --type — kind columns still apply, terminal Tasks excluded", async () => {
  const { dir, cleanup } = await makeTerminalBundle();
  try {
    const result = await runJson(["--type", "Task", "--open", "--dir", dir]);
    assert.equal(result.count, 1);
    const rows = result.docs as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.id, "tasks/a");
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "status", "title"]);
  } finally {
    await cleanup();
  }
});

test("list --open: a bundle where NO kind declares any terminal set is a structural no-op — same count, an explicit help line says so", async () => {
  const { dir, cleanup } = await makeTwoKindBundle(); // neither Task nor Ticket declares fields.terminal here
  try {
    const without = await runJson(["--dir", dir]);
    const withOpen = await runJson(["--open", "--dir", dir]);
    assert.equal(withOpen.count, without.count);
    const help = withOpen.help as string[];
    assert.ok(
      Array.isArray(help) && help.some((h) => /no kind declares terminal values — --open filtered nothing/.test(h)),
      `expected the --open no-op help line, got ${JSON.stringify(help)}`,
    );
  } finally {
    await cleanup();
  }
});

test("--open over --remote: same result set as --dir against a live serve() (the terminal-exclusion filter is transparent over the wire, same as the comma-OR post-filter)", async () => {
  const { dir, cleanup } = await makeTerminalBundle();
  try {
    const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const local = await runJson(["--type", "Task", "--open", "--dir", dir]);
      const remote = await runJson(["--type", "Task", "--open", "--remote", url]);
      assert.deepEqual(remote, local);
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup();
  }
});

test("list --open: an ARRAY-valued terminal field (status: [todo, done]) is excluded — isTerminal matches on membership, never throws", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        title: "Task",
        governs: "Task",
        path: "tasks/",
        fields: {
          required: ["title"],
          optional: ["status"],
          values: { status: ["todo", "doing", "done"] },
          terminal: { status: ["done"] },
        },
        timestamp: T,
      },
      body: "",
    });
    // An array-valued status (e.g. from a repeated --status flag) still counts as terminal if
    // ANY member is a terminal value — the same membership semantics validateAgainstKind/matchesFilter use.
    await writeDoc(bundle, {
      id: "tasks/multi",
      frontmatter: { type: "Task", title: "Multi", status: ["todo", "done"], timestamp: T },
      body: "",
    });
    await writeDoc(bundle, {
      id: "tasks/plain",
      frontmatter: { type: "Task", title: "Plain", status: "todo", timestamp: T },
      body: "",
    });

    const result = await runJson(["--type", "Task", "--open", "--dir", dir]);
    assert.equal(result.count, 1, "the array-valued terminal doc must be excluded, no throw");
    const rows = result.docs as Array<{ id: string }>;
    assert.equal(rows[0]!.id, "tasks/plain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --open --field status=done (contradictory): the --field push-down already narrows to terminal docs, so --open excludes all of them — definitive count:0, exit 0", async () => {
  const { dir, cleanup } = await makeTerminalBundle();
  try {
    const result = await runJson(["--type", "Task", "--open", "--field", "status=done", "--dir", dir]);
    assert.equal(result.count, 0);
    assert.deepEqual(result.docs, []);
  } finally {
    await cleanup();
  }
});

// ── Cross-cutting ────────────────────────────────────────────────────────────────────────────────

test("conventions-free bundle: --type Foo stays minimal schema; --field filters normally (registry loads to empty, no crash)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "concepts/x", frontmatter: { type: "Foo", status: "done", timestamp: T }, body: "" });
    const scoped = await runJson(["--type", "Foo", "--dir", dir]);
    const rows = scoped.docs as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "timestamp", "title", "type"]);

    const filtered = await runJson(["--field", "status=done", "--dir", dir]);
    assert.equal(filtered.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt doc (unparseable YAML) is SKIPPED and reported — it never fails the whole list", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "notes/good", frontmatter: { type: "Concept", title: "Good", timestamp: T }, body: "" });
    // Hand-write a doc with an unterminated YAML flow sequence — js-yaml cannot parse it.
    await mkdir(path.join(dir, "notes"), { recursive: true });
    await writeFile(path.join(dir, "notes", "bad.md"), "---\ntype: [unclosed\ntitle: bad\n---\nbody\n");

    const out = await runJson(["--dir", dir]);
    // The good doc still lists; the corrupt one is quarantined into `skipped`, not crashed on.
    const ids = (out.docs as Array<{ id: string }>).map((d) => d.id);
    assert.ok(ids.includes("notes/good"));
    assert.ok(!ids.includes("notes/bad"));
    const skipped = out.skipped as Array<{ id: string; reason: string }>;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.id, "notes/bad");
    assert.ok((skipped[0]?.reason ?? "").length > 0);
    assert.ok(Array.isArray(out.help) && /unparseable frontmatter/.test((out.help as string[])[0] ?? ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --limit caps rows: count=total, shown=cap, and a --limit 0 truncation hint (A2)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    for (let i = 0; i < 4; i++) {
      await writeDoc(bundle, { id: `notes/n${i}`, frontmatter: { type: "Concept", title: `N${i}`, timestamp: T }, body: "" });
    }
    const out = await runJson(["--limit", "2", "--dir", dir]);
    assert.equal((out.docs as unknown[]).length, 2, "docs page is capped to the limit");
    assert.equal(out.shown, 2);
    assert.ok((out.count as number) > 2, "count reports the full total, not the page size");
    const help = out.help as string[];
    assert.ok(help.some((h) => /showing 2 of \d+/.test(h) && /--limit 0/.test(h)), "truncation hint present");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list --fields caps each cell at 80 chars, like kind columns (A3)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    const longVal = "x".repeat(200);
    await writeDoc(bundle, { id: "notes/big", frontmatter: { type: "Concept", title: "Big", summary: longVal, timestamp: T }, body: "" });
    const out = await runJson(["--fields", "summary", "--prefix", "notes/", "--dir", dir]);
    const row = (out.docs as Array<Record<string, unknown>>).find((r) => r.id === "notes/big")!;
    assert.equal((row.summary as string).length, 81, "80 chars + the ellipsis");
    assert.ok((row.summary as string).endsWith("…"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list emits contextual next-step help on non-empty output, none when empty (A4)", async () => {
  const dir = await tempDir();
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "notes/one", frontmatter: { type: "Concept", title: "One", timestamp: T }, body: "" });

    const nonEmpty = await runJson(["--prefix", "notes/", "--dir", dir]);
    const help = nonEmpty.help as string[];
    assert.ok(Array.isArray(help) && help.some((h) => /doc read <id>/.test(h)), "browse hint present on non-empty");

    // An empty result stays a bare definitive-zero (no next-step noise) — §5.
    const empty = await runJson(["--type", "NoSuchType", "--dir", dir]);
    assert.equal(empty.count, 0);
    assert.equal(empty.help, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── uniform-kind discovery hint (plans/list-hint-arity.md decision 2) ─────────────────────────
//
// The hint is a HELP LINE, never a schema change: a data-dependent column projection was
// considered and rejected (output schema must key on the invocation, not bundle content).

/** The hint line, if present, from a runJson result. */
function hintLine(out: Record<string, unknown>): string | undefined {
  const help = (out.help as string[] | undefined) ?? [];
  return help.find((h) => h.includes("--type"));
}

test("hint: a minimal-schema result uniformly one GOVERNED kind advertises --type and its columns", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    const out = await runJson(["--prefix", "tasks/", "--dir", dir]);
    // Schema stays MINIMAL (the hint never changes columns).
    const rows = out.docs as Record<string, unknown>[];
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["id", "timestamp", "title", "type"]);
    const hint = hintLine(out);
    assert.ok(hint, "expected a --type discovery hint");
    assert.match(hint!, /all 3 rows are 'Task'/);
    assert.match(hint!, /--type Task/);
    assert.match(hint!, /progress_status\/priority/);
    assert.doesNotMatch(hint!, /superbee_progress_status/);
  } finally {
    await cleanup();
  }
});

test("hint: silent on a MIXED result, on --fields, on --type, and on an ungoverned uniform type", async () => {
  const { dir, cleanup } = await makeTwoKindBundle();
  try {
    // Mixed types (whole bundle): no hint.
    assert.equal(hintLine(await runJson(["--dir", dir])), undefined);
    // Explicit --fields projection: no hint (the caller already chose a schema).
    assert.equal(hintLine(await runJson(["--prefix", "tasks/", "--fields", "status", "--dir", dir])), undefined);
    // --type given: kind columns are ACTIVE — hinting would be noise.
    assert.equal(hintLine(await runJson(["--type", "Task", "--dir", dir])), undefined);
    // Uniformly one type but UNGOVERNED (the two Convention docs): no hint.
    assert.equal(hintLine(await runJson(["--prefix", "conventions/", "--dir", dir])), undefined);
  } finally {
    await cleanup();
  }
});
