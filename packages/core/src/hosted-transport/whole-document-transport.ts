/**
 * The sync delivery side: an {@link OperationTransport} that pushes one whole document per
 * request. The intent's kind names the operation and its base must agree with it
 * ({@link WHOLE_DOCUMENT_INTENT_KINDS}): a create (`documents.create.v1`, create-only) has no
 * base, a replace (`documents.replace.v1`) is against exactly the intent's base, and a delete
 * (`documents.delete.v1`) removes the document at exactly the intent's base, so the host's
 * compare-and-swap decides every concurrent change to one document and never merges it. Any other
 * kind (a body update) or a kind its base contradicts is refused before anything is sent, and
 * never mapped to another operation. The managed fields the host owns are stripped before
 * sending; the host carries them from the stored document.
 *
 * A deleted document leaves a tombstone on the host. A create of that id is refused as a
 * `version_conflict` naming the tombstone unless it acknowledges exactly the id's latest one
 * (`X-Superbee-Recreate`), and the refusal comes back as the "deleted remotely" conflict carrying
 * the tombstone (`{ kind: "conflict", actual: null, tombstone }`). The acknowledgement is sent
 * only when the intent says so ({@link OperationIntent.recreates}); a stale one is refused again
 * and comes back as a fresh conflict naming the newer tombstone, never as last-writer-wins.
 *
 * Every answer is mapped by the shared rows in `answer-rows.ts`, with one difference a
 * create-only write needs: `document_exists` is a conflict against the served head, because a
 * create that finds the document is exactly a compare-and-swap mismatch on absence.
 *
 * The committed version comes from the host's recorded result, and the host stores its own
 * serialization (with managed fields), so a committed version is not the intent's `local`
 * version. Deliver with `settlement: "recorded-only"` ({@link WHOLE_DOCUMENT_SETTLEMENT}) so a
 * conflict is never read as a commit by comparing versions.
 *
 * `OperationTransport.lookup` names only a request identity, and the host's outcome route takes
 * the same body as the write it identifies, so the transport reads the intent back from the
 * journal (`intentFor`) to rebuild it.
 */

import { parseMarkdown } from "../frontmatter.js";
import type { Frontmatter, Version } from "../types.js";
import type { OperationIntent, OperationTransport, Outcome, UncertainWriteOptions } from "../uncertain-write.js";
import {
  classifyWriteAnswer,
  decodeOutcomeAnswer,
  HostedOutcomeError,
  CAPACITY_REFUSAL_CODES,
  updateRow,
  UPDATE_ANSWER_ROWS,
  type AuthorizationCode,
  type WriteFailure,
} from "./answer-rows.js";
import { DELETE_OPERATION_ID } from "./answer-rows.js";
import { HostedCarrierError, type HostedAnswer, type HostedCarrier, type HostedRequestOptions } from "./carrier.js";
import { isContentVersion } from "../version-transport.js";
import { OPERATIONS_RETENTION_SKEW_MS, type HostedReadAdapter } from "./read-adapter.js";

/** Frontmatter the host owns; no caller may set it, and the host carries it from the stored document. */
export const HOSTED_MANAGED_FIELDS: ReadonlySet<string> = new Set(["actor", "superbee_updated_by", "generated", "verified", "timestamp", "okf_version"]);

/** The most frontmatter fields the kernel accepts on a create or replace. */
export const FRONTMATTER_KEY_LIMIT = 32;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The settlement mode a whole-document delivery must use. */
export const WHOLE_DOCUMENT_SETTLEMENT: NonNullable<UncertainWriteOptions["settlement"]> = "recorded-only";

export const WHOLE_DOCUMENT_BOUNDS = Object.freeze({
  /** The write routes' request ceiling; a larger payload is refused here before it leaves. */
  payloadBytes: 65536,
  /** A write answer is a bounded result envelope. */
  answerBytes: 65536,
  /** An outcome answer carries the committed document as base64 under this envelope ceiling. */
  outcomeAnswerBytes: 2 * 1024 * 1024,
});

export interface WholeDocumentRoutes {
  create: string;
  replace: string;
  delete: string;
  outcome: string;
}

export const SYNC_WRITE_ROUTES: WholeDocumentRoutes = Object.freeze({
  create: "/sync/v1/create",
  replace: "/sync/v1/replace",
  delete: "/sync/v1/delete",
  outcome: "/sync/v1/outcome",
});

const OPERATION_IDS = { create: "documents.create.v1", replace: "documents.replace.v1", delete: DELETE_OPERATION_ID } as const;

