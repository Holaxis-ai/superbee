// One managed local UI authority per exact canonical bundle + resolved actor. This module owns the
// private record transaction and authenticated controller protocol; it never owns bundle reads,
// browser-session auth, rendering, or the HTTP listener itself.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { withFilesystemMutationLock } from "@superbee/core";

import { CliError } from "../errors.js";
import { currentExecutableRealPath, cliInvocation } from "../invocation.js";
import {
  ensureUserStateRoot,
  readUserStateFile,
  userStateDir,
  writeUserStateFileAtomic0600,
} from "../user-state.js";
import { commandFragment, commandToken, type CommandText } from "../command-text.js";

export const MANAGED_UI_PROTOCOL = 1;
export const MANAGED_UI_RECORD_SCHEMA = 1;
export const MANAGED_UI_STARTUP_DEADLINE_MS = 15_000;
export const MANAGED_UI_PENDING_RECLAIM_MS = 20_000;
const RECORD_PREFIX = "managed-ui-";
const RECORD_SUFFIX = ".json";
const RECORD_MAX_BYTES = 32 * 1024;
const START_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const START_DIAGNOSTIC_MESSAGE_MAX_CHARS = 512;
const PROBE_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 100;
const STOP_EXIT_DEADLINE_MS = 20_000;
// A recovery can consume one initial probe + stop acknowledgement + the complete bounded exit
// proof before starting and adopting a replacement. Keep contender wait above that 38s ceiling.
const LIFECYCLE_LOCK_WAIT_MS = 60_000;

export interface ManagedUiAuthority {
  key: string;
  mode: "dir";
  bundle_root: string;
  launch_root: string;
  actor: string | null;
  protocol: number;
}

export type ManagedUiPhase = "pending" | "ready" | "adopted" | "stopping";

export interface ManagedUiRecord {
  schema_version: 1;
  phase: ManagedUiPhase;
  operation_id: string;
  authority: ManagedUiAuthority;
  management_secret: string;
  created_at: string;
  host?: "127.0.0.1";
  port?: number;
  browser_token?: string;
  launch_nonce?: string;
  pid?: number;
  started_at?: string;
}

export interface ManagedUiStatus extends ManagedUiRecord {
  live: boolean | "unknown";
  active_clients?: number;
}

export interface ManagedUiLaunchReceipt {
  state: "started" | "reused";
  authority: ManagedUiAuthority;
  record: ManagedUiRecord;
  url: string;
}

export interface ManagedUiWorkerInput {
  schema_version: 1;
  operation_id: string;
  authority: ManagedUiAuthority;
  management_secret: string;
  startup_deadline_at: string;
  launch_identity: ManagedUiLaunchIdentity;
  port: number;
}

export interface ManagedUiLaunchIdentity {
  canonical_root: string;
  dev: number;
  ino: number;
}

export interface ManagedUiWorkerReady {
  host: "127.0.0.1";
  port: number;
  browser_token: string;
  launch_nonce: string;
  pid: number;
  started_at: string;
}

export interface ManagedUiControllerOptions {
  home?: string;
  now?: () => number;
  fetch?: typeof fetch;
  spawnWorker?: (input: ManagedUiWorkerInput) => Promise<ManagedUiWorkerReady>;
  withLock?: <T>(target: string, fn: () => Promise<T>) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  launchIdentity?: ManagedUiLaunchIdentity;
}

