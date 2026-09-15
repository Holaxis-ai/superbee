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

/** A wire payload the authority produced but the contract does not admit: not retried, not truncation. */
export function malformed(message: string): RemoteError {
  return new RemoteError(message, "RUNTIME", 502);
}
