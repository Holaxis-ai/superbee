/**
 * The hosted answer grammar, once: how every identified-write answer, every outcome-lookup
 * answer and every read-route answer is classified, whichever client sent the request. The
 * browser editor's body delivery and the CLI's whole-document sync read these same tables, so
 * "recorded", "unknown" and "absent past retention" mean one thing in both.
 *
 * The update rows are hosted's browser table plus the sync quota rows (`request_capacity`),
 * which only the `/sync/v1` routes answer. Until the hosted browser imports this module, hosted's golden exchanges
 * (`test/fixtures/hosted-transport/`, produced from the hosted encoders) pin that these rows
 * classify exactly what the host emits.
 *
 * The rows keep three facts apart: a refusal the host recorded under the request identity is
 * definitive; a refusal answered before dispatch is definitive but unrecorded; and anything the
 * host may have applied without saying so is unknown. Only two refusal codes reach the shared
 * primitive's authorization set and pause the store: `AUTH_REQUIRED` (the carrier denied the
 * request) and `PERMISSION_DENIED` (the host refused the caller's access to the bundle).
 */

import { isContentVersion } from "../version-transport.js";
import type { Version } from "../types.js";
import type { HostedAnswer } from "./carrier.js";

/** A refusal code the shared primitive treats as lost authorization, pausing the store. */
export type AuthorizationCode = "AUTH_REQUIRED" | "PERMISSION_DENIED";

/**
 * The refusal codes of a sync quota the host enforces on identified writes (`request_capacity`),
 * one per scope it names: the person's rolling daily bound in this bundle, or the bundle's own
 * bound. The shared primitive counts both as pausing refusals, so the store pauses with nothing
 * lost and `resume` requeues the refused intents once the quota resets.
 */
export const CAPACITY_REFUSAL_CODES = Object.freeze({ principal: "REQUEST_CAPACITY_PRINCIPAL", bundle: "REQUEST_CAPACITY_BUNDLE" } as const);
export type CapacityScope = keyof typeof CAPACITY_REFUSAL_CODES;

/** The quota scope a refused outcome names, or `null` when it is not a capacity refusal. */
export function capacityScopeOf(outcome: { kind: string; code?: string }): CapacityScope | null {
  if (outcome.kind !== "refused") return null;
  if (outcome.code === CAPACITY_REFUSAL_CODES.principal) return "principal";
  if (outcome.code === CAPACITY_REFUSAL_CODES.bundle) return "bundle";
  return null;
}

/**
 * One identified-write answer and how the shared primitive sees it. `answer` names the hosted
 * answer: the status, and for a `200` the definitive refusal code, `ok`, or `other` for a code,
 * shape or size the client does not admit. `recorded` says whether the host holds the answer
 * under the request identity: always, never (refused before dispatch), only when the settled
 * header names the request, maybe (the write may have left), or unknown. `outcome` is the shared
 * outcome kind once the answer is recorded. `code` is the authorization code a refusal carries
 * when the host's own code must not reach the primitive.
 */
export type UpdateAnswerRow = Readonly<{
  answer: string;
  recorded: "yes" | "no" | "settled-only" | "maybe" | "unknown";
  outcome: "committed" | "conflict" | "refused" | "unknown";
  code?: AuthorizationCode;
}>;

