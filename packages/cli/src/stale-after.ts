import { parseIsoInstant } from "@superbee/core";
import { CliError } from "./errors.js";

/** The CLI input boundary shares the core instant grammar and retains the producer's spelling. */
export function parseStaleAfter(raw: string | undefined): string | undefined {
  if (raw !== undefined && parseIsoInstant(raw) === null) {
    throw new CliError("USAGE", "--stale-after requires a valid ISO-8601 date and time with a zone (e.g. 2026-09-07T12:00:00Z)");
  }
  return raw;
}

/** Check the mutation's current edition, including every CAS retry. */
export function assertStaleAfterEdition(value: string | undefined, edition: string | undefined): void {
  if (value !== undefined && edition !== "0.2") {
    throw new CliError("USAGE", "--stale-after requires an OKF v0.2 bundle; this bundle retains v0.1. Omit the flag or explicitly migrate the bundle to v0.2 first.");
  }
}
