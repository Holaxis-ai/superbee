import type { UiServerHandle } from "./server.js";
import { stat, realpath } from "node:fs/promises";
import {
  MANAGED_UI_PROTOCOL,
  managedUiAuthority,
  type ManagedUiWorkerInput,
} from "./managed-authority.js";
import { ui } from "../commands/ui.js";
import type { UiManagementOptions } from "@superbee/ui-server";
import { randomUUID } from "node:crypto";
import path from "node:path";

const INPUT_MAX_BYTES = 16 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/u;

export function parseManagedUiWorkerInput(raw: string): ManagedUiWorkerInput {
  if (Buffer.byteLength(raw) > INPUT_MAX_BYTES) throw new Error("managed UI startup input is too large");
  const value = JSON.parse(raw) as unknown;
  if (!object(value) || Object.keys(value).sort().join(",") !== "authority,launch_identity,management_secret,operation_id,port,schema_version,startup_deadline_at") {
    throw new Error("managed UI startup input has an unsupported shape");
  }
  const authority = value.authority;
  const launchIdentity = value.launch_identity;
  if (!object(authority) || Object.keys(authority).sort().join(",") !== "actor,bundle_root,key,launch_root,mode,protocol") {
    throw new Error("managed UI startup authority has an unsupported shape");
  }
  if (value.schema_version !== 1) throw new Error("managed UI startup schema version is invalid");
  if (typeof value.operation_id !== "string" || value.operation_id.length === 0 || value.operation_id.length > 128) {
    throw new Error("managed UI startup operation id is invalid");
  }
  if (typeof value.management_secret !== "string" || value.management_secret.length < 32 || value.management_secret.length > 256) {
    throw new Error("managed UI startup management secret is invalid");
  }
  if (typeof value.startup_deadline_at !== "string" || !Number.isFinite(Date.parse(value.startup_deadline_at))) {
    throw new Error("managed UI startup deadline is invalid");
  }
  if (!object(launchIdentity) || Object.keys(launchIdentity).sort().join(",") !== "canonical_root,dev,ino") {
    throw new Error("managed UI startup launch identity has an unsupported shape");
  }
  if (typeof launchIdentity.canonical_root !== "string" || !path.isAbsolute(launchIdentity.canonical_root)) {
    throw new Error("managed UI startup canonical root is invalid");
  }
  if (typeof launchIdentity.dev !== "string" || !DECIMAL_IDENTITY.test(launchIdentity.dev)) {
    throw new Error("managed UI startup device identity is invalid");
  }
  if (typeof launchIdentity.ino !== "string" || !DECIMAL_IDENTITY.test(launchIdentity.ino)) {
    throw new Error("managed UI startup inode identity is invalid");
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535) {
    throw new Error("managed UI startup port is invalid");
  }
  if (authority.mode !== "dir" || authority.protocol !== MANAGED_UI_PROTOCOL) {
    throw new Error("managed UI startup authority protocol is invalid");
  }
  if (typeof authority.bundle_root !== "string" || !path.isAbsolute(authority.bundle_root)) {
    throw new Error("managed UI startup bundle root is invalid");
  }
  if (typeof authority.launch_root !== "string" || !path.isAbsolute(authority.launch_root)) {
    throw new Error("managed UI startup launch root is invalid");
  }
  if (!(authority.actor === null || (typeof authority.actor === "string" && authority.actor.length > 0 && authority.actor.length <= 1024))) {
    throw new Error("managed UI startup actor is invalid");
  }
  const expected = managedUiAuthority(authority.bundle_root, authority.actor ?? undefined);
  if (authority.key !== expected.key) throw new Error("managed UI startup authority key is invalid");
  if (launchIdentity.canonical_root !== authority.bundle_root) {
    throw new Error("managed UI startup launch identity is invalid");
  }
  return value as unknown as ManagedUiWorkerInput;
}

