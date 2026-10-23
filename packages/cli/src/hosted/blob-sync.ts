/** Scoped ordinary-file baselines. Physical capture is bounded and leaf-only; callers own checkout locking. */
import { isOrdinaryBlobKey, captureBlobHead, isBlobContentType, isContentVersion, compareStorageKeys, isWriteRequestId, blobReceipt, prepareBlobIntent, captureBlobIntentRecord, decodePreparedBlobIntent, type BlobHead, type BlobTargetScope, type BlobIntentRecord, type BlobIntentPatch, type BlobJournaledBackend, IntentHoldConflict, type JournaledBackend, type BlobJournalRead } from "@superbee/core/storage";
import { captureJournalValue, equalJournalValue, JournalGuardConflict } from "@superbee/core/journaled-backend";

import path from "node:path";
import { deletionBound, acceptsRefusal, type RefusedDeletions } from "@superbee/core/platform";
import { mintRequestId } from "@superbee/core/uncertain-write";
import { FileJournalUnavailableError } from "@superbee/core/file-journaled-backend";
import { createHostedBlobReadAdapter, HostedCarrierError, HostedReadAdapterError, type HostedCarrier, type HostedCapabilities } from "@superbee/core/hosted-transport";
import { RemoteError } from "@superbee/core";
import { digestOf, projectionPathExact as blobPathSafe, findFilePathCollision, prepareBlobStage, installBlobStage, finishBlobStage, orphanBlobStages, type BlobFileIdentity, type BlobStagePlan, UnsafePlacementError } from "./projection.js";
import { readRegularFileNoFollowSync } from "../nofollow-read.js";
import { commandToken } from "../command-text.js";

export const BLOB_SYNC_META_KEY = "hosted.blob-sync.v1";
export interface BlobSyncEntry {
  key: string;
  /** Omitted: unobserved. Null: observed absence. */
  head?: BlobHead | null;
  placedDigest: string | null;
  desiredContentType?: string;
  placement?: BlobPlacementDescriptor;
}
export interface BlobPlacementDescriptor {
  id: string;
  operation: "create" | "replace" | "delete";
  state: "pending" | "committed";
  original: Omit<BlobSyncEntry, "placement"> | null;
  intended: { head: BlobHead | null; placedDigest: string | null };
  install?: BlobFileIdentity;
  preimage?: BlobFileIdentity;
}
export interface BlobSyncMap { schemaVersion: 1; scope: BlobTargetScope; entries: BlobSyncEntry[]; refusal?: RefusedDeletions }
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
  if (!object(row) || !only(row, ["key", "head", "placedDigest", "desiredContentType", "placement"]) || typeof row.key !== "string" || !(row.placedDigest === null || isContentVersion(row.placedDigest)) || row.desiredContentType !== undefined && !isBlobContentType(row.desiredContentType)) throw new TypeError("invalid blob sync entry");
  // Reuse the neutral key grammar even when no head has been observed.
  captureBlobHead({ key: row.key, version: `sha256:${"0".repeat(64)}`, contentType: "application/octet-stream" });
  const head = row.head === undefined ? undefined : row.head === null ? null : captureBlobHead(row.head);
  if (head && head.key !== row.key) throw new TypeError("blob sync head key mismatch");
  const base = { key: row.key, ...(head === undefined ? {} : { head }), placedDigest: row.placedDigest, ...(row.desiredContentType === undefined ? {} : { desiredContentType: row.desiredContentType }) };
  return { ...base, ...(row.placement === undefined ? {} : { placement: placementOf(row.placement, base) }) };
}
function identityOf(value: BlobFileIdentity): BlobFileIdentity {
  if (!object(value) || !only(value, ["dev", "ino", "mtimeNs"]) || ![value.dev, value.ino].every(v => typeof v === "string" && /^[1-9][0-9]{0,31}$/.test(v)) || typeof value.mtimeNs !== "string" || !/^-?[0-9]{1,32}$/.test(value.mtimeNs)) throw new TypeError("invalid placement identity");
  return { dev: value.dev, ino: value.ino, mtimeNs: value.mtimeNs };
}
function placementOf(value: BlobPlacementDescriptor, base: Omit<BlobSyncEntry, "placement">): BlobPlacementDescriptor {
  const v = captureJournalValue(value);
  if (!object(v) || !only(v, ["id", "operation", "state", "original", "intended", "install", "preimage"]) || typeof v.id !== "string" || !isWriteRequestId(v.id) || !["create", "replace", "delete"].includes(v.operation) || !["pending", "committed"].includes(v.state) || !object(v.intended) || !only(v.intended, ["head", "placedDigest"])) throw new TypeError("invalid placement descriptor");
  if (v.original !== null && (!object(v.original) || Object.hasOwn(v.original, "placement"))) throw new TypeError("recursive placement original");
  const original = v.original === null ? null : entryOf(v.original);
  const head = v.intended.head === null ? null : captureBlobHead(v.intended.head);
  if (head ? head.key !== base.key || v.intended.placedDigest !== head.version : v.intended.placedDigest !== null) throw new TypeError("placement intended pins mismatch");
  if (original && original.key !== base.key) throw new TypeError("placement original key mismatch");
  if (v.operation === "create" ? head === null || original !== null && (original.head !== null || original.placedDigest !== null) : !original?.head || original.placedDigest !== original.head.version || (v.operation === "delete" ? head !== null : head === null || head.version === original.placedDigest)) throw new TypeError("placement operation mismatch");
  const expected = v.state === "pending" ? original ?? { key: base.key, placedDigest: null } : { key: base.key, head, placedDigest: v.intended.placedDigest, ...(original?.desiredContentType === undefined ? {} : { desiredContentType: original.desiredContentType }) };
  if (!equalJournalValue(base, expected)) throw new TypeError("placement baseline mismatch");
  const install = v.install === undefined ? undefined : identityOf(v.install), preimage = v.preimage === undefined ? undefined : identityOf(v.preimage);
  if (v.operation === "delete" && install || v.operation === "create" && preimage || v.state === "committed" && (v.operation !== "delete" && !install || v.operation !== "create" && !preimage)) throw new TypeError("placement identity mismatch");
  const descriptor: BlobPlacementDescriptor = { id: v.id, operation: v.operation, state: v.state, original, intended: { head, placedDigest: v.intended.placedDigest }, ...(install === undefined ? {} : { install }), ...(preimage === undefined ? {} : { preimage }) };
  if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > 16 * 1024) throw new RangeError("placement descriptor exceeds byte bound");
  return descriptor;
}
/** Canonicalizes order and rejects duplicate keys, unknown fields and oversized metadata. */
export function captureBlobSyncMap(value: BlobSyncMap, expectedScope: BlobTargetScope): BlobSyncMap {
  const input = captureJournalValue(value);
  if (!object(input) || !only(input, ["schemaVersion", "scope", "entries", "refusal"]) || input.schemaVersion !== 1 || !Array.isArray(input.entries) || input.entries.length > 10_000) throw new TypeError("invalid blob sync map");
  const scope = scopeOf(input.scope);
  if (!equalJournalValue(scope, scopeOf(expectedScope))) throw new TypeError("blob sync scope mismatch");
  const entries = input.entries.map(entryOf).sort((a, b) => compareStorageKeys(a.key, b.key));
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.key === entry.key)) throw new TypeError("duplicate blob sync key");
  if (findFilePathCollision(entries.map(entry => entry.key))) throw new TypeError("aliased blob projection ownership");
  const ids = entries.flatMap(entry => entry.placement ? [entry.placement.id] : []);
  if (new Set(ids).size !== ids.length) throw new TypeError("duplicate placement id");
  const refusal = input.refusal;
  if (refusal !== undefined && (!object(refusal) || !only(refusal, ["deletions", "reason", "digest"]) || !Number.isSafeInteger(refusal.deletions) || refusal.deletions < 8 || refusal.deletions > 10_000 || !["empty-listing", "over-half"].includes(refusal.reason) || !isContentVersion(refusal.digest))) throw new TypeError("invalid blob deletion refusal");
  const map: BlobSyncMap = { schemaVersion: 1, scope, entries, ...(refusal === undefined ? {} : { refusal: { deletions: refusal.deletions, reason: refusal.reason, digest: refusal.digest } as RefusedDeletions }) };
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
  const current = captured.entries.find(row => row.key === next.key);
  if ((current?.placement || next.placement) && !equalJournalValue(current, next)) throw new TypeError("generic blob metadata changes cannot alter placement WAL");
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
  if (map.entries.find(entry => entry.key === record.target)?.placement) throw new TypeError("blob receipt settlement waits for placement recovery");
  const prepared = decodePreparedBlobIntent(record.prepared);
  if (!equalJournalValue(map.scope, prepared.scope) || captured.journal.key !== record.target || !captured.journal.intents.some(row => equalJournalValue(row, record))) throw new TypeError("blob settlement snapshot mismatch");
  const witness = update.receipt === undefined ? undefined : blobReceipt(record.prepared, update.receipt.result);
  if (!witness || !equalJournalValue(witness, update.receipt)) throw new TypeError("blob settlement requires a validated receipt");
  const next = projectBlobSyncReceipt(map, record, update);
  const encoded = encodeBlobSyncMap(next);
  return backend.updateBlobIntent(record.requestId, record.state, update, { guard: captured.journal.guard, meta: [{ key: BLOB_SYNC_META_KEY, value: encoded }] });
}

