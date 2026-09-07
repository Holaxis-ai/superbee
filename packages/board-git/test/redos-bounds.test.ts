/**
 * Deterministic bounds for the two board-git text scanners that read attacker-influenced input:
 * a bundle key derived from a remote URL/subpath, and git's own stderr. Each case is a string that
 * drives quadratic backtracking in the regex shape these scanners replaced, so a regression that
 * reintroduces `/\/+$/`-style matching turns the assertion into a visible timeout rather than a
 * silent slow path. The budget is deliberately loose: the linear scan finishes in single-digit
 * milliseconds, while the quadratic shape needs minutes on the same input.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { bundleKey } from "../src/cursor.js";
import { classifyGitError } from "../src/errors.js";

const BUDGET_MS = 2_000;
const SIZE = 200_000;

function elapsedMs(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test("bundleKey stays linear on a remote URL and subpath of pure separators", () => {
  const slashes = "/".repeat(SIZE);
  const took = elapsedMs(() => {
    bundleKey({ remoteUrl: `https://example.invalid/board${slashes}`, subpath: slashes, checkoutRoot: "/tmp/x" });
  });
  assert.ok(took < BUDGET_MS, `bundleKey took ${took}ms on ${SIZE} separators`);
});

test("classifyGitError stays linear on a rejected-push line that never names a reason", () => {
  const line = `![rejected]${" ".repeat(SIZE)}(no reason here`;
  let classified;
  const took = elapsedMs(() => {
    classified = classifyGitError({ args: ["push"], status: 1, stdout: "", stderr: line });
  });
  assert.equal(classified?.code, "RUNTIME");
  assert.ok(took < BUDGET_MS, `classifyGitError took ${took}ms on a ${SIZE}-character rejection line`);
});

test("classifyGitError stays linear on an origin ref that never reaches the merge suffix", () => {
  const line = `origin/${"a".repeat(SIZE)} - not something we can`;
  let classified;
  const took = elapsedMs(() => {
    classified = classifyGitError({ args: ["merge"], status: 1, stdout: "", stderr: line });
  });
  assert.equal(classified?.code, "RUNTIME");
  assert.ok(took < BUDGET_MS, `classifyGitError took ${took}ms on a ${SIZE}-character ref line`);
});

test("classifyGitError still recognizes the real non-fast-forward and unmergeable-ref shapes", () => {
  const rejected = classifyGitError({
    args: ["push"],
    status: 1,
    stdout: "",
    stderr: " ! [rejected]        board -> board (fetch first)",
  });
  assert.equal(rejected.code, "TRANSIENT");
  assert.equal(rejected.details?.reason, "non-fast-forward");

  const unmergeable = classifyGitError({
    args: ["merge"],
    status: 1,
    stdout: "",
    stderr: "merge: origin/board - not something we can merge",
  });
  assert.equal(unmergeable.code, "NO_UPSTREAM");
});

test("classifyGitError matches the rejection reason and the ref case-insensitively", () => {
  const shouted = classifyGitError({
    args: ["push"],
    status: 1,
    stdout: "",
    stderr: " ! [REJECTED]        board -> board (Non-Fast-Forward)",
  });
  assert.equal(shouted.code, "TRANSIENT");

  // An earlier `origin/` start still wins, as it did under the regex form.
  const nested = classifyGitError({
    args: ["merge"],
    status: 1,
    stdout: "",
    stderr: "merge: origin/aorigin/ - not something we can merge",
  });
  assert.equal(nested.code, "NO_UPSTREAM");
});
