/**
 * Newest-first order shared by `list`, `home` and the View Bridge `order: "newest"` query.
 *
 * Rows sort by their parsed meaningful-change time (`generated.at`, else legacy `timestamp`),
 * newest first. Rows with a missing or unparseable time follow every timed row. Every tie,
 * including the untimed tail, breaks on the canonical ID in UTF-16 code-unit order, which every
 * host computes identically; `localeCompare` depends on the platform's ICU data.
 *
 * Browser-safe and pure.
 */
import { parseTimestamp } from "./freshness.js";
import { meaningfulChangeTimeValue } from "./meaningful-change-time.js";

export interface MeaningfulChangeOrderKey {
  id: string;
  /** The raw selected clock when it is a string, else `""`. */
  timestamp: string;
  /** The clock parsed under the bundle's OKF edition, or `null` when missing or invalid. */
  timestampMs: number | null;
}

export function meaningfulChangeOrderKey(
  id: string,
  frontmatter: { readonly generated?: unknown; readonly timestamp?: unknown },
  okfVersion?: string | null,
): MeaningfulChangeOrderKey {
  const value = meaningfulChangeTimeValue(frontmatter);
  return {
    id,
    timestamp: typeof value === "string" ? value : "",
    timestampMs: parseTimestamp(value, okfVersion ?? undefined),
  };
}

/** Newest usable meaningful-change time first; canonical ID in code-unit order for all ties. */
export function compareByMeaningfulChange(a: MeaningfulChangeOrderKey, b: MeaningfulChangeOrderKey): number {
  if (a.timestampMs !== null && b.timestampMs !== null) {
    if (a.timestampMs !== b.timestampMs) return b.timestampMs - a.timestampMs;
  } else if (a.timestampMs !== null) {
    return -1;
  } else if (b.timestampMs !== null) {
    return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Return a new array of `rows` in newest-first order; the input array is left untouched. */
export function sortByMeaningfulChange<T extends { id: string; frontmatter: { readonly generated?: unknown; readonly timestamp?: unknown } }>(
  rows: readonly T[],
  okfVersion?: string | null,
): T[] {
  return rows
    .map((row) => ({ row, key: meaningfulChangeOrderKey(row.id, row.frontmatter, okfVersion) }))
    .sort((a, b) => compareByMeaningfulChange(a.key, b.key))
    .map(({ row }) => row);
}
