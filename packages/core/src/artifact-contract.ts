/** Portable document identity and presentation evidence. No host selection or effects. */
import type { ConceptId, Version } from "./types.js";
import type { Provenance } from "./platform.js";
import { assertSafeConceptId } from "./paths.js";
import { isContentVersion } from "./version-transport.js";

export type ArtifactAuthorityV1 =
  | { mode: "local"; authorityKey: string }
  | { mode: "hosted"; authorityKey: string; workspaceKey: string };
export interface DocumentTargetV1 {
  schemaVersion: "superbee.document-target.v1";
  authority: ArtifactAuthorityV1;
  bundleKey: string;
  documentId: ConceptId;
}
export type ArtifactLifecycleV1 =
  | { state: "unverified" }
  | { state: "bound"; sourceToken: string; documentToken: string };
export interface DocumentObservationV1 {
  schemaVersion: "superbee.document-observation.v1";
  target: DocumentTargetV1;
  provenance: Provenance;
  lifecycle: ArtifactLifecycleV1;
}
export interface PresentDocumentRequestV1 {
  schemaVersion: "superbee.present-document.v1";
  operation: "present_document";
  invocationId: string;
  target: DocumentTargetV1;
  referenceVersion?: Version;
  expectedLifecycle?: Extract<ArtifactLifecycleV1, { state: "bound" }>;
}
export type PresentationStateV1 =
  | { state: "open_requested"; observation?: DocumentObservationV1 }
  | { state: "payload_prepared"; observation: DocumentObservationV1 }
  | { state: "offered"; expiresAt: number; observation?: DocumentObservationV1 }
  | { state: "navigated"; observation?: DocumentObservationV1 };
export type PresentationErrorCodeV1 =
  | "invalid_input" | "unsupported_version" | "unsupported_operation"
  | "unsupported_host" | "unavailable" | "unavailable_stale_target"
  | "context_changed" | "presentation_disabled" | "busy";
export type PresentDocumentReceiptV1 = {
  schemaVersion: "superbee.present-document-receipt.v1";
  operation: "present_document";
  invocationId: string;
  target: DocumentTargetV1;
} & (
  | { ok: true; presentation: PresentationStateV1 }
  | { ok: false; error: { code: PresentationErrorCodeV1; retryable: boolean } }
);
export interface DocumentPresentationCapabilitiesV1 {
  schemaVersion: "superbee.document-presentation-capabilities.v1";
  states: Array<PresentationStateV1["state"]>;
}
export type ArtifactDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid_input" | "unsupported_version" | "receipt_mismatch" };

type DecodeCode = Extract<ArtifactDecodeResult<never>, { ok: false }>["code"];
class DecodeFailure {
  readonly code: DecodeCode;
  constructor(code: DecodeCode) { this.code = code; }
}
function requireValue(condition: unknown, code: DecodeCode = "invalid_input"): asserts condition {
  if (!condition) throw new DecodeFailure(code);
}
type Data = Record<string, unknown>;

/** Reflect first, before schema classification. Own accessors are never read. Reflection can
 * invoke Proxy traps; failures are caught by the decoder, not treated as trusted data. */
