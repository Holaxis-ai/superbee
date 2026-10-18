/** File-journal optional ordinary-file admission. Frozen payloads are data, never authority:
 * a dispatcher must compare their scope with its current trusted context before delivery. */
import { captureBlobWriteExpected, decodeBlobWriteResult, assertBlobKey, isBlobContentType, isSafeBlobKey, type BlobWriteExpected, type BlobWriteResult, type BlobHead } from "./blob-contract.js";
import { isHostedBundleId } from "./dependencies.js";
import { isAgentLabelVia, isWriteBinding, isWriteRequestId } from "./write-identity.js";
import { sha256HexOfBytes } from "./sha256.js";
import { captureJournalValue, equalJournalValue, assertMetaExpectation, IntentStateConflict, JournalGuardConflict, JournalSnapshotConflict, type MetaExpectation, type MetaRecord } from "./journaled-backend.js";
import type { OperationState } from "./uncertain-write.js";

export { isWriteRequestId } from "./write-identity.js";

export const BLOB_JOURNAL_BOUNDS = Object.freeze({ rawBytes: 16 * 1024 * 1024, preparedBytes: 24 * 1024 * 1024,
  /** The file codec checks the actual tagged encoding, not an estimate of JSON text. */
  terminalReceiptBytes: 128 * 1024,
  settlementStructureBytes: 4 * 1024,
  /** Aggregate encoded metadata growth ordinarily needed for the settled byte+MIME baseline. */
  baselineBytes: 16 * 1024,
});
export interface BlobTargetScope { origin: string; prefix: string; bundleId: string; workspaceSlug: string | null }
export interface BlobPreparedInput {
  scope: BlobTargetScope;
  intent: BlobWriteExpected;
  identity: { requestId: string; binding: string; via?: string };
  createdAt: string;
}
export interface PreparedBlobIntent extends BlobPreparedInput { schemaVersion: 1; bytesBase64?: string }
export type BlobReceipt =
  | { scope: BlobTargetScope; result: Extract<BlobWriteResult, { ok: true }>; head: BlobHead | null; removed?: BlobHead }
  | { scope: BlobTargetScope; result: Extract<BlobWriteResult, { ok: false }> };
export interface BlobDeletionHold { deletions: number; baseline: number }
/** Bounded diagnostics, never acceptance or a terminal receipt. */
export function captureBlobDeletionHold(value: BlobDeletionHold): BlobDeletionHold {
  const hold = captureJournalValue(value);
  if (!object(hold) || !only(hold, ["deletions", "baseline"]) || ![hold.deletions, hold.baseline].every(n => Number.isSafeInteger(n) && n >= 1)) throw new TypeError("invalid blob deletion hold");
  return hold;
}
/**
 * Why a claimed attempt is proven never to have left the process. Only for this invocation's own
 * claim, made through the same open journal, and only for a failure before the carrier is invoked
 * (credentials, an already-aborted signal, a malformed identity, a local precondition) or the
 * carrier's own `denied`, which by its contract means nothing left. Any other carrier or transport
 * failure, and any claim found at open, may have been sent: that is `unknown`.
 */
export const BLOB_NOT_DISPATCHED_CODES = Object.freeze(["credentials_unavailable", "credentials_denied", "aborted", "invalid_identity", "precondition_failed"] as const);
export type BlobNotDispatchedCode = (typeof BLOB_NOT_DISPATCHED_CODES)[number];
export interface BlobNotDispatched { code: BlobNotDispatchedCode }
export function captureBlobNotDispatched(value: BlobNotDispatched): BlobNotDispatched {
  const evidence = captureJournalValue(value);
  if (!object(evidence) || !only(evidence, ["code"]) || !(BLOB_NOT_DISPATCHED_CODES as readonly unknown[]).includes(evidence.code)) throw new TypeError("invalid blob not-dispatched evidence");
  return evidence;
}
/** Typed proof that the latest claimed attempt was not applied. A deletion hold is the host's
 * `428 deletions_held`; not-dispatched is a local failure before any request left. */
export type BlobNonExecution = ({ kind: "deletion_hold" } & BlobDeletionHold) | ({ kind: "not_dispatched" } & BlobNotDispatched);
export interface BlobIntentRecord {
  recordFamily: "blob";
  requestId: string;
  target: string;
  /** The ONE canonical frozen payload, including raw bytes when this is a create/replace. */
  prepared: string;
  sequence: number;
  attempts: number;
  state: OperationState;
  updatedAt: string;
  receipt?: BlobReceipt;
  /** Proven non-execution for every attempt through this count; omitted means zero. */
  notAppliedThrough?: number;
  deletionHold?: BlobDeletionHold;
  /** The latest not-dispatched evidence inside the prefix; absent in records written before it existed. */
  notDispatched?: BlobNotDispatched;
}
export interface BlobJournalGuard {
  key: string;
  intents: BlobIntentRecord[];
  meta: { key: string; expected: MetaExpectation }[];
}
export interface BlobJournalRead { key: string; intents: BlobIntentRecord[]; meta: Map<string, unknown>; guard: BlobJournalGuard }
export interface BlobJournalMutationOptions { guard: BlobJournalGuard; meta?: MetaRecord[]; removeMeta?: string[] }
export interface BlobIntentPatch { state?: OperationState; attempts?: number; receipt?: BlobReceipt; notAppliedThrough?: number; deletionHold?: BlobDeletionHold; notDispatched?: BlobNotDispatched }
/** Admission options. `unsettled` names, exactly, the receipt-less intents on the same bundle and
 * key that this admission knowingly stands beside; without it such an intent refuses admission. */
