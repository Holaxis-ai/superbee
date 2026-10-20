/** Publication linkage never grants delivery authority; the existing checkout journal owns writes. */
import path from "node:path";
import { baseKey, commitLocal, openLocalBundle } from "@superbee/browser-local";
import { assertSafeConceptId, loadKinds, readBundleOkfVersion, progressStatusStorageField, type OkfDocument } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { captureJournalValue, equalJournalValue, type IntentRecord, type JournaledWriteOptions } from "@superbee/core/journaled-backend";
import { blobReceipt, decodePreparedBlobIntent, isContentVersion, isWriteRequestId, type BlobTargetScope } from "@superbee/core/storage";
import { wholeDocumentRequest } from "@superbee/core/hosted-transport";
import { CliError } from "../errors.js";
import { readRegularFileNoFollowSync } from "../nofollow-read.js";
import { digestOf } from "./projection.js";
import { checkoutBindingDigest, type CheckoutBinding } from "./binding.js";
import { readBlobSyncState } from "./blob-sync.js";
import { exportCheckout, placeQueuedLocalCreate, type ProjectionRecord } from "./sync-scan.js";
export const ARTIFACT_META_PREFIX = "hosted.artifact.create.v1:";
export const ARTIFACT_ROWS = 256, ARTIFACT_ROW_BYTES = 16_384, ARTIFACT_TOTAL_BYTES = 4_194_304;
export interface Publication {
  schema: 1; id: string; entry: string; scope: BlobTargetScope; binding: string; principal: string;
  title: string; description?: string; actor: string; digest: string; contentType: "text/html";
  blobRequestId: string; state: "blob_admitted" | "record_admitted";
  record?: { requestId: string; localVersion: string; rawDigest: string };
}
const held = (message: string) => new CliError("CONFLICT", message, { details: { reason: "artifact_publication_held" }, help: "preserve the original requests; inspect checkout status before retrying" });
export const publicationKey = (id: string): string => ARTIFACT_META_PREFIX + id;
export function publicationScope(b: CheckoutBinding): BlobTargetScope { return { origin: b.origin, prefix: b.routes, bundleId: b.bundle_id, workspaceSlug: b.workspace_slug ?? null }; }
export function decodePublication(value: unknown): Publication {
  const p = captureJournalValue(value) as Publication;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !["schema", "id", "entry", "scope", "binding", "principal", "title", "description", "actor", "digest", "contentType", "blobRequestId", "state", "record"].includes(k)) || p.schema !== 1) throw held("invalid Artifact publication metadata");
  assertSafeConceptId(p.id);
  if (!/^artifacts\/[a-z0-9][a-z0-9-]*$/.test(p.id) || p.entry !== `${p.id}.html` || !isContentVersion(p.digest) || !isWriteRequestId(p.blobRequestId) || p.contentType !== "text/html" || !["blob_admitted", "record_admitted"].includes(p.state) || typeof p.title !== "string" || !p.title.trim() || typeof p.actor !== "string" || !p.actor || typeof p.binding !== "string" || !p.binding || typeof p.principal !== "string" || !p.principal || p.description !== undefined && typeof p.description !== "string") throw held("invalid Artifact publication identity");
  const s = p.scope;
  if (!s || Object.keys(s).sort().join(",") !== "bundleId,origin,prefix,workspaceSlug" || typeof s.origin !== "string" || new URL(s.origin).origin !== s.origin || typeof s.prefix !== "string" || !s.prefix.startsWith("/") || typeof s.bundleId !== "string" || !(s.workspaceSlug === null || typeof s.workspaceSlug === "string")) throw held("invalid Artifact publication scope");
  if (p.state === "record_admitted" ? !p.record || Object.keys(p.record).sort().join(",") !== "localVersion,rawDigest,requestId" || !isWriteRequestId(p.record.requestId) || !isContentVersion(p.record.localVersion) || !isContentVersion(p.record.rawDigest) : p.record !== undefined) throw held("invalid Artifact record linkage");
  if (Buffer.byteLength(JSON.stringify(p)) > ARTIFACT_ROW_BYTES) throw held("Artifact publication row exceeds 16 KiB");
  return p;
}
export async function publications(store: FileJournaledBackend, replacement?: Publication): Promise<Publication[]> {
  const rows = await store.listMeta(ARTIFACT_META_PREFIX);
  const decoded = rows.map(row => { const p = decodePublication(row.value); if (row.key !== publicationKey(p.id)) throw held("Artifact publication key mismatch"); return p; });
  const all = replacement ? [...decoded.filter(p => p.id !== replacement.id), decodePublication(replacement)] : decoded;
  if (all.length > ARTIFACT_ROWS || all.reduce((n, p) => n + Buffer.byteLength(publicationKey(p.id)) + Buffer.byteLength(JSON.stringify(p)), 0) > ARTIFACT_TOTAL_BYTES) throw held("Artifact publication capacity reached (256 retained publications / 4 MiB); no new publication was admitted");
  return all;
}
export function assertPublicationBinding(p: Publication, binding: CheckoutBinding): void {
  if (p.binding !== checkoutBindingDigest(binding.checkout_id) || p.principal !== binding.principal_id || !equalJournalValue(p.scope, publicationScope(binding))) throw held("Artifact publication belongs to another checkout authority");
}
export function assertPublicationSource(p: Publication, folder: string): void {
  const file = readRegularFileNoFollowSync(path.join(folder, ...p.entry.split("/")), { maximumBytes: 16 * 1024 * 1024 });
  if (file.state !== "present" || digestOf(file.bytes) !== p.digest) throw held("Artifact source differs from its frozen publication bytes");
}
export async function acknowledgedArtifactBlob(store: FileJournaledBackend, p: Publication): Promise<string | null> {
  const row = await store.readBlobIntent(p.blobRequestId);
  if (!row) throw held("original Artifact blob evidence is missing; its outcome is not reconstructed");
  const prepared = decodePreparedBlobIntent(row.prepared);
  if (!equalJournalValue(prepared.scope, p.scope) || prepared.identity.binding !== p.binding || prepared.intent.operationId !== "blobs.create.v1" || prepared.intent.key !== p.entry || prepared.intent.version !== p.digest || prepared.intent.contentType !== p.contentType || row.target !== p.entry) throw held("Artifact blob evidence differs from its reservation");
  if (!row.receipt) return null;
  const receipt = blobReceipt(row.prepared, row.receipt.result);
  if (!equalJournalValue(receipt, row.receipt) || !receipt.result.ok || row.state !== "acknowledged") throw held(`Artifact blob has retained ${row.state} evidence; no record was admitted`);
  if (!("head" in receipt) || !receipt.head) throw held("Artifact blob receipt has no committed head");
  const state = await readBlobSyncState(store, p.entry, p.scope);
  const entry = state.map.entries.find(e => e.key === p.entry);
  if (!entry?.head || !equalJournalValue(entry.head, receipt.head) || entry.placement || entry.placedDigest !== p.digest) throw held("Artifact blob receipt has not settled its exact checkout baseline");
  return receipt.head.version;
}
/** One exact-target adapter adds a full guard to commitLocal's policy-preserving create. */
export async function admitArtifactRecord(store: FileJournaledBackend, p: Publication, entryVersion: string, maximumBytes: number): Promise<Publication> {
  p = decodePublication(p);
  if (await acknowledgedArtifactBlob(store, p) !== entryVersion) throw held("Artifact record admission requires its exact settled blob acknowledgment");
  const key = publicationKey(p.id), base = baseKey(p.id);
  const snapshot = await store.readWithJournal(p.id, { meta: [base, key] });
  if (snapshot.document || snapshot.intents.length || snapshot.meta.has(base) || !equalJournalValue(snapshot.meta.get(key), p) || p.state !== "blob_admitted") throw held("Artifact record no longer has an empty create-null admission snapshot");
  const guard = { target: p.id, document: null, intents: [], meta: [{ key: base, expected: { present: false as const } }, { key, expected: { present: true as const, value: p } }] };
  const registry = await loadKinds({ root: "", backend: store });
  const edition = await readBundleOkfVersion({ root: "", backend: store });
  const retained = await publications(store);
  let used = false;
  const backend = new Proxy(store, { get(inner, prop) {
    if (prop === "writeJournaled") return async (id: string, doc: OkfDocument, options: JournaledWriteOptions = {}) => {
      const intent = options.intent;
      if (used || id !== p.id || doc.id !== p.id || options.expectedVersion !== null || !intent || intent.kind !== "document.write" || intent.target !== p.id || intent.base !== null || intent.baseContent !== null || intent.after !== undefined || intent.recreates !== undefined || options.supersede || options.resolveIntents || options.removeMeta || options.meta || options.guard && !equalJournalValue(options.guard, guard)) throw held("Artifact admission refused an incompatible composed create");
      used = true;
      return inner.writeJournaled(id, doc, { ...options, guard, meta: ({ raw, version }) => {
        if (Buffer.byteLength(raw) > maximumBytes || Buffer.byteLength(JSON.stringify(wholeDocumentRequest(p.scope.bundleId, { ...intent, content: raw }, edition).payload)) > maximumBytes) throw held("serialized Artifact document exceeds the host input bound");
        const next = decodePublication({ ...p, state: "record_admitted", record: { requestId: intent.requestId, localVersion: version, rawDigest: digestOf(Buffer.from(raw)) } });
        const future = retained.map(row => row.id === next.id ? next : row);
        if (future.reduce((n, row) => n + Buffer.byteLength(publicationKey(row.id)) + Buffer.byteLength(JSON.stringify(row)), 0) > ARTIFACT_TOTAL_BYTES) throw held("Artifact publication metadata expansion exceeds its total byte bound");
        return [{ key, value: next }];
      } });
    };
    const v = Reflect.get(inner, prop, inner); return typeof v === "function" ? v.bind(inner) : v;
  } });
  await commitLocal(openLocalBundle("artifact-admission", { backend }), p.id, { mode: "create-only", registry, strict: true, actor: p.actor, persistActor: true, buildCandidate: (_existing, context) => ({ frontmatter: { type: "Artifact", title: p.title, entry: p.entry, entry_version: entryVersion, ...(p.description === undefined ? {} : { description: p.description }), [progressStatusStorageField(context.okfVersion)!]: "active" }, body: "" }) });
  return decodePublication(await store.readMeta(key));
}
export interface InitialPlacementHold { publication: Publication; intent: IntentRecord; raw: string; version: string }
export async function initialArtifactOwner(store: FileJournaledBackend, projection: ProjectionRecord, p: Publication): Promise<InitialPlacementHold | null> {
  if (!p.record || Object.hasOwn(projection.files, p.id)) return null;
  const snap = await store.readWithJournal(p.id, { meta: [baseKey(p.id)] });
  const row = snap.intents[0];
  if (!snap.document || snap.intents.length !== 1 || !row || row.requestId !== p.record.requestId || row.target !== p.id || row.kind !== "document.write" || row.base !== null || row.baseContent !== null || row.after || row.recreates || row.local !== p.record.localVersion || digestOf(Buffer.from(row.content)) !== p.record.rawDigest) return null;
  const exactLocal = snap.document.version === p.record.localVersion && digestOf(Buffer.from(snap.raw!)) === p.record.rawDigest;
  if (!exactLocal) {
    const base = snap.meta.get(baseKey(p.id)) as { version?: string; content?: string; tombstone?: string } | undefined;
    if (row.state !== "acknowledged" || row.acknowledgedVersion !== snap.document.version || base?.version !== snap.document.version || base.content !== snap.raw || base.tombstone) return null;
  } else if (row.state !== "acknowledged" && snap.meta.has(baseKey(p.id))) return null;
  return { publication: p, intent: row, raw: snap.raw!, version: snap.document.version };
}
export async function recoverArtifactRecord(store: FileJournaledBackend, folder: string, projection: ProjectionRecord, p: Publication): Promise<InitialPlacementHold | null> {
  const owner = await initialArtifactOwner(store, projection, p);
  if (!owner) return null;
  if (owner.intent.state === "acknowledged") await exportCheckout(folder, store, projection, { only: new Set([p.id]), placeMissing: true });
  else await placeQueuedLocalCreate(folder, store, projection, { id: p.id, requestId: owner.intent.requestId, localVersion: owner.version, rawDigest: digestOf(Buffer.from(owner.raw)) });
  const still = await initialArtifactOwner(store, projection, p);
  return still && equalJournalValue(still, owner) ? still : null;
}
export async function originalArtifactRecord(store: FileJournaledBackend, p: Publication): Promise<IntentRecord | null> {
  if (!p.record) return null;
  const snap = await store.readWithJournal(p.id);
  const row = snap.intents.find(r => r.requestId === p.record!.requestId);
  if (!row || snap.intents.length !== 1 || row.local !== p.record.localVersion || digestOf(Buffer.from(row.content)) !== p.record.rawDigest || !snap.document || !(snap.document.version === row.local || row.state === "acknowledged" && snap.document.version === row.acknowledgedVersion)) throw held("original Artifact record evidence changed or was retired; ordinary editing retains ownership");
  return row;
}
