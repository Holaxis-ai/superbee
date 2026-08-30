import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";
import { createRouter } from "@superbee/server";

import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import type { StorageBackend } from "../src/types.js";
import {
  registerClaimPreconditionContract,
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

// Neither adapter stores by filename, so no spelling pair aliases at either kind.
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
  { name: "FilesystemBackend", create: filesystemFixture, retention: "current-only" as const },
  {
    name: "MemoryBackend",
    create: memoryFixture,
    retention: "retained" as const,
    retainsClientAgent: true,
  },
  // The authenticated hosted worker, not RemoteBackend clients, manufactures X-Agent.
  { name: "RemoteBackend", create: remoteFixture, retention: "retained" as const },
];

for (const contract of CONTRACTS) {
  registerStorageBackendBaseContract(contract);
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
