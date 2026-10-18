// The one-call blob write: one ordinary file to a hosted bundle, create-only or at an expected
// version and content type, or a delete at one. `driveJournaledBlob` is the single owner of the
// journaled sequence (admit, durable claim, delivery, persisted patch, retirement) over the pure
// blob transition rules in `blob-journal.ts` and `performHostedBlobDelivery`; the client methods
// below add only the capability gate, scope, serialization and the result's shape.
import type { BlobHead } from "../blob-contract.js";
import {
  BlobAdmissionConflict,
  blobIntentResendable,
  blobNonExecutionPatch,
  checkBlobAdmission,
  decodePreparedBlobIntent,
  prepareBlobIntent,
  type BlobAdmissionCheck,
  type BlobDeletionHold,
  type BlobIntentPatch,
  type BlobIntentRecord,
  type BlobJournalGuard,
  type BlobJournalMutationOptions,
  type BlobJournaledBackend,
  type BlobNotDispatchedCode,
  type BlobReceipt,
  type BlobTargetScope,
  type PreparedBlobIntent,
} from "../blob-journal.js";
import { isHostedBundleId } from "../dependencies.js";
import { captureJournalValue, equalJournalValue, JournalGuardConflict, type MetaRecord } from "../journaled-backend.js";
import { RemoteError } from "../remote-error.js";
import { sha256HexOfBytes } from "../sha256.js";
import type { OperationState, Sleep } from "../uncertain-write.js";
import { mintRequestId } from "../uncertain-write.js";
import { isContentVersion } from "../version-transport.js";
import { isAgentLabelVia, isWriteBinding, isWriteRequestId } from "../write-identity.js";
import type { Version } from "../types.js";
import {
  createHostedBlobReadAdapter,
  createHostedBlobWriteAdapter,
  HostedCarrierError,
  HostedReadAdapterError,
  isAcceptedDeletionCount,
  type BlobWriteExpected,
  type HostedBlobHeads,
  type HostedBlobRead,
  type HostedBlobWriteAdapter,
  type HostedCapabilities,
  type HostedCarrier,
} from "../hosted-transport/index.js";
import { performHostedBlobDelivery, type HostedBlobDeliveryOutcome, type HostedBlobDeliveryResult } from "./blob-delivery.js";
import { HostedBlobWritesNotServed, HostedRouteNotServed } from "./errors.js";
import { dropWriteSide, untilAborted, writeSide, writeSignal, type HostedWriteContext, type WriteSide } from "./write.js";

// ── the owner ───────────────────────────────────────────────────────────────────────────────

/** The journal transaction a premises snapshot is taken for. */
export type BlobDriveStep =
  | { readonly kind: "admit"; readonly prepared: string }
  | { readonly kind: "claim"; readonly record: BlobIntentRecord }
  | { readonly kind: "persist"; readonly record: BlobIntentRecord; readonly patch: BlobIntentPatch }
  | { readonly kind: "retire"; readonly record: BlobIntentRecord }
  | { readonly kind: "forget"; readonly record: BlobIntentRecord };

/** One read's guard, and the caller's own metadata changes, for the next transaction on the key. */
export interface BlobDriveSnapshot {
  readonly guard: BlobJournalGuard;
  readonly meta?: readonly MetaRecord[];
  readonly removeMeta?: readonly string[];
  /** Admission only: the unsettled same-bundle intents on the key this admission stands beside. */
  readonly unsettled?: readonly BlobIntentRecord[];
}

/**
 * A caller's own premises, checked in the same transactions as the owner's: `snapshot` reads the
 * key's journal (with any named metadata) and returns that read's guard plus the metadata changes
 * the step commits with it. Without it the owner reads the key's intents alone.
 */
export interface BlobDrivePremises {
  snapshot(key: string, step: BlobDriveStep): Promise<BlobDriveSnapshot>;
}

export interface JournaledBlobContext {
  /** The trusted current target. A record of any other scope is never delivered. */
  readonly scope: BlobTargetScope;
  /** The carrier for `scope`, already qualified by its workspace when it has one. */
  readonly carrier: HostedCarrier;
  /**
   * The bundle's capabilities. Called at most once per drive, and that one answer serves both the
   * owner's checks before a claim and the delivery adapter, so they cannot disagree. A lookup-only
   * drive calls it only through the adapter, where a failure leaves the outcome unknown.
   */
  readonly capabilities: () => Promise<HostedCapabilities>;
  readonly signal?: AbortSignal;
  readonly premises?: BlobDrivePremises;
  readonly delivery?: { readonly deadlineMs?: number; readonly maxLookups?: number; readonly lookupDelayMs?: number; readonly sleep?: Sleep };
}

/**
 * `admit`: admit `prepared` and submit it once. `settle`: submit a record whose every attempt is
 * proven not applied (a deletion hold needs `acceptDeletes` of at least its count), otherwise look
 * it up. `lookup`: look it up, never submitting.
 */
export type JournaledBlobMode =
  | { readonly start: "admit"; readonly prepared: string; readonly acceptDeletes?: number }
  | { readonly start: "settle"; readonly acceptDeletes?: number }
  | { readonly start: "lookup" };

export type JournaledBlobResult =
  /** Nothing was journaled: the input fails a check against the capabilities answer. */
  | { readonly kind: "not-admitted"; readonly reason: "precondition"; readonly check: Extract<BlobAdmissionCheck, { ok: false }> }
  /** Nothing was journaled: another unsettled intent of the bundle holds the key. */
  | { readonly kind: "not-admitted"; readonly reason: "unsettled"; readonly unsettled: readonly string[] }
  /** Nothing was journaled or sent (admit), or claimed (settle): the host serves no blob writes. */
  | { readonly kind: "not-served"; readonly record?: BlobIntentRecord }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "scope-mismatch"; readonly record: BlobIntentRecord }
  /** A deletion hold awaiting a person's acceptance; nothing was sent. */
  | { readonly kind: "held"; readonly record: BlobIntentRecord; readonly hold: BlobDeletionHold }
  /** A lookup of a record never sent, or proven not applied: nothing to ask the host. */
  | { readonly kind: "unsent"; readonly record: BlobIntentRecord }
  /** A resendable record fails a check against the current capabilities; it was not claimed. */
  | { readonly kind: "not-sendable"; readonly record: BlobIntentRecord; readonly check: Extract<BlobAdmissionCheck, { ok: false }> }
  /**
   * The claim was proven never dispatched. `rolledBack`: the journal returned it to `pending`,
   * resendable; otherwise it stays `in_flight` and only a lookup may settle it.
   */
  | { readonly kind: "not-dispatched"; readonly record: BlobIntentRecord; readonly code: BlobNotDispatchedCode; readonly cause?: unknown; readonly rolledBack: boolean }
  | {
      readonly kind: "delivered";
      /** The record as last persisted (the claim when `persisted` is false). */
      readonly record: BlobIntentRecord;
      readonly outcome: HostedBlobDeliveryOutcome;
      /** Whether this drive submitted (false for a lookup or a receipt already held). */
      readonly submitted: boolean;
      readonly lookups: number;
      /** False when the outcome could not be recorded: the record stays for a later lookup. */
      readonly persisted: boolean;
      readonly retired: boolean;
    };

