/**
 * Enum arity guard, end to end (`plans/list-hint-arity.md` decision 3): a repeated
 * kind-field flag is an intentional FEATURE for non-enum fields (`--labels a --labels b`
 * → array) but a silent-corruption trap for enum-restricted ones (`--status todo
 * --status done` used to persist a two-status doc with ZERO warnings, even strict —
 * every array member passes the element-wise membership check). The guard lives in
 * CORE's one validation locus (`validateAgainstKind`, `KIND_FIELD_ARITY`), so this file
 * pins the two CLI surfaces that inherit it (`new` — always strict; `doc update` —
 * strict for kind-field patches) plus the preserved array feature.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, readDoc, CONVENTION_TYPE, type Bundle } from "@superbee/core";

import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";

const T = "2026-07-01T00:00:00.000Z";
const sink = { stdout: () => {} };
// A body-less `doc update` probes stdin for a piped body; under the test runner stdin is a
// pipe that never EOFs, so EVERY in-process `doc` call MUST stub `readStdin` or the suite
// hangs (the same rule doc.test.ts's test-authoring note pins).
const docSink = { stdout: () => {}, readStdin: async () => undefined };

/** A bundle with one governed kind carrying BOTH an enum field (`status`) and a plain
 * optional field (`labels`) — the pair the guard must distinguish. */
async function makeEnumKindBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-arity-test-"));
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
        optional: ["labels"],
        values: { status: ["todo", "doing", "done"] },
      },
      timestamp: T,
    },
    body: "A unit of work.",
  });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("new: a repeated ENUM field flag is a USAGE rejection naming the arity violation — nothing written", async () => {
  const { dir, cleanup } = await makeEnumKindBundle();
  try {
    await assert.rejects(
      () =>
        newCommand(
          ["Task", "two-status", "--title", "X", "--status", "todo", "--status", "done", "--dir", dir],
          sink,
        ),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(String(err.message), /exactly ONE value/);
        return true;
      },
    );
    // Create-only discipline: the rejected doc must not exist.
    await assert.rejects(() => readDoc({ root: dir }, "tasks/two-status"));
  } finally {
    await cleanup();
  }
});

test("new: a repeated NON-enum field flag still produces an array (the feature is preserved)", async () => {
  const { dir, cleanup } = await makeEnumKindBundle();
  try {
    await newCommand(
      ["Task", "labeled", "--title", "X", "--status", "todo", "--labels", "a", "--labels", "b", "--dir", dir],
      sink,
    );
    const written = await readDoc({ root: dir }, "tasks/labeled");
    assert.deepEqual(written.frontmatter.labels, ["a", "b"]);
    assert.equal(written.frontmatter.status, "todo");
  } finally {
    await cleanup();
  }
});

test("doc update: a repeated ENUM field flag is a USAGE rejection — the stored doc is untouched", async () => {
  const { dir, cleanup } = await makeEnumKindBundle();
  try {
    await newCommand(["Task", "one", "--title", "One", "--status", "todo", "--dir", dir], sink);
    await assert.rejects(
      () => doc(["update", "tasks/one", "--status", "doing", "--status", "done", "--dir", dir], docSink),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(String(err.message), /exactly ONE value/);
        return true;
      },
    );
    const stored = await readDoc({ root: dir }, "tasks/one");
    assert.equal(stored.frontmatter.status, "todo", "the rejected patch must not have written");
  } finally {
    await cleanup();
  }
});