export interface BlobAdmitOptions extends BlobJournalMutationOptions { unsettled?: readonly BlobIntentRecord[] }
export interface BlobJournaledBackend {
  /** Optional file-only atomic metadata mutation under the complete same-key/named-meta guard. */
  writeBlobMeta?(key: string, changes: Pick<BlobJournalMutationOptions, "meta" | "removeMeta">, options: { guard: BlobJournalGuard }): Promise<void>;
  readBlobWithJournal(key: string, options?: { meta?: readonly string[] }): Promise<BlobJournalRead>;
  admitPreparedBlob(prepared: string, options: BlobAdmitOptions): Promise<BlobIntentRecord>;
  listBlobIntents(state?: OperationState | readonly OperationState[]): Promise<BlobIntentRecord[]>;
  readBlobIntent(requestId: string): Promise<BlobIntentRecord | undefined>;
  updateBlobIntent(requestId: string, expectedState: OperationState, patch: BlobIntentPatch, options: BlobJournalMutationOptions): Promise<BlobIntentRecord>;
  retireBlobIntents(key: string, requestIds: readonly string[], options: BlobJournalMutationOptions): Promise<void>;
  /**
   * Remove one receipt-less `unknown` intent on the guard's key, on the caller's own evidence that
   * its identity is absent on the host. Not a receipt: an earlier delivery may still commit, and
   * the host's compare-and-swap is what keeps that from losing an update. Optional, so a journal
   * written before it existed still satisfies the interface.
   */
  forgetBlobIntent?(requestId: string, options: BlobJournalMutationOptions): Promise<void>;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v: object, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const timestamp = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
function captureInput(value: BlobPreparedInput): BlobPreparedInput {
  const v = captureJournalValue(value);
  if (!object(v) || !only(v, ["scope", "intent", "identity", "createdAt"]) || !timestamp(v.createdAt) || !object(v.scope) || !only(v.scope, ["origin", "prefix", "bundleId", "workspaceSlug"]) || !object(v.identity) || !only(v.identity, ["requestId", "binding", "via"])) throw new TypeError("invalid prepared blob input");
  const { scope, identity } = v;
  if (typeof scope.origin !== "string" || scope.origin.length > 2048 || typeof scope.prefix !== "string" || scope.prefix.length > 512 || !/^\/(?:[a-zA-Z0-9._~-]+\/)*[a-zA-Z0-9._~-]+$/.test(scope.prefix) || scope.prefix.split("/").some(part => part === "." || part === "..") || typeof scope.bundleId !== "string" || !isHostedBundleId(scope.bundleId) || !(scope.workspaceSlug === null || typeof scope.workspaceSlug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(scope.workspaceSlug))) throw new TypeError("invalid blob target scope");
  let origin: URL;
  try { origin = new URL(scope.origin); } catch { throw new TypeError("invalid blob target origin"); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== scope.origin) throw new TypeError("invalid blob target origin");
  if (typeof identity.requestId !== "string" || !isWriteRequestId(identity.requestId) || typeof identity.binding !== "string" || !isWriteBinding(identity.binding) || identity.via !== undefined && !isAgentLabelVia(identity.via)) throw new TypeError("invalid blob prepared identity");
  const original = captureBlobWriteExpected(v.intent);
  const pins = { operationId: original.operationId, key: original.key, expectedVersion: original.expectedVersion, expectedContentType: original.expectedContentType };
  const intent = (original.operationId === "blobs.delete.v1" ? pins : { ...pins, version: original.version, contentType: original.contentType }) as BlobWriteExpected;
  return { scope: { origin: scope.origin, prefix: scope.prefix, bundleId: scope.bundleId, workspaceSlug: scope.workspaceSlug }, intent, identity: { requestId: identity.requestId, binding: identity.binding, ...(identity.via === undefined ? {} : { via: identity.via }) }, createdAt: v.createdAt };
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
function checkedPayload(input: BlobPreparedInput, bytes?: Uint8Array): PreparedBlobIntent {
  const captured = captureInput(input);
  const deletion = captured.intent.operationId === "blobs.delete.v1";
  if (deletion ? bytes !== undefined : !(bytes instanceof Uint8Array) || bytes.byteLength > BLOB_JOURNAL_BOUNDS.rawBytes) throw new TypeError("invalid prepared blob bytes");
  if (captured.intent.operationId !== "blobs.delete.v1" && `sha256:${sha256HexOfBytes(bytes!)}` !== captured.intent.version) throw new TypeError("prepared blob digest does not match bytes");
  return { schemaVersion: 1, ...captured, ...(deletion ? {} : { bytesBase64: base64(bytes!) }) };
}
export function prepareBlobIntent(input: BlobPreparedInput, bytes?: Uint8Array): string {
  const payload = JSON.stringify(checkedPayload(input, bytes === undefined ? undefined : new Uint8Array(bytes)));
  if (new TextEncoder().encode(payload).byteLength > BLOB_JOURNAL_BOUNDS.preparedBytes) throw new RangeError("prepared blob exceeds its byte bound");
  return payload;
}
/**
 * Payloads already validated, keyed by the payload text itself: validation is a pure function of
 * that text, and one write validates its record's payload many times (every guard and transition
 * re-captures it). Bounded by count and by payload length, oldest out first; each hit still
 * returns a fresh copy, so no caller shares or can change a cached value.
 */
const DECODED = new Map<string, PreparedBlobIntent>();
const DECODED_ENTRIES = 8;
const DECODED_CHARS = 32 * 1024 * 1024;
let decodedChars = 0;
function copyPrepared(value: PreparedBlobIntent): PreparedBlobIntent {
  return { ...value, scope: { ...value.scope }, intent: { ...value.intent }, identity: { ...value.identity } };
}
export function decodePreparedBlobIntent(payload: string): PreparedBlobIntent {
  const cached = typeof payload === "string" ? DECODED.get(payload) : undefined;
  if (cached) return copyPrepared(cached);
  const decoded = decodeUncachedPreparedBlobIntent(payload);
  if (payload.length <= DECODED_CHARS) {
    DECODED.set(payload, copyPrepared(decoded));
    decodedChars += payload.length;
    for (const key of DECODED.keys()) {
      if (DECODED.size <= DECODED_ENTRIES && decodedChars <= DECODED_CHARS) break;
      DECODED.delete(key);
      decodedChars -= key.length;
    }
  }
  return decoded;
}
function decodeUncachedPreparedBlobIntent(payload: string): PreparedBlobIntent {
  if (typeof payload !== "string" || payload.length > BLOB_JOURNAL_BOUNDS.preparedBytes || new TextEncoder().encode(payload).byteLength > BLOB_JOURNAL_BOUNDS.preparedBytes) throw new TypeError("invalid prepared blob payload");
  const value: unknown = JSON.parse(payload);
  if (!object(value) || !only(value, ["schemaVersion", "scope", "intent", "identity", "createdAt", "bytesBase64"]) || value.schemaVersion !== 1) throw new TypeError("invalid prepared blob schema");
  const { schemaVersion: _schema, bytesBase64, ...input } = value;
  let bytes: Uint8Array | undefined;
  if (bytesBase64 !== undefined) {
    if (typeof bytesBase64 !== "string" || bytesBase64.length > Math.ceil(BLOB_JOURNAL_BOUNDS.rawBytes / 3) * 4) throw new TypeError("invalid prepared blob base64");
    bytes = Uint8Array.from(atob(bytesBase64), c => c.charCodeAt(0));
    if (base64(bytes) !== bytesBase64) throw new TypeError("noncanonical prepared blob base64");
  }
  const checked = checkedPayload(input as unknown as BlobPreparedInput, bytes);
  if (JSON.stringify(checked) !== payload) throw new TypeError("noncanonical prepared blob payload");
  return captureJournalValue(checked);
}
export function blobReceipt(prepared: string, raw: unknown): BlobReceipt {
  const original = decodePreparedBlobIntent(prepared);
  const result = decodeBlobWriteResult(raw, original.intent);
  if (!result.ok) {
    if (result.error.writeState !== "not_applied") throw new TypeError("uncertain blob result is not a terminal receipt");
    return { scope: original.scope, result };
  }
  const head = { key: result.data.key, version: result.data.version, contentType: result.data.contentType };
  return result.operationId === "blobs.delete.v1" ? { scope: original.scope, result, head: null, removed: head } : { scope: original.scope, result, head };
}
export function captureBlobIntentRecord(value: BlobIntentRecord): BlobIntentRecord {
  const row = captureJournalValue(value);
  if (!object(row) || !only(row, ["recordFamily", "requestId", "target", "prepared", "sequence", "attempts", "state", "updatedAt", "receipt", "notAppliedThrough", "deletionHold", "notDispatched"]) || row.recordFamily !== "blob" || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || !timestamp(row.updatedAt) || !["pending", "in_flight", "acknowledged", "conflict", "refused", "unknown"].includes(row.state)) throw new TypeError("invalid blob intent record");
  const prepared = decodePreparedBlobIntent(row.prepared);
  if (row.requestId !== prepared.identity.requestId || row.target !== prepared.intent.key) throw new TypeError("blob record index does not match payload");
  const prefix = row.notAppliedThrough === undefined ? 0 : row.notAppliedThrough;
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > row.attempts) throw new TypeError("invalid blob non-execution prefix");
  if (row.deletionHold !== undefined) {
    captureBlobDeletionHold(row.deletionHold);
    if (prefix === 0 || prepared.intent.operationId !== "blobs.delete.v1") throw new TypeError("blob hold requires its proven deletion prefix");
  }
  if (row.notDispatched !== undefined) {
    captureBlobNotDispatched(row.notDispatched);
    if (prefix === 0) throw new TypeError("blob not-dispatched evidence requires its proven prefix");
  }
  if (prefix > 0 && row.deletionHold === undefined && row.notDispatched === undefined) throw new TypeError("blob non-execution prefix requires typed evidence");
  const terminal = row.state === "acknowledged" || row.state === "conflict" || row.state === "refused";
  if (terminal !== (row.receipt !== undefined)) throw new TypeError("blob terminal state requires its receipt");
  if (row.receipt !== undefined) {
    const receipt = blobReceipt(row.prepared, row.receipt.result);
    if (!equalJournalValue(receipt, row.receipt) || (row.state === "acknowledged") !== receipt.result.ok || (!receipt.result.ok && (row.state === "conflict") !== (receipt.result.error.code === "version_conflict"))) throw new TypeError("blob receipt does not match state");
  }
  return row;
}
export function captureBlobJournalGuard(value: BlobJournalGuard): BlobJournalGuard {
  const guard = captureJournalValue(value);
  if (!object(guard) || !only(guard, ["key", "intents", "meta"]) || !Array.isArray(guard.intents) || !Array.isArray(guard.meta)) throw new JournalGuardConflict("blob");
  assertBlobKey(guard.key);
  const ids = new Set<string>(), sequences = new Set<number>(), keys = new Set<string>();
  for (const row of guard.intents) {
    captureBlobIntentRecord(row);
    if (row.target !== guard.key || ids.has(row.requestId) || sequences.has(row.sequence)) throw new JournalGuardConflict(guard.key);
    ids.add(row.requestId); sequences.add(row.sequence);
  }
  for (const row of guard.meta) {
    if (!object(row) || !only(row, ["key", "expected"]) || typeof row.key !== "string" || keys.has(row.key)) throw new JournalGuardConflict(guard.key);
    keys.add(row.key); assertMetaExpectation(row.expected);
  }
  return guard;
}
export function assertBlobJournalGuard(expected: BlobJournalGuard, actual: BlobJournalGuard): void {
  const a = captureBlobJournalGuard(expected), b = captureBlobJournalGuard(actual);
  for (const guard of [a, b]) { guard.intents.sort((x, y) => x.sequence - y.sequence); guard.meta.sort((x, y) => x.key.localeCompare(y.key)); }
  if (!equalJournalValue(a, b)) throw new JournalGuardConflict(a.key);
}
export function captureBlobMutationOptions(options: BlobJournalMutationOptions): BlobJournalMutationOptions {
  const captured = captureJournalValue(options);
  if (!object(captured) || !only(captured, ["guard", "meta", "removeMeta"])) throw new JournalGuardConflict("blob");
  captured.guard = captureBlobJournalGuard(captured.guard);
  const puts = captured.meta ?? [], removals = captured.removeMeta ?? [];
  if (!Array.isArray(puts) || !Array.isArray(removals) || puts.some(row => !object(row) || !only(row, ["key", "value"]) || typeof row.key !== "string") || new Set(puts.map(row => row.key)).size !== puts.length || new Set(removals).size !== removals.length || [...puts.map(row => row.key), ...removals].some(key => typeof key !== "string" || !captured.guard.meta.some(row => row.key === key)) || removals.some(key => puts.some(row => row.key === key))) throw new JournalGuardConflict(captured.guard.key);
  return captured;
}

// ── the one transition owner ─────────────────────────────────────────────────────────────
// Every blob journal decides admission, claims, settlement, non-execution proof, retirement and
// guarded metadata through these pure functions; a backend only persists what they return.

/** Admission refused: an unsettled intent on the same bundle and key was not named as a premise. */
export class BlobAdmissionConflict extends JournalGuardConflict {
  readonly unsettled: readonly string[];
  constructor(key: string, unsettled: readonly string[]) {
    super(key);
    this.message = `'${key}' already has an unsettled blob intent (${unsettled.join(", ") || "premise mismatch"}) in this bundle; name it as a premise to admit beside it`;
    this.unsettled = Object.freeze([...unsettled]);
  }
}

/** The committed state a decision reads. A backend answers from one consistent snapshot. */
export interface BlobJournalView {
  /** Every blob intent whose target is `key`, any bundle. */
  blobIntentsFor(key: string): readonly BlobIntentRecord[];
  /** The blob intent with this id, or undefined (also when another record family holds the id). */
  blobIntent(requestId: string): BlobIntentRecord | undefined;
  /** The state of whatever intent, of any family, holds this id; null when none does. */
  intentState(requestId: string): OperationState | null;
  meta(key: string): MetaExpectation;
  readonly sequence: number;
  /** Whether this open journal handle itself made the claim that brought `requestId` to exactly
   * `attempts`. A claim found at open belongs to a process that may have sent it. */
  claimedInThisSession(requestId: string, attempts: number): boolean;
}
/** What a backend persists atomically for one decided verb. */
export interface BlobJournalDecision<T> {
  result: T;
  /** Intent puts (value) and removals (null), keyed by request id. */
  intents: { requestId: string; value: BlobIntentRecord | null }[];
  sequence?: number;
  meta: MetaRecord[];
  removeMeta: string[];
  /** After the decision commits: record this handle's claim at `claimed` attempts, or clear it (null). */
  session?: { requestId: string; claimed: number | null };
}

export interface CapturedBlobAdmission { prepared: string; decoded: PreparedBlobIntent; options: BlobJournalMutationOptions; unsettled?: BlobIntentRecord[] }
export interface CapturedBlobUpdate { requestId: string; expectedState: OperationState; patch: BlobIntentPatch; options: BlobJournalMutationOptions }
export interface CapturedBlobRetirement { key: string; requestIds: string[]; options: BlobJournalMutationOptions }
export interface CapturedBlobMetaWrite { key: string; options: BlobJournalMutationOptions }

/** The guard must equal the complete same-key intent set and every named meta premise. */
export function assertBlobGuardMatches(view: BlobJournalView, guard: BlobJournalGuard): void {
  assertBlobJournalGuard(guard, { key: guard.key, intents: [...view.blobIntentsFor(guard.key)], meta: guard.meta.map(row => ({ key: row.key, expected: view.meta(row.key) })) });
}

/** Pre-admit checks a caller runs before durably admitting, against the bound the host advertised.
 * Failing any of these after a claim would strand an attempt that never left. */
export type BlobAdmissionCheck =
  | { ok: true }
  | { ok: false; code: "invalid_input"; reason: "unsafe_key" | "invalid_content_type" | "invalid_expected_content_type" | "bytes_with_delete" | "missing_bytes" | "too_large" | "invalid_bound"; message: string };
export function checkBlobAdmission(input: { operation: "create" | "replace" | "delete"; key: unknown; contentType?: unknown; expectedContentType?: unknown; byteLength?: number; maximumBytes?: number | null }): BlobAdmissionCheck {
  const refuse = (reason: Extract<BlobAdmissionCheck, { ok: false }>["reason"], message: string): BlobAdmissionCheck => ({ ok: false, code: "invalid_input", reason, message });
  if (!isSafeBlobKey(input.key)) return refuse("unsafe_key", "the blob key is not a safe ordinary-file key");
  const deletion = input.operation === "delete";
  if (!deletion && !isBlobContentType(input.contentType)) return refuse("invalid_content_type", "the blob content type is not a valid MIME value");
  if (input.operation !== "create" && !isBlobContentType(input.expectedContentType)) return refuse("invalid_expected_content_type", "replace and delete pin the expected content type");
  if (deletion) return input.byteLength === undefined ? { ok: true } : refuse("bytes_with_delete", "a blob delete carries no bytes");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength! < 0) return refuse("missing_bytes", "a blob create or replace carries bytes");
  const advertised = input.maximumBytes;
  if (advertised !== undefined && advertised !== null && (!Number.isSafeInteger(advertised) || advertised < 1)) return refuse("invalid_bound", "the advertised blob write bound is not a positive integer");
  const bound = Math.min(BLOB_JOURNAL_BOUNDS.rawBytes, advertised ?? BLOB_JOURNAL_BOUNDS.rawBytes);
  if (input.byteLength! > bound) return refuse("too_large", `the blob is ${input.byteLength} bytes; the write bound is ${bound}`);
  return { ok: true };
}

