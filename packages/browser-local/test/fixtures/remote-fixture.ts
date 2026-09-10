/**
 * A disposable stand-in for the hosted authority: the reference wire router over an in-process
 * MemoryBackend, wrapped in a hosted request handler that adds what the shipped protocol lacks
 * today: request identity and outcome lookup.
 *
 * The wrapper plays the hosted side. A document PUT carrying an `Idempotency-Key` header is
 * applied at most once: the key is claimed before the application starts, a submission with the
 * same key that arrives while the first is still applying waits for that application and
 * returns its response, and any later submission returns the recorded response without
 * touching the bundle. The lookup route (`/_fixture/operations/{requestId}`) reads the same
 * record and answers 404 only when no outcome was ever recorded under the identity. A revoked
 * credential answers before the key is claimed, as an authorization layer in front of the
 * router would, so a refused-for-permission identity carries no recorded outcome and is a first
 * delivery when it is retried. Knobs simulate the failures the primitive must survive: a
 * network error before the request is applied, a dropped response after it was applied, a
 * revoked credential, latency, and an authority that stops serving reads part-way through a
 * hydration. Reads (`remote`) bypass the write knobs so bootstrap and pull observe the
 * authority's true state.
 *
 * The handler is a plain `(Request) => Promise<Response>`, so the Node proof calls it directly
 * and the Chromium proof serves it over node:http (see `remote-http.ts`). A thrown handler
 * error means "the carrier failed": in process it propagates to the caller, over HTTP the
 * bridge resets the socket, and either way the client cannot tell whether the write landed.
 * Submissions and lookups are counted at the handler, so both carriers are observed.
 *
 * Nothing here changes `@superbee/server` or the wire protocol. What a hosted endpoint would
 * need to provide is exactly this wrapper's contract: honor the identity header on writes,
 * keep the outcome per key for a bounded window, and expose a lookup route for it.
 */

import { MemoryBackend, RemoteBackend, type StorageBackend } from "@superbee/core";
import type { OperationTransport, Outcome } from "@superbee/core/uncertain-write";
import { createRouter } from "@superbee/server";

import { createFetchTransport, IDENTITY_HEADER, LOOKUP_PREFIX, outcomeOf, replayResponse, storeResponse, type StoredResponse } from "./wire-transport.ts";

export { IDENTITY_HEADER } from "./wire-transport.ts";
export const BASE_URL = "http://fixture.invalid";
export const BUNDLE = "default";
const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Remote fixture\n";

export interface FixtureKnobs {
  /** Throw before the request reaches the router: the authority never sees it. */
  failBeforeApply: boolean;
  /** Apply the request, record its outcome, then throw instead of returning the response. */
  dropAfterApply: boolean;
  /** Answer every identified write with 401 AUTH_REQUIRED. */
  unauthorized: boolean;
  /** Make `lookup` throw, as if the lookup route were unreachable. */
  lookupFails: boolean;
  /** Latency before the router is invoked for an identified write. */
  delayMs: number;
  /**
   * Documents the read routes will still serve before failing; `null` means unlimited. A
   * read-many whose ids exceed the remaining budget fails as a carrier error and leaves the
   * budget unchanged, so a hydration stops part-way and stays stopped until the knob is reset.
   */
  readBudget: number | null;
}

export interface AppliedWrite {
  requestId: string;
  id: string;
  status: number;
}

export interface RemoteFixture {
  /** The authority's own state, for seeding and for asserting what was applied. */
  authority: MemoryBackend;
  /** The read side used by bootstrap and pull; unaffected by the write knobs. */
  remote: StorageBackend;
  /** The in-process transport: the shared fetch transport over {@link hosted}. */
  transport: OperationTransport;
  /** The hosted side as one request handler, for direct calls and for the HTTP bridge. */
  hosted: (request: Request) => Promise<Response>;
  knobs: FixtureKnobs;
  /** Every identified write the router actually applied, in order. */
  history: AppliedWrite[];
  /** Outcomes recorded by request identity. */
  outcomes: Map<string, Outcome>;
  /** Submissions that returned a recorded or in-progress response instead of being applied again. */
  deduplicated: string[];
  /** The request identity of every identified write that reached the handler, in order, whatever became of it. */
  submissions: string[];
  /** The request identity of every lookup that reached the handler, in order. */
  lookups: string[];
  /** Documents served through the read routes so far. */
  served: { documents: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "credential revoked" } }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** How many documents a read request asks for, or `null` when it is not a document read. */
