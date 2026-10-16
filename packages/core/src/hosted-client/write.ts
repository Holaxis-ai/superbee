// The one-call document write: one whole document to a hosted bundle, create-only or against an
// expected version, settled through the shared uncertain-write primitive over the whole-document
// transport. The client owns only what an app without a checkout lacks: a binding (minted once
// per client), an intent store the lookup rebuilds its request from, and the result's shape.
import { readBundleOkfVersion } from "../engine.js";
import {
  createHostedReadAdapter,
  createWholeDocumentTransport,
  type HostedCarrier,
  type HostedCapabilities,
  type HostedReadAdapter,
  type HostedReadRoutes,
  type WriteErrorCode,
} from "../hosted-transport/index.js";
import type { Version } from "../types.js";
import {
  mintRequestId,
  performUncertainWrite,
  type OperationIntent,
  type OperationState,
  type OperationTransport,
  type Outcome,
} from "../uncertain-write.js";
import { isContentVersion } from "../version-transport.js";
import { versionOfBytes } from "../versioning.js";

/** What one write asks: a create of an absent document, or a replace at exactly `expectedVersion`. */
export type HostedWriteInput =
  | { readonly id: string; readonly document: string; readonly expectedVersion: Version; readonly expectAbsent?: never }
  | { readonly id: string; readonly document: string; readonly expectAbsent: true; readonly expectedVersion?: never };

export interface HostedWriteOptions {
  /**
   * The request identity to send under, a lowercase UUID v4. Default: a fresh one. Pass the
   * identity of a write this client's intent store holds to confirm it again: the same write
   * resumes under that identity (nothing new is applied), and a different write is refused.
   */
  readonly requestId?: string;
  /** Ends this write's requests; an abort after sending leaves the outcome unknown. */
  readonly signal?: AbortSignal;
}

/**
 * A recorded write, everything its outcome lookup needs to rebuild the exact request: the
 * operation, the bundle (and the workspace it was named in), the document and its digest, the
 * precondition, the request identity and the binding.
 */
export interface HostedWriteIntent {
  readonly requestId: string;
  /** The client binding (`X-Superbee-Checkout`) the write and every lookup of it carry. */
  readonly binding: string;
  readonly bundleId: string;
  /** The workspace slug the bundle was named in (`within`), or null. */
  readonly workspace: string | null;
  readonly operation: "create" | "replace";
  readonly documentId: string;
  /** The whole serialized document, as sent. */
  readonly document: string;
  /** `sha256:<hex>` of the document's UTF-8 bytes. */
  readonly digest: Version;
  /** The version replaced, or null for a create. */
  readonly expectedVersion: Version | null;
  /** The bundle's OKF edition the document was parsed under, or null when the bundle names none. */
  readonly okfVersion: string | null;
  /** When the intent was recorded (ISO instant): its age decides whether absence is still evidence. */
  readonly createdAt: string;
  /** Submissions made or about to leave; a non-zero count starts any later delivery at the lookup. */
  readonly attempts: number;
  readonly state: OperationState;
}

/**
 * Where a client keeps its writes until they settle. The default is in memory
 * ({@link createMemoryIntentStore}); a service that must recover a write across restarts passes
 * a durable one. `put` replaces the record under its request identity; a settled write is
 * deleted, and a write whose outcome is unknown stays for `lookupWrite`.
 */
export interface HostedIntentStore {
  put(intent: HostedWriteIntent): Promise<void> | void;
  get(requestId: string): Promise<HostedWriteIntent | undefined> | HostedWriteIntent | undefined;
  delete(requestId: string): Promise<void> | void;
}

/** An in-memory {@link HostedIntentStore}: records live as long as the store. */
export function createMemoryIntentStore(): HostedIntentStore {
  const records = new Map<string, HostedWriteIntent>();
  return {
    put(intent) {
      records.set(intent.requestId, Object.freeze({ ...intent }));
    },
    get(requestId) {
      return records.get(requestId);
    },
    delete(requestId) {
      records.delete(requestId);
    },
  };
}

/** A refusal's code: the host's own (`validation_failed`, ...) or one the client names. */
export type HostedWriteRefusalCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "REQUEST_CAPACITY_PRINCIPAL"
  | "REQUEST_CAPACITY_BUNDLE"
  /** The host serves this bundle no identified writes. */
  | "read_only"
  | "unsupported_operation"
  | WriteErrorCode
  | (string & {});

interface WriteResultBase {
  readonly requestId: string;
  readonly documentId: string;
}

/**
 * A write's settled answer, or `unknown`. A conflict is final for this request identity: nothing
 * was written, and a further attempt is the caller's decision, as a new write.
 */
