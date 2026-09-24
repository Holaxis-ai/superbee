// Where the hosted refresh token lives.
//
// The OS credential store is reached through its own system tool (macOS `/usr/bin/security`,
// Linux `secret-tool`), never a native addon: no new dependency, and on macOS the keychain item's
// ACL names the stable `security` binary rather than whichever `node` ran the CLI, so a Node
// upgrade does not trigger a fresh keychain prompt. Secrets never travel in argv: macOS gets
// hex-encoded input over `security -i` stdin, and `secret-tool store` reads the secret from stdin.
// Every call is bounded, because a locked keychain can prompt (and hang) in an agent shell.
//
// There is no silent plaintext fallback. When no OS store is usable the caller gets
// CREDENTIAL_STORE_UNAVAILABLE with the remedy; the 0600 file store is an explicit opt-in via
// SUPERBEE_CREDENTIAL_STORE=file. Windows gets no new package: it uses the file opt-in until a
// native store is separately approved.
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../errors.js";
import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";

export const CREDENTIAL_STORE_ENV = "SUPERBEE_CREDENTIAL_STORE";
export const KEYCHAIN_SERVICE = "superbee-cli";
export const STORE_CALL_TIMEOUT_MS = 5_000;
const MACOS_SECURITY = "/usr/bin/security";

export type SecretStoreKind = "macos-keychain" | "secret-service" | "file";

export interface SecretStore {
  readonly kind: SecretStoreKind;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  /** True when something was removed. */
  delete(account: string): Promise<boolean>;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The tool is not installed (spawn ENOENT). */
  readonly missing?: boolean;
  readonly timedOut?: boolean;
}

export type ToolRunner = (command: string, args: readonly string[], stdin: string, timeoutMs: number) => Promise<RunResult>;

/** Spawn a system tool with a hard timeout; stdout/stderr are captured, never inherited. */
export const runTool: ToolRunner = (command, args, stdin, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", missing: true });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr, missing: error.code === "ENOENT" });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });

export function credentialStoreUnavailable(reason: string, kind?: SecretStoreKind): CliError {
  return new CliError("CREDENTIAL_STORE_UNAVAILABLE", `cannot use the OS credential store: ${reason}`, {
    details: { ...(kind ? { store: kind } : {}), reason },
    help:
      `unlock or install the OS credential store and retry, or opt in to a 0600 file under the Superbee state directory with ${CREDENTIAL_STORE_ENV}=file`,
  });
}

/** Keychain accounts are CLI-built `<origin> <audience>` strings; refuse anything that could break a -i line. */
function assertAccount(account: string): void {
  if (!/^[\x21-\x7e ]+$/u.test(account) || /["\\]/u.test(account)) {
    throw new CliError("RUNTIME", "credential store account name contains unsupported characters");
  }
}

function failure(kind: SecretStoreKind, result: RunResult, action: string): CliError {
  if (result.missing) return credentialStoreUnavailable(`${kind} tool is not installed`, kind);
  if (result.timedOut) return credentialStoreUnavailable(`${action} did not finish within ${STORE_CALL_TIMEOUT_MS / 1000}s (locked or prompting?)`, kind);
  // Never surface a long hex run: it could only be encoded secret input echoed back.
  const detail = (result.stderr.trim().split("\n")[0] ?? "").replace(/[0-9a-f]{32,}/giu, "<redacted>").slice(0, 200);
  return credentialStoreUnavailable(`${action} failed${detail ? `: ${detail}` : ""}`, kind);
}

/** macOS `security` exit status for "item not found". */
const SEC_ITEM_NOT_FOUND = 44;

export function macosKeychainStore(run: ToolRunner = runTool, securityPath = MACOS_SECURITY): SecretStore {
  const kind = "macos-keychain" as const;
  return {
    kind,
    async get(account) {
      assertAccount(account);
      const result = await run(securityPath, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], "", STORE_CALL_TIMEOUT_MS);
      if (result.code === 0) return result.stdout.replace(/\n$/u, "");
      if (result.code === SEC_ITEM_NOT_FOUND) return null;
      throw failure(kind, result, "keychain read");
    },
    async set(account, secret) {
      assertAccount(account);
      const hex = Buffer.from(secret, "utf8").toString("hex");
      const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${account}" -l "Superbee CLI" -X ${hex}\n`;
      const result = await run(securityPath, ["-i"], line, STORE_CALL_TIMEOUT_MS);
      if (result.code !== 0 || /error|fail/iu.test(result.stderr)) throw failure(kind, result, "keychain write");
    },
    async delete(account) {
      assertAccount(account);
      const result = await run(securityPath, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], "", STORE_CALL_TIMEOUT_MS);
      if (result.code === 0) return true;
      if (result.code === SEC_ITEM_NOT_FOUND) return false;
      throw failure(kind, result, "keychain delete");
    },
  };
}

