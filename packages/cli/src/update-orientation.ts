import { randomBytes } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { credentialsDir } from "./credentials.js";
import { ensureUserStateRootSync, inspectUserStateRootSync, writeUserStateFileAtomic0600 } from "./user-state.js";
import { staticBuildIdentity } from "./build-identity.js";
import { currentExecutableRealPath, PACKAGE_NAME } from "./invocation.js";
import {
  UPDATE_CHECK_SCHEMA,
  checkSupportedRelease,
  compareStrictSemver,
  parseStrictSemver,
  type UpdateCheckResult,
} from "./update-check.js";
import { LEGACY_NO_UPDATE_CHECK_ENV, SUPERBEE_NO_UPDATE_CHECK_ENV } from "./env-policy.js";

export const UPDATE_CACHE_SCHEMA = "aslite.update-cache.v1";
export const UPDATE_LEASE_SCHEMA = "aslite.update-lease.v1";
export const UPDATE_CACHE_FILE_NAME = "update-check-v1.json";
export const UPDATE_LEASE_FILE_NAME = "update-check-v1.lock";
export const UPDATE_CACHE_TTL_MS = 86_400_000;
export const UPDATE_LEASE_ACTIVE_MS = 30_000;
export const UPDATE_CACHE_MAX_BYTES = 65_536;
export const UPDATE_LEASE_MAX_BYTES = 4_096;

const TRACK = "latest" as const;
const TOKEN = /^[0-9a-f]{64}$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const METADATA_MAX_LENGTH = 4_096;
const SUCCESSFUL_STATUSES = new Set([
  "current",
  "successor_not_ready",
  "deprecated",
  "upgrade_available",
  "rollback_available",
]);

export interface UpdateCacheRecord {
  schema: typeof UPDATE_CACHE_SCHEMA;
  package: typeof PACKAGE_NAME;
  running_version: string;
  track: typeof TRACK;
  check: UpdateCheckResult;
  checked_at: string;
  expires_at: string;
}

export interface ActiveUpdateLease {
  schema: typeof UPDATE_LEASE_SCHEMA;
  state: "active";
  token: string;
  started_at: string;
  lease_expires_at: string;
  cooldown_expires_at: string;
}

export interface CooldownUpdateLease {
  schema: typeof UPDATE_LEASE_SCHEMA;
  state: "cooldown";
  token: string;
  started_at: string;
  expires_at: string;
}

export type UpdateLeaseRecord = ActiveUpdateLease | CooldownUpdateLease;

export interface UpdateNotice {
  status: "deprecated" | "upgrade_available" | "rollback_available";
  running_version: string;
  selected_version: string;
  checked_at: string;
  command: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalInstant(value: unknown): { text: string; milliseconds: number } | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  if (new Date(milliseconds).toISOString() !== value) return undefined;
  return { text: value, milliseconds };
}

function boundedMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= METADATA_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validIntegrity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const encoded = INTEGRITY.exec(value)?.[1];
  if (!encoded) return false;
  const digest = Buffer.from(encoded, "base64");
  return digest.byteLength === 64 && digest.toString("base64") === encoded;
}

function expectedVerify(): string[] {
  return [
    "superbee version --check",
    "superbee skill status --scope user",
    "superbee hook status --scope user",
  ];
}

