/**
 * Internal adapter contract kit. Base persistence guarantees are mandatory; stronger
 * guarantees are registered explicitly so a new backend cannot pass through hidden
 * capability skips. Engine validation, wire mechanics, and adapter internals stay in
 * their dedicated suites.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type {
  HeadResult,
  OkfDocument,
  QueryFilter,
  StorageBackend,
  Version,
} from "../src/types.js";
import { blobVersion, contentVersion, VersionConflict } from "../src/versioning.js";
import { FilesystemIdentityAliasError, InvalidInputError } from "../src/errors.js";
import type { HostClass } from "./host-class.js";

export interface BackendFixture {
  backend: StorageBackend;
  cleanup(): Promise<void>;
}

export interface BackendContractOptions {
  name: string;
  create(): Promise<BackendFixture> | BackendFixture;
}

export interface IdentityBackendContractOptions {
  name: string;
  /** The fixture reports the host class its storage actually sits on ("exact" for non-filesystem adapters). */
  create(): Promise<BackendFixture & { hostClass: HostClass }> | (BackendFixture & { hostClass: HostClass });
}

export interface AtomicBackendContractOptions {
  name: string;
  createPeers(): Promise<BackendFixture & { peers: StorageBackend[] }> | BackendFixture & {
    peers: StorageBackend[];
  };
}

const TIMESTAMP = "2026-07-01T00:00:00.000Z";
const enc = (value: string) => new TextEncoder().encode(value);

async function withFixture(
  create: BackendContractOptions["create"],
  run: (backend: StorageBackend) => Promise<void>,
): Promise<void> {
  const fixture = await create();
  try {
    await run(fixture.backend);
  } finally {
    await fixture.cleanup();
  }
}

function doc(id: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "ContractFixture", timestamp: TIMESTAMP }, body };
}

function assertConflict(
  error: unknown,
  expected: Version | null,
  actual: Version | null,
): boolean {
  assert.ok(error instanceof VersionConflict);
  assert.equal(error.expected, expected);
  assert.equal(error.actual, actual);
  return true;
}

