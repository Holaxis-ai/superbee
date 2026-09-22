import {
  applyQuerySelectionFilters,
  loadKinds,
  projectLogicalKindFields,
  queryEdges,
  queryHeads,
  readBundleOkfVersion,
  readDocVersioned,
  type Bundle,
  type Frontmatter,
  type HeadResult,
  type KindConvention,
  type QuerySelectionParams,
} from "@superbee/core";
import { isAnyRegistryId, parseRegistration, type BridgeCapability } from "@superbee/core/page";

export const BRIDGE_PROTOCOL = "v0";
export const ACTION_BRIDGE_PROTOCOL = "v1";

const MAX_REQUEST_ID_BYTES = 128;
const MAX_DOC_ID_BYTES = 1024;
const MAX_SELECTOR_BYTES = 1024;
const MAX_SELECTOR_VALUES = 32;
const MAX_QUERY_ROWS = 500;
const MAX_EDGE_ROWS = 1_000;
const MAX_DOCUMENT_BODY_BYTES = 1024 * 1024;
/** Every bridge reply, `graph` included, is refused with `TOO_LARGE` above this serialized size. */
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
/** A `graph` reply carries at most this many documents; a larger bundle answers `TOO_LARGE`. */
export const GRAPH_MAX_DOCUMENTS = 1_000;
/** A `graph` reply carries at most this many relationships; a larger bundle answers `TOO_LARGE`. */
export const GRAPH_MAX_RELATIONSHIPS = 10_000;
const MAX_CHANGE_ROWS = 100;
const MAX_CHANGE_BYTES = 256 * 1024;
const MAX_SUBSCRIPTION_HEADS = 10_000;
const MAX_HOST_CAPABILITY_BYTES = 128;
const MAX_HOST_REQUEST_BYTES = 64 * 1024;
const HOST_CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Every bridge error code. docs/VIEW-PROTOCOL.md owns what each one means to a View author. */
export const BRIDGE_ERROR_CODES = ["USAGE", "FORBIDDEN", "REVOKED", "TOO_LARGE", "RUNTIME", "NOT_FOUND"] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export type BridgeHostKind = "oss" | "portal" | "hosted";

/** Host-declared ceilings. Zero means the host does not offer the request at all. */
export interface BridgeHostLimits {
  query: number;
  edges: number;
  graphDocuments: number;
  graphRelationships: number;
  replyBytes: number;
}

/** How a host that embeds the View as its page presents it. `title: "host"` means the host has
 * printed the View's name, so the View may hide its own masthead; `height: "content"` means the
 * host sizes the frame to the height the View reports through `frame.resize`, up to `maxHeight`
 * CSS pixels. A View that never reports keeps the host's floor and owns its own scroll; a View
 * reports a height or keeps the window, never both. */
export interface BridgeHostFrame {
  title: "host";
  height: "content";
  maxHeight: number;
}
/** The host's own resolved design tokens, each a CSS value string the View may adopt as `--sb-*`
 * custom properties. Never user input: a host reads them from its own stylesheet. */
export interface BridgeHostTheme {
  scheme: "light" | "dark";
  ground: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  focus: string;
  fontSans: string;
  fontDisplay: string;
  fontMono: string;
  radius: string;
  spacing: string;
}
/** What a host tells a View in the `hello` reply so the View can feature-detect instead of guess.
 * `frame` and `theme` are present only on a host that embeds the View as its page. */
export interface BridgeHostDescriptor {
  kind: BridgeHostKind;
  capabilities: readonly string[];
  limits: BridgeHostLimits;
  frame?: BridgeHostFrame;
  theme?: BridgeHostTheme;
}

/** The limits this service enforces. A host that runs the service declares exactly these. */
export const BRIDGE_SERVICE_LIMITS: BridgeHostLimits = Object.freeze({
  query: MAX_QUERY_ROWS,
  edges: MAX_EDGE_ROWS,
  graphDocuments: GRAPH_MAX_DOCUMENTS,
  graphRelationships: GRAPH_MAX_RELATIONSHIPS,
  replyBytes: MAX_REPLY_BYTES,
});

