import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { IDBFactory } from "fake-indexeddb";

import { FilesystemBackend } from "../src/backend.js";
import { IndexedDbBackend } from "../src/indexeddb-backend.js";
import { IntentHoldConflict, IntentStateConflict } from "../src/journaled-backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import type { StorageBackend } from "../src/types.js";
import { contentVersion, VersionConflict } from "../src/versioning.js";
import { registerJournaledBackendContract } from "./journaled-backend-contract.js";
import {
  registerClaimPreconditionContract,
  registerFrontmatterReadContract,
  assertStorageInputRefusals,
  registerOkfAuthoringContract,
  registerStorageBackendAtomicCasContract,
  registerStorageBackendBaseContract,
  registerStorageBackendBlobContract,
  registerStorageBackendHistoryContract,
  registerStorageBackendIdentityContract,
  registerStorageBackendQueryHeadsContract,
  type AtomicBackendContractOptions,
  type BackendFixture,
} from "./storage-backend-contract.js";
import { assertHostClassExpectation, detectHostAliasingIn } from "./host-class.js";

// None of these adapters stores by filename, so no spelling pair aliases at either kind.
const EXACT_HOST = { hostClass: "exact", case: false, normalization: false } as const;

async function filesystemFixture(): Promise<BackendFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "aslite-storage-contract-"));
  return {
    backend: new FilesystemBackend(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function memoryFixture(): BackendFixture {
  return {
    backend: new MemoryBackend(),
    cleanup: async () => undefined,
  };
}

// A fresh in-memory IndexedDB factory per fixture: no global shim, no state shared across rows.
function indexedDbFixture(): BackendFixture {
  const backend = new IndexedDbBackend({ databaseName: "storage-contract", indexedDB: new IDBFactory() });
  return { backend, cleanup: async () => backend.close() };
}

function remoteFixture(): BackendFixture {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://storage-contract", backend: serverBackend });
  return {
    backend: new RemoteBackend({
      baseUrl: "http://wire.local",
      bundle: "contract",
      fetchImpl: router,
      maxRetries: 0,
    }),
    cleanup: async () => undefined,
  };
}

const CONTRACTS = [
  { name: "FilesystemBackend", create: filesystemFixture, retention: "current-only" as const, localYamlValues: true },
  {
    name: "MemoryBackend",
    create: memoryFixture,
    retention: "retained" as const,
    retainsClientAgent: true,
    localYamlValues: true,
  },
  // The authenticated hosted worker, not RemoteBackend clients, manufactures X-Agent.
  { name: "RemoteBackend", create: remoteFixture, retention: "retained" as const, localYamlValues: false },
  { name: "IndexedDbBackend", create: indexedDbFixture, retention: "current-only" as const, localYamlValues: true },
];

test("MemoryBackend frontmatter read contract: metadata decoding does not reinterpret delimiter-leading bodies", async () => {
  const backend = new MemoryBackend();
  for (const [index, body] of ["---\nvalue: body text\n---\nbody", "\uFEFF---\nvalue: body text\n---\nbody"].entries()) {
    const value = { id: `metadata/body-${index}`, frontmatter: {}, body };
    const version = await backend.write(value.id, value);
    assert.equal(version, contentVersion(value));
    for (const read of [await backend.read(value.id), ...(await backend.readMany([value.id]))]) {
      assert.equal(read.version, version);
      assert.deepEqual(read.doc.frontmatter, {});
      assert.equal(read.doc.body, body);
    }
  }
});

test("MemoryBackend frontmatter read contract: returned metadata and version describe the same getter snapshot", async () => {
  const backend = new MemoryBackend();
  let observed = 0;
  const value = {
    id: "metadata/getter",
    frontmatter: { type: "Note", get value() { return ++observed; } },
    body: "body\n",
  };
  const version = await backend.write(value.id, value);
  const read = await backend.read(value.id);
  assert.equal(typeof read.doc.frontmatter.value, "number");
  assert.equal(version, contentVersion({
    ...value, frontmatter: { type: "Note", value: read.doc.frontmatter.value },
  }));
  assert.equal(read.version, version);
  assert.deepEqual(await backend.read(value.id), read);
});

test("RemoteBackend contract: invalid input rows do not issue requests", async () => {
  let requests = 0;
  const backend = new RemoteBackend({
    baseUrl: "http://wire.local", bundle: "contract", maxRetries: 0,
    fetchImpl: async () => { requests++; throw new Error("Unexpected request"); },
  });
  await assertStorageInputRefusals(backend);
  assert.equal(requests, 0);
});

test("IndexedDbBackend contract: invalid input rows do not open storage", async () => {
  const factory = new IDBFactory();
  let opens = 0;
  factory.open = () => { opens++; throw new Error("Unexpected database open"); };
  const backend = new IndexedDbBackend({ databaseName: "unopened", indexedDB: factory });
  await assertStorageInputRefusals(backend);
  assert.equal(opens, 0);
  backend.close();
});

for (const contract of CONTRACTS) {
  registerStorageBackendBaseContract(contract);
  registerFrontmatterReadContract(contract);
  registerOkfAuthoringContract(contract);
  registerStorageBackendBlobContract(contract);
  registerStorageBackendHistoryContract(contract);
}

// One set of peer fixtures serves every contract whose subject is concurrency, so the seam's
// one-winner row and the engine's claim row are always scored against the same topology.
const PEER_CONTRACTS: AtomicBackendContractOptions[] = [
  {
    name: "FilesystemBackend",
    async createPeers() {
      const root = await mkdtemp(path.join(tmpdir(), "aslite-storage-cas-contract-"));
      const peers = [new FilesystemBackend(root), new FilesystemBackend(root)];
      return {
        backend: peers[0]!,
        peers,
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "MemoryBackend",
    createPeers() {
      const backend = new MemoryBackend();
      return { backend, peers: [backend], cleanup: async () => undefined };
    },
  },
  {
    name: "RemoteBackend",
    createPeers() {
      const serverBackend = new ServerMemoryBackend();
      const router = createRouter({ root: "mem://storage-cas-contract", backend: serverBackend });
      const peers: StorageBackend[] = [
        new RemoteBackend({
          baseUrl: "http://wire.local",
          bundle: "contract",
          fetchImpl: router,
          maxRetries: 0,
        }),
        new RemoteBackend({
          baseUrl: "http://wire.local",
          bundle: "contract",
          fetchImpl: router,
          maxRetries: 0,
        }),
      ];
      return { backend: peers[0]!, peers, cleanup: async () => undefined };
    },
  },
  {
    // Two adapter instances over one database name and one factory: the concurrent-tabs topology.
    name: "IndexedDbBackend",
    createPeers() {
      const factory = new IDBFactory();
      const peers = [
        new IndexedDbBackend({ databaseName: "storage-cas-contract", indexedDB: factory }),
        new IndexedDbBackend({ databaseName: "storage-cas-contract", indexedDB: factory }),
      ];
      return {
        backend: peers[0]!,
        peers,
        cleanup: async () => {
          for (const peer of peers) peer.close();
        },
      };
    },
  },
];

for (const contract of PEER_CONTRACTS) {
  registerStorageBackendAtomicCasContract(contract);
  registerClaimPreconditionContract(contract);
}

registerStorageBackendQueryHeadsContract({
  name: "RemoteBackend",
  create: remoteFixture,
});

registerStorageBackendIdentityContract({
  name: "FilesystemBackend",
  async create() {
    const probeRoot = await mkdtemp(path.join(tmpdir(), "aslite-storage-identity-probe-"));
    const host = await detectHostAliasingIn(probeRoot);
    await rm(probeRoot, { recursive: true, force: true });
    assertHostClassExpectation(host.hostClass);
    const root = await mkdtemp(path.join(tmpdir(), "aslite-storage-identity-contract-"));
    return {
      backend: new FilesystemBackend(root),
      host,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  },
});

registerStorageBackendIdentityContract({
  name: "MemoryBackend",
  create: () => ({ ...memoryFixture(), host: EXACT_HOST }),
});

registerStorageBackendIdentityContract({
  name: "RemoteBackend",
  create: () => ({ ...remoteFixture(), host: EXACT_HOST }),
});

registerStorageBackendIdentityContract({
  name: "IndexedDbBackend",
  create: () => ({ ...indexedDbFixture(), host: EXACT_HOST }),
});

// The journal rows: the seam the browser-local sync runtime programs against. The IndexedDB
// adapter is the shipping implementation; `@superbee/browser-local` runs the same rows over its
// in-memory test adapter to prove the seam is not a description of this one class.
registerJournaledBackendContract({
  name: "IndexedDbBackend",
  create: () => {
    const backend = new IndexedDbBackend({ databaseName: "journal-contract", indexedDB: new IDBFactory() });
    return { backend, cleanup: async () => backend.close() };
  },
  seam: { IntentStateConflict, IntentHoldConflict, VersionConflict },
});