export function registerStorageBackendBaseContract(options: BackendContractOptions): void {
  const { name, create } = options;

  test(`${name} contract: document reads expose stable content versions`, async () => {
    await withFixture(create, async (backend) => {
      const value = doc("concepts/versioned", "one");
      const written = await backend.write(value.id, value);
      const first = await backend.read(value.id);
      const second = await backend.read(value.id);

      assert.match(written, /^sha256:[0-9a-f]{64}$/);
      assert.equal(written, contentVersion(value));
      assert.equal(first.version, written);
      assert.deepEqual(first, second);
      assert.equal(first.doc.id, value.id);
      assert.deepEqual(first.doc.frontmatter, value.frontmatter);
      assert.equal(first.doc.body.trimEnd(), value.body);
    });
  });

  test(`${name} contract: concept ids are canonical, exact, and invertible`, async () => {
    await withFixture(create, async (backend) => {
      for (const alias of ["./a/b", "a//b", "a\\b", "a/./b", "a/b/", "a.md/b"]) {
        await assert.rejects(
          () => backend.write(alias, doc(alias, alias)),
          (error: unknown) => error instanceof InvalidInputError,
        );
      }

      const plain = "concepts/x";
      const markdownSuffixed = "concepts/x.md";
      const plainVersion = await backend.write(plain, doc(plain, "physical x.md"), { expectedVersion: null });
      const suffixedVersion = await backend.write(
        markdownSuffixed,
        doc(markdownSuffixed, "physical x.md.md"),
        { expectedVersion: null },
      );

      assert.notEqual(plainVersion, suffixedVersion);
      assert.deepEqual(await backend.list("concepts/"), [plain, markdownSuffixed]);
      assert.equal((await backend.read(plain)).doc.body.trimEnd(), "physical x.md");
      assert.equal((await backend.read(markdownSuffixed)).doc.body.trimEnd(), "physical x.md.md");
      await assert.rejects(
        () => backend.write(markdownSuffixed, doc(markdownSuffixed, "duplicate"), { expectedVersion: null }),
        (error) => assertConflict(error, null, suffixedVersion),
      );
      assert.equal((await backend.read(plain)).version, plainVersion);
      assert.equal((await backend.read(markdownSuffixed)).version, suffixedVersion);
    });
  });

  test(`${name} contract: the write key owns the returned document identity`, async () => {
    await withFixture(create, async (backend) => {
      const id = "concepts/route-id";
      await backend.write(id, doc("concepts/mismatched-body-id", "body"));
      assert.equal((await backend.read(id)).doc.id, id);
    });
  });

  test(`${name} contract: document CAS and expect-absent are fail-closed`, async () => {
    await withFixture(create, async (backend) => {
      const id = "concepts/cas";
      const first = await backend.write(id, doc(id, "one"), { expectedVersion: null });
      await assert.rejects(
        () => backend.write(id, doc(id, "duplicate-create"), { expectedVersion: null }),
        (error) => assertConflict(error, null, first),
      );
      assert.equal((await backend.read(id)).version, first);

      const second = await backend.write(id, doc(id, "two"));
      assert.notEqual(second, first);
      await assert.rejects(
        () => backend.write(id, doc(id, "stale"), { expectedVersion: first }),
        (error) => assertConflict(error, first, second),
      );
      assert.equal((await backend.read(id)).version, second);

      const third = await backend.write(id, doc(id, "three"), { expectedVersion: second });
      assert.notEqual(third, second);
      assert.equal((await backend.read(id)).version, third);
      await assert.rejects(
        () => backend.write("concepts/missing", doc("concepts/missing", "x"), { expectedVersion: first }),
        (error) => assertConflict(error, first, null),
      );
    });
  });

  test(`${name} contract: readMany preserves order and reports a missing member`, async () => {
    await withFixture(create, async (backend) => {
      const versions = new Map<string, Version>();
      for (const id of ["z/last", "a/first", "m/mid"]) {
        versions.set(id, await backend.write(id, doc(id, id)));
      }

      const ids = ["m/mid", "a/first", "z/last"];
      const results = await backend.readMany(ids);
      assert.deepEqual(results.map((result) => result.doc.id), ids);
      for (const result of results) {
        assert.match(result.version, /^sha256:[0-9a-f]{64}$/);
        assert.equal(result.version, versions.get(result.doc.id));
      }
      assert.deepEqual(await backend.readMany([]), []);
      await assert.rejects(
        () => backend.readMany(["a/first", "does/not-exist"]),
        (error: unknown) =>
          Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT"),
      );
    });
  });

  test(`${name} contract: list, prefix, and exists describe the same sorted namespace`, async () => {
    await withFixture(create, async (backend) => {
      for (const id of ["tasks/z", "notes/a", "tasks/a"]) {
        await backend.write(id, doc(id, id));
      }

      assert.deepEqual(await backend.list(), ["notes/a", "tasks/a", "tasks/z"]);
      assert.deepEqual(await backend.list("tasks/"), ["tasks/a", "tasks/z"]);
      assert.equal(await backend.exists("tasks/a"), true);
      assert.equal(await backend.exists("tasks/missing"), false);
    });
  });

  test(`${name} contract: delete is idempotent, CAS-guarded, and purges history`, async () => {
    await withFixture(create, async (backend) => {
      const id = "concepts/delete";
      const first = await backend.write(id, doc(id, "one"));
      const second = await backend.write(id, doc(id, "two"));

      await assert.rejects(
        () => backend.delete(id, { expectedVersion: first }),
        (error) => assertConflict(error, first, second),
      );
      assert.equal(await backend.exists(id), true);
      assert.equal((await backend.read(id)).version, second);
      assert.equal(await backend.delete(id, { expectedVersion: second }), true);
      await assert.rejects(
        () => backend.read(id),
        (error: unknown) =>
          Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT"),
      );
      assert.equal(await backend.exists(id), false);
      assert.equal((await backend.list()).includes(id), false);
      assert.deepEqual(await backend.versions(id), []);
      assert.equal(await backend.delete(id, { expectedVersion: first }), false);
      assert.equal(await backend.delete(id, { expectedVersion: second }), false);
      assert.equal(await backend.delete("concepts/never-written"), false);
    });
  });

  test(`${name} contract: reserved reads and writes obey the same version discipline`, async () => {
    await withFixture(create, async (backend) => {
      assert.equal(await backend.readReserved("missing", "index.md"), null);
      const first = await backend.writeReserved("nested", "index.md", "# One\n", {
        expectedVersion: null,
      });
      assert.equal((await backend.readReserved("nested", "index.md"))?.version, first);

      await assert.rejects(
        () => backend.writeReserved("nested", "index.md", "# Duplicate\n", { expectedVersion: null }),
        (error) => assertConflict(error, null, first),
      );
      assert.equal((await backend.readReserved("nested", "index.md"))?.version, first);
      await assert.rejects(
        () =>
          backend.writeReserved("nested", "index.md", "# Stale\n", {
            expectedVersion: `sha256:${"0".repeat(64)}`,
          }),
        (error) => assertConflict(error, `sha256:${"0".repeat(64)}`, first),
      );
      assert.equal((await backend.readReserved("nested", "index.md"))?.version, first);
      await assert.rejects(
        () =>
          backend.writeReserved("missing", "index.md", "# Missing\n", {
            expectedVersion: first,
          }),
        (error) => assertConflict(error, first, null),
      );

      const second = await backend.writeReserved("nested", "index.md", "# Two\n", {
        expectedVersion: first,
      });
      assert.notEqual(second, first);
      assert.equal((await backend.readReserved("nested", "index.md"))?.content, "# Two\n");
    });
  });
}

