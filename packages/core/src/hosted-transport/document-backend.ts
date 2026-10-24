/** A finite document StorageBackend over hosted's existing read and write grammars. */
import { isOkfActor } from "../okf-actor.js";
import { stringifyDoc } from "../frontmatter.js";
import { assertSafeConceptId, isReservedFile, pathFromConceptId } from "../paths.js";
import { sha256HexOfUtf8 } from "../sha256.js";
import type { StorageBackend } from "../types.js";
import { performUncertainWrite, type OperationIntent, type Outcome } from "../uncertain-write.js";
import { isContentVersion, VersionConflict } from "../version-transport.js";
import { isWriteBinding, isWriteRequestId } from "../write-identity.js";
import type { HostedCarrier } from "./carrier.js";
import type { HostedReadAdapter } from "./read-adapter.js";
import { createWholeDocumentTransport, wholeDocumentRequest, type WholeDocumentRoutes } from "./whole-document-transport.js";

/** Authority and interpretation pinned by the host before constructing this backend. */
export interface HostedDocumentScope {
  readonly tenant: string;
  readonly bundleId: string;
  readonly registration: string;
  readonly binding: string;
  readonly workspace: string | null;
  readonly okfVersion: "0.1" | "0.2";
  readonly mode: "write";
  readonly bodyPolicy: "protected";
  readonly tombstonePolicy: "refuse";
}

export interface HostedDocumentIntent {
  readonly scope: Readonly<HostedDocumentScope>;
  readonly intent: Readonly<OperationIntent>;
  /** Advisory input only; the carrier and host determine persisted attribution. */
  readonly advisoryActor: string | null;
  /** Binds immutable scope, content, premise, identity and original creation instant. */
  readonly digest: string;
  readonly outcome?: Readonly<Outcome>;
}

/**
 * Trusted persistence, outside the bundle. All methods are atomic and durable before resolving.
 * prepareOrReadAndClaim inserts a new descriptor with in_flight/attempts=1 and returns fresh=true
 * to exactly one caller. An existing row, even pending or in_flight, ALWAYS returns fresh=false.
 * A failed/uncertain acknowledgement grants no freshness. Never overwrite a different descriptor
 * under an identity. settle compares the immutable digest, preserves the descriptor, and must not
 * overwrite a known outcome; contradictory settlement must refuse. Retain both through the consumer's acceptance acknowledgement.
 */
export interface HostedDocumentIntentPort {
  prepareOrReadAndClaim(candidate: HostedDocumentIntent): Promise<{ record: HostedDocumentIntent; fresh: boolean }>;
  settle(record: HostedDocumentIntent, outcome: Outcome): Promise<void>;
}

export class HostedDocumentBackendError extends Error {
  override readonly name = "HostedDocumentBackendError";
  readonly code: string;
  readonly requestId?: string;
  readonly record?: HostedDocumentIntent;
  constructor(code: string, message: string, requestId?: string, record?: HostedDocumentIntent, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.requestId = requestId;
    this.record = record;
  }
}

/** CAS conflict retaining the original identity and tombstone receipt for its consumer. */
export class HostedDocumentVersionConflict extends VersionConflict {
  readonly requestId: string;
  readonly record: HostedDocumentIntent;
  constructor(record: HostedDocumentIntent) {
    const outcome = record.outcome;
    if (outcome?.kind !== "conflict") throw new TypeError("A recorded conflict is required.");
    super(record.intent.target, record.intent.base, outcome.actual);
    this.requestId = record.intent.requestId;
    this.record = record;
  }
}

export interface HostedDocumentBackendOptions {
  readonly reader: HostedReadAdapter;
  readonly carrier: HostedCarrier;
  readonly scope: HostedDocumentScope;
  readonly intents: HostedDocumentIntentPort;
  readonly maximumDocuments: number;
  readonly routes?: WholeDocumentRoutes;
  readonly now?: () => number;
}

