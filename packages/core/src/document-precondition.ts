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
  return JSON.stringify(actual) ?? String(actual);
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
    const actual = frontmatter === undefined
      ? undefined
      : (frontmatter as Record<string, unknown>)[precondition.field];
    if (!satisfied(precondition.expect, actual)) {
      throw new PreconditionFailed(id, precondition.field, precondition.expect, actual, observedVersion);
    }
  }
}
