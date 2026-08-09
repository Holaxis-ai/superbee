// Shared guard around node:util `parseArgs`.
//
// `parseArgs` throws a bare `TypeError` (code ERR_PARSE_ARGS_*) on an unknown flag, a missing
// option value, or an unexpected positional. Left unwrapped, that bare throw routes through the
// bin wrapper's non-CliError path to RUNTIME / exit 1 — but a parse failure is a USAGE error
// (exit 2). An agent branches on the exit code first, so a typo'd flag landing on exit 1 (which
// signals a retryable runtime fault) would invite a pointless re-run of a non-retryable mistake.
//
// `parseOrUsage` runs the (already-configured) parse thunk and converts any non-CliError throw
// into `CliError("USAGE", …)`, TRANSLATING parseArgs's raw message into a clean, tool-native one
// (AXI §6 — "translate errors, discard noise, never leak dependency wording") by mapping on
// `err.code`, and attaching a `--help` pointer for the offending command. Node's own advisory
// boilerplate tail (the "To specify a positional argument…" / "Did you forget…" prose) is always
// stripped, even when a code is unrecognized and the raw message is passed through — so a caller
// never sees the raw dependency wording, only ever a trimmed original at worst.
//
// Ported from holaxis-agentstate `packages/cli/src/args.ts` (help pointer retargeted to `axi`).
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import { assertLeafArity, type LeafPath } from "./positional-arity.js";

const ARITY_DECISION_BRAND: unique symbol = Symbol("agentstate-lite.arity-decision");

export type ArityDecision = (
  | { readonly kind: "leaf"; readonly path: LeafPath }
  | { readonly kind: "deferred"; readonly reason: SelectorDeferral | "new:schema" | "doc-update:token-normalization" }
) & { readonly [ARITY_DECISION_BRAND]: true };

export type SelectorDeferral =
  | "selector:bundle"
  | "selector:catalog"
  | "selector:index"
  | "selector:kind"
  | "selector:view"
  | "selector:hook"
  | "selector:skill";

export const leafArity = (path: LeafPath): ArityDecision =>
  Object.freeze({ kind: "leaf", path, [ARITY_DECISION_BRAND]: true as const });
export const deferArity = (reason: SelectorDeferral | "new:schema" | "doc-update:token-normalization"): ArityDecision =>
  Object.freeze({ kind: "deferred", reason, [ARITY_DECISION_BRAND]: true as const });

function assertOwnedArityDecision(decision: ArityDecision): void {
  if (
    typeof decision !== "object" ||
    decision === null ||
    (decision as { [ARITY_DECISION_BRAND]?: unknown })[ARITY_DECISION_BRAND] !== true
  ) {
    throw new TypeError("invalid arity decision: use leafArity() or deferArity()");
  }
}

export type SelectorResolution<P> =
  | { readonly kind: "navigation" }
  | { readonly kind: "unknown"; readonly token?: string; readonly reason?: string }
  | { readonly kind: "selected"; readonly path: LeafPath; readonly data: readonly string[]; readonly payload: P };

export type ValidatedSelectorResult<V, P> = {
  readonly values: V;
  readonly selection: SelectorResolution<P> | { readonly kind: "help" };
};

/** Resolve selectors once, validate their leaf data, and never expose raw positionals downstream. */
export function parseSelectorOrUsage<
  T extends { positionals: readonly string[]; values: object },
  P,
>(
  parse: () => T,
  command: string,
  reason: SelectorDeferral,
  resolve: (positionals: readonly string[]) => SelectorResolution<P>,
): ValidatedSelectorResult<T["values"], P> {
  const parsed = parseOrUsage(parse, command, deferArity(reason));
  if (Boolean((parsed.values as { help?: unknown }).help)) return { values: parsed.values, selection: { kind: "help" } };
  const selection = resolve(parsed.positionals);
  if (selection.kind === "selected") assertLeafArity(selection.path, selection.data);
  return { values: parsed.values, selection };
}

const QUOTED = /'([^']+)'/;

/** Drop node's advisory boilerplate tail. Kept for the fall-through cases so nothing regresses. */
function stripAdvisory(msg: string): string {
  const noPositionalHint = msg.split(". To specify a positional argument")[0] ?? msg;
  const noAmbiguousHint = noPositionalHint.split("\nDid you forget")[0] ?? noPositionalHint;
  return noAmbiguousHint.trim();
}

/**
 * Translate a node `parseArgs` error to a clean, tool-native USAGE message, or `null` when the
 * error isn't a recognized `ERR_PARSE_ARGS_*` (caller falls back to the trimmed original).
 * Grounded in node's real `err.code` values (see `plans/axi-experience-pass.md`'s captured table):
 * `ERR_PARSE_ARGS_UNKNOWN_OPTION`, `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` (both "missing a value"
 * and "does not take an argument"), and `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`.
 */
export function translateParseArgsError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const tok = QUOTED.exec(err.message)?.[1];
  switch (code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
      return tok ? `unknown option '${tok}'` : stripAdvisory(err.message);
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE": {
      const opt = tok ? (tok.split(/\s+/)[0] ?? tok) : undefined; // '--type <value>' -> '--type'
      if (/does not take an argument/.test(err.message))
        return opt ? `option '${opt}' takes no value` : stripAdvisory(err.message);
      return opt ? `option '${opt}' requires a value` : stripAdvisory(err.message);
    }
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL":
      return tok ? `unexpected argument '${tok}'` : stripAdvisory(err.message);
    default:
      return null; // unrecognized ERR_PARSE_ARGS_* (or non-parse Error) -> caller keeps trimmed original
  }
}

/** Run a parseArgs thunk, mapping its bare parse error to a translated USAGE CliError (exit 2). */
export function parseOrUsage<T extends { positionals: readonly string[]; values?: object }>(
  parse: () => T,
  command: string,
  decision: ArityDecision,
): T {
  assertOwnedArityDecision(decision);
  try {
    const parsed = parse();
    if (Boolean((parsed.values as { help?: unknown } | undefined)?.help)) return parsed;
    if (decision.kind === "leaf") assertLeafArity(decision.path, parsed.positionals);
    return parsed;
  } catch (err) {
    if (err instanceof CliError) throw err; // passthrough — never remapped
    const translated = translateParseArgsError(err);
    const raw = err instanceof Error ? err.message : String(err);
    const message = translated ?? stripAdvisory(raw); // unrecognized -> trimmed original, never worse
    throw new CliError("USAGE", message, { help: `${cliInvocation()} ${command} --help` });
  }
}
