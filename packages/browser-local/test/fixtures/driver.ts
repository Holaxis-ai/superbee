/**
 * Page-side driver for the Chromium proof. Bundled by esbuild inside the spec and served to the
 * page; every call goes through the same core seam a product page would use (the IndexedDB
 * backend behind bundle-ops and mutateDocument), and returns plain JSON so the Node side of the
 * spec can compare tokens and bodies without any page-to-node object marshalling.
 */

import type { OkfDocument, QueryFilter, StorageBackend } from "@superbee/core";
import { queryHeads, readBlob, readDocVersioned, writeBlob, writeDocVersioned } from "@superbee/core/bundle-ops";
import { mutateDocument } from "@superbee/core/document-mutation";
import { IndexedDbSchemaError } from "@superbee/core/indexeddb-backend";
import type { IntentRecord } from "@superbee/core/journaled-backend";
import type { KindRegistry } from "@superbee/core/kinds";
import type { ExecutionMode, PlatformEdit, PlatformRuntime } from "@superbee/core/platform";
import { RemoteBackend } from "@superbee/core/remote";
import { createRemoteOperationTransport } from "@superbee/core/remote-operations";
import type { OperationState, OperationTransport } from "@superbee/core/uncertain-write";
import { contentVersion, VersionConflict, versionOfBytes } from "@superbee/core/versioning";

import {
  baseKey,
  bootstrap,
  commitLocal,
  isComplete,
  openLocalBundle,
  pull,
  pushWithRole,
  reclaimInFlight,
  resume,
  syncStatus,
  UNSETTLED_STATES,
  type LocalBundle,
  type SharedBase,
} from "../../src/local-bundle.ts";
import type { LockManagerLike } from "../../src/push-role.ts";
import { createBrowserLocalRuntime, createRequestDrivenRuntime } from "../../src/platform/index.ts";
import { faultyIndexedDb, type Faults } from "./faulty-factory.ts";
import { mountPresentation, type Presentation } from "./presentation.ts";

const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Browser-local proof\n";
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

