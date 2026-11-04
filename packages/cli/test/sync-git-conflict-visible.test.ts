// A saved Git board conflict stays visible until it is settled, and a settling verb never deletes
// what it did not carry. Every test runs on real temp boards through the same in-process commands
// a person runs; sync-git-conflict-verbs.test.ts pins the verbs themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { sync } from "../src/commands/sync.js";
import { doc } from "../src/commands/doc.js";
import { status } from "../src/commands/status.js";
import { sessionStart } from "../src/commands/session-start.js";
import { turnEnd } from "../src/commands/turn-end.js";
import { CliError } from "../src/errors.js";
import { bundleKey, syncExportsDir } from "../src/cursor.js";
import {
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

async function capture(home: string, run: (stdout: (text: string) => void) => Promise<void>): Promise<RunResult> {
  const out: string[] = [];
  try {
    await withIsolatedUserEnv(home, () => run((text) => void out.push(text)));
    return { out: out.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: out.join(""), err };
    throw err;
  }
}

const runSync = (home: string, argv: string[]): Promise<RunResult> => capture(home, (stdout) => sync(argv, { stdout }));
const runDoc = (home: string, argv: string[]): Promise<RunResult> => capture(home, (stdout) => doc(argv, { stdout }));

async function syncBlock(topo: TwoCloneTopology, home: string): Promise<Record<string, any>> {
  const shown = await capture(home, (stdout) =>
    status(["--dir", topo.b.board, "--json"], { stdout, home, autoPull: async () => undefined }),
  );
  assert.equal(shown.err, undefined, shown.err?.message);
  return JSON.parse(shown.out) as Record<string, any>;
}

function exportsOf(topo: TwoCloneTopology, home: string): string {
  return syncExportsDir(bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board }), home);
}

interface Fixture {
  topo: TwoCloneTopology;
  homeA: string;
  homeB: string;
  /** One more converge on `id`: A publishes `theirs` first, then B's sync runs into it with `yours`. */
  collide(id: string, theirs: Parameters<typeof modifyBoardDoc>[2], yours: Parameters<typeof modifyBoardDoc>[2]): Promise<RunResult>;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const topo = await makeTwoCloneTopology();
  const homeA = await mkdtemp(path.join(tmpdir(), "sb-conflict-visible-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "sb-conflict-visible-b-"));
  return {
    topo,
    homeA,
    homeB,
    async collide(id, theirs, yours) {
      await modifyBoardDoc(topo.a, id, theirs);
      const aSync = await runSync(homeA, ["--dir", topo.a.root]);
      assert.equal(aSync.err, undefined, aSync.err?.message);
      await modifyBoardDoc(topo.b, id, yours);
      const bSync = await runSync(homeB, ["--dir", topo.b.root]);
      assert.equal(bSync.err?.exitCode, 5, "the plain sync converges");
      return bSync;
    },
    async cleanup() {
      await topo.cleanup();
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    },
  };
}

const ID = "tasks/seed-one";

test("an unresolved conflict stays named by status, by every later sync, and by session-start", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });

    const record = await syncBlock(f.topo, f.homeB);
    assert.equal(record.sync.state, "needs_decision");
    assert.equal(record.sync.conflicts, 1);
    assert.deepEqual(record.sync.conflict_ids, [ID]);
    assert.ok(record.help.some((line: string) => line.includes(`sync --inspect --doc ${ID}`)), "status says what to do");

    const again = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(again.err, undefined, "a copy from an earlier run does not change the exit code");
    const receipt = JSON.parse(again.out) as Record<string, any>;
    assert.equal(receipt.conflicts, 1);
    assert.equal(receipt.saved_conflicts.rows[0].id, ID);
    assert.ok(receipt.next.some((line: string) => line.includes(`sync --inspect --doc ${ID}`)));

