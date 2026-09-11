/**
 * A disposable stand-in for the hosted authority: the reference wire router from
 * `@superbee/server` over an in-process MemoryBackend, with the reference outcome store behind
 * it, wrapped in one request handler that injects the failures the sync primitive must survive.
 *
 * The protocol is the shipped one. A document PUT carrying `Idempotency-Key` is applied at most
 * once by the router's own claim-before-apply logic, a duplicate is answered from the record,
 * and `GET /v0/bundles/{bundle}/operations/{key}` reads that record back. What this fixture adds
 * is fault injection around the real router: a network error before the request is applied, a
 * dropped response after it was applied, a revoked credential answered ahead of the router (as
 * an authorization layer in front of it would, so nothing is recorded under the identity), a
 * lookup route that is unreachable, latency on identified writes (`delayMs`) or on every request
 * (`latencyMs`, a simulated round trip), and an authority that stops serving reads part-way
 * through a hydration. The write knobs apply to every document write, identified (the sync
 * verbs' intents) or plain (a request-driven client's compare-and-swap PUT), so the platform
 * contract kit can show the two execution modes the same fault. Reads (`remote`) bypass the
 * write knobs so bootstrap and pull observe the authority's true state.
 *
 * The handler is a plain `(Request) => Promise<Response>`, so the Node proof calls it directly
 * and the Chromium proof serves it over node:http (see `remote-http.ts`). A thrown handler
 * error means "the carrier failed": in process it propagates to the caller, over HTTP the
 * bridge resets the socket, and either way the client cannot tell whether the write landed.
 * Submissions and lookups are counted at the handler, so both carriers are observed; what the
 * router recorded and what it answered from the record is observed by wrapping the store.
 */

import { MemoryBackend, RemoteBackend, type StorageBackend } from "@superbee/core";
import { openRemoteOperationTransport } from "@superbee/core/remote-operations";
import type { OperationTransport, Outcome } from "@superbee/core/uncertain-write";
import { createRouter, MemoryOperationOutcomeStore, type OperationOutcomeStore } from "@superbee/server";

export const BASE_URL = "http://fixture.invalid";
export const BUNDLE = "default";
const IDENTITY_HEADER = "Idempotency-Key";
const LOOKUP_PATH = /^\/v0\/bundles\/[^/]+\/operations\/([^/]+)$/;
const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Remote fixture\n";

export interface FixtureKnobs {
  /** Throw before a document write reaches the router: the authority never sees it. */
  failBeforeApply: boolean;
  /** Let the router apply (and, when identified, record) a document write, then throw instead of returning its response. */
  dropAfterApply: boolean;
  /** Answer every document write with 401 AUTH_REQUIRED ahead of the router. */
  unauthorized: boolean;
  /** Make the lookup route throw, as if it were unreachable. */
  lookupFails: boolean;
  /** Latency before the router is invoked for an identified write. */
  delayMs: number;
  /** Latency added to every request the handler sees (reads, writes, lookups, capabilities), as a simulated round trip. */
  latencyMs: number;
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
  /** The reference outcome store the router records into; its clock is `clock`. */
  outcomeStore: MemoryOperationOutcomeStore;
  /** Milliseconds added to the store's clock, so a test can expire records. */
  clock: { skewMs: number };
  /** The read side used by bootstrap and pull; unaffected by the write knobs. */
  remote: StorageBackend;
  /** The in-process transport: core's remote operation transport over {@link hosted}. */
  transport: OperationTransport;
  /** The hosted side as one request handler, for direct calls and for the HTTP bridge. */
  hosted: (request: Request) => Promise<Response>;
  knobs: FixtureKnobs;
  /** Every identified write the router actually applied and recorded, in order. */
  history: AppliedWrite[];
  /** Outcomes the router recorded, by request identity. */
  outcomes: Map<string, Outcome>;
  /** Submissions the router answered from a recorded or in-progress application instead of applying again. */
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

/** A document write, identified or not: the write knobs apply to both, as a revoked credential or a dead carrier would. */
function isDocumentWrite(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (request.method === "PUT" || request.method === "DELETE") && /\/docs\/.+/.test(pathname);
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

/**
 * The reference store with the fixture's counters attached: a claim answered from the record
 * or from an application still in progress is a deduplicated submission, and every record the
 * router makes is mirrored into `history` and `outcomes`.
 */
function observedStore(
  inner: OperationOutcomeStore,
  history: AppliedWrite[],
  outcomes: Map<string, Outcome>,
  deduplicated: string[],
): OperationOutcomeStore {
  return {
    async claim(scope, key) {
      const claim = await inner.claim(scope, key);
      if (claim.kind !== "claimed") {
        deduplicated.push(key);
        return claim;
      }
      return {
        kind: "claimed",
        release: claim.release,
        record: (operation) => {
          const record = claim.record(operation);
          history.push({ requestId: key, id: operation.id, status: operation.response.status });
          outcomes.set(key, record.outcome);
          return record;
        },
      };
    },
    lookup: (scope, key) => inner.lookup(scope, key),
  };
}

export async function createRemoteFixture(): Promise<RemoteFixture> {
  const authority = new MemoryBackend();
  await authority.writeReserved("", "index.md", ROOT_INDEX);
  const clock = { skewMs: 0 };
  const outcomeStore = new MemoryOperationOutcomeStore({ now: () => Date.now() + clock.skewMs });
  const history: AppliedWrite[] = [];
  const outcomes = new Map<string, Outcome>();
  const deduplicated: string[] = [];
  const submissions: string[] = [];
  const lookups: string[] = [];
  const served = { documents: 0 };
  const router = createRouter({ root: "memory://fixture", backend: authority }, { outcomes: observedStore(outcomeStore, history, outcomes, deduplicated) });
  const knobs: FixtureKnobs = { failBeforeApply: false, dropAfterApply: false, unauthorized: false, lookupFails: false, delayMs: 0, latencyMs: 0, readBudget: null };

  /** The hosted side: the fixture's faults around the real router. */
  const hosted = async (request: Request): Promise<Response> => {
    if (knobs.latencyMs > 0) await sleep(knobs.latencyMs);
    const { pathname } = new URL(request.url);
    const lookup = LOOKUP_PATH.exec(pathname);
    if (lookup) {
      lookups.push(decodeURIComponent(lookup[1]!));
      if (knobs.lookupFails) throw new TypeError("fetch failed: lookup route unreachable");
      return router(request);
    }
    const requestId = request.headers.get(IDENTITY_HEADER);
    if (requestId === null && !isDocumentWrite(request)) {
      const requested = await documentsRequested(request);
      if (requested !== null) {
        if (knobs.readBudget !== null && requested > knobs.readBudget) throw new TypeError("fetch failed: authority stopped serving reads");
        if (knobs.readBudget !== null) knobs.readBudget -= requested;
        served.documents += requested;
      }
      return router(request);
    }
    if (requestId !== null) submissions.push(requestId);
    // Refused ahead of the router, before the identity is claimed: nothing is recorded under it.
    if (knobs.unauthorized) return unauthorizedResponse();
    if (knobs.delayMs > 0) await sleep(knobs.delayMs);
    if (knobs.failBeforeApply) throw new TypeError("fetch failed: connection refused");
    const response = await router(request);
    if (knobs.dropAfterApply) throw new TypeError("fetch failed: connection reset by peer");
    return response;
  };

  const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: hosted, maxRetries: 0 });
  const transport = await openRemoteOperationTransport(remote);

  return { authority, outcomeStore, clock, remote, transport, hosted, knobs, history, outcomes, deduplicated, submissions, lookups, served };
}
