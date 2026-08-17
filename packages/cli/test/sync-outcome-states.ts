/**
 * `sync-outcome-states.ts` — deterministic repo states for the sync-outcome agreement suite
 * (`sync-outcomes.test.ts`). NOT a test file (no `.test.ts` suffix). The same builders produced
 * the committed fixtures (`fixtures/sync-outcomes/fixtures.json`) from the PRE-refactor code, so
 * the agreement test MUST keep these recipes byte-stable: a changed recipe changes probed state
 * (e.g. the tracked-remnant path list) and would break the freeze the fixtures pin.
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUNDLE_DIR } from "@superbee/board-git";
import { git } from "../../board-git/test/git-harness.js";

export interface OutcomeState {
  /** The repo top the probe-taking factory receives. */
  top: string;
  cleanup(): Promise<void>;
}

/** A plain one-commit repo on `main`, no remote — `boardWindowGuidance`'s DEFAULT (pull-first) arm. */
export async function makePlainTop(): Promise<OutcomeState> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "aslite-outcome-plain-")));
  git(dir, ["init", "-b", "main"]);
  await writeFile(path.join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  return { top: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The tracked-REMNANT state (`trackedBoardRemnantPaths` non-null): `origin/main`'s tip carries NO
 * `.superbee/`, that tip is an ancestor of HEAD, and HEAD still tracks exactly ONE board
 * path (`.superbee/tasks/extra.md`) — deterministic, so the remnant fixture's message count
 * and `tracked_remnants` rows are byte-stable.
 */
export async function makeRemnantTop(): Promise<OutcomeState> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "aslite-outcome-remnant-")));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  git(dir, ["init", "--bare", "origin.git"]);
  git(dir, ["init", "-b", "main", "repo"]);
  await writeFile(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial (no board folder)"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-u", "origin", "main"]);
  await mkdir(path.join(repo, BUNDLE_DIR, "tasks"), { recursive: true });
  await writeFile(
    path.join(repo, BUNDLE_DIR, "tasks", "extra.md"),
    "---\ntype: Task\ntitle: Extra\nactor: bob\n---\n# Extra\n",
  );
  git(repo, ["add", BUNDLE_DIR]);
  git(repo, ["commit", "-m", "board: re-added over the removal"]);
  return { top: repo, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A repo whose `refs/heads/board` exists (ffSwallowToError's unpublished-local-board probe). */
export async function makeLocalBoardTop(): Promise<OutcomeState> {
  const state = await makePlainTop();
  git(state.top, ["branch", "board"]);
  return state;
}