export async function captureManagedUiLaunchIdentity(authority: ManagedUiAuthority): Promise<ManagedUiLaunchIdentity> {
  const canonicalRoot = await realpath(authority.launch_root);
  if (canonicalRoot !== authority.bundle_root) {
    throw new CliError("CONFLICT", "managed UI launch route changed after controller selection");
  }
  const metadata = await stat(canonicalRoot);
  if (!metadata.isDirectory()) throw new CliError("CONFLICT", "managed UI launch route is no longer a directory");
  return { canonical_root: canonicalRoot, dev: metadata.dev, ino: metadata.ino };
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function managedUiAuthority(
  bundleRoot: string,
  actor: string | undefined,
  launchRoot: string = bundleRoot,
): ManagedUiAuthority {
  const tuple = { mode: "dir" as const, bundle_root: bundleRoot, actor: actor ?? null };
  // Protocol compatibility is RECORD state, not slot identity. Keeping it out of the digest lets a
  // new controller discover and deliberately replace/refuse an older authority instead of silently
  // starting a second process beside it.
  const key = createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
  return { key, ...tuple, launch_root: launchRoot, protocol: MANAGED_UI_PROTOCOL };
}

function validateAuthority(value: unknown): ManagedUiAuthority | null {
  if (!object(value) || !exactKeys(value, ["key", "mode", "bundle_root", "launch_root", "actor", "protocol"])) return null;
  if (!boundedString(value.key, 64) || !/^[0-9a-f]{64}$/u.test(value.key)) return null;
  if (value.mode !== "dir" || !boundedString(value.bundle_root) || !path.isAbsolute(value.bundle_root)) return null;
  if (!boundedString(value.launch_root) || !path.isAbsolute(value.launch_root)) return null;
  if (!(value.actor === null || boundedString(value.actor, 1024))) return null;
  if (typeof value.protocol !== "number" || !Number.isSafeInteger(value.protocol) || value.protocol < 1) return null;
  const expected = managedUiAuthority(value.bundle_root, value.actor ?? undefined, value.launch_root);
  return expected.key === value.key ? { ...expected, protocol: value.protocol } : null;
}

export function parseManagedUiRecord(raw: string): ManagedUiRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("managed UI record is not valid JSON");
  }
  const required = ["schema_version", "phase", "operation_id", "authority", "management_secret", "created_at"];
  const optional = ["host", "port", "browser_token", "launch_nonce", "pid", "started_at"];
  if (!object(value) || !exactKeys(value, required, optional)) throw new Error("managed UI record has an unsupported shape");
  if (value.schema_version !== MANAGED_UI_RECORD_SCHEMA) throw new Error("managed UI record has an unsupported schema");
  if (!(value.phase === "pending" || value.phase === "ready" || value.phase === "adopted" || value.phase === "stopping")) {
    throw new Error("managed UI record has an invalid phase");
  }
  const authority = validateAuthority(value.authority);
  if (!authority) throw new Error("managed UI record has an invalid authority");
  if (!boundedString(value.operation_id, 128) || !boundedString(value.management_secret, 256)) {
    throw new Error("managed UI record has invalid operation authority");
  }
  if (!boundedString(value.created_at, 64) || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error("managed UI record has an invalid creation time");
  }
  const liveRequired = value.phase !== "pending";
  if (liveRequired) {
    if (
      value.host !== "127.0.0.1" ||
      typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !boundedString(value.browser_token, 256) || !boundedString(value.launch_nonce, 128) ||
      typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !boundedString(value.started_at, 64) || !Number.isFinite(Date.parse(value.started_at))
    ) throw new Error("managed UI live record is incomplete");
  } else if (optional.some((key) => Object.hasOwn(value, key))) {
    throw new Error("managed UI pending record contains live-process fields");
  }
  return value as unknown as ManagedUiRecord;
}

export function managedUiRecordPath(authority: ManagedUiAuthority, home: string = homedir()): string {
  return path.join(userStateDir(home), `${RECORD_PREFIX}${authority.key}${RECORD_SUFFIX}`);
}

function recordName(authority: ManagedUiAuthority): string {
  return `${RECORD_PREFIX}${authority.key}${RECORD_SUFFIX}`;
}