/**
 * A held deletion's continuation named fewer deletions than the host holds. Nothing was claimed
 * or sent; the record stays held.
 */
export class HostedBlobDeletionsNotAccepted extends Error {
  readonly code = "DELETIONS_NOT_ACCEPTED";
  readonly requestId: string;
  readonly deletions: number;
  readonly baseline: number;
  readonly accepted: number | undefined;
  constructor(requestId: string, hold: BlobDeletionHold, accepted: number | undefined) {
    super(`the host holds ${hold.deletions} deletions of ${hold.baseline} files; acceptDeletes must be at least ${hold.deletions}. Nothing was sent.`);
    this.name = "HostedBlobDeletionsNotAccepted";
    this.requestId = requestId;
    this.deletions = hold.deletions;
    this.baseline = hold.baseline;
    this.accepted = accepted;
  }
}

/** How long an aborted send waits for its carrier call to settle before it counts as unknown. */
const CARRIER_SETTLE_MS = 1000;

/** `work` settled, or `ms` passed: whichever is first, never rejecting. */
async function settledWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

/** How many times a transaction reads its key again after a guard conflict, before refusing. */
const GUARD_ATTEMPTS = 8;

function mutationOptions(snapshot: BlobDriveSnapshot): BlobJournalMutationOptions {
  return {
    guard: snapshot.guard,
    ...(snapshot.meta === undefined ? {} : { meta: [...snapshot.meta] }),
    ...(snapshot.removeMeta === undefined ? {} : { removeMeta: [...snapshot.removeMeta] }),
  };
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let answer: Promise<T> | undefined;
  return () => (answer ??= Promise.resolve().then(load));
}

function admissionCheck(prepared: PreparedBlobIntent, bytes: number | undefined, capabilities: HostedCapabilities): BlobAdmissionCheck {
  const { intent } = prepared;
  const operation = intent.operationId === "blobs.create.v1" ? "create" : intent.operationId === "blobs.replace.v1" ? "replace" : "delete";
  return checkBlobAdmission({
    operation,
    key: intent.key,
    ...(intent.operationId === "blobs.delete.v1" ? {} : { contentType: intent.contentType }),
    ...(operation === "create" ? {} : { expectedContentType: intent.expectedContentType }),
    ...(bytes === undefined ? {} : { byteLength: bytes }),
    maximumBytes: capabilities.blobWriteBytes ?? null,
  });
}

