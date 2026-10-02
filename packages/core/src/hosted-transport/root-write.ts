/**
 * The bundle's front page: one write that replaces the root `index.md` (`bundles.root.replace.v1`,
 * `POST <sync prefix>/root`), compare-and-swap on the root's version or on its absence.
 *
 * It is not an identified write. It carries no `X-Superbee-Write-Request`, the host keeps no
 * receipt of it, and there is no outcome lookup. A root version is the SHA-256 of its exact UTF-8
 * bytes, so a client that lost the answer re-reads the root's version from the capabilities answer
 * instead ({@link rootLanding}): the digest of what it sent means the write landed, its base means
 * it did not, and anything else is a conflict. The window this leaves (the root returning to the
 * same old bytes in between) is accepted for a front page.
 *
 * The refusal envelope is the write schema's, read by the same parser as a document write's; only
 * the success differs, since it names the bundle and no document.
 */

import { sha256HexOfUtf8 } from "../sha256.js";
import { isContentVersion } from "../version-transport.js";
import { parseWriteResult, updateRow, type AuthorizationCode } from "./answer-rows.js";
import { HostedCarrierError, isAgentLabelVia, type HostedAnswer, type HostedCarrier } from "./carrier.js";
import { WHOLE_DOCUMENT_BOUNDS } from "./whole-document-transport.js";

export const ROOT_OPERATION_ID = "bundles.root.replace.v1";

/** What a capabilities answer says about replacing the bundle's root `index.md`; absent reads as `"refused"`. */
export type HostedRootWrites = "allowed" | "refused";

export const ROOT_WRITE_BOUNDS = Object.freeze({
  /** The request ceiling, measured on the encoded JSON body: the same bound as every sync write. */
  payloadBytes: WHOLE_DOCUMENT_BOUNDS.payloadBytes,
  /** The answer is a bounded result envelope. */
  answerBytes: WHOLE_DOCUMENT_BOUNDS.answerBytes,
});

/** The root's version as the host computes it: `sha256:` and the hex SHA-256 of the UTF-8 bytes. */
export function rootVersionOf(content: string): string {
  return `sha256:${sha256HexOfUtf8(content)}`;
}

/** The body one root write sends: against `expectedVersion`, or creating a root that is absent. */
export type RootWritePayload =
  | { readonly bundleId: string; readonly content: string; readonly expectedVersion: string }
  | { readonly bundleId: string; readonly content: string; readonly expectAbsent: true };

