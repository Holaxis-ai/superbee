/**
 * L1 protocol trace proofs for `filesystem-identity.ts` against a scripted port: every platform,
 * deterministic, no real filesystem except where a key-stability row says so.
 *
 * Trace shape of one observation of `concepts/x.md` under `/root`:
 *   O-PROBE      probe(/root/concepts), probe(/root/concepts/x.md)          (recorded)
 *   O-VERIFY     entries(/root), entries(/root/concepts)                    (+ a confirming probe only when a name is missing)
 *   O-USE        open(/root/concepts/x.md), readAll(#n)
 *   O-POSTVERIFY entries(/root), entries(/root/concepts), probe(/root/concepts/x.md), close(#n)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConcurrentReplacementError, FilesystemIdentityAliasError, InvalidInputError } from "../src/errors.js";
import {
  classifyLeaf,
  classifyMkdir,
  confirmAlias,
  FilesystemShapeMismatchError,
  FilesystemSymlinkEntryError,
  foldSegment,
  identityKey,
  mutateExact,
  observeExact,
  probeExact,
  type ListedEntry,
  type MutationContext,
  type PortHandle,
} from "../src/filesystem-identity.js";
import { opOf, ScriptedPort } from "./scripted-identity-port.js";

const ROOT = "/root";
const CONCEPTS = path.join(ROOT, "concepts");
const REL = "concepts/x.md";
const TARGET = path.join(ROOT, REL);
const WRITE_CLASS = ["mkdir", "writeTemp", "link", "rename", "unlink", "claim"];

/** The read every observation row uses: bytes through the handle, absent-class errors as `null`. */
const readText = (port: ScriptedPort) => async (handle: PortHandle) => {
  try {
    return (await port.readAll(handle)).toString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EISDIR") return null;
    throw err;
  }
};

function observe(port: ScriptedPort, rel = REL) {
  return observeExact(port, ROOT, rel, readText(port));
}

function entry(name: string, kind: ListedEntry["kind"] = "file"): ListedEntry {
  return { name, kind };
}

function opsOf(port: ScriptedPort): string[] {
  return port.trace.map(opOf);
}

/**
 * Count O-PROBE walks of a two-segment `rel`: only that walk probes the directory segment and then,
 * immediately, the leaf. A confirming probe of either path on its own never forms that pair.
 */
function probeWalks(port: ScriptedPort, rel = REL): number {
  const [dir, leaf] = rel.split("/") as [string, string];
  const first = `probe(${path.join(ROOT, dir)})`;
  const second = `probe(${path.join(ROOT, dir, leaf)})`;
  let walks = 0;
  for (let index = 0; index + 1 < port.trace.length; index++) {
    if (port.trace[index] === first && port.trace[index + 1] === second) walks++;
  }
  return walks;
}

/**
 * AC-3(l): at most one handle open at any time; every open is closed; `close` comes after the
 * post-walk's listings and leaf probe (nothing but `readAll`, `entries`, `probe`, `stat` between
 * an open and its close); no `readAll` after `close`; the call after a close, if any, starts a
 * fresh O-PROBE (`probe`), never a listing.
 */
function assertHandleDiscipline(port: ScriptedPort): void {
  assert.equal(port.openCount, 0, "every handle is closed, including on thrown paths");
  assert.ok(port.maxOpen <= 1, `at most one handle open, saw ${port.maxOpen}`);
  const ops = opsOf(port);
  for (let index = 0; index < ops.length; index++) {
    if (ops[index] !== "open") continue;
    const closeIndex = ops.indexOf("close", index);
    assert.ok(closeIndex > index, "an open without a close");
    const between = ops.slice(index + 1, closeIndex);
    assert.ok(!between.includes("open"), "a second open before close");
    assert.ok(between.every((op) => ["opened", "readAll", "entries", "probe", "stat"].includes(op)), between.join(","));
    const handle = port.trace[index + 1]!.slice("opened(".length, -1);
    assert.ok(!port.trace.slice(closeIndex + 1).includes(`readAll(${handle})`), "readAll after close");
    const next = ops[closeIndex + 1];
    if (next !== undefined) assert.equal(next, "probe", `after close the observation restarts at O-PROBE, saw ${next}`);
  }
}

// ── AC-1 observation non-materialization by trace ─────────────────────────────