export function secretServiceStore(run: ToolRunner = runTool): SecretStore {
  const kind = "secret-service" as const;
  // `secret-tool lookup` exits 1 with empty output for a missing item; any stderr means the
  // service itself is unusable (no D-Bus session, locked collection, and so on).
  return {
    kind,
    async get(account) {
      assertAccount(account);
      const result = await run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", account], "", STORE_CALL_TIMEOUT_MS);
      if (result.code === 0) return result.stdout.replace(/\n$/u, "") || null;
      if (result.code === 1 && !result.missing && !result.timedOut && result.stderr.trim() === "") return null;
      throw failure(kind, result, "secret-service read");
    },
    async set(account, secret) {
      assertAccount(account);
      const result = await run(
        "secret-tool",
        ["store", "--label", "Superbee CLI", "service", KEYCHAIN_SERVICE, "account", account],
        secret,
        STORE_CALL_TIMEOUT_MS,
      );
      if (result.code !== 0) throw failure(kind, result, "secret-service write");
    },
    async delete(account) {
      assertAccount(account);
      const existing = await this.get(account);
      if (existing === null) return false;
      const result = await run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account], "", STORE_CALL_TIMEOUT_MS);
      if (result.code !== 0) throw failure(kind, result, "secret-service delete");
      return true;
    },
  };
}

/** Explicit opt-in: one 0600 JSON file per session directory inside the private state root. */
export function fileSecretStore(home: string, directoryFor: (account: string) => string): SecretStore {
  const FILE = "refresh-token.json";
  return {
    kind: "file",
    async get(account) {
      let raw: string;
      try {
        raw = await readUserStateFile(home, join(directoryFor(account), FILE), 64 * 1024);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        const parsed = JSON.parse(raw) as { account?: unknown; refresh_token?: unknown };
        return parsed.account === account && typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
      } catch {
        return null;
      }
    },
    async set(account, secret) {
      await writeUserStateFileAtomic0600(home, directoryFor(account), FILE, `${JSON.stringify({ account, refresh_token: secret })}\n`);
    },
    async delete(account) {
      try {
        await unlink(join(directoryFor(account), FILE));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

export interface SelectStoreOptions {
  readonly home: string;
  readonly directoryFor: (account: string) => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly run?: ToolRunner;
}

/**
 * Pick the store by explicit policy. `SUPERBEE_CREDENTIAL_STORE=file` opts in to the file store;
 * `keychain` (or unset) means the OS store for this platform, and an unsupported platform refuses.
 */
export function selectSecretStore(options: SelectStoreOptions): SecretStore {
  const env = options.env ?? process.env;
  const requested = (env[CREDENTIAL_STORE_ENV] ?? "").trim().toLowerCase();
  if (requested === "file") return fileSecretStore(options.home, options.directoryFor);
  if (requested !== "" && requested !== "keychain") {
    throw new CliError("USAGE", `${CREDENTIAL_STORE_ENV} must be 'keychain' or 'file' (got '${requested}')`);
  }
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return macosKeychainStore(options.run);
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return secretServiceStore(options.run);
  throw credentialStoreUnavailable(`no supported OS credential store on ${platform}`);
}

/** The account a writability probe uses: never the session's own, so the probe cannot clobber a live refresh token. */
export function probeAccount(account: string): string {
  return `${account} probe`;
}

/**
 * Prove the store can hold the refresh token before a person is asked to sign in. An OS store can
 * answer reads and still refuse writes (a HOME with no default keychain reports every item as not
 * found), and a device code is spent the moment it is redeemed, so the OS stores are probed with a
 * write and delete of a throwaway item. The file store lives in the private state root the session
 * lock has already created, so a read is enough there.
 */
export async function probeSecretStore(store: SecretStore, account: string): Promise<void> {
  if (store.kind === "file") {
    await store.get(account);
    return;
  }
  const probe = probeAccount(account);
  await store.set(probe, "superbee-cli write probe");
  await store.delete(probe).catch(() => false);
}
