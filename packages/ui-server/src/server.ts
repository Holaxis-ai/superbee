// The reusable loopback UI node:http listener: one server, same origin, either mode. Every request
// passes the Host allowlist, then the token/cookie session check, then
// (for a mutation) the `X-Requested-With` check, before it ever reaches the router / proxy /
// asset layer — see each helper module's own doc comment for why each gate exists.
//
// Reuses the server package's exported node:http adapter ({@link requestFromIncomingMessage} /
// {@link writeResponseToServerResponse}) so Request/Response marshaling has one implementation.
//
// Bundle Views add a second privilege tier alongside the data API: a
// PAGE-BYTES route (`/__page/<nonce>`) that serves a bundle page's static HTML to a sandboxed,
// opaque-origin iframe, gated by a per-page nonce the session-authed shell mints (`POST
// /__page/mint`) — NOT by the session token, so a page cannot call `/v0/*` directly. Data-bearing
// active HTML also requires an exact-byte local approval, and its bridge requests are resolved
// here against the immutable launch before and after each read. Plus an SSE `/events` stream
// (shell-only) fed by a version-token watcher. See `pages.ts`, `events.ts`, `watch.ts`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  RequestBodyTooLargeError,
  requestFromIncomingMessage,
  writeResponseToServerResponse,
} from "@superbee/server";
import { assertSafeBlobKey, loadKinds, queryEdges, queryHeads, readBundleOkfVersion, type Bundle, type EdgeFilter } from "@superbee/core";
import { parseRegistration } from "@superbee/core/page";
import { isAllowedHost } from "./host.js";
import { checkAuth, mintSessionSecret, sessionCookieHeader } from "./session.js";
import type { UiAssetHandler } from "./assets.js";
import { proxyToRemote } from "./proxy.js";
import { pageCsp } from "./pages.js";
import {
  BridgeService,
  PageActionLaunchAuthority,
  PageBridgeLaunchAuthority,
  PageLaunchRegistry,
  RegisteredViewLaunchError,
  SessionViewAuthorizationStore,
  TrustedActionService,
  launchIsCurrent,
  listViewCatalog,
  mintActiveViewLaunch,
  pageLaunchAuthorizationSubject,
  ViewNotFoundError,
  type ActionTerminalResult,
  type BridgeDocumentRenderer,
  type BridgeOutcome,
  type PageLaunch,
  type ViewAuthorizationStore,
} from "@superbee/view-runtime";
import { SseHub } from "./events.js";
import { startWatcher, type ChangeEvent, type WatcherHandle } from "./watch.js";

/** Always loopback: a network-exposed key proxy is a different feature and security boundary. */
const HOST = "127.0.0.1";

/**
 * The home surface's sharing-chip state (designs/home-surface, the 9-row truth table). Declared
 * HERE as a plain data shape — ui-server owns the vocabulary; the CLI maps its board-channel
 * detection into it (the import-direction test forbids even type-only CLI/board-git imports).
 * The SPA owns the WORDS; this enum owns the states. `hosted` is the one state this runtime
 * derives itself (remote mode, from `remoteBase` — no injection involved).
 */
export type SharingStateKind =
  | "private"
  | "private_local_branch"
  | "private_intree_no_remote"
  | "private_intree_not_pushed"
  | "shared_branch"
  | "shared_intree"
  | "hosted"
  | "unavailable"
  | "unscoped";

/** One sharing-state reading, stamped with when it was computed (`as_of` — the loader is TTL-cached and offline-evidence-only, so freshness is part of the truth). */
export interface SharingSummary {
  kind: SharingStateKind;
  /** Humanized remote for the shared/hosted kinds (`org/repo`, a host, or a path tail — consumer-degraded). */
  remote?: string;
  /** Short human reason for `unavailable` (a determinate refusal state or a probe failure — never silently "private"). */
  reason?: string;
  as_of: string;
  /** Dir-mode classifier cache lifetime. When present, the SPA schedules re-evaluation from `as_of`; hosted summaries omit it. */
  refresh_after_ms?: number;
}

/** One registered-workspace row for the home's collapsed workspaces block (labels + paths only — no availability probes; CLI policy decides the projection). */
export interface WorkspaceSummaryEntry {
  label: string;
  path: string;
  /** True when this entry IS the bundle this server is mounted over. */
  open: boolean;
}

interface CommonUiServerOptions {
  port?: number;
  /**
   * REQUIRED in both modes: the semantic bundle used by View launch, catalog, bridge, and
   * engine-level reads. Remote mode supplies a RemoteBackend-backed bundle over `remoteBase`;
   * the SPA's `/v0/*` data path still stays the reverse proxy.
   */
  bundle: Bundle;
  /** Consumer-owned canonical document renderer; this host never imports presentation code. */
  renderDocument: BridgeDocumentRenderer;
  /** Asset bytes stay consumer-owned (the CLI injects its build-generated embedded table). */
  serveAsset: UiAssetHandler;
  /** Injectable for tests; defaults to a fresh random secret per boot (never reused across runs). */
  sessionSecret?: string;
  /** Advisory identity recorded by a confirmed local View action. Read-only UI needs no actor. */
  actor?: string;
  /**
   * Consumer-owned approval persistence for active Views. The runtime defaults to process-local
   * approvals; the CLI injects a local exact-byte store so a user approves unchanged View code
   * once without placing trust state in the synced bundle.
   */
  viewAuthorization?: ViewAuthorizationStore;
}