export function registerStorageBackendBlobContract(options: BackendContractOptions): void {
  const { name, create } = options;

  test(`${name} blob contract: bytes, versions, absence, and sorted listing round-trip`, async () => {
    await withFixture(create, async (backend) => {
      assert.equal(await backend.readBlob("artifacts/missing.bin"), null);
      assert.equal(await backend.existsBlob("artifacts/missing.bin"), false);

      const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
      const version = await backend.writeBlob("artifacts/binary.dat", binary);
      const read = await backend.readBlob("artifacts/binary.dat");
      assert.ok(read);
      assert.deepEqual([...read.bytes], [...binary]);
      assert.equal(read.version, version);
      assert.equal(version, blobVersion(binary));
      assert.equal(read.contentType, "application/octet-stream");

      await backend.writeBlob("other/c.bin", enc("c"));
      await backend.writeBlob("artifacts/a.bin", enc("a"));
      await backend.writeBlob("artifacts/sub/b.bin", enc("b"));
      await backend.writeBlob("artifacts/page.html", enc("<p>page</p>"));
      assert.equal(
        (await backend.readBlob("artifacts/page.html"))?.contentType,
        "text/html; charset=utf-8",
      );
      assert.deepEqual(await backend.listBlobs(), [
        "artifacts/a.bin",
        "artifacts/binary.dat",
        "artifacts/page.html",
        "artifacts/sub/b.bin",
        "other/c.bin",
      ]);
      assert.deepEqual(await backend.listBlobs("artifacts/"), [
        "artifacts/a.bin",
        "artifacts/binary.dat",
        "artifacts/page.html",
        "artifacts/sub/b.bin",
      ]);
      assert.deepEqual(await backend.listBlobs("other/"), ["other/c.bin"]);
    });
  });

  test(`${name} blob contract: CAS, expect-absent, and byte-identical no-op`, async () => {
    await withFixture(create, async (backend) => {
      const key = "artifacts/cas.bin";
      const firstBytes = enc("one");
      const first = await backend.writeBlob(key, firstBytes, undefined, { expectedVersion: null });
      await assert.rejects(
        () => backend.writeBlob(key, enc("duplicate-create"), undefined, { expectedVersion: null }),
        (error) => assertConflict(error, null, first),
      );
      assert.equal((await backend.readBlob(key))?.version, first);

      const noOp = await backend.writeBlob(key, firstBytes, undefined, { expectedVersion: first });
      assert.equal(noOp, first);
      const second = await backend.writeBlob(key, enc("two"));
      assert.notEqual(second, first);
      await assert.rejects(
        () => backend.writeBlob(key, enc("stale"), undefined, { expectedVersion: first }),
        (error) => assertConflict(error, first, second),
      );
      assert.equal((await backend.readBlob(key))?.version, second);

      const third = await backend.writeBlob(key, enc("three"), undefined, { expectedVersion: second });
      assert.notEqual(third, second);
      assert.equal((await backend.readBlob(key))?.version, third);
      await assert.rejects(
        () => backend.writeBlob("artifacts/missing.bin", enc("x"), undefined, { expectedVersion: first }),
        (error) => assertConflict(error, first, null),
      );
    });
  });

  test(`${name} blob contract: delete is idempotent and CAS-guarded`, async () => {
    await withFixture(create, async (backend) => {
      const key = "artifacts/delete.bin";
      const first = await backend.writeBlob(key, enc("one"));
      const second = await backend.writeBlob(key, enc("two"));

      await assert.rejects(
        () => backend.deleteBlob(key, { expectedVersion: first }),
        (error) => assertConflict(error, first, second),
      );
      assert.equal(await backend.existsBlob(key), true);
      assert.equal((await backend.readBlob(key))?.version, second);
      assert.equal(await backend.deleteBlob(key, { expectedVersion: second }), true);
      assert.equal(await backend.readBlob(key), null);
      assert.equal(await backend.existsBlob(key), false);
      assert.deepEqual(await backend.listBlobs("artifacts/"), []);
      assert.equal(await backend.deleteBlob(key, { expectedVersion: first }), false);
      assert.equal(await backend.deleteBlob("artifacts/never-written.bin"), false);
    });
  });


  // A key nested under an existing FILE entry names a shape no backend can hold. Every observation
  // reports absence (never a raw ENOTDIR): the filesystem adapter classifies the shape mismatch as
  // absence, exactly like the adapters that have no notion of a path segment being a file.
  // Contract record: before the identity protocol the filesystem adapter raised a raw ENOTDIR from
  // read/readBlob/readReserved/versions here. Mutations under a file segment are NOT in this parity
  // row: the filesystem adapter raises its typed shape-mismatch error (where it used to raise raw
  // ENOTDIR), while the in-memory and remote adapters report the key as absent.
  test(`${name} blob contract: a key nested under an existing file entry is absent for every observation`, async () => {
    await withFixture(create, async (backend) => {
      await backend.writeBlob("artifacts/parent.bin", enc("a file, not a directory"));
      const nestedId = "artifacts/parent.bin/nested";
      const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
      await assert.rejects(() => backend.read(nestedId), isEnoent);
      await assert.rejects(() => backend.readMany([nestedId]), isEnoent);
      assert.equal(await backend.exists(nestedId), false);
      assert.deepEqual(await backend.versions(nestedId), []);
      assert.equal(await backend.readReserved("artifacts/parent.bin", "index.md"), null);
      assert.equal(await backend.readBlob("artifacts/parent.bin/nested.bin"), null);
      assert.equal(await backend.existsBlob("artifacts/parent.bin/nested.bin"), false);
      assert.deepEqual(await backend.list("artifacts/"), []);
      assert.deepEqual(await backend.listBlobs("artifacts/"), ["artifacts/parent.bin"]);
      assert.equal(new TextDecoder().decode((await backend.readBlob("artifacts/parent.bin"))?.bytes), "a file, not a directory");
    });
  });
}

