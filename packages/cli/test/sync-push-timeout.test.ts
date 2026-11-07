// A Git board push that does not finish: sync reports a timeout with its budget (never "could not
// reach the remote"), keeps the local commit, and the end-of-turn sync stops its upload by the
// turn-end deadline, under the Stop hook's kill. A stalling `pre-push` hook stands in for an
// upload that does not finish.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PUSH_TIMEOUT_MS } from "@superbee/board-git";
import { TURN_END_HOOK_TIMEOUT_SECONDS } from "../src/commands/hook.js";
import { pushFailureMessage, pushTimeoutMessage } from "../src/commands/sync/converge.js";
import { sync } from "../src/commands/sync/orchestrate.js";
import { TURN_END_BUDGET_MS, turnEnd } from "../src/commands/turn-end.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps } from "../src/hosted-auth/session.js";
import { withSharingDetails } from "../src/sync-outcomes.js";
import {
  boardHead,
  git,
  makeTwoCloneTopology,
  originBoardHead,
  writeBoardDoc,
  type TwoCloneTopology,
} from "../../board-git/test/git-harness.js";
import { withIsolatedUserEnv } from "./support/user-env.js";

async function stallPush(topo: TwoCloneTopology, seconds: number): Promise<string> {
  const hook = path.join(topo.a.root, ".git", "hooks", "pre-push");
  await writeFile(hook, `#!/bin/sh\nsleep ${seconds}\n`);
  await chmod(hook, 0o755);
  return hook;
}

async function rejects(run: Promise<unknown>): Promise<CliError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  assert.fail("expected sync to fail");
}

test("push timeout message names the budget and does not claim the host is unreachable", () => {
  const timeout = withSharingDetails(
    new CliError("TRANSIENT", "git push did not finish within 600 seconds and was stopped; retry", {
      details: { op: "push", retryable: true, reason: "timeout", timeout_ms: PUSH_TIMEOUT_MS },
    }),
    { operation: "update-board" },
  );
  const message = pushFailureMessage(timeout);
  assert.equal(message, pushTimeoutMessage(PUSH_TIMEOUT_MS));
  assert.match(message, /did not finish within 600 seconds and was stopped\. The remote may already have it\. Run sync again to check and continue\.$/);
  assert.doesNotMatch(message, /could not reach/);
  const sharing = timeout.details?.sharing as Record<string, unknown>;
  assert.equal(sharing.possible_causes, undefined, "a timeout names no cause");
  assert.equal(sharing.local_work, "committed");
});

test("sync: a stalled push stops by the caller's deadline and reports a timeout, keeping the commit; the next sync finishes it", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "sb-push-timeout-home-")));
  try {
    await writeBoardDoc(topo.a, "notes/slow", { frontmatter: { type: "Note", title: "slow" }, body: "# slow\n" });
    const before = originBoardHead(topo);
    const hook = await stallPush(topo, 5);

    const out: string[] = [];
    const started = Date.now();
    const err = await withIsolatedUserEnv(home, () =>
      rejects(sync(["--dir", topo.a.board, "--json"], { stdout: (s) => void out.push(s), stderr: () => {}, hookInstalled: () => true, networkDeadline: Date.now() + 2_000 })),
    );
    assert.ok(Date.now() - started < 4_500, "stopped by the deadline, not when the hook finished");
    assert.equal(err.code, "TRANSIENT");
    assert.equal(err.details?.reason, "timeout");
    assert.equal(typeof err.details?.timeout_ms, "number");
    assert.ok((err.details?.timeout_ms as number) <= 2_000);
    assert.match(err.message, /The upload to origin\/board did not finish within \d+ seconds and was stopped\. The remote may already have it\./);
    assert.doesNotMatch(err.message, /could not reach/);
    const receipt = JSON.parse(out.join("")) as { warning: string; committed: number; details: { sharing: Record<string, unknown> } };
    assert.equal(receipt.warning, err.message);
    assert.equal(receipt.committed, 1);
    assert.equal(receipt.details.sharing.possible_causes, undefined);
    assert.equal(originBoardHead(topo), before, "the remote did not move");
    const committed = boardHead(topo.a);

    // The next sync, with the upload allowed to finish, sends the kept commit.
    await rm(hook);
    await withIsolatedUserEnv(home, () => sync(["--dir", topo.a.board, "--json"], { stdout: () => {}, stderr: () => {}, hookInstalled: () => true }));
    assert.equal(originBoardHead(topo), committed);
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("sync: when a stopped upload already reached the remote, the next sync sends nothing again", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "sb-push-landed-home-")));
  try {
    await writeBoardDoc(topo.a, "notes/landed", { frontmatter: { type: "Note", title: "landed" }, body: "# landed\n" });
    const hook = await stallPush(topo, 5);
    await withIsolatedUserEnv(home, () =>
      rejects(sync(["--dir", topo.a.board, "--json"], { stdout: () => {}, stderr: () => {}, hookInstalled: () => true, networkDeadline: Date.now() + 1_500 })),
    );
    // The remote received the update after all (the stop only lost the answer).
    await rm(hook);
    const committed = boardHead(topo.a);
    git(topo.a.board, ["push", "origin", `${committed}:refs/heads/board`]);

    const out: string[] = [];
    await withIsolatedUserEnv(home, () => sync(["--dir", topo.a.board, "--json"], { stdout: (s) => void out.push(s), stderr: () => {}, hookInstalled: () => true }));
    const receipt = JSON.parse(out.join("")) as { sent: number };
    assert.equal(receipt.sent, 0, "nothing is sent again");
    assert.equal(originBoardHead(topo), committed);
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("turn-end: the turn-end budget ends well before the Stop hook is killed", () => {
  assert.ok(TURN_END_BUDGET_MS < TURN_END_HOOK_TIMEOUT_SECONDS * 1000);
  assert.ok(TURN_END_BUDGET_MS < PUSH_TIMEOUT_MS);
});

test("turn-end --git-boards: a stalled upload is stopped by the turn-end deadline, not the push budget", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "sb-push-turn-end-home-")));
  try {
    await writeBoardDoc(topo.a, "notes/turn", { frontmatter: { type: "Note", title: "turn" }, body: "# turn\n" });
    const before = originBoardHead(topo);
    await stallPush(topo, 6);
    const started = Date.now();
    await withIsolatedUserEnv(home, () =>
      turnEnd(["--dir", topo.a.board, "--git-boards"], {
        stdout: () => {},
        env: {},
        readStdin: async () => null,
        hostedCheckout: async () => null,
        budgetMs: 2_000,
        syncDeps: { auth: defaultHostedAuthDeps(home) },
      }),
    );
    assert.ok(Date.now() - started < 5_000, "the default Git turn-end sync ended by its deadline");
    assert.equal(originBoardHead(topo), before);
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
