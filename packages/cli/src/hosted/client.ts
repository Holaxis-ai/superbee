// The CLI's side of the hosted sync route family (`/sync/v1`): a bearer carrier over core's
// shared hosted transport, the identity and bundle-list reads the checkout needs before it opens
// a bundle, and one translation from the transport's failures to the CLI's error taxonomy.
//
// The access token is obtained before any request is built, through the sign-in module, so a
// structured AUTH_REQUIRED (with its one sign-in link) reaches the agent unchanged. A request the
// host refuses as unauthenticated becomes AUTH_REQUIRED naming the login command.
import {
  createFetchCarrier,
  createHostedReadAdapter,
  decodeHistoryAnswer,
  historyInput,
  HOSTED_READ_BOUNDS,
  HostedCarrierError,
  readRefusal,
  type HostedCarrier,
  type HostedHistoryAnswer,
  type HostedHistoryRequest,
  type HostedReadAdapter,
  type HostedReadRoutes,
} from "@superbee/core/hosted-transport";
import { hostedBundleReferenceText, isWorkspaceSlug, parseHostedBundleReference, type HostedBundleReference } from "./reference.js";
import { isMalformedAnswer, RemoteError } from "@superbee/core";

import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { commandToken } from "../command-text.js";
import { hostArgument } from "../hosted-auth/session.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";

const IDENTITY_BYTES = 64 * 1024;
const BUNDLES_BYTES = 256 * 1024;
const AGENT_AUDIENCE_PATH = /^\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/mcp$/;

/**
 * The sync family under a target's audience: `/sync/v1` for the Superbee API (`<origin>/mcp`),
 * `/agents/<uuid>/sync/v1` for an agent connection. Any other audience has no sync family.
 */
export function syncRoutePrefix(target: HostedTarget): string {
  const audiencePath = target.audience.slice(target.origin.length);
  if (audiencePath === "/mcp") return "/sync/v1";
  if (AGENT_AUDIENCE_PATH.test(audiencePath)) return `${audiencePath.slice(0, -"/mcp".length)}/sync/v1`;
  throw new CliError("USAGE", `${target.audience} has no hosted sync routes`, {
    help: "pass --host with a Superbee origin or an agent connection URL",
  });
}

export function syncReadRoutes(prefix: string): HostedReadRoutes {
  return Object.freeze({
    capabilities: `${prefix}/capabilities`,
    heads: `${prefix}/heads`,
    snapshot: `${prefix}/snapshot`,
    read: `${prefix}/read`,
  });
}

export interface HostedSyncClient {
  readonly target: HostedTarget;
  readonly prefix: string;
  readonly carrier: HostedCarrier;
  readonly signal: AbortSignal;
  whoami(): Promise<HostedIdentity>;
  bundles(): Promise<HostedBundleRow[]>;
  reader(bundleId: string): HostedReadAdapter;
  /** One page of a document's history (`documents.history.v1`), validated against the page asked for. */
  history(bundleId: string, request: HostedHistoryRequest): Promise<HostedHistoryAnswer>;
  /** The same client, naming its bundles in the workspace with this slug ({@link qualifyingCarrier}). */
  within(slug: string): HostedSyncClient;
}

export interface HostedIdentity {
  readonly principalId: string;
  readonly tenantIds: readonly string[];
  /**
   * Each workspace with the slug a qualified reference names it by (null for none), in
   * `tenantIds` order. A host from before qualified references reports no slugs: every one is null.
   */
  readonly workspaces: readonly HostedWorkspace[];
}

export interface HostedWorkspace {
  readonly tenantId: string;
  readonly slug: string | null;
}

export interface HostedBundleRow {
  readonly bundleId: string;
  readonly name: string;
  /** `active`, or another lifecycle the host names (archived, for example); null when it names none. */
  readonly lifecycle: string | null;
}

/** The host answers at most this many bundle rows (the kernel's list cap, applied across tenants). */
export const BUNDLE_LIST_CAP = 100;

