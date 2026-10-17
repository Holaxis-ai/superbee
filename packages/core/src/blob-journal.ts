/** File-journal optional ordinary-file admission. Frozen payloads are data, never authority:
 * a dispatcher must compare their scope with its current trusted context before delivery. */
import { captureBlobWriteExpected, decodeBlobWriteResult, assertBlobKey, type BlobWriteExpected, type BlobWriteResult, type BlobHead } from "./blob-contract.js";
import { isHostedBundleId } from "./dependencies.js";
import { isAgentLabelVia, isWriteBinding, isWriteRequestId } from "./write-identity.js";
import { sha256HexOfBytes } from "./sha256.js";
import { captureJournalValue, equalJournalValue, assertMetaExpectation, JournalGuardConflict, type MetaExpectation, type MetaRecord } from "./journaled-backend.js";
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
}
export interface BlobJournalGuard {
  key: string;
  intents: BlobIntentRecord[];
  meta: { key: string; expected: MetaExpectation }[];
}
export interface BlobJournalRead { key: string; intents: BlobIntentRecord[]; meta: Map<string, unknown>; guard: BlobJournalGuard }
export interface BlobJournalMutationOptions { guard: BlobJournalGuard; meta?: MetaRecord[]; removeMeta?: string[] }
export interface BlobIntentPatch { state?: OperationState; attempts?: number; receipt?: BlobReceipt; notAppliedThrough?: number; deletionHold?: BlobDeletionHold }
export interface BlobJournaledBackend {
  /** Optional file-only atomic metadata mutation under the complete same-key/named-meta guard. */
  writeBlobMeta?(key: string, changes: Pick<BlobJournalMutationOptions, "meta" | "removeMeta">, options: { guard: BlobJournalGuard }): Promise<void>;
  readBlobWithJournal(key: string, options?: { meta?: readonly string[] }): Promise<BlobJournalRead>;
  admitPreparedBlob(prepared: string, options: BlobJournalMutationOptions): Promise<BlobIntentRecord>;
  listBlobIntents(state?: OperationState | readonly OperationState[]): Promise<BlobIntentRecord[]>;
  readBlobIntent(requestId: string): Promise<BlobIntentRecord | undefined>;
  updateBlobIntent(requestId: string, expectedState: OperationState, patch: BlobIntentPatch, options: BlobJournalMutationOptions): Promise<BlobIntentRecord>;
  retireBlobIntents(key: string, requestIds: readonly string[], options: BlobJournalMutationOptions): Promise<void>;
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
export function decodePreparedBlobIntent(payload: string): PreparedBlobIntent {
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
  if (!object(row) || !only(row, ["recordFamily", "requestId", "target", "prepared", "sequence", "attempts", "state", "updatedAt", "receipt", "notAppliedThrough", "deletionHold"]) || row.recordFamily !== "blob" || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || !timestamp(row.updatedAt) || !["pending", "in_flight", "acknowledged", "conflict", "refused", "unknown"].includes(row.state)) throw new TypeError("invalid blob intent record");
  const prepared = decodePreparedBlobIntent(row.prepared);
  if (row.requestId !== prepared.identity.requestId || row.target !== prepared.intent.key) throw new TypeError("blob record index does not match payload");
  const prefix = row.notAppliedThrough === undefined ? 0 : row.notAppliedThrough;
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > row.attempts) throw new TypeError("invalid blob non-execution prefix");
  if (row.deletionHold !== undefined) {
    captureBlobDeletionHold(row.deletionHold);
    if (prefix === 0 || prepared.intent.operationId !== "blobs.delete.v1") throw new TypeError("blob hold requires its proven deletion prefix");
  }
  if (prefix > 0 && row.deletionHold === undefined) throw new TypeError("blob non-execution prefix requires hold diagnostics");
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
