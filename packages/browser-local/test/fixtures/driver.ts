/**
 * Page-side driver for the Chromium proof. Bundled by esbuild inside the spec and served to the
 * page; every call goes through the same core seam a product page would use (the IndexedDB
 * backend behind bundle-ops and mutateDocument), and returns plain JSON so the Node side of the
 * spec can compare tokens and bodies without any page-to-node object marshalling.
 */

import { queryHeads, readBlob, readDocVersioned, writeBlob, writeDocVersioned } from "@superbee/core/bundle-ops";
import { mutateDocument } from "@superbee/core/document-mutation";
import { IndexedDbSchemaError } from "@superbee/core/indexeddb-backend";
import type { KindRegistry } from "@superbee/core/kinds";
import { contentVersion, VersionConflict, versionOfBytes } from "@superbee/core/versioning";

import { openLocalBundle, type LocalBundle } from "../../src/local-bundle.ts";

const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Browser-local proof\n";
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

export interface DriverError {
  error: { name: string; message: string; expected?: string | null; actual?: string | null };
}

export interface WriteReply {
  version: string;
  doc: { id: string; frontmatter: Record<string, unknown>; body: string };
}

export interface MutateReply {
  version: string;
  changed: boolean;
}

function describeError(error: unknown): DriverError {
  if (error instanceof VersionConflict) {
    return { error: { name: error.name, message: error.message, expected: error.expected, actual: error.actual } };
  }
  if (error instanceof IndexedDbSchemaError) return { error: { name: error.name, message: error.message } };
  const err = error as { name?: unknown; message?: unknown };
  return {
    error: {
      name: typeof err?.name === "string" ? err.name : "Error",
      message: typeof err?.message === "string" ? err.message : String(error),
    },
  };
}

async function attempt<T>(work: () => Promise<T>): Promise<T | DriverError> {
  try {
    return await work();
  } catch (error) {
    return describeError(error);
  }
}

let current: LocalBundle | null = null;

function bundleOrThrow(): LocalBundle {
  if (!current) throw new Error("driver: call open(name) first");
  return current;
}

const driver = {
  /** Open the working copy under `name`; seed the root index.md once so the edition is 0.2. */
  open: (name: string) =>
    attempt(async () => {
      current?.close();
      current = openLocalBundle(name);
      const existing = await current.backend.readReserved("", "index.md");
      if (!existing) await current.backend.writeReserved("", "index.md", ROOT_INDEX, { expectedVersion: null });
      return { ok: true as const, seeded: !existing };
    }),

  close: () => {
    current?.close();
    current = null;
    return { ok: true as const };
  },

  write: (id: string, frontmatter: Record<string, unknown>, body: string) =>
    attempt<WriteReply>(async () => {
      const { bundle } = bundleOrThrow();
      const { doc, version } = await writeDocVersioned(bundle, { id, frontmatter, body });
      return { version, doc: { id: doc.id, frontmatter: doc.frontmatter, body: doc.body } };
    }),

  read: (id: string) =>
    attempt<WriteReply>(async () => {
      const { bundle } = bundleOrThrow();
      const { doc, version } = await readDocVersioned(bundle, id);
      return { version, doc: { id: doc.id, frontmatter: doc.frontmatter, body: doc.body } };
    }),

  /** Head rows under a concept-id prefix, sorted by id: the engine's scan over the backend. */
  query: (prefix: string) =>
    attempt(async () => {
      const { bundle } = bundleOrThrow();
      const heads = await queryHeads(bundle, { prefix });
      return heads.map((head) => ({ id: head.id, version: head.version, type: head.frontmatter.type }));
    }),

  /** One hard compare-and-swap edit: patch mode with a caller-supplied expected version. */
  mutate: (id: string, expectedVersion: string, newBody: string) =>
    attempt<MutateReply>(async () => {
      const { bundle } = bundleOrThrow();
      const result = await mutateDocument({
        bundle,
        id,
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        expectedVersion,
        buildCandidate: (existing) => ({ frontmatter: existing!.frontmatter, body: newBody }),
      });
      return { version: result.version, changed: result.changed };
    }),

  writeBlob: (key: string, bytes: number[], contentType?: string) =>
    attempt(async () => {
      const { bundle } = bundleOrThrow();
      const version = await writeBlob(bundle, key, new Uint8Array(bytes), contentType);
      return { version };
    }),

  readBlob: (key: string) =>
    attempt(async () => {
      const { bundle } = bundleOrThrow();
      const found = await readBlob(bundle, key);
      if (!found) return { found: false as const };
      return { found: true as const, version: found.version, contentType: found.contentType, bytes: Array.from(found.bytes) };
    }),

  /** The page's own hashing of a stored document, for parity against the Node primitives. */
  contentVersionOf: (id: string) =>
    attempt(async () => {
      const { bundle } = bundleOrThrow();
      const { doc } = await readDocVersioned(bundle, id);
      return { version: contentVersion(doc) };
    }),

  versionOfBytes: (raw: string) => ({ version: versionOfBytes(raw) }),

  /** Create a foreign IndexedDB database at `version` with one unrelated store, then close it. */
  createForeignDatabase: (name: string, version: number, storeName: string) =>
    new Promise<{ ok: true; version: number; stores: string[] } | DriverError>((resolve) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(storeName);
      };
      request.onerror = () => resolve(describeError(request.error));
      request.onsuccess = () => {
        const db = request.result;
        const stores = Array.from(db.objectStoreNames);
        db.close();
        resolve({ ok: true, version: db.version, stores });
      };
    }),

  storage: async () => {
    const storage = navigator.storage;
    const persisted = storage && typeof storage.persisted === "function" ? await storage.persisted() : null;
    const estimate = storage && typeof storage.estimate === "function" ? await storage.estimate() : null;
    return {
      persisted,
      usage: estimate?.usage ?? null,
      quota: estimate?.quota ?? null,
    };
  },

  requestPersist: async () => {
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== "function") return { supported: false as const, persist: null, persisted: null };
    const persist = await storage.persist();
    const persisted = await storage.persisted();
    return { supported: true as const, persist, persisted };
  },
};

export type Driver = typeof driver;

declare global {
  interface Window {
    superbeeLocal: Driver;
  }
}

window.superbeeLocal = driver;