/** One listed row: the reference the host lists it by (what `checkout` takes), and that reference parsed. */
export interface HostedListedBundle {
  readonly row: HostedBundleRow;
  /** Rows the host listed under this same reference: more than one only from a host from before qualified references. */
  readonly workspaces: number;
  /** The listed reference parsed; null for a row this CLI cannot read as one. */
  readonly reference: HostedBundleReference | null;
}

/**
 * A bundle list read as a whole: each row under the reference it names (the bare id, or
 * `<slug>/<id>` for an id two of the person's workspaces hold), how many rows name it, and whether
 * the cap cut it.
 */
export interface HostedBundleListing {
  readonly bundles: ReadonlyMap<string, HostedListedBundle>;
  /** False when the host's answer reached {@link BUNDLE_LIST_CAP}, so more bundles may exist. */
  readonly complete: boolean;
  /**
   * What the listing says about a reference: the row it names; `holders`, the rows whose bundle id
   * is the reference's own, however listed (bare or qualified); and those rows' qualified
   * references, sorted. A bare id with two or more holders cannot be told apart.
   */
  lookup(reference: HostedBundleReference): {
    readonly row: HostedBundleRow | null;
    readonly holders: number;
    readonly references: readonly string[];
  };
}

/**
 * One reading of the host's rows, each parsed once. The host answers one row per workspace that
 * serves an id, and names an id two workspaces serve by each one's reference. A host from before
 * qualified references (or a workspace with no slug, or a collision past the list cap) lists such
 * an id bare, more than once.
 */
export function readBundleListing(rows: readonly HostedBundleRow[]): HostedBundleListing {
  const bundles = new Map<string, HostedListedBundle>();
  const holders = new Map<string, number>();
  const qualified = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = bundles.get(row.bundleId);
    const reference = seen?.reference ?? parseHostedBundleReference(row.bundleId);
    bundles.set(row.bundleId, { row: seen?.row ?? row, workspaces: (seen?.workspaces ?? 0) + 1, reference });
    if (!reference) continue;
    holders.set(reference.bundleId, (holders.get(reference.bundleId) ?? 0) + 1);
    if (reference.slug !== null) qualified.set(reference.bundleId, (qualified.get(reference.bundleId) ?? new Set()).add(row.bundleId));
  }
  return {
    bundles,
    complete: rows.length < BUNDLE_LIST_CAP,
    lookup(reference) {
      return {
        row: bundles.get(hostedBundleReferenceText(reference))?.row ?? null,
        holders: holders.get(reference.bundleId) ?? 0,
        references: [...(qualified.get(reference.bundleId) ?? [])].sort(),
      };
    },
  };
}

/**
 * The sync routes whose body names one bundle (`bundleId`): the ones a qualified reference is sent
 * on. `whoami`, `bundles` and `bundle-create` (which names its workspace in the body) never are.
 */
const BUNDLE_SCOPED_ROUTES = Object.freeze([
  "capabilities",
  "heads",
  "snapshot",
  "read",
  "history",
  "create",
  "replace",
  "delete",
  "outcome",
  "export",
] as const);

/**
 * The carrier with a workspace: every bundle-scoped request names its bundle as
 * `<slug>/<bundle-id>`, so the host selects that workspace's bundle. Everything else the CLI does
 * keeps the bare id, including reading the host's answers, which name the bare id.
 */
export function qualifyingCarrier(carrier: HostedCarrier, prefix: string, slug: string): HostedCarrier {
  const routes = new Set(BUNDLE_SCOPED_ROUTES.map((route) => `${prefix}/${route}`));
  const qualify = (route: string, input: unknown): unknown => {
    if (!routes.has(route) || input === null || typeof input !== "object" || Array.isArray(input)) return input;
    const bundleId = (input as { bundleId?: unknown }).bundleId;
    if (typeof bundleId !== "string") return input;
    // Only this wrapper qualifies: an id that already names a workspace is a caller's mistake.
    if (bundleId.includes("/")) throw new TypeError("a qualified reference sent through a qualifying client");
    return { ...input, bundleId: hostedBundleReferenceText({ slug, bundleId }) };
  };
  return {
    json: async (route, input, signal, options) => carrier.json(route, qualify(route, input), signal, options),
    stream: async (route, input, signal) => carrier.stream(route, qualify(route, input), signal),
  };
}