    const started = await capture(f.homeB, (stdout) =>
      sessionStart(["--dir", f.topo.b.root, "--json"], { stdout, pull: async () => undefined }),
    );
    assert.equal(started.err, undefined, started.err?.message);
    assert.match(started.out, /saved_conflicts/);
    assert.match(started.out, /tasks\/seed-one/);
  } finally {
    await f.cleanup();
  }
});

test("turn end neither blocks nor syncs for a saved copy alone", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });
    let syncs = 0;
    const ran = await capture(f.homeB, (stdout) =>
      turnEnd(["--git-boards", "--dir", f.topo.b.root], { stdout, env: {}, readStdin: async () => null, gitSync: async () => void syncs++ }),
    );
    assert.equal(ran.err, undefined, ran.err?.message);
    assert.equal(ran.out, "");
    assert.equal(syncs, 0);
  } finally {
    await f.cleanup();
  }
});

test("a pull-only sync names the unresolved conflict without failing", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });
    const pulled = await runSync(f.homeB, ["--dir", f.topo.b.root, "--pull-only", "--json"]);
    assert.equal(pulled.err, undefined, pulled.err?.message);
    const receipt = JSON.parse(pulled.out) as Record<string, any>;
    assert.equal(receipt.conflicts, 1);
    assert.equal(receipt.saved_conflicts.rows[0].id, ID);
  } finally {
    await f.cleanup();
  }
});

