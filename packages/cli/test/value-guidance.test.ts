import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, CONVENTION_TYPE } from "@superbee/core";

import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";

const DONE = "Done means merged and verified; an open PR is not done.";

async function run(
  cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>,
  argv: string[],
): Promise<string> {
  let out = "";
  await cmd(argv, { stdout: (s) => (out += s) });
  return out;
}

test("writes echo the governing Kind's value description when they set a described value", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-value-guidance-"));
  try {
    await initBundle(dir);
    await writeDoc({ root: dir }, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Task",
        path: "tasks/",
        fields: {
          required: ["title", "superbee_progress_status"],
          optional: [],
          values: { superbee_progress_status: ["todo", "done"] },
          value_descriptions: { superbee_progress_status: { done: DONE } },
          terminal: { superbee_progress_status: ["done"] },
        },
      },
      body: "",
    });

    const created = JSON.parse(await run(newCommand, ["Task", "a", "--title", "A", "--progress_status", "todo", "--dir", dir, "--json"]));
    assert.equal(created.guidance, undefined);
    const createdDone = JSON.parse(await run(newCommand, ["Task", "b", "--title", "B", "--progress_status", "done", "--dir", dir, "--json"]));
    assert.deepEqual(createdDone.guidance, [{ field: "progress_status", value: "done", description: DONE }]);

    const toon = await run(doc, ["update", "tasks/a", "--progress_status", "done", "--dir", dir]);
    assert.ok(toon.includes(`\nguidance[1]{field,value,description}:\n  progress_status,done,${DONE}\n`), toon);
    assert.doesNotMatch(toon, /superbee_progress_status/);

    const unchanged = JSON.parse(await run(doc, ["update", "tasks/a", "--progress_status", "done", "--dir", dir, "--json"]));
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.guidance, undefined);

    await run(doc, ["update", "tasks/a", "--progress_status", "todo", "--dir", dir]);
    const json = JSON.parse(await run(doc, ["update", "tasks/a", "--progress_status", "done", "--dir", dir, "--json"]));
    assert.deepEqual(json.guidance, [{ field: "progress_status", value: "done", description: DONE }]);

    await run(doc, ["update", "tasks/a", "--progress_status", "todo", "--dir", dir]);
    const field = JSON.parse(await run(doc, ["field", "set", "tasks/a", "progress_status", "done", "--dir", dir, "--json"]));
    assert.equal(field.changed, true);
    assert.deepEqual(field.guidance, [{ field: "progress_status", value: "done", description: DONE }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
