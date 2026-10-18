import { RemoteError } from "../remote-error.js";

/** The code of {@link HostedRouteNotServed}. */
export const ROUTE_NOT_SERVED = "ROUTE_NOT_SERVED";

/**
 * The host does not have this route yet: the sync family's own unknown-route answer,
 * `404 {"error":"not_found"}` and nothing else, which a gateway from before the route sends. It
 * is deterministic for that host version, so it is never retried; a later host serves the route.
 * Its status stays `404`, and it names the route asked for.
 */
export class HostedRouteNotServed extends RemoteError {
  readonly route: string;
  constructor(route: string) {
    super(`the host does not serve ${route}`, ROUTE_NOT_SERVED, 404);
    this.name = "HostedRouteNotServed";
    this.route = route;
  }
}

/** True when `error` is a {@link HostedRouteNotServed}. */
export function isRouteNotServed(error: unknown): error is HostedRouteNotServed {
  return error instanceof HostedRouteNotServed;
}

/**
 * The host serves this bundle no blob writes (`blobWrites` is not `allowed` in its capabilities,
 * as an older host's answer decodes). A {@link HostedRouteNotServed}, so `isRouteNotServed` is
 * true; thrown before anything is journaled or sent. Unlike `write()`, whose bundle without
 * writes is the result `refused: read_only`, a blob write throws: the blob routes are a newer
 * capability a caller is expected to probe for, as it probes for any route a host may lack.
 */
export class HostedBlobWritesNotServed extends HostedRouteNotServed {
  constructor(route: string) {
    super(route);
    this.name = "HostedBlobWritesNotServed";
  }
}
