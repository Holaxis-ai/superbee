import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import { assertCliLeaf, type CliLeafSpec } from "./command-spec.js";
import { commandWords } from "./command-text.js";

function boundedToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  return token.length <= 80 ? token : `${token.slice(0, 80)}…`;
}

/** Validate already-classified leaf data. This module never parses argv or knows option names. */
export function assertLeafArity(
  leaf: CliLeafSpec,
  positionals: readonly string[],
): void {
  assertCliLeaf(leaf);
  const path = leaf.canonical.path;
  const count = leaf.arity.count;
  const expected = count === 0
    ? "no positional arguments"
    : `exactly ${count} positional${count === 1 ? "" : "s"}`;
  const actual = positionals.length;
  if (actual === count) return;
  const firstUnexpected = boundedToken(positionals[count]);
  const surplus = Math.max(0, actual - count);
  throw new CliError("USAGE", `${path} expected ${expected}; received ${actual}`, {
    details: {
      command: path,
      expected,
      actual,
      ...(surplus === 0 ? {} : { surplus }),
      ...(firstUnexpected === undefined ? {} : { first_unexpected: firstUnexpected }),
    },
    help: `${cliInvocation()} ${commandWords(path)} --help`,
  });
}
