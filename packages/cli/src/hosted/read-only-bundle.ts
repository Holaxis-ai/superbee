// A hosted checkout opened by the local MCP app through the catalog: every read is served, every
// write is refused with the same "do this in the app" refusal the CLI gives, before it touches
// the folder. The MCP app writes Views (an entry blob plus a registration) and documents through
// its View bridge; a checkout cannot sync a blob, so a View saved there would be written to the
// folder and held by sync forever. The guard sits on the storage backend, the one path every
// write takes, so no MCP tool can go around it.
import type { Bundle, StorageBackend } from "@superbee/core";

import { configuredBundle } from "../filesystem-runtime.js";
import type { CheckoutBinding } from "./binding.js";
import { hostedMcpWriteRefusal } from "./refusals.js";

const WRITES: Readonly<Record<string, string>> = Object.freeze({
  write: "document write",
  delete: "document delete",
  writeReserved: "index write",
  writeBlob: "blob write",
  deleteBlob: "blob delete",
});

/** The bundle with its backend wrapped so reads pass through and writes are refused. */
export function readOnlyHostedBundle(bundle: Bundle, binding: CheckoutBinding): Bundle {
  const backend: StorageBackend = bundle.backend ?? configuredBundle(bundle.root).backend!;
  const guarded = new Proxy(backend, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(WRITES, property)) {
        return async () => {
          throw hostedMcpWriteRefusal(binding, WRITES[property]!);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      // The backend keeps private fields, so its methods run against the backend itself.
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return Object.freeze({ ...bundle, backend: guarded });
}