export type HostedWriteResult =
  | (WriteResultBase & { readonly status: "committed"; readonly version: Version })
  /**
   * The document is not at the expected version (or, for a create, exists): `currentVersion` is
   * the version the host serves, or null when it serves none. `tombstone` names the deletion a
   * create of a deleted id ran into, when the host named one.
   */
  | (WriteResultBase & { readonly status: "conflict"; readonly reason: "version_conflict"; readonly currentVersion: Version | null; readonly tombstone?: Version })
  /** Another write to the bundle overlapped this one past the host's own retries; nothing was applied. */
  | (WriteResultBase & { readonly status: "conflict"; readonly reason: "concurrent_change"; readonly message: string })
  | (WriteResultBase & { readonly status: "refused"; readonly code: HostedWriteRefusalCode; readonly message: string })
  /** The host may or may not hold the write. `lookupWrite(requestId)` asks again later. */
  | (WriteResultBase & { readonly status: "unknown" });

/** The identity an app's request names: a lowercase UUID v4, the only form the host admits. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What a write needs from its client: the carrier for a workspace, the routes and the store. */
export interface HostedWriteContext {
  readonly binding: string;
  readonly store: HostedIntentStore;
  readonly prefix: string;
  readonly workspace: string | null;
  readonly signal: AbortSignal;
  carrierFor(workspace: string | null): HostedCarrier;
  readRoutes: HostedReadRoutes;
}

function writeRoutes(prefix: string) {
  return { create: `${prefix}/create`, replace: `${prefix}/replace`, delete: `${prefix}/delete`, outcome: `${prefix}/outcome` };
}

function operationIntent(intent: HostedWriteIntent): OperationIntent {
  return {
    requestId: intent.requestId,
    kind: intent.operation === "create" ? "document.create" : "document.replace",
    target: intent.documentId,
    base: intent.expectedVersion,
    local: intent.digest,
    content: intent.document,
    createdAt: intent.createdAt,
    attempts: intent.attempts,
    state: intent.state,
  };
}

/** True when two intents are the same write: everything but its delivery progress and record time. */
function sameWrite(a: HostedWriteIntent, b: Omit<HostedWriteIntent, "binding" | "createdAt" | "attempts" | "state" | "okfVersion">): boolean {
  return (
    a.requestId === b.requestId &&
    a.bundleId === b.bundleId &&
    a.workspace === b.workspace &&
    a.operation === b.operation &&
    a.documentId === b.documentId &&
    a.digest === b.digest &&
    a.document === b.document &&
    a.expectedVersion === b.expectedVersion
  );
}

function resultOf(intent: HostedWriteIntent, outcome: Outcome): HostedWriteResult {
  const base = { requestId: intent.requestId, documentId: intent.documentId };
  switch (outcome.kind) {
    case "committed":
      return { ...base, status: "committed", version: outcome.version };
    case "conflict":
      return { ...base, status: "conflict", reason: "version_conflict", currentVersion: outcome.actual, ...(outcome.tombstone !== undefined ? { tombstone: outcome.tombstone } : {}) };
    case "refused":
      // Settled, so final: the client never resends it, under this identity or a new one.
      if (outcome.code === "concurrent_change") return { ...base, status: "conflict", reason: "concurrent_change", message: outcome.message };
      return { ...base, status: "refused", code: outcome.code, message: outcome.message };
    case "unknown":
      return { ...base, status: "unknown" };
  }
}

