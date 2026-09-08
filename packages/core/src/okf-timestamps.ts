/** Known OKF v0.2 timestamp slots, shared by authored-write validation and read-only diagnostics. */
import { InvalidInputError } from "./errors.js";
import { parseIsoInstant } from "./verification.js";

type RecordValue = Readonly<Record<string, unknown>>;
export interface InvalidOkfTimestamp { field: string; value: unknown }

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

/**
 * A consumed exact match lets preserved legacy records move within an array, but not multiply.
 * Editing a source/event row authors that row anew; its known timestamps must then be valid.
 */
function rows(value: unknown, allowBare: boolean): unknown[] {
  return Array.isArray(value) ? value : allowBare && record(value) ? [value] : [];
}

function scan(frontmatter: RecordValue, existing?: RecordValue): InvalidOkfTimestamp[] {
  const findings: InvalidOkfTimestamp[] = [];
  const slot = (owner: unknown, key: string, field: string, previous?: unknown): void => {
    if (!record(owner) || !Object.hasOwn(owner, key)) return;
    const value = owner[key];
    if (typeof value === "string" && parseIsoInstant(value) !== null) return;
    if (record(previous) && Object.hasOwn(previous, key) && equal(value, previous[key])) return;
    findings.push({ field, value });
  };
  const window = (owner: unknown, prefix: string, previous?: unknown): void => {
    slot(owner, "from", `${prefix}.from`, previous);
    slot(owner, "to", `${prefix}.to`, previous);
  };
  slot(frontmatter.generated, "at", "generated.at", existing?.generated);
  slot(frontmatter, "stale_after", "stale_after", existing);
  window(frontmatter.usage_window, "usage_window", existing?.usage_window);
  for (const key of ["verified", "sources"] as const) {
    const current = rows(frontmatter[key], key === "verified");
    const prior = rows(existing?.[key], key === "verified");
    const used = new Set<number>();
    current.forEach((entry, index) => {
      const match = prior.findIndex((old, i) => !used.has(i) && equal(entry, old));
      if (match !== -1) {
        used.add(match);
        return;
      }
      const path = key === "verified" && !Array.isArray(frontmatter.verified) ? key : `${key}[${index}]`;
      if (key === "verified") slot(entry, "at", `${path}.at`);
      else {
        slot(entry, "last_modified", `${path}.last_modified`);
        if (record(entry)) window(entry.usage_window, `${path}.usage_window`);
      }
    });
  }
  return findings;
}

/** Inspect stored values without normalizing, inferring offsets, or validating arbitrary extensions. */
export function invalidOkfTimestamps(frontmatter: RecordValue): InvalidOkfTimestamp[] {
  return scan(frontmatter);
}

/** Reject newly supplied invalid timestamps while preserving unchanged imported values. */
export function assertAuthoredOkfTimestamps(frontmatter: RecordValue, existing?: RecordValue): void {
  const first = scan(frontmatter, existing)[0];
  if (first) throw new InvalidInputError(
    `OKF v0.2 ${first.field} requires a valid ISO-8601 date and time with an explicit UTC offset (e.g. 2026-09-08T18:30:00Z or 2026-09-08T12:30:00-06:00)`,
  );
}
