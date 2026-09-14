import { parseTimestamp } from "@superbee/core";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";

export interface MeaningfulChangeOrderKey {
  id: string;
  timestamp: string;
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

/** Newest usable meaningful-change clock first; canonical ID ascending for all ties. */
export function compareByMeaningfulChange(a: MeaningfulChangeOrderKey, b: MeaningfulChangeOrderKey): number {
  if (a.timestampMs !== null && b.timestampMs !== null) {
    if (a.timestampMs !== b.timestampMs) return b.timestampMs - a.timestampMs;
  } else if (a.timestampMs !== null) {
    return -1;
  } else if (b.timestampMs !== null) {
    return 1;
  }
  return a.id.localeCompare(b.id);
}
