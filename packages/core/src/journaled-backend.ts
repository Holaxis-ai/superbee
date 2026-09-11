/**
 * The journaled-backend seam: what a storage adapter must add to {@link StorageBackend} to host
 * a browser-local working copy whose synchronization is a durable intent journal. The engine
 * reads and writes through `StorageBackend`; the sync runtime reads and writes through this
 * seam. Any adapter that implements it and passes the journal rows of the contract kit can hold
 * the working copy, whatever it persists to.
 *
 * The contract a second adapter must meet:
 *
 * - {@link JournaledBackend.writeJournaled} is ONE transaction over documents, intents, and
 *   meta: the document compare-and-swap of `write`, plus (optionally) deleting a superseded
 *   intent, recording a new intent for the written bytes, and putting meta rows. Every step is
 *   conditional on every other: a failed document CAS records no intent, and a superseded
 *   intent whose state or attempts moved fails the whole write with {@link IntentStateConflict}
 *   so the caller composes against fresh state. With `requireSettled`, an unsettled intent on
 *   the target fails it with {@link IntentHoldConflict} before the document is touched; the
 *   check runs inside the write's own transaction, so an intent committed while the caller was
 *   awaiting the network still holds the target. A recorded intent starts `pending` with zero
 *   attempts, carries the written bytes as `content` and their version as `local`, and takes
 *   the next value of a monotonic per-store sequence. The sequence advances only for a write
 *   that commits.
 * - {@link JournaledBackend.deleteJournaled} is the deletion counterpart: ONE transaction that
 *   removes the document record under the same compare-and-swap, puts and removes meta rows
 *   with it, and honours `requireSettled` the same way, so a document the authority deleted
 *   leaves the working copy together with its shared base and never while a local edit holds
 *   it. An absent target is not a conflict: the meta changes still apply and the result says
 *   `absent`, as the plain `delete` answers absence with `false`. With `onHeld`, a hold is not a
 *   rejection but the third outcome: the deletion and its own meta changes do not apply, the
 *   `onHeld` meta rows apply instead, in the same transaction as the hold check, and the result
 *   says `held` and names the holder. A caller that must rewrite a held document's shared base
 *   (a pull reconciling a remote deletion) does it there, so no other realm can settle the
 *   holding intent between the refusal and the rewrite.
 * - {@link JournaledBackend.readWithJournal} is ONE snapshot: the document, every intent
 *   targeting it, and the named meta rows, read in one readonly transaction, so a write in
 *   another realm between separate reads can never show a caller a document of one moment
 *   beside a journal of another. Intents come back in local commit order (by `sequence`).
 * - {@link JournaledBackend.updateIntent} is a compare-and-swap on the intent's `state`: the
 *   patch applies only while the record is in `expectedState`, together with any meta rows, in
 *   one transaction. A different state or a missing record rejects with
 *   {@link IntentStateConflict} and writes nothing, so two realms (a stale tab, a worker) cannot
 *   both settle or both replace one intent.
 * - {@link JournaledBackend.listIntents} returns intents in local commit order (ascending
 *   `sequence`), optionally restricted to one or more states.
 * - {@link JournaledBackend.readMeta} and {@link JournaledBackend.writeMeta} are an opaque
 *   key-value store; what the rows mean belongs to the sync component that writes them.
 *
 * This module imports no Node builtin so it bundles for the browser. The IndexedDB adapter is
 * the shipping implementation; a test-only in-memory adapter proves the seam is not a
 * description of that one class.
 */

import type { OperationIntent, OperationState } from "./uncertain-write.js";
import type { ConceptId, DeleteOptions, OkfDocument, ReadResult, StorageBackend, Version, WriteOptions } from "./types.js";

/**
 * An intent's journal state was not the one the caller expected, or the intent is gone. Settling
 * and superseding are compare-and-swap operations on the intent's own record so two realms (a
 * stale tab, a worker) cannot both settle or both replace one intent.
 */
export class IntentStateConflict extends Error {
  override readonly name = "IntentStateConflict";
  readonly requestId: string;
  readonly expected: OperationState;
  readonly actual: OperationState | null;