/**
 * Capability names a host may list in `hello.host.capabilities`. The registry of their meanings,
 * inputs and outputs is docs/VIEW-PROTOCOL.md; a host never invents a name outside it.
 */
export const BRIDGE_HOST_CAPABILITIES = Object.freeze({
  queryKindProjection: "query.kind-projection",
  queryFieldOr: "query.field-or",
  queryOpen: "query.open",
  queryCount: "query.count",
  edges: "edges",
  renderDocument: "render-document",
  openPage: "open-page",
  subscribeDeltas: "subscribe-deltas",
  graph: "graph",
  graphModel: "graph.model",
  recordOpen: "record.open",
  frameResize: "frame.resize",
} as const);
export type BridgeHostCapability = (typeof BRIDGE_HOST_CAPABILITIES)[keyof typeof BRIDGE_HOST_CAPABILITIES];

/** The query and read capabilities this service implements on every host that runs it. */
export const BRIDGE_SERVICE_CAPABILITIES: readonly BridgeHostCapability[] = Object.freeze([
  BRIDGE_HOST_CAPABILITIES.queryKindProjection,
  BRIDGE_HOST_CAPABILITIES.queryFieldOr,
  BRIDGE_HOST_CAPABILITIES.queryOpen,
  BRIDGE_HOST_CAPABILITIES.queryCount,
  BRIDGE_HOST_CAPABILITIES.edges,
  BRIDGE_HOST_CAPABILITIES.graph,
  BRIDGE_HOST_CAPABILITIES.renderDocument,
]);

export interface BridgeHostExtensionRequest {
  capability: string;
  input: Record<string, unknown> | undefined;
  launch: BridgeLaunch;
}

export type BridgeHostExtensionOutcome =
  | { ok: true; output: unknown }
  | { ok: false; code: BridgeErrorCode; message: string };

/** One handler per declared host extension capability; a registered name is always advertised. */
export type BridgeHostHandlers = Readonly<Record<string, (request: BridgeHostExtensionRequest) => Promise<BridgeHostExtensionOutcome>>>;

export interface BridgeLaunch {
  launchId: string;
  capability: BridgeCapability;
}

export interface BridgeLaunchAuthority {
  resolve(launchId: string, requireAuthorization: boolean): Promise<BridgeLaunch | null>;
  revoke(launchId: string): void;
}

export interface BridgeConfig {
  root: string | null;
  name: string;
  mode: string;
}

export interface BridgeOutcome {
  reply: Record<string, unknown> | null;
  subscribed?: boolean;
  openPageId?: string;
}

export type BridgePollOutcome =
  | { status: "unchanged" }
  | { status: "change"; generation: string; message: Record<string, unknown> }
  | { status: "reload-required"; message: string };

interface SubscriptionState {
  baseline: Map<string, string>;
  pending?: {
    generation: string;
    next: Map<string, string>;
    message: Record<string, unknown>;
  };
}

interface BaseRequest {
  bridge: typeof BRIDGE_PROTOCOL;
  id: string;
  type: "hello" | "query" | "read" | "render-document" | "edges" | "graph" | "subscribe" | "host";
}

interface HelloRequest extends BaseRequest {
  type: "hello";
}

interface QueryRequest extends BaseRequest {
  type: "query";
  params: QuerySelectionParams;
}

interface ReadRequest extends BaseRequest {
  type: "read";
  docId: string;
}

interface RenderDocumentRequest extends BaseRequest {
  type: "render-document";
  docId: string;
}

export interface EdgeParams {
  from?: string | string[];
  to?: string | string[];
  text?: string;
}

interface EdgesRequest extends BaseRequest {
  type: "edges";
  params: EdgeParams;
}

interface GraphRequest extends BaseRequest {
  type: "graph";
  includeBodies: boolean;
}

interface SubscribeRequest extends BaseRequest {
  type: "subscribe";
}

