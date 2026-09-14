/** Immutable delivery evidence for body-only updates whose authority owns document metadata. */
import { parseMarkdown, normalizeDocumentBodyForStorage } from "./frontmatter.js";
import { assertSafeConceptId, isReservedFile, pathFromConceptId } from "./paths.js";
import { parseIsoInstant } from "./verification.js";
import { isContentVersion, versionOfBytes } from "./versioning.js";
import { isRequestIdentity, performUncertainWrite, type Outcome, type OperationState, type UncertainWriteOptions } from "./uncertain-write.js";
import type { IntentRecord } from "./journaled-backend.js";
import type { Version } from "./types.js";

export const BODY_DELIVERY_LIMITS = Object.freeze({ labelBytes: 2048, bodyBytes: 64 * 1024, envelopeBytes: 2 * 1024 * 1024 });
export interface BodyUpdateOperation { readonly kind: "document.body.update"; readonly body: string }
export interface PreparedBodyDelivery {
  readonly schema: 1;
  readonly scope: string;
  readonly requestId: string;
  readonly target: string;
  readonly okfVersion: "0.1" | "0.2";
  readonly operation: BodyUpdateOperation;
  readonly expectedVersion: Version;
  readonly local: Version;
  readonly content: string;
  readonly createdAt: string;
  readonly predecessor?: Readonly<{ requestId: string; acknowledgedVersion: Version }>;
}
export interface CommittedBodyReceipt {
  readonly scope: string;
  readonly requestId: string;
  readonly target: string;
  readonly expectedVersion: Version;
  readonly body: string;
  readonly version: Version;
  readonly content: string;
}
export type BodyDeliveryOutcome =
  | { readonly kind: "committed"; readonly receipt: CommittedBodyReceipt }
  | Exclude<Outcome, { kind: "committed" }>;
export interface BodyDeliveryTransport {
  submit(prepared: PreparedBodyDelivery, options?: { signal?: AbortSignal }): Promise<BodyDeliveryOutcome>;
  /** null positively means never recorded; unavailable evidence must be unknown or throw. */
  lookup(prepared: PreparedBodyDelivery): Promise<BodyDeliveryOutcome | null>;
}
export interface BodyDeliveryResult {
  readonly prepared: PreparedBodyDelivery;
  readonly attempts: number;
  readonly state: OperationState;
  readonly lookups: number;
  readonly outcome: BodyDeliveryOutcome;
  readonly diagnostic?: string;
}