export interface DriverError {
  error: { name: string; message: string; expected?: string | null; actual?: string | null; code?: string; status?: number };
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
  const err = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown };
  return {
    error: {
      name: typeof err?.name === "string" ? err.name : "Error",
      message: typeof err?.message === "string" ? err.message : String(error),
      ...(typeof err?.code === "string" ? { code: err.code } : {}),
      ...(typeof err?.status === "number" ? { status: err.status } : {}),
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

// ── sync state ─────────────────────────────────────────────────────────────────────────────

const REMOTE_BUNDLE = "default";
/** Faults the wrapped factory injects; armed per scenario from the Node side. */
const faults: Faults = { quotaOnNextPut: false };
/** When set, the carrier throws before any request leaves the page. */
let offline = false;
let remote: { baseUrl: string; backend: StorageBackend; transport: OperationTransport } | null = null;
const submittedWhileOffline: string[] = [];

const carrier = (request: Request): Promise<Response> => {
  if (offline) {
    submittedWhileOffline.push(`${request.method} ${new URL(request.url).pathname}`);
    return Promise.reject(new TypeError("fetch failed: page is offline"));
  }
  return fetch(request);
};

function remoteOrThrow(): NonNullable<typeof remote> {
  if (!remote) throw new Error("driver: call attach(remoteBaseUrl, name) first");
  return remote;
}

/** Open the working copy under `name` through the fault-injecting factory and bind the authority. */
function attachTo(remoteBaseUrl: string, name: string): void {
  current?.close();
  current = openLocalBundle(name, { indexedDB: faultyIndexedDb(indexedDB, faults) });
  const backend = new RemoteBackend({ baseUrl: remoteBaseUrl, bundle: REMOTE_BUNDLE, fetchImpl: carrier, maxRetries: 0 });
  remote = { baseUrl: remoteBaseUrl, backend, transport: createRemoteOperationTransport(backend) };
}

/** The journal fields a scenario compares; content strings ride along so conflict is fully visible. */
function intentView(row: IntentRecord) {
  return {
    requestId: row.requestId,
    target: row.target,
    state: row.state,
    attempts: row.attempts,
    base: row.base,
    baseContent: row.baseContent,
    local: row.local,
    content: row.content,
    after: row.after ?? null,
    acknowledgedVersion: row.acknowledgedVersion ?? null,
    remote: row.remote ?? null,
    refusal: row.refusal ?? null,
    finding: row.finding ?? null,
  };
}

export type IntentView = ReturnType<typeof intentView>;

const immediate = { lookupDelayMs: 0 };

/**
 * A lock manager that grants every request: the red probe's stand-in for a user agent whose
 * push role never says held-elsewhere. Every tab that pushes through it believes it holds the
 * role, which is exactly the shape the real Web Lock rules out.
 */
const grantsEveryRequest: LockManagerLike = {
  request: (name, _options, callback) => callback({ name }),
};

function edit(body: string) {
  return {
    buildCandidate: (existing: OkfDocument | undefined) => ({ frontmatter: existing!.frontmatter, body }),
  };
}

// ── platform runtime and presentation ─────────────────────────────────────────────────────

/** The fixed clock and actor the contract kit uses, so a page commit mints the kit's version. */
const PLATFORM_NOW = "2026-09-10T12:00:00.000Z";
const PLATFORM_ACTOR = "process:contract-kit";

let platform: { mode: ExecutionMode; runtime: PlatformRuntime; presentation: Presentation } | null = null;

function platformOrThrow(): NonNullable<typeof platform> {
  if (!platform) throw new Error("driver: call platformMount(mode, remoteBaseUrl, name) first");
  return platform;
}

/**
 * Build a runtime of `mode` over the authority at `remoteBaseUrl` through the page's carrier
 * (so the offline flag cuts either mode off), mount the presentation over it, and render once.
 * Browser-local hydrates the working copy under `name` when it is not already complete.
 */
async function mountPlatform(mode: ExecutionMode, remoteBaseUrl: string, name: string): Promise<PlatformRuntime> {
  platform?.presentation.root.remove();
  platform = null;
  let runtime: PlatformRuntime;
  if (mode === "request-driven") {
    const backend = new RemoteBackend({ baseUrl: remoteBaseUrl, bundle: REMOTE_BUNDLE, fetchImpl: carrier, maxRetries: 0 });
    runtime = await createRequestDrivenRuntime({ remote: backend, actor: PLATFORM_ACTOR, now: () => PLATFORM_NOW });
  } else {
    attachTo(remoteBaseUrl, name);
    const local = bundleOrThrow();
    const { backend, transport } = remoteOrThrow();
    if (!(await isComplete(local))) await bootstrap(backend, local);
    runtime = createBrowserLocalRuntime({ local, remote: backend as RemoteBackend, transport, write: immediate, actor: PLATFORM_ACTOR, now: () => PLATFORM_NOW });
  }
  const presentation = mountPresentation(document.body, runtime);
  await presentation.refresh();
  platform = { mode, runtime, presentation };
  return runtime;
}

type PlatformVerb = "read" | "query" | "validate" | "commit" | "syncStatus" | "sync";

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

  // ── sync verbs ───────────────────────────────────────────────────────────────────────────

  /** Open the working copy under `name` (without seeding) and bind the authority at `remoteBaseUrl`. */
  attach: (remoteBaseUrl: string, name: string) =>
    attempt(async () => {
      attachTo(remoteBaseUrl, name);
      return { ok: true as const, complete: await isComplete(bundleOrThrow()) };
    }),

  /** Attach and hydrate from the authority; `ms` is the page-measured wall time of the hydration. */
  bootstrap: (remoteBaseUrl: string, name: string, batchSize?: number, concurrency?: number) =>
    attempt(async () => {
      attachTo(remoteBaseUrl, name);
      const started = performance.now();
      const marker = await bootstrap(remoteOrThrow().backend, bundleOrThrow(), {
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(concurrency === undefined ? {} : { concurrency }),
      });
      return { marker, ms: performance.now() - started };
    }),

  /** One body edit through the engine's patch path, journaled as an intent in the same transaction. */
  commitLocal: (id: string, body: string) =>
    attempt(async () => {
      const started = performance.now();
      const result = await commitLocal(bundleOrThrow(), id, edit(body));
      return { version: result.version, changed: result.changed, intent: result.intent ? intentView(result.intent) : null, ms: performance.now() - started };
    }),

  /** Push under the store's push role: the Web Lock decides whether this page delivers at all. */
  push: () =>
    attempt(async () => {
      const started = performance.now();
      const role = await pushWithRole(bundleOrThrow(), remoteOrThrow().transport, { remote: remoteOrThrow().backend, write: immediate });
      return { ...role, ms: performance.now() - started };
    }),

  /**
   * The same push with the Web Lock bypassed: the role is granted to every caller, so this page
   * runs push whether or not another page is mid-push over the same store. Only for the red
   * probe that shows what the lock prevents.
   */
  pushWithoutRole: () =>
    attempt(async () => {
      const started = performance.now();
      const role = await pushWithRole(bundleOrThrow(), remoteOrThrow().transport, { remote: remoteOrThrow().backend, write: immediate }, { locks: grantsEveryRequest });
      return { ...role, ms: performance.now() - started };
    }),

  pull: () => attempt(() => pull(bundleOrThrow(), remoteOrThrow().backend)),

  syncStatus: () => attempt(() => syncStatus(bundleOrThrow())),

  isComplete: () => attempt(async () => ({ complete: await isComplete(bundleOrThrow()) })),

  reclaimInFlight: () => attempt(async () => ({ reclaimed: await reclaimInFlight(bundleOrThrow()) })),

  resume: () => attempt(async () => {
    await resume(bundleOrThrow());
    return { ok: true as const };
  }),

  intents: (state?: OperationState) =>
    attempt(async () => (await bundleOrThrow().backend.listIntents(state)).map(intentView)),

  intent: (requestId: string) =>
    attempt(async () => {
      const row = await bundleOrThrow().backend.readIntent(requestId);
      return row ? intentView(row) : null;
    }),

  /**
   * A read that separates what the page holds from what the authority has acknowledged: the
   * document's local version, the shared base recorded for it, and any unsettled intent. The
   * document is locally persisted whenever the read succeeds; it is shared only when the base
   * equals the local version and no unsettled intent targets it.
   */
  readSync: (id: string) =>
    attempt(async () => {
      const { bundle, backend } = bundleOrThrow();
      const { doc, version } = await readDocVersioned(bundle, id);
      const base = await backend.readMeta<SharedBase>(baseKey(id));
      const unsettled = (await backend.listIntents(UNSETTLED_STATES)).filter((row) => row.target === id).map(intentView);
      return {
        version,
        doc: { id: doc.id, frontmatter: doc.frontmatter, body: doc.body },
        local: { persisted: true as const, version },
        shared: { baseVersion: base?.version ?? null, acknowledged: base?.version === version && unsettled.length === 0, unsettled },
      };
    }),

  setOffline: (flag: boolean) => {
    offline = flag;
    return { offline, submittedWhileOffline: [...submittedWhileOffline] };
  },

  armQuota: () => {
    faults.quotaOnNextPut = true;
    return { armed: true as const };
  },

  disarmQuota: () => {
    faults.quotaOnNextPut = false;
    return { armed: false as const };
  },

  // ── platform contract ────────────────────────────────────────────────────────────────────

  /** Mount the presentation over a runtime of `mode`; replies with the runtime's capabilities. */
  platformMount: (mode: ExecutionMode, remoteBaseUrl: string, name: string) =>
    attempt(async () => {
      const runtime = await mountPlatform(mode, remoteBaseUrl, name);
      return { capabilities: runtime.capabilities() };
    }),

  /** One contract verb on the mounted runtime; the reply is the contract's own result as JSON. */
  platformCall: (verb: PlatformVerb, id?: string, edit?: PlatformEdit | QueryFilter) =>
    attempt(async () => {
      const { runtime } = platformOrThrow();
      switch (verb) {
        case "read":
          return runtime.read(id!);
        case "query":
          return runtime.query((edit as QueryFilter | undefined) ?? {});
        case "validate":
          return runtime.validate(id!);
        case "commit":
          return runtime.commit(id!, edit as PlatformEdit);
        case "syncStatus":
          return runtime.syncStatus();
        case "sync":
          return runtime.sync();
      }
    }),

  /** Unsettled intents for `id` in the mounted working copy; none in request-driven mode. */
  platformUnsettled: (id: string) =>
    attempt(async () => {
      if (platformOrThrow().mode === "request-driven") return [];
      return (await bundleOrThrow().backend.listIntents(UNSETTLED_STATES)).filter((row) => row.target === id).map((row) => ({ requestId: row.requestId, state: row.state }));
    }),

  platformRefresh: () => attempt(async () => {
    await platformOrThrow().presentation.refresh();
    return { ok: true as const };
  }),

  /** Wall time of one read and one prefix query, measured in the page. */
  timeRead: (id: string, prefix: string) =>
    attempt(async () => {
      const { bundle } = bundleOrThrow();
      const readStart = performance.now();
      const { version } = await readDocVersioned(bundle, id);
      const readMs = performance.now() - readStart;
      const queryStart = performance.now();
      const heads = await queryHeads(bundle, { prefix });
      const queryMs = performance.now() - queryStart;
      return { version, readMs, count: heads.length, queryMs };
    }),

  /** A blob of incompressible bytes from the page's own entropy, so a storage estimate is honest. */
  writeRandomBlob: (key: string, size: number) =>
    attempt(async () => {
      const { bundle } = bundleOrThrow();
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
      }
      const version = await writeBlob(bundle, key, bytes, "application/octet-stream");
      return { version, size };
    }),
};

export type Driver = typeof driver;

declare global {
  interface Window {
    superbeeLocal: Driver;
  }
}

window.superbeeLocal = driver;
