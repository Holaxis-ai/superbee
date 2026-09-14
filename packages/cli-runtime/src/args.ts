// Shared guard around node:util `parseArgs`.
//
// `parseArgs` throws a bare `TypeError` (code ERR_PARSE_ARGS_*) on an unknown flag, a missing
// option value, or an unexpected positional. Left unwrapped, that bare throw routes through the
// bin wrapper's non-CliError path to RUNTIME / exit 1 — but a parse failure is a USAGE error
// (exit 2). An agent branches on the exit code first, so a typo'd flag landing on exit 1 (which
// signals a retryable runtime fault) would invite a pointless re-run of a non-retryable mistake.
//
// The owned parse APIs run an already-configured parse thunk and convert any non-CliError throw
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
import {
  assertCliLeaf,
  type CliLeafSpec,
  type PublicCommandName,
} from "./command-spec.js";
import { assertLeafArity } from "./positional-arity.js";
import { commandToken, commandWords } from "./command-text.js";

export type SelectorResolution<P> =
  | { readonly kind: "navigation" }
  | { readonly kind: "unknown"; readonly token?: string; readonly reason?: string }
  | { readonly kind: "selected"; readonly leaf: CliLeafSpec; readonly data: readonly string[]; readonly payload: P };

export type ValidatedSelectorResult<V, P> = {
  readonly values: V;
  readonly selection: SelectorResolution<P> | { readonly kind: "help" };
};

export interface ParseRecoveryOptions {
  /** Parser-owned long option names, without leading dashes, eligible for a bounded typo hint. */
  readonly optionNames?: readonly string[];
}

/** Resolve selectors once, validate their leaf data, and never expose raw positionals downstream. */
export function parseSelectorOrUsage<
  T extends { positionals: readonly string[]; values: object },
  P,
>(
  parse: () => T,
  command: PublicCommandName,
  resolve: (positionals: readonly string[]) => SelectorResolution<P>,
): ValidatedSelectorResult<T["values"], P> {
  const parsed = parseOwnedOrUsage(parse, command);
  if (Boolean((parsed.values as { help?: unknown }).help)) return { values: parsed.values, selection: { kind: "help" } };
  const selection = resolve(parsed.positionals);
  if (selection.kind === "selected") {
    assertCliLeaf(selection.leaf);
    if (selection.leaf.exposure !== "public" || selection.leaf.command !== command) {
      throw new TypeError(`selector for '${command}' returned unrelated leaf '${selection.leaf.path}'`);
    }
    assertLeafArity(selection.leaf, selection.data);
  }
  return { values: parsed.values, selection };
}

const QUOTED = /'([^']+)'/;

/** Drop node's advisory boilerplate tail. Kept for the fall-through cases so nothing regresses. */
function stripAdvisory(msg: string): string {
  const noPositionalHint = msg.split(". To specify a positional argument")[0] ?? msg;
  const noAmbiguousHint = noPositionalHint.split("\nDid you forget")[0] ?? noPositionalHint;
  return noAmbiguousHint.trim();
}

/** Restricted Damerau-Levenshtein distance for short CLI option names. */
function optionDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= right.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = rows[i - 1]![j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, substitution);
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
      }
    }
  }
  return rows[left.length]![right.length]!;
}

/** Return one unambiguous nearby long option; distant matches and ties deliberately return none. */
function nearestLongOption(token: string | undefined, candidates: readonly string[] | undefined): string | undefined {
  if (!token?.startsWith("--") || !candidates || candidates.length === 0) return undefined;
  const rawName = token.slice(2);
  const name = rawName.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return undefined;
  const maxDistance = name.length <= 4 ? 1 : 2;
  let bestDistance = Number.POSITIVE_INFINITY;
  let best: string | undefined;
  let tied = false;
  for (const candidate of [...new Set(candidates)].sort()) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate)) continue;
    if (candidate === rawName) return undefined;
    const distance = optionDistance(name, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  return best !== undefined && !tied && bestDistance <= maxDistance ? `--${commandToken(best)}` : undefined;
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
function parseOwnedOrUsage<T extends { positionals: readonly string[]; values?: object }>(
  parse: () => T,
  command: string,
  recovery: ParseRecoveryOptions = {},
): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof CliError) throw err; // passthrough — never remapped
    const translated = translateParseArgsError(err);
    const raw = err instanceof Error ? err.message : String(err);
    const suggestion = (err as { code?: unknown } | null)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
      ? nearestLongOption(QUOTED.exec(raw)?.[1], recovery.optionNames)
      : undefined;
    const baseMessage = translated ?? stripAdvisory(raw); // unrecognized -> trimmed original, never worse
    const message = suggestion ? `${baseMessage} — did you mean '${suggestion}'?` : baseMessage;
    throw new CliError("USAGE", message, { help: `${cliInvocation()} ${commandWords(command)} --help` });
  }
}

/** Parse and validate an ordinary leaf through its branded canonical specification. */
export function parseLeafOrUsage<T extends { positionals: readonly string[]; values?: object }>(
  parse: () => T,
  leaf: CliLeafSpec,
  recovery: ParseRecoveryOptions = {},
): T {
  // Validate ownership before invoking the caller's parser thunk or any effects it may contain.
  assertCliLeaf(leaf);
  const parsed = parseOwnedOrUsage(parse, leaf.canonical.path, recovery);
  if (Boolean((parsed.values as { help?: unknown } | undefined)?.help)) return parsed;
  assertLeafArity(leaf, parsed.positionals);
  return parsed;
}

/** Exact architectural exception: `new` must load its bundle-declared schema before leaf arity. */
export function parseNewSchemaPhaseOrUsage<T extends { positionals: readonly string[]; values?: object }>(
  parse: () => T,
): T {
  return parseOwnedOrUsage(parse, "new");
}

/** Exact architectural exception: doc-update normalizes dynamic field tokens before leaf arity. */
export function parseDocUpdateTokensOrUsage<T extends { positionals: readonly string[]; values?: object }>(
  parse: () => T,
): T {
  return parseOwnedOrUsage(parse, "doc update");
}
