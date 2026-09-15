import type { StorageBackend } from "@superbee/core";
import type { OperationTransport } from "@superbee/core/uncertain-write";
import type { LocalBundle } from "../../src/local-bundle.js";
import { createBrowserLocalRuntime } from "../../src/platform/index.js";
import { hostReadAdapter } from "./host-read-adapter.js";

// Compiled by the contract test: the normal test loader only transpiles TypeScript.
export function construct(local: LocalBundle, source: StorageBackend, transport: OperationTransport) {
  return createBrowserLocalRuntime({ local, remote: hostReadAdapter(source).backend, transport });
}