export const UPDATE_ANSWER_ROWS: readonly UpdateAnswerRow[] = Object.freeze([
  { answer: "200 ok", recorded: "yes", outcome: "committed" },
  { answer: "200 version_conflict", recorded: "yes", outcome: "conflict" },
  { answer: "200 document_not_found", recorded: "yes", outcome: "conflict" },
  { answer: "200 validation_failed", recorded: "yes", outcome: "refused" },
  { answer: "200 body_edit_mismatch", recorded: "yes", outcome: "refused" },
  { answer: "200 invalid_input", recorded: "settled-only", outcome: "refused" },
  { answer: "200 insufficient_scope", recorded: "no", outcome: "refused", code: "PERMISSION_DENIED" },
  { answer: "200 bundle_not_found", recorded: "no", outcome: "refused", code: "PERMISSION_DENIED" },
  { answer: "200 access_denied", recorded: "no", outcome: "refused", code: "PERMISSION_DENIED" },
  { answer: "200 backend_unavailable", recorded: "settled-only", outcome: "refused" },
  { answer: "200 concurrent_change", recorded: "settled-only", outcome: "refused" },
  { answer: "200 internal_error", recorded: "settled-only", outcome: "refused" },
  { answer: "200 deadline_exceeded", recorded: "settled-only", outcome: "refused" },
  { answer: "200 cancelled", recorded: "settled-only", outcome: "refused" },
  // The remaining not_applied codes of the write schema: definitive once recorded, like the transient ones.
  { answer: "200 result_too_large", recorded: "settled-only", outcome: "refused" },
  { answer: "200 field_action_refused", recorded: "settled-only", outcome: "refused" },
  { answer: "200 document_exists", recorded: "settled-only", outcome: "refused" },
  { answer: "200 candidate_unavailable", recorded: "settled-only", outcome: "refused" },
  { answer: "200 candidate_recovery_unavailable", recorded: "settled-only", outcome: "refused" },
  // The sync quota, refused before dispatch; the row's outcome code is chosen by the scope the answer names.
  { answer: "200 request_capacity", recorded: "no", outcome: "refused" },
  { answer: "429 request_capacity", recorded: "no", outcome: "refused" },
  { answer: "200 write_outcome_unknown", recorded: "maybe", outcome: "unknown" },
  { answer: "200 other", recorded: "unknown", outcome: "unknown" },
  { answer: "400", recorded: "no", outcome: "unknown" },
  { answer: "401 not_applied", recorded: "no", outcome: "refused", code: "AUTH_REQUIRED" },
  { answer: "401 write_outcome_unknown", recorded: "maybe", outcome: "unknown" },
  { answer: "401 other", recorded: "unknown", outcome: "refused", code: "AUTH_REQUIRED" },
  { answer: "403", recorded: "no", outcome: "refused", code: "AUTH_REQUIRED" },
  { answer: "503", recorded: "maybe", outcome: "unknown" },
  { answer: "other status", recorded: "unknown", outcome: "unknown" },
  { answer: "not sent", recorded: "no", outcome: "refused", code: "AUTH_REQUIRED" },
  { answer: "carrier", recorded: "maybe", outcome: "unknown" },
]);

/**
 * One outcome-lookup answer and what the shared primitive receives: `null` says the host never
 * recorded the identity (or holds a claim without a result), an outcome is the recorded evidence,
 * and `throws` leaves the intent recoverable because the evidence was unavailable. `absent` past
 * the host's retention window, less the skew margin, is `unknown` rather than `null`: an expired
 * identity looks absent, and absence must never let an old intent be resubmitted as if never
 * delivered.
 */
export type OutcomeAnswerRow = Readonly<{
  answer: string;
  result: "null" | "committed" | "recorded" | "unknown" | "throws";
}>;

export const OUTCOME_ANSWER_ROWS: readonly OutcomeAnswerRow[] = Object.freeze([
  { answer: "200 absent", result: "null" },
  { answer: "200 absent past retention", result: "unknown" },
  { answer: "200 pending", result: "null" },
  { answer: "200 committed", result: "committed" },
  { answer: "200 refused", result: "recorded" },
  { answer: "200 committed contradiction", result: "throws" },
  { answer: "400", result: "throws" },
  { answer: "401", result: "throws" },
  { answer: "403", result: "throws" },
  { answer: "503", result: "throws" },
  { answer: "malformed", result: "throws" },
  { answer: "carrier", result: "throws" },
]);

/**
 * One read-route answer (capabilities, heads, snapshot, document read) and what the working
 * copy's pull sees. `admitted` is decoded; `not-modified` is a heads `304`; `truncated` is a
 * snapshot that ended before its terminator, which the pull re-requests; `authority` is a
 * refusal about the bundle or the caller, surfaced with the host's status and code; `offline`
 * says nothing about the bundle (a `503`) and pauses the pull as a carrier failure; `restart`
 * is a page the host refused because the bundle moved since the first page pinned it, so the
 * reader starts the listing again from the first page (a snapshot reports it as truncation).
 * A `page` answer is one page of a paged listing that names the next; the reader follows it.
 */