/** A root the transport will not send, and why: over the request bound, or content the host refuses outright. */
export class RootWriteInputError extends Error {
  override readonly name = "RootWriteInputError";
  readonly code: "too_large" | "invalid_input";
  constructor(code: "too_large" | "invalid_input", message: string) {
    super(message);
    this.code = code;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const encoder = new TextEncoder();

/**
 * The request a root write sends, and its encoded body, refused before anything leaves when the
 * host could only refuse it: a leading byte-order mark or text that is not well formed (the host's
 * version and the client's digest of it could then differ), or a body over the request bound.
 */
export function rootWriteRequest(bundleId: string, content: string, base: string | null): { payload: RootWritePayload; body: string; bytes: number } {
  if (base !== null && !isContentVersion(base)) throw new RootWriteInputError("invalid_input", "the root's base is not a version");
  if (content.startsWith("﻿")) throw new RootWriteInputError("invalid_input", "the root index starts with a byte-order mark, which the host refuses");
  if (LONE_SURROGATE.test(content)) throw new RootWriteInputError("invalid_input", "the root index is not well-formed text");
  const payload: RootWritePayload = base === null ? { bundleId, content, expectAbsent: true } : { bundleId, content, expectedVersion: base };
  const body = JSON.stringify(payload);
  const bytes = encoder.encode(body).byteLength;
  if (bytes > ROOT_WRITE_BOUNDS.payloadBytes) throw new RootWriteInputError("too_large", `the root index is over the ${ROOT_WRITE_BOUNDS.payloadBytes / 1024} KiB a sync write carries (${bytes} bytes as a request)`);
  return { payload, body, bytes };
}

/**
 * One root write's outcome. `committed` names the version stored (the digest of the bytes sent).
 * `conflict` is a stale base (`version_conflict`, or `document_exists` for a create that found a
 * root), with the host's version when it said. `refused` applied nothing and is final;
 * `authorization` is set when the refusal is about the caller, not the content. `unknown` may
 * have landed: resolve it with {@link rootLanding}.
 */
export type RootWriteOutcome =
  | { readonly kind: "committed"; readonly version: string; readonly changed: boolean }
  | { readonly kind: "conflict"; readonly current?: string }
  | { readonly kind: "refused"; readonly code: string; readonly message: string; readonly authorization?: AuthorizationCode }
  | { readonly kind: "unknown" };

const UNKNOWN: RootWriteOutcome = Object.freeze({ kind: "unknown" });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A root write's `200` success, admitted only for this bundle, a content version and a boolean `changed`. */
function rootSuccess(body: unknown, bundleId: string): { version: string; changed: boolean } | null {
  if (!isRecord(body) || body.ok !== true || body.operationId !== ROOT_OPERATION_ID || body.error !== undefined) return null;
  const data = body.data;
  if (!isRecord(data) || !Object.keys(data).every((key) => key === "bundleId" || key === "version" || key === "changed")) return null;
  if (data.bundleId !== bundleId || !isContentVersion(data.version) || typeof data.changed !== "boolean") return null;
  return { version: data.version, changed: data.changed };
}

/** The authorization code the identified writes' row for a `200` refusal carries, if any. */
function authorizationOf(code: string): AuthorizationCode | undefined {
  try {
    return updateRow(`200 ${code}`).code;
  } catch {
    return undefined;
  }
}

/**
 * The outcome one root write's answer stands for. The refusal rows are the identified writes'
 * ({@link updateRow}), read without an identity: a refusal that says `not_applied` is final, and
 * anything the host may have applied without saying so is unknown.
 */
export function classifyRootAnswer(answer: Pick<HostedAnswer, "status" | "body">, expected: { bundleId: string; sent: string }): RootWriteOutcome {
  const { status, body } = answer;
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const notApplied = error?.writeState === "not_applied";
  if (status === 200) {
    if (isRecord(body) && body.ok === true) {
      const success = rootSuccess(body, expected.bundleId);
      // A success naming other bytes than those sent is not evidence about this request.
      return success && success.version === expected.sent ? { kind: "committed", ...success } : UNKNOWN;
    }
    let failure;
    try {
      failure = parseWriteResult(body, { operationIds: [ROOT_OPERATION_ID], documentId: "index.md", bundleId: expected.bundleId });
    } catch {
      return UNKNOWN;
    }
    if (failure.ok || failure.error.writeState !== "not_applied") return UNKNOWN;
    const { code, message, currentVersion } = failure.error;
    if (code === "version_conflict" || code === "document_exists") return { kind: "conflict", ...(currentVersion !== undefined ? { current: currentVersion } : {}) };
    const authorization = authorizationOf(code);
    return { kind: "refused", code, message, ...(authorization ? { authorization } : {}) };
  }
  // A malformed binding or body: the host read nothing, and the same request can only repeat it.
  if (status === 400) return { kind: "refused", code: typeof error?.code === "string" ? error.code : "invalid_input", message: typeof error?.message === "string" ? error.message : "The host refused the request as malformed; nothing was written." };
  if (status === 401) return notApplied ? { kind: "refused", code: "AUTH_REQUIRED", message: "The hosted session ended; the front page was not sent.", authorization: "AUTH_REQUIRED" } : UNKNOWN;
  if (status === 403) return { kind: "refused", code: "PERMISSION_DENIED", message: "The host denied access to this bundle.", authorization: "PERMISSION_DENIED" };
  if (status === 503 && notApplied) return { kind: "refused", code: typeof error?.code === "string" ? error.code : "backend_unavailable", message: typeof error?.message === "string" ? error.message : "The host was unavailable; nothing was written." };
  return UNKNOWN;
}

/** The refusal codes of a root write that say only that the host was busy: the next sync sends it again. */
export const ROOT_BUSY_CODES: ReadonlySet<string> = new Set(["backend_unavailable", "concurrent_change", "internal_error", "deadline_exceeded", "cancelled"]);

export interface RootWriteOptions {
  carrier: HostedCarrier;
  /** The root route, e.g. `/sync/v1/root`. */
  route: string;
  bundleId: string;
  /** The checkout's binding (`X-Superbee-Checkout`). */
  binding: string;
  /** The agent the client runs under (`X-Superbee-Via`); a token {@link isAgentLabelVia} admits. */
  via?: string;
  content: string;
  /** The root version the content replaces, or null to create a root the bundle lacks. */
  base: string | null;
  signal?: AbortSignal;
}

/**
 * Send one root write and classify its answer. Content the host would refuse outright is refused
 * here without sending ({@link rootWriteRequest}). Never sends a request identity.
 */
export async function sendRootWrite(options: RootWriteOptions): Promise<RootWriteOutcome> {
  if (options.via !== undefined && !isAgentLabelVia(options.via)) throw new TypeError("the via token is not one the host admits");
  let request;
  try {
    request = rootWriteRequest(options.bundleId, options.content, options.base);
  } catch (error) {
    if (error instanceof RootWriteInputError) return { kind: "refused", code: error.code, message: `${error.message}; it was not sent.` };
    throw error;
  }
  let answer: HostedAnswer;
  try {
    answer = await options.carrier.json(options.route, request.payload, options.signal ?? new AbortController().signal, {
      maximum: ROOT_WRITE_BOUNDS.answerBytes,
      binding: options.binding,
      ...(options.via !== undefined ? { via: options.via } : {}),
    });
  } catch (error) {
    // A credential that was already gone sent nothing; anything else may have left.
    if (error instanceof HostedCarrierError && error.code === "denied") return { kind: "refused", code: "AUTH_REQUIRED", message: "No credential was available; the front page was not sent.", authorization: "AUTH_REQUIRED" };
    return UNKNOWN;
  }
  return classifyRootAnswer(answer, { bundleId: options.bundleId, sent: rootVersionOf(options.content) });
}

/**
 * Whether a root write whose answer was lost landed, from the root version the host serves now
 * (`null`: no root): the digest of the bytes sent means it landed, its base means it did not, and
 * anything else is a conflict (another write moved the root).
 */
export function rootLanding(current: string | null, sent: string, base: string | null): "landed" | "not_landed" | "conflict" {
  if (current === sent) return "landed";
  if (current === base) return "not_landed";
  return "conflict";
}