test("AC-1: observations issue no write-class port call in any state", async () => {
  const states: Array<[string, (port: ScriptedPort) => void]> = [
    ["ROOT-ABSENT", () => {}],
    ["ABSENT", (port) => void port.mkdirp(ROOT)],
    ["EXACT", (port) => void port.file(TARGET, "body")],
    ["ALIASED", (port) => void port.file(path.join(CONCEPTS, "X.md"), "body")],
  ];
  for (const [state, arrange] of states) {
    for (const [name, run] of [
      ["read", (port: ScriptedPort) => observe(port)],
      ["probe", (port: ScriptedPort) => probeExact(port, ROOT, REL)],
    ] as const) {
      const port = new ScriptedPort({ aliasing: true });
      arrange(port);
      await run(port).catch((err: unknown) => {
        assert.ok(err instanceof FilesystemIdentityAliasError, `${state}/${name}: ${String(err)}`);
        assert.equal(state, "ALIASED");
      });
      assert.deepEqual(port.ops(...WRITE_CLASS), [], `${state}/${name} wrote through the port`);
      assertHandleDiscipline(port);
    }
  }
});

// ── AC-2 decision tables ──────────────────────────────────────────────────────

test("AC-2: classifyLeaf covers all six (listed, probe) cells", () => {
  const handle = { dev: 1, ino: 9 };
  const same = { kind: "file", dev: 1, ino: 9 } as const;
  const other = { kind: "file", dev: 1, ino: 12 } as const;
  assert.equal(classifyLeaf({ listed: true, probe: same, handle }), "exact");
  assert.equal(classifyLeaf({ listed: true, probe: other, handle }), "replaced");
  assert.equal(classifyLeaf({ listed: true, probe: null, handle }), "absent");
  assert.equal(classifyLeaf({ listed: false, probe: same, handle }), "aliased");
  assert.equal(classifyLeaf({ listed: false, probe: other, handle }), "replaced");
  assert.equal(classifyLeaf({ listed: false, probe: null, handle }), "absent");
  assert.equal(classifyLeaf({ listed: true, probe: { kind: "file", dev: 2, ino: 9 }, handle }), "replaced", "dev is part of the witness");
});

test("AC-2: confirmAlias rows for a segment whose listing lacks the exact spelling", () => {
  const recorded = { dev: 1, ino: 7 };
  assert.equal(confirmAlias(true, null, recorded), "continue");
  assert.equal(confirmAlias(true, { kind: "file", dev: 1, ino: 99 }, recorded), "continue");
  assert.equal(confirmAlias(false, null, recorded), "absent");
  assert.equal(confirmAlias(false, { kind: "file", dev: 1, ino: 7 }, recorded), "aliased");
  assert.equal(confirmAlias(false, { kind: "file", dev: 1, ino: 9 }, recorded), "restart");
});

test("AC-2: classifyMkdir rows, rel segments exact directories only and tail segments any spelling", () => {
  const docs = [entry("docs", "directory")];
  assert.equal(classifyMkdir("created", [], "Docs", false), "created");
  assert.equal(classifyMkdir("exists", [entry("Docs", "directory")], "Docs", false), "exact");
  assert.equal(classifyMkdir("exists", docs, "Docs", false), "aliased");
  assert.equal(classifyMkdir("exists", [entry("Docs", "file")], "Docs", false), "shape-mismatch");
  assert.equal(classifyMkdir("exists", [entry("Docs", "symlink")], "Docs", false), "shape-mismatch");
  assert.equal(classifyMkdir("exists", [entry("mybundle", "directory")], "MyBundle", true), "exact");
  assert.equal(classifyMkdir("exists", [entry("MyBundle", "directory")], "MyBundle", true), "exact");
  assert.equal(classifyMkdir("exists", [entry("MyBundle", "file")], "MyBundle", true), "shape-mismatch");
  assert.equal(classifyMkdir("created", docs, "MyBundle", true), "created");
});

// ── AC-3 observeExact interleavings ───────────────────────────────────────────

test("AC-3(a): an absent first segment is ABSENT with no further calls", async () => {
  const port = new ScriptedPort();
  assert.deepEqual(await observe(port), { state: "absent" });
  assert.deepEqual(port.trace, [`probe(${CONCEPTS})`]);
});

test("AC-3(b): O-PROBE via an alias records ino 7; listing lacks the exact leaf; confirming probe reaches 7: ALIASED, no open", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(path.join(CONCEPTS, "X.md"), "canonical", 7);
  await assert.rejects(() => observe(port), FilesystemIdentityAliasError);
  assert.deepEqual(port.trace, [
    `probe(${CONCEPTS})`,
    `probe(${TARGET})`,
    `entries(${ROOT})`,
    `entries(${CONCEPTS})`,
    `probe(${TARGET})`,
  ]);
  assert.equal(port.calls("open"), 0);
});