interface HostRequest extends BaseRequest {
  type: "host";
  capability: string;
  input?: Record<string, unknown>;
}

interface OpenPageRequest {
  bridge: typeof BRIDGE_PROTOCOL;
  type: "open-page";
  id?: string;
  pageId: string;
}

interface ReadVersionedRequest {
  bridge: typeof ACTION_BRIDGE_PROTOCOL;
  type: "read-versioned";
  id: string;
  docId: string;
}

type ParsedBridgeRequest =
  | HelloRequest
  | QueryRequest
  | ReadRequest
  | RenderDocumentRequest
  | EdgesRequest
  | GraphRequest
  | SubscribeRequest
  | HostRequest
  | OpenPageRequest
  | ReadVersionedRequest;

const V0_REQUEST_TYPES = new Set(["hello", "query", "read", "render-document", "edges", "graph", "subscribe", "host", "open-page"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    return null;
  }
  return value;
}

function requestId(value: unknown): string | null {
  return boundedString(value, MAX_REQUEST_ID_BYTES);
}

function invalidV0RequestId(value: unknown): string | undefined {
  if (!isPlainRecord(value) || value.bridge !== BRIDGE_PROTOCOL || typeof value.type !== "string") {
    return undefined;
  }
  return requestId(value.id) ?? undefined;
}

function normalizeQueryParams(raw: unknown): QuerySelectionParams | null {
  if (!isPlainRecord(raw)) return null;
  const allowed = new Set(["type", "prefix", "field", "open", "limit"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const out: QuerySelectionParams = {};
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
    if (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 0 || (raw.limit as number) > MAX_QUERY_ROWS) {
      return null;
    }
    out.limit = raw.limit as number;
  }
  return out;
}

function selector(value: unknown): string | string[] | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.trim() && Buffer.byteLength(value, "utf8") <= MAX_SELECTOR_BYTES ? value : null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SELECTOR_VALUES) return null;
  const selectors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    if (!entry.trim() || Buffer.byteLength(entry, "utf8") > MAX_SELECTOR_BYTES) return null;
    selectors.push(entry);
  }
  return selectors;
}