function stringArrayEquals(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/** Strictly revalidate a complete successful check before trusting private cached bytes. */
function parseSuccessfulCheck(
  value: unknown,
  runningVersion: string,
  checkedAt: string,
): UpdateCheckResult | undefined {
  const check = asRecord(value);
  if (
    !check ||
    !hasExactKeys(check, [
      "schema",
      "track",
      "status",
      "relation",
      "checked_at",
      "running_version",
      "selected_version",
      "running_deprecated",
      "selected_integrity",
      "command",
      "verify",
      "unavailable",
    ]) ||
    check.schema !== UPDATE_CHECK_SCHEMA ||
    check.track !== TRACK ||
    check.running_version !== runningVersion ||
    check.checked_at !== checkedAt ||
    typeof check.status !== "string" ||
    !SUCCESSFUL_STATUSES.has(check.status) ||
    check.unavailable !== null ||
    typeof check.selected_version !== "string" ||
    !parseStrictSemver(check.selected_version) ||
    !validIntegrity(check.selected_integrity) ||
    !(
      check.running_deprecated === null ||
      (boundedMetadata(check.running_deprecated) && check.running_deprecated.length > 0)
    )
  ) {
    return undefined;
  }

  const selectedVersion = check.selected_version;
  const status = check.status;
  const relation = compareStrictSemver(selectedVersion, runningVersion);
  if (status === "current" || status === "deprecated") {
    if (
      selectedVersion !== runningVersion ||
      check.relation !== "equal" ||
      check.command !== null ||
      !stringArrayEquals(check.verify, []) ||
      (status === "current" && check.running_deprecated !== null) ||
      (status === "deprecated" && check.running_deprecated === null)
    ) {
      return undefined;
    }
  } else if (status === "successor_not_ready") {
    if (
      relation === undefined ||
      check.relation !== (relation === 0 ? "equal" : relation > 0 ? "selected_newer" : "selected_older") ||
      check.command !== null ||
      !stringArrayEquals(check.verify, [])
    ) {
      return undefined;
    }
  } else {
    const expectedRelation = status === "upgrade_available" ? "selected_newer" : "selected_older";
    const expectedDirection = status === "upgrade_available" ? 1 : -1;
    if (
      relation !== expectedDirection ||
      check.relation !== expectedRelation ||
      check.command !== `npm install --global ${PACKAGE_NAME}@${selectedVersion}` ||
      !stringArrayEquals(check.verify, expectedVerify())
    ) {
      return undefined;
    }
  }
  return check as unknown as UpdateCheckResult;
}

export function isPassiveUpdateSuppressed(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    argv.includes("--no-update-check") ||
    Object.hasOwn(env, SUPERBEE_NO_UPDATE_CHECK_ENV) ||
    Object.hasOwn(env, LEGACY_NO_UPDATE_CHECK_ENV) ||
    Object.hasOwn(env, "NO_UPDATE_NOTIFIER") ||
    Object.hasOwn(env, "CI")
  );
}

export function serializeUpdateCache(check: UpdateCheckResult): string {
  const checkedAt = canonicalInstant(check.checked_at);
  if (!checkedAt) throw new Error("update check timestamp is not canonical");
  const validated = parseSuccessfulCheck(check, check.running_version, checkedAt.text);
  if (!validated) throw new Error("update check is not a complete successful latest result");
  const record: UpdateCacheRecord = {
    schema: UPDATE_CACHE_SCHEMA,
    package: PACKAGE_NAME,
    running_version: check.running_version,
    track: TRACK,
    check: validated,
    checked_at: checkedAt.text,
    expires_at: new Date(checkedAt.milliseconds + UPDATE_CACHE_TTL_MS).toISOString(),
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > UPDATE_CACHE_MAX_BYTES) {
    throw new Error("update cache exceeds private size limit");
  }
  return serialized;
}

export function parseUpdateCacheText(
  raw: string,
  input: { runningVersion: string; now: Date },
): UpdateCheckResult | null {
  if (Buffer.byteLength(raw) > UPDATE_CACHE_MAX_BYTES || !parseStrictSemver(input.runningVersion)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "schema",
      "package",
      "running_version",
      "track",
      "check",
      "checked_at",
      "expires_at",
    ]) ||
    record.schema !== UPDATE_CACHE_SCHEMA ||
    record.package !== PACKAGE_NAME ||
    record.running_version !== input.runningVersion ||
    record.track !== TRACK
  ) {
    return null;
  }
  const checkedAt = canonicalInstant(record.checked_at);
  const expiresAt = canonicalInstant(record.expires_at);
  const nowMs = input.now.getTime();
  if (
    !checkedAt ||
    !expiresAt ||
    !Number.isFinite(nowMs) ||
    expiresAt.milliseconds - checkedAt.milliseconds !== UPDATE_CACHE_TTL_MS ||
    checkedAt.milliseconds > nowMs ||
    nowMs >= expiresAt.milliseconds
  ) {
    return null;
  }
  return parseSuccessfulCheck(record.check, input.runningVersion, checkedAt.text) ?? null;
}