test("AC-3(b'): an aliased intermediate directory is refused at O-VERIFY with a confirming probe, before any open", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(path.join(ROOT, "Concepts/x.md"), "canonical");
  await assert.rejects(
    () => observe(port),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "concepts",
  );
  assert.equal(port.calls("open"), 0);
  assert.equal(port.trace.at(-1), `probe(${CONCEPTS})`);
});

test("AC-3(m): O-PROBE ok recording 7; listing lacks the exact leaf; confirming probe absent: ABSENT, no open (the non-aliasing delete race)", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 7);
  port.after("probe", 2, () => port.remove(TARGET));
  assert.deepEqual(await observe(port), { state: "absent" });
  assert.equal(port.calls("open"), 0);
  assert.equal(port.calls("probe"), 3);
});

test("AC-3(n): confirming probe reaches a different inode: exactly one restart that begins at O-PROBE, not with a listing", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "body", 7);
  port.after("probe", 2, () => {
    port.remove(TARGET);
    port.file(path.join(CONCEPTS, "X.md"), "alias", 9);
  });
  await assert.rejects(() => observe(port), FilesystemIdentityAliasError);
  assert.equal(probeWalks(port), 2, "one restart");
  const confirm = port.trace.indexOf(`probe(${TARGET})`, 2);
  assert.equal(port.trace[confirm + 1], `probe(${CONCEPTS})`, "the restart begins with O-PROBE");
  assert.equal(port.calls("open"), 0);
});

test("AC-3(o): a directory segment missing from the listing is confirmed against its recorded inode", async () => {
  const rel = "docs/x.md";
  const docs = path.join(ROOT, "docs");

  const aliased = new ScriptedPort({ aliasing: true });
  aliased.file(path.join(docs, "x.md"), "body");
  aliased.after("probe", 2, () => aliased.respell(docs, "Docs"));
  await assert.rejects(
    () => observe(aliased, rel),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "docs",
  );
  assert.equal(aliased.calls("open"), 0);

  const removed = new ScriptedPort();
  removed.file(path.join(docs, "x.md"), "body");
  removed.after("probe", 2, () => removed.remove(docs));
  assert.deepEqual(await observe(removed, rel), { state: "absent" });

  const replaced = new ScriptedPort({ aliasing: true });
  replaced.file(path.join(docs, "x.md"), "body");
  replaced.after("probe", 2, () => {
    replaced.remove(docs);
    replaced.file(path.join(ROOT, "Docs", "x.md"), "other", 6);
  });
  await assert.rejects(() => observe(replaced, rel), FilesystemIdentityAliasError);
  assert.equal(probeWalks(replaced, rel), 2, "a different inode restarts once; the restart then confirms the alias");
});

test("AC-3(c): exact throughout with a stable inode is EXACT, in the documented trace shape", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 9);
  assert.deepEqual(await observe(port), { state: "exact", value: "body" });
  assert.deepEqual(port.trace, [
    `probe(${CONCEPTS})`,
    `probe(${TARGET})`,
    `entries(${ROOT})`,
    `entries(${CONCEPTS})`,
    `open(${TARGET})`,
    "opened(#1)",
    "readAll(#1)",
    `entries(${ROOT})`,
    `entries(${CONCEPTS})`,
    `probe(${TARGET})`,
    "close(#1)",
  ]);
  assertHandleDiscipline(port);
});

test("AC-3(d): a replaced leaf restarts once from O-PROBE and returns the re-read bytes", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "old", 9);
  port.after("readAll", 1, () => void port.file(TARGET, "new", 10));
  assert.deepEqual(await observe(port), { state: "exact", value: "new" });
  assert.equal(port.calls("open"), 2);
  assert.equal(probeWalks(port), 2);
  assertHandleDiscipline(port);
});

test("AC-3(e): bytes read from H=11; post-walk lacks the exact leaf; probe reaches 11: ALIASED (kills 'remove O-POSTVERIFY')", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "body", 11);
  port.after("readAll", 1, () => port.respell(TARGET, "X.md"));
  await assert.rejects(() => observe(port), FilesystemIdentityAliasError);
  assertHandleDiscipline(port);
});

