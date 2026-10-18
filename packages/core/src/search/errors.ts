// The ways a search refuses: a corpus over an index limit (or a host's configured bound), a request
// whose terms occur too often to rank, a request outside the contract, and a cancellation. Messages
// are fixed text; none repeats the caller's input.
import { SEARCH_GUIDANCE } from "./contract.js";

/** The corpus exceeds an index limit or a host's configured bound, or the request's terms exceed
 * `maxEvidenceInstances` (the message is then SEARCH_GUIDANCE.broad). A kernel answers
 * `result_too_large`. */
export class SearchLimitError extends Error {
  readonly limit: string;
  readonly max: number;
  readonly actual: number;

  constructor(limit: string, max: number, actual: number) {
    super(limit === "maxEvidenceInstances" ? SEARCH_GUIDANCE.broad : `The search corpus exceeds its ${limit} limit.`);
    this.name = "SearchLimitError";
    this.limit = limit;
    this.max = max;
    this.actual = actual;
  }
}

export type SearchInputReason =
  | "request"
  | "query"
  | "empty-query"
  | "too-many-query-terms"
  | "match"
  | "filter"
  | "limit"
  | "facets"
  | "cursor";

/** The request is outside the contract. A kernel answers `invalid_input`. */
export class SearchInputError extends Error {
  readonly reason: SearchInputReason;

  constructor(reason: SearchInputReason) {
    super(`The search request is invalid (${reason}).`);
    this.name = "SearchInputError";
    this.reason = reason;
  }
}

/** A cancelled index build or ranking rejects; it never returns a partial answer. */
export class SearchAbortError extends Error {
  constructor() {
    super("The search was cancelled.");
    this.name = "AbortError";
  }
}

/** Throws as a stop asks: a signal already aborted, or a host check that throws. */
export function stopIfAsked(stop: { readonly signal?: AbortSignal; readonly check?: () => void } | undefined): void {
  if (stop?.signal?.aborted) throw new SearchAbortError();
  stop?.check?.();
}
