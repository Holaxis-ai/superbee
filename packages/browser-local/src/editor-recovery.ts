import type { JournaledBackend } from "@superbee/core/journaled-backend";
import { assertSafeConceptId, isContentVersion, type Version } from "@superbee/core/storage";
import { sha256Hex } from "@superbee/core/versioning";
import { hostLocks, type LockManagerLike } from "./push-role.js";

/** Partition labels supplied by an authenticated host; these are never authorization. */
export interface EditorRecoveryScope {
  endpoint: string;
  principalScope: string;
  workspace: string;
  bundle: string;
  installation: string;
  registrationScope: string;
}
export interface EditorDraft {
  base: { version: Version; body: string };
  body: string;
}
/** Exact body-only request to pass to the host's identified save implementation. */
export interface EditorPreparedAttempt {
  requestId: string;
  documentId: string;
  expectedVersion: Version;
  body: string;
  diagnosticsVersion: 1;
}
export type EditorSettlement = { kind: "committed"; version: Version } | { kind: "refused" };
export interface EditorRecoverySlot extends EditorDraft {
  documentId: string;
  revision: number;
  pending: EditorPreparedAttempt | null;
  confirmation: ({ requestId: string } & EditorSettlement) | null;
}
export interface EditorRecoverySession {
  read(documentId: string): Promise<EditorRecoverySlot | null>;
  saveDraft(documentId: string, draft: EditorDraft, expectedDraftRevision: number | null): Promise<EditorRecoverySlot>;
  prepare(documentId: string, input: { requestId: string }, expectedDraftRevision: number): Promise<EditorPreparedAttempt>;
  settle(documentId: string, requestId: string, outcome: EditorSettlement): Promise<EditorRecoverySlot>;
  discardDraft(documentId: string, expectedDraftRevision: number): Promise<void>;
}
export interface EditorRecoveryOptions {
  backend: Pick<JournaledBackend, "readMeta" | "writeMeta">;
  /** No fallback: cross-tab coordination is required even for reads. */
  locks?: LockManagerLike | null;
}
export type EditorRecoveryResult<T> = { held: true; value: T } | { held: false; reason: "held-elsewhere" | "locks-unavailable" };
export const EDITOR_RECOVERY_LIMITS = Object.freeze({ documents: 32, envelopeBytes: 2 * 1024 * 1024, bodyBytes: 64 * 1024 });
export class EditorRecoveryError extends Error {
  override readonly name = "EditorRecoveryError";
  readonly code: "invalid" | "capacity" | "stale" | "pending" | "request-mismatch" | "closed";
  constructor(code: EditorRecoveryError["code"], message: string) { super(message); this.code = code; }
}
interface Envelope {
  schemaVersion: 1;
  scope: EditorRecoveryScope;
  nextRevision: number;
  documents: EditorRecoverySlot[];
}
const encoder = new TextEncoder();
const scopeKeys = ["endpoint", "principalScope", "workspace", "bundle", "installation", "registrationScope"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function requireValue(ok: unknown, message: string, code: EditorRecoveryError["code"] = "invalid"): asserts ok {
  if (!ok) throw new EditorRecoveryError(code, message);
}
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid recovery object");
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "Unknown or missing recovery fields");
}
function label(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.length > 0 && value.trim() === value && encoder.encode(value).length <= 2048, "Invalid recovery label");
}
function body(value: unknown): asserts value is string {
  requireValue(typeof value === "string", "Invalid draft body");
  requireValue(encoder.encode(value).length <= EDITOR_RECOVERY_LIMITS.bodyBytes, "Draft body capacity exceeded", "capacity");
}
function revision(value: unknown): asserts value is number {
  requireValue(Number.isSafeInteger(value) && (value as number) > 0, "Invalid draft revision");
}
function requestId(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && uuid.test(value), "Expected a UUIDv4 request identity");
}
function documentId(value: string): void { label(value); assertSafeConceptId(value); }
function canonicalScope(input: EditorRecoveryScope): EditorRecoveryScope {
  const captured = structuredClone(input);
  object(captured, scopeKeys);
  for (const key of scopeKeys) label(captured[key]);
  const endpoint = new URL(captured.endpoint);
  requireValue((endpoint.protocol === "https:" || endpoint.protocol === "http:") && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, "Endpoint must be an HTTP(S) URL without credentials, query or fragment");
  return { endpoint: endpoint.href, principalScope: captured.principalScope, workspace: captured.workspace, bundle: captured.bundle, installation: captured.installation, registrationScope: captured.registrationScope };
}
function scopeTuple(scope: EditorRecoveryScope): string { return JSON.stringify(scopeKeys.map(key => scope[key])); }
/** The same captured canonical tuple owns both its metadata key and its writer lock. */
export function editorRecoveryKey(scope: EditorRecoveryScope): string {
  return `superbee:editor-recovery:v1:${sha256Hex(scopeTuple(canonicalScope(scope)))}`;
}
function validateDraft(value: unknown): asserts value is EditorDraft {
  object(value, ["base", "body"]);
  object(value.base, ["version", "body"]);
  requireValue(isContentVersion(value.base.version), "Invalid base version");
  body(value.base.body); body(value.body);
}
function validateSettlement(value: unknown): asserts value is EditorSettlement {
  requireValue(value !== null && typeof value === "object", "Invalid settlement");
  const kind = (value as EditorSettlement).kind;
  object(value, kind === "committed" ? ["kind", "version"] : ["kind"]);
  requireValue(kind === "committed" || kind === "refused", "Only definitive outcomes can settle an attempt");
  if (kind === "committed") requireValue(isContentVersion(value.version), "Invalid confirmation version");
}
function validateEnvelope(value: unknown, scope: EditorRecoveryScope): asserts value is Envelope {
  object(value, ["schemaVersion", "scope", "nextRevision", "documents"]);
  requireValue(value.schemaVersion === 1, "Unsupported recovery schema");
  requireValue(scopeTuple(canonicalScope(value.scope as EditorRecoveryScope)) === scopeTuple(scope) && JSON.stringify(value.scope) === JSON.stringify(scope), "Recovery scope mismatch");
  revision(value.nextRevision);
  requireValue(Array.isArray(value.documents), "Invalid recovery documents");
  requireValue(value.documents.length <= EDITOR_RECOVERY_LIMITS.documents, "Recovery document capacity exceeded", "capacity");
  const ids = new Set<string>();
  const revisions = new Set<number>();
  const requests = new Set<string>();
  for (const slot of value.documents) {
    object(slot, ["documentId", "base", "body", "revision", "pending", "confirmation"]);
    documentId(slot.documentId as string);
    requireValue(!ids.has(slot.documentId as string), "Duplicate recovery document"); ids.add(slot.documentId as string);
    validateDraft({ base: slot.base, body: slot.body });
    revision(slot.revision);
    requireValue(slot.revision < value.nextRevision && !revisions.has(slot.revision), "Invalid recovery revision order"); revisions.add(slot.revision);
    if (slot.pending !== null) {
      object(slot.pending, ["requestId", "documentId", "expectedVersion", "body", "diagnosticsVersion"]);
      requestId(slot.pending.requestId);
      requireValue(!requests.has(slot.pending.requestId), "Duplicate pending request"); requests.add(slot.pending.requestId);
      requireValue(slot.pending.documentId === slot.documentId && slot.pending.diagnosticsVersion === 1 && isContentVersion(slot.pending.expectedVersion), "Invalid prepared attempt");
      body(slot.pending.body);
    }
    if (slot.confirmation !== null) {
      const confirmation = slot.confirmation as Record<string, unknown>;
      object(confirmation, confirmation.kind === "committed" ? ["requestId", "kind", "version"] : ["requestId", "kind"]);
      requestId(confirmation.requestId);
      const { requestId: _, ...outcome } = confirmation;
      validateSettlement(outcome);
    }
  }
  requireValue(encoder.encode(JSON.stringify(value)).length <= EDITOR_RECOVERY_LIMITS.envelopeBytes, "Recovery envelope capacity exceeded", "capacity");
}