/** The same pure projection is used to track only our own guarded map effects across a batch. */
export function projectBlobSyncReceipt(map: BlobSyncMap, record: BlobIntentRecord, update: BlobIntentPatch): BlobSyncMap {
  const prepared = decodePreparedBlobIntent(record.prepared);
  if (!equalJournalValue(prepared.scope, map.scope)) throw new TypeError("blob projection scope mismatch");
  const witness = update.receipt === undefined ? undefined : blobReceipt(record.prepared, update.receipt.result);
  if (!witness || !equalJournalValue(witness, update.receipt)) throw new TypeError("blob projection requires a validated receipt");
  let next = map;
  if ("head" in witness) {
    const previous = map.entries.find(row => row.key === record.target);
    const desired = previous?.desiredContentType;
    const sentType = prepared.intent.operationId === "blobs.delete.v1" ? undefined : prepared.intent.contentType;
    next = changeBlobSyncEntry(map, { key: record.target, head: witness.head, placedDigest: prepared.intent.operationId === "blobs.delete.v1" ? null : prepared.intent.version,
      ...(desired === undefined || desired === sentType ? {} : { desiredContentType: desired }) });
  }
  return next;
}
/** A declared gate and explicit held-delete acceptance judge the frozen representation, not newer bytes. */
export async function blobFrozenPhysicalMatches(folder: string, snapshot: Pick<BlobSyncSnapshot, "map">, record: BlobIntentRecord): Promise<boolean> {
  const prepared = decodePreparedBlobIntent(record.prepared), intent = prepared.intent;
  if (!isOrdinaryBlobKey(record.target) || !equalJournalValue(prepared.scope, snapshot.map.scope) || snapshot.map.entries.find(row => row.key === record.target)?.placement) return false;
  const entry = snapshot.map.entries.find(row => row.key === record.target), file = path.join(folder, ...record.target.split("/"));
  if (!await blobPathSafe(folder, record.target)) return false;
  const found = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
  if (found.state === "unsafe" || !await blobPathSafe(folder, record.target)) return false;
  if (record.receipt?.result.ok) return entry !== undefined && !blobSyncDirty(entry, found.state === "missing" ? null : digestOf(found.bytes));
  if (intent.operationId === "blobs.delete.v1") return found.state === "missing" && !!entry?.head && entry.head.version === intent.expectedVersion && entry.head.contentType === intent.expectedContentType && (entry.desiredContentType === undefined || entry.desiredContentType === intent.expectedContentType);
  return found.state === "present" && digestOf(found.bytes) === intent.version && (entry?.desiredContentType ?? entry?.head?.contentType) === intent.contentType;
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
    if (!isOrdinaryBlobKey(head.key) || exported[head.key] !== head.version || findFilePathCollision([...map.entries.map(row => row.key), head.key])) continue;
    const file = path.join(folder, ...head.key.split("/"));
    if (!await blobPathSafe(folder, head.key)) continue;
    const actual = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
    if (actual.state !== "present" || digestOf(actual.bytes) !== head.version || !await blobPathSafe(folder, head.key)) continue;
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
  // A refusal an earlier run reported (or settled just before it stopped) no longer holds its file.
  if (!preview) await retireBlobRefusals(store, captured.scope, (await store.listBlobIntents("refused")).filter(retirableBlobRefusal).map(row => row.target));
  const intents = (await store.listBlobIntents()).filter(row => row.state !== "acknowledged" && !(preview && retirableBlobRefusal(row)));
  const outstanding = new Set(intents.map(row => row.target)), conflicted = new Set(intents.filter(settledBlobConflict).map(row => row.target));
  for (const entry of map.entries) {
    const hold = (message: string, reason: BlobCaptureHold["reason"] = "not_sendable") => held.push({ key: entry.key, reason, message });
    if (entry.placement) { hold(`${entry.key} has unresolved local placement evidence; capture waits for recovery`); continue; }
    if (!isOrdinaryBlobKey(entry.key)) { hold(`${entry.key} is a protected namespace; ordinary-file sync does not change it`); continue; }
    if (conflicted.has(entry.key)) { hold(blobConflictMessage(entry.key)); continue; }
    if (outstanding.has(entry.key)) { hold(`${entry.key} has a preserved ordinary-file intent awaiting delivery or recovery`); continue; }
    const file = path.join(folder, ...entry.key.split("/"));
    if (!await blobPathSafe(folder, entry.key)) { hold(`${entry.key} has an unsafe parent; no deletion or edit was captured`, "unsafe_path"); continue; }
    const physical = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
    if (physical.state === "unsafe" || !await blobPathSafe(folder, entry.key)) { hold(`${entry.key} is unsafe or exceeds the capture bound; no deletion or edit was captured`, "unsafe_path"); continue; }
    const digest = physical.state === "missing" ? null : digestOf(physical.bytes);
    if (!blobSyncDirty(entry, digest)) continue;
    if (!entry.head) { hold(`${entry.key} has no observed present byte and MIME baseline; it remains local${digest === null ? "" : ` (re-create it on the host with promote ${commandToken(path.join(folder, ...entry.key.split("/")))} --doc-key ${commandToken(entry.key)})`}`); continue; }
    if (!captured.allowed) { hold(`${entry.key} remains local because this host does not allow ordinary-file writes`); continue; }
    if (!preview) {
      const snapshot = await readBlobSyncState(store, entry.key, captured.scope);
      if (!equalJournalValue(snapshot.map, map)) throw new JournalGuardConflict(entry.key);
      if (snapshot.journal.intents.some(row => row.state !== "acknowledged")) { hold(`${entry.key} has a preserved ordinary-file intent awaiting delivery or recovery`); continue; }
      const common = { key: entry.key, expectedVersion: entry.head.version, expectedContentType: entry.head.contentType };
      const intent = physical.state === "missing" ? { operationId: "blobs.delete.v1" as const, ...common } : { operationId: "blobs.replace.v1" as const, ...common, version: digest!, contentType: entry.desiredContentType ?? entry.head.contentType };
      const prepared = prepareBlobIntent({ scope: captured.scope, intent, identity: { requestId: mintRequestId(), binding: captured.binding, ...(captured.via === undefined ? {} : { via: captured.via }) }, createdAt: captured.createdAt }, physical.state === "present" ? physical.bytes : undefined);
      try { await store.admitPreparedBlob(prepared, { guard: snapshot.journal.guard }); }
      catch (error) {
        if (error instanceof JournalGuardConflict || error instanceof IntentHoldConflict || error instanceof FileJournalUnavailableError || error instanceof RangeError && /exceeds the store's .* byte bound/.test(error.message)) { hold(`${entry.key} could not be captured under its journal guard or capacity; the file remains local`); continue; }
        throw error;
      }
    }
    hold(`${entry.key} ${preview ? "would be preserved" : "is preserved"} locally; this capture does not submit it`);
  }
  return { keys: new Set(map.entries.map(row => row.key)), held };
}

/** Sole lifecycle mutation path; generic entry updates cannot transition or retire WAL. */
function changePlacementEntry(map: BlobSyncMap, key: string, next: BlobSyncEntry | null, expected: { id: string; state: "pending" | "committed" } | null): BlobSyncMap {
  const captured = captureBlobSyncMap(map, map.scope), current = captured.entries.find(row => row.key === key), prior = current?.placement;
  if (expected ? !prior || prior.id !== expected.id || prior.state !== expected.state : prior !== undefined) throw new TypeError("placement prior state mismatch");
  if (next?.placement) {
    const following = next.placement;
    if (!prior) { if (following.state !== "pending" || !equalJournalValue(following.original, current ?? null)) throw new TypeError("invalid placement preparation"); }
    else if (following.id !== prior.id || following.operation !== prior.operation || !equalJournalValue(following.original, prior.original) || !equalJournalValue(following.intended, prior.intended) || prior.state !== "pending" || prior.install && !equalJournalValue(prior.install, following.install) || prior.preimage && !equalJournalValue(prior.preimage, following.preimage)) throw new TypeError("invalid placement transition");
  } else if (!prior || !equalJournalValue(next, prior.state === "pending" ? prior.original : placementBaseline(current!))) throw new TypeError("invalid placement retirement");
  return captureBlobSyncMap({ ...captured, entries: [...captured.entries.filter(row => row.key !== key), ...(next ? [next] : [])] }, captured.scope);
}
function placementPlan(entry: BlobSyncEntry): BlobStagePlan {
  const p = entry.placement!;
  return { id: p.id, key: entry.key, operation: p.operation, beforeDigest: p.original?.placedDigest ?? null, afterDigest: p.intended.placedDigest, ...(p.install ? { install: p.install } : {}), ...(p.preimage ? { preimage: p.preimage } : {}) };
}
/** A failed acknowledgment is resolved only by the exact durable entry/UUID/state, not bytes. */
async function writePlacementMap(store: BlobJournaledBackend, snapshot: BlobSyncSnapshot, next: BlobSyncMap, key: string): Promise<void> {
  if (!store.writeBlobMeta) throw new TypeError("file journal does not support guarded blob metadata");
  const desired = next.entries.find(entry => entry.key === key);
  try { await store.writeBlobMeta(key, { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(next) }] }, { guard: snapshot.journal.guard }); }
  catch (error) {
    const actual = await readBlobSyncState(store, key, next.scope);
    if (!equalJournalValue(actual.map.entries.find(entry => entry.key === key), desired)) throw error;
  }
}
function placementBaseline(entry: BlobSyncEntry): BlobSyncEntry {
  const p = entry.placement!;
  return { key: entry.key, ...p.intended, ...(p.original?.desiredContentType === undefined ? {} : { desiredContentType: p.original.desiredContentType }) };
}
export interface BlobPlacementRecovery { held: { key: string | null; message: string }[] }
/** Existing map is the sole WAL; no target authority is inferred from raw temporary files. */
export async function recoverBlobPlacements(folder: string, store: BlobJournaledBackend & Pick<JournaledBackend, "readMeta">, scope: BlobTargetScope): Promise<BlobPlacementRecovery> {
  const capturedScope = scopeOf(scope), raw = await store.readMeta(BLOB_SYNC_META_KEY), map = decodeBlobSyncMap(raw, capturedScope);
  const descriptors = map.entries.filter(entry => entry.placement);
  const held: BlobPlacementRecovery["held"] = [];
  if ((await orphanBlobStages(folder, new Set(descriptors.map(entry => entry.placement!.id)))).length > 0) return { held: [{ key: null, message: "unreferenced blob placement files are preserved; resolve them before capture" }] };
  for (const entry of descriptors) {
    const snapshot = await readBlobSyncState(store, entry.key, capturedScope), current = snapshot.map.entries.find(row => row.key === entry.key);
    if (!current?.placement || !equalJournalValue(current.placement, entry.placement) || snapshot.journal.intents.some(row => row.state !== "acknowledged")) { held.push({ key: entry.key, message: "blob placement state or journal changed; evidence is preserved" }); continue; }
    try {
      if (!await finishBlobStage(folder, placementPlan(current), current.placement.state)) { held.push({ key: entry.key, message: "ambiguous or changed blob placement evidence is preserved" }); continue; }
      const replacement = current.placement.state === "committed" ? placementBaseline(current) : current.placement.original;
      const next = changePlacementEntry(snapshot.map, entry.key, replacement, { id: current.placement.id, state: current.placement.state });
      await writePlacementMap(store, snapshot, next, entry.key); // descriptor clears LAST, after directory sync
    } catch (error) {
      if (error instanceof UnsafePlacementError || error instanceof JournalGuardConflict || error instanceof FileJournalUnavailableError) held.push({ key: entry.key, message: "blob placement recovery refused; evidence is preserved" });
      else throw error;
    }
  }
  return { held };
}
/** Caller owns the checkout lock and a pinned authoritative read. This API does not fetch. */
export async function stageBlobPlacement(folder: string, store: BlobJournaledBackend & Pick<JournaledBackend, "readMeta">, supplied: BlobSyncSnapshot, input: { key: string; head: BlobHead | null; bytes?: Uint8Array }): Promise<"placed" | "held"> {
  if (!store.writeBlobMeta) throw new TypeError("file journal does not support guarded blob metadata");
  const map = captureBlobSyncMap(supplied.map, supplied.map.scope), key = input.key, head = input.head === null ? null : captureBlobHead(input.head), bytes = input.bytes === undefined ? undefined : new Uint8Array(input.bytes);
  const guard = captureJournalValue(supplied.journal.guard);
  const premise = guard.meta.find(row => row.key === BLOB_SYNC_META_KEY)?.expected;
  if (guard.key !== key || supplied.journal.key !== key || !premise || !equalJournalValue(map, decodeBlobSyncMap(premise.present ? premise.value : undefined, map.scope)) || guard.intents.some(row => row.state !== "acknowledged") || !isOrdinaryBlobKey(key) || head && head.key !== key) throw new TypeError("invalid blob placement snapshot");
  if (findFilePathCollision([...map.entries.map(row => row.key), key]) || !await blobPathSafe(folder, key)) return "held";
  const original = map.entries.find(row => row.key === key) ?? null;
  if (original?.placement || original?.desiredContentType !== undefined && original.desiredContentType !== original.head?.contentType) return "held";
  if (head === null ? bytes !== undefined : !bytes || bytes.length > 16 * 1024 * 1024 || digestOf(bytes) !== head.version) throw new TypeError("blob placement bytes mismatch");
  const operation = head === null ? "delete" : original?.head ? "replace" : "create";
  const pending: BlobPlacementDescriptor = { id: mintRequestId(), operation, state: "pending", original, intended: { head, placedDigest: head?.version ?? null } };
  const base: BlobSyncEntry = original ?? { key, placedDigest: null };
  const entry = entryOf({ ...base, placement: pending });
  const snapshot: BlobSyncSnapshot = { map, journal: { ...supplied.journal, guard } };
  await writePlacementMap(store, snapshot, changePlacementEntry(map, key, entry, null), key); // pending before ANY filesystem mutation
  try {
    const identities = await prepareBlobStage(folder, placementPlan(entry), bytes);
    let current = await readBlobSyncState(store, key, map.scope), currentEntry = current.map.entries.find(row => row.key === key)!;
    if (!equalJournalValue(currentEntry.placement, pending) || current.journal.intents.some(row => row.state !== "acknowledged")) return "held";
    const identified = entryOf({ ...currentEntry, placement: { ...pending, ...identities } });
    await writePlacementMap(store, current, changePlacementEntry(current.map, key, identified, { id: pending.id, state: "pending" }), key); // identity durable before rename/link
    await installBlobStage(folder, placementPlan(identified));
    current = await readBlobSyncState(store, key, map.scope); currentEntry = current.map.entries.find(row => row.key === key)!;
    if (!equalJournalValue(currentEntry.placement, identified.placement) || current.journal.intents.some(row => row.state !== "acknowledged")) return "held";
    const committed = entryOf({ ...placementBaseline(currentEntry), placement: { ...currentEntry.placement!, state: "committed" } });
    await writePlacementMap(store, current, changePlacementEntry(current.map, key, committed, { id: pending.id, state: "pending" }), key);
    const recovered = await recoverBlobPlacements(folder, store, map.scope);
    return recovered.held.length === 0 ? "placed" : "held";
  } catch (error) {
    if (error instanceof UnsafePlacementError || error instanceof JournalGuardConflict || error instanceof FileJournalUnavailableError || error instanceof RangeError && /exceeds the store's .* byte bound/.test(error.message)) return "held";
    throw error;
  }
}

export interface BlobRefreshReport {
  refreshed: string[]; removed: string[]; metadataUpdated: string[]; kept: string[];
  held: BlobCaptureHold[]; refused?: RefusedDeletions; taken?: boolean;
}
export function blobHostDeletionsToken(refused: RefusedDeletions): string {
  return `blobs:${refused.deletions}:${digestOf(Buffer.from(refused.digest)).slice(7, 19)}`;
}
/** One read-side pass under the checkout lock. A complete listing is not permission to overwrite local choices. */
export async function refreshBlobCheckout(options: {
  folder: string; scope: BlobTargetScope;
  store: BlobJournaledBackend & Pick<JournaledBackend, "readMeta">;
  carrier: HostedCarrier; capabilities: () => Promise<HostedCapabilities>; acceptToken?: string;
}): Promise<BlobRefreshReport | undefined> {
  const { folder, store, carrier, capabilities } = options, scope = scopeOf(options.scope), acceptToken = options.acceptToken;
  const raw = await store.readMeta(BLOB_SYNC_META_KEY);
  let map = decodeBlobSyncMap(raw, scope);
  const caps = await capabilities();
  if (caps.blobReads !== "allowed") return undefined;
  const out: BlobRefreshReport = { refreshed: [], removed: [], metadataUpdated: [], kept: [], held: [] };
  const hold = (key: string, message: string) => { out.kept.push(key); out.held.push({ key, reason: "not_sendable", message }); };
  const controller = new AbortController();
  const reader = createHostedBlobReadAdapter({ carrier, bundleId: scope.bundleId, prefix: scope.prefix, signal: controller.signal, capabilities: async () => caps });
  const knownReadFailure = (error: unknown) => error instanceof HostedReadAdapterError || error instanceof HostedCarrierError || error instanceof RemoteError;
  const guardedFailure = (error: unknown) => error instanceof JournalGuardConflict || error instanceof IntentHoldConflict || error instanceof FileJournalUnavailableError || error instanceof RangeError && /exceeds the store's .* byte bound/.test(error.message);
  const physical = async (key: string): Promise<string | null | undefined> => {
    const file = path.join(folder, ...key.split("/"));
    if (!await blobPathSafe(folder, key)) return undefined;
    const found = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
    if (found.state === "unsafe" || !await blobPathSafe(folder, key)) return undefined;
    return found.state === "missing" ? null : digestOf(found.bytes);
  };
  const snapshotFor = async (key: string) => {
    const snapshot = await readBlobSyncState(store, key, scope);
    if (!equalJournalValue(snapshot.map, map)) throw new JournalGuardConflict(key);
    return snapshot;
  };
  const eligible = async (key: string): Promise<BlobSyncSnapshot | undefined> => {
    const entry = map.entries.find(row => row.key === key);
    if (!isOrdinaryBlobKey(key)) { hold(key, `${key} is a protected namespace`); return; }
    if (findFilePathCollision([...map.entries.map(row => row.key), key])) { hold(key, `${key} aliases another ordinary-file projection owner`); return; }
    const snapshot = await snapshotFor(key);
    if (entry?.placement || snapshot.journal.intents.some(row => row.state !== "acknowledged")) { hold(key, `${key} has preserved intent or placement evidence`); return; }
    const actual = await physical(key);
    if (actual === undefined || (entry ? blobSyncDirty(entry, actual) : actual !== null)) { hold(key, `${key} has local bytes, an unknown baseline, an unsafe path, or an outstanding MIME choice`); return; }
    return snapshot;
  };
  const writeMap = async (snapshot: BlobSyncSnapshot, next: BlobSyncMap) => {
    if (!store.writeBlobMeta) throw new TypeError("file journal does not support guarded blob metadata");
    await store.writeBlobMeta(snapshot.journal.key, { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(next) }] }, { guard: snapshot.journal.guard });
    map = next;
  };
  try {
    let listing;
    try { listing = await reader.heads(); }
    catch (error) {
      if (!knownReadFailure(error)) throw error;
      hold("ordinary files", "ordinary-file listing is unavailable or inconsistent; no absence was applied");
      if (map.refusal) out.refused = map.refusal;
      return out;
    }
    const listed = new Set(listing.heads.map(head => head.key));
    let readsComplete = true;
    // No absence is applied until all required pinned reads finish. Only one body is retained at a time.
    for (const head of listing.heads) {
      if (findFilePathCollision([...map.entries.map(entry => entry.key), head.key])) { hold(head.key, `${head.key} aliases another ordinary-file projection owner`); readsComplete = false; continue; }
      const prior = map.entries.find(entry => entry.key === head.key);
      try {
        let snapshot = await eligible(head.key);
        if (!snapshot) continue;
        if (prior?.head && equalJournalValue(prior.head, head)) continue;
        if (prior?.head?.version === head.version) {
          const next = changeBlobSyncEntry(map, { ...prior, head });
          // Physical bytes are checked again after the metadata read; the baseline stays the original placed digest.
          if (await physical(head.key) !== prior.placedDigest) { hold(head.key, `${head.key} changed during refresh`); continue; }
          await writeMap(snapshot, next); out.metadataUpdated.push(head.key); continue;
        }
        const read = await reader.read(head);
        snapshot = await eligible(head.key);
        if (!snapshot) continue;
        if (await stageBlobPlacement(folder, store, snapshot, { key: head.key, head, bytes: read.bytes }) === "held") { hold(head.key, `${head.key} changed or placement could not finish safely`); continue; }
        map = (await readBlobSyncState(store, head.key, scope)).map;
        out.refreshed.push(head.key);
      } catch (error) {
        if (knownReadFailure(error)) { readsComplete = false; hold(head.key, `${head.key} pinned read is unavailable or changed; remote deletions are held`); }
        else if (guardedFailure(error)) { readsComplete = false; hold(head.key, `${head.key} journal changed or capacity was reached; remote deletions are held`); }
        else throw error;
      }
    }
    if (!readsComplete) { if (map.refusal) out.refused = map.refusal; return out; }
    const candidates: BlobSyncEntry[] = [];
    for (const entry of map.entries) if (entry.head && !listed.has(entry.key)) {
      try { if (await eligible(entry.key)) candidates.push(entry); }
      catch (error) { if (!guardedFailure(error)) throw error; hold(entry.key, `${entry.key} journal changed; no remote deletion applied`); return out; }
    }
    const digest = digestOf(Buffer.from(JSON.stringify(["superbee.blobs.remote-deletions.v1", scope, listing.revision, listing.digest, candidates.map(entry => [entry.key, entry.head!.version, entry.head!.contentType])])));
    const refused = deletionBound(listing.heads.length, map.entries.filter(entry => entry.head).length, candidates.length, digest);
    const accepted = map.refusal && acceptToken === blobHostDeletionsToken(map.refusal) ? map.refusal : undefined;
    // Supplying a token selects exact-set confirmation, even if the set has since shrunk
    // below the ordinary safety threshold. It must never fall through to no-token policy.
    if (acceptToken !== undefined && !refused) {
      out.taken = false;
      for (const entry of candidates) hold(entry.key, `${entry.key} is held because the supplied blob deletion token no longer names the current set; run sync without that token to use ordinary deletion policy`);
      return out;
    }
    const mustRefuse = refused && !acceptsRefusal(refused, accepted);
    const next = captureBlobSyncMap({ schemaVersion: 1, scope, entries: map.entries, ...(mustRefuse ? { refusal: refused } : {}) }, scope);
    if (!equalJournalValue(next, map)) {
      const anchor = map.entries[0]?.key ?? listing.heads[0]?.key ?? "blob-sync-control";
      try { await writeMap(await snapshotFor(anchor), next); }
      catch (error) { if (!guardedFailure(error)) throw error; hold(anchor, "ordinary-file refusal metadata could not be committed; no remote deletion applied"); return out; }
    }
    if (mustRefuse) {
      out.refused = refused;
      for (const entry of candidates) hold(entry.key, `${entry.key} is in a refused set of host deletions`);
      if (acceptToken !== undefined) out.taken = false;
      return out;
    }
    if (acceptToken !== undefined) out.taken = accepted !== undefined && refused !== undefined;
    for (const entry of candidates) {
      try {
        const snapshot = await eligible(entry.key);
        if (!snapshot) continue;
        if (await stageBlobPlacement(folder, store, snapshot, { key: entry.key, head: null }) === "held") { hold(entry.key, `${entry.key} changed or removal could not finish safely`); continue; }
        map = (await readBlobSyncState(store, entry.key, scope)).map;
        out.removed.push(entry.key);
      } catch (error) { if (!guardedFailure(error)) throw error; hold(entry.key, `${entry.key} journal changed or capacity was reached; no remote deletion applied`); }
    }
    return out;
  } finally { controller.abort(); }
}


