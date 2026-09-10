/**
 * An IndexedDB factory wrapper for the Chromium proof that can be armed to fail one store write
 * the way a full origin fails it: the next `put` on any object store throws a
 * `QuotaExceededError` DOMException, which aborts the surrounding transaction. Real Chromium
 * raises the same error name when the origin's quota is exhausted; the arming only decides when.
 * Everything else passes straight through to the page's real `indexedDB`, so the proof still
 * runs the adapter over real storage.
 */

import type { IdbFactoryLike, IdbOpenRequestLike } from "@superbee/core/indexeddb-backend";

export interface Faults {
  /** When true, the next `put` throws `QuotaExceededError` and the flag clears. */
  quotaOnNextPut: boolean;
}

/** Forward every property to `target`, binding methods, except those `overrides` replaces. */
function passthrough<T extends object>(target: T, overrides: Record<PropertyKey, unknown> = {}): T {
  return new Proxy(target, {
    get(inner, prop) {
      if (prop in overrides) return overrides[prop];
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
    },
    set(inner, prop, value) {
      Reflect.set(inner, prop, value, inner);
      return true;
    },
  });
}

function wrapStore(store: IDBObjectStore, faults: Faults): IDBObjectStore {
  return passthrough(store, {
    put: (value: unknown, key?: IDBValidKey) => {
      if (faults.quotaOnNextPut) {
        faults.quotaOnNextPut = false;
        throw new DOMException("The quota has been exceeded (armed by the test).", "QuotaExceededError");
      }
      return store.put(value, key);
    },
  });
}

function wrapTransaction(transaction: IDBTransaction, faults: Faults): IDBTransaction {
  return passthrough(transaction, {
    objectStore: (name: string) => wrapStore(transaction.objectStore(name), faults),
  });
}

function wrapDatabase(db: IDBDatabase, faults: Faults): IDBDatabase {
  return passthrough(db, {
    transaction: (stores: string | string[], mode?: IDBTransactionMode) => wrapTransaction(db.transaction(stores, mode), faults),
  });
}

export function faultyIndexedDb(factory: IDBFactory, faults: Faults): IdbFactoryLike {
  return {
    open(name: string, version?: number): IdbOpenRequestLike {
      const request = factory.open(name, version);
      return new Proxy(request, {
        get(inner, prop) {
          if (prop === "result") return inner.result ? wrapDatabase(inner.result, faults) : inner.result;
          const value = Reflect.get(inner, prop, inner);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
        },
        set(inner, prop, value) {
          Reflect.set(inner, prop, value, inner);
          return true;
        },
      }) as unknown as IdbOpenRequestLike;
    },
  };
}
