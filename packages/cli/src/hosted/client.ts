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
  HISTORY_ANSWER_BYTES,
  historyInput,
  HostedCarrierError,
  readRefusal,
  type HostedCarrier,
  type HostedHistoryPage,
  type HostedHistoryRefusal,
  type HostedHistoryRequest,
  type HostedReadAdapter,
  type HostedReadRoutes,
} from "@superbee/core/hosted-transport";
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
  history(bundleId: string, request: HostedHistoryRequest): Promise<{ ok: true; page: HostedHistoryPage } | { ok: false; refusal: HostedHistoryRefusal }>;
}

export interface HostedIdentity {
  readonly principalId: string;
  readonly tenantIds: readonly string[];
}

export interface HostedBundleRow {
  readonly bundleId: string;
  readonly name: string;
  /** `active`, or another lifecycle the host names (archived, for example); null when it names none. */
  readonly lifecycle: string | null;
}

/** The host answers at most this many bundle rows (the kernel's list cap, applied across tenants). */
export const BUNDLE_LIST_CAP = 100;

/** A bundle list read as a whole: each id once, how many of the person's workspaces hold it, and whether the cap cut it. */
export interface HostedBundleListing {
  readonly bundles: ReadonlyMap<string, { readonly row: HostedBundleRow; readonly workspaces: number }>;
  /** False when the host's answer reached {@link BUNDLE_LIST_CAP}, so more bundles may exist. */
  readonly complete: boolean;
}

/**
 * One reading of the host's rows. The host answers one row per workspace that serves an id, and
 * refuses an id two workspaces serve, so a count above one is an ambiguous id.
 */
export function readBundleListing(rows: readonly HostedBundleRow[]): HostedBundleListing {
  const bundles = new Map<string, { row: HostedBundleRow; workspaces: number }>();
  for (const row of rows) {
    const seen = bundles.get(row.bundleId);
    bundles.set(row.bundleId, seen ? { row: seen.row, workspaces: seen.workspaces + 1 } : { row, workspaces: 1 });
  }
  return { bundles, complete: rows.length < BUNDLE_LIST_CAP };
}

/**
 * The header that names the workspace a request means. The sync routes select the tenant from the
 * bundle and do not read it yet; it is sent so a host that learns to select by it needs no client
 * change, and it never widens anything (the tenant must still be one the admission reached).
 */
export const WORKSPACE_HEADER = "X-Superbee-Workspace";

export interface HostedClientOptions {
  readonly target: HostedTarget;
  readonly accessToken: string;
  /** The workspace the person named, sent on every request as {@link WORKSPACE_HEADER}. */
  readonly workspace?: string;
  /** The command that repeats this one, carried on an AUTH_REQUIRED so an agent can resume it. */
  readonly resume?: string;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
}

export function createHostedSyncClient(options: HostedClientOptions): HostedSyncClient {
  const { target } = options;
  const prefix = syncRoutePrefix(target);
  const carrier = createFetchCarrier({
    baseUrl: target.origin,
    credentials: async () => ({
      Authorization: `Bearer ${options.accessToken}`,
      ...(options.workspace !== undefined ? { [WORKSPACE_HEADER]: options.workspace } : {}),
    }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
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
      const body = (await json("whoami", IDENTITY_BYTES)) as { principalId?: unknown; tenantIds?: unknown } | undefined;
      if (
        typeof body?.principalId !== "string" ||
        body.principalId === "" ||
        !Array.isArray(body.tenantIds) ||
        !body.tenantIds.every((id): id is string => typeof id === "string")
      ) {
        throw new CliError("RUNTIME", `${target.origin} answered a malformed identity`);
      }
      return { principalId: body.principalId, tenantIds: [...body.tenantIds].sort() };
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
    async history(bundleId, request) {
      const route = `${prefix}/history`;
      let answer;
      try {
        answer = await carrier.json(route, historyInput(bundleId, request), controller.signal, { maximum: HISTORY_ANSWER_BYTES });
      } catch (error) {
        throw hostedFailure(error, target, options.resume);
      }
      // A gateway from before the route answers the family's own 404 for an unknown route.
      if (answer.status === 404) {
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
