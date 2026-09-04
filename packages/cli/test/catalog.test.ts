import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { filesystemMutationLockPath, initBundle } from "@superbee/core";

import {
  addCatalogEntry,
  catalogLockPath,
  catalogPath,
  listCatalogEntries,
  loadCatalog,
  parseCatalog,
  resolveCatalogEntry,
} from "../src/catalog.js";
import { CliError } from "../src/errors.js";
import { canonicalUserStateDir, ensureUserStateRoot } from "../src/user-state.js";

async function fixture(): Promise<{ root: string; home: string; first: string; second: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-catalog-test-")));
  const home = path.join(root, "home");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await mkdir(home);
  await initBundle(first);
  await initBundle(second);
  return { root, home, first, second };
}

const id = (digit: string): string => `bnd_${digit.repeat(32)}`;

test("catalog add is durable, private, sorted, and idempotent for the same label/path", async () => {
  const f = await fixture();
  try {
    const first = await addCatalogEntry("zeta", f.first, { home: f.home, createId: () => id("1") });
    const repeated = await addCatalogEntry("zeta", f.first, { home: f.home, createId: () => id("9") });
    const second = await addCatalogEntry("alpha", f.second, { home: f.home, createId: () => id("2") });

    assert.equal(first.changed, true);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.entry.id, first.entry.id);
    assert.equal(second.changed, true);
    assert.deepEqual((await loadCatalog(f.home)).entries.map((entry) => entry.label), ["alpha", "zeta"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(path.dirname(catalogPath(f.home)))).mode & 0o777, 0o700);
      assert.equal((await stat(catalogPath(f.home))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog uniqueness conflicts do not alter the prior registry", async () => {
  const f = await fixture();
  try {
    await addCatalogEntry("one", f.first, { home: f.home, createId: () => id("1") });
    const before = await readFile(catalogPath(f.home), "utf8");
    await assert.rejects(
      () => addCatalogEntry("one", f.second, { home: f.home }),
      (err: unknown) => err instanceof CliError && err.code === "ALREADY_EXISTS",
    );
    await assert.rejects(
      () => addCatalogEntry("two", f.first, { home: f.home }),
      (err: unknown) => err instanceof CliError && err.code === "ALREADY_EXISTS",
    );
    assert.equal(await readFile(catalogPath(f.home), "utf8"), before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog parser rejects drift-prone or ambiguous persisted state", () => {
  const file = "/tmp/catalog.json";
  assert.throws(() => parseCatalog("{", file), (err: unknown) => err instanceof CliError && err.code === "USAGE");
  assert.throws(
    () => parseCatalog(JSON.stringify({ schema_version: 1, entries: [], extra: true }), file),
    (err: unknown) => err instanceof CliError && err.code === "USAGE",
  );
  assert.throws(
    () =>
      parseCatalog(
        JSON.stringify({
          schema_version: 1,
          entries: [
            { id: id("1"), label: "one", locator: { kind: "local-path", path: "/tmp/one" } },
            { id: id("2"), label: "one", locator: { kind: "local-path", path: "/tmp/two" } },
          ],
        }),
        file,
      ),
    (err: unknown) => err instanceof CliError && err.code === "USAGE",
  );
  assert.throws(
    () =>
      parseCatalog(
        JSON.stringify({
          schema_version: 1,
          entries: [{ id: id("1"), label: "one", locator: { kind: "local-path", path: "/tmp/a/../one" } }],
        }),
        file,
      ),
    (err: unknown) => err instanceof CliError && err.code === "USAGE",
  );
  assert.throws(
    () => parseCatalog(JSON.stringify({ schema_version: 2, entries: [] }), file),
    (err: unknown) => err instanceof CliError && err.code === "NOT_IMPLEMENTED",
  );
});

test("a newer catalog schema refuses mutation without rewriting bytes", async () => {
  const f = await fixture();
  try {
    await ensureUserStateRoot(f.home);
    const future = JSON.stringify({ schema_version: 2, entries: [], future: true }) + "\n";
    await writeFile(catalogPath(f.home), future);
    await assert.rejects(
      () => addCatalogEntry("one", f.first, { home: f.home }),
      (err: unknown) => err instanceof CliError && err.code === "NOT_IMPLEMENTED",
    );
    assert.equal(await readFile(catalogPath(f.home), "utf8"), future);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("list derives availability while resolve revalidates by label and stable id", async () => {
  const f = await fixture();
  try {
    const added = await addCatalogEntry("one", f.first, { home: f.home, createId: () => id("1") });
    assert.equal((await resolveCatalogEntry("one", f.home)).locator.path, f.first);
    assert.equal((await resolveCatalogEntry(added.entry.id, f.home)).label, "one");

    await rm(f.first, { recursive: true, force: true });
    assert.equal((await listCatalogEntries(f.home))[0]?.available, false);
    await assert.rejects(
      () => resolveCatalogEntry("one", f.home),
      (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("concurrent in-process additions serialize without a lost update", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      addCatalogEntry("one", f.first, { home: f.home, createId: () => id("1") }),
      addCatalogEntry("two", f.second, { home: f.home, createId: () => id("2") }),
    ]);
    assert.deepEqual((await loadCatalog(f.home)).entries.map((entry) => entry.label), ["one", "two"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog mutation cannot acquire the initialization lease under catalog.lock", async () => {
  const f = await fixture();
  const stateRoot = await ensureUserStateRoot(f.home);
  assert.equal(stateRoot, canonicalUserStateDir(f.home));
  const initializationLock = filesystemMutationLockPath(stateRoot, stateRoot);
  let planted = false;
  try {
    const added = await addCatalogEntry("one", f.first, {
      home: f.home,
      createId: () => {
        assert.equal(statSync(catalogLockPath(f.home)).isFile(), true, "catalog.lock must already be held");
        mkdirSync(path.dirname(initializationLock), { recursive: true, mode: 0o700 });
        mkdirSync(initializationLock, { mode: 0o700 });
        planted = true;
        writeFileSync(
          path.join(initializationLock, "owner.json"),
          `${JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            created_at_ms: Date.now(),
            token: "catalog-order-sentinel",
            target: stateRoot,
          })}\n`,
          { mode: 0o600 },
        );
        return id("1");
      },
    });
    assert.equal(added.changed, true);
    assert.equal((await loadCatalog(f.home)).entries[0]?.label, "one");
  } finally {
    if (planted) await rm(initializationLock, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog mutation refuses a root replaced after catalog.lock acquisition", async () => {
  const f = await fixture();
  const stateRoot = await ensureUserStateRoot(f.home);
  const displacedRoot = `${stateRoot}.displaced`;
  const sentinelPath = path.join(stateRoot, "foreign-sentinel");
  const sentinel = Buffer.from([0x00, 0xff, 0x53, 0x42, 0x7f]);
  try {
    await assert.rejects(
      () => addCatalogEntry("one", f.first, {
        home: f.home,
        createId: () => {
          assert.equal(statSync(catalogLockPath(f.home)).isFile(), true, "catalog.lock must already be held");
          renameSync(stateRoot, displacedRoot);
          mkdirSync(stateRoot, { mode: 0o700 });
          writeFileSync(sentinelPath, sentinel, { mode: 0o600 });
          return id("1");
        },
      }),
      /not owned by this product/,
    );
    assert.deepEqual(await readFile(sentinelPath), sentinel);
    assert.deepEqual(await readdir(stateRoot), ["foreign-sentinel"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("active and stale locks fail deterministically without unsafe lock stealing", async () => {
  const f = await fixture();
  try {
    const lock = catalogLockPath(f.home);
    await ensureUserStateRoot(f.home);
    await writeFile(lock, JSON.stringify({ pid: 4242, created_at_ms: 1_000, token: "owner" }) + "\n");
    await chmod(lock, 0o600);

    let now = 1_000;
    await assert.rejects(
      () =>
        addCatalogEntry("one", f.first, {
          home: f.home,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          processExists: () => true,
          lockWaitMs: 50,
          lockPollMs: 25,
        }),
      (err: unknown) => err instanceof CliError && err.code === "TRANSIENT" && err.details?.retryable === true,
    );

    await writeFile(lock, JSON.stringify({ pid: 4242, created_at_ms: 1_000, token: "owner" }) + "\n");
    await assert.rejects(
      () =>
        addCatalogEntry("one", f.first, {
          home: f.home,
          now: () => 31_001,
          processExists: () => false,
        }),
      (err: unknown) => err instanceof CliError && err.code === "TRANSIENT" && err.details?.stale === true,
    );
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, "owner");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an old empty lock from a crash is diagnosed as malformed and never silently stolen", async () => {
  const f = await fixture();
  try {
    const lock = catalogLockPath(f.home);
    await ensureUserStateRoot(f.home);
    await writeFile(lock, "");
    await utimes(lock, new Date(1_000), new Date(1_000));

    await assert.rejects(
      () => addCatalogEntry("one", f.first, { home: f.home, now: () => 31_001 }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "TRANSIENT" &&
        err.details?.stale === true &&
        err.details?.malformed === true &&
        err.help?.includes("inspect and remove") === true,
    );
    assert.equal(await readFile(lock, "utf8"), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failed decision releases its lock for the next writer", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => addCatalogEntry("one", path.join(f.root, "missing"), { home: f.home }),
      (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND",
    );
    await addCatalogEntry("one", f.first, { home: f.home, createId: () => id("1") });
    await assert.rejects(() => stat(catalogLockPath(f.home)), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