/** One unsettled intent per (bundle, key): every receipt-less same-bundle intent on the key must be
 * named, exactly, in `unsettled`. Other bundles on the same key never block. */
export function assertBlobSameKeyAdmission(existing: readonly BlobIntentRecord[], prepared: PreparedBlobIntent, unsettled: readonly BlobIntentRecord[] = []): void {
  const key = prepared.intent.key;
  const blocking = existing.filter(row => row.target === key && row.receipt === undefined && decodePreparedBlobIntent(row.prepared).scope.bundleId === prepared.scope.bundleId);
  const named = new Set(unsettled.map(row => row.requestId));
  if (named.size !== unsettled.length || unsettled.length !== blocking.length || !blocking.every(row => unsettled.some(premise => equalJournalValue(premise, row)))) throw new BlobAdmissionConflict(key, blocking.map(row => row.requestId));
}

export function captureBlobAdmission(prepared: string, options: BlobAdmitOptions): CapturedBlobAdmission {
  const decoded = decodePreparedBlobIntent(prepared);
  const { unsettled, ...rest } = object(options) ? options as BlobAdmitOptions : ({} as Partial<BlobAdmitOptions>);
  const captured = captureBlobMutationOptions((object(options) ? rest : options) as BlobJournalMutationOptions);
  if (captured.guard.key !== decoded.intent.key) throw new JournalGuardConflict(decoded.intent.key);
  let premise: BlobIntentRecord[] | undefined;
  if (unsettled !== undefined) {
    const rows = captureJournalValue(unsettled);
    if (!Array.isArray(rows)) throw new JournalGuardConflict(decoded.intent.key);
    premise = rows.map(row => captureBlobIntentRecord(row));
  }
  return { prepared, decoded, options: captured, ...(premise === undefined ? {} : { unsettled: premise }) };
}
export function decideBlobAdmission(view: BlobJournalView, admission: CapturedBlobAdmission, now: string): BlobJournalDecision<BlobIntentRecord> {
  const { decoded, prepared, options: { guard, meta = [], removeMeta = [] } } = admission;
  assertBlobGuardMatches(view, guard);
  if (view.intentState(decoded.identity.requestId) !== null) throw new JournalSnapshotConflict(guard.key);
  assertBlobSameKeyAdmission(view.blobIntentsFor(guard.key), decoded, admission.unsettled);
  const sequence = view.sequence + 1;
  if (!Number.isSafeInteger(sequence)) throw new RangeError("journal sequence exhausted");
  const record = captureBlobIntentRecord({ recordFamily: "blob", requestId: decoded.identity.requestId, target: decoded.intent.key, prepared, sequence, attempts: 0, state: "pending", updatedAt: now });
  return { result: record, sequence, intents: [{ requestId: record.requestId, value: record }], meta, removeMeta };
}