test("AC-3(f): post-walk lacks the exact leaf and the probe is absent: ABSENT", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 11);
  port.after("readAll", 1, () => port.remove(TARGET));
  assert.deepEqual(await observe(port), { state: "absent" });
  assertHandleDiscipline(port);
});

test("AC-3(g): a replacement followed by an alias on the restart is ALIASED", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "old", 9);
  port.after("readAll", 1, () => void port.file(TARGET, "new", 10));
  port.after("readAll", 2, () => port.respell(TARGET, "X.md"));
  await assert.rejects(() => observe(port), FilesystemIdentityAliasError);
  assert.equal(port.calls("open"), 2);
  assertHandleDiscipline(port);
});

test("AC-3(h): an intermediate segment no longer exactly listed at post-walk is ALIASED though the leaf matches (kills 'leaf-only post-verify')", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "body", 9);
  port.after("readAll", 1, () => port.respell(CONCEPTS, "Concepts"));
  await assert.rejects(
    () => observe(port),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "concepts",
  );
  assertHandleDiscipline(port);
});

// Post-walk listings are entries #3 (root) and #4 (concepts); the post leaf probe is probe #3.
test("AC-3(j): post-walk lacks the exact leaf and the probe reaches a different inode: one restart at O-PROBE, decided by the restart", async () => {
  // (j2) non-aliasing: the exact document was deleted and recreated; the restart reads it.
  const j2 = new ScriptedPort();
  j2.file(TARGET, "old", 9);
  j2.after("readAll", 1, () => j2.remove(TARGET));
  j2.after("entries", 4, () => void j2.file(TARGET, "recreated", 12));
  assert.deepEqual(await observe(j2), { state: "exact", value: "recreated" });
  assert.equal(probeWalks(j2), 2);
  assertHandleDiscipline(j2);

  // (j1) aliasing: recreated under an alias spelling; the restart's confirmed listing refuses it.
  const j1 = new ScriptedPort({ aliasing: true });
  j1.file(TARGET, "old", 9);
  j1.after("readAll", 1, () => j1.remove(TARGET));
  j1.after("entries", 4, () => void j1.file(path.join(CONCEPTS, "X.md"), "alias", 12));
  await assert.rejects(() => observe(j1), FilesystemIdentityAliasError);
  assert.equal(probeWalks(j1), 2);
  assert.equal(j1.calls("open"), 1, "the restart refuses before opening");
  assertHandleDiscipline(j1);

  // (j3) the restart's O-PROBE finds nothing: ABSENT.
  const j3 = new ScriptedPort();
  j3.file(TARGET, "old", 9);
  j3.after("readAll", 1, () => j3.remove(TARGET));
  j3.after("entries", 4, () => void j3.file(TARGET, "recreated", 12));
  j3.after("probe", 3, () => j3.remove(TARGET));
  assert.deepEqual(await observe(j3), { state: "absent" });
  assert.equal(probeWalks(j3), 2);
  assertHandleDiscipline(j3);

  // (j4) deleted again right after the restart's O-PROBE: the confirming probe is absent, so
  // ABSENT, never ALIASED (kills a restart that re-enters at O-VERIFY).
  const j4 = new ScriptedPort();
  j4.file(TARGET, "old", 9);
  j4.after("readAll", 1, () => j4.remove(TARGET));
  j4.after("entries", 4, () => void j4.file(TARGET, "recreated", 12));
  j4.after("probe", 5, () => j4.remove(TARGET));
  assert.deepEqual(await observe(j4), { state: "absent" });
  assert.equal(probeWalks(j4), 2);
  assert.equal(j4.calls("open"), 1);
  assertHandleDiscipline(j4);
});

test("AC-3(k): post-walk lists the exact leaf but the probe is absent: ABSENT, no restart", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 9);
  port.after("entries", 4, () => port.remove(TARGET));
  assert.deepEqual(await observe(port), { state: "absent" });
  assert.equal(probeWalks(port), 1);
  assertHandleDiscipline(port);
});

test("AC-3(i): replacement on every attempt is bounded at three restarts, then ConcurrentReplacementError; one handle at a time throughout", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "v0", 9);
  let ino = 9;
  for (const nth of [1, 2, 3, 4, 5]) port.after("readAll", nth, () => void port.file(TARGET, `v${nth}`, ++ino));
  await assert.rejects(() => observe(port), ConcurrentReplacementError);
  assert.equal(port.calls("open"), 4, "initial attempt plus exactly three restarts");
  assert.equal(probeWalks(port), 4, "exactly three O-PROBE re-walks");
  assertHandleDiscipline(port);
});

