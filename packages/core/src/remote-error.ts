/**
 * The typed rejection of the wire client, shared by {@link RemoteBackend} and the heads and
 * snapshot parsers in `remote-parsers.ts`, which the backend calls; a module of its own so the
 * two need no import cycle. Runtime-neutral: nothing from Node.
 */

/**
 * A non-2xx wire response that is neither a `404` (ENOENT-shaped) nor a `412`
 * ({@link VersionConflict}): the generic case, carrying the error envelope's `code` alongside
 * the raw HTTP `status`, so a caller can distinguish e.g.
 * `AUTH_REQUIRED` (401, an unauthenticated/misconfigured `--remote`) from `RUNTIME` (5xx, a
 * genuine server-side bug) instead of both collapsing into a generically-classified `Error`.
 */
export class RemoteError extends Error {
  /** The envelope's `code` field, or a status-derived guess when the envelope is missing/unparseable. */
  readonly code: string;
  /** The raw HTTP status that produced this error. */
  readonly status: number;

  constructor(message: string, code: string, status: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RemoteError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The code of an answer the authority produced that the client's contract does not admit. It is
 * deterministic (the same request gets the same answer), so it is never retried and never read
 * as truncation or as the host being unavailable. The status stays `502` so a write whose answer
 * is malformed is still an unknown outcome to the uncertain-write primitive, not a refusal.
 */
export const MALFORMED_ANSWER = "MALFORMED_ANSWER";

/** A {@link MALFORMED_ANSWER} rejection, naming the route that answered when the reader knows it. */
export class MalformedAnswer extends RemoteError {
  route: string | undefined;
  constructor(message: string, route?: string) {
    super(message, MALFORMED_ANSWER, 502);
    this.route = route;
  }
}

/** A wire payload the authority produced but the contract does not admit: not retried, not truncation. */
export function malformed(message: string, route?: string): MalformedAnswer {
  return new MalformedAnswer(message, route);
}

/** True when `error` is a {@link MalformedAnswer}. */
export function isMalformedAnswer(error: unknown): error is MalformedAnswer {
  return error instanceof MalformedAnswer;
}

/** Run `read`, naming `route` on a malformed answer it rejects with that does not name one yet. */
export async function onRoute<T>(route: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MalformedAnswer && error.route === undefined) error.route = route;
    throw error;
  }
}