function immutable(record: HostedDocumentIntent): string {
  const { intent: i, scope: s } = record;
  return JSON.stringify([s.tenant, s.bundleId, s.registration, s.binding, s.workspace, s.okfVersion, s.mode, s.bodyPolicy, s.tombstonePolicy,
    record.advisoryActor, i.requestId, i.kind, i.target, i.base, i.local, i.content, i.createdAt]);
}
function capture(record: HostedDocumentIntent): HostedDocumentIntent {
  return Object.freeze({ scope: Object.freeze({ ...record.scope }), intent: Object.freeze({ ...record.intent }), advisoryActor: record.advisoryActor, digest: record.digest,
    ...(record.outcome === undefined ? {} : { outcome: Object.freeze({ ...record.outcome }) }) });
}
function sameInput(a: HostedDocumentIntent, b: HostedDocumentIntent): boolean {
  return a.scope.workspace === b.scope.workspace && a.intent.base === b.intent.base && a.advisoryActor === b.advisoryActor &&
    immutable({ ...a, intent: { ...a.intent, createdAt: b.intent.createdAt } }) === immutable(b);
}
function refuse(): never { throw new HostedDocumentBackendError("unsupported", "This backend supports only finite document reads and conditional document writes."); }
async function unsupported(): Promise<never> { return refuse(); }

/**
 * No auth authority or general wire routes are supplied here. An actor option is validated as
 * advisory only; agent/bodyReplace
 * options are refused: the host attributes normal writes and retains its body protection policy.
 * Every reopened descriptor is lookup-only; absent or expired receipts never authorize a resend.
 */
