import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";
import { createRouter } from "@superbee/server";

import { RemoteBackend } from "../src/remote-backend.js";
import type { StorageBackend } from "../src/types.js";
import type { BackendFixture } from "./storage-backend-contract.js";

// These are end-to-end subjects, not evidence of adapter-only enforcement.
// Per-row ownership is recorded in storage-backend-remote-ownership.md.
export const REMOTE_CONTRACT_SUBJECT = "RemoteBackend + reference router + ServerMemoryBackend";

export function remotePeerFixture(serverBackend: StorageBackend = new ServerMemoryBackend()): BackendFixture & { peers: StorageBackend[] } {
  const router = createRouter({ root: "mem://storage-contract", backend: serverBackend });
  const peers = Array.from({ length: 2 }, () => new RemoteBackend({
    baseUrl: "http://wire.local",
    bundle: "contract",
    fetchImpl: router,
    maxRetries: 0,
  }));
  return { backend: peers[0]!, peers, cleanup: async () => undefined };
}

export function remoteFixture(serverBackend: StorageBackend = new ServerMemoryBackend()): BackendFixture {
  return remotePeerFixture(serverBackend);
}
