// Credential persistence: ~/.superbee/okf-config.json (file 0600, dir 0700), with an exact
// read-only fallback to the pre-rename ~/.agentstate/okf-config.json.
//
// Token VALUES are never logged. The home directory is injectable so unit tests can point at a temp
// dir. The on-disk field SHAPE stays compatible with holaxis-agentstate `packages/cli/src/credentials.ts`
// (same field names, same atomic temp-file-then-rename write with 0600/0700 perms), but the FILE is
// deliberately SEPARATE — `okf-config.json`, NOT canonical AgentState's `credentials.json` — so
// Superbee never overwrites (nor reads as its own) the canonical AgentState CLI's OAuth credential
// on the same machine. What Superbee stores: per-origin `--remote` API keys (`remotes`) only — the
// OAuth/PKCE/loopback flow AND the legacy `login --token` bearer store (`server`/`access_token`) are
// both gone; the live remote auth is a per-origin API key against a gated wire-protocol deployment.
//
// Writes use user-state.ts's one atomic private-file authority.
import { homedir } from "node:os";
import { join } from "node:path";

import {
  legacyUserStateDir,
  readUserStateText,
  userStateDir,
  writeFileAtomic0600,
} from "./user-state.js";

export interface Credentials {
  /**
   * Per-origin API keys for an explicitly gated `--remote <url>`, keyed by the remote's ORIGIN
   * (`new URL(remoteUrl).origin`, e.g. `https://my-worker.example.workers.dev`) — origin-keyed
   * from birth (a recorded design commitment: a single-slot shape would break the moment a
   * caller talks to more than one gated remote, e.g. a staging + a production deployment).
   * Provisioned outside the default CLI; read by `bundle.ts`'s `--remote`
   * resolution to source the `RemoteBackend` `authToken`. This is the SOLE credential shape — the
   * legacy `server`/`access_token` bearer fields were removed (the live remote auth is a per-origin
   * API key, not a stored bearer token).
   */
  remotes?: Record<string, { api_key: string }>;
}

export const CRED_FILE_NAME = "okf-config.json";

export function credentialsPath(home: string = homedir()): string {
  return join(userStateDir(home), CRED_FILE_NAME);
}

export function legacyCredentialsPath(home: string = homedir()): string {
  return join(legacyUserStateDir(home), CRED_FILE_NAME);
}

/** Write credentials atomically (temp + rename) with 0600/0700 perms. */
export async function saveCredentials(
  creds: Credentials,
  home: string = homedir(),
): Promise<void> {
  await writeFileAtomic0600(
    userStateDir(home),
    CRED_FILE_NAME,
    JSON.stringify(creds, null, 2) + "\n",
  );
}

/** Load stored credentials, or null if none exist / the file is unusable. */
export async function loadCredentials(
  home: string = homedir(),
): Promise<Credentials | null> {
  const selected = await readUserStateText(credentialsPath(home), legacyCredentialsPath(home));
  if (!selected) return null;
  const raw = selected.content;
  let parsed: Credentials;
  try {
    parsed = JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  // Valid iff it carries at least one origin-keyed `remotes` entry — a file
  // with none is unusable for anything this module's callers do, and routes to the clean "not logged
  // in" path instead of surfacing a raw low-level error downstream.
  const hasRemotes =
    parsed.remotes !== undefined && parsed.remotes !== null && Object.keys(parsed.remotes).length > 0;
  if (!hasRemotes) return null;
  return parsed;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Look up a stored API key for `origin` (`new URL(remoteUrl).origin`), or `undefined` if none stored. */
export async function getApiKeyForOrigin(
  origin: string,
  home: string = homedir(),
): Promise<string | undefined> {
  const creds = await loadCredentials(home);
  const key = creds?.remotes?.[origin]?.api_key;
  return isNonEmptyString(key) ? key : undefined;
}

/**
 * Persist an API key for `origin`, MERGING with (never clobbering) any existing credentials
 * file — every OTHER origin's stored key survives. Non-default provisioning integrations are the
 * writers.
 */
export async function saveApiKeyForOrigin(
  origin: string,
  apiKey: string,
  home: string = homedir(),
): Promise<void> {
  const existing = (await loadCredentials(home)) ?? {};
  const next: Credentials = {
    ...existing,
    remotes: { ...(existing.remotes ?? {}), [origin]: { api_key: apiKey } },
  };
  await saveCredentials(next, home);
}
