/**
 * Kind-field arity at the CLI boundary: creation preserves repeated non-enum fields
 * as arrays and delegates enum arity to core. Ordinary updates accept one value per
 * dynamic field flag and reject repeats before preparing scalar assignments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

/** A bundle with one governed kind carrying BOTH an enum field (`phase`) and a plain
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
        required: ["title", "phase"],
        optional: ["labels"],
        values: { phase: ["todo", "doing", "done"] },
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
          ["Task", "two-phase", "--title", "X", "--phase", "todo", "--phase", "done", "--dir", dir],
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
    await assert.rejects(() => readDoc({ root: dir }, "tasks/two-phase"));
  } finally {
    await cleanup();
  }
});

test("new: a repeated NON-enum field flag still produces an array (the feature is preserved)", async () => {
  const { dir, cleanup } = await makeEnumKindBundle();
  try {
    await newCommand(
      ["Task", "labeled", "--title", "X", "--phase", "todo", "--labels", "a", "--labels", "b", "--dir", dir],
      sink,
    );
    const written = await readDoc({ root: dir }, "tasks/labeled");
    assert.deepEqual(written.frontmatter.labels, ["a", "b"]);
    assert.equal(written.frontmatter.phase, "todo");
  } finally {
    await cleanup();
  }
});

for (const [field, first, second] of [["phase", "doing", "done"], ["labels", "a", "b"]] as const) {
  const forms = [
    { name: "spaced", args: [`--${field}`, first, `--${field}`, second] },
    { name: "inline", args: [`--${field}=${first}`, `--${field}=${second}`] },
    { name: "mixed", args: [`--${field}=${first}`, `--${field}`, second] },
    { name: "reverse mixed", args: [`--${field}`, first, `--${field}=${second}`] },
  ];
  for (const { name, args } of forms) {
    test(`doc update: repeated ${field} flags (${name}) name the arity error and preserve bytes`, async () => {
      const { dir, cleanup } = await makeEnumKindBundle();
      try {
        await newCommand(["Task", "one", "--title", "One", "--phase", "todo", "--dir", dir], sink);
        const file = path.join(dir, "tasks/one.md");
        const before = await readFile(file);
        await assert.rejects(
          () => doc(["update", "tasks/one", ...args, "--dir", dir], docSink),
          (err: unknown) => {
            assert.ok(err instanceof CliError);
            assert.equal(err.code, "USAGE");
            assert.match(err.message, /exactly ONE value/);
            assert.ok(err.message.includes(`--${field}`));
            return true;
          },
        );
        assert.deepEqual(await readFile(file), before, "the rejected patch must preserve bytes");
      } finally {
        await cleanup();
      }
    });
  }
}

test("doc update: one value for each dynamic Kind field remains supported", async () => {
  const { dir, cleanup } = await makeEnumKindBundle();
  try {
    await newCommand(["Task", "one", "--title", "One", "--phase", "todo", "--dir", dir], sink);
    await doc(["update", "tasks/one", "--phase=doing", "--labels", "a", "--dir", dir], docSink);
    const stored = await readDoc({ root: dir }, "tasks/one");
    assert.equal(stored.frontmatter.phase, "doing");
    assert.equal(stored.frontmatter.labels, "a");
  } finally {
    await cleanup();
  }
});