export function registerStorageBackendHistoryContract(
  options: BackendContractOptions & {
    retention: "current-only" | "retained";
    retainsClientAgent?: boolean;
  },
): void {
  const { name, create, retention, retainsClientAgent = false } = options;

  test(`${name} history contract: reports ${retention} revisions newest-first`, async () => {
    await withFixture(create, async (backend) => {
      const id = "concepts/history";
      const first = await backend.write(id, doc(id, "one"), { actor: "alpha", agent: "agent-a" });
      const second = await backend.write(id, doc(id, "two"), { actor: "beta", agent: "agent-b" });
      const versions = await backend.versions(id);

      if (retention === "current-only") {
        assert.deepEqual(versions.map((entry) => entry.version), [second]);
      } else {
        assert.deepEqual(versions.map((entry) => entry.version), [second, first]);
        assert.deepEqual(versions.map((entry) => entry.actor), ["beta", "alpha"]);
        if (retainsClientAgent) {
          assert.deepEqual(versions.map((entry) => entry.agent), ["agent-b", "agent-a"]);
        }
      }
    });
  });
}

export function registerStorageBackendAtomicCasContract(
  options: AtomicBackendContractOptions,
): void {
  const { name, createPeers } = options;

  test(`${name} atomic CAS contract: concurrent writers produce one winner`, async () => {
    const fixture = await createPeers();
    try {
      assert.ok(fixture.peers.length > 0);
      const id = "concepts/race";
      const initial = await fixture.backend.write(id, doc(id, "initial"));
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          fixture.peers[index % fixture.peers.length]!.write(id, doc(id, `writer-${index}`), {
            expectedVersion: initial,
          }),
        ),
      );
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Version> => result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, results.length - 1);
      for (const result of rejected) {
        assert.ok(result.reason instanceof VersionConflict);
        assert.equal(result.reason.expected, initial);
      }
      assert.equal((await fixture.backend.read(id)).version, fulfilled[0]!.value);
    } finally {
      await fixture.cleanup();
    }
  });
}

