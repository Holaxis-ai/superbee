// A registered View's page (its `entry`, under `views/`) read and replaced whole on a hosted bundle:
// `<prefix>/view-content-read` (`views.content.read.v1`) and `<prefix>/view-content-update`
// (`views.content.update.v1`). Both are pinned to the registration's version, and an update to the
// page's own version as well, so neither reads or replaces a page the caller did not look at.
//
// A page's version is `sha256:<hex>` of its exact UTF-8 bytes (`blobVersion`), the same digest a
// Portal site pins as `entrySha256`. Every answer is checked against the bytes it describes (a
// read's html against its version and byte count, an update's version against the html sent), so
// a stored page is never reported under a version it does not have. Uploading never approves
// execution: that stays a separate act (a hosted app slot's approval, a site's pin).
import { isAnyEntryKey, isAnyRegistryId } from "../page.js";
import { malformed } from "../remote-error.js";
import { sha256HexOfBytes } from "../sha256.js";
import { REFUSAL_CODE } from "../hosted-transport/index.js";
import { stripHostText } from "../host-text.js";

export const VIEW_CONTENT_READ_OPERATION = "views.content.read.v1";
export const VIEW_CONTENT_UPDATE_OPERATION = "views.content.update.v1";

/** The largest page an update sends: 512 KiB of UTF-8, the host's bound. */
export const VIEW_CONTENT_MAX_BYTES = 512 * 1024;

/** A read's answer: the page and its envelope, at most the page's bound as JSON (escapes included) plus slack. */
export const VIEW_CONTENT_READ_ANSWER_BYTES = 6 * VIEW_CONTENT_MAX_BYTES + 64 * 1024;
/** An update's answer carries no html. */
export const VIEW_CONTENT_UPDATE_ANSWER_BYTES = 64 * 1024;

const VERSION = /^sha256:[0-9a-f]{64}$/;
const REQUEST_ID = /^[\x21-\x7e]{1,256}$/;
const CONTENT_TYPE = /^[\x20-\x7e]{1,256}$/;
const REFUSAL_MESSAGE_CHARS = 500;

/** True for a version token in the content-version grammar (`sha256:` and 64 lowercase hex digits). */
export function isViewContentVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** The version of a page's exact UTF-8 bytes. */
export function viewContentVersion(bytes: Uint8Array): string {
  return `sha256:${sha256HexOfBytes(bytes)}`;
}

export interface HostedViewContentReadRequest {
  /** The View registration's id (`views-registry/...`). */
  readonly registryId: string;
  /** The registration's version the caller read; the host refuses any other (`version_conflict`, target `registry`). */
  readonly expectedRegistryVersion: string;
}

export interface HostedViewContentUpdateRequest extends HostedViewContentReadRequest {
  /** The page's version the update replaces; the host refuses any other (`version_conflict`, target `content`). */
  readonly expectedContentVersion: string;
  /** The whole page, at most {@link VIEW_CONTENT_MAX_BYTES} of UTF-8. A leading U+FEFF is part of it. */
  readonly html: string;
}

export interface HostedViewContent {
  readonly bundleId: string;
  readonly registryId: string;
  readonly registryVersion: string;
  /** The page's key, the registration's `entry`. */
  readonly key: string;
  readonly version: string;
  readonly contentType: string;
  readonly byteCount: number;
  /** The page's exact decoded text; a leading BOM is kept as U+FEFF. */
  readonly html: string;
}

export interface HostedViewContentUpdate {
  readonly bundleId: string;
  readonly registryId: string;
  readonly registryVersion: string;
  readonly key: string;
  /** False when the page already held exactly these bytes. */
  readonly changed: boolean;
  readonly version: string;
  readonly previousVersion: string;
  readonly byteCount: number;
  readonly contentType: string;
  readonly requestId: string;
}