const PATCH_KEYS = ["state", "attempts", "receipt", "notAppliedThrough", "deletionHold", "notDispatched"];
export function captureBlobUpdate(requestId: string, expectedState: OperationState, patch: BlobIntentPatch, options: BlobJournalMutationOptions): CapturedBlobUpdate {
  const captured = captureJournalValue(patch);
  const mutation = captureBlobMutationOptions(options);
  // An undefined-valued key would merge into the record as a present key; a patch names only values.
  if (!captured || typeof captured !== "object" || Array.isArray(captured) || Object.entries(captured).some(([key, value]) => !PATCH_KEYS.includes(key) || value === undefined)) throw new JournalGuardConflict(mutation.guard.key);
  return { requestId, expectedState, patch: captured, options: mutation };
}

/**
 * The single claim/settle/non-execution rule. A claim consumes exactly one eligibility (`pending` or
 * `unknown`, every earlier attempt proven not applied) before any wire operation. Proof of
 * non-execution extends the prefix by exactly the claimed attempt and returns the record to
 * `pending`: a deletion hold from `in_flight` or `unknown`, not-dispatched only from an `in_flight`
 * claim this journal handle made at exactly the current attempt (`claimedHere`).
 * A receipt freezes the record. Anything else may not touch the counters or the evidence.
 */
