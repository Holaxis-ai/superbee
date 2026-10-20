/** Pure ordinary-file intent and result grammar. No transport or authority is carried here. */
import { assertSafeBlobKey } from "./paths.js";
import { isContentVersion } from "./version-transport.js";
import type { Version } from "./types.js";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
export const BLOB_OPERATION_IDS = Object.freeze(["blobs.create.v1", "blobs.replace.v1", "blobs.delete.v1"] as const);
export type BlobOperationId = (typeof BLOB_OPERATION_IDS)[number];
/** Pins retained in an intent. A delete has no replacement digest/type and creates name absence. */
export type BlobWriteExpected =
  | { operationId: "blobs.create.v1"; key: string; expectedVersion: null; expectedContentType: null; version: Version; contentType: string }
  | { operationId: "blobs.replace.v1"; key: string; expectedVersion: Version; expectedContentType: string; version: Version; contentType: string }
  | { operationId: "blobs.delete.v1"; key: string; expectedVersion: Version; expectedContentType: string };
export type BlobWriteSuccess =
  | { ok: true; operationId: "blobs.create.v1" | "blobs.replace.v1"; data: { key: string; version: Version; contentType: string; changed: boolean } }
  | { ok: true; operationId: "blobs.delete.v1"; data: { key: string; version: Version; contentType: string; deleted: true } };
export type BlobWriteErrorCode = "version_conflict" | "insufficient_scope" | "bundle_not_found" | "concurrent_change" | "backend_unavailable" | "request_capacity" | "deletions_held" | "write_outcome_unknown";
export type BlobWriteFailure = {
  ok: false;
  operationId: BlobOperationId;
  error: {
    code: BlobWriteErrorCode; message: string; retryable: false; writeState: "not_applied" | "unknown";
    expected?: Version | null; actual?: Version | null;
    expectedContentType?: string | null; actualContentType?: string | null;
    scope?: "principal" | "bundle"; resetAt?: string; deletions?: number; baseline?: number;
  };
};
export type BlobWriteResult = BlobWriteSuccess | BlobWriteFailure;
const BLOB_ERROR_CODES: readonly BlobWriteErrorCode[] = ["version_conflict", "insufficient_scope", "bundle_not_found", "concurrent_change", "backend_unavailable", "request_capacity", "deletions_held", "write_outcome_unknown"];
const BLOB_ERROR_KEYS = ["code", "message", "retryable", "writeState", "expected", "actual", "expectedContentType", "actualContentType", "scope", "resetAt", "deletions", "baseline"];
const BLOB_CONFLICT_KEYS = ["expected", "actual", "expectedContentType", "actualContentType"];
export function isBlobContentType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
}
export function isSafeBlobKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertSafeBlobKey(value);
    const bytes = new TextEncoder().encode(value);
    return bytes.length <= 512 && new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) === value;
  } catch { return false; }
}
export function isBlobWriteExpected(expected: BlobWriteExpected): boolean {
  if (!isRecord(expected) || !(BLOB_OPERATION_IDS as readonly unknown[]).includes(expected.operationId) || !isSafeBlobKey(expected.key)) return false;
  if (expected.operationId === "blobs.create.v1") {
    if (expected.expectedVersion !== null || expected.expectedContentType !== null) return false;
  } else if (!isContentVersion(expected.expectedVersion) || !isBlobContentType(expected.expectedContentType)) return false;
  if (expected.operationId === "blobs.delete.v1") return !("version" in expected) && !("contentType" in expected);
  return isContentVersion(expected.version) && isBlobContentType(expected.contentType);
}

/** A blob result answers every version and MIME pin retained in the original intent. Success
 * names a replacement head, or a delete's removed head; it never invents a tombstone. */
