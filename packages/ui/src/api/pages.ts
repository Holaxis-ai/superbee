/**
 * Pages-spike API surface (tasks/ui-pages-spike), layered on the same-origin `/v0/*` client
 * (`client.ts`) plus two shell-only local endpoints the pages server adds:
 *   - `GET /__ui/config` — bundle summary for the launcher + the bridge `hello` reply.
 *   - `POST /__page/mint` — resolve a View to one immutable launch with a single-use nonce URL.
 *   - `GET /__page/<nonce>` — the shell's one fetch of that launch's exact HTML bytes, verified
 *     against the approved content version before the View host mounts them as a `blob:` frame.
 *   Both are session-gated (cookie + X-Requested-With), so a View — which holds neither — can
 *   never mint or fetch its own.
 *
 * A page's HTML never rides the model/query path: only its registry doc (frontmatter) is read
 * here; the bytes travel opaquely from the nonce route to the View host.
 */
import { getDoc, parseErrorEnvelope } from "./client.js";
import type { Edge, EdgesResponse, Frontmatter } from "./types.js";
import type { KindConvention } from "@superbee/core/kinds";
import type { ActionConfirmation, ActionPrepareResult, ActionTerminalResult, DocumentAction, SharingSummary, WorkspaceSummaryEntry } from "@superbee/ui-server";
import { parseRegisteredPage, type BridgeCapability } from "../pages/registry.js";

/** `/__ui/config` shape (server `configResponse`). `sharing`/`workspaces` are ui-server's plain data shapes (type-only import — no runtime dependency), CLI-injected in dir mode. */
export interface UiConfig {
  mode: string;
  remoteUrl: string | null;
  root: string | null;
  name: string;
  sharing: SharingSummary | null;
  workspaces: WorkspaceSummaryEntry[];
}

/** A `type: View` registry doc, projected to the launcher's card fields (provenance included). */
export interface PageEntry {
  id: string;
  version: string;
  title: string;
  description?: string;
  actor?: string;
  timestamp?: string;
  presentation?: "workspace" | "inline" | "adaptive";
  /** The server-enforced bridge capability — groups the launcher. */
  bridge: BridgeCapability;
}

export async function fetchConfig(): Promise<UiConfig> {
  const res = await fetch("/__ui/config", { credentials: "same-origin" });
  if (!res.ok) throw await parseErrorEnvelope(res);
  return (await res.json()) as UiConfig;
}

/** CLI-rendered, host-shell-safe recovery command for one document. */
export async function fetchDocumentOpenCommand(documentId: string): Promise<string> {
  const query = new URLSearchParams({ id: documentId });
  const res = await fetch(`/__ui/document-open-command?${query.toString()}`, { credentials: "same-origin" });
  if (!res.ok) throw await parseErrorEnvelope(res);
  const payload = (await res.json()) as { command: string };
  return payload.command;
}

/**
 * Every valid durable View from the server-owned shared catalog. Discovery no longer re-runs in
 * the browser: the web launcher, CLI, and MCP all consume the same runtime projection.
 */
export async function listPages(): Promise<PageEntry[]> {
  const res = await fetch("/__ui/views", { credentials: "same-origin" });
  if (!res.ok) throw await parseErrorEnvelope(res);
  const payload = (await res.json()) as {
    views?: Array<{
      id: string;
      version: string;
      title: string;
      access: BridgeCapability;
      description?: string;
      actor?: string;
      timestamp?: string;
      presentation?: "workspace" | "inline" | "adaptive";
    }>;
  };
  return (payload.views ?? []).map((entry) => ({
    id: entry.id,
    version: entry.version,
    title: entry.title,
    bridge: entry.access,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.actor ? { actor: entry.actor } : {}),
    ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
    ...(entry.presentation ? { presentation: entry.presentation } : {}),
  }));
}

/** Exported for the `bridge` fail-closed-default unit test (pages.test.ts) — not otherwise a public API. */
export function pageFromFrontmatter(id: string, version: string, fm: Frontmatter): PageEntry | null {
  const page = parseRegisteredPage(id, fm);
  if (!page) return null;
  return {
    id: page.id,
    version,
    title: page.title,
    description: page.description,
    actor: page.actor,
    timestamp: page.timestamp,
    bridge: page.bridge,
  };
}

/** Narrow navigation resolver: return only whether an id is a usable registered Page. */
export async function resolvePageTarget(pageId: string): Promise<boolean> {
  try {
    const { doc } = await getDoc(pageId);
    return parseRegisteredPage(doc.id, doc.frontmatter) !== null;
  } catch {
    return false;
  }
}

/**
 * `GET /__ui/kinds` — the bundle's kind registry, serialized by the server from core's
 * `loadKinds` (ONE registry; the browser consumes it, never re-implements discovery).
 * Feeds the bridge's `open` filter. Cached until {@link invalidateKinds}; errors yield an empty
 * registry (=> `open` filters nothing — `list --open`'s posture on a terminal-free bundle).
 */
export interface KindContext {
  kinds: KindConvention[];
  /** Internal storage edition used to project stable product-level field names. */
  okfVersion: string;
}

let kindsCache: Promise<KindContext> | null = null;

export function fetchKindContext(): Promise<KindContext> {
  kindsCache ??= (async () => {
    try {
      const res = await fetch("/__ui/kinds", { credentials: "same-origin" });
      if (!res.ok) return { kinds: [], okfVersion: "0.1" };
      const body = (await res.json()) as { kinds?: KindConvention[]; okfVersion?: string };
      return {
        kinds: Array.isArray(body.kinds) ? body.kinds : [],
        okfVersion: typeof body.okfVersion === "string" ? body.okfVersion : "0.1",
      };
    } catch {
      return { kinds: [], okfVersion: "0.1" };
    }
  })();
  return kindsCache;
}

