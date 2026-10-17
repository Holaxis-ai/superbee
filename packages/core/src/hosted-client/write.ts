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
 * deleted, and a write whose outcome is unknown stays for `lookupWrite` and `settleWrite`.
 * `list`, when the store has it, yields every record it holds, so a service restarting with a
 * durable store finds its unsettled writes (`heldWrites`).
 */
export interface HostedIntentStore {
  put(intent: HostedWriteIntent): Promise<void> | void;
  get(requestId: string): Promise<HostedWriteIntent | undefined> | HostedWriteIntent | undefined;
  delete(requestId: string): Promise<void> | void;
  list?(): AsyncIterable<HostedWriteIntent>;
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
    async *list() {
      yield* [...records.values()];
    },
  };
}

/** The code of {@link HostedIntentsNotListable}. */
export const INTENTS_NOT_LISTABLE = "INTENTS_NOT_LISTABLE";

/** `heldWrites` was asked of a client whose intent store has no `list`. */
export class HostedIntentsNotListable extends Error {
  readonly code = INTENTS_NOT_LISTABLE;
  constructor() {
    super("this client's intent store cannot list its writes (it has no list method)");
    this.name = "HostedIntentsNotListable";
  }
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
  /**
   * The host may or may not hold the write. `lookupWrite` or `settleWrite` asks again later.
   * `refusal` is the refusal of this call's resend, when one ended it: the resend was refused
   * before it ran (access withdrawn, signed out, a spent quota, a malformed request) while an
   * earlier delivery may still commit, so the write is kept. It says why settling must wait.
   */
  | (WriteResultBase & { readonly status: "unknown"; readonly refusal?: { readonly code: string; readonly message: string } });

/**
 * What `lookupWrite` and `settleWrite` answer: a write's result, or `unrecorded` when the intent
 * store holds no write under the identity (never recorded, or already settled and deleted).
 */
export type HostedWriteLookupResult = HostedWriteResult | { readonly status: "unrecorded"; readonly requestId: string };

/** The identity an app's request names: a lowercase UUID v4, the only form the host admits. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What a write needs from its client: the carrier for a workspace, the routes and the store. */
export interface HostedWriteContext {
  readonly binding: string;
  readonly store: HostedIntentStore;
  /** One chain per request identity in flight, shared by a client and its `within` clients. */
  readonly inFlight: Map<string, Promise<unknown>>;
  readonly prefix: string;
  readonly workspace: string | null;
  readonly signal: AbortSignal;
  /** The wait between outcome lookups (default 250 ms). */
  readonly lookupDelayMs?: number;
  /** Each bundle's capabilities as writes use them, shared by a client and its `within` clients. */
  readonly capabilities: HostedCapabilitiesCache;
  carrierFor(workspace: string | null): HostedCarrier;
  readRoutes: HostedReadRoutes;
}

/** The capabilities a write uses, from one answer: the flags and bounds, and the edition its root declares. */
interface WriteSideAnswer {
  readonly capabilities: HostedCapabilities;
  readonly okfVersion: "0.1" | "0.2" | null;
}

/**
 * One bundle's write side: a reader of its own (never the public `reader()`, whose held answer
 * is checked against heads answers) and its one capabilities answer, in flight or arrived.
 */
interface WriteSide {
  readonly reader: HostedReadAdapter;
  readonly answer: Promise<WriteSideAnswer>;
  /** When the answer arrived, by the cache's clock; undefined while it is in flight. */
  answeredAt: number | undefined;
}

/**
 * Each bundle's write side, keyed by the workspace the bundle is named in and its id, and held
 * for `ttlMs` after its answer arrives. A `ttlMs` of 0 holds nothing: every write reads anew.
 */
export interface HostedCapabilitiesCache {
  readonly ttlMs: number;
  readonly now: () => number;
  readonly entries: Map<string, WriteSide>;
}

/** The default time a bundle's capabilities answer serves writes: 60 s. */
export const DEFAULT_CAPABILITIES_TTL_MS = 60_000;

export function createCapabilitiesCache(ttlMs: number = DEFAULT_CAPABILITIES_TTL_MS, now: () => number = Date.now): HostedCapabilitiesCache {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError("capabilitiesTtlMs is a finite number of milliseconds, 0 or more");
  return { ttlMs, now, entries: new Map() };
}

/**
 * The write side of a bundle named in `workspace`: the held one while its answer is in flight or
 * fresh, so concurrent writes share one read, else (or when `fresh`) a new reader and read, which
 * replaces the held one. A read that fails is never held. Each new read also removes every
 * expired entry, so a long-lived client holds only bundles written within the TTL.
 */
function writeSide(context: HostedWriteContext, workspace: string | null, bundleId: string, fresh = false): WriteSide {
  const cache = context.capabilities;
  const key = JSON.stringify([workspace, bundleId]);
  const live = (side: WriteSide) => side.answeredAt === undefined || cache.now() - side.answeredAt < cache.ttlMs;
  const held = cache.entries.get(key);
  if (held && !fresh && live(held)) return held;
  for (const [other, side] of cache.entries) if (!live(side)) cache.entries.delete(other);
  const reader = createHostedReadAdapter({ carrier: context.carrierFor(workspace), bundleId, routes: context.readRoutes });
  const answer = reader.hostedCapabilities().then(async (capabilities): Promise<WriteSideAnswer> => {
    // The edition from this same answer's root; the editions core parses, any other reads as
    // none, as the CLI's checkout reads it.
    const edition = await readBundleOkfVersion({ readReserved: async () => capabilities.root });
    return { capabilities, okfVersion: edition === "0.1" || edition === "0.2" ? edition : null };
  });
  const side: WriteSide = { reader, answer, answeredAt: undefined };
  if (cache.ttlMs === 0) return side;
  cache.entries.set(key, side);
  answer.then(
    () => {
      side.answeredAt = cache.now();
    },
    () => {
      if (cache.entries.get(key) === side) cache.entries.delete(key);
    },
  );
  return side;
}

/**
 * Refusals after which a bundle's held capabilities may be what went wrong, so the next write
 * reads them again: no writes served (`read_only`); input the host or the client's parse under
 * the held edition refused (`invalid_input`, `validation_failed`); and the bundle gone or access
 * withdrawn, which the write answer reports as `PERMISSION_DENIED` (`bundle_not_found`,
 * `insufficient_scope`, `access_denied`).
 */
const DROPPING_REFUSALS: ReadonlySet<string> = new Set(["read_only", "invalid_input", "validation_failed", "bundle_not_found", "PERMISSION_DENIED"]);

/** Drop a write side after a result that may say its capabilities are stale: such a refusal, or any `unknown`. */
function settleWriteSide(context: HostedWriteContext, workspace: string | null, bundleId: string, side: WriteSide, result: HostedWriteResult): HostedWriteResult {
  if (result.status === "unknown" || (result.status === "refused" && DROPPING_REFUSALS.has(result.code))) {
    const key = JSON.stringify([workspace, bundleId]);
    if (context.capabilities.entries.get(key) === side) context.capabilities.entries.delete(key);
  }
  return result;
}

/**
 * The reader a transport needs. The retention window decides whether an `absent` lookup lets an
 * intent be resent, so it always comes from a capabilities read made now, never a held answer: a
 * window the host has since shortened must not resend an identity it may already have expired.
 * That read refreshes the held entry. It runs only after an `absent` lookup; a failure leaves the
 * outcome unknown.
 */
function writeRemote(context: HostedWriteContext, intent: HostedWriteIntent, reader: HostedReadAdapter): Pick<HostedReadAdapter, "read" | "operationsRetentionMs"> {
  return {
    read: (id) => reader.read(id),
    operationsRetentionMs: async () => (await writeSide(context, intent.workspace, intent.bundleId, true).answer).capabilities.operationsRetentionMs,
  };
}

/**
 * Run `task` after every earlier task of this client under the same request identity, so two
 * calls naming one identity never check and record it at the same time.
 */
async function serialized<T>(context: HostedWriteContext, requestId: string, task: () => Promise<T>): Promise<T> {
  const previous = context.inFlight.get(requestId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  context.inFlight.set(requestId, settled);
  try {
    return await run;
  } finally {
    if (context.inFlight.get(requestId) === settled) context.inFlight.delete(requestId);
  }
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

/** True when two writes differ only in the workspace their bundle was named in. */
function onlyWorkspaceDiffers(a: HostedWriteIntent, b: Omit<HostedWriteIntent, "binding" | "createdAt" | "attempts" | "state" | "okfVersion">): boolean {
  return a.workspace !== b.workspace && sameWrite({ ...a, workspace: b.workspace }, b);
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
      return { ...base, status: "unknown", ...(outcome.refusal ? { refusal: { code: outcome.refusal.code, message: outcome.refusal.message } } : {}) };
  }
}

/** The signal a write's requests run under: the client's, and the caller's when given. */
function writeSignal(context: HostedWriteContext, signal: AbortSignal | undefined): AbortSignal {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

function transportFor(context: HostedWriteContext, intent: HostedWriteIntent, reader: HostedReadAdapter, capabilities: HostedCapabilities, signal: AbortSignal) {
  const { store } = context;
  return createWholeDocumentTransport({
    carrier: context.carrierFor(intent.workspace),
    bundleId: intent.bundleId,
    binding: intent.binding,
    intentFor: async (requestId) => {
      const stored = await store.get(requestId);
      return stored ? operationIntent(stored) : undefined;
    },
    remote: writeRemote(context, intent, reader),
    routes: writeRoutes(context.prefix),
    ...(intent.okfVersion !== null ? { okfVersion: intent.okfVersion } : {}),
    documentInputBytes: capabilities.documentInputBytes,
    signal,
  });
}

/**
 * Record what an outcome leaves: a settled write leaves the store, an unknown one stays with its
 * attempt count. Only the record of this same write is touched, never another write's under the
 * identity. A store failure here never hides the outcome from the caller.
 */
async function recordOutcome(context: HostedWriteContext, intent: HostedWriteIntent, outcome: Outcome, attempts: number): Promise<void> {
  try {
    const stored = await context.store.get(intent.requestId);
    if (!stored || !sameWrite(stored, intent)) return;
    if (outcome.kind === "unknown") {
      if (attempts !== stored.attempts || stored.state !== "unknown") await context.store.put({ ...stored, attempts, state: "unknown" });
    } else await context.store.delete(intent.requestId);
  } catch {
    // The record before the submission stands; the answer is the caller's either way.
  }
}

/**
 * Deliver a recorded intent and settle it: the submission (unless one already left) and, after
 * an unclear answer, the lookup under the same identity and binding, as `performUncertainWrite`
 * decides. The record's attempt count is stored before each submission leaves; when that fails
 * before the first submission, nothing is sent and the store's error is thrown.
 */
async function deliver(
  context: HostedWriteContext,
  intent: HostedWriteIntent,
  reader: HostedReadAdapter,
  capabilities: HostedCapabilities,
  callerSignal: AbortSignal,
): Promise<HostedWriteResult> {
  // Stopping on a store failure ends the primitive's lookups at once, without the delay between them.
  const halt = new AbortController();
  const signal = AbortSignal.any([callerSignal, halt.signal]);
  const transport = transportFor(context, intent, reader, capabilities, signal);
  // The intent store failed before a first submission could be recorded: nothing was sent.
  let storeFailure: { readonly cause: unknown } | undefined;
  const recording: OperationTransport = {
    async submit(sending, options) {
      try {
        await context.store.put({ ...intent, attempts: sending.attempts, state: "in_flight" });
      } catch (error) {
        // A first submission that cannot be recorded is not sent; a later one is not sent either,
        // and the earlier submission's outcome stays unknown.
        if (sending.attempts === 1) storeFailure = { cause: error };
        halt.abort();
        throw error;
      }
      return transport.submit(sending, options);
    },
    lookup: (requestId) => transport.lookup(requestId),
  };
  const { outcome, intent: settled } = await performUncertainWrite(recording, operationIntent(intent), {
    settlement: transport.settlement,
    signal,
    // Every held record with a submission is one whose answer was never definitive.
    earlierDeliveryUnclear: intent.attempts > 0,
    ...(context.lookupDelayMs !== undefined ? { lookupDelayMs: context.lookupDelayMs } : {}),
  });
  if (storeFailure) throw storeFailure.cause;
  // A refusal after the caller aborted is the abort's (the carrier sends nothing once it has),
  // never the host's verdict: the identity stays unknown and its record is kept.
  const answer: Outcome = callerSignal.aborted && outcome.kind === "refused" ? { kind: "unknown" } : outcome;
  await recordOutcome(context, intent, answer, settled.attempts);
  return resultOf(intent, answer);
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
  return serialized(context, requested.requestId, async () => {
    const signal = writeSignal(context, options.signal);
    signal.throwIfAborted();
    const known = options.requestId !== undefined ? await context.store.get(requested.requestId) : undefined;
    if (known && !sameWrite(known, requested)) {
      const message = onlyWorkspaceDiffers(known, requested)
        ? `This request identity names the same write in ${known.workspace === null ? "no workspace" : `workspace '${known.workspace}'`}; confirm it from that client. Nothing was sent.`
        : "This request identity already names a different write; nothing was sent.";
      return { requestId: requested.requestId, documentId: id, status: "refused", code: "invalid_input", message };
    }
    // Nothing has left yet: a failure to read the bundle's capabilities is the caller's typed
    // error. Everything this write uses from capabilities comes from this one answer.
    const side = writeSide(context, requested.workspace, bundleId);
    const { capabilities, okfVersion } = await side.answer;
    const settle = (result: HostedWriteResult) => settleWriteSide(context, requested.workspace, bundleId, side, result);
    if (known) return settle(await deliver(context, known, side.reader, capabilities, signal));
    if (!capabilities.operations) {
      return settle({ requestId: requested.requestId, documentId: id, status: "refused", code: "read_only", message: "The host serves no identified writes for this bundle; nothing was sent." });
    }
    const intent: HostedWriteIntent = {
      ...requested,
      binding: context.binding,
      okfVersion,
      createdAt: new Date().toISOString(),
      attempts: 0,
      state: "pending",
    };
    await context.store.put(intent);
    return settle(await deliver(context, intent, side.reader, capabilities, signal));
  });
}

/** The held intent and its bundle's write side and capabilities, or what a lookup answers without them. */
async function heldIntent(
  context: HostedWriteContext,
  requestId: string,
): Promise<{ intent: HostedWriteIntent; side: WriteSide; reader: HostedReadAdapter; capabilities: HostedCapabilities } | HostedWriteLookupResult> {
  const intent = typeof requestId === "string" ? await context.store.get(requestId) : undefined;
  if (!intent) return { status: "unrecorded", requestId };
  const side = writeSide(context, intent.workspace, intent.bundleId);
  try {
    return { intent, side, reader: side.reader, capabilities: (await side.answer).capabilities };
  } catch {
    // The write may have left: an unreadable bundle is no evidence either way.
    return { requestId: intent.requestId, documentId: intent.documentId, status: "unknown" };
  }
}

/** One outcome lookup of a held write, never a send; a host holding no outcome yet is `unknown`. */
async function lookupOnly(context: HostedWriteContext, intent: HostedWriteIntent, reader: HostedReadAdapter, capabilities: HostedCapabilities, signal: AbortSignal): Promise<HostedWriteResult> {
  const transport = transportFor(context, intent, reader, capabilities, signal);
  let outcome: Outcome;
  try {
    const recorded = await transport.lookup(intent.requestId);
    outcome = recorded === null || recorded.kind === "pending" ? { kind: "unknown" } : recorded;
  } catch {
    outcome = { kind: "unknown" };
  }
  await recordOutcome(context, intent, outcome, intent.attempts);
  return resultOf(intent, outcome);
}

/**
 * `HostedClient.lookupWrite`: what the host recorded for a held write, by one outcome lookup under
 * the identity and binding it was sent with. It never sends the write: a host that holds no
 * outcome yet (absent or pending), or a lookup that fails, is `unknown`.
 */
export async function hostedLookupWrite(context: HostedWriteContext, requestId: string, options: { signal?: AbortSignal } = {}): Promise<HostedWriteLookupResult> {
  const signal = writeSignal(context, options.signal);
  signal.throwIfAborted();
  return serialized(context, requestId, async () => {
    // Aborted while an earlier call under this identity ran: this one sends nothing.
    signal.throwIfAborted();
    const held = await heldIntent(context, requestId);
    if (!("intent" in held)) return held;
    return settleWriteSide(context, held.intent.workspace, held.intent.bundleId, held.side, await lookupOnly(context, held.intent, held.reader, held.capabilities, signal));
  });
}

/**
 * `HostedClient.settleWrite`: settle a held write. It looks the identity up under the binding it
 * was sent with; when the host never recorded it (within the retention window it serves), it
 * delivers that same identity once more, as the write itself would have. An unclear lookup is
 * `unknown` again. A bundle the host serves no writes for is only looked up.
 */
export async function hostedSettleWrite(context: HostedWriteContext, requestId: string, options: { signal?: AbortSignal } = {}): Promise<HostedWriteLookupResult> {
  const signal = writeSignal(context, options.signal);
  signal.throwIfAborted();
  return serialized(context, requestId, async () => {
    // Aborted while an earlier call under this identity ran: this one sends nothing.
    signal.throwIfAborted();
    const held = await heldIntent(context, requestId);
    if (!("intent" in held)) return held;
    const settle = (result: HostedWriteResult) => settleWriteSide(context, held.intent.workspace, held.intent.bundleId, held.side, result);
    if (!held.capabilities.operations) return settle(await lookupOnly(context, held.intent, held.reader, held.capabilities, signal));
    // A recorded intent may never have left (a store written before a crash): delivery starts
    // with a submission then, under the recorded identity, exactly as the write would have.
    return settle(await deliver(context, held.intent, held.reader, held.capabilities, signal));
  });
}

/** `HostedClient.heldWrites`: every write the intent store holds. */
export async function hostedHeldWrites(context: HostedWriteContext): Promise<HostedWriteIntent[]> {
  const { store } = context;
  if (typeof store.list !== "function") throw new HostedIntentsNotListable();
  const held: HostedWriteIntent[] = [];
  for await (const intent of store.list()) held.push(intent);
  return held;
}