export function registerStorageBackendQueryHeadsContract(options: BackendContractOptions): void {
  const { name, create } = options;

  test(`${name} queryHeads contract: an implemented projection does not under-return body-free heads`, async () => {
    await withFixture(create, async (backend) => {
      assert.ok(backend.queryHeads, `${name} must implement queryHeads to register this contract`);
      const fixtures = [
        {
          ...doc("tasks/a", "body-a"),
          frontmatter: { type: "Task", timestamp: TIMESTAMP, status: "done", tags: ["work"] },
        },
        {
          ...doc("tasks/b", "body-b"),
          frontmatter: { type: "Task", timestamp: TIMESTAMP, status: "todo", tags: ["work", "urgent"] },
        },
        doc("notes/c", "body-c"),
      ];
      const versions = new Map<string, Version>();
      for (const value of fixtures) {
        versions.set(value.id, await backend.write(value.id, value));
      }

      const cases: Array<[QueryFilter, string[]]> = [
        [{}, ["notes/c", "tasks/a", "tasks/b"]],
        [{ type: "Task" }, ["tasks/a", "tasks/b"]],
        [{ prefix: "tasks/" }, ["tasks/a", "tasks/b"]],
        [{ tags: ["urgent"] }, ["tasks/b"]],
      ];
      for (const [filter, ids] of cases) {
        const heads = await backend.queryHeads!(filter);
        const returnedIds = heads.map((head: HeadResult) => head.id);
        for (const id of ids) {
          assert.equal(returnedIds.includes(id), true, `queryHeads under-returned ${id}`);
        }
        for (const head of heads) {
          const version = versions.get(head.id);
          assert.ok(version, `queryHeads returned an unknown id: ${head.id}`);
          assert.equal(head.version, version);
          assert.equal("body" in head, false);
        }
      }
    });
  });
}

/**
 * Identity rows (I7): one conditional row per operation for a spelling that aliases an existing
 * entry on the fixture's host class. On an aliasing host every operation with the alias is
 * refused with the typed alias verdict and the canonical entry is untouched; on an exact host
 * the alias is simply a distinct absent identity. A normalizing host (legacy HFS+) is out of
 * scope: it treats case pairs like an aliasing host, and its NFC/NFD behavior is pinned by the
 * native suite's AC-17 row instead. `dev`/`ino` are assumed stable per observation on local
 * APFS/ext4; network filesystems are unsupported. First creation of a document is published with a
 * hard link so the host's own equivalence refuses a second spelling the identity fold did not
 * equate; on a local filesystem without hard links (exFAT, FAT32, some FUSE mounts) first creation
 * falls back to rename, and two CONCURRENT first-creation writers of such a host-equated pair are
 * not excluded there (sequential access is still refused). That residual is confined to those hosts.
 */
