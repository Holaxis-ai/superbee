// The headless client of the hosted sync route family (`/sync/v1`): a bearer carrier over the
// shared hosted transport, the identity and bundle-list reads a caller needs before it opens a
// bundle, document reads and history, and operations run by id.
//
// Credentials come from the caller's provider, asked once per request through the carrier seam, so
// a short-lived token can be renewed between requests. The client never logs them, and its errors
// carry the route and code, never a credential. Failures are typed and never worded for a particular surface:
// `HostedCarrierError` (transport), `MalformedAnswer` (an answer the contract does not admit),
// `RemoteError` (a refusal, with the host's code and status) and `HostedRouteNotServed`.
import {
  createFetchCarrier,
  createHostedReadAdapter,
  decodeHistoryAnswer,
  decodeOperationListing,
  decodeOperationRun,
  familyRefusal,
  historyInput,
  HOSTED_READ_BOUNDS,
  operationRunBody,
  readRefusal,
  statedDocumentInputBytes,
  type HostedAnswer,
  type HostedCarrier,
  type HostedHistoryAnswer,
  type HostedHistoryRequest,
  type HostedOperationListingAnswer,
  type HostedOperationRun,
  type HostedReadAdapter,
  type FetchCarrierOptions,
  type HostedReadRoutes,
  type JsonObject,
} from "../hosted-transport/index.js";
import { isMalformedAnswer, MalformedAnswer, RemoteError } from "../remote-error.js";
import { HostedCarrierError } from "../hosted-transport/index.js";
import {
  decodeViewContentRead,
  decodeViewContentUpdate,
  unknownOutcome,
  VIEW_CONTENT_READ_ANSWER_BYTES,
  VIEW_CONTENT_READ_OPERATION,
  VIEW_CONTENT_UPDATE_ANSWER_BYTES,
  VIEW_CONTENT_UPDATE_OPERATION,
  viewContentReadBody,
  viewContentRefusal,
  viewContentUpdateBody,
  type HostedViewContentReadRequest,
  type HostedViewContentReadResult,
  type HostedViewContentUpdateRequest,
  type HostedViewContentUpdateResult,
} from "./view-content.js";
import type { HostedBundleRow } from "./bundle-listing.js";
import { HostedRouteNotServed } from "./errors.js";
import { hostedBundleReferenceText, isWorkspaceSlug, parseHostedBundleReference } from "./reference.js";
import { checkoutBindingDigest } from "./binding.js";
import { mintRequestId } from "../uncertain-write.js";
import {
  createCapabilitiesCache,
  createMemoryIntentStore,
  hostedHeldWrites,
  hostedLookupWrite,
  hostedSettleWrite,
  hostedWrite,
  type HostedCapabilitiesCache,
  type HostedIntentStore,
  type HostedWriteInput,
  type HostedWriteIntent,
  type HostedWriteLookupResult,
  type HostedWriteOptions,
  type HostedWriteResult,
} from "./write.js";
import { createMemoryBlobJournal, type BlobJournaledBackend } from "../blob-journal.js";
import type { BlobHead } from "../blob-contract.js";
import type { HostedBlobHeads, HostedBlobRead } from "../hosted-transport/index.js";
import {
  hostedBlobHead,
  hostedBlobHeads,
  hostedDeleteBlob,
  hostedForgetBlobWrite,
  hostedHeldBlobWrites,
  hostedLookupBlobWrite,
  hostedReadBlob,
  hostedSettleBlobWrite,
  hostedWriteBlob,
  type BlobPin,
  type HostedBlobContext,
  type HostedBlobDeleteInput,
  type HostedBlobForgetResult,
  type HostedBlobHeldWrite,
  type HostedBlobLookupResult,
  type HostedBlobWriteInput,
  type HostedBlobWriteOptions,
  type HostedBlobWriteResult,
} from "./blob-write.js";

const IDENTITY_BYTES = 64 * 1024;
const BUNDLES_BYTES = 256 * 1024;
const AGENT_AUDIENCE_PATH = /^\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/mcp$/;