export function createHostedDocumentBackend(options: HostedDocumentBackendOptions): StorageBackend {
  const { reader, carrier, intents } = options;
  const scope = Object.freeze({ ...options.scope });
  if (![scope.tenant, scope.bundleId, scope.registration].every((v) => typeof v === "string" && v.length > 0) ||
      !isWriteBinding(scope.binding) || !(scope.workspace === null || typeof scope.workspace === "string" && scope.workspace.length > 0) ||
      !["0.1", "0.2"].includes(scope.okfVersion) || scope.mode !== "write" || scope.bodyPolicy !== "protected" || scope.tombstonePolicy !== "refuse")
    throw new TypeError("Invalid hosted document scope.");
  const maximumDocuments = options.maximumDocuments;
  if (!Number.isSafeInteger(maximumDocuments) || maximumDocuments < 1) throw new TypeError("maximumDocuments must be a positive integer.");
  const now = options.now ?? Date.now;
  const routes = options.routes === undefined ? undefined : Object.freeze({ ...options.routes });
  return {
    read: (id) => reader.read(id),
    readMany: (ids) => reader.readMany(ids),
    readReserved: (dir, name) => reader.readReserved(dir, name),
    async exists(id) {
      try { await reader.read(id); return true; }
      catch (error) { if ((error as { code?: unknown } | null)?.code === "ENOENT") return false; throw error; }
    },
    async list(prefix) {
      const result = await reader.heads();
      if (result === null) throw new HostedDocumentBackendError("inventory_incomplete", "A complete document inventory is required.");
      if (result.heads.length > maximumDocuments) throw new HostedDocumentBackendError("inventory_bound", "Document inventory exceeds the configured bound.");
      return result.heads.map((head) => head.id).filter((id) => prefix === undefined || id.startsWith(prefix));
    },
    async write(id, doc, writeOptions) {
      assertSafeConceptId(id);
      if (isReservedFile(pathFromConceptId(id))) refuse();
      if (!writeOptions || typeof writeOptions.requestId !== "string" || !isWriteRequestId(writeOptions.requestId) ||
          !(writeOptions.expectedVersion === null || isContentVersion(writeOptions.expectedVersion)))
        throw new HostedDocumentBackendError("invalid_input", "A UUIDv4 requestId and explicit create/replace CAS are required.");
      if (writeOptions.actor !== undefined && !isOkfActor(writeOptions.actor)) throw new HostedDocumentBackendError("invalid_input", "actor must be an OKF actor; persisted attribution belongs to the host.");
      if (Object.entries(writeOptions).some(([key, value]) => value !== undefined && !["requestId", "expectedVersion", "actor"].includes(key))) refuse();
      const requestId = writeOptions.requestId;
      const content = stringifyDoc(doc.frontmatter, doc.body);
      const intent: OperationIntent = { requestId, kind: "document.write", target: id, base: writeOptions.expectedVersion,
        local: `sha256:${sha256HexOfUtf8(content)}`, content, createdAt: new Date(now()).toISOString(), attempts: 1, state: "in_flight" };
      // Preflight uses the same semantic owner as the actual transport, before persistence.
      wholeDocumentRequest(scope.bundleId, intent, scope.okfVersion);
      const initial = { scope, intent, advisoryActor: writeOptions.actor ?? null, digest: "" };
      const candidate = capture({ ...initial, digest: sha256HexOfUtf8(immutable(initial)) });
      let record: HostedDocumentIntent;
      let fresh: boolean;
      try {
        const prepared = await intents.prepareOrReadAndClaim(candidate);
        record = capture(prepared.record);
        fresh = prepared.fresh;
      } catch (cause) {
        throw new HostedDocumentBackendError("outcome_unknown", "Intent claim acknowledgement is uncertain; retain the original identity.", requestId, undefined, { cause });
      }
      if (!sameInput(record, candidate) || record.digest !== sha256HexOfUtf8(immutable(record)) ||
          record.intent.local !== `sha256:${sha256HexOfUtf8(record.intent.content)}` || record.intent.bodyReplace !== undefined || record.intent.recreates !== undefined ||
          !Number.isFinite(Date.parse(record.intent.createdAt)) || typeof fresh !== "boolean" ||
          !Number.isSafeInteger(record.intent.attempts) || record.intent.attempts < 0 ||
          !["pending", "in_flight", "acknowledged", "conflict", "refused", "unknown"].includes(record.intent.state) ||
          fresh && (record.digest !== candidate.digest || record.intent.attempts !== 1 || record.intent.state !== "in_flight" || record.outcome !== undefined))
        throw new HostedDocumentBackendError("intent_conflict", "Stored identity does not match the immutable write and scope.", requestId);
      const transport = createWholeDocumentTransport({ carrier, bundleId: scope.bundleId, binding: scope.binding, okfVersion: scope.okfVersion,
        remote: reader, intentFor: async (key) => key === requestId ? { ...record.intent } : undefined, routes, signal: reader.signal, now });
      const result = record.outcome && record.outcome.kind !== "unknown" ? { outcome: record.outcome as Outcome } :
        await performUncertainWrite({ submit: (sending, opts) => transport.submit(sending, opts), lookup: async (key) => {
          const answer = await transport.lookup(key);
          return answer?.kind === "pending" ? null : answer;
        } }, { ...record.intent }, { settlement: "recorded-only", start: fresh ? "submit-claimed" : "lookup", signal: reader.signal });
      const outcome = result.outcome;
      try { await intents.settle(record, outcome); }
      catch (cause) { throw new HostedDocumentBackendError("outcome_unknown", "Outcome persistence is uncertain; retain the original identity.", requestId, capture({ ...record, outcome }), { cause }); }
      switch (outcome.kind) {
        case "committed": return outcome.version;
        case "conflict": throw new HostedDocumentVersionConflict(capture({ ...record, outcome }));
        case "refused": throw new HostedDocumentBackendError(outcome.code, outcome.message, requestId, capture({ ...record, outcome }));
        case "unknown": throw new HostedDocumentBackendError("outcome_unknown", "The original write outcome remains unknown.", requestId, record);
      }
    },
    capabilities: () => ({ enforced_cas: true, history: false, blobs: false }),
    versions: unsupported, writeReserved: unsupported, delete: unsupported, readBlob: unsupported, writeBlob: unsupported,
    existsBlob: unsupported, listBlobs: unsupported, deleteBlob: unsupported,
  };
}
