/**
 * L1 protocol trace proofs for `filesystem-identity.ts` against a scripted port: every platform,
 * deterministic, no real filesystem except where a key-stability row says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConcurrentReplacementError, FilesystemIdentityAliasError, InvalidInputError } from "../src/errors.js";
import {
  classifyLeaf,
  classifyMkdir,
  FilesystemShapeMismatchError,
  identityKey,
  mutateExact,
  observeExact,
  type ListedEntry,
  type MutationContext,
} from "../src/filesystem-identity.js";
import { ScriptedPort } from "./scripted-identity-port.js";

const ROOT = "/root";
const REL = "concepts/x.md";
const TARGET = path.join(ROOT, REL);
const WRITE_CLASS = ["mkdir", "writeTemp", "rename", "unlink", "claim"];

const readUse = (port: ScriptedPort) => async (target: string) => {
  try {
    const { bytes, dev, ino } = await port.readFile(target);
    return { value: bytes.toString(), dev, ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

const probeUse = (port: ScriptedPort) => async (target: string) => {
  const probed = await port.probe(target);
  return probed === null ? null : { value: probed.kind, dev: probed.dev, ino: probed.ino };
};

function entry(name: string, ino: number, kind: ListedEntry["kind"] = "file"): ListedEntry {
  return { name, kind, dev: 1, ino };
}

// ── AC-1 observation non-materialization by trace ─────────────────────────────

test("AC-1: observations issue no write-class port call in any state", async () => {
  const states: Array<[string, (port: ScriptedPort) => void]> = [
    ["ROOT-ABSENT", () => {}],
    ["ABSENT", (port) => void port.mkdirp(ROOT)],
    ["EXACT", (port) => void port.file(TARGET, "body")],
    ["ALIASED", (port) => void port.file(path.join(ROOT, "concepts/X.md"), "body")],
  ];
  for (const [state, arrange] of states) {
    for (const [name, use] of [["read", readUse], ["probe", probeUse]] as const) {
      const port = new ScriptedPort({ aliasing: true });
      arrange(port);
      await observeExact(port, ROOT, REL, use(port)).catch((err: unknown) => {
        assert.ok(err instanceof FilesystemIdentityAliasError, `${state}/${name}: ${String(err)}`);
        assert.equal(state, "ALIASED");
      });
      assert.deepEqual(port.ops(...WRITE_CLASS), [], `${state}/${name} wrote through the port`);
    }
  }
});

// ── AC-2 decision tables ──────────────────────────────────────────────────────

test("AC-2: classifyLeaf rows, including case-only and NFC/NFD alias pairs", () => {
  const handle = { dev: 1, ino: 9 };
  assert.equal(classifyLeaf({ leaf: "x.md", handle, entries: [entry("x.md", 9)] }), "exact");
  assert.equal(classifyLeaf({ leaf: "x.md", handle, entries: [entry("x.md", 10), entry("X.md", 9)] }), "replaced");
  assert.equal(classifyLeaf({ leaf: "x.md", handle, entries: [entry("X.md", 9)] }), "aliased");
  assert.equal(classifyLeaf({ leaf: "x.md", handle, entries: [entry("y.md", 9)] }), "aliased");
  assert.equal(classifyLeaf({ leaf: "x.md", handle, entries: [entry("y.md", 8)] }), "absent");
  assert.equal(classifyLeaf({ leaf: "x.md", handle, entries: [] }), "absent");
  assert.equal(classifyLeaf({ leaf: "café.md", handle, entries: [entry("café.md", 9)] }), "aliased");
  assert.equal(classifyLeaf({ leaf: "café.md", handle, entries: [entry("café.md", 9)] }), "aliased");
});

test("AC-2: classifyMkdir rows, rel segments exact-only and tail segments any spelling", () => {
  const docs = [entry("docs", 5, "directory")];
  assert.equal(classifyMkdir("created", [], "Docs", false), "created");
  assert.equal(classifyMkdir("exists", [entry("Docs", 5, "directory")], "Docs", false), "exact");
  assert.equal(classifyMkdir("exists", [entry("Docs", 5, "symlink")], "Docs", false), "exact");
  assert.equal(classifyMkdir("exists", docs, "Docs", false), "aliased");
  assert.equal(classifyMkdir("exists", [entry("Docs", 5, "file")], "Docs", false), "shape-mismatch");
  assert.equal(classifyMkdir("exists", [entry("mybundle", 5, "directory")], "MyBundle", true), "exact");
  assert.equal(classifyMkdir("exists", [entry("MyBundle", 5, "directory")], "MyBundle", true), "exact");
  assert.equal(classifyMkdir("exists", [entry("MyBundle", 5, "file")], "MyBundle", true), "shape-mismatch");
  assert.equal(classifyMkdir("created", docs, "MyBundle", true), "created");
});

// ── AC-3 observeExact interleavings ───────────────────────────────────────────

test("AC-3(a): probe ENOENT is ABSENT with no further calls", async () => {
  const port = new ScriptedPort();
  assert.deepEqual(await observeExact(port, ROOT, REL, readUse(port)), { state: "absent" });
  assert.deepEqual(port.trace, [`probe(${TARGET})`]);
});

test("AC-3(b): probe succeeds through an alias, listing lacks the exact leaf: ALIASED before any read", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(path.join(ROOT, "concepts/X.md"), "canonical");
  await assert.rejects(() => observeExact(port, ROOT, REL, readUse(port)), FilesystemIdentityAliasError);
  assert.equal(port.calls("readFile"), 0);
});

test("AC-3(b'): an aliased intermediate directory is refused before any read", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(path.join(ROOT, "Concepts/x.md"), "canonical");
  await assert.rejects(
    () => observeExact(port, ROOT, REL, readUse(port)),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "concepts",
  );
  assert.equal(port.calls("readFile"), 0);
});

test("AC-3(c): exact throughout with a stable inode is EXACT", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 9);
  assert.deepEqual(await observeExact(port, ROOT, REL, readUse(port)), { state: "exact", value: "body" });
  assert.deepEqual(port.ops("probe", "entries", "readFile"), [
    `probe(${TARGET})`,
    `probe(${path.join(ROOT, "concepts")})`,
    `entries(${ROOT})`,
    `probe(${TARGET})`,
    `entries(${path.join(ROOT, "concepts")})`,
    `readFile(${TARGET})`,
    `entries(${ROOT})`,
    `entries(${path.join(ROOT, "concepts")})`,
  ]);
});

test("AC-3(d): a replaced leaf restarts once and returns the re-read bytes", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "old", 9);
  port.after("readFile", 1, () => void port.file(TARGET, "new", 10));
  assert.deepEqual(await observeExact(port, ROOT, REL, readUse(port)), { state: "exact", value: "new" });
  assert.equal(port.calls("readFile"), 2);
  assert.equal(port.calls("entries"), 8, "two full walks: verify + post-verify, twice");
});

test("AC-3(e): bytes read through an alias that appeared after the pre-walk are refused", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "body", 11);
  port.after("readFile", 1, () => port.respell(TARGET, "X.md"));
  await assert.rejects(() => observeExact(port, ROOT, REL, readUse(port)), FilesystemIdentityAliasError);
});

test("AC-3(f): the leaf vanished after use and no entry carries its inode: ABSENT", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 11);
  port.after("readFile", 1, () => port.remove(TARGET));
  assert.deepEqual(await observeExact(port, ROOT, REL, readUse(port)), { state: "absent" });
});

test("AC-3(g): a replacement followed by an alias on the restart is ALIASED", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "old", 9);
  port.after("readFile", 1, () => void port.file(TARGET, "new", 10));
  port.after("readFile", 2, () => port.respell(TARGET, "X.md"));
  await assert.rejects(() => observeExact(port, ROOT, REL, readUse(port)), FilesystemIdentityAliasError);
  assert.equal(port.calls("readFile"), 2);
});

test("AC-3(h): an intermediate segment no longer exactly listed at post-walk is ALIASED though the leaf matches", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "body", 9);
  port.after("readFile", 1, () => port.respell(path.join(ROOT, "concepts"), "Concepts"));
  await assert.rejects(
    () => observeExact(port, ROOT, REL, readUse(port)),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "concepts",
  );
});

test("AC-3(i): replacement on every attempt is bounded at three restarts, then ConcurrentReplacementError", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "v0", 9);
  let ino = 9;
  for (const nth of [1, 2, 3, 4, 5]) port.after("readFile", nth, () => void port.file(TARGET, `v${nth}`, ++ino));
  await assert.rejects(() => observeExact(port, ROOT, REL, readUse(port)), ConcurrentReplacementError);
  assert.equal(port.calls("readFile"), 4, "initial attempt plus exactly three restarts");
  assert.equal(port.trace.filter((line) => line === `entries(${ROOT})`).length, 8, "four O-VERIFY walks and four post-walks");
});

test("observeExact: probe-shaped use binds presence to the probed inode and restarts on replacement", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 9);
  assert.deepEqual(await observeExact(port, ROOT, REL, probeUse(port)), { state: "exact", value: "file" });
  assert.equal(port.calls("probe"), 4, "O-PROBE, two walk probes, the use probe");

  const again = new ScriptedPort();
  again.file(TARGET, "body", 9);
  // The fourth probe is the use itself; replacing the leaf right after it makes the post-walk
  // listing carry a different inode, so the observation restarts from O-VERIFY exactly once.
  again.after("probe", 4, () => void again.file(TARGET, "other", 10));
  assert.deepEqual(await observeExact(again, ROOT, REL, probeUse(again)), { state: "exact", value: "file" });
  assert.equal(again.calls("probe"), 7);
});

test("observeExact: containment guard rejects escapes before any port call", async () => {
  const port = new ScriptedPort();
  for (const rel of ["../x.md", "/x.md", "a/../x.md", ""]) {
    await assert.rejects(() => observeExact(port, ROOT, rel, readUse(port)), InvalidInputError);
  }
  assert.deepEqual(port.trace, []);
});

// ── AC-4 and AC-14 mutateExact ordering by trace ──────────────────────────────

const casWrite = (expected: string | null) => async (context: MutationContext) => {
  const current = await context.current();
  const actual = current === null ? null : current.toString();
  if (actual !== expected) throw new Error(`conflict: expected ${String(expected)}, found ${String(actual)}`);
  await context.replace(Buffer.from("new"));
  return "written";
};

function opsOf(port: ScriptedPort): string[] {
  return port.trace.map((line) => line.slice(0, line.indexOf("(")));
}

test("AC-4: write ordering is claim, walk, CAS read, per-segment mkdir, writeTemp, rename, release", async () => {
  const port = new ScriptedPort();
  port.mkdirp(ROOT);
  const key = await identityKey(ROOT, "a/b/c.md");
  assert.equal(await mutateExact(port, ROOT, "a/b/c.md", casWrite(null)), "written");
  const ops = opsOf(port);
  assert.equal(ops[0], "claim");
  assert.equal(ops[ops.length - 1], "release");
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink").map((line) => line.slice(0, line.indexOf("("))), [
    "mkdir",
    "mkdir",
    "writeTemp",
    "rename",
  ]);
  assert.deepEqual(port.ops("mkdir"), [`mkdir(${path.join(ROOT, "a")})`, `mkdir(${path.join(ROOT, "a/b")})`]);
  assert.ok(ops.indexOf("probe") > ops.indexOf("claim") && ops.indexOf("mkdir") > ops.lastIndexOf("entries"));
  assert.equal(port.trace[0], `claim(${key})`);
  assert.equal(port.node(path.join(ROOT, "a/b/c.md"))?.bytes.toString(), "new");
});

test("AC-4: an existing leaf is read for CAS before mkdir/write, and no mkdir is issued for present segments", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "old", 9);
  assert.equal(await mutateExact(port, ROOT, REL, casWrite("old")), "written");
  const ops = opsOf(port);
  assert.ok(ops.indexOf("readFile") < ops.indexOf("writeTemp"));
  assert.deepEqual(port.ops("mkdir"), []);
  assert.ok(ops.indexOf("readFile") > ops.indexOf("claim"));
});

test("AC-4: ALIASED at the walk is claim, walk, release with no write-class call", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(path.join(ROOT, "concepts/X.md"), "canonical");
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite(null)), FilesystemIdentityAliasError);
  const ops = opsOf(port);
  assert.equal(ops[0], "claim");
  assert.equal(ops[ops.length - 1], "release");
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink", "readFile"), []);
});

test("AC-4: a CAS conflict issues no mkdir and no write-class call, and still releases", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "current", 9);
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite("stale")), /conflict/);
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink"), []);
  assert.equal(opsOf(port).at(-1), "release");
});

test("AC-4: CAS against an absent target reads nothing and creates nothing on conflict", async () => {
  const port = new ScriptedPort();
  port.mkdirp(ROOT);
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite("expected-present")), /conflict/);
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink", "readFile"), []);
  assert.deepEqual([...port.node(ROOT)!.children.keys()], []);
});

test("AC-4: release happens on a thrown body and on delete", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 9);
  await assert.rejects(() => mutateExact(port, ROOT, REL, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(opsOf(port).at(-1), "release");
  port.trace.length = 0;
  assert.equal(
    await mutateExact(port, ROOT, REL, async (context) => {
      if ((await context.current()) === null) return false;
      await context.remove();
      return true;
    }),
    true,
  );
  assert.deepEqual(port.ops("unlink", "release"), [`unlink(${TARGET})`, `release(${await identityKey(ROOT, REL)})`]);
  assert.equal(port.node(TARGET), null);
});

test("AC-4: a failed rename removes its own temp file", async () => {
  const port = new ScriptedPort();
  port.mkdirp(path.join(ROOT, "concepts"));
  port.override("rename", async ([from]) => {
    throw Object.assign(new Error("EIO"), { code: "EIO", path: from });
  });
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite(null)), /EIO/);
  assert.equal(port.calls("unlink"), 1);
  assert.deepEqual([...port.node(path.join(ROOT, "concepts"))!.children.keys()], []);
});

test("AC-14: EEXIST on a rel segment the walk found absent is refused when the listing spells it differently", async () => {
  const port = new ScriptedPort();
  port.mkdirp(ROOT);
  port.override("mkdir", async ([dir]) => {
    port.mkdirp(path.join(ROOT, "docs"));
    assert.equal(dir, path.join(ROOT, "Docs"));
    return "exists";
  });
  await assert.rejects(
    () => mutateExact(port, ROOT, "Docs/a.md", casWrite(null)),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "Docs",
  );
  assert.deepEqual(port.ops("writeTemp", "rename", "unlink"), []);
  assert.equal(opsOf(port).at(-1), "release");
});

test("AC-14 variant: a created rel segment proceeds into the exact directory", async () => {
  const port = new ScriptedPort();
  port.mkdirp(ROOT);
  assert.equal(await mutateExact(port, ROOT, "Docs/a.md", casWrite(null)), "written");
  assert.deepEqual(port.ops("mkdir"), [`mkdir(${path.join(ROOT, "Docs")})`]);
  assert.equal(port.node(path.join(ROOT, "Docs/a.md"))?.bytes.toString(), "new");
});

test("AC-14 variant: EEXIST with an exactly spelled regular file is a typed shape mismatch with nothing written", async () => {
  const port = new ScriptedPort();
  port.file(path.join(ROOT, "Docs"), "a file");
  port.override("probe", async ([target], base) => (target === path.join(ROOT, "Docs") ? null : base()));
  await assert.rejects(() => mutateExact(port, ROOT, "Docs/a.md", casWrite(null)), FilesystemShapeMismatchError);
  assert.deepEqual(port.ops("writeTemp", "rename", "unlink"), []);
});

test("AC-14 variant: a rel segment that is a regular file at the walk is a typed shape mismatch", async () => {
  const port = new ScriptedPort();
  port.file(path.join(ROOT, "Docs"), "a file");
  await assert.rejects(() => mutateExact(port, ROOT, "Docs/a.md", casWrite(null)), FilesystemShapeMismatchError);
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink"), []);
});

test("AC-14 tail variant: a root segment that exists under another spelling is accepted", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.mkdirp("/base/mybundle");
  let raced = false;
  port.override("probe", async ([target], base) => {
    if (target === "/base/MyBundle" && !raced) return null;
    return base();
  });
  port.override("mkdir", async ([dir], base) => {
    if (dir === "/base/MyBundle") raced = true;
    return base();
  });
  assert.equal(await mutateExact(port, "/base/MyBundle", REL, casWrite(null)), "written");
  assert.deepEqual(port.ops("mkdir"), ["mkdir(/base/MyBundle)", "mkdir(/base/MyBundle/concepts)"]);
  assert.equal(port.node("/base/mybundle/concepts/x.md")?.bytes.toString(), "new");
});

test("AC-14 tail variant: an absent multi-level root is created root-first before rel segments", async () => {
  const port = new ScriptedPort();
  port.mkdirp("/base");
  assert.equal(await mutateExact(port, "/base/a/b", REL, casWrite(null)), "written");
  assert.deepEqual(port.ops("mkdir"), ["mkdir(/base/a)", "mkdir(/base/a/b)", "mkdir(/base/a/b/concepts)"]);
});

// ── AC-5 key purity and stability ─────────────────────────────────────────────

test("AC-5: keys are equal across case, normalization, and lexical root spellings; distinct across identities", async () => {
  const base = await identityKey("/x/bundle", "concepts/a.md");
  assert.equal(await identityKey("/x/bundle", "concepts/A.md"), base);
  assert.equal(await identityKey("/x/bundle", "Concepts/a.md"), base);
  assert.equal(await identityKey("/x/../x/bundle", "concepts/a.md"), base);
  assert.equal(await identityKey("/x/Bundle", "concepts/a.md"), base);
  assert.equal(await identityKey("/x/bundle", "concepts/café.md"), await identityKey("/x/bundle", "concepts/café.md"));
  assert.notEqual(await identityKey("/x/other", "concepts/a.md"), base);
  assert.notEqual(await identityKey("/x/bundle", "concepts/b.md"), base);
  assert.notEqual(await identityKey("/x/bundle", "docs/a.md"), base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

test("AC-5: keys ignore TMPDIR and HOME", async () => {
  const before = await identityKey("/x/bundle", "concepts/a.md");
  const saved = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
  try {
    process.env.TMPDIR = "/nonexistent/tmp";
    process.env.HOME = "/nonexistent/home";
    assert.equal(await identityKey("/x/bundle", "concepts/a.md"), before);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("AC-5: keys are stable across root creation for uppercase, NFD, and two-level absent roots", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "superbee-key-stability-"));
  try {
    for (const tail of ["MyBundle", "café", path.join("outer", "inner")]) {
      const root = path.join(parent, tail);
      const absent = await identityKey(root, "concepts/a.md");
      await mkdir(root, { recursive: true });
      assert.equal(await identityKey(root, "concepts/a.md"), absent, `key moved when '${tail}' was created`);
      assert.equal(await identityKey(root, "concepts/A.md"), absent);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const DIGEST_SPELLINGS: Array<[string, string]> = [
  ["/", "concepts/a.md"],
  ["/", "concepts/A.md"],
  ["/", "Concepts/a.md"],
  ["/", "CONCEPTS/A.MD"],
  ["/", "concepts/café.md"],
  ["/", "concepts/café.md"],
  ["/", "concepts/CAFÉ.md"],
  ["/", "concepts/CAFÉ.md"],
  ["/", "concepts/straße.md"],
  ["/", "concepts/STRASSE.md"],
  ["/", "concepts/straẞe.md"],
  ["/", "concepts/ıstanbul.md"],
  ["/", "concepts/istanbul.md"],
  ["/", "concepts/İstanbul.md"],
  ["/", "concepts/ISTANBUL.md"],
  ["/", "concepts/ſoft.md"],
  ["/", "concepts/soft.md"],
  ["/", "concepts/ﬁle.md"],
  ["/", "concepts/file.md"],
  ["/", "concepts/Ångström.md"],
  ["/", "concepts/Ångström.md"],
  ["/", "concepts/angstrom.md"],
  ["/", "concepts/Ωhm.md"],
  ["/", "concepts/Ωhm.md"],
  ["/", "concepts/ωhm.md"],
  ["/", "concepts/².md"],
  ["/", "concepts/2.md"],
  ["/", "concepts/①.md"],
  ["/", "concepts/1.md"],
  ["/", "concepts/ẛ̣.md"],
  ["/", "concepts/ṩ.md"],
  ["/", "concepts/്.md"],
  ["/", "concepts/あ.md"],
  ["/", "concepts/ｱ.md"],
  ["/", "concepts/ア.md"],
  ["/", "concepts/😀.md"],
  ["/", "concepts/中文.md"],
  ["/", "index.md"],
  ["/", "docs/index.md"],
  ["/", "Docs/index.md"],
  ["/", "artifacts/report.pdf"],
  ["/", "artifacts/REPORT.PDF"],
  ["/", "a/b/c/d/e.md"],
  ["/", "a.md"],
  ["/Superbee-Identity-Digest-Fixture", "concepts/a.md"],
  ["/superbee-identity-digest-fixture", "concepts/a.md"],
  ["/SUPERBEE-IDENTITY-DIGEST-FIXTURE/", "concepts/a.md"],
  ["/superbee-identity-digest-fixture/café", "concepts/a.md"],
  ["/superbee-identity-digest-fixture/café", "concepts/a.md"],
  ["/superbee-identity-digest-fixture/./nested/../nested", "concepts/a.md"],
];

test("AC-5: fold digest over the checked-in spelling list is pinned", async () => {
  assert.equal(DIGEST_SPELLINGS.length, 50);
  const digest = createHash("sha256");
  for (const [root, rel] of DIGEST_SPELLINGS) digest.update(`${await identityKey(root, rel)}\n`);
  assert.equal(digest.digest("hex"), "687f7be02e929e42325997ccffc85b11caca7e5378dbd4d83685e832fb557e20");
});
