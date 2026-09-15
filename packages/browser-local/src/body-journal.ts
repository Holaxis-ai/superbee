/** Admission, immutable evidence and capacity for the existing journal's body delivery mode. */
import { parseMarkdown, stringifyDoc, normalizeDocumentBodyForStorage, captureRemoteFrontmatter } from "@superbee/core/document-codec";
import { readBundleOkfVersion } from "@superbee/core/engine";
import { BODY_DELIVERY_LIMITS, BODY_RECONCILIATION_BYTES, prepareBodyDelivery, validatePreparedBodyDelivery, validateBodyReceipt,
  assertSameBodyDelivery, type PreparedBodyDelivery, type CommittedBodyReceipt } from "@superbee/core/governed-body-write";
import { captureJournalValue, JournalGuardConflict, type JournalGuard, type JournaledBackend, type JournaledReadResult, type IntentRecord, type MetaRecord, type JournaledWriteOptions, type JournaledDeleteOptions, type IntentPatch, type IntentUpdateOptions } from "@superbee/core/journaled-backend";
import { isContentVersion, versionOfBytes } from "@superbee/core/versioning";
import type { OkfDocument, Version, StorageBackend } from "@superbee/core";
import { assertJournalGuard } from "@superbee/core/journaled-backend";

export const BODY_MODE_KEY = "body-delivery:mode";
export const BODY_RUNTIME_LIMITS = Object.freeze({ journalBytes: 8 * 1024 * 1024, guardedBytes: 32 * 1024 * 1024, unsettled: 2, transitionBytes: 2 * 1024 * 1024, controlBytes: 64 * 1024 });
const E = BODY_DELIVERY_LIMITS.envelopeBytes;
export interface BodyMode { schema: 1; kind: "document.body.update"; scope: string; okfVersion: "0.1" | "0.2" }
export interface BodyDeliveryOptions { scope: string; okfVersion: "0.1" | "0.2"; dedicated?: true }
export interface BodyRecord {
  schema: 1; requestId: string; target: string; scope: string; okfVersion: "0.1" | "0.2"; body: string;
  initialVersion: Version | null; prepared?: PreparedBodyDelivery; receipt?: CommittedBodyReceipt;
}
export class BodyRuntimeError extends Error {
  override readonly name: string = "BodyRuntimeError";
  constructor(message: string) { super(message); }
}
export class BodyCapacityError extends BodyRuntimeError {
  override readonly name = "BodyCapacityError";
  constructor() { super("Working copy capacity cannot reserve delivery evidence. Retain or export existing work before adding more history."); }
}
export function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const copy = captureJournalValue(value);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) throw new BodyRuntimeError("Invalid body delivery record.");
  const row = copy as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) throw new BodyRuntimeError("Invalid body delivery fields.");
  return row;
}
export function bodyMode(value: BodyDeliveryOptions): BodyMode {
  const row = shape(value, ["scope", "okfVersion"], ["dedicated"]);
  if (typeof row.scope !== "string" || !row.scope.trim() || jsonBytes(row.scope) > BODY_DELIVERY_LIMITS.labelBytes || !["0.1", "0.2"].includes(row.okfVersion as string) || (Object.hasOwn(row, "dedicated") && row.dedicated !== true)) throw new BodyRuntimeError("Invalid body delivery scope or edition.");
  return Object.freeze({ schema: 1, kind: "document.body.update", scope: row.scope, okfVersion: row.okfVersion as BodyMode["okfVersion"] });
}
function storedMode(value: unknown): BodyMode {
  const row = shape(value, ["schema", "kind", "scope", "okfVersion", "controls"]);
  if (row.schema !== 1 || row.kind !== "document.body.update") throw new BodyRuntimeError("Unsupported working copy mode.");
  const controls = shape(row.controls, [], ["sync", "bootstrap", "pull"]);
  const controlFields: Record<string, string[]> = { sync: ["paused", "reason", "since"], bootstrap: ["generation", "startedAt", "complete", "completedAt", "documentCount", "headsDigest", "held", "deleted", "refused", "findings"], pull: ["startedAt", "completedAt", "refreshed", "unchanged", "headsDigest", "refused"] };
  for (const [key, value] of Object.entries(controls)) {
    const fields = shape(value, key === "sync" ? ["paused"] : key === "bootstrap" ? ["generation", "startedAt", "complete"] : ["startedAt", "completedAt"], controlFields[key]!);
    for (const [name, item] of Object.entries(fields)) {
      if (["paused", "complete", "unchanged"].includes(name) && typeof item !== "boolean") throw new BodyRuntimeError("Invalid control boolean.");
      if (["generation", "documentCount", "refreshed"].includes(name) && (!Number.isSafeInteger(item) || (item as number) < 0)) throw new BodyRuntimeError("Invalid control counter.");
      if (["startedAt", "completedAt", "reason", "since", "headsDigest"].includes(name) && typeof item !== "string" && !(name === "completedAt" && item === null)) throw new BodyRuntimeError("Invalid control text.");
      if (["held", "deleted", "findings"].includes(name) && (!Array.isArray(item) || item.some(value => typeof value !== "string"))) throw new BodyRuntimeError("Invalid control list.");
      if (name === "refused") {
        const refused = shape(item, ["deletions", "reason", "digest"]);
        if (!Number.isSafeInteger(refused.deletions) || typeof refused.digest !== "string" || !["empty-listing", "over-half"].includes(refused.reason as string)) throw new BodyRuntimeError("Invalid deletion refusal.");
      }
    }
  }
  if (jsonBytes(row) > BODY_RUNTIME_LIMITS.controlBytes) throw new BodyCapacityError();
  return bodyMode({ scope: row.scope as string, okfVersion: row.okfVersion as BodyMode["okfVersion"] });
}
export const bodyRecordKey = (requestId: string): string => `body-delivery:request:${requestId}`;
export const bodyDatabaseName = (name: string, mode: BodyMode): string => `body-v1:${JSON.stringify([name, mode.scope])}`;
const selected = new WeakMap<JournaledBackend, BodyMode>();
export function selectBodyMode(backend: JournaledBackend, mode: BodyMode): void {
  if (backend.journalSnapshotCas !== true) throw new BodyRuntimeError("Body delivery requires atomic journal snapshots.");
  const previous = selected.get(backend);
  if (previous && JSON.stringify(previous) !== JSON.stringify(mode)) throw new BodyRuntimeError("Working copy mode binding changed.");
  selected.set(backend, mode);
}
/** The marker is checked on every entry; a bare backend cannot select legacy behavior over it. */
export async function admitBodyMode(backend: JournaledBackend): Promise<BodyMode | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await backend.readWithJournal("runtime-state", { meta: [BODY_MODE_KEY] });
    const expected = selected.get(backend);
    if (read.meta.has(BODY_MODE_KEY)) {
      const mode = storedMode(read.meta.get(BODY_MODE_KEY));
      if (backend.journalSnapshotCas !== true || (expected && JSON.stringify(expected) !== JSON.stringify(mode))) throw new BodyRuntimeError("Working copy identity is incompatible.");
      return mode;
    }
    const intents = await backend.listIntents();
    if (!expected) {
      if (intents.some(row => row.kind === "document.body.update")) throw new BodyRuntimeError("Body journal has no admitted mode.");
      return null;
    }
    if (intents.length) throw new BodyRuntimeError("Cannot adopt a nonempty journal into body delivery.");
    const root = await backend.readReserved("", "index.md");
    if (root && await declaredBodyEdition(backend) !== expected.okfVersion) throw new BodyRuntimeError("Existing working copy edition is incompatible.");
    for (const id of await backend.list()) {
      const value = await backend.readWithJournal(id, { meta: [`base:${id}`] });
      if (value.meta.has(`base:${id}`)) assertSharedBase(value.meta.get(`base:${id}`));
      assertBodyCapacity({ target: id, document: value.document ? { version: value.document.version, raw: value.raw! } : null, intents: value.intents,
        meta: [{ key: BODY_MODE_KEY, expected: { present: true, value: { ...expected, controls: {} } } }, { key: `base:${id}`, expected: value.meta.has(`base:${id}`) ? { present: true, value: value.meta.get(`base:${id}`) } : { present: false } }] });
    }
    try { await backend.writeMeta(BODY_MODE_KEY, { ...expected, controls: {} }, { expected: { present: false }, requireEmptyJournal: true }); }
    catch (error) { if (error instanceof JournalGuardConflict) continue; throw error; }
  }
  throw new BodyRuntimeError("Working copy admission changed concurrently.");
}
export async function assertBodyEdition(backend: JournaledBackend, mode: BodyMode): Promise<void> {
  if (await declaredBodyEdition(backend) !== mode.okfVersion) throw new BodyRuntimeError("Working copy edition differs from delivery mode.");
}
/** Keep the edition reader's missing-marker fallback, but never turn an invalid declaration into it. */
async function declaredBodyEdition(backend: StorageBackend): Promise<BodyMode["okfVersion"]> {
  const root = await backend.readReserved("", "index.md");
  const captured = new Proxy(backend, { get(inner, key) {
    if (key === "readReserved") return async () => root;
    const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
  } });
  const edition = (await readBundleOkfVersion(captured)) ?? "0.1";
  const fields: Record<string, unknown> = root ? parseMarkdown(root.content, "index.md", { okfVersion: "0.2" }).frontmatter : {};
  if (Object.hasOwn(fields, "okf_version") && fields.okf_version !== "0.1" && fields.okf_version !== "0.2" || edition !== "0.1" && edition !== "0.2") throw new BodyRuntimeError("Invalid or unsupported declared edition.");
  return edition;
}
export async function assertBodyRemoteEdition(remote: StorageBackend, mode: BodyMode): Promise<void> {
  if (await declaredBodyEdition(remote) !== mode.okfVersion) throw new BodyRuntimeError("Authority edition differs from delivery mode.");
}
/** Body mode owns a minimal local edition seed, never a mutable mirror of reserved metadata. */
export async function seedBodyRoot(backend: JournaledBackend, mode: BodyMode): Promise<void> {
  if (await backend.readReserved("", "index.md")) { await assertBodyEdition(backend, mode); return; }
  await controlRow(backend, mode);
  try { await backend.writeReserved("", "index.md", `---\nokf_version: '${mode.okfVersion}'\n---\n`, { expectedVersion: null }); }
  catch (error) { if ((error as { name?: unknown })?.name !== "VersionConflict") throw error; }
  await assertBodyEdition(backend, mode);
}
/** Codec conversion preserves its declared edition and produces guard-compatible plain data. */
export function bodyDocument(raw: string, id: string, mode: BodyMode): OkfDocument {
  const parsed = parseMarkdown(raw, id, { okfVersion: mode.okfVersion });
  // v0.1's standard timestamp can decode as a Date; re-encode through the existing codec.
  return { id, frontmatter: captureRemoteFrontmatter(parsed.frontmatter) as OkfDocument["frontmatter"], body: parsed.body };
}
export function validateBodyRecord(mode: BodyMode, intent: IntentRecord, value: unknown): BodyRecord {
  shape(intent, ["requestId", "kind", "target", "base", "local", "content", "createdAt", "attempts", "state", "sequence", "updatedAt", "baseContent"], ["after", "acknowledgedVersion", "remote", "refusal", "finding"]);
  if (!Number.isSafeInteger(intent.attempts) || intent.attempts < 0 || !Number.isSafeInteger(intent.sequence) || intent.sequence < 0 || !Number.isFinite(Date.parse(intent.updatedAt)) || !["pending", "in_flight", "acknowledged", "conflict", "refused", "unknown"].includes(intent.state)) throw new BodyRuntimeError("Invalid body journal state.");
  if (intent.state !== "pending" && intent.attempts === 0) throw new BodyRuntimeError("Unattempted body journal has a delivery outcome.");
  const text = (value: unknown) => typeof value === "string" && new TextEncoder().encode(value).length <= BODY_DELIVERY_LIMITS.labelBytes;
  if (Object.hasOwn(intent, "finding") && !text(intent.finding)) throw new BodyRuntimeError("Invalid body finding.");
  if (Object.hasOwn(intent, "refusal")) {
    const refusal = shape(intent.refusal, ["code", "message"]);
    if (!text(refusal.code) || !text(refusal.message)) throw new BodyRuntimeError("Invalid retained refusal.");
  }
  if (Object.hasOwn(intent, "remote")) {
    const remote = shape(intent.remote, ["version", "content"]);
    if (remote.version !== null && !isContentVersion(remote.version) || remote.content !== null && typeof remote.content !== "string" || jsonBytes(remote) > E) throw new BodyRuntimeError("Invalid retained remote observation.");
  }
  const row = shape(value, ["schema", "requestId", "target", "scope", "okfVersion", "body", "initialVersion"], ["prepared", "receipt"]);
  if (intent.kind !== "document.body.update" || row.schema !== 1 || row.requestId !== intent.requestId || row.target !== intent.target || row.scope !== mode.scope || row.okfVersion !== mode.okfVersion || typeof row.body !== "string" || new TextEncoder().encode(row.body).length > BODY_DELIVERY_LIMITS.bodyBytes) throw new BodyRuntimeError("Body descriptor does not bind its intent.");
  const candidate = parseMarkdown(intent.content, intent.target, { okfVersion: mode.okfVersion });
  if (versionOfBytes(intent.content) !== intent.local || normalizeDocumentBodyForStorage(candidate.body) !== normalizeDocumentBodyForStorage(row.body)) throw new BodyRuntimeError("Body descriptor differs from local history.");
  if (intent.after === undefined ? row.initialVersion !== intent.base || !row.initialVersion : row.initialVersion !== null) throw new BodyRuntimeError("Initial authority premise changed.");
  const record = row as unknown as BodyRecord;
  // The shared preparation codec owns immutable input validation even before preparation is persisted.
  if (!intent.base) throw new BodyRuntimeError("Body journal lacks its original premise.");
  prepareBodyDelivery({ scope: mode.scope, requestId: intent.requestId, target: intent.target, okfVersion: mode.okfVersion, operation: { kind: "document.body.update", body: record.body }, local: intent.local, content: intent.content, createdAt: intent.createdAt }, { expectedVersion: intent.base });
  if (Object.hasOwn(row, "prepared")) {
    if (intent.attempts === 0) throw new BodyRuntimeError("Preparation has no attempted claim.");
    record.prepared = validatePreparedBodyDelivery(row.prepared);
    const p = record.prepared;
    if (p.requestId !== intent.requestId || p.target !== intent.target || p.local !== intent.local || p.content !== intent.content || p.createdAt !== intent.createdAt || p.scope !== mode.scope || p.okfVersion !== mode.okfVersion || p.operation.body !== record.body || (intent.after === undefined && (p.expectedVersion !== record.initialVersion || p.predecessor !== undefined)) || (intent.after !== undefined && p.predecessor?.requestId !== intent.after)) throw new BodyRuntimeError("Prepared delivery changed original history.");
  }
  if (intent.attempts > 0 && !record.prepared) throw new BodyRuntimeError("Attempted body delivery has no durable preparation.");
  if (Object.hasOwn(row, "receipt")) {
    if (!record.prepared) throw new BodyRuntimeError("Receipt has no prepared delivery.");
    record.receipt = validateBodyReceipt(record.prepared, row.receipt);
    if (intent.state !== "acknowledged" || intent.acknowledgedVersion !== record.receipt.version) throw new BodyRuntimeError("Receipt and journal acknowledgment differ.");
  }
  if (intent.state === "acknowledged" && !record.receipt) throw new BodyRuntimeError("Acknowledgment has no committed content evidence.");
  return record;
}
export interface BodySnapshot { read: JournaledReadResult; guard: JournalGuard; records: Map<string, BodyRecord> }
function assertSharedBase(value: unknown): void {
  const base = shape(value, ["version", "content"]);
  if (base.version !== null && !isContentVersion(base.version) || base.content !== null && typeof base.content !== "string" || base.version !== null && base.content === null) throw new BodyRuntimeError("Invalid shared content premise.");
}
export interface BodyRefreshPremises {
  guard(id: string): JournalGuard;
  check(id: string): Promise<void>;
  checkAll(): Promise<void>;
}
/** Bind incoming evidence to local state observed before its request, never after its response. */
export async function captureBodyRefresh(backend: JournaledBackend, mode: BodyMode, ids?: readonly string[]): Promise<BodyRefreshPremises> {
  const targets = ids ?? [...new Set([...await backend.list(), ...(await backend.listIntents()).map(row => row.target)])];
  const guards = new Map<string, JournalGuard>();
  for (const id of targets) guards.set(id, (await bodySnapshot(backend, id, mode)).guard);
  const marker = await controlRow(backend, mode);
  // A streamed snapshot can name an unseen target. Its import is conditional on complete absence.
  const guard = (id: string): JournalGuard => guards.get(id) ?? { target: id, document: null, intents: [], meta: [
    { key: BODY_MODE_KEY, expected: { present: true, value: marker } }, { key: `base:${id}`, expected: { present: false } },
  ] };
  const check = async (id: string) => assertJournalGuard(guard(id), (await bodySnapshot(backend, id, mode)).guard);
  return { guard, check, checkAll: async () => {
    const control = (value: unknown): JournalGuard => ({ target: "runtime-state", document: null, intents: [], meta: [{ key: BODY_MODE_KEY, expected: { present: true, value } }] });
    assertJournalGuard(control(marker), control(await controlRow(backend, mode)));
    for (const id of guards.keys()) await check(id);
  } };
}
export async function bodySnapshot(backend: JournaledBackend, target: string, mode: BodyMode, extra: readonly string[] = []): Promise<BodySnapshot> {
  await assertBodyEdition(backend, mode);
  for (let attempt = 0; attempt < 3; attempt++) {
    const discovery = await backend.readWithJournal(target);
    const keys = [...new Set([BODY_MODE_KEY, `base:${target}`, ...discovery.intents.map(row => bodyRecordKey(row.requestId)), ...extra])];
    const read = await backend.readWithJournal(target, { meta: keys });
    if (read.intents.some(row => !keys.includes(bodyRecordKey(row.requestId)))) continue;
    if (!read.meta.has(BODY_MODE_KEY) || JSON.stringify(storedMode(read.meta.get(BODY_MODE_KEY))) !== JSON.stringify(mode)) throw new BodyRuntimeError("Working copy mode changed.");
    if (read.meta.has(`base:${target}`)) assertSharedBase(read.meta.get(`base:${target}`));
    const records = new Map(read.intents.map(row => [row.requestId, validateBodyRecord(mode, row, read.meta.get(bodyRecordKey(row.requestId)))]));
    for (const row of read.intents) {
      const record = records.get(row.requestId)!;
      if (row.after !== undefined) {
        const predecessor = read.intents.find(prior => prior.requestId === row.after);
        if (!predecessor || predecessor.sequence >= row.sequence || predecessor.local !== row.base || predecessor.content !== row.baseContent) throw new BodyRuntimeError("Body successor has invalid original history.");
      }
      if (row.after !== undefined && record.prepared) {
        const predecessor = records.get(row.after);
        if (!predecessor?.prepared || !predecessor.receipt) throw new BodyRuntimeError("Successor lacks predecessor evidence.");
        const candidate = prepareBodyDelivery({ scope: mode.scope, requestId: row.requestId, target, okfVersion: mode.okfVersion, operation: record.prepared.operation, local: row.local, content: row.content, createdAt: row.createdAt }, { prepared: predecessor.prepared, receipt: predecessor.receipt });
        assertSameBodyDelivery(record.prepared, candidate);
      }
    }
    const guard: JournalGuard = { target, document: read.document ? { version: read.document.version, raw: read.raw! } : null, intents: read.intents,
      meta: keys.map(key => ({ key, expected: read.meta.has(key) ? { present: true, value: read.meta.get(key) } : { present: false } })) };
    assertBodyCapacity(guard);
    return { read, guard, records };
  }
  throw new JournalGuardConflict(target);
}

