/**
 * L2 native platform proofs for the filesystem adapter on the real filesystem. Expectations
 * depend on the detected host class (see `host-class.ts`); nothing here skips, and a lane that
 * declares its host class fails closed when the filesystem disagrees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { FilesystemBackend } from "../src/backend.js";
import { ConcurrentReplacementError, FilesystemIdentityAliasError, InvalidInputError } from "../src/errors.js";
import { FilesystemSymlinkEntryError, identityKey } from "../src/filesystem-identity.js";
import { FilesystemMutationLockError, filesystemIdentityLockPath, filesystemMutationLockRoot } from "../src/filesystem-lock.js";
import { VersionConflict } from "../src/versioning.js";
import { detectHostClass, type HostClass } from "./host-class.js";

const TIMESTAMP = "2026-07-01T00:00:00.000Z";
const doc = (id: string, body: string) => ({ id, frontmatter: { type: "NativeFixture", timestamp: TIMESTAMP }, body });
const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

let hostClassPromise: Promise<HostClass> | undefined;
const hostClass = (): Promise<HostClass> => (hostClassPromise ??= detectHostClass());
const backend = (root: string): FilesystemBackend => new FilesystemBackend(root);

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `superbee-identity-native-${prefix}-`));
}

// ── AC-7 absent-root observation ──────────────────────────────────────────────

test("AC-7: every observation of an absent root reports absence and leaves the root absent", async () => {
  const parent = await tempRoot("absent-root");
  const root = path.join(parent, "bundle");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.read("missing/nested"), isEnoent);
    await assert.rejects(() => backend.readMany(["missing/nested"]), isEnoent);
    assert.equal(await backend.exists("missing/nested"), false);
    assert.deepEqual(await backend.versions("missing/nested"), []);
    assert.deepEqual(await backend.list(), []);
    assert.equal(await backend.readReserved("", "index.md"), null);
    assert.equal(await backend.readReserved("docs", "log.md"), null);
    assert.equal(await backend.readBlob("artifacts/missing.bin"), null);
    assert.equal(await backend.existsBlob("artifacts/missing.bin"), false);
    assert.deepEqual(await backend.listBlobs(), []);
    await assert.rejects(() => stat(root), isEnoent);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-7: observations of absent paths inside an existing root create nothing", async () => {
  const root = await tempRoot("absent-paths");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.read("missing/nested"), isEnoent);
    assert.equal(await backend.exists("missing/nested"), false);
    assert.deepEqual(await backend.versions("missing/nested"), []);
    assert.equal(await backend.readReserved("missing", "index.md"), null);
    assert.equal(await backend.readBlob("artifacts/missing.bin"), null);
    assert.equal(await backend.existsBlob("artifacts/missing.bin"), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── AC-8 rejected-mutation non-materialization ────────────────────────────────

test("AC-8: a CAS-rejected write in an empty root creates no directory", async () => {
  const root = await tempRoot("cas-empty");
  try {
    const backend = new FilesystemBackend(root);
    const stale = "sha256:" + "0".repeat(64);
    await assert.rejects(() => backend.write("concepts/nested/doc", doc("concepts/nested/doc", "x"), { expectedVersion: stale }), VersionConflict);
    await assert.rejects(() => backend.writeReserved("docs", "index.md", "# x\n", { expectedVersion: stale }), VersionConflict);
    await assert.rejects(() => backend.writeBlob("artifacts/x.bin", new Uint8Array([1]), undefined, { expectedVersion: stale }), VersionConflict);
    assert.equal(await backend.delete("concepts/nested/doc", { expectedVersion: stale }), false);
    assert.equal(await backend.deleteBlob("artifacts/x.bin", { expectedVersion: stale }), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC-8: a CAS-rejected write against an absent root leaves the root absent", async () => {
  const parent = await tempRoot("cas-absent-root");
  const root = path.join(parent, "bundle");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.write("concepts/doc", doc("concepts/doc", "x"), { expectedVersion: "sha256:" + "1".repeat(64) }), VersionConflict);
    assert.equal(await backend.delete("concepts/doc"), false);
    await assert.rejects(() => stat(root), isEnoent);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-8 (cond): an aliased write leaves listings unchanged at every level", async () => {
  const root = await tempRoot("alias-write");
  try {
    const backend = new FilesystemBackend(root);
    const aliasing = (await hostClass()) !== "exact";
    await backend.write("Docs/a", doc("Docs/a", "a"));
    const attempt = backend.write("docs/b", doc("docs/b", "b"));
    if (!aliasing) {
      await attempt;
      assert.deepEqual((await readdir(root)).sort(), ["Docs", "docs"]);
      assert.deepEqual(await readdir(path.join(root, "docs")), ["b.md"]);
    } else {
      await assert.rejects(() => attempt, FilesystemIdentityAliasError);
      assert.deepEqual(await readdir(root), ["Docs"]);
    }
    // After the operation completes no residue remains at any level, dot entries included: a
    // refused first creation removes its own temp file before reporting the refusal.
    assert.deepEqual(await readdir(path.join(root, "Docs")), ["a.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── AC-15 directory first-creation race ───────────────────────────────────────

test("AC-15 (cond): concurrent first creation of Docs/a and docs/b yields exactly one spelling on an aliasing host", async () => {
  const aliasing = (await hostClass()) !== "exact";
  for (let round = 0; round < 5; round++) {
    const root = await tempRoot(`race-${round}`);
    try {
      const writers = [
        ["Docs/a", new FilesystemBackend(root)],
        ["docs/b", new FilesystemBackend(root)],
      ] as const;
      const outcomes = await Promise.allSettled(writers.map(([id, backend]) => backend.write(id, doc(id, id))));
      const fulfilled = outcomes.flatMap((outcome, index) => (outcome.status === "fulfilled" ? [writers[index]![0]] : []));
      const refused = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      const rootListing = await readdir(root);
      if (aliasing) {
        assert.equal(fulfilled.length, 1, `round ${round}: outcomes ${JSON.stringify(outcomes.map((o) => o.status))}`);
        assert.equal(refused.length, 1);
        assert.ok(refused[0] instanceof FilesystemIdentityAliasError, String(refused[0]));
        assert.equal(rootListing.length, 1, `one directory spelling, got ${rootListing.join(",")}`);
      } else {
        assert.deepEqual(fulfilled.sort(), ["Docs/a", "docs/b"]);
        assert.deepEqual(rootListing.sort(), ["Docs", "docs"]);
      }
      for (const id of fulfilled) {
        const [dir, name] = id.split("/") as [string, string];
        assert.ok(rootListing.includes(dir), `winner's directory '${dir}' spelled exactly`);
        const listing = await readdir(path.join(root, dir));
        assert.ok(listing.includes(`${name}.md`), `winner's file '${name}.md' spelled exactly`);
        assert.deepEqual(listing.filter((entry) => entry.startsWith(".")), [], "no temp file remains");
      }
      for (const dir of rootListing) {
        assert.deepEqual((await readdir(path.join(root, dir))).filter((entry) => entry.startsWith(".")), []);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// AC-15b, forbidden-outcome form: on every host class, never two `fulfilled` with fewer than two
// files, and every fulfilled writer's file is at its exact requested path with its own body. With
// the fold in place the pair shares one key (excluded by the lock); with the fold reverted the
// loser's link still fails EEXIST, so the forbidden outcomes cannot occur either way.
test("AC-15b (cond): concurrent first creation of a full-case-folding pair never fulfils both writers on an aliasing host", async () => {
  const aliasing = (await hostClass()) !== "exact";
  const pairs: Array<[string, string]> = [
    ["concepts/straße", "concepts/STRASSE"],
    ["concepts/ẞ", "concepts/SS"],
    ["concepts/ς", "concepts/σ"],
    ["concepts/ᾈ", "concepts/ἀι"],
  ];
  for (const [first, second] of pairs) {
    for (let round = 0; round < 3; round++) {
      const root = await tempRoot(`fold-race-${round}`);
      try {
        const writers = [first, second].map((id) => [id, new FilesystemBackend(root)] as const);
        const outcomes = await Promise.allSettled(writers.map(([id, backend]) => backend.write(id, doc(id, id))));
        const fulfilled = outcomes.flatMap((outcome, index) => (outcome.status === "fulfilled" ? [writers[index]![0]] : []));
        const rejected = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
        const files = await readdir(path.join(root, "concepts"));
        const label = `${first} vs ${second}, round ${round}: ${JSON.stringify(outcomes.map((o) => o.status))} files=${files.join(",")}`;
        assert.ok(!(fulfilled.length === 2 && files.length < 2), `forbidden: both fulfilled with one file (${label})`);
        for (const id of fulfilled) {
          const name = `${id.slice("concepts/".length)}.md`;
          assert.ok(files.includes(name), `forbidden: fulfilled '${id}' is not at its exact path (${label})`);
          assert.equal((await backend(root).read(id)).doc.body.trimEnd(), id, `forbidden: fulfilled '${id}' lost its body (${label})`);
        }
        assert.deepEqual(files.filter((name) => name.startsWith(".")), [], `no temp residue (${label})`);
        if (aliasing) {
          assert.equal(fulfilled.length, 1, label);
          assert.ok(
            rejected[0] instanceof FilesystemIdentityAliasError || rejected[0] instanceof ConcurrentReplacementError,
            label,
          );
          assert.deepEqual(files, [`${fulfilled[0]!.slice("concepts/".length)}.md`], label);
        } else {
          assert.deepEqual(fulfilled.sort(), [first, second].sort(), label);
          assert.equal(files.length, 2, label);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test("I4: a backend built with a relative root keeps its identity across a later chdir", async () => {
  const parent = await tempRoot("relative-root");
  const cwd = process.cwd();
  try {
    process.chdir(parent);
    const relative = new FilesystemBackend("bundle");
    await relative.write("concepts/a", doc("concepts/a", "a"));
    const elsewhere = path.join(parent, "elsewhere");
    await mkdir(elsewhere);
    process.chdir(elsewhere);
    assert.equal((await relative.read("concepts/a")).doc.body.trimEnd(), "a");
    await relative.write("concepts/b", doc("concepts/b", "b"));
    assert.deepEqual(await readdir(elsewhere), [], "nothing was created relative to the new cwd");
    assert.deepEqual((await readdir(path.join(parent, "bundle", "concepts"))).sort(), ["a.md", "b.md"]);
  } finally {
    process.chdir(cwd);
    await rm(parent, { recursive: true, force: true });
  }
});

// ── AC-12a crash residue, single process ──────────────────────────────────────

test("AC-12a: a stale or malformed identity lock fails the next write closed, naming the identity, with no partial file", async () => {
  const cases = [
    {
      name: "stale",
      owner: { pid: 999_999, hostname: hostname(), created_at_ms: Date.now() - 60_000, token: "dead", target: "unused" },
      stale: true,
      malformed: false,
    },
    { name: "malformed", owner: null, stale: false, malformed: true },
  ] as const;
  for (const fixture of cases) {
    const root = await tempRoot(`residue-${fixture.name}`);
    const key = await identityKey(root, "concepts/x.md");
    const lockPath = filesystemIdentityLockPath(key, root);
    try {
      await mkdir(filesystemMutationLockRoot(root), { recursive: true, mode: 0o700 });
      await mkdir(lockPath, { recursive: true });
      if (fixture.owner) await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(fixture.owner));
      await assert.rejects(
        () => new FilesystemBackend(root).write("concepts/x", doc("concepts/x", "x")),
        (err: unknown) => {
          assert.ok(err instanceof FilesystemMutationLockError);
          assert.equal(err.stale, fixture.stale);
          assert.equal(err.malformed, fixture.malformed);
          assert.equal(err.lockPath, lockPath);
          assert.ok(err.message.includes(`${path.resolve(root)}:concepts/x.md`), err.message);
          return true;
        },
      );
      assert.deepEqual(await readdir(root), [], "no partial file in the bundle");
      assert.equal((await stat(lockPath)).isDirectory(), true, "the leftover is never stolen");
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

// ── AC-17 normalizing-store scope-out ─────────────────────────────────────────

test("AC-17 (cond): a normalizing store is unsupported and fails closed; CI hosts are not normalizing", async () => {
  const detected = await hostClass();
  const root = await tempRoot("normalizing");
  try {
    const backend = new FilesystemBackend(root);
    const nfc = "concepts/café";
    await backend.write(nfc, doc(nfc, "nfc"));
    if (detected === "normalizing") {
      await assert.rejects(() => backend.read(nfc), FilesystemIdentityAliasError);
      await assert.rejects(() => backend.exists(nfc), FilesystemIdentityAliasError);
      await assert.rejects(() => backend.versions(nfc), FilesystemIdentityAliasError);
      assert.deepEqual(await backend.list(), ["concepts/café"]);
    } else {
      assert.notEqual(detected, "normalizing");
      assert.equal((await backend.read(nfc)).doc.body.trimEnd(), "nfc");
      assert.equal(await backend.exists(nfc), true);
      assert.deepEqual(await backend.list(), [nfc]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── AC-18 readers under a hot delete/write loop ───────────────────────────────

const AC18_RUN_MS = 1_000;

interface ReaderTally {
  bytes: number;
  absent: number;
  replaced: number;
  aliased: number;
}

async function readerLoop(
  backend: FilesystemBackend,
  id: string,
  deadline: number,
  allowedBodies: () => Set<string>,
  aliasAllowed: boolean,
): Promise<ReaderTally> {
  const tally: ReaderTally = { bytes: 0, absent: 0, replaced: 0, aliased: 0 };
  while (Date.now() < deadline) {
    try {
      const body = (await backend.read(id)).doc.body.trimEnd();
      assert.ok(allowedBodies().has(body), `read returned bytes never written under '${id}': ${body}`);
      tally.bytes++;
    } catch (err) {
      if (isEnoent(err)) tally.absent++;
      else if (err instanceof ConcurrentReplacementError) tally.replaced++;
      else if (err instanceof FilesystemIdentityAliasError && aliasAllowed) tally.aliased++;
      else throw err;
    }
  }
  return tally;
}

test("AC-18: readers of a document under a delete/write loop see only written bytes, absence, or a bounded-replacement error", async () => {
  const root = await tempRoot("ac18-churn");
  try {
    const backend = new FilesystemBackend(root);
    const deadline = Date.now() + AC18_RUN_MS;
    const written = new Set<string>();
    let iteration = 0;
    const writer = (async () => {
      while (Date.now() < deadline) {
        const body = `iteration-${++iteration}`;
        written.add(body);
        await backend.write("concepts/a", doc("concepts/a", body));
        await backend.delete("concepts/a");
      }
    })();
    const readers = await Promise.all([
      readerLoop(backend, "concepts/a", deadline, () => written, false),
      readerLoop(backend, "concepts/a", deadline, () => written, false),
    ]);
    await writer;
    assert.ok(iteration > 0);
    assert.ok(readers.some((tally) => tally.bytes + tally.absent + tally.replaced > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC-18 (cond): alternating exact and alias spellings never yield an alias-tagged body to readers of the exact id", async () => {
  const aliasing = (await hostClass()) !== "exact";
  const root = await tempRoot("ac18-alternate");
  try {
    const backend = new FilesystemBackend(root);
    const deadline = Date.now() + AC18_RUN_MS;
    const exactBodies = new Set<string>();
    let iteration = 0;
    const writer = (async () => {
      while (Date.now() < deadline) {
        const n = ++iteration;
        exactBodies.add(`a-${n}`);
        await backend.write("concepts/a", doc("concepts/a", `a-${n}`));
        await backend.delete("concepts/a");
        await backend.write("concepts/A", doc("concepts/A", `A-${n}`));
        await backend.delete("concepts/A");
      }
    })();
    const [tally] = await Promise.all([
      readerLoop(backend, "concepts/a", deadline, () => exactBodies, aliasing),
      writer,
    ]);
    assert.ok(iteration > 0);
    if (!aliasing) assert.equal(tally.aliased, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── V3A-4 / R1: symlinked entries fail closed ─────────────────────────────────

// Behavior change recorded for R1 layouts: a symlinked document or directory inside a bundle used
// to be read through; it is now refused on every operation with an input-class error, because
// the walk never follows links and a link's inode cannot witness what opening it would reach.
test("R1: a symlinked document or directory inside a bundle is refused as caller input on every operation", async () => {
  const root = await tempRoot("symlink");
  try {
    const backend = new FilesystemBackend(root);
    await backend.write("concepts/real", doc("concepts/real", "real"));
    await symlink("real.md", path.join(root, "concepts", "linked.md"));
    await symlink("concepts", path.join(root, "linked-dir"));
    const isSymlinkRefusal = (err: unknown): boolean =>
      err instanceof FilesystemSymlinkEntryError && err instanceof InvalidInputError;

    await assert.rejects(() => backend.read("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.exists("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.versions("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.write("concepts/linked", doc("concepts/linked", "x")), isSymlinkRefusal);
    await assert.rejects(() => backend.delete("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.read("linked-dir/real"), isSymlinkRefusal);
    await assert.rejects(() => backend.write("linked-dir/other", doc("linked-dir/other", "x")), isSymlinkRefusal);
    assert.equal((await backend.read("concepts/real")).doc.body.trimEnd(), "real");
    assert.deepEqual(await backend.list(), ["concepts/real"], "listings skip links as before");
    assert.deepEqual(await readdir(path.join(root, "concepts")), ["linked.md", "real.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
