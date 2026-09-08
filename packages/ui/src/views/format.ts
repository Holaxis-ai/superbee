/** Shared presentation of explicit instants in the selected bundle time zone. */
import { parseIsoInstant } from "@superbee/core/verification";
import { DEFAULT_BUNDLE_TIME_ZONE } from "@superbee/core/time-zone";

/** A null zone means configuration is unavailable; retain source text without interpreting it. */
export function formatWhen(timestamp?: string, timeZone: string | null = DEFAULT_BUNDLE_TIME_ZONE, now = new Date()): string | null {
  if (!timestamp) return null;
  if (timeZone === null) return timestamp;
  const instant = parseIsoInstant(timestamp);
  if (instant === null) return timestamp;
  const date = new Date(instant);
  const year = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
  const sameYear = year.format(date) === year.format(now);
  return date.toLocaleString(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