/**
 * The exact kernel input one intent becomes, and the route and operation it goes to. A create
 * that re-creates a deleted document carries the tombstone it acknowledges in `recreates`, which
 * rides the `X-Superbee-Recreate` header, never the body.
 */
export type WholeDocumentRequest =
  | { kind: "create"; operationId: "documents.create.v1"; payload: { bundleId: string; documentId: string; expectAbsent: true; frontmatter: Frontmatter; body: string }; recreates?: Version }
  | { kind: "replace"; operationId: "documents.replace.v1"; payload: { bundleId: string; documentId: string; expectedVersion: Version; frontmatter: Frontmatter; body: string } }
  | { kind: "delete"; operationId: typeof DELETE_OPERATION_ID; payload: { bundleId: string; documentId: string; expectedVersion: Version } };

/**
 * The intent kinds this transport sends, each with the base it requires. `document.write` is the
 * working-copy engine's whole-document write, a create exactly when it has no base.
 * `document.delete` removes the document at exactly its base, so it requires one. Every other
 * kind is unsupported: it is refused without sending, never routed by its base.
 */
export const WHOLE_DOCUMENT_INTENT_KINDS: Readonly<Record<string, "create" | "replace" | "delete" | "by-base">> = Object.freeze({
  "document.create": "create",
  "document.replace": "replace",
  "document.delete": "delete",
  "document.write": "by-base",
});

/**
 * An intent the transport will not send, and why: the answer a `refused` outcome carries.
 * `unsupported_operation` is an intent kind this transport does not send, or one its base
 * contradicts; `invalid_input` is a document the host would refuse.
 */
export class WholeDocumentInputError extends Error {
  override readonly name = "WholeDocumentInputError";
  readonly code: "invalid_input" | "unsupported_operation";
  constructor(message: string, code: "invalid_input" | "unsupported_operation" = "invalid_input") {
    super(message);
    this.code = code;
  }
}

/**
 * The operation an intent's kind names, refused when the kind is unsupported, its base
 * disagrees, or it carries a re-create acknowledgement that is not a create's.
 */
function operationOf(intent: Pick<OperationIntent, "kind" | "target" | "base" | "recreates">): "create" | "replace" | "delete" {
  const declared = Object.hasOwn(WHOLE_DOCUMENT_INTENT_KINDS, intent.kind) ? WHOLE_DOCUMENT_INTENT_KINDS[intent.kind] : undefined;
  if (declared === undefined) throw new WholeDocumentInputError(`'${intent.target}' is a '${intent.kind}' intent, which this transport does not send`, "unsupported_operation");
  const byBase = intent.base === null ? "create" : "replace";
  const operation = declared === "by-base" ? byBase : declared;
  if ((operation === "delete" && intent.base === null) || (operation !== "delete" && operation !== byBase))
    throw new WholeDocumentInputError(`'${intent.target}' is a '${intent.kind}' intent that ${intent.base === null ? "has no base" : "has a base"}`, "unsupported_operation");
  if (intent.recreates !== undefined) {
    if (operation !== "create") throw new WholeDocumentInputError(`'${intent.target}' acknowledges a deletion, which only a create re-creating it may`, "unsupported_operation");
    if (!isContentVersion(intent.recreates)) throw new WholeDocumentInputError(`'${intent.target}' acknowledges a deletion that is not a version`);
  }
  return operation;
}

function jsonPure(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonPure);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as object).every(jsonPure);
  return false;
}

/**
 * The request an intent becomes: the serialized document parsed under the bundle's edition,
 * managed fields removed, a create or a replace against `base` as its kind names. The kind is
 * checked first, so an unsupported kind is refused before its content is read. A document
 * whose frontmatter is not plain JSON (a date object, say) is refused here, because sending it
 * would change what it says.
 */