export function registerStorageBackendIdentityContract(options: IdentityBackendContractOptions): void {
  const { name, create } = options;
  const isAlias = (error: unknown): boolean =>
    error instanceof FilesystemIdentityAliasError && error instanceof InvalidInputError;
  const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

  async function withIdentityFixture(
    run: (backend: StorageBackend, hostClass: HostClass) => Promise<void>,
  ): Promise<void> {
    const fixture = await create();
    try {
      await run(fixture.backend, fixture.hostClass);
    } finally {
      await fixture.cleanup();
    }
  }

  const documentPairs: Array<[string, string, string]> = [
    ["case", "concepts/exact-name", "concepts/EXACT-NAME"],
    ["normalization", "concepts/caf\u00e9", "concepts/cafe\u0301"],
  ];

  for (const [label, id, alias] of documentPairs) {
    test(`${name} contract: document ${label} alias is refused on an aliasing host and distinct otherwise`, async () => {
      await withIdentityFixture(async (backend, hostClass) => {
        if (label === "normalization" && hostClass === "normalizing") return; // pinned by AC-17 instead
        const aliasing = hostClass !== "exact";
        const version = await backend.write(id, doc(id, "canonical"));
        assert.deepEqual(await backend.list("concepts/"), [id]);

        if (aliasing) {
          await assert.rejects(() => backend.read(alias), isAlias);
          await assert.rejects(() => backend.readMany([id, alias]), isAlias);
          await assert.rejects(() => backend.exists(alias), isAlias);
          await assert.rejects(() => backend.versions(alias), isAlias);
          await assert.rejects(() => backend.write(alias, doc(alias, "alias")), isAlias);
          await assert.rejects(() => backend.write(alias, doc(alias, "alias"), { expectedVersion: null }), isAlias);
          await assert.rejects(() => backend.delete(alias), isAlias);
          await assert.rejects(() => backend.delete(alias, { expectedVersion: version }), isAlias);
          assert.deepEqual(await backend.list("concepts/"), [id]);
        } else {
          await assert.rejects(() => backend.read(alias), isEnoent);
          await assert.rejects(() => backend.readMany([id, alias]), isEnoent);
          assert.equal(await backend.exists(alias), false);
          assert.deepEqual(await backend.versions(alias), []);
          assert.equal(await backend.delete(alias), false);
          const aliasVersion = await backend.write(alias, doc(alias, "alias"), { expectedVersion: null });
          assert.notEqual(aliasVersion, version);
          assert.equal((await backend.read(alias)).doc.body.trimEnd(), "alias");
          assert.deepEqual((await backend.list("concepts/")).sort(), [id, alias].sort());
          assert.equal(await backend.delete(alias, { expectedVersion: aliasVersion }), true);
        }
        const canonical = await backend.read(id);
        assert.equal(canonical.version, version);
        assert.equal(canonical.doc.body.trimEnd(), "canonical");
        assert.equal(await backend.exists(id), true);
      });
    });
  }

  test(`${name} contract: reserved-file directory alias is refused on an aliasing host and distinct otherwise`, async () => {
    await withIdentityFixture(async (backend, hostClass) => {
      const aliasing = hostClass !== "exact";
      const version = await backend.writeReserved("Docs", "index.md", "# Docs\n");
      if (aliasing) {
        await assert.rejects(() => backend.readReserved("docs", "index.md"), isAlias);
        await assert.rejects(() => backend.writeReserved("docs", "index.md", "# docs\n"), isAlias);
        await assert.rejects(() => backend.writeReserved("docs", "index.md", "# docs\n", { expectedVersion: null }), isAlias);
      } else {
        assert.equal(await backend.readReserved("docs", "index.md"), null);
        const other = await backend.writeReserved("docs", "index.md", "# docs\n", { expectedVersion: null });
        assert.notEqual(other, version);
        assert.equal((await backend.readReserved("docs", "index.md"))?.content, "# docs\n");
      }
      const canonical = await backend.readReserved("Docs", "index.md");
      assert.equal(canonical?.content, "# Docs\n");
      assert.equal(canonical?.version, version);
    });
  });

  test(`${name} contract: blob key alias is refused on an aliasing host and distinct otherwise`, async () => {
    await withIdentityFixture(async (backend, hostClass) => {
      const aliasing = hostClass !== "exact";
      const key = "artifacts/Exact.bin";
      const alias = "artifacts/exact.bin";
      const version = await backend.writeBlob(key, enc("canonical"));
      if (aliasing) {
        await assert.rejects(() => backend.readBlob(alias), isAlias);
        await assert.rejects(() => backend.existsBlob(alias), isAlias);
        await assert.rejects(() => backend.writeBlob(alias, enc("alias")), isAlias);
        await assert.rejects(() => backend.writeBlob(alias, enc("alias"), undefined, { expectedVersion: null }), isAlias);
        await assert.rejects(() => backend.deleteBlob(alias), isAlias);
        assert.deepEqual(await backend.listBlobs("artifacts/"), [key]);
      } else {
        assert.equal(await backend.readBlob(alias), null);
        assert.equal(await backend.existsBlob(alias), false);
        assert.equal(await backend.deleteBlob(alias), false);
        const other = await backend.writeBlob(alias, enc("alias"), undefined, { expectedVersion: null });
        assert.notEqual(other, version);
        assert.deepEqual((await backend.listBlobs("artifacts/")).sort(), [key, alias].sort());
        assert.equal(await backend.deleteBlob(alias, { expectedVersion: other }), true);
      }
      const canonical = await backend.readBlob(key);
      assert.equal(canonical?.version, version);
      assert.equal(new TextDecoder().decode(canonical?.bytes), "canonical");
      assert.equal(await backend.existsBlob(key), true);
    });
  });
}