/** Where a hosted client sends its requests. */
export interface HostedClientTarget {
  /** The host's origin, such as `https://mcp.getsuperbee.com`; routes resolve against it. */
  readonly origin: string;
  /**
   * The sync family's path prefix: `/sync/v1` for the Superbee API, or `/agents/<id>/sync/v1` for
   * an agent connection. {@link syncRoutePrefix} derives it from a protected-resource audience.
   */
  readonly syncPrefix: string;
}

/**
 * The credential headers for one request, such as `{ Authorization: "Bearer …" }` or a browser's
 * cookie-bound CSRF header: the carrier seam's own `credentials` (`FetchCarrierOptions`), passed
 * through unchanged. It is called before every request (never cached by the client), so it may
 * renew a short-lived token. A rejection means no credential: the request is not sent and fails
 * as a `HostedCarrierError` with code `denied`.
 */
export type HostedCredentialProvider = FetchCarrierOptions["credentials"];

/**
 * A {@link HostedCredentialProvider} sending `Authorization: Bearer <token>`, asking `getToken`
 * before every request. A value that is not a string is no credential (`denied`).
 */
export function bearerCredentials(getToken: (signal: AbortSignal) => Promise<string> | string): HostedCredentialProvider {
  return async (signal) => {
    const token = await getToken(signal);
    if (typeof token !== "string") throw new TypeError("the token provider returned no bearer");
    return { Authorization: `Bearer ${token}` };
  };
}

