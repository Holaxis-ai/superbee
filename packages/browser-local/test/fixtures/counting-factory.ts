/**
 * An IndexedDB factory wrapper that counts the transactions opened through it, so a page can
 * report how many store transactions an operation cost beside its wall time. Only the database
 * handle is wrapped, for its `transaction` method; every transaction, store and request is the
 * page's real IndexedDB object, so the adapter runs over real storage with one extra property
 * lookup per transaction.
 */

import type { IdbFactoryLike, IdbOpenRequestLike } from "@superbee/core/indexeddb-backend";

export interface TransactionCounts {
  /** Transactions opened since the counter was created, whatever their mode. */
  transactions: number;
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

function wrapDatabase(db: IDBDatabase, counts: TransactionCounts): IDBDatabase {
  return passthrough(db, {
    transaction: (stores: string | string[], mode?: IDBTransactionMode) => {
      counts.transactions += 1;
      return db.transaction(stores, mode);
    },
  });
}

export function countingIndexedDb(factory: IDBFactory, counts: TransactionCounts): IdbFactoryLike {
  return {
    open(name: string, version?: number): IdbOpenRequestLike {
      const request = factory.open(name, version);
      return new Proxy(request, {
        get(inner, prop) {
          if (prop === "result") return inner.result ? wrapDatabase(inner.result, counts) : inner.result;
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
