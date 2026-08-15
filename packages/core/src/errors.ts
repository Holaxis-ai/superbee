/**
 * Typed rejection for caller-supplied input the engine refuses BEFORE touching storage:
 * unsafe/reserved concept ids, invalid blob keys, missing/empty `frontmatter.type`,
 * malformed option values. Distinct from a runtime failure (I/O, transport, backend) so a
 * consumer boundary — e.g. the CLI's `classifyBundleError` — can map "fix your input"
 * (USAGE, exit 2) separately from "retry/report a bug" (RUNTIME, exit 1) without
 * prose-matching messages.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
