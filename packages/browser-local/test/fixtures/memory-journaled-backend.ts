/**
 * A test-only in-memory {@link JournaledBackend}: the proof that the sync runtime depends on the
 * seam and not on the IndexedDB class. Documents, the intent journal, and the meta rows live in
 * plain maps and every verb's checks and mutations run in one synchronous section, so "one
 * transaction" and "one snapshot" are a function body with no await inside it; reserved files
 * and blobs, which no journal verb touches, are the core {@link MemoryBackend}'s. The state
 * compare-and-swap is real: a wrong state or a missing record refuses the write and changes
 * nothing.
 *
 * Imported from the built `@superbee/core` subpaths, the same module graph `local-bundle.ts`
 * resolves, so the errors this adapter throws are the classes the runtime tests with
 * `instanceof`. Not a shipping store: it forgets everything when the process ends.
 */

import { parseMarkdown, stringifyDoc } from "@superbee/core/document-codec";
import { readBundleOkfVersion } from "@superbee/core/engine";
import {
  assertJournalGuard,
  assertJournalIntentChanges,
  assertJournalMetaChanges,
  assertMetaWrite,
  captureJournalGuardOption,
  captureJournalDeleteOptions,
  captureJournalWriteOptions,
  captureIntentUpdate,
  captureMetaWrite,
  captureJournalValue,
  JournalGuardConflict,
  assertJournalResolutionOptions,
  assertJournalSnapshot,
  IntentHoldConflict,
  IntentStateConflict,
  type IntentPatch,
  type IntentRecord,
  type IntentUpdateOptions,
  type JournalGuard,
  type MetaWriteOptions,
  type JournaledBackend,
  type JournaledDeleteOptions,
  type JournaledDeleteResult,
  type JournaledHead,
  type JournaledHeadsOptions,
  type JournaledReadResult,
  type JournaledWriteOptions,
  type MetaRecord,
} from "@superbee/core/journaled-backend";
import { MemoryBackend } from "@superbee/core/memory-backend";
import {
  assertSafeConceptId,
  MalformedDocumentError,
  pathFromConceptId,
  type BlobKey,
  type ConceptId,
  type DeleteOptions,
  type OkfDocument,
  type ReadBlobResult,
  type ReadResult,
  type ReservedFilename,
  type ReservedReadResult,
  type StorageCapabilities,
  type Version,
  type VersionInfo,
  type WriteOptions,
} from "@superbee/core/storage";
import type { OperationState } from "@superbee/core/uncertain-write";
import { defaultActor, VersionConflict, versionOfBytes } from "@superbee/core/versioning";

interface DocumentRow {
  doc: OkfDocument;
  /** The exact serialization `version` names, as the IndexedDB adapter stores it. */
  raw: string;
  version: Version;
  actor: string;
  timestamp: string;
  /** Set by {@link MemoryJournaledBackend.storeRaw} when the planted bytes do not parse: single reads reject with it, the listing reports it. */
  malformed?: MalformedDocumentError;
}

