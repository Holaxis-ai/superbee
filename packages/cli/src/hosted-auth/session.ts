// Hosted sign-in sessions: resumable device-code sign-in, silent single-flight refresh, logout.
//
// One session per (host origin, audience). Its directory under the private state root holds the
// short-lived access token cache (`session.json`), any in-progress device authorization
// (`pending.json`) and, only with the explicit file opt-in, the refresh token. The refresh token
// otherwise lives in the OS credential store under the account `<origin> <audience>`.
//
// Concurrency: a cached access token with more than REFRESH_SKEW_MS left is used without a lock.
// Otherwise the caller takes the session's cross-process lock, RE-READS the cache (another process
// may already have refreshed), and refreshes only if still needed, writing the rotated refresh
// token and then the access token before releasing. A lost refresh response (network failure or
// 5xx after the issuer may have rotated) is retried once with the stored token, but only inside the
// issuer's REFRESH_REUSE_LEEWAY_MS reuse window; outside it a retry would trip reuse detection and
// revoke the whole token family.
//
// No command waits on a browser without a bound. Without a usable session, the first call starts a
// device authorization, persists it, and returns AUTH_REQUIRED carrying one link to relay. Running
// the same command again polls once and, when the person has confirmed, completes sign-in and
// carries on.
import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import { FilesystemMutationLockError } from "@superbee/core";

import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { cliFilesystemRuntime, withCliFilesystemMutationLock } from "../filesystem-runtime.js";
import { ensureUserStateRoot, readUserStateFile, userStateDir, writeUserStateFileAtomic0600 } from "../user-state.js";
import {
  REQUESTED_SCOPE,
  discoverHosted,
  isSecureUrl,
  trimTrailingSlashes,
  resolveClientId,
  resolveHostedTarget,
  type Discovery,
  type FetchLike,
  type HostedTarget,
} from "./discovery.js";
import {
  CREDENTIAL_STORE_ENV,
  fileSecretStore,
  macosKeychainStore,
  probeSecretStore,
  secretServiceStore,
  selectSecretStore,
  type SecretStore,
  type SecretStoreKind,
  type ToolRunner,
} from "./secret-store.js";

export const ACCESS_TOKEN_ENV = "SUPERBEE_ACCESS_TOKEN";
export const HOST_ENV = "SUPERBEE_HOST";
export const CLIENT_ID_ENV = "SUPERBEE_OAUTH_CLIENT_ID";

/** Refresh when less than this remains: covers one gateway request deadline with margin. */
export const REFRESH_SKEW_MS = 120_000;
/** The issuer's refresh-token reuse leeway (architecture review D3). */
export const REFRESH_REUSE_LEEWAY_MS = 30_000;
/**
 * How long a caller waits for another process holding the session lock before reporting the
 * session busy. It must exceed the worst-case hold so parallel agent commands queue behind one
 * slow refresh instead of failing: a refresh holds the lock for up to two store reads and one
 * store write (STORE_CALL_TIMEOUT_MS each, 5s) plus two token calls (HTTP_TIMEOUT_MS each, 10s),
 * about 35s; a device poll that restarts sign-in holds it for the poll, a store write probe (two
 * store calls), three metadata fetches and the device call, about 60s in the worst case. Waiters
 * past this still get a retryable TRANSIENT.
 */
export const SESSION_LOCK_WAIT_MS = 65_000;
/**
 * A session lock that has stood this long is far past any hold SESSION_LOCK_WAIT_MS allows for, so
 * its holder is gone even when its PID now names another process or it was taken on another host.
 */
export const SESSION_LOCK_ORPHAN_MS = 10 * 60_000;
/**
 * An owner-less session lock younger than this may be a claim caught between its directory and its
 * owner record; older, it was left by a process killed while taking it.
 */
const SESSION_LOCK_CLAIM_GRACE_MS = 5_000;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_RECORD_BYTES = 64 * 1024;
const SESSION_FILE = "session.json";
const PENDING_FILE = "pending.json";
const DEFAULT_HOST_FILE = "default-host.json";

export interface HostedAuthDeps {
  /** Home directory owning the private state root. */
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly run?: ToolRunner;
  /** Replace the OS store entirely (tests). */
  readonly store?: SecretStore;
  readonly lockWaitMs?: number;
}