export function nextBlobIntentRecord(current: BlobIntentRecord | undefined, update: Pick<CapturedBlobUpdate, "requestId" | "expectedState" | "patch">, guardKey: string, now: string, options: { checkRecord?: (next: BlobIntentRecord) => void; claimedHere?: boolean } = {}): BlobIntentRecord {
  const { requestId, expectedState, patch } = update;
  const { checkRecord, claimedHere = false } = options;
  if (!current || current.state !== expectedState) throw new IntentStateConflict(requestId, expectedState, current?.state ?? null);
  if (current.target !== guardKey) throw new JournalGuardConflict(guardKey);
  const next = captureBlobIntentRecord({ ...current, ...patch, updatedAt: now });
  checkRecord?.(next);
  const beforePrefix = current.notAppliedThrough ?? 0, afterPrefix = next.notAppliedThrough ?? 0;
  const sameHold = equalJournalValue(current.deletionHold, next.deletionHold);
  const sameNotDispatched = equalJournalValue(current.notDispatched, next.notDispatched);
  const refuse = () => new JournalGuardConflict(guardKey);
  if (current.receipt && (next.attempts !== current.attempts || next.state !== current.state || !equalJournalValue(current.receipt, next.receipt) || afterPrefix !== beforePrefix || !sameHold || !sameNotDispatched)) throw refuse();
  if (next.attempts !== current.attempts) {
    if (current.receipt || !["pending", "unknown"].includes(current.state) || next.state !== "in_flight" || next.attempts !== current.attempts + 1 || beforePrefix !== current.attempts || afterPrefix !== beforePrefix || !sameHold || !sameNotDispatched) throw refuse();
  } else if (afterPrefix !== beforePrefix) {
    // Typed evidence belongs to this exact claimed count and must extend the complete prefix.
    const held = patch.deletionHold !== undefined, notDispatched = patch.notDispatched !== undefined;
    if (current.receipt || next.state !== "pending" || patch.attempts !== current.attempts || beforePrefix !== current.attempts - 1 || afterPrefix !== current.attempts || next.receipt !== undefined || held === notDispatched) throw refuse();
    if (held ? !["in_flight", "unknown"].includes(current.state) : current.state !== "in_flight" || !sameHold || !claimedHere) throw refuse();
  } else if (!sameHold || !sameNotDispatched || patch.state === "in_flight") throw refuse();
  return next;
}
export function decideBlobUpdate(view: BlobJournalView, update: CapturedBlobUpdate, now: string, checkRecord?: (next: BlobIntentRecord) => void): BlobJournalDecision<BlobIntentRecord> {
  const { guard, meta = [], removeMeta = [] } = update.options;
  assertBlobGuardMatches(view, guard);
  const current = view.blobIntent(update.requestId);
  if (!current && view.intentState(update.requestId) !== null) throw new IntentStateConflict(update.requestId, update.expectedState, view.intentState(update.requestId));
  const claimedHere = current !== undefined && view.claimedInThisSession(update.requestId, current.attempts);
  const next = nextBlobIntentRecord(current, update, guard.key, now, { ...(checkRecord ? { checkRecord } : {}), claimedHere });
  const claimed = next.attempts !== current!.attempts ? next.attempts : next.state !== "in_flight" ? null : undefined;
  return { result: next, intents: [{ requestId: update.requestId, value: next }], meta, removeMeta, ...(claimed === undefined ? {} : { session: { requestId: update.requestId, claimed } }) };
}