function notFound(id: ConceptId): Error & { code: string } {
  const err = new Error(`no concept document '${id}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

const bySequence = (a: IntentRecord, b: IntentRecord) => a.sequence - b.sequence;

export class MemoryJournaledBackend implements JournaledBackend {
  readonly journalSnapshotCas = true as const;
  readonly #documents = new Map<ConceptId, DocumentRow>();
  readonly #intents = new Map<string, IntentRecord>();
  readonly #meta = new Map<string, unknown>();
  /** Reserved files and blobs: the core in-memory adapter's, untouched by any journal verb. */
  readonly #rest = new MemoryBackend();
  #sequence = 0;

  capabilities(): StorageCapabilities {
    return { history: false, enforced_cas: true, blobs: true, projections: false, backlinks: false };
  }

  // ── documents ─────────────────────────────────────────────────────────────────────────

  /** The synchronous document compare-and-swap every write path shares; the caller decides what else lands with it. */
  #putDocument(id: ConceptId, doc: OkfDocument, expected: Version | null | undefined, actor: string | undefined, timestamp: string): { version: Version; raw: string } {
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const version = versionOfBytes(raw);
    const current = this.#documents.get(id)?.version ?? null;
    if (expected !== undefined && expected !== current) throw new VersionConflict(id, expected, current);
    this.#documents.set(id, { doc: structuredClone({ ...doc, id }), raw, version, actor: actor?.trim() || defaultActor(), timestamp });
    return { version, raw };
  }

  async read(id: ConceptId): Promise<ReadResult> {
    assertSafeConceptId(id);
    const row = this.#documents.get(id);
    if (!row) throw notFound(id);
    if (row.malformed) throw row.malformed;
    return { doc: structuredClone(row.doc), version: row.version };
  }

  /**
   * Plant exact bytes as a document's stored serialization, bypassing the seam's serializer:
   * the contract kit's malformed-record and edition rows. Bytes that parse become the
   * document, decoded under the root index's edition as the IndexedDB adapter decodes a stored
   * record; bytes that do not are kept with the parser's error, as a record holding them would
   * be.
   */
  async storeRaw(id: ConceptId, raw: string): Promise<void> {
    assertSafeConceptId(id);
    let okfVersion: string | undefined;
    try {
      okfVersion = await readBundleOkfVersion(this);
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
    }
    const previous = this.#documents.get(id);
    const row: DocumentRow = { doc: { id, frontmatter: {} as OkfDocument["frontmatter"], body: "" }, raw, version: versionOfBytes(raw), actor: previous?.actor ?? defaultActor(), timestamp: new Date().toISOString() };
    try {
      const parsed = parseMarkdown(raw, pathFromConceptId(id), { okfVersion });
      row.doc = { id, frontmatter: parsed.frontmatter, body: parsed.body };
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
      row.malformed = error;
    }
    this.#documents.set(id, row);
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    for (const id of ids) assertSafeConceptId(id);
    return Promise.all(ids.map((id) => this.read(id)));
  }

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    return this.#putDocument(id, doc, options.expectedVersion, options.actor, new Date().toISOString()).version;
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    const current = this.#documents.get(id)?.version ?? null;
    if (current === null) return false;
    if (options.expectedVersion !== undefined && options.expectedVersion !== current) throw new VersionConflict(id, options.expectedVersion, current);
    this.#documents.delete(id);
    return true;
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    return this.#documents.has(id);
  }

  /** Ids in this adapter's `list` order, synchronously, so a listing over them is one section with no await. */
  #ids(prefix?: string): ConceptId[] {
    const ids = [...this.#documents.keys()].filter((id) => !prefix || id.startsWith(prefix));
    ids.sort((a, b) => a.localeCompare(b));
    return ids;
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    return this.#ids(prefix);
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    const row = this.#documents.get(id);
    return row ? [{ version: row.version, actor: row.actor, timestamp: row.timestamp }] : [];
  }

  // ── reserved files and blobs: delegated ───────────────────────────────────────────────

  readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    return this.#rest.readReserved(dir, name);
  }

  writeReserved(dir: string, name: ReservedFilename, content: string, options?: WriteOptions): Promise<Version> {
    return this.#rest.writeReserved(dir, name, content, options);
  }

  readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    return this.#rest.readBlob(key);
  }

  writeBlob(key: BlobKey, bytes: Uint8Array, contentType?: string, options?: WriteOptions): Promise<Version> {
    return this.#rest.writeBlob(key, bytes, contentType, options);
  }

  deleteBlob(key: BlobKey, options?: DeleteOptions): Promise<boolean> {
    return this.#rest.deleteBlob(key, options);
  }

  existsBlob(key: BlobKey): Promise<boolean> {
    return this.#rest.existsBlob(key);
  }

  listBlobs(prefix?: string): Promise<BlobKey[]> {
    return this.#rest.listBlobs(prefix);
  }

  // ── the journal seam ──────────────────────────────────────────────────────────────────

  #checkGuard(guard: JournalGuard | undefined): void {
    if (guard === undefined) return;
    const document = this.#documents.get(guard.target);
    assertJournalGuard(guard, {
      target: guard.target,
      document: document ? { version: document.version, raw: document.raw } : null,
      intents: [...this.#intents.values()].filter(row => row.target === guard.target),
      meta: guard.meta.map(row => ({ key: row.key, expected: this.#meta.has(row.key) ? { present: true, value: this.#meta.get(row.key) } : { present: false } })),
    });
  }

  async writeJournaled(id: ConceptId, doc: OkfDocument, options: JournaledWriteOptions = {}): Promise<{ version: Version; raw: string; intent: IntentRecord | null }> {
    const snapshotGuard = captureJournalGuardOption(options, id);
    if (snapshotGuard !== undefined) { options = captureJournalWriteOptions(options); doc = captureJournalValue(doc); }
    assertSafeConceptId(id);
    assertJournalResolutionOptions(id, options);
    if (snapshotGuard && (doc.id !== id || (options.intent && options.intent.target !== id))) throw new JournalGuardConflict(id);
    const now = new Date().toISOString();
    // The producer can synchronously cause another write. Finish it and capture its result
    // before deciding any storage premise, matching the IndexedDB transaction boundary.
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const version = versionOfBytes(raw);
    const producedMeta = typeof options.meta === "function" ? options.meta({ version, raw }) : options.meta ?? [];
    assertJournalMetaChanges(snapshotGuard, producedMeta, options.removeMeta);
    const meta = structuredClone(producedMeta);
    const { intent, supersede, requireSettled } = options;
    const preparedIntent = intent ? structuredClone({ ...intent, local: version, content: raw, sequence: this.#sequence + 1, attempts: 0, state: "pending" as const, updatedAt: now }) : null;
    this.#checkGuard(snapshotGuard);
    assertJournalIntentChanges(snapshotGuard, intent ? this.#intents.get(intent.requestId) : undefined, supersede ? this.#intents.get(supersede.requestId) : undefined);
    if (options.resolveIntents) assertJournalSnapshot(id, options.resolveIntents.expected, [...this.#intents.values()], options.intent?.requestId);
    // Every check runs before any mutation, with no await between them: that is this adapter's
    // transaction. A refusal at any check leaves the store exactly as it was.
    if (requireSettled) {
      const holder = [...this.#intents.values()].sort(bySequence).find((row) => row.target === id && row.state !== "acknowledged");
      if (holder) throw new IntentHoldConflict(id, holder.requestId, holder.state);
    }
    const current = this.#documents.get(id)?.version ?? null;
    if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
      throw new VersionConflict(id, options.expectedVersion, current);
    }
    if (supersede) {
      const existing = this.#intents.get(supersede.requestId);
      if (!existing || existing.state !== supersede.expectedState || existing.attempts !== supersede.expectedAttempts) {
        throw new IntentStateConflict(supersede.requestId, supersede.expectedState, existing?.state ?? null);
      }
    }
    this.#putDocument(id, doc, undefined, options.actor, now);
    if (supersede) this.#intents.delete(supersede.requestId);
    for (const row of options.resolveIntents?.expected ?? []) this.#intents.delete(row.requestId);
    let record: IntentRecord | null = null;
    if (intent) {
      this.#sequence += 1;
      record = preparedIntent!;
      this.#intents.set(record.requestId, structuredClone(record));
    }
    for (const row of meta) this.#meta.set(row.key, structuredClone(row.value));
    for (const key of options.removeMeta ?? []) this.#meta.delete(key);
    return { version, raw, intent: record };
  }

  async deleteJournaled(id: ConceptId, options: JournaledDeleteOptions = {}): Promise<JournaledDeleteResult> {
    options = captureJournalDeleteOptions(id, options);
    assertSafeConceptId(id);
    assertJournalResolutionOptions(id, options);
    this.#checkGuard(options.guard);
    if (options.resolveIntents) assertJournalSnapshot(id, options.resolveIntents.expected, [...this.#intents.values()]);
    // Every check runs before any mutation, with no await between them, as in `writeJournaled`.
    if (options.requireSettled) {
      const holder = [...this.#intents.values()].sort(bySequence).find((row) => row.target === id && row.state !== "acknowledged");
      if (holder) {
        if (!options.onHeld) throw new IntentHoldConflict(id, holder.requestId, holder.state);
        for (const row of options.onHeld.meta) this.#meta.set(row.key, structuredClone(row.value));
        return { outcome: "held", requestId: holder.requestId, state: holder.state };
      }
    }
    const current = this.#documents.get(id)?.version ?? null;
    if ((current !== null || options.resolveIntents) && options.expectedVersion !== undefined && options.expectedVersion !== current) {
      throw new VersionConflict(id, options.expectedVersion, current);
    }
    const meta = structuredClone(options.meta ?? []);
    const removed = this.#documents.delete(id);
    for (const row of options.resolveIntents?.expected ?? []) this.#intents.delete(row.requestId);
    for (const row of meta) this.#meta.set(row.key, row.value);
    for (const key of options.removeMeta ?? []) this.#meta.delete(key);
    return { outcome: removed ? "deleted" : "absent" };
  }

  async readWithJournal(id: ConceptId, options: { meta?: readonly string[] } = {}): Promise<JournaledReadResult> {
    assertSafeConceptId(id);
    const row = this.#documents.get(id);
    const intents = [...this.#intents.values()].filter((entry) => entry.target === id).sort(bySequence).map((entry) => structuredClone(entry));
    const meta = new Map<string, unknown>();
    for (const key of options.meta ?? []) {
      if (this.#meta.has(key)) meta.set(key, structuredClone(this.#meta.get(key)));
    }
    if (!row) return { document: null, raw: null, intents, meta };
    if (row.malformed) throw row.malformed;
    return { document: { doc: structuredClone(row.doc), version: row.version }, raw: row.raw, intents, meta };
  }

  async readHeads<T = JournaledHead>(options: JournaledHeadsOptions<T> = {}): Promise<T[]> {
    const keysOf = options.meta ?? (() => []);
    const project = options.project ?? ((head: JournaledHead) => head as unknown as T);
    // One synchronous pass over the maps: this adapter's one transaction, with no await inside.
    const shared = new Map<string, unknown>();
    for (const key of new Set(options.shared ?? [])) {
      if (this.#meta.has(key)) shared.set(key, structuredClone(this.#meta.get(key)));
    }
    const out: T[] = [];
    for (const id of this.#ids()) {
      const row = this.#documents.get(id)!;
      const intents = [...this.#intents.values()].filter((entry) => entry.target === id).sort(bySequence).map((entry) => structuredClone(entry));
      const meta = new Map(shared);
      for (const key of new Set(keysOf(id, intents))) {
        if (!meta.has(key) && !(options.shared ?? []).includes(key) && this.#meta.has(key)) meta.set(key, structuredClone(this.#meta.get(key)));
      }
      const head = { id, version: row.version, updatedBy: row.actor, updatedAt: row.timestamp, raw: row.raw, intents, meta };
      out.push(project(row.malformed ? { ...head, frontmatter: null, malformed: row.malformed } : { ...head, frontmatter: structuredClone(row.doc.frontmatter) }));
    }
    return out;
  }

  async listIntents(state?: OperationState | readonly OperationState[]): Promise<IntentRecord[]> {
    const wanted = state === undefined ? null : new Set(typeof state === "string" ? [state] : state);
    return [...this.#intents.values()]
      .filter((row) => !wanted || wanted.has(row.state))
      .sort(bySequence)
      .map((row) => structuredClone(row));
  }

  async readIntent(requestId: string): Promise<IntentRecord | undefined> {
    const row = this.#intents.get(requestId);
    return row ? structuredClone(row) : undefined;
  }

  async updateIntent(requestId: string, expectedState: OperationState, patch: IntentPatch, options: IntentUpdateOptions = {}): Promise<IntentRecord> {
    ({ patch, options } = captureIntentUpdate(patch, options));
    this.#checkGuard(options.guard);
    const current = this.#intents.get(requestId);
    if (!current || current.state !== expectedState) throw new IntentStateConflict(requestId, expectedState, current?.state ?? null);
    if (options.guard && current.target !== options.guard.target) throw new JournalGuardConflict(current.target);
    const next: IntentRecord = { ...current, ...patch, requestId, sequence: current.sequence, updatedAt: new Date().toISOString() };
    // All potentially throwing preparation precedes the synchronous commit section.
    const captured = structuredClone(next);
    const meta = structuredClone(options.meta ?? []);
    if (options.document) this.#putDocument(options.document.id, options.document, undefined, undefined, next.updatedAt);
    this.#intents.set(requestId, captured);
    for (const row of meta) this.#meta.set(row.key, row.value);
    return next;
  }

  async readMeta<T = unknown>(key: string): Promise<T | undefined> {
    return this.#meta.has(key) ? (structuredClone(this.#meta.get(key)) as T) : undefined;
  }

  async writeMeta(key: string, value: unknown, options: MetaWriteOptions = {}): Promise<void> {
    options = captureMetaWrite(options);
    const captured = options.expected !== undefined || options.requireEmptyJournal ? captureJournalValue(value) : structuredClone(value);
    assertMetaWrite(key, options, this.#meta.has(key) ? { present: true, value: this.#meta.get(key) } : { present: false }, [...this.#intents.values()]);
    this.#meta.set(key, captured);
  }
}
