import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import type { PublicLeafPath } from "./reference.js";

export type PositionalArity =
  | { readonly kind: "exact"; readonly count: number }
  | { readonly kind: "minimum"; readonly minimum: number }
  | { readonly kind: "range"; readonly minimum: number; readonly maximum: number }
  | { readonly kind: "variadic"; readonly fixedPrefix: number; readonly repeatedRole: string };

export const exact = (count: number): PositionalArity => ({ kind: "exact", count });
export const minimum = (minimum: number): PositionalArity => ({ kind: "minimum", minimum });
export const range = (minimum: number, maximum: number): PositionalArity => ({ kind: "range", minimum, maximum });
export const variadic = (fixedPrefix: number, repeatedRole: string): PositionalArity => ({ kind: "variadic", fixedPrefix, repeatedRole });

export type LeafPath = PublicLeafPath | "home";

const zero = exact(0);
const one = exact(1);
const two = exact(2);
const listArity = zero;

export const LEAF_POSITIONAL_ARITY: Readonly<Record<LeafPath, PositionalArity>> = {
  "bundle locate": zero,
  "catalog add": one,
  "catalog list": zero,
  "catalog resolve": one,
  init: zero,
  "index generate": zero,
  status: zero,
  "doc write": one,
  "doc update": one,
  "doc read": one,
  "doc history": one,
  "doc delete": one,
  list: listArity,
  query: listArity,
  "link add": two,
  "link show": one,
  "link list": zero,
  "artifact create": one,
  promote: one,
  pull: zero,
  blobs: zero,
  delete: zero,
  new: two,
  kinds: zero,
  "kind field add": two,
  "kind field remove": two,
  recipes: zero,
  "recipe add": one,
  serve: zero,
  ui: zero,
  mcp: zero,
  "view list": zero,
  sync: zero,
  version: zero,
  "session-start": zero,
  "hook install": zero,
  "hook status": zero,
  "hook uninstall": zero,
  "skill install": zero,
  "skill status": zero,
  "skill uninstall": zero,
  home: zero,
};

/** The sole leaf whose authoritative option grammar requires a bundle-declared schema read. */
export const LEAF_ARITY_VALIDATION_PHASE = {
  new: "after-schema",
} as const satisfies Partial<Record<PublicLeafPath, "after-schema">>;

function expectation(contract: PositionalArity): { minimum: number; maximum?: number; description: string } {
  switch (contract.kind) {
    case "exact": return {
      minimum: contract.count,
      maximum: contract.count,
      description: contract.count === 0
        ? "no positional arguments"
        : `exactly ${contract.count} positional${contract.count === 1 ? "" : "s"}`,
    };
    case "minimum": return { minimum: contract.minimum, description: `at least ${contract.minimum} positionals` };
    case "range": return { minimum: contract.minimum, maximum: contract.maximum, description: `${contract.minimum}..${contract.maximum} positionals` };
    case "variadic": return { minimum: contract.fixedPrefix, description: `at least ${contract.fixedPrefix} positionals (then repeated ${contract.repeatedRole})` };
  }
}

function boundedToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  return token.length <= 80 ? token : `${token.slice(0, 80)}…`;
}

/** Validate already-classified leaf data. This module never parses argv or knows option names. */
export function assertLeafArity(
  path: LeafPath,
  positionals: readonly string[],
  contract: PositionalArity = LEAF_POSITIONAL_ARITY[path],
): void {
  const expected = expectation(contract);
  const actual = positionals.length;
  if (actual >= expected.minimum && (expected.maximum === undefined || actual <= expected.maximum)) return;
  const firstUnexpected = expected.maximum === undefined ? undefined : boundedToken(positionals[expected.maximum]);
  const surplus = expected.maximum === undefined ? 0 : Math.max(0, actual - expected.maximum);
  throw new CliError("USAGE", `${path} expected ${expected.description}; received ${actual}`, {
    details: {
      command: path,
      expected: expected.description,
      actual,
      ...(surplus === 0 ? {} : { surplus }),
      ...(firstUnexpected === undefined ? {} : { first_unexpected: firstUnexpected }),
    },
    help: `${cliInvocation()} ${path === "home" ? "home" : path} --help`,
  });
}