/** The raw length of a prepared intent's bytes, from its canonical base64. */
function preparedByteLength(prepared: PreparedBlobIntent): number | undefined {
  const text = prepared.bytesBase64;
  if (text === undefined) return undefined;
  return (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
}

/** A held receipt as the outcome its delivery selected. */
function outcomeOfReceipt(receipt: BlobReceipt): HostedBlobDeliveryOutcome {
  if (receipt.result.ok) return { kind: "committed", receipt: receipt as Extract<BlobReceipt, { result: { ok: true } }> };
  const failed = receipt as Extract<BlobReceipt, { result: { ok: false } }>;
  if (failed.result.error.code === "version_conflict") return { kind: "conflict", receipt: failed };
  return { kind: "refused", code: failed.result.error.code, message: failed.result.error.message, receipt: failed };
}

/**
 * Drive one journaled blob intent: admit it (`admit`), make the fresh durable claim, deliver it
 * through `performHostedBlobDelivery`, persist the patch and retire a terminal record.
 *
 * - Every check that could fail inside the adapter's send (the capability, the advertised byte
 *   bound, the key and MIME grammar) runs before admission and again before a claim, against the
 *   one capabilities answer the adapter is handed.
 * - A claim proven never dispatched is rolled back to `pending` (typed `not_dispatched`), so it
 *   stays resendable: nothing reached the carrier (credentials, an aborted signal, a malformed
 *   identity, a local precondition), or the carrier refused it `denied`, which by its contract
 *   means nothing left. Anything after the carrier was invoked is `unknown`, lookup-only.
 * - A failure to admit or to claim is thrown with nothing sent. A failure to record the outcome
 *   is not thrown: the record stays for a later lookup and `persisted` is false.
 */
export function driveJournaledBlob(journal: BlobJournaledBackend, context: JournaledBlobContext, requestId: string, mode: JournaledBlobMode): Promise<JournaledBlobResult> {
  return drive(journal, context, requestId, mode, undefined);
}

type LookupAnswer = Awaited<ReturnType<HostedBlobWriteAdapter["lookup"]>>;

/** The owner; `answered` replays one lookup answer already obtained (a forget's), so it is not asked twice. */
async function drive(journal: BlobJournaledBackend, context: JournaledBlobContext, requestId: string, mode: JournaledBlobMode, answered: LookupAnswer | undefined): Promise<JournaledBlobResult> {
  const scope = captureJournalValue({ ...context.scope });
  const { carrier, premises } = context;
  const capabilities = once(context.capabilities);
  const delivery = { ...(context.delivery ?? {}) };
  const signal = context.signal;
  const copied = { ...mode } as { start: string; prepared?: string; acceptDeletes?: number };
  if (typeof requestId !== "string" || !isWriteRequestId(requestId)) throw new TypeError("a blob drive names a request identity");
  if (!["admit", "settle", "lookup"].includes(copied.start)) throw new TypeError("unknown blob drive start");
  if (copied.acceptDeletes !== undefined && (copied.start === "lookup" || !isAcceptedDeletionCount(copied.acceptDeletes))) throw new TypeError("acceptDeletes is a deletion count from 1 to 100,000, for a submission");

  async function guarded<T>(key: string, step: BlobDriveStep, run: (options: BlobJournalMutationOptions, snapshot: BlobDriveSnapshot) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = premises ? await premises.snapshot(key, step) : { guard: (await journal.readBlobWithJournal(key)).guard };
      try {
        return await run(mutationOptions(snapshot), snapshot);
      } catch (error) {
        // The guard covers every intent on the key, of any bundle: a write of another bundle or
        // another client sharing the journal moves it without touching this record. Read again.
        if (!(error instanceof JournalGuardConflict) || error instanceof BlobAdmissionConflict || attempt >= GUARD_ATTEMPTS) throw error;
      }
    }
  }

  async function retire(record: BlobIntentRecord): Promise<boolean> {
    try {
      await guarded(record.target, { kind: "retire", record }, (options) => journal.retireBlobIntents(record.target, [record.requestId], options));
      return true;
    } catch {
      // The receipt is durable; a later lookup, settle or heldBlobWrites sweeps it.
      return false;
    }
  }

  /** Persist a delivery's patch (unless it changes nothing), then retire a terminal record. */
  async function persist(row: BlobIntentRecord, result: HostedBlobDeliveryResult, submitted: boolean): Promise<JournaledBlobResult> {
    const { patch } = result;
    const unchanged = patch.receipt === undefined && patch.notAppliedThrough === undefined && patch.state === row.state && patch.attempts === row.attempts;
    let saved = row;
    let persisted = true;
    if (!unchanged) {
      try {
        saved = await guarded(row.target, { kind: "persist", record: row, patch }, (options) => journal.updateBlobIntent(row.requestId, row.state, patch, options));
      } catch {
        persisted = false;
      }
    }
    const retired = persisted && saved.receipt !== undefined ? await retire(saved) : false;
    return { kind: "delivered", record: saved, outcome: result.outcome, submitted, lookups: result.lookups, persisted, retired };
  }

  async function rollBack(claimed: BlobIntentRecord, code: BlobNotDispatchedCode, cause: unknown): Promise<JournaledBlobResult> {
    const patch = blobNonExecutionPatch(claimed, { kind: "not_dispatched", code });
    try {
      const saved = await guarded(claimed.target, { kind: "persist", record: claimed, patch }, (options) => journal.updateBlobIntent(claimed.requestId, "in_flight", patch, options));
      return { kind: "not-dispatched", record: saved, code, ...(cause === undefined ? {} : { cause }), rolledBack: true };
    } catch {
      return { kind: "not-dispatched", record: claimed, code, ...(cause === undefined ? {} : { cause }), rolledBack: false };
    }
  }

  /**
   * Deliver `row` through an adapter that records whether its one send reached the carrier, and
   * how the carrier answered, before the send returned.
   */
  async function deliver(row: BlobIntentRecord, start: "submit-claimed" | "lookup", acceptDeletes: number | undefined): Promise<JournaledBlobResult> {
    const prepared = decodePreparedBlobIntent(row.prepared);
    const halt = new AbortController();
    const userAborted = () => signal?.aborted === true;
    const probe = {
      sending: false,
      calls: 0,
      denied: undefined as HostedCarrierError | undefined,
      /** The send's one carrier call, settled either way (never rejecting). */
      pending: undefined as Promise<void> | undefined,
      /** The send wrapper's own completion: a cancelled delivery returns before it records its evidence. */
      finished: undefined as Promise<void> | undefined,
      settled: undefined as { calls: number; denied: HostedCarrierError | undefined; ended: boolean } | undefined,
      /** The send's own lifetime, which the delivery's deadline as well as the caller can end. */
      lifetime: undefined as AbortSignal | undefined,
    };
    const identity = prepared.identity;
    const identityValid = isWriteRequestId(identity.requestId) && isWriteBinding(identity.binding) && (identity.via === undefined || isAgentLabelVia(identity.via));
    /** Why a send that never reached the host did not: `undefined` when it may have. */
    const notDispatched = (): BlobNotDispatchedCode | undefined => {
      const seen = probe.settled ?? { calls: probe.calls, denied: undefined, ended: false };
      if (seen.calls === 0) return userAborted() || seen.ended ? "aborted" : identityValid ? "precondition_failed" : "invalid_identity";
      // The carrier contract: `denied` means nothing left (no credential, or refused before sending).
      if (seen.calls === 1 && seen.denied) {
        if (userAborted() || seen.ended) return "aborted";
        if (!identityValid) return "invalid_identity";
        return seen.denied.cause !== undefined ? "credentials_unavailable" : "credentials_denied";
      }
      return undefined;
    };
    const watch = <T>(call: () => Promise<T>): Promise<T> => {
      const counted = probe.sending;
      if (counted) probe.calls += 1;
      const answer = Promise.resolve().then(call);
      if (counted) {
        probe.pending = answer.then(
          () => undefined,
          (error: unknown) => {
            if (probe.sending && error instanceof HostedCarrierError && error.code === "denied") probe.denied ??= error;
          },
        );
      }
      return answer;
    };
    const watched: HostedCarrier = {
      json: (route, input, s, options) => watch(() => carrier.json(route, input, s, options)),
      stream: (route, input, s) => watch(() => carrier.stream(route, input, s)),
      ...(carrier.bytes ? { bytes: (route: string, body: Uint8Array, s: AbortSignal, options: Parameters<NonNullable<HostedCarrier["bytes"]>>[3]) => watch(() => carrier.bytes!(route, body, s, options)) } : {}),
    };
    const adapterFor = (lifetime: AbortSignal): HostedBlobWriteAdapter => {
      probe.lifetime = lifetime;
      const inner = createHostedBlobWriteAdapter({ carrier: watched, bundleId: scope.bundleId, prefix: scope.prefix, signal: lifetime, capabilities });
      return {
        async send(intent, id, bytes) {
          probe.sending = true;
          let finish!: () => void;
          probe.finished = new Promise<void>((resolve) => { finish = resolve; });
          try {
            return await inner.send(intent, id, bytes);
          } finally {
            // An abort ends the send before the carrier answers; the carrier sees the same abort
            // and settles at once, and its own answer (denied: nothing left) is the evidence.
            if ((userAborted() || probe.lifetime?.aborted) && probe.calls === 1 && probe.pending) await settledWithin(probe.pending, CARRIER_SETTLE_MS);
            probe.sending = false;
            probe.settled = { calls: probe.calls, denied: probe.denied, ended: probe.lifetime?.aborted === true };
            // Proven not sent: stop here, with no lookup of an identity the host never saw.
            if (notDispatched() !== undefined) halt.abort();
            finish();
          }
        },
        lookup: (intent, id) => (answered === undefined ? inner.lookup(intent, id) : Promise.resolve(answered)),
      };
    };
    let result: HostedBlobDeliveryResult;
    try {
      result = await performHostedBlobDelivery({ scope, adapterFor }, row, {
        start,
        signal: signal ? AbortSignal.any([signal, halt.signal]) : halt.signal,
        ...(acceptDeletes === undefined ? {} : { acceptDeletes }),
        ...(delivery.deadlineMs === undefined ? {} : { deadlineMs: delivery.deadlineMs }),
        ...(delivery.maxLookups === undefined ? {} : { maxLookups: delivery.maxLookups }),
        ...(delivery.lookupDelayMs === undefined ? {} : { lookupDelayMs: delivery.lookupDelayMs }),
        ...(delivery.sleep === undefined ? {} : { sleep: delivery.sleep }),
      });
    } catch (error) {
      await probe.finished;
      if (start === "submit-claimed" && probe.calls === 0) return rollBack(row, notDispatched() ?? "precondition_failed", error);
      throw error;
    }
    // The send ends promptly once its lifetime is over (the adapter races it); wait for its evidence.
    await probe.finished;
    if (start === "submit-claimed" && result.outcome.kind === "unknown") {
      const code = notDispatched();
      if (code !== undefined) return rollBack(row, code, probe.settled?.denied);
    }
    return persist(row, result, start === "submit-claimed");
  }

  async function claimAndSubmit(record: BlobIntentRecord, acceptDeletes: number | undefined): Promise<JournaledBlobResult> {
    const claimed = await guarded(record.target, { kind: "claim", record }, (options) =>
      journal.updateBlobIntent(record.requestId, record.state, { state: "in_flight", attempts: record.attempts + 1 }, options),
    );
    const deletion = decodePreparedBlobIntent(claimed.prepared).intent.operationId === "blobs.delete.v1";
    return deliver(claimed, "submit-claimed", deletion ? acceptDeletes : undefined);
  }

  if (copied.start === "admit") {
    if (typeof copied.prepared !== "string") throw new TypeError("an admitted blob drive carries its prepared intent");
    const decoded = decodePreparedBlobIntent(copied.prepared);
    if (decoded.identity.requestId !== requestId) throw new TypeError("the prepared intent names another request identity");
    if (!equalJournalValue(decoded.scope, scope)) throw new TypeError("the prepared intent's target does not match the trusted scope");
    if (copied.acceptDeletes !== undefined && decoded.intent.operationId !== "blobs.delete.v1") throw new TypeError("acceptDeletes belongs only to a delete");
    // Nothing is journaled until the one answer the adapter will use admits the input.
    const answer = await capabilities();
    if (answer.blobWrites !== "allowed") return { kind: "not-served" };
    const check = admissionCheck(decoded, preparedByteLength(decoded), answer);
    if (!check.ok) return { kind: "not-admitted", reason: "precondition", check };
    // An abort before admission admits nothing; one after it is a claim rolled back, still held.
    signal?.throwIfAborted();
    let admitted: BlobIntentRecord;
    try {
      admitted = await guarded(decoded.intent.key, { kind: "admit", prepared: copied.prepared }, (options, snapshot) =>
        journal.admitPreparedBlob(copied.prepared!, { ...options, ...(snapshot.unsettled === undefined ? {} : { unsettled: [...snapshot.unsettled] }) }),
      );
    } catch (error) {
      if (error instanceof BlobAdmissionConflict) return { kind: "not-admitted", reason: "unsettled", unsettled: error.unsettled };
      throw error;
    }
    return claimAndSubmit(admitted, copied.acceptDeletes);
  }

  const record = await journal.readBlobIntent(requestId);
  if (!record) return { kind: "unrecorded" };
  const prepared = decodePreparedBlobIntent(record.prepared);
  if (!equalJournalValue(prepared.scope, scope)) return { kind: "scope-mismatch", record };
  if (record.receipt !== undefined) {
    // Settled before a crash kept it from retiring: sweep it now.
    return { kind: "delivered", record, outcome: outcomeOfReceipt(record.receipt), submitted: false, lookups: 0, persisted: true, retired: await retire(record) };
  }
  if (blobIntentResendable(record)) {
    if (copied.start === "lookup") return record.deletionHold ? { kind: "held", record, hold: record.deletionHold } : { kind: "unsent", record };
    if (record.deletionHold) {
      if (copied.acceptDeletes === undefined) return { kind: "held", record, hold: record.deletionHold };
      if (copied.acceptDeletes < record.deletionHold.deletions) throw new HostedBlobDeletionsNotAccepted(requestId, record.deletionHold, copied.acceptDeletes);
    }
    const answer = await capabilities();
    if (answer.blobWrites !== "allowed") return { kind: "not-served", record };
    const check = admissionCheck(prepared, preparedByteLength(prepared), answer);
    if (!check.ok) return { kind: "not-sendable", record, check };
    return claimAndSubmit(record, copied.acceptDeletes);
  }
  // Once an attempt may have left, the identity is only ever looked up: absence is never a resend.
  return deliver(record, "lookup", undefined);
}

