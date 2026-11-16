// Running a port operation by id against a hosted Sync door (`<prefix>/run`). Every hosted door
// calls one operations port, `run(operation, input)`; this is the client's side of it, used for
// operations run by id, document reads and document history alike.
//
// The one older-host fallback lives here. A host from before it ran an operation by id answers the
// run route's `400 unknown_operation` (or, with no `run` at all, the family's unknown-route 404).
// For an operation that host served on a route of its own ({@link ROUTE_BEFORE_RUN}), the runner
// sends the operation's input there instead. Which one a host takes is decided once per operation
// and held in {@link HostedRunDecisions}, shared by every runner of one client (its workspaces and
// its write path): the first request asks `run`, and requests that arrive meanwhile wait for its
// answer. Both routes answer the same `OperationResult` bytes, so a caller decodes one shape.
import { HostedAnswerTooLarge, HostedCarrierError, isAnswerTooLarge, type HostedAnswer, type HostedCarrier } from "./carrier.js";
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

/** How one host takes each operation with an older route: by id, on its route, or being checked. */
export type HostedRunDecisions = Map<string, "run" | "route" | Promise<void>>;

/** The decisions of one client: create once and pass to each of its runners. */
export function createRunDecisions(): HostedRunDecisions {
  return new Map();
}

export function createPortRunner(options: { readonly carrier: HostedCarrier; readonly prefix: string; readonly decisions?: HostedRunDecisions }): HostedPortRunner {
  const { carrier, prefix } = options;
  const decisions = options.decisions ?? createRunDecisions();
  return {
    async run(bundleId, operationId, input, signal, runOptions) {
      const body = { ...input, bundleId };
      const send = (route: string, payload: unknown) =>
        carrier
          .json(route, payload, signal, { maximum: runOptions.maximum, ...(runOptions.binding ? { binding: runOptions.binding } : {}) })
          .then((answer) => ({ route, answer }))
          .catch((error: unknown) => {
            // An answer over its bound names the route that gave it.
            if (isAnswerTooLarge(error)) throw new HostedCarrierError("unavailable", { cause: new HostedAnswerTooLarge(runOptions.maximum, route) });
            throw error;
          });
      const byId = () => send(`${prefix}/run`, { bundleId, operationId, input: body });
      const fallback = runOptions.fallback !== false && Object.hasOwn(ROUTE_BEFORE_RUN, operationId) ? `${prefix}/${ROUTE_BEFORE_RUN[operationId]}` : undefined;
      if (!fallback) return byId();
      for (;;) {
        const decided = decisions.get(operationId);
        if (decided === "route") return send(fallback, body);
        if (decided === "run") return byId();
        if (decided !== undefined) {
          // Another request is checking this host: wait for its answer, then decide again.
          await decided;
          continue;
        }
        let settle!: () => void;
        decisions.set(operationId, new Promise<void>((resolve) => (settle = resolve)));
        let ran: HostedPortRunAnswer;
        try {
          ran = await byId();
        } catch (error) {
          // No answer says nothing about the host: the next request checks again.
          decisions.delete(operationId);
          settle();
          throw error;
        }
        // Only the operation's own answer (200) or the refusal by id decides; any other answer
        // (an outage, a lost credential) leaves the next request to check again.
        const refused = notRunById(ran.answer);
        if (refused) decisions.set(operationId, "route");
        else if (ran.answer.status === 200) decisions.set(operationId, "run");
        else decisions.delete(operationId);
        settle();
        return refused ? send(fallback, body) : ran;
      }
    },
  };
}
