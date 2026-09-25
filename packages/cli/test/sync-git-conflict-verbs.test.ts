// `sync --inspect` and `sync --resolve keep|take|revise` on a Git board: the hosted checkout's
// conflict grammar as aliases over the Git board's converge-and-export flow. The converge itself is
// pinned in sync-conflict.test.ts and must not change; these tests pin the aliases on top of it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { sync } from "../src/commands/sync.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import { bundleKey, syncExportsDir } from "../src/cursor.js";
import {
  deleteBoardDoc,
  git,
  makeTwoCloneTopology,
  modifyBoardDoc,
  readBoardFile,
  writeBoardDoc,
  type TwoCloneTopology,
} from "../../board-git/test/git-harness.js";

interface RunResult {
  out: string;
  err?: CliError;
}

async function runSync(home: string, argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  try {
    await withIsolatedUserEnv(home, () => sync(argv, { stdout: (text: string) => void out.push(text) }));
    return { out: out.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: out.join(""), err };
    throw err;
  }
}

async function runDoc(home: string, argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  try {
    await withIsolatedUserEnv(home, () => doc(argv, { stdout: (text: string) => void out.push(text) }));
    return { out: out.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: out.join(""), err };
    throw err;
  }
}

function exportPathFor(topo: TwoCloneTopology, home: string, relPath: string): string {
  return path.join(syncExportsDir(bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board }), home), relPath);
}

/** A converged conflict on tasks/seed-one: A's version on the board, B's saved aside. */
async function conflicted(): Promise<{ topo: TwoCloneTopology; homeA: string; homeB: string; cleanup: () => Promise<void> }> {
  const topo = await makeTwoCloneTopology();
  const homeA = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-b-"));
  await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nA's half.\n", frontmatter: { title: "Seed one (A)" } });
  const aSync = await runSync(homeA, ["--dir", topo.a.root]);
  assert.equal(aSync.err, undefined, aSync.err?.message);
  await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB's half.\n" });
  const bSync = await runSync(homeB, ["--dir", topo.b.root]);
  assert.equal(bSync.err?.exitCode, 5, "the plain sync converges exactly as before");
  return {
    topo,
    homeA,
    homeB,
    cleanup: async () => {
      await topo.cleanup();
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    },
  };
}

test("--inspect shows your saved version and the teammate's, and --inspect <id> is its alias", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const shown = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(shown.err, undefined, shown.err?.message);
    const record = JSON.parse(shown.out) as Record<string, any>;
    assert.equal(record.conflict, "tasks/seed-one");
    assert.equal(record.reason, "changed_remotely");
    assert.match(record.local.content, /B's half/);
    assert.equal(record.local.saved_at, exportPathFor(topo, homeB, "tasks/seed-one.md"));
    assert.match(record.remote.content, /A's half/);
    assert.deepEqual(record.frontmatter_differs, ["title"]);
    assert.deepEqual(Object.keys(record.choices), ["keep", "take", "revise"]);
    assert.equal(record.help.length, 3);

    const alias = await runSync(homeB, ["--inspect", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.deepEqual(JSON.parse(alias.out), record);

    // TOON by default, like every other command.
    const toon = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", topo.b.root]);
    assert.match(toon.out, /^conflict: tasks\/seed-one/m);

    // Inspecting changes nothing: the saved copy and the board stay put.
    assert.ok(existsSync(exportPathFor(topo, homeB, "tasks/seed-one.md")));
    assert.equal(git(topo.b.board, ["status", "--porcelain"]), "");
  } finally {
    await cleanup();
  }
});

test("--inspect --out writes the teammate's version whole, and refuses a path inside the bundle", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const out = path.join(homeB, "theirs.md");
    const written = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--out", out, "--dir", topo.b.root, "--json"]);
    assert.equal(written.err, undefined, written.err?.message);
    assert.equal(await readFile(out, "utf8"), git(topo.b.board, ["show", "refs/remotes/origin/board:tasks/seed-one.md"]));

    const inside = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--out", path.join(topo.b.board, "theirs.md"), "--dir", topo.b.root]);
    assert.equal(inside.err?.code, "USAGE");
    assert.equal(existsSync(path.join(topo.b.board, "theirs.md")), false);
  } finally {
    await cleanup();
  }
});