/** The patch that records typed non-execution of the latest claimed attempt. `not_dispatched` is
 * only for this invocation's own claim, before the carrier is invoked or refused by it as `denied`;
 * the journal refuses it for a claim it did not make in this session. Any other carrier or
 * transport failure is `unknown`, never this. */
export function blobNonExecutionPatch(current: BlobIntentRecord, reason: BlobNonExecution): BlobIntentPatch {
  const { kind, ...evidence } = reason;
  const base = { state: "pending" as const, attempts: current.attempts, notAppliedThrough: current.attempts };
  if (kind === "deletion_hold") return { ...base, deletionHold: captureBlobDeletionHold(evidence as BlobDeletionHold) };
  if (kind === "not_dispatched") return { ...base, notDispatched: captureBlobNotDispatched(evidence as BlobNotDispatched) };
  throw new TypeError("unknown blob non-execution kind");
}
/** Fresh submission is allowed only while every earlier attempt is proven not applied. */
export function blobIntentResendable(row: BlobIntentRecord): boolean {
  return row.receipt === undefined && (row.state === "pending" || row.state === "unknown") && (row.notAppliedThrough ?? 0) === row.attempts;
}

export function captureBlobRetirement(key: string, requestIds: readonly string[], options: BlobJournalMutationOptions): CapturedBlobRetirement {
  assertBlobKey(key);
  const ids = captureJournalValue([...requestIds]);
  const captured = captureBlobMutationOptions(options);
  if (captured.guard.key !== key || ids.length === 0 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new JournalGuardConflict(key);
  return { key, requestIds: ids, options: captured };
}
/** Only terminal records with their receipt retire, and only together with their key's guard. */
export function decideBlobRetirement(view: BlobJournalView, retirement: CapturedBlobRetirement): BlobJournalDecision<void> {
  const { key, requestIds, options: { guard, meta = [], removeMeta = [] } } = retirement;
  assertBlobGuardMatches(view, guard);
  for (const id of requestIds) {
    const row = view.blobIntent(id);
    if (!row || row.target !== key || !row.receipt || !["acknowledged", "refused", "conflict"].includes(row.state)) throw new JournalGuardConflict(key);
  }
  return { result: undefined, intents: requestIds.map(requestId => ({ requestId, value: null })), meta, removeMeta };
}

export interface CapturedBlobForget { requestId: string; options: BlobJournalMutationOptions }
export function captureBlobForget(requestId: string, options: BlobJournalMutationOptions): CapturedBlobForget {
  const captured = captureBlobMutationOptions(options);
  if (typeof requestId !== "string" || !isWriteRequestId(requestId)) throw new JournalGuardConflict(captured.guard.key);
  return { requestId, options: captured };
}
/** Only an `unknown`, receipt-less intent whose latest attempt is not proven unapplied may be forgotten. */
export function decideBlobForget(view: BlobJournalView, forget: CapturedBlobForget): BlobJournalDecision<void> {
  const { requestId, options: { guard, meta = [], removeMeta = [] } } = forget;
  assertBlobGuardMatches(view, guard);
  const row = view.blobIntent(requestId);
  if (!row || row.state !== "unknown") throw new IntentStateConflict(requestId, "unknown", row?.state ?? view.intentState(requestId));
  if (row.target !== guard.key || row.receipt !== undefined || (row.notAppliedThrough ?? 0) >= row.attempts) throw new JournalGuardConflict(guard.key);
  return { result: undefined, intents: [{ requestId, value: null }], meta, removeMeta };
}

export function captureBlobMetaWrite(key: string, changes: Pick<BlobJournalMutationOptions, "meta" | "removeMeta">, options: { guard: BlobJournalGuard }): CapturedBlobMetaWrite {
  assertBlobKey(key);
  const captured = captureBlobMutationOptions({ ...captureJournalValue(changes), guard: options.guard });
  if (captured.guard.key !== key) throw new JournalGuardConflict(key);
  return { key, options: captured };
}
export function decideBlobMetaWrite(view: BlobJournalView, write: CapturedBlobMetaWrite): BlobJournalDecision<void> {
  assertBlobGuardMatches(view, write.options.guard);
  return { result: undefined, intents: [], meta: write.options.meta ?? [], removeMeta: write.options.removeMeta ?? [] };
}

/** A same-key read and the complete guard a later mutation must present. Values are copies. */
export function readBlobJournal(view: BlobJournalView, key: string, options: { meta?: readonly string[] } = {}): BlobJournalRead {
  assertBlobKey(key);
  const intents = [...view.blobIntentsFor(key)].sort((a, b) => a.sequence - b.sequence).map(row => structuredClone(row));
  const meta = new Map<string, unknown>();
  const premises: BlobJournalGuard["meta"] = [];
  for (const name of new Set(options.meta ?? [])) {
    if (typeof name !== "string") throw new JournalGuardConflict(key);
    const actual = view.meta(name);
    if (actual.present) {
      const value = structuredClone(actual.value);
      meta.set(name, value);
      premises.push({ key: name, expected: { present: true, value: structuredClone(value) } });
    } else premises.push({ key: name, expected: { present: false } });
  }
  return { key, intents, meta, guard: { key, intents: structuredClone(intents), meta: premises } };
}

// ── browser-safe in-memory journal ─────────────────────────────────────────────────────────

export interface MemoryBlobJournal extends BlobJournaledBackend {
  forgetBlobIntent(requestId: string, options: BlobJournalMutationOptions): Promise<void>;
  writeBlobMeta(key: string, changes: Pick<BlobJournalMutationOptions, "meta" | "removeMeta">, options: { guard: BlobJournalGuard }): Promise<void>;
  readMeta<T = unknown>(key: string): Promise<T | undefined>;
  /** A copy of the committed rows, for a caller that persists them; session claims are not state. */
  exportState(): MemoryBlobJournalState;
}
export interface MemoryBlobJournalState { intents: BlobIntentRecord[]; meta: [string, unknown][]; sequence: number }

/**
 * A {@link BlobJournaledBackend} held in memory, for a browser or a test: the same pure transition
 * functions as the file journal, nothing durable. Each verb decides and applies with no await in
 * between, so verbs never interleave. A terminal receipt is bounded by its JSON size here, where
 * the file journal measures its own tagged encoding. `state` restores exported rows as a new
 * handle would find them: an `in_flight` claim among them is not this handle's.
 */
export function createMemoryBlobJournal(state?: MemoryBlobJournalState): MemoryBlobJournal {
  const intents = new Map<string, BlobIntentRecord>();
  const meta = new Map<string, unknown>();
  const claims = new Map<string, number>();
  let sequence = 0;
  if (state !== undefined) {
    const restored = captureJournalValue(state);
    if (!object(restored) || !only(restored, ["intents", "meta", "sequence"]) || !Array.isArray(restored.intents) || !Array.isArray(restored.meta) || !Number.isSafeInteger(restored.sequence) || restored.sequence < 0) throw new TypeError("invalid memory blob journal state");
    for (const row of restored.intents) {
      const captured = captureBlobIntentRecord(row);
      if (intents.has(captured.requestId) || captured.sequence > restored.sequence) throw new TypeError("invalid memory blob journal state");
      intents.set(captured.requestId, captured);
    }
    for (const entry of restored.meta) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || meta.has(entry[0])) throw new TypeError("invalid memory blob journal state");
      meta.set(entry[0], entry[1]);
    }
    sequence = restored.sequence;
  }
  const view: BlobJournalView = {
    blobIntentsFor: key => [...intents.values()].filter(row => row.target === key),
    blobIntent: id => intents.get(id),
    intentState: id => intents.get(id)?.state ?? null,
    meta: key => meta.has(key) ? { present: true, value: meta.get(key) } : { present: false },
    get sequence() { return sequence; },
    claimedInThisSession: (id, attempts) => claims.get(id) === attempts,
  };
  const apply = <T>(decision: BlobJournalDecision<T>): T => {
    for (const { requestId, value } of decision.intents) {
      if (value) intents.set(requestId, structuredClone(value)); else intents.delete(requestId);
    }
    if (decision.sequence !== undefined) sequence = decision.sequence;
    for (const row of decision.meta) meta.set(row.key, structuredClone(row.value));
    for (const key of decision.removeMeta) meta.delete(key);
    if (decision.session) {
      if (decision.session.claimed === null) claims.delete(decision.session.requestId); else claims.set(decision.session.requestId, decision.session.claimed);
    }
    for (const { requestId, value } of decision.intents) if (value === null) claims.delete(requestId);
    return decision.result;
  };
  const checkReceipt = (row: BlobIntentRecord) => {
    if (row.receipt !== undefined && new TextEncoder().encode(JSON.stringify(row.receipt)).byteLength > BLOB_JOURNAL_BOUNDS.terminalReceiptBytes) throw new RangeError("a blob terminal receipt exceeds its byte bound");
  };
  return {
    async readBlobWithJournal(key, options = {}) { return readBlobJournal(view, key, options); },
    async writeBlobMeta(key, changes, options) { apply(decideBlobMetaWrite(view, captureBlobMetaWrite(key, changes, options))); },
    async admitPreparedBlob(prepared, options) { return structuredClone(apply(decideBlobAdmission(view, captureBlobAdmission(prepared, options), new Date().toISOString()))); },
    async listBlobIntents(state) {
      const wanted = state === undefined ? null : new Set(typeof state === "string" ? [state] : state);
      return [...intents.values()].filter(row => !wanted || wanted.has(row.state)).sort((a, b) => a.sequence - b.sequence).map(row => structuredClone(row));
    },
    async readBlobIntent(requestId) { const row = intents.get(requestId); return row && structuredClone(row); },
    async updateBlobIntent(requestId, expectedState, patch, options) { return structuredClone(apply(decideBlobUpdate(view, captureBlobUpdate(requestId, expectedState, patch, options), new Date().toISOString(), checkReceipt))); },
    async retireBlobIntents(key, requestIds, options) { apply(decideBlobRetirement(view, captureBlobRetirement(key, requestIds, options))); },
    async forgetBlobIntent(requestId, options) { apply(decideBlobForget(view, captureBlobForget(requestId, options))); },
    async readMeta<T>(key: string) { return meta.has(key) ? structuredClone(meta.get(key)) as T : undefined; },
    exportState: () => ({ intents: [...intents.values()].sort((a, b) => a.sequence - b.sequence).map(row => structuredClone(row)), meta: [...meta].map(([key, value]) => [key, structuredClone(value)]), sequence }),
  };
}
