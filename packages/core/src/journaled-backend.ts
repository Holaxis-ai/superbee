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
 *   with it, optionally supersedes an intent and records a deletion intent
 *   ({@link DOCUMENT_DELETE_KIND}) exactly as `writeJournaled` does for a write, and honours
 *   `requireSettled` the same way, so a document the authority deleted
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
 *   optional replacement intent, leaving acknowledged history untouched. Recovery may retire a
 *   chain whose head is a recorded conflict or refusal, with conflicted, refused, and
 *   never-attempted pending successors behind it, never uncertain delivery. The caller
 *   preserves recovery evidence in meta; retirement does not assert remote acceptance.
 * - {@link JournaledBackend.readWithJournal} is ONE snapshot: the document, every intent
 *   targeting it, and the named meta rows, read in one readonly transaction, so a write in
 *   another realm between separate reads can never show a caller a document of one moment
 *   beside a journal of another. Intents come back in local commit order (by `sequence`).
 * - {@link JournaledBackend.readHeads} is that snapshot over every document at once: each
 *   record's head (id, version, writer, time), its leading frontmatter parsed as `read` parses
 *   it, its exact bytes, every intent targeting it, and the meta rows the caller names for it,
 *   all from ONE readonly transaction, so every row describes the same moment. Bodies are
 *   never parsed. A record whose leading block does not parse is a row with `frontmatter`
 *   null and the parser's error, never a dropped row and never a failed listing. A caller that
 *   keeps less than the row (a version and a provenance, say) passes `project`, which maps
 *   each row as it is read so the listing over a large store never holds every document's
 *   stored bytes at once; the journal is read whole before the walk, so intents and the
 *   content they carry are held for its duration, as a single read holds them. Keys every row
 *   needs go in `shared`, read once. Rows come back in the order `list` orders ids.
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

import type { MalformedDocumentError } from "./frontmatter-contract.js";
import type { OperationIntent, OperationState } from "./uncertain-write.js";
import type { ConceptId, DeleteOptions, Frontmatter, OkfDocument, ReadResult, StorageBackend, Version, WriteOptions } from "./types.js";
import { assertSafeConceptId } from "./paths.js";
import { versionOfBytes } from "./versioning.js";

/**
 * The intent kind of a journaled local deletion: the document leaves at exactly the intent's
 * base. A deletion carries no bytes, so its `content` is {@link DELETION_CONTENT} and its `local`
 * is {@link DELETION_VERSION}, the version of empty bytes, which no document can have (every
 * document has frontmatter). A conflict can therefore never name a deletion's own `local` and
 * read as its commit.
 */
export const DOCUMENT_DELETE_KIND = "document.delete";
export const DELETION_CONTENT = "";
export const DELETION_VERSION: Version = versionOfBytes(DELETION_CONTENT);

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