export function decodeBlobWriteResult(raw: unknown, expected: BlobWriteExpected): BlobWriteResult {
  const refuse = () => new TypeError("the blob write result does not answer the retained intent");
  if (!isBlobWriteExpected(expected) || !isRecord(raw) || !onlyKeys(raw, ["ok", "operationId", "data", "error"]) || raw.operationId !== expected.operationId) throw refuse();
  const operationId = expected.operationId;
  if (raw.ok === true) {
    const data = raw.data;
    const deletion = operationId === "blobs.delete.v1";
    if (raw.error !== undefined || !isRecord(data) || !onlyKeys(data, deletion ? ["key", "version", "contentType", "deleted"] : ["key", "version", "contentType", "changed"]) || data.key !== expected.key || !isContentVersion(data.version) || !isBlobContentType(data.contentType)) throw refuse();
    if (expected.operationId === "blobs.delete.v1") {
      if (data.deleted !== true || data.version !== expected.expectedVersion || data.contentType !== expected.expectedContentType) throw refuse();
      return { ok: true, operationId: expected.operationId, data: { key: expected.key, version: data.version, contentType: data.contentType, deleted: true } };
    }
    if (data.version !== expected.version || data.contentType !== expected.contentType || typeof data.changed !== "boolean" ||
        (expected.operationId === "blobs.create.v1" && !data.changed) ||
        (expected.operationId === "blobs.replace.v1" && data.changed !== (expected.version !== expected.expectedVersion || expected.contentType !== expected.expectedContentType))) throw refuse();
    return { ok: true, operationId: expected.operationId, data: { key: expected.key, version: data.version, contentType: data.contentType, changed: data.changed } };
  }
  const error = raw.error;
  if (raw.ok !== false || raw.data !== undefined || !isRecord(error) || !onlyKeys(error, BLOB_ERROR_KEYS) || !(BLOB_ERROR_CODES as readonly unknown[]).includes(error.code) || typeof error.message !== "string" || error.retryable !== false ||
      (error.writeState !== "not_applied" && error.writeState !== "unknown") ||
      (error.code === "write_outcome_unknown" ? error.writeState !== "unknown" : error.writeState !== "not_applied")) throw refuse();
  if (error.code === "version_conflict") {
    if (error.expected !== expected.expectedVersion || error.expectedContentType !== expected.expectedContentType ||
        !(error.actual === null || isContentVersion(error.actual)) || !(error.actualContentType === null || isBlobContentType(error.actualContentType)) ||
        ((error.actual === null) !== (error.actualContentType === null)) ||
        (expected.operationId === "blobs.create.v1" && error.actual === null) ||
        (error.actual === expected.expectedVersion && error.actualContentType === expected.expectedContentType)) throw refuse();
  } else if (BLOB_CONFLICT_KEYS.some(key => error[key] !== undefined)) throw refuse();
  if (error.code === "request_capacity") {
    if ((error.scope !== "principal" && error.scope !== "bundle") || (error.resetAt !== undefined && (typeof error.resetAt !== "string" || !Number.isFinite(Date.parse(error.resetAt))))) throw refuse();
  } else if (error.scope !== undefined || error.resetAt !== undefined) throw refuse();
  if (error.code === "deletions_held") {
    if (operationId !== "blobs.delete.v1" || !count(error.deletions) || !Number.isSafeInteger(error.baseline) || (error.baseline as number) < 0) throw refuse();
  } else if (error.deletions !== undefined || error.baseline !== undefined) throw refuse();
  return { ok: false, operationId, error: { ...(error as BlobWriteFailure["error"]) } };
}


export interface BlobHead { readonly key: string; readonly version: string; readonly contentType: string }
export function assertBlobKey(key: string): void {
  try { assertSafeBlobKey(key); } catch { throw new TypeError("unsafe blob key"); }
  const bytes = new TextEncoder().encode(key);
  if (bytes.length > 512 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== key) throw new TypeError("unrepresentable blob key");
}
export function captureBlobHead(value: unknown): BlobHead {
  if (!isRecord(value) || !onlyKeys(value, ["key", "version", "contentType"]) || typeof value.key !== "string" || !isContentVersion(value.version) || !isBlobContentType(value.contentType)) throw new TypeError("malformed blob head");
  assertBlobKey(value.key);
  return Object.freeze({ key: value.key, version: value.version, contentType: value.contentType });
}
export function encodeBlobKey(key: string): string {
  assertBlobKey(key);
  let binary = "";
  for (const byte of new TextEncoder().encode(key)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Snapshot the strict retained payload before any asynchronous admission. */
export function captureBlobWriteExpected(intent: BlobWriteExpected): BlobWriteExpected {
  if (!isRecord(intent)) throw new TypeError("blob intent and identity must be objects");
  const copied = { ...intent };
  const deletion = copied.operationId === "blobs.delete.v1";
  if (!["blobs.create.v1", "blobs.replace.v1", "blobs.delete.v1"].includes(copied.operationId) ||
      !onlyKeys(copied, deletion ? ["operationId", "key", "expectedVersion", "expectedContentType"] : ["operationId", "key", "expectedVersion", "expectedContentType", "version", "contentType"])) throw new TypeError("unsupported blob intent");
  assertBlobKey(copied.key);
  if (copied.operationId === "blobs.create.v1" ? copied.expectedVersion !== null || copied.expectedContentType !== null : !isContentVersion(copied.expectedVersion) || !isBlobContentType(copied.expectedContentType)) throw new TypeError("blob preconditions are required");
  if (copied.operationId !== "blobs.delete.v1" && (!isContentVersion(copied.version) || !isBlobContentType(copied.contentType))) throw new TypeError("blob replacement pins are required");
  return Object.freeze(copied);
}
