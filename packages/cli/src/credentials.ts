// The legacy credential file name and the exact shape the one-shot state migration accepts.
//
// `okf-config.json` held per-origin API keys (`remotes`) for the removed `--remote` client. Nothing
// reads them now; the migration still validates the file before copying it byte for byte, so its
// accepted shape lives here.
import { homedir } from "node:os";

import { userStateDir } from "./user-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

/** Exact historical disk contract accepted by the explicit one-shot migration. */
export function assertMigratableCredentials(raw: string): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("legacy credentials are not valid JSON");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["remotes"]) || !isRecord(value.remotes)) {
    throw new Error("legacy credentials do not use the supported origin-keyed schema");
  }
  for (const [origin, entry] of Object.entries(value.remotes)) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("legacy credentials contain an invalid remote origin");
    }
    if (
      url.origin !== origin
      || !isRecord(entry)
      || !hasExactKeys(entry, ["api_key"])
      || typeof entry.api_key !== "string"
      || entry.api_key.length === 0
    ) {
      throw new Error("legacy credentials contain an unsupported remote entry");
    }
  }
}

export const CRED_FILE_NAME = "okf-config.json";

export function credentialsDir(home: string = homedir()): string {
  return userStateDir(home);
}
