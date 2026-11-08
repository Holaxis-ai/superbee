// A saved Git board conflict stays visible until it is settled, and a settling verb never deletes
// what it did not carry. Every test runs on real temp boards through the same in-process commands
// a person runs; sync-git-conflict-verbs.test.ts pins the verbs themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { sync } from "../src/commands/sync.js";
import { doc } from "../src/commands/doc.js";
import { status } from "../src/commands/status.js";
import { buildBoardBlock } from "../src/commands/home.js";
import { sessionStart } from "../src/commands/session-start.js";
import { cliInvocation } from "../src/invocation.js";
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
    assert.match(receipt.saved_conflicts.rows[0].next, new RegExp(`sync --inspect --doc ${ID}`));
    assert.deepEqual(receipt.next, [], "each row carries its own next, under --limit");

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

test("a hand merge pushes and exits 0, its copy stays listed, and take settles it in one command", async () => {
  const f = await fixture();
  try {
    const first = await f.collide(ID, { body: "# Seed one\n\nA's half.\n" }, { body: "# Seed one\n\nB's half.\n" });
    assert.match(String(first.err?.details?.saved_copies), /revise before your merge is pushed, take after/);
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nA's half.\n\nB's half.\n" });
    const pushed = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(pushed.err, undefined, pushed.err?.message);
    assert.match(git(f.topo.origin, ["show", `board:${ID}.md`]), /A's half[\s\S]*B's half/);
    assert.equal(JSON.parse(pushed.out).saved_conflicts.rows[0].id, ID);

    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const merged = await readBoardFile(f.topo.b, `${ID}.md`);
    const refused = await runSync(f.homeB, ["--resolve", "revise", "--doc", ID, "--dir", f.topo.b.root]);
    assert.equal(refused.err?.exitCode, 5, "the document equals upstream and does not hold the copy");
    assert.match(refused.err?.help ?? "", /--resolve take/);
    assert.equal(existsSync(saved), true);
    const taken = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    assert.equal(JSON.parse(taken.out).file_state, "unchanged");
    assert.equal(await readBoardFile(f.topo.b, `${ID}.md`), merged);
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

test("revise refuses on the upstream version whatever the clocks say", async () => {
  const f = await fixture();
  try {
    // The teammate's clock runs ahead.
    process.env.GIT_COMMITTER_DATE = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await modifyBoardDoc(f.topo.a, ID, { body: "# Seed one\n\nA.\n" });
      assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nB unique.\n" });
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);

    // A restored backup makes the copy look old.
    const old = new Date(Date.now() - 86_400_000);
    await utimes(saved, old, old);
    assert.equal((await runSync(f.homeB, ["--resolve", "revise", "--doc", ID, "--dir", f.topo.b.root])).err?.exitCode, 5);
    assert.equal(existsSync(saved), true);

    // A teammate's later ordinary edit is an upstream version that holds none of B's words.
    await modifyBoardDoc(f.topo.a, ID, { body: "# Seed one\n\nA again.\n" });
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--resolve", "revise", "--doc", ID, "--dir", f.topo.b.root])).err?.exitCode, 5);
    assert.equal(existsSync(saved), true);
  } finally {
    await f.cleanup();
  }
});

test("a raw file conflicting at two stops keeps one copy, the run's final version", async () => {
  const f = await fixture();
  try {
    const file = (repo: TwoCloneTopology["a"]) => path.join(repo.board, "data.json");
    await writeFile(file(f.topo.a), '{"v":"base"}\n');
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    await writeFile(file(f.topo.a), '{"v":"A"}\n');
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    for (const value of ["B1", "B2"]) {
      await writeFile(file(f.topo.b), `{"v":"${value}"}\n`);
      git(f.topo.b.board, ["add", "-A"]);
      git(f.topo.b.board, ["commit", "-m", value]);
    }
    const run = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(run.err?.exitCode, 5);
    const rows = (run.err?.details?.conflicts as { rows: Record<string, string>[] }).rows;
    assert.equal(rows[0]!.yours, path.join(exportsOf(f.topo, f.homeB), "data.json"));
    assert.match(await readFile(rows[0]!.yours!, "utf8"), /B2/);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.saved_copies, 1);
  } finally {
    await f.cleanup();
  }
});

test("an earlier copy whose bytes a later stop matches is not overwritten by that run's next stop", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA.\n" }, { body: "# Seed one\n\nX earlier.\n" });
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    await writeFile(path.join(f.topo.b.board, `${ID}.md`), await readFile(saved));
    git(f.topo.b.board, ["add", "-A"]);
    git(f.topo.b.board, ["commit", "-m", "x"]);
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nY later.\n" });
    git(f.topo.b.board, ["add", "-A"]);
    git(f.topo.b.board, ["commit", "-m", "y"]);
    await modifyBoardDoc(f.topo.a, ID, { body: "# Seed one\n\nA again.\n" });
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    const run = await runSync(f.homeB, ["--dir", f.topo.b.root]);
    assert.equal(run.err?.exitCode, 5);
    assert.match(await readFile(saved, "utf8"), /X earlier/);
    const rows = (run.err?.details?.conflicts as { rows: Record<string, string>[] }).rows;
    assert.match(await readFile(rows[0]!.yours!, "utf8"), /Y later/);
  } finally {
    await f.cleanup();
  }
});