/** What `forgetJournaledBlob` did. */
export type JournaledBlobForgetResult =
  | { readonly kind: "unrecorded" }
  | { readonly kind: "scope-mismatch"; readonly record: BlobIntentRecord }
  /** Only an `unknown` record may be forgotten; settle an `in_flight` one first. */
  | { readonly kind: "not-unknown"; readonly record: BlobIntentRecord }
  /** The lookup failed, was refused or malformed; nothing was forgotten. */
  | { readonly kind: "lookup-unavailable"; readonly record: BlobIntentRecord; readonly cause: unknown }
  | { readonly kind: "forgotten"; readonly record: BlobIntentRecord }
  /** The lookup found the recorded outcome, persisted and (when possible) retired as a delivery's. */
  | Extract<JournaledBlobResult, { kind: "delivered" }>;

/**
 * Forget an `unknown` record after one fresh lookup answers `absent`. The record is removed, not
 * settled: the earlier delivery may still commit, and only the host's compare-and-swap keeps a
 * later write from losing that update. A lookup that finds the outcome settles it instead.
 */
export async function forgetJournaledBlob(journal: BlobJournaledBackend, context: JournaledBlobContext, requestId: string): Promise<JournaledBlobForgetResult> {
  const scope = captureJournalValue({ ...context.scope });
  const { carrier, premises } = context;
  if (typeof journal.forgetBlobIntent !== "function") throw new TypeError("this blob journal cannot forget an intent");
  const record = typeof requestId === "string" ? await journal.readBlobIntent(requestId) : undefined;
  if (!record) return { kind: "unrecorded" };
  const prepared = decodePreparedBlobIntent(record.prepared);
  if (!equalJournalValue(prepared.scope, scope)) return { kind: "scope-mismatch", record };
  if (record.state !== "unknown" || record.receipt !== undefined || blobIntentResendable(record)) return { kind: "not-unknown", record };
  const lifetime = new AbortController();
  const lifetimeSignal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
  let answer;
  try {
    const adapter = createHostedBlobWriteAdapter({ carrier, bundleId: scope.bundleId, prefix: scope.prefix, signal: lifetimeSignal, capabilities: once(context.capabilities) });
    answer = await adapter.lookup(prepared.intent, prepared.identity);
  } catch (cause) {
    return { kind: "lookup-unavailable", record, cause };
  } finally {
    lifetime.abort();
  }
  if (answer.status !== "absent") {
    // The host recorded it: settle with that very answer, through the delivery's own validation.
    const settled = await drive(journal, { ...context, delivery: { maxLookups: 1 } }, requestId, { start: "lookup" }, answer);
    if (settled.kind === "delivered" && settled.outcome.kind !== "unknown") return settled;
    return { kind: "lookup-unavailable", record, cause: new Error("the host's recorded outcome does not answer this intent") };
  }
  const target = record.target;
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = premises ? await premises.snapshot(target, { kind: "forget", record }) : { guard: (await journal.readBlobWithJournal(target)).guard };
    try {
      await journal.forgetBlobIntent(requestId, mutationOptions(snapshot));
      return { kind: "forgotten", record };
    } catch (error) {
      if (!(error instanceof JournalGuardConflict) || attempt >= GUARD_ATTEMPTS) throw error;
    }
  }
}