export function wholeDocumentRequest(bundleId: string, intent: Pick<OperationIntent, "kind" | "target" | "base" | "content" | "recreates">, okfVersion?: string): WholeDocumentRequest {
  const operation = operationOf(intent);
  // A delete names the version that leaves and nothing else: its content is never read or sent.
  if (operation === "delete") return { kind: "delete", operationId: OPERATION_IDS.delete, payload: { bundleId, documentId: intent.target, expectedVersion: intent.base! } };
  let parsed: { frontmatter: Frontmatter; body: string };
  try {
    parsed = parseMarkdown(intent.content, intent.target, { okfVersion });
  } catch (error) {
    throw new WholeDocumentInputError(`'${intent.target}' does not parse: ${(error as Error).message}`);
  }
  const frontmatter: Frontmatter = {} as Frontmatter;
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (!HOSTED_MANAGED_FIELDS.has(key)) (frontmatter as Record<string, unknown>)[key] = value;
  }
  if (!jsonPure(frontmatter)) throw new WholeDocumentInputError(`'${intent.target}' has frontmatter that is not plain JSON`);
  // The kernel's input schema bounds, checked here so a document it would refuse is refused
  // before it leaves rather than answered and looked up.
  const keys = Object.keys(frontmatter);
  if (keys.length > FRONTMATTER_KEY_LIMIT) throw new WholeDocumentInputError(`'${intent.target}' has ${keys.length} frontmatter fields; at most ${FRONTMATTER_KEY_LIMIT} are accepted`);
  if (typeof frontmatter.type !== "string" || frontmatter.type.trim() === "") throw new WholeDocumentInputError(`'${intent.target}' has no type`);
  if (keys.some((key) => UNSAFE_KEYS.has(key))) throw new WholeDocumentInputError(`'${intent.target}' names a reserved object key in its frontmatter`);
  const common = { bundleId, documentId: intent.target, frontmatter, body: parsed.body };
  // `operationOf` has already bound the operation to the base: a create has none, a replace has one.
  return operation === "create" || intent.base === null
    ? {
        kind: "create",
        operationId: OPERATION_IDS.create,
        payload: { bundleId, documentId: intent.target, expectAbsent: true, frontmatter, body: parsed.body },
        ...(intent.recreates !== undefined ? { recreates: intent.recreates } : {}),
      }
    : { kind: "replace", operationId: OPERATION_IDS.replace, payload: { ...common, expectedVersion: intent.base } };
}

export interface WholeDocumentTransportOptions {
  carrier: HostedCarrier;
  bundleId: string;
  /** The checkout's binding, pinned on every write and lookup; the outcome answer must name it. */
  binding: string;
  /** The intent a request identity names, from the journal; the lookup rebuilds its request from it. */
  intentFor(requestId: string): Promise<OperationIntent | undefined>;
  /** The served head after a conflict without a current version, and the retention window. */
  remote: Pick<HostedReadAdapter, "read" | "operationsRetentionMs">;
  routes?: WholeDocumentRoutes;
  /** The bundle's edition, for parsing an intent's serialized frontmatter. */
  okfVersion?: string;
  /** Ends every request in flight. */
  signal?: AbortSignal;
  now?: () => number;
}

const UNKNOWN: Outcome = Object.freeze({ kind: "unknown" });
const encoder = new TextEncoder();

