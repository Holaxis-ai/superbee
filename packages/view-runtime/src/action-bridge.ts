export const ACTION_BRIDGE_PROTOCOL = "v1";
const MAX_MESSAGE_BYTES = 512 * 1024;
export const MAX_ACTION_BODY_BYTES = 64 * 1024;

export type ActionScalar = string | number | boolean;

export interface DocumentSetFieldAction {
  kind: "document.set-field";
  docId: string;
  field: string;
  value: ActionScalar;
  expectedVersion: string;
}

export interface DocumentSetBodyAction {
  kind: "document.set-body";
  docId: string;
  field: "body";
  value: string;
  expectedVersion: string;
}
export interface DocumentUpdateAction {
  kind: "document.update";
  docId: string;
  field: "document";
  value: { fields: Record<string, ActionScalar>; body: string };
  expectedVersion: string;
}
export type DocumentAction = DocumentSetFieldAction | DocumentSetBodyAction | DocumentUpdateAction;

export function parseDocumentAction(value: unknown): DocumentAction {
  if (isPlainRecord(value) && value.kind === "document.update") {
    if (!exactKeys(value, ["kind", "docId", "field", "value", "expectedVersion"]) || value.field !== "document" ||
        !isPlainRecord(value.value) || !exactKeys(value.value, ["fields", "body"]) || !isPlainRecord(value.value.fields))
      throw new Error("document update requires exact fields and body");
    const body = parseDocumentAction({ ...value, kind: "document.set-body", field: "body", value: value.value.body }) as DocumentSetBodyAction;
    const entries = Object.entries(value.value.fields);
    if (entries.length < 1 || entries.length > 8) throw new Error("document update requires one to eight scalar fields");
    for (const [field, scalar] of entries) {
      const parsed = parseDocumentSetFieldAction({ kind: "document.set-field", docId: body.docId, field, value: scalar, expectedVersion: body.expectedVersion });
      if (parsed.field !== field) throw new Error("field names must be canonical");
    }
    return { kind: "document.update", docId: body.docId, field: "document", value: { fields: Object.fromEntries(entries) as Record<string, ActionScalar>, body: body.value }, expectedVersion: body.expectedVersion };
  }
  if (!isPlainRecord(value) || value.kind !== "document.set-body") return parseDocumentSetFieldAction(value);
  if (!exactKeys(value, ["kind", "docId", "field", "value", "expectedVersion"]) ||
      !safeDocId(value.docId) || value.field !== "body" || typeof value.value !== "string" ||
      byteLength(value.value) > MAX_ACTION_BODY_BYTES || typeof value.expectedVersion !== "string" ||
      !value.expectedVersion.trim() || value.expectedVersion.length > 256)
    throw new Error("body action requires a safe docId, field body, text of at most 64 KiB, and expectedVersion");
  return { kind: "document.set-body", docId: value.docId, field: "body", value: value.value, expectedVersion: value.expectedVersion.trim() };
}

export type ActionBridgeMessage =
  | { bridge: "v1"; type: "read-versioned"; id: string; docId: string }
  | { bridge: "v1"; type: "action.propose"; requestId: string; action: DocumentAction };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeDocId(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return (
    !segments.some((segment) => segment === "" || segment === "." || segment === "..") &&
    !segments.slice(0, -1).some((segment) => segment.toLowerCase().endsWith(".md"))
  );
}

function safeScalar(value: unknown): value is ActionScalar {
  if (typeof value === "string") return byteLength(value) <= 4096;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

function jsonSize(value: unknown): number | null {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function parseDocumentSetFieldAction(value: unknown): DocumentSetFieldAction {
  if (!isPlainRecord(value) || !exactKeys(value, ["kind", "docId", "field", "value", "expectedVersion"])) {
    throw new Error("action must contain exactly kind, docId, field, value, and expectedVersion");
  }
  if (value.kind !== "document.set-field") throw new Error("unsupported action kind");
  if (!safeDocId(value.docId)) throw new Error("docId must be one canonical bundle-relative concept id");
  const field = typeof value.field === "string" ? value.field.trim() : "";
  if (!field || byteLength(field) > 128) throw new Error("field must be a non-empty string of at most 128 bytes");
  const expectedVersion = typeof value.expectedVersion === "string" ? value.expectedVersion.trim() : "";
  if (!expectedVersion || expectedVersion.length > 256) {
    throw new Error("expectedVersion must be a non-empty string of at most 256 characters");
  }
  if (!safeScalar(value.value)) {
    throw new Error("value must be a string (at most 4 KiB), finite number, or boolean");
  }
  return {
    kind: "document.set-field",
    docId: value.docId,
    field,
    value: value.value,
    expectedVersion,
  };
}

/** Validate the complete structured-clone message before any shell work or confirmation UI. */
export function parseActionBridgeMessage(value: unknown): { ok: true; message: ActionBridgeMessage } | { ok: false; message: string } | null {
  if (!isPlainRecord(value) || value.bridge !== ACTION_BRIDGE_PROTOCOL || typeof value.type !== "string") return null;
  const size = jsonSize(value);
  const limit = value.type === "action.propose" && isPlainRecord(value.action) && ["document.set-body", "document.update"].includes(String(value.action.kind)) ? MAX_MESSAGE_BYTES : 8 * 1024;
  if (size === null || size > limit) return { ok: false, message: `action bridge message must be acyclic JSON of at most ${limit / 1024} KiB` };

  if (value.type === "read-versioned") {
    if (!exactKeys(value, ["bridge", "type", "id", "docId"]) || typeof value.id !== "string" || !value.id || value.id.length > 64 || !safeDocId(value.docId)) {
      return { ok: false, message: "read-versioned requires exact bridge, type, id, and safe docId fields" };
    }
    return { ok: true, message: value as ActionBridgeMessage };
  }

  if (value.type === "action.propose") {
    if (!exactKeys(value, ["bridge", "type", "requestId", "action"]) || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 64) {
      return { ok: false, message: "action.propose requires an exact non-empty requestId of at most 64 characters" };
    }
    try {
      const action = parseDocumentAction(value.action);
      return { ok: true, message: { bridge: ACTION_BRIDGE_PROTOCOL, type: "action.propose", requestId: value.requestId, action } };
    } catch {
      return { ok: false, message: "action.propose requires one valid document.set-field or document.set-body action" };
    }
  }

  return { ok: false, message: `unknown action bridge request '${value.type}'` };
}

export function actionReply(requestId: string, result: unknown): Record<string, unknown> {
  return { bridge: ACTION_BRIDGE_PROTOCOL, requestId, type: "action.result", result };
}

export function actionError(id: string | undefined, message: string): Record<string, unknown> {
  return { bridge: ACTION_BRIDGE_PROTOCOL, id, type: "error", error: { code: "REJECTED", message } };
}
