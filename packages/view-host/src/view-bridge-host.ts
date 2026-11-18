/**
 * An operation-mapped View bridge host: the parent-page half of the View protocol
 * (`docs/VIEW-PROTOCOL.md`, bridge `v0` and the v1 `read-versioned` and `action.propose`), for a
 * page that runs a View in a sandboxed frame. It parses what the View's frame posts, maps each data
 * request onto one named operation that the page's `execute` callback runs on the person's behalf,
 * and answers in the protocol's vocabulary. It has no data semantics of its own:
 *
 * | request | operation |
 * | --- | --- |
 * | `query` | `documents.query.v1` |
 * | `read`, `read-versioned`, `render-document` | `documents.read.v1` |
 * | `relationships` | `documents.relationships.v1` |
 * | `edges` | `documents.edges.v1` |
 * | `graph` | `bundles.graph.v1` |
 * | `action.propose` (v1) | the page's `proposeAction` (`documents.update.v1` behind its confirmation) |
 *
 * A request whose operation the caller does not offer is not declared in `hello` and is refused
 * with `FORBIDDEN`. A query feature the operations cannot answer yet (`query.field-or`, `query.open`,
 * `query.kind-projection`, `query.count`) is declared absent, and the query that needs it is refused
 * with `USAGE` instead of being answered with less: a `field` with more than one value, `open: true`,
 * and a `field` on the logical `progress_status`. A capped `query` says `more: true`.
 *
 * The bundle is fixed when the host is made: every operation input carries that `bundleId` and a
 * View cannot name another. Nothing here builds an address: `hello.bundle` is `{ root: null, name }`,
 * and `open-page` asks the page's own resolver.
 *
 * A host that stops answering must remove the frame. The protocol's reference client never times a
 * request out, so a frame whose requests go unanswered waits forever: when `admitted()` turns false
 * the host calls `invalidate()` and answers nothing more, and when `stop()` runs waiting requests are
 * dropped. In both cases the page removes the View's frame (`invalidate` is where it does so).
 */
import { parseActionBridgeMessage, actionReply, type DocumentAction } from "./action-bridge.js";
import { assertSafeConceptId } from "@superbee/core/storage";
import { isAnyRegistryId } from "@superbee/core/page";
import { compareCodeUnits } from "@superbee/core/code-unit-order";
// Nothing on this path loads a schema library: the host maps messages onto operations with plain
// checks, and the operation's own input schema, where `execute` runs it, is the validator.
import { ReadAdapterError } from "./read-adapter-error.js";

export { ReadAdapterError } from "./read-adapter-error.js";

/** The row orders `documents.query.v1` answers: canonical id (the default) or newest first. */
export const QUERY_ORDERS = ["id", "newest"] as const;
/** `bundles.graph.v1`'s ceilings, which equal the protocol's `graph` ceilings. */
export const GRAPH_MAX_DOCUMENTS = 1000;
export const GRAPH_MAX_RELATIONSHIPS = 10000;

export const BRIDGE_PROTOCOL = "v0";
export const ACTION_BRIDGE_PROTOCOL = "v1";
/** The operations a View's requests map onto, by the names the caller's `execute` runs them under. */
export const VIEW_BRIDGE_OPERATIONS = [
  "documents.read.v1",
  "documents.query.v1",
  "documents.relationships.v1",
  "documents.edges.v1",
  "bundles.graph.v1",
  "documents.update.v1",
] as const;
export type ViewBridgeOperation = (typeof VIEW_BRIDGE_OPERATIONS)[number];
const MAX_MESSAGE_BYTES = 65536;
/** An oversize message is answered TOO_LARGE only when its `id` reads cheaply from the top level. */
const MAX_OVERSIZE_ECHO_ID_BYTES = 255;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_ACTION_REQUEST_ID_BYTES = 64;
const MAX_HOST_CAPABILITY_BYTES = 128;
const HOST_CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_DOC_ID_BYTES = 1024;
/** `documents.query.v1`'s own row ceiling. */
const MAX_QUERY_ROWS = 100;
/** The operations' bounds on a query's text facets and a document id, in UTF-8 bytes. */
const MAX_QUERY_TEXT_BYTES = 256;
const MAX_QUERY_PREFIX_BYTES = 512;
const MAX_CANONICAL_ID_BYTES = 512;
/** `documents.edges.v1`'s own row ceiling; the operation refuses above it. */
const MAX_EDGE_ROWS = 1000;
const MAX_DOCUMENT_BODY_BYTES = 1024 * 1024;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const HOST_INVOKE_TIMEOUT_MS = 15000;
/** At most four operations execute at once; further requests wait FIFO rather than being dropped,
 * since the protocol's reference client never retries. */
const MAX_IN_FLIGHT = 4;
const MAX_PENDING = 64;
const SEEN_WINDOW = 10000;
/** The ceilings this host enforces where the caller offers the request; `bridgeLimits` zeroes the
 * ones it does not offer, which is how the protocol expresses "not offered". */
export const BRIDGE_LIMITS = Object.freeze({
  query: MAX_QUERY_ROWS,
  edges: MAX_EDGE_ROWS,
  graphDocuments: GRAPH_MAX_DOCUMENTS,
  graphRelationships: GRAPH_MAX_RELATIONSHIPS,
  replyBytes: MAX_REPLY_BYTES,
});
export type BridgeErrorCode = "USAGE" | "FORBIDDEN" | "REVOKED" | "TOO_LARGE" | "RUNTIME" | "NOT_FOUND";
/** What the page's reader answers for `record.open`. */
export type ViewBridgeUiResult =
  | { ok: true }
  | {
      ok: false;
      code: "unsupported" | "invalid_input" | "not_found" | "denied" | "unavailable" | "cancelled" | "busy";
    };