function normalizeEdgeParams(raw: unknown): EdgeParams | null {
  if (!isPlainRecord(raw)) return null;
  const allowed = new Set(["from", "to", "text"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const from = selector(raw.from);
  const to = selector(raw.to);
  if (from === null || to === null) return null;
  const out: EdgeParams = {};
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  if (raw.text !== undefined) {
    const text = boundedString(raw.text, MAX_SELECTOR_BYTES);
    if (!text?.trim()) return null;
    out.text = text;
  }
  return out;
}

export function parseBridgeRequest(value: unknown): ParsedBridgeRequest | null {
  if (!isPlainRecord(value) || typeof value.bridge !== "string" || typeof value.type !== "string") {
    return null;
  }
  if (value.bridge === ACTION_BRIDGE_PROTOCOL && value.type === "read-versioned") {
    if (!exactKeys(value, ["bridge", "type", "id", "docId"])) return null;
    const id = requestId(value.id);
    const docId = boundedString(value.docId, MAX_DOC_ID_BYTES);
    return id && docId
      ? { bridge: ACTION_BRIDGE_PROTOCOL, type: "read-versioned", id, docId }
      : null;
  }
  if (value.bridge !== BRIDGE_PROTOCOL) return null;
  if (value.type === "open-page") {
    const expected = value.id === undefined
      ? ["bridge", "type", "pageId"]
      : ["bridge", "type", "id", "pageId"];
    if (!exactKeys(value, expected)) return null;
    if (value.id !== undefined && requestId(value.id) === null) return null;
    if (!isAnyRegistryId(value.pageId)) return null;
    return {
      bridge: BRIDGE_PROTOCOL,
      type: "open-page",
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      pageId: value.pageId,
    };
  }
  const id = requestId(value.id);
  if (!id) return null;
  if (value.type === "hello" || value.type === "subscribe") {
    if (!exactKeys(value, ["bridge", "type", "id"])) return null;
    return { bridge: BRIDGE_PROTOCOL, type: value.type, id };
  }
  if (value.type === "read" || value.type === "render-document") {
    if (!exactKeys(value, ["bridge", "type", "id", "docId"])) return null;
    const docId = boundedString(value.docId, MAX_DOC_ID_BYTES);
    return docId ? { bridge: BRIDGE_PROTOCOL, type: value.type, id, docId } : null;
  }
  if (value.type === "query") {
    if (!exactKeys(value, ["bridge", "type", "id", "params"])) return null;
    const params = normalizeQueryParams(value.params);
    return params ? { bridge: BRIDGE_PROTOCOL, type: "query", id, params } : null;
  }
  if (value.type === "edges") {
    if (!exactKeys(value, ["bridge", "type", "id", "params"])) return null;
    const params = normalizeEdgeParams(value.params);
    return params ? { bridge: BRIDGE_PROTOCOL, type: "edges", id, params } : null;
  }
  if (value.type === "graph") {
    const expected = value.includeBodies === undefined
      ? ["bridge", "type", "id"]
      : ["bridge", "type", "id", "includeBodies"];
    if (!exactKeys(value, expected)) return null;
    if (value.includeBodies !== undefined && typeof value.includeBodies !== "boolean") return null;
    return { bridge: BRIDGE_PROTOCOL, type: "graph", id, includeBodies: value.includeBodies === true };
  }
  if (value.type === "host") {
    const expected = value.input === undefined
      ? ["bridge", "type", "id", "capability"]
      : ["bridge", "type", "id", "capability", "input"];
    if (!exactKeys(value, expected)) return null;
    const capability = boundedString(value.capability, MAX_HOST_CAPABILITY_BYTES);
    if (!capability || !HOST_CAPABILITY_NAME.test(capability)) return null;
    if (value.input !== undefined && !isPlainRecord(value.input)) return null;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return null;
    }
    if (bytes > MAX_HOST_REQUEST_BYTES) return null;
    return {
      bridge: BRIDGE_PROTOCOL,
      type: "host",
      id,
      capability,
      ...(value.input === undefined ? {} : { input: value.input as Record<string, unknown> }),
    };
  }
  return null;
}

/**
 * A well-formed envelope whose type this service does not offer: a write, or a type outside the
 * contract. Refused with FORBIDDEN so a View can tell "not offered here" from a malformed request.
 */
function unsupportedRequest(value: unknown): { bridge: string; id: string | undefined } | null {
  if (!isPlainRecord(value) || typeof value.type !== "string") return null;
  if (value.bridge === BRIDGE_PROTOCOL) {
    return V0_REQUEST_TYPES.has(value.type) ? null : { bridge: BRIDGE_PROTOCOL, id: requestId(value.id) ?? undefined };
  }
  if (value.bridge === ACTION_BRIDGE_PROTOCOL) {
    if (value.type === "read-versioned") return null;
    const id = value.type === "action.propose" ? value.requestId : value.id;
    return { bridge: ACTION_BRIDGE_PROTOCOL, id: requestId(id) ?? undefined };
  }
  return null;
}

function ok(id: string | undefined, bridge: string, type: string, result: unknown): Record<string, unknown> {
  return { bridge, id, type: `${type}:result`, result };
}

function fail(id: string | undefined, bridge: string, code: string, message: string): Record<string, unknown> {
  return { bridge, id, type: "error", error: { code, message } };
}

function replyWithinLimit(reply: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(reply), "utf8") <= MAX_REPLY_BYTES;
}

function boundedRows(rows: HeadResult[], params: QuerySelectionParams, kinds: KindConvention[]): {
  rows: HeadResult[];
  count: number;
} {
  const requested = params.limit === 0 || params.limit === undefined
    ? MAX_QUERY_ROWS
    : Math.min(params.limit, MAX_QUERY_ROWS);
  return applyQuerySelectionFilters(rows, { ...params, limit: requested }, kinds);
}

