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
 * - `resolveIntents` on either journaled mutation requires document CAS and the exact complete
 *   unsettled target journal. It retires those records atomically with the document, meta, and
 *   optional replacement intent, leaving acknowledged history untouched. Recovery may retire
 *   conflicts, refusals, and never-attempted pending successors, never uncertain delivery. The
 *   caller preserves recovery evidence in meta; retirement does not assert remote acceptance.
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
import { assertSafeConceptId } from "./paths.js";

/** Presence is independent of value: a stored undefined is not an absent row. */
export type MetaExpectation = { present: false } | { present: true; value: unknown };

/** A complete target snapshot and the explicitly named metadata premises for a mutation. */
export interface JournalGuard {
  target: ConceptId;
  document: { version: Version; raw: string } | null;
  intents: IntentRecord[];
  meta: { key: string; expected: MetaExpectation }[];
}

/** A full snapshot or metadata admission premise changed; nothing was written. */
export class JournalGuardConflict extends Error {
  override readonly name = "JournalGuardConflict";
  readonly target: string;
  constructor(target: string) {
    super(`journal guard for '${target}' does not match or is invalid`);
    this.target = target;
  }
}

/**
 * Guard values are acyclic plain records, arrays, and primitive values (including undefined).
 * Symbols, accessors, functions, and objects with other prototypes are refused. This restriction
 * applies only to guarded operations; the unguarded metadata store remains opaque.
 */
export function captureJournalValue<T>(value: T): T {
  const ancestors = new Set<object>();
  const check = (entry: unknown): void => {
    if (typeof entry === "function" || typeof entry === "symbol") throw new JournalGuardConflict("value");
    if (entry === null || typeof entry !== "object") return;
    if (ancestors.has(entry) || (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)) throw new JournalGuardConflict("value");
    ancestors.add(entry);
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== "string") throw new JournalGuardConflict("value");
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
      if (!("value" in descriptor) || (!descriptor.enumerable && !(Array.isArray(entry) && key === "length"))) throw new JournalGuardConflict("value");
      check(descriptor.value);
    }
    ancestors.delete(entry);
  };
  check(value);
  return structuredClone(value);
}

function equalJournalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJournalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function assertMetaExpectation(value: MetaExpectation): void {
  if (!value || typeof value !== "object" || typeof value.present !== "boolean" ||
      !equalJournalValue(Object.keys(value).sort(), (value.present ? ["present", "value"] : ["present"]).sort())) throw new JournalGuardConflict("meta");
}

export function captureJournalGuard(value: JournalGuard, target = value.target): JournalGuard {
  const guard = captureJournalValue(value);
  assertSafeConceptId(guard.target);
  if (guard.target !== target || !Array.isArray(guard.intents) || !Array.isArray(guard.meta) ||
      (guard.document !== null && (!guard.document || typeof guard.document.version !== "string" || typeof guard.document.raw !== "string"))) throw new JournalGuardConflict(target);
  const requests = new Set<string>(), sequences = new Set<number>(), keys = new Set<string>();
  for (const row of guard.intents) {
    if (!row || row.target !== target || typeof row.requestId !== "string" || requests.has(row.requestId) || !Number.isSafeInteger(row.sequence) || sequences.has(row.sequence)) throw new JournalGuardConflict(target);
    requests.add(row.requestId); sequences.add(row.sequence);
  }
  for (const row of guard.meta) {
    if (!row || typeof row.key !== "string" || keys.has(row.key)) throw new JournalGuardConflict(target);
    keys.add(row.key); assertMetaExpectation(row.expected);
  }
  return guard;
}

/** Compare all target records, including acknowledged history, and exact named row presence. */
export function assertJournalGuard(expected: JournalGuard, current: JournalGuard): void {
  const a = captureJournalGuard(expected), b = captureJournalGuard(current, a.target);
  a.intents.sort((x, y) => x.sequence - y.sequence); b.intents.sort((x, y) => x.sequence - y.sequence);
  a.meta.sort((x, y) => x.key.localeCompare(y.key)); b.meta.sort((x, y) => x.key.localeCompare(y.key));
  if (!equalJournalValue(a, b)) throw new JournalGuardConflict(a.target);
}

export interface IntentUpdateOptions {
  meta?: MetaRecord[];
  guard?: JournalGuard;
  /** Replaces persisted content without authoring metadata changes; requires a full guard. */
  document?: OkfDocument;
}

export interface MetaWriteOptions {
  expected?: MetaExpectation;
  /** Admission succeeds only when the entire journal is empty, in the same transaction. */
  requireEmptyJournal?: boolean;
}

/** Capture guarded updates before any asynchronous adapter work and protect original history. */
export function captureIntentUpdate(patch: IntentPatch, options: IntentUpdateOptions): { patch: IntentPatch; options: IntentUpdateOptions } {
  if (Object.hasOwn(options, "guard")) captureJournalValue({ patch, options });
  if (options.document && !options.guard) throw new JournalGuardConflict(options.document.id);
  const captured = structuredClone({ patch, options });
  if (options.guard) {
    captured.options.guard = captureJournalGuard(options.guard);
    const mutable = new Set(["state", "attempts", "acknowledgedVersion", "remote", "refusal", "finding", "updatedAt"]);
    if (Object.keys(patch).some(key => !mutable.has(key)) || (captured.options.document && captured.options.document.id !== captured.options.guard.target)) throw new JournalGuardConflict(captured.options.guard.target);
    assertJournalMetaChanges(captured.options.guard, captured.options.meta ?? [], undefined);
  }
  return captured;
}