/**
 * The host's refusal, as its envelope says. `writeState` is `not_applied` when the host says
 * nothing changed, and `unknown` when it cannot say (or did not say, for an update). `status` is
 * the HTTP status, or 0 when no answer was read at all (the request may have left).
 */
export interface HostedViewContentRefusal {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly writeState: "not_applied" | "unknown";
  readonly retryable: boolean;
  /** For `version_conflict`: which pin did not hold. */
  readonly target?: "registry" | "content";
  readonly expected?: string | null;
  readonly actual?: string | null;
}

export type HostedViewContentReadResult = { readonly ok: true; readonly content: HostedViewContent } | { readonly ok: false; readonly refusal: HostedViewContentRefusal };
export type HostedViewContentUpdateResult = { readonly ok: true; readonly update: HostedViewContentUpdate } | { readonly ok: false; readonly refusal: HostedViewContentRefusal };

/** The refusal an update reports when it sent its request and read no answer it could trust. */
export const WRITE_OUTCOME_UNKNOWN = "write_outcome_unknown";

/** An update whose outcome is not known: the request may have left and been applied. */
export function unknownOutcome(status: number, message: string): HostedViewContentRefusal {
  return Object.freeze({ code: WRITE_OUTCOME_UNKNOWN, status, message, writeState: "unknown", retryable: false });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A request's fields, refused before sending when they are not what the host admits. */
export function viewContentReadBody(bundleId: string, request: HostedViewContentReadRequest): Record<string, unknown> {
  if (!isAnyRegistryId(request.registryId)) throw new RangeError("a View content request names a View registration id (views-registry/...)");
  if (!isViewContentVersion(request.expectedRegistryVersion)) throw new RangeError("a View content request pins the registration's sha256 version");
  return { bundleId, registryId: request.registryId, expectedRegistryVersion: request.expectedRegistryVersion };
}

/** An update's fields and the exact bytes it sends, refused before sending as the read's are, and when the page is over its bound. */
export function viewContentUpdateBody(bundleId: string, request: HostedViewContentUpdateRequest): { body: Record<string, unknown>; bytes: Uint8Array } {
  const read = viewContentReadBody(bundleId, request);
  if (!isViewContentVersion(request.expectedContentVersion)) throw new RangeError("a View content update pins the page's sha256 version");
  if (typeof request.html !== "string") throw new TypeError("a View content update sends its page as text");
  const bytes = new TextEncoder().encode(request.html);
  // A lone surrogate has no UTF-8 form: the encoder would send U+FFFD, not the text given.
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== request.html) throw new RangeError("a View page must be valid Unicode text");
  if (bytes.byteLength > VIEW_CONTENT_MAX_BYTES) throw new RangeError(`a View page is at most ${VIEW_CONTENT_MAX_BYTES} bytes of UTF-8`);
  return { body: { ...read, expectedContentVersion: request.expectedContentVersion, html: request.html }, bytes };
}

/**
 * The refusal an answer carries (`ok: false` naming `operationId`), or undefined for an answer
 * that is not one. An `ok: false` envelope naming another operation, or a code outside the
 * refusal grammar, is malformed. `defaultWriteState` is what a refusal that states none means.
 */