export interface BridgeServiceOptions {
  bundle: Bundle;
  launches: BridgeLaunchAuthority;
  config: () => Promise<BridgeConfig>;
  renderDocument: BridgeDocumentRenderer;
  /** Declared to every View in `hello`; the runtime that embeds the service owns kind and capabilities. */
  host: BridgeHostDescriptor;
  /** Host extension capabilities answered through the reserved `host` request. */
  hostHandlers?: BridgeHostHandlers;
  enablePolling?: boolean;
  /** Retire the source launch before returning an open-page selection to a host-owned resolver. */
  consumeOpenPage?: boolean;
}

export interface BridgeDocumentRendererInput {
  id: string;
  body: string;
}

export interface BridgeDocumentRendererResult {
  html: string;
  bounded: boolean;
}

export type BridgeDocumentRenderer = (
  document: BridgeDocumentRendererInput,
) => BridgeDocumentRendererResult;

/**
 * Server-owned semantic authority for the View bridge. Host shells only validate their current
 * child and forward an opaque launch id plus one bounded request.
 */
export class BridgeService {
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private nextPollGeneration = 0;

  constructor(private readonly options: BridgeServiceOptions) {}

  async handle(launchId: string, rawRequest: unknown): Promise<BridgeOutcome> {
    const request = parseBridgeRequest(rawRequest);
    if (!request) {
      const unsupported = unsupportedRequest(rawRequest);
      if (unsupported) {
        return {
          reply: fail(
            unsupported.id,
            unsupported.bridge,
            "FORBIDDEN",
            "this host does not offer the requested bridge operation",
          ),
        };
      }
      return {
        reply: fail(
          invalidV0RequestId(rawRequest),
          BRIDGE_PROTOCOL,
          "USAGE",
          "invalid or unsupported bridge request",
        ),
      };
    }
    const dataBearing = request.type !== "open-page";
    const before = await this.options.launches.resolve(launchId, dataBearing);
    if (!before) {
      return { reply: fail(request.id, request.bridge, "FORBIDDEN", "the View launch is unknown, changed, expired, or not locally authorized") };
    }
    if (
      dataBearing &&
      before.capability !== "bundle-read" &&
      before.capability !== "bundle-propose"
    ) {
      return { reply: fail(request.id, request.bridge, "FORBIDDEN", "this View has no bundle-data access") };
    }

    let outcome: BridgeOutcome;
    try {
      outcome = await this.execute(before, request);
    } catch {
      outcome = {
        reply: fail(
          request.id,
          request.bridge,
          "RUNTIME",
          "the View request failed",
        ),
      };
    }

    if (
      request.type === "open-page" &&
      this.options.consumeOpenPage === true &&
      outcome.openPageId !== undefined
    ) {
      return outcome;
    }

    const after = await this.options.launches.resolve(launchId, dataBearing);
    if (!after) {
      this.revoke(launchId);
      return { reply: fail(request.id, request.bridge, "REVOKED", "the View changed while the request was running") };
    }
    if (outcome.reply && !replyWithinLimit(outcome.reply)) {
      return { reply: fail(request.id, request.bridge, "TOO_LARGE", "the bridge reply exceeded the 2 MiB safety limit") };
    }
    return outcome;
  }