export function captureJournalGuard(value: JournalGuard, target?: ConceptId): JournalGuard {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JournalGuardConflict(target ?? "guard");
  const guard = captureJournalValue(value);
  if (typeof guard.target !== "string") throw new JournalGuardConflict(target ?? "guard");
  target ??= guard.target;
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

/** Only omission or undefined selects the unguarded compatibility path. */
export function captureJournalGuardOption(options: { guard?: JournalGuard }, target?: ConceptId): JournalGuard | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, "guard");
  if (!descriptor) {
    if ("guard" in options) throw new JournalGuardConflict(target ?? "guard");
    return undefined;
  }
  if (!("value" in descriptor)) throw new JournalGuardConflict(target ?? "guard");
  return descriptor.value === undefined ? undefined : captureJournalGuard(descriptor.value, target);
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
  const guard = captureJournalGuardOption(options);
  if (guard !== undefined) captureJournalValue({ patch, options });
  if (options.document && guard === undefined) throw new JournalGuardConflict(options.document.id);
  const captured = structuredClone({ patch, options });
  if (guard !== undefined) {
    captured.options.guard = guard;
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

/** Capture every guarded deletion branch before evaluating held or absent state. */
export function captureJournalDeleteOptions(target: ConceptId, options: JournaledDeleteOptions): JournaledDeleteOptions {
  const guard = captureJournalGuardOption(options, target);
  if (guard === undefined) return options;
  const captured = captureJournalValue(options);
  captured.guard = guard;
  assertJournalMetaChanges(guard, captured.meta ?? [], captured.removeMeta);
  if (captured.onHeld !== undefined) {
    if (!captured.onHeld || !Array.isArray(captured.onHeld.meta)) throw new JournalGuardConflict(target);
    assertJournalMetaChanges(guard, captured.onHeld.meta, undefined);
  }
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
  /**
   * The shared head observed when the intent entered conflict. With `version: null` (deleted
   * remotely), `tombstone` is the deletion the authority named, when it named one: what a
   * deliberate re-create acknowledges. It is never a version a read serves.
   */
  remote?: { version: Version | null; content: string | null; tombstone?: Version };
  refusal?: { code: string; message: string };
  /** A recorded observation the caller should surface, such as an acknowledged version that differs from `local`. */
  finding?: string;
}

/** The caller-supplied part of a new intent; the adapter fills content, version, sequence, and state. */
export type NewIntentRecord = Pick<IntentRecord, "requestId" | "kind" | "target" | "base" | "baseContent" | "createdAt"> &
  Partial<Pick<IntentRecord, "after" | "recreates">>;

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

/**
 * The deletion intent a journaled deletion records, refused before any adapter work when it is
 * not one: another kind, another target, or combined with a guard (a guarded deletion journals
 * nothing). The adapter fills content, local version, sequence and state.
 */
export function assertDeletionIntent(target: ConceptId, options: JournaledDeleteOptions): void {
  if (options.intent === undefined && options.supersede === undefined) return;
  if (options.guard !== undefined || (options.intent !== undefined && (options.intent.kind !== DOCUMENT_DELETE_KIND || options.intent.target !== target))) {
    throw new JournalSnapshotConflict(target);
  }
}

/** The record a journaled deletion adds for `intent`. */
export function deletionIntentRecord(intent: NewIntentRecord, sequence: number, now: string): IntentRecord {
  return { ...intent, local: DELETION_VERSION, content: DELETION_CONTENT, sequence, attempts: 0, state: "pending", updatedAt: now };
}

export function assertJournalResolutionOptions(target: ConceptId, options: JournaledWriteOptions | JournaledDeleteOptions): void {
  if (!options.resolveIntents) return;
  if (options.expectedVersion === undefined || options.requireSettled !== undefined ||
      ("intent" in options && options.intent !== undefined && options.intent.target !== target) ||
      ("supersede" in options && options.supersede !== undefined) || ("onHeld" in options && options.onHeld !== undefined)) {
    throw new JournalSnapshotConflict(target);
  }
}

/**
 * Compare full records, not only state: a changed outcome or retry is new recovery evidence.
 * The head of the set (its lowest sequence) must hold a recorded terminal answer, `conflict` or
 * `refused`; every later row must be `conflict`, `refused` or never-attempted `pending`. An
 * `unknown`, `in_flight` or attempted `pending` head is uncertain delivery and stays refused.
 */
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
  const head = expected.reduce<IntentRecord | undefined>((lowest, row) => lowest === undefined || row.sequence < lowest.sequence ? row : lowest, undefined);
  if ((freshRequestId !== undefined && current.some(row => row.requestId === freshRequestId)) ||
      ids.size !== expected.length || actual.length !== expected.length || head === undefined || !(head.state === "conflict" || head.state === "refused") ||
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
  /** Compare the full target and named metadata before any deleted, absent, or held outcome. */
  guard?: JournalGuard;
  /** As write recovery; requires document CAS even when the target is absent. */
  resolveIntents?: { expected: IntentRecord[] };
  /** Meta rows to put in the same transaction; they apply only when the deletion applies or the target is absent. */
  meta?: MetaRecord[];
  /** Meta keys to remove in the same transaction; a key with no row is not an error. Applied as `meta` is. */
  removeMeta?: readonly string[];
  /**
   * Record this deletion intent in the same transaction, as `writeJournaled` records a write's:
   * `pending`, zero attempts, the next sequence, with {@link DELETION_CONTENT} and
   * {@link DELETION_VERSION}. Its kind must be {@link DOCUMENT_DELETE_KIND}. It is recorded when
   * the deletion applies, including over an absent record (a resolution re-deleting a document
   * the working copy no longer holds), and never when the deletion is held.
   */
  intent?: NewIntentRecord;
  /** An unsettled intent this deletion composes over; removed only while its state and attempts still match, as for `writeJournaled`. */
  supersede?: { requestId: string; expectedState: OperationState; expectedAttempts: number };
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
  /** A record was removed; `meta` and `removeMeta` applied, and `intent` recorded when one was given. */
  | { outcome: "deleted"; intent?: IntentRecord }
  /** No record to remove; `meta` and `removeMeta` still applied, and `intent` recorded when one was given. */
  | { outcome: "absent"; intent?: IntentRecord }
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

/**
 * One document's head with everything the journal holds about it, as {@link JournaledBackend.readHeads}
 * reads it: the stored record's identity and version, its leading frontmatter, its exact
 * bytes, its intents, and the meta rows the caller named for it. Nothing of the body is parsed.
 * The frontmatter is what `read` parses for the record under the bundle's edition; when the
 * leading block does not parse it is `null` and `malformed` carries the parser's error.
 */
export type JournaledHead = {
  id: ConceptId;
  /** The version of the stored bytes, the token `read` reports for the document. */
  version: Version;
  /** The actor recorded for the stored revision. */
  updatedBy: string;
  /** When the stored revision was written, as an ISO instant. */
  updatedAt: string;
  /** The exact stored serialization, the bytes `version` names. */
  raw: string;
  /** Every intent targeting the id, in local commit order, whatever its state. */
  intents: IntentRecord[];
  /** The meta rows `meta` named for this id, by key; a key with no row is absent from the map. */
  meta: Map<string, unknown>;
} & ({ frontmatter: Frontmatter; malformed?: undefined } | { frontmatter: null; malformed: MalformedDocumentError });

/** Options for {@link JournaledBackend.readHeads}. */
export interface JournaledHeadsOptions<T> {
  /** The meta keys to read for one document, given its id and its intents; none by default. Read per row and released with it. */
  meta?: (id: ConceptId, intents: readonly IntentRecord[]) => readonly string[];
  /** Meta keys read once for the whole listing, in the same transaction, and present in every row's `meta`; a key named here is not read again when `meta` names it for a row. */
  shared?: readonly string[];
  /**
   * Maps each head as it is read; only the projection is kept, so a listing over a large store
   * holds one document's stored bytes at a time (the journal, read whole, is held throughout).
   * Omitted, the heads themselves are returned. A projection that throws rejects the whole
   * listing with its error.
   */
  project?: (head: JournaledHead) => T;
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

  /**
   * Every document's head, its leading frontmatter, its bytes, its intents, and the meta rows
   * `meta` names for it, from ONE readonly transaction, in the order `list` orders ids. A
   * caller that lists or counts the working copy reads here so every row describes the same
   * moment and no body is parsed; `project` keeps the listing's memory at one document at a
   * time. A record whose leading block does not parse is reported, not dropped.
   */
  readHeads<T = JournaledHead>(options?: JournaledHeadsOptions<T>): Promise<T[]>;

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