test("AC-3(i'): restarts from O-VERIFY confirmation count against the same bound", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(TARGET, "body", 7);
  let ino = 7;
  // After every O-PROBE leaf probe (probes 2, 5, 8, 11) swap the entry for a fresh alias inode,
  // so each O-VERIFY confirmation reaches a different inode and restarts.
  for (const nth of [2, 5, 8, 11]) {
    port.after("probe", nth, () => {
      port.remove(path.join(CONCEPTS, ino === 7 ? "x.md" : "X.md"));
      port.file(path.join(CONCEPTS, "X.md"), "alias", ++ino);
    });
  }
  await assert.rejects(() => observe(port), ConcurrentReplacementError);
  assert.equal(port.calls("open"), 0);
  assert.equal(probeWalks(port), 4);
});

test("V3A-4: a symbolic link at any rel segment is refused as caller input, before any open", async () => {
  const leaf = new ScriptedPort();
  leaf.symlink(TARGET);
  await assert.rejects(
    () => observe(leaf),
    (err: unknown) => err instanceof FilesystemSymlinkEntryError && err instanceof InvalidInputError && err.segment === "x.md",
  );
  assert.equal(leaf.calls("open"), 0);
  await assert.rejects(() => probeExact(leaf, ROOT, REL), FilesystemSymlinkEntryError);

  const dir = new ScriptedPort();
  dir.symlink(CONCEPTS);
  await assert.rejects(
    () => observe(dir),
    (err: unknown) => err instanceof FilesystemSymlinkEntryError && err.segment === "concepts",
  );
  await assert.rejects(() => mutateExact(dir, ROOT, REL, async () => "unreachable"), FilesystemSymlinkEntryError);
  assert.deepEqual(dir.ops("mkdir", "writeTemp", "rename", "unlink"), []);
  assert.equal(opsOf(dir).at(-1), "release");

  const raced = new ScriptedPort();
  raced.mkdirp(ROOT);
  raced.override("mkdir", async () => {
    raced.symlink(CONCEPTS);
    return "exists";
  });
  await assert.rejects(() => mutateExact(raced, ROOT, REL, casWrite(null)), FilesystemSymlinkEntryError);
  assert.deepEqual(raced.ops("writeTemp", "rename", "unlink"), []);
});

test("probeExact: presence is bound to the recorded inode and restarts on replacement", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "body", 9);
  assert.deepEqual(await probeExact(port, ROOT, REL), { state: "exact", value: { kind: "file", dev: 1, ino: 9 } });
  assert.deepEqual(port.trace, [
    `probe(${CONCEPTS})`,
    `probe(${TARGET})`,
    `entries(${ROOT})`,
    `entries(${CONCEPTS})`,
    `entries(${ROOT})`,
    `entries(${CONCEPTS})`,
    `probe(${TARGET})`,
  ]);

  const again = new ScriptedPort();
  again.file(TARGET, "body", 9);
  again.after("entries", 4, () => void again.file(TARGET, "other", 10));
  assert.deepEqual(await probeExact(again, ROOT, REL), { state: "exact", value: { kind: "file", dev: 1, ino: 10 } });
  assert.equal(probeWalks(again), 2);

  const gone = new ScriptedPort();
  gone.file(TARGET, "body", 9);
  gone.after("entries", 4, () => gone.remove(TARGET));
  assert.deepEqual(await probeExact(gone, ROOT, REL), { state: "absent" });
});

