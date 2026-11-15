// Running a port operation by id against a hosted Sync door (`<prefix>/run`). Every hosted door
// calls one operations port, `run(operation, input)`; this is the client's side of it, used for
// operations run by id, document reads and document history alike.
//
// The one older-host fallback lives here. A host from before it ran an operation by id answers the
// run route's `400 unknown_operation` (or, with no `run` at all, the family's unknown-route 404).
// For an operation that host served on a route of its own ({@link ROUTE_BEFORE_RUN}), the runner
// sends the operation's input there instead, and keeps doing so for that operation for the rest
// of its life. Both routes answer the same `OperationResult` bytes, so a caller decodes one shape.
import type { HostedAnswer, HostedCarrier } from "./carrier.js";
import { familyRefusal } from "./read-adapter.js";

/**
 * The routes older hosts served an operation on before `run` ran it by id: superbee-hosted
 * `src/sync-v1-reads.ts` `operationRoutes` (`run` serves both since superbee-hosted PR 1778).
 */
export const ROUTE_BEFORE_RUN: Readonly<Record<string, string>> = Object.freeze({
  "documents.read.v1": "read",
  "documents.history.v1": "history",
});

export interface HostedPortRunOptions {
  /** The most bytes the answer may take. */
  readonly maximum: number;
  /** A checkout binding to pin, where the family binds reads. */
  readonly binding?: string;
  /** False runs by id only, with no older-host route (`superbee op run`, which names the id itself). */
  readonly fallback?: boolean;
}

/** One run's answer and the route that gave it (`<prefix>/run`, or an older host's own route). */
export interface HostedPortRunAnswer {
  readonly route: string;
  readonly answer: HostedAnswer;
}

export interface HostedPortRunner {
  /**
   * Runs `operationId` with `input` for `bundleId`. `input` names the same bundle (or none; it is
   * set). The answer is returned as the host gave it, refusals included, for the caller to decode.
   */
  run(bundleId: string, operationId: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal, options: HostedPortRunOptions): Promise<HostedPortRunAnswer>;
}

/** The family's answer to a route it does not have: `404 {"error":"not_found"}`, nothing else. */
export function isUnknownRouteAnswer(answer: { status: number; body: unknown }): boolean {
  const body = answer.body;
  return answer.status === 404 && typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && (body as { error?: unknown }).error === "not_found";
}

/** Whether a run's answer says this host does not run the operation by id. */
function notRunById(answer: HostedAnswer): boolean {
  return isUnknownRouteAnswer(answer) || (answer.status === 400 && familyRefusal(answer)?.code === "unknown_operation");
}

export function createPortRunner(options: { readonly carrier: HostedCarrier; readonly prefix: string }): HostedPortRunner {
  const { carrier, prefix } = options;
  /** The operations this host refused by id that it serves on a route of their own. */
  const byRoute = new Set<string>();
  return {
    async run(bundleId, operationId, input, signal, runOptions) {
      const body = { ...input, bundleId };
      const send = (route: string, payload: unknown) =>
        carrier.json(route, payload, signal, { maximum: runOptions.maximum, ...(runOptions.binding ? { binding: runOptions.binding } : {}) }).then((answer) => ({ route, answer }));
      const fallback = runOptions.fallback !== false && Object.hasOwn(ROUTE_BEFORE_RUN, operationId) ? `${prefix}/${ROUTE_BEFORE_RUN[operationId]}` : undefined;
      if (fallback && byRoute.has(operationId)) return send(fallback, body);
      const ran = await send(`${prefix}/run`, { bundleId, operationId, input: body });
      if (!fallback || !notRunById(ran.answer)) return ran;
      byRoute.add(operationId);
      return send(fallback, body);
    },
  };
}