export interface HostedClientOptions {
  readonly target: HostedClientTarget;
  readonly credentials: HostedCredentialProvider;
  readonly fetch?: typeof fetch;
  /** Request deadline; streamed reads bound upstream idle time, excluding downstream processing. Default 15 s. */
  readonly deadlineMs?: number;
  /** Aborting it stops every request the client (and each `within` client) sends. */
  readonly signal?: AbortSignal;
  /**
   * Where `write` records each write until it settles, for its outcome lookup. Default: an
   * in-memory store ({@link createMemoryIntentStore}) owned by this client.
   */
  readonly intentStore?: HostedIntentStore;
  /**
   * Where `writeBlob` and `deleteBlob` journal each blob write until it settles. Default: an
   * in-memory journal (`createMemoryBlobJournal`) owned by this client. In Node,
   * `openHostedClientJournal(...).blobs` keeps them across restarts.
   */
  readonly blobJournal?: BlobJournaledBackend;
  /** How a write recovers an unclear answer: the wait between its outcome lookups (default 250 ms). */
  readonly writeRecovery?: { readonly lookupDelayMs?: number };
  /**
   * How long a bundle's capabilities answer serves this client's writes (and its `within`
   * clients'), in milliseconds after it arrives. Default 60,000; 0 reads them before every write.
   * A write refused `read_only`, `invalid_input`, `validation_failed` or `PERMISSION_DENIED`, or
   * whose outcome is `unknown`, drops the answer so the next write reads it again. `reader()` never
   * shares it.
   */
  readonly capabilitiesTtlMs?: number;
  /** The clock the capabilities answers age by, in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** One operation run's options. */
export interface HostedRunOptions {
  /** The largest answer read, in bytes. Default `HOSTED_READ_BOUNDS.runBytes`. */
  readonly maximumBytes?: number;
}

export interface HostedIdentity {
  readonly principalId: string;
  readonly tenantIds: readonly string[];
  /**
   * Each workspace with the slug a qualified reference names it by (null for none), in
   * `tenantIds` order. A host from before qualified references reports no slugs: every one is null.
   */
  readonly workspaces: readonly HostedWorkspace[];
  /**
   * The host's whole-document write bound (`limits.documentInputBytes`), or null when it states
   * none (every host before the bound was stated accepts 65,536).
   */
  readonly documentInputBytes: number | null;
  /** The person's email, when the host names one (null otherwise). */
  readonly email: string | null;
  /**
   * The deployment's document target authority key (`targetAuthorityKey`), the `authorityKey` a
   * hosted document target names. Absent when the host states none or states one no target can carry.
   */
  readonly targetAuthorityKey?: string;
  /**
   * The workspaces (tenant ids, a subset of `tenantIds`) whose notification directory
   * (`members.directory.v1`) the host offers this person. Absent when it offers none, or states
   * nothing (a host from before the directory): a client then names recipients by principal id only.
   */
  readonly notificationDirectoryWorkspaces?: readonly string[];
}

export interface HostedWorkspace {
  readonly tenantId: string;
  readonly slug: string | null;
}

export interface HostedClient {
  readonly target: HostedClientTarget;
  /** The sync family's prefix, `target.syncPrefix`. */
  readonly prefix: string;
  /** The bearer carrier, for routes this client has no method for; it qualifies as {@link within} does. */
  readonly carrier: HostedCarrier;
  /** The signal every request is sent under. */
  readonly signal: AbortSignal;
  /** Who the bearer is (`<prefix>/whoami`). */
  whoami(): Promise<HostedIdentity>;
  /** The bundles the bearer may sync (`<prefix>/bundles`), at most `BUNDLE_LIST_CAP` rows. */
  bundles(): Promise<HostedBundleRow[]>;
  /** The read adapter (capabilities, heads, snapshot, read) for one bundle. */
  reader(bundleId: string): HostedReadAdapter;
  /** One page of a document's history (`documents.history.v1`), validated against the page asked for. */
  history(bundleId: string, request: HostedHistoryRequest): Promise<HostedHistoryAnswer>;
  /**
   * The same client, naming its bundles in the workspace with this slug: every bundle-scoped
   * request names its bundle as `<slug>/<bundle-id>` ({@link qualifyingCarrier}).
   */
  within(slug: string): HostedClient;
  /**
   * The reads this host runs by id for one bundle (`<prefix>/operations`). A bundle the host does
   * not serve to this person is the refusal `bundle_not_found`, as a run answers it.
   */
  listOperations(bundleId: string): Promise<HostedOperationListingAnswer>;
  /**
   * One operation, run by id (`<prefix>/run`) in one request: the operation's data, or its
   * refusal. The route's own `unknown_operation` (the host does not run this id) and
   * `invalid_input` come back as refusals too. `input.bundleId` is set to `bundleId`.
   */
  runOperation(bundleId: string, operationId: string, input: JsonObject, options?: HostedRunOptions): Promise<HostedOperationRun>;
  /**
   * Write one whole serialized document: a create when `expectAbsent` is true, else a replace at
   * exactly `expectedVersion`. One request identity, minted here unless given, settles it: the
   * answer, or after an unclear one a lookup under the same identity and this client's binding.
   * Returns committed, a conflict (final; never resent), a refusal, or `unknown` with the request
   * identity for {@link lookupWrite}. Nothing is thrown once a request may have left.
   */
  write(bundleId: string, input: HostedWriteInput, options?: HostedWriteOptions): Promise<HostedWriteResult>;
  /**
   * What the host recorded for a held write: one outcome lookup under its own identity and
   * binding. It never sends the write; a host holding no outcome yet answers `unknown`.
   */
  lookupWrite(requestId: string, options?: { signal?: AbortSignal }): Promise<HostedWriteLookupResult>;
  /**
   * Settle a held write: look it up and, when the host never recorded it within the retention
   * window it serves, send that same identity once more.
   */
  settleWrite(requestId: string, options?: { signal?: AbortSignal }): Promise<HostedWriteLookupResult>;
  /** Every write the intent store holds (unsettled, or never sent); needs a store with `list`. */
  heldWrites(): Promise<HostedWriteIntent[]>;
  /**
   * Write one ordinary file (a blob): a create when `expectAbsent` is true, else a replace at
   * exactly `expected` (version and content type). It is journaled, durably claimed and sent once
   * under one request identity; an unclear answer is looked up, never resent. Throws
   * `HostedBlobWritesNotServed` before journaling when the host serves the bundle no blob writes.
   */
  writeBlob(bundleId: string, input: HostedBlobWriteInput, options?: HostedBlobWriteOptions): Promise<HostedBlobWriteResult>;
  /** Delete one blob at exactly `expected`. A mass delete the host holds answers `held`. */
  deleteBlob(bundleId: string, input: HostedBlobDeleteInput, options?: HostedBlobWriteOptions): Promise<HostedBlobWriteResult>;
  /** One outcome lookup of a held blob write; it never sends the write. */
  lookupBlobWrite(requestId: string, options?: { signal?: AbortSignal }): Promise<HostedBlobLookupResult>;
  /**
   * Settle a held blob write: submit it when every attempt is proven not applied (a held delete
   * needs `acceptDeletes` of at least its count), otherwise look it up; absence stays `unknown`.
   */
  settleBlobWrite(requestId: string, options?: { signal?: AbortSignal; acceptDeletes?: number }): Promise<HostedBlobLookupResult>;
  /**
   * Drop an `unknown` blob write once one fresh lookup answers `absent`. The earlier delivery may
   * still commit; the host's compare-and-swap prevents a lost update.
   */
  forgetBlobWrite(requestId: string, options?: { signal?: AbortSignal }): Promise<HostedBlobForgetResult>;
  /** Every blob write the journal holds unsettled. */
  heldBlobWrites(): Promise<HostedBlobHeldWrite[]>;
  /** The bundle's whole blob listing (`blob-heads`), verified against its digest. */
  blobHeads(bundleId: string, options?: { signal?: AbortSignal }): Promise<HostedBlobHeads>;
  /** One key's head from the listing, or null when absent. The listing is the only head lookup. */
  blobHead(bundleId: string, key: string, options?: { signal?: AbortSignal }): Promise<BlobHead | null>;
  /** The bytes at exactly `pin` (required), verified; null when the key is no longer at that pin. */
  readBlob(bundleId: string, key: string, options: { pin: BlobPin; signal?: AbortSignal }): Promise<HostedBlobRead | null>;
  /**
   * A registered View's page (`<prefix>/view-content-read`, `views.content.read.v1`), at the
   * registration's version the caller read: the page with its version and byte count, checked
   * against its html, or the host's refusal (`version_conflict`, `view_not_found`, ...). Throws
   * `HostedRouteNotServed` on a host without the route, and the transport's errors otherwise.
   */
  readViewContent(bundleId: string, request: HostedViewContentReadRequest): Promise<HostedViewContentReadResult>;
  /**
   * Replace a registered View's page whole (`<prefix>/view-content-update`,
   * `views.content.update.v1`), pinned to the registration's version and the page's. Sent once and
   * never resent: an answer that may follow an applied update and cannot be read (no answer, a
   * `5xx` without the operation's refusal) is the refusal `write_outcome_unknown`, `writeState:
   * "unknown"`, for the caller to settle by reading the page again. A request refused before it
   * left (`RangeError`, the transport's `denied`) and a host without the route
   * (`HostedRouteNotServed`) throw. Uploading a page never approves its execution.
   */
  updateViewContent(bundleId: string, request: HostedViewContentUpdateRequest): Promise<HostedViewContentUpdateResult>;
}

/**
 * The sync family under a protected resource's audience: `/sync/v1` for the Superbee API
 * (`<origin>/mcp`), `/agents/<uuid>/sync/v1` for an agent connection. Null for any other
 * audience, which has no sync family.
 */
export function syncRoutePrefix(resource: { readonly origin: string; readonly audience: string }): string | null {
  const { origin, audience } = resource;
  // The audience must be on the origin itself, not on another host whose name merely starts the same.
  if (!audience.startsWith(origin) || (audience.length > origin.length && audience[origin.length] !== "/")) return null;
  const audiencePath = audience.slice(origin.length);
  if (audiencePath === "/mcp") return "/sync/v1";
  if (AGENT_AUDIENCE_PATH.test(audiencePath)) return `${audiencePath.slice(0, -"/mcp".length)}/sync/v1`;
  return null;
}

function syncReadRoutes(prefix: string): HostedReadRoutes {
  return Object.freeze({
    capabilities: `${prefix}/capabilities`,
    heads: `${prefix}/heads`,
    snapshot: `${prefix}/snapshot`,
    read: `${prefix}/read`,
  });
}

/**
 * The sync routes whose body never names one bundle by reference: `whoami` and `bundles` span the
 * person's workspaces, and `bundle-create` and the staged creation's four routes name their
 * workspace in the body (the blob route in its headers) and a bundle that does not exist yet.
 * Every other route under the family's prefix is bundle-scoped, the host's own rule, so a route
 * added later is qualified by default rather than read as an absent bundle once an id collides.
 */
const UNSCOPED_ROUTES = Object.freeze([
  "whoami",
  "bundles",
  "bundle-create",
  "bundle-create-begin",
  "bundle-create-stage",
  "bundle-create-blob",
  "bundle-create-commit",
] as const);

/**
 * The carrier with a workspace: every bundle-scoped request names its bundle as
 * `<slug>/<bundle-id>`, so the host selects that workspace's bundle. The host's answers still
 * name the bare id. An id that already names a workspace is a caller's mistake (a `TypeError`),
 * as is a raw body sent to a bundle-scoped route other than an ordinary blob create/replace.
 */
export function qualifyingCarrier(carrier: HostedCarrier, prefix: string, slug: string): HostedCarrier {
  const unscoped = new Set(UNSCOPED_ROUTES.map((route) => `${prefix}/${route}`));
  const blobUploads = new Set([`${prefix}/blob-create`, `${prefix}/blob-replace`]);
  const scoped = (route: string) => route.startsWith(`${prefix}/`) && !unscoped.has(route);
  const qualify = (route: string, input: unknown): unknown => {
    if (!scoped(route) || input === null || typeof input !== "object" || Array.isArray(input)) return input;
    const bundleId = (input as { bundleId?: unknown }).bundleId;
    if (typeof bundleId !== "string") return input;
    if (bundleId.includes("/")) throw new TypeError("a qualified reference sent through a qualifying client");
    return { ...input, bundleId: hostedBundleReferenceText({ slug, bundleId }) };
  };
  const bytes = carrier.bytes?.bind(carrier);
  return {
    json: async (route, input, signal, options) => carrier.json(route, qualify(route, input), signal, options),
    stream: async (route, input, signal) => carrier.stream(route, qualify(route, input), signal),
    // Ordinary blob uploads name their bundle in one route header, not in the binary body.
    ...(bytes
      ? {
          bytes: async (route: string, body: Uint8Array, signal: AbortSignal, options: Parameters<NonNullable<HostedCarrier["bytes"]>>[3]) => {
            if (blobUploads.has(route)) {
              const entries = Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() === "x-superbee-bundle");
              if (entries.length !== 1) throw new TypeError("a blob upload must name exactly one bundle header");
              const [name, value] = entries[0]!;
              const reference = typeof value === "string" ? parseHostedBundleReference(value) : null;
              if (reference === null || reference.slug !== null) throw new TypeError("a blob upload through a qualifying client must name a bare hosted bundle id");
              return bytes(route, body, signal, { ...options, headers: { ...options.headers, [name]: hostedBundleReferenceText({ slug, bundleId: reference.bundleId }) } });
            }
            if (scoped(route)) throw new TypeError(`a raw body sent to the bundle-scoped route ${route} through a qualifying client`);
            return bytes(route, body, signal, options);
          },
        }
      : {}),
  };
}

