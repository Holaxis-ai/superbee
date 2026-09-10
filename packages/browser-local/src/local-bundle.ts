/**
 * The browser-local working copy's entry: one {@link IndexedDbBackend} per bundle name, handed
 * to the engine as `bundle.backend` so every read, query, validation, and compare-and-swap
 * write runs against the page's own IndexedDB. Nothing here talks to a server; sync and UI are
 * separate concerns that build on this seam.
 */

import type { Bundle } from "@superbee/core";
import { IndexedDbBackend, type IdbFactoryLike } from "@superbee/core/indexeddb-backend";

export interface OpenLocalBundleOptions {
  /** The IndexedDB factory to open the working copy with. Defaults to the page's `indexedDB`. */
  indexedDB?: IdbFactoryLike;
}

export interface LocalBundle {
  /** The engine-facing bundle: a synthetic root label plus the IndexedDB backend. */
  bundle: Bundle;
  backend: IndexedDbBackend;
  /** Release the database handle; a later operation reopens it lazily. */
  close(): void;
}

/**
 * Open (or lazily create) the browser-local working copy stored under `name`. The bundle root
 * is a label, not a path: the engine routes every operation through `bundle.backend`.
 */
export function openLocalBundle(name: string, options: OpenLocalBundleOptions = {}): LocalBundle {
  const backend = new IndexedDbBackend({ databaseName: name, indexedDB: options.indexedDB });
  const bundle: Bundle = { root: `indexeddb://${name}`, backend };
  return { bundle, backend, close: () => backend.close() };
}
