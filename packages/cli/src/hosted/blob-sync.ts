/** Scoped ordinary-file baselines. Physical capture is bounded and leaf-only; callers own checkout locking. */
import { captureBlobHead, isBlobContentType, isContentVersion, compareStorageKeys, blobReceipt, prepareBlobIntent, captureBlobIntentRecord, decodePreparedBlobIntent, type BlobHead, type BlobTargetScope, type BlobIntentRecord, type BlobIntentPatch, type BlobJournaledBackend, isReservedFile, IntentHoldConflict, type JournaledBackend, type BlobJournalRead } from "@superbee/core/storage";
import { captureJournalValue, equalJournalValue, JournalGuardConflict } from "@superbee/core/journaled-backend";

import path from "node:path";
import { mintRequestId } from "@superbee/core/uncertain-write";
import { FileJournalUnavailableError } from "@superbee/core/file-journaled-backend";
import { createHostedBlobReadAdapter, HostedCarrierError, HostedReadAdapterError, type HostedCarrier, type HostedCapabilities } from "@superbee/core/hosted-transport";
import { RemoteError } from "@superbee/core";
import { PAGE_ENTRY_PREFIX, PAGE_REGISTRY_PREFIX, VIEW_ENTRY_PREFIX, VIEW_REGISTRY_PREFIX } from "@superbee/core/page";
import { digestOf, parentUnsafe, fold } from "./projection.js";
import { readRegularFileNoFollowSync } from "../nofollow-read.js";

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

/** Optional initial seeding, never a refresh or an inference from old projection extras. */
export type BlobBaselineSeed = { state: "seeded"; count: number } | { state: "retained" | "unsupported" | "unavailable" | "capacity" | "busy"; count: 0 };
export async function seedInitialBlobBaselines(options: {
  folder: string;
  scope: BlobTargetScope;
  /** Only digests from this invocation's verified export and placed/matching files. */
  exported: Readonly<Record<string, string>>;
  store: Pick<JournaledBackend, "readMeta" | "writeMeta">;
  carrier: HostedCarrier;
  capabilities: () => Promise<HostedCapabilities>;
}): Promise<BlobBaselineSeed> {
  const { folder, store, carrier, capabilities } = options;
  const scope = scopeOf(options.scope), exported = captureJournalValue(options.exported);
  const existing = await store.readMeta(BLOB_SYNC_META_KEY);
  if (existing !== undefined) { decodeBlobSyncMap(existing, scope); return { state: "retained", count: 0 }; }
  let heads: readonly BlobHead[];
  try {
    const caps = await capabilities();
    if (caps.blobReads !== "allowed" || !Number.isSafeInteger(caps.blobReadBytes) || !(caps.blobReadBytes! > 0)) return { state: "unsupported", count: 0 };
    const controller = new AbortController();
    try { heads = (await createHostedBlobReadAdapter({ carrier, bundleId: scope.bundleId, prefix: scope.prefix, signal: controller.signal, capabilities: async () => caps }).heads()).heads; }
    finally { controller.abort(); }
  } catch (error) {
    if (error instanceof HostedReadAdapterError || error instanceof HostedCarrierError || error instanceof RemoteError && error.code !== "MALFORMED_ANSWER") return { state: "unavailable", count: 0 };
    throw error;
  }
  let map: BlobSyncMap = { schemaVersion: 1, scope, entries: [] };
  for (const head of heads) {
    if (!ordinarySeedKey(head.key) || exported[head.key] !== head.version) continue;
    const file = path.join(folder, ...head.key.split("/"));
    if (await parentUnsafe(folder, file)) continue;
    const actual = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
    if (actual.state !== "present" || digestOf(actual.bytes) !== head.version || await parentUnsafe(folder, file)) continue;
    map.entries.push(seedBlobSyncEntry(head, head.version));
  }
  if (map.entries.length === 0) return { state: "seeded", count: 0 };
  map = captureBlobSyncMap(map, scope);
  try {
    // Whole-map CAS and global journal emptiness are checked in the same existing transaction.
    await store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(map), { expected: { present: false }, requireEmptyJournal: true });
  } catch (error) {
    if (error instanceof FileJournalUnavailableError) return { state: "unavailable", count: 0 };
    if (error instanceof JournalGuardConflict || error instanceof IntentHoldConflict) return { state: "busy", count: 0 };
    if (error instanceof RangeError && /exceeds the store's .* byte bound/.test(error.message)) return { state: "capacity", count: 0 };
    throw error;
  }
  return { state: "seeded", count: map.entries.length };
}
function ordinarySeedKey(key: string): boolean {
  if (isReservedFile(key)) return false;
  const root = fold(key.split("/")[0]!);
  return ![PAGE_ENTRY_PREFIX, PAGE_REGISTRY_PREFIX, VIEW_ENTRY_PREFIX, VIEW_REGISTRY_PREFIX, "conventions/", "recipes/", "references/"].some(prefix => root === prefix.slice(0, -1));
}

