/** Known OKF v0.2 timestamp slots, shared by authored-write validation and read-only diagnostics. */
import { InvalidInputError } from "./errors.js";
import { parseIsoInstant } from "./verification.js";

import { isOkfRecord as record, okfValuesEqual as equal, authoredOkfRows, type OkfRecord as RecordValue } from "./okf-authored-values.js";

export interface InvalidOkfTimestamp { field: string; value: unknown }

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
    authoredOkfRows(frontmatter[key], existing?.[key], key === "verified").forEach(({ entry, index }) => {
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