test("a copy differing by owner and state is not settled by itself, and take settles it", async () => {
  const f = await fixture();
  try {
    await writeBoardDoc(f.topo.a, "conventions/task", {
      frontmatter: {
        type: "Convention",
        title: "Task",
        governs: "Task",
        fields: { required: ["title", "superbee_progress_status"], optional: ["assignee"], values: { superbee_progress_status: ["todo", "in_progress", "done"] } },
        claim: { owner_field: "assignee", state_field: "progress_status" },
      } as never,
      body: "# Task\n",
    });
    await modifyBoardDoc(f.topo.a, ID, { frontmatter: { superbee_progress_status: "todo" } as never });
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    await f.collide(ID, { frontmatter: { assignee: "agent-a", superbee_progress_status: "in_progress" } as never }, { frontmatter: { assignee: "agent-b", superbee_progress_status: "done" } as never });
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const next = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(next.err, undefined, next.err?.message);
    assert.equal(existsSync(saved), true, "B's done status is on the board nowhere");
    assert.equal(JSON.parse(next.out).conflicts, 1);
    assert.equal((await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root])).err, undefined);
    assert.equal(existsSync(saved), false);
  } finally {
    await f.cleanup();
  }
});

test("keep refuses to overwrite unsent words, and a frontmatter-only edit does not stop it", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA.\n" }, { body: "# Seed one\n\nB.\n" });
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nUnsent merge.\n" });
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const refused = await runSync(f.homeB, ["--resolve", "keep", "--doc", ID, "--dir", f.topo.b.root]);
    assert.equal(refused.err?.exitCode, 5);
    assert.equal(refused.err?.details?.reason, "unsent_edit");
    assert.match(await readBoardFile(f.topo.b, `${ID}.md`), /Unsent merge/);
    assert.equal(existsSync(saved), true);
    const shown = JSON.parse((await runSync(f.homeB, ["--inspect", "--doc", ID, "--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.deepEqual(Object.keys(shown.choices), ["revise", "take"]);
    assert.match(shown.help[0], /--resolve revise/);
    assert.match(shown.choices.take, /unsent edit/);

    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nA.\n", frontmatter: { reviewed: "yes" } as never });
    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", ID, "--dir", f.topo.b.root]);
    assert.equal(kept.err, undefined, kept.err?.message);
    assert.match(await readBoardFile(f.topo.b, `${ID}.md`), /reviewed: 'yes'[\s\S]*\nB\./);
  } finally {
    await f.cleanup();
  }
});

test("removing a document's copy by hand settles it, with no phantom from its body companion", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA.\n" }, { body: "# Seed one\n\nB.\n" });
    await rm(path.join(exportsOf(f.topo, f.homeB), `${ID}.md`));
    const block = await syncBlock(f.topo, f.homeB);
    assert.equal(block.sync.state, "clean");
    assert.equal(block.sync.conflict_ids, undefined);
  } finally {
    await f.cleanup();
  }
});

test("--limit bounds the saved conflict rows", async () => {
  const f = await fixture();
  try {
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    for (let index = 0; index < 4; index++) {
      const copy = path.join(exportsOf(f.topo, f.homeB), `old/doc-${index}.md`);
      await mkdir(path.dirname(copy), { recursive: true });
      await writeFile(copy, `---\ntype: Note\ntitle: d${index}\n---\nOld ${index}.\n`);
    }
    const receipt = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json", "--limit", "2"])).out) as Record<string, any>;
    assert.equal(receipt.saved_conflicts.rows.length, 2);
    assert.equal(receipt.saved_conflicts.total, 4);
    assert.equal(receipt.conflicts, 4);
    assert.deepEqual(receipt.next, []);
  } finally {
    await f.cleanup();
  }
});

