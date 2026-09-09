import { parseTimestamp } from "@superbee/core";
import { CliError } from "./errors.js";

/** Check raw author input against the mutation's current edition before metadata or no-op handling. */
export function assertAuthoredLegacyTimestamp(value: unknown, edition: string | undefined): void {
  if (value !== undefined && edition === "0.2" && parseTimestamp(value, edition) === null) {
    throw new CliError("USAGE", "--timestamp requires a real ISO-8601 date and time with an explicit UTC offset (Z or numeric), e.g. 2026-09-08T12:30:00Z");
  }
}
