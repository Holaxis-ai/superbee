// Credential persistence inside the platform-native private user-state root.
//
// Token VALUES are never logged. The home directory is injectable so unit tests can point at a temp
// dir. The on-disk schema is version 2 and keys authority by exact origin-and-bundle pair. The FILE is
// deliberately SEPARATE — `okf-config.json`, NOT canonical AgentState's `credentials.json` — so
// Superbee never overwrites (nor reads as its own) the canonical AgentState CLI's OAuth credential
// on the same machine. What Superbee stores: exact-target `--remote` API keys (`remotes`) only — the
// OAuth/PKCE/loopback flow AND the legacy `login --token` bearer store (`server`/`access_token`) are
// both gone; the live remote auth is a per-origin API key against a gated wire-protocol deployment.
//
// The write is ATOMIC: the JSON is written to a freshly O_EXCL-created temp file (mode 0600) in the
// same 0700 dir, then renamed over okf-config.json — so the secret is never momentarily exposed at
// looser perms, a crash mid-write can never truncate a good file into unparseable JSON, and O_EXCL
// refuses to follow / write through a planted symlink at the temp path.
import { homedir } from "node:os";
import { join } from "node:path";

import { readUserStateFile, userStateDir, writeUserStateFileAtomic0600 } from "./user-state.js";
import { isCanonicalBundleId, type BundleId } from "@superbee/core/storage";

export interface Credentials {
  schema: 2;
  remotes: Record<string, { bundles: Record<BundleId, { api_key: string }> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isCredentials(value: unknown): value is Credentials {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "remotes"]) || value.schema !== 2 || !isRecord(value.remotes)) {
    return false;
  }
  for (const [origin, remote] of Object.entries(value.remotes)) {
    try {
      if (new URL(origin).origin !== origin) return false;
    } catch {
      return false;
    }
    if (
      !isRecord(remote)
      || !hasExactKeys(remote, ["bundles"])
      || !isRecord(remote.bundles)
      || Object.keys(remote.bundles).length === 0
    ) return false;
    for (const [bundleId, entry] of Object.entries(remote.bundles)) {
      if (
        !isCanonicalBundleId(bundleId)
        || !isRecord(entry)
        || !hasExactKeys(entry, ["api_key"])
        || typeof entry.api_key !== "string"
        || entry.api_key.length === 0
      ) return false;
    }
  }
  return Object.keys(value.remotes).length > 0;
}

/** Exact current disk contract accepted by the explicit one-shot private-state migration. */
export function assertMigratableCredentials(raw: string): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("legacy credentials are not valid JSON");
  }
  if (!isCredentials(value)) throw new Error("credentials do not use the supported schema 2 origin-and-bundle shape");
}

export const CRED_FILE_NAME = "okf-config.json";

export function credentialsDir(home: string = homedir()): string {
  return userStateDir(home);
}

export function credentialsPath(home: string = homedir()): string {
  return join(credentialsDir(home), CRED_FILE_NAME);
}

/** Write credentials atomically (temp + rename) with 0600/0700 perms. */
export async function saveCredentials(
  creds: Credentials,
  home: string = homedir(),
): Promise<void> {
  await writeUserStateFileAtomic0600(
    home,
    credentialsDir(home),
    CRED_FILE_NAME,
    JSON.stringify(creds, null, 2) + "\n",
  );
}

/** Load stored credentials, or null if none exist / the file is unusable. */
export async function loadCredentials(
  home: string = homedir(),
): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await readUserStateFile(home, credentialsPath(home), 1024 * 1024);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isCredentials(parsed) ? parsed : null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Look up a stored API key for the exact `(origin, bundleId)` target. */
export async function getApiKeyForRemote(
  origin: string,
  bundleId: BundleId,
  home: string = homedir(),
): Promise<string | undefined> {
  const creds = await loadCredentials(home);
  const key = creds?.remotes[origin]?.bundles[bundleId]?.api_key;
  return isNonEmptyString(key) ? key : undefined;
}

/**
 * Persist an API key for `(origin, bundleId)`, MERGING with (never clobbering) any existing
 * credentials file — every other target's stored key survives. Provisioning integrations are the
 * writers.
 */
export async function saveApiKeyForRemote(
  origin: string,
  bundleId: BundleId,
  apiKey: string,
  home: string = homedir(),
): Promise<void> {
  if (!isCanonicalBundleId(bundleId)) throw new Error(`invalid bundle id '${bundleId}'`);
  const normalizedOrigin = new URL(origin).origin;
  if (normalizedOrigin !== origin) throw new Error(`remote origin must be canonical: ${origin}`);
  if (!isNonEmptyString(apiKey)) throw new Error("API key must be non-empty");
  const existing = await loadCredentials(home);
  const existingRemote = existing?.remotes[origin];
  const next: Credentials = {
    schema: 2,
    remotes: {
      ...(existing?.remotes ?? {}),
      [origin]: {
        bundles: {
          ...(existingRemote?.bundles ?? {}),
          [bundleId]: { api_key: apiKey },
        },
      },
    },
  };
  await saveCredentials(next, home);
}