async function readRecord(authority: ManagedUiAuthority, home: string): Promise<{ record: ManagedUiRecord; raw: string } | null> {
  const file = managedUiRecordPath(authority, home);
  try {
    const raw = await readUserStateFile(home, file, RECORD_MAX_BYTES);
    const record = parseManagedUiRecord(raw);
    if (record.authority.key !== authority.key) throw new Error("managed UI record does not match its authority slot");
    return { record, raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("RUNTIME", `managed UI state for this bundle is unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`, {
      help: `${cliInvocation()} ui --status --dir ${commandToken(authority.bundle_root)}`,
    });
  }
}

async function writeRecord(record: ManagedUiRecord, home: string): Promise<void> {
  await writeUserStateFileAtomic0600(
    home,
    userStateDir(home),
    recordName(record.authority),
    `${JSON.stringify(record)}\n`,
  );
}

async function removeExactRecord(authority: ManagedUiAuthority, expectedRaw: string, home: string): Promise<boolean> {
  const current = await readRecord(authority, home);
  if (!current || current.raw !== expectedRaw) return false;
  await unlink(managedUiRecordPath(authority, home));
  return true;
}

function managementHeaders(record: ManagedUiRecord): Record<string, string> {
  return {
    "x-superbee-management-secret": record.management_secret,
    "x-superbee-launch-nonce": record.launch_nonce!,
  };
}

async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface Probe {
  protocol: number;
  mode: "dir";
  authority_key: string;
  bundle_root: string;
  launch_root: string;
  actor: string | null;
  launch_nonce: string;
  state: ManagedUiPhase;
  active_clients: number;
}

type ProbeResult =
  | { kind: "matched"; probe: Probe }
  | { kind: "absent" }
  | { kind: "indeterminate"; reason: string };

function hasConnectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if ((value as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
    if ("cause" in value && visit((value as { cause?: unknown }).cause)) return true;
    if ("errors" in value && Array.isArray((value as { errors?: unknown[] }).errors)) {
      return (value as { errors: unknown[] }).errors.some(visit);
    }
    return false;
  };
  return visit(error);
}

async function probeRecord(record: ManagedUiRecord, fetchImpl: typeof fetch, timeoutMs?: number): Promise<ProbeResult> {
  if (!record.port || !record.launch_nonce) return { kind: "indeterminate", reason: "record has no live launch identity" };
  try {
    const response = await boundedFetch(fetchImpl, `http://127.0.0.1:${record.port}/__manage/status`, {
      headers: managementHeaders(record),
    }, timeoutMs);
    if (!response.ok) return { kind: "indeterminate", reason: `management endpoint returned ${response.status}` };
    const value = await response.json() as Partial<Probe>;
    if (
      value.mode !== "dir" ||
      value.authority_key !== record.authority.key ||
      value.bundle_root !== record.authority.bundle_root ||
      value.launch_root !== record.authority.launch_root ||
      value.actor !== record.authority.actor ||
      value.launch_nonce !== record.launch_nonce ||
      typeof value.protocol !== "number" ||
      !(value.state === "ready" || value.state === "adopted" || value.state === "stopping") ||
      typeof value.active_clients !== "number"
    ) return { kind: "indeterminate", reason: "management endpoint returned a mismatched identity" };
    return { kind: "matched", probe: value as Probe };
  } catch (error) {
    return hasConnectionRefused(error)
      ? { kind: "absent" }
      : { kind: "indeterminate", reason: error instanceof Error ? error.message : String(error) };
  }
}

function probeUncertain(record: ManagedUiRecord, reason: string): CliError {
  return new CliError("TRANSIENT", `could not prove whether the managed UI is still live: ${reason}`, {
    help: `${cliInvocation()} ui --status --dir ${commandToken(record.authority.bundle_root)}`,
  });
}

async function waitForExactExit(
  record: ManagedUiRecord,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + STOP_EXIT_DEADLINE_MS;
  let lastReason = "the listener still answers for the exact launch nonce";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await probeRecord(record, fetchImpl, Math.min(PROBE_TIMEOUT_MS, remaining));
    if (result.kind === "absent") return;
    lastReason = result.kind === "indeterminate" ? result.reason : lastReason;
    const sleepMs = Math.min(STOP_POLL_MS, deadline - Date.now());
    if (sleepMs > 0) await sleep(sleepMs);
  }
  throw new CliError("TRANSIENT", `managed UI stop was acknowledged but listener exit is not yet proven: ${lastReason}`, {
    help: `${cliInvocation()} ui --stop --dir ${commandToken(record.authority.bundle_root)}${actorArgs(record)}`,
  });
}

async function managementPost(record: ManagedUiRecord, operation: "adopt" | "stop", fetchImpl: typeof fetch): Promise<void> {
  const response = await boundedFetch(fetchImpl, `http://127.0.0.1:${record.port}/__manage/${operation}`, {
    method: "POST",
    headers: managementHeaders(record),
  });
  if (!response.ok) throw new Error(`managed UI ${operation} was refused (${response.status})`);
  const value = await response.json() as { launch_nonce?: unknown };
  if (value.launch_nonce !== record.launch_nonce) throw new Error(`managed UI ${operation} acknowledged a different launch`);
}

function liveRecord(base: ManagedUiRecord, ready: ManagedUiWorkerReady, phase: "ready" | "adopted"): ManagedUiRecord {
  return {
    ...base,
    phase,
    host: ready.host,
    port: ready.port,
    browser_token: ready.browser_token,
    launch_nonce: ready.launch_nonce,
    pid: ready.pid,
    started_at: ready.started_at,
  };
}