export function projectUpdateNotice(check: UpdateCheckResult | null): UpdateNotice | undefined {
  if (
    !check ||
    (check.status !== "upgrade_available" &&
      check.status !== "rollback_available" &&
      check.status !== "deprecated") ||
    check.selected_version === null
  ) {
    return undefined;
  }
  return {
    status: check.status,
    running_version: check.running_version,
    selected_version: check.selected_version,
    checked_at: check.checked_at,
    command: check.command,
  };
}

export function isUpdateLeaseToken(value: string): boolean {
  return TOKEN.test(value);
}

export function updateCachePath(home: string): string {
  return join(credentialsDir(home), UPDATE_CACHE_FILE_NAME);
}

export function updateLeasePath(home: string): string {
  return join(credentialsDir(home), UPDATE_LEASE_FILE_NAME);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function privateOwnerAndMode(stats: Stats, mode: number): boolean {
  if ((stats.mode & 0o777) !== mode) return false;
  const currentUid = process.getuid?.();
  return currentUid === undefined || stats.uid === currentUid;
}

function inspectStateDirectory(home: string, create: boolean): "safe" | "missing" | "unsafe" {
  const directory = credentialsDir(home);
  if (create) {
    try {
      ensureUserStateRootSync(home);
    } catch {
      return "unsafe";
    }
  }
  const rootState = inspectUserStateRootSync(home);
  if (rootState === "absent") return "missing";
  if (rootState === "conflict") return "unsafe";
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(directory, flags);
  } catch (error) {
    if (errno(error) !== "ENOENT" || !create) return errno(error) === "ENOENT" ? "missing" : "unsafe";
    try {
      mkdirSync(directory, { mode: 0o700 });
      descriptor = openSync(directory, flags);
    } catch {
      return "unsafe";
    }
  }
  try {
    const stats = fstatSync(descriptor);
    return stats.isDirectory() && privateOwnerAndMode(stats, 0o700) ? "safe" : "unsafe";
  } catch {
    return "unsafe";
  } finally {
    closeSync(descriptor);
  }
}

type PrivateFileRead =
  | { state: "missing" }
  | { state: "unsafe" }
  | { state: "safe"; text: string | null };

function readPrivateFile(filePath: string, maxBytes: number): PrivateFileRead {
  const flags =
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(filePath, flags);
  } catch (error) {
    return errno(error) === "ENOENT" ? { state: "missing" } : { state: "unsafe" };
  }
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      !privateOwnerAndMode(stats, 0o600) ||
      stats.size > maxBytes
    ) {
      return { state: "unsafe" };
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) return { state: "unsafe" };
    try {
      return {
        state: "safe",
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)),
      };
    } catch {
      return { state: "safe", text: null };
    }
  } catch {
    return { state: "unsafe" };
  } finally {
    closeSync(descriptor);
  }
}

export type UpdateCacheInspection =
  | { state: "fresh"; check: UpdateCheckResult }
  | { state: "refreshable" }
  | { state: "unsafe" };

export function inspectUpdateCache(input: {
  home: string;
  runningVersion: string;
  now: Date;
}): UpdateCacheInspection {
  const directory = inspectStateDirectory(input.home, false);
  if (directory === "missing") return { state: "refreshable" };
  if (directory === "unsafe") return { state: "unsafe" };
  const file = readPrivateFile(updateCachePath(input.home), UPDATE_CACHE_MAX_BYTES);
  if (file.state === "missing") return { state: "refreshable" };
  if (file.state === "unsafe") return { state: "unsafe" };
  const check = file.text === null ? null : parseUpdateCacheText(file.text, input);
  return check ? { state: "fresh", check } : { state: "refreshable" };
}

export function serializeUpdateLease(lease: UpdateLeaseRecord): string {
  const parsed = parseUpdateLeaseValue(lease);
  if (!parsed) throw new Error("update lease is invalid");
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > UPDATE_LEASE_MAX_BYTES) {
    throw new Error("update lease exceeds private size limit");
  }
  return serialized;
}

