import { InvalidInputError } from "./errors.js";

/** Fixed Greenwich mean time, independent of host settings and daylight-saving rules. */
export const DEFAULT_BUNDLE_TIME_ZONE = "Etc/GMT";

/** Accept named IANA zones and the explicit zero-offset names UTC/GMT, retaining spelling. */
export function validateBundleTimeZone(value: unknown): string {
  const named = typeof value === "string" &&
    (value === "UTC" || value === "GMT" || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(value));
  if (named) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      return value;
    } catch { /* Report the same actionable contract for unsupported and malformed names. */ }
  }
  throw new InvalidInputError(
    "superbee_base_time_zone must be a supported named IANA time zone, such as America/New_York or Etc/GMT (UTC and GMT are also accepted); offsets and abbreviations such as EST are not accepted.",
  );
}