export type UiServerOptions = CommonUiServerOptions &
  (
    | {
        mode: "dir";
        /** The in-process router mounted over the local bundle (`createRouter(bundle)`). */
        router: (req: Request) => Promise<Response>;
        /** Consumer-owned display-name policy; the runtime never imports CLI naming rules. */
        resolveBundleDisplayName?: (bundle: Bundle) => Promise<string>;
        /** Consumer-owned sharing classifier; absent means the shell makes no sharing claim. */
        loadSharingSummary?: () => Promise<SharingSummary>;
        /** Consumer-owned registered-workspace rows for the home surface. */
        loadWorkspaces?: () => Promise<WorkspaceSummaryEntry[]>;
        remoteBase?: never;
        apiKey?: never;
        watcherBootTimeoutMs?: never;
      }
    | {
        mode: "remote";
        /** The target origin's normalized base URL. */
        remoteBase: string;
        /** Stored API key for that origin, if any. */
        apiKey?: string;
        /** Override the remote watcher's boot-time initial-snapshot timeout. */
        watcherBootTimeoutMs?: number;
        router?: never;
        resolveBundleDisplayName?: never;
        loadSharingSummary?: never;
        loadWorkspaces?: never;
      }
  );

export interface UiServerHandle {
  host: string;
  port: number;
  /** The per-run session secret — the `ui` command embeds this as the receipt URL's `?token=`. */
  token: string;
  close(): Promise<void>;
}

/** Per-run mutable state the request handler closes over: the page-nonce registry, the SSE fan-out, the change watcher, and the shutdown signal (aborts remote-mode upstream requests at close()). */
interface UiRuntime {
  launches: PageLaunchRegistry;
  /** Launches whose nonce response reached Node's completed-response boundary. */
  deliveredLaunches: WeakSet<PageLaunch>;
  authorizations: ViewAuthorizationStore;
  bridge?: BridgeService;
  actions?: TrustedActionService;
  sse: SseHub;
  watcher?: WatcherHandle;
  shutdown: AbortController;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Escape text for interpolation into HTML (the standard `&<>\"'` five). The ONE escape primitive for the serve path — every {@link pageError} message flows through it, because a message on that path can carry remote-originated text (e.g. an upstream failure's error string) and must never reach the iframe as markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A minimal readable error rendered INSIDE the page iframe (the page route serves HTML, so a JSON envelope would show as raw text). Carries the page CSP so the error frame is as locked-down as a real page. The message is ALWAYS HTML-escaped — it is data, never markup. Exported for the escaping pin (ui-pages.test.ts); not otherwise a public API. */
export function pageError(status: number, message: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>page unavailable</title><p>${escapeHtml(message)}</p>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": pageCsp(), "referrer-policy": "no-referrer" },
  });
}