export interface HostedClientOptions {
  readonly target: HostedTarget;
  readonly accessToken: string;
  /** The command that repeats this one, carried on an AUTH_REQUIRED so an agent can resume it. */
  readonly resume?: string;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
}

export function createHostedSyncClient(options: HostedClientOptions): HostedSyncClient {
  return clientIn(options, undefined);
}

/** The client, naming its bundles in the workspace with `slug` when there is one ({@link HostedSyncClient.within}). */
function clientIn(options: HostedClientOptions, slug: string | undefined): HostedSyncClient {
  const { target } = options;
  const prefix = syncRoutePrefix(target);
  const fetchCarrier = createFetchCarrier({
    baseUrl: target.origin,
    credentials: async () => ({ Authorization: `Bearer ${options.accessToken}` }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
  const carrier = slug === undefined ? fetchCarrier : qualifyingCarrier(fetchCarrier, prefix, slug);
  const controller = new AbortController();

  async function json(route: string, maximum: number): Promise<unknown> {
    let answer;
    try {
      answer = await carrier.json(`${prefix}/${route}`, {}, controller.signal, { maximum });
    } catch (error) {
      throw hostedFailure(error, target, options.resume);
    }
    if (answer.status !== 200) {
      const code = (answer.body as { error?: { code?: unknown } | unknown } | undefined)?.error;
      const named = typeof code === "string" ? code : typeof (code as { code?: unknown })?.code === "string" ? (code as { code: string }).code : undefined;
      throw hostedFailure(new RemoteError(`hosted ${route} answered ${answer.status}`, named ?? "RUNTIME", answer.status), target, options.resume);
    }
    return answer.body;
  }

  return {
    target,
    prefix,
    carrier,
    signal: controller.signal,
    async whoami() {
      const body = (await json("whoami", IDENTITY_BYTES)) as { principalId?: unknown; tenantIds?: unknown; workspaces?: unknown } | undefined;
      if (
        typeof body?.principalId !== "string" ||
        body.principalId === "" ||
        !Array.isArray(body.tenantIds) ||
        !body.tenantIds.every((id): id is string => typeof id === "string")
      ) {
        throw new CliError("RUNTIME", `${target.origin} answered a malformed identity`);
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
          throw new CliError("RUNTIME", `${target.origin} answered a malformed identity`);
        }
        for (const w of body.workspaces as { tenantId: string; slug: string | null }[]) slugs.set(w.tenantId, w.slug);
        if (slugs.size !== tenantIds.length) throw new CliError("RUNTIME", `${target.origin} answered a malformed identity`);
      }
      return {
        principalId: body.principalId,
        tenantIds,
        workspaces: tenantIds.map((tenantId) => ({ tenantId, slug: slugs.get(tenantId) ?? null })),
      };
    },
    async bundles() {
      const body = (await json("bundles", BUNDLES_BYTES)) as
        | { ok?: unknown; data?: { bundles?: unknown }; error?: { code?: unknown } }
        | undefined;
      if (body?.ok === false) {
        const code = typeof body.error?.code === "string" ? body.error.code : "RUNTIME";
        throw hostedFailure(new RemoteError(`hosted bundles answered ${code}`, code, code === "insufficient_scope" ? 403 : 422), target, options.resume);
      }
      const rows = body?.data?.bundles;
      if (body?.ok !== true || !Array.isArray(rows)) throw new CliError("RUNTIME", `${target.origin} answered a malformed bundle list`);
      return rows
        .filter((row): row is { bundleId: string; name: string; lifecycle?: unknown } => typeof row?.bundleId === "string" && typeof row?.name === "string")
        .map((row) => ({ bundleId: row.bundleId, name: row.name, lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : null }));
    },
    reader(bundleId) {
      return createHostedReadAdapter({ carrier, bundleId, routes: syncReadRoutes(prefix) });
    },
    within(slug) {
      return clientIn(options, slug);
    },
    async history(bundleId, request) {
      const route = `${prefix}/history`;
      let answer;
      try {
        answer = await carrier.json(route, historyInput(bundleId, request), controller.signal, { maximum: HOSTED_READ_BOUNDS.historyBytes });
      } catch (error) {
        throw hostedFailure(error, target, options.resume);
      }
      // A gateway from before the route answers the family's own unknown-route 404, exactly this body.
      if (answer.status === 404 && isUnknownRoute(answer.body)) {
        throw new CliError("NOT_IMPLEMENTED", `${target.origin} does not serve document history yet`, {
          details: { host: target.origin, route, status: 404 },
          help: `a later release of the host serves it; until then ${cliInvocation()} doc read ${commandToken(request.documentId)} shows the current version`,
        });
      }
      if (answer.status !== 200) throw hostedFailure(readRefusal(answer), target, options.resume);
      try {
        return decodeHistoryAnswer(request, answer.body, route);
      } catch (error) {
        throw hostedFailure(error, target, options.resume);
      }
    },
  };
}

/** The sync family's answer to a route it does not have: `404 {"error":"not_found"}`, nothing else. */
function isUnknownRoute(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && (body as { error?: unknown }).error === "not_found";
}

function loginHelp(target: HostedTarget): string {
  return `${cliInvocation()} login --host ${commandToken(hostArgument(target))}`;
}

/**
 * One translation from the hosted transport's failures to the CLI taxonomy. An unauthenticated
 * answer is AUTH_REQUIRED naming the login command; a withdrawn grant is FORBIDDEN; a carrier
 * failure is TRANSIENT (the request may not have been answered); an answer the client cannot
 * read is a non-retryable RUNTIME naming the route. Any other error passes through.
 */
export function hostedFailure(error: unknown, target: HostedTarget, resume?: string): unknown {
  if (error instanceof CliError) return error;
  if (error instanceof HostedCarrierError) {
    return new CliError("TRANSIENT", `could not reach ${target.origin} (${error.code === "denied" ? "no credential" : "no answer"})`, {
      details: { host: target.origin, retryable: true },
      help: "retry the same command",
    });
  }
  if (isMalformedAnswer(error)) {
    // The host answered, and the client cannot read what it said: the same request gets the same
    // answer, so retrying never helps. It is a client/host contract mismatch to report or upgrade past.
    const route = error.route ?? "unknown";
    return new CliError("RUNTIME", `${target.origin} answered ${route} with an answer this CLI cannot read (client/host contract mismatch)`, {
      details: { host: target.origin, route, code: error.code, reason: error.message, retryable: false },
      help: "upgrade Superbee (npm install -g superbee); retrying the same command gets the same answer, so if it persists, report this route and reason",
    });
  }
  if (error instanceof RemoteError) {
    const status = error.status;
    const code = error.code;
    if (status === 401 || code === "AUTH_REQUIRED" || code === "unauthenticated" || code === "invalid_token") {
      return new CliError("AUTH_REQUIRED", `${target.origin} did not accept the hosted session`, {
        details: { host: target.origin, audience: target.audience, code, ...(resume ? { resume } : {}) },
        help: resume ? `${loginHelp(target)}, then re-run: ${resume}` : loginHelp(target),
      });
    }
    if (status === 403 || code === "insufficient_scope" || code === "access_denied") {
      return new CliError("FORBIDDEN", `${target.origin} refused access (${code})`, {
        details: { host: target.origin, code },
        help: `${cliInvocation()} whoami --host ${commandToken(hostArgument(target))}`,
      });
    }
    if (status >= 500 || code === "SNAPSHOT_TRUNCATED" || code === "SNAPSHOT_DIGEST_MISMATCH") {
      return new CliError("TRANSIENT", `${target.origin} is unavailable (${code})`, {
        details: { host: target.origin, code, retryable: true },
        help: "retry the same command",
      });
    }
    return new CliError("RUNTIME", `${target.origin} refused the request (${code})`, { details: { host: target.origin, code, status } });
  }
  return error;
}