export interface OfflineBlobAdmission {
  binding: import("./binding.js").CheckoutBinding;
  requestIds: string[];
  resumed: boolean;
  receipt: Record<string, unknown>;
}
/** Offline explicit command admission. This never authenticates, discovers a host head, or sends. */
export async function admitOfflineBlob(options: {
  operation: "promote" | "delete"; key: string; dir?: string; source?: string;
  expectedVersion?: string; contentType?: string; home: string; cwd: string;
}, locked?: { store: import("@superbee/core/file-journaled-backend").FileJournaledBackend; meta: { key: string; value: (requestId: string, prepared: string) => unknown } }): Promise<OfflineBlobAdmission | null> {
  const { resolveLocalBundleTarget } = await import("../bundle.js");
  const { bindingForPath, checkoutBindingDigest } = await import("./binding.js");
  const { readCheckoutMarker } = await import("./marker.js");
  const { withIdleCheckoutStore } = await import("./checkout-store.js");
  const { CliError } = await import("../errors.js");
  const input = captureJournalValue(options);
  const target = await resolveLocalBundleTarget(input.dir, input.cwd);
  const binding = await bindingForPath(input.home, target.canonicalRoot);
  if (!binding) {
    const marker = readCheckoutMarker(target.canonicalRoot);
    if (marker) {
      const { unboundCopyRefusal } = await import("./refusals.js");
      throw unboundCopyRefusal({ folder: target.canonicalRoot, marker }, "FORBIDDEN", "this copied or moved checkout must be adopted before ordinary-file admission");
    }
    return null;
  }
  const refuse = (message: string, reason = "blob_admission_held") => new CliError("CONFLICT", message, { details: { reason, key: input.key, submitted: false }, help: "preserve the file and resolve its checkout state before promoting or deleting it" });
  if (!isOrdinaryBlobKey(input.key)) throw refuse("ordinary-file admission refuses this reserved, document, model, View or publisher-owned key");
  const file = path.join(binding.path, ...input.key.split("/"));
  if (input.operation === "promote" && (!input.source || path.resolve(input.cwd, input.source) !== file)) throw new CliError("USAGE", "hosted promote requires the source to be the checkout target pathname", { help: `copy the source into ${commandToken(file)}, then promote that target with --doc-key ${commandToken(input.key)}` });
  const admit = async (store: import("@superbee/core/file-journaled-backend").FileJournaledBackend) => {
    if (!equalJournalValue(await bindingForPath(input.home, binding.path), binding)) throw refuse("checkout binding or folder changed before admission");
    const scope: BlobTargetScope = { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null };
    const recovery = await recoverBlobPlacements(binding.path, store, scope);
    if (recovery.held.some(row => row.key === null || row.key === input.key)) throw refuse("ordinary-file placement evidence must be recovered before admission");
    let snapshot = await readBlobSyncState(store, input.key, scope), entry = snapshot.map.entries.find(row => row.key === input.key);
    if (locked) {
      const journal = await store.readBlobWithJournal(input.key, { meta: [BLOB_SYNC_META_KEY, locked.meta.key] });
      if (journal.meta.has(locked.meta.key) || journal.intents.length) throw refuse("publication already has durable evidence");
      snapshot = { journal, map: decodeBlobSyncMap(journal.meta.get(BLOB_SYNC_META_KEY), scope) };
      entry = snapshot.map.entries.find(row => row.key === input.key);
    }
    if (entry?.placement) throw refuse("this file has unresolved placement evidence");
    if (findFilePathCollision([...snapshot.map.entries.map(row => row.key), input.key])) throw refuse("this key aliases another ordinary-file projection owner");
    if (!await blobPathSafe(binding.path, input.key)) throw refuse("this file has an unsafe parent");
    const physical = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
    if (physical.state === "unsafe" || !await blobPathSafe(binding.path, input.key)) throw refuse("this file is unsafe, changed during capture, or exceeds 16 MiB");
    const physicalDigest = physical.state === "missing" ? null : digestOf(physical.bytes);
    if (input.operation === "promote" && physical.state !== "present") throw refuse("promote requires the existing checkout target file");
    let keptType: string | undefined;
    const conflict = snapshot.journal.intents.some(settledBlobConflict) ? await readBlobConflict(store, scope, input.key) : undefined;
    if (conflict?.state === "conflict" && (input.operation === "delete" || input.expectedVersion !== undefined)) {
      // A replacement over the host's recorded head is the explicit form of `sync --resolve keep`.
      const recorded = conflict.evidence.actual;
      if (input.operation === "delete" || recorded === null || input.expectedVersion !== recorded) {
        throw new CliError("CONFLICT", `${input.key} has a version conflict: the host recorded ${recorded === null ? "a deletion" : `version ${recorded} (${conflict.evidence.actualContentType})`}; nothing was admitted`, { details: { reason: "blob_conflict", key: input.key, request_id: conflict.evidence.requestId, expected: conflict.evidence.expected, actual: recorded, actual_content_type: conflict.evidence.actualContentType, submitted: false }, help: input.operation === "promote" && recorded !== null ? `promote with --expected-version ${commandToken(recorded)}, or run sync --resolve keep|take --doc ${commandToken(input.key)} --dir ${commandToken(binding.path)}` : `sync --resolve keep|take --doc ${commandToken(input.key)} --dir ${commandToken(binding.path)}` });
      }
      await resolveBlobConflict({ folder: binding.path, store, scope, key: input.key, choice: "keep" });
      snapshot = await readBlobSyncState(store, input.key, scope); entry = snapshot.map.entries.find(row => row.key === input.key);
      keptType = entry?.desiredContentType;
    } else if (conflict?.state === "conflict") {
      // An explicit create is a new CAS attempt; the settled conflict it supersedes stops holding the key.
      await store.retireBlobIntents(input.key, conflict.evidence.requestIds, { guard: snapshot.journal.guard });
      snapshot = await readBlobSyncState(store, input.key, scope); entry = snapshot.map.entries.find(row => row.key === input.key);
    }
    const outstanding = snapshot.journal.intents.filter(row => row.receipt === undefined);
    const latest = snapshot.journal.intents.at(-1);
    const acknowledged = latest?.state === "acknowledged" && latest.receipt?.result.ok ? latest : undefined;
    const receiptHead = acknowledged?.receipt && "head" in acknowledged.receipt ? acknowledged.receipt.head : undefined;
    const acknowledgedPrepared = acknowledged === undefined ? undefined : decodePreparedBlobIntent(acknowledged.prepared);
    const acknowledgedDigest = acknowledgedPrepared?.intent.operationId === "blobs.delete.v1" ? null : acknowledgedPrepared?.intent.version;
    const currentAcknowledged = acknowledged !== undefined && receiptHead !== undefined && entry !== undefined &&
      equalJournalValue(entry.head, receiptHead) && entry.placedDigest === acknowledgedDigest && !blobSyncDirty(entry, physicalDigest);
    const retained = outstanding.length ? outstanding : currentAcknowledged ? [acknowledged!] : [];
    if (retained.length) {
      const row = retained[0]!, frozen = decodePreparedBlobIntent(row.prepared), intent = frozen.intent;
      const effectiveType = input.contentType ?? (input.expectedVersion === undefined ? (await import("@superbee/core")).resolveContentType(input.key) : entry?.desiredContentType ?? entry?.head?.contentType ?? (intent.operationId === "blobs.delete.v1" ? intent.expectedContentType : intent.contentType));
      const differences: string[] = [];
      if (retained.length !== 1) differences.push("multiple outstanding requests");
      if (!equalJournalValue(frozen.scope, scope)) differences.push("target scope");
      if (input.operation === "delete" ? intent.operationId !== "blobs.delete.v1" : intent.operationId !== (input.expectedVersion === undefined ? "blobs.create.v1" : "blobs.replace.v1")) differences.push("operation");
      if (input.operation === "promote" ? intent.expectedVersion !== (input.expectedVersion ?? null) : input.expectedVersion !== undefined && intent.expectedVersion !== input.expectedVersion) differences.push("CAS premise");
      if (input.operation === "promote" && intent.operationId !== "blobs.delete.v1" && (physicalDigest !== intent.version || effectiveType !== intent.contentType)) differences.push("bytes or MIME");
      if (input.operation === "delete" && (physical.state !== "missing" || entry?.desiredContentType !== undefined && entry.desiredContentType !== intent.expectedContentType)) differences.push("recreated bytes or MIME choice");
      if (outstanding.length && intent.expectedVersion !== null && (!entry?.head || entry.head.version !== intent.expectedVersion || entry.head.contentType !== intent.expectedContentType)) differences.push("observed MIME baseline");
      if (differences.length && outstanding.length) throw new CliError("CONFLICT", `preserved request ${row.requestId} differs in ${differences.join(", ")}; nothing was submitted`, { details: { reason: "blob_resume_mismatch", request_id: row.requestId, differences, frozen: { operation: intent.operationId, expectedVersion: intent.expectedVersion, expectedContentType: intent.expectedContentType, ...(intent.operationId === "blobs.delete.v1" ? {} : { version: intent.version, contentType: intent.contentType }) }, submitted: false }, help: "preserve this intent and resolve the differing representation before retrying" });
      if (differences.length === 0) return { binding, requestIds: [row.requestId], resumed: true, receipt: { [input.operation]: "pending", status: "incomplete", route: "blob", key: input.key, request_id: row.requestId, submitted: false } };
    }
    if ((input.operation === "delete" || input.expectedVersion !== undefined) && (!entry?.head || input.expectedVersion !== undefined && input.expectedVersion !== entry.head.version)) throw refuse("replacement or deletion requires the preserved observed digest and MIME baseline matching --expected-version");
    if (input.operation === "delete" && blobSyncDirty(entry!, physicalDigest)) throw refuse("delete refuses locally changed bytes or an outstanding MIME choice");
    const { resolveContentType } = await import("@superbee/core");
    const contentType = input.operation === "delete" ? undefined : input.contentType ?? (input.expectedVersion === undefined ? resolveContentType(input.key) : keptType ?? entry!.head!.contentType);
    const intent = input.operation === "delete"
      ? { operationId: "blobs.delete.v1" as const, key: input.key, expectedVersion: entry!.head!.version, expectedContentType: entry!.head!.contentType }
      : input.expectedVersion === undefined
        ? { operationId: "blobs.create.v1" as const, key: input.key, expectedVersion: null, expectedContentType: null, version: physicalDigest!, contentType: contentType! }
        : { operationId: "blobs.replace.v1" as const, key: input.key, expectedVersion: entry!.head!.version, expectedContentType: entry!.head!.contentType, version: physicalDigest!, contentType: contentType! };
    const { resolveHostedVia } = await import("./via.js");
    const via = resolveHostedVia(process.env).token;
    const prepared = prepareBlobIntent({ scope, intent, identity: { requestId: mintRequestId(), binding: checkoutBindingDigest(binding.checkout_id), ...(via === undefined ? {} : { via }) }, createdAt: new Date().toISOString() }, input.operation === "promote" && physical.state === "present" ? physical.bytes : undefined);
    const next = input.operation === "delete" ? snapshot.map : changeBlobSyncEntry(snapshot.map, { ...(entry ?? { key: input.key, placedDigest: null }), desiredContentType: contentType! });
    let removed = false;
    if (input.operation === "delete" && physical.state === "present") {
      if (!equalJournalValue(await bindingForPath(input.home, binding.path), binding)) throw refuse("checkout binding or folder changed before local deletion");
      const { removeGuarded } = await import("./sync-scan.js");
      if (!await blobPathSafe(binding.path, input.key) || !await removeGuarded(file, physical.bytes)) throw refuse("the file changed before local deletion; no intent was admitted");
      removed = true;
    }
    let record: BlobIntentRecord;
    try {
      if (!equalJournalValue(await bindingForPath(input.home, binding.path), binding)) throw refuse("checkout binding or folder changed before durable admission");
      record = await store.admitPreparedBlob(prepared, { guard: snapshot.journal.guard, ...(input.operation === "promote" ? { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(next) }, ...(locked ? [{ key: locked.meta.key, value: locked.meta.value(decodePreparedBlobIntent(prepared).identity.requestId, prepared) }] : [])] } : {}) }); }
    catch (error) {
      if (removed) throw Object.assign(new CliError("TRANSIENT", "the file was removed locally but its deletion was not submitted or durably admitted; sync can capture its genuine absence", { details: { reason: "blob_delete_local_unsubmitted", key: input.key, local_removed: true, submitted: false }, help: "keep the preserved baseline and run sync to capture the local deletion" }), { cause: error });
      throw error;
    }
    return { binding, requestIds: [record.requestId], resumed: false, receipt: { [input.operation]: "pending", status: "incomplete", route: "blob", key: input.key, request_id: record.requestId, submitted: false, ...(contentType === undefined ? { local_removed: removed } : { content_type: contentType, version: physicalDigest }) } };
  };
  const result = locked ? await admit(locked.store) : await withIdleCheckoutStore(binding, input.home, admit, { readOnly: false });
  if (result === null) throw refuse("checkout is busy; nothing was admitted", "sync_busy");
  return result;
}