/**
 * Retain editor work under one cross-tab writer role for the callback's whole lifetime.
 * The host must establish current read authorization before opening, close on access loss,
 * and separately authorize any remote retry. This primitive never sends, expires or purges.
 * Browser eviction and device-owner access remain properties of browser storage.
 */
export async function withEditorRecovery<T>(input: EditorRecoveryScope, options: EditorRecoveryOptions, fn: (session: EditorRecoverySession) => Promise<T>): Promise<EditorRecoveryResult<T>> {
  const scope = canonicalScope(input);
  const key = editorRecoveryKey(scope);
  const backend = options.backend;
  const locks = options.locks === undefined ? hostLocks() : options.locks;
  if (!locks) return { held: false, reason: "locks-unavailable" };
  return locks.request<EditorRecoveryResult<T>>(key, { ifAvailable: true }, async lock => {
    if (!lock) return { held: false, reason: "held-elsewhere" };
    const stored = await backend.readMeta(key);
    let envelope: Envelope = stored === undefined ? { schemaVersion: 1, scope, nextRevision: 1, documents: [] } : structuredClone(stored) as Envelope;
    validateEnvelope(envelope, scope);
    let active = true;
    let failedWrite: unknown;
    let poisoned = false;
    let queue = Promise.resolve();
    function enqueue<R>(operation: () => Promise<R> | R): Promise<R> {
      if (!active) return Promise.reject(new EditorRecoveryError("closed", "Recovery session is closed"));
      const next = queue.then(() => {
        requireValue(!poisoned, "Recovery storage failed; reopen before continuing", "closed");
        return operation();
      });
      queue = next.then(() => {}, () => {});
      return next;
    }
    async function persist(next: Envelope): Promise<void> {
      validateEnvelope(next, scope);
      try { await backend.writeMeta(key, structuredClone(next)); }
      catch (error) { poisoned = true; failedWrite = error; throw error; }
      envelope = next;
    }
    function slotFor(next: Envelope, id: string, expected?: number | null): EditorRecoverySlot | undefined {
      const slot = next.documents.find(row => row.documentId === id);
      if (expected !== undefined) requireValue((slot?.revision ?? null) === expected, "Draft changed since it was read", "stale");
      return slot;
    }
    const session: EditorRecoverySession = {
      async read(id) {
        documentId(id);
        return enqueue(() => structuredClone(slotFor(envelope, id) ?? null));
      },
      async saveDraft(id, inputDraft, expected) {
        const draft = structuredClone(inputDraft);
        documentId(id); validateDraft(draft); if (expected !== null) revision(expected);
        return enqueue(async () => {
          const next = structuredClone(envelope);
          const previous = slotFor(next, id, expected);
          const slot: EditorRecoverySlot = { documentId: id, ...draft, revision: next.nextRevision++, pending: previous?.pending ?? null, confirmation: previous?.confirmation ?? null };
          if (previous) next.documents[next.documents.indexOf(previous)] = slot;
          else next.documents.push(slot);
          await persist(next);
          return structuredClone(slot);
        });
      },
      async prepare(id, inputRequest, expected) {
        const captured = structuredClone(inputRequest);
        documentId(id); object(captured, ["requestId"]); requestId(captured.requestId); revision(expected);
        return enqueue(async () => {
          const next = structuredClone(envelope);
          const slot = slotFor(next, id, expected);
          requireValue(slot, "Draft is missing", "stale");
          requireValue(!slot.pending, "An unresolved attempt already exists", "pending");
          requireValue(!next.documents.some(row => row.pending?.requestId === captured.requestId || row.confirmation?.requestId === captured.requestId), "Request identity already used", "request-mismatch");
          const pending: EditorPreparedAttempt = { requestId: captured.requestId, documentId: id, expectedVersion: slot.base.version, body: slot.body, diagnosticsVersion: 1 };
          slot.pending = pending;
          await persist(next);
          return structuredClone(pending);
        });
      },
      async settle(id, identity, inputOutcome) {
        const outcome = structuredClone(inputOutcome);
        documentId(id); requestId(identity); validateSettlement(outcome);
        return enqueue(async () => {
          const next = structuredClone(envelope);
          const slot = slotFor(next, id);
          requireValue(slot?.pending?.requestId === identity, "Pending request identity does not match", "request-mismatch");
          slot.pending = null;
          slot.confirmation = { requestId: identity, ...outcome };
          await persist(next);
          return structuredClone(slot);
        });
      },
      async discardDraft(id, expected) {
        documentId(id); revision(expected);
        return enqueue(async () => {
          const next = structuredClone(envelope);
          const slot = slotFor(next, id, expected);
          requireValue(slot, "Draft is missing", "stale");
          requireValue(!slot.pending, "An unresolved attempt cannot be discarded", "pending");
          next.documents.splice(next.documents.indexOf(slot), 1);
          await persist(next);
        });
      },
    };
    try {
      const value = await fn(session);
      active = false;
      await queue;
      if (poisoned) throw failedWrite;
      return { held: true, value };
    } finally {
      active = false;
      // Already-entered operations retain the lock even when the callback throws or forgets await.
      await queue;
    }
  });
}