export type ReadAnswerRow = Readonly<{
  answer: string;
  result: "admitted" | "not-modified" | "truncated" | "authority" | "offline" | "restart";
}>;

export const READ_ANSWER_ROWS: readonly ReadAnswerRow[] = Object.freeze([
  { answer: "capabilities 200", result: "admitted" },
  { answer: "heads 200", result: "admitted" },
  { answer: "heads 304", result: "not-modified" },
  { answer: "heads 200 page", result: "admitted" },
  { answer: "snapshot 200 complete", result: "admitted" },
  { answer: "snapshot 200 page", result: "admitted" },
  { answer: "snapshot 200 truncated", result: "truncated" },
  { answer: "refusal 409 concurrent_change", result: "restart" },
  { answer: "refusal 400 invalid_input", result: "authority" },
  { answer: "refusal 401 unauthenticated", result: "authority" },
  { answer: "refusal 404 bundle_not_found", result: "authority" },
  { answer: "refusal 422 result_too_large", result: "authority" },
  { answer: "refusal 422 validation_failed", result: "authority" },
  { answer: "refusal 503 backend_unavailable", result: "offline" },
]);

// ── the operation result envelope ──────────────────────────────────────────────────────────

/** The codes a write refusal may carry: the hosted write schema's closed set. */
export const WRITE_ERROR_CODES = Object.freeze([
  "field_action_refused",
  "invalid_input",
  "insufficient_scope",
  "bundle_not_found",
  "backend_unavailable",
  "document_not_found",
  "document_exists",
  "version_conflict",
  "body_edit_mismatch",
  "validation_failed",
  "result_too_large",
  "cancelled",
  "deadline_exceeded",
  "concurrent_change",
  "write_outcome_unknown",
  "internal_error",
  "candidate_unavailable",
  "candidate_recovery_unavailable",
  "request_capacity",
] as const);
export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number];

/** The whole-document delete: its success names the tombstone as `version`, and the version that left. */
export const DELETE_OPERATION_ID = "documents.delete.v1";

export type WriteSuccess = {
  ok: true;
  operationId: string;
  /**
   * `version` is what committed: the document's new version, or for a delete the tombstone
   * version. A delete's data alone also carries `deletedVersion` (the version that left, which
   * is the request's `expectedVersion`) and `deleted: true`; `changed: false` there says the
   * document had already left at exactly that base, and `version` names that deletion.
   */
  data: { bundleId: string; documentId: string; version: Version; changed: boolean; scope?: unknown; deletedVersion?: Version; deleted?: true };
};
export type WriteFailure = {
  ok: false;
  operationId: string;
  error: {
    code: WriteErrorCode;
    message: string;
    retryable: false;
    writeState: "not_applied" | "unknown";
    currentVersion?: Version;
    /** On `request_capacity` only: which bound refused. */
    scope?: CapacityScope;
    /** On `request_capacity` only, when the host states it: when the bound admits writes again (ISO instant). */
    resetAt?: string;
  };
};
export type WriteResult = WriteSuccess | WriteFailure;