// ── the client methods ──────────────────────────────────────────────────────────────────────

/** A head as a write's precondition: the version and content type it must find. */
export interface BlobPin {
  readonly version: Version;
  readonly contentType: string;
}

/** A create of an absent key, or a replace at exactly `expected` (a type-only change included). */
export type HostedBlobWriteInput =
  | { readonly key: string; readonly bytes: Uint8Array; readonly contentType: string; readonly expectAbsent: true; readonly expected?: never }
  | { readonly key: string; readonly bytes: Uint8Array; readonly contentType: string; readonly expected: BlobPin; readonly expectAbsent?: never };

export interface HostedBlobDeleteInput {
  readonly key: string;
  readonly expected: BlobPin;
}

export interface HostedBlobWriteOptions {
  /** The request identity, a lowercase UUID v4. Default: a fresh one. A held identity resumes its own write. */
  readonly requestId?: string;
  /** Ends this call's requests; an abort after sending leaves the outcome unknown. */
  readonly signal?: AbortSignal;
  /** A person's confirmation of the host's mass-delete hold: the count they accepted. Delete only. */
  readonly acceptDeletes?: number;
}

export type HostedBlobOperation = "create" | "replace" | "delete";

/**
 * A refusal's code. The host's own: a recorded refusal (`backend_unavailable`, ...), or one it
 * answers before dispatch and never records (`insufficient_scope`, `bundle_not_found`,
 * `request_capacity`), which is final for the identity when every earlier attempt was proven not
 * applied; after an unclear attempt the write stays `unknown` instead. Or one the client names
 * before sending (`invalid_input`, `scope_mismatch`, `unsettled_write`).
 */
export type HostedBlobRefusalCode =
  | "insufficient_scope"
  | "bundle_not_found"
  | "request_capacity"
  | "invalid_input"
  | "backend_unavailable"
  | "scope_mismatch"
  | "unsettled_write"
  | (string & {});

interface BlobResultBase {
  readonly requestId: string;
  readonly key: string;
  readonly operation: HostedBlobOperation;
}

export type HostedBlobWriteResult = BlobResultBase &
  (
    /** Applied. `head` is the new head, null after a delete; `changed` is false for a replace the head already matched. */
    | { readonly status: "committed"; readonly head: BlobHead | null; readonly changed?: boolean }
    /** The head is not at the expected pin (a create: the key exists). `actual` is the head now, or null for none. Final. */
    | { readonly status: "conflict"; readonly reason: "version_conflict"; readonly actual: BlobPin | null }
    /** Another write overlapped this one past the host's own retries; nothing was applied. Final. */
    | { readonly status: "conflict"; readonly reason: "concurrent_change"; readonly message: string }
    | { readonly status: "refused"; readonly code: HostedBlobRefusalCode; readonly message: string }
    /** The host holds this mass delete (`428 deletions_held`); nothing was applied. `settleBlobWrite` with `acceptDeletes` continues it. */
    | { readonly status: "held"; readonly deletions: number; readonly baseline: number }
    /** The host may or may not hold the write. `lookupBlobWrite` or `settleBlobWrite` asks again. */
    | { readonly status: "unknown" }
  );

export type HostedBlobLookupResult =
  | HostedBlobWriteResult
  /** No blob write is held under the identity: never recorded, or settled and retired. */
  | { readonly status: "unrecorded"; readonly requestId: string }
  /** Held, never sent (or proven not applied): nothing to look up. `settleBlobWrite` sends it. */
  | (BlobResultBase & { readonly status: "pending" });

export type HostedBlobForgetResult =
  | HostedBlobLookupResult
  /** Removed from the journal after an `absent` lookup. The earlier delivery may still commit; the host's compare-and-swap prevents a lost update. */
  | (BlobResultBase & { readonly status: "forgotten" })
  /** Not forgotten: the record is not `unknown`, or its lookup did not answer `absent`. Nothing changed. */
  | (BlobResultBase & { readonly status: "kept"; readonly reason: "not_unknown" | "lookup_unavailable"; readonly state: OperationState });

/** A blob write the journal holds unsettled. */
export interface HostedBlobHeldWrite {
  readonly requestId: string;
  readonly bundleId: string;
  /** The workspace slug the bundle was named in, or null. */
  readonly workspace: string | null;
  readonly key: string;
  readonly operation: HostedBlobOperation;
  readonly state: OperationState;
  readonly attempts: number;
  /** True when every attempt is proven not applied, so `settleBlobWrite` submits it. */
  readonly resendable: boolean;
  /** The host's mass-delete hold awaiting acceptance. */
  readonly hold?: { readonly deletions: number; readonly baseline: number };
  readonly createdAt: string;
}

/**
 * Nothing was sent, and the write stays held under `requestId`: `held` is true when it is
 * resendable (`settleBlobWrite` or the same `writeBlob` call sends it), false when the journal
 * could not record that and only a lookup may settle it. `reason` says why it was not sent.
 */