/**
 * A host refusal settled with its receipt (anything but a version conflict, which waits for
 * --resolve): final for its identity, which is never sent again. Sync reports it once and then
 * retires it. A tracked file's change is then captured anew on the next run, as an edited
 * document would be; a new file has no host baseline, so it stays local until promote sends it.
 */
export function retirableBlobRefusal(row: BlobIntentRecord): boolean {
  return row.state === "refused" && row.receipt !== undefined && !row.receipt.result.ok && !settledBlobConflict(row);
}
/** Caller holds the checkout lock. Retires each key's settled refusals under its map and journal guard; a key whose guard moved keeps them for the next run. */
export async function retireBlobRefusals(store: BlobJournaledBackend, scope: BlobTargetScope, keys: Iterable<string>): Promise<void> {
  for (const key of new Set(keys)) {
    try {
      const snapshot = await readBlobSyncState(store, key, scope);
      const ids = snapshot.journal.intents.filter(retirableBlobRefusal).map(row => row.requestId);
      if (ids.length) await store.retireBlobIntents(key, ids, { guard: snapshot.journal.guard });
    } catch (error) {
      if (!(error instanceof JournalGuardConflict || error instanceof FileJournalUnavailableError)) throw error;
    }
  }
}
/** A terminal version conflict: proven not applied, so its identity is never sent again. */
export function settledBlobConflict(row: BlobIntentRecord): boolean {
  const result = row.receipt?.result;
  return row.state === "conflict" && result !== undefined && !result.ok && result.error.code === "version_conflict" && result.error.writeState === "not_applied";
}
export function blobConflictMessage(key: string): string {
  return `${key} conflicts with a newer host version; nothing is sent for it until you resolve it with sync --resolve keep or take --doc ${commandToken(key)}`;
}
export interface BlobConflictEvidence {
  key: string;
  /** The latest conflicted request; every settled conflict row on the key is retired together. */
  requestId: string;
  requestIds: string[];
  operation: "blobs.create.v1" | "blobs.replace.v1" | "blobs.delete.v1";
  expected: string | null; expectedContentType: string | null;
  actual: string | null; actualContentType: string | null;
  /** The conflicted local representation; null for a deletion. */
  version: string | null; contentType: string | null;
}
export type BlobConflictLookup =
  | { state: "conflict"; snapshot: BlobSyncSnapshot; evidence: BlobConflictEvidence }
  | { state: "none" | "outstanding" | "placement" };