export interface BlobCaptureContext {
  store: BlobJournaledBackend & Pick<JournaledBackend, "readMeta">;
  scope: BlobTargetScope;
  binding: string;
  via?: string;
  createdAt: string;
  allowed: boolean;
}
export interface BlobCaptureHold { key: string; reason: "not_sendable" | "unsafe_path"; message: string }
/** Freeze under the caller's checkout lock; this function never claims, sends or retries. */
export async function captureTrackedBlobChanges(folder: string, context: BlobCaptureContext, preview = false): Promise<{ keys: ReadonlySet<string>; held: BlobCaptureHold[] }> {
  const { store } = context;
  const captured = captureJournalValue({ scope: context.scope, binding: context.binding, ...(context.via === undefined ? {} : { via: context.via }), createdAt: context.createdAt, allowed: context.allowed });
  const raw = await store.readMeta(BLOB_SYNC_META_KEY), map = decodeBlobSyncMap(raw, captured.scope);
  const held: BlobCaptureHold[] = [];
  const outstanding = new Set((await store.listBlobIntents()).filter(row => row.state !== "acknowledged").map(row => row.target));
  for (const entry of map.entries) {
    const hold = (message: string, reason: BlobCaptureHold["reason"] = "not_sendable") => held.push({ key: entry.key, reason, message });
    if (!ordinarySeedKey(entry.key)) { hold(`${entry.key} is a protected namespace; ordinary-file sync does not change it`); continue; }
    if (outstanding.has(entry.key)) { hold(`${entry.key} has a preserved ordinary-file intent; delivery is not yet enabled`); continue; }
    const file = path.join(folder, ...entry.key.split("/"));
    if (await parentUnsafe(folder, file)) { hold(`${entry.key} has an unsafe parent; no deletion or edit was captured`, "unsafe_path"); continue; }
    const physical = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
    if (physical.state === "unsafe" || await parentUnsafe(folder, file)) { hold(`${entry.key} is unsafe or exceeds the capture bound; no deletion or edit was captured`, "unsafe_path"); continue; }
    const digest = physical.state === "missing" ? null : digestOf(physical.bytes);
    if (!blobSyncDirty(entry, digest)) continue;
    if (!entry.head) { hold(`${entry.key} has no observed present byte and MIME baseline; it remains local`); continue; }
    if (!captured.allowed) { hold(`${entry.key} remains local because this host does not allow ordinary-file writes`); continue; }
    if (!preview) {
      const snapshot = await readBlobSyncState(store, entry.key, captured.scope);
      if (!equalJournalValue(snapshot.map, map)) throw new JournalGuardConflict(entry.key);
      if (snapshot.journal.intents.some(row => row.state !== "acknowledged")) { hold(`${entry.key} has a preserved ordinary-file intent; delivery is not yet enabled`); continue; }
      const common = { key: entry.key, expectedVersion: entry.head.version, expectedContentType: entry.head.contentType };
      const intent = physical.state === "missing" ? { operationId: "blobs.delete.v1" as const, ...common } : { operationId: "blobs.replace.v1" as const, ...common, version: digest!, contentType: entry.desiredContentType ?? entry.head.contentType };
      const prepared = prepareBlobIntent({ scope: captured.scope, intent, identity: { requestId: mintRequestId(), binding: captured.binding, ...(captured.via === undefined ? {} : { via: captured.via }) }, createdAt: captured.createdAt }, physical.state === "present" ? physical.bytes : undefined);
      try { await store.admitPreparedBlob(prepared, { guard: snapshot.journal.guard }); }
      catch (error) {
        if (error instanceof JournalGuardConflict || error instanceof IntentHoldConflict || error instanceof FileJournalUnavailableError || error instanceof RangeError && /exceeds the store's .* byte bound/.test(error.message)) { hold(`${entry.key} could not be captured under its journal guard or capacity; the file remains local`); continue; }
        throw error;
      }
    }
    hold(`${entry.key} ${preview ? "would be preserved" : "is preserved"} locally; ordinary-file delivery is not yet enabled`);
  }
  return { keys: new Set(map.entries.map(row => row.key)), held };
}