export class HostedBlobWriteNotSent extends Error {
  readonly code = "BLOB_WRITE_NOT_SENT";
  readonly requestId: string;
  readonly reason: BlobNotDispatchedCode;
  readonly held: boolean;
  constructor(requestId: string, reason: BlobNotDispatchedCode, held: boolean, options: { cause?: unknown; detail?: string } = {}) {
    super(`blob write ${requestId} was not sent (${reason}${options.detail ? `: ${options.detail}` : ""})`, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HostedBlobWriteNotSent";
    this.requestId = requestId;
    this.reason = reason;
    this.held = held;
  }
}

/** What blob writes need from a client: its write context, origin, journal and per-request and per-key chains. */
export interface HostedBlobContext extends HostedWriteContext {
  /** The client's origin as a target names it (`URL.origin`). */
  readonly origin: string;
  readonly blobJournal: BlobJournaledBackend;
  /** One chain per request identity and one per key, shared by a client and its `within` clients. */
  readonly blobLocks: Map<string, Promise<unknown>>;
}

const OPERATIONS = { "blobs.create.v1": "create", "blobs.replace.v1": "replace", "blobs.delete.v1": "delete" } as const;
const ROUTES = { "blobs.create.v1": "blob-create", "blobs.replace.v1": "blob-replace", "blobs.delete.v1": "blob-delete" } as const;
/** Refusals after which a held capabilities answer may be what went wrong. */
const DROPPING_BLOB_REFUSALS: ReadonlySet<string> = new Set(["insufficient_scope", "bundle_not_found", "invalid_input"]);
// `request_capacity` keeps the held answer: a quota says nothing about the bundle's capabilities.

/** Run `task` after every earlier task on `name` in `locks`. */
async function chained<T>(locks: Map<string, Promise<unknown>>, name: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  locks.set(name, settled);
  try {
    return await run;
  } finally {
    if (locks.get(name) === settled) locks.delete(name);
  }
}
const byRequest = <T>(context: HostedBlobContext, requestId: string, task: () => Promise<T>) => chained(context.blobLocks, `request:${requestId}`, task);
// The journal guard is keyed by key alone, across bundles: one chain per key keeps this client's
// own calls from moving each other's guard.
const byKey = <T>(context: HostedBlobContext, key: string, task: () => Promise<T>) => chained(context.blobLocks, `key:${key}`, task);

function baseOf(record: BlobIntentRecord): BlobResultBase {
  const { intent, identity } = decodePreparedBlobIntent(record.prepared);
  return { requestId: identity.requestId, key: intent.key, operation: OPERATIONS[intent.operationId] };
}

function resultOf(base: BlobResultBase, outcome: HostedBlobDeliveryOutcome): HostedBlobWriteResult {
  switch (outcome.kind) {
    case "committed": {
      const { receipt } = outcome;
      const result = receipt.result;
      return { ...base, status: "committed", head: receipt.head, ...(result.operationId === "blobs.delete.v1" ? {} : { changed: result.data.changed }) };
    }
    case "conflict": {
      const { error } = outcome.receipt.result;
      return { ...base, status: "conflict", reason: "version_conflict", actual: error.actual === null || error.actual === undefined ? null : { version: error.actual, contentType: error.actualContentType! } };
    }
    case "refused":
      if (outcome.code === "concurrent_change") return { ...base, status: "conflict", reason: "concurrent_change", message: outcome.message };
      return { ...base, status: "refused", code: outcome.code, message: outcome.message };
    case "not-executed":
      return { ...base, status: "held", deletions: outcome.details.deletions, baseline: outcome.details.baseline };
    case "unknown":
      return { ...base, status: "unknown" };
  }
}

/** The bundle's write side, read only when the owner first needs it. */
function lazySide(context: HostedBlobContext, workspace: string | null, bundleId: string, signal: AbortSignal) {
  let side: WriteSide | undefined;
  return {
    capabilities: async () => (await untilAborted((side ??= writeSide(context, workspace, bundleId)).answer, signal)).capabilities,
    drop: () => {
      if (side) dropWriteSide(context, workspace, bundleId, side);
    },
  };
}

function ownerContext(context: HostedBlobContext, bundleId: string, workspace: string | null, capabilities: () => Promise<HostedCapabilities>, signal: AbortSignal): JournaledBlobContext {
  return {
    scope: { origin: context.origin, prefix: context.prefix, bundleId, workspaceSlug: workspace },
    // A recorded write is sent and looked up in the workspace it was recorded in, whichever client asks.
    carrier: context.carrierFor(workspace),
    capabilities,
    signal,
    ...(context.lookupDelayMs === undefined ? {} : { delivery: { lookupDelayMs: context.lookupDelayMs } }),
  };
}

/** The client's answer for one drive; throws only when nothing was sent. */
function answerOf(context: HostedBlobContext, side: { drop(): void }, base: BlobResultBase, route: string, drive: JournaledBlobResult): HostedBlobLookupResult {
  switch (drive.kind) {
    case "not-admitted":
      return drive.reason === "precondition"
        ? { ...base, status: "refused", code: "invalid_input", message: `${drive.check.message}. Nothing was sent.` }
        : { ...base, status: "refused", code: "unsettled_write", message: `An earlier write of this key in this bundle is still unsettled (${drive.unsettled.join(", ")}); settle or forget it first. Nothing was sent.` };
    case "not-served":
      side.drop();
      throw new HostedBlobWritesNotServed(route);
    case "unrecorded":
      return { status: "unrecorded", requestId: base.requestId };
    case "scope-mismatch":
      return { ...base, status: "refused", code: "scope_mismatch", message: "This write was recorded for another host or sync prefix than this client's; settle it from a client of that target. Nothing was sent." };
    case "held":
      return { ...base, status: "held", deletions: drive.hold.deletions, baseline: drive.hold.baseline };
    case "unsent":
      return { ...base, status: "pending" };
    case "not-sendable":
      side.drop();
      throw new HostedBlobWriteNotSent(base.requestId, "precondition_failed", true, { detail: drive.check.message });
    case "not-dispatched":
      throw new HostedBlobWriteNotSent(base.requestId, drive.code, drive.rolledBack, drive.cause === undefined ? {} : { cause: drive.cause });
    case "delivered": {
      const result = resultOf(base, drive.outcome);
      if (result.status === "unknown" || (result.status === "refused" && DROPPING_BLOB_REFUSALS.has(result.code))) side.drop();
      return result;
    }
  }
}

function assertPin(pin: unknown, name: string): asserts pin is BlobPin {
  if (typeof pin !== "object" || pin === null || !isContentVersion((pin as BlobPin).version) || typeof (pin as BlobPin).contentType !== "string") throw new TypeError(`${name} is a pin: { version, contentType }`);
}
function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key === "") throw new TypeError("a blob write names its key");
}
function assertBundle(bundleId: unknown): asserts bundleId is string {
  if (typeof bundleId !== "string" || !isHostedBundleId(bundleId)) throw new TypeError("a blob write names a bare hosted bundle id");
}
function assertRequestId(requestId: unknown): void {
  if (requestId !== undefined && (typeof requestId !== "string" || !isWriteRequestId(requestId))) throw new TypeError("a request identity is a lowercase UUID v4");
}

