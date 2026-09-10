/**
 * A disposable stand-in for the hosted authority: the reference wire router over an in-process
 * MemoryBackend, wrapped in an {@link OperationTransport} that adds what the shipped protocol
 * lacks today: request identity and outcome lookup.
 *
 * The wrapper plays the hosted side. A document PUT carrying an `Idempotency-Key` header is
 * applied at most once: the first application's response is recorded under that key, and any
 * later submission with the same key returns the recorded response without touching the
 * bundle. `lookup(requestId)` reads the same record. Knobs simulate the failures the primitive
 * must survive: a network error before the request is applied, a dropped response after it was
 * applied, a revoked credential, and latency. Reads (`remote`) bypass the knobs so bootstrap and
 * pull observe the authority's true state.
 *
 * Nothing here changes `@superbee/server` or the wire protocol. What a hosted endpoint would
 * need to provide is exactly this wrapper's contract: honor the identity header on writes,
 * keep the outcome per key for a bounded window, and expose a lookup route for it.
 */

import { MemoryBackend, RemoteBackend, parseMarkdown, type OkfDocument, type StorageBackend } from "@superbee/core";
import { pathFromConceptId } from "@superbee/core/storage";
import type { OperationIntent, OperationTransport, Outcome } from "@superbee/core/uncertain-write";
import { createRouter } from "@superbee/server";

export const IDENTITY_HEADER = "Idempotency-Key";
const BASE_URL = "http://fixture.invalid";
const BUNDLE = "default";
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
  /** Latency before the router is invoked. */
  delayMs: number;
}

interface StoredResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

export interface AppliedWrite {
  requestId: string;
  id: string;
  status: number;
}

export interface RemoteFixture {
  /** The authority's own state, for seeding and for asserting what was applied. */
  authority: MemoryBackend;
  /** The read side used by bootstrap and pull; unaffected by the knobs. */
  remote: StorageBackend;
  transport: OperationTransport;
  knobs: FixtureKnobs;
  /** Every identified write the router actually applied, in order. */
  history: AppliedWrite[];
  /** Outcomes recorded by request identity. */
  outcomes: Map<string, Outcome>;
  /** Submissions that returned a recorded response instead of being applied again. */
  deduplicated: string[];
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

async function outcomeOf(stored: StoredResponse): Promise<Outcome> {
  let payload: { version?: string; error?: { code?: string; message?: string; details?: { actual?: string | null } } } = {};
  try {
    payload = JSON.parse(stored.body);
  } catch {
    payload = {};
  }
  if (stored.status === 200 || stored.status === 201) {
    const version = stored.headers.find(([name]) => name.toLowerCase() === "x-version")?.[1] ?? payload.version;
    if (!version) throw new Error("fixture: committed response carried no version");
    return { kind: "committed", version };
  }
  if (stored.status === 412) return { kind: "conflict", actual: payload.error?.details?.actual ?? null };
  return {
    kind: "refused",
    code: payload.error?.code ?? (stored.status === 401 ? "AUTH_REQUIRED" : "RUNTIME"),
    message: payload.error?.message ?? `status ${stored.status}`,
  };
}

async function store(response: Response): Promise<StoredResponse> {
  return { status: response.status, headers: [...response.headers.entries()], body: await response.text() };
}

function replay(stored: StoredResponse): Response {
  return new Response(stored.body, { status: stored.status, headers: stored.headers });
}

export async function createRemoteFixture(): Promise<RemoteFixture> {
  const authority = new MemoryBackend();
  await authority.writeReserved("", "index.md", ROOT_INDEX);
  const router = createRouter({ root: "memory://fixture", backend: authority });
  const knobs: FixtureKnobs = { failBeforeApply: false, dropAfterApply: false, unauthorized: false, lookupFails: false, delayMs: 0 };
  const recorded = new Map<string, StoredResponse>();
  const outcomes = new Map<string, Outcome>();
  const history: AppliedWrite[] = [];
  const deduplicated: string[] = [];

  /** The hosted side: identity-aware for identified writes, plain routing for everything else. */
  const hosted = async (request: Request): Promise<Response> => {
    const requestId = request.headers.get(IDENTITY_HEADER);
    if (requestId === null) return router(request);
    if (knobs.unauthorized) {
      const stored = await store(unauthorizedResponse());
      recorded.set(requestId, stored);
      outcomes.set(requestId, await outcomeOf(stored));
      return replay(stored);
    }
    const existing = recorded.get(requestId);
    if (existing) {
      deduplicated.push(requestId);
      return replay(existing);
    }
    if (knobs.delayMs > 0) await sleep(knobs.delayMs);
    if (knobs.failBeforeApply) throw new TypeError("fetch failed: connection refused");
    const stored = await store(await router(request));
    recorded.set(requestId, stored);
    outcomes.set(requestId, await outcomeOf(stored));
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^.*\/docs\//, ""));
    history.push({ requestId, id, status: stored.status });
    if (knobs.dropAfterApply) throw new TypeError("fetch failed: connection reset by peer");
    return replay(stored);
  };

  const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: hosted, maxRetries: 0 });

  const transport: OperationTransport = {
    async submit(intent: OperationIntent): Promise<Outcome> {
      if (intent.kind !== "document.write") throw new Error(`fixture: unsupported intent kind '${intent.kind}'`);
      const { frontmatter, body } = parseMarkdown(intent.content, pathFromConceptId(intent.target));
      const doc: OkfDocument = { id: intent.target, frontmatter, body };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [IDENTITY_HEADER]: intent.requestId,
        "X-Actor": "browser-local",
      };
      if (intent.base === null) headers["If-None-Match"] = "*";
      else headers["If-Match"] = intent.base;
      const encoded = intent.target
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const request = new Request(`${BASE_URL}/v0/bundles/${BUNDLE}/docs/${encoded}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ frontmatter: doc.frontmatter, body: doc.body }),
      });
      // A thrown transport error propagates: the primitive classifies it as unknown.
      const response = await hosted(request);
      return outcomeOf(await store(response));
    },
    async lookup(requestId: string): Promise<Outcome | null> {
      if (knobs.lookupFails) throw new TypeError("fetch failed: lookup route unreachable");
      return outcomes.get(requestId) ?? null;
    },
  };

  return { authority, remote, transport, knobs, history, outcomes, deduplicated };
}