/** Full JSON cost plus independent future evidence reservations, including escaped wrappers. */
export function assertBodyCapacity(guard: JournalGuard): void {
  const unsettled = guard.intents.filter(row => row.state !== "acknowledged");
  if (unsettled.length > BODY_RUNTIME_LIMITS.unsettled) throw new BodyCapacityError();
  const metas = new Map(guard.meta.filter(row => row.expected.present).map(row => [row.key, (row.expected as { present: true; value: unknown }).value]));
  const base = metas.get(`base:${guard.target}`) as { version: Version | null; content: string | null } | undefined;
  const documentCost = jsonBytes(guard.document), sharedCost = jsonBytes(base ?? null);
  if (documentCost > E || sharedCost > E) throw new BodyCapacityError();
  const originalJournal = guard.intents.map(({ remote: _remote, refusal: _refusal, finding: _finding, ...row }) => row);
  if (jsonBytes(originalJournal) > BODY_RUNTIME_LIMITS.journalBytes) throw new BodyCapacityError();
  const controlCost = jsonBytes(metas.get(BODY_MODE_KEY) ?? null);
  if (controlCost > BODY_RUNTIME_LIMITS.controlBytes) throw new BodyCapacityError();
  let reserve = Math.max(0, E - documentCost) + Math.max(0, E - sharedCost) + BODY_RUNTIME_LIMITS.transitionBytes + Math.max(0, BODY_RUNTIME_LIMITS.controlBytes - controlCost);
  let remoteReserve = 0;
  for (const row of unsettled) {
    const record = metas.get(bodyRecordKey(row.requestId)) as BodyRecord | undefined;
    for (const field of ["prepared", "receipt"] as const) {
      const cost = record?.[field] === undefined ? 0 : jsonBytes(record[field]);
      if (cost > E) throw new BodyCapacityError();
      // Field-name/comma wrappers are covered independently of the envelope's own bytes.
      reserve += record?.[field] === undefined ? E + 32 : 0;
    }
    const cost = row.remote === undefined ? 0 : jsonBytes(row.remote);
    if (cost > E) throw new BodyCapacityError();
    remoteReserve += Math.max(0, E - cost) + 32;
  }
  const pure = { version: guard.document?.version ?? null, intents: guard.intents, shared: base?.version ? base : null };
  if (jsonBytes(pure) + remoteReserve + Math.max(0, E - sharedCost) + BODY_RUNTIME_LIMITS.transitionBytes > BODY_RECONCILIATION_BYTES || jsonBytes(guard) + reserve + remoteReserve > BODY_RUNTIME_LIMITS.guardedBytes) throw new BodyCapacityError();
}

