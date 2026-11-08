import type { MalformedDocumentCode } from "./frontmatter-contract.js";
import type { NonCanonicalDocumentId } from "./paths.js";

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
 * A create of a document id outside its one canonical spelling. The reason is the same one a
 * hosted create and `publish` report (`document_id_not_canonical`), so the refusal surfaces where
 * the id is chosen. `suggestedId` is a safe canonical spelling when one exists and is free.
 */
export class NonCanonicalDocumentIdError extends InvalidInputError {
  readonly reason = "document_id_not_canonical" as const;
  readonly id: string;
  readonly why: NonCanonicalDocumentId;
  readonly suggestedId: string | undefined;
  /** The canonical spelling names a document that already exists, so it is not offered as the fix. */
  readonly existingId: string | undefined;
  constructor(id: string, why: NonCanonicalDocumentId, suggestion: { id: string; exists: boolean } | undefined) {
    const explanation = {
      segment_whitespace: "a path segment starts or ends with whitespace",
      format_character: "a path segment holds an invisible format character",
      not_nfc: "it writes a letter as two characters (a base letter and a separate combining mark) instead of one, and some filesystems treat the two spellings as the same name",
    }[why];
    super(
      `'${visibleId(id)}' cannot be created: ${explanation}. Ids must have one spelling everywhere, so this one would also fail at publish and sync.`
        + (suggestion === undefined ? " Choose a different id."
          : suggestion.exists ? ` '${suggestion.id}' already exists: choose a different id, or edit that document if you meant it.`
          : ` Use '${suggestion.id}'.`),
    );
    this.name = "NonCanonicalDocumentIdError";
    this.id = id;
    this.why = why;
    this.suggestedId = suggestion && !suggestion.exists ? suggestion.id : undefined;
    this.existingId = suggestion?.exists ? suggestion.id : undefined;
  }
}

/** Escape characters a terminal would show invisibly or merge into a neighbour. */
function visibleId(id: string): string {
  return id.replace(/[\p{Cf}\p{Cc}\p{M}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

/**
 * Frontmatter a write would store that the frontmatter reader refuses. `code` is the reader's
 * stable code, so a consumer can report the same reason on the write as on a later read.
 */
export class FrontmatterRefusedError extends InvalidInputError {
  readonly code: MalformedDocumentCode;
  constructor(code: MalformedDocumentCode, detail: string) {
    super(`frontmatter cannot be stored: ${detail}`);
    this.name = "FrontmatterRefusedError";
    this.code = code;
  }
}

/**
 * An actor identity that does not follow the OKF actor convention (SPEC 7). A subclass of
 * {@link InvalidInputError} so every existing USAGE mapping still applies; it additionally carries
 * the rejected spelling so a presenting boundary can offer the corrected one.
 */
export class OkfActorError extends InvalidInputError {
  readonly actor: string;
  constructor(actor: string, message: string) {
    super(message);
    this.name = "OkfActorError";
    this.actor = actor;
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
