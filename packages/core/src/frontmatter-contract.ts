/** Runtime-neutral error and predicates shared by storage adapters and the engine. */

/**
 * A document whose YAML frontmatter could not be parsed. `context` identifies the document when
 * known; `detail` is the first line of the parser error, and `cause` preserves the original error.
 */
export class MalformedDocumentError extends Error {
  override readonly name = "MalformedDocumentError";
  readonly context?: string;
  readonly detail: string;

  constructor(context: string | undefined, cause: unknown) {
    const detail = ((cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "")
      .trim();
    super(
      `malformed frontmatter${context ? ` in '${context}'` : ""}: ${detail} — ` +
        `fix the YAML or remove the file`,
    );
    if (context !== undefined) this.context = context;
    this.detail = detail;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Legacy timestamp shape predicate: a non-empty (post-trim) string. This controls v0.1
 * defaults, not edition-aware clock validity or v0.2 imported-value preservation.
 */
export function isUsableTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
