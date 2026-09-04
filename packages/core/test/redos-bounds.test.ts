/**
 * Deterministic bounds for the two core text scanners that read document- or configuration-supplied
 * input: the level-1 heading splitter and the remote backend's base-URL normalization. Each input
 * drives quadratic backtracking in the regex shape these replaced, so a regression shows up as a
 * failed budget rather than a silent slow path. The linear scan finishes in single-digit
 * milliseconds; the quadratic shape needs minutes on the same input.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { splitSections } from "../src/kinds.js";
import { RemoteBackend } from "../src/remote-backend.js";

const BUDGET_MS = 2_000;
const SIZE = 200_000;

function elapsedMs(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test("splitSections stays linear on a heading line of trailing whitespace", () => {
  const body = `# ${" ".repeat(SIZE)}\nbody\n`;
  let sections: Record<string, string> = {};
  const took = elapsedMs(() => {
    sections = splitSections(body);
  });
  // A blank heading line continues into the next line's text, exactly as before this bound.
  assert.deepEqual(sections, { body: "" });
  assert.ok(took < BUDGET_MS, `splitSections took ${took}ms on a ${SIZE}-character heading line`);
});

test("splitSections still names a heading and its section", () => {
  assert.deepEqual(splitSections("# Notes   \nfirst\n\n# Next\nsecond\n"), {
    Notes: "first",
    Next: "second",
  });
});

test("a trailing bare '#' heading is content, not an empty-named section", () => {
  // Decided, not incidental: `#` followed only by blanks at end of input used to open a junk
  // `""` section, because the old capture accepted a space as the heading name. Requiring a
  // non-space name folds the orphan marker back into the section it trails.
  assert.deepEqual(splitSections("# Summary\ntext\n\n# \t\n"), { Summary: "text\n\n#" });
});

test("RemoteBackend base-URL normalization stays linear on a run of trailing separators", () => {
  const baseUrl = `https://example.invalid${"/".repeat(SIZE)}`;
  const took = elapsedMs(() => {
    new RemoteBackend({ baseUrl, bundle: "b", fetchImpl: () => Promise.reject(new Error("unused")) });
  });
  assert.ok(took < BUDGET_MS, `RemoteBackend construction took ${took}ms on ${SIZE} separators`);
});