/** A client of the hosted sync family at `options.target`, authenticated by `options.credentials`. */
export function createHostedClient(options: HostedClientOptions): HostedClient {
  const { syncPrefix } = options.target;
  if (typeof syncPrefix !== "string" || !syncPrefix.startsWith("/") || syncPrefix.endsWith("/")) {
    throw new TypeError("a hosted client's sync prefix is an absolute path without a trailing slash");
  }
  if (typeof options.credentials !== "function") throw new TypeError("a hosted client needs a credential provider");
  // One binding per client instance, shared by its `within` clients: a digest of a random id, as a
  // checkout's is, so the id itself never leaves.
  const writes: ClientWrites = {
    binding: checkoutBindingDigest(mintRequestId()),
    store: options.intentStore ?? createMemoryIntentStore(),
    inFlight: new Map<string, Promise<unknown>>(),
    capabilities: createCapabilitiesCache(options.capabilitiesTtlMs, options.now),
    blobJournal: options.blobJournal ?? createMemoryBlobJournal(),
    blobLocks: new Map<string, Promise<unknown>>(),
  };
  return clientIn(options, options.signal ?? new AbortController().signal, undefined, writes);
}

/** What a client and its `within` clients share for writes. */
interface ClientWrites {
  readonly binding: string;
  readonly store: HostedIntentStore;
  readonly inFlight: Map<string, Promise<unknown>>;
  readonly capabilities: HostedCapabilitiesCache;
  readonly blobJournal: BlobJournaledBackend;
  readonly blobLocks: Map<string, Promise<unknown>>;
}