/** Serve a page's bytes for a resolved nonce — the ONLY thing a nonce authorizes, and only ITS one key. */
async function servePageBytes(
  options: UiServerOptions,
  runtime: UiRuntime,
  nonce: string,
): Promise<{ response: Response; deliveredLaunch?: PageLaunch }> {
  const launch = runtime.launches.resolveNonce(nonce);
  if (!launch) return { response: pageError(403, "This view link is unknown or has expired. Reopen the view from the launcher.") };
  if (!(await launchIsCurrent(options.bundle, launch))) {
    runtime.launches.revoke(launch.launchId);
    return { response: pageError(403, "This view changed after it was opened. Reopen it from the launcher.") };
  }
  return {
    response: new Response(launch.bytes, {
      status: 200,
      headers: {
        "content-type": launch.contentType,
        "content-security-policy": pageCsp(),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    }),
    deliveredLaunch: launch,
  };
}

/**
 * Mint an immutable launch through view-runtime's registered-source authority. The host owns only
 * request parsing, legacy entry-key lookup, and translation into its HTTP response contract.
 */
function mintFailureResponse(options: UiServerOptions, registryId: string, error: unknown): Response {
  if (error instanceof ViewNotFoundError) {
    const detail = error.storageCause instanceof Error ? error.storageCause.message : error.message;
    return jsonError(404, "RUNTIME", detail);
  }
  if (error instanceof RegisteredViewLaunchError) {
    switch (error.code) {
      case "VIEW_REGISTRY_READ_FAILED":
        return jsonError(502, "RUNTIME", error.message);
      case "VIEW_INVALID_REGISTRATION":
        return jsonError(403, "FORBIDDEN", `'${registryId}' is not a valid type:View registration (the legacy type:Page name no longer registers — migrate legacy content with the repo's migrate-legacy-view-names script)`);
      case "VIEW_ENTRY_READ_FAILED": {
        const upstreamStatus = (error.storageCause as { status?: unknown } | undefined)?.status;
        // Preserve the retired remote helper's public contract: an HTTP non-success while reading
        // an entry was indistinguishable from absence. Transport failures had no status and remain
        // runtime errors. This mode-specific translation belongs to the web adapter, not the
        // shared launch authority; changing it should be a separate behavioral decision.
        if (options.mode === "remote" && typeof upstreamStatus === "number") {
          return jsonError(404, "NOT_FOUND", `no View bytes found for '${error.entryKey}'`);
        }
        return jsonError(500, "RUNTIME", error.message);
      }
      case "VIEW_ENTRY_NOT_FOUND":
        return jsonError(404, "NOT_FOUND", error.message);
      case "VIEW_ENTRY_VERSION_CONFLICT":
        return jsonError(409, "VERSION_CONFLICT", error.message);
      case "VIEW_ADMISSION_REJECTED":
      case "VIEW_CHANGED_DURING_PREPARATION":
        return jsonError(403, "FORBIDDEN", error.message);
    }
  }
  return jsonError(500, "RUNTIME", error instanceof Error ? error.message : String(error));
}

async function handleMint(req: Request, runtime: UiRuntime, options: UiServerOptions): Promise<Response> {
  let payload: { registryId?: unknown; key?: unknown };
  try {
    payload = (await req.json()) as { registryId?: unknown; key?: unknown };
  } catch {
    return jsonError(400, "USAGE", "request body must be JSON { registryId }");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return jsonError(400, "USAGE", "request body must contain exactly registryId");
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== 1 || (keys[0] !== "registryId" && keys[0] !== "key")) {
    return jsonError(400, "USAGE", "request body must contain exactly registryId");
  }
  let registryId = typeof payload.registryId === "string" ? payload.registryId.trim() : "";
  const legacyKey = typeof payload.key === "string" ? payload.key.trim() : "";
  if (!registryId && legacyKey) {
    try {
      assertSafeBlobKey(legacyKey);
    } catch (error) {
      return jsonError(400, "USAGE", error instanceof Error ? error.message : String(error));
    }
    const matches: string[] = [];
    try {
      const heads = await queryHeads(options.bundle, { type: "View" });
      for (const head of heads) {
        const registration = parseRegistration(head.id, head.frontmatter);
        if (registration?.entry === legacyKey) matches.push(registration.id);
      }
    } catch (error) {
      return jsonError(502, "RUNTIME", `could not read the View registry (${error instanceof Error ? error.message : String(error)})`);
    }
    registryId = matches.sort()[0] ?? "";
    if (!registryId) return jsonError(403, "FORBIDDEN", `'${legacyKey}' is not the entry of any valid registered View`);
  }
  if (!registryId) return jsonError(400, "USAGE", "request body must include a non-empty registryId");

  let launch: Awaited<ReturnType<typeof mintActiveViewLaunch>>;
  try {
    launch = await mintActiveViewLaunch(options.bundle, runtime.launches, registryId);
  } catch (error) {
    return mintFailureResponse(options, registryId, error);
  }
  const subject = pageLaunchAuthorizationSubject(launch);
  const required = launch.capability !== "none";
  const authorized = !required || await runtime.authorizations.isAuthorized(subject);
  return new Response(JSON.stringify({
    nonce: launch.nonce,
    url: `/__page/${launch.nonce}`,
    launchId: launch.launchId,
    title: launch.registryTitle,
    entry: launch.entryKey,
    capability: launch.capability,
    authorization: {
      required,
      authorized,
      contentVersion: launch.contentVersion,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * The SPA bootstrap endpoint: mode, the `--remote` origin (for `ReloginScreen`), and a friendly
 * bundle label for the launcher summary (shell header + bridge `hello.bundle.name`). NOT part of
 * the wire surface (no `/v0/` prefix, never proxied). Dir mode derives the label through THE
 * bundle display-name chain (`bundle-name.ts` — explicit doc, else parent-of-conventional-dir,
 * else root basename), read per request so a `doc write docs/bundle --title …` shows up on the
 * next load without a server restart. Remote mode keeps the origin host as the label.
 */
async function configData(options: UiServerOptions): Promise<{
  mode: "dir" | "remote";
  remoteUrl: string | null;
  root: string | null;
  name: string;
  sharing: SharingSummary | null;
  workspaces: WorkspaceSummaryEntry[];
}> {
  const name =
    options.mode === "dir"
      ? options.resolveBundleDisplayName
        ? await options.resolveBundleDisplayName(options.bundle)
        : "bundle"
      : (() => {
          try {
            return new URL(options.remoteBase!).host;
          } catch {
            return options.remoteBase ?? "remote";
          }
        })();
  return {
    mode: options.mode,
    remoteUrl: options.mode === "remote" ? (options.remoteBase ?? null) : null,
    root: options.mode === "dir" ? options.bundle.root : options.remoteBase,
    name,
    sharing: await sharingSummary(options),
    workspaces: await workspacesSummary(options),
  };
}

async function configResponse(options: UiServerOptions): Promise<Response> {
  return new Response(
    JSON.stringify(await configData(options)),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

/**
 * The trust chip's state. Remote mode is derived HERE (`hosted` off remoteBase); dir mode is the
 * consumer's injected classification (absent loader = no claim, `null`). A THROWING loader is
 * `unavailable`, never a fabricated "private" — a wrong "private" and a wrong "shared" are the
 * same trust bug (designs/home-surface, the truth-table rules).
 */
async function sharingSummary(options: UiServerOptions): Promise<SharingSummary | null> {
  if (options.mode === "remote") {
    let host: string;
    try {
      host = new URL(options.remoteBase!).host;
    } catch {
      host = options.remoteBase ?? "remote";
    }
    return { kind: "hosted", remote: host, as_of: new Date().toISOString() };
  }
  if (!options.loadSharingSummary) return null;
  try {
    return await options.loadSharingSummary();
  } catch (err) {
    return {
      kind: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
      as_of: new Date().toISOString(),
    };
  }
}

/** The collapsed workspaces block's rows (dir mode, consumer-injected). Best-effort: a throwing loader is an empty list, never a failed config. */
async function workspacesSummary(options: UiServerOptions): Promise<WorkspaceSummaryEntry[]> {
  if (options.mode !== "dir" || !options.loadWorkspaces) return [];
  try {
    return await options.loadWorkspaces();
  } catch {
    return [];
  }
}

/**
 * The bundle's kind conventions for the shell's bridge `open` filter, derived by core's
 * `loadKinds` — the ONE registry (gate 3) — over the mode-appropriate bundle. The browser never
 * re-implements discovery/dedupe; it consumes this serialized registry plus core's pure
 * `isTerminal`. Best-effort: a bundle that cannot be read (e.g. a remote hiccup) yields an empty
 * registry, which makes `open` filter nothing — the same posture as `list --open` on a bundle
 * with no terminal declarations (this endpoint feeds a display filter, not a security boundary).
 */
async function kindsResponse(options: UiServerOptions): Promise<Response> {
  let kinds: unknown[] = [];
  let okfVersion = "0.1";
  try {
    const [registry, version] = await Promise.all([
      loadKinds(options.bundle),
      readBundleOkfVersion(options.bundle),
    ]);
    kinds = Array.from(registry.kinds.values());
    okfVersion = version ?? "0.1";
  } catch {
    kinds = [];
  }
  return new Response(JSON.stringify({ kinds, okfVersion }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The web launcher's projection of the same durable View catalog used by CLI and MCP. */
async function viewsResponse(options: UiServerOptions): Promise<Response> {
  try {
    const catalog = await listViewCatalog(options.bundle);
    return new Response(JSON.stringify({
      views: catalog.entries,
      total: catalog.total,
      invalidRegistrations: catalog.invalidRegistrations,
      unavailableEntries: catalog.unavailableEntries,
      skippedDocuments: catalog.skippedDocuments,
    }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return jsonError(
      502,
      "RUNTIME",
      `could not read the View catalog (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * The bundle's derived edge list (graph-query-v0's `queryEdges`, gate 3: proxied, never
 * reimplemented) for the bridge's `edges` request. Mode-aware exactly like `kindsResponse` above:
 * dir mode calls `queryEdges` over the mounted `Bundle`; remote mode calls it over the SAME
 * `RemoteBackend`-backed bundle `kindsResponse` already uses (`options.bundle`) — `queryEdges`
 * rides `query`+`readMany` under the hood, so this costs no new wire route on the reference server.
 * `from`/`to` are repeatable query params (array-union, mirroring `link list --from/--to`); `text`
 * is exact-match. Row schema is AXI-minimal (`{from, to, text}`), the SAME projection `link list`
 * applies — core's `Link` also carries `href` (the raw pre-resolution markdown target), an
 * internal detail no page needs.
 *
 * UNLIKE `kindsResponse` (an auxiliary display filter, correctly best-effort), edges is PRIMARY
 * data — a page's backlinks panel, say — so a `queryEdges` failure (most commonly a `--remote`
 * upstream outage) is mapped to a 502, mirroring `proxyToRemote`'s own transport-failure envelope,
 * rather than swallowed into a 200 `{edges:[],count:0}`: a real outage must read as an error, not
 * as "this bundle simply has no edges" (the branch's own silent-staleness standard, and the reason
 * `fetchEdges` throws on any non-2xx rather than best-effort-emptying like `fetchKinds`).
 */
async function edgesResponse(options: UiServerOptions, url: URL): Promise<Response> {
  const filter: EdgeFilter = {};
  const from = url.searchParams.getAll("from").map((v) => v.trim()).filter(Boolean);
  if (from.length > 0) filter.from = from;
  const to = url.searchParams.getAll("to").map((v) => v.trim()).filter(Boolean);
  if (to.length > 0) filter.to = to;
  const text = url.searchParams.get("text")?.trim();
  if (text) filter.text = text;

  let links: Awaited<ReturnType<typeof queryEdges>>;
  try {
    links = await queryEdges(options.bundle, filter);
  } catch (err) {
    return jsonError(502, "RUNTIME", `could not read the bundle's edges (${err instanceof Error ? err.message : String(err)})`);
  }
  const edges = links.map((l) => ({ from: l.from, to: l.to, text: l.text }));
  return new Response(JSON.stringify({ edges, count: edges.length }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function actionJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const MAX_TRUSTED_ACTION_BODY_BYTES = 16 * 1024;

/**
 * The `X-Requested-With` marker a same-origin mutation must carry. Renaming the value cannot be a
 * flag day: a browser holding a cached bundle of the previous UI keeps sending the old marker, and
 * this check is the CSRF guard, so rejecting it would 403 a user whose only mistake was not hard
 * reloading. The server therefore ACCEPTS both and the client SENDS the canonical one; the legacy
 * value can be dropped once no shipped UI emits it.
 */
export const REQUESTED_WITH_MARKER = "superbee-ui";
/** Pre-rename marker, still accepted from a cached UI bundle. Never sent by current code. */
export const LEGACY_REQUESTED_WITH_MARKER = "agentstate-lite-ui";

function hasRequestedWithMarker(req: Request): boolean {
  const seen = req.headers.get("x-requested-with");
  return seen === REQUESTED_WITH_MARKER || seen === LEGACY_REQUESTED_WITH_MARKER;
}

async function trustedPayload(
  req: Request,
  keys: readonly string[],
  label = "trusted action",
): Promise<Record<string, unknown> | Response> {
  if (!hasRequestedWithMarker(req)) {
    const subject = label === "trusted action" ? "trusted actions" : `${label} requests`;
    return jsonError(403, "FORBIDDEN", `${subject} require X-Requested-With: ${REQUESTED_WITH_MARKER}`);
  }
  if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return jsonError(415, "USAGE", `${label} requests require application/json`);
  }
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRUSTED_ACTION_BODY_BYTES) {
    return jsonError(413, "USAGE", `${label} request body must be at most 16 KiB`);
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return jsonError(400, "USAGE", `${label} request body could not be read`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TRUSTED_ACTION_BODY_BYTES) {
    return jsonError(413, "USAGE", `${label} request body must be at most 16 KiB`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return jsonError(400, "USAGE", `${label} request body must be valid JSON`);
  }
  return exactOwnKeys(value, keys) ? value : jsonError(400, "USAGE", `${label} request must contain exactly ${keys.join(", ")}`);
}

async function prepareAction(req: Request, options: UiServerOptions, runtime: UiRuntime): Promise<Response> {
  const payload = await trustedPayload(req, ["launchId", "action"]);
  if (payload instanceof Response) return payload;
  if (options.mode !== "dir" || !runtime.actions) {
    const result: ActionTerminalResult = { status: "rejected", action: "document.set-field", message: "trusted View actions are available only in local --dir mode" };
    return actionJson(result);
  }
  const launchId = typeof payload.launchId === "string" ? payload.launchId : "";
  if (!launchId || launchId.length > 256) return jsonError(400, "USAGE", "launchId must be a non-empty string of at most 256 characters");
  return actionJson(await runtime.actions.prepare(launchId, payload.action));
}

async function finishAction(req: Request, runtime: UiRuntime, operation: "commit" | "cancel"): Promise<Response> {
  const payload = await trustedPayload(req, ["approvalToken"]);
  if (payload instanceof Response) return payload;
  const token = typeof payload.approvalToken === "string" ? payload.approvalToken : "";
  if (!token || token.length > 256) return jsonError(400, "USAGE", "approvalToken must be a non-empty string of at most 256 characters");
  if (!runtime.actions) {
    return actionJson({ status: "rejected", action: "document.set-field", message: "trusted View actions are unavailable" } satisfies ActionTerminalResult);
  }
  return actionJson(operation === "commit" ? await runtime.actions.commit(token) : runtime.actions.cancel(token));
}

function launchIdFrom(payload: Record<string, unknown>): string | null {
  const launchId = typeof payload.launchId === "string" ? payload.launchId : "";
  return launchId && launchId.length <= 256 ? launchId : null;
}

async function resolveViewAuthorization(
  options: UiServerOptions,
  runtime: UiRuntime,
  launchId: string,
  authorize: boolean,
): Promise<{ required: boolean; authorized: boolean } | null> {
  const launch = runtime.launches.resolveLaunch(launchId);
  if (!launch || !(await launchIsCurrent(options.bundle, launch))) {
    if (launch) runtime.launches.revoke(launch.launchId);
    return null;
  }
  const subject = pageLaunchAuthorizationSubject(launch);
  const required = launch.capability !== "none";
  if (authorize && required) await runtime.authorizations.authorize(subject);
  if (!(await launchIsCurrent(options.bundle, launch))) {
    runtime.launches.revoke(launch.launchId);
    return null;
  }
  return {
    required,
    authorized: !required || await runtime.authorizations.isAuthorized(subject),
  };
}

async function authorizeView(req: Request, options: UiServerOptions, runtime: UiRuntime): Promise<Response> {
  const payload = await trustedPayload(req, ["launchId"], "View authorization");
  if (payload instanceof Response) return payload;
  const launchId = launchIdFrom(payload);
  if (!launchId) return jsonError(400, "USAGE", "launchId must be a non-empty string of at most 256 characters");
  const status = await resolveViewAuthorization(options, runtime, launchId, true);
  return status
    ? actionJson(status)
    : jsonError(403, "FORBIDDEN", "the View launch is unknown, changed, or expired");
}

async function verifyView(req: Request, options: UiServerOptions, runtime: UiRuntime): Promise<Response> {
  const payload = await trustedPayload(req, ["launchId"], "View verification");
  if (payload instanceof Response) return payload;
  const launchId = launchIdFrom(payload);
  if (!launchId) return jsonError(400, "USAGE", "launchId must be a non-empty string of at most 256 characters");
  const status = await resolveViewAuthorization(options, runtime, launchId, false);
  return status
    ? actionJson(status)
    : jsonError(403, "FORBIDDEN", "the View launch is unknown, changed, or expired");
}

async function verifyViewDelivery(req: Request, options: UiServerOptions, runtime: UiRuntime): Promise<Response> {
  const payload = await trustedPayload(req, ["launchId"], "View delivery verification");
  if (payload instanceof Response) return payload;
  const launchId = launchIdFrom(payload);
  if (!launchId) return jsonError(400, "USAGE", "launchId must be a non-empty string of at most 256 characters");
  const launch = runtime.launches.resolveLaunch(launchId);
  if (!launch) {
    return jsonError(403, "FORBIDDEN", "the View launch is unknown, changed, or expired");
  }
  if (!(await launchIsCurrent(options.bundle, launch))) {
    runtime.launches.revoke(launch.launchId);
    return jsonError(403, "FORBIDDEN", "the View launch is unknown, changed, or expired");
  }
  return actionJson({ delivered: runtime.deliveredLaunches.has(launch) });
}

async function handleViewBridge(req: Request, runtime: UiRuntime): Promise<Response> {
  const payload = await trustedPayload(req, ["launchId", "request"], "View bridge");
  if (payload instanceof Response) return payload;
  const launchId = launchIdFrom(payload);
  if (!launchId) return jsonError(400, "USAGE", "launchId must be a non-empty string of at most 256 characters");
  if (!runtime.bridge) return jsonError(403, "FORBIDDEN", "the View bridge is unavailable for this host");
  const outcome: BridgeOutcome = await runtime.bridge.handle(launchId, payload.request);
  return actionJson(outcome);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: UiServerOptions,
  runtime: UiRuntime,
  sessionSecret: string,
): Promise<void> {
  if (!isAllowedHost(req.headers.host)) {
    await writeResponseToServerResponse(res, jsonError(403, "FORBIDDEN", "Host header is not in the loopback allowlist"));
    return;
  }

  const origin = `http://${req.headers.host}`;
  const url = new URL(req.url ?? "/", origin);

  // PAGE BYTES — the second privilege tier. Nonce-gated and SESSION-INDEPENDENT: the sandboxed,
  // opaque-origin iframe that loads this URL holds no session token, and the nonce is its sole
  // capability (minted by the session-authed shell for this one key). The data token does NOT open
  // this route to arbitrary keys, and this nonce does NOT open any data route (`checkAuth` below
  // rejects it — it is not the session secret). `/__page/mint` is excluded here: it is a data
  // operation and stays behind the session gate.
  if (url.pathname.startsWith("/__page/") && url.pathname !== "/__page/mint") {
    const nonce = decodeURIComponent(url.pathname.slice("/__page/".length));
    const served = await servePageBytes(options, runtime, nonce);
    const completed = new Promise<boolean>((resolve) => {
      const finish = (): void => { cleanup(); resolve(true); };
      const close = (): void => { cleanup(); resolve(res.writableFinished); };
      const cleanup = (): void => {
        res.off("finish", finish);
        res.off("close", close);
      };
      res.once("finish", finish);
      res.once("close", close);
    });
    await writeResponseToServerResponse(res, served.response);
    if (served.deliveredLaunch && await completed) {
      runtime.deliveredLaunches.add(served.deliveredLaunch);
    }
    return;
  }

  // Authenticate from the raw request metadata before adapting/buffering any body. A caller with
  // no session must not be able to make the loopback process allocate an arbitrary request body
  // merely to discover that it is unauthorized.
  const auth = checkAuth(
    sessionSecret,
    url.searchParams.get("token"),
    req.headers.cookie ?? null,
  );
  if (!auth.ok) {
    await writeResponseToServerResponse(
      res,
      jsonError(403, "FORBIDDEN", "missing or invalid session — open the printed URL (with its ?token) again"),
    );
    return;
  }
  const boundedTrustedBody =
    url.pathname === "/__page/mint" || url.pathname.startsWith("/__ui/");
  let request: Request;
  try {
    request = await requestFromIncomingMessage(req, origin, {
      ...(boundedTrustedBody ? { maxBodyBytes: MAX_TRUSTED_ACTION_BODY_BYTES } : {}),
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      const label = url.pathname.startsWith("/__ui/actions/")
        ? "trusted action"
        : url.pathname.startsWith("/__ui/views/")
          ? "View"
          : "View launch";
      await writeResponseToServerResponse(
        res,
        jsonError(413, "USAGE", `${label} request body must be at most 16 KiB`),
      );
      return;
    }
    throw error;
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !request.headers.get("x-requested-with")) {
    await writeResponseToServerResponse(res, jsonError(403, "FORBIDDEN", "a mutation requires an X-Requested-With header"));
    return;
  }

  // SSE — a long-lived stream written directly on the raw response (never marshaled through
  // `writeResponseToServerResponse`, which finishes the response). Shell-only; pages can't reach it.
  if (url.pathname === "/events" && request.method === "GET") {
    const cookieHeaders: Record<string, string> = auth.grantsCookie ? { "set-cookie": sessionCookieHeader(sessionSecret) } : {};
    runtime.sse.add(res, cookieHeaders);
    return;
  }

  let response: Response;
  if (url.pathname === "/__page/mint" && request.method === "POST") {
    response = await handleMint(request, runtime, options);
  } else if (url.pathname === "/__ui/views/authorize" && request.method === "POST") {
    response = await authorizeView(request, options, runtime);
  } else if (url.pathname === "/__ui/views/verify" && request.method === "POST") {
    response = await verifyView(request, options, runtime);
  } else if (url.pathname === "/__ui/views/delivered" && request.method === "POST") {
    response = await verifyViewDelivery(request, options, runtime);
  } else if (url.pathname === "/__ui/views/bridge" && request.method === "POST") {
    response = await handleViewBridge(request, runtime);
  } else if (url.pathname === "/__ui/actions/prepare" && request.method === "POST") {
    response = await prepareAction(request, options, runtime);
  } else if (url.pathname === "/__ui/actions/commit" && request.method === "POST") {
    response = await finishAction(request, runtime, "commit");
  } else if (url.pathname === "/__ui/actions/cancel" && request.method === "POST") {
    response = await finishAction(request, runtime, "cancel");
  } else if (url.pathname === "/__ui/config") {
    response = await configResponse(options);
  } else if (url.pathname === "/__ui/kinds") {
    response = await kindsResponse(options);
  } else if (url.pathname === "/__ui/views" && request.method === "GET") {
    response = await viewsResponse(options);
  } else if (url.pathname === "/__ui/edges") {
    response = await edgesResponse(options, url);
  } else if (url.pathname.startsWith("/v0/")) {
    response =
      options.mode === "dir"
        ? await options.router!(request)
        : await proxyToRemote(request, options.remoteBase!, options.apiKey, runtime.shutdown.signal);
  } else {
    const asset = options.serveAsset(url.pathname, request.headers.get("accept-encoding"));
    response = new Response(asset.body, { status: asset.status, headers: asset.headers });
  }

  if (auth.grantsCookie) response.headers.append("set-cookie", sessionCookieHeader(sessionSecret));
  await writeResponseToServerResponse(res, response);
}

/**
 * Boot the change watcher for live updates, feeding each diff into the SSE hub. Best-effort: a
 * watcher that can't start (e.g. an unreachable remote at boot, or — tasks/ui-remote-watcher-boot-timeout
 * — a `--remote` upstream that never responds, now bounded by `startWatcher`'s boot-time timeout so
 * it THROWS instead of hanging) leaves the UI fully usable, just without live push. Either way the
 * failure is logged to stderr (`onError`) — never a silent no-watch and never a hung boot.
 */
async function bootWatcher(options: UiServerOptions, sse: SseHub): Promise<WatcherHandle | undefined> {
  const onChange = (e: ChangeEvent): void => sse.broadcast(e);
  const onError = (err: unknown): void => {
    process.stderr.write(`[ui watcher] ${err instanceof Error ? err.message : String(err)}\n`);
  };
  try {
    return options.mode === "dir"
      ? await startWatcher({ mode: "dir", bundle: options.bundle!, onChange, onError })
      : await startWatcher({
          mode: "remote",
          remoteBase: options.remoteBase!,
          apiKey: options.apiKey,
          bootTimeoutMs: options.watcherBootTimeoutMs,
          onChange,
          onError,
        });
  } catch (err) {
    onError(err);
    return undefined;
  }
}

/** How long close() waits for accepted request handlers to settle before shutting down without them (a backstop for a pathological handler; severed sockets settle ordinary blocked reads well within this). */
const CLOSE_DRAIN_WATCHDOG_MS = 5_000;

/** Boot the `ui` command's http listener and resolve once it is listening. */
export async function bootUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const sessionSecret = options.sessionSecret ?? mintSessionSecret();
  const launches = new PageLaunchRegistry();
  const authorizations = options.viewAuthorization ?? new SessionViewAuthorizationStore();
  const bridgeAuthority = new PageBridgeLaunchAuthority(options.bundle, launches, authorizations);
  const runtime: UiRuntime = {
    launches,
    deliveredLaunches: new WeakSet(),
    authorizations,
    bridge: new BridgeService({
      bundle: options.bundle,
      launches: bridgeAuthority,
      renderDocument: options.renderDocument,
      config: async () => {
        const config = await configData(options);
        return { root: config.root, name: config.name, mode: config.mode };
      },
    }),
    actions:
      options.mode === "dir" && options.bundle
        ? new TrustedActionService(
            options.bundle,
            new PageActionLaunchAuthority(options.bundle, launches, authorizations),
            options.actor,
          )
        : undefined,
    sse: new SseHub(),
    shutdown: new AbortController(),
  };
  runtime.watcher = await bootWatcher(options, runtime.sse);

  return new Promise((resolve, reject) => {
    // Every ACCEPTED request's handler promise, tracked until it settles: close() drains this
    // set before resolving, so no handler can commit a write AFTER shutdown ostensibly finished
    // (the post-close destructive-write race — e.g. a mutation recreating a bundle dir the
    // operator deleted right after close()).
    const inFlight = new Set<Promise<void>>();
    const server = createServer((req, res) => {
      const handled = handleRequest(req, res, options, runtime, sessionSecret).catch((err: unknown) => {
        // Best-effort: the response may already be severed (shutdown's closeAllConnections) — a
        // throwing fallback here would surface as an unhandled rejection, not a served error.
        try {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { code: "RUNTIME", message: err instanceof Error ? err.message : String(err) } }));
        } catch {
          res.destroy();
        }
      });
      inFlight.add(handled);
      void handled.finally(() => inFlight.delete(handled));
    });
    server.once("error", (err) => {
      void runtime.watcher?.stop();
      runtime.sse.close();
      reject(err);
    });
    server.listen(options.port ?? 0, HOST, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("failed to bind a TCP address"));
        return;
      }
      resolve({
        host: HOST,
        port: addr.port,
        token: sessionSecret,
        close: async () => {
          void runtime.watcher?.stop();
          runtime.sse.close();
          const listenerClosed = new Promise<void>((resolveClose, rejectClose) =>
            server.close((err) => (err ? rejectClose(err) : resolveClose())),
          );
          // Handled-guard: listenerClosed is awaited only AFTER the drain below, so a rejection
          // landing during the drain (a concurrent second close() gets ERR_SERVER_NOT_RUNNING)
          // would otherwise sit handler-less across macrotask turns — a process-fatal
          // unhandledRejection. The no-op catch marks it handled now; the await still throws.
          listenerClosed.catch(() => {});
          // Shutdown never waits on a client: sever every remaining socket now. Without this,
          // an EventSource reconnect racing onto a kept-alive connection mid-drain registers a
          // fresh never-ending stream (or a pipelined request keeps its socket active) and
          // `server.close()` blocks forever — the session-rotation restart hang.
          server.closeAllConnections();
          // Remote mode: abort in-flight upstream requests — a slow remote must not stall
          // shutdown, and the remote owns its own write coherence. Dir mode is untouched by
          // this signal: an accepted LOCAL mutation finishes (see the drain below).
          runtime.shutdown.abort();
          // Drain accepted server-side work BEFORE resolving: severing sockets stops CLIENTS,
          // but a handler already executing (e.g. a mutation inside the router) is our work —
          // resolving under it would let a write commit AFTER close(). Dir-mode semantics:
          // finish-what-you-accepted (aborting a local fs write mid-flight risks partial
          // state). Bounded by a watchdog for a pathological handler that outlives its
          // severed socket.
          const drained = Promise.allSettled([...inFlight]).then(() => true as const);
          const bounded = await Promise.race([
            drained,
            new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), CLOSE_DRAIN_WATCHDOG_MS).unref()),
          ]);
          if (!bounded) {
            process.stderr.write("[ui] close(): a request handler did not settle within the drain window; shutting down without it\n");
          }
          await listenerClosed;
        },
      });
    });
  });
}
