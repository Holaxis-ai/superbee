/**
 * Typed rejection for caller-supplied input the engine refuses: unsafe/reserved concept ids,
 * invalid blob keys, missing/empty `frontmatter.type`, malformed option values, and (through
 * {@link FilesystemIdentityAliasError}) an id whose spelling names an existing filesystem entry
 * only by alias. Most rejections happen before storage is touched; the alias verdict needs one
 * inspection of storage but is still "fix your input". Distinct from a runtime failure (I/O,
 * transport, backend) so a consumer boundary — e.g. the CLI's `classifyBundleError` — can map
 * "fix your input" (USAGE, exit 2) separately from "retry/report a bug" (RUNTIME, exit 1) without
 * prose-matching messages.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/**
 * The requested bundle-relative path resolves, on a case- or normalization-insensitive
 * filesystem, to a directory entry spelled differently at `segment`. Every operation refuses it
 * so two distinct canonical ids can never read, compare-and-swap, or delete one physical file.
 */
export class FilesystemIdentityAliasError extends InvalidInputError {
  readonly rel: string;
  readonly segment: string;

  constructor(rel: string, segment: string) {
    super(
      `Path '${rel}' does not match the exact spelling of an existing filesystem entry at segment ` +
        `'${segment}'; ids that differ only by case or Unicode normalization cannot share one file.`,
    );
    this.name = "FilesystemIdentityAliasError";
    this.rel = rel;
    this.segment = segment;
  }
}

/**
 * A filesystem operation could not bind its result to one stable on-disk entry: an observation
 * saw replacement, or a Windows replacement sharing violation made the current write attempt
 * unsafe to continue. A retryable runtime condition; the owning read/decide/CAS loop must restart
 * the complete attempt rather than retrying the filesystem operation in place.
 */
export class ConcurrentReplacementError extends Error {
  readonly rel: string;
  /** Optional bounded backoff hint for a transient host condition; ordinary observation races use zero. */
  readonly retryAfterMs: number;

  constructor(rel: string, attempts: number, retryAfterMs = 0) {
    super(`Path '${rel}' could not be bound to one stable entry during ${attempts} filesystem attempt(s); retry.`);
    this.name = "ConcurrentReplacementError";
    this.rel = rel;
    this.retryAfterMs = retryAfterMs;
  }
}
