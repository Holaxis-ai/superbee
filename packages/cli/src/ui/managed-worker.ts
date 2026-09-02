import type { UiServerHandle } from "./server.js";
import {
  MANAGED_UI_PROTOCOL,
  MANAGED_UI_STARTUP_LEASE_MS,
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

function parseInput(raw: string): ManagedUiWorkerInput {
  if (Buffer.byteLength(raw) > INPUT_MAX_BYTES) throw new Error("managed UI startup input is too large");
  const value = JSON.parse(raw) as unknown;
  if (!object(value) || Object.keys(value).sort().join(",") !== "authority,management_secret,operation_id,port,schema_version") {
    throw new Error("managed UI startup input has an unsupported shape");
  }
  const authority = value.authority;
  if (!object(authority) || Object.keys(authority).sort().join(",") !== "actor,bundle_root,key,mode,protocol") {
    throw new Error("managed UI startup authority has an unsupported shape");
  }
  if (
    value.schema_version !== 1 ||
    typeof value.operation_id !== "string" || value.operation_id.length === 0 || value.operation_id.length > 128 ||
    typeof value.management_secret !== "string" || value.management_secret.length < 32 || value.management_secret.length > 256 ||
    typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535 ||
    authority.mode !== "dir" || authority.protocol !== MANAGED_UI_PROTOCOL ||
    typeof authority.bundle_root !== "string" || !path.isAbsolute(authority.bundle_root) ||
    !(authority.actor === null || (typeof authority.actor === "string" && authority.actor.length > 0 && authority.actor.length <= 1024))
  ) throw new Error("managed UI startup input is invalid");
  const expected = managedUiAuthority(authority.bundle_root, authority.actor ?? undefined);
  if (authority.key !== expected.key) throw new Error("managed UI startup authority key is invalid");
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

function adoptionLifecycle(handle?: UiServerHandle): Promise<void> {
  if (!handle?.management) return Promise.reject(new Error("managed UI server did not expose its management lifecycle"));
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MANAGED_UI_STARTUP_LEASE_MS);
    timer.unref?.();
    void handle.management!.adopted.then(async () => {
      clearTimeout(timer);
      await handle.management!.stopRequested;
      resolve();
    });
  });
}

export async function runManagedUiWorker(): Promise<void> {
  const input = parseInput(await readStartupInput());
  const launchNonce = randomUUID();
  const startedAt = new Date().toISOString();
  const management: UiManagementOptions = {
    secret: input.management_secret,
    identity: {
      protocol: MANAGED_UI_PROTOCOL,
      mode: "dir",
      authority_key: input.authority.key,
      bundle_root: input.authority.bundle_root,
      actor: input.authority.actor,
      launch_nonce: launchNonce,
      pid: process.pid,
      started_at: startedAt,
    },
  };
  let readyWritten = false;
  const args = ["--dir", input.authority.bundle_root, "--port", String(input.port), "--json"];
  if (input.authority.actor !== null) args.push("--actor", input.authority.actor);
  await ui(args, {
    management,
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
    waitForShutdown: adoptionLifecycle,
    openBrowser: () => {},
    writeUrlFile: async () => {},
    clearUrlFile: async () => {},
  });
}