export function viewContentRefusal(status: number, body: unknown, operationId: string, defaultWriteState: "not_applied" | "unknown", route?: string): HostedViewContentRefusal | undefined {
  if (!isRecord(body) || body.ok !== false) return undefined;
  const error = body.error;
  if (body.operationId !== operationId || !isRecord(error) || typeof error.code !== "string" || !REFUSAL_CODE.test(error.code)) {
    throw malformed(`answered a refusal that is not ${operationId}'s`, route);
  }
  const writeState = error.writeState === "not_applied" || error.writeState === "unknown" ? error.writeState : defaultWriteState;
  const text = typeof error.message === "string" ? stripHostText(error.message, REFUSAL_MESSAGE_CHARS) : "";
  const pinned = (value: unknown): string | null | undefined => (value === null ? null : isViewContentVersion(value) ? value : undefined);
  const expected = pinned(error.expected);
  const actual = pinned(error.actual);
  return Object.freeze({
    code: error.code,
    status,
    message: text === "" ? error.code : text,
    writeState,
    retryable: error.retryable === true,
    ...(error.target === "registry" || error.target === "content" ? { target: error.target } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
  });
}

function common(data: Record<string, unknown>, bundleId: string, request: HostedViewContentReadRequest, fail: (why: string) => never) {
  if (data.bundleId !== bundleId) fail("an answer for another bundle");
  if (data.registryId !== request.registryId) fail("an answer for another View");
  if (data.registryVersion !== request.expectedRegistryVersion) fail("an answer at another registration version");
  if (!isAnyEntryKey(data.key)) fail("a key that is not a View entry");
  if (!isViewContentVersion(data.version)) fail("a version that is not a sha256 version");
  if (typeof data.contentType !== "string" || !CONTENT_TYPE.test(data.contentType)) fail("no content type");
  const byteCount = data.byteCount;
  if (typeof byteCount !== "number" || !Number.isSafeInteger(byteCount) || byteCount < 0) fail("a byte count that is not a count");
  return { bundleId, registryId: request.registryId, registryVersion: request.expectedRegistryVersion, key: data.key as string, version: data.version as string, contentType: data.contentType as string, byteCount: byteCount as number };
}

/**
 * A read's `200` answer, for the View asked for: its html must have exactly the stated byte count
 * and version, or the answer is malformed.
 */
export function decodeViewContentRead(bundleId: string, request: HostedViewContentReadRequest, body: unknown, route?: string): HostedViewContent {
  const fail = (why: string): never => {
    throw malformed(`view-content-read answered ${why}`, route);
  };
  const data = isRecord(body) && body.ok === true && body.operationId === VIEW_CONTENT_READ_OPERATION && isRecord(body.data) ? body.data : fail(`an envelope that is not ${VIEW_CONTENT_READ_OPERATION}'s result`);
  const fields = common(data, bundleId, request, fail);
  if (typeof data.html !== "string") fail("no html");
  const bytes = new TextEncoder().encode(data.html as string);
  if (bytes.byteLength !== fields.byteCount) fail("html whose length is not its byte count");
  if (viewContentVersion(bytes) !== fields.version) fail("html whose digest is not its version");
  return Object.freeze({ ...fields, html: data.html as string });
}

/**
 * An update's `200` answer, for the update sent: its version must be the digest of the bytes sent
 * (an unchanged page's previous version is the same), or the answer is malformed.
 */
export function decodeViewContentUpdate(bundleId: string, request: HostedViewContentUpdateRequest, sent: Uint8Array, body: unknown, route?: string): HostedViewContentUpdate {
  const fail = (why: string): never => {
    throw malformed(`view-content-update answered ${why}`, route);
  };
  const data = isRecord(body) && body.ok === true && body.operationId === VIEW_CONTENT_UPDATE_OPERATION && isRecord(body.data) ? body.data : fail(`an envelope that is not ${VIEW_CONTENT_UPDATE_OPERATION}'s result`);
  const fields = common(data, bundleId, request, fail);
  if (typeof data.changed !== "boolean") fail("no changed flag");
  if (!isViewContentVersion(data.previousVersion)) fail("a previous version that is not a sha256 version");
  if (typeof data.requestId !== "string" || !REQUEST_ID.test(data.requestId)) fail("no request id");
  if (fields.version !== viewContentVersion(sent) || fields.byteCount !== sent.byteLength) fail("a version other than the page sent");
  if (!data.changed && data.previousVersion !== fields.version) fail("an unchanged page whose previous version differs");
  if (data.changed && data.previousVersion === fields.version) fail("a changed page whose previous version is the same");
  return Object.freeze({ ...fields, changed: data.changed as boolean, previousVersion: data.previousVersion as string, requestId: data.requestId as string });
}