export function fetchKinds(): Promise<KindConvention[]> {
  return fetchKindContext().then(({ kinds }) => kinds);
}

/** Drop the cached kind registry when a `conventions/` doc moved (`ids` = changed+removed doc ids from a change event), or unconditionally when `ids` is omitted (the SSE-resync case: anything may have changed during the gap). */
export function invalidateKinds(ids?: string[]): void {
  if (ids === undefined || ids.some((id) => id.startsWith("conventions/"))) kindsCache = null;
}

/**
 * `GET /__ui/edges?from=&to=&text=` — the bundle's derived edge list (core's `queryEdges`,
 * server-proxied), for the bridge's `edges` request. `from`/`to` each accept an id, a
 * trailing-slash prefix, or an array-union of either — sent as repeated query params (the
 * server's `EdgeFilter` union, mirroring `link list --from/--to`); `text` is exact-match. Unlike
 * `fetchKinds` (an auxiliary display filter, best-effort), this is primary data like `query`/`read`
 * — a non-2xx throws the SAME typed {@link ApiError} they do, so a dead session (403) reaches the
 * bridge's error reply / the interceptor instead of masquerading as "zero edges".
 */
export async function fetchEdges(params: { from?: string | string[]; to?: string | string[]; text?: string }): Promise<Edge[]> {
  const query = new URLSearchParams();
  for (const from of toArray(params.from)) query.append("from", from);
  for (const to of toArray(params.to)) query.append("to", to);
  if (params.text) query.set("text", params.text);
  const res = await fetch(`/__ui/edges?${query.toString()}`, { credentials: "same-origin" });
  if (!res.ok) throw await parseErrorEnvelope(res);
  const body = (await res.json()) as EdgesResponse;
  return Array.isArray(body.edges) ? body.edges : [];
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export interface MintedView {
  url: string;
  launchId: string;
  title: string;
  entry: string;
  capability: BridgeCapability;
  authorization: {
    required: boolean;
    authorized: boolean;
    contentVersion: string;
  };
}

export interface ViewAuthorizationStatus {
  required: boolean;
  authorized: boolean;
}

export interface ViewDeliveryStatus {
  delivered: boolean;
}

export interface ViewBridgeOutcome {
  reply: Record<string, unknown> | null;
  subscribed?: boolean;
  openPageId?: string;
}

/** Resolve one registry doc and its exact HTML bytes to an immutable server-owned launch. */
export async function mintPageNonce(registryId: string): Promise<MintedView> {
  const res = await fetch("/__page/mint", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "X-Requested-With": "superbee-ui" },
    body: JSON.stringify({ registryId }),
  });
  if (!res.ok) throw await parseErrorEnvelope(res);
  return (await res.json()) as MintedView;
}

export interface ViewBytes {
  bytes: ArrayBuffer;
  contentType: string;
}

/** The fetched bytes are not the version the launch (and any approval) named. */
export class ViewBytesMismatchError extends Error {
  constructor() {
    super("the View's HTML did not match the version that was approved; reopen the View from the launcher");
    this.name = "ViewBytesMismatchError";
  }
}

async function sha256Version(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("this browser cannot verify View bytes (Web Crypto is unavailable)");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fetch a launch's exact HTML once through its single-use nonce URL and prove the bytes are the
 * content version the launch carries — the version the shell displayed for approval. Only
 * verified bytes reach the View host.
 */
export async function fetchViewBytes(url: string, contentVersion: string): Promise<ViewBytes> {
  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Requested-With": "superbee-ui" },
  });
  if (!res.ok) throw await parseErrorEnvelope(res);
  const bytes = await res.arrayBuffer();
  if ((await sha256Version(bytes)) !== contentVersion) throw new ViewBytesMismatchError();
  return { bytes, contentType: res.headers.get("content-type") ?? "text/html; charset=utf-8" };
}

async function postTrustedShell<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "X-Requested-With": "superbee-ui" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseErrorEnvelope(res);
  return (await res.json()) as T;
}

export function prepareTrustedAction(launchId: string, action: DocumentAction): Promise<ActionPrepareResult> {
  return postTrustedShell("/__ui/actions/prepare", { launchId, action });
}

export function commitTrustedAction(approvalToken: string): Promise<ActionTerminalResult> {
  return postTrustedShell("/__ui/actions/commit", { approvalToken });
}

export function cancelTrustedAction(approvalToken: string): Promise<ActionTerminalResult> {
  return postTrustedShell("/__ui/actions/cancel", { approvalToken });
}

export function authorizeViewLaunch(launchId: string): Promise<ViewAuthorizationStatus> {
  return postTrustedShell("/__ui/views/authorize", { launchId });
}

export function verifyViewLaunch(launchId: string): Promise<ViewAuthorizationStatus> {
  return postTrustedShell("/__ui/views/verify", { launchId });
}

export function verifyViewDelivery(launchId: string): Promise<ViewDeliveryStatus> {
  return postTrustedShell("/__ui/views/delivered", { launchId });
}

export function sendViewBridge(launchId: string, request: unknown): Promise<ViewBridgeOutcome> {
  return postTrustedShell("/__ui/views/bridge", { launchId, request });
}

export type { ActionConfirmation, ActionPrepareResult, ActionTerminalResult, DocumentAction, SharingSummary, WorkspaceSummaryEntry };
