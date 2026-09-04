import {
  applyQuerySelectionFilters,
  loadKinds,
  projectLogicalKindFields,
  queryEdges,
  queryHeads,
  readBundleOkfVersion,
  readDocVersioned,
  type Bundle,
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
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_CHANGE_ROWS = 100;
const MAX_CHANGE_BYTES = 256 * 1024;
const MAX_SUBSCRIPTION_HEADS = 10_000;

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
  type: "hello" | "query" | "read" | "render-document" | "edges" | "subscribe";
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

interface SubscribeRequest extends BaseRequest {
  type: "subscribe";
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
  | SubscribeRequest
  | OpenPageRequest
  | ReadVersionedRequest;

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
  allowActionProtocol?: boolean;
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
      return {
        reply: fail(
          invalidV0RequestId(rawRequest),
          BRIDGE_PROTOCOL,
          "USAGE",
          "invalid or unsupported bridge request",
        ),
      };
    }
    if (request.bridge === ACTION_BRIDGE_PROTOCOL && this.options.allowActionProtocol === false) {
      return {
        reply: fail(
          request.id,
          request.bridge,
          "FORBIDDEN",
          "this host admits only the read-only v0 View bridge",
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
        }),
      };
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
