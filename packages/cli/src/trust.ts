/**
 * The one CLI rendering of OKF v0.2 trust-tier counts, shared by `status` and `home` so the two
 * reports never disagree on key names or order. Highest tier first: the signal a reader wants is
 * "how much of this bundle has a human behind it".
 */
import { trustTierCounts, type OkfDocument } from "@superbee/core";

export interface TrustCountsRow {
  human_reviewed: number;
  machine_confirmed: number;
  unverified: number;
}

/**
 * Present only for an OKF v0.2 bundle holding at least one document: v0.1 defines no trust family,
 * and an empty bundle keeps its byte-identical baseline report.
 */
export function trustCountsRow(
  okfVersion: string | null | undefined,
  docs: ReadonlyArray<Pick<OkfDocument, "frontmatter">>,
): TrustCountsRow | undefined {
  if (okfVersion !== "0.2" || docs.length === 0) return undefined;
  const counts = trustTierCounts(docs);
  return {
    human_reviewed: counts["human-reviewed"],
    machine_confirmed: counts["machine-confirmed"],
    unverified: counts.unverified,
  };
}