/** The signal a write's requests run under: the client's, and the caller's when given. */
function writeSignal(context: HostedWriteContext, signal: AbortSignal | undefined): AbortSignal {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

/**
 * Deliver a recorded intent and settle it: the submission (unless one already left) and, after
 * an unclear answer, the lookup under the same identity and binding, as `performUncertainWrite`
 * decides. The record's attempt count is stored before each submission leaves.
 */
async function deliver(
  context: HostedWriteContext,
  intent: HostedWriteIntent,
  reader: HostedReadAdapter,
  capabilities: Pick<HostedCapabilities, "documentInputBytes">,
  signal: AbortSignal,
): Promise<HostedWriteResult> {
  const { store } = context;
  const transport = createWholeDocumentTransport({
    carrier: context.carrierFor(intent.workspace),
    bundleId: intent.bundleId,
    binding: intent.binding,
    intentFor: async (requestId) => {
      const stored = await store.get(requestId);
      return stored ? operationIntent(stored) : undefined;
    },
    remote: reader,
    routes: writeRoutes(context.prefix),
    ...(intent.okfVersion !== null ? { okfVersion: intent.okfVersion } : {}),
    documentInputBytes: capabilities.documentInputBytes,
    signal,
  });
  const recording: OperationTransport = {
    async submit(sending, options) {
      await store.put({ ...intent, attempts: sending.attempts, state: "in_flight" });
      return transport.submit(sending, options);
    },
    lookup: (requestId) => transport.lookup(requestId),
  };
  const { outcome, intent: settled } = await performUncertainWrite(recording, operationIntent(intent), { settlement: transport.settlement });
  try {
    if (outcome.kind === "unknown") await store.put({ ...intent, attempts: settled.attempts, state: "unknown" });
    else await store.delete(intent.requestId);
  } catch {
    // The settled answer is the caller's either way; the record before the submission stands.
  }
  return resultOf(intent, outcome);
}

/** `HostedClient.write`. */
export async function hostedWrite(context: HostedWriteContext, bundleId: string, input: HostedWriteInput, options: HostedWriteOptions = {}): Promise<HostedWriteResult> {
  if (typeof bundleId !== "string" || bundleId === "") throw new TypeError("a write names its bundle");
  if (typeof input !== "object" || input === null) throw new TypeError("a write takes { id, document } with expectedVersion or expectAbsent");
  const { id, document } = input;
  if (typeof id !== "string" || id === "") throw new TypeError("a write names its document id");
  if (typeof document !== "string") throw new TypeError("a write's document is the whole serialized document");
  const creates = input.expectAbsent === true;
  if (creates === (input.expectedVersion !== undefined)) throw new TypeError("a write takes exactly one of expectedVersion and expectAbsent: true");
  if (!creates && !isContentVersion(input.expectedVersion)) throw new TypeError("expectedVersion is not a version");
  if (options.requestId !== undefined && !REQUEST_ID.test(options.requestId)) throw new TypeError("a request identity is a lowercase UUID v4");

  const requested = {
    requestId: options.requestId ?? mintRequestId(),
    bundleId,
    workspace: context.workspace,
    operation: creates ? ("create" as const) : ("replace" as const),
    documentId: id,
    document,
    digest: versionOfBytes(document),
    expectedVersion: creates ? null : (input.expectedVersion as Version),
  };
  const signal = writeSignal(context, options.signal);
  const reader = createHostedReadAdapter({ carrier: context.carrierFor(requested.workspace), bundleId, routes: context.readRoutes });

  const known = options.requestId !== undefined ? await context.store.get(requested.requestId) : undefined;
  if (known && !sameWrite(known, requested)) {
    return { requestId: requested.requestId, documentId: id, status: "refused", code: "invalid_input", message: "This request identity already names a different write; nothing was sent." };
  }
  // Nothing has left yet: a failure to read the bundle's capabilities is the caller's typed error.
  const capabilities = await reader.hostedCapabilities();
  if (known) return deliver(context, known, reader, capabilities, signal);
  if (!capabilities.operations) {
    return { requestId: requested.requestId, documentId: id, status: "refused", code: "read_only", message: "The host serves no identified writes for this bundle; nothing was sent." };
  }
  // The editions core parses; any other reads as none, as the CLI's checkout reads it.
  const edition = await readBundleOkfVersion(reader);
  const intent: HostedWriteIntent = {
    ...requested,
    binding: context.binding,
    okfVersion: edition === "0.1" || edition === "0.2" ? edition : null,
    createdAt: new Date().toISOString(),
    attempts: 0,
    state: "pending",
  };
  await context.store.put(intent);
  return deliver(context, intent, reader, capabilities, signal);
}

/**
 * `HostedClient.lookupWrite`: settle a recorded write whose outcome was unknown. It looks the
 * identity up under the binding it was sent with; when the host never recorded it (within its
 * stated retention), it delivers that same identity, as the write itself would have. An unclear
 * lookup is `unknown` again, and an identity the store does not hold is a `TypeError`.
 */
export async function hostedLookupWrite(context: HostedWriteContext, requestId: string, options: { signal?: AbortSignal } = {}): Promise<HostedWriteResult> {
  const intent = typeof requestId === "string" ? await context.store.get(requestId) : undefined;
  if (!intent) throw new TypeError("no recorded write has this request identity");
  const signal = writeSignal(context, options.signal);
  const reader = createHostedReadAdapter({ carrier: context.carrierFor(intent.workspace), bundleId: intent.bundleId, routes: context.readRoutes });
  let capabilities: HostedCapabilities;
  try {
    capabilities = await reader.hostedCapabilities();
  } catch {
    return { requestId: intent.requestId, documentId: intent.documentId, status: "unknown" };
  }
  // A recorded intent may never have left (a store written before a crash): delivery starts
  // with a submission then, under the recorded identity, exactly as the write would have.
  return deliver(context, intent, reader, capabilities, signal);
}
