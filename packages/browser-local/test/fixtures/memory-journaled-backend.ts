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

import { stringifyDoc } from "@superbee/core/document-codec";
import {
  IntentHoldConflict,
  IntentStateConflict,
  type IntentPatch,
  type IntentRecord,
  type JournaledBackend,
  type JournaledReadResult,
  type JournaledWriteOptions,
  type MetaRecord,
} from "@superbee/core/journaled-backend";
import { MemoryBackend } from "@superbee/core/memory-backend";
import {
  assertSafeConceptId,
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
}

function notFound(id: ConceptId): Error & { code: string } {
  const err = new Error(`no concept document '${id}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

const bySequence = (a: IntentRecord, b: IntentRecord) => a.sequence - b.sequence;

export class MemoryJournaledBackend implements JournaledBackend {
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
    return { doc: structuredClone(row.doc), version: row.version };
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

  async list(prefix?: string): Promise<ConceptId[]> {
    const ids = [...this.#documents.keys()].filter((id) => !prefix || id.startsWith(prefix));
    ids.sort((a, b) => a.localeCompare(b));
    return ids;
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

  async writeJournaled(id: ConceptId, doc: OkfDocument, options: JournaledWriteOptions = {}): Promise<{ version: Version; raw: string; intent: IntentRecord | null }> {
    assertSafeConceptId(id);
    const now = new Date().toISOString();
    const { intent, supersede, requireSettled } = options;
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
    const { version, raw } = this.#putDocument(id, doc, undefined, options.actor, now);
    if (supersede) this.#intents.delete(supersede.requestId);
    let record: IntentRecord | null = null;
    if (intent) {
      this.#sequence += 1;
      record = { ...intent, local: version, content: raw, sequence: this.#sequence, attempts: 0, state: "pending", updatedAt: now };
      this.#intents.set(record.requestId, structuredClone(record));
    }
    const meta = typeof options.meta === "function" ? options.meta({ version, raw }) : options.meta ?? [];
    for (const row of meta) this.#meta.set(row.key, structuredClone(row.value));
    return { version, raw, intent: record };
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
    return { document: { doc: structuredClone(row.doc), version: row.version }, raw: row.raw, intents, meta };
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

  async updateIntent(requestId: string, expectedState: OperationState, patch: IntentPatch, options: { meta?: MetaRecord[] } = {}): Promise<IntentRecord> {
    const current = this.#intents.get(requestId);
    if (!current || current.state !== expectedState) throw new IntentStateConflict(requestId, expectedState, current?.state ?? null);
    const next: IntentRecord = { ...current, ...patch, requestId, sequence: current.sequence, updatedAt: new Date().toISOString() };
    this.#intents.set(requestId, structuredClone(next));
    for (const row of options.meta ?? []) this.#meta.set(row.key, structuredClone(row.value));
    return next;
  }

  async readMeta<T = unknown>(key: string): Promise<T | undefined> {
    return this.#meta.has(key) ? (structuredClone(this.#meta.get(key)) as T) : undefined;
  }

  async writeMeta(key: string, value: unknown): Promise<void> {
    this.#meta.set(key, structuredClone(value));
  }
}