test("observeExact: containment guard rejects escapes before any port call", async () => {
  const port = new ScriptedPort();
  for (const rel of ["../x.md", "/x.md", "a/../x.md", ""]) {
    await assert.rejects(() => observe(port, rel), InvalidInputError);
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

test("AC-4: first-creation ordering is claim, walk, CAS read, per-segment mkdir, writeTemp, link, unlink(tmp), release", async () => {
  const port = new ScriptedPort();
  port.mkdirp(ROOT);
  const key = await identityKey(ROOT, "a/b/c.md");
  assert.equal(await mutateExact(port, ROOT, "a/b/c.md", casWrite(null)), "written");
  const ops = opsOf(port);
  assert.equal(ops[0], "claim");
  assert.equal(ops[ops.length - 1], "release");
  assert.deepEqual(port.ops("mkdir", "writeTemp", "link", "rename", "unlink").map(opOf), ["mkdir", "mkdir", "writeTemp", "link", "unlink"]);
  assert.deepEqual(port.ops("mkdir"), [`mkdir(${path.join(ROOT, "a")})`, `mkdir(${path.join(ROOT, "a/b")})`]);
  assert.ok(ops.indexOf("probe") > ops.indexOf("claim") && ops.indexOf("mkdir") > ops.lastIndexOf("entries"));
  assert.equal(port.trace[0], `claim(${key})`);
  const [link] = port.ops("link");
  const [unlink] = port.ops("unlink");
  assert.ok(link!.endsWith(`, ${path.join(ROOT, "a/b/c.md")})`), "link publishes the temp under the exact name");
  assert.equal(unlink, `unlink(${link!.slice("link(".length, link!.indexOf(","))})`, "the temp name is unlinked after the link");
  assert.equal(port.node(path.join(ROOT, "a/b/c.md"))?.bytes.toString(), "new");
  assert.deepEqual([...port.node(path.join(ROOT, "a/b"))!.children.keys()], ["c.md"], "no temp link remains");
});

test("AC-4: an existing leaf is read for CAS before mkdir/write, replaced by rename, and no mkdir is issued for present segments", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "old", 9);
  assert.equal(await mutateExact(port, ROOT, REL, casWrite("old")), "written");
  const ops = opsOf(port);
  assert.deepEqual(port.ops("writeTemp", "link", "rename", "unlink").map(opOf), ["writeTemp", "rename"], "a replace never links");
  assert.ok(ops.indexOf("open") > ops.indexOf("claim") && ops.indexOf("open") < ops.indexOf("writeTemp"));
  assert.ok(ops.indexOf("close") < ops.indexOf("writeTemp"), "the CAS read handle is closed before the write");
  assert.deepEqual(port.ops("mkdir"), []);
  assert.equal(port.openCount, 0);
});

test("AC-4: ALIASED at the walk is claim, walk, release with no write-class call", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.file(path.join(ROOT, "concepts/X.md"), "canonical");
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite(null)), FilesystemIdentityAliasError);
  const ops = opsOf(port);
  assert.equal(ops[0], "claim");
  assert.equal(ops[ops.length - 1], "release");
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink", "open"), []);
});

test("AC-4: a CAS conflict issues no mkdir and no write-class call, and still releases", async () => {
  const port = new ScriptedPort();
  port.file(TARGET, "current", 9);
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite("stale")), /conflict/);
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink"), []);
  assert.equal(opsOf(port).at(-1), "release");
  assert.equal(port.openCount, 0);
});

test("AC-4: CAS against an absent target reads nothing and creates nothing on conflict", async () => {
  const port = new ScriptedPort();
  port.mkdirp(ROOT);
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite("expected-present")), /conflict/);
  assert.deepEqual(port.ops("mkdir", "writeTemp", "rename", "unlink", "open"), []);
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

test("AC-4: a failed link or rename removes its own temp file", async () => {
  const first = new ScriptedPort();
  first.mkdirp(CONCEPTS);
  first.override("link", async ([from]) => {
    throw Object.assign(new Error("EIO"), { code: "EIO", path: from });
  });
  await assert.rejects(() => mutateExact(first, ROOT, REL, casWrite(null)), /EIO/);
  assert.equal(first.calls("unlink"), 1);
  assert.deepEqual([...first.node(CONCEPTS)!.children.keys()], []);

  const replace = new ScriptedPort();
  replace.file(TARGET, "old", 9);
  replace.override("rename", async ([from]) => {
    throw Object.assign(new Error("EIO"), { code: "EIO", path: from });
  });
  await assert.rejects(() => mutateExact(replace, ROOT, REL, casWrite("old")), /EIO/);
  assert.equal(replace.calls("unlink"), 1);
  assert.deepEqual([...replace.node(CONCEPTS)!.children.keys()], ["x.md"]);
  assert.equal(replace.node(TARGET)?.bytes.toString(), "old");
});

