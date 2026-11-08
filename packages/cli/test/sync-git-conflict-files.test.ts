// `sync --inspect` and `sync --resolve` on a saved conflict of a file that is not a document (a JSON
// feed snapshot, a binary blob): the file is named by its path and settled byte for byte, with the
// document verbs' guarantees. Two clones write the same file; nothing either wrote may be lost.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { sync } from "../src/commands/sync.js";
import { status } from "../src/commands/status.js";
import { CliError } from "../src/errors.js";
import { bundleKey, syncExportsDir } from "../src/cursor.js";
import { git, makeTwoCloneTopology, type BoardRepo, type TwoCloneTopology } from "../../board-git/test/git-harness.js";

interface RunResult {
  out: string;
  err?: CliError;
}

async function capture(home: string, run: (stdout: (text: string) => void) => Promise<void>): Promise<RunResult> {
  const out: string[] = [];
  try {
    await withIsolatedUserEnv(home, () => run((text: string) => void out.push(text)));
    return { out: out.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: out.join(""), err };
    throw err;
  }
}

const runSync = (home: string, argv: string[]): Promise<RunResult> => capture(home, (stdout) => sync(argv, { stdout }));

const REL = "feeds/snap.json";
const BASE = Buffer.from('{"alerts":[]}\n');
const THEIRS = Buffer.from('{"alerts":["A"]}\n');
// Not valid UTF-8, so only a byte comparison can tell the two sides apart.
const YOURS = Buffer.from([0x7b, 0x22, 0x42, 0x22, 0x3a, 0xff, 0xfe, 0x7d, 0x0a]);

interface Fixture {
  topo: TwoCloneTopology;
  homeA: string;
  homeB: string;
  file(repo: BoardRepo): string;
  saved(slot?: number): string;
  /** A publishes `theirs` first, then B's sync runs into it with `yours`. */
  collide(theirs: Buffer | null, yours: Buffer): Promise<void>;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const topo = await makeTwoCloneTopology();
  const homeA = await mkdtemp(path.join(tmpdir(), "sb-conflict-files-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "sb-conflict-files-b-"));
  const file = (repo: BoardRepo): string => path.join(repo.board, REL);
  const exportsDir = (): string => syncExportsDir(bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board }), homeB);
  await mkdir(path.dirname(file(topo.a)), { recursive: true });
  await writeFile(file(topo.a), BASE);
  assert.equal((await runSync(homeA, ["--dir", topo.a.root])).err, undefined);
  assert.equal((await runSync(homeB, ["--dir", topo.b.root])).err, undefined);
  return {
    topo,
    homeA,
    homeB,
    file,
    saved: (slot = 1) => (slot === 1 ? path.join(exportsDir(), REL) : path.join(`${exportsDir()}.repeat`, String(slot), REL)),
    async collide(theirs, yours) {
      if (theirs === null) await rm(file(topo.a));
      else await writeFile(file(topo.a), theirs);
      assert.equal((await runSync(homeA, ["--dir", topo.a.root])).err, undefined);
      await writeFile(file(topo.b), yours);
      assert.equal((await runSync(homeB, ["--dir", topo.b.root])).err?.exitCode, 5, "the plain sync converges and saves yours");
    },
    async cleanup() {
      await topo.cleanup();
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    },
  };
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("--inspect names a file by its path and shows both sides byte for byte, changing nothing", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    const shown = await runSync(f.homeB, ["--inspect", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(shown.err, undefined, shown.err?.message);
    const record = JSON.parse(shown.out) as Record<string, any>;
    assert.equal(record.conflict, REL);
    assert.equal(record.kind, "file");
    assert.equal(record.reason, "changed_remotely");
    assert.equal(record.local.sha256, sha(YOURS));
    assert.equal(record.local.binary, true, "bytes that are not UTF-8 are not shown as text");
    assert.equal(record.local.content, null);
    assert.equal(record.remote.sha256, sha(THEIRS));
    assert.equal(record.remote.content, THEIRS.toString("utf8"));
    assert.deepEqual(Object.keys(record.choices), ["keep", "take", "revise"]);
    assert.ok(record.help.every((line: string) => line.includes(`--doc ${REL}`)));
    assert.deepEqual(await readFile(f.file(f.topo.b)), THEIRS);
    assert.deepEqual(await readFile(f.saved()), YOURS);
    assert.equal(git(f.topo.b.board, ["status", "--porcelain"]), "");
  } finally {
    await f.cleanup();
  }
});

test("status and sync point a file's saved conflict at the verbs instead of a hand merge", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    const again = await runSync(f.homeB, ["--dir", f.topo.b.root, "--json"]);
    assert.equal(again.err, undefined, again.err?.message);
    const row = JSON.parse(again.out).saved_conflicts.rows[0] as Record<string, string>;
    assert.equal(row.path, REL);
    assert.match(row.next!, new RegExp(`sync --inspect --doc ${REL}`));
    assert.match(row.discard!, new RegExp(`sync --resolve take --doc ${REL}`));
    const shown = await capture(f.homeB, (stdout) => status(["--dir", f.topo.b.board, "--json"], { stdout, home: f.homeB, autoPull: async () => undefined }));
    assert.equal(shown.err, undefined, shown.err?.message);
    assert.ok((JSON.parse(shown.out).help as string[]).some((line) => line.includes(`sync --inspect --doc ${REL}`)));
  } finally {
    await f.cleanup();
  }
});

