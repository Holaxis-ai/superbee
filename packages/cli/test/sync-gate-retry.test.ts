// `superbee sync` on a Git board: the declared pre-push gate (`superbee.syncGate`) and the bounded
// retry after a lost push race. Races are made deterministic with a `pre-push` hook in the syncing
// clone that pushes another writer's commit between sync's rebase and its push — exactly the
// window a concurrent writer hits in the field.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sync } from "../src/commands/sync.js";
import { SYNC_PUSH_ATTEMPTS } from "../src/commands/sync/orchestrate.js";
import { CliError } from "../src/errors.js";
import { withIsolatedUserEnv } from "./support/user-env.js";
import {
  BOARD_BRANCH,
  commitBoard,
  git,
  makeTwoCloneTopology,
  modifyBoardDoc,
  pushBoard,
  readBoardFile,
  writeBoardDoc,
  type TwoCloneTopology,
} from "../../board-git/test/git-harness.js";

async function runSync(home: string, argv: string[]): Promise<{ out: string; err?: CliError }> {
  const chunks: string[] = [];
  try {
    await withIsolatedUserEnv(home, () => sync(argv, { stdout: (s) => chunks.push(s), hookInstalled: () => true }));
    return { out: chunks.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: chunks.join(""), err };
    throw err;
  }
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-sync-gate-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const originBoard = (topo: TwoCloneTopology): string => git(topo.origin, ["rev-parse", BOARD_BRANCH]).trim();

async function note(topo: TwoCloneTopology, clone: "a" | "b", id: string, body = `# ${id}\n`): Promise<void> {
  await writeBoardDoc(topo[clone], id, { frontmatter: { type: "Note", title: id }, body });
}

/**
 * Install a `pre-push` hook in clone A that, while `<state>/races` holds a positive count, makes
 * clone B push one more commit first (writing `doc` there) and decrements the count.
 */
async function installRacingHook(topo: TwoCloneTopology, state: string, races: number, doc: string, body?: string): Promise<void> {
  await writeFile(path.join(state, "races"), String(races));
  const hooks = path.join(topo.a.root, ".git", "hooks");
  const docPath = path.join(topo.b.board, `${doc}.md`);
  const content = body ?? "";
  const script = `#!/bin/sh
n=$(cat '${state}/races')
[ "$n" -gt 0 ] || exit 0
echo $((n - 1)) > '${state}/races'
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
cd '${topo.b.board}' || exit 1
if [ -n '${content}' ]; then
  printf '%s' '${content}' > '${docPath}'
else
  printf -- '---\\ntype: Note\\ntitle: race %s\\n---\\n# race %s\\n' "$n" "$n" > '${topo.b.board}/notes/race-'"$n"'.md'
fi
git add -A >/dev/null && git commit -q -m "other writer $n" && git push -q origin board >/dev/null 2>&1
exit 0
`;
  await writeFile(path.join(hooks, "pre-push"), script);
  await chmod(path.join(hooks, "pre-push"), 0o755);
}

/** A gate script that records each invocation's attempt and environment, then exits `code`. */
async function recordingGate(state: string, code = 0): Promise<string> {
  const script = path.join(state, "gate.sh");
  await writeFile(
    script,
    `#!/bin/sh
echo "$SUPERBEE_SYNC_ATTEMPT $SUPERBEE_BOARD_BRANCH $SUPERBEE_BOARD_UPSTREAM_REF $SUPERBEE_BOARD_UPSTREAM_SHA $SUPERBEE_BOARD_HEAD_SHA $(git rev-parse HEAD) $(pwd -P)" >> '${state}/gate.log'
echo "gate output line"
exit ${code}
`,
  );
  await chmod(script, 0o755);
  return script;
}

async function gateLog(state: string): Promise<string[][]> {
  const file = path.join(state, "gate.log");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => line.split(" "));
}