export function captureMetaWrite(options: MetaWriteOptions): MetaWriteOptions {
  const result = captureJournalValue(options);
  if (Object.hasOwn(result, "expected")) assertMetaExpectation(result.expected!);
  if (result.requireEmptyJournal !== undefined && typeof result.requireEmptyJournal !== "boolean") throw new JournalGuardConflict("meta");
  return result;
}

export function assertMetaWrite(key: string, options: MetaWriteOptions, actual: MetaExpectation, intents: readonly IntentRecord[]): void {
  if (options.expected !== undefined && !equalJournalValue(captureJournalValue(options.expected), captureJournalValue(actual))) throw new JournalGuardConflict(key);
  if (options.requireEmptyJournal && intents.length !== 0) throw new JournalGuardConflict(key);
}

/** Metadata removal is admitted only with an explicit full-snapshot premise. */
export function assertJournalMetaChanges(guard: JournalGuard | undefined, puts: readonly MetaRecord[], removals: readonly string[] | undefined): void {
  if (guard) {
    captureJournalValue(puts);
    if (puts.some(row => !guard.meta.some(expected => expected.key === row.key))) throw new JournalGuardConflict(guard.target);
  }
  if (removals === undefined) return;
  if (!guard || !Array.isArray(removals) || removals.some(key => typeof key !== "string") || new Set(removals).size !== removals.length ||
      removals.some(key => puts.some(row => row.key === key) || !guard.meta.some(expected => expected.key === key))) throw new JournalGuardConflict(guard?.target ?? "meta");
}

/** A guarded write owns one target and creates a globally fresh journal identity. */
export function assertJournalIntentChanges(guard: JournalGuard | undefined, existingIdentity: IntentRecord | undefined, superseded: IntentRecord | undefined): void {
  if (guard && (existingIdentity !== undefined || (superseded !== undefined && superseded.target !== guard.target))) throw new JournalGuardConflict(guard.target);
}

/** Capture write options while retaining the existing synchronous metadata producer. */
export function captureJournalWriteOptions(options: JournaledWriteOptions): JournaledWriteOptions {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const data: Record<string, unknown> = {};
  let producer: JournaledWriteOptions["meta"];
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string") throw new JournalGuardConflict("options");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new JournalGuardConflict("options");
    if (key === "meta" && typeof descriptor.value === "function") producer = descriptor.value;
    else data[key] = descriptor.value;
  }
  const captured = captureJournalValue(data) as JournaledWriteOptions;
  if (producer) captured.meta = producer;
  return captured;
}

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

/** Recovery was composed against a different or unsafe unsettled journal snapshot. */
export class JournalSnapshotConflict extends Error {
  override readonly name = "JournalSnapshotConflict";
  readonly target: ConceptId;
  constructor(target: ConceptId) {
    super(`journal snapshot for '${target}' changed or cannot be resolved`);
    this.target = target;
  }
}

export function assertJournalResolutionOptions(target: ConceptId, options: JournaledWriteOptions | JournaledDeleteOptions): void {
  if (!options.resolveIntents) return;
  if (options.expectedVersion === undefined || options.requireSettled !== undefined ||
      ("intent" in options && options.intent !== undefined && options.intent.target !== target) ||
      ("supersede" in options && options.supersede !== undefined) || ("onHeld" in options && options.onHeld !== undefined)) {
    throw new JournalSnapshotConflict(target);
  }
}

/** Compare full records, not only state: a changed outcome or retry is new recovery evidence. */
export function assertJournalSnapshot(target: ConceptId, expected: IntentRecord[], current: IntentRecord[], freshRequestId?: string): void {
  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) &&
      equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  };
  const actual = current.filter(row => row.target === target && row.state !== "acknowledged");
  const ids = new Set(expected.map(row => row.requestId));
  if ((freshRequestId !== undefined && current.some(row => row.requestId === freshRequestId)) ||
      ids.size !== expected.length || actual.length !== expected.length || !expected.some(row => row.state === "conflict") ||
      expected.some(row => row.target !== target || !(row.state === "conflict" || row.state === "refused" || (row.state === "pending" && row.attempts === 0))) ||
      expected.some(row => !equal(row, actual.find(candidate => candidate.requestId === row.requestId)))) {
    throw new JournalSnapshotConflict(target);
  }
}

/** Options for {@link JournaledBackend.writeJournaled}. */
export interface JournaledWriteOptions extends WriteOptions {
  /** Full document, journal, and named metadata CAS, evaluated before any mutation. */
  guard?: JournalGuard;
  /** Remove named metadata in the guarded write; keys must not also be put by this write. */
  removeMeta?: readonly string[];
  /** Retire this exact complete unsettled target snapshot atomically with document and meta writes. */
  resolveIntents?: { expected: IntentRecord[] };
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
  /** As write recovery; requires document CAS even when the target is absent. */
  resolveIntents?: { expected: IntentRecord[] };
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
  /** All guarded writes, updates, replacements, and metadata admission share atomic CAS. */
  readonly journalSnapshotCas?: true;
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
  updateIntent(requestId: string, expectedState: OperationState, patch: IntentPatch, options?: IntentUpdateOptions): Promise<IntentRecord>;

  readMeta<T = unknown>(key: string): Promise<T | undefined>;

  writeMeta(key: string, value: unknown, options?: MetaWriteOptions): Promise<void>;
}
