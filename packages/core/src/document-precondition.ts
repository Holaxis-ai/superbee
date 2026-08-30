/**
 * Field preconditions for document mutation: the DOMAIN half of the pairing `mutation.ts`'s
 * header names. `versionedMutation` makes stale BYTES structurally impossible to act on, because
 * every attempt's decision is derived from that attempt's own fresh read; it cannot make a stale
 * DOMAIN ASSUMPTION impossible to act on, because the primitive cannot know which assumption a
 * caller made before the retry loop began. A field precondition is that assumption, written down
 * and re-derived from every attempt's fresh state.
 *
 * Evaluated inside `decide` against the same read whose version the CAS write is then conditional
 * on, the check and the write are as atomic as the compare-and-swap itself: one round trip, no new
 * backend method, and identical behavior on every adapter because no adapter participates. A
 * frontmatter predicate is OKF semantics, which is why this lives above the storage seam.
 *
 * A failure is terminal, never retried. `decide` propagates any non-`VersionConflict` throw
 * unchanged, so a caller whose assumption is already false is refused on its first attempt instead
 * of burning a retry budget and winning on a later one.
 */

import { InvalidInputError } from "./errors.js";
import type { ConceptId, Frontmatter, Version } from "./types.js";

/** What a caller asserts about one field's observed value. */
export type FieldExpectation =
  | "absent"
  | { equals: string }
  | { oneOf: string[] };

/** One asserted fact about the document a caller is about to mutate. */
export interface FieldPrecondition {
  /**
   * The storage coordinate — the literal frontmatter key. Resolving a logical Kind field to its
   * edition-specific storage field (`progress_status` -> `superbee_progress_status`) belongs to
   * the caller that owns the Kind registry; this module reads exactly the key it is given.
   */
  field: string;
  expect: FieldExpectation;
}

function describeExpectation(expect: FieldExpectation): string {
  if (expect === "absent") return "absent";
  if ("equals" in expect) return `'${expect.equals}'`;
  return `one of ${expect.oneOf.map((value) => `'${value}'`).join(", ")}`;
}

function describeActual(actual: unknown): string {
  if (actual === undefined || actual === null) return "absent";
  if (typeof actual === "string") return `'${actual}'`;
  // This runs while CONSTRUCTING the refusal, and a frontmatter value can be self-referential (a
  // YAML alias pointing back at its own anchor), which makes `JSON.stringify` throw. A throw here
  // would replace the typed error consumers branch on with a TypeError from the message builder.
  try {
    return JSON.stringify(actual) ?? String(actual);
  } catch {
    return `an unrenderable ${typeof actual} value`;
  }
}

/**
 * A caller's asserted fact about the document did not hold on the read it was evaluated against.
 * Terminal: the mutation wrote nothing and the document is byte-unchanged. Consumers branch on the
 * TYPE and map it to their own conflict shape; they never parse this message.
 */
export class PreconditionFailed extends Error {
  readonly id: ConceptId;
  readonly field: string;
  readonly expected: FieldExpectation;
  readonly actual: unknown;
  /** The version of the read this precondition was evaluated against; `null` when the document is absent. */
  readonly observedVersion: Version | null;

  constructor(
    id: ConceptId,
    field: string,
    expected: FieldExpectation,
    actual: unknown,
    observedVersion: Version | null,
  ) {
    super(
      `'${id}' precondition failed: field '${field}' expected ${describeExpectation(expected)}, `
        + `found ${describeActual(actual)}`,
    );
    this.name = "PreconditionFailed";
    this.id = id;
    this.field = field;
    this.expected = expected;
    this.actual = actual;
    this.observedVersion = observedVersion;
  }
}

/**
 * A YAML key written with no value (`assignee:`) parses to `null`, which records the same "nobody
 * set this" state as the key being missing. Distinguishing them would make an unclaimed document
 * unclaimable purely because of how its frontmatter happened to be authored.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Refuse a malformed expectation before anything evaluates it. Every other bad shape already fails
 * CLOSED, but `{ oneOf: "todo" }` did not: `oneOf` reached `String.prototype.includes`, turning set
 * membership into SUBSTRING matching, so `'tod'` and `''` satisfied it. A guard whose one failure
 * mode is failing open is worse than no guard, so the shape is rejected rather than interpreted —
 * and rejected here, in the owning primitive, so no caller can recreate the mistake at its own
 * boundary. `equals` and `oneOf` are mutually exclusive: an object carrying both states two
 * different assertions about one field and names neither.
 */
function assertRecognizedExpectation(id: ConceptId, field: string, expect: unknown): void {
  if (expect === "absent") return;
  if (typeof expect === "object" && expect !== null && !Array.isArray(expect)) {
    const shape = expect as { equals?: unknown; oneOf?: unknown };
    const hasEquals = "equals" in shape;
    const hasOneOf = "oneOf" in shape;
    if (hasEquals && !hasOneOf && typeof shape.equals === "string") return;
    if (
      hasOneOf
      && !hasEquals
      && Array.isArray(shape.oneOf)
      && shape.oneOf.every((value) => typeof value === "string")
    ) return;
  }
  throw new InvalidInputError(
    `'${id}' declares an unrecognized precondition on field '${field}': `
      + `expect must be "absent", { equals: string }, or { oneOf: string[] }`,
  );
}

function satisfied(expect: FieldExpectation, actual: unknown): boolean {
  if (expect === "absent") return isAbsent(actual);
  // A value expectation is a declared string; a list, map, number, or boolean sitting at that
  // coordinate is not that string, and coercing it to one would let `assignee: [a, b]` satisfy
  // `equals: a` on some hosts and not others.
  if (typeof actual !== "string") return false;
  return "equals" in expect ? actual === expect.equals : expect.oneOf.includes(actual);
}

/**
 * Throw on the FIRST unsatisfied precondition in caller order, so a refusal names one deterministic
 * field rather than whichever member of a set happened to be evaluated first. Preconditions are
 * ANDed: an empty or absent list asserts nothing and passes.
 *
 * Shapes are validated in a COMPLETE pass before any of them is evaluated. Interleaving the two
 * would let a malformed expectation escape unreported whenever an earlier assertion happens to
 * fail first — the same guard silently absent depending on list order.
 *
 * `frontmatter === undefined` is an ABSENT document. Every field of a document that does not exist
 * is absent, so `absent` holds there and every value expectation fails.
 */
export function assertFieldPreconditions(
  id: ConceptId,
  frontmatter: Frontmatter | undefined,
  preconditions: readonly FieldPrecondition[] | undefined,
  observedVersion: Version | null,
): void {
  if (preconditions === undefined || preconditions.length === 0) return;
  for (const precondition of preconditions) {
    assertRecognizedExpectation(id, precondition.field, precondition.expect);
  }
  for (const precondition of preconditions) {
    const actual = frontmatter === undefined ? undefined : frontmatter[precondition.field];
    if (!satisfied(precondition.expect, actual)) {
      throw new PreconditionFailed(id, precondition.field, precondition.expect, actual, observedVersion);
    }
  }
}
