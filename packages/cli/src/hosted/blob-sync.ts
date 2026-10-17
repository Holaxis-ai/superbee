/** Scoped ordinary-file baselines. This module performs no filesystem or network operations. */
import { captureBlobHead, isBlobContentType, isContentVersion, compareStorageKeys, blobReceipt, captureBlobIntentRecord, decodePreparedBlobIntent, type BlobHead, type BlobTargetScope, type BlobIntentRecord, type BlobIntentPatch, type BlobJournaledBackend, type BlobJournalRead } from "@superbee/core/storage";
import { captureJournalValue, equalJournalValue } from "@superbee/core/journaled-backend";

export const BLOB_SYNC_META_KEY = "hosted.blob-sync.v1";
export interface BlobSyncEntry {
  key: string;
  /** Omitted: unobserved. Null: observed absence. */
  head?: BlobHead | null;
  placedDigest: string | null;
  desiredContentType?: string;
}
export interface BlobSyncMap { schemaVersion: 1; scope: BlobTargetScope; entries: BlobSyncEntry[] }
export interface BlobSyncSnapshot { map: BlobSyncMap; journal: BlobJournalRead }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
function scopeOf(value: BlobTargetScope): BlobTargetScope {
  const scope = captureJournalValue(value);
  if (!object(scope) || !only(scope, ["origin", "prefix", "bundleId", "workspaceSlug"]) || typeof scope.origin !== "string" || typeof scope.prefix !== "string" || typeof scope.bundleId !== "string" || !(scope.workspaceSlug === null || typeof scope.workspaceSlug === "string")) throw new TypeError("invalid blob sync scope");
  // Scope is captured caller data, never authority. Its full tuple must match before delivery.
  return { origin: scope.origin, prefix: scope.prefix, bundleId: scope.bundleId, workspaceSlug: scope.workspaceSlug };
}
function entryOf(value: BlobSyncEntry): BlobSyncEntry {
  const row = captureJournalValue(value);
  if (!object(row) || !only(row, ["key", "head", "placedDigest", "desiredContentType"]) || typeof row.key !== "string" || !(row.placedDigest === null || isContentVersion(row.placedDigest)) || row.desiredContentType !== undefined && !isBlobContentType(row.desiredContentType)) throw new TypeError("invalid blob sync entry");
  // Reuse the neutral key grammar even when no head has been observed.
  captureBlobHead({ key: row.key, version: `sha256:${"0".repeat(64)}`, contentType: "application/octet-stream" });
  const head = row.head === undefined ? undefined : row.head === null ? null : captureBlobHead(row.head);
  if (head && head.key !== row.key) throw new TypeError("blob sync head key mismatch");
  return { key: row.key, ...(head === undefined ? {} : { head }), placedDigest: row.placedDigest, ...(row.desiredContentType === undefined ? {} : { desiredContentType: row.desiredContentType }) };
}
/** Canonicalizes order and rejects duplicate keys, unknown fields and oversized metadata. */
export function captureBlobSyncMap(value: BlobSyncMap, expectedScope: BlobTargetScope): BlobSyncMap {
  const input = captureJournalValue(value);
  if (!object(input) || !only(input, ["schemaVersion", "scope", "entries"]) || input.schemaVersion !== 1 || !Array.isArray(input.entries) || input.entries.length > 10_000) throw new TypeError("invalid blob sync map");
  const scope = scopeOf(input.scope);
  if (!equalJournalValue(scope, scopeOf(expectedScope))) throw new TypeError("blob sync scope mismatch");
  const entries = input.entries.map(entryOf).sort((a, b) => compareStorageKeys(a.key, b.key));
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.key === entry.key)) throw new TypeError("duplicate blob sync key");
  const map: BlobSyncMap = { schemaVersion: 1, scope, entries };
  if (Buffer.byteLength(JSON.stringify(map), "utf8") > 32 * 1024 * 1024) throw new RangeError("blob sync metadata exceeds byte bound");
  return map;
}
export function encodeBlobSyncMap(value: BlobSyncMap): string { return JSON.stringify(captureBlobSyncMap(value, value.scope)); }
export function decodeBlobSyncMap(value: unknown, scope: BlobTargetScope): BlobSyncMap {
  if (value === undefined) return captureBlobSyncMap({ schemaVersion: 1, scope, entries: [] }, scope);
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 32 * 1024 * 1024) throw new TypeError("invalid blob sync metadata");
  const map = captureBlobSyncMap(JSON.parse(value), scope);
  if (JSON.stringify(map) !== value) throw new TypeError("noncanonical blob sync metadata");
  return map;
}
export function changeBlobSyncEntry(map: BlobSyncMap, entry: BlobSyncEntry): BlobSyncMap {
  const captured = captureBlobSyncMap(map, map.scope), next = entryOf(entry);
  return captureBlobSyncMap({ ...captured, entries: [...captured.entries.filter(row => row.key !== next.key), next] }, captured.scope);
}
/** Physical bytes and MIME choices are independent dirty dimensions. Unknown is never absence. */
export function blobSyncDirty(entry: BlobSyncEntry, physicalDigest: string | null): boolean {
  const row = entryOf(entry);
  if (!(physicalDigest === null || isContentVersion(physicalDigest))) throw new TypeError("invalid physical digest");
  return row.head === undefined || physicalDigest !== row.placedDigest || row.desiredContentType !== undefined && (row.head === null || row.head.contentType !== row.desiredContentType);
}
/** Only verified placed bytes matching an authoritative head can establish a fresh baseline. */
export function seedBlobSyncEntry(head: BlobHead, placedDigest: string): BlobSyncEntry {
  const captured = captureBlobHead(head);
  if (captured.version !== placedDigest) throw new TypeError("placed bytes do not match blob head");
  return { key: captured.key, head: captured, placedDigest };
}
export async function readBlobSyncState(backend: BlobJournaledBackend, key: string, scope: BlobTargetScope): Promise<BlobSyncSnapshot> {
  const capturedScope = scopeOf(scope);
  const journal = await backend.readBlobWithJournal(key, { meta: [BLOB_SYNC_META_KEY] });
  return { journal, map: decodeBlobSyncMap(journal.meta.get(BLOB_SYNC_META_KEY), capturedScope) };
}
/** Caller holds the checkout lock. The complete map and same-key intent snapshot form one CAS. */
export async function settleBlobSyncReceipt(backend: BlobJournaledBackend, snapshot: BlobSyncSnapshot, original: BlobIntentRecord, patch: BlobIntentPatch): Promise<BlobIntentRecord> {
  const captured = { map: captureJournalValue(snapshot.map), journal: { key: snapshot.journal.key, intents: captureJournalValue(snapshot.journal.intents), guard: captureJournalValue(snapshot.journal.guard), meta: new Map([...snapshot.journal.meta].map(([key, value]) => [key, captureJournalValue(value)])) } }, record = captureBlobIntentRecord(original), update = captureJournalValue(patch);
  const map = captureBlobSyncMap(captured.map, captured.map.scope);
  if (!equalJournalValue(map, decodeBlobSyncMap(captured.journal.meta.get(BLOB_SYNC_META_KEY), map.scope))) throw new TypeError("blob settlement map mismatch");
  const expected = captured.journal.guard.meta.find(row => row.key === BLOB_SYNC_META_KEY)?.expected;
  const stored = captured.journal.meta.get(BLOB_SYNC_META_KEY);
  if (!expected || !equalJournalValue(expected, stored === undefined ? { present: false } : { present: true, value: stored })) throw new TypeError("blob settlement metadata guard mismatch");
  const prepared = decodePreparedBlobIntent(record.prepared);
  if (!equalJournalValue(map.scope, prepared.scope) || captured.journal.key !== record.target || !captured.journal.intents.some(row => equalJournalValue(row, record))) throw new TypeError("blob settlement snapshot mismatch");
  const witness = update.receipt === undefined ? undefined : blobReceipt(record.prepared, update.receipt.result);
  if (!witness || !equalJournalValue(witness, update.receipt)) throw new TypeError("blob settlement requires a validated receipt");
  let next = map;
  if ("head" in witness) {
    const previous = map.entries.find(row => row.key === record.target);
    const desired = previous?.desiredContentType;
    const sentType = prepared.intent.operationId === "blobs.delete.v1" ? undefined : prepared.intent.contentType;
    next = changeBlobSyncEntry(map, { key: record.target, head: witness.head, placedDigest: prepared.intent.operationId === "blobs.delete.v1" ? null : prepared.intent.version,
      ...(desired === undefined || desired === sentType ? {} : { desiredContentType: desired }) });
  }
  const encoded = encodeBlobSyncMap(next);
  return backend.updateBlobIntent(record.requestId, record.state, update, { guard: captured.journal.guard, meta: [{ key: BLOB_SYNC_META_KEY, value: encoded }] });
}