/** The client, naming its bundles in the workspace with `slug` when there is one. */
function clientIn(options: HostedClientOptions, signal: AbortSignal, slug: string | undefined, writes: ClientWrites): HostedClient {
  const { target } = options;
  const prefix = target.syncPrefix;
  const fetchCarrier = createFetchCarrier({
    baseUrl: target.origin,
    credentials: options.credentials,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
  const carrier = slug === undefined ? fetchCarrier : qualifyingCarrier(fetchCarrier, prefix, slug);
  const writeContext: HostedBlobContext = {
    ...writes,
    prefix,
    workspace: slug ?? null,
    signal,
    ...(options.writeRecovery?.lookupDelayMs !== undefined ? { lookupDelayMs: options.writeRecovery.lookupDelayMs } : {}),
    readRoutes: syncReadRoutes(prefix),
    // A recorded write is looked up in the workspace it was sent in, whichever client asks.
    carrierFor: (workspace) => (workspace === null ? fetchCarrier : qualifyingCarrier(fetchCarrier, prefix, workspace)),
    origin: new URL(target.origin).origin,
  };

  /** An unscoped read: the body on a `200`, otherwise the host's refusal as a `RemoteError`. */
  async function json(route: string, maximum: number): Promise<unknown> {
    const answer = await carrier.json(`${prefix}/${route}`, {}, signal, { maximum });
    if (answer.status !== 200) {
      const code = (answer.body as { error?: { code?: unknown } | unknown } | undefined)?.error;
      const named = typeof code === "string" ? code : typeof (code as { code?: unknown })?.code === "string" ? (code as { code: string }).code : undefined;
      throw new RemoteError(`hosted ${route} answered ${answer.status}`, named ?? "RUNTIME", answer.status);
    }
    return answer.body;
  }

  /**
   * One request of a route a gateway may not have yet. That gateway answers the family's
   * unknown-route 404, which is {@link HostedRouteNotServed}. An answer larger than `maximum` is
   * the carrier's `unavailable` whose cause is `HostedAnswerTooLarge` (see `isAnswerTooLarge`).
   */
  async function send(route: string, input: unknown, maximum: number): Promise<HostedAnswer> {
    const answer = await carrier.json(route, input, signal, { maximum });
    if (answer.status === 404 && isUnknownRoute(answer.body)) throw new HostedRouteNotServed(route);
    return answer;
  }

  return {
    target,
    prefix,
    carrier,
    signal,
    async whoami() {
      const route = `${prefix}/whoami`;
      const body = (await json("whoami", IDENTITY_BYTES)) as { principalId?: unknown; tenantIds?: unknown; workspaces?: unknown; limits?: unknown; email?: unknown; targetAuthorityKey?: unknown; notificationDirectoryWorkspaces?: unknown } | undefined;
      if (
        typeof body?.principalId !== "string" ||
        body.principalId === "" ||
        !Array.isArray(body.tenantIds) ||
        !body.tenantIds.every((id): id is string => typeof id === "string")
      ) {
        throw new MalformedAnswer("not an identity", route);
      }
      const tenantIds = [...body.tenantIds].sort();
      // A host from before qualified references names no slugs.
      const slugs = new Map<string, string | null>();
      if (body.workspaces !== undefined) {
        if (
          !Array.isArray(body.workspaces) ||
          body.workspaces.length !== tenantIds.length ||
          !body.workspaces.every(
            (w) =>
              typeof w?.tenantId === "string" &&
              tenantIds.includes(w.tenantId) &&
              (w.slug === null || isWorkspaceSlug(w.slug)),
          )
        ) {
          throw new MalformedAnswer("not an identity's workspaces", route);
        }
        for (const w of body.workspaces as { tenantId: string; slug: string | null }[]) slugs.set(w.tenantId, w.slug);
        if (slugs.size !== tenantIds.length) throw new MalformedAnswer("an identity naming a workspace twice", route);
      }
      return {
        principalId: body.principalId,
        tenantIds,
        workspaces: tenantIds.map((tenantId) => ({ tenantId, slug: slugs.get(tenantId) ?? null })),
        documentInputBytes: statedDocumentInputBytes(body.limits),
        email: typeof body.email === "string" && /^[^\s\p{Cc}\p{Cf}]{3,320}$/u.test(body.email) ? body.email : null,
        ...(isAuthorityKey(body.targetAuthorityKey) ? { targetAuthorityKey: body.targetAuthorityKey } : {}),
        ...directoryWorkspaces(body.notificationDirectoryWorkspaces, tenantIds),
      };
    },
    async bundles() {
      const body = (await json("bundles", BUNDLES_BYTES)) as
        | { ok?: unknown; data?: { bundles?: unknown }; error?: { code?: unknown } }
        | undefined;
      if (body?.ok === false) {
        const code = typeof body.error?.code === "string" ? body.error.code : "RUNTIME";
        throw new RemoteError(`hosted bundles answered ${code}`, code, code === "insufficient_scope" ? 403 : 422);
      }
      const rows = body?.data?.bundles;
      if (body?.ok !== true || !Array.isArray(rows)) throw new MalformedAnswer("not a bundle list", `${prefix}/bundles`);
      return rows
        .filter((row): row is { bundleId: string; name: string; lifecycle?: unknown } => typeof row?.bundleId === "string" && typeof row?.name === "string")
        .map((row) => ({ bundleId: row.bundleId, name: row.name, lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : null }));
    },
    reader(bundleId) {
      return createHostedReadAdapter({ carrier, bundleId, routes: syncReadRoutes(prefix) });
    },
    within(workspace) {
      return clientIn(options, signal, workspace, writes);
    },
    write: (bundleId, input, writeOptions) => hostedWrite(writeContext, bundleId, input, writeOptions),
    lookupWrite: (requestId, lookupOptions) => hostedLookupWrite(writeContext, requestId, lookupOptions),
    settleWrite: (requestId, settleOptions) => hostedSettleWrite(writeContext, requestId, settleOptions),
    heldWrites: () => hostedHeldWrites(writeContext),
    writeBlob: (bundleId, input, blobOptions) => hostedWriteBlob(writeContext, bundleId, input, blobOptions),
    deleteBlob: (bundleId, input, blobOptions) => hostedDeleteBlob(writeContext, bundleId, input, blobOptions),
    lookupBlobWrite: (requestId, lookupOptions) => hostedLookupBlobWrite(writeContext, requestId, lookupOptions),
    settleBlobWrite: (requestId, settleOptions) => hostedSettleBlobWrite(writeContext, requestId, settleOptions),
    forgetBlobWrite: (requestId, forgetOptions) => hostedForgetBlobWrite(writeContext, requestId, forgetOptions),
    heldBlobWrites: () => hostedHeldBlobWrites(writeContext),
    blobHeads: (bundleId, readOptions) => hostedBlobHeads(writeContext, bundleId, readOptions),
    blobHead: (bundleId, key, readOptions) => hostedBlobHead(writeContext, bundleId, key, readOptions),
    readBlob: (bundleId, key, readOptions) => hostedReadBlob(writeContext, bundleId, key, readOptions),
    async readViewContent(bundleId, request) {
      const route = `${prefix}/view-content-read`;
      const answer = await send(route, viewContentReadBody(bundleId, request), VIEW_CONTENT_READ_ANSWER_BYTES);
      if (answer.status === 200 && (answer.body as { ok?: unknown } | undefined)?.ok === true) {
        return { ok: true, content: decodeViewContentRead(bundleId, request, answer.body, route) };
      }
      if (answer.status === 401) throw readRefusal(answer);
      const refusal = viewContentRefusal(answer.status, answer.body, VIEW_CONTENT_READ_OPERATION, "not_applied", route);
      if (refusal) return { ok: false, refusal };
      if (answer.status === 200) throw new MalformedAnswer(`view-content-read answered an envelope that is not ${VIEW_CONTENT_READ_OPERATION}'s result`, route);
      throw readRefusal(answer);
    },
    async updateViewContent(bundleId, request) {
      const route = `${prefix}/view-content-update`;
      const { body, bytes } = viewContentUpdateBody(bundleId, request);
      let answer: HostedAnswer;
      try {
        answer = await send(route, body, VIEW_CONTENT_UPDATE_ANSWER_BYTES);
      } catch (error) {
        // `denied` sent nothing; `unavailable` may have left and been applied.
        if (error instanceof HostedCarrierError && error.code === "unavailable") return { ok: false, refusal: unknownOutcome(0, "no answer was read; the update may have been applied") };
        throw error;
      }
      if (answer.status === 200 && (answer.body as { ok?: unknown } | undefined)?.ok === true) {
        return { ok: true, update: decodeViewContentUpdate(bundleId, request, bytes, answer.body, route) };
      }
      if (answer.status === 401) throw readRefusal(answer);
      let refusal;
      try {
        // A refusal that states no write state is unknown only where the host may have failed mid-write.
        refusal = viewContentRefusal(answer.status, answer.body, VIEW_CONTENT_UPDATE_OPERATION, answer.status >= 500 ? "unknown" : "not_applied", route);
      } catch (error) {
        // A failure answer this client cannot read says nothing about whether the update applied.
        if (isMalformedAnswer(error) && answer.status >= 500) return { ok: false, refusal: unknownOutcome(answer.status, "the host's failure answer could not be read; the update may have been applied") };
        throw error;
      }
      if (refusal) return { ok: false, refusal };
      if (answer.status >= 500) return { ok: false, refusal: unknownOutcome(answer.status, `the host answered ${answer.status}; the update may have been applied`) };
      if (answer.status === 200) throw new MalformedAnswer(`view-content-update answered an envelope that is not ${VIEW_CONTENT_UPDATE_OPERATION}'s result`, route);
      throw readRefusal(answer);
    },
    async history(bundleId, request) {
      const route = `${prefix}/history`;
      const answer = await send(route, historyInput(bundleId, request), HOSTED_READ_BOUNDS.historyBytes);
      if (answer.status !== 200) throw readRefusal(answer);
      return decodeHistoryAnswer(request, answer.body, route);
    },
    async listOperations(bundleId) {
      const route = `${prefix}/operations`;
      const answer = await send(route, { bundleId }, HOSTED_READ_BOUNDS.operationsBytes);
      if (answer.status !== 200) {
        // The listing refuses a bundle as capabilities does: a 404 naming the code, never a 200.
        const refusal = answer.status === 404 ? familyRefusal(answer) : undefined;
        if (refusal?.code === "bundle_not_found") return { ok: false, refusal };
        throw readRefusal(answer);
      }
      return { ok: true, listing: decodeOperationListing(answer.body, route) };
    },
    async runOperation(bundleId, operationId, input, runOptions = {}) {
      const route = `${prefix}/run`;
      const answer = await send(route, operationRunBody(bundleId, operationId, input), runOptions.maximumBytes ?? HOSTED_READ_BOUNDS.runBytes);
      if (answer.status !== 200) {
        // The route's own refusals of the request, before any operation ran: an id the host does
        // not run by id, and an envelope or input it refuses. Both are typed, for the caller to word.
        const refusal = answer.status === 400 ? familyRefusal(answer) : undefined;
        if (refusal?.code === "unknown_operation" || refusal?.code === "invalid_input") return { ok: false, refusal };
        throw readRefusal(answer);
      }
      return decodeOperationRun(operationId, answer.body, route);
    },
  };
}

/** The document target decoder's key rule: printable ASCII without a slash or backslash, at most 256 characters. */
function isAuthorityKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value) && !/[\\/]/.test(value);
}

/**
 * The stated directory workspaces the identity belongs to, sorted and once each; nothing when the
 * field is absent, not a list, or names none of them. An entry outside `tenantIds` is dropped: the
 * directory is only ever offered in a workspace the person is in.
 */
function directoryWorkspaces(value: unknown, tenantIds: readonly string[]): { notificationDirectoryWorkspaces?: readonly string[] } {
  if (!Array.isArray(value)) return {};
  const offered = tenantIds.filter((tenantId) => value.includes(tenantId));
  return offered.length === 0 ? {} : { notificationDirectoryWorkspaces: offered };
}

/** The sync family's answer to a route it does not have: `404 {"error":"not_found"}`, nothing else. */
function isUnknownRoute(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && (body as { error?: unknown }).error === "not_found";
}