/** Caller holds the checkout lock. Reads only. */
export async function readBlobConflict(store: BlobJournaledBackend, scope: BlobTargetScope, key: string): Promise<BlobConflictLookup> {
  const captured = scopeOf(scope), snapshot = await readBlobSyncState(store, key, captured);
  const conflicts = snapshot.journal.intents.filter(settledBlobConflict).sort((a, b) => a.sequence - b.sequence);
  if (conflicts.length === 0) return { state: "none" };
  if (snapshot.map.entries.find(row => row.key === key)?.placement) return { state: "placement" };
  if (snapshot.journal.intents.some(row => row.state !== "acknowledged" && !settledBlobConflict(row))) return { state: "outstanding" };
  const latest = conflicts.at(-1)!, prepared = decodePreparedBlobIntent(latest.prepared), intent = prepared.intent;
  if (!equalJournalValue(prepared.scope, captured)) throw new TypeError("blob conflict scope mismatch");
  const result = latest.receipt!.result;
  if (result.ok) throw new TypeError("blob conflict receipt mismatch");
  const error = result.error;
  return { state: "conflict", snapshot, evidence: {
    key, requestId: latest.requestId, requestIds: conflicts.map(row => row.requestId), operation: intent.operationId,
    expected: intent.expectedVersion, expectedContentType: intent.expectedContentType,
    actual: error.actual ?? null, actualContentType: error.actualContentType ?? null,
    version: intent.operationId === "blobs.delete.v1" ? null : intent.version, contentType: intent.operationId === "blobs.delete.v1" ? null : intent.contentType,
  } };
}
export interface BlobConflictResolution {
  key: string;
  choice: "keep" | "take";
  evidence: BlobConflictEvidence;
  /** What happened to the checkout file. */
  file: "unchanged" | "removed" | "placed" | "absent";
  /** keep: the next plain sync sends a new request for this key. */
  sends: boolean;
  /** keep after a host deletion: the create admitted under a new request id. */
  admitted?: string;
  /** take: the host's bytes could not be placed now; the next sync places them. */
  placementDeferred?: boolean;
}
/**
 * The one owner of blob conflict resolution; the caller holds the checkout lock. It acts only on a
 * settled version conflict with no other outstanding row and no placement WAL, and never resends
 * the conflicted identity: its rows are retired under the same-key journal guard together with the
 * new baseline, and any later send is a new request with explicit version and MIME pins.
 * keep moves the base to the host's recorded head, so the next sync sends the file as it is then
 * (the host CAS still refuses it if the host moved again). take discards the conflicted bytes,
 * records observed absence, and places the host's current bytes when a pinned read succeeds.
 */