async function documentsRequested(request: Request): Promise<number | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname.endsWith("/docs:read-many")) {
    const payload = (await request.clone().json()) as { ids?: unknown };
    return Array.isArray(payload.ids) ? payload.ids.length : 0;
  }
  if (request.method === "GET" && /\/docs\/.+/.test(pathname) && !pathname.endsWith("/versions")) return 1;
  return null;
}

export async function createRemoteFixture(): Promise<RemoteFixture> {
  const authority = new MemoryBackend();
  await authority.writeReserved("", "index.md", ROOT_INDEX);
  const router = createRouter({ root: "memory://fixture", backend: authority });
  const knobs: FixtureKnobs = { failBeforeApply: false, dropAfterApply: false, unauthorized: false, lookupFails: false, delayMs: 0, readBudget: null };
  const recorded = new Map<string, StoredResponse>();
  const applying = new Map<string, Promise<StoredResponse>>();
  const outcomes = new Map<string, Outcome>();
  const history: AppliedWrite[] = [];
  const deduplicated: string[] = [];
  const submissions: string[] = [];
  const lookups: string[] = [];
  const served = { documents: 0 };

  /** One application of an identified request; the key is claimed by the caller before this starts. */
  const apply = async (requestId: string, request: Request): Promise<StoredResponse> => {
    if (knobs.delayMs > 0) await sleep(knobs.delayMs);
    if (knobs.failBeforeApply) throw new TypeError("fetch failed: connection refused");
    const stored = await storeResponse(await router(request));
    recorded.set(requestId, stored);
    outcomes.set(requestId, outcomeOf(stored));
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^.*\/docs\//, ""));
    history.push({ requestId, id, status: stored.status });
    return stored;
  };

  /** The hosted side: identity-aware for identified writes, plain routing for everything else. */
  const hosted = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(LOOKUP_PREFIX)) {
      const requestId = decodeURIComponent(pathname.slice(LOOKUP_PREFIX.length));
      lookups.push(requestId);
      if (knobs.lookupFails) throw new TypeError("fetch failed: lookup route unreachable");
      const outcome = outcomes.get(requestId);
      return outcome ? json(200, outcome) : json(404, { error: { code: "NOT_FOUND", message: "no recorded outcome" } });
    }
    const requestId = request.headers.get(IDENTITY_HEADER);
    if (requestId === null) {
      const requested = await documentsRequested(request);
      if (requested !== null) {
        if (knobs.readBudget !== null && requested > knobs.readBudget) throw new TypeError("fetch failed: authority stopped serving reads");
        if (knobs.readBudget !== null) knobs.readBudget -= requested;
        served.documents += requested;
      }
      return router(request);
    }
    submissions.push(requestId);
    // Refused ahead of the router, before the identity is claimed: nothing is recorded under it.
    if (knobs.unauthorized) return unauthorizedResponse();
    const existing = recorded.get(requestId);
    if (existing) {
      deduplicated.push(requestId);
      return replayResponse(existing);
    }
    const inProgress = applying.get(requestId);
    if (inProgress) {
      deduplicated.push(requestId);
      return replayResponse(await inProgress);
    }
    const application = apply(requestId, request);
    applying.set(requestId, application);
    try {
      const stored = await application;
      if (knobs.dropAfterApply) throw new TypeError("fetch failed: connection reset by peer");
      return replayResponse(stored);
    } finally {
      applying.delete(requestId);
    }
  };

  const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: hosted, maxRetries: 0 });
  const transport = createFetchTransport({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: hosted });

  return { authority, remote, transport, hosted, knobs, history, outcomes, deduplicated, submissions, lookups, served };
}