test("AC-4: a first creation whose link hits EEXIST is refused as an alias when the listing lacks the exact spelling, with only its temp unlinked", async () => {
  const port = new ScriptedPort({ aliasing: true });
  port.mkdirp(CONCEPTS);
  // The equated entry appears between M-REALIZE (absent) and M-APPLY: a fold-gap writer won.
  port.after("writeTemp", 1, () => void port.file(path.join(CONCEPTS, "X.md"), "winner", 7));
  await assert.rejects(
    () => mutateExact(port, ROOT, REL, casWrite(null)),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "x.md",
  );
  assert.deepEqual(port.ops("link", "rename", "unlink").map(opOf), ["link", "unlink"]);
  assert.ok(port.ops("unlink")[0]!.includes(".x.md."), "only the temp file is unlinked");
  assert.deepEqual([...port.node(CONCEPTS)!.children.keys()], ["X.md"], "the winner is intact and no residue remains");
  assert.equal(port.node(path.join(CONCEPTS, "X.md"))?.bytes.toString(), "winner");
  assert.equal(opsOf(port).at(-1), "release");
});

test("AC-4: a first creation whose link hits EEXIST with the exact spelling listed fails closed as a concurrent replacement", async () => {
  const port = new ScriptedPort();
  port.mkdirp(CONCEPTS);
  // A same-spelling entry appearing under our own key is impossible for core; a non-core actor did it.
  port.after("writeTemp", 1, () => void port.file(TARGET, "foreign", 7));
  await assert.rejects(() => mutateExact(port, ROOT, REL, casWrite(null)), ConcurrentReplacementError);
  assert.deepEqual(port.ops("link", "rename", "unlink").map(opOf), ["link", "unlink"]);
  assert.equal(port.node(TARGET)?.bytes.toString(), "foreign", "the existing document is intact");
  assert.deepEqual([...port.node(CONCEPTS)!.children.keys()], ["x.md"]);
});

test("F1: a filesystem without hard links falls back to rename for first creation, learned once per root, with no probe file", async () => {
  const port = new ScriptedPort();
  port.mkdirp("/nolink/concepts");
  port.override("link", async () => "unsupported");
  assert.equal(await mutateExact(port, "/nolink", REL, casWrite(null)), "written");
  assert.deepEqual(port.ops("writeTemp", "link", "rename", "unlink").map(opOf), ["writeTemp", "link", "rename"]);
  assert.equal(port.node("/nolink/concepts/x.md")?.bytes.toString(), "new");
  assert.deepEqual([...port.node("/nolink/concepts")!.children.keys()], ["x.md"], "no probe or temp file remains");

  port.trace.length = 0;
  assert.equal(await mutateExact(port, "/nolink", "concepts/y.md", casWrite(null)), "written");
  assert.deepEqual(port.ops("writeTemp", "link", "rename", "unlink").map(opOf), ["writeTemp", "rename"], "the root is remembered; no second link attempt");

  // Another root is unaffected by the first root's answer.
  port.mkdirp("/haslink/concepts");
  port.override("link", async (args, base) => base());
  port.trace.length = 0;
  assert.equal(await mutateExact(port, "/haslink", REL, casWrite(null)), "written");
  assert.deepEqual(port.ops("writeTemp", "link", "rename", "unlink").map(opOf), ["writeTemp", "link", "unlink"]);
});

test("F2: a failed unlink of the temp name after a successful link does not fail the write", async () => {
  const port = new ScriptedPort();
  port.mkdirp(CONCEPTS);
  port.override("unlink", async ([target]) => {
    throw Object.assign(new Error("EBUSY"), { code: "EBUSY", path: target });
  });
  assert.equal(await mutateExact(port, ROOT, REL, casWrite(null)), "written");
  assert.deepEqual(port.ops("writeTemp", "link", "rename", "unlink").map(opOf), ["writeTemp", "link", "unlink"]);
  assert.equal(port.node(TARGET)?.bytes.toString(), "new");
  const names = [...port.node(CONCEPTS)!.children.keys()];
  assert.deepEqual(names.filter((name) => !name.startsWith(".")), ["x.md"]);
  assert.equal(names.length, 2, "the leftover temp link is the dot-prefixed crash-residue class");
  assert.equal(opsOf(port).at(-1), "release");
});