export function defaultHostedAuthDeps(home: string, overrides: Partial<HostedAuthDeps> = {}): HostedAuthDeps {
  return {
    home,
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

export interface Subject {
  readonly sub?: string;
  readonly email?: string;
  readonly name?: string;
}

export interface SessionRecord {
  readonly schema: 1;
  readonly host: string;
  readonly audience: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint?: string;
  readonly credential_store: SecretStoreKind;
  readonly has_refresh_token: boolean;
  readonly access_token: string;
  readonly access_token_expires_at_ms: number;
  readonly scope?: string;
  readonly subject: Subject;
  readonly signed_in_at_ms: number;
  readonly refreshed_at_ms?: number;
}

export interface PendingRecord {
  readonly schema: 1;
  readonly host: string;
  readonly audience: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint?: string;
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_at_ms: number;
  readonly interval_s: number;
  readonly next_poll_at_ms: number;
}

export interface TokenSet {
  readonly access_token: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
}

export type TokenOutcome =
  | { readonly kind: "tokens"; readonly tokens: TokenSet }
  | { readonly kind: "oauth_error"; readonly error: string; readonly description?: string; readonly status: number }
  /** No usable answer: network failure, timeout, 5xx or an unreadable body. The issuer may still have acted. */
  | { readonly kind: "lost"; readonly reason: string };

export interface AccessToken {
  readonly accessToken: string;
  readonly source: "env" | "cache" | "refresh" | "sign-in";
  readonly expiresAtMs?: number;
}

// ---------------------------------------------------------------------------------------------
// Paths and records

export function hostedAuthRoot(home: string): string {
  return join(userStateDir(home), "hosted-auth");
}

/** The credential-store account for a target; also the session's identity. */
export function sessionAccount(target: HostedTarget): string {
  return `${target.origin} ${target.audience}`;
}

export function sessionDirFor(home: string, account: string): string {
  const key = createHash("sha256").update(account).digest("hex").slice(0, 32);
  return join(hostedAuthRoot(home), key);
}

/** The shortest `--host` value that selects this target. */
export function hostArgument(target: HostedTarget): string {
  return target.audience === `${target.origin}/mcp` ? target.origin : target.audience;
}

async function readRecord<T>(home: string, file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readUserStateFile(home, file, MAX_RECORD_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function removeFile(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readSession(home: string, target: HostedTarget): Promise<SessionRecord | null> {
  const record = await readRecord<SessionRecord>(home, join(sessionDirFor(home, sessionAccount(target)), SESSION_FILE));
  if (!record || record.schema !== 1 || record.audience !== target.audience || record.host !== target.origin) return null;
  if (typeof record.access_token !== "string" || typeof record.access_token_expires_at_ms !== "number") return null;
  return record;
}

export async function readPending(home: string, target: HostedTarget): Promise<PendingRecord | null> {
  const record = await readRecord<PendingRecord>(home, join(sessionDirFor(home, sessionAccount(target)), PENDING_FILE));
  if (!record || record.schema !== 1 || record.audience !== target.audience || record.host !== target.origin) return null;
  if (typeof record.device_code !== "string" || typeof record.expires_at_ms !== "number") return null;
  return record;
}

async function writeRecord(home: string, target: HostedTarget, file: string, value: unknown): Promise<void> {
  await writeUserStateFileAtomic0600(home, sessionDirFor(home, sessionAccount(target)), file, `${JSON.stringify(value)}\n`);
}

export async function readDefaultHost(home: string): Promise<string | null> {
  const record = await readRecord<{ host?: unknown }>(home, join(hostedAuthRoot(home), DEFAULT_HOST_FILE));
  return typeof record?.host === "string" ? record.host : null;
}

export async function writeDefaultHost(home: string, host: string): Promise<void> {
  await writeUserStateFileAtomic0600(home, hostedAuthRoot(home), DEFAULT_HOST_FILE, `${JSON.stringify({ host })}\n`);
}

/** `--host`, then SUPERBEE_HOST, then the host of the last successful sign-in. */
export async function resolveHostSelection(flag: string | undefined, deps: HostedAuthDeps): Promise<HostedTarget> {
  const chosen = flag ?? (deps.env[HOST_ENV] || undefined) ?? (await readDefaultHost(deps.home)) ?? undefined;
  if (!chosen) {
    throw new CliError("USAGE", "no hosted Superbee host selected", {
      help: `pass --host <url> (for example ${cliInvocation()} login --host https://mcp.getsuperbee.com) or set ${HOST_ENV}`,
    });
  }
  return resolveHostedTarget(chosen);
}

// ---------------------------------------------------------------------------------------------
// Stores and locking

function directoryForAccount(home: string): (account: string) => string {
  return (account) => sessionDirFor(home, account);
}

/** The store a NEW sign-in writes to, per the explicit policy. */
export function storeForNewSession(deps: HostedAuthDeps): SecretStore {
  if (deps.store) return deps.store;
  return selectSecretStore({
    home: deps.home,
    directoryFor: directoryForAccount(deps.home),
    env: deps.env,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.run ? { run: deps.run } : {}),
  });
}

/** The store an EXISTING session's refresh token was written to. */
export function storeForSession(session: SessionRecord, deps: HostedAuthDeps): SecretStore {
  if (deps.store) return deps.store;
  switch (session.credential_store) {
    case "file":
      return fileSecretStore(deps.home, directoryForAccount(deps.home));
    case "macos-keychain":
      return macosKeychainStore(deps.run);
    case "secret-service":
      return secretServiceStore(deps.run);
  }
}

export async function withSessionLock<T>(target: HostedTarget, deps: HostedAuthDeps, body: () => Promise<T>): Promise<T> {
  await ensureUserStateRoot(deps.home);
  const dir = sessionDirFor(deps.home, sessionAccount(target));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let entered = false;
  let bodyError: { readonly error: unknown } | undefined;
  try {
    return await withCliFilesystemMutationLock(
      join(dir, "session"),
      async () => {
        entered = true;
        try {
          return await body();
        } catch (error) {
          bodyError = { error };
          throw error;
        }
      },
      { waitMs: deps.lockWaitMs ?? SESSION_LOCK_WAIT_MS },
    );
  } catch (error) {
    if (!(error instanceof FilesystemMutationLockError) || bodyError?.error === error) throw error;
    if (entered) throw sessionLockReleaseFailure(error, target);
    // A refused lock root (not a private directory of this user) is not the session lock being
    // held, and its age says nothing about a holder: pass the refusal through unchanged.
    if (!(await namesSessionLock(error.lockPath, dir))) throw error;
    throw await sessionLockFailure(error, target);
  }
}

/** Whether a claim failure names the session lock itself rather than the lock root around it. */
async function namesSessionLock(lockPath: string, sessionDir: string): Promise<boolean> {
  const canonical = await realpath(sessionDir).then((real) => join(real, "session"), () => null);
  return canonical !== null && basename(cliFilesystemRuntime().mutationLockPath(canonical)) === basename(lockPath);
}

/** Why the session lock could not be taken: busy while its holder may still finish, else orphaned. */
async function sessionLockFailure(error: FilesystemMutationLockError, target: HostedTarget): Promise<CliError> {
  const changed = await stat(error.lockPath).then((info) => info.mtimeMs, () => null);
  if (changed !== null && Date.now() - changed >= (error.malformed ? SESSION_LOCK_CLAIM_GRACE_MS : SESSION_LOCK_ORPHAN_MS)) {
    return new CliError("CONFLICT", `the ${target.origin} sign-in session lock was left by a command that is gone`, {
      details: { reason: "session_lock_orphaned", host: target.origin, lock: error.lockPath, retryable: false },
      help: `confirm no superbee command is using the ${target.origin} sign-in session, remove ${error.lockPath}, then retry the same command`,
    });
  }
  return new CliError("TRANSIENT", `another Superbee process is refreshing the ${target.origin} session`, {
    details: { reason: "session_busy", retryable: true, host: target.origin },
    help: "retry the same command",
  });
}

/** The session work finished but its lock was not released as its own: a person must look. */
function sessionLockReleaseFailure(error: FilesystemMutationLockError, target: HostedTarget): CliError {
  return new CliError("RUNTIME", `the ${target.origin} sign-in session lock could not be released: ${error.message}`, {
    details: { reason: "session_lock_release_failed", host: target.origin, lock: error.lockPath, retryable: false },
    help: `inspect ${error.lockPath} before retrying the same command`,
  });
}

// ---------------------------------------------------------------------------------------------
// OAuth wire calls

async function postForm(
  deps: HostedAuthDeps,
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null } | { lost: string }> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    return { lost: error instanceof Error ? error.name : "network" };
  }
  let body: Record<string, unknown> | null = null;
  try {
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function tokenRequest(deps: HostedAuthDeps, tokenEndpoint: string, params: Record<string, string>): Promise<TokenOutcome> {
  const result = await postForm(deps, tokenEndpoint, params);
  if ("lost" in result) return { kind: "lost", reason: result.lost };
  const { status, body } = result;
  if (status >= 500) return { kind: "lost", reason: `http_${status}` };
  if (status >= 200 && status < 300) {
    if (body && typeof body.access_token === "string" && body.access_token.length > 0) {
      return {
        kind: "tokens",
        tokens: {
          access_token: body.access_token,
          ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
          ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
          ...(typeof body.id_token === "string" ? { id_token: body.id_token } : {}),
          ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
        },
      };
    }
    return { kind: "lost", reason: "unreadable_token_response" };
  }
  const error = body && typeof body.error === "string" ? body.error : `http_${status}`;
  const description = body && typeof body.error_description === "string" ? body.error_description : undefined;
  return { kind: "oauth_error", error, ...(description ? { description } : {}), status };
}

/** Unverified claims for display only; the gateway, not the CLI, verifies tokens. */
export function decodeJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function subjectFrom(tokens: TokenSet, previous?: Subject): Subject {
  const claims = decodeJwtClaims(tokens.id_token) ?? decodeJwtClaims(tokens.access_token) ?? {};
  const pick = (key: string) => (typeof claims[key] === "string" ? (claims[key] as string) : undefined);
  const sub = pick("sub") ?? previous?.sub;
  const email = pick("email") ?? previous?.email;
  const name = pick("name") ?? previous?.name;
  return { ...(sub ? { sub } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

function expiresAt(tokens: TokenSet, now: number): number {
  if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) return now + tokens.expires_in * 1000;
  const exp = decodeJwtClaims(tokens.access_token)?.exp;
  if (typeof exp === "number") return exp * 1000;
  return now + 300_000;
}

// ---------------------------------------------------------------------------------------------
// Persisting a sign-in

interface IssuerBinding {
  readonly issuer: string;
  readonly client_id: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint?: string;
}

/** Store the refresh token first, then the access-token cache: a reader never sees a cache ahead of its refresh token. */
export async function persistTokens(
  target: HostedTarget,
  binding: IssuerBinding,
  tokens: TokenSet,
  store: SecretStore,
  deps: HostedAuthDeps,
  previous?: SessionRecord,
): Promise<SessionRecord> {
  const now = deps.now();
  const account = sessionAccount(target);
  if (!previous) await revokeReplacedSession(target, store, deps);
  if (tokens.refresh_token) await store.set(account, tokens.refresh_token);
  const record: SessionRecord = {
    schema: 1,
    host: target.origin,
    audience: target.audience,
    issuer: binding.issuer,
    client_id: binding.client_id,
    token_endpoint: binding.token_endpoint,
    ...(binding.revocation_endpoint ? { revocation_endpoint: binding.revocation_endpoint } : {}),
    credential_store: store.kind,
    has_refresh_token: Boolean(tokens.refresh_token) || Boolean(previous?.has_refresh_token),
    access_token: tokens.access_token,
    access_token_expires_at_ms: expiresAt(tokens, now),
    ...(tokens.scope ?? previous?.scope ? { scope: tokens.scope ?? previous?.scope } : {}),
    subject: subjectFrom(tokens, previous?.subject),
    signed_in_at_ms: previous?.signed_in_at_ms ?? now,
    ...(previous ? { refreshed_at_ms: now } : {}),
  };
  await writeRecord(deps.home, target, SESSION_FILE, record);
  if (!previous) await writeDefaultHost(deps.home, hostArgument(target));
  return record;
}

/**
 * A fresh sign-in replaces any existing session for the target. Revoke the replaced refresh token
 * (best-effort) so its family does not stay live at the issuer until idle expiry.
 */
async function revokeReplacedSession(target: HostedTarget, newStore: SecretStore, deps: HostedAuthDeps): Promise<void> {
  const existing = await readSession(deps.home, target);
  if (!existing?.has_refresh_token || !existing.revocation_endpoint) return;
  let old: string | null = null;
  try {
    old = await storeForSession(existing, deps).get(sessionAccount(target));
  } catch {
    return;
  }
  if (!old) return;
  await postForm(deps, existing.revocation_endpoint, { token: old, token_type_hint: "refresh_token", client_id: existing.client_id });
  if (existing.credential_store !== newStore.kind) {
    await storeForSession(existing, deps).delete(sessionAccount(target)).catch(() => false);
  }
}

/** Remove the session. The local files always go; a store that cannot be reached is reported, not fatal. */
async function clearSession(target: HostedTarget, deps: HostedAuthDeps, store: SecretStore | null): Promise<boolean> {
  let storeCleared = true;
  if (store) {
    try {
      await store.delete(sessionAccount(target));
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "CREDENTIAL_STORE_UNAVAILABLE") throw error;
      storeCleared = false;
    }
  }
  await removeFile(join(sessionDirFor(deps.home, sessionAccount(target)), SESSION_FILE));
  return storeCleared;
}

async function clearPending(target: HostedTarget, deps: HostedAuthDeps): Promise<void> {
  await removeFile(join(sessionDirFor(deps.home, sessionAccount(target)), PENDING_FILE));
}

/** Drop an in-progress device authorization. Caller holds the session lock. */
export async function clearPendingSignIn(target: HostedTarget, deps: HostedAuthDeps): Promise<void> {
  await clearPending(target, deps);
}

// ---------------------------------------------------------------------------------------------
// AUTH_REQUIRED

export type SignInReason =
  | "no_session"
  | "session_expired"
  | "authorization_pending"
  | "previous_code_expired"
  | "previous_code_rejected"
  | "previous_request_denied";

export function defaultResumeCommand(target: HostedTarget, clientIdFlag?: string): CommandText {
  const base = commandFragment`${cliInvocation()} login --host ${commandToken(hostArgument(target))}`;
  return clientIdFlag ? commandFragment`${base} --client-id ${commandToken(clientIdFlag)}` : base;
}

export function authRequired(
  target: HostedTarget,
  pending: PendingRecord,
  reason: SignInReason,
  resume: CommandText,
  now: number,
): CliError {
  const link = pending.verification_uri_complete ?? pending.verification_uri;
  const relay = pending.verification_uri_complete
    ? `open ${link} and confirm the code ${pending.user_code}`
    : `open ${link} and enter the code ${pending.user_code}`;
  return new CliError("AUTH_REQUIRED", `sign-in to ${target.origin} is required: ask the person to ${relay}, then re-run the same command`, {
    details: {
      host: target.origin,
      audience: target.audience,
      reason,
      sign_in_url: link,
      user_code: pending.user_code,
      expires_at: new Date(pending.expires_at_ms).toISOString(),
      poll_after_seconds: Math.max(0, Math.ceil((pending.next_poll_at_ms - now) / 1000)),
      resume,
    },
    help: `after the person confirms, re-run: ${resume}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Device authorization

export interface SignInOptions {
  readonly clientIdFlag?: string;
  readonly resume?: CommandText;
  /**
   * False for background work (a pull on a read, a session start): use the cached token or a
   * refresh, and otherwise throw {@link SignedOutError} without clearing the stored session or
   * starting a sign-in, so an explicit command meets the session as it was and relays the link.
   */
  readonly signIn?: boolean;
}

/** Background work found no usable session and, by design, did not start a sign-in. */
export class SignedOutError extends CliError {
  constructor(target: HostedTarget, reason: "no_session" | "session_expired") {
    super("AUTH_REQUIRED", `not signed in to ${target.origin} (${reason}); background sync skipped`, {
      details: { reason: "signed_out", session: reason, host: target.origin },
      help: `${cliInvocation()} login --host ${commandToken(hostArgument(target))}`,
    });
  }
}

export interface PreparedSignIn {
  readonly discovery: Discovery;
  readonly clientId: string;
  readonly store: SecretStore;
}

/** Discovery, client id and a store probe: every sign-in fails fast here before a person is asked to act. */
export async function prepareSignIn(target: HostedTarget, options: SignInOptions, deps: HostedAuthDeps): Promise<PreparedSignIn> {
  const store = storeForNewSession(deps);
  await probeSecretStore(store, sessionAccount(target));
  const discovery = await discoverHosted(deps.fetch, target);
  const { clientId } = resolveClientId({
    ...(options.clientIdFlag ? { flag: options.clientIdFlag } : {}),
    ...(deps.env[CLIENT_ID_ENV] ? { env: deps.env[CLIENT_ID_ENV] } : {}),
    ...(discovery.publishedClientId ? { published: discovery.publishedClientId } : {}),
    ...(discovery.publishedClientIdMalformed ? { publishedMalformed: true } : {}),
    origin: target.origin,
    metadataUrl: target.metadataUrl,
  });
  return { discovery, clientId, store };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function startDeviceAuthorization(target: HostedTarget, options: SignInOptions, deps: HostedAuthDeps): Promise<PendingRecord> {
  const { discovery, clientId } = await prepareSignIn(target, options, deps);
  if (!discovery.deviceAuthorizationEndpoint) {
    throw new CliError("RUNTIME", `the issuer for ${target.origin} does not offer device sign-in`, {
      help: `use ${cliInvocation()} login --host ${commandToken(hostArgument(target))} --loopback`,
    });
  }
  const result = await postForm(deps, discovery.deviceAuthorizationEndpoint, {
    client_id: clientId,
    scope: REQUESTED_SCOPE,
    audience: target.audience,
  });
  if ("lost" in result || result.status >= 500) {
    throw new CliError("TRANSIENT", `could not start sign-in with ${discovery.issuer}`, { details: { retryable: true } });
  }
  const body = result.body ?? {};
  if (result.status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string") {
    const error = typeof body.error === "string" ? body.error : `http_${result.status}`;
    throw new CliError("RUNTIME", `the issuer refused to start sign-in (${error})`, { details: { error, host: target.origin, client_id: clientId } });
  }
  for (const key of ["verification_uri", "verification_uri_complete"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isSecureUrl(value)) {
      throw new CliError("RUNTIME", `the issuer returned a ${key} that is not an https URL; refusing to relay it`, {
        details: { host: target.origin },
      });
    }
  }
  const now = deps.now();
  const interval = positiveInt(body.interval, 5);
  const pending: PendingRecord = {
    schema: 1,
    host: target.origin,
    audience: target.audience,
    issuer: discovery.issuer,
    client_id: clientId,
    token_endpoint: discovery.tokenEndpoint,
    ...(discovery.revocationEndpoint ? { revocation_endpoint: discovery.revocationEndpoint } : {}),
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    ...(typeof body.verification_uri_complete === "string" ? { verification_uri_complete: body.verification_uri_complete } : {}),
    expires_at_ms: now + positiveInt(body.expires_in, 900) * 1000,
    interval_s: interval,
    next_poll_at_ms: now + interval * 1000,
  };
  await writeRecord(deps.home, target, PENDING_FILE, pending);
  return pending;
}

/** Device-poll errors that end the current code and are answered with a fresh one. */
const DEVICE_RESTART_REASONS: ReadonlyMap<string, SignInReason> = new Map([
  ["expired_token", "previous_code_expired"],
  ["access_denied", "previous_request_denied"],
  ["invalid_grant", "previous_code_rejected"],
]);

/**
 * Save a just-redeemed device sign-in. The device code is spent once redeemed, so the pending
 * record goes whether or not the save succeeds: a later run must start a fresh code rather than
 * poll a dead one. When the save fails the tokens cannot be kept, so the new refresh token is
 * revoked (best-effort) and the failure is reported as a store problem with its remedy.
 */
async function completeDeviceSignIn(target: HostedTarget, pending: PendingRecord, tokens: TokenSet, deps: HostedAuthDeps): Promise<SessionRecord> {
  try {
    return await persistTokens(target, pending, tokens, storeForNewSession(deps), deps);
  } catch (error) {
    if (tokens.refresh_token && pending.revocation_endpoint) {
      await postForm(deps, pending.revocation_endpoint, {
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
        client_id: pending.client_id,
      });
    }
    if (error instanceof CliError && error.code === "CREDENTIAL_STORE_UNAVAILABLE") {
      throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", `sign-in to ${target.origin} was confirmed but could not be saved: ${error.message}`, {
        details: { ...error.details, host: target.origin, reason: "store_write_failed_after_sign_in", sign_in_discarded: true },
        help: `${error.help ?? `set ${CREDENTIAL_STORE_ENV}=file to use a 0600 file store`}; then re-run the same command, which starts a fresh sign-in`,
      });
    }
    throw error;
  } finally {
    await clearPending(target, deps);
  }
}

/**
 * Advance device sign-in by at most one poll. Returns the new session when the person has
 * confirmed; otherwise throws AUTH_REQUIRED with the (same, or a fresh) link. Caller holds the lock.
 */
async function advanceDeviceSignIn(
  target: HostedTarget,
  reason: SignInReason,
  options: SignInOptions,
  deps: HostedAuthDeps,
): Promise<SessionRecord> {
  const resume = options.resume ?? defaultResumeCommand(target, options.clientIdFlag);
  let pending = await readPending(deps.home, target);
  const now = deps.now();
  const requestedClientId = options.clientIdFlag || deps.env[CLIENT_ID_ENV] || undefined;
  if (pending && (pending.expires_at_ms <= now || (requestedClientId && requestedClientId !== pending.client_id))) {
    await clearPending(target, deps);
    reason = pending.expires_at_ms <= now ? "previous_code_expired" : reason;
    pending = null;
  }
  if (!pending) {
    const started = await startDeviceAuthorization(target, options, deps);
    throw authRequired(target, started, reason, resume, deps.now());
  }
  if (now < pending.next_poll_at_ms) throw authRequired(target, pending, "authorization_pending", resume, now);

  const outcome = await tokenRequest(deps, pending.token_endpoint, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: pending.device_code,
    client_id: pending.client_id,
  });
  if (outcome.kind === "tokens") return completeDeviceSignIn(target, pending, outcome.tokens, deps);
  const after = deps.now();
  if (outcome.kind === "lost" || outcome.error === "authorization_pending" || outcome.error === "slow_down") {
    const interval = outcome.kind === "oauth_error" && outcome.error === "slow_down" ? pending.interval_s + 5 : pending.interval_s;
    const next: PendingRecord = { ...pending, interval_s: interval, next_poll_at_ms: after + interval * 1000 };
    await writeRecord(deps.home, target, PENDING_FILE, next);
    throw authRequired(target, next, "authorization_pending", resume, after);
  }
  await clearPending(target, deps);
  // invalid_grant on a device poll means the issuer no longer knows the code: it was already
  // redeemed or has aged out. Either way only a fresh code can make progress.
  const restartAs = DEVICE_RESTART_REASONS.get(outcome.error);
  if (restartAs) {
    const restarted = await startDeviceAuthorization(target, options, deps);
    throw authRequired(target, restarted, restartAs, resume, deps.now());
  }
  throw new CliError("RUNTIME", `the issuer rejected sign-in (${outcome.error})`, {
    details: { error: outcome.error, host: target.origin, client_id: pending.client_id },
  });
}

// ---------------------------------------------------------------------------------------------
// Refresh

async function refreshOnce(session: SessionRecord, refreshToken: string, deps: HostedAuthDeps): Promise<TokenOutcome> {
  return tokenRequest(deps, session.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: session.client_id,
  });
}

/**
 * One refresh, plus at most one retry of a LOST response inside the reuse leeway. The retry
 * re-reads the store first, so if anything else under this lock wrote a rotated token it is used.
 */
async function refreshWithLeeway(
  session: SessionRecord,
  account: string,
  store: SecretStore,
  refreshToken: string,
  deps: HostedAuthDeps,
): Promise<TokenOutcome> {
  const started = deps.now();
  const first = await refreshOnce(session, refreshToken, deps);
  if (first.kind !== "lost") return first;
  if (deps.now() - started >= REFRESH_REUSE_LEEWAY_MS) return first;
  const current = (await store.get(account)) ?? refreshToken;
  return refreshOnce(session, current, deps);
}

function freshSession(session: SessionRecord | null, now: number): SessionRecord | null {
  return session !== null && session.access_token_expires_at_ms - now > REFRESH_SKEW_MS ? session : null;
}

/**
 * THE entry point for any command that needs a hosted access token. Returns a token (from the CI
 * override, the cache, a silent refresh, or a just-confirmed device sign-in) or throws
 * AUTH_REQUIRED carrying one link to relay.
 */
export async function ensureHostedAccessToken(
  target: HostedTarget,
  options: SignInOptions,
  deps: HostedAuthDeps,
): Promise<AccessToken> {
  const override = deps.env[ACCESS_TOKEN_ENV];
  if (override) {
    assertOverrideFor(target, override, deps);
    return { accessToken: override, source: "env" };
  }

  const cached = freshSession(await readSession(deps.home, target), deps.now());
  if (cached) return { accessToken: cached.access_token, source: "cache", expiresAtMs: cached.access_token_expires_at_ms };

  return withSessionLock(target, deps, async () => {
    const session = await readSession(deps.home, target);
    const fresh = freshSession(session, deps.now());
    if (fresh) return { accessToken: fresh.access_token, source: "cache", expiresAtMs: fresh.access_token_expires_at_ms };
    let reason: SignInReason = "no_session";
    if (!session && options.signIn === false) throw new SignedOutError(target, "no_session");
    if (session) {
      reason = "session_expired";
      const store = storeForSession(session, deps);
      const refreshToken = session.has_refresh_token ? await store.get(sessionAccount(target)) : null;
      if (!refreshToken && options.signIn === false) throw new SignedOutError(target, "session_expired");
      if (refreshToken) {
        const outcome = await refreshWithLeeway(session, sessionAccount(target), store, refreshToken, deps);
        if (outcome.kind === "tokens") {
          const next = await persistTokens(target, session, outcome.tokens, store, deps, session);
          return { accessToken: next.access_token, source: "refresh", expiresAtMs: next.access_token_expires_at_ms };
        }
        if (outcome.kind === "lost") {
          throw new CliError("TRANSIENT", `could not refresh the ${target.origin} session (${outcome.reason})`, {
            details: { reason: "refresh_unanswered", retryable: true, host: target.origin },
            help: "retry the same command",
          });
        }
        if (outcome.status === 429 || outcome.error === "too_many_requests") {
          throw new CliError("TRANSIENT", `the issuer is rate-limiting refreshes for ${target.origin}`, {
            details: { reason: "rate_limited", retryable: true, host: target.origin },
            help: "wait, then retry the same command",
          });
        }
        if (outcome.error !== "invalid_grant") {
          throw new CliError("RUNTIME", `the issuer refused to refresh the ${target.origin} session (${outcome.error})`, {
            details: { error: outcome.error, host: target.origin },
          });
        }
        if (options.signIn === false) throw new SignedOutError(target, "session_expired");
      }
      await clearSession(target, deps, store);
    }
    const signedIn = await advanceDeviceSignIn(target, reason, options, deps);
    return { accessToken: signedIn.access_token, source: "sign-in", expiresAtMs: signedIn.access_token_expires_at_ms };
  });
}

/** Audiences the override token claims (unverified), or null for an opaque token. */
export function overrideAudiences(token: string): string[] | null {
  const aud = decodeJwtClaims(token)?.aud;
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === "string");
  return null;
}

/**
 * SUPERBEE_ACCESS_TOKEN is bound to one host: it is used only when its `aud` names this target's
 * audience, or (for an opaque token) when SUPERBEE_HOST selects this target. Otherwise a CI token
 * minted for staging could be sent to production or to an agent path.
 */
export function assertOverrideFor(target: HostedTarget, token: string, deps: HostedAuthDeps): void {
  const audiences = overrideAudiences(token);
  if (audiences !== null) {
    if (audiences.some((a) => trimTrailingSlashes(a) === target.audience)) return;
    throw new CliError("USAGE", `${ACCESS_TOKEN_ENV} is for a different audience than ${target.audience}`, {
      details: { host: target.origin, audience: target.audience, token_audiences: audiences },
      help: `unset ${ACCESS_TOKEN_ENV}, or target the host it was issued for`,
    });
  }
  const pinned = deps.env[HOST_ENV];
  let pinnedAudience: string | undefined;
  try {
    pinnedAudience = pinned ? resolveHostedTarget(pinned).audience : undefined;
  } catch {
    pinnedAudience = undefined;
  }
  if (pinnedAudience === target.audience) return;
  throw new CliError("USAGE", `${ACCESS_TOKEN_ENV} carries no readable audience; set ${HOST_ENV} to the host it is for`, {
    details: { host: target.origin, audience: target.audience },
    help: `set ${HOST_ENV}=${hostArgument(target)} if the token is for this host, or unset ${ACCESS_TOKEN_ENV}`,
  });
}

export interface WaitOptions extends SignInOptions {
  readonly timeoutMs: number;
  /** Told the link to relay: on the first AUTH_REQUIRED and whenever the link changes. */
  readonly announce?: (error: CliError) => void;
}

/** `login --wait`: poll at the issuer's interval until confirmed, denied, expired, or the bound runs out. */
export async function waitForHostedSignIn(target: HostedTarget, options: WaitOptions, deps: HostedAuthDeps): Promise<AccessToken> {
  const deadline = deps.now() + options.timeoutMs;
  let announced: unknown;
  while (true) {
    try {
      return await ensureHostedAccessToken(target, options, deps);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "AUTH_REQUIRED") throw error;
      const link = error.details?.sign_in_url;
      if (link !== announced) {
        announced = link;
        options.announce?.(error);
      }
      const pollAfter = Number(error.details?.poll_after_seconds ?? 5) * 1000;
      const now = deps.now();
      if (now + pollAfter > deadline) throw error;
      await deps.sleep(Math.max(pollAfter, 250));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Logout

export interface LogoutResult {
  readonly host: string;
  readonly audience: string;
  readonly signed_out: boolean;
  readonly revoked: boolean;
  readonly revocation?: "revoked" | "no_refresh_token" | "no_revocation_endpoint" | "failed" | "store_unavailable";
  readonly access_token_valid_until?: string;
  /** Whether the refresh token was removed from the credential store (absent when there was no session). */
  readonly store_cleared?: boolean;
  readonly cancelled_pending_sign_in: boolean;
}

export async function logoutHosted(target: HostedTarget, deps: HostedAuthDeps): Promise<LogoutResult> {
  return withSessionLock(target, deps, async () => {
    const session = await readSession(deps.home, target);
    const cancelledPending = (await readPending(deps.home, target)) !== null;
    await clearPending(target, deps);
    if (!session) {
      return { host: target.origin, audience: target.audience, signed_out: false, revoked: false, cancelled_pending_sign_in: cancelledPending };
    }
    const store = storeForSession(session, deps);
    let refreshToken: string | null = null;
    let storeUnavailable = false;
    try {
      refreshToken = session.has_refresh_token ? await store.get(sessionAccount(target)) : null;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "CREDENTIAL_STORE_UNAVAILABLE") throw error;
      storeUnavailable = true;
    }
    let revocation: LogoutResult["revocation"] = storeUnavailable ? "store_unavailable" : "no_refresh_token";
    if (refreshToken && !session.revocation_endpoint) revocation = "no_revocation_endpoint";
    if (refreshToken && session.revocation_endpoint) {
      const result = await postForm(deps, session.revocation_endpoint, {
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: session.client_id,
      });
      revocation = !("lost" in result) && result.status === 200 ? "revoked" : "failed";
    }
    // Revocation and local deletion are separate facts: a revoke can succeed and the store delete still fail.
    const storeCleared = !storeUnavailable && (await clearSession(target, deps, store));
    if (storeUnavailable) await clearSession(target, deps, null);
    const validUntil = session.access_token_expires_at_ms > deps.now() ? new Date(session.access_token_expires_at_ms).toISOString() : undefined;
    return {
      host: target.origin,
      audience: target.audience,
      signed_out: true,
      revoked: revocation === "revoked",
      revocation,
      store_cleared: storeCleared,
      ...(validUntil ? { access_token_valid_until: validUntil } : {}),
      cancelled_pending_sign_in: cancelledPending,
    };
  });
}