function parseUpdateLeaseValue(value: unknown): UpdateLeaseRecord | null {
  const lease = asRecord(value);
  if (
    !lease ||
    lease.schema !== UPDATE_LEASE_SCHEMA ||
    typeof lease.token !== "string" ||
    !isUpdateLeaseToken(lease.token) ||
    typeof lease.state !== "string"
  ) {
    return null;
  }
  const startedAt = canonicalInstant(lease.started_at);
  if (!startedAt) return null;
  if (lease.state === "active") {
    if (
      !hasExactKeys(lease, [
        "schema",
        "state",
        "token",
        "started_at",
        "lease_expires_at",
        "cooldown_expires_at",
      ])
    ) {
      return null;
    }
    const leaseExpiresAt = canonicalInstant(lease.lease_expires_at);
    const cooldownExpiresAt = canonicalInstant(lease.cooldown_expires_at);
    if (
      !leaseExpiresAt ||
      !cooldownExpiresAt ||
      leaseExpiresAt.milliseconds - startedAt.milliseconds !== UPDATE_LEASE_ACTIVE_MS ||
      cooldownExpiresAt.milliseconds - startedAt.milliseconds !== UPDATE_CACHE_TTL_MS
    ) {
      return null;
    }
    return lease as unknown as ActiveUpdateLease;
  }
  if (lease.state === "cooldown") {
    if (
      !hasExactKeys(lease, ["schema", "state", "token", "started_at", "expires_at"])
    ) {
      return null;
    }
    const expiresAt = canonicalInstant(lease.expires_at);
    if (!expiresAt || expiresAt.milliseconds - startedAt.milliseconds !== UPDATE_CACHE_TTL_MS) {
      return null;
    }
    return lease as unknown as CooldownUpdateLease;
  }
  return null;
}