test("--resolve take keeps the teammate's version, discards the saved copy, and has nothing to push", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const before = await readBoardFile(topo.b, "tasks/seed-one.md");
    const taken = await runSync(homeB, ["--resolve", "take", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    const record = JSON.parse(taken.out) as Record<string, any>;
    assert.equal(record.choice, "take");
    assert.equal(record.file_state, "unchanged");
    assert.equal(record.sent, false);
    assert.deepEqual(record.help, []);
    assert.equal(await readBoardFile(topo.b, "tasks/seed-one.md"), before);
    assert.equal(existsSync(exportPathFor(topo, homeB, "tasks/seed-one.md")), false);
    assert.equal(existsSync(exportPathFor(topo, homeB, "tasks/seed-one.body.md")), false);

    // The conflict is settled: a second inspect has nothing to show.
    const again = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", topo.b.root]);
    assert.equal(again.err?.code, "NOT_FOUND");
  } finally {
    await cleanup();
  }
});

test("--resolve keep writes your saved body with doc update, and the next sync pushes it", async () => {
  const { topo, homeA, homeB, cleanup } = await conflicted();
  try {
    const kept = await runSync(homeB, ["--resolve", "keep", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    const record = JSON.parse(kept.out) as Record<string, any>;
    assert.equal(record.file_state, "written");
    assert.equal(record.sent, false, "--resolve never pushes");
    assert.deepEqual(record.frontmatter_not_carried, ["title"], "only the body is carried, as in the reconcile chain");
    assert.equal(record.help.length, 1);
    assert.match(await readBoardFile(topo.b, "tasks/seed-one.md"), /B's half/);
    assert.equal(existsSync(exportPathFor(topo, homeB, "tasks/seed-one.md")), false);

    const pushed = await runSync(homeB, ["--dir", topo.b.root]);
    assert.equal(pushed.err, undefined, pushed.err?.message);
    assert.match(git(topo.origin, ["show", "board:tasks/seed-one.md"]), /B's half/);
    const pulled = await runSync(homeA, ["--dir", topo.a.root, "--pull-only"]);
    assert.equal(pulled.err, undefined, pulled.err?.message);
  } finally {
    await cleanup();
  }
});

test("--resolve revise records the document as it was edited, and the next sync pushes it", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const merged = path.join(homeB, "merged.md");
    await writeFile(merged, "# Seed one\n\nA's half.\n\nB's half.\n");
    const edited = await runDoc(homeB, ["update", "tasks/seed-one", "--body-file", merged, "--dir", topo.b.board]);
    assert.equal(edited.err, undefined, edited.err?.message);

    const revised = await runSync(homeB, ["--resolve", "revise", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(revised.err, undefined, revised.err?.message);
    const record = JSON.parse(revised.out) as Record<string, any>;
    assert.equal(record.choice, "revise");
    assert.equal(record.file_state, "unchanged");
    assert.equal(record.help.length, 1, "the edited document is waiting to push");

    const pushed = await runSync(homeB, ["--dir", topo.b.root]);
    assert.equal(pushed.err, undefined, pushed.err?.message);
    const origin = git(topo.origin, ["show", "board:tasks/seed-one.md"]);
    assert.match(origin, /A's half/);
    assert.match(origin, /B's half/);
  } finally {
    await cleanup();
  }
});

test("--resolve keep re-creates a document the teammate deleted", async () => {
  const topo = await makeTwoCloneTopology();
  const homeA = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-b-"));
  try {
    await deleteBoardDoc(topo.a, "tasks/seed-one");
    assert.equal((await runSync(homeA, ["--dir", topo.a.root])).err, undefined);
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB kept working.\n" });
    assert.equal((await runSync(homeB, ["--dir", topo.b.root])).err?.exitCode, 5);

    const shown = JSON.parse((await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"])).out) as Record<string, any>;
    assert.equal(shown.reason, "deleted_remotely");
    assert.equal(shown.remote.deleted, true);

    const kept = await runSync(homeB, ["--resolve", "keep", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    assert.equal((JSON.parse(kept.out) as Record<string, unknown>).file_state, "re-created");
    assert.match(await readBoardFile(topo.b, "tasks/seed-one.md"), /B kept working/);
    assert.equal((await runSync(homeB, ["--dir", topo.b.root])).err, undefined);
    assert.match(git(topo.origin, ["show", "board:tasks/seed-one.md"]), /B kept working/);
  } finally {
    await topo.cleanup();
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
  }
});

test("conflict verbs refuse cleanly: no saved conflict, bad arguments, and hosted-only verbs", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const none = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-two", "--dir", topo.b.root]);
    assert.equal(none.err?.code, "NOT_FOUND");
    assert.ok(none.err?.help, "a refusal names the next step");

    for (const argv of [
      ["--inspect"],
      ["--resolve", "keep"],
      ["--resolve", "merge", "--doc", "tasks/seed-one"],
      ["--doc", "tasks/seed-one"],
      ["--inspect", "--doc", "tasks/seed-one", "--resolve", "take"],
      ["--resolve", "take", "--doc", "tasks/seed-one", "--out", "x.md"],
      ["--inspect", "--doc", "tasks/seed-one", "--pull-only"],
      ["--inspect", "--doc", "log"],
    ]) {
      const refused = await runSync(homeB, [...argv, "--dir", topo.b.root]);
      assert.equal(refused.err?.code, "USAGE", argv.join(" "));
    }
    const hostedOnly = await runSync(homeB, ["--restore-deletes", "--dir", topo.b.root]);
    assert.equal(hostedOnly.err?.code, "USAGE");
    assert.match(hostedOnly.err!.message, /apply to a hosted checkout/);

    // The saved copy survived every refusal.
    assert.ok(existsSync(exportPathFor(topo, homeB, "tasks/seed-one.md")));
  } finally {
    await cleanup();
  }
});

test("a local-only bundle has no sync conflicts to inspect", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-local-"));
  try {
    const bundle = path.join(home, "bundle");
    await mkdir(bundle);
    assert.equal((await runDoc(home, ["write", "notes/one", "--type", "Note", "--title", "One", "--dir", bundle])).err, undefined);
    const refused = await runSync(home, ["--inspect", "--doc", "notes/one", "--dir", bundle]);
    assert.equal(refused.err?.code, "USAGE");
    assert.match(refused.err!.message, /neither/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("--resolve take restores the teammate's version over an edit made since the converge", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const theirs = git(topo.b.board, ["show", "refs/remotes/origin/board:tasks/seed-one.md"]);
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nAn edit after the conflict.\n" });
    const taken = await runSync(homeB, ["--resolve", "take", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    const record = JSON.parse(taken.out) as Record<string, any>;
    assert.equal(record.file_state, "restored");
    assert.deepEqual(record.help, [], "nothing of yours is left to push");
    assert.equal(await readBoardFile(topo.b, "tasks/seed-one.md"), theirs);
  } finally {
    await cleanup();
  }
});

test("--resolve revise refuses while a document the teammate deleted is still absent", async () => {
  const topo = await makeTwoCloneTopology();
  const homeA = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-b-"));
  try {
    await deleteBoardDoc(topo.a, "tasks/seed-one");
    assert.equal((await runSync(homeA, ["--dir", topo.a.root])).err, undefined);
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB kept working.\n" });
    assert.equal((await runSync(homeB, ["--dir", topo.b.root])).err?.exitCode, 5);
    const revised = await runSync(homeB, ["--resolve", "revise", "--doc", "tasks/seed-one", "--dir", topo.b.root]);
    assert.equal(revised.err?.code, "CONFLICT");
    assert.ok(existsSync(exportPathFor(topo, homeB, "tasks/seed-one.md")), "the saved copy survives the refusal");
  } finally {
    await topo.cleanup();
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
  }
});

test("--dir may name any folder of the project, as it may for a plain sync", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const shown = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", path.join(topo.b.root, "src"), "--json"]);
    assert.equal(shown.err, undefined, shown.err?.message);
    const board = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", topo.b.board, "--json"]);
    assert.equal(board.err, undefined, board.err?.message);
  } finally {
    await cleanup();
  }
});

test("--inspect --out refuses a symbolic link and stdout", async () => {
  const { topo, homeB, cleanup } = await conflicted();
  try {
    const link = path.join(homeB, "theirs.md");
    await symlink(path.join(topo.b.board, "tasks", "planted.md"), link);
    const linked = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--out", link, "--dir", topo.b.root]);
    assert.equal(linked.err?.code, "USAGE");
    assert.equal(existsSync(path.join(topo.b.board, "tasks", "planted.md")), false);
    const dash = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--out", "-", "--dir", topo.b.root]);
    assert.equal(dash.err?.code, "USAGE");
  } finally {
    await cleanup();
  }
});

test("a lost claim is reported, never offered back: no keep, and no owner field to re-apply", async () => {
  const topo = await makeTwoCloneTopology();
  const homeA = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "sb-conflict-verbs-b-"));
  try {
    await writeBoardDoc(topo.a, "conventions/task", {
      frontmatter: {
        type: "Convention",
        title: "Task",
        governs: "Task",
        fields: {
          required: ["title", "superbee_progress_status"],
          optional: ["assignee", "description"],
          values: { superbee_progress_status: ["todo", "in_progress", "done", "canceled"] },
        },
        claim: { owner_field: "assignee", state_field: "progress_status" },
      },
      body: "# Task\n\nA unit of work.\n",
    });
    await modifyBoardDoc(topo.a, "tasks/seed-one", { frontmatter: { superbee_progress_status: "todo" }, body: "# Seed one\n\nseed body\n" });
    assert.equal((await runSync(homeA, ["--dir", topo.a.root])).err, undefined);
    assert.equal((await runSync(homeB, ["--dir", topo.b.root, "--pull-only"])).err, undefined);
    const claim = (owner: string) => ({ frontmatter: { assignee: owner, superbee_progress_status: "in_progress", superbee_updated_by: owner } });
    await modifyBoardDoc(topo.a, "tasks/seed-one", claim("agent-a"));
    assert.equal((await runSync(homeA, ["--dir", topo.a.root])).err, undefined);
    await modifyBoardDoc(topo.b, "tasks/seed-one", claim("agent-b"));
    assert.equal((await runSync(homeB, ["--dir", topo.b.root])).err?.exitCode, 5);

    const shown = await runSync(homeB, ["--inspect", "--doc", "tasks/seed-one", "--dir", topo.b.root, "--json"]);
    assert.equal(shown.err, undefined, shown.err?.message);
    const record = JSON.parse(shown.out) as Record<string, any>;
    assert.match(record.claim_lost, /owner is agent-a as of origin\/board@/);
    assert.equal(record.frontmatter_differs, undefined);
    assert.deepEqual(Object.keys(record.choices), ["take", "revise"]);
    assert.doesNotMatch(JSON.stringify(record.help), /--resolve keep/);

    const kept = await runSync(homeB, ["--resolve", "keep", "--doc", "tasks/seed-one", "--dir", topo.b.root]);
    assert.equal(kept.err?.code, "CONFLICT");
    assert.doesNotMatch(`${kept.err!.message} ${kept.err!.help}`, /assignee/);
  } finally {
    await topo.cleanup();
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
  }
});