test("sync gate: a failing gate holds the push with the work committed; a passing gate releases it", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: state, cleanup } = await scratch();
  try {
    const before = originBoard(topo);
    await note(topo, "a", "notes/gated");
    git(topo.a.root, ["config", "superbee.syncGate", `${await recordingGate(state, 3)}`]);

    const held = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(held.err?.code, "GATE_FAILED");
    assert.equal(held.err?.exitCode, 5);
    assert.match(held.out, /your work is saved\. The sync gate exited 3 on the rebased board, so nothing was pushed/);
    assert.match(held.out, /gate output line/, "the failing gate's output tail is reported");
    assert.equal(originBoard(topo), before, "nothing was pushed");
    assert.equal(git(topo.a.board, ["rev-list", "--count", "origin/board..HEAD"]).trim(), "1", "the work stays committed locally");
    assert.equal(git(topo.a.board, ["status", "--porcelain"]), "");

    git(topo.a.root, ["config", "superbee.syncGate", `${await recordingGate(state, 0)}`]);
    const released = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(released.err, undefined, released.err?.message);
    assert.match(released.out, /pushed: 1/);
    assert.match(released.out, /gate: "passed: .*gate\.sh \(attempt 1\)"/);
    assert.equal(originBoard(topo), git(topo.a.board, ["rev-parse", "HEAD"]).trim());
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync gate: judges the rebased tree and is told exactly which commits it judges", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: state, cleanup } = await scratch();
  try {
    await note(topo, "b", "notes/from-b");
    commitBoard(topo.b, "teammate");
    pushBoard(topo.b);
    const teammateTip = originBoard(topo);

    await note(topo, "a", "notes/from-a");
    // The gate passes only when the teammate's document is present: it must see the rebased tree.
    const gate = path.join(state, "needs-teammate.sh");
    await writeFile(gate, `#!/bin/sh\ntest -f notes/from-b.md && test -f notes/from-a.md && ${await recordingGate(state, 0)}\n`);
    await chmod(gate, 0o755);
    git(topo.a.root, ["config", "superbee.syncGate", gate]);

    const result = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(result.err, undefined, result.err?.message);
    const [run] = await gateLog(state);
    const head = git(topo.a.board, ["rev-parse", "HEAD"]).trim();
    assert.deepEqual(run, ["1", "board", "origin/board", teammateTip, head, head, await realBoard(topo)]);
    assert.equal(originBoard(topo), head, "exactly the judged commit was pushed");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

async function realBoard(topo: TwoCloneTopology): Promise<string> {
  return git(topo.a.board, ["rev-parse", "--show-toplevel"]).trim();
}

test("sync gate: a gate that edits the board fails, and an idle sync never runs the gate", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: state, cleanup } = await scratch();
  try {
    git(topo.a.root, ["config", "superbee.syncGate", "false"]);
    const idle = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(idle.err, undefined, "nothing to push: the gate does not run");

    const before = originBoard(topo);
    await note(topo, "a", "notes/edited-by-gate");
    git(topo.a.root, ["config", "superbee.syncGate", "echo tampered >> notes/edited-by-gate.md"]);
    const tampered = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(tampered.err?.code, "GATE_FAILED");
    assert.equal((tampered.err?.details?.gate as { modified_board?: boolean }).modified_board, true);
    assert.equal(originBoard(topo), before);

    // An empty value at a narrower scope declares no gate.
    git(topo.a.board, ["checkout", "--", "notes/edited-by-gate.md"]);
    git(topo.a.root, ["config", "superbee.syncGate", ""]);
    const ungated = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(ungated.err, undefined, ungated.err?.message);
    assert.match(ungated.out, /pushed: 1/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync race: a lost push re-fetches, rebases, re-gates and pushes; nothing is reported as a permission problem", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: state, cleanup } = await scratch();
  try {
    await note(topo, "a", "notes/mine");
    git(topo.a.root, ["config", "superbee.syncGate", await recordingGate(state, 0)]);
    await installRacingHook(topo, state, 1, "notes/race");

    const result = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /pushed: 1/);
    assert.match(result.out, /notes\/race-1/, "the receipt reports what arrived during the retry");
    const runs = await gateLog(state);
    assert.deepEqual(runs.map((r) => r[0]), ["1", "2"], "the gate re-ran on the re-rebased tree");
    assert.notEqual(runs[0]![4], runs[1]![4], "the second attempt judged a different (rebased) head");
    const tip = originBoard(topo);
    assert.equal(tip, git(topo.a.board, ["rev-parse", "HEAD"]).trim());
    assert.equal(git(topo.a.board, ["log", "-1", "--format=%s", "HEAD~1"]).trim(), "other writer 1");
    assert.ok(existsSync(path.join(topo.a.board, "notes", "race-1.md")));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync race: retries are bounded, keep the work, and classify the failure as a race", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: state, cleanup } = await scratch();
  try {
    await note(topo, "a", "notes/never-lands");
    await installRacingHook(topo, state, 100, "notes/race");

    const result = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(result.err?.code, "TRANSIENT");
    assert.equal(result.err?.exitCode, 1);
    assert.equal(result.err?.details?.reason, "non-fast-forward");
    assert.equal(result.err?.details?.attempts, SYNC_PUSH_ATTEMPTS);
    assert.match(result.err?.message ?? "", /your work is saved\. another writer pushed to the board each time sync tried/);
    const sharing = result.err?.details?.sharing as Record<string, unknown>;
    assert.equal(sharing.possible_causes, undefined, "no permission or policy causes are suggested for a race");
    assert.equal(sharing.required_authority, undefined);
    assert.doesNotMatch(result.out, /Write access|branch rule|policy/i);
    assert.equal(Number((await readFile(path.join(state, "races"), "utf8")).trim()), 100 - SYNC_PUSH_ATTEMPTS);
    assert.equal(git(topo.a.board, ["status", "--porcelain"]), "");
    assert.equal(git(topo.a.board, ["rev-list", "--count", "origin/board..HEAD"]).trim(), "1", "the commit is kept, unpushed");
    git(topo.a.board, ["cat-file", "-e", "HEAD:notes/never-lands.md"]);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync race: a conflicting commit that wins the race converges (exit 5) and pushes nothing", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: state, cleanup } = await scratch();
  try {
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# mine\n" });
    const theirs = "---\ntype: Task\ntitle: Seed one\nactor: brian\n---\n# theirs\n";
    await installRacingHook(topo, state, 1, "tasks/seed-one", theirs);

    const result = await runSync(path.join(state, "home"), ["--dir", topo.a.root]);
    assert.equal(result.err?.code, "CONFLICT");
    assert.equal(result.err?.exitCode, 5);
    assert.match(await readBoardFile(topo.a, "tasks/seed-one.md"), /# theirs/, "upstream's version is kept");
    assert.equal(originBoard(topo), git(topo.b.board, ["rev-parse", "HEAD"]).trim(), "only the winner is on origin");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});