function launchUrl(record: ManagedUiRecord, documentId: string): string {
  const url = new URL(`http://127.0.0.1:${record.port}/`);
  url.searchParams.set("token", record.browser_token!);
  url.searchParams.set("view", "doc");
  url.searchParams.set("id", documentId);
  return url.toString();
}

function actorArgs(record: ManagedUiRecord): CommandText {
  return record.authority.actor === null
    ? commandFragment``
    : commandFragment` --actor ${commandToken(record.authority.actor)}`;
}

function portConflict(record: ManagedUiRecord, requestedPort: number): CliError {
  return new CliError("CONFLICT", `managed UI authority is already running on port ${record.port}; requested port ${requestedPort} would create a second authority`, {
    help: `${cliInvocation()} ui --stop --dir ${commandToken(record.authority.bundle_root)}${actorArgs(record)}, then rerun with --port ${commandToken(String(requestedPort))}`,
  });
}

async function defaultSpawnWorker(input: ManagedUiWorkerInput): Promise<ManagedUiWorkerReady> {
  const entry = currentExecutableRealPath();
  if (!entry) throw new Error("the exact running Superbee executable could not be resolved");
  const child = spawn(process.execPath, [...process.execArgv, entry, "__managed-ui-v1"], {
    detached: true,
    windowsHide: true,
    // stderr is a private, bounded startup diagnostic channel. It is closed as soon as readiness
    // arrives, so the adopted worker retains no parent-owned pipe for its long-lived lifecycle.
    stdio: ["pipe", "pipe", "pipe"],
  });
  return waitForWorkerReady(child, input);
}

function startupDiagnostic(raw: string, truncated: boolean): string {
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  if (!truncated && normalized.length <= START_DIAGNOSTIC_MESSAGE_MAX_CHARS) return `: ${normalized}`;
  const headChars = Math.floor(START_DIAGNOSTIC_MESSAGE_MAX_CHARS / 2);
  const tailChars = START_DIAGNOSTIC_MESSAGE_MAX_CHARS - headChars;
  return `: ${normalized.slice(0, headChars)} … ${normalized.slice(-tailChars)}`;
}