test("AC-15c: two first creations under different keys for names the host equates: the loser's link fails EEXIST and it is refused with the winner intact", async () => {
  const port = new ScriptedPort();
  port.mkdirp(CONCEPTS);
  // A fold gap: the keys differ (distinct rels), but the scripted host equates the two names at
  // link time. The second writer's M-REALIZE sees nothing (non-aliasing probes), so it reaches
  // link, which is scripted to report EEXIST exactly as the host would.
  assert.notEqual(await identityKey(ROOT, "concepts/x.md"), await identityKey(ROOT, "concepts/y.md"));
  assert.equal(await mutateExact(port, ROOT, "concepts/x.md", casWrite(null)), "written");
  port.trace.length = 0;
  port.override("link", async ([, to]) => (to === path.join(CONCEPTS, "y.md") ? "exists" : "linked"));
  await assert.rejects(
    () => mutateExact(port, ROOT, "concepts/y.md", casWrite(null)),
    (err: unknown) => err instanceof FilesystemIdentityAliasError && err.segment === "y.md",
  );
  assert.deepEqual(port.ops("link", "rename", "unlink").map(opOf), ["link", "unlink"], "one link, no rename, its own temp unlinked");
  assert.ok(port.ops("unlink")[0]!.includes(".y.md."));
  assert.deepEqual([...port.node(CONCEPTS)!.children.keys()], ["x.md"]);
  assert.equal(port.node(path.join(CONCEPTS, "x.md"))?.bytes.toString(), "new");
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

/**
 * Pairs a case-insensitive host equates through Unicode FULL case folding that NFKD plus a plain
 * lower-case fold does NOT equate (verified on APFS: each pair aliases on disk). Every pair must
 * derive one key, or two concurrent first-creation writers would both realize ABSENT.
 */
const FULL_CASE_FOLD_PAIRS: Array<[string, string]> = [
  ["straße", "STRASSE"],
  ["straße", "strasse"],
  ["ẞ", "SS"],
  ["ς", "σ"],
  ["ᾈ", "ἀι"],
  ["ᾳ", "αι"],
  ["ῳ", "ωι"],
  ["ᾨ", "ὠι"],
  ["ῌ", "ηι"],
];

test("AC-5: full-case-folding pairs derive one identity key, and a plain lower-case fold would not", async () => {
  assert.equal(FULL_CASE_FOLD_PAIRS.length, 9);
  for (const [a, b] of FULL_CASE_FOLD_PAIRS) {
    assert.equal(await identityKey("/x/bundle", `concepts/${a}.md`), await identityKey("/x/bundle", `concepts/${b}.md`), `${a} / ${b}`);
    assert.notEqual(a.normalize("NFKD").toLowerCase(), b.normalize("NFKD").toLowerCase(), `${a} / ${b} is the class a lower-case fold misses`);
  }
  // Root segments fold the same way as rel segments.
  assert.equal(await identityKey("/x/Straße", "concepts/a.md"), await identityKey("/x/STRASSE", "concepts/a.md"));
});

test("AC-5 row 3: every C and F entry of the checked-in Unicode CaseFolding table folds to one key", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const table = await readFile(path.join(here, "fixtures", "CaseFolding-17.0.0.txt"), "utf8");
  assert.match(table, /^# CaseFolding-17\.0\.0\.txt/m, "fixture is the pinned Unicode version");
  const entries = { C: 0, F: 0 };
  const failures: string[] = [];
  for (const line of table.split("\n")) {
    const match = /^([0-9A-F]+); ([CFST]); ([0-9A-F ]+);/.exec(line);
    if (match === null) continue;
    const [, code, status, mapping] = match as unknown as [string, string, "C" | "F" | "S" | "T", string];
    if (status !== "C" && status !== "F") continue;
    entries[status]++;
    const source = String.fromCodePoint(Number.parseInt(code, 16));
    const folded = String.fromCodePoint(...mapping.trim().split(" ").map((hex) => Number.parseInt(hex, 16)));
    if (foldSegment(source) !== foldSegment(folded)) failures.push(`${code} ${status} ${mapping.trim()}`);
  }
  assert.deepEqual(entries, { C: 1481, F: 104 }, "entry counts pin the table's content");
  assert.deepEqual(failures, []);
});

test("AC-5: fold digest over the checked-in spelling list is pinned", async () => {
  assert.equal(DIGEST_SPELLINGS.length, 50);
  const digest = createHash("sha256");
  for (const [root, rel] of DIGEST_SPELLINGS) digest.update(`${await identityKey(root, rel)}\n`);
  for (const [a, b] of FULL_CASE_FOLD_PAIRS) {
    digest.update(`${await identityKey("/", `concepts/${a}.md`)}\n`);
    digest.update(`${await identityKey("/", `concepts/${b}.md`)}\n`);
  }
  assert.equal(digest.digest("hex"), "7307f1939479537efaac08c000c1e3552d855434e29bb93ba1ee493c086d5f4e");
});