/** Submit a new write, or resume the one held under the same identity. */
async function submit(context: HostedBlobContext, bundleId: string, intent: BlobWriteExpected, bytes: Uint8Array | undefined, options: HostedBlobWriteOptions): Promise<HostedBlobWriteResult> {
  const requestId = options.requestId ?? mintRequestId();
  const base: BlobResultBase = { requestId, key: intent.key, operation: OPERATIONS[intent.operationId] };
  const route = `${context.prefix}/${ROUTES[intent.operationId]}`;
  // The input alone (key policy, content types, the 16 MiB bound) is checked before any request.
  const input = checkBlobAdmission({
    operation: base.operation,
    key: intent.key,
    ...(intent.operationId === "blobs.delete.v1" ? {} : { contentType: intent.contentType }),
    ...(intent.operationId === "blobs.create.v1" ? {} : { expectedContentType: intent.expectedContentType }),
    ...(bytes === undefined ? {} : { byteLength: bytes.byteLength }),
  });
  if (!input.ok) return { ...base, status: "refused", code: "invalid_input", message: `${input.message}. Nothing was sent.` };
  const signal = writeSignal(context, options.signal);
  signal.throwIfAborted();
  return byRequest(context, requestId, () =>
    byKey(context, intent.key, async () => {
      signal.throwIfAborted();
      const known = await context.blobJournal.readBlobIntent(requestId);
      if (known) {
        const prior = decodePreparedBlobIntent(known.prepared).scope;
        if (prior.origin !== context.origin || prior.prefix !== context.prefix) {
          return { ...base, status: "refused", code: "scope_mismatch", message: "This request identity names a write recorded for another host or sync prefix than this client's; settle it from a client of that target. Nothing was sent." };
        }
        const sameTarget = prior.origin === context.origin && prior.prefix === context.prefix && prior.bundleId === bundleId;
        const sameWrite = sameTarget && equalJournalValue(decodePreparedBlobIntent(known.prepared).intent, intent);
        if (!sameWrite || prior.workspaceSlug !== context.workspace) {
          const message = sameWrite
            ? `This request identity names the same write in ${prior.workspaceSlug === null ? "no workspace" : `workspace '${prior.workspaceSlug}'`}; confirm it from that client. Nothing was sent.`
            : "This request identity already names a different blob write; nothing was sent.";
          return { ...base, status: "refused", code: "invalid_input", message };
        }
        return settleKnown(context, known, signal, options.acceptDeletes, "settle") as Promise<HostedBlobWriteResult>;
      }
      // Nothing has left yet: a failure to read the capabilities is the caller's typed error, and
      // the gate, the checks before admission and the adapter all use this one answer.
      const side = writeSide(context, context.workspace, bundleId);
      const { capabilities } = await untilAborted(side.answer, signal);
      const drop = { drop: () => dropWriteSide(context, context.workspace, bundleId, side) };
      if (capabilities.blobWrites !== "allowed") throw new HostedBlobWritesNotServed(route);
      const check = checkBlobAdmission({
        operation: base.operation,
        key: intent.key,
        ...(intent.operationId === "blobs.delete.v1" ? {} : { contentType: intent.contentType }),
        ...(intent.operationId === "blobs.create.v1" ? {} : { expectedContentType: intent.expectedContentType }),
        ...(bytes === undefined ? {} : { byteLength: bytes.byteLength }),
        maximumBytes: capabilities.blobWriteBytes ?? null,
      });
      if (!check.ok) return { ...base, status: "refused", code: "invalid_input", message: `${check.message}. Nothing was sent.` };
      // An abort before admission admits nothing: once admitted, a write is held until it settles.
      signal.throwIfAborted();
      const prepared = prepareBlobIntent(
        { scope: { origin: context.origin, prefix: context.prefix, bundleId, workspaceSlug: context.workspace }, intent, identity: { requestId, binding: context.binding }, createdAt: new Date().toISOString() },
        bytes,
      );
      const drive = await driveJournaledBlob(context.blobJournal, ownerContext(context, bundleId, context.workspace, async () => capabilities, signal), requestId, {
        start: "admit",
        prepared,
        ...(options.acceptDeletes === undefined ? {} : { acceptDeletes: options.acceptDeletes }),
      });
      return answerOf(context, drop, base, route, drive) as HostedBlobWriteResult;
    }),
  );
}

/** Settle or look up a held record, under its key's chain. */
async function settleKnown(context: HostedBlobContext, record: BlobIntentRecord, signal: AbortSignal, acceptDeletes: number | undefined, start: "settle" | "lookup"): Promise<HostedBlobLookupResult> {
  const { scope, intent } = decodePreparedBlobIntent(record.prepared);
  const base = baseOf(record);
  const side = lazySide(context, scope.workspaceSlug, scope.bundleId, signal);
  const deletion = intent.operationId === "blobs.delete.v1";
  const drive = await driveJournaledBlob(context.blobJournal, ownerContext(context, scope.bundleId, scope.workspaceSlug, side.capabilities, signal), record.requestId, {
    start,
    // A confirmation belongs to a delete's submission only; a lookup never carries one.
    ...(start === "settle" && deletion && acceptDeletes !== undefined ? { acceptDeletes } : {}),
  });
  return answerOf(context, side, base, `${context.prefix}/${ROUTES[intent.operationId]}`, drive);
}

/** Run `task` on a held record under its request and key chains, reading it again under both. */
async function withHeld<T>(context: HostedBlobContext, requestId: string, signal: AbortSignal, task: (record: BlobIntentRecord) => Promise<T>, absent: () => T): Promise<T> {
  signal.throwIfAborted();
  return byRequest(context, requestId, async () => {
    signal.throwIfAborted();
    const first = await context.blobJournal.readBlobIntent(requestId);
    if (!first) return absent();
    return byKey(context, first.target, async () => {
      const record = await context.blobJournal.readBlobIntent(requestId);
      return record ? task(record) : absent();
    });
  });
}

/** `HostedClient.writeBlob`. */
export function hostedWriteBlob(context: HostedBlobContext, bundleId: string, input: HostedBlobWriteInput, options: HostedBlobWriteOptions = {}): Promise<HostedBlobWriteResult> {
  assertBundle(bundleId);
  if (typeof input !== "object" || input === null) throw new TypeError("a blob write takes { key, bytes, contentType } with expectAbsent: true or expected");
  const { key, bytes, contentType } = input;
  assertKey(key);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("a blob write's bytes are a Uint8Array");
  if (typeof contentType !== "string") throw new TypeError("a blob write names its content type");
  const creates = input.expectAbsent === true;
  if (creates === (input.expected !== undefined)) throw new TypeError("a blob write takes exactly one of expectAbsent: true and expected");
  if (!creates) assertPin(input.expected, "expected");
  assertRequestId(options.requestId);
  if (options.acceptDeletes !== undefined) throw new TypeError("acceptDeletes belongs only to a delete");
  // Copied before any await, so a caller mutating its buffer cannot change what is recorded.
  const copy = new Uint8Array(bytes);
  const version = `sha256:${sha256HexOfBytes(copy)}` as Version;
  const intent: BlobWriteExpected = creates
    ? { operationId: "blobs.create.v1", key, expectedVersion: null, expectedContentType: null, version, contentType }
    : { operationId: "blobs.replace.v1", key, expectedVersion: input.expected!.version, expectedContentType: input.expected!.contentType, version, contentType };
  return submit(context, bundleId, intent, copy, options);
}