test("a repeat conflict on one document keeps both saved copies, and each is settled in turn", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA first.\n" }, { body: "# Seed one\n\nB first.\n" });
    const second = await f.collide(ID, { body: "# Seed one\n\nA second.\n" }, { body: "# Seed one\n\nB second.\n" });
    const primary = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    assert.match(await readFile(primary, "utf8"), /B first/, "the earlier copy is untouched");
    const conflicts = second.err?.details?.conflicts as { rows: Record<string, string>[] };
    const newest = conflicts.rows[0]!.yours!;
    assert.notEqual(newest, primary);
    assert.match(await readFile(newest, "utf8"), /B second/);
    assert.match(await readFile(conflicts.rows[0]!.yours_body!, "utf8"), /B second/);
    assert.match(second.err?.message ?? "", new RegExp(`yours saved at ${newest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const block = await syncBlock(f.topo, f.homeB);
    assert.equal(block.sync.conflicts, 1, "one document, two copies");

    // Oldest first, so the newest copy has the last word.
    const shown = await runSync(f.homeB, ["--inspect", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    const inspected = JSON.parse(shown.out) as Record<string, any>;
    assert.match(inspected.local.content, /B first/);
    assert.deepEqual(inspected.later_copies, [newest]);

    const dropped = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(dropped.err, undefined, dropped.err?.message);
    assert.deepEqual(JSON.parse(dropped.out).later_copies, [newest]);
    assert.equal(existsSync(primary), false);
    assert.equal(existsSync(newest), true, "settling one copy leaves the other");
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "needs_decision");

    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    assert.equal(existsSync(newest), false);
    assert.match(await readBoardFile(f.topo.b, `${ID}.md`), /B second/);

    const pushed = await runSync(f.homeB, ["--dir", f.topo.b.root]);
    assert.equal(pushed.err, undefined, pushed.err?.message);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean");
  } finally {
    await f.cleanup();
  }
});

test("taking an earlier copy leaves the document alone while a later copy waits", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA first.\n" }, { body: "# Seed one\n\nB first.\n" });
    await f.collide(ID, { body: "# Seed one\n\nA second.\n" }, { body: "# Seed one\n\nB second.\n" });
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nMerged by hand.\n" });
    const dropped = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(dropped.err, undefined, dropped.err?.message);
    assert.equal(JSON.parse(dropped.out).file_state, "unchanged");
    assert.match(await readBoardFile(f.topo.b, `${ID}.md`), /Merged by hand/);
  } finally {
    await f.cleanup();
  }
});

test("every settled route stops the report: take, keep, revise, the reconcile chain, and a removed copy", async () => {
  const yours = { body: "# Seed one\n\nB's half.\n" };
  const theirs = { body: "# Seed one\n\nA's half.\n" };
  const routes: Record<string, (f: Fixture) => Promise<void>> = {
    take: async (f) => void assert.equal((await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root])).err, undefined),
    keep: async (f) => void assert.equal((await runSync(f.homeB, ["--resolve", "keep", "--doc", ID, "--dir", f.topo.b.root])).err, undefined),
    revise: async (f) => {
      await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nMerged.\n" });
      assert.equal((await runSync(f.homeB, ["--resolve", "revise", "--doc", ID, "--dir", f.topo.b.root])).err, undefined);
    },
    chain: async (f) => {
      const body = path.join(exportsOf(f.topo, f.homeB), `${ID}.body.md`);
      assert.equal((await runDoc(f.homeB, ["update", ID, "--body-file", body, "--dir", f.topo.b.root])).err, undefined);
    },
    removed: async (f) => {
      await rm(path.join(exportsOf(f.topo, f.homeB), `${ID}.md`));
      await rm(path.join(exportsOf(f.topo, f.homeB), `${ID}.body.md`));
    },
  };
  for (const [name, settle] of Object.entries(routes)) {
    const f = await fixture();
    try {
      await f.collide(ID, theirs, yours);
      await settle(f);
      const block = await syncBlock(f.topo, f.homeB);
      assert.equal(block.sync.conflicts, undefined, `${name}: status stops naming it`);
      const next = await runSync(f.homeB, ["--dir", f.topo.b.root]);
      assert.equal(next.err, undefined, `${name}: ${next.err?.message}`);
      assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean", name);

      // A later teammate edit must not bring a settled copy back.
      assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root, "--pull-only"])).err, undefined);
      await modifyBoardDoc(f.topo.a, ID, { body: "# Seed one\n\nA moved on.\n" });
      assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
      const after = await runSync(f.homeB, ["--dir", f.topo.b.root]);
      assert.equal(after.err, undefined, `${name} after a teammate edit: ${after.err?.message}`);
    } finally {
      await f.cleanup();
    }
  }
});

test("a sync that still names a conflict sends the rest of the work", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });
    await writeBoardDoc(f.topo.b, "tasks/other", { frontmatter: { type: "Task", title: "Other" }, body: "Other.\n" });
    const next = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(next.err, undefined, next.err?.message);
    assert.equal(JSON.parse(next.out).pushed, 1);
    assert.equal(git(f.topo.origin, ["cat-file", "-t", "board:tasks/other.md"]).trim(), "blob");
  } finally {
    await f.cleanup();
  }
});

test("--resolve keep refuses when your saved copy differs in frontmatter: nothing written, nothing deleted", async () => {
  const f = await fixture();
  try {
    await writeBoardDoc(f.topo.a, "u/fm", { frontmatter: { type: "Note", title: "FM" }, body: "base\n" });
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);

    // Bob edits only the title, Alice only the body.
    // The CLI stamps both writes, which is what makes these edits collide in the frontmatter.
    assert.equal((await runDoc(f.homeA, ["update", "u/fm", "--body", "alice\n", "--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runDoc(f.homeB, ["update", "u/fm", "--title", "Bob's title", "--dir", f.topo.b.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5, "the plain sync converges");
    const saved = path.join(exportsOf(f.topo, f.homeB), "u/fm.md");
    const before = await readBoardFile(f.topo.b, "u/fm.md");

    const refused = await runSync(f.homeB, ["--resolve", "keep", "--doc", "u/fm", "--dir", f.topo.b.root, "--json"]);
    assert.equal(refused.err?.exitCode, 5);
    assert.deepEqual(refused.err?.details?.frontmatter_differs, ["title"]);
    assert.equal(refused.err?.details?.saved_at, saved);
    assert.match(refused.err?.help ?? "", /--resolve revise --doc u\/fm/);
    assert.match(await readFile(saved, "utf8"), /Bob's title/, "the only copy of Bob's title survives");
    assert.equal(await readBoardFile(f.topo.b, "u/fm.md"), before, "Alice's body is untouched");

    const inspected = JSON.parse((await runSync(f.homeB, ["--inspect", "--doc", "u/fm", "--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.deepEqual(Object.keys(inspected.choices), ["take", "revise"], "a keep that would lose a field is not offered");
    assert.ok(!inspected.help.some((line: string) => line.includes("--resolve keep")));

    // The refusal's route: apply the field, then record the result.
    assert.equal((await runDoc(f.homeB, ["update", "u/fm", "--title", "Bob's title", "--dir", f.topo.b.root])).err, undefined);
    const revised = await runSync(f.homeB, ["--resolve", "revise", "--doc", "u/fm", "--dir", f.topo.b.root, "--json"]);
    assert.equal(revised.err, undefined, revised.err?.message);
    assert.equal(existsSync(saved), false);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    const landed = git(f.topo.origin, ["show", "board:u/fm.md"]);
    assert.match(landed, /Bob's title/);
    assert.match(landed, /alice/, "both people's work landed");
  } finally {
    await f.cleanup();
  }
});

test("--resolve revise refuses a document still equal to the teammate's, which would discard your only copy", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const refused = await runSync(f.homeB, ["--resolve", "revise", "--doc", ID, "--dir", f.topo.b.root]);
    assert.equal(refused.err?.exitCode, 5);
    assert.equal(existsSync(saved), true);
    assert.match(refused.err?.help ?? "", /--resolve take/);
  } finally {
    await f.cleanup();
  }
});

test("--resolve keep refuses to re-create a deleted document without fields the re-creation would drop", async () => {
  const f = await fixture();
  try {
    await writeBoardDoc(f.topo.a, "u/rich", { frontmatter: { type: "Note", title: "Rich", priority: "high" }, body: "base\n" });
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    await rm(path.join(f.topo.a.board, "u/rich.md"));
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    await modifyBoardDoc(f.topo.b, "u/rich", { body: "edited\n" });
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);

    const saved = path.join(exportsOf(f.topo, f.homeB), "u/rich.md");
    const refused = await runSync(f.homeB, ["--resolve", "keep", "--doc", "u/rich", "--dir", f.topo.b.root]);
    assert.equal(refused.err?.exitCode, 5);
    assert.deepEqual(refused.err?.details?.frontmatter_differs, ["priority"]);
    assert.equal(existsSync(saved), true);
    assert.equal(existsSync(path.join(f.topo.b.board, "u/rich.md")), false);
  } finally {
    await f.cleanup();
  }
});

test("--resolve take and a body-only keep still settle in one step", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { frontmatter: { title: "B's title" }, body: "# Seed one\n\nB's half.\n" });
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const taken = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    assert.equal(JSON.parse(taken.out).discarded, saved, "take names what it discards, by the person's choice");
    assert.equal(existsSync(saved), false);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean");
  } finally {
    await f.cleanup();
  }
});

test("red probe: a document named like a body companion is its own conflict and survives its neighbor", async () => {
  const f = await fixture();
  try {
    for (const id of ["u/foo", "u/foo.body"]) {
      await writeBoardDoc(f.topo.a, id, { frontmatter: { type: "Note", title: id }, body: "base\n" });
    }
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);

    // The dotted document conflicts first, so a naive body companion for u/foo would overwrite it.
    await f.collide("u/foo.body", { body: "A dotted.\n" }, { body: "B dotted.\n" });
    await f.collide("u/foo", { body: "A plain.\n" }, { body: "B plain.\n" });

    const block = await syncBlock(f.topo, f.homeB);
    assert.deepEqual([...block.sync.conflict_ids].sort(), ["u/foo", "u/foo.body"]);
    const dotted = JSON.parse((await runSync(f.homeB, ["--inspect", "--doc", "u/foo.body", "--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.match(dotted.local.content, /B dotted/);
    const plain = JSON.parse((await runSync(f.homeB, ["--inspect", "--doc", "u/foo", "--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.match(plain.local.content, /B plain/);
    // Keep uses the matching body, never its neighbor's whole file.
    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", "u/foo", "--dir", f.topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    const written = await readBoardFile(f.topo.b, "u/foo.md");
    assert.match(written, /B plain/);
    assert.doesNotMatch(written, /title: u\/foo\.body/);
  } finally {
    await f.cleanup();
  }
});

test("a hand merge pushes and exits 0, its copy stays listed, and revise releases it after the push", async () => {
  const f = await fixture();
  try {
    const first = await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });
    assert.match(String(first.err?.details?.saved_copies), /--resolve revise/);
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nA's half.\n\nB's half.\n" });
    const pushed = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(pushed.err, undefined, pushed.err?.message);
    assert.match(git(f.topo.origin, ["show", `board:${ID}.md`]), /A's half[\s\S]*B's half/);
    assert.equal(JSON.parse(pushed.out).saved_conflicts.rows[0].id, ID);

    // The save happened in an earlier second than the push, as it does for anyone but a test.
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const earlier = new Date(Date.now() - 60_000);
    await utimes(saved, earlier, earlier);
    const revised = await runSync(f.homeB, ["--resolve", "revise", "--doc", ID, "--dir", f.topo.b.root]);
    assert.equal(revised.err, undefined, revised.err?.message);
    assert.equal(existsSync(saved), false);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean");
  } finally {
    await f.cleanup();
  }
});

test("an old export settles with the one printed discard command, and an unsent edit survives it", async () => {
  for (const edited of [false, true]) {
    const f = await fixture();
    try {
      assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
      // A copy from before this release: a file on disk with nothing else recorded about it.
      const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
      await mkdir(path.dirname(saved), { recursive: true });
      await writeFile(saved, "---\ntype: Task\ntitle: Seed one\n---\nOld words.\n");
      if (edited) await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nUnsent edit.\n" });

      const block = await syncBlock(f.topo, f.homeB);
      assert.equal(block.sync.state, "needs_decision");
      assert.equal(block.help.length, edited ? 3 : 2);

      // Listed with --pull-only, which leaves any edit where it is, so the verb is judged as it stands.
      const listed = await runSync(f.homeB, ["--dir", f.topo.b.root, "--pull-only", "--json"]);
      assert.equal(listed.err, undefined, listed.err?.message);
      const row = JSON.parse(listed.out).saved_conflicts.rows[0] as Record<string, string>;
      assert.match(row.discard!, new RegExp(`sync --resolve ${edited ? "revise" : "take"} --doc ${ID}`));

      const argv = row.discard!.slice(row.discard!.indexOf("--resolve")).split(" ");
      const settled = await runSync(f.homeB, argv);
      assert.equal(settled.err, undefined, settled.err?.message);
      assert.equal(existsSync(saved), false);
      if (edited) assert.match(await readBoardFile(f.topo.b, `${ID}.md`), /Unsent edit/);
      assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
      assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean");
    } finally {
      await f.cleanup();
    }
  }
});

test("a raw file's saved copy is named by path until the file is gone", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.topo.a.board, "log.md"), "# A log\n");
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    await writeFile(path.join(f.topo.b.board, "log.md"), "# B log\n");
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);
    const again = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(again.err, undefined, again.err?.message);
    const row = JSON.parse(again.out).saved_conflicts.rows[0] as Record<string, string>;
    assert.equal(row.path, "log.md");
    assert.match(row.discard!, /^rm /);
    await rm(row.saved_at!);
    assert.equal(JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out).conflicts, 0);
  } finally {
    await f.cleanup();
  }
});
