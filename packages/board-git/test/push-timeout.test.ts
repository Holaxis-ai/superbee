// A board push has its own budget, longer than fetch's, and a push stopped at that budget reports
// a timeout with the budget it enforced rather than an unreachable host. A stalling `pre-push`
// hook stands in for an upload that does not finish.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import { NETWORK_TIMEOUT_MS, PUSH_TIMEOUT_MS, classifyGitError, isBoardGitError, push } from "../src/index.js";
import {
  BOARD_BRANCH,
  boardHead,
  commitBoard,
  makeTwoCloneTopology,
  originBoardHead,
  writeBoardDoc,
} from "./git-harness.js";

test("push budget: a push gets ten minutes, longer than the fetch and probe budget", () => {
  assert.equal(PUSH_TIMEOUT_MS, 600_000);
  assert.ok(PUSH_TIMEOUT_MS > NETWORK_TIMEOUT_MS);
});

test("push: a stalled upload is stopped at its budget and reports a timeout with that budget, keeping the local commit", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeBoardDoc(topo.a, "notes/slow", { frontmatter: { type: "Note", title: "slow" }, body: "# slow\n" });
    const head = commitBoard(topo.a, "slow upload");
    const before = originBoardHead(topo);
    const hook = path.join(topo.a.root, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\nsleep 5\n");
    await chmod(hook, 0o755);

    const started = Date.now();
    let err: unknown = null;
    try {
      push(topo.a.board, head, BOARD_BRANCH, 1_500);
    } catch (e) {
      err = e;
    }
    assert.ok(Date.now() - started < 4_500, "stopped at the budget, not when the hook finished");
    assert.ok(isBoardGitError(err), "a classified failure");
    assert.equal(err.code, "TRANSIENT");
    assert.equal(err.message, "git push did not finish within 2 seconds and was stopped; retry");
    assert.equal(err.details?.reason, "timeout");
    assert.equal(err.details?.timeout_ms, 1_500);
    assert.equal(originBoardHead(topo), before, "the remote did not move");
    assert.equal(boardHead(topo.a), head, "the local commit is kept");
  } finally {
    await topo.cleanup();
  }
});

test("classify: a timeout with no known budget still names no cause", () => {
  const err = classifyGitError({ args: ["fetch"], status: null, stdout: "", stderr: "", timedOut: true });
  assert.equal(err.message, "git fetch did not finish in time and was stopped; retry");
  assert.equal(err.details?.reason, "timeout");
  assert.equal(err.details?.timeout_ms, undefined);
});
