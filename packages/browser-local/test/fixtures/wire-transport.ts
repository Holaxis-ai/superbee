/**
 * The client side of the disposable authority's contract, as one {@link OperationTransport}
 * over a fetch-like carrier. It is the piece a product page would ship once a hosted endpoint
 * honors request identity: a document PUT carrying the identity header, the base as an
 * `If-Match` precondition (or `If-None-Match: *` for a create), the wire's committed, conflict
 * and refused answers mapped to {@link Outcome}, and a lookup route read by request identity.
 *
 * This module imports nothing from Node so the esbuild driver can bundle it for the page; the
 * Node fixture uses the same code over its in-process router. One transport, two carriers.
 */

import { parseMarkdown, type OkfDocument } from "@superbee/core/document-codec";
import { pathFromConceptId } from "@superbee/core/storage";
import type { OperationIntent, OperationTransport, Outcome } from "@superbee/core/uncertain-write";

export const IDENTITY_HEADER = "Idempotency-Key";
/** The fixture's lookup route, outside the shipped wire namespace so it is visibly test-only. */
export const LOOKUP_PREFIX = "/_fixture/operations/";

export type FetchLike = (request: Request) => Promise<Response>;

export interface FetchTransportOptions {
  baseUrl: string;
  bundle: string;
  fetchImpl: FetchLike;
  actor?: string;
}

/** The parts of a response the outcome mapping needs; a recorded response replays through the same shape. */
export interface StoredResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

export async function storeResponse(response: Response): Promise<StoredResponse> {
  return { status: response.status, headers: [...response.headers.entries()], body: await response.text() };
}

export function replayResponse(stored: StoredResponse): Response {
  return new Response(stored.body, { status: stored.status, headers: stored.headers });
}

/** Map one wire answer for an identified write to the primitive's outcome. */
export function outcomeOf(stored: StoredResponse): Outcome {
  let payload: { version?: string; error?: { code?: string; message?: string; details?: { actual?: string | null } } } = {};
  try {
    payload = JSON.parse(stored.body);
  } catch {
    payload = {};
  }
  if (stored.status === 200 || stored.status === 201) {
    const version = stored.headers.find(([name]) => name.toLowerCase() === "x-version")?.[1] ?? payload.version;
    if (!version) throw new Error("wire transport: committed response carried no version");
    return { kind: "committed", version };
  }
  if (stored.status === 412) return { kind: "conflict", actual: payload.error?.details?.actual ?? null };
  return {
    kind: "refused",
    code: payload.error?.code ?? (stored.status === 401 ? "AUTH_REQUIRED" : "RUNTIME"),
    message: payload.error?.message ?? `status ${stored.status}`,
  };
}

function encodeId(id: string): string {
  return id
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function createFetchTransport(options: FetchTransportOptions): OperationTransport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const bundle = encodeURIComponent(options.bundle);
  return {
    async submit(intent: OperationIntent): Promise<Outcome> {
      if (intent.kind !== "document.write") throw new Error(`wire transport: unsupported intent kind '${intent.kind}'`);
      const { frontmatter, body } = parseMarkdown(intent.content, pathFromConceptId(intent.target));
      const doc: OkfDocument = { id: intent.target, frontmatter, body };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [IDENTITY_HEADER]: intent.requestId,
        "X-Actor": options.actor ?? "browser-local",
      };
      if (intent.base === null) headers["If-None-Match"] = "*";
      else headers["If-Match"] = intent.base;
      const request = new Request(`${base}/v0/bundles/${bundle}/docs/${encodeId(intent.target)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ frontmatter: doc.frontmatter, body: doc.body }),
      });
      // A thrown carrier error propagates: the primitive classifies it as unknown.
      const response = await options.fetchImpl(request);
      return outcomeOf(await storeResponse(response));
    },
    async lookup(requestId: string): Promise<Outcome | null> {
      const response = await options.fetchImpl(new Request(`${base}${LOOKUP_PREFIX}${encodeURIComponent(requestId)}`, { method: "GET" }));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`wire transport: lookup answered ${response.status}`);
      return (await response.json()) as Outcome;
    },
  };
}