type RecordValue = Record<string, unknown>;
function fail(message: string): never { throw new Error(`Invalid body delivery: ${message}`); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("expected a plain record");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key) && !optional.includes(key)) ||
      Object.values(descriptors).some(d => !d.enumerable || !("value" in d)) || keys.some(key => !Object.hasOwn(value, key))) fail("unexpected or missing fields");
  return value as RecordValue;
}
function string(value: unknown, max: number = BODY_DELIVERY_LIMITS.labelBytes, nonempty = true): string {
  if (typeof value !== "string" || nonempty && !value.trim() || new TextEncoder().encode(value).length > max) fail("invalid string or size limit");
  return value;
}
function version(value: unknown): Version { if (!isContentVersion(value)) fail("invalid version"); return value; }
function request(value: unknown): string { const id = string(value); if (!isRequestIdentity(id)) fail("invalid request identity"); return id; }
function timestamp(value: unknown): string { const text = string(value); if (parseIsoInstant(text) === null) fail("invalid timestamp"); return text; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid count"); return value; }
function target(value: unknown): string {
  const id = string(value); assertSafeConceptId(id);
  if (isReservedFile(pathFromConceptId(id))) fail("reserved target");
  return id;
}
function bounded<T>(value: T): T { string(JSON.stringify(value), BODY_DELIVERY_LIMITS.envelopeBytes); return value; }
function bodyContent(content: unknown, body: string, id: string, okfVersion: "0.1" | "0.2"): string {
  const raw = string(content, BODY_DELIVERY_LIMITS.envelopeBytes, false);
  const parsed = parseMarkdown(raw, id, { okfVersion });
  if (typeof parsed.frontmatter.type !== "string" || !parsed.frontmatter.type.trim()) fail("concept type required");
  if (normalizeDocumentBodyForStorage(parsed.body) !== normalizeDocumentBodyForStorage(body)) fail("content body differs from operation");
  return raw;
}

/** Capture a serialized envelope without changing its request identity or original history. */
export function validatePreparedBodyDelivery(value: unknown): PreparedBodyDelivery {
  const raw = record(value, ["schema", "scope", "requestId", "target", "okfVersion", "operation", "expectedVersion", "local", "content", "createdAt"], ["predecessor"]);
  if (raw.schema !== 1 || raw.okfVersion !== "0.1" && raw.okfVersion !== "0.2") fail("unsupported schema or edition");
  const op = record(raw.operation, ["kind", "body"]);
  if (op.kind !== "document.body.update") fail("unsupported operation");
  const operation = Object.freeze({ kind: "document.body.update" as const, body: string(op.body, BODY_DELIVERY_LIMITS.bodyBytes, false) });
  const id = target(raw.target);
  const content = bodyContent(raw.content, operation.body, id, raw.okfVersion);
  const local = version(raw.local);
  if (versionOfBytes(content) !== local) fail("local content hash mismatch");
  let predecessor: PreparedBodyDelivery["predecessor"];
  if (Object.hasOwn(raw, "predecessor")) {
    const p = record(raw.predecessor, ["requestId", "acknowledgedVersion"]);
    predecessor = Object.freeze({ requestId: request(p.requestId), acknowledgedVersion: version(p.acknowledgedVersion) });
    if (predecessor.requestId === raw.requestId || predecessor.acknowledgedVersion !== raw.expectedVersion) fail("invalid predecessor");
  }
  return Object.freeze(bounded<PreparedBodyDelivery>({ schema: 1, scope: string(raw.scope), requestId: request(raw.requestId), target: id,
    okfVersion: raw.okfVersion, operation, expectedVersion: version(raw.expectedVersion), local, content,
    createdAt: timestamp(raw.createdAt), ...(predecessor ? { predecessor } : {}) }));
}

export type BodyDeliveryInput = Omit<PreparedBodyDelivery, "schema" | "expectedVersion" | "predecessor">;
export type BodyDeliveryPremise = { expectedVersion: Version } | { prepared: PreparedBodyDelivery; receipt: CommittedBodyReceipt };
/** Successors derive their premise only from a fully bound predecessor receipt. */
export function prepareBodyDelivery(input: BodyDeliveryInput, premise: BodyDeliveryPremise): PreparedBodyDelivery {
  const fields = record(input, ["scope", "requestId", "target", "okfVersion", "operation", "local", "content", "createdAt"]);
  if (Object.hasOwn(premise, "expectedVersion")) {
    const initial = record(premise, ["expectedVersion"]);
    return validatePreparedBodyDelivery({ ...fields, schema: 1, expectedVersion: initial.expectedVersion });
  }
  const prior = record(premise, ["prepared", "receipt"]);
  const prepared = validatePreparedBodyDelivery(prior.prepared);
  const receipt = validateBodyReceipt(prepared, prior.receipt);
  if (fields.scope !== prepared.scope || fields.target !== prepared.target || fields.okfVersion !== prepared.okfVersion || fields.requestId === prepared.requestId) fail("successor identity mismatch");
  return validatePreparedBodyDelivery({ ...fields, schema: 1, expectedVersion: receipt.version,
    predecessor: { requestId: prepared.requestId, acknowledgedVersion: receipt.version } });
}

export function assertSameBodyDelivery(recorded: unknown, candidate: unknown): void {
  if (JSON.stringify(validatePreparedBodyDelivery(recorded)) !== JSON.stringify(validatePreparedBodyDelivery(candidate))) fail("request identity reused with different input");
}

/** Content/version association is asserted by the trusted authority, not inferred from a later head. */
export function validateBodyReceipt(prepared: PreparedBodyDelivery, value: unknown): CommittedBodyReceipt {
  const p = validatePreparedBodyDelivery(prepared);
  const raw = record(value, ["scope", "requestId", "target", "expectedVersion", "body", "version", "content"]);
  if (raw.scope !== p.scope || raw.requestId !== p.requestId || raw.target !== p.target ||
      raw.expectedVersion !== p.expectedVersion || raw.body !== p.operation.body) fail("receipt binding mismatch");
  return Object.freeze(bounded({ scope: p.scope, requestId: p.requestId, target: p.target, expectedVersion: p.expectedVersion,
    body: p.operation.body, version: version(raw.version), content: bodyContent(raw.content, p.operation.body, p.target, p.okfVersion) }));
}

type EvidencedOutcome = Outcome & { receipt?: CommittedBodyReceipt; diagnostic?: string };
function captureOutcome(prepared: PreparedBodyDelivery, value: unknown): EvidencedOutcome {
  try {
    if (!value || typeof value !== "object") fail("invalid outcome");
    switch ((value as RecordValue).kind) {
      case "committed": {
        const raw = record(value, ["kind", "receipt"]);
        const receipt = validateBodyReceipt(prepared, raw.receipt);
        return Object.freeze({ kind: "committed", version: receipt.version, receipt });
      }
      case "conflict": { const raw = record(value, ["kind", "actual"]); return { kind: "conflict", actual: raw.actual === null ? null : version(raw.actual) }; }
      case "refused": { const raw = record(value, ["kind", "code", "message"]); return { kind: "refused", code: string(raw.code), message: string(raw.message) }; }
      case "unknown": record(value, ["kind"]); return { kind: "unknown" };
      default: fail("unknown outcome kind");
    }
  } catch { return { kind: "unknown", diagnostic: "Invalid or incomplete delivery evidence" }; }
}

/** Persist the envelope and attempted claim atomically BEFORE calling; this function does no persistence. */
export async function performBodyDelivery(
  transport: BodyDeliveryTransport, prepared: PreparedBodyDelivery, attempts: number,
  options: Omit<UncertainWriteOptions, "settlement"> = {},
): Promise<BodyDeliveryResult> {
  const p = validatePreparedBodyDelivery(prepared);
  integer(attempts);
  const raw = record(options, [], ["deadlineMs", "maxLookups", "lookupDelayMs", "maxSubmissions", "sleep"]);
  for (const key of ["deadlineMs", "maxLookups", "lookupDelayMs", "maxSubmissions"]) if (Object.hasOwn(raw, key)) integer(raw[key]);
  if (raw.sleep !== undefined && typeof raw.sleep !== "function") fail("invalid timer");
  if (attempts > Number.MAX_SAFE_INTEGER - Math.max(1, options.maxSubmissions ?? 2)) fail("attempt counter overflow");
  const result = await performUncertainWrite({
    submit: async (_intent, signal) => captureOutcome(p, await transport.submit(p, signal)),
    lookup: async () => { const value = await transport.lookup(p); return value === null ? null : captureOutcome(p, value); },
  }, { requestId: p.requestId, kind: p.operation.kind, target: p.target, base: p.expectedVersion, local: p.local,
    content: p.content, createdAt: p.createdAt, attempts, state: "pending" }, { ...options, settlement: "recorded-only" });
  // Evidence travels on the chosen outcome, so a deadline-late response cannot replace it.
  const chosen = result.outcome as EvidencedOutcome;
  const outcome: BodyDeliveryOutcome = chosen.kind === "committed"
    ? chosen.receipt && chosen.receipt.version === chosen.version ? { kind: "committed", receipt: chosen.receipt } : { kind: "unknown" }
    : chosen.kind === "unknown" ? { kind: "unknown" } : chosen;
  return Object.freeze({ prepared: p, attempts: result.intent.attempts, state: outcome.kind === "committed" ? "acknowledged" : outcome.kind,
    lookups: result.lookups, outcome: Object.freeze(outcome), ...(chosen.diagnostic ? { diagnostic: chosen.diagnostic } : {}) });
}

export interface BodyLocalSnapshot {
  readonly version: Version | null;
  readonly intents: readonly IntentRecord[];
  readonly shared: Readonly<{ version: Version; content: string }> | null;
}
export interface BodyReconciliationProposal {
  readonly action: "preserve-local" | "replace-local-under-CAS";
  readonly receipt: CommittedBodyReceipt;
  readonly shared: Readonly<{ action: "preserve-shared" } | { action: "replace-shared-under-CAS"; version: Version; content: string }>;
  readonly expected: BodyLocalSnapshot;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function captureIntent(value: unknown): IntentRecord {
  const row = record(value, ["requestId", "kind", "target", "base", "local", "content", "createdAt", "attempts", "state", "sequence", "updatedAt", "baseContent"], ["after", "acknowledgedVersion", "remote", "refusal", "finding"]);
  request(row.requestId); string(row.kind); target(row.target); version(row.local);
  if (row.base !== null) version(row.base);
  string(row.content, BODY_DELIVERY_LIMITS.envelopeBytes, false);
  if (row.baseContent !== null) string(row.baseContent, BODY_DELIVERY_LIMITS.envelopeBytes, false);
  timestamp(row.createdAt); timestamp(row.updatedAt); integer(row.attempts); integer(row.sequence);
  if (!["pending", "in_flight", "acknowledged", "conflict", "refused", "unknown"].includes(row.state as string)) fail("invalid journal state");
  if (Object.hasOwn(row, "after")) request(row.after);
  if (Object.hasOwn(row, "acknowledgedVersion")) version(row.acknowledgedVersion);
  if (Object.hasOwn(row, "finding")) string(row.finding);
  if (Object.hasOwn(row, "remote")) {
    const remote = record(row.remote, ["version", "content"]);
    if (remote.version !== null) version(remote.version);
    if (remote.content !== null) string(remote.content, BODY_DELIVERY_LIMITS.envelopeBytes, false);
  }
  if (Object.hasOwn(row, "refusal")) { const refusal = record(row.refusal, ["code", "message"]); string(refusal.code); string(refusal.message); }
  return JSON.parse(JSON.stringify(row)) as IntentRecord;
}
/** Pure proposal only. Replacement requires an atomic full-journal, document AND shared-base CAS. */
export function reconcileBodyReceipt(prepared: PreparedBodyDelivery, receipt: CommittedBodyReceipt, snapshot: BodyLocalSnapshot): BodyReconciliationProposal {
  const p = validatePreparedBodyDelivery(prepared), r = validateBodyReceipt(p, receipt);
  record(snapshot, ["version", "intents", "shared"]);
  if (snapshot.version !== null) version(snapshot.version);
  if (!Array.isArray(snapshot.intents)) fail("invalid journal snapshot");
  if (Object.keys(snapshot.intents).length !== snapshot.intents.length) fail("invalid journal list");
  let shared: BodyLocalSnapshot["shared"] = null;
  if (snapshot.shared !== null) {
    const raw = record(snapshot.shared, ["version", "content"]);
    const content = string(raw.content, BODY_DELIVERY_LIMITS.envelopeBytes, false);
    const parsed = parseMarkdown(content, p.target, { okfVersion: p.okfVersion });
    if (typeof parsed.frontmatter.type !== "string" || !parsed.frontmatter.type.trim()) fail("shared concept type required");
    shared = { version: version(raw.version), content };
  }
  // Shared refresh can advance independently of the document and journal; compare all three.
  const expected: BodyLocalSnapshot = bounded({ version: snapshot.version, intents: snapshot.intents.map(captureIntent), shared });
  const ids = new Set<string>(), sequences = new Set<number>();
  for (const row of expected.intents) {
    request(row.requestId); integer(row.sequence);
    if (ids.has(row.requestId) || sequences.has(row.sequence)) fail("ambiguous journal snapshot");
    ids.add(row.requestId); sequences.add(row.sequence);
  }
  const anchor = expected.intents.find(row => row.requestId === p.requestId);
  const boundAnchor = anchor?.target === p.target && anchor.local === p.local && anchor.content === p.content && anchor.createdAt === p.createdAt;
  const newer = anchor ? expected.intents.filter(row => row.target === p.target && row.sequence > anchor.sequence) : [];
  const compatible = boundAnchor && !newer.some(row => row.state === "acknowledged");
  const alreadyShared = shared?.version === r.version && shared.content === r.content;
  const advanceShared = compatible && shared?.version === p.expectedVersion && shared.version !== r.version;
  const replace = compatible && (advanceShared || alreadyShared) && expected.version === p.local && newer.length === 0;
  return freezeDeep({ action: replace ? "replace-local-under-CAS" : "preserve-local", receipt: r,
    shared: advanceShared ? { action: "replace-shared-under-CAS", version: r.version, content: r.content } : { action: "preserve-shared" }, expected });
}
