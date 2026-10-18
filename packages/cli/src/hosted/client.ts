// The CLI's side of the hosted sync route family (`/sync/v1`): core's hosted client
// (`@superbee/core/hosted-client`) with the CLI's discovered target and signed-in bearer, and one
// translation from that client's typed failures to the CLI's error taxonomy.
//
// The access token is obtained before any request is built, through the sign-in module, so a
// structured AUTH_REQUIRED (with its one sign-in link) reaches the agent unchanged. A request the
// host refuses as unauthenticated becomes AUTH_REQUIRED naming the login command.
import {
  bearerCredentials,
  createHostedClient,
  HostedAnswerTooLarge,
  HostedCarrierError,
  isAnswerTooLarge,
  isMalformedAnswer,
  isRouteNotServed,
  RemoteError,
  syncRoutePrefix as coreSyncRoutePrefix,
  type HostedClient,
} from "@superbee/core/hosted-client";
import type { HostedOperationListingAnswer, HostedOperationRun, JsonObject } from "@superbee/core/hosted-transport";

import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { commandToken } from "../command-text.js";
import { hostArgument } from "../hosted-auth/session.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";

// The qualifying carrier is core's; this name stays importable here for the CLI's own tests.
export { qualifyingCarrier } from "@superbee/core/hosted-client";

/**
 * The sync family under a target's audience: `/sync/v1` for the Superbee API (`<origin>/mcp`),
 * `/agents/<uuid>/sync/v1` for an agent connection. Any other audience is a usage error.
 */
export function syncRoutePrefix(target: HostedTarget): string {
  const prefix = coreSyncRoutePrefix(target);
  if (prefix !== null) return prefix;
  throw new CliError("USAGE", `${target.audience} has no hosted sync routes`, {
    help: "pass --host with a Superbee origin or an agent connection URL",
  });
}

/**
 * Core's hosted client under the CLI's target, its failures in the CLI's words. The CLI writes
 * documents and blobs through its checkout sync, so the one-call writes are not part of it.
 */
export interface HostedSyncClient
  extends Omit<
    HostedClient,
    | "target" | "within" | "listOperations" | "runOperation" | "write" | "lookupWrite" | "settleWrite" | "heldWrites"
    | "writeBlob" | "deleteBlob" | "lookupBlobWrite" | "settleBlobWrite" | "forgetBlobWrite" | "heldBlobWrites" | "blobHeads" | "blobHead" | "readBlob"
  > {
  readonly target: HostedTarget;
  /** The same client, naming its bundles in the workspace with this slug. */
  within(slug: string): HostedSyncClient;
  listOperations(bundleId: string, options?: OperationRouteOptions): Promise<HostedOperationListingAnswer>;
  runOperation(bundleId: string, operationId: string, input: JsonObject, options?: OperationRouteOptions & { readonly maximumBytes?: number }): Promise<HostedOperationRun>;
}

/** What a caller adds to the operations routes' answers. */
export interface OperationRouteOptions {
  /**
   * Appended to the help of the `NOT_IMPLEMENTED` a gateway from before the routes is: the
   * caller's own pointer (a command's typed verbs, say), since the client names no command.
   */
  readonly unavailableHelp?: string;
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
  const { target } = options;
  const core = createHostedClient({
    target: { origin: target.origin, syncPrefix: syncRoutePrefix(target) },
    credentials: bearerCredentials(() => options.accessToken),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
  return wording(core, target, options.resume);
}

function wording(client: HostedClient, target: HostedTarget, resume: string | undefined): HostedSyncClient {
  const { prefix } = client;
  const failure = (error: unknown) => hostedFailure(error, target, resume);

  /**
   * A read of a route a gateway may not have yet: that gateway's answer is `NOT_IMPLEMENTED` in
   * the route's own words. An answer larger than its bound is the host's deterministic answer, not
   * an outage: a non-retryable RUNTIME.
   */
  const readFailure = (error: unknown, route: string, missing: { message: string; help: string }) => {
    if (isRouteNotServed(error)) {
      return new CliError("NOT_IMPLEMENTED", missing.message, { details: { host: target.origin, route: error.route, status: 404 }, help: missing.help });
    }
    if (isAnswerTooLarge(error)) {
      const maximum = ((error as HostedCarrierError).cause as HostedAnswerTooLarge).maximum;
      return new CliError("RUNTIME", `${target.origin} answered ${route} with more than ${maximum} bytes`, {
        details: { host: target.origin, route, code: "result_too_large", maximum, retryable: false },
      });
    }
    return failure(error);
  };

  /** A gateway from before the operations routes, in words that name no command, then the caller's. */
  const operationsMissing = (routeOptions: OperationRouteOptions): { message: string; help: string } => {
    const help = "a later release of the host offers them";
    return { message: `${target.origin} does not offer operations by id yet`, help: routeOptions.unavailableHelp ? `${help}; ${routeOptions.unavailableHelp}` : help };
  };

  return {
    target,
    prefix,
    carrier: client.carrier,
    signal: client.signal,
    async whoami() {
      try {
        return await client.whoami();
      } catch (error) {
        if (isMalformedAnswer(error)) throw new CliError("RUNTIME", `${target.origin} answered a malformed identity`);
        throw failure(error);
      }
    },
    async bundles() {
      try {
        return await client.bundles();
      } catch (error) {
        if (isMalformedAnswer(error)) throw new CliError("RUNTIME", `${target.origin} answered a malformed bundle list`);
        throw failure(error);
      }
    },
    reader(bundleId) {
      return client.reader(bundleId);
    },
    within(slug) {
      return wording(client.within(slug), target, resume);
    },
    async history(bundleId, request) {
      try {
        return await client.history(bundleId, request);
      } catch (error) {
        throw readFailure(error, `${prefix}/history`, {
          message: `${target.origin} does not serve document history yet`,
          help: `a later release of the host serves it; until then ${cliInvocation()} doc read ${commandToken(request.documentId)} shows the current version`,
        });
      }
    },
    async listOperations(bundleId, listOptions = {}) {
      try {
        return await client.listOperations(bundleId);
      } catch (error) {
        throw readFailure(error, `${prefix}/operations`, operationsMissing(listOptions));
      }
    },
    async runOperation(bundleId, operationId, input, runOptions = {}) {
      try {
        return await client.runOperation(bundleId, operationId, input, runOptions.maximumBytes === undefined ? {} : { maximumBytes: runOptions.maximumBytes });
      } catch (error) {
        throw readFailure(error, `${prefix}/run`, operationsMissing(runOptions));
      }
    },
  };
}

function loginHelp(target: HostedTarget): string {
  return `${cliInvocation()} login --host ${commandToken(hostArgument(target))}`;
}

/**
 * One translation from the hosted client's and transport's failures to the CLI taxonomy. An
 * unauthenticated answer is AUTH_REQUIRED naming the login command; a withdrawn grant is
 * FORBIDDEN; a carrier failure is TRANSIENT (the request may not have been answered); an answer
 * the client cannot read is a non-retryable RUNTIME naming the route. Any other error passes through.
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