test("the printed discard leaves an unsent deletion in place", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA.\n" }, { body: "# Seed one\n\nB.\n" });
    await rm(path.join(f.topo.b.board, `${ID}.md`));
    const listed = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--pull-only", "--json"])).out) as Record<string, any>;
    const discard = listed.saved_conflicts.rows[0].discard as string;
    assert.match(discard, /^rm /);
    for (const file of discard.split(" ").slice(1)) await rm(file);
    assert.equal(existsSync(path.join(f.topo.b.board, `${ID}.md`)), false);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.conflicts, undefined);
  } finally {
    await f.cleanup();
  }
});

test("in the old layout a dotted document's copy beside its neighbor is its own copy, and keep will not use it as a body", async () => {
  const f = await fixture();
  try {
    for (const id of ["u/foo", "u/foo.body"]) {
      await writeBoardDoc(f.topo.a, id, { frontmatter: { type: "Note", title: id }, body: "base\n" });
    }
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    const dir = exportsOf(f.topo, f.homeB);
    await mkdir(path.join(dir, "u"), { recursive: true });
    await writeFile(path.join(dir, "u/foo.md"), "---\ntype: Note\ntitle: u/foo\n---\nfoo mine\n");
    const dotted = path.join(dir, "u/foo.body.md");
    await writeFile(dotted, "---\ntype: Note\ntitle: u/foo.body\n---\nDOTTED UNIQUE\n");

    const block = await syncBlock(f.topo, f.homeB);
    assert.deepEqual([...block.sync.conflict_ids].sort(), ["u/foo", "u/foo.body"]);
    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", "u/foo", "--dir", f.topo.b.root]);
    assert.equal(kept.err?.exitCode, 5, "no body of its own to write");
    assert.doesNotMatch(await readBoardFile(f.topo.b, "u/foo.md"), /DOTTED/);
    assert.match(await readFile(dotted, "utf8"), /DOTTED UNIQUE/);
  } finally {
    await f.cleanup();
  }
});

test("take saves an unsent merge as a new copy and names it", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA.\n" }, { body: "# Seed one\n\nB.\n" });
    await modifyBoardDoc(f.topo.b, ID, { body: "# Seed one\n\nHour of merging.\n" });
    const taken = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    const receipt = JSON.parse(taken.out) as Record<string, any>;
    assert.equal(receipt.file_state, "restored");
    assert.match(await readFile(receipt.unsent_edit_saved_at, "utf8"), /Hour of merging/);
    assert.match(await readBoardFile(f.topo.b, `${ID}.md`), /\nA\./);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.saved_copies, 1, "the new copy stays listed");

    // Now the document is upstream's: the next take just settles the copy.
    const again = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(JSON.parse(again.out).unsent_edit_saved_at, undefined);
    assert.equal(existsSync(receipt.unsent_edit_saved_at), false);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean");
  } finally {
    await f.cleanup();
  }
});

test("keep then take keeps the kept words as a copy", async () => {
  const f = await fixture();
  try {
    await f.collide(ID, { body: "# Seed one\n\nA1.\n" }, { body: "# Seed one\n\nB1 unique.\n" });
    await f.collide(ID, { body: "# Seed one\n\nA2.\n" }, { body: "# Seed one\n\nB2.\n" });
    assert.equal((await runSync(f.homeB, ["--resolve", "keep", "--doc", ID, "--dir", f.topo.b.root])).err, undefined);
    const taken = await runSync(f.homeB, ["--resolve", "take", "--doc", ID, "--dir", f.topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    assert.match(await readFile(JSON.parse(taken.out).unsent_edit_saved_at, "utf8"), /B1 unique/);
  } finally {
    await f.cleanup();
  }
});

test("a copy whose upstream cannot be read never stops a sync, and stays named without printing bytes", async () => {
  const f = await fixture();
  try {
    const file = (repo: TwoCloneTopology["a"]) => path.join(repo.board, "data.bin");
    await writeFile(file(f.topo.a), "base");
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    await writeFile(file(f.topo.a), randomBytes(33 * 1024 * 1024));
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    await writeFile(file(f.topo.b), "B words");
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);

    await writeBoardDoc(f.topo.b, "tasks/other", { frontmatter: { type: "Task", title: "Other" }, body: "Other.\n" });
    const later = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(later.err, undefined, String(later.err?.message).slice(0, 80));
    const receipt = JSON.parse(later.out) as Record<string, any>;
    assert.equal(receipt.pushed, 1, "the rest of the work still goes");
    assert.ok(later.out.length < 4000, "no file bytes in the receipt");
    const row = receipt.saved_conflicts.rows[0];
    assert.equal(row.path, "data.bin");
    assert.match(row.note, /could not be compared/);
    assert.match(row.discard, /^rm /);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.conflicts, 1);
  } finally {
    await f.cleanup();
  }
});