async function waitForWorkerReady(child: ChildProcess, input: ManagedUiWorkerInput): Promise<ManagedUiWorkerReady> {
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("managed UI child did not expose its private startup channel");
  const stdout = child.stdout;
  const stderr = child.stderr;
  child.stdin.end(`${JSON.stringify(input)}\n`);
  return new Promise<ManagedUiWorkerReady>((resolve, reject) => {
    let bytes = "";
    let diagnostic = "";
    let diagnosticTruncated = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("managed UI child did not become ready in time")), START_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error?: Error, value?: ManagedUiWorkerReady): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.removeAllListeners();
      stderr.removeAllListeners();
      child.removeAllListeners("error");
      child.removeAllListeners("close");
      stdout.destroy();
      stderr.destroy();
      child.unref();
      if (error) reject(error);
      else resolve(value!);
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(new Error(
      `managed UI child exited before readiness (${code ?? "signal"})${startupDiagnostic(diagnostic, diagnosticTruncated)}`,
    )));
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      if (diagnostic.length >= START_DIAGNOSTIC_MAX_BYTES) {
        diagnosticTruncated = true;
        return;
      }
      const remaining = START_DIAGNOSTIC_MAX_BYTES - diagnostic.length;
      diagnostic += chunk.slice(0, remaining);
      if (chunk.length > remaining) diagnosticTruncated = true;
    });
    stdout.on("data", (chunk: string) => {
      bytes += chunk;
      if (bytes.length > RECORD_MAX_BYTES) return finish(new Error("managed UI child readiness exceeded its bound"));
      const newline = bytes.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(bytes.slice(0, newline)) as ManagedUiWorkerReady;
        if (
          value.host !== "127.0.0.1" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
          !boundedString(value.browser_token, 256) || !boundedString(value.launch_nonce, 128) ||
          !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
          !boundedString(value.started_at, 64) || !Number.isFinite(Date.parse(value.started_at))
        ) throw new Error("invalid managed UI child readiness receipt");
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function pendingRecord(authority: ManagedUiAuthority, now: number): ManagedUiRecord {
  return {
    schema_version: MANAGED_UI_RECORD_SCHEMA,
    phase: "pending",
    operation_id: randomUUID(),
    authority,
    management_secret: randomBytes(32).toString("base64url"),
    created_at: new Date(now).toISOString(),
  };
}

async function recoverOrReuse(
  current: { record: ManagedUiRecord; raw: string },
  desiredAuthority: ManagedUiAuthority,
  requestedPort: number | undefined,
  now: number,
  fetchImpl: typeof fetch,
  home: string,
  sleep: (ms: number) => Promise<void>,
): Promise<ManagedUiRecord | null> {
  const record = current.record;
  if (record.phase === "pending") {
    if (now - Date.parse(record.created_at) < MANAGED_UI_PENDING_RECLAIM_MS) {
      throw new CliError("TRANSIENT", "managed UI startup is already in progress", {
        help: `retry ${cliInvocation()} doc open after the bounded startup recovery window`,
      });
    }
    await removeExactRecord(record.authority, current.raw, home);
    return null;
  }
  const result = await probeRecord(record, fetchImpl);
  if (result.kind === "absent") {
    // The record authorizes only removal of its exact bytes. It never authorizes signaling the PID.
    await removeExactRecord(record.authority, current.raw, home);
    return null;
  }
  if (result.kind === "indeterminate") throw probeUncertain(record, result.reason);
  const probe = result.probe;
  if (record.authority.launch_root !== desiredAuthority.launch_root) {
    throw new CliError("CONFLICT", "the managed UI authority is active through a different trusted bundle route", {
      help: `${cliInvocation()} ui --stop --dir ${commandToken(record.authority.launch_root)}${actorArgs(record)}, then retry`,
    });
  }
  if (probe.protocol !== MANAGED_UI_PROTOCOL) {
    if (probe.active_clients > 0) {
      throw new CliError("CONFLICT", "an incompatible managed UI is still serving an active browser", {
        help: `${cliInvocation()} ui --stop --dir ${commandToken(record.authority.bundle_root)}${actorArgs(record)}, then retry`,
      });
    }
    await managementPost(record, "stop", fetchImpl);
    await waitForExactExit(record, fetchImpl, sleep);
    await removeExactRecord(record.authority, current.raw, home);
    return null;
  }
  if (requestedPort !== undefined && requestedPort !== 0 && requestedPort !== record.port) throw portConflict(record, requestedPort);
  if (record.phase === "ready") {
    await managementPost(record, "adopt", fetchImpl);
    const adopted = { ...record, phase: "adopted" as const };
    await writeRecord(adopted, home);
    return adopted;
  }
  if (record.phase === "stopping" || probe.state === "stopping") {
    await managementPost(record, "stop", fetchImpl);
    await waitForExactExit(record, fetchImpl, sleep);
    const exact = await readRecord(record.authority, home);
    if (exact?.record.operation_id === record.operation_id && exact.record.launch_nonce === record.launch_nonce) {
      await removeExactRecord(record.authority, exact.raw, home);
    }
    return null;
  }
  return record;
}

export async function startOrReuseManagedUi(
  authority: ManagedUiAuthority,
  documentId: string,
  requestedPort: number | undefined,
  options: ManagedUiControllerOptions = {},
): Promise<ManagedUiLaunchReceipt> {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? fetch;
  const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const withLock = options.withLock ?? ((target, fn) => withFilesystemMutationLock(target, fn, { waitMs: LIFECYCLE_LOCK_WAIT_MS }));
  await ensureUserStateRoot(home);
  return withLock(managedUiRecordPath(authority, home), async () => {
    const current = await readRecord(authority, home);
    if (current) {
      const reused = await recoverOrReuse(current, authority, requestedPort, now(), fetchImpl, home, sleep);
      if (reused) return { state: "reused", authority, record: reused, url: launchUrl(reused, documentId) };
    }

    // Freeze the exact selected directory before publishing a pending operation. A failed
    // identity capture therefore cannot strand a record that another controller must recover.
    const launchIdentity = options.launchIdentity ?? await captureManagedUiLaunchIdentity(authority);
    const pending = pendingRecord(authority, now());
    await writeRecord(pending, home);
    let ready: ManagedUiWorkerReady;
    try {
      ready = await spawnWorker({
        schema_version: 1,
        operation_id: pending.operation_id,
        authority,
        management_secret: pending.management_secret,
        startup_deadline_at: new Date(Date.parse(pending.created_at) + MANAGED_UI_STARTUP_DEADLINE_MS).toISOString(),
        launch_identity: launchIdentity,
        // The record makes the chosen port durable for reuse. Letting the OS choose for an
        // unpinned first launch avoids colliding with unrelated loopback services.
        port: requestedPort ?? 0,
      });
    } catch (error) {
      // Readiness failure is uncertain: a child may still bind after the parent times out or rejects
      // malformed output. Keep the exact pending lease so no second authority can start beside it.
      throw new CliError("RUNTIME", `could not confirm managed UI startup: ${error instanceof Error ? error.message : String(error)}`, {
        help: `retry after the bounded startup recovery window (${MANAGED_UI_PENDING_RECLAIM_MS} ms)`,
      });
    }
    const readyRecord = liveRecord(pending, ready, "ready");
    await writeRecord(readyRecord, home);
    const probe = await probeRecord(readyRecord, fetchImpl);
    if (probe.kind !== "matched") {
      throw probe.kind === "indeterminate"
        ? probeUncertain(readyRecord, probe.reason)
        : new CliError("RUNTIME", "managed UI child became ready but its exact listener is absent");
    }
    await managementPost(readyRecord, "adopt", fetchImpl);
    const adopted = { ...readyRecord, phase: "adopted" as const };
    await writeRecord(adopted, home);
    return { state: "started", authority, record: adopted, url: launchUrl(adopted, documentId) };
  });
}

export async function listManagedUiStatus(
  bundleRoot: string,
  options: ManagedUiControllerOptions = {},
): Promise<ManagedUiStatus[]> {
  const home = options.home ?? homedir();
  const fetchImpl = options.fetch ?? fetch;
  const root = await ensureUserStateRoot(home);
  const names = await readdir(root);
  const statuses: ManagedUiStatus[] = [];
  for (const name of names.filter((entry) => entry.startsWith(RECORD_PREFIX) && entry.endsWith(RECORD_SUFFIX)).sort()) {
    const raw = await readUserStateFile(home, path.join(root, name), RECORD_MAX_BYTES);
    const record = parseManagedUiRecord(raw);
    if (record.authority.bundle_root !== bundleRoot) continue;
    const result = await probeRecord(record, fetchImpl);
    statuses.push({
      ...record,
      live: result.kind === "matched" ? true : result.kind === "absent" ? false : "unknown",
      ...(result.kind === "matched" ? { active_clients: result.probe.active_clients } : {}),
    });
  }
  return statuses;
}

export async function stopManagedUi(
  authority: ManagedUiAuthority,
  options: ManagedUiControllerOptions = {},
): Promise<{ stopped: boolean; authority: ManagedUiAuthority }> {
  const home = options.home ?? homedir();
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const withLock = options.withLock ?? ((target, fn) => withFilesystemMutationLock(target, fn, { waitMs: LIFECYCLE_LOCK_WAIT_MS }));
  await ensureUserStateRoot(home);
  return withLock(managedUiRecordPath(authority, home), async () => {
    const current = await readRecord(authority, home);
    if (!current) return { stopped: false, authority };
    const record = current.record;
    if (record.phase === "pending") {
      if ((options.now ?? Date.now)() - Date.parse(record.created_at) < MANAGED_UI_PENDING_RECLAIM_MS) {
        throw new CliError("TRANSIENT", "managed UI startup is still in progress and has not published a launch authority", {
          help: `retry ${cliInvocation()} ui --stop after the bounded startup recovery window`,
        });
      }
      await removeExactRecord(authority, current.raw, home);
      return { stopped: false, authority };
    }
    const probe = await probeRecord(record, fetchImpl);
    if (probe.kind === "absent") {
      await removeExactRecord(authority, current.raw, home);
      return { stopped: false, authority };
    }
    if (probe.kind === "indeterminate") throw probeUncertain(record, probe.reason);
    const stopping = { ...record, phase: "stopping" as const };
    await writeRecord(stopping, home);
    await managementPost(stopping, "stop", fetchImpl);
    await waitForExactExit(stopping, fetchImpl, sleep);
    const exact = await readRecord(authority, home);
    if (exact?.record.operation_id === record.operation_id && exact.record.launch_nonce === record.launch_nonce) {
      await removeExactRecord(authority, exact.raw, home);
    }
    return { stopped: true, authority };
  });
}
