/**
 * Minimal port of `packages/schemas/src/validation.ts` from holaxis-agentstate.
 *
 * The source module is a zod-backed WARN-FIRST validation layer. `content-type.ts`
 * consumes ONLY the {@link ValidationWarning} shape from it (a type-only import),
 * so `@superbee/core` ports just that type and deliberately drops the zod
 * runtime — keeping the store engine dependency-free at this layer. If a full
 * schema-validation stage is ever needed here, restore the zod pieces from the
 * source repo.
 */

/** Non-fatal validation warning. Mirrors the `errorResponse` {code,message,details} grammar. */
export type ValidationWarning = {
  /** Stable machine code (e.g. "IGNORED_FIELD", "INVALID_FIELD"). */
  code: string;
  /** Human-readable message. */
  message: string;
  /** JSON-path of the offending field (`issue.path.join(".")`), when applicable. */
  field?: string;
  /** Strictly non-fatal. There is NO "error" severity on a 200 response. */
  severity: "warning" | "info";
};