export class HostedAnswerError extends Error {
  override readonly name = "HostedAnswerError";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const DATA_KEYS = ["bundleId", "documentId", "version", "changed", "scope"] as const;
const DELETE_DATA_KEYS = [...DATA_KEYS, "deletedVersion", "deleted"] as const;
const ERROR_KEYS = ["code", "message", "retryable", "writeState", "currentVersion", "diagnostics", "fieldActionDetails", "candidate", "retentionUnavailable", "scope", "resetAt"] as const;

/**
 * A write operation's result envelope, admitted or refused as one: the operation it answers,
 * the document it names, and a success with a content version or a refusal with a known code
 * and write state. A refusal's detail blocks (diagnostics, corrective details) are carried but
 * not interpreted here. `write_outcome_unknown` must say its write state is unknown.
 */
export function parseWriteResult(raw: unknown, expected: { operationIds: readonly string[]; documentId: string; bundleId?: string }): WriteResult {
  const refuse = () => new HostedAnswerError("the write result envelope is not one the client admits");
  if (!isRecord(raw) || !onlyKeys(raw, ["ok", "operationId", "data", "error"]) || typeof raw.operationId !== "string" || !expected.operationIds.includes(raw.operationId)) throw refuse();
  const { operationId } = raw as { operationId: string };
  if (raw.ok === true) {
    const data = raw.data;
    // A delete's success, and only a delete's, names the version that left and says it left.
    const deletion = operationId === DELETE_OPERATION_ID;
    if (raw.error !== undefined || !isRecord(data) || !onlyKeys(data, deletion ? DELETE_DATA_KEYS : DATA_KEYS) || typeof data.bundleId !== "string" || data.bundleId.length === 0 ||
        data.documentId !== expected.documentId || (expected.bundleId !== undefined && data.bundleId !== expected.bundleId) ||
        !isContentVersion(data.version) || typeof data.changed !== "boolean" ||
        (deletion && (!isContentVersion(data.deletedVersion) || data.deleted !== true))) throw refuse();
    const accepted = data as WriteSuccess["data"];
    return { ok: true, operationId, data: { ...accepted } };
  }
  if (raw.ok !== false) throw refuse();
  const error = raw.error;
  if (raw.data !== undefined || !isRecord(error) || !onlyKeys(error, ERROR_KEYS) || !(WRITE_ERROR_CODES as readonly unknown[]).includes(error.code) ||
      typeof error.message !== "string" || error.retryable !== false || (error.writeState !== "not_applied" && error.writeState !== "unknown") ||
      (error.currentVersion !== undefined && !isContentVersion(error.currentVersion)) ||
      (error.code === "write_outcome_unknown" && error.writeState !== "unknown") ||
      (error.code === "request_capacity"
        ? (error.scope !== "principal" && error.scope !== "bundle") || error.writeState !== "not_applied" || (error.resetAt !== undefined && (typeof error.resetAt !== "string" || !Number.isFinite(Date.parse(error.resetAt))))
        : error.scope !== undefined || error.resetAt !== undefined)) throw refuse();
  return { ok: false, operationId, error: { ...(error as WriteFailure["error"]) } };
}

// ── classifying an identified-write answer ─────────────────────────────────────────────────

const rowsByAnswer = new Map(UPDATE_ANSWER_ROWS.map((row) => [row.answer, row]));

/** The row named `answer`; every name this module uses is in the table. */
export function updateRow(answer: string): UpdateAnswerRow {
  const row = rowsByAnswer.get(answer);
  if (!row) throw new RangeError(`no update answer row '${answer}'`);
  return row;
}

/** The row an identified-write answer falls under, and the validated envelope when it carries one. */
export function classifyWriteAnswer(
  answer: HostedAnswer,
  expected: { operationIds: readonly string[]; documentId: string; bundleId?: string },
): { row: UpdateAnswerRow; result?: WriteResult } {
  const { status, body } = answer;
  if (status === 200) {
    // The legacy denial is outside the canonical result schema, so it is read before it.
    const legacy = body as { ok?: unknown; error?: { code?: unknown } } | undefined;
    if (legacy?.ok === false && legacy.error?.code === "access_denied") return { row: updateRow("200 access_denied") };
    let result: WriteResult;
    try {
      result = parseWriteResult(body, expected);
    } catch {
      return { row: updateRow("200 other") };
    }
    if (result.ok) return { row: updateRow("200 ok"), result };
    return { row: rowsByAnswer.get(`200 ${result.error.code}`) ?? updateRow("200 other"), result };
  }
  if (status === 400) return { row: updateRow("400") };
  if (status === 401) {
    const error = (body as { error?: { code?: unknown; writeState?: unknown } } | undefined)?.error;
    if (error?.writeState === "not_applied") return { row: updateRow("401 not_applied") };
    if (error?.code === "write_outcome_unknown") return { row: updateRow("401 write_outcome_unknown") };
    return { row: updateRow("401 other") };
  }
  if (status === 403) return { row: updateRow("403") };
  if (status === 429) {
    const error = (body as { error?: unknown } | undefined)?.error;
    if (isRecord(error) && error.code === "request_capacity") {
      try {
        const result = parseWriteResult({ ok: false, operationId: expected.operationIds[0], error: { retryable: false, writeState: "not_applied", message: "", ...error } }, expected);
        return { row: updateRow("429 request_capacity"), result };
      } catch {
        return { row: updateRow("other status") };
      }
    }
    return { row: updateRow("other status") };
  }
  if (status === 503) return { row: updateRow("503") };
  return { row: updateRow("other status") };
}

// ── the outcome lookup answer ──────────────────────────────────────────────────────────────

/** Why an outcome lookup could not produce evidence; the primitive counts it as a failed lookup. */
export class HostedOutcomeError extends Error {
  override readonly name = "HostedOutcomeError";
  readonly reason: "refused" | "malformed" | "contradiction" | "unavailable";
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(reason: "refused" | "malformed" | "contradiction" | "unavailable", status?: number, code?: string) {
    super(status === undefined ? reason : `${reason}: ${status}${code ? ` ${code}` : ""}`);
    this.reason = reason;
    this.status = status;
    this.code = code;
  }
}

/** A decoded outcome answer: one of the four observations the route makes. */
export type OutcomeAnswer =
  | { status: "absent" }
  | { status: "pending" }
  /** `content` is the committed bytes; `null` for a delete alone, whose tombstone has no bytes. */
  | { status: "committed"; result: WriteSuccess; content: { version: Version; bytes: Uint8Array } | null }
  | { status: "refused"; result: WriteFailure };

/** An outcome answer carries the committed document's exact bytes under this bound. */
export const OUTCOME_CONTENT_BYTES = 1024 * 1024;

/** The bytes a canonical base64 string encodes, refused when it is not one or exceeds `maximum`. */
function decodeBase64(text: string, maximum: number): Uint8Array {
  if (text.length > 4 * Math.ceil(maximum / 3) || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw new HostedOutcomeError("malformed");
  const binary = atob(text);
  if (binary.length > maximum) throw new HostedOutcomeError("malformed");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The lookup route's `200` answer, admitted or refused as one: `schemaVersion` 1, the request
 * identity and binding it answers for, and one status. A committed answer carries the original
 * validated success and the committed document's exact bytes as base64 at the receipt's
 * version (a delete's carries none: a tombstone has no bytes); a refused answer carries the
 * original definitive failure. Anything else, including a
 * stored result whose write state is not definitive, is malformed evidence.
 */
export function decodeOutcomeAnswer(
  value: unknown,
  expected: { requestId: string; binding: string; bundleId: string; documentId: string; operationIds: readonly string[] },
): OutcomeAnswer {
  const malformed = () => new HostedOutcomeError("malformed");
  if (!isRecord(value)) throw malformed();
  const body = value;
  if (body.schemaVersion !== 1 || body.requestId !== expected.requestId || body.binding !== expected.binding) throw malformed();
  const result = (): WriteResult => {
    try {
      return parseWriteResult(body.result, { operationIds: expected.operationIds, documentId: expected.documentId, bundleId: expected.bundleId });
    } catch {
      throw malformed();
    }
  };
  const observation = body.status;
  if (observation === "absent" || observation === "pending") {
    if (body.result !== undefined || body.content !== undefined) throw malformed();
    return { status: observation };
  }
  switch (observation) {
    case "committed": {
      const parsed = result();
      // A committed delete carries the recorded result and no content: nothing it committed has bytes.
      if (parsed.ok && parsed.operationId === DELETE_OPERATION_ID) {
        if (body.content !== undefined) throw malformed();
        return { status: "committed", result: parsed, content: null };
      }
      const content = body.content as { encoding?: unknown; version?: unknown; bytes?: unknown } | undefined;
      if (!parsed.ok || !isRecord(content) || content.encoding !== "base64" || !isContentVersion(content.version) || typeof content.bytes !== "string") throw malformed();
      return { status: "committed", result: parsed, content: { version: content.version, bytes: decodeBase64(content.bytes, OUTCOME_CONTENT_BYTES) } };
    }
    case "refused": {
      const parsed = result();
      if (parsed.ok || parsed.error.writeState !== "not_applied" || body.content !== undefined) throw malformed();
      return { status: "refused", result: parsed };
    }
    default:
      throw malformed();
  }
}