const CONTROL_KEYS = new Set(["sync", "bootstrap", "pull"]);
async function controlRow(backend: JournaledBackend, mode: BodyMode): Promise<BodyMode & { controls: Record<string, unknown> }> {
  const read = await backend.readWithJournal("runtime-state", { meta: [BODY_MODE_KEY] });
  const row = read.meta.get(BODY_MODE_KEY);
  if (JSON.stringify(storedMode(row)) !== JSON.stringify(mode)) throw new BodyRuntimeError("Working copy identity changed.");
  return captureJournalValue(row) as BodyMode & { controls: Record<string, unknown> };
}
export async function writeBodyControl(backend: JournaledBackend, mode: BodyMode, key: string, value: unknown): Promise<void> {
  if (!CONTROL_KEYS.has(key)) throw new BodyRuntimeError("Unknown body control field.");
  const captured = captureJournalValue(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await controlRow(backend, mode);
    const next = { ...row, controls: { ...row.controls, [key]: captured } };
    storedMode(next);
    try { await backend.writeMeta(BODY_MODE_KEY, next, { expected: { present: true, value: row } }); return; }
    catch (error) { if (!(error instanceof JournalGuardConflict)) throw error; }
  }
  throw new JournalGuardConflict("runtime-state");
}

/** Adapt existing refresh/recovery verbs to guarded persistence, without duplicating their loops. */
export function bodyBackend(backend: JournaledBackend, mode: BodyMode): JournaledBackend {
  const write = async (id: string, document: OkfDocument, options: JournaledWriteOptions = {}) => {
    const raw = stringifyDoc(document.frontmatter, document.body ?? "");
    const doc = bodyDocument(raw, id, mode);
    const storedRaw = stringifyDoc(doc.frontmatter, doc.body ?? ""), version = versionOfBytes(storedRaw);
    const meta = typeof options.meta === "function" ? options.meta({ raw: storedRaw, version }) : options.meta ?? [];
    const captured = captureJournalValue({ ...options, meta });
    const snap = await bodySnapshot(backend, id, mode, [...captured.meta.map(row => row.key), ...(captured.removeMeta ?? [])]);
    if (captured.guard) {
      // Explicit delivery/commit callers already composed against their own immutable snapshot.
      projectBodyGuard(captured.guard, { document: { version, raw: storedRaw }, meta: captured.meta });
      return backend.writeJournaled(id, doc, captured);
    }
    if (captured.intent) throw new BodyRuntimeError("Refresh cannot create an untyped body intent.");
    const intents = captured.resolveIntents ? snap.read.intents.filter(row => !captured.resolveIntents!.expected.some(retired => retired.requestId === row.requestId)) : snap.read.intents;
    projectBodyGuard(snap.guard, { document: { version, raw: storedRaw }, intents, meta: captured.meta, removeMeta: captured.removeMeta });
    return backend.writeJournaled(id, doc, { ...captured, guard: snap.guard });
  };
  const remove = async (id: string, options: JournaledDeleteOptions = {}) => {
    const captured = captureJournalValue(options);
    const keys = [...(captured.meta ?? []).map(row => row.key), ...(captured.removeMeta ?? []), ...(captured.onHeld?.meta ?? []).map(row => row.key)];
    const snap = await bodySnapshot(backend, id, mode, keys);
    const guard = captured.guard ?? snap.guard;
    const held = captured.requireSettled && guard.intents.some(row => row.state !== "acknowledged");
    if (held && captured.onHeld) projectBodyGuard(guard, { meta: captured.onHeld.meta });
    else projectBodyGuard(guard, { document: null, intents: captured.resolveIntents ? guard.intents.filter(row => !captured.resolveIntents!.expected.some(retired => retired.requestId === row.requestId)) : guard.intents, meta: captured.meta, removeMeta: captured.removeMeta });
    return backend.deleteJournaled(id, { ...captured, guard });
  };
  const update = async (requestId: string, state: IntentRecord["state"], patch: IntentPatch, options: IntentUpdateOptions = {}) => {
    const captured = captureJournalValue({ patch, options });
    const intent = await backend.readIntent(requestId);
    if (!intent) throw new BodyRuntimeError("Missing body intent.");
    const snap = await bodySnapshot(backend, intent.target, mode, (captured.options.meta ?? []).map(row => row.key));
    const guard = captured.options.guard ?? snap.guard;
    const intents = guard.intents.map(row => row.requestId === requestId ? { ...row, ...captured.patch } : row);
    const raw = captured.options.document ? stringifyDoc(captured.options.document.frontmatter, captured.options.document.body ?? "") : undefined;
    projectBodyGuard(guard, { intents, meta: captured.options.meta, ...(raw === undefined ? {} : { document: { version: versionOfBytes(raw), raw } }) });
    return backend.updateIntent(requestId, state, captured.patch, { ...captured.options, guard });
  };
  return new Proxy(backend, { get(inner, key) {
    if (key === "writeJournaled") return write;
    if (key === "deleteJournaled") return remove;
    if (key === "updateIntent") return update;
    if (key === "readMeta") return async (name: string) => CONTROL_KEYS.has(name) ? (await controlRow(backend, mode)).controls[name] : backend.readMeta(name);
    if (key === "writeMeta") return async (name: string, value: unknown) => {
      if (!CONTROL_KEYS.has(name)) throw new BodyRuntimeError("Body metadata writes require a target guard.");
      await writeBodyControl(backend, mode, name, value);
    };
    if (key === "writeReserved") return async () => { throw new BodyRuntimeError("Body mode does not mirror reserved metadata."); };
    const value = Reflect.get(inner, key, inner);
    return typeof value === "function" ? value.bind(inner) : value;
  } });
}
export function projectBodyGuard(guard: JournalGuard, changes: { document?: JournalGuard["document"]; intents?: IntentRecord[]; meta?: MetaRecord[]; removeMeta?: readonly string[] }): JournalGuard {
  const projected = captureJournalValue(guard);
  if (changes.document !== undefined) projected.document = changes.document;
  if (changes.intents) projected.intents = changes.intents;
  for (const row of changes.meta ?? []) {
    const entry = projected.meta.find(entry => entry.key === row.key);
    if (!entry) throw new BodyRuntimeError("Unobserved body metadata change.");
    entry.expected = { present: true, value: row.value };
  }
  for (const key of changes.removeMeta ?? []) {
    const entry = projected.meta.find(entry => entry.key === key);
    if (!entry) throw new BodyRuntimeError("Unobserved body metadata removal.");
    entry.expected = { present: false };
  }
  assertBodyCapacity(projected);
  return projected;
}