export function createWholeDocumentTransport(options: WholeDocumentTransportOptions): OperationTransport & { readonly settlement: typeof WHOLE_DOCUMENT_SETTLEMENT } {
  const { carrier, bundleId, binding, remote } = options;
  const routes = options.routes ?? SYNC_WRITE_ROUTES;
  const now = options.now ?? Date.now;
  const lifetime = options.signal ?? new AbortController().signal;
  const requestSignal = (signal?: AbortSignal) => (signal ? AbortSignal.any([lifetime, signal]) : lifetime);
  const denial = (code: AuthorizationCode, message: string): Outcome => ({ kind: "refused", code, message });

  /**
   * The served head as the conflict a refusal stands for. Absent, it is a conflict against no
   * document ("deleted remotely"), carrying `tombstone` when the refusal named one; except for a
   * create that found the document (`absentIs: "unknown"`): its follow-up read finding none raced
   * a deletion, there is no concurrent content to conflict with, so the outcome is unknown and the
   * next push looks the identity up and, finding it absent, creates again.
   */
  async function servedHead(intent: OperationIntent, absentIs: "conflict" | "unknown" = intent.base === null ? "unknown" : "conflict", tombstone?: Version): Promise<Outcome> {
    try {
      return { kind: "conflict", actual: (await remote.read(intent.target)).version };
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === "ENOENT")
        return absentIs === "unknown" ? UNKNOWN : { kind: "conflict", actual: null, ...(tombstone !== undefined ? { tombstone } : {}) };
      return UNKNOWN;
    }
  }

  /** The sync quota, as the pausing refusal its scope names. */
  function capacity(error: WriteFailure["error"]): Outcome {
    const scope = error.scope ?? "bundle";
    const reset = error.resetAt ? ` It resets at ${error.resetAt}.` : "";
    const whose = scope === "principal" ? "Your sync quota for this bundle is used up." : "This bundle's sync capacity is used up.";
    return { kind: "refused", code: CAPACITY_REFUSAL_CODES[scope], message: `${whose}${reset} Nothing was written; sync resumes when it resets.` };
  }

  /** A definitive recorded refusal, from the write answer or from the stored result a lookup returns. */
  function settleRecorded(intent: OperationIntent, failure: WriteFailure): Promise<Outcome> | Outcome {
    const { error } = failure;
    if (error.code === "request_capacity") return capacity(error);
    if (error.code === "document_exists" && intent.base === null) return servedHead(intent);
    if (error.code === "document_not_found") return { kind: "conflict", actual: null };
    // A create's version conflict may name a tombstone, which no read serves, so it is never
    // trusted as a remote version: the served head decides. An absent head is a conflict against
    // no document ("deleted remotely") that carries the tombstone for a deliberate re-create,
    // never unknown, or the identity would loop between lookup and resubmission. A re-create
    // whose acknowledgement went stale (another deletion since) lands here too, naming the newer
    // tombstone: a conflict again, never a silent overwrite.
    if (error.code === "version_conflict" && intent.base === null) return servedHead(intent, "conflict", error.currentVersion);
    if (error.code === "version_conflict") return error.currentVersion === undefined ? servedHead(intent) : { kind: "conflict", actual: error.currentVersion };
    const row = UPDATE_ANSWER_ROWS.find((candidate) => candidate.answer === `200 ${error.code}`) ?? updateRow("200 other");
    return row.code ? denial(row.code, error.message) : { kind: "refused", code: error.code, message: error.message };
  }

  function prepare(intent: OperationIntent): { request: WholeDocumentRequest; body: string } {
    const request = wholeDocumentRequest(bundleId, intent, options.okfVersion);
    const body = JSON.stringify(request.payload);
    if (encoder.encode(body).byteLength > WHOLE_DOCUMENT_BOUNDS.payloadBytes)
      throw new WholeDocumentInputError(`the document exceeds ${WHOLE_DOCUMENT_BOUNDS.payloadBytes} bytes as a request`);
    return { request, body };
  }

  /** The identity headers of a write and of its lookup: the same, including a create's acknowledgement. */
  function identity(intent: OperationIntent, request: WholeDocumentRequest, maximum: number): HostedRequestOptions {
    return { maximum, writeRequest: intent.requestId, binding, ...(request.kind === "create" && request.recreates !== undefined ? { recreate: request.recreates } : {}) };
  }

  /**
   * A delete whose identity the host no longer holds (absent past retention) is settled by
   * reading the document back (review S5): absent, it is settled as removed with no tombstone
   * known (committed at the intent's own `local`, the deletion version); present at any version,
   * even the one it was deleted at (a same-bytes re-create), it is a conflict, never resent.
   */
  async function deleteReadBack(intent: OperationIntent): Promise<Outcome> {
    try {
      return { kind: "conflict", actual: (await remote.read(intent.target)).version };
    } catch (error) {
      return (error as { code?: unknown } | undefined)?.code === "ENOENT" ? { kind: "committed", version: intent.local } : UNKNOWN;
    }
  }

  async function lookupIntent(intent: OperationIntent): Promise<Outcome | null> {
    let request: WholeDocumentRequest;
    try {
      request = prepare(intent).request;
    } catch {
      throw new HostedOutcomeError("unavailable");
    }
    let answer: HostedAnswer;
    try {
      answer = await carrier.json(routes.outcome, request.payload, lifetime, identity(intent, request, WHOLE_DOCUMENT_BOUNDS.outcomeAnswerBytes));
    } catch {
      throw new HostedOutcomeError("unavailable");
    }
    if (answer.status !== 200) {
      const code = (answer.body as { error?: { code?: unknown } } | undefined)?.error?.code;
      throw new HostedOutcomeError("refused", answer.status, typeof code === "string" ? code : undefined);
    }
    const outcome = decodeOutcomeAnswer(answer.body, { requestId: intent.requestId, binding, bundleId, documentId: intent.target, operationIds: [request.operationId] });
    switch (outcome.status) {
      case "absent": {
        // An identity the host already expired looks absent too; past the window, less the skew
        // margin, absence is no longer evidence that the request never arrived.
        const trusted = (await remote.operationsRetentionMs()) - OPERATIONS_RETENTION_SKEW_MS;
        if (now() - Date.parse(intent.createdAt) <= trusted) return null;
        return request.kind === "delete" ? deleteReadBack(intent) : UNKNOWN;
      }
      case "pending":
        return null;
      case "refused":
        return settleRecorded(intent, outcome.result);
      case "committed": {
        const { result, content } = outcome;
        if (request.kind === "delete") {
          // The recorded delete must be of exactly this base; `changed` is the host's
          // classification (false: it had already left at this base) and either is a commit.
          if (content !== null || result.data.deletedVersion !== intent.base) throw new HostedOutcomeError("contradiction");
          return { kind: "committed", version: result.data.version };
        }
        if (content === null) throw new HostedOutcomeError("contradiction");
        const changed = intent.base === null || intent.base !== content.version;
        if (result.data.version !== content.version || result.data.changed !== changed) throw new HostedOutcomeError("contradiction");
        return { kind: "committed", version: content.version };
      }
    }
  }

  async function submit(intent: OperationIntent, submitOptions: { signal?: AbortSignal } = {}): Promise<Outcome> {
    let prepared: { request: WholeDocumentRequest; body: string };
    try {
      prepared = prepare(intent);
    } catch (error) {
      const code = error instanceof WholeDocumentInputError ? error.code : "invalid_input";
      return { kind: "refused", code, message: `${(error as Error).message}; it was not sent.` };
    }
    const { request } = prepared;
    let answer: HostedAnswer;
    try {
      answer = await carrier.json(routes[request.kind], request.payload, requestSignal(submitOptions.signal), identity(intent, request, WHOLE_DOCUMENT_BOUNDS.answerBytes));
    } catch (error) {
      // A credential that was already gone sent nothing; anything else may have left.
      if (error instanceof HostedCarrierError && error.code === "denied") return denial("AUTH_REQUIRED", "No credential was available; the change was not sent.");
      return UNKNOWN;
    }
    const { row, result } = classifyWriteAnswer(answer, { operationIds: [request.operationId], documentId: intent.target, bundleId });
    // A delete's success, `changed` or not, is the document gone at exactly this base, and its
    // version is the tombstone. One naming another base is not evidence about this request.
    if (result?.ok && request.kind === "delete" && result.data.deletedVersion !== intent.base) return UNKNOWN;
    if (result?.ok) return { kind: "committed", version: result.data.version };
    if (result && !result.ok && result.error.code === "request_capacity") return capacity(result.error);
    // The carrier refuses a malformed identity or binding before sending, so a 400 here, and any
    // invalid_input, is the host's schema refusing this exact document. That is deterministic:
    // resending or looking it up again can only repeat it, so it is a terminal refusal.
    if (row.answer === "400") {
      const code = (answer.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      return { kind: "refused", code: typeof code?.code === "string" ? code.code : "invalid_input", message: typeof code?.message === "string" ? code.message : "The host refused the request as malformed; nothing was written." };
    }
    if (result && !result.ok && result.error.code === "invalid_input") return { kind: "refused", code: "invalid_input", message: result.error.message };
    const settled = answer.headers.get("X-Superbee-Write-Settled") === intent.requestId;
    const lookupRecorded = async (): Promise<Outcome> => {
      try {
        return (await lookupIntent(intent)) ?? UNKNOWN;
      } catch {
        return UNKNOWN;
      }
    };
    switch (row.recorded) {
      case "yes":
        return settleRecorded(intent, result as WriteFailure);
      case "settled-only":
        // A create-only write that found the document is a conflict whether or not it was recorded.
        if ((result as WriteFailure).error.code === "document_exists" && intent.base === null) return servedHead(intent);
        // The header says the answer is recorded, not that the write never applied: a refusal
        // settles here only when it also says `not_applied`, as a recorded one must on lookup.
        return settled && (result as WriteFailure).error.writeState === "not_applied" ? settleRecorded(intent, result as WriteFailure) : lookupRecorded();
      case "no":
        return row.code ? denial(row.code, result?.ok === false ? result.error.message : "The host refused the request before dispatch.") : UNKNOWN;
      default:
        return row.code ? denial(row.code, "The host denied the request.") : UNKNOWN;
    }
  }

  return {
    settlement: WHOLE_DOCUMENT_SETTLEMENT,
    submit,
    async lookup(requestId: string): Promise<Outcome | null> {
      const intent = await options.intentFor(requestId);
      if (!intent) throw new HostedOutcomeError("unavailable");
      return lookupIntent(intent);
    },
  };
}