test("--resolve keep writes your saved bytes whole, keeps the file mode, and the next sync publishes them", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    await chmod(f.file(f.topo.b), 0o755);
    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    const record = JSON.parse(kept.out) as Record<string, any>;
    assert.equal(record.file_state, "written");
    assert.equal(record.sent, false);
    assert.match(record.next, /share the file as it is now/);
    assert.deepEqual(await readFile(f.file(f.topo.b)), YOURS);
    assert.equal((await stat(f.file(f.topo.b))).mode & 0o777, 0o755, "the mode survives the replace");
    assert.equal(existsSync(f.saved()), false);

    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    assert.equal((await runSync(f.homeA, ["--dir", f.topo.a.root])).err, undefined);
    assert.deepEqual(await readFile(f.file(f.topo.a)), YOURS, "the teammate receives your bytes exactly");
  } finally {
    await f.cleanup();
  }
});

test("--resolve take restores the teammate's bytes and discards your saved copy", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    const taken = await runSync(f.homeB, ["--resolve", "take", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    assert.equal(JSON.parse(taken.out).file_state, "unchanged");
    assert.deepEqual(await readFile(f.file(f.topo.b)), THEIRS);
    assert.equal(existsSync(f.saved()), false);
    const again = await runSync(f.homeB, ["--inspect", "--doc", REL, "--dir", f.topo.b.root]);
    assert.equal(again.err?.code, "NOT_FOUND");
  } finally {
    await f.cleanup();
  }
});

test("keep never overwrites a change made since the conflict; revise records it and take saves it first", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    const merged = Buffer.from('{"alerts":["A","B"]}\n');
    await writeFile(f.file(f.topo.b), merged);

    const inspected = JSON.parse((await runSync(f.homeB, ["--inspect", "--doc", REL, "--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.equal(inspected.choices.keep, undefined, "keep is not offered over unsent bytes");
    assert.equal(Object.keys(inspected.choices)[0], "revise");

    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(kept.err?.exitCode, 5);
    assert.equal(kept.err?.details?.reason, "unsent_edit");
    assert.deepEqual(await readFile(f.file(f.topo.b)), merged, "nothing changed");
    assert.deepEqual(await readFile(f.saved()), YOURS, "the saved copy stays");

    const taken = await runSync(f.homeB, ["--resolve", "take", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(taken.err, undefined, taken.err?.message);
    const receipt = JSON.parse(taken.out) as Record<string, any>;
    assert.deepEqual(await readFile(f.file(f.topo.b)), THEIRS);
    assert.deepEqual(await readFile(receipt.unsent_edit_saved_at), merged, "the unsent change is saved before take restores theirs");
  } finally {
    await f.cleanup();
  }
});

test("--resolve revise records the file as you merged it, and the next sync publishes it", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    const merged = Buffer.from('{"alerts":["A","B"]}\n');
    await writeFile(f.file(f.topo.b), merged);
    const revised = await runSync(f.homeB, ["--resolve", "revise", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(revised.err, undefined, revised.err?.message);
    assert.equal(existsSync(f.saved()), false);
    assert.equal((await runSync(f.homeB, ["--dir", f.topo.b.root])).err, undefined);
    assert.equal(git(f.topo.origin, ["show", `board:${REL}`]), merged.toString("utf8"));
  } finally {
    await f.cleanup();
  }
});

test("keep of an older copy is refused while a later copy waits, so the newest has the last word", async () => {
  const f = await fixture();
  try {
    await f.collide(THEIRS, YOURS);
    const newer = Buffer.from('{"alerts":["B2"]}\n');
    await f.collide(Buffer.from('{"alerts":["A2"]}\n'), newer);
    assert.deepEqual(await readFile(f.saved(2)), newer, "the second conflict saved a second copy");

    const older = await runSync(f.homeB, ["--resolve", "keep", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(older.err?.exitCode, 5);
    assert.equal(older.err?.details?.reason, "later_copy_waits");
    assert.deepEqual(await readFile(f.saved()), YOURS);
    assert.equal(git(f.topo.b.board, ["status", "--porcelain"]), "", "nothing changed");

    const setAside = await runSync(f.homeB, ["--resolve", "take", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(setAside.err, undefined, setAside.err?.message);
    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    assert.deepEqual(await readFile(f.file(f.topo.b)), newer);
  } finally {
    await f.cleanup();
  }
});

test("keep re-creates a file the teammate deleted, and refuses to write through a link", async () => {
  const f = await fixture();
  try {
    await f.collide(null, YOURS);
    const shown = JSON.parse((await runSync(f.homeB, ["--inspect", "--doc", REL, "--dir", f.topo.b.root, "--json"])).out) as Record<string, any>;
    assert.equal(shown.reason, "deleted_remotely");

    const outside = path.join(f.homeB, "outside.json");
    await writeFile(outside, "outside\n");
    await mkdir(path.dirname(f.file(f.topo.b)), { recursive: true });
    await symlink(outside, f.file(f.topo.b));
    const linked = await runSync(f.homeB, ["--resolve", "keep", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(linked.err?.exitCode, 5);
    assert.equal(await readFile(outside, "utf8"), "outside\n", "the link's target is untouched");
    assert.ok(existsSync(f.saved()));
    await rm(f.file(f.topo.b));

    const kept = await runSync(f.homeB, ["--resolve", "keep", "--doc", REL, "--dir", f.topo.b.root, "--json"]);
    assert.equal(kept.err, undefined, kept.err?.message);
    assert.equal(JSON.parse(kept.out).file_state, "re-created");
    assert.deepEqual(await readFile(f.file(f.topo.b)), YOURS);
  } finally {
    await f.cleanup();
  }
});