export function parseUpdateLeaseText(raw: string): UpdateLeaseRecord | null {
  if (Buffer.byteLength(raw) > UPDATE_LEASE_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseUpdateLeaseValue(parsed);
}

type UpdateLeaseInspection =
  | { state: "missing" }
  | { state: "unsafe" }
  | { state: "foreign" }
  | { state: "valid"; lease: UpdateLeaseRecord };

function inspectUpdateLease(home: string): UpdateLeaseInspection {
  const file = readPrivateFile(updateLeasePath(home), UPDATE_LEASE_MAX_BYTES);
  if (file.state !== "safe") return file;
  if (file.text === null) return { state: "foreign" };
  const lease = parseUpdateLeaseText(file.text);
  return lease ? { state: "valid", lease } : { state: "foreign" };
}

function writeCompleteTemp(
  directory: string,
  baseName: string,
  content: string,
  maxBytes: number,
): string {
  if (Buffer.byteLength(content) > maxBytes) throw new Error("private state exceeds size limit");
  const temporary = join(directory, `.${baseName}.${randomBytes(16).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, content, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor may already have been closed by a failed close.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // No residue to clean.
    }
    throw error;
  }
}

function createActiveLease(now: Date, token: string): ActiveUpdateLease | undefined {
  if (!isUpdateLeaseToken(token) || !Number.isFinite(now.getTime())) return undefined;
  const startedAt = now.toISOString();
  return {
    schema: UPDATE_LEASE_SCHEMA,
    state: "active",
    token,
    started_at: startedAt,
    lease_expires_at: new Date(now.getTime() + UPDATE_LEASE_ACTIVE_MS).toISOString(),
    cooldown_expires_at: new Date(now.getTime() + UPDATE_CACHE_TTL_MS).toISOString(),
  };
}

function publishActiveClaim(home: string, lease: ActiveUpdateLease): boolean {
  const directory = credentialsDir(home);
  let temporary: string | undefined;
  try {
    temporary = writeCompleteTemp(
      directory,
      UPDATE_LEASE_FILE_NAME,
      serializeUpdateLease(lease),
      UPDATE_LEASE_MAX_BYTES,
    );
    linkSync(temporary, updateLeasePath(home));
    unlinkSync(temporary);
    return true;
  } catch {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // Another path owns no cleanup obligation here.
      }
    }
    return false;
  }
}

function sameLease(left: UpdateLeaseRecord, right: UpdateLeaseRecord): boolean {
  return serializeUpdateLease(left) === serializeUpdateLease(right);
}

function transitionStaleActiveToCooldown(
  home: string,
  observed: ActiveUpdateLease,
  now: Date,
  beforeReplace?: () => void,
): boolean {
  const cooldown: CooldownUpdateLease = {
    schema: UPDATE_LEASE_SCHEMA,
    state: "cooldown",
    token: observed.token,
    started_at: observed.started_at,
    expires_at: observed.cooldown_expires_at,
  };
  let temporary: string | undefined;
  try {
    temporary = writeCompleteTemp(
      credentialsDir(home),
      UPDATE_LEASE_FILE_NAME,
      serializeUpdateLease(cooldown),
      UPDATE_LEASE_MAX_BYTES,
    );
    const current = inspectUpdateLease(home);
    if (
      current.state !== "valid" ||
      current.lease.state !== "active" ||
      !sameLease(current.lease, observed) ||
      now.getTime() < Date.parse(current.lease.lease_expires_at)
    ) {
      unlinkSync(temporary);
      return false;
    }
    beforeReplace?.();
    // rename replaces active with cooldown in one step: the fixed path is never absent.
    renameSync(temporary, updateLeasePath(home));
    return true;
  } catch {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // A successful rename consumed the temp path.
      }
    }
    return false;
  }
}

function quarantineMatchingLease(
  home: string,
  matches: (lease: UpdateLeaseRecord) => boolean,
  afterCapture?: () => void,
): boolean {
  const fixed = updateLeasePath(home);
  const quarantine = join(
    credentialsDir(home),
    `.${UPDATE_LEASE_FILE_NAME}.${randomBytes(16).toString("hex")}.quarantine`,
  );
  try {
    renameSync(fixed, quarantine);
  } catch {
    return false;
  }
  try {
    afterCapture?.();
  } catch {
    // A test barrier (or future observer) must not leave the fixed path needlessly absent.
    try {
      linkSync(quarantine, fixed);
      unlinkSync(quarantine);
    } catch {
      // Preserve the captured record when a successor raced into the fixed path.
    }
    return false;
  }
  const captured = readPrivateFile(quarantine, UPDATE_LEASE_MAX_BYTES);
  const lease =
    captured.state === "safe" && captured.text !== null
      ? parseUpdateLeaseText(captured.text)
      : null;
  if (lease && matches(lease)) {
    try {
      unlinkSync(quarantine);
    } catch {
      // The fixed path remains clear; quarantine is a private same-directory residue.
    }
    return true;
  }

  // A raced or foreign capture is never discarded. Restore only when no successor occupies fixed.
  try {
    linkSync(quarantine, fixed);
    unlinkSync(quarantine);
  } catch {
    // A successor exists or the captured state is itself unsafe; preserve the quarantine evidence.
  }
  return false;
}

export type UpdateLeaseClaimResult =
  | { state: "claimed"; lease: ActiveUpdateLease }
  | { state: "occupied" }
  | { state: "cleaned" };

export function claimUpdateLease(input: {
  home: string;
  now: Date;
  token?: string;
  /** Deterministic test barrier immediately before the continuous stale replacement. */
  beforeStaleReplace?: () => void;
  /** Deterministic test barrier after observing an expired cooldown, before quarantine. */
  beforeExpiredCooldownCleanup?: () => void;
  /** Deterministic test barrier after quarantine removes the fixed path. */
  afterExpiredCooldownCapture?: () => void;
}): UpdateLeaseClaimResult {
  if (inspectStateDirectory(input.home, true) !== "safe") return { state: "occupied" };
  const token = input.token ?? randomBytes(32).toString("hex");
  const candidate = createActiveLease(input.now, token);
  if (!candidate) return { state: "occupied" };
  const inspected = inspectUpdateLease(input.home);
  if (inspected.state === "unsafe" || inspected.state === "foreign") return { state: "occupied" };
  if (inspected.state === "missing") {
    return publishActiveClaim(input.home, candidate)
      ? { state: "claimed", lease: candidate }
      : { state: "occupied" };
  }
  const nowMs = input.now.getTime();
  if (inspected.lease.state === "active") {
    if (nowMs >= Date.parse(inspected.lease.lease_expires_at)) {
      transitionStaleActiveToCooldown(
        input.home,
        inspected.lease,
        input.now,
        input.beforeStaleReplace,
      );
    }
    return { state: "occupied" };
  }
  if (nowMs < Date.parse(inspected.lease.expires_at)) return { state: "occupied" };
  try {
    input.beforeExpiredCooldownCleanup?.();
  } catch {
    return { state: "occupied" };
  }
  return quarantineMatchingLease(
    input.home,
    (lease) => lease.state === "cooldown" && sameLease(lease, inspected.lease),
    input.afterExpiredCooldownCapture,
  )
    ? { state: "cleaned" }
    : { state: "occupied" };
}

export function releaseActiveUpdateLease(home: string, token: string): boolean {
  if (!isUpdateLeaseToken(token) || inspectStateDirectory(home, false) !== "safe") return false;
  return quarantineMatchingLease(
    home,
    (lease) => lease.state === "active" && lease.token === token,
  );
}

function activeLeaseAuthority(home: string, token: string, now: Date): ActiveUpdateLease | undefined {
  if (!isUpdateLeaseToken(token) || inspectStateDirectory(home, false) !== "safe") return undefined;
  const inspected = inspectUpdateLease(home);
  if (inspected.state !== "valid" || inspected.lease.state !== "active") return undefined;
  const nowMs = now.getTime();
  const startedMs = Date.parse(inspected.lease.started_at);
  const expiresMs = Date.parse(inspected.lease.lease_expires_at);
  if (
    !Number.isFinite(nowMs) ||
    nowMs < startedMs ||
    nowMs >= expiresMs ||
    inspected.lease.token !== token
  ) {
    return undefined;
  }
  return inspected.lease;
}

function transitionMatchingActiveToCooldown(home: string, token: string, now: Date): boolean {
  const observed = activeLeaseAuthority(home, token, now);
  if (!observed) return false;
  const cooldown: CooldownUpdateLease = {
    schema: UPDATE_LEASE_SCHEMA,
    state: "cooldown",
    token: observed.token,
    started_at: observed.started_at,
    expires_at: observed.cooldown_expires_at,
  };
  let temporary: string | undefined;
  try {
    temporary = writeCompleteTemp(
      credentialsDir(home),
      UPDATE_LEASE_FILE_NAME,
      serializeUpdateLease(cooldown),
      UPDATE_LEASE_MAX_BYTES,
    );
    const current = activeLeaseAuthority(home, token, now);
    if (!current || !sameLease(current, observed)) {
      unlinkSync(temporary);
      return false;
    }
    renameSync(temporary, updateLeasePath(home));
    return true;
  } catch {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // A successful rename consumed the temp path.
      }
    }
    return false;
  }
}

export interface DetachedUpdateChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface PassiveUpdateOrientationDeps {
  home?: string;
  runningVersion?: string;
  now?: () => Date;
  executablePath?: () => string | undefined;
  spawn?: (
    command: string,
    argv: string[],
    options: { detached: true; stdio: "ignore" },
  ) => DetachedUpdateChild;
  token?: () => string;
  /** Deterministic test barrier for the read-before-claim interleaving. */
  afterClaim?: (lease: ActiveUpdateLease) => void;
  /** Deterministic test barrier after the initial cache read and before the active claim. */
  afterInitialCacheRead?: () => void;
}

/**
 * Perform bounded local passive orientation work. The only asynchronous work is delegated to the
 * detached private worker; this function never waits for its network request or process lifetime.
 */
export function runPassiveUpdateOrientation(
  deps: PassiveUpdateOrientationDeps = {},
): UpdateNotice | undefined {
  const home = deps.home ?? homedir();
  const runningVersion = deps.runningVersion ?? staticBuildIdentity().package.version;
  const now = deps.now ?? (() => new Date());
  const initial = inspectUpdateCache({ home, runningVersion, now: now() });
  if (initial.state === "unsafe") return undefined;
  if (initial.state === "fresh") return projectUpdateNotice(initial.check);
  try {
    deps.afterInitialCacheRead?.();
  } catch {
    return undefined;
  }

  const claimed = claimUpdateLease({
    home,
    now: now(),
    token: deps.token?.(),
  });
  if (claimed.state !== "claimed") return undefined;
  try {
    deps.afterClaim?.(claimed.lease);
  } catch {
    releaseActiveUpdateLease(home, claimed.lease.token);
    return undefined;
  }

  // The post-claim recheck closes a paused-parent race with a successful prior worker.
  const afterClaim = inspectUpdateCache({ home, runningVersion, now: now() });
  if (afterClaim.state !== "refreshable") {
    releaseActiveUpdateLease(home, claimed.lease.token);
    return afterClaim.state === "fresh" ? projectUpdateNotice(afterClaim.check) : undefined;
  }

  const entry = (deps.executablePath ?? currentExecutableRealPath)();
  if (!entry || !isAbsolute(entry)) {
    releaseActiveUpdateLease(home, claimed.lease.token);
    return undefined;
  }
  const spawn =
    deps.spawn ??
    ((command, argv, options) => spawnChild(command, argv, options) as DetachedUpdateChild);

  // Cleanup quarantine can ABA-capture this claim and let a successor claim the reopened fixed
  // path. Cache freshness alone cannot prove process-start authority: immediately before spawn,
  // require the fixed record to still be our matching, unexpired active token. On lost authority,
  // do no cleanup at all: even token-scoped quarantine would briefly move a successor's record.
  if (!activeLeaseAuthority(home, claimed.lease.token, now())) {
    return undefined;
  }
  try {
    const child = spawn(
      process.execPath,
      [entry, "__update-refresh-v1", claimed.lease.token],
      { detached: true, stdio: "ignore" },
    );
    child.once("error", () => {
      releaseActiveUpdateLease(home, claimed.lease.token);
    });
    child.unref();
  } catch {
    releaseActiveUpdateLease(home, claimed.lease.token);
  }
  return undefined;
}

export interface UpdateRefreshWorkerDeps {
  home?: string;
  runningVersion?: string;
  now?: () => Date;
  check?: (input: {
    runningVersion: string;
    track: "latest";
  }) => Promise<UpdateCheckResult>;
  /** Deterministic test barrier immediately before the atomic writer's authority callback. */
  beforeCacheCommit?: () => void;
}

/** The silent private worker. Missing authority or any failure is a zero-output, zero-throw exit. */
export async function runUpdateRefreshWorker(
  token: string,
  deps: UpdateRefreshWorkerDeps = {},
): Promise<void> {
  if (!isUpdateLeaseToken(token)) return;
  const home = deps.home ?? homedir();
  const runningVersion = deps.runningVersion ?? staticBuildIdentity().package.version;
  const now = deps.now ?? (() => new Date());
  if (!parseStrictSemver(runningVersion) || !activeLeaseAuthority(home, token, now())) return;

  let check: UpdateCheckResult;
  try {
    check = await (deps.check ?? checkSupportedRelease)({ runningVersion, track: TRACK });
  } catch {
    transitionMatchingActiveToCooldown(home, token, now());
    return;
  }
  if (check.status === "unavailable" || check.unavailable !== null) {
    transitionMatchingActiveToCooldown(home, token, now());
    return;
  }

  let serialized: string;
  try {
    serialized = serializeUpdateCache(check);
  } catch {
    transitionMatchingActiveToCooldown(home, token, now());
    return;
  }
  if (!activeLeaseAuthority(home, token, now())) return;
  if (inspectUpdateCache({ home, runningVersion, now: now() }).state === "unsafe") {
    transitionMatchingActiveToCooldown(home, token, now());
    return;
  }

  try {
    await writeUserStateFileAtomic0600(home, credentialsDir(home), UPDATE_CACHE_FILE_NAME, serialized, {
      beforeCommit: () => {
        deps.beforeCacheCommit?.();
        return activeLeaseAuthority(home, token, now()) !== undefined;
      },
    });
  } catch {
    transitionMatchingActiveToCooldown(home, token, now());
    return;
  }
  releaseActiveUpdateLease(home, token);
}