test("different invalid bytes that decode the same are not carried", async () => {
  const f = await fixture();
  try {
    const content = (bytes: number[]): Buffer => Buffer.concat([Buffer.from("---\ntype: Task\ntitle: Seed one\n---\n"), Buffer.from(bytes), Buffer.from("\n")]);
    await writeFile(path.join(f.topo.a.board, `${ID}.md`), content([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    await writeFile(path.join(f.topo.b.board, `${ID}.md`), content([0xcc, 0xe8, 0xf0, 0xed, 0xfb, 0xe9]));
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.conflicts, 1);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    assert.equal(existsSync(saved), true, "the only copy of these bytes survives the next sync");
  } finally {
    await f.cleanup();
  }
});

test("--inspect on a raw file with a saved copy says so and gives the removal step", async () => {
  const f = await fixture();
  try {
    const file = (repo: TwoCloneTopology["a"]) => path.join(repo.board, "data.bin");
    await writeFile(file(f.topo.a), "base");
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    await writeFile(file(f.topo.a), "A words");
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    await writeFile(file(f.topo.b), "B words");
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);
    const saved = path.join(exportsOf(f.topo, f.homeB), "data.bin");
    const shown = await runSync(f.homeB, ["--inspect", "--doc", "data.bin", "--dir", f.topo.b.root]);
    assert.equal(shown.err?.exitCode, 5);
    assert.doesNotMatch(shown.err?.message ?? "", /no saved conflict/);
    assert.match(shown.err?.message ?? "", /raw file/);
    assert.match(shown.err?.help ?? "", /^rm .*data\.bin/);
    assert.equal(existsSync(saved), true);
  } finally {
    await f.cleanup();
  }
});

test("home points at the row's real next step when a document's copy cannot be compared", () => {
  const unsettled = [{ relPath: "tasks/big.md", id: "tasks/big", copies: [{ relPath: "tasks/big.md", file: "/x/tasks/big.md", bodyFile: null }], discardWith: "remove" as const, unreadable: true }];
  const { block } = buildBoardBlock({ state: "provisioned", cache: null, selfActors: [], unpushed: 0, uncommitted: 0, unsettled }, undefined, cliInvocation());
  const line = String((block as Record<string, unknown>).saved_conflicts);
  assert.doesNotMatch(line, /--inspect/);
  assert.match(line, /tasks\/big/);
  assert.match(line, /by hand, then delete the saved file/);
});

/** A board whose Task kind declares its claim, with tasks/seed-one on both clones. */
async function claimBoard(f: Fixture, declared = true): Promise<void> {
  await writeBoardDoc(f.topo.a, "conventions/task", {
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      fields: { required: ["title", "superbee_progress_status"], optional: ["assignee"], values: { superbee_progress_status: ["todo", "in_progress", "done"] } },
      ...(declared ? { claim: { owner_field: "assignee", state_field: "progress_status" } } : {}),
    } as never,
    body: "# Task\n",
  });
  await modifyBoardDoc(f.topo.a, ID, { frontmatter: { superbee_progress_status: "in_progress" } as never });
  assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
  assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
}

test("a lost claim race settles on the next run and is reported once", async () => {
  const f = await fixture();
  try {
    await claimBoard(f);
    const first = await f.collide(ID, { frontmatter: { assignee: "agent-a" } as never }, { frontmatter: { assignee: "agent-b" } as never });
    assert.equal(first.err?.exitCode, 5, "the sync that loses still exits 5");
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    assert.equal((await syncBlock(f.topo, f.homeB)).sync.state, "clean", "a lost race does not bury real conflicts");

    const next = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.deepEqual(next.lost_claims_settled.rows, [{ id: ID, owner: "agent-a", your_owner: "agent-b" }]);
    assert.equal(next.conflicts, 0);
    assert.equal(next.saved_conflicts, undefined);
    assert.equal(existsSync(saved), false);
    const third = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.equal(third.lost_claims_settled, undefined, "reported once");
  } finally {
    await f.cleanup();
  }
});

test("a new conflict in the run that settles a lost claim still carries the report", async () => {
  const f = await fixture();
  try {
    await claimBoard(f);
    await f.collide(ID, { frontmatter: { assignee: "agent-a" } as never }, { frontmatter: { assignee: "agent-b" } as never });
    const second = await f.collide("tasks/seed-two", { body: "A two.\n" }, { body: "B two.\n" });
    assert.deepEqual((second.err?.details?.lost_claims_settled as { rows: unknown[] }).rows, [{ id: ID, owner: "agent-a", your_owner: "agent-b" }]);
  } finally {
    await f.cleanup();
  }
});