async function readStartupInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > INPUT_MAX_BYTES) throw new Error("managed UI startup input is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function adoptionLifecycle(handle: UiServerHandle | undefined, deadlineTimer: NodeJS.Timeout): Promise<void> {
  if (!handle?.management) return Promise.reject(new Error("managed UI server did not expose its management lifecycle"));
  const first = await Promise.race([
    handle.management.adopted.then(() => "adopted" as const),
    handle.management.stopRequested.then(() => "stopping" as const),
  ]);
  if (first === "adopted") {
    clearTimeout(deadlineTimer);
    await handle.management.stopRequested;
  }
}

async function assertFrozenLaunchIdentity(input: ManagedUiWorkerInput): Promise<void> {
  const canonicalRoot = await realpath(input.authority.launch_root);
  const metadata = await stat(canonicalRoot, { bigint: true });
  if (
    canonicalRoot !== input.authority.bundle_root ||
    canonicalRoot !== input.launch_identity.canonical_root ||
    !metadata.isDirectory() ||
    metadata.dev.toString() !== input.launch_identity.dev ||
    metadata.ino.toString() !== input.launch_identity.ino
  ) throw new Error("managed UI launch route changed after controller selection");
}

export interface ManagedUiWorkerRuntime {
  now?: () => number;
  launchUi?: typeof ui;
  terminate?: (code: number) => void;
}

export async function runManagedUiWorkerInput(
  input: ManagedUiWorkerInput,
  runtime: ManagedUiWorkerRuntime = {},
): Promise<void> {
  const now = runtime.now ?? Date.now;
  const launchUi = runtime.launchUi ?? ui;
  const terminate = runtime.terminate ?? ((code: number) => process.exit(code));
  const startupDeadline = Date.parse(input.startup_deadline_at);
  if (now() >= startupDeadline) throw new Error("managed UI startup deadline already expired");
  let deadlineExpired = false;
  let managementHandle: UiServerHandle["management"] | undefined;
  const deadlineTimer = setTimeout(() => {
    if (!managementHandle) {
      deadlineExpired = true;
      terminate(1);
      return;
    }
    // Once the listener exists, the server's state machine owns the adoption race. Expiry closes
    // only a still-ready launch; false means an authenticated adopt/stop already won atomically.
    deadlineExpired = managementHandle.expireIfReady();
  }, startupDeadline - now());
  deadlineTimer.unref?.();
  const launchNonce = randomUUID();
  const startedAt = new Date().toISOString();
  const management: UiManagementOptions = {
    secret: input.management_secret,
    identity: {
      protocol: MANAGED_UI_PROTOCOL,
      mode: "dir",
      authority_key: input.authority.key,
      bundle_root: input.authority.bundle_root,
      launch_root: input.authority.launch_root,
      actor: input.authority.actor,
      launch_nonce: launchNonce,
      pid: process.pid,
      started_at: startedAt,
    },
  };
  let readyWritten = false;
  await assertFrozenLaunchIdentity(input);
  if (now() >= startupDeadline) throw new Error("managed UI startup deadline expired during route validation");
  const args = ["--dir", input.authority.launch_root, "--port", String(input.port), "--json"];
  if (input.authority.actor !== null) args.push("--actor", input.authority.actor);
  await launchUi(args, {
    management,
    localBundle: { root: input.authority.launch_root },
    sessionCookieName: `superbee_ui_${input.authority.key.slice(0, 16)}`,
    stdout: (raw) => {
      if (readyWritten) return;
      const receipt = JSON.parse(raw) as { url: string; mode: string };
      const url = new URL(receipt.url);
      readyWritten = true;
      process.stdout.write(`${JSON.stringify({
        host: "127.0.0.1",
        port: Number(url.port),
        browser_token: url.searchParams.get("token"),
        launch_nonce: launchNonce,
        pid: process.pid,
        started_at: startedAt,
      })}\n`);
    },
    waitForShutdown: (handle) => {
      managementHandle = handle?.management;
      return adoptionLifecycle(handle, deadlineTimer);
    },
    openBrowser: () => {},
    writeUrlFile: async () => {},
    clearUrlFile: async () => {},
  });
  clearTimeout(deadlineTimer);
  if (deadlineExpired) throw new Error("managed UI startup deadline expired before readiness");
}

export async function runManagedUiWorker(): Promise<void> {
  await runManagedUiWorkerInput(parseManagedUiWorkerInput(await readStartupInput()));
}