export async function resolveBlobConflict(options: {
  folder: string; store: BlobJournaledBackend & Pick<JournaledBackend, "readMeta">; scope: BlobTargetScope; key: string; choice: "keep" | "take";
  /** keep after a host deletion with the file present admits a create under this identity. */
  identity?: { binding: string; via?: string; createdAt: string };
  /** take: a pinned read of the host head; omitted, or failing, leaves the placement to the next sync. */
  read?: (head: BlobHead) => Promise<Uint8Array>;
}): Promise<BlobConflictResolution> {
  const { CliError } = await import("../errors.js");
  const { folder, store, key, choice } = options, scope = scopeOf(options.scope);
  const resolveHelp = `sync --resolve keep|take --doc ${commandToken(key)} --dir ${commandToken(folder)}`;
  const found = await readBlobConflict(store, scope, key);
  if (found.state === "none") throw new CliError("NOT_FOUND", `'${key}' has no ordinary-file conflict to resolve in this checkout`, { details: { reason: "no_conflict", key }, help: `sync --dir ${commandToken(folder)}` });
  if (found.state !== "conflict") throw new CliError("CONFLICT", `'${key}' has ${found.state === "placement" ? "unfinished placement evidence" : "an unfinished or refused request that is not a version conflict"}; nothing was resolved`, { details: { reason: found.state === "placement" ? "blob_placement_recovery" : "blob_outstanding", key }, help: `run sync --dir ${commandToken(folder)} first; if it reports a conflict on ${key}, then ${resolveHelp}` });
  const { snapshot, evidence } = found;
  const file = path.join(folder, ...key.split("/"));
  if (!await blobPathSafe(folder, key)) throw new CliError("CONFLICT", `${key} has an unsafe parent; nothing was resolved`, { details: { reason: "unsafe_path", key } });
  const physical = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
  if (physical.state === "unsafe" || !await blobPathSafe(folder, key)) throw new CliError("CONFLICT", `${key} is unsafe or exceeds 16 MiB; nothing was resolved`, { details: { reason: "unsafe_path", key } });
  const hostHead: BlobHead | null = evidence.actual === null ? null : captureBlobHead({ key, version: evidence.actual, contentType: evidence.actualContentType! });
  const retire = async (from: BlobSyncSnapshot, next: BlobSyncEntry) => {
    await store.retireBlobIntents(key, evidence.requestIds, { guard: from.journal.guard, meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(changeBlobSyncEntry(from.map, next)) }] });
  };
  if (choice === "keep") {
    // Only a MIME the person chose survives keep; the old head's type must not revert the host's.
    const chosenType = snapshot.map.entries.find(row => row.key === key)?.desiredContentType;
    const frozenType = evidence.contentType ?? undefined;
    if (hostHead && physical.state === "missing" && evidence.operation !== "blobs.delete.v1") {
      // keep means "send my edit"; a file gone since the conflict would turn it into a host deletion nobody chose.
      throw new CliError("CONFLICT", `${file} is missing, so keep would delete the host's version; nothing was resolved`, { details: { reason: "missing_since_conflict", key, file }, help: `put the file back to keep it, or take the host's version: ${resolveHelp.replace("keep|take", "take")}` });
    }
    if (hostHead) {
      // The base moves: the host's version becomes what this checkout last saw.
      await retire(snapshot, { key, head: hostHead, placedDigest: hostHead.version, ...(chosenType === undefined || chosenType === hostHead.contentType ? {} : { desiredContentType: chosenType }) });
      return { key, choice, evidence, file: "unchanged", sends: physical.state === "present" ? digestOf(physical.bytes) !== hostHead.version || (chosenType ?? hostHead.contentType) !== hostHead.contentType : true };
    }
    await retire(snapshot, { key, head: null, placedDigest: null });
    if (physical.state !== "present" || !options.identity) return { key, choice, evidence, file: physical.state === "present" ? "unchanged" : "absent", sends: false };
    // The host deleted it: a create is the only send that can re-apply the local bytes.
    const contentType = chosenType ?? frozenType ?? evidence.expectedContentType!;
    const current = await readBlobSyncState(store, key, scope), entry = current.map.entries.find(row => row.key === key) ?? { key, placedDigest: null };
    const prepared = prepareBlobIntent({ scope, intent: { operationId: "blobs.create.v1", key, expectedVersion: null, expectedContentType: null, version: digestOf(physical.bytes), contentType }, identity: { requestId: mintRequestId(), binding: options.identity.binding, ...(options.identity.via === undefined ? {} : { via: options.identity.via }) }, createdAt: options.identity.createdAt }, physical.bytes);
    const record = await store.admitPreparedBlob(prepared, { guard: current.journal.guard, meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(changeBlobSyncEntry(current.map, { ...entry, desiredContentType: contentType })) }] });
    return { key, choice, evidence, file: "unchanged", sends: true, admitted: record.requestId };
  }
  // take: only the conflicted bytes (or their absence) may be discarded, never a later edit.
  const discardable = physical.state === "missing" || evidence.operation !== "blobs.delete.v1" && digestOf(physical.bytes) === evidence.version;
  if (!discardable) throw new CliError("CONFLICT", `${file} has edits made since the conflict, which take would discard`, { details: { reason: "edited_since_conflict", key, file }, help: `remove the file first to discard edits made since the conflict, or keep them: sync --resolve keep --doc ${commandToken(key)} --dir ${commandToken(folder)}` });
  let removed = false;
  if (physical.state === "present") {
    const { removeGuarded } = await import("./sync-scan.js");
    if (!await blobPathSafe(folder, key) || !await removeGuarded(file, physical.bytes)) throw new CliError("CONFLICT", `${file} changed while resolving it; nothing was resolved`, { details: { reason: "edited_since_conflict", key, file } });
    removed = true;
  }
  // Crash between the removal and this write: a rerun finds the file missing and continues.
  await retire(snapshot, { key, head: null, placedDigest: null });
  if (!hostHead) return { key, choice, evidence, file: removed ? "removed" : "absent", sends: false };
  let bytes: Uint8Array | undefined;
  if (options.read) {
    try { bytes = await options.read(hostHead); }
    catch (error) { if (!(error instanceof HostedReadAdapterError || error instanceof HostedCarrierError || error instanceof RemoteError)) throw error; }
  }
  if (bytes === undefined || digestOf(bytes) !== hostHead.version) return { key, choice, evidence, file: removed ? "removed" : "absent", sends: false, placementDeferred: true };
  const placed = await stageBlobPlacement(folder, store, await readBlobSyncState(store, key, scope), { key, head: hostHead, bytes });
  return { key, choice, evidence, file: placed === "placed" ? "placed" : removed ? "removed" : "absent", sends: false, ...(placed === "placed" ? {} : { placementDeferred: true }) };
}