function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { requireValue(Number.isFinite(value)); return value; }
  requireValue(typeof value === "object");
  requireValue(!ancestors.has(value));
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  requireValue(array ? prototype === Array.prototype : prototype === null || prototype === Object.prototype);
  ancestors.add(value);
  try {
    const copy: Data = Object.create(null);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      requireValue(typeof key === "string");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValue(descriptor && Object.hasOwn(descriptor, "value"));
      copy[key] = snapshot(descriptor.value, ancestors);
    }
    if (!array) return copy;
    const length = copy.length;
    requireValue(typeof length === "number" && Number.isSafeInteger(length) && length >= 0);
    requireValue(keys.length === length + 1);
    const items: unknown[] = [];
    for (let i = 0; i < length; i++) {
      requireValue(Object.hasOwn(copy, String(i)));
      items.push(copy[String(i)]);
    }
    return items;
  } finally { ancestors.delete(value); }
}
function record(value: unknown): Data {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Data;
}
function fields(value: Data, required: string[], optional: string[] = []): void {
  requireValue(required.every(key => Object.hasOwn(value, key)));
  requireValue(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function envelope(value: unknown, schema: string): Data {
  const data = record(value);
  requireValue(typeof data.schemaVersion === "string");
  requireValue(data.schemaVersion === schema, "unsupported_version");
  return data;
}
function key(value: unknown): string {
  requireValue(typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value) && !/[\\/]/.test(value));
  return value;
}
function version(value: unknown): Version { requireValue(isContentVersion(value)); return value; }
function nullableVersion(value: unknown): Version | null { return value === null ? null : version(value); }
function target(value: unknown): DocumentTargetV1 {
  const data = envelope(value, "superbee.document-target.v1");
  fields(data, ["schemaVersion", "authority", "bundleKey", "documentId"]);
  const authority = record(data.authority);
  let parsedAuthority: ArtifactAuthorityV1;
  if (authority.mode === "local") {
    fields(authority, ["mode", "authorityKey"]);
    parsedAuthority = { mode: "local", authorityKey: key(authority.authorityKey) };
  } else {
    requireValue(authority.mode === "hosted");
    fields(authority, ["mode", "authorityKey", "workspaceKey"]);
    parsedAuthority = { mode: "hosted", authorityKey: key(authority.authorityKey), workspaceKey: key(authority.workspaceKey) };
  }
  requireValue(typeof data.documentId === "string");
  assertSafeConceptId(data.documentId);
  return { schemaVersion: "superbee.document-target.v1", authority: parsedAuthority, bundleKey: key(data.bundleKey), documentId: data.documentId };
}
function lifecycle(value: unknown): ArtifactLifecycleV1 {
  const data = record(value);
  if (data.state === "unverified") { fields(data, ["state"]); return { state: "unverified" }; }
  requireValue(data.state === "bound");
  fields(data, ["state", "sourceToken", "documentToken"]);
  return { state: "bound", sourceToken: key(data.sourceToken), documentToken: key(data.documentToken) };
}
function provenance(value: unknown): Provenance {
  const data = record(value);
  if (data.state === "shared-confirmed") {
    fields(data, ["state", "version", "acknowledged"]);
    return { state: "shared-confirmed", version: version(data.version), acknowledged: version(data.acknowledged) };
  }
  requireValue(data.state === "local-pending" || data.state === "local-conflict");
  fields(data, ["state", "version", "base", "requestId", ...(data.state === "local-conflict" ? ["remote"] : [])]);
  requireValue(typeof data.requestId === "string");
  const common = { version: version(data.version), base: nullableVersion(data.base), requestId: data.requestId };
  return data.state === "local-pending"
    ? { state: "local-pending", ...common }
    : { state: "local-conflict", ...common, remote: nullableVersion(data.remote) };
}
function observation(value: unknown): DocumentObservationV1 {
  const data = envelope(value, "superbee.document-observation.v1");
  fields(data, ["schemaVersion", "target", "provenance", "lifecycle"]);
  return { schemaVersion: "superbee.document-observation.v1", target: target(data.target), provenance: provenance(data.provenance), lifecycle: lifecycle(data.lifecycle) };
}
function request(value: unknown): PresentDocumentRequestV1 {
  const data = envelope(value, "superbee.present-document.v1");
  fields(data, ["schemaVersion", "operation", "invocationId", "target"], ["referenceVersion", "expectedLifecycle"]);
  requireValue(data.operation === "present_document");
  const expectedLifecycle = Object.hasOwn(data, "expectedLifecycle") ? lifecycle(data.expectedLifecycle) : undefined;
  requireValue(expectedLifecycle === undefined || expectedLifecycle.state === "bound");
  return {
    schemaVersion: "superbee.present-document.v1", operation: "present_document",
    invocationId: key(data.invocationId), target: target(data.target),
    ...(Object.hasOwn(data, "referenceVersion") ? { referenceVersion: version(data.referenceVersion) } : {}),
    ...(expectedLifecycle?.state === "bound" ? { expectedLifecycle } : {}),
  };
}
const states: PresentationStateV1["state"][] = ["open_requested", "payload_prepared", "offered", "navigated"];
function presentation(value: unknown): PresentationStateV1 {
  const data = record(value);
  requireValue(states.includes(data.state as PresentationStateV1["state"]));
  fields(data, ["state", ...(data.state === "offered" ? ["expiresAt"] : []), ...(data.state === "payload_prepared" ? ["observation"] : [])], ["observation"]);
  const observed = Object.hasOwn(data, "observation") ? { observation: observation(data.observation) } : {};
  switch (data.state) {
    case "offered":
      requireValue(typeof data.expiresAt === "number" && Number.isSafeInteger(data.expiresAt) && data.expiresAt >= 0);
      return { state: "offered", expiresAt: data.expiresAt, ...observed };
    case "payload_prepared": return { state: "payload_prepared", observation: observation(data.observation) };
    case "open_requested": return { state: "open_requested", ...observed };
    default: return { state: "navigated", ...observed };
  }
}
const errors: PresentationErrorCodeV1[] = ["invalid_input", "unsupported_version", "unsupported_operation", "unsupported_host", "unavailable", "unavailable_stale_target", "context_changed", "presentation_disabled", "busy"];
function receipt(value: unknown, expected: PresentDocumentRequestV1): PresentDocumentReceiptV1 {
  const data = envelope(value, "superbee.present-document-receipt.v1");
  requireValue(typeof data.ok === "boolean");
  fields(data, ["schemaVersion", "operation", "invocationId", "target", "ok", data.ok ? "presentation" : "error"]);
  requireValue(data.operation === "present_document");
  const common = { schemaVersion: "superbee.present-document-receipt.v1" as const, operation: "present_document" as const, invocationId: key(data.invocationId), target: target(data.target) };
  let parsed: PresentDocumentReceiptV1;
  if (data.ok) parsed = { ...common, ok: true, presentation: presentation(data.presentation) };
  else {
    const error = record(data.error);
    fields(error, ["code", "retryable"]);
    requireValue(errors.includes(error.code as PresentationErrorCodeV1) && typeof error.retryable === "boolean");
    requireValue(!error.retryable || error.code === "busy" || error.code === "unavailable");
    parsed = { ...common, ok: false, error: { code: error.code as PresentationErrorCodeV1, retryable: error.retryable } };
  }
  requireValue(parsed.invocationId === expected.invocationId && sameDocumentTargetV1(parsed.target, expected.target), "receipt_mismatch");
  if (parsed.ok) {
    const observed = parsed.presentation.observation;
    requireValue(!observed || sameDocumentTargetV1(observed.target, expected.target), "receipt_mismatch");
    if (expected.expectedLifecycle) {
      const actual = observed?.lifecycle;
      requireValue(actual?.state === "bound" && actual.sourceToken === expected.expectedLifecycle.sourceToken && actual.documentToken === expected.expectedLifecycle.documentToken, "receipt_mismatch");
    }
  }
  return parsed;
}
function decode<T>(value: unknown, parse: (data: unknown) => T): ArtifactDecodeResult<T> {
  try { return { ok: true, value: parse(snapshot(value)) }; }
  catch (error) { return { ok: false, code: error instanceof DecodeFailure ? error.code : "invalid_input" }; }
}
export function decodeDocumentTargetV1(value: unknown): ArtifactDecodeResult<DocumentTargetV1> { return decode(value, target); }
export function decodeDocumentObservationV1(value: unknown): ArtifactDecodeResult<DocumentObservationV1> { return decode(value, observation); }
export function decodePresentDocumentRequestV1(value: unknown): ArtifactDecodeResult<PresentDocumentRequestV1> { return decode(value, request); }
/** expected is caller-owned decoded data or an equivalent trusted constructor value. */
export function decodePresentDocumentReceiptV1(value: unknown, expected: PresentDocumentRequestV1): ArtifactDecodeResult<PresentDocumentReceiptV1> {
  return decode(value, data => receipt(data, expected));
}
export function decodeDocumentPresentationCapabilitiesV1(value: unknown): ArtifactDecodeResult<DocumentPresentationCapabilitiesV1> {
  return decode(value, value => {
    const data = envelope(value, "superbee.document-presentation-capabilities.v1");
    fields(data, ["schemaVersion", "states"]);
    requireValue(Array.isArray(data.states) && data.states.every(state => states.includes(state)) && new Set(data.states).size === data.states.length);
    return { schemaVersion: "superbee.document-presentation-capabilities.v1", states: [...data.states] };
  });
}
export function sameDocumentTargetV1(a: DocumentTargetV1, b: DocumentTargetV1): boolean {
  return a.authority.mode === b.authority.mode && a.authority.authorityKey === b.authority.authorityKey
    && (a.authority.mode !== "hosted" || (b.authority.mode === "hosted" && a.authority.workspaceKey === b.authority.workspaceKey))
    && a.bundleKey === b.bundleKey && a.documentId === b.documentId;
}
export function compareAuthorityVersionV1(observed: DocumentObservationV1, reference: Version): "same" | "different" | "unconfirmed" {
  return observed.provenance.state !== "shared-confirmed" ? "unconfirmed" : observed.provenance.acknowledged === reference ? "same" : "different";
}