test("a lost claim that also differs in state, body or undecodable bytes stays listed", async () => {
  const cases: Record<string, (f: Fixture) => Promise<void>> = {
    state: async (f) => void (await f.collide(ID, { frontmatter: { assignee: "agent-a" } as never }, { frontmatter: { assignee: "agent-b", superbee_progress_status: "done" } as never })),
    body: async (f) => void (await f.collide(ID, { frontmatter: { assignee: "agent-a" } as never }, { frontmatter: { assignee: "agent-b" } as never, body: "# Seed one\n\nB's words.\n" })),
    bytes: async (f) => {
      await f.collide(ID, { frontmatter: { assignee: "agent-a" } as never }, { frontmatter: { assignee: "agent-b" } as never });
      const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
      const text = await readFile(saved);
      await writeFile(saved, Buffer.concat([text, Buffer.from([0xcf, 0xf0])]));
      // Sync gives such a copy no body companion.
      await rm(saved.replace(/\.md$/, ".body.md"));
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const f = await fixture();
    try {
      await claimBoard(f);
      await arrange(f);
      const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
      assert.equal((await syncBlock(f.topo, f.homeB)).sync.conflicts, 1, `${name}: status names it`);
      const next = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
      assert.equal(next.conflicts, 1, name);
      assert.equal(next.lost_claims_settled, undefined, name);
      assert.equal(existsSync(saved), true, `${name}: the copy survives`);
    } finally {
      await f.cleanup();
    }
  }
});

test("frontmatter text that parsing would hide stays listed, and words in an owner value are reported", async () => {
  const insert = (text: string, line: string): string => text.replace(/^---\n/, `---\n${line}\n`);
  const cases: Record<string, { base?: string; yours: (text: string) => string }> = {
    "frontmatter comment": { yours: (text) => insert(text, "# why I claimed this") },
    "inline comment on the owner line": { yours: (text) => text.replace("assignee: agent-b", "assignee: agent-b # handoff words") },
    "big number changed in its last digit": { base: "ticket: 12345678901234567890", yours: (text) => text.replace("12345678901234567890", "12345678901234567891") },
    "nan against inf": { base: "meta: .nan", yours: (text) => text.replace("meta: .nan", "meta: .inf") },
    "multi-line owner value": { yours: (text) => text.replace("assignee: agent-b", "assignee: |\n  agent-b\n  more words") },
  };
  const race = async (f: Fixture, yours: (text: string) => string, base?: string): Promise<void> => {
    const fileOf = (repo: TwoCloneTopology["a"]) => path.join(repo.board, `${ID}.md`);
    if (base !== undefined) {
      await writeFile(fileOf(f.topo.a), insert(await readFile(fileOf(f.topo.a), "utf8"), base));
      assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
      assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    }
    await writeFile(fileOf(f.topo.a), insert(await readFile(fileOf(f.topo.a), "utf8"), "assignee: agent-a"));
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    await writeFile(fileOf(f.topo.b), yours(insert(await readFile(fileOf(f.topo.b), "utf8"), "assignee: agent-b")));
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err?.exitCode, 5);
  };
  for (const [name, { base, yours }] of Object.entries(cases)) {
    const f = await fixture();
    try {
      await claimBoard(f);
      await race(f, yours, base);
      const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
      const next = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
      assert.equal(next.conflicts, 1, name);
      assert.equal(next.lost_claims_settled, undefined, name);
      assert.equal(existsSync(saved), true, `${name}: the copy survives`);
    } finally {
      await f.cleanup();
    }
  }
  const f = await fixture();
  try {
    await claimBoard(f);
    await race(f, (text) => text.replace("assignee: agent-b", "assignee: agent-b handoff words"));
    const next = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.deepEqual(next.lost_claims_settled.rows, [{ id: ID, owner: "agent-a", your_owner: "agent-b handoff words" }]);
  } finally {
    await f.cleanup();
  }
});

test("red probe: an assignee field on a kind that declares no claim is the person's data", async () => {
  const f = await fixture();
  try {
    await claimBoard(f, false);
    await f.collide(ID, { frontmatter: { assignee: "agent-a" } as never }, { frontmatter: { assignee: "agent-b" } as never });
    const saved = path.join(exportsOf(f.topo, f.homeB), `${ID}.md`);
    const next = JSON.parse((await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.equal(next.conflicts, 1);
    assert.equal(existsSync(saved), true);
  } finally {
    await f.cleanup();
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