  constructor(requestId: string, expected: OperationState, actual: OperationState | null) {
    super(
      actual === null
        ? `intent '${requestId}' does not exist (expected state '${expected}')`
        : `intent '${requestId}' is '${actual}', not '${expected}'`,
    );
    this.requestId = requestId;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A journaled write required that no unsettled intent hold its target, and one does. The local
 * edit that intent describes would otherwise be replaced while the authority has not accepted
 * it. The check runs inside the write's own transaction, so an intent committed while the caller
 * was awaiting the network still holds the target.
 */
export class IntentHoldConflict extends Error {
  override readonly name = "IntentHoldConflict";
  readonly target: ConceptId;
  readonly requestId: string;
  readonly state: OperationState;

  constructor(target: ConceptId, requestId: string, state: OperationState) {
    super(`'${target}' is held by intent '${requestId}' in state '${state}'`);
    this.target = target;
    this.requestId = requestId;
    this.state = state;
  }
}

/**
 * A journaled local write: the shared primitive's {@link OperationIntent} plus what the
 * working copy keeps for reconciliation. `sequence` is the local commit order; `after` names a
 * predecessor intent on the same target that must be acknowledged before this one is delivered.
 */
export interface IntentRecord extends OperationIntent {
  sequence: number;
  updatedAt: string;
  /** The serialized document at `base`, when the working copy held it; the three-way baseline. */
  baseContent: string | null;
  after?: string;
  /** Set when the authority committed the intent; equals `local` for a content-addressed token. */
  acknowledgedVersion?: Version;
  /** The shared head observed when the intent entered conflict. */
  remote?: { version: Version | null; content: string | null };
  refusal?: { code: string; message: string };
  /** A recorded observation the caller should surface, such as an acknowledged version that differs from `local`. */
  finding?: string;
}

/** The caller-supplied part of a new intent; the adapter fills content, version, sequence, and state. */
export type NewIntentRecord = Pick<IntentRecord, "requestId" | "kind" | "target" | "base" | "baseContent" | "createdAt"> &
  Partial<Pick<IntentRecord, "after">>;

/** An opaque key-value row in the meta store (bootstrap marker, per-document base, pause flag). */
export interface MetaRecord {
  key: string;
  value: unknown;
}

/** Options for {@link JournaledBackend.writeJournaled}. */
export interface JournaledWriteOptions extends WriteOptions {
  /** Record this intent in the same transaction as the document write. */
  intent?: NewIntentRecord;
  /** An unsettled intent this write composes over; deleted only while its state and attempts still match. */
  supersede?: { requestId: string; expectedState: OperationState; expectedAttempts: number };
  /** Meta rows to put in the same transaction, given the written bytes when a function. */
  meta?: MetaRecord[] | ((written: { version: Version; raw: string }) => MetaRecord[]);
  /**
   * Abort with {@link IntentHoldConflict} when any intent targeting `id` is in a state other than
   * `acknowledged`, read in the same transaction as the document write. A refresh from the
   * authority uses this so a local edit committed during its network round trip is never
   * replaced.
   */
  requireSettled?: boolean;
}

/** Options for {@link JournaledBackend.deleteJournaled}. */
export interface JournaledDeleteOptions extends DeleteOptions {
  /** Meta rows to put in the same transaction; they apply only when the deletion applies or the target is absent. */
  meta?: MetaRecord[];
  /** Meta keys to remove in the same transaction; a key with no row is not an error. Applied as `meta` is. */
  removeMeta?: readonly string[];
  /**
   * Refuse the deletion when any intent targeting `id` is in a state other than `acknowledged`,
   * read in the same transaction as the deletion. A pull that reconciles a remote deletion uses
   * this so a local edit is never discarded. Without `onHeld` the refusal rejects with
   * {@link IntentHoldConflict}; with it, the refusal is the `held` outcome.
   */
  requireSettled?: boolean;
  /**
   * What to apply instead when `requireSettled` refuses the deletion: these meta rows are put in
   * the same transaction as the hold check, and nothing else in the options applies. Only
   * meaningful with `requireSettled`.
   */
  onHeld?: { meta: MetaRecord[] };
}

/** What {@link JournaledBackend.deleteJournaled} did, in one transaction. */
export type JournaledDeleteResult =
  /** A record was removed; `meta` and `removeMeta` applied. */
  | { outcome: "deleted" }
  /** No record to remove; `meta` and `removeMeta` still applied. */
  | { outcome: "absent" }
  /** An unsettled intent holds the target and `onHeld` was given: its meta rows applied, nothing else did. */
  | { outcome: "held"; requestId: string; state: OperationState };

/** One document with everything the journal holds about it, read in one transaction. See {@link JournaledBackend.readWithJournal}. */
export interface JournaledReadResult {
  /** The parsed document and its version, or `null` when the store holds no record. */
  document: ReadResult | null;
  /** The exact stored serialization, the bytes `version` names; `null` when absent. */
  raw: string | null;
  /** Every intent targeting the id, in local commit order, whatever its state. */
  intents: IntentRecord[];
  /** The requested meta rows' values by key; a key with no row is absent from the map. */
  meta: Map<string, unknown>;
}

/** Fields a caller may change when settling or reclaiming an intent. */
export type IntentPatch = Partial<Omit<IntentRecord, "requestId" | "sequence" | "createdAt" | "kind" | "target">>;

/**
 * A {@link StorageBackend} that also journals local writes as intents and keeps opaque meta
 * rows, with the transaction and compare-and-swap guarantees stated in this module's header.
 */
export interface JournaledBackend extends StorageBackend {
  /**
   * One transaction over documents, intents, and meta: the document compare-and-swap of
   * `write`, plus (optionally) deleting a superseded intent, recording a new intent for the
   * written bytes, and putting meta rows. Every step is conditional on every other: a failed
   * document CAS records no intent, and a superseded intent whose state or attempts moved fails
   * the whole write with {@link IntentStateConflict} so the caller composes against fresh state. With
   * `requireSettled`, an unsettled intent on the target fails it with
   * {@link IntentHoldConflict} before the document is touched.
   */
  writeJournaled(
    id: ConceptId,
    doc: OkfDocument,
    options?: JournaledWriteOptions,
  ): Promise<{ version: Version; raw: string; intent: IntentRecord | null }>;

  /**
   * One transaction over documents, intents, and meta: the document compare-and-swap of
   * `delete`, plus putting and removing meta rows. With `requireSettled`, an unsettled intent on
   * the target refuses it before anything is touched: a rejection with
   * {@link IntentHoldConflict}, or, with `onHeld`, the `held` outcome with the `onHeld` meta rows
   * applied in the same transaction. Resolves `deleted` when a record was removed and `absent`
   * when the target was already absent; the meta changes apply in both of those cases, and a
   * mismatched `expectedVersion` against a present record rejects with `VersionConflict` and
   * changes nothing.
   */
  deleteJournaled(id: ConceptId, options?: JournaledDeleteOptions): Promise<JournaledDeleteResult>;

  /**
   * The document, every intent targeting it, and the named meta rows, from ONE readonly
   * transaction. A caller deriving where a document stands (its bytes against its shared base
   * and its journal) reads them here so a write in another realm between separate reads can
   * never show it a document of one moment beside a journal of another; with this snapshot a
   * mismatch is a genuine working-copy defect.
   */
  readWithJournal(id: ConceptId, options?: { meta?: readonly string[] }): Promise<JournaledReadResult>;

  /** Intents in local commit order, optionally restricted to one or more states. */
  listIntents(state?: OperationState | readonly OperationState[]): Promise<IntentRecord[]>;

  readIntent(requestId: string): Promise<IntentRecord | undefined>;

  /**
   * Compare-and-swap on an intent's `state`: the patch applies only while the record is in
   * `expectedState`, together with any meta rows, in one transaction. A different state or a
   * missing record rejects with {@link IntentStateConflict} and writes nothing.
   */
  updateIntent(requestId: string, expectedState: OperationState, patch: IntentPatch, options?: { meta?: MetaRecord[] }): Promise<IntentRecord>;

  readMeta<T = unknown>(key: string): Promise<T | undefined>;

  writeMeta(key: string, value: unknown): Promise<void>;
}