export type BlobFileState = "clean" | "pending" | "conflict" | "unknown" | "refused" | "held";
/**
 * Local-only classification of every tracked ordinary file for status: no request, no store or
 * folder write. pending is admitted or changed and not yet sent; unknown was sent and its answer
 * was lost; held needs the person (placement evidence, an unsafe path, no baseline, or a proven
 * host deletion hold).
 */
export async function blobCheckoutStates(folder: string, store: BlobJournaledBackend & Pick<JournaledBackend, "readMeta">, scope: BlobTargetScope): Promise<{ key: string; state: BlobFileState }[]> {
  const map = decodeBlobSyncMap(await store.readMeta(BLOB_SYNC_META_KEY), scopeOf(scope));
  const rows = (await store.listBlobIntents()).filter(row => row.state !== "acknowledged");
  const keys = [...new Set([...map.entries.map(entry => entry.key), ...rows.map(row => row.target)])].sort(compareStorageKeys);
  const out: { key: string; state: BlobFileState }[] = [];
  for (const key of keys) {
    const mine = rows.filter(row => row.target === key), entry = map.entries.find(row => row.key === key);
    const deletionHeld = (row: BlobIntentRecord) => !row.receipt && row.attempts > 0 && row.notAppliedThrough === row.attempts && row.deletionHold !== undefined;
    let state: BlobFileState;
    if (mine.some(settledBlobConflict)) state = "conflict";
    else if (mine.some(row => row.receipt)) state = "refused";
    else if (mine.some(deletionHeld)) state = "held";
    else if (mine.some(row => row.attempts > 0)) state = "unknown";
    else if (mine.length) state = "pending";
    else if (!entry) continue;
    else if (entry.placement || !isOrdinaryBlobKey(key) || !await blobPathSafe(folder, key)) state = "held";
    else {
      const found = readRegularFileNoFollowSync(path.join(folder, ...key.split("/")), { maximumBytes: 16 * 1024 * 1024 });
      if (found.state === "unsafe") state = "held";
      else if (!blobSyncDirty(entry, found.state === "missing" ? null : digestOf(found.bytes))) state = "clean";
      else state = entry.head ? "pending" : "held";
    }
    out.push({ key, state });
  }
  return out;
}
