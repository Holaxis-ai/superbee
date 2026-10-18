// The ways a search refuses: a corpus over an index limit (or a host's configured bound), a request
// whose terms occur too often to rank, a request outside the contract, and a cancellation. Messages
// are fixed text; none repeats the caller's input.
import { SEARCH_GUIDANCE } from "./contract.js";

/** The corpus exceeds an index limit or a host's configured bound. A kernel answers
 * `result_too_large`. */
export class SearchLimitError extends Error {
  readonly limit: string;
  readonly max: number;
  readonly actual: number;

  constructor(limit: string, max: number, actual: number, message = `The search corpus exceeds its ${limit} limit.`) {
    super(message);
    this.name = "SearchLimitError";
    this.limit = limit;
    this.max = max;
    this.actual = actual;
  }
}

/** The request's terms hold more than `maxEvidenceInstances` capped instances. Still a
 * `SearchLimitError` (`result_too_large`), but the corpus is searchable: the message is
 * SEARCH_GUIDANCE.broad, to retry with fewer or more specific terms. */
export class SearchBroadQueryError extends SearchLimitError {
  constructor(max: number, actual: number) {
    super("maxEvidenceInstances", max, actual, SEARCH_GUIDANCE.broad);
    this.name = "SearchBroadQueryError";
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