/** `HostedClient.deleteBlob`. */
export function hostedDeleteBlob(context: HostedBlobContext, bundleId: string, input: HostedBlobDeleteInput, options: HostedBlobWriteOptions = {}): Promise<HostedBlobWriteResult> {
  assertBundle(bundleId);
  if (typeof input !== "object" || input === null) throw new TypeError("a blob delete takes { key, expected }");
  assertKey(input.key);
  assertPin(input.expected, "expected");
  assertRequestId(options.requestId);
  if (options.acceptDeletes !== undefined && !isAcceptedDeletionCount(options.acceptDeletes)) throw new TypeError("acceptDeletes is a deletion count from 1 to 100,000");
  const intent: BlobWriteExpected = { operationId: "blobs.delete.v1", key: input.key, expectedVersion: input.expected.version, expectedContentType: input.expected.contentType };
  return submit(context, bundleId, intent, undefined, options);
}

/** `HostedClient.lookupBlobWrite`: one outcome lookup of a held write; it never sends the write. */
export function hostedLookupBlobWrite(context: HostedBlobContext, requestId: string, options: { signal?: AbortSignal } = {}): Promise<HostedBlobLookupResult> {
  const signal = writeSignal(context, options.signal);
  return withHeld(context, requestId, signal, (record) => settleKnown(context, record, signal, undefined, "lookup"), () => ({ status: "unrecorded", requestId }));
}

/**
 * `HostedClient.settleBlobWrite`: submit a held write whose every attempt is proven not applied
 * (pending or unknown, `attempts === notAppliedThrough`), otherwise look it up. An absent lookup
 * is `unknown`, never a resend.
 */
export function hostedSettleBlobWrite(context: HostedBlobContext, requestId: string, options: { signal?: AbortSignal; acceptDeletes?: number } = {}): Promise<HostedBlobLookupResult> {
  if (options.acceptDeletes !== undefined && !isAcceptedDeletionCount(options.acceptDeletes)) throw new TypeError("acceptDeletes is a deletion count from 1 to 100,000");
  const signal = writeSignal(context, options.signal);
  return withHeld(context, requestId, signal, (record) => settleKnown(context, record, signal, options.acceptDeletes, "settle"), () => ({ status: "unrecorded", requestId }));
}

/**
 * `HostedClient.forgetBlobWrite`: drop an `unknown` write after one fresh lookup answers `absent`.
 * The earlier delivery may still commit; the host's compare-and-swap prevents a lost update.
 */
export function hostedForgetBlobWrite(context: HostedBlobContext, requestId: string, options: { signal?: AbortSignal } = {}): Promise<HostedBlobForgetResult> {
  const signal = writeSignal(context, options.signal);
  return withHeld<HostedBlobForgetResult>(
    context,
    requestId,
    signal,
    async (record) => {
      const { scope, intent } = decodePreparedBlobIntent(record.prepared);
      const base = baseOf(record);
      const side = lazySide(context, scope.workspaceSlug, scope.bundleId, signal);
      const forgot = await forgetJournaledBlob(context.blobJournal, ownerContext(context, scope.bundleId, scope.workspaceSlug, side.capabilities, signal), requestId);
      switch (forgot.kind) {
        case "forgotten":
          return { ...base, status: "forgotten" };
        case "not-unknown":
          return { ...base, status: "kept", reason: "not_unknown", state: forgot.record.state };
        case "lookup-unavailable":
          return { ...base, status: "kept", reason: "lookup_unavailable", state: forgot.record.state };
        default:
          return answerOf(context, side, base, `${context.prefix}/${ROUTES[intent.operationId]}`, forgot);
      }
    },
    () => ({ status: "unrecorded", requestId }),
  );
}

/** `HostedClient.heldBlobWrites`: every unsettled blob write, after sweeping settled ones left by a crash. */
export async function hostedHeldBlobWrites(context: HostedBlobContext): Promise<HostedBlobHeldWrite[]> {
  for (const row of await context.blobJournal.listBlobIntents(["acknowledged", "conflict", "refused"])) {
    await withHeld(context, row.requestId, context.signal, (record) => settleKnown(context, record, context.signal, undefined, "lookup"), () => undefined).catch(() => undefined);
  }
  const held: HostedBlobHeldWrite[] = [];
  for (const row of await context.blobJournal.listBlobIntents()) {
    if (row.receipt !== undefined) continue;
    const { scope, intent, createdAt } = decodePreparedBlobIntent(row.prepared);
    held.push({
      requestId: row.requestId,
      bundleId: scope.bundleId,
      workspace: scope.workspaceSlug,
      key: intent.key,
      operation: OPERATIONS[intent.operationId],
      state: row.state,
      attempts: row.attempts,
      resendable: blobIntentResendable(row),
      ...(row.deletionHold ? { hold: { deletions: row.deletionHold.deletions, baseline: row.deletionHold.baseline } } : {}),
      createdAt,
    });
  }
  return held;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────

function blobReader(context: HostedBlobContext, bundleId: string, signal: AbortSignal) {
  return createHostedBlobReadAdapter({
    carrier: context.carrierFor(context.workspace),
    bundleId,
    prefix: context.prefix,
    signal,
    capabilities: async () => (await writeSide(context, context.workspace, bundleId).answer).capabilities,
  });
}

/** A host serving no blob reads is the route it lacks, as for writes. */
async function served<T>(route: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HostedReadAdapterError && error.code === "unsupported") throw new HostedRouteNotServed(route);
    throw error;
  }
}

/** `HostedClient.blobHeads`: the bundle's whole blob listing, verified against its digest. */
export function hostedBlobHeads(context: HostedBlobContext, bundleId: string, options: { signal?: AbortSignal } = {}): Promise<HostedBlobHeads> {
  assertBundle(bundleId);
  const signal = writeSignal(context, options.signal);
  return served(`${context.prefix}/blob-heads`, () => blobReader(context, bundleId, signal).heads());
}

/** `HostedClient.blobHead`: one key's head from the listing, or null when the key is absent. */
export async function hostedBlobHead(context: HostedBlobContext, bundleId: string, key: string, options: { signal?: AbortSignal } = {}): Promise<BlobHead | null> {
  assertKey(key);
  const listing = await hostedBlobHeads(context, bundleId, options);
  return listing.heads.find((head) => head.key === key) ?? null;
}

/**
 * `HostedClient.readBlob`: the bytes at exactly `pin`, verified against its length, digest and
 * content type; null when the key is no longer at that pin (the host's `409`).
 */
export async function hostedReadBlob(context: HostedBlobContext, bundleId: string, key: string, options: { pin: BlobPin; signal?: AbortSignal }): Promise<HostedBlobRead | null> {
  assertBundle(bundleId);
  assertKey(key);
  if (typeof options !== "object" || options === null) throw new TypeError("readBlob takes { pin }: a read names the version and content type it expects");
  assertPin(options.pin, "pin");
  const signal = writeSignal(context, options.signal);
  const pin = { key, version: options.pin.version, contentType: options.pin.contentType };
  try {
    return await served(`${context.prefix}/blob-read`, () => blobReader(context, bundleId, signal).read(pin));
  } catch (error) {
    if (error instanceof RemoteError && error.status === 409 && error.code === "version_conflict") return null;
    throw error;
  }
}
