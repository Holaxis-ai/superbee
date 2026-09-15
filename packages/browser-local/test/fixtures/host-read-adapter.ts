import type { StorageBackend } from "@superbee/core";
import type { RemoteBackend } from "@superbee/core/remote";

/** The existing optional inventory protocol, without a concrete backend identity. */
type Inventory = Pick<RemoteBackend, "heads" | "snapshot" | "wireCapabilities">;

export function hostReadAdapter(source: StorageBackend, inventory?: Inventory) {
  const mutations: string[] = [];
  const refuse = async (method: string): Promise<never> => {
    mutations.push(method);
    throw new Error(`host read adapter must not mutate: ${method}`);
  };
  const backend: StorageBackend & Partial<Inventory> = {
    read: (id) => source.read(id),
    readMany: (ids) => source.readMany(ids),
    exists: (id) => source.exists(id),
    list: (prefix) => source.list(prefix),
    versions: (id) => source.versions(id),
    readReserved: (dir, name) => source.readReserved(dir, name),
    readBlob: (key) => source.readBlob(key),
    existsBlob: (key) => source.existsBlob(key),
    listBlobs: (prefix) => source.listBlobs(prefix),
    write: () => refuse("write"),
    writeReserved: () => refuse("writeReserved"),
    delete: () => refuse("delete"),
    writeBlob: () => refuse("writeBlob"),
    deleteBlob: () => refuse("deleteBlob"),
    ...(inventory === undefined ? {} : {
      heads: (...args: Parameters<Inventory["heads"]>) => inventory.heads(...args),
      snapshot: (...args: Parameters<Inventory["snapshot"]>) => inventory.snapshot(...args),
      wireCapabilities: () => inventory.wireCapabilities(),
    }),
  };
  return { backend, mutations };
}
