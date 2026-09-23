/**
 * The sync delivery side: an {@link OperationTransport} that pushes one whole document per
 * request. An intent with no base is a create (`documents.create.v1`, create-only); any other is
 * a replace (`documents.replace.v1`) against exactly the intent's base, so the host's
 * compare-and-swap decides every concurrent change to one document and never merges it. The
 * managed fields the host owns are stripped before sending; the host carries them from the
 * stored document.
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
  updateRow,
  UPDATE_ANSWER_ROWS,
  type AuthorizationCode,
  type WriteFailure,
} from "./answer-rows.js";
import { HostedCarrierError, type HostedAnswer, type HostedCarrier } from "./carrier.js";
import { OPERATIONS_RETENTION_SKEW_MS, type HostedReadAdapter } from "./read-adapter.js";

/** Frontmatter the host owns; no caller may set it, and the host carries it from the stored document. */
export const HOSTED_MANAGED_FIELDS: ReadonlySet<string> = new Set(["actor", "superbee_updated_by", "generated", "verified", "timestamp", "okf_version"]);

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
  outcome: string;
}

export const SYNC_WRITE_ROUTES: WholeDocumentRoutes = Object.freeze({
  create: "/sync/v1/create",
  replace: "/sync/v1/replace",
  outcome: "/sync/v1/outcome",
});

const OPERATION_IDS = { create: "documents.create.v1", replace: "documents.replace.v1" } as const;

/** The exact kernel input one intent becomes, and the route and operation it goes to. */
export type WholeDocumentRequest =
  | { kind: "create"; operationId: "documents.create.v1"; payload: { bundleId: string; documentId: string; expectAbsent: true; frontmatter: Frontmatter; body: string } }
  | { kind: "replace"; operationId: "documents.replace.v1"; payload: { bundleId: string; documentId: string; expectedVersion: Version; frontmatter: Frontmatter; body: string } };

/** An intent the transport will not send, and why: the answer a `refused` outcome carries. */
export class WholeDocumentInputError extends Error {
  override readonly name = "WholeDocumentInputError";
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
 * managed fields removed, create by `base === null`, else replace against `base`. A document
 * whose frontmatter is not plain JSON (a date object, say) is refused here, because sending it
 * would change what it says.
 */
export function wholeDocumentRequest(bundleId: string, intent: Pick<OperationIntent, "target" | "base" | "content">, okfVersion?: string): WholeDocumentRequest {
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
  const common = { bundleId, documentId: intent.target, frontmatter, body: parsed.body };
  return intent.base === null
    ? { kind: "create", operationId: OPERATION_IDS.create, payload: { bundleId, documentId: intent.target, expectAbsent: true, frontmatter, body: parsed.body } }
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

  async function servedHead(target: string): Promise<Outcome> {
    try {
      return { kind: "conflict", actual: (await remote.read(target)).version };
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === "ENOENT") return { kind: "conflict", actual: null };
      return UNKNOWN;
    }
  }

  /** A definitive recorded refusal, from the write answer or from the stored result a lookup returns. */
  function settleRecorded(intent: OperationIntent, failure: WriteFailure): Promise<Outcome> | Outcome {
    const { error } = failure;
    if (error.code === "document_exists" && intent.base === null) return servedHead(intent.target);
    if (error.code === "document_not_found") return { kind: "conflict", actual: null };
    if (error.code === "version_conflict") return error.currentVersion === undefined ? servedHead(intent.target) : { kind: "conflict", actual: error.currentVersion };
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

  async function lookupIntent(intent: OperationIntent): Promise<Outcome | null> {
    let request: WholeDocumentRequest;
    try {
      request = prepare(intent).request;
    } catch {
      throw new HostedOutcomeError("unavailable");
    }
    let answer: HostedAnswer;
    try {
      answer = await carrier.json(routes.outcome, request.payload, lifetime, { maximum: WHOLE_DOCUMENT_BOUNDS.outcomeAnswerBytes, writeRequest: intent.requestId, binding });
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
        return now() - Date.parse(intent.createdAt) > trusted ? UNKNOWN : null;
      }
      case "pending":
        return null;
      case "refused":
        return settleRecorded(intent, outcome.result);
      case "committed": {
        const { result, content } = outcome;
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
      return { kind: "refused", code: "invalid_input", message: `${(error as Error).message}; it was not sent.` };
    }
    const { request } = prepared;
    let answer: HostedAnswer;
    try {
      answer = await carrier.json(routes[request.kind], request.payload, requestSignal(submitOptions.signal), {
        maximum: WHOLE_DOCUMENT_BOUNDS.answerBytes,
        writeRequest: intent.requestId,
        binding,
      });
    } catch (error) {
      // A credential that was already gone sent nothing; anything else may have left.
      if (error instanceof HostedCarrierError && error.code === "denied") return denial("AUTH_REQUIRED", "No credential was available; the change was not sent.");
      return UNKNOWN;
    }
    const { row, result } = classifyWriteAnswer(answer, { operationIds: [request.operationId], documentId: intent.target, bundleId });
    if (result?.ok) return { kind: "committed", version: result.data.version };
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
        if ((result as WriteFailure).error.code === "document_exists" && intent.base === null) return servedHead(intent.target);
        return settled ? settleRecorded(intent, result as WriteFailure) : lookupRecorded();
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