  /**
   * Poll a server-owned subscription snapshot. A delivered change remains pending until the host
   * acknowledges its generation on the next poll, so a failed frame delivery is retried rather
   * than silently advancing freshness state.
   */
  async poll(launchId: string, acknowledgeGeneration?: string): Promise<BridgePollOutcome> {
    const before = await this.options.launches.resolve(launchId, true);
    if (!before) return this.reload(launchId, "the View launch changed, expired, or lost authorization");
    const subscription = this.subscriptions.get(launchId);
    if (!subscription) return this.reload(launchId, "the View has no current subscription baseline");

    if (acknowledgeGeneration !== undefined) {
      if (subscription.pending?.generation !== acknowledgeGeneration) {
        return this.reload(launchId, "the View poll acknowledgement did not match the pending generation");
      }
      subscription.baseline = subscription.pending.next;
      subscription.pending = undefined;
    }
    if (subscription.pending) {
      return {
        status: "change",
        generation: subscription.pending.generation,
        message: subscription.pending.message,
      };
    }

    let next: Map<string, string>;
    try {
      next = await this.subscriptionSnapshot();
    } catch {
      return this.reload(launchId, "the View subscription could not be refreshed");
    }
    const after = await this.options.launches.resolve(launchId, true);
    if (!after) return this.reload(launchId, "the View changed while its subscription was polled");

    const changes: { id: string; version: string }[] = [];
    const removed: string[] = [];
    for (const [id, version] of next) {
      if (subscription.baseline.get(id) !== version) changes.push({ id, version });
    }
    for (const id of subscription.baseline.keys()) {
      if (!next.has(id)) removed.push(id);
    }
    changes.sort((a, b) => a.id.localeCompare(b.id));
    removed.sort();
    if (changes.length === 0 && removed.length === 0) return { status: "unchanged" };
    if (changes.length > MAX_CHANGE_ROWS || removed.length > MAX_CHANGE_ROWS) {
      return this.reload(launchId, "the View change set exceeded the polling safety limit");
    }
    const message = changeMessage(changes, removed);
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_CHANGE_BYTES) {
      return this.reload(launchId, "the View change set exceeded the polling byte limit");
    }
    const generation = String(++this.nextPollGeneration);
    subscription.pending = { generation, next, message };
    return { status: "change", generation, message };
  }

  revoke(launchId: string): void {
    this.subscriptions.delete(launchId);
    this.options.launches.revoke(launchId);
  }

  private reload(launchId: string, message: string): BridgePollOutcome {
    this.revoke(launchId);
    return { status: "reload-required", message };
  }

  private async subscriptionSnapshot(): Promise<Map<string, string>> {
    const rows = await queryHeads(this.options.bundle, {});
    if (rows.length > MAX_SUBSCRIPTION_HEADS) {
      throw new Error("the bundle is too large for the experimental View polling snapshot");
    }
    return new Map(
      [...rows]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((row) => [row.id, row.version]),
    );
  }

  /**
   * Whole-bundle projection for graph-shaped Views. The documents come from one head scan and
   * the relationships from `queryEdges`, which is a second full-bundle scan; the two scans are
   * accepted because the reply is bounded by the exported graph limits and the host never
   * caches bundle state on a View's behalf. No `model` or `definitions` are answered here: the
   * owner of that shape is undecided, and a host that has one declares the `graph.model`
   * capability before adding them.
   */
  private async graph(launch: BridgeLaunch, request: GraphRequest): Promise<BridgeOutcome> {
    const heads = await queryHeads(this.options.bundle, {});
    if (heads.length > GRAPH_MAX_DOCUMENTS) {
      return {
        reply: fail(request.id, request.bridge, "TOO_LARGE", `the graph exceeded ${GRAPH_MAX_DOCUMENTS} documents`),
      };
    }
    const [registry, declaredOkfVersion, edges] = await Promise.all([
      loadKinds(this.options.bundle),
      readBundleOkfVersion(this.options.bundle),
      queryEdges(this.options.bundle, {}),
    ]);
    if (edges.length > GRAPH_MAX_RELATIONSHIPS) {
      return {
        reply: fail(request.id, request.bridge, "TOO_LARGE", `the graph exceeded ${GRAPH_MAX_RELATIONSHIPS} relationships`),
      };
    }
    const okfVersion = declaredOkfVersion ?? "0.1";
    const includeBodies = request.includeBodies &&
      (launch.capability === "bundle-read" || launch.capability === "bundle-propose");
    const documents: { id: string; version: string; frontmatter: Frontmatter; body?: string }[] = [];
    for (const head of heads) {
      // Bodies are read per document so that a document's body and version stay one read; the
      // head scan is only the bounded identity list.
      const source: { version: string; frontmatter: Frontmatter; body?: string } = includeBodies
        ? await readDocVersioned(this.options.bundle, head.id).then((result) => ({
          version: result.version,
          frontmatter: result.doc.frontmatter,
          body: result.doc.body,
        }))
        : { version: head.version, frontmatter: head.frontmatter };
      // A graph row must not carry a body that a plain read would refuse.
      if (source.body !== undefined && Buffer.byteLength(source.body, "utf8") > MAX_DOCUMENT_BODY_BYTES) {
        return { reply: fail(request.id, request.bridge, "TOO_LARGE", "a document body exceeded the 1 MiB View limit") };
      }
      const kind = registry.kinds.get(String(source.frontmatter.type ?? ""));
      const frontmatter = kind
        ? projectLogicalKindFields(okfVersion, kind, source.frontmatter)
        : source.frontmatter;
      documents.push({
        id: head.id,
        version: source.version,
        frontmatter,
        ...(source.body === undefined ? {} : { body: source.body }),
      });
    }
    const relationships = edges.map(({ from, to, text }) => ({ from, to, text }));
    return {
      reply: ok(request.id, request.bridge, request.type, {
        okfVersion,
        documents,
        relationships,
        counts: { documents: documents.length, relationships: relationships.length },
      }),
    };
  }

  private hostDescriptor(): BridgeHostDescriptor {
    const declared = new Set<string>(this.options.host.capabilities);
    for (const name of Object.keys(this.options.hostHandlers ?? {})) declared.add(name);
    return {
      kind: this.options.host.kind,
      capabilities: [...declared].sort(),
      limits: { ...this.options.host.limits },
      ...(this.options.host.frame ? { frame: { ...this.options.host.frame } } : {}),
      ...(this.options.host.theme ? { theme: { ...this.options.host.theme } } : {}),
    };
  }

  private async execute(launch: BridgeLaunch, request: ParsedBridgeRequest): Promise<BridgeOutcome> {
    if (request.type === "open-page") {
      if (this.options.consumeOpenPage === true) {
        this.revoke(launch.launchId);
        return { reply: null, openPageId: request.pageId };
      }
      try {
        const target = await readDocVersioned(this.options.bundle, request.pageId);
        if (!isAnyRegistryId(target.doc.id) || !parseRegistration(target.doc.id, target.doc.frontmatter)) {
          throw new Error("invalid View target");
        }
        return { reply: null, openPageId: request.pageId };
      } catch {
        return { reply: fail(request.id, request.bridge, "NOT_FOUND", `View '${request.pageId}' is not available`) };
      }
    }
    if (request.type === "hello") {
      const config = await this.options.config();
      return {
        reply: ok(request.id, request.bridge, request.type, {
          bundle: { root: config.root, name: config.name },
          mode: config.mode,
          protocol: BRIDGE_PROTOCOL,
          grant: launch.capability === "bundle-propose" ? "propose" : "read",
          ...(config.mode === "dir" && this.options.host.kind === "oss" && launch.capability === "bundle-propose"
            ? { actions: ["document.set-field", "document.set-body"] } : {}),
          host: this.hostDescriptor(),
        }),
      };
    }
    if (request.type === "host") {
      const handlers = this.options.hostHandlers ?? {};
      if (!Object.hasOwn(handlers, request.capability)) {
        return { reply: fail(request.id, request.bridge, "FORBIDDEN", "this host does not offer the requested capability") };
      }
      const outcome = await handlers[request.capability]!({
        capability: request.capability,
        input: request.input,
        launch,
      });
      if (!outcome.ok) return { reply: fail(request.id, request.bridge, outcome.code, outcome.message) };
      return { reply: ok(request.id, request.bridge, request.type, { capability: request.capability, output: outcome.output }) };
    }
    if (request.type === "query") {
      const rows = await queryHeads(this.options.bundle, {
        ...(request.params.type ? { type: request.params.type } : {}),
        ...(request.params.prefix ? { prefix: request.params.prefix } : {}),
      });
      // Every View query is a product-facing projection, including untyped feeds such as Pulse.
      // Resolve logical Kind fields here once so durable web and MCP Views never need to know the
      // physical coordinate selected by a bundle edition.
      const [registry, okfVersion] = await Promise.all([
        loadKinds(this.options.bundle),
        readBundleOkfVersion(this.options.bundle),
      ]);
      const result = boundedRows(
        rows,
        { ...request.params, okfVersion },
        [...registry.kinds.values()],
      );
      result.rows = result.rows.map((row) => {
        const kind = registry.kinds.get(String(row.frontmatter.type ?? ""));
        return kind
          ? { ...row, frontmatter: projectLogicalKindFields(okfVersion, kind, row.frontmatter) }
          : row;
      });
      return { reply: ok(request.id, request.bridge, request.type, result) };
    }
    if (request.type === "read" || request.type === "read-versioned") {
      const [result, registry, okfVersion] = await Promise.all([
        readDocVersioned(this.options.bundle, request.docId),
        loadKinds(this.options.bundle),
        readBundleOkfVersion(this.options.bundle),
      ]);
      if (Buffer.byteLength(result.doc.body, "utf8") > MAX_DOCUMENT_BODY_BYTES) {
        return { reply: fail(request.id, request.bridge, "TOO_LARGE", "the document body exceeded the 1 MiB View limit") };
      }
      const kind = registry.kinds.get(String(result.doc.frontmatter.type ?? ""));
      const projectedDoc = kind
        ? { ...result.doc, frontmatter: projectLogicalKindFields(okfVersion, kind, result.doc.frontmatter) }
        : result.doc;
      return {
        reply: ok(
          request.id,
          request.bridge,
          request.type,
          request.type === "read" ? projectedDoc : { ...result, doc: projectedDoc },
        ),
      };
    }
    if (request.type === "render-document") {
      let result;
      try {
        result = await readDocVersioned(this.options.bundle, request.docId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return {
            reply: fail(
              request.id,
              request.bridge,
              "NOT_FOUND",
              `Document '${request.docId}' is not available`,
            ),
          };
        }
        throw error;
      }
      if (Buffer.byteLength(result.doc.body, "utf8") > MAX_DOCUMENT_BODY_BYTES) {
        return { reply: fail(request.id, request.bridge, "TOO_LARGE", "the document body exceeded the 1 MiB View limit") };
      }
      const rendered = this.options.renderDocument({ id: result.doc.id, body: result.doc.body });
      return {
        reply: ok(request.id, request.bridge, request.type, {
          document: { id: result.doc.id, version: result.version },
          html: rendered.html,
          bounded: rendered.bounded,
        }),
      };
    }
    if (request.type === "edges") {
      const edges = await queryEdges(this.options.bundle, request.params);
      if (edges.length > MAX_EDGE_ROWS) {
        return { reply: fail(request.id, request.bridge, "TOO_LARGE", `the edge query exceeded ${MAX_EDGE_ROWS} rows`) };
      }
      const projected = edges.map(({ from, to, text }) => ({ from, to, text }));
      return { reply: ok(request.id, request.bridge, request.type, { edges: projected, count: projected.length }) };
    }
    if (request.type === "graph") {
      return this.graph(launch, request);
    }
    if (this.options.enablePolling) {
      this.subscriptions.set(launch.launchId, {
        baseline: await this.subscriptionSnapshot(),
      });
    }
    return { reply: ok(request.id, request.bridge, request.type, { ok: true }), subscribed: true };
  }
}

export function changeMessage(
  changes: { id: string; version: string }[],
  removed: string[],
): Record<string, unknown> {
  const boundedChanges = changes.slice(0, MAX_QUERY_ROWS);
  const boundedRemoved = removed.slice(0, MAX_QUERY_ROWS);
  return {
    bridge: BRIDGE_PROTOCOL,
    type: "change",
    event: { changes: boundedChanges, removed: boundedRemoved },
  };
}