/** The View's frame window as the host uses it: where replies are posted. */
export interface ViewBridgeFrame {
  postMessage(message: unknown, targetOrigin: string): void;
}
/** A `message` event the page received, as the host reads it. */
export interface ViewBridgeMessage {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}
/** The one bundle the View reads: its id (sent with every operation) and the name the page shows
 * for it (`hello.bundle.name`, never an internal id). */
export interface ViewBridgeBundle {
  readonly id: string;
  readonly name: string;
}
/** Runs one operation on the person's behalf, as the caller runs it, with the host's input (the fixed
 * `bundleId` included) and answers the operation's result envelope. */
export type ViewBridgeExecute = (
  operation: ViewBridgeOperation,
  input: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
/** Everything else the host is given, in one object so later options are added without changing
 * the call. */
export interface ViewBridgeHostOptions {
  /** The operations the caller runs on the person's behalf for this View; a request mapped to any
   * other is not declared in `hello` and is refused with FORBIDDEN. */
  readonly operations: readonly ViewBridgeOperation[];
  /** Whether the View may still be answered (the page's binding, grant or lifetime). Checked before
   * and after every operation; when false the host calls `invalidate` and answers nothing. */
  admitted?(): boolean;
  /** The page removes the View's frame (and stops this host). */
  invalidate?(): void;
  /** Called once, on the first bridge request of any type: a View need not send `hello`. */
  onReady?(): void;
  /** `render-document`: the shared inert Markdown renderer (`@superbee/markdown-renderer/static`'s
   * `renderDocumentToStaticHtml`), so a View receives the same markup on every host. Absent, the
   * request is not offered. */
  renderDocument?(document: { id: string; body: string }): { html: string; bounded: boolean };
  /** v1 `action.propose`, behind the page's own confirmation; offered only with `documents.read.v1`
   * and `documents.update.v1` in `operations`. */
  proposeAction?(action: DocumentAction, signal: AbortSignal): Promise<unknown>;
  /** `host` capability `record.open`: the page opens its own reader for one document. */
  recordAvailable?(): boolean;
  openRecord?(documentId: string, signal: AbortSignal): Promise<ViewBridgeUiResult>;
  /** The page owns the frame's presentation: `hello.host.frame` tells the View so, `theme` carries
   * the page's tokens, and `frame.resize` lets the View report its content height. `resize` returns
   * the height the frame now draws at, within the page's bounds; `maxHeight` is the largest. */
  frame?: {
    resize(height: number): number;
    readonly maxHeight: number;
    readonly theme?: Readonly<Record<string, string>>;
  };
  /** `open-page`: the page opens the View its bundle registers as `registryId` (a sibling of this
   * View in the same bundle), resolving it from what the page already knows, never from the
   * request, and answers whether it did. Absent, `open-page` is not offered. */
  openPage?(registryId: string): boolean;
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
class BridgeFailure extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}
type Bridge = typeof BRIDGE_PROTOCOL | typeof ACTION_BRIDGE_PROTOCOL;
/** `from`, `to` and `text` as the View sent them: `documents.edges.v1`'s input is their validator. */
type EdgeParams = Record<string, unknown>;
type QueryParams = {
  type?: string;
  prefix?: string;
  field?: string;
  open?: true;
  limit?: number;
  order?: (typeof QUERY_ORDERS)[number];
};
type ParsedRequest =
  | { kind: "hello"; bridge: Bridge; id: string }
  | { kind: "subscribe"; bridge: Bridge; id: string }
  | { kind: "query"; bridge: Bridge; id: string; params: QueryParams }
  | { kind: "read" | "render-document" | "read-versioned"; bridge: Bridge; id: string; docId: string }
  | { kind: "relationships"; bridge: Bridge; id: string; docId: string; cursor?: Record<string, unknown> }
  | { kind: "edges"; bridge: Bridge; id: string; params: EdgeParams }
  | { kind: "graph"; bridge: Bridge; id: string; includeBodies: boolean }
  | { kind: "host"; bridge: Bridge; id: string; capability: string; input: unknown }
  /** `open-page` is fire-and-forget in the protocol's grammar: `id` is optional, and `pageId` is `null`
   * when the envelope is malformed or names no registry id, which is refused like any other target. */
  | { kind: "open-page"; bridge: Bridge; id: string | undefined; pageId: string | null }
  | { kind: "refused"; bridge: Bridge; id: string | undefined; code: "USAGE" | "FORBIDDEN"; message: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function boundedString(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= maxBytes ? value : null;
}
function normalizeQueryParams(raw: unknown): QueryParams | null {
  if (!isPlainRecord(raw)) return null;
  // `cursor` (the protocol's `query.cursor`, not offered here) is an unknown key like any other: USAGE.
  const allowed = new Set(["type", "prefix", "field", "open", "limit", "order"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const out: QueryParams = {};
  if (raw.type !== undefined) {
    const value = boundedString(raw.type, 256)?.trim();
    if (!value) return null;
    out.type = value;
  }
  if (raw.prefix !== undefined) {
    const value = boundedString(raw.prefix, 1024)?.trim();
    if (!value) return null;
    out.prefix = value;
  }
  if (raw.field !== undefined) {
    const value = boundedString(raw.field, 1024)?.trim();
    if (!value) return null;
    out.field = value;
  }
  if (raw.open !== undefined) {
    if (raw.open !== true && raw.open !== false) return null;
    if (raw.open) out.open = true;
  }
  if (raw.limit !== undefined) {
    if (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 0) return null;
    out.limit = raw.limit as number;
  }
  if (raw.order !== undefined) {
    if (!(QUERY_ORDERS as readonly unknown[]).includes(raw.order)) return null;
    out.order = raw.order as QueryParams["order"];
  }
  return out;
}
/** The envelope only: an object of `from`, `to` and `text`. Their values (canonical ids or prefixes,
 * 1 to 32, at most 1,024 bytes, nonblank text) are checked by the operation, whose `invalid_input`
 * answers `USAGE`. */
function edgeParams(raw: unknown): EdgeParams | null {
  return isPlainRecord(raw) && Object.keys(raw).every((key) => key === "from" || key === "to" || key === "text")
    ? raw
    : null;
}
/** The protocol's request grammar, extended by the reserved `host` request. A type this host does not
 * serve is refused with FORBIDDEN and never dropped, so a View can tell refusal from silence. */
function parseBridgeRequest(value: Record<string, unknown>): ParsedRequest {
  const bridge = value.bridge as Bridge;
  const type = value.type as string;
  // A v1 id is bounded at 64 bytes, as the protocol's other hosts bound it before forwarding.
  const idBytes = bridge === ACTION_BRIDGE_PROTOCOL ? MAX_ACTION_REQUEST_ID_BYTES : MAX_REQUEST_ID_BYTES;
  const id = boundedString(value.id, idBytes) ?? undefined;
  // A refusal echoes whichever correlation key the message carried, so an action proposal
  // (keyed by `requestId`) is refused in a reply its client can match, never dropped.
  const echo = id ?? boundedString(value.requestId, idBytes) ?? undefined;
  const usage = (message: string): ParsedRequest => ({ kind: "refused", bridge, id: echo, code: "USAGE", message });
  if (bridge === ACTION_BRIDGE_PROTOCOL) {
    if (type !== "read-versioned")
      return { kind: "refused", bridge, id: echo, code: "FORBIDDEN", message: "this host serves no bridge actions" };
    if (!exactKeys(value, ["bridge", "type", "id", "docId"]) || !id) return usage("invalid read-versioned request");
    const docId = boundedString(value.docId, MAX_DOC_ID_BYTES);
    return docId ? { kind: "read-versioned", bridge, id, docId } : usage("invalid read-versioned request");
  }
  if (type === "hello" || type === "subscribe" || type === "query" || type === "edges" || type === "graph") {
    if (!id) return usage(`invalid ${type} request`);
    if (type === "hello" || type === "subscribe")
      return exactKeys(value, ["bridge", "type", "id"]) ? { kind: type, bridge, id } : usage(`invalid ${type} request`);
    if (type === "query") {
      const params = exactKeys(value, ["bridge", "type", "id", "params"]) ? normalizeQueryParams(value.params) : null;
      return params ? { kind: "query", bridge, id, params } : usage("invalid query request");
    }
    if (type === "edges") {
      const params = exactKeys(value, ["bridge", "type", "id", "params"]) ? edgeParams(value.params) : null;
      return params ? { kind: "edges", bridge, id, params } : usage("invalid edges request");
    }
    const expected =
      value.includeBodies === undefined ? ["bridge", "type", "id"] : ["bridge", "type", "id", "includeBodies"];
    if (!exactKeys(value, expected) || (value.includeBodies !== undefined && typeof value.includeBodies !== "boolean"))
      return usage("invalid graph request");
    return { kind: "graph", bridge, id, includeBodies: value.includeBodies === true };
  }
  if (type === "read" || type === "render-document") {
    if (!id) return usage(`invalid ${type} request`);
    const docId = exactKeys(value, ["bridge", "type", "id", "docId"])
      ? boundedString(value.docId, MAX_DOC_ID_BYTES)
      : null;
    return docId ? { kind: type, bridge, id, docId } : usage(`invalid ${type} request`);
  }
  if (type === "relationships") {
    // The cursor is whatever this host answered for the previous page, sent back unchanged; the
    // operation's own input check is its validator.
    const expected =
      value.cursor === undefined ? ["bridge", "type", "id", "docId"] : ["bridge", "type", "id", "docId", "cursor"];
    const docId = id && exactKeys(value, expected) ? boundedString(value.docId, MAX_DOC_ID_BYTES) : null;
    if (!docId || (value.cursor !== undefined && !isPlainRecord(value.cursor)))
      return usage("invalid relationships request");
    return {
      kind: "relationships",
      bridge,
      id: id!,
      docId,
      ...(value.cursor === undefined ? {} : { cursor: value.cursor as Record<string, unknown> }),
    };
  }
  if (type === "open-page") {
    const expected = value.id === undefined ? ["bridge", "type", "pageId"] : ["bridge", "type", "id", "pageId"];
    const wellFormed = exactKeys(value, expected) && (value.id === undefined || !!id) && isAnyRegistryId(value.pageId);
    return { kind: "open-page", bridge, id: echo, pageId: wellFormed ? (value.pageId as string) : null };
  }
  if (type === "host") {
    if (!id) return usage("invalid host request");
    const expected =
      value.input === undefined
        ? ["bridge", "type", "id", "capability"]
        : ["bridge", "type", "id", "capability", "input"];
    // The envelope grammar (a registry-shaped name, an object input) is checked before the
    // capability lookup, so a malformed request is USAGE and only an undeclared name is FORBIDDEN.
    const capability = exactKeys(value, expected) ? boundedString(value.capability, MAX_HOST_CAPABILITY_BYTES) : null;
    if (!capability || !HOST_CAPABILITY_NAME.test(capability)) return usage("invalid host request");
    if (value.input !== undefined && !isPlainRecord(value.input)) return usage("host input must be an object");
    return { kind: "host", bridge, id, capability, input: value.input };
  }
  return { kind: "refused", bridge, id: echo, code: "FORBIDDEN", message: `this host does not serve ${type}` };
}

/** The registry capabilities this host declares for `operations` and the page's services, sorted as
 * the protocol requires. Of the `query.*` capabilities only `query.newest` is declared:
 * `documents.query.v1` orders by newest meaningful change, and it has no OR of field values, no
 * terminal filter, no Kind projection and no total count yet, so `query.field-or`, `query.open`,
 * `query.kind-projection` and `query.count` are absent (and refused as `USAGE` where a query needs
 * them). Whether `query` is offered at all is `limits.query`, not a capability. */
export function bridgeCapabilities(
  operations: ReadonlySet<ViewBridgeOperation>,
  services: { renderDocument?: boolean; recordOpen?: boolean; frameResize?: boolean; openPage?: boolean } = {},
) {
  const capabilities: string[] = [];
  if (operations.has("documents.edges.v1")) capabilities.push("edges");
  if (operations.has("bundles.graph.v1")) capabilities.push("graph");
  if (operations.has("documents.query.v1")) capabilities.push("query.newest");
  if (operations.has("documents.relationships.v1")) capabilities.push("relationships");
  if (operations.has("documents.read.v1") && services.renderDocument) capabilities.push("render-document");
  if (operations.has("documents.read.v1") && services.recordOpen) capabilities.push("record.open");
  // `frame.resize` needs no bundle operation: it reports a height, it reads nothing.
  if (services.frameResize) capabilities.push("frame.resize");
  // `open-page` is the registry's "navigates the shell": declared where the page resolves sibling
  // Views and opens them; it reads nothing either.
  if (services.openPage) capabilities.push("open-page");
  return capabilities.sort(compareCodeUnits);
}
/** The `frame.resize` input: one finite, non-negative CSS pixel height and nothing else. */
function frameResizeInput(input: unknown): number | null {
  if (!isPlainRecord(input) || !exactKeys(input, ["height"])) return null;
  const height = input.height;
  // No upper bound here: the registry names only finite and non-negative, and the sizer clamps.
  return typeof height === "number" && Number.isFinite(height) && height >= 0 ? height : null;
}
/** The declared ceilings: `0` for a request the caller does not offer. */
export function bridgeLimits(operations: ReadonlySet<ViewBridgeOperation>) {
  const query = operations.has("documents.query.v1"),
    edges = operations.has("documents.edges.v1"),
    graph = operations.has("bundles.graph.v1");
  return {
    query: query ? BRIDGE_LIMITS.query : 0,
    edges: edges ? BRIDGE_LIMITS.edges : 0,
    graphDocuments: graph ? BRIDGE_LIMITS.graphDocuments : 0,
    graphRelationships: graph ? BRIDGE_LIMITS.graphRelationships : 0,
    replyBytes: BRIDGE_LIMITS.replyBytes,
  };
}

const operationFor = {
  query: "documents.query.v1",
  read: "documents.read.v1",
  "read-versioned": "documents.read.v1",
  "render-document": "documents.read.v1",
  relationships: "documents.relationships.v1",
  edges: "documents.edges.v1",
  graph: "bundles.graph.v1",
} as const satisfies Record<string, ViewBridgeOperation>;
type DataRequest = Extract<ParsedRequest, { kind: keyof typeof operationFor }>;
type ReadData = { document: { id: string; frontmatter: Record<string, unknown>; body: string }; version: string };
type GraphData = {
  okfVersion?: string;
  documents: { id: string; version: string; frontmatter: Record<string, unknown>; body?: string }[];
  relationships: { from: string; to: string; text: string }[];
};
type RelationshipsData = {
  links: { documentId: string; title: string; label: string; direction: "incoming" | "outgoing" }[];
  next?: Record<string, unknown>;
};
type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
/** One canonical document id, as the operations accept one, or null. */
function canonicalId(value: unknown): string | null {
  if (typeof value !== "string" || !value || byteLength(value) > MAX_CANONICAL_ID_BYTES) return null;
  try {
    assertSafeConceptId(value);
    return value;
  } catch {
    return null;
  }
}
/** The logical Kind field whose physical name depends on the bundle's edition; matching it as a raw
 * key finds nothing, so without `query.kind-projection` a filter on it is refused. */
const LOGICAL_KIND_FIELDS: ReadonlySet<string> = new Set(["progress_status"]);
/** Refused reads a retry alone never changes: grant denials and the older wire signals a caller
 * may still forward. */
const DENIED_CODES: ReadonlySet<string> = new Set([
  "bundle_not_found",
  "insufficient_scope",
  "access_denied",
  "denied",
]);

/** The protocol's `field` grammar onto `documents.query.v1`'s `fields` (one exact value per key):
 * split at the first `=`, ignore a filter with no `=` or an empty key, drop empty values, and match
 * nothing on an empty value list (`null`: no operation runs). What the operation cannot answer is
 * refused, never answered with less. */
function queryInput(params: QueryParams) {
  if (params.limit !== undefined && params.limit > MAX_QUERY_ROWS)
    throw new BridgeFailure("USAGE", `this host answers at most ${MAX_QUERY_ROWS} rows`);
  if (params.open) throw new BridgeFailure("USAGE", "this host does not offer query.open");
  const input: Record<string, unknown> = { limit: params.limit ? params.limit : MAX_QUERY_ROWS };
  const invalid = () => new BridgeFailure("USAGE", "invalid query parameters");
  if (params.type) {
    if (byteLength(params.type) > MAX_QUERY_TEXT_BYTES) throw invalid();
    input.type = params.type;
  }
  if (params.prefix) {
    const bare = params.prefix.endsWith("/") ? params.prefix.slice(0, -1) : params.prefix;
    if (byteLength(params.prefix) > MAX_QUERY_PREFIX_BYTES || canonicalId(bare) === null) throw invalid();
    input.prefix = params.prefix;
  }
  // `id` is the operation's default order, so only `newest` is sent.
  if (params.order === "newest") input.order = "newest";
  if (params.field !== undefined) {
    const separator = params.field.indexOf("=");
    const key = separator < 0 ? "" : params.field.slice(0, separator).trim();
    if (key) {
      const values = params.field
        .slice(separator + 1)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (values.length === 0) return null;
      if (values.length > 1)
        throw new BridgeFailure("USAGE", "this host does not offer query.field-or: send one field value");
      if (LOGICAL_KIND_FIELDS.has(key))
        throw new BridgeFailure(
          "USAGE",
          `this host does not offer query.kind-projection: ${key} is a logical Kind field`,
        );
      if (byteLength(key) > MAX_QUERY_TEXT_BYTES || byteLength(values[0]!) > MAX_QUERY_TEXT_BYTES) throw invalid();
      input.fields = { [key]: values[0] };
    }
  }
  return input;
}
function readInput(docId: string) {
  const documentId = canonicalId(docId);
  if (documentId === null) throw new BridgeFailure("USAGE", "docId must be one canonical document id");
  return { documentId };
}
function boundedBody(body: string) {
  if (byteLength(body) > MAX_DOCUMENT_BODY_BYTES)
    throw new BridgeFailure("TOO_LARGE", "the document body exceeded the 1 MiB View limit");
  return body;
}
function readDocument(raw: unknown): ReadData {
  const data = raw as ReadData;
  boundedBody(data.document.body);
  return data;
}
/** `bundles.graph.v1` lists links by source and target, not by text, so `graph.relationships` is
 * sorted here by `(from, to, text)`, by code unit rather than locale so every browser answers the
 * same order. (`edges` arrives in the operation's own order, by code point.) */
function orderedEdges(edges: { from: string; to: string; text: string }[]) {
  return edges
    .map(({ from, to, text }) => ({ from, to, text }))
    .sort(
      (a, b) => compareCodeUnits(a.from, b.from) || compareCodeUnits(a.to, b.to) || compareCodeUnits(a.text, b.text),
    );
}
function operationFailure(error: { code: string; message: string }): BridgeFailure {
  switch (error.code) {
    case "document_not_found":
      return new BridgeFailure("NOT_FOUND", error.message);
    case "insufficient_scope":
    case "bundle_not_found":
    case "access_denied":
      return new BridgeFailure("REVOKED", "the View lost access while the request was running");
    case "invalid_input":
    case "validation_failed":
      return new BridgeFailure("USAGE", error.message);
    case "result_too_large":
      return new BridgeFailure("TOO_LARGE", error.message);
    default:
      return new BridgeFailure("RUNTIME", "the View request failed");
  }
}
function thrownFailure(error: unknown): BridgeFailure {
  if (error instanceof BridgeFailure) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DENIED_CODES.has(code))
    return new BridgeFailure("REVOKED", "the View lost access while the request was running");
  if (code === "invalid_input") return new BridgeFailure("USAGE", "invalid request");
  // The host's result ceiling throws a plain `invalid_response`; the adapter's shape check throws
  // its own error class with the same message, and only the ceiling is a size failure.
  if (!(error instanceof ReadAdapterError) && error instanceof Error && error.message === "invalid_response")
    return new BridgeFailure("TOO_LARGE", "the reply exceeded the host's result limit");
  return new BridgeFailure("RUNTIME", "the View request failed");
}
function translate(request: DataRequest, raw: unknown, render: ViewBridgeHostOptions["renderDocument"]): unknown {
  const envelope = raw as Envelope;
  if (!isPlainRecord(envelope) || typeof envelope.ok !== "boolean")
    throw new BridgeFailure("RUNTIME", "the View request failed");
  if (!envelope.ok) throw operationFailure(envelope.error);
  switch (request.kind) {
    case "query": {
      const data = envelope.data as {
        documents: { id: string; frontmatter: unknown; version: string }[];
        skipped?: { id: string; reason: string }[];
      };
      const rows = data.documents.map(({ id, version, frontmatter }) => ({ id, version, frontmatter }));
      // A document whose frontmatter does not parse is named, as the protocol's other hosts name it.
      const skipped = Array.isArray(data.skipped) ? data.skipped.map(({ id, reason }) => ({ id, reason })) : [];
      // Without `query.count` the count is the rows returned; a reply that filled the cap may have
      // left matching rows out, which `more` says.
      const cap = request.params.limit ? request.params.limit : MAX_QUERY_ROWS;
      return {
        rows,
        count: rows.length,
        ...(rows.length >= cap ? { more: true } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
      };
    }
    case "read": {
      const { document } = readDocument(envelope.data);
      return { id: document.id, frontmatter: document.frontmatter, body: document.body };
    }
    case "read-versioned": {
      const { document, version } = readDocument(envelope.data);
      return { doc: { id: document.id, frontmatter: document.frontmatter, body: document.body }, version };
    }
    case "render-document": {
      const { document, version } = readDocument(envelope.data);
      const rendered = render!({ id: document.id, body: document.body });
      return { document: { id: document.id, version }, html: rendered.html, bounded: rendered.bounded };
    }
    case "relationships": {
      // The operation's page as the protocol's: the neighbor, its label and title, and the
      // operation's own continuation as the opaque `cursor` the View sends back unchanged.
      const data = envelope.data as RelationshipsData;
      return {
        documentId: request.docId,
        rows: data.links.map(({ direction, documentId, label, title }) => ({ direction, documentId, label, title })),
        ...(data.next === undefined ? {} : { cursor: data.next }),
      };
    }
    case "edges": {
      // The operation's rows and order, as they are; above its cap it refuses (`result_too_large`).
      const edges = (envelope.data as { edges: { from: string; to: string; text: string }[] }).edges.map(
        ({ from, to, text }) => ({ from, to, text }),
      );
      return { edges, count: edges.length };
    }
    case "graph": {
      const data = envelope.data as GraphData;
      if (data.documents.length > GRAPH_MAX_DOCUMENTS)
        throw new BridgeFailure("TOO_LARGE", `the graph exceeded ${GRAPH_MAX_DOCUMENTS} documents`);
      if (data.relationships.length > GRAPH_MAX_RELATIONSHIPS)
        throw new BridgeFailure("TOO_LARGE", `the graph exceeded ${GRAPH_MAX_RELATIONSHIPS} relationships`);
      // A graph row must not carry a body that a plain read would refuse: one oversize body refuses
      // the whole request, with no partial rows.
      const documents = data.documents.map(({ id, version, frontmatter, body }) => ({
        id,
        version,
        frontmatter,
        ...(body === undefined ? {} : { body: boundedBody(body) }),
      }));
      const relationships = orderedEdges(data.relationships);
      return {
        okfVersion: data.okfVersion ?? "0.1",
        documents,
        relationships,
        counts: { documents: documents.length, relationships: relationships.length },
      };
    }
  }
}
const uiFailure: Record<Extract<ViewBridgeUiResult, { ok: false }>["code"], BridgeErrorCode> = {
  not_found: "NOT_FOUND",
  denied: "REVOKED",
  invalid_input: "USAGE",
  unsupported: "FORBIDDEN",
  busy: "RUNTIME",
  unavailable: "RUNTIME",
  cancelled: "RUNTIME",
};

/** The host for one View frame. `frame` is the frame's window (the only source whose messages are
 * admitted, and only from the opaque origin `"null"` a `sandbox="allow-scripts"` frame has);
 * `bundle` is fixed for the host's life; `execute` runs an operation on the person's behalf. The
 * page forwards every `message` event to `receive`, calls `refresh` when its data may have
 * changed, and `stop` when it removes the frame. */
export function createViewBridgeHost(
  frame: ViewBridgeFrame,
  bundle: ViewBridgeBundle,
  execute: ViewBridgeExecute,
  options: ViewBridgeHostOptions,
) {
  if (
    !Array.isArray(options.operations) ||
    options.operations.some((operation) => !VIEW_BRIDGE_OPERATIONS.includes(operation)) ||
    new Set(options.operations).size !== options.operations.length
  )
    throw new Error("Invalid View bridge operation subset");
  if (typeof bundle?.id !== "string" || !bundle.id || typeof bundle.name !== "string")
    throw new Error("Invalid View bridge bundle");
  const operations = new Set<ViewBridgeOperation>(options.operations);
  const bundleId = bundle.id;
  const admitted = () => options.admitted?.() !== false;
  const invalidate = () => options.invalidate?.();
  let stopped = false,
    ready = false,
    subscribed = false;
  const seen = new Set<string>();
  const active = new Map<string, AbortController>();
  const queue: { run: () => Promise<void>; settle: () => void }[] = [];
  /** Requests the frame sent are remembered in a sliding window, so a repeated id is refused as
   * `USAGE` while the first is pending or recently answered. */
  const remember = (id: string) => {
    if (seen.size >= SEEN_WINDOW) seen.delete(seen.values().next().value!);
    seen.add(id);
  };
  const post = (data: object) => {
    if (!stopped) frame.postMessage(data, "*");
  };
  const fail = (bridge: Bridge, id: string | undefined, code: BridgeErrorCode, message: string) =>
    post({ bridge, id, type: "error", error: { code, message } });
  const reply = (bridge: Bridge, id: string, type: string, result: unknown) => {
    const message = { bridge, id, type: `${type}:result`, result };
    if (byteLength(JSON.stringify(message)) > MAX_REPLY_BYTES)
      fail(bridge, id, "TOO_LARGE", "the bridge reply exceeded the 2 MiB safety limit");
    else post(message);
  };
  const actionAvailable = () =>
    operations.has("documents.read.v1") && operations.has("documents.update.v1") && !!options.proposeAction;
  let activeAction = false;
  const recordOpen = () =>
    operations.has("documents.read.v1") && !!options.openRecord && options.recordAvailable?.() !== false;
  const renderDocument = !!options.renderDocument;
  const openPage = !!options.openPage;
  async function invokeHost(request: Extract<ParsedRequest, { kind: "host" }>, documentId: string) {
    const controller = new AbortController();
    active.set(request.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      fail(request.bridge, request.id, "RUNTIME", "the record reader did not answer in time");
    }, HOST_INVOKE_TIMEOUT_MS);
    try {
      const result = await options.openRecord!(documentId, controller.signal);
      if (stopped || controller.signal.aborted || active.get(request.id) !== controller) return;
      if (!admitted()) {
        invalidate();
        return;
      }
      if (result.ok)
        reply(request.bridge, request.id, "host", { capability: request.capability, output: { opened: true } });
      else fail(request.bridge, request.id, uiFailure[result.code] ?? "RUNTIME", `record.open answered ${result.code}`);
    } catch {
      if (!timedOut) fail(request.bridge, request.id, "RUNTIME", "the record reader failed");
    } finally {
      clearTimeout(timer);
      active.delete(request.id);
    }
  }
  const allows = (request: DataRequest) =>
    operations.has(operationFor[request.kind]) &&
    (request.kind !== "render-document" || renderDocument) &&
    !(request.kind === "graph" && request.includeBodies && !operations.has("documents.read.v1"));
  async function invokeOperation(request: DataRequest) {
    const operation = operationFor[request.kind];
    const controller = new AbortController();
    active.set(request.id, controller);
    try {
      const input =
        request.kind === "query"
          ? queryInput(request.params)
          : request.kind === "edges"
            ? request.params
            : request.kind === "graph"
              ? request.includeBodies
                ? { includeBodies: true as const }
                : {}
              : request.kind === "relationships"
                ? { ...readInput(request.docId), ...(request.cursor ? { cursor: request.cursor } : {}) }
                : readInput(request.docId);
      if (input === null) {
        // A field filter with an empty value list matches nothing; no operation runs.
        reply(request.bridge, request.id, request.kind, { rows: [], count: 0 });
        return;
      }
      const raw = await execute(
        operation,
        Object.freeze({
          ...input,
          bundleId,
          ...(request.kind === "read-versioned" && actionAvailable() ? { includeViewActionContext: true } : {}),
        }),
        controller.signal,
      );
      if (stopped || controller.signal.aborted || active.get(request.id) !== controller) return;
      if (!admitted()) {
        invalidate();
        return;
      }
      reply(request.bridge, request.id, request.kind, translate(request, raw, options.renderDocument));
    } catch (error) {
      if (stopped || controller.signal.aborted) return;
      const failure = thrownFailure(error);
      fail(request.bridge, request.id, failure.code, failure.message);
    } finally {
      active.delete(request.id);
    }
  }
  function pump() {
    while (!stopped && active.size < MAX_IN_FLIGHT && queue.length > 0) {
      const entry = queue.shift()!;
      void entry.run().finally(() => {
        entry.settle();
        pump();
      });
    }
  }
  /** Executes `run` in one of the in-flight slots, FIFO behind the requests already waiting. The
   * returned promise settles when the request is answered or the host stops. */
  function enqueue(bridge: Bridge, id: string, run: () => Promise<void>) {
    if (queue.length >= MAX_PENDING) {
      fail(bridge, id, "RUNTIME", "too many pending requests");
      return Promise.resolve();
    }
    return new Promise<void>((settle) => {
      queue.push({
        settle,
        async run() {
          // The binding may have changed while the request waited; `admitted` is checked again at
          // the start of execution, as it is checked before and after every operation.
          if (stopped) return;
          if (!admitted()) {
            invalidate();
            return;
          }
          await run();
        },
      });
      pump();
    });
  }
  return {
    /** An empty `change` after `subscribe`: the refresh signal a host without deltas may send. */
    refresh() {
      if (stopped || !subscribed) return;
      if (!admitted()) {
        invalidate();
        return;
      }
      post({ bridge: BRIDGE_PROTOCOL, type: "change", event: { changes: [], removed: [] } });
    },
    /** The frame is gone, or about to be: nothing waiting is answered and nothing more is read. */
    stop() {
      stopped = true;
      for (const controller of active.values()) controller.abort();
      active.clear();
      seen.clear();
      // Waiting requests get no reply, and their callers are released.
      for (const entry of queue.splice(0)) entry.settle();
    },
    async receive(event: ViewBridgeMessage) {
      if (stopped || event.source !== frame || event.origin !== "null") return;
      const data = event.data;
      if (
        !isPlainRecord(data) ||
        (data.bridge !== BRIDGE_PROTOCOL && data.bridge !== ACTION_BRIDGE_PROTOCOL) ||
        typeof data.type !== "string"
      )
        return;
      let serialized: string;
      try {
        serialized = JSON.stringify(data);
      } catch {
        return;
      }
      if (data.bridge === ACTION_BRIDGE_PROTOCOL && data.type === "action.propose" && actionAvailable()) {
        const parsed = parseActionBridgeMessage(data);
        const id = boundedString(data.requestId, MAX_ACTION_REQUEST_ID_BYTES);
        if (!id) return;
        if (!parsed?.ok || parsed.message.type !== "action.propose") {
          post(actionReply(id, { status: "rejected", message: "Invalid View action proposal." }));
          return;
        }
        if (!admitted()) {
          invalidate();
          return;
        }
        if (seen.has(id) || activeAction) {
          post(
            actionReply(id, {
              status: "rejected",
              message: "A proposal is already active or this request was already used.",
            }),
          );
          return;
        }
        remember(id);
        activeAction = true;
        const controller = new AbortController();
        active.set(id, controller);
        try {
          const result = await options.proposeAction!(parsed.message.action, controller.signal);
          if (!stopped && admitted()) post(actionReply(id, result));
          else if (!stopped) invalidate();
        } catch {
          if (!stopped)
            post(
              actionReply(id, {
                status: "failed",
                writeState: "unknown",
                message: "The outcome is unknown. Read the document before another proposal.",
              }),
            );
        } finally {
          activeAction = false;
          active.delete(id);
        }
        return;
      }
      if (byteLength(serialized) > MAX_MESSAGE_BYTES) {
        // The one message with no reply is an oversize one whose id cannot be read cheaply: a
        // top-level string id under 256 bytes is echoed in a TOO_LARGE reply, anything else is
        // uncorrelatable and ignored. Nothing else the frame sends goes unanswered.
        const echo =
          boundedString(data.id, MAX_OVERSIZE_ECHO_ID_BYTES) ??
          boundedString(data.requestId, MAX_OVERSIZE_ECHO_ID_BYTES);
        if (echo)
          fail(data.bridge as Bridge, echo, "TOO_LARGE", "the bridge request exceeded the 64 KiB message limit");
        return;
      }
      if (!ready) {
        ready = true;
        options.onReady?.();
      }
      const request = parseBridgeRequest(data);
      if (request.kind === "refused") {
        fail(request.bridge, request.id, request.code, request.message);
        return;
      }
      if (request.kind === "open-page") {
        // The protocol's vocabulary for a host that navigates: a well-formed registry id the page
        // does not open (another bundle's View among them) is NOT_FOUND; a malformed envelope (a
        // document id, wrong keys, a non-string pageId) is USAGE as for every other request type; a
        // page without a resolver does not serve open-page at all, FORBIDDEN. Each echoes the id
        // when one was sent; a fire-and-forget request has no id to repeat, one with an id is
        // deduplicated.
        if (!openPage) {
          fail(request.bridge, request.id, "FORBIDDEN", "this host does not serve open-page");
          return;
        }
        if (request.pageId === null) {
          fail(request.bridge, request.id, "USAGE", "invalid open-page request");
          return;
        }
        if (request.id !== undefined) {
          if (seen.has(request.id)) {
            fail(request.bridge, request.id, "USAGE", "duplicate request id");
            return;
          }
          remember(request.id);
        }
        if (!admitted()) {
          invalidate();
          return;
        }
        if (options.openPage!(request.pageId) !== true)
          fail(request.bridge, request.id, "NOT_FOUND", "this host does not open that View");
        return;
      }
      if (seen.has(request.id)) {
        fail(request.bridge, request.id, "USAGE", "duplicate request id");
        return;
      }
      remember(request.id);
      if (!admitted()) {
        invalidate();
        return;
      }
      // hello, subscribe and every refusal answer at once; only work that reaches the transport or
      // the host reader takes one of the in-flight slots.
      if (request.kind === "hello") {
        reply(request.bridge, request.id, "hello", {
          // No address: the View is named by its bundle and registry id, never a path.
          bundle: { root: null, name: bundle.name },
          mode: "hosted",
          protocol: BRIDGE_PROTOCOL,
          grant: actionAvailable() ? "propose" : "read",
          ...(actionAvailable()
            ? { actionProtocol: "v1", actions: ["document.set-field", "document.set-body", "document.update"] }
            : {}),
          host: {
            kind: "hosted",
            capabilities: bridgeCapabilities(operations, {
              renderDocument,
              recordOpen: recordOpen(),
              frameResize: !!options.frame,
              openPage,
            }),
            limits: bridgeLimits(operations),
            // Additive descriptor fields: a View that ignores them draws as it does elsewhere.
            ...(options.frame
              ? {
                  frame: { title: "host", height: "content", maxHeight: options.frame.maxHeight },
                  ...(options.frame.theme ? { theme: options.frame.theme } : {}),
                }
              : {}),
          },
        });
        return;
      }
      if (request.kind === "subscribe") {
        subscribed = true;
        reply(request.bridge, request.id, "subscribe", { ok: true });
        return;
      }
      if (request.kind === "host") {
        if (request.capability === "frame.resize" && options.frame) {
          // Answered at once, like hello: a height report touches no bundle data.
          const height = frameResizeInput(request.input);
          if (height === null) fail(request.bridge, request.id, "USAGE", "frame.resize takes one height in CSS pixels");
          else
            reply(request.bridge, request.id, "host", {
              capability: request.capability,
              output: { height: options.frame.resize(height) },
            });
          return;
        }
        if (request.capability !== "record.open" || !recordOpen()) {
          fail(request.bridge, request.id, "FORBIDDEN", `this host does not offer ${request.capability}`);
          return;
        }
        const documentId =
          isPlainRecord(request.input) && exactKeys(request.input, ["documentId"])
            ? canonicalId(request.input.documentId)
            : null;
        if (documentId === null) {
          fail(request.bridge, request.id, "USAGE", "record.open takes one canonical documentId");
          return;
        }
        await enqueue(request.bridge, request.id, () => invokeHost(request, documentId));
        return;
      }
      if (!allows(request)) {
        fail(request.bridge, request.id, "FORBIDDEN", `this host does not offer ${request.kind}`);
        return;
      }
      await enqueue(request.bridge, request.id, () => invokeOperation(request));
    },
  };
}
export type ViewBridgeHost = ReturnType<typeof createViewBridgeHost>;
